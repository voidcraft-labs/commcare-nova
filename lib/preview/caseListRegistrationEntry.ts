import type { Location } from "@/lib/routing/types";
import type {
	PreviewCaseListRegistrationEntry,
	PreviewParentCaseRequest,
} from "@/lib/session/types";

/**
 * Whether the running app is still on the path of the one launch a case
 * list's Register action made, at this location. The launch belongs to the
 * form entry it opened, as CommCare HQ's return belongs to the frame that
 * action pushes (`workflow.py::CaseListFormWorkflow`): it lasts while the
 * location runs that form (any of the form's own pages, which Preview runs
 * as the form), or is the case list choosing a parent case that admission
 * asked for on the way into that same form (a pending parent case request
 * whose resume location runs it). Every other location is an exit, however
 * the worker or the author got there (a menu, the app tree, a finding, a
 * breadcrumb, browser Back or Forward, a typed URL), and ends the launch, so
 * a later entry of the same form is an ordinary form.
 */
export function caseListRegistrationEntryContinues(
	entry: PreviewCaseListRegistrationEntry,
	loc: Location,
	parentCaseRequest: PreviewParentCaseRequest | undefined,
): boolean {
	if (runsEntryForm(entry, loc)) return true;
	return (
		parentCaseRequest !== undefined &&
		loc.kind === "cases" &&
		loc.moduleUuid === parentCaseRequest.selectingModuleUuid &&
		parentCaseRequest.resumeLocation !== undefined &&
		runsEntryForm(entry, parentCaseRequest.resumeLocation)
	);
}

function runsEntryForm(
	entry: PreviewCaseListRegistrationEntry,
	loc: Location,
): boolean {
	switch (loc.kind) {
		case "form":
		case "form-condition":
		case "form-operations":
		case "form-links":
			return (
				loc.moduleUuid === entry.moduleUuid && loc.formUuid === entry.formUuid
			);
		default:
			return false;
	}
}
