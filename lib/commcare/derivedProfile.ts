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
import { moduleCaseTypeForActions } from "./formLinkProjection";

export const NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS = [
	"cc-index-case-search-results",
] as const;

export type NovaOwnedDerivedProfilePropertyKey =
	(typeof NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS)[number];

export type NovaDerivedProfileProperties = Partial<
	Record<NovaOwnedDerivedProfilePropertyKey, "yes">
>;

/**
 * Whether the app emits at least one real remote Search workflow: a menu that
 * lists cases and holds a search. A menu that lists no cases
 * (`moduleCaseTypeForActions` gives no type, the gate both exports read) writes
 * no remote request whatever search it holds: the HQ JSON keeps CommCare HQ's
 * default `search_config` there and the local suite builds no search for it.
 */
export function hasEffectiveSearch(doc: BlueprintDoc): boolean {
	return doc.moduleOrder.some((moduleUuid) => {
		const module = doc.modules[moduleUuid];
		return (
			module !== undefined &&
			effectiveCaseSearchConfig(module) !== undefined &&
			moduleCaseTypeForActions(doc, moduleUuid) !== ""
		);
	});
}

/**
 * Project the profile optimization justified by the current document.
 *
 * CommCare uses this property to index cases returned by remote Search in its
 * temporary case storage. It does not request, schedule, or imitate a sync.
 * Formplayer is its one reader, and reads it only while it fetches a remote
 * request's results, so an app that writes no remote request has no use for it.
 */
export function derivedProfileProperties(
	doc: BlueprintDoc,
): Readonly<Record<string, string>> {
	return hasEffectiveSearch(doc)
		? ({
				"cc-index-case-search-results": "yes",
			} satisfies NovaDerivedProfileProperties)
		: {};
}
