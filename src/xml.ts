import { DOMParser, onErrorStopParsing, ParseError, type Element } from '@xmldom/xmldom';
import { HttpError } from './http';

export const DAV = 'DAV:';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

export const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>\n';

/** Parses a request body whose root must be the DAV: element `rootName`; anything else is a 400. */
export function parseDavXml(body: string, rootName: string): Element {
	let root: Element | null;
	try {
		root = new DOMParser({ onError: onErrorStopParsing }).parseFromString(body, 'application/xml').documentElement;
	} catch (error) {
		if (error instanceof ParseError) throw new HttpError(400);
		throw error;
	}
	if (root?.namespaceURI !== DAV || root.localName !== rootName) throw new HttpError(400);
	return root;
}

export function childElements(element: Element, davName?: string): Element[] {
	return Array.from(element.childNodes).filter(
		(node): node is Element =>
			node.nodeType === node.ELEMENT_NODE && (davName === undefined || (node.namespaceURI === DAV && node.localName === davName)),
	);
}

export interface PropName {
	namespace: string;
	local: string;
}

export function propName(element: Element): PropName {
	return { namespace: element.namespaceURI ?? '', local: element.localName ?? element.nodeName };
}

export function propElement(name: PropName, value = ''): string {
	const tag = name.namespace === DAV ? `D:${name.local}` : name.namespace === '' ? name.local : `x:${name.local}`;
	const xmlns = name.namespace === DAV ? '' : ` xmlns${name.namespace === '' ? '' : ':x'}="${escapeXml(name.namespace)}"`;
	return value === '' ? `<${tag}${xmlns}/>` : `<${tag}${xmlns}>${value}</${tag}>`;
}

export function propstat(props: string[], status: string): string {
	return `<D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat>`;
}

export function multistatus(responses: string[]): Response {
	return new Response(`${XML_HEADER}<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`, {
		status: 207,
		headers: { 'Content-Type': 'application/xml; charset=utf-8' },
	});
}
