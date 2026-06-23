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
import { effectiveFilterForEmission } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";

export function caseSearchConfigRequiresSearchableSurface(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseSearchConfig) return [];

	// "Has a filter" means it narrows something AFTER normalization, so
	// the gate agrees with what emission produces: a filter that reduces
	// to `match-all` (e.g. an authored `and` of all-true clauses) emits
	// no query, so it is NOT a searchable surface. `effectiveFilterForEmission`
	// is the shared "no effective filter" decision; a shallow check here
	// would pass a config the emitter strips to nothing.
	const hasFilter =
		effectiveFilterForEmission(mod.caseListConfig?.filter) !== undefined;
	const hasInputs = (mod.caseListConfig?.searchInputs ?? []).length > 0;
	if (hasFilter || hasInputs) return [];

	return [
		validationError(
			"CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE",
			"module",
			`Module "${mod.name}" carries a \`caseSearchConfig\` but its case list has nothing to search by — no search inputs and no default filter. Add an entry to \`caseListConfig.searchInputs\`, set a \`caseListConfig.filter\`, or remove \`caseSearchConfig\`.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}
