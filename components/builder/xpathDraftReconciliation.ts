import { cleanXPathHashtagSpans } from "@/lib/codemirror/xpath-hashtag-spans";
import { userPropertySlugVerdict } from "@/lib/doc/identifierVerdicts";

/**
 * Three-way reconciliation for an open XPath editor.
 *
 * `base` is the projection the local draft started from, while `incoming` is
 * the newest projection of the identity-backed AST. The only dirty-draft
 * change this reconciler applies automatically is one byte-exact rename of one
 * complete `#user/<slug>` token whose catalog entries prove the same stable
 * UUID on both sides. The peer may change no other byte, and the local draft
 * must still contain that exact qualified token exactly once.
 *
 * Everything else fails closed. In particular, no edit-distance alignment may
 * map a bare slug onto another hashtag namespace, erase a peer's wider edit, or
 * leave a renamed custom-worker spelling behind to parse later as a raw
 * `user-ref`.
 */

export interface XPathUserPropertyProjection {
	readonly uuid: string;
	readonly slug: string;
}

interface IdentityRename {
	readonly oldToken: string;
	readonly newToken: string;
}

const NO_CLAIMED_SLUGS: ReadonlySet<string> = new Set();

function uniqueIdentityForSlug(
	properties: readonly XPathUserPropertyProjection[],
	slug: string,
): string | undefined {
	if (!userPropertySlugVerdict(slug, NO_CLAIMED_SLUGS).ok) {
		return undefined;
	}
	const folded = slug.toLowerCase();
	const matches = properties.filter(
		(property) => property.slug.toLowerCase() === folded,
	);
	if (matches.length !== 1 || matches[0].slug !== slug) return undefined;
	return matches[0].uuid;
}

function uniquePropertiesByUuid(
	properties: readonly XPathUserPropertyProjection[],
): ReadonlyMap<string, XPathUserPropertyProjection> | null {
	const byUuid = new Map<string, XPathUserPropertyProjection>();
	for (const property of properties) {
		if (byUuid.has(property.uuid)) return null;
		byUuid.set(property.uuid, property);
	}
	return byUuid;
}

function sameCatalogProjection(
	before: readonly XPathUserPropertyProjection[],
	after: readonly XPathUserPropertyProjection[],
): boolean {
	const beforeByUuid = uniquePropertiesByUuid(before);
	const afterByUuid = uniquePropertiesByUuid(after);
	if (!beforeByUuid || !afterByUuid || beforeByUuid.size !== afterByUuid.size) {
		return false;
	}
	for (const [uuid, property] of beforeByUuid) {
		if (afterByUuid.get(uuid)?.slug !== property.slug) return false;
	}
	return true;
}

function singleCatalogRename(
	before: readonly XPathUserPropertyProjection[],
	after: readonly XPathUserPropertyProjection[],
): IdentityRename | null {
	const beforeByUuid = uniquePropertiesByUuid(before);
	const afterByUuid = uniquePropertiesByUuid(after);
	if (!beforeByUuid || !afterByUuid || beforeByUuid.size !== afterByUuid.size) {
		return null;
	}

	let rename: IdentityRename | null = null;
	for (const [uuid, oldProperty] of beforeByUuid) {
		const newProperty = afterByUuid.get(uuid);
		if (!newProperty) return null;
		if (oldProperty.slug === newProperty.slug) continue;
		if (rename !== null) return null;
		if (
			uniqueIdentityForSlug(before, oldProperty.slug) !== uuid ||
			uniqueIdentityForSlug(after, newProperty.slug) !== uuid
		) {
			return null;
		}
		rename = {
			oldToken: `#user/${oldProperty.slug}`,
			newToken: `#user/${newProperty.slug}`,
		};
	}
	return rename;
}

function userSlug(token: string): string | undefined {
	const prefix = "#user/";
	return token.startsWith(prefix) ? token.slice(prefix.length) : undefined;
}

function catalogChangeTouchesSpans(
	spans: readonly {
		readonly text: string;
		readonly start: number;
		readonly end: number;
	}[],
	before: readonly XPathUserPropertyProjection[],
	after: readonly XPathUserPropertyProjection[],
	skip?: { readonly start: number; readonly end: number },
): boolean {
	for (const span of spans) {
		if (span.start === skip?.start && span.end === skip.end) continue;
		const slug = userSlug(span.text);
		if (slug === undefined) continue;
		if (
			uniqueIdentityForSlug(before, slug) !== uniqueIdentityForSlug(after, slug)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Prove that `incoming` is `base` with exactly one complete UUID-backed
 * custom-worker token renamed and no other byte changed.
 */
function exactPeerIdentityRename({
	base,
	incoming,
	baseUserProperties,
	incomingUserProperties,
}: {
	readonly base: string;
	readonly incoming: string;
	readonly baseUserProperties: readonly XPathUserPropertyProjection[];
	readonly incomingUserProperties: readonly XPathUserPropertyProjection[];
}): IdentityRename | null {
	const rename = singleCatalogRename(
		baseUserProperties,
		incomingUserProperties,
	);
	if (!rename) return null;

	const baseHashtags = cleanXPathHashtagSpans(base);
	if (baseHashtags === null) return null;
	const oldSpans = baseHashtags.filter((span) => span.text === rename.oldToken);
	if (oldSpans.length !== 1) return null;
	const [renamedSpan] = oldSpans;
	if (
		base.slice(0, renamedSpan.start) +
			rename.newToken +
			base.slice(renamedSpan.end) !==
		incoming
	) {
		return null;
	}
	if (
		catalogChangeTouchesSpans(
			baseHashtags,
			baseUserProperties,
			incomingUserProperties,
			renamedSpan,
		)
	) {
		return null;
	}
	return rename;
}

export function reconcileXPathDraft({
	base,
	draft,
	incoming,
	baseUserProperties,
	incomingUserProperties,
	conflict = false,
}: {
	readonly base: string;
	readonly draft: string;
	readonly incoming: string;
	readonly baseUserProperties: readonly XPathUserPropertyProjection[];
	readonly incomingUserProperties: readonly XPathUserPropertyProjection[];
	/** A same-slot collision was already observed in this mounted edit. */
	readonly conflict?: boolean;
}): { base: string; draft: string; conflict: boolean } {
	// A later peer projection cannot prove that the local same-slot edit is
	// suddenly safe. Advance the shared base for diagnostics, but preserve both
	// the draft and the refusal until the editor's explicit cancel/reload path
	// unmounts this controller.
	if (conflict) return { base: incoming, draft, conflict: true };
	if (incoming === base) {
		if (
			sameCatalogProjection(baseUserProperties, incomingUserProperties) ||
			draft === base
		) {
			return { base, draft, conflict: false };
		}
		const draftHashtags = cleanXPathHashtagSpans(draft);
		return {
			base,
			draft,
			conflict:
				draftHashtags === null ||
				catalogChangeTouchesSpans(
					draftHashtags,
					baseUserProperties,
					incomingUserProperties,
				),
		};
	}
	if (draft === base || draft === incoming) {
		return { base: incoming, draft: incoming, conflict: false };
	}

	const rename = exactPeerIdentityRename({
		base,
		incoming,
		baseUserProperties,
		incomingUserProperties,
	});
	if (!rename) return { base: incoming, draft, conflict: true };

	const draftHashtags = cleanXPathHashtagSpans(draft);
	if (draftHashtags === null) {
		return { base: incoming, draft, conflict: true };
	}
	const mapped = draftHashtags.filter((span) => span.text === rename.oldToken);
	if (mapped.length !== 1) {
		return { base: incoming, draft, conflict: true };
	}
	const [span] = mapped;
	if (
		catalogChangeTouchesSpans(
			draftHashtags,
			baseUserProperties,
			incomingUserProperties,
			span,
		)
	) {
		return { base: incoming, draft, conflict: true };
	}
	return {
		base: incoming,
		draft: draft.slice(0, span.start) + rename.newToken + draft.slice(span.end),
		conflict: false,
	};
}
