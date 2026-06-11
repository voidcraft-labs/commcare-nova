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

/** A resolver that resolves nothing — every form reference parses to
 *  a raw leaf. For contexts with no form (module-level slots never
 *  carry form-local refs, but total readers still need a context). */
export const NO_FIELD_PATHS: ResolveFieldPath = () => undefined;
