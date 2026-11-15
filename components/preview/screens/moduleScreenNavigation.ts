import { CASE_LOADING_FORM_TYPES, type Uuid } from "@/lib/domain";
import {
	type PreviewMenuSource,
	previewCaseListFormRequest,
} from "@/lib/preview/menuProjection";
import type { Location } from "@/lib/routing/types";
import type {
	PreviewCaseTarget,
	PreviewParentCaseRequest,
} from "@/lib/session/types";

/** A configuration URL runs its owning Form/Results surface in Preview, so
 * it is as resumable as the canonical running URL. Module and module-condition
 * locations are already menu checkpoints and need no leaf restoration. */
export function previewParentCaseResumeLocation(
	loc: Location,
	moduleUuid: Uuid,
): Location | undefined {
	if (
		loc.kind === "home" ||
		loc.kind === "app-setup" ||
		loc.kind === "project-data" ||
		loc.kind === "module" ||
		loc.kind === "module-condition" ||
		loc.moduleUuid !== moduleUuid
	) {
		return undefined;
	}
	return loc;
}

/** The parent case selection a module's screen starts when it needs a
 * parent case: its selector, then this module, then whatever the request it
 * continues still returns to. A module entered as the selector of a pending
 * request continues that request, so the leaf and the cancel destination
 * stay the ones the request already carries: the selector's own URL is the
 * selection in progress, never a leaf to resume. A module entered any other
 * way resumes the leaf its URL names and cancels to its structural parent's
 * menu, or Home. */
export function previewParentCaseRequestFor(args: {
	readonly loc: Location;
	readonly moduleUuid: Uuid;
	readonly selectorModuleUuid: Uuid;
	readonly structuralParentUuid: Uuid | null | undefined;
	readonly pending: PreviewParentCaseRequest | undefined;
}): PreviewParentCaseRequest {
	const continuing =
		args.pending?.selectingModuleUuid === args.moduleUuid
			? args.pending
			: undefined;
	const resumeLocation = continuing
		? continuing.resumeLocation
		: previewParentCaseResumeLocation(args.loc, args.moduleUuid);
	return {
		selectingModuleUuid: args.selectorModuleUuid,
		returnModuleUuids: [
			args.moduleUuid,
			...(continuing?.returnModuleUuids ?? []),
		],
		...(resumeLocation !== undefined && { resumeLocation }),
		cancelLocation:
			continuing?.cancelLocation ??
			(args.structuralParentUuid
				? { kind: "module", moduleUuid: args.structuralParentUuid }
				: { kind: "home" }),
	};
}

/** The locations Preview runs a module's case list at. */
function isListLocation(
	loc: Location,
): loc is Extract<
	Location,
	{ kind: "cases" | "search-config" | "detail-config" | "data-review" }
> {
	return (
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config" ||
		loc.kind === "data-review"
	);
}

/** The case target a parent case selection keeps: the form the list it
 * resumes holds, chosen before its cases, so that list asks for its case
 * and opens that form once the parent case is chosen, as Formplayer asks for
 * a form's parent case and then its case after the form's command (a crumb
 * at that form cuts the session back to the command,
 * `utils.js::CloudcareUrl.spliceSelections`). Any other target is let go:
 * a case already chosen belongs to the parent case being chosen again. */
export function previewTargetKeptForParentCase(
	source: PreviewMenuSource,
	target: PreviewCaseTarget | undefined,
	request: PreviewParentCaseRequest,
): PreviewCaseTarget | undefined {
	const resume = request.resumeLocation;
	if (target === undefined || resume === undefined || !isListLocation(resume))
		return undefined;
	const caseLoading = (source.formOrder[resume.moduleUuid] ?? []).filter(
		(formUuid) => {
			const form = source.forms[formUuid];
			return form !== undefined && CASE_LOADING_FORM_TYPES.has(form.type);
		},
	);
	const held = previewCaseListFormRequest(target, caseLoading);
	return held === undefined ? undefined : { formUuid: held };
}
