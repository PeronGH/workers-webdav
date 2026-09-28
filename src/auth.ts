export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const encoder = new TextEncoder();

export async function derivePassword(secret: string, username: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(username)), 0, 16);
	return btoa(String.fromCharCode(...mac))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

/** Returns the authenticated username, or null if credentials are missing or invalid. */
export async function authenticate(request: Request, secret: string): Promise<string | null> {
	const encoded = /^Basic\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
	if (encoded === undefined) return null;

	let credentials: string;
	try {
		credentials = atob(encoded);
	} catch {
		return null;
	}

	const separator = credentials.indexOf(':');
	if (separator < 0) return null;
	const username = credentials.slice(0, separator);
	const password = encoder.encode(credentials.slice(separator + 1));
	if (!USERNAME_PATTERN.test(username)) return null;

	// The derived password has a fixed, public length, so an early length mismatch leaks nothing.
	const expected = encoder.encode(await derivePassword(secret, username));
	return expected.byteLength === password.byteLength && crypto.subtle.timingSafeEqual(expected, password) ? username : null;
}
