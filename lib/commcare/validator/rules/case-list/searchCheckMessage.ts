/**
 * Rule: a Search field's requirement and check carry messages the wire can
 * print.
 *
 * A requirement either has no message at all (`noMessage`) or may have one
 * of its own (`searchCheckMessageRefusal`, which the builder reads too).
 *
 * A check with no message of its own carries no text, and the worker reads
 * CommCare's sentence (`searchPrompts.ts::buildValidation`). Core keeps one
 * check per prompt (`QueryPromptParser.parse`), so where the search adds its
 * own guard to a field's answers (`xpathQuery.ts::buildRuntimeCsqlPromptValidations`),
 * the guard shares the field's check and its sentence follows the field's own
 * message. A field the search guards therefore needs a message of its own
 * for its check: without one, the guard's sentence would stand for both and
 * read back as the guard alone.
 */

import {
	type BlueprintDoc,
	type Module,
	searchCheckMessageRefusal,
	type Uuid,
} from "@/lib/domain";
import { searchGuardedFieldNames } from "../../../suite/case-search/moduleXPathQuery";
import { type ValidationError, validationError } from "../../errors";

/** `searchGuardedFieldNames`, or none where the search can't be composed yet: the rules that
 *  refuse such a search name it themselves. */
function guardedFieldNames(
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ReadonlySet<string> {
	try {
		return searchGuardedFieldNames(doc, moduleUuid);
	} catch {
		return new Set();
	}
}

export function searchCheckMessage(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	const errors: ValidationError[] = [];
	let guarded: ReadonlySet<string> | undefined;
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
		if (
			input.validation === undefined ||
			input.validation.message !== undefined
		)
			return;
		// Composed once for the module, and only where a check has no message.
		guarded ??= guardedFieldNames(moduleUuid, doc);
		if (!guarded.has(input.name)) return;
		const guardReason =
			"The search checks this field's answer itself and shows its own sentence after the check's message, so the check needs a message. Give the check a message.";
		errors.push(
			validationError(
				"CASE_LIST_SEARCH_CHECK_MESSAGE_REFUSED",
				"module",
				`${named} has a check with no message, and the search adds its own check of the answer to the same check, whose sentence follows the field's message. ${guardReason}`,
				{ moduleUuid, moduleName: mod.name },
				{
					slot: `caseListConfig.searchInputs[${i}].validation`,
					inputName: input.name,
					inputUuid: input.uuid,
					reason: guardReason,
				},
			),
		);
	});
	return errors;
}
