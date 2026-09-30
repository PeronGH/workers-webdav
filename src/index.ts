import { authenticate } from './auth';
import { handleGet, handleHead } from './get';
import { ALLOW, hasBody, HttpError } from './http';
import { handleLock, handleUnlock } from './lock';
import { handlePropfind, handleProppatch } from './propfind';
import { parseTarget, parseUploadPath } from './storage';
import { handleUpload } from './upload';
import { handleCopyMove, handleDelete, handleMkcol, handlePut } from './write';

const METHODS = new Set(ALLOW.split(', '));
const BODY_METHODS = new Set(['PROPFIND', 'PROPPATCH', 'PUT', 'LOCK']);

async function handle(request: Request, env: Env): Promise<Response> {
	const { method } = request;
	if (!METHODS.has(method)) throw new HttpError(405, null, { Allow: ALLOW });
	if (!BODY_METHODS.has(method) && hasBody(request)) throw new HttpError(415);

	if (method === 'OPTIONS') {
		return new Response(null, { headers: { DAV: '1, 2', Allow: ALLOW, 'MS-Author-Via': 'DAV' } });
	}

	const user = await authenticate(request, env.AUTH_SECRET);
	if (user === null) {
		throw new HttpError(401, null, { 'WWW-Authenticate': 'Basic realm="WebDAV", charset="UTF-8"' });
	}

	const bucket = env.BUCKET;
	const { pathname } = new URL(request.url);
	const upload = parseUploadPath(pathname, user);
	if (upload) return handleUpload(request, bucket, user, upload);
	const target = parseTarget(pathname, user);
	switch (method) {
		case 'GET':
			return handleGet(request, bucket, user, target);
		case 'HEAD':
			return handleHead(request, bucket, user, target);
		case 'PROPFIND':
			return handlePropfind(request, bucket, user, target);
		case 'PROPPATCH':
			return handleProppatch(request, bucket, user, target);
		case 'PUT':
			return handlePut(request, bucket, user, target);
		case 'DELETE':
			return handleDelete(request, bucket, user, target);
		case 'MKCOL':
			return handleMkcol(bucket, user, target);
		case 'COPY':
			return handleCopyMove(request, bucket, user, target, false);
		case 'MOVE':
			return handleCopyMove(request, bucket, user, target, true);
		case 'LOCK':
			return handleLock(request, bucket, user, target);
		default:
			return handleUnlock(request);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handle(request, env);
		} catch (error) {
			if (error instanceof HttpError) return error.toResponse();
			throw error;
		}
	},
} satisfies ExportedHandler<Env>;
