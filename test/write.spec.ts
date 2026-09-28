import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { dav, hrefs } from './helpers';

const LOCK_BODY =
	'<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>me</D:href></D:owner></D:lockinfo>';

async function read(user: string, path: string): Promise<string | null> {
	return (await env.BUCKET.get(`${user}${path}`))?.text() ?? null;
}

async function lock(user: string, path: string, status = 200): Promise<string> {
	const response = await dav(user, 'LOCK', path, { Timeout: 'Second-600' }, LOCK_BODY);
	expect(response.status).toBe(status);
	return /^<(.+)>$/.exec(response.headers.get('Lock-Token') ?? '')?.[1] ?? '';
}

describe('PUT', () => {
	it('creates, overwrites and stores the content type', async () => {
		expect((await dav('carol', 'PUT', '/a.txt', { 'Content-Type': 'text/plain' }, 'one')).status).toBe(201);
		expect((await dav('carol', 'PUT', '/a.txt', { 'Content-Type': 'text/plain' }, 'two')).status).toBe(204);
		const response = await dav('carol', 'GET', '/a.txt');
		expect(response.headers.get('Content-Type')).toBe('text/plain');
		expect(await response.text()).toBe('two');
	});

	it('requires the parent collection', async () => {
		expect((await dav('carol', 'PUT', '/missing/a.txt', {}, 'x')).status).toBe(409);
		expect((await dav('carol', 'PUT', '/dir/', {}, 'x')).status).toBe(405);
	});

	it('accepts chunked bodies, using multipart uploads when large', async () => {
		const stream = (size: number) => new Blob([new Uint8Array(size).fill(97)]).stream().pipeThrough(new TransformStream());
		expect((await dav('carol', 'PUT', '/small.bin', {}, stream(1000))).status).toBe(201);
		expect((await env.BUCKET.head('carol/small.bin'))?.size).toBe(1000);

		const size = 10 * 1024 * 1024 + 123;
		expect((await dav('carol', 'PUT', '/large.bin', {}, stream(size))).status).toBe(201);
		expect((await env.BUCKET.head('carol/large.bin'))?.size).toBe(size);
	});

	it('honours If-Match and If-None-Match', async () => {
		await dav('carol', 'PUT', '/cond.txt', {}, 'v1');
		expect((await dav('carol', 'PUT', '/cond.txt', { 'If-None-Match': '*' }, 'v2')).status).toBe(412);
		expect((await dav('carol', 'PUT', '/cond.txt', { 'If-Match': '"nope"' }, 'v2')).status).toBe(412);
		const etag = (await dav('carol', 'HEAD', '/cond.txt')).headers.get('ETag') ?? '';
		expect((await dav('carol', 'PUT', '/cond.txt', { 'If-Match': etag }, 'v2')).status).toBe(204);
		expect(await read('carol', '/cond.txt')).toBe('v2');

		expect((await dav('carol', 'PUT', '/cond.txt', { 'If-Match': `W/${etag}` }, 'v3')).status).toBe(412);
		const past = 'Sat, 01 Jan 2000 00:00:00 GMT';
		expect((await dav('carol', 'PUT', '/cond.txt', { 'If-Unmodified-Since': past }, 'v3')).status).toBe(412);
		expect(await read('carol', '/cond.txt')).toBe('v2');
	});

	it('evaluates entity tags and Not in the If header', async () => {
		await dav('carol', 'PUT', '/if.txt', {}, 'v1');
		const etag = (await dav('carol', 'HEAD', '/if.txt')).headers.get('ETag') ?? '';
		expect((await dav('carol', 'PUT', '/if.txt', { If: '(["stale"])' }, 'v2')).status).toBe(412);
		expect((await dav('carol', 'PUT', '/if.txt', { If: '(["stale"]) (Not ["other"])' }, 'v2')).status).toBe(204);
		const current = (await dav('carol', 'HEAD', '/if.txt')).headers.get('ETag') ?? '';
		expect(current).not.toBe(etag);
		expect((await dav('carol', 'PUT', '/if.txt', { If: `([${etag}])` }, 'v3')).status).toBe(412);
		expect((await dav('carol', 'PUT', '/if.txt', { If: `</if.txt> ([${current}])` }, 'v3')).status).toBe(204);
		expect((await dav('carol', 'PUT', '/new-if.txt', { If: '(Not <DAV:no-lock>)' }, 'x')).status).toBe(201);
		expect((await dav('carol', 'PUT', '/if.txt', { If: '(["unterminated"' }, 'v4')).status).toBe(400);
		expect(await read('carol', '/if.txt')).toBe('v3');
	});
});

describe('MKCOL / DELETE', () => {
	it('creates empty collections', async () => {
		expect((await dav('dave', 'MKCOL', '/new')).status).toBe(201);
		expect((await dav('dave', 'MKCOL', '/new')).status).toBe(405);
		expect((await dav('dave', 'MKCOL', '/a/b')).status).toBe(409);
		expect(hrefs(await (await dav('dave', 'PROPFIND', '/', { Depth: '1' })).text())).toContain('/new/');
	});

	it('keeps the parent collection when its last member is deleted', async () => {
		await env.BUCKET.put('dave/implicit/only.txt', 'x');
		expect((await dav('dave', 'DELETE', '/implicit/only.txt')).status).toBe(204);
		expect((await dav('dave', 'PROPFIND', '/implicit/', { Depth: '0' })).status).toBe(207);
	});

	it('deletes collections recursively', async () => {
		await env.BUCKET.put('dave/tree/a.txt', 'a');
		await env.BUCKET.put('dave/tree/sub/b.txt', 'b');
		expect((await dav('dave', 'DELETE', '/tree/')).status).toBe(204);
		expect((await env.BUCKET.list({ prefix: 'dave/tree/' })).objects).toEqual([]);
		expect((await dav('dave', 'DELETE', '/tree/')).status).toBe(404);
		expect((await dav('dave', 'DELETE', '/')).status).toBe(403);
	});

	it('honours If-Match', async () => {
		await env.BUCKET.put('dave/keep.txt', 'k');
		expect((await dav('dave', 'DELETE', '/keep.txt', { 'If-Match': '"stale"' })).status).toBe(412);
		expect(await read('dave', '/keep.txt')).toBe('k');
	});
});

describe('COPY / MOVE', () => {
	const to = (path: string) => ({ Destination: `https://dav.example${path}` });

	it('copies and moves files', async () => {
		await env.BUCKET.put('erin/src.txt', 'data', { httpMetadata: { contentType: 'text/plain' } });
		expect((await dav('erin', 'COPY', '/src.txt', to('/copy.txt'))).status).toBe(201);
		expect(await read('erin', '/copy.txt')).toBe('data');
		expect((await env.BUCKET.head('erin/copy.txt'))?.httpMetadata?.contentType).toBe('text/plain');

		expect((await dav('erin', 'MOVE', '/copy.txt', to('/moved.txt'))).status).toBe(201);
		expect(await read('erin', '/copy.txt')).toBeNull();
		expect(await read('erin', '/moved.txt')).toBe('data');
	});

	it('respects Overwrite', async () => {
		await env.BUCKET.put('erin/x.txt', 'x');
		await env.BUCKET.put('erin/y.txt', 'y');
		expect((await dav('erin', 'COPY', '/x.txt', { ...to('/y.txt'), Overwrite: 'F' })).status).toBe(412);
		expect((await dav('erin', 'COPY', '/x.txt', to('/y.txt'))).status).toBe(204);
		expect(await read('erin', '/y.txt')).toBe('x');
	});

	it('applies If-Match to the source', async () => {
		await env.BUCKET.put('erin/stay.txt', 's');
		expect((await dav('erin', 'MOVE', '/stay.txt', { ...to('/gone.txt'), 'If-Match': '"stale"' })).status).toBe(412);
		expect(await read('erin', '/stay.txt')).toBe('s');
		expect(await read('erin', '/gone.txt')).toBeNull();
	});

	it('moves collections recursively', async () => {
		await env.BUCKET.put('erin/d/a.txt', 'a');
		await env.BUCKET.put('erin/d/sub/b.txt', 'b');
		expect((await dav('erin', 'MOVE', '/d/', to('/e/'))).status).toBe(201);
		expect(await read('erin', '/e/sub/b.txt')).toBe('b');
		expect((await env.BUCKET.list({ prefix: 'erin/d/' })).objects).toEqual([]);
		expect((await dav('erin', 'MOVE', '/e/', to('/e/inside/'))).status).toBe(403);
	});

	it('replaces destinations with exactly the source', async () => {
		await env.BUCKET.put('erin/r1/a.txt', 'new a');
		await env.BUCKET.put('erin/r2/a.txt', 'old a');
		await env.BUCKET.put('erin/r2/old.txt', 'old');
		expect((await dav('erin', 'COPY', '/r1/', to('/r2/'))).status).toBe(204);
		const keys = (await env.BUCKET.list({ prefix: 'erin/r2/' })).objects.map((object) => object.key);
		expect(keys.sort()).toEqual(['erin/r2/', 'erin/r2/a.txt']);
		expect(await read('erin', '/r2/a.txt')).toBe('new a');

		await env.BUCKET.put('erin/r3.txt', 'file');
		expect((await dav('erin', 'MOVE', '/r3.txt', to('/r2'))).status).toBe(204);
		expect(await read('erin', '/r2')).toBe('file');
		expect((await env.BUCKET.list({ prefix: 'erin/r2/' })).objects).toEqual([]);
	});

	it('refuses to overwrite an ancestor of the source', async () => {
		await env.BUCKET.put('erin/anc/b/file', 'f');
		await env.BUCKET.put('erin/anc/sibling', 's');
		for (const method of ['COPY', 'MOVE']) {
			expect((await dav('erin', method, '/anc/b/', to('/anc/'))).status).toBe(403);
			expect((await dav('erin', method, '/anc/b/file', to('/anc'))).status).toBe(403);
		}
		expect(await read('erin', '/anc/b/file')).toBe('f');
		expect(await read('erin', '/anc/sibling')).toBe('s');
	});

	it('rejects foreign destinations', async () => {
		await env.BUCKET.put('erin/f.txt', 'f');
		expect((await dav('erin', 'COPY', '/f.txt', { Destination: 'https://elsewhere.example/f.txt' })).status).toBe(502);
		expect((await dav('erin', 'COPY', '/f.txt', to('/nowhere/f.txt'))).status).toBe(409);
	});
});

describe('LOCK', () => {
	it('returns a token and lets its holder save repeatedly', async () => {
		await env.BUCKET.put('frank/doc.txt', 'v0');
		const response = await dav('frank', 'LOCK', '/doc.txt', {}, LOCK_BODY);
		const token = /^<(.+)>$/.exec(response.headers.get('Lock-Token') ?? '')?.[1] ?? '';
		const xml = await response.text();
		expect(token).toMatch(/^opaquelocktoken:/);
		expect(xml).toContain(`<D:locktoken><D:href>${token}</D:href></D:locktoken>`);
		expect(xml).toContain('<D:href>me</D:href>');

		expect((await dav('frank', 'PUT', '/doc.txt', { If: `(<${token}>)` }, 'v1')).status).toBe(204);
		expect((await dav('frank', 'PUT', '/doc.txt', { If: `(<${token}>)` }, 'v2')).status).toBe(204);
		expect(await read('frank', '/doc.txt')).toBe('v2');
		expect((await dav('frank', 'UNLOCK', '/doc.txt', { 'Lock-Token': `<${token}>` })).status).toBe(204);
	});

	it('prevents lost updates', async () => {
		await env.BUCKET.put('frank/shared.txt', 'v0');
		const a = await lock('frank', '/shared.txt');
		expect((await dav('frank', 'PUT', '/shared.txt', {}, 'from b')).status).toBe(204);
		expect((await dav('frank', 'PUT', '/shared.txt', { If: `(<${a}>)` }, 'from a')).status).toBe(412);
		expect(await read('frank', '/shared.txt')).toBe('from b');
	});

	it('lets only the most recent saver continue when two clients hold locks', async () => {
		await env.BUCKET.put('frank/both.txt', 'v0');
		const a = await lock('frank', '/both.txt');
		const b = await lock('frank', '/both.txt');
		expect((await dav('frank', 'PUT', '/both.txt', { If: `(<${a}>)` }, 'a1')).status).toBe(204);
		expect((await dav('frank', 'PUT', '/both.txt', { If: `(<${b}>)` }, 'b1')).status).toBe(412);
		expect((await dav('frank', 'PUT', '/both.txt', { If: `(<${a}>)` }, 'a2')).status).toBe(204);
	});

	it('creates an empty file when locking an unmapped URL', async () => {
		const token = await lock('frank', '/fresh.txt', 201);
		expect(await read('frank', '/fresh.txt')).toBe('');
		expect((await dav('frank', 'PUT', '/fresh.txt', { If: `(<${token}>)` }, 'mine')).status).toBe(204);

		const late = await lock('frank', '/race.txt', 201);
		await env.BUCKET.put('frank/race.txt', 'someone else');
		expect((await dav('frank', 'PUT', '/race.txt', { If: `(<${late}>)` }, 'mine')).status).toBe(412);

		expect((await dav('frank', 'LOCK', '/nodir/x.txt', {}, LOCK_BODY)).status).toBe(409);
		expect((await dav('frank', 'LOCK', '/fresh.txt', { Depth: '1' }, LOCK_BODY)).status).toBe(400);
	});

	it('rejects tokens it did not issue', async () => {
		await env.BUCKET.put('frank/foreign.txt', 'v0');
		const If = '(<opaquelocktoken:00000000-0000-0000-0000-000000000000.deadbeef>)';
		expect((await dav('frank', 'PUT', '/foreign.txt', { If }, 'x')).status).toBe(412);
		expect((await dav('frank', 'PUT', '/foreign.txt', { If: '(<urn:uuid:other-server>)' }, 'x')).status).toBe(412);
		expect((await dav('frank', 'DELETE', '/foreign.txt', { If })).status).toBe(412);
	});

	it('guards save-by-MOVE with tagged If headers', async () => {
		await env.BUCKET.put('frank/report.txt', 'v0');
		const token = await lock('frank', '/report.txt');
		const headers = { Destination: 'https://dav.example/report.txt', If: `<https://dav.example/report.txt> (<${token}>)` };

		await env.BUCKET.put('frank/.tmp1', 'v1');
		expect((await dav('frank', 'MOVE', '/.tmp1', headers)).status).toBe(204);
		expect(await read('frank', '/report.txt')).toBe('v1');

		await env.BUCKET.put('frank/report.txt', 'changed elsewhere');
		await env.BUCKET.put('frank/.tmp2', 'v2');
		expect((await dav('frank', 'MOVE', '/.tmp2', headers)).status).toBe(412);
		expect(await read('frank', '/report.txt')).toBe('changed elsewhere');
	});

	it('refreshes without issuing a new token', async () => {
		await env.BUCKET.put('frank/refresh.txt', 'v0');
		const token = await lock('frank', '/refresh.txt');
		const response = await dav('frank', 'LOCK', '/refresh.txt', { If: `(<${token}>)` });
		expect(response.status).toBe(200);
		expect(response.headers.has('Lock-Token')).toBe(false);
		expect(await response.text()).toContain(token);

		await env.BUCKET.put('frank/refresh.txt', 'changed elsewhere');
		expect((await dav('frank', 'LOCK', '/refresh.txt', { If: `(<${token}>)` })).status).toBe(412);
	});

	it('advertises lock support in PROPFIND', async () => {
		await env.BUCKET.put('frank/props.txt', 'x');
		const xml = await (await dav('frank', 'PROPFIND', '/props.txt', { Depth: '0' })).text();
		expect(xml).toContain('<D:supportedlock><D:lockentry>');
		expect(xml).toContain('<D:lockdiscovery/>');
	});
});

describe('PROPPATCH', () => {
	const update = (prop: string) =>
		`<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop>${prop}</D:prop></D:set></D:propertyupdate>`;

	it('accepts dead properties and refuses live ones atomically', async () => {
		await env.BUCKET.put('gina/p.txt', 'x');
		const ok = await (await dav('gina', 'PROPPATCH', '/p.txt', {}, update('<Z:Win32LastModifiedTime>x</Z:Win32LastModifiedTime>'))).text();
		expect(ok).toContain('HTTP/1.1 200 OK');

		const refused = await (
			await dav('gina', 'PROPPATCH', '/p.txt', {}, update('<D:getetag>x</D:getetag><Z:Win32FileAttributes>0</Z:Win32FileAttributes>'))
		).text();
		expect(refused).toContain('<D:getetag/></D:prop><D:status>HTTP/1.1 403 Forbidden');
		expect(refused).toContain('HTTP/1.1 424 Failed Dependency');
	});
});

it('rejects unexpected request bodies', async () => {
	expect((await dav('gina', 'OPTIONS', '/', {}, 'x')).status).toBe(415);
	expect((await dav('gina', 'MKCOL', '/withbody', {}, 'x')).status).toBe(415);
});
