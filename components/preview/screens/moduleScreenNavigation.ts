import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type ModuleLanding,
	type Uuid,
} from "@/lib/domain";
import { previewParentCaseBeforeMenu } from "@/lib/preview/engine/parentCaseSelection";
import {
	type PreviewMenuSource,
	previewCaseListFormRequest,
	previewMenuCaseContext,
} from "@/lib/preview/menuProjection";
import { parentCaseSelectorLocation } from "@/lib/preview/screenProjection";
import type { NavigateActions } from "@/lib/routing/navigation";
import type { Location } from "@/lib/routing/types";
import type {
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
	PreviewParentCaseRequest,
} from "@/lib/session/types";
import { openModuleLanding } from "./moduleLanding";

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

/**
 * Whether the module's screen, shown in Preview at `loc`, starts its parent
 * case selection: where Core asks for the parent case before it lists the
 * screen (`parentCaseBeforeMenu`, `parentCaseSelection.ts::
 * previewParentCaseBeforeMenu`), and wherever the screen stands in for a
 * leaf of the module a worker reached past its command (a form, a case
 * list: `previewParentCaseResumeLocation`), whose entry asks for it next.
 * At the module's own URL a screen that lists its entries first lists them,
 * as `CommCareSession.getNeededData` asks for a command there.
 */
export function previewModuleAsksParentCase(args: {
	readonly loc: Location;
	readonly moduleUuid: Uuid;
	readonly parentCaseBeforeMenu: boolean;
}): boolean {
	return (
		args.parentCaseBeforeMenu ||
		previewParentCaseResumeLocation(args.loc, args.moduleUuid) !== undefined
	);
}

/** The parent case selection a module's screen starts when it needs a
 * parent case: its selector, then this module, then whatever the request it
 * continues still returns to. A module entered as the selector of a pending
 * request continues that request, so the leaf and the cancel destination
 * stay the ones the request already carries: the selector's own URL is the
 * selection in progress, never a leaf to resume. A module entered any other
 * way resumes the leaf its URL names and cancels to the screen a device's
 * Back reaches from the parent's list: the module's own screen where it
 * lists its entries before the parent case (`listsBeforeParentCase`), as
 * `CommCareSession.stepBack` pops the command of the entry that asked and
 * stops where the session asks for a command, else its structural parent's
 * menu, or Home. */
export function previewParentCaseRequestFor(args: {
	readonly loc: Location;
	readonly moduleUuid: Uuid;
	readonly selectorModuleUuid: Uuid;
	readonly structuralParentUuid: Uuid | null | undefined;
	readonly pending: PreviewParentCaseRequest | undefined;
	readonly listsBeforeParentCase?: boolean;
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
			(args.listsBeforeParentCase === true && resumeLocation !== undefined
				? { kind: "module", moduleUuid: args.moduleUuid }
				: args.structuralParentUuid
					? { kind: "module", moduleUuid: args.structuralParentUuid }
					: { kind: "home" }),
	};
}

/** What choosing a menu's tile reads and writes. */
export interface PreviewMenuTileActions {
	readonly setPreviewCaseTarget: (
		target: PreviewCaseTarget | undefined,
	) => void;
	readonly setPreviewParentCaseRequest: (
		request: PreviewParentCaseRequest | undefined,
	) => void;
	readonly navigate: Pick<
		NavigateActions,
		"push" | "openCaseList" | "openModule"
	>;
}

/**
 * Choose a menu's tile, on the first menu or on a menu's screen. The tile is
 * a menu's command, which names no form, so a case target an earlier screen
 * left (a form held for a list) is let go first, on every route. Where the
 * menu asks for its parent case before it lists its screen
 * (`parentCaseSelection.ts::previewParentCaseBeforeMenu`) the parent's list
 * opens, asking for it, and Back from it cancels to `cancelLocation`, the
 * screen the tile was on; otherwise the menu opens where its landing says,
 * its forms listed first even where one of them asks for a parent case after
 * its command.
 */
export function choosePreviewMenuTile(
	actions: PreviewMenuTileActions,
	args: {
		readonly source: PreviewMenuSource & { readonly doc: BlueprintDoc };
		readonly moduleUuid: Uuid;
		readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
		readonly cancelLocation: Location;
		readonly landing: ModuleLanding;
	},
): void {
	actions.setPreviewCaseTarget(undefined);
	const required = previewMenuCaseContext(
		args.source,
		args.moduleUuid,
		args.selections,
	).requiredParentCase;
	if (
		required !== undefined &&
		previewParentCaseBeforeMenu(args.source.doc, args.moduleUuid)
	) {
		actions.setPreviewParentCaseRequest({
			selectingModuleUuid: required.moduleUuid,
			returnModuleUuids: [args.moduleUuid],
			cancelLocation: args.cancelLocation,
		});
		actions.navigate.push(parentCaseSelectorLocation(required.moduleUuid));
		return;
	}
	openModuleLanding(actions.navigate, args.moduleUuid, args.landing);
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
