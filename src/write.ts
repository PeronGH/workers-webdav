import { ALLOW, HttpError } from './http';
import { lockPermits, lockTokens } from './lock';
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

function etagList(value: string): string[] {
	return value.split(',').map((etag) => etag.trim().replace(/^W\//, ''));
}

function clientConditionsPass(headers: Headers, object: R2Object | null): boolean {
	const ifMatch = headers.get('If-Match');
	if (ifMatch !== null && !(object && (ifMatch.trim() === '*' || etagList(ifMatch).includes(object.httpEtag)))) return false;
	const ifNoneMatch = headers.get('If-None-Match');
	return !(ifNoneMatch !== null && object && (ifNoneMatch.trim() === '*' || etagList(ifNoneMatch).includes(object.httpEtag)));
}

/**
 * Decides whether a write to `path` may replace `existing`, from lock tokens in the If header and, for the
 * request URI, the client's own If-Match / If-None-Match. Conditional writes are guarded against races.
 */
function writeConditions(
	request: Request,
	path: string[],
	isRequestUri: boolean,
	existing: R2Object | null,
): { guard: Guard; lockId?: string } {
	const conditional = isRequestUri && (request.headers.has('If-Match') || request.headers.has('If-None-Match'));
	if (conditional && !clientConditionsPass(request.headers, existing)) throw new HttpError(412);

	const tokens = lockTokens(request, path, isRequestUri);
	if (tokens === null) return { guard: conditional ? existing : undefined };
	const token = tokens.find((candidate) => lockPermits(candidate, existing));
	if (!token) throw new HttpError(412);
	return { guard: existing, lockId: token.id };
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

	const { guard, lockId } = writeConditions(request, target.path, true, existing);
	const contentType = request.headers.get('Content-Type');
	const options: WriteOptions = {
		guard,
		httpMetadata: contentType ? { contentType } : undefined,
		customMetadata: withLock(existing?.customMetadata, lockId),
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

	if (entry.type === 'file') {
		// DELETE cannot be conditional in R2, so this check races with concurrent writers.
		const tokens = lockTokens(request, entry.path, true);
		if (tokens && !tokens.some((token) => lockPermits(token, entry.object))) throw new HttpError(412);
		await bucket.delete(entry.object.key);
	} else {
		const depth = request.headers.get('Depth');
		if (depth !== null && depth !== 'infinity') throw new HttpError(400);
		await deleteTree(bucket, user, entry.path);
	}
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

async function copyObject(bucket: R2Bucket, from: string, to: string, guard: Guard, lockId?: string): Promise<R2Object | null> {
	const object = await bucket.get(from);
	if (!object) throw new HttpError(404);
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
	const { guard, lockId } = writeConditions(request, dest.path, false, existing?.type === 'file' ? existing.object : null);
	if (existing && !replacesFile) {
		if (existing.type === 'file') await bucket.delete(existing.object.key);
		else await deleteTree(bucket, user, existing.path);
	}

	if (source.type === 'file') {
		const written = await copyObject(bucket, source.object.key, objectKey(user, dest.path), replacesFile ? guard : null, lockId);
		if (!written) throw new HttpError(412);
		if (move) await bucket.delete(source.object.key);
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
