/**
 * Rule: every `searchInputs[i].default` value expression on the
 * case list is a GLOBAL value — no case-data reads — that
 * type-checks against the module's case-type schema map AND
 * resolves to a type compatible with the surrounding input's
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
 * The case-data guard mirrors `excludedOwnerIdsTypeCheck`: a prompt
 * default evaluates when the search screen opens, before any case is
 * selected, so there is no row for a property or relationship read to
 * read. The on-device wire emits such a read as a bare relative path
 * that resolves blank, and Preview deliberately resolves it blank too
 * — the authored seed silently does nothing. The shared domain walker
 * (`expressionReadsCaseData`) rejects property, count, exists, and
 * missing reads at the gate; literals, `today()`/`now()`, and
 * session/current-user values remain valid.
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
 * coerced via `concat(...)`.
 *
 * Per-input short-circuits cleanly when the `default` slot is
 * absent.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES } from "@/lib/domain";
import {
	checkValueExpression,
	expressionReadsCaseData,
} from "@/lib/domain/predicate";
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
		if (expressionReadsCaseData(input.default)) {
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE",
					"module",
					`Search input "${input.label}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}" has a starting value that reads a case property or relationship, but the search screen opens before any case is selected — there is no case to read, so the seed resolves blank on every runtime. Use a fixed value, \`today()\`, or a current-user/session value; otherwise remove the starting value so the input opens empty.`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						inputUuid: input.uuid,
						widgetType: input.type,
						slot: `caseListConfig.searchInputs[${index}].default`,
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
					`Search input "${input.label}" (input #${index + 1}, name "${input.name}", widget "${input.type}") on the case list of module "${mod.name}" has a default value that doesn't type-check${suffix}: ${err.message}. The widget kind expects a "${expectedType}"-typed seed. Open the input's editor and adjust the operand at that path — pick a global value whose type matches, wrap the expression in a coercion (\`dateCoerce(...)\` for date widgets; \`concat(...)\` for text / select / barcode widgets), or remove the default entirely (the runtime leaves the input empty when the default slot is absent).`,
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
