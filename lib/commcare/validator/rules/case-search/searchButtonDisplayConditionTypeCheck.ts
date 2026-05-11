/**
 * Rule: `caseSearchConfig.searchButtonDisplayCondition` (the
 * predicate gating whether the search button renders) type-checks
 * against the module's case-type schema map.
 *
 * Routes through the shared `moduleTypeContext` admission set + the
 * shared `formatPath` for AST-path suffixes + the shared
 * `checkPredicate` dispatch — same shape every predicate-slot type-
 * check rule uses, varying only on (1) which slot it reads and (2)
 * the validation error code it emits.
 *
 * Routing through `checkPredicate` covers orphan input refs
 * natively — the type checker pushes "Unknown search input
 * '<name>'." per orphan ref via `resolveTermType`'s `input` arm
 * when `ctx.knownInputs` is populated. No separate orphan-ref rule
 * is needed for the predicate slots.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent OR the
 * `searchButtonDisplayCondition` slot itself is omitted — no
 * predicate to check, no error.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkPredicate } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "../case-list/shared";

export function searchButtonDisplayConditionTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const condition = mod.caseSearchConfig?.searchButtonDisplayCondition;
	if (!condition) return [];

	const ctx = moduleTypeContext(mod, doc);
	const result = checkPredicate(condition, ctx);
	if (result.ok) return [];

	return result.errors.map((err) => {
		const at = formatPath(err.path);
		// Suffix the AST path when present — locates the offending
		// node inside the predicate. Reads as a sentence fragment
		// when concatenated to the per-rule message.
		const suffix = at ? ` (at ${at})` : "";
		return validationError(
			"CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			"module",
			`Module "${mod.name}" case-search button display condition has a type error${suffix}: ${err.message}. The slot must resolve to a boolean (the runtime hides the search button when the predicate evaluates false). Open \`caseSearchConfig.searchButtonDisplayCondition\` and adjust the operand at that path, or clear the condition to render the button unconditionally.`,
			{ moduleUuid, moduleName: mod.name },
			{ path: at },
		);
	});
}
