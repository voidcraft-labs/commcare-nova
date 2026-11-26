import {
	type PreviousTaskProjection,
	previousTaskFrame,
	projectModuleTaskSelectionUuids,
	projectPreviousTask,
	projectTaskFormSelections,
} from "@/lib/commcare";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { moduleUuidOfForm } from "@/lib/domain";
import type {
	PreviewEntryChoice,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
import { previewMenuCaseContext } from "../menuProjection";
import { previewPlatformRules } from "../platform";
import { caseRowToFormPreload } from "./caseDataBindingClient";
import type { SessionDatumValue } from "./formLinkEvaluation";
import { moduleFirstMenuCases, screenOfFrame } from "./frameLanding";
import type { CaseDatabaseSnapshot } from "./xpathInstances";

export interface PreviousTask {
	readonly destination: PreviousTaskProjection["destination"];
	readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	/** The submitting entry's own choices the preceding frame keeps, in
	 *  frame order: the walk resumes from them at the next list. */
	readonly entryChoices: readonly PreviewEntryChoice[];
	readonly caseDatabase: CaseDatabaseSnapshot;
}

/** Retire a destination's leaf selection when the new module frame omits it.
 * Separately owned parent selections and explicit frame selections survive. */
export function selectionsForModuleTask(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): Readonly<Record<string, PreviewMenuCaseSelection>> {
	if (
		selections[moduleUuid] === undefined ||
		projectModuleTaskSelectionUuids(doc, moduleUuid).includes(moduleUuid)
	)
		return selections;
	const next = { ...selections };
	delete next[moduleUuid];
	return next;
}

/** A static return to this menu takes the shared first-menu datum from the
 * submitting entry. Root and leaf can be two distinct menus of the same type. */
export function selectionsForStaticModuleTask(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
	datums: ReadonlyMap<string, SessionDatumValue> | undefined,
	cases: CaseDatabaseSnapshot,
): Readonly<Record<string, PreviewMenuCaseSelection>> {
	const prefix = moduleFirstMenuCases(doc, moduleUuid);
	if (prefix.length === 0)
		return selectionsForModuleTask(doc, moduleUuid, selections);
	const next = { ...selections };
	for (const binding of prefix) {
		const held = datums?.get(binding.datumId);
		if (!held?.value) {
			delete next[binding.moduleUuid];
			continue;
		}
		const row = cases.rows.find(
			(item) =>
				item.case_id === held.value && item.case_type === binding.caseType,
		);
		next[binding.moduleUuid] = {
			caseType: binding.caseType,
			cases: [
				{
					caseId: held.value,
					caseName: row?.case_name || held.caseName,
					...(row && {
						caseProperties: Object.fromEntries(caseRowToFormPreload(row)),
					}),
				},
			],
		};
	}
	const landed = { ...selectionsForModuleTask(doc, moduleUuid, next) };
	for (const binding of prefix) {
		for (const recipient of binding.destinationConsumers) {
			if (next[binding.moduleUuid])
				landed[recipient] = next[binding.moduleUuid];
			else delete landed[recipient];
		}
	}
	return landed;
}

/** Selecting a fresh form on a retained menu preserves its device world,
 * while the form's actual entry decides which selectors remain missing. */
export function previousTaskFormSelectors(
	doc: BlueprintDoc,
	formUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): readonly Uuid[] {
	if (!moduleUuidOfForm(doc, formUuid))
		throw new Error("The next task's form is unavailable.");
	const source = { ...doc, caseTypes: doc.caseTypes ?? [] };
	return projectTaskFormSelections(doc, formUuid).flatMap((required) => {
		const held = previewMenuCaseContext(
			source,
			required.moduleUuid,
			selections,
		).selectedCase;
		if (held === undefined) return [required.moduleUuid];
		if (
			held.caseType !== required.caseType ||
			held.cases.length > required.maximum
		)
			throw new Error("The next task's selected records are unavailable.");
		return [];
	});
}

/** Resolve against the submitting entry plus its transaction receipt. No
 * visited-screen history or later restore is involved. Only the selections
 * the owner's preceding frame retains survive, with exact collection order. */
export function resolvePreviousTask(args: {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly submittedCaseIds: readonly string[];
	readonly platform: "android" | "web-apps";
	readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	/** The choices the submitting entry walked, when it walked its own. */
	readonly entryChoices?: readonly PreviewEntryChoice[];
	readonly caseDatabase: CaseDatabaseSnapshot;
}): PreviousTask {
	const plan = projectPreviousTask(args.doc, args.formUuid);
	const selections: Record<string, PreviewMenuCaseSelection> = {};
	const entryChoices: PreviewEntryChoice[] = [];
	const rowById = new Map(
		args.caseDatabase.rows.map((row) => [row.case_id, row]),
	);
	// Formplayer resets and replays choices from the first menu. Without a
	// command on the frame it stays there and never consumes a case datum.
	const retainedSelections =
		plan.destination.kind === "home" &&
		previewPlatformRules(args.platform).poppedEntrySelections === "address"
			? []
			: plan.retainedSelections;
	for (const retained of retainedSelections) {
		// A choice the entry walked is the entry's, held by its identity:
		// two choices from one list are two records, never one menu's.
		const walked = args.entryChoices?.find((choice) =>
			retained.selectionUuids?.includes(choice.selectionUuid),
		);
		if (walked !== undefined) {
			const row = rowById.get(walked.caseId);
			if (!row || row.case_type !== retained.caseType)
				throw new Error(
					"The preceding task requires a record absent from the saved device state.",
				);
			entryChoices.push({
				selectionUuid: walked.selectionUuid,
				caseId: walked.caseId,
				caseName: row.case_name || "Case",
			});
			continue;
		}
		const current =
			retained.source === "form-records"
				? {
						caseType: retained.caseType,
						cases: args.submittedCaseIds.map((caseId) => ({ caseId })),
					}
				: previewMenuCaseContext(
						{ ...args.doc, caseTypes: args.doc.caseTypes ?? [] },
						retained.moduleUuid,
						args.selections,
					).selectedCase;
		if (
			current === undefined ||
			current.caseType !== retained.caseType ||
			current.cases.length > retained.maximum
		)
			throw new Error("The preceding task's selected records are unavailable.");
		selections[retained.moduleUuid] = {
			caseType: retained.caseType,
			cases: current.cases.map((choice) => {
				const row = rowById.get(choice.caseId);
				if (!row || row.case_type !== retained.caseType)
					throw new Error(
						"The preceding task requires a record absent from the saved device state.",
					);
				return {
					caseId: choice.caseId,
					caseName: row.case_name || "Case",
					caseProperties: Object.fromEntries(caseRowToFormPreload(row)),
				};
			}),
		};
		for (const recipient of retained.alsoSupplies ?? [])
			selections[recipient] = selections[retained.moduleUuid];
	}
	return {
		destination: previousTaskDestination(args.doc, args.formUuid, plan),
		selections,
		entryChoices,
		caseDatabase: args.caseDatabase,
	};
}

/** Where the preceding task lands, read as every frame lands
 * (`screenOfFrame`): the screen of the frame's last menu command, Home where
 * it holds none, or the form its form command names, reopened at the
 * selectors the projection names. */
export function previousTaskDestination(
	doc: BlueprintDoc,
	formUuid: Uuid,
	plan: PreviousTaskProjection,
): PreviousTaskProjection["destination"] {
	const { context, children } = previousTaskFrame(doc, formUuid);
	const landing = screenOfFrame(context, children);
	if (landing.formUuid !== undefined) {
		if (
			plan.destination.kind !== "record-selection" ||
			plan.destination.formUuid !== landing.formUuid
		)
			throw new Error("The preceding task's destination is unavailable.");
		return plan.destination;
	}
	return landing.screen.kind === "first-menu"
		? { kind: "home" }
		: { kind: "menu", moduleUuid: landing.screen.moduleUuid };
}
