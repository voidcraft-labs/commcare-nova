import { entryPointRequirements } from "@/lib/doc/entryPointProjection";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import { moduleParent } from "@/lib/domain/moduleHierarchy";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { caseRowToFormPreload } from "./engine/caseDataBindingClient";
import {
	formDisplayVisibility,
	moduleDisplayVisibility,
} from "./engine/displayConditionEvaluation";
import type { PreviewSearchSessionValues } from "./engine/identity";
import type { PreviewLookupStatus } from "./engine/useLookupPreviewData";
import type { CaseDatabaseSnapshot } from "./engine/xpathInstances";
import type {
	EntryPointLaunchResult,
	EntryPointSelection,
} from "./entryPointLaunchTypes";
import { previewMenuCaseContext } from "./menuProjection";

/** Pure admission over one authorized device snapshot. No selection can fall
 * through to ordinary Preview's first-case convenience behavior. */
export function prepareEntryPointLaunch(args: {
	readonly doc: BlueprintDoc;
	readonly entryPointUuid: Uuid;
	readonly expectedSeq: number;
	readonly personaUuid?: string;
	readonly selections: readonly EntryPointSelection[];
	readonly database: CaseDatabaseSnapshot;
	readonly session: PreviewSearchSessionValues;
	readonly lookup: PreviewLookupStatus;
}): EntryPointLaunchResult {
	const refuse = (message: string): EntryPointLaunchResult => ({
		kind: "refused",
		message,
	});
	const item = entryPointInventory(args.doc).find(
		(item) => item.entryPoint.uuid === args.entryPointUuid,
	);
	if (!item)
		return refuse("This entry point changed. Reload the app and try again.");
	const projection = entryPointRequirements(args.doc, item.target);
	if (!projection.available) return refuse(projection.message);
	const required = projection.requiredSelections;
	if (
		args.selections.length !== required.length ||
		new Set(args.selections.map((x) => x.moduleUuid)).size !==
			args.selections.length
	)
		return refuse("Choose cases for each required selection and try again.");
	const rows = new Map(args.database.rows.map((row) => [row.case_id, row]));
	// This plan crosses a Server Action boundary; React requires plain objects.
	const menuSelections: Record<string, PreviewMenuCaseSelection> = {};
	for (const requirement of required) {
		const selection = args.selections.find(
			(x) => x.moduleUuid === requirement.moduleUuid,
		);
		if (
			!selection ||
			selection.caseIds.length === 0 ||
			selection.caseIds.length > requirement.maximum ||
			(requirement.cardinality === "one" && selection.caseIds.length !== 1) ||
			new Set(selection.caseIds).size !== selection.caseIds.length ||
			selection.caseIds.some((id) => !id)
		)
			return refuse(
				"Choose the required number of distinct cases and try again.",
			);
		const selectedRows = selection.caseIds.map((id) => rows.get(id));
		if (
			selectedRows.some((row) => !row || row.case_type !== requirement.caseType)
		)
			return refuse(
				"One or more cases are unavailable to this Preview worker. Choose cases on this worker’s device. Preview does not claim or sync cases from HQ.",
			);
		menuSelections[requirement.moduleUuid] = {
			caseType: requirement.caseType,
			cases: selectedRows.map((row) => {
				if (!row)
					throw new Error("Selected case disappeared from immutable snapshot.");
				return {
					caseId: row.case_id,
					caseName: row.case_name,
					caseProperties: Object.fromEntries(caseRowToFormPreload(row)),
				};
			}),
		};
	}
	for (const requirement of required) {
		const parentType = (args.doc.caseTypes ?? []).find(
			(type) => type.name === requirement.caseType,
		)?.parent_type;
		if (!parentType) continue;
		const parents =
			previewMenuCaseContext(
				{ ...args.doc, caseTypes: args.doc.caseTypes ?? [] },
				requirement.moduleUuid,
				menuSelections,
			).parentCase?.cases.map((choice) => choice.caseId) ?? [];
		if (!parents.length)
			return refuse(
				"This entry point needs a parent case selection. Reload the app and try again.",
			);
		for (const choice of menuSelections[requirement.moduleUuid].cases) {
			const index = args.database.indices.find(
				(index) =>
					index.case_id === choice.caseId &&
					index.identifier === "parent" &&
					index.relationship === "child" &&
					index.depth === 1 &&
					index.target_case_type === parentType,
			);
			if (!index || !parents.includes(index.ancestor_id))
				return refuse(
					"Choose child cases that belong to the selected parent cases.",
				);
		}
	}
	const bypass =
		item.target.kind === "form" &&
		item.entryPoint.ignoreDisplayConditions === true;
	if (!bypass) {
		let moduleUuid: Uuid | undefined | null = item.target.moduleUuid;
		while (moduleUuid) {
			const mod = args.doc.modules[moduleUuid];
			if (
				moduleDisplayVisibility({
					condition: mod.displayCondition,
					session: args.session,
					currentCaseType: mod.caseType,
					lookup: args.lookup,
				}) !== "shown"
			)
				return refuse(
					"This destination is hidden for the selected Preview worker.",
				);
			moduleUuid = moduleParent(args.doc, moduleUuid);
		}
		if (item.target.kind === "form") {
			const mod = args.doc.modules[item.target.moduleUuid];
			const selection = previewMenuCaseContext(
				{ ...args.doc, caseTypes: args.doc.caseTypes ?? [] },
				item.target.moduleUuid,
				menuSelections,
			).selectedCase;
			const caseProjection =
				selection?.cases.length === 1
					? new Map(Object.entries(selection.cases[0].caseProperties ?? {}))
					: undefined;
			if (
				formDisplayVisibility({
					condition: args.doc.forms[item.target.formUuid].displayCondition,
					session: args.session,
					currentCaseType: mod.caseType,
					caseProjection,
					lookup: args.lookup,
				}) !== "shown"
			)
				return refuse(
					"This form is hidden for the selected cases or Preview worker.",
				);
		}
	}
	const target = item.target;
	return {
		kind: "ready",
		launch: {
			entryPointUuid: args.entryPointUuid,
			expectedSeq: args.expectedSeq,
			personaUuid: args.personaUuid,
			ignoreDisplayConditions: bypass,
			menuSelections,
			location:
				target.kind === "form"
					? {
							kind: "form",
							moduleUuid: target.moduleUuid,
							formUuid: target.formUuid,
						}
					: target.kind === "case-list"
						? { kind: "cases", moduleUuid: target.moduleUuid }
						: { kind: "module", moduleUuid: target.moduleUuid },
			...(target.kind === "form"
				? {
						formTarget: {
							formUuid: target.formUuid,
							cases:
								previewMenuCaseContext(
									{ ...args.doc, caseTypes: args.doc.caseTypes ?? [] },
									target.moduleUuid,
									menuSelections,
								).selectedCase?.cases ?? [],
						},
					}
				: {}),
		},
	};
}
