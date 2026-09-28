import { XMLSerializer } from '@xmldom/xmldom';
import { HttpError } from './http';
import { dirExists, href, parseTarget, stat, type Target } from './storage';
import { childElements, escapeXml, parseDavXml, XML_HEADER } from './xml';

/*
 * Stateless "etag-stamped" locks. LOCK always succeeds and hands out a token carrying a random id plus the
 * resource's etag at lock time. Writes presenting a token succeed only if nobody else changed the object since,
 * which is detected by the etag still matching, or by the object carrying this lock's id from an earlier save.
 * Nothing is stored, so locks never block; conflicting saves fail with 412 instead.
 */

const TOKEN_PATTERN = /^opaquelocktoken:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.+)$/i;
const ABSENT = 'none';
const COLLECTION = 'collection';
const TIMEOUT = 'Second-3600';

export interface LockToken {
	id: string;
	/** R2 etag at lock time, or `none` for unmapped URLs, or `collection` for collections. */
	etag: string;
}

function createToken(id: string, etag: string): string {
	return `opaquelocktoken:${id}.${etag}`;
}

function parseToken(token: string): LockToken | null {
	const match = TOKEN_PATTERN.exec(token);
	return match ? { id: match[1], etag: match[2] } : null;
}

/**
 * Lock tokens from the If header (RFC 4918 §10.4) that apply to `path`: untagged lists apply to the request URI,
 * tagged lists to their resource. Returns null when no token applies; unparseable tokens are dropped, so a
 * non-null empty array means the client presented only foreign tokens.
 */
export function lockTokens(request: Request, path: string[], isRequestUri: boolean): LockToken[] | null {
	const header = request.headers.get('If');
	if (header === null) return null;

	const wanted = path.join('/');
	const found: string[] = [];
	let tagApplies = isRequestUri;
	let inList = false;
	let negated = false;
	for (const [token] of header.matchAll(/<[^>]*>|\[[^\]]*\]|\(|\)|Not/gi)) {
		if (token === '(') inList = true;
		else if (token === ')') inList = false;
		else if (token.toLowerCase() === 'not') negated = true;
		else if (!inList && token.startsWith('<')) {
			try {
				tagApplies = parseTarget(new URL(token.slice(1, -1), request.url).pathname).path.join('/') === wanted;
			} catch {
				tagApplies = false;
			}
		} else {
			if (tagApplies && !negated && token.startsWith('<')) found.push(token.slice(1, -1));
			negated = false;
		}
	}
	return found.length > 0 ? found.map(parseToken).filter((token) => token !== null) : null;
}

/** Whether a write presenting `token` may replace `object` (null when the key is absent). */
export function lockPermits(token: LockToken, object: R2Object | null): boolean {
	if (token.etag === COLLECTION) return true;
	return object ? object.etag === token.etag || object.customMetadata?.lock === token.id : token.etag === ABSENT;
}

interface LockInfo {
	scope: 'exclusive' | 'shared';
	owner: string;
}

function parseLockInfo(body: string): LockInfo {
	const root = parseDavXml(body, 'lockinfo');
	const shared = childElements(root, 'lockscope').some((scope) => childElements(scope, 'shared').length > 0);
	const owner = childElements(root, 'owner').at(0);
	return { scope: shared ? 'shared' : 'exclusive', owner: owner ? new XMLSerializer().serializeToString(owner) : '' };
}

function lockResponse(token: string, root: string, info: LockInfo, depth: string, fresh: boolean): Response {
	const activelock =
		`<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:${info.scope}/></D:lockscope>` +
		`<D:depth>${depth}</D:depth>${info.owner}<D:timeout>${TIMEOUT}</D:timeout>` +
		`<D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken><D:lockroot><D:href>${escapeXml(root)}</D:href></D:lockroot></D:activelock>`;
	const headers = new Headers({ 'Content-Type': 'application/xml; charset=utf-8', Timeout: TIMEOUT });
	if (fresh) headers.set('Lock-Token', `<${token}>`);
	return new Response(`${XML_HEADER}<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activelock}</D:lockdiscovery></D:prop>`, { headers });
}

export async function handleLock(request: Request, bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	const body = await request.text();
	const entry = await stat(bucket, user, target);
	const root = href(entry ?? { type: target.wantsDir ? 'dir' : 'file', path: target.path });
	const depth = entry?.type === 'dir' && request.headers.get('Depth') !== '0' ? 'infinity' : '0';

	if (body.trim() === '') {
		const token = lockTokens(request, target.path, true)?.[0];
		if (token === undefined) throw new HttpError(412);
		return lockResponse(createToken(token.id, token.etag), root, { scope: 'exclusive', owner: '' }, depth, false);
	}

	const info = parseLockInfo(body);
	if (!entry && !(await dirExists(bucket, user, target.path.slice(0, -1)))) throw new HttpError(409);
	const etag = !entry ? ABSENT : entry.type === 'dir' ? COLLECTION : entry.object.etag;
	return lockResponse(createToken(crypto.randomUUID(), etag), root, info, depth, true);
}

export function handleUnlock(request: Request): Response {
	if (!request.headers.has('Lock-Token')) throw new HttpError(400);
	return new Response(null, { status: 204 });
}

export const SUPPORTED_LOCK =
	'<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
	'<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>';
