/**
 * Rule: every `CalculatedColumn.expression` on
 * `caseListConfig.calculatedColumns` type-checks via
 * `checkValueExpression(...)` (the predicate AST type checker at
 * `@/lib/domain/predicate`) against the module's case-type schema.
 *
 * Calculated columns are author-defined `ValueExpression`s whose
 * resolved type drives downstream wire emission. The type checker
 * walks every operand, resolves property references, and surfaces
 * per-operand errors with paths the editor can highlight. Any error
 * the checker emits surfaces here as a single
 * `CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR` validation entry per
 * operand — the column id and the AST path locate the offending node.
 *
 * No per-column display-kind type rule is enforced beyond the
 * checker's own arms. Calculated columns never carry a kind on the
 * `Column` discriminated union; the runtime renderer reads the
 * column's expression result as text regardless of the resolved type
 * (the wire emitter coerces through `string` at the suite XML layer).
 * The checker's per-operator type rules (numeric arithmetic, ordered
 * comparisons, text-shaped operands for `concat` / `match`, etc.)
 * remain the structural gate for column expressions.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkValueExpression } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "./shared";

export function calculatedColumnTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const columns = mod.caseListConfig?.calculatedColumns ?? [];
	if (columns.length === 0) return [];

	const ctx = moduleTypeContext(mod, doc.caseTypes ?? []);
	const errors: ValidationError[] = [];

	for (let index = 0; index < columns.length; index++) {
		const column = columns[index];
		const result = checkValueExpression(column.expression, ctx);
		if (result.ok) continue;

		for (const err of result.errors) {
			const at = formatPath(err.path);
			const suffix = at ? ` (at ${at})` : "";
			errors.push(
				validationError(
					"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
					"module",
					`Module "${mod.name}" calculated column #${index + 1} ("${column.header}", id "${column.id}") has a type error${suffix}: ${err.message}`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						columnId: column.id,
						path: at,
					},
				),
			);
		}
	}

	return errors;
}
