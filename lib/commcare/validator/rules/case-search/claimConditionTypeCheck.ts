/**
 * Rule: `caseSearchConfig.claimCondition` (the predicate gating the
 * runtime claim step) type-checks against the module's case-type
 * schema map.
 *
 * Mirrors the pattern from the case-list `filterTypeCheck` rule —
 * both rules dispatch the same predicate AST type checker against a
 * predicate slot, differing only in (1) which slot they read and
 * (2) the validation error code they emit. Reusing
 * `moduleTypeContext` (from `../case-list/shared`) keeps the
 * admission set identical across both surfaces: declared properties
 * → CommCare standard set → writer-derived set, with the same
 * priority order, and the same `searchInputs` declaration list
 * supplying the type checker's `knownInputs`.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent OR the
 * `claimCondition` slot itself is omitted — no predicate to check,
 * no error.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkPredicate } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "../case-list/shared";

export function claimConditionTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const claimCondition = mod.caseSearchConfig?.claimCondition;
	if (!claimCondition) return [];

	const ctx = moduleTypeContext(mod, doc);
	const result = checkPredicate(claimCondition, ctx);
	if (result.ok) return [];

	return result.errors.map((err) => {
		const at = formatPath(err.path);
		// Suffix the AST path when present — locates the offending
		// node inside the predicate. Reads as a sentence fragment when
		// concatenated to the per-rule message.
		const suffix = at ? ` (at ${at})` : "";
		return validationError(
			"CASE_SEARCH_CLAIM_CONDITION_TYPE_ERROR",
			"module",
			`Module "${mod.name}" case-search claim condition has a type error${suffix}: ${err.message}`,
			{ moduleUuid, moduleName: mod.name },
			{ path: at },
		);
	});
}
