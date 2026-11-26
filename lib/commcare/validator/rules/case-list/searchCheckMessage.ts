/**
 * Rule: a Search field's requirement and check carry messages the wire can
 * print.
 *
 * A requirement either has no message at all (`noMessage`) or may have one
 * of its own (`searchCheckMessageRefusal`, which the builder reads too).
 *
 * A check with no message uses CommCare's sentence for the check and any
 * generated answer guard, because Core keeps one validation per prompt.
 */

import {
	type Module,
	searchCheckMessageRefusal,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function searchCheckMessage(
	mod: Module,
	moduleUuid: Uuid,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	const errors: ValidationError[] = [];
	inputs.forEach((input, i) => {
		if (input.kind === "hidden") return;
		const named = `Search input "${input.label || input.name}" (input #${i + 1}, name "${input.name}") on module "${mod.name}"`;
		const reason = searchCheckMessageRefusal(input);
		if (reason !== undefined)
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_CHECK_MESSAGE_REFUSED",
					"module",
					`${named} has a requirement with no message and a message of its own. ${reason}`,
					{ moduleUuid, moduleName: mod.name },
					{
						slot: `caseListConfig.searchInputs[${i}].required`,
						inputName: input.name,
						inputUuid: input.uuid,
						reason,
					},
				),
			);
	});
	return errors;
}
