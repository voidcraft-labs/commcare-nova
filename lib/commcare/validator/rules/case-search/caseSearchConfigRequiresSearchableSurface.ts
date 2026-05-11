/**
 * Rule: when `caseSearchConfig` is present (so the module emits a
 * `<remote-request>` and the search button renders), the case-list
 * config must carry at least one of:
 *
 *   - a non-`match-all` `caseListConfig.filter` (a default search
 *     filter that narrows the result set on click), OR
 *   - one or more `caseListConfig.searchInputs[]` entries (inputs
 *     the user types into to narrow the result set).
 *
 * If neither is present, the search button opens a search screen
 * with zero inputs and no filter — pressing "Search" produces the
 * unfiltered case list, which the user could have seen by tapping
 * the case-list module directly. The search affordance has no
 * effect on the user's reachable set.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent — no
 * search button renders, no search screen exists.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function caseSearchConfigRequiresSearchableSurface(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseSearchConfig) return [];

	const filter = mod.caseListConfig?.filter;
	const hasFilter = filter !== undefined && filter.kind !== "match-all";
	const hasInputs = (mod.caseListConfig?.searchInputs ?? []).length > 0;
	if (hasFilter || hasInputs) return [];

	return [
		validationError(
			"CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE",
			"module",
			`Module "${mod.name}" carries a \`caseSearchConfig\` but its case list has no search inputs and no default filter — the search button on this module opens a search screen with nothing to fill in and no predicate to narrow the result set, so pressing it returns the unfiltered case list (the same set the user can reach by tapping the module directly). Add at least one entry to \`caseListConfig.searchInputs\` for the user to type into, set a \`caseListConfig.filter\` to narrow the default search result set, or remove \`caseSearchConfig\` so the search button stops rendering.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}
