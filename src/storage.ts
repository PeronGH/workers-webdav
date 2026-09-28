import { HttpError } from './http';

/** A resource inside a user's root; `path` holds decoded segments, empty for the root. */
export type Entry = { type: 'file'; path: string[]; object: R2Object } | { type: 'dir'; path: string[] };

export interface Target {
	path: string[];
	/** The request URL ended in `/`, so only a collection can match. */
	wantsDir: boolean;
}

export function parseTarget(pathname: string): Target {
	try {
		return {
			path: pathname
				.split('/')
				.filter((segment) => segment !== '')
				.map(decodeURIComponent),
			wantsDir: pathname.endsWith('/'),
		};
	} catch (error) {
		if (error instanceof URIError) throw new HttpError(400);
		throw error;
	}
}

export function objectKey(user: string, path: string[]): string {
	return [user, ...path].join('/');
}

function dirPrefix(user: string, path: string[]): string {
	return `${objectKey(user, path)}/`;
}

export function href(entry: Entry): string {
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
