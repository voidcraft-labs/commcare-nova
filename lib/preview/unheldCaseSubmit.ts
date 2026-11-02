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
// - a follow-up or close form whose own case operation changes the case it
//   loaded: a rename, an owner, a link, or a write that saves to that case
//   rather than through an index to a case above it;
// - another case operation that updates or closes the session's case.
//
// An operation on a case the form creates, or on a case an expression names
// through the worker's data, changes a case the phone resolves against its
// own restore and is not counted; nor is a form that only reads the case.
//
// Pure: the form screen's submit calls it. App Tests open no entry point,
// so their submission never reaches a case the phone does not hold.

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { orderedCaseOperations } from "@/lib/domain/forms";
import type { Uuid } from "@/lib/domain/uuid";

/** Whether submitting the form updates or closes the case the session holds.
 *  `closeHolds` is whether the form closes its own case for the submitted
 *  answers (`FormEngine.ownCloseHolds`). */
export function formChangesSessionCase(
	doc: Pick<BlueprintDoc, "forms">,
	formUuid: Uuid,
	closeHolds: boolean,
): boolean {
	const form = doc.forms[formUuid];
	if (form === undefined) return false;
	if (form.type !== "followup" && form.type !== "close") return false;
	if (form.type === "close" && closeHolds) return true;
	return orderedCaseOperations(form).some((operation) =>
		operation.action === "own"
			? operation.name !== undefined ||
				operation.owner !== undefined ||
				(operation.links?.length ?? 0) > 0 ||
				(operation.writes ?? []).some((write) => write.via === undefined)
			: (operation.action === "update" || operation.action === "close") &&
				operation.target.kind === "session",
	);
}
