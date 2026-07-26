// lib/domain/xpath/resolve.ts
//
// Parse-side resolution: an id path (`["grp", "age"]`, the segments of
// a `#form/grp/age` or `/data/grp/age` reference) → the field uuid it
// lands on. The stepwise walk follows `fieldOrder` structure by
// semantic id from the form root, first match per level — the same
// rule every other form-local resolution path uses, and the exact
// inverse of `xpathPrintContext`'s ancestor-chain print, which is what
// holds the round-trip law over resolved references.

import type { XPathPrintableDoc } from "./print";

/** Resolve a full id path from a form root to a field uuid, or
 *  `undefined` when any segment fails to resolve. Identity leaves are
 *  minted only from FULL resolutions — a partially-resolving reference
 *  stays a raw leaf and keeps printing its original text. */
export type ResolveFieldPath = (
	segments: readonly string[],
) => string | undefined;

/** Resolve a custom worker-information saved name to its stable identity. */
export type ResolveUserPropertySlug = (slug: string) => string | undefined;

/** Decide whether a textual slug is eligible to bind to a custom identity. */
export type IsBindableUserPropertySlug = (slug: string) => boolean;

/**
 * Build the parse-side custom worker-information resolver.
 *
 * Resolution is deliberately stricter than an exact record lookup. HQ treats
 * custom worker-property slugs case-insensitively for uniqueness, so a
 * historical `Region` / `region` collision is ambiguous even when the source
 * text exactly matches one member. The source spelling must also exactly match
 * the one unambiguous property so parsing never changes authored bytes merely
 * by normalizing case. Finally, the caller supplies the CommCare-validity gate:
 * a built-in or otherwise reserved historical custom declaration must stay the
 * explicit raw `user-ref` arm.
 */
export function userPropertySlugResolver(
	doc: Pick<XPathPrintableDoc, "userProperties">,
	isBindableSlug: IsBindableUserPropertySlug,
): ResolveUserPropertySlug {
	return (slug) => {
		if (!isBindableSlug(slug)) return undefined;
		const matches: Array<readonly [string, string]> = [];
		const key = slug.toLowerCase();
		for (const [uuid, property] of Object.entries(doc.userProperties ?? {})) {
			if (property?.slug.toLowerCase() !== key) continue;
			matches.push([uuid, property.slug]);
		}
		if (matches.length !== 1) return undefined;
		const [uuid, exactSlug] = matches[0];
		return exactSlug === slug ? uuid : undefined;
	};
}

/**
 * Build a resolver scoped to one form. `formUuid` may name a form that
 * doesn't exist on `doc` yet (a form minted earlier in the same batch)
 * — every resolution then fails and references stay raw, exactly the
 * dangling treatment they'd get against an empty form.
 */
export function fieldPathResolver(
	doc: XPathPrintableDoc,
	formUuid: string | undefined,
): ResolveFieldPath {
	return (segments) => {
		if (formUuid === undefined || segments.length === 0) return undefined;
		let parent = formUuid;
		let resolved: string | undefined;
		for (const segment of segments) {
			const children = doc.fieldOrder[parent] ?? [];
			const next = children.find((uuid) => doc.fields[uuid]?.id === segment);
			if (next === undefined) return undefined;
			resolved = next;
			parent = next;
		}
		return resolved;
	};
}
