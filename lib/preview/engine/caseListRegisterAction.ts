/**
 * The Register action a case list offers, as the running app draws it, and
 * where a worker lands after submitting a form a list always offers, read
 * from the frames the wire owner writes for it
 * (`lib/commcare/formLinkProjection.ts::caseListFormReturnFrames`).
 */

import { caseListFormLabelUnit } from "@/lib/commcare/emissionPlan";
import {
	caseListFormReturnFrames,
	entryNewCaseDatumId,
	entrySessionDatums,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import {
	alwaysOfferedRegistrationOf,
	type BlueprintDoc,
	caseListRegistrationReturnOf,
	type FormIconRef,
	type MediaAssetId,
	moduleUuidOfForm,
	type Platform,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import type {
	PreviewCaseListRegistrationLaunch,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
import { previewPlatformRules } from "../platform";
import { type FrameLanding, screenOfFrame } from "./frameLanding";

/** The Register action a case list offers, as the list draws it. */
export interface PreviewRegisterAction {
	readonly arm: "after-empty-search" | "always";
	/** The form the action opens, and the module that holds it (the host
	 *  itself for `after-empty-search`). */
	readonly formUuid: Uuid;
	readonly formModuleUuid: Uuid;
	/** The label's unit (`emissionPlan.ts::caseListFormLabelUnit`) and its
	 *  source text: the slot's `label`, else the form's name. */
	readonly labelUnitId: TranslationUnitId;
	readonly label: string;
	/** The `always` arm's media where the platform draws it; else undefined. */
	readonly icon: FormIconRef | undefined;
	readonly audioLabel: MediaAssetId | undefined;
}

/**
 * What the host's case list offers, undefined where the host holds no slot
 * or the form it names is in no menu. When the `after-empty-search` action
 * shows is the caller's (`noMatchesActionAvailable`); the `always` action
 * shows wherever the host's list shows. Its icon and spoken label are drawn
 * only where the platform draws a case list action's media
 * (`caseListActionMedia`).
 */
export function previewRegisterAction(
	doc: BlueprintDoc,
	hostUuid: Uuid,
	platform: Platform,
): PreviewRegisterAction | undefined {
	const slot = doc.modules[hostUuid]?.caseListRegistrationForm;
	if (slot === undefined) return undefined;
	const form = doc.forms[slot.formUuid];
	const formModuleUuid = moduleUuidOfForm(doc, slot.formUuid);
	if (form === undefined || formModuleUuid === undefined) return undefined;
	const base = {
		formUuid: slot.formUuid,
		formModuleUuid,
		labelUnitId: caseListFormLabelUnit(doc, hostUuid, slot.formUuid),
		label: slot.label ?? form.name,
	};
	if (slot.kind === "after-empty-search")
		return {
			arm: "after-empty-search",
			...base,
			icon: undefined,
			audioLabel: undefined,
		};
	const media = previewPlatformRules(platform).caseListActionMedia === "shown";
	return {
		arm: "always",
		...base,
		icon: media ? slot.icon : undefined,
		audioLabel: media ? slot.audioLabel : undefined,
	};
}

/**
 * Where a worker lands after submitting a form the Register action of an
 * `always` arm opened. Undefined is ordinary routing: no launch, a launch
 * whose host no longer offers the form, or a form whose own after-submit is
 * in force (`caseListRegistrationReturnOf` gives `own`), as on a device,
 * where HQ then writes no return frame. Otherwise it lands where the frame
 * whose guard holds lands (`screenOfFrame`): the one frame of `case-list`;
 * for `new-case` the first where the submission created a case, else the
 * second.
 */
export function alwaysOfferedRegistrationReturn(
	doc: BlueprintDoc,
	formUuid: Uuid,
	launch: PreviewCaseListRegistrationLaunch | undefined,
	createdCaseId: string | undefined,
): FrameLanding | undefined {
	if (launch === undefined) return undefined;
	const hostUuid = launch.hostModuleUuid;
	if (alwaysOfferedRegistrationOf(doc, hostUuid)?.formUuid !== formUuid)
		return undefined;
	const returnTo = caseListRegistrationReturnOf(doc, hostUuid);
	const caseType = doc.modules[hostUuid]?.caseType;
	const formModuleUuid = moduleUuidOfForm(doc, formUuid);
	if (
		returnTo === undefined ||
		returnTo.kind === "own" ||
		!caseType ||
		formModuleUuid === undefined
	)
		return undefined;
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const newCaseId = entryNewCaseDatumId(
		entrySessionDatums(doc, ctx, formModuleUuid, formUuid),
		caseType,
	);
	if (newCaseId === undefined) return undefined;
	const frames = caseListFormReturnFrames(
		doc,
		ctx,
		hostUuid,
		newCaseId,
		caseType,
		returnTo.kind,
	);
	const frame =
		returnTo.kind === "new-case" && createdCaseId === undefined
			? frames[1]
			: frames[0];
	return frame === undefined ? undefined : screenOfFrame(ctx, frame.target);
}

/** The case a registration created, as the device holds it after the
 *  submission: the row of `caseId` and `caseType` its patch wrote, which is
 *  what the `new-case` frame's guard counts. Undefined where its open
 *  condition created none. */
export function registeredCaseOnDevice(
	patch:
		| {
				readonly rows: readonly {
					readonly case_id: string;
					readonly case_type: string;
					readonly case_name: string;
				}[];
		  }
		| undefined,
	caseId: string,
	caseType: string | undefined,
): { readonly caseId: string; readonly caseName: string } | undefined {
	const row = patch?.rows.find(
		(candidate) =>
			candidate.case_id === caseId && candidate.case_type === caseType,
	);
	return row === undefined
		? undefined
		: { caseId: row.case_id, caseName: row.case_name };
}

/**
 * The menu selections a Register return leaves: the host's selection is the
 * created case where the landing's frame selects in the host, every other
 * menu the frame selects in keeps its current selection, and every menu the
 * frame does not select in is cleared, as a frame installs only the datums
 * it carries.
 */
export function selectionsAfterRegistrationReturn(
	current: Readonly<Record<string, PreviewMenuCaseSelection>>,
	landing: FrameLanding,
	hostModuleUuid: Uuid,
	hostCaseType: string,
	created: { readonly caseId: string; readonly caseName: string } | undefined,
): Record<string, PreviewMenuCaseSelection> {
	const next: Record<string, PreviewMenuCaseSelection> = {};
	for (const moduleUuid of landing.selectingModuleUuids) {
		if (moduleUuid === hostModuleUuid) {
			if (created !== undefined)
				next[moduleUuid] = {
					caseType: hostCaseType,
					cases: [
						{
							caseId: created.caseId,
							caseName: created.caseName === "" ? "Case" : created.caseName,
						},
					],
				};
			continue;
		}
		const kept = current[moduleUuid];
		if (kept !== undefined) next[moduleUuid] = kept;
	}
	return next;
}
