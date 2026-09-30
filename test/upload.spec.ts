import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { BASE, dav, hrefs } from './helpers';

const UPLOADS = '/remote.php/dav/uploads/dave';
const FILES = `${BASE}/remote.php/dav/files/dave`;

describe('Nextcloud chunked upload', () => {
	it('joins the chunks in natural order and cleans up', async () => {
		expect((await dav('dave', 'MKCOL', `${UPLOADS}/one`)).status).toBe(201);
		for (const [name, body] of [
			['10', 'c'],
			['2', 'b'],
			['1', 'a'],
		]) {
			expect((await dav('dave', 'PUT', `${UPLOADS}/one/${name}`, {}, body)).status).toBe(201);
		}
		const move = await dav('dave', 'MOVE', `${UPLOADS}/one/.file`, { Destination: `${FILES}/joined.txt`, 'OC-Total-Length': '3' });
		expect(move.status).toBe(201);
		expect(await (await env.BUCKET.get('dave/joined.txt'))?.text()).toBe('abc');
		expect(move.headers.get('ETag')).toBe((await env.BUCKET.head('dave/joined.txt'))?.httpEtag);
		expect((await env.BUCKET.list({ prefix: '.uploads/dave/one/' })).objects).toEqual([]);
	});

	it('overwrites existing files and checks the total length', async () => {
		await env.BUCKET.put('dave/over.txt', 'old');
		await dav('dave', 'MKCOL', `${UPLOADS}/two`);
		await dav('dave', 'PUT', `${UPLOADS}/two/1`, {}, 'new');
		const headers = { Destination: `${FILES}/over.txt` };
		expect((await dav('dave', 'MOVE', `${UPLOADS}/two/.file`, { ...headers, 'OC-Total-Length': '4' })).status).toBe(400);
		expect((await dav('dave', 'MOVE', `${UPLOADS}/two/.file`, { ...headers, 'If-None-Match': '*' })).status).toBe(412);
		expect((await dav('dave', 'MOVE', `${UPLOADS}/two/.file`, headers)).status).toBe(204);
		expect(await (await env.BUCKET.get('dave/over.txt'))?.text()).toBe('new');
		expect((await dav('dave', 'MOVE', `${UPLOADS}/two/.file`, headers)).status).toBe(404);
	});

	it('aborts on DELETE', async () => {
		await dav('dave', 'MKCOL', `${UPLOADS}/three`);
		expect((await dav('dave', 'MKCOL', `${UPLOADS}/three`)).status).toBe(405);
		await dav('dave', 'PUT', `${UPLOADS}/three/1`, {}, 'x');
		expect((await dav('dave', 'DELETE', `${UPLOADS}/three`)).status).toBe(204);
		expect((await env.BUCKET.list({ prefix: '.uploads/dave/three/' })).objects).toEqual([]);
		expect((await dav('dave', 'DELETE', `${UPLOADS}/three`)).status).toBe(404);
	});

	it("refuses other users' URLs", async () => {
		expect((await dav('erin', 'MKCOL', `${UPLOADS}/four`)).status).toBe(403);
		expect((await dav('erin', 'PROPFIND', '/remote.php/dav/files/dave/', { Depth: '1' })).status).toBe(403);
		await dav('dave', 'MKCOL', `${UPLOADS}/four`);
		const move = await dav('dave', 'MOVE', `${UPLOADS}/four/.file`, { Destination: `${BASE}/remote.php/dav/files/erin/x` });
		expect(move.status).toBe(403);
	});

	it('serves files under the Nextcloud path', async () => {
		await env.BUCKET.put('dave/docs/a.txt', 'a');
		const response = await dav('dave', 'PROPFIND', '/remote.php/dav/files/dave/docs/', { Depth: '1' });
		expect(response.status).toBe(207);
		expect(hrefs(await response.text())).toEqual(['/remote.php/dav/files/dave/docs/', '/remote.php/dav/files/dave/docs/a.txt']);
		expect(await (await dav('dave', 'GET', '/remote.php/dav/files/dave/docs/a.txt')).text()).toBe('a');
	});
});
