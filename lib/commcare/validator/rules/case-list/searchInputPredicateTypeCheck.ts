/**
 * Rule: every advanced-arm `searchInputs[i].predicate` on the case
 * list type-checks against the module's case-type schema map.
 *
 * The simple arm of `SearchInputDef` derives its predicate from a
 * `(property, mode, via)` tuple at wire-emission time — there's no
 * authored predicate AST to type-check. The advanced arm carries
 * a full `Predicate` body that replaces the simple-arm derivation;
 * authors compose the AST directly and the wire layer emits it
 * verbatim. This rule covers the advanced arm; simple-arm
 * structural checks live in `searchInputModeMatchesPropertyType`.
 *
 * The dispatch routes through `checkPredicate` against the same
 * `moduleTypeContext` the predicate-bearing case-list rules
 * consume, so the admission set (declared properties, CommCare
 * standard set, writer-derived) and the search-input declaration
 * list (`knownInputs`) match every other case-list-config rule by
 * construction. Cross-input refs inside an advanced predicate
 * (e.g. `when-input-present(input("other_input"), ...)`) resolve
 * against the module's full search-input list because
 * `moduleTypeContext` populates `knownInputs` from
 * `caseListConfig.searchInputs`.
 *
 * Per-input short-circuits cleanly when `kind === "simple"`.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkPredicate } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "./shared";

export function searchInputPredicateTypeCheck(
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
		// Simple-arm inputs have no authored predicate body — the wire
		// layer derives the predicate from `(property, mode, via)` at
		// emission time. The mode-vs-property-type compatibility check
		// for simple inputs lives in `searchInputModeMatchesPropertyType`.
		if (input.kind !== "advanced") continue;
		const result = checkPredicate(input.predicate, ctx);
		if (result.ok) continue;

		for (const err of result.errors) {
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
						path: at,
					},
				),
			);
		}
	}

	return errors;
}
