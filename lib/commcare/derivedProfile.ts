/**
 * Derived CommCare profile properties owned by Nova.
 *
 * These are wire optimizations inferred from the app Nova already authors.
 * They are never stored in BlueprintDoc and never exposed as settings. The
 * direct-update path uses the exported key tuple as its complete allowlist:
 * it may replace or remove only these keys while preserving every profile
 * value owned by the target project space.
 */

import { type BlueprintDoc, effectiveCaseSearchConfig } from "@/lib/domain";

export const NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS = [
	"cc-index-case-search-results",
] as const;

export type NovaOwnedDerivedProfilePropertyKey =
	(typeof NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS)[number];

export type NovaDerivedProfileProperties = Partial<
	Record<NovaOwnedDerivedProfilePropertyKey, "yes">
>;

/** Whether the app emits at least one real remote Search workflow. */
export function hasEffectiveSearch(
	doc: Pick<BlueprintDoc, "modules">,
): boolean {
	return Object.values(doc.modules).some(
		(module) => effectiveCaseSearchConfig(module) !== undefined,
	);
}

/**
 * Project the profile optimization justified by the current document.
 *
 * CommCare uses this property to index cases returned by remote Search in its
 * temporary case storage. It does not request, schedule, or imitate a sync.
 */
export function derivedProfileProperties(
	doc: Pick<BlueprintDoc, "modules">,
): Readonly<Record<string, string>> {
	return hasEffectiveSearch(doc)
		? ({
				"cc-index-case-search-results": "yes",
			} satisfies NovaDerivedProfileProperties)
		: {};
}
