// lib/preview/unheldCaseSubmit.ts
//
// Which forms change the case they were opened for, for a form an entry
// point opened on Android for a case the phone does not hold
// (`lib/preview/platform.ts`, `entryPointCaseNotHeld: "opens-blank"`).
//
// Android opens such a form with blank preloads. Submitting it, Core's
// `xml/CaseXmlParser.java::loadCase` throws for an update or a close of a
// case the phone lacks (`errorIfMissing` is true for both, false for an
// index or an attachment). Android processes a completed form as it saves
// it (`android/database/user/models/FormRecord.java::updateAndProcessRecord`),
// so the throw fails the save (`tasks/SaveToDiskTask.java`,
// `SAVE_UNRECOVERABLE_ERROR`) and `activities/FormEntryActivity.java::savingComplete`
// quarantines the form, which posts "Form Record Quarantined"
// (`notification.quarantine.local.*`). The lane observes that notification
// and that the form never reaches HQ (`entryPointUnheldCaseSubmit:
// "not-processed"`). So Preview refuses to write exactly the submissions
// that would make Core's `loadCase` throw:
//
// - a close form whose close condition holds (or that has none);
// - a follow-up whose own case block updates the module's case, which is
//   the primary `<update>` `lib/commcare/xform/caseBlocks.ts` writes when
//   the update map has entries;
// - an authored case operation that updates or closes the session's case.
//
// An operation on a case the form creates, or on a case an expression names
// through the worker's data, changes a case the phone resolves against its
// own restore and is not counted; nor is a form that only reads the case.
//
// Pure: the form screen's submit calls it. App Tests open no entry point,
// so their submission never reaches a case the phone does not hold.

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { deriveCaseWriteInventory } from "@/lib/domain/caseWriteInventory";
import { orderedCaseOperations } from "@/lib/domain/forms";
import type { Uuid } from "@/lib/domain/uuid";

/** Whether a close form's close condition holds for the submitted answers,
 *  read through `answerOf` (the answer to a question by its uuid): `=`
 *  compares the answer, `selected` looks for it among a multiple choice's
 *  answers, and a close form with no condition always closes. */
export function closeConditionHolds(
	doc: Pick<BlueprintDoc, "forms">,
	formUuid: Uuid,
	answerOf: (fieldUuid: Uuid) => string,
): boolean {
	const condition = doc.forms[formUuid]?.closeCondition;
	if (condition === undefined) return true;
	const value = answerOf(condition.field);
	return condition.operator === "selected"
		? value.split(/\s+/).includes(condition.answer)
		: value === condition.answer;
}

/** Whether submitting the form updates or closes the case the session holds.
 *  `closeHolds` is whether a close form's close condition holds for the
 *  submitted answers (true for a close form with no condition). */
export function formChangesSessionCase(
	doc: Pick<
		BlueprintDoc,
		| "forms"
		| "formOrder"
		| "modules"
		| "fields"
		| "fieldOrder"
		| "caseTypes"
		| "userProperties"
	>,
	formUuid: Uuid,
	closeHolds: boolean,
): boolean {
	const form = doc.forms[formUuid];
	if (form === undefined) return false;
	if (form.type === "close" && closeHolds) return true;
	if (
		orderedCaseOperations(form).some(
			(operation) =>
				(operation.action === "update" || operation.action === "close") &&
				operation.target.kind === "session",
		)
	)
		return true;
	if (form.type !== "followup" && form.type !== "close") return false;
	const moduleUuid = Object.keys(doc.formOrder).find((candidate) =>
		doc.formOrder[candidate as Uuid]?.includes(formUuid),
	) as Uuid | undefined;
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (module === undefined) return false;
	return deriveCaseWriteInventory(
		doc,
		formUuid,
		module,
		form.type,
	).buckets.some(
		(bucket) =>
			bucket.kind === "primary" &&
			bucket.action === "update" &&
			bucket.writers.length > 0,
	);
}
