/**
 * The Register action a case list offers, as the running app draws it, and
 * where a worker lands after submitting a form a list always offers, read
 * from the frames the wire owner writes for it
 * (`lib/commcare/formLinkProjection.ts::caseListFormReturnFrames`).
 */

import {
	caseListFormLabelUnit,
	emissionPlan,
} from "@/lib/commcare/emissionPlan";
import {
	caseListActionDatums,
	caseListActionReturnFrames,
	entryFrameDatums,
	entrySessionDatums,
	formLinkProjectionContext,
	sourceOfFrameSelection,
} from "@/lib/commcare/formLinkProjection";
import {
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

/** Where a Register return leaves a worker. */
export interface RegistrationReturnLanding extends FrameLanding {
	/** The menus whose search the frame runs again over the registered case
	 *  alone (`CaseListFormReturnFrame.newCaseSearchModuleUuids`): each one's
	 *  Results, and its forms' read of what the search found, hold that one
	 *  case, or none where the form created no case. */
	readonly newCaseSearchModuleUuids: readonly Uuid[];
	/** The menu whose search the frame ends on, keyed to the registered case
	 *  (the last of `newCaseSearchModuleUuids`, with no selection after it):
	 *  Web Apps lands on its list with no row (`PreviewSearchState`'s
	 *  `listsNoRow`). */
	readonly endsOnSearchOf?: Uuid;
	/** The menus the frame selects another case the form created in, by
	 *  the case operation that created it and its entry datum
	 *  (`CaseListFormReturnFrame.createdSelections`). */
	readonly createdSelections?: readonly {
		readonly moduleUuid: Uuid;
		readonly operationUuid: Uuid;
		readonly datumId: string;
		readonly caseType: string;
	}[];
	readonly earlierSelections?: readonly {
		target: Uuid;
		source: Uuid;
		fromForm: boolean;
	}[];
}

/**
 * Where a worker lands after submitting a form the Register action of an
 * `always` arm opened. Undefined is ordinary routing: no launch, a launch
 * whose host no longer offers the form, or a form whose own after-submit is
 * in force (`caseListRegistrationReturnOf` gives `own`), as on a device,
 * where HQ then writes no return frame. Otherwise it lands where the frame
 * whose guard holds lands (`screenOfFrame`): the one frame of `case-list`;
 * for `new-case` the first where the submission created a case, else the
 * second; with the menus whose search that frame keys to the registered
 * case.
 */
export function caseListActionReturn(
	doc: BlueprintDoc,
	formUuid: Uuid,
	launch: PreviewCaseListRegistrationLaunch | undefined,
	createdCaseId: string | undefined,
): RegistrationReturnLanding | undefined {
	if (launch === undefined) return undefined;
	const hostUuid = launch.hostModuleUuid;
	if (doc.modules[hostUuid]?.caseListRegistrationForm?.formUuid !== formUuid)
		return undefined;
	const returnTo = caseListRegistrationReturnOf(doc, hostUuid);
	const caseType = doc.modules[hostUuid]?.caseType;
	const projectedDoc = emissionPlan(doc).doc;
	const formModuleUuid = moduleUuidOfForm(projectedDoc, formUuid);
	if (
		returnTo === undefined ||
		returnTo.kind === "own" ||
		!caseType ||
		formModuleUuid === undefined
	)
		return undefined;
	const ctx = formLinkProjectionContext(projectedDoc, {
		entryMetadataOnly: true,
		expressionDoc: doc,
	});
	const frames = caseListActionReturnFrames(
		projectedDoc,
		ctx,
		hostUuid,
		entrySessionDatums(projectedDoc, ctx, formModuleUuid, formUuid),
	);
	const frame =
		returnTo.kind === "new-case" && createdCaseId === undefined
			? frames[1]
			: frames[0];
	if (frame === undefined) return undefined;
	const submitting = entryFrameDatums(
		projectedDoc,
		ctx,
		formModuleUuid,
		formUuid,
	);
	const earlierSelections = frame.target.flatMap((child) => {
		if (
			child.type !== "datum" ||
			!child.datum.requiresSelection ||
			child.datum.query ||
			child.datum.caseType === caseType ||
			!child.datum.selectionSourceModuleUuid
		)
			return [];
		const source = sourceOfFrameSelection(submitting, child.datum);
		return source
			? [
					{
						target: child.datum.selectionSourceModuleUuid,
						source,
						fromForm: source === formModuleUuid,
					},
				]
			: [];
	});
	const operations = new Map(
		ctx.newCaseDatums(formUuid).map((datum) => [datum.id, datum.operationUuid]),
	);
	const createdSelections = frame.createdSelections.flatMap((row) => {
		const operationUuid = operations.get(row.datumId);
		return operationUuid === undefined ? [] : [{ ...row, operationUuid }];
	});
	const endsOnSearchOf =
		frame.children.at(-1)?.type === "query"
			? frame.newCaseSearchModuleUuids.at(-1)
			: undefined;
	return {
		...screenOfFrame(ctx, frame.target),
		...(earlierSelections.length > 0 && { earlierSelections }),
		...(createdSelections.length > 0 && { createdSelections }),
		newCaseSearchModuleUuids: frame.newCaseSearchModuleUuids,
		...(endsOnSearchOf !== undefined && { endsOnSearchOf }),
	};
}

/** The concrete record this action's return reads from the just-completed
 * form. Root alignment and the case block both use the operation's id. */
export function caseListActionCreatedDatum(
	doc: BlueprintDoc,
	hostUuid: Uuid,
	formUuid: Uuid,
): string | undefined {
	const slot = doc.modules[hostUuid]?.caseListRegistrationForm;
	if (slot?.formUuid !== formUuid) return undefined;
	const target = slot.kind === "always" ? slot.target : undefined;
	if (target?.kind === "chosen-parent") return undefined;
	const projection = emissionPlan(doc).doc;
	const ctx = formLinkProjectionContext(projection, {
		entryMetadataOnly: true,
		expressionDoc: doc,
	});
	return ctx
		.newCaseDatums(formUuid)
		.find((datum) =>
			target?.kind === "created-case"
				? datum.operationUuid === target.operationUuid
				: datum.ref.kind === "new-case" &&
					datum.caseType === doc.modules[hostUuid]?.caseType,
		)?.id;
}

/** The choices already supplied when the worker opens the list action.
 * Only the invoking list's earlier selections can fill a target selector.
 * Its current list is still on screen, so a previous visit's choice there
 * cannot fill the form. */
export function caseListActionChoices(
	doc: BlueprintDoc,
	hostUuid: Uuid,
	formUuid: Uuid,
	held: Readonly<Record<string, PreviewMenuCaseSelection>>,
): Record<string, PreviewMenuCaseSelection> {
	const projection = emissionPlan(doc).doc;
	const targetModule = moduleUuidOfForm(projection, formUuid);
	if (!targetModule) return {};
	const ctx = formLinkProjectionContext(projection, {
		entryMetadataOnly: true,
		expressionDoc: doc,
	});
	const supplied: Record<string, PreviewMenuCaseSelection> = {};
	for (const datum of caseListActionDatums(projection, ctx, hostUuid, {
		moduleUuid: targetModule,
		formUuid,
	})) {
		const from = datum.source?.selectionSourceModuleUuid;
		const to = datum.target.selectionSourceModuleUuid;
		if (from === undefined || to === undefined || from === hostUuid) continue;
		const chosen = held[from];
		if (chosen && chosen.caseType === datum.target.caseType)
			supplied[to] = chosen;
	}
	return supplied;
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
	landing: FrameLanding &
		Pick<RegistrationReturnLanding, "earlierSelections" | "createdSelections">,
	hostModuleUuid: Uuid,
	hostCaseType: string,
	created: { readonly caseId: string; readonly caseName: string } | undefined,
	formSelection?: PreviewMenuCaseSelection,
	/** The device's row of each other case the form created, by its case
	 *  operation; undefined where that operation created none. */
	createdByOperation: (
		operationUuid: Uuid,
		caseType: string,
	) =>
		| { readonly caseId: string; readonly caseName: string }
		| undefined = () => undefined,
): Record<string, PreviewMenuCaseSelection> {
	const next: Record<string, PreviewMenuCaseSelection> = {};
	for (const moduleUuid of landing.selectingModuleUuids) {
		// HQ's frame keys this menu's datum to another case the form created
		// (`_find_best_match`), whatever was chosen there before.
		const fromForm = landing.createdSelections?.find(
			(row) => row.moduleUuid === moduleUuid,
		);
		if (fromForm !== undefined && moduleUuid !== hostModuleUuid) {
			const row = createdByOperation(fromForm.operationUuid, fromForm.caseType);
			if (row !== undefined)
				next[moduleUuid] = {
					caseType: fromForm.caseType,
					cases: [
						{
							caseId: row.caseId,
							...(row.caseName !== "" && { caseName: row.caseName }),
						},
					],
				};
			continue;
		}
		if (
			moduleUuid === hostModuleUuid ||
			landing.firstMenuCases?.some(
				(root) =>
					root.moduleUuid === moduleUuid && root.caseType === hostCaseType,
			)
		) {
			if (created !== undefined)
				next[moduleUuid] = {
					caseType: hostCaseType,
					cases: [
						{
							caseId: created.caseId,
							...(created.caseName !== "" && { caseName: created.caseName }),
						},
					],
				};
			continue;
		}
		const supplier = landing.earlierSelections?.find(
			(item) => item.target === moduleUuid,
		);
		const kept = supplier?.fromForm
			? formSelection
			: current[supplier?.source ?? moduleUuid];
		if (kept !== undefined) next[moduleUuid] = kept;
	}
	for (const root of landing.firstMenuCases ?? []) {
		const selected = next[root.moduleUuid];
		if (selected)
			for (const recipient of root.destinationConsumers)
				next[recipient] = selected;
	}
	return next;
}
