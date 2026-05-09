/**
 * Rule: every `searchInputs[i].default` value expression on the
 * case list type-checks against the module's case-type schema map.
 *
 * The `default` slot is shared across both arms of the
 * `SearchInputDef` discriminated union — `simple` and `advanced`
 * inputs each accept an optional `default: ValueExpression` that
 * seeds the input's initial state at runtime (e.g. `today()` for
 * date-typed inputs, `sessionUser("region")` for an input
 * pre-populated from the FLW's profile). Both arms route through
 * one rule because the type-check shape is identical regardless of
 * the surrounding `kind`.
 *
 * Mirrors `calculatedColumnTypeCheck`'s shape: walk the
 * `searchInputs` array, dispatch `checkValueExpression(...)` per
 * input that carries a `default`, and lift each `CheckError` into
 * a structured `ValidationError` carrying the input's name + uuid
 * + AST-path so the editor can land on the offending node.
 *
 * No `expectedType` is passed: the wire layer coerces the seed
 * value to the input's `type` at emission. Per-arm structural
 * checks (unknown property, ill-typed operators) cover the real
 * authoring failure modes; over-constraining the resolved type
 * here would reject legitimate seed shapes.
 *
 * Per-input short-circuits cleanly when the `default` slot is
 * absent.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkValueExpression } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "./shared";

export function searchInputDefaultTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	if (inputs.length === 0) return [];

	const ctx = moduleTypeContext(mod, doc);
	const errors: ValidationError[] = [];

	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index];
		if (!input.default) continue;
		const result = checkValueExpression(input.default, ctx);
		if (result.ok) continue;

		for (const err of result.errors) {
			const at = formatPath(err.path);
			const suffix = at ? ` (at ${at})` : "";
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
					"module",
					`Search input "${input.label}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}" has a default value that doesn't type-check${suffix}: ${err.message}. Open the input's editor and adjust the operand at that path, or remove the default entirely (the runtime leaves the input empty when the default slot is absent).`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						inputUuid: input.uuid,
						path: at,
					},
				),
			);
		}
	}

	return errors;
}
