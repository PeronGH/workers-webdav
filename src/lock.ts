import { XMLSerializer } from '@xmldom/xmldom';
import { appliedToken, checkIf, COLLECTION, createToken } from './conditions';
import { HttpError } from './http';
import { CREATE_ONLY, dirExists, href, objectKey, stat, type Entry, type Target } from './storage';
import { childElements, escapeXml, parseDavXml, XML_HEADER } from './xml';

const TIMEOUT = 'Second-3600';

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

function lockResponse(token: string, root: string, info: LockInfo, depth: string, status: number, fresh: boolean): Response {
	const activelock =
		`<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:${info.scope}/></D:lockscope>` +
		`<D:depth>${depth}</D:depth>${info.owner}<D:timeout>${TIMEOUT}</D:timeout>` +
		`<D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken><D:lockroot><D:href>${escapeXml(root)}</D:href></D:lockroot></D:activelock>`;
	const headers = new Headers({ 'Content-Type': 'application/xml; charset=utf-8', Timeout: TIMEOUT });
	if (fresh) headers.set('Lock-Token', `<${token}>`);
	return new Response(`${XML_HEADER}<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activelock}</D:lockdiscovery></D:prop>`, { status, headers });
}

/** A LOCK on an unmapped URL creates an empty file (RFC 4918 §9.10.4); null if another request just created it. */
async function createEmpty(bucket: R2Bucket, user: string, target: Target): Promise<Entry | null> {
	if (target.wantsDir || !(await dirExists(bucket, user, target.path.slice(0, -1)))) throw new HttpError(409);
	const object = await bucket.put(objectKey(user, target.path), '', { onlyIf: CREATE_ONLY() });
	return object && { type: 'file', path: target.path, object };
}

export async function handleLock(request: Request, bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	const body = await request.text();
	const existing = await stat(bucket, user, target);
	const groups = await checkIf(request, bucket, user, [[target.path, existing]]);

	if (body.trim() === '') {
		const token = appliedToken(groups, target.path, existing);
		if (!token) throw new HttpError(412);
		const entry = existing ?? { type: 'file', path: target.path };
		const depth = entry.type === 'dir' ? 'infinity' : '0';
		return lockResponse(createToken(token), href(entry), { scope: 'exclusive', owner: '' }, depth, 200, false);
	}

	const depth = request.headers.get('Depth')?.toLowerCase() ?? 'infinity';
	if (depth !== '0' && depth !== 'infinity') throw new HttpError(400);
	const info = parseLockInfo(body);
	const created = existing ? null : await createEmpty(bucket, user, target);
	const entry = existing ?? created ?? (await stat(bucket, user, target));
	if (!entry) throw new HttpError(409);
	const token = createToken({ id: crypto.randomUUID(), etag: entry.type === 'dir' ? COLLECTION : entry.object.etag });
	return lockResponse(token, href(entry), info, entry.type === 'dir' ? depth : '0', created ? 201 : 200, true);
}

export function handleUnlock(request: Request): Response {
	if (!request.headers.has('Lock-Token')) throw new HttpError(400);
	return new Response(null, { status: 204 });
}

export const SUPPORTED_LOCK =
	'<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
	'<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>';
