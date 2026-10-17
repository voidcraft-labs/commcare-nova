// lib/domain/closeCondition.ts
//
// Where a close form's condition is written. A condition stays authorable on
// any question; what CommCare HQ's Case Management tab can state decides the
// placement, which is derived from the document and never stored.
//
// The tab states a condition when all five hold, each read on HQ's own page
// and build:
//
//   1. The question is a single select, a multi select, a Hidden Value or a
//      label. Over any other kind the page's save empties the condition's
//      question (`case_config_utils.js::getQuestions`).
//   2. The question stands in no repeat. Inside one the save empties it too.
//   3. The answer holds no `'`. HQ's build writes the answer between single
//      quotes (`xform.py::XForm.action_relevance`), so one breaks out of them.
//   4. The answer neither starts nor ends with `"`. The save strips a
//      boundary `"` (`views/forms.py::edit_form_actions`).
//   5. For a select with its own choices, the answer is one of their values.
//      The page offers a select's choices alone, and its save writes the first
//      one over any other answer. A select whose choices come from a data
//      table or from the worker's cases takes any answer.
//
// Any other condition is a Save to Case close: a close-only block in the
// form's source whose group carries the condition.

import type { BlueprintDoc } from "./blueprint";
import type { Uuid } from "./uuid";

/** Where a close form's close is written: HQ's close action, or its source. */
export type CloseConditionPlacement = "form-action" | "save-to-case";

/** The question kinds HQ's Case Management tab offers a close condition. */
const STATABLE_QUESTION_KINDS: ReadonlySet<string> = new Set([
	"single_select",
	"multi_select",
	"hidden",
	"label",
]);

/**
 * Where `formUuid`'s close is written. An unconditional close, and any form
 * that is not a close form, is `form-action`. So is a condition missing its
 * answer: the emitter reads it as unconditional, as the validator's
 * CLOSE_CONDITION_INCOMPLETE says, and the editor shows no Save to Case
 * close for a condition still being written.
 */
export function closeConditionPlacement(
	doc: Pick<BlueprintDoc, "forms" | "fields" | "fieldParent">,
	formUuid: Uuid,
): CloseConditionPlacement {
	const form = doc.forms[formUuid];
	const condition = form?.closeCondition;
	if (form?.type !== "close" || condition === undefined || !condition.answer)
		return "form-action";
	const field = doc.fields[condition.field];
	if (field === undefined) return "form-action";
	const statable =
		STATABLE_QUESTION_KINDS.has(field.kind) &&
		!standsInRepeat(doc, condition.field, formUuid) &&
		!condition.answer.includes("'") &&
		!condition.answer.startsWith('"') &&
		!condition.answer.endsWith('"') &&
		answerIsOfferedChoice(field, condition.answer);
	return statable ? "form-action" : "save-to-case";
}

/** Whether a repeat stands between `fieldUuid` and its form. */
function standsInRepeat(
	doc: Pick<BlueprintDoc, "fields" | "fieldParent">,
	fieldUuid: Uuid,
	formUuid: Uuid,
): boolean {
	for (
		let parent = doc.fieldParent[fieldUuid];
		parent !== undefined && parent !== formUuid;
		parent = doc.fieldParent[parent]
	) {
		if (doc.fields[parent]?.kind === "repeat") return true;
	}
	return false;
}

/** Whether `answer` is one of the select's own choices, where it has them. */
function answerIsOfferedChoice(
	field: BlueprintDoc["fields"][Uuid],
	answer: string,
): boolean {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return true;
	if (field.optionsSource.kind !== "inline") return true;
	return field.optionsSource.options.some((option) => option.value === answer);
}
