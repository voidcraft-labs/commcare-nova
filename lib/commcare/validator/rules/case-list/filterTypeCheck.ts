/**
 * Rule: `caseListConfig.filter` (the always-on case-list predicate)
 * type-checks against the module's case-type schema.
 *
 * Delegates to `checkPredicate(predicate, ctx)` — the predicate AST
 * type checker (`@/lib/domain/predicate`) that validates property
 * references, operator type-compatibility, and relational walks
 * against the declared case-type schemas. Any error the checker
 * returns is surfaced as a single `CASE_LIST_FILTER_TYPE_ERROR` per
 * error, with the AST path appended to the message so the editor can
 * highlight the offending node.
 *
 * The `TypeContext` consumed here carries the augmented case-type
 * list from `moduleTypeContext` — writer-derived + CommCare standard
 * properties are synthesized into each case type's `properties[]` so
 * the predicate AST type checker sees the same admission set the
 * per-rule resolvers do (declared / standard / writer-derived).
 * Without this augmentation, a filter referencing a writer-derived
 * property like `prop("patient", "weight")` would silently fire
 * "Unknown property" even though the case-store accepts it at
 * runtime.
 *
 * Absent filter (`filter` omitted) short-circuits cleanly — no
 * predicate to check, no error.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkPredicate } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "./shared";

export function filterTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const filter = mod.caseListConfig?.filter;
	if (!filter) return [];

	const ctx = moduleTypeContext(mod, doc);
	const result = checkPredicate(filter, ctx);
	if (result.ok) return [];

	return result.errors.map((err) => {
		const at = formatPath(err.path);
		// Suffix the AST path when present — the path locates the
		// offending node inside the predicate (e.g. `eq.left` for the
		// left operand of a top-level equality). The leading "at" reads
		// as a sentence fragment when concatenated to the human-readable
		// per-rule message.
		const suffix = at ? ` (at ${at})` : "";
		return validationError(
			"CASE_LIST_FILTER_TYPE_ERROR",
			"module",
			`Module "${mod.name}" case-list filter has a type error${suffix}: ${err.message}`,
			{ moduleUuid, moduleName: mod.name },
			{ path: at },
		);
	});
}
