import { authenticate } from './auth';
import { handleGet, handleHead } from './get';
import { hasBody, HttpError } from './http';
import { handlePropfind } from './propfind';
import { parseTarget } from './storage';

const ALLOW = 'OPTIONS, GET, HEAD, PROPFIND';

async function handle(request: Request, env: Env): Promise<Response> {
	const { method } = request;
	if (!['OPTIONS', 'GET', 'HEAD', 'PROPFIND'].includes(method)) throw new HttpError(405, null, { Allow: ALLOW });
	if (method !== 'PROPFIND' && hasBody(request)) throw new HttpError(415);

	if (method === 'OPTIONS') {
		return new Response(null, { headers: { DAV: '1', Allow: ALLOW, 'MS-Author-Via': 'DAV' } });
	}

	const user = await authenticate(request, env.AUTH_SECRET);
	if (user === null) {
		throw new HttpError(401, null, { 'WWW-Authenticate': 'Basic realm="WebDAV", charset="UTF-8"' });
	}

	const target = parseTarget(new URL(request.url).pathname);
	switch (method) {
		case 'GET':
			return handleGet(request, env.BUCKET, user, target);
		case 'HEAD':
			return handleHead(env.BUCKET, user, target);
		default:
			return handlePropfind(request, env.BUCKET, user, target);
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
