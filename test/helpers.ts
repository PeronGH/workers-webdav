import { env, exports } from 'cloudflare:workers';
import { derivePassword } from '../src/auth';

export const BASE = 'https://dav.example';

export async function authHeader(user: string): Promise<string> {
	return `Basic ${btoa(`${user}:${await derivePassword(env.AUTH_SECRET, user)}`)}`;
}

export async function dav(
	user: string,
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body?: BodyInit,
): Promise<Response> {
	return exports.default.fetch(`${BASE}${path}`, { method, headers: { Authorization: await authHeader(user), ...headers }, body });
}

export function hrefs(xml: string): string[] {
	return [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((match) => match[1]).sort();
}
