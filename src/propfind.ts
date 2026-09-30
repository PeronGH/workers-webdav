import { HttpError } from './http';
import { SUPPORTED_LOCK } from './lock';
import { displayName, href, listDir, stat, type Entry, type Target } from './storage';
import { childElements, DAV, escapeXml, multistatus, parseDavXml, propElement, propName, propstat, XML_HEADER, type PropName } from './xml';

type PropfindRequest = { type: 'allprop' } | { type: 'propname' } | { type: 'prop'; props: PropName[] };

export function parsePropfind(body: string): PropfindRequest {
	if (body.trim() === '') return { type: 'allprop' };

	for (const child of childElements(parseDavXml(body, 'propfind'))) {
		if (child.namespaceURI !== DAV) continue;
		switch (child.localName) {
			case 'allprop':
				return { type: 'allprop' };
			case 'propname':
				return { type: 'propname' };
			case 'prop':
				return { type: 'prop', props: childElements(child).map(propName) };
		}
	}
	throw new HttpError(400);
}

/** Live DAV: properties of an entry, as inner XML keyed by local name. */
function liveProps(entry: Entry): Map<string, string> {
	const props = new Map<string, string>([
		['displayname', escapeXml(displayName(entry))],
		['resourcetype', entry.type === 'dir' ? '<D:collection/>' : ''],
		['supportedlock', SUPPORTED_LOCK],
		// Locks are stateless, so there is never an active lock to report.
		['lockdiscovery', ''],
	]);
	if (entry.type === 'file') {
		const { object } = entry;
		props.set('getcontentlength', String(object.size));
		props.set('getcontenttype', escapeXml(object.httpMetadata?.contentType ?? 'application/octet-stream'));
		props.set('getetag', escapeXml(object.httpEtag));
		props.set('getlastmodified', object.uploaded.toUTCString());
	}
	return props;
}

const OC = 'http://owncloud.org/ns';

/** ownCloud permissions, which webdav-manager.js reads to decide what it shows and lets the user do. */
function ocPermissions(entry: Entry): string {
	if (entry.type === 'file') return 'GWDNV';
	return entry.path.length === 0 ? 'GCK' : 'GCKDNV';
}

function liveProp(entry: Entry, live: Map<string, string>, name: PropName): string | undefined {
	if (name.namespace === DAV) return live.get(name.local);
	return name.namespace === OC && name.local === 'permissions' ? ocPermissions(entry) : undefined;
}

function response(entry: Entry, request: PropfindRequest, base?: string): string {
	const live = liveProps(entry);
	const propstats: string[] = [];
	switch (request.type) {
		case 'allprop':
			propstats.push(
				propstat(
					[...live].map(([local, value]) => propElement({ namespace: DAV, local }, value)),
					'200 OK',
				),
			);
			break;
		case 'propname':
			propstats.push(
				propstat(
					[...live.keys()].map((local) => propElement({ namespace: DAV, local })),
					'200 OK',
				),
			);
			break;
		case 'prop': {
			const found: string[] = [];
			const missing: string[] = [];
			for (const name of request.props) {
				const value = liveProp(entry, live, name);
				if (value === undefined) missing.push(propElement(name));
				else found.push(propElement(name, value));
			}
			if (found.length > 0) propstats.push(propstat(found, '200 OK'));
			if (missing.length > 0) propstats.push(propstat(missing, '404 Not Found'));
		}
	}
	return `<D:response><D:href>${escapeXml(href(entry, base))}</D:href>${propstats.join('')}</D:response>`;
}

export async function handlePropfind(request: Request, bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	const propfind = parsePropfind(await request.text());

	const entry = await stat(bucket, user, target);
	if (!entry) throw new HttpError(404);

	// Depth is ignored for non-collections; infinite depth on collections is refused (RFC 4918 §9.1.1).
	const depth = request.headers.get('Depth');
	if (entry.type === 'dir' && depth !== '0' && depth !== '1') {
		throw new HttpError(403, `${XML_HEADER}<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`, {
			'Content-Type': 'application/xml; charset=utf-8',
		});
	}

	const entries = entry.type === 'dir' && depth === '1' ? [entry, ...(await listDir(bucket, user, entry.path))] : [entry];
	return multistatus(entries.map((e) => response(e, propfind, target.base)));
}

/**
 * Dead properties are accepted and discarded, since clients such as the Windows Mini-Redirector treat PROPPATCH
 * failures as save errors. DAV: properties are live and protected, which fails the whole request atomically.
 */
export async function handleProppatch(request: Request, bucket: R2Bucket, user: string, target: Target): Promise<Response> {
	const root = parseDavXml(await request.text(), 'propertyupdate');
	const entry = await stat(bucket, user, target);
	if (!entry) throw new HttpError(404);

	const names = childElements(root)
		.filter((child) => child.namespaceURI === DAV && (child.localName === 'set' || child.localName === 'remove'))
		.flatMap((instruction) => childElements(instruction, 'prop'))
		.flatMap((prop) => childElements(prop).map(propName));
	if (names.length === 0) throw new HttpError(400);

	const protectedNames = names.filter((name) => name.namespace === DAV);
	const deadNames = names.filter((name) => name.namespace !== DAV);
	const groups: [PropName[], string][] =
		protectedNames.length > 0
			? [
					[protectedNames, '403 Forbidden'],
					[deadNames, '424 Failed Dependency'],
				]
			: [[deadNames, '200 OK']];
	const propstats = groups
		.filter(([group]) => group.length > 0)
		.map(([group, status]) =>
			propstat(
				group.map((name) => propElement(name)),
				status,
			),
		);
	return multistatus([`<D:response><D:href>${escapeXml(href(entry, target.base))}</D:href>${propstats.join('')}</D:response>`]);
}
