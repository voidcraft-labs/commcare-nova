/**
 * Rule: every runtime-active `kind: "calculated"` column on
 * `caseListConfig.columns` carries a `ValueExpression` that type-checks via
 * `checkValueExpression(...)` (the predicate AST type checker at
 * `@/lib/domain/predicate`) against the module's case-type schema.
 *
 * Calculated columns are author-defined `ValueExpression`s whose
 * resolved type drives downstream wire emission. The type checker
 * walks every operand, resolves property references, and surfaces
 * per-operand errors with paths the editor can highlight. Any error
 * the checker emits surfaces here as a single
 * `CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR` validation entry per
 * operand — the column uuid and the AST path locate the offending
 * node.
 *
 * Calculated columns share the column array with every other column
 * kind; the rule iterates the array and dispatches the type-check on
 * the calculated arm. Non-calculated columns are owned by
 * `columnReferences` (which checks their `field` slot against the
 * augmented admission set).
 *
 * The `TypeContext` consumed here carries the augmented case-type
 * list from `moduleTypeContext` — writer-derived + CommCare standard
 * properties are synthesized into each case type's `properties[]` so
 * the predicate AST type checker sees the same admission set the
 * per-rule resolvers do. Fully off-screen, unsorted legacy calculations are
 * ignored until they regain a Results, Details, or Default-order role.
 */

import {
	type BlueprintDoc,
	caseListColumnHasRuntimeRole,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { checkValueExpression } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "./shared";

export function calculatedColumnTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const columns = mod.caseListConfig?.columns ?? [];
	if (columns.length === 0) return [];

	const ctx = moduleTypeContext(mod, doc);
	const errors: ValidationError[] = [];

	for (let index = 0; index < columns.length; index++) {
		const column = columns[index];
		if (!caseListColumnHasRuntimeRole(column)) continue;
		if (column.kind !== "calculated") continue;
		const result = checkValueExpression(column.expression, ctx);
		if (result.ok) continue;

		for (const err of result.errors) {
			const at = formatPath(err.path);
			const suffix = at ? ` at \`${at}\`` : "";
			errors.push(
				validationError(
					"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
					"module",
					`Calculated column "${column.header}" (column #${index + 1}, uuid "${column.uuid}") on the case list of module "${mod.name}" has an expression that doesn't type-check${suffix}: ${err.message}. The expression's operand types and the operator's expected types didn't line up. Open the column's expression editor and adjust the operand at that path — common fixes are pointing the property reference at a different case property whose \`data_type\` matches, swapping the operator for one that admits these operands, or wrapping a literal in the right shape (for example casting a text literal to a number).`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						columnUuid: column.uuid,
						path: at,
					},
				),
			);
		}
	}

	return errors;
}
