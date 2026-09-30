import { appliedToken, checkIf, checkPreconditions } from './conditions';
import { HttpError } from './http';
import { CREATE_ONLY, deleteKeys, dirExists, listPrefix, objectKey, stat, uploadPrefix } from './storage';
import { destinationTarget, putOptions, putUnknownLength, withLock, type WriteOptions } from './write';

/*
 * Nextcloud's chunked upload v1: MKCOL an upload collection, PUT the chunks into it under names that sort in
 * order, then MOVE its virtual `.file` member to the destination, which joins the chunks. DELETE aborts. A
 * `Destination` header on the other requests (v2) is ignored, as Nextcloud does on storage without multipart.
 */

const ALLOW = 'OPTIONS, MKCOL, PUT, MOVE, DELETE';

/** R2's single-put limit, 5 GiB less 5 MiB; larger files are written as multipart uploads. */
const MAX_PUT = 5 * 1024 ** 3 - 5 * 1024 ** 2;

export async function handleUpload(request: Request, bucket: R2Bucket, user: string, path: string[]): Promise<Response> {
	if (path.length === 0 || path.length > 2) throw new HttpError(405, null, { Allow: ALLOW });
	const [id, name] = path;
	const prefix = uploadPrefix(user, id);
	switch (`${request.method} ${path.length === 1 ? 'collection' : name === '.file' ? 'file' : 'chunk'}`) {
		case 'MKCOL collection':
			if (!(await bucket.put(prefix, '', { onlyIf: CREATE_ONLY() }))) throw new HttpError(405, null, { Allow: ALLOW });
			return new Response(null, { status: 201 });
		case 'PUT chunk': {
			const key = prefix + name;
			if (request.body === null || request.headers.has('Content-Length')) await bucket.put(key, request.body ?? '');
			else await putUnknownLength(bucket, key, request.body as ReadableStream<Uint8Array>, { guard: undefined, customMetadata: {} });
			return new Response(null, { status: 201 });
		}
		case 'DELETE collection': {
			const keys = (await listPrefix(bucket, prefix)).map((object) => object.key);
			if (keys.length === 0) throw new HttpError(404);
			await deleteKeys(bucket, keys);
			return new Response(null, { status: 204 });
		}
		case 'MOVE file':
			return assemble(request, bucket, user, prefix);
		default:
			throw new HttpError(405, null, { Allow: ALLOW });
	}
}

/** The chunks back to back; piping between R2 and a FixedLengthStream stays out of JavaScript. */
function concatenate(bucket: R2Bucket, chunks: R2Object[], size: number): ReadableStream<Uint8Array> {
	const { readable, writable } = new FixedLengthStream(size);
	void (async () => {
		try {
			for (const chunk of chunks) {
				const object = await bucket.get(chunk.key, { onlyIf: { etagMatches: chunk.etag } });
				if (!object || !('body' in object)) throw new Error(`chunk ${chunk.key} changed during assembly`);
				await object.body.pipeTo(writable, { preventClose: true });
			}
			await writable.close();
		} catch (error) {
			await writable.abort(error);
		}
	})();
	return readable;
}

async function assemble(request: Request, bucket: R2Bucket, user: string, prefix: string): Promise<Response> {
	const dest = destinationTarget(request, user);
	if (dest.path.length === 0) throw new HttpError(403);
	const [objects, existing, parentExists] = await Promise.all([
		listPrefix(bucket, prefix),
		stat(bucket, user, { path: dest.path, wantsDir: false }),
		dirExists(bucket, user, dest.path.slice(0, -1)),
	]);
	if (objects.length === 0) throw new HttpError(404);
	if (!parentExists) throw new HttpError(409);
	if (existing?.type === 'dir') throw new HttpError(400);
	if (existing && request.headers.get('Overwrite')?.trim().toUpperCase() === 'F') throw new HttpError(412);
	// The virtual source has no validators, so If-Match and friends apply to the destination.
	const conditional = checkPreconditions(request.headers, existing);
	const groups = await checkIf(request, bucket, user, [[dest.path, existing]]);

	const chunks = objects.filter((object) => object.key !== prefix).sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
	const size = chunks.reduce((total, chunk) => total + chunk.size, 0);
	const expected = request.headers.get('OC-Total-Length');
	if (expected !== null && Number(expected) !== size) throw new HttpError(400);

	const options: WriteOptions = {
		guard: conditional || groups ? (existing?.object ?? null) : undefined,
		customMetadata: withLock(existing?.object.customMetadata, appliedToken(groups, dest.path, existing)?.id),
	};
	const key = objectKey(user, dest.path);
	const body = concatenate(bucket, chunks, size);
	const written = size <= MAX_PUT ? await bucket.put(key, body, putOptions(options)) : await putUnknownLength(bucket, key, body, options);
	if (!written) throw new HttpError(412);
	await deleteKeys(
		bucket,
		objects.map((object) => object.key),
	);
	return new Response(null, { status: existing ? 204 : 201, headers: { ETag: written.httpEtag } });
}
