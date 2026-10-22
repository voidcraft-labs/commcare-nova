/** Project semantic findings from this saved slot, preserving its owning validation code. */
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import { type ValidationError, validationError } from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";
import { formatPath } from "./shared";

export function searchInputPredicateTypeCheck(
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
		// Simple-arm inputs have no authored predicate body — the wire
		// layer derives the predicate from `(property, mode, via)` at
		// emission time. The mode-vs-property-type compatibility check
		// for simple inputs lives in `searchInputModeMatchesPropertyType`.
		if (input.kind !== "advanced") continue;
		const ctx = slotContext(
			doc,
			{
				entity: "module",
				uuid: moduleUuid,
				slot: "search_input_predicate",
				member: { searchInputUuid: input.uuid },
			},
			lookupTables ?? new Map(),
		);
		if (ctx === undefined) continue;
		const typeErrors = semanticCheckErrors(
			checkExpression(input.predicate, ctx),
		);
		if (typeErrors.length === 0) continue;

		for (const err of typeErrors) {
			const at = formatPath(err.path);
			const suffix = at ? ` (at ${at})` : "";
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
					"module",
					`Advanced search input "${input.label}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}" has a predicate that doesn't type-check${suffix}: ${err.message}. Open the input's predicate editor and adjust the operand at that path, or convert the input back to the simple arm if the authored predicate is no longer needed.`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						inputUuid: input.uuid,
						slot: `caseListConfig.searchInputs[${index}].predicate`,
						registrySlot: "search_input_predicate",
						...checkErrorDetails(err),
					},
				),
			);
		}
	}

	return errors;
}
