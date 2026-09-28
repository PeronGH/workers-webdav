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

interface ByteRange {
	start: number;
	end: number;
}

/** Parses a single `bytes=` range (RFC 9110 §14); null means the header is ignored and the whole file is served. */
function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, first, last] = match;
	if (first === '') {
		if (last === '') return null;
		const suffix = Number(last);
		return suffix === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(size - suffix, 0), end: size - 1 };
	}
	const start = Number(first);
	if (last !== '' && Number(last) < start) return null;
	if (start >= size) return 'unsatisfiable';
	return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}

function fileResponse(request: Request, object: R2Object | R2ObjectBody, range: ByteRange | null): Response {
	const headers = fileHeaders(object);
	if (!('body' in object)) {
		const revalidating = request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since');
		return new Response(null, { status: revalidating ? 304 : 412, headers });
	}
	if (range) {
		headers.set('Content-Range', `bytes ${String(range.start)}-${String(range.end)}/${String(object.size)}`);
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
		const key = objectKey(user, target.path);
		// Ranges are resolved here against the size, since R2 does not reject unsatisfiable ones consistently.
		const rangeHeader = request.headers.get('Range');
		const size = rangeHeader === null ? undefined : (await bucket.head(key))?.size;
		const range = rangeHeader === null || size === undefined ? null : parseRange(rangeHeader, size);
		if (range === 'unsatisfiable') {
			return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${String(size)}` } });
		}
		const object = await bucket.get(key, {
			onlyIf: request.headers,
			range: range ? { offset: range.start, length: range.end - range.start + 1 } : undefined,
		});
		if (object) return fileResponse(request, object, range);
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
