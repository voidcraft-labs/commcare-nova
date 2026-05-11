/**
 * Rule: every `caseListConfig.searchInputs[i].name` is unique within
 * the array.
 *
 * The wire layer keys search inputs by `name` at two emission sites:
 * the per-input `<prompt key="X">` block in the `<query>` body, and
 * every CSQL `instance('search-input:results')/input/field[@name='X']`
 * read inside the AND-composed `_xpath_query`. Two declarations
 * sharing a `name` produce a wire with duplicate `<prompt>` blocks
 * and ambiguous CSQL references — the runtime cannot disambiguate
 * which authored declaration each match belongs to, so one input
 * silently shadows the other.
 *
 * The Zod schema constrains `name`'s character class (XML element-
 * name vocabulary) but does not enforce within-array uniqueness;
 * a schema-level refine would block parse-time roundtrips, and the
 * authoring surface needs the offending pair surfaced as a
 * validator error (with both indices + the conflicting name) so
 * the editor can highlight both rows. This rule lifts the
 * structural uniqueness invariant into the validator layer.
 *
 * Short-circuits cleanly when `caseListConfig` is absent or carries
 * fewer than two search inputs (uniqueness is trivially satisfied).
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function searchInputNameUniqueness(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	if (inputs.length < 2) return [];

	const errors: ValidationError[] = [];
	// Track first-seen index per name. The first occurrence is the
	// "canonical" declaration; every subsequent occurrence reports the
	// collision against it, so authors get one error per offending row
	// (the duplicate) rather than a quadratic explosion of error pairs.
	const firstByName = new Map<string, number>();

	for (let i = 0; i < inputs.length; i++) {
		const input = inputs[i];
		const firstIndex = firstByName.get(input.name);
		if (firstIndex === undefined) {
			firstByName.set(input.name, i);
			continue;
		}
		errors.push(
			validationError(
				"CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME",
				"module",
				`Module "${mod.name}" has two search inputs sharing the name "${input.name}" (input #${firstIndex + 1} and input #${i + 1}). The wire layer keys each input by name at \`<prompt key="…">\` and at the CSQL \`instance('search-input:results')/input/field[@name='…']\` read, so a runtime that fires the second declaration would silently shadow the first. Either rename one of the inputs so each name is unique within the module, or merge the two declarations into one row.`,
				{ moduleUuid, moduleName: mod.name },
				{
					inputName: input.name,
					firstIndex: String(firstIndex),
					duplicateIndex: String(i),
					firstUuid: inputs[firstIndex].uuid,
					duplicateUuid: input.uuid,
				},
			),
		);
	}

	return errors;
}
