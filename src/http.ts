export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: string | null = null,
		readonly headers: HeadersInit = {},
	) {
		super(`HTTP ${String(status)}`);
	}

	toResponse(): Response {
		return new Response(this.body, { status: this.status, headers: this.headers });
	}
}

export function hasBody(request: Request): boolean {
	return Number(request.headers.get('Content-Length') ?? 0) > 0 || request.headers.has('Transfer-Encoding');
}
