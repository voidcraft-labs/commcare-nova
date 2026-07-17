/**
 * Rule: authored search settings need something meaningful to act on. A module
 * may expose a visible search screen when it has inputs, or go directly to
 * automatically-filtered results when it has only an always-on rule. The
 * case-list config must therefore carry at least one of:
 *
 *   - a non-`match-all` `caseListConfig.filter` (the Cases available
 *     rule that always narrows the result set), OR
 *   - one or more `caseListConfig.searchInputs[]` entries (inputs
 *     the user types into to narrow the result set).
 *
 * If neither is present, the saved search copy/advanced settings have no
 * meaningful surface to control.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent — no
 * search surface exists.
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
			`Module "${mod.name}" carries search-screen settings but has neither available-case rules nor search fields. Add a search field, narrow the available cases, or remove the unused search-screen settings.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}
