/**
 * Rule: a Search field Web Apps does not draw (`hidden: true`) carries
 * nothing a worker there would have to see, and a hidden text field is
 * matched by its own name.
 *
 * Web Apps hides a hidden prompt's row whole (`query.js`, `d-none`), so a
 * hint, a requirement, a check or the box to also find blank would stand on
 * a row nobody sees; CommCare HQ's Case List page blanks a hidden prompt's
 * requirement and checks on a save. A hidden prompt with no widget that
 * leaves its key out of the request is a value the search never matches by
 * name, which Nova holds as the `hidden` arm, so a hidden text field rides
 * the bare prompt. `hiddenSearchFieldRefusal` is the one home of these
 * reasons, which the builder reads too; the wire's own decision of which
 * prompt carries `exclude` agrees with it (`hiddenSearchField.test.ts`).
 */

import {
	type BlueprintDoc,
	hiddenSearchFieldRefusal,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function hiddenSearchField(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	const errors: ValidationError[] = [];
	inputs.forEach((input, i) => {
		if (input.kind === "hidden" || input.hidden !== true) return;
		const reason = hiddenSearchFieldRefusal(input);
		if (reason === undefined) return;
		errors.push(
			validationError(
				"CASE_LIST_HIDDEN_SEARCH_FIELD_REFUSED",
				"module",
				`Search input "${input.label || input.name}" (input #${i + 1}, name "${input.name}") on module "${mod.name}" is hidden in Web Apps, which hides its whole row and reads a hidden prompt with no widget left out of the request as a value the search never matches. ${reason}`,
				{ moduleUuid, moduleName: mod.name },
				{
					slot: `caseListConfig.searchInputs[${i}].hidden`,
					inputName: input.name,
					inputUuid: input.uuid,
					reason,
				},
			),
		);
	});
	return errors;
}
