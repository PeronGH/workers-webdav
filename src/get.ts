import { HttpError } from './http';
import { dirExists, displayName, href, listDir, objectKey, type Target } from './storage';
import { escapeXml } from './xml';

function fileHeaders(object: R2Object): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('ETag', object.httpEtag);
	headers.set('Last-Modified', object.uploaded.toUTCString());
	headers.set('Accept-Ranges', 'bytes');
	return headers;
}

function byteRange(range: R2Range, size: number): { start: number; end: number } {
	// R2 returns every key of the range, with the unused ones set to undefined, so `in` checks cannot discriminate.
	const { offset, length, suffix } = range as { offset?: number; length?: number; suffix?: number };
	if (suffix !== undefined) return { start: Math.max(size - suffix, 0), end: size - 1 };
	const start = offset ?? 0;
	return { start, end: Math.min(start + (length ?? size - start), size) - 1 };
}

function fileResponse(request: Request, object: R2Object | R2ObjectBody): Response {
	const headers = fileHeaders(object);
	if (!('body' in object)) {
		const revalidating = request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since');
		return new Response(null, { status: revalidating ? 304 : 412, headers });
	}
	if (request.headers.has('Range') && object.range) {
		const { start, end } = byteRange(object.range, object.size);
		headers.set('Content-Range', `bytes ${String(start)}-${String(end)}/${String(object.size)}`);
		return new Response(object.body, { status: 206, headers });
	}
	return new Response(object.body, { headers });
}

async function dirListing(bucket: R2Bucket, user: string, path: string[]): Promise<Response> {
	const entries = await listDir(bucket, user, path);
	const title = escapeXml(`/${path.join('/')}`);
	const items = entries
		.map((entry) => {
			const name = escapeXml(displayName(entry) + (entry.type === 'dir' ? '/' : ''));
			return `<li><a href="${escapeXml(href(entry))}">${name}</a></li>`;
		})
		.join('');
	const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><ul>${items}</ul>`;
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function handleGet(request: Request, bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	if (!target.wantsDir && target.path.length > 0) {
		const object = await bucket.get(objectKey(user, target.path), { onlyIf: request.headers, range: request.headers });
		if (object) return fileResponse(request, object);
	}
	if (await dirExists(bucket, user, target.path)) return dirListing(bucket, user, target.path);
	throw new HttpError(404);
}

export async function handleHead(bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	if (!target.wantsDir && target.path.length > 0) {
		const object = await bucket.head(objectKey(user, target.path));
		if (object) {
			const headers = fileHeaders(object);
			headers.set('Content-Length', String(object.size));
			return new Response(null, { headers });
		}
	}
	if (await dirExists(bucket, user, target.path)) return new Response(null, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	throw new HttpError(404);
}
