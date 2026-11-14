import type { Uuid } from "@/lib/domain";
import type { Location } from "@/lib/routing/types";
import type { PreviewParentCaseRequest } from "@/lib/session/types";

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
