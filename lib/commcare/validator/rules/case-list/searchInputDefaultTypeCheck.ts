/** The starting value uses its saved input slot and expected widget type. */
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	isHiddenSearchInput,
	SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES,
	searchInputDefault,
} from "@/lib/domain";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import { type ValidationError, validationError } from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";
import { formatPath } from "./shared";

export function searchInputDefaultTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	if (inputs.length === 0) return [];

	const errors: ValidationError[] = [];

	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index];
		// A hidden input has a `value`, not a seed; `searchInputHiddenValueTypeCheck`
		// owns that slot.
		if (isHiddenSearchInput(input)) continue;
		const inputDefault = searchInputDefault(input);
		if (inputDefault === undefined) continue;
		const ctx = slotContext(
			doc,
			{
				entity: "module",
				uuid: moduleUuid,
				slot: "search_input_default",
				member: { searchInputUuid: input.uuid },
			},
			lookupTables ?? new Map(),
		);
		if (ctx === undefined) continue;
		const checked = semanticCheckErrors(checkExpression(inputDefault, ctx));
		const scope = checked.find(
			(error) => error.code === "case-data-unavailable",
		);
		if (scope !== undefined) {
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE",
					"module",
					`Search input "${input.label}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}" has a starting value that reads a case property or relationship, but the search screen opens before any case is selected. There is no case to read, so the seed resolves blank on every runtime. Use a fixed value, \`today()\`, or a current-user/session value; otherwise remove the starting value so the input opens empty.`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						inputUuid: input.uuid,
						widgetType: input.type,
						...checkErrorDetails(scope),
						slot: `caseListConfig.searchInputs[${index}].default`,
					},
				),
			);
			continue;
		}
		if (input.type === "date-range") {
			throw new Error("Date-range input exposed a scalar default.");
		}
		const expectedType = SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES[input.type];
		const typeErrors = checked.filter(
			(error) => error.code !== "search-answer-unavailable",
		);
		if (typeErrors.length === 0) continue;

		for (const err of typeErrors) {
			const at = formatPath(err.path);
			const suffix = at ? ` (at ${at})` : "";
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
					"module",
					`Search input "${input.label}" (input #${index + 1}, name "${input.name}", widget "${input.type}") on the case list of module "${mod.name}" has a default value that doesn't type-check${suffix}: ${err.message}. The widget kind expects a "${expectedType}"-typed seed. Open the input's editor and adjust the operand at that path. Pick a global value whose type matches, wrap the expression in a coercion (\`dateCoerce(...)\` for date widgets; \`concat(...)\` for text / select / barcode widgets), or remove the default entirely (the runtime leaves the input empty when the default slot is absent).`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						inputUuid: input.uuid,
						widgetType: input.type,
						expectedType,
						slot: `caseListConfig.searchInputs[${index}].default`,
						registrySlot: "search_input_default",
						...checkErrorDetails(err),
					},
				),
			);
		}
	}

	return errors;
}
