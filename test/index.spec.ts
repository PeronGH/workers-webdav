import { exports } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

describe('Hello World worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const response = worker.fetch();
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('responds with Hello World! (integration style)', async () => {
		const response = await exports.default.fetch('https://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});
});
