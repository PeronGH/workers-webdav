import { HttpError } from './http';
import { parseTarget, stat, type Entry, type Target } from './storage';

/*
 * Stateless "etag-stamped" locks. LOCK always succeeds and hands out a token carrying a random id plus the
 * resource's etag at lock time. A token holds on a resource only while nobody else changed it since, which is
 * detected by the etag still matching, or by the object carrying this lock's id from an earlier save. Nothing is
 * stored, so locks never block; conflicting saves fail with 412 instead.
 */

const TOKEN_PATTERN = /^opaquelocktoken:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.+)$/i;
export const COLLECTION = 'collection';

export interface LockToken {
	id: string;
	/** R2 etag at lock time, or `collection` for collections. */
	etag: string;
}

export function createToken({ id, etag }: LockToken): string {
	return `opaquelocktoken:${id}.${etag}`;
}

function parseToken(value: string): LockToken | null {
	const match = TOKEN_PATTERN.exec(value);
	return match ? { id: match[1], etag: match[2] } : null;
}

/** A collection token holds on anything, mapped or not, since the scope of its lock is not recorded. */
function tokenHolds(token: LockToken, entry: Entry | null): boolean {
	if (token.etag === COLLECTION) return true;
	return entry?.type === 'file' && (entry.object.etag === token.etag || entry.object.customMetadata?.lock === token.id);
}

type Condition = { not: boolean } & ({ etag: string } | { token: string });

/** Lists applying to one resource; `resource` is null for resources on other hosts, which never match. */
interface Group {
	resource: Target | null;
	lists: Condition[][];
}

function tagResource(url: string, requestUrl: string): Target | null {
	let parsed: URL;
	try {
		parsed = new URL(url, requestUrl);
	} catch {
		throw new HttpError(400);
	}
	return parsed.host === new URL(requestUrl).host ? parseTarget(parsed.pathname) : null;
}

/** Parses the If header (RFC 4918 §10.4.2); malformed headers are a 400 rather than silently ignored. */
function parseIf(header: string, requestUrl: string): Group[] {
	const groups: Group[] = [];
	let tagged: boolean | undefined;
	let list: Condition[] | null = null;
	let not = false;
	const source = header.trim();
	const pattern = /(?:<([^>]*)>|\[([^\]]*)\]|(\()|(\))|(not)\b)\s*/iy;
	while (pattern.lastIndex < source.length) {
		const match = pattern.exec(source);
		if (!match) throw new HttpError(400);
		const [, url, etag, open, close, negation] = match as (string | undefined)[];
		if (list === null) {
			if (url !== undefined && tagged !== false) {
				tagged = true;
				groups.push({ resource: tagResource(url, requestUrl), lists: [] });
			} else if (open !== undefined) {
				if (tagged === undefined) {
					tagged = false;
					groups.push({ resource: parseTarget(new URL(requestUrl).pathname), lists: [] });
				}
				list = [];
			} else throw new HttpError(400);
		} else if (negation !== undefined && !not) {
			not = true;
		} else if (url !== undefined) {
			list.push({ not, token: url });
			not = false;
		} else if (etag !== undefined) {
			list.push({ not, etag });
			not = false;
		} else if (close !== undefined && list.length > 0 && !not) {
			groups[groups.length - 1].lists.push(list);
			list = null;
		} else throw new HttpError(400);
	}
	if (list !== null || groups.length === 0 || groups.some((group) => group.lists.length === 0)) throw new HttpError(400);
	return groups;
}

const weak = (etag: string): string => etag.replace(/^W\//, '');

function holds(condition: Condition, entry: Entry | null): boolean {
	if ('etag' in condition) return entry?.type === 'file' && weak(condition.etag) === weak(entry.object.httpEtag);
	const token = parseToken(condition.token);
	return token !== null && tokenHolds(token, entry);
}

/**
 * Evaluates the If header (RFC 4918 §10.4.3), failing with 412 when no list holds. `known` supplies the entries the
 * caller already has, by path; other tagged resources are looked up. Returns null when there is no If header.
 */
export async function checkIf(
	request: Request,
	bucket: R2Bucket,
	user: string,
	known: [string[], Entry | null][],
): Promise<Group[] | null> {
	const header = request.headers.get('If');
	if (header === null) return null;
	const groups = parseIf(header, request.url);
	const entries = new Map(known.map(([path, entry]) => [path.join('/'), entry]));
	for (const { resource, lists } of groups) {
		let entry: Entry | null = null;
		if (resource) {
			const key = resource.path.join('/');
			if (!entries.has(key)) entries.set(key, await stat(bucket, user, { path: resource.path, wantsDir: false }));
			entry = entries.get(key) ?? null;
		}
		if (lists.some((list) => list.every((condition) => holds(condition, entry) !== condition.not))) return groups;
	}
	throw new HttpError(412);
}

/** The first lock token submitted for `path` that still holds on `entry`. */
export function appliedToken(groups: Group[] | null, path: string[], entry: Entry | null): LockToken | undefined {
	const key = path.join('/');
	return (groups ?? [])
		.filter(({ resource }) => resource?.path.join('/') === key)
		.flatMap(({ lists }) => lists.flat())
		.map((condition) => ('token' in condition && !condition.not ? parseToken(condition.token) : null))
		.find((token): token is LockToken => token !== null && tokenHolds(token, entry));
}

function etagList(value: string): string[] {
	return value.split(',').map((etag) => etag.trim());
}

/**
 * Evaluates If-Match (strong), If-Unmodified-Since and If-None-Match (weak) for a write to `entry`, in RFC 9110
 * §13.2.2 order, failing with 412. Returns whether any were present.
 */
export function checkPreconditions(headers: Headers, entry: Entry | null): boolean {
	const etag = entry?.type === 'file' ? entry.object.httpEtag : undefined;
	const ifMatch = headers.get('If-Match');
	const ifUnmodifiedSince = headers.get('If-Unmodified-Since');
	const ifNoneMatch = headers.get('If-None-Match');
	if (ifMatch !== null) {
		if (!entry || (ifMatch.trim() !== '*' && (etag === undefined || !etagList(ifMatch).includes(etag)))) throw new HttpError(412);
	} else if (ifUnmodifiedSince !== null && entry?.type === 'file') {
		const date = Date.parse(ifUnmodifiedSince);
		// HTTP dates have second precision.
		if (Math.floor(entry.object.uploaded.getTime() / 1000) * 1000 > date) throw new HttpError(412);
	}
	if (
		ifNoneMatch !== null &&
		entry &&
		(ifNoneMatch.trim() === '*' || (etag !== undefined && etagList(ifNoneMatch).map(weak).includes(weak(etag))))
	) {
		throw new HttpError(412);
	}
	return ifMatch !== null || ifUnmodifiedSince !== null || ifNoneMatch !== null;
}
