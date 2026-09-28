const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

export const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>\n';
