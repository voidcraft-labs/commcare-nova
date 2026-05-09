/**
 * Rule: `caseSearchConfig.blacklistedOwnerIds` (the value
 * expression evaluating to a space-separated list of owner ids
 * excluded from search results) type-checks against the module's
 * case-type schema map.
 *
 * Mirrors the case-list `calculatedColumnTypeCheck` pattern —
 * dispatches `checkValueExpression(expression, ctx)` and lifts
 * each `CheckError` into a structured `ValidationError`. The slot
 * is a `ValueExpression` (not a Predicate), so the rule consumes
 * the value-expression entry point rather than `checkPredicate`.
 *
 * No `expectedType` is passed: the wire-emission layer coerces the
 * resolved value to text at emission time, and the per-arm
 * structural checks the type checker runs (unknown property,
 * ill-typed operators, relation-walk validation, search-input
 * resolution) cover the real authoring failure modes. Locking the
 * slot to a text-typed result would over-constrain legitimate
 * authoring shapes that resolve to other types and coerce
 * downstream.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent OR
 * the `blacklistedOwnerIds` slot itself is omitted — no expression
 * to check, no error.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkValueExpression } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "../case-list/shared";

export function blacklistedOwnerIdsTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const expression = mod.caseSearchConfig?.blacklistedOwnerIds;
	if (!expression) return [];

	const ctx = moduleTypeContext(mod, doc);
	const result = checkValueExpression(expression, ctx);
	if (result.ok) return [];

	return result.errors.map((err) => {
		const at = formatPath(err.path);
		const suffix = at ? ` (at ${at})` : "";
		return validationError(
			"CASE_SEARCH_BLACKLISTED_OWNER_IDS_TYPE_ERROR",
			"module",
			`Module "${mod.name}" case-search blacklisted owner ids expression has a type error${suffix}: ${err.message}. Open \`caseSearchConfig.blacklistedOwnerIds\` and adjust the operand at that path — common fixes are pointing a property reference at a different case property whose \`data_type\` matches, swapping the operator for one that admits these operands, or removing the broken sub-expression entirely (the wire layer omits the blacklist when the slot is empty).`,
			{ moduleUuid, moduleName: mod.name },
			{ path: at },
		);
	});
}
