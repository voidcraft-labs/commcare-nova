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
	const beforeByUuid = uniquePropertiesByUuid(baseUserProperties);
	const afterByUuid = uniquePropertiesByUuid(incomingUserProperties);
	if (!beforeByUuid || !afterByUuid) return null;

	const baseHashtags = cleanXPathHashtagSpans(base);
	const candidates: IdentityRename[] = [];
	for (const [uuid, before] of beforeByUuid) {
		const after = afterByUuid.get(uuid);
		if (!after || before.slug === after.slug) continue;
		if (
			uniqueIdentityForSlug(baseUserProperties, before.slug) !== uuid ||
			uniqueIdentityForSlug(incomingUserProperties, after.slug) !== uuid
		) {
			continue;
		}

		const oldToken = `#user/${before.slug}`;
		const newToken = `#user/${after.slug}`;
		for (const span of baseHashtags) {
			if (span.text !== oldToken) continue;
			const projected =
				base.slice(0, span.start) + newToken + base.slice(span.end);
			if (projected !== incoming) continue;
			candidates.push({ oldToken, newToken });
			if (candidates.length > 1) return null;
		}
	}
	return candidates[0] ?? null;
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
	if (incoming === base) return { base, draft, conflict: false };
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

	const mapped = cleanXPathHashtagSpans(draft).filter(
		(span) => span.text === rename.oldToken,
	);
	if (mapped.length !== 1) {
		return { base: incoming, draft, conflict: true };
	}
	const [span] = mapped;
	return {
		base: incoming,
		draft: draft.slice(0, span.start) + rename.newToken + draft.slice(span.end),
		conflict: false,
	};
}
