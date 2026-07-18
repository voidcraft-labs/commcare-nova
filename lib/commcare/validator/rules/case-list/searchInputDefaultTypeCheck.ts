/**
 * Rule: every `searchInputs[i].default` value expression on the
 * case list type-checks against the module's case-type schema map
 * AND resolves to a type compatible with the surrounding input's
 * widget kind.
 *
 * The `default` slot is shared across both arms of the
 * `SearchInputDef` discriminated union — `simple` and `advanced`
 * inputs each accept an optional `default: ValueExpression` that
 * seeds the input's initial state at runtime. Both arms route
 * through one rule because the type-check shape is identical
 * regardless of the surrounding `kind`; the per-input widget
 * `type` enum (text / select / date / barcode)
 * picks the expected resolution type via
 * `SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES` (single source of
 * truth at `lib/domain/modules.ts`).
 *
 * Date-range is the deliberate exception. Its legacy scalar `default`
 * slot cannot describe the complete start-and-end answer CommCare requires,
 * so any imported value gets one repairable finding instead of being
 * type-checked and then emitted with different device semantics.
 *
 * Mirrors `calculatedColumnTypeCheck`'s shape: walk the
 * `searchInputs` array, dispatch
 * `checkValueExpression(default, ctx, expectedType)` per input
 * that carries a `default`, and lift each `CheckError` into a
 * structured `ValidationError` carrying the input's name + uuid
 * + widget kind + AST-path so the editor can land on the
 * offending node.
 *
 * The expected-type pin enforces the AST-strict authoring
 * contract: a `date` widget rejects a `now()` (datetime) default
 * unless the author coerces explicitly via `dateCoerce(...)`; a
 * `text` widget rejects a numeric / temporal default unless
 * coerced via `concat(...)`. `typesCompatible` widens select-
 * shaped property types (`single_select` / `multi_select`) into
 * text, so a `select` widget accepts a property reference seed
 * without explicit coercion.
 *
 * Per-input short-circuits cleanly when the `default` slot is
 * absent.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES } from "@/lib/domain";
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
		if (input.type === "date-range") {
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
					"module",
					`Search input "${input.label}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}" is a date range with a legacy single-value default. A date range needs both a start and an end, but this saved default can express only one value; Preview and CommCare would otherwise start differently. Remove the starting value. The field will open empty until Nova supports authored paired range defaults.`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						inputUuid: input.uuid,
						widgetType: input.type,
						reason: "date-range-default-unsupported",
					},
				),
			);
			continue;
		}
		const expectedType = SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES[input.type];
		const result = checkValueExpression(input.default, ctx, expectedType);
		if (result.ok) continue;

		for (const err of result.errors) {
			const at = formatPath(err.path);
			const suffix = at ? ` (at ${at})` : "";
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
					"module",
					`Search input "${input.label}" (input #${index + 1}, name "${input.name}", widget "${input.type}") on the case list of module "${mod.name}" has a default value that doesn't type-check${suffix}: ${err.message}. The widget kind expects a "${expectedType}"-typed seed. Open the input's editor and adjust the operand at that path — pick a property whose \`data_type\` matches, wrap the expression in a coercion (\`dateCoerce(...)\` for date widgets; \`concat(...)\` for text / select / barcode widgets), or remove the default entirely (the runtime leaves the input empty when the default slot is absent).`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						inputUuid: input.uuid,
						widgetType: input.type,
						expectedType,
						path: at,
					},
				),
			);
		}
	}

	return errors;
}
