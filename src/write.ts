import { appliedToken, checkIf, checkPreconditions } from './conditions';
import { ALLOW, HttpError } from './http';
import {
	CREATE_ONLY,
	deleteKeys,
	deleteTree,
	dirExists,
	dirPrefix,
	keepDir,
	listTree,
	objectKey,
	parseTarget,
	stat,
	type Entry,
	type Target,
} from './storage';

/** R2 parts must be equal in size except the last, and at least 5 MiB. */
const PART_SIZE = 10 * 1024 * 1024;

/**
 * The state a write expects to replace: `undefined` writes unconditionally, `null` requires the key to be absent,
 * and an object requires its etag to be unchanged.
 */
type Guard = R2Object | null | undefined;

interface WriteOptions {
	guard: Guard;
	httpMetadata?: R2HTTPMetadata | Headers;
	customMetadata: Record<string, string>;
}

function putOptions({ guard, httpMetadata, customMetadata }: WriteOptions): R2PutOptions {
	return { onlyIf: guard === undefined ? undefined : guard ? { etagMatches: guard.etag } : CREATE_ONLY(), httpMetadata, customMetadata };
}

async function* parts(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	let buffer = new Uint8Array(PART_SIZE);
	let filled = 0;
	for await (const chunk of stream) {
		for (let offset = 0; offset < chunk.byteLength;) {
			const length = Math.min(PART_SIZE - filled, chunk.byteLength - offset);
			buffer.set(chunk.subarray(offset, offset + length), filled);
			filled += length;
			offset += length;
			if (filled === PART_SIZE) {
				yield buffer;
				buffer = new Uint8Array(PART_SIZE);
				filled = 0;
			}
		}
	}
	if (filled > 0) yield buffer.subarray(0, filled);
}

/**
 * R2 rejects streams of unknown length, which chunked uploads (such as Finder's) produce. Bodies that fit in one
 * part are written with a single guarded put; larger ones go through a multipart upload.
 */
async function putUnknownLength(
	bucket: R2Bucket,
	key: string,
	stream: ReadableStream<Uint8Array>,
	options: WriteOptions,
): Promise<R2Object | null> {
	const chunks = parts(stream);
	const first = await chunks.next();
	if (first.done) return bucket.put(key, '', putOptions(options));
	const second = await chunks.next();
	if (second.done) return bucket.put(key, first.value, putOptions(options));

	const upload = await bucket.createMultipartUpload(key, { httpMetadata: options.httpMetadata, customMetadata: options.customMetadata });
	try {
		const uploaded = [await upload.uploadPart(1, first.value), await upload.uploadPart(2, second.value)];
		for await (const part of chunks) uploaded.push(await upload.uploadPart(uploaded.length + 1, part));
		// Completing a multipart upload is not conditional, so the guard is re-checked just before; a narrow race remains.
		if (options.guard !== undefined && (await bucket.head(key))?.etag !== options.guard?.etag) {
			await upload.abort();
			return null;
		}
		return await upload.complete(uploaded);
	} catch (error) {
		await upload.abort();
		throw error;
	}
}

function withLock(customMetadata: Record<string, string> | undefined, lockId: string | undefined): Record<string, string> {
	const metadata = { ...customMetadata };
	delete metadata.lock;
	return lockId === undefined ? metadata : { ...metadata, lock: lockId };
}

export async function handlePut(request: Request, bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	if (target.wantsDir || target.path.length === 0) throw new HttpError(405, null, { Allow: ALLOW });
	const key = objectKey(user, target.path);
	const [existing, isDir, parentExists] = await Promise.all([
		bucket.head(key),
		dirExists(bucket, user, target.path),
		dirExists(bucket, user, target.path.slice(0, -1)),
	]);
	if (isDir) throw new HttpError(405, null, { Allow: ALLOW });
	if (!parentExists) throw new HttpError(409);

	const entry: Entry | null = existing && { type: 'file', path: target.path, object: existing };
	const conditional = checkPreconditions(request.headers, entry);
	const groups = await checkIf(request, bucket, user, [[target.path, entry]]);
	const contentType = request.headers.get('Content-Type');
	const options: WriteOptions = {
		// Whatever the conditions were checked against must still be current when the write lands.
		guard: conditional || groups ? existing : undefined,
		httpMetadata: contentType ? { contentType } : undefined,
		customMetadata: withLock(existing?.customMetadata, appliedToken(groups, target.path, entry)?.id),
	};
	const written =
		request.headers.has('Content-Length') || request.body === null
			? await bucket.put(key, request.body ?? '', putOptions(options))
			: await putUnknownLength(bucket, key, request.body as ReadableStream<Uint8Array>, options);
	if (!written) throw new HttpError(412);
	return new Response(null, { status: existing ? 204 : 201, headers: { ETag: written.httpEtag } });
}

export async function handleDelete(request: Request, bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	if (target.path.length === 0) throw new HttpError(403);
	const entry = await stat(bucket, user, target);
	if (!entry) throw new HttpError(404);
	const depth = request.headers.get('Depth');
	if (entry.type === 'dir' && depth !== null && depth !== 'infinity') throw new HttpError(400);
	checkPreconditions(request.headers, entry);
	await checkIf(request, bucket, user, [[entry.path, entry]]);

	// DELETE cannot be conditional in R2, so the checks above race with concurrent writers.
	if (entry.type === 'file') await bucket.delete(entry.object.key);
	else await deleteTree(bucket, user, entry.path);
	await keepDir(bucket, user, entry.path.slice(0, -1));
	return new Response(null, { status: 204 });
}

export async function handleMkcol(bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	if (target.path.length === 0 || (await stat(bucket, user, { path: target.path, wantsDir: false }))) {
		throw new HttpError(405, null, { Allow: ALLOW });
	}
	if (!(await dirExists(bucket, user, target.path.slice(0, -1)))) throw new HttpError(409);
	if (!(await bucket.put(dirPrefix(user, target.path), '', { onlyIf: CREATE_ONLY() }))) throw new HttpError(405, null, { Allow: ALLOW });
	return new Response(null, { status: 201 });
}

/** Copies `from` to `to`; `onlyIf` makes the source read conditional, failing with 412. */
async function copyObject(
	bucket: R2Bucket,
	from: string,
	to: string,
	guard: Guard,
	lockId?: string,
	onlyIf?: R2Conditional,
): Promise<R2Object | null> {
	const object = await bucket.get(from, { onlyIf });
	if (!object) throw new HttpError(404);
	if (!('body' in object)) throw new HttpError(412);
	return bucket.put(
		to,
		object.body,
		putOptions({ guard, httpMetadata: object.httpMetadata, customMetadata: withLock(object.customMetadata, lockId) }),
	);
}

function destinationTarget(request: Request): Target {
	const destination = request.headers.get('Destination');
	if (destination === null) throw new HttpError(400);
	let url: URL;
	try {
		url = new URL(destination, request.url);
	} catch {
		throw new HttpError(400);
	}
	if (url.host !== new URL(request.url).host) throw new HttpError(502);
	return parseTarget(url.pathname);
}

/**
 * R2 has no server-side copy, so objects are streamed through the Worker, two R2 operations each. Collection
 * copies are therefore bounded by the per-request subrequest limit, and are not atomic.
 */
export async function handleCopyMove(request: Request, bucket: R2Bucket, user: string, target: Target, move: boolean): Promise<Response> {
	const dest = destinationTarget(request);
	const source = await stat(bucket, user, target);
	if (!source) throw new HttpError(404);

	const from = source.path.join('/');
	const to = dest.path.join('/');
	// Overlapping trees are refused: replacing an ancestor would delete the source, and copying into a descendant recurses.
	if (
		source.path.length === 0 ||
		dest.path.length === 0 ||
		to === from ||
		from.startsWith(`${to}/`) ||
		(source.type === 'dir' && to.startsWith(`${from}/`))
	) {
		throw new HttpError(403);
	}
	const depth = request.headers.get('Depth');
	if (source.type === 'dir' && depth !== null && depth !== 'infinity' && (move || depth !== '0')) throw new HttpError(400);

	const [existing, parentExists] = await Promise.all([
		stat(bucket, user, { path: dest.path, wantsDir: false }),
		dirExists(bucket, user, dest.path.slice(0, -1)),
	]);
	if (!parentExists) throw new HttpError(409);
	if (existing && request.headers.get('Overwrite')?.trim().toUpperCase() === 'F') throw new HttpError(412);

	const replacesFile = existing?.type === 'file' && source.type === 'file';
	// If-Match and friends apply to the source only (RFC 4918 §10.6); the destination is guarded by If header lists.
	checkPreconditions(request.headers, source);
	const groups = await checkIf(request, bucket, user, [
		[source.path, source],
		[dest.path, existing],
	]);
	const guard = groups ? (existing?.type === 'file' ? existing.object : null) : undefined;
	const lockId = appliedToken(groups, dest.path, existing)?.id;
	if (existing && !replacesFile) {
		if (existing.type === 'file') await bucket.delete(existing.object.key);
		else await deleteTree(bucket, user, existing.path);
	}

	if (source.type === 'file') {
		const { key, etag } = source.object;
		const written = await copyObject(bucket, key, objectKey(user, dest.path), replacesFile ? guard : null, lockId, { etagMatches: etag });
		if (!written) throw new HttpError(412);
		if (move) {
			// R2 deletes cannot be conditional; a source changed since the copy is kept, leaving both.
			if ((await bucket.head(key))?.etag !== etag) throw new HttpError(412);
			await bucket.delete(key);
		}
	} else {
		const objects = depth === '0' ? [] : await listTree(bucket, user, source.path);
		const fromPrefix = dirPrefix(user, source.path);
		const toPrefix = dirPrefix(user, dest.path);
		for (const object of objects) await copyObject(bucket, object.key, toPrefix + object.key.slice(fromPrefix.length), undefined);
		await keepDir(bucket, user, dest.path);
		if (move)
			await deleteKeys(
				bucket,
				objects.map((object) => object.key),
			);
	}
	if (move) await keepDir(bucket, user, source.path.slice(0, -1));
	return new Response(null, { status: existing ? 204 : 201 });
}
