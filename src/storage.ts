import { HttpError } from './http';

/** A resource inside a user's root; `path` holds decoded segments, empty for the root. */
export type Entry = { type: 'file'; path: string[]; object: R2Object } | { type: 'dir'; path: string[] };

export interface Target {
	path: string[];
	/** The request URL ended in `/`, so only a collection can match. */
	wantsDir: boolean;
}

export function parseTarget(pathname: string): Target {
	let path: string[];
	try {
		path = pathname
			.split('/')
			.filter((segment) => segment !== '')
			.map(decodeURIComponent);
	} catch (error) {
		if (error instanceof URIError) throw new HttpError(400);
		throw error;
	}
	// An encoded slash would break the one-to-one mapping of paths to keys, e.g. `a%2F` naming the folder marker `a/`.
	if (path.some((segment) => segment.includes('/'))) throw new HttpError(400);
	return { path, wantsDir: pathname.endsWith('/') };
}

export function objectKey(user: string, path: string[]): string {
	return [user, ...path].join('/');
}

export function dirPrefix(user: string, path: string[]): string {
	return `${objectKey(user, path)}/`;
}

export const CREATE_ONLY = (): Headers => new Headers({ 'If-None-Match': '*' });

/** Every object below a collection, including its folder marker, at any depth. */
export async function listTree(bucket: R2Bucket, user: string, path: string[]): Promise<R2Object[]> {
	const prefix = dirPrefix(user, path);
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, include: ['httpMetadata', 'customMetadata'], cursor });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
	return objects;
}

export async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
	for (let start = 0; start < keys.length; start += 1000) await bucket.delete(keys.slice(start, start + 1000));
}

export async function deleteTree(bucket: R2Bucket, user: string, path: string[]): Promise<void> {
	await deleteKeys(
		bucket,
		(await listTree(bucket, user, path)).map((object) => object.key),
	);
}

/** Creates the folder marker for `path`, so the collection survives after its last member is removed. */
export async function keepDir(bucket: R2Bucket, user: string, path: string[]): Promise<void> {
	if (path.length > 0) await bucket.put(dirPrefix(user, path), '', { onlyIf: CREATE_ONLY() });
}

export function href(entry: Pick<Entry, 'type' | 'path'>): string {
	const encoded = entry.path.map(encodeURIComponent).join('/');
	if (entry.type === 'file') return `/${encoded}`;
	return entry.path.length === 0 ? '/' : `/${encoded}/`;
}

export function displayName(entry: Entry): string {
	return entry.path.at(-1) ?? '';
}

export async function dirExists(bucket: R2Bucket, user: string, path: string[]): Promise<boolean> {
	if (path.length === 0) return true;
	const page = await bucket.list({ prefix: dirPrefix(user, path), limit: 1 });
	return page.objects.length > 0 || page.delimitedPrefixes.length > 0;
}

export async function stat(bucket: R2Bucket, user: string, target: Target): Promise<Entry | null> {
	if (!target.wantsDir && target.path.length > 0) {
		const object = await bucket.head(objectKey(user, target.path));
		if (object) return { type: 'file', path: target.path, object };
	}
	return (await dirExists(bucket, user, target.path)) ? { type: 'dir', path: target.path } : null;
}

export async function listDir(bucket: R2Bucket, user: string, path: string[]): Promise<Entry[]> {
	const prefix = dirPrefix(user, path);
	const entries: Entry[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, delimiter: '/', include: ['httpMetadata'], cursor });
		for (const object of page.objects) {
			const name = object.key.slice(prefix.length);
			// An empty name is a zero-byte "folder/" marker object, which S3 tools create.
			if (name !== '') entries.push({ type: 'file', path: [...path, name], object });
		}
		for (const delimited of page.delimitedPrefixes) {
			const name = delimited.slice(prefix.length, -1);
			if (name !== '') entries.push({ type: 'dir', path: [...path, name] });
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
	return entries;
}
