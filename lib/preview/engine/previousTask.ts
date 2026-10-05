import {
	type PreviousTaskProjection,
	projectModuleTaskSelectionUuids,
	projectPreviousTask,
	projectTaskFormSelections,
} from "@/lib/commcare";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { moduleUuidOfForm } from "@/lib/domain";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { previewMenuCaseContext } from "../menuProjection";
import { caseRowToFormPreload } from "./caseDataBindingClient";
import type { CaseDatabaseSnapshot } from "./xpathInstances";

export interface PreviousTask {
	readonly destination: PreviousTaskProjection["destination"];
	readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
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
	readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly caseDatabase: CaseDatabaseSnapshot;
}): PreviousTask {
	const plan = projectPreviousTask(args.doc, args.formUuid);
	const selections: Record<string, PreviewMenuCaseSelection> = {};
	const rowById = new Map(
		args.caseDatabase.rows.map((row) => [row.case_id, row]),
	);
	for (const retained of plan.retainedSelections) {
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
	}
	return {
		destination: plan.destination,
		selections,
		caseDatabase: args.caseDatabase,
	};
}
