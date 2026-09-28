import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { derivePassword } from '../src/auth';

const BASE = 'https://dav.example';

async function authHeader(user: string): Promise<string> {
	return `Basic ${btoa(`${user}:${await derivePassword(env.AUTH_SECRET, user)}`)}`;
}

async function dav(user: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
	return exports.default.fetch(`${BASE}${path}`, { method, headers: { Authorization: await authHeader(user), ...headers }, body });
}

beforeAll(async () => {
	await env.BUCKET.put('alice/hello.txt', 'Hello, world!', { httpMetadata: { contentType: 'text/plain' } });
	await env.BUCKET.put('alice/docs/a b.md', '# A');
	await env.BUCKET.put('alice/empty/', '');
	await env.BUCKET.put('bob/secret.txt', 'bob only');
});

describe('auth', () => {
	it('answers OPTIONS without credentials', async () => {
		const response = await exports.default.fetch(`${BASE}/`, { method: 'OPTIONS' });
		expect(response.status).toBe(200);
		expect(response.headers.get('DAV')).toBe('1');
		expect(response.headers.get('Allow')).toBe('OPTIONS, GET, HEAD, PROPFIND');
	});

	it('rejects missing and wrong credentials', async () => {
		const missing = await exports.default.fetch(`${BASE}/hello.txt`);
		expect(missing.status).toBe(401);
		expect(missing.headers.get('WWW-Authenticate')).toContain('Basic');

		const wrong = await exports.default.fetch(`${BASE}/hello.txt`, { headers: { Authorization: `Basic ${btoa('alice:nope')}` } });
		expect(wrong.status).toBe(401);

		const borrowed = await exports.default.fetch(`${BASE}/hello.txt`, {
			headers: { Authorization: `Basic ${btoa(`bob:${await derivePassword(env.AUTH_SECRET, 'alice')}`)}` },
		});
		expect(borrowed.status).toBe(401);
	});

	it('rejects usernames outside the allowed charset', async () => {
		const response = await exports.default.fetch(`${BASE}/`, {
			method: 'PROPFIND',
			headers: { Authorization: `Basic ${btoa(`Alice:${await derivePassword(env.AUTH_SECRET, 'Alice')}`)}`, Depth: '0' },
		});
		expect(response.status).toBe(401);
	});

	it('scopes each user to their own prefix', async () => {
		expect((await dav('alice', 'GET', '/secret.txt')).status).toBe(404);
		expect((await dav('alice', 'GET', '/../bob/secret.txt')).status).toBe(404);
		expect(await (await dav('bob', 'GET', '/secret.txt')).text()).toBe('bob only');
	});
});

describe('GET / HEAD', () => {
	it('serves files with metadata', async () => {
		const response = await dav('alice', 'GET', '/hello.txt');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/plain');
		expect(response.headers.get('ETag')).toMatch(/^".+"$/);
		expect(await response.text()).toBe('Hello, world!');
	});

	it('serves byte ranges', async () => {
		const response = await dav('alice', 'GET', '/hello.txt', { Range: 'bytes=7-11' });
		expect(response.status).toBe(206);
		expect(response.headers.get('Content-Range')).toBe('bytes 7-11/13');

		const suffix = await dav('alice', 'GET', '/hello.txt', { Range: 'bytes=-6' });
		expect(suffix.headers.get('Content-Range')).toBe('bytes 7-12/13');
		expect(await response.text()).toBe('world');
	});

	it('revalidates with If-None-Match', async () => {
		const etag = (await dav('alice', 'HEAD', '/hello.txt')).headers.get('ETag') ?? '';
		const response = await dav('alice', 'GET', '/hello.txt', { 'If-None-Match': etag });
		expect(response.status).toBe(304);
	});

	it('answers HEAD with length and no body', async () => {
		const response = await dav('alice', 'HEAD', '/hello.txt');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Length')).toBe('13');
	});

	it('lists directories as HTML', async () => {
		const response = await dav('alice', 'GET', '/');
		const html = await response.text();
		expect(response.headers.get('Content-Type')).toContain('text/html');
		expect(html).toContain('href="/hello.txt"');
		expect(html).toContain('href="/docs/"');
	});

	it('returns 404 for missing paths', async () => {
		expect((await dav('alice', 'GET', '/nope')).status).toBe(404);
		expect((await dav('alice', 'GET', '/hello.txt/')).status).toBe(404);
	});
});

describe('PROPFIND', () => {
	function hrefs(xml: string): string[] {
		return [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((match) => match[1]).sort();
	}

	it('lists a collection at depth 1', async () => {
		const response = await dav('alice', 'PROPFIND', '/', { Depth: '1' });
		expect(response.status).toBe(207);
		const xml = await response.text();
		expect(hrefs(xml)).toEqual(['/', '/docs/', '/empty/', '/hello.txt']);
		expect(xml).toContain('<D:getcontentlength>13</D:getcontentlength>');
		expect(xml).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
	});

	it('percent-encodes hrefs and hides folder markers', async () => {
		expect(hrefs(await (await dav('alice', 'PROPFIND', '/docs/', { Depth: '1' })).text())).toEqual(['/docs/', '/docs/a%20b.md']);
		expect(hrefs(await (await dav('alice', 'PROPFIND', '/empty/', { Depth: '1' })).text())).toEqual(['/empty/']);
	});

	it('refuses infinite or missing depth on collections', async () => {
		for (const headers of [{ Depth: 'infinity' }, {}] as Record<string, string>[]) {
			const response = await dav('alice', 'PROPFIND', '/docs', headers);
			expect(response.status).toBe(403);
			expect(await response.text()).toContain('<D:propfind-finite-depth/>');
		}
	});

	it('ignores depth on files', async () => {
		const response = await dav('alice', 'PROPFIND', '/hello.txt', { Depth: 'infinity' });
		expect(response.status).toBe(207);
		expect(hrefs(await response.text())).toEqual(['/hello.txt']);
	});

	it('returns named properties and 404s unknown ones', async () => {
		const body = `<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:z="urn:z"><prop><getetag/><z:color/><creationdate/></prop></propfind>`;
		const xml = await (await dav('alice', 'PROPFIND', '/hello.txt', { Depth: '0' }, body)).text();
		expect(xml).toMatch(/<D:propstat><D:prop><D:getetag>&quot;.+&quot;<\/D:getetag><\/D:prop><D:status>HTTP\/1.1 200 OK<\/D:status>/);
		expect(xml).toContain('<D:prop><x:color xmlns:x="urn:z"/><D:creationdate/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status>');
	});

	it('returns property names for propname', async () => {
		const body = '<propfind xmlns="DAV:"><propname/></propfind>';
		const xml = await (await dav('alice', 'PROPFIND', '/', { Depth: '0' }, body)).text();
		expect(xml).toContain('<D:resourcetype/>');
		expect(xml).not.toContain('<D:collection/>');
	});

	it('rejects malformed bodies', async () => {
		expect((await dav('alice', 'PROPFIND', '/', { Depth: '0' }, '<propfind xmlns="DAV:">')).status).toBe(400);
		expect((await dav('alice', 'PROPFIND', '/', { Depth: '0' }, '<foo/>')).status).toBe(400);
	});

	it('returns 404 for missing paths', async () => {
		expect((await dav('alice', 'PROPFIND', '/nope', { Depth: '0' })).status).toBe(404);
	});
});

describe('read-only', () => {
	it('refuses write methods', async () => {
		for (const method of ['PUT', 'DELETE', 'MKCOL', 'COPY', 'MOVE', 'PROPPATCH', 'LOCK', 'UNLOCK']) {
			const response = await dav('alice', method, '/hello.txt', {}, 'body');
			expect(response.status, method).toBe(405);
			expect(response.headers.get('Allow')).toBe('OPTIONS, GET, HEAD, PROPFIND');
		}
	});

	it('rejects unexpected request bodies', async () => {
		expect((await dav('alice', 'OPTIONS', '/', {}, 'x')).status).toBe(415);
	});
});
