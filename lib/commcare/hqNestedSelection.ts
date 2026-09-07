import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	caseListSessionDatums,
	entrySessionDatums,
	formLinkProjectionContext,
} from "./formLinkProjection";
import type { LookupWireNaming } from "./lookup/naming";
import type { SessionDatum } from "./session";
import { type ValidationError, validationError } from "./validator/errors";

/**
 * Native HQ cannot carry two otherwise valid selection shapes. Keep these
 * target refusals outside admission: the local suite executes both in Core.
 * Consume the actual entry projection so registrations, surveys, unused
 * catalog relationships and the root's first-form selection stay distinct.
 */
export function hqNestedSelectionFindings(
	doc: BlueprintDoc,
	exportMode: "hq-json" | "hq-upload",
	lookupNaming?: LookupWireNaming,
): ValidationError[] {
	const findings = new Map<string, ValidationError>();
	function add(
		moduleUuid: Uuid,
		message: string,
		details: Record<string, string>,
	): void {
		const key = `${moduleUuid}:${details.reason}:${details.sourceModuleUuid}:${details.targetModuleUuid}`;
		if (!findings.has(key)) {
			findings.set(
				key,
				validationError(
					"HQ_NESTED_SELECTION_UNREPRESENTABLE",
					"module",
					message,
					{ moduleUuid },
					{ exportMode, ...details },
				),
			);
		}
	}
	const context = formLinkProjectionContext(doc, {
		...(lookupNaming !== undefined && { lookupNaming }),
		onHqSelectionBoundMismatch: (issue) =>
			add(
				issue.moduleUuid,
				`CommCare HQ would reuse a selection of up to ${issue.sourceMaximum} cases in a nested menu limited to ${issue.targetMaximum}. Download the app to keep this limit, or increase the nested menu's limit before exporting to HQ.`,
				{
					reason: "smaller-child-maximum",
					sourceModuleUuid: issue.sourceModuleUuid,
					targetModuleUuid: issue.targetModuleUuid,
					sourceMaximum: String(issue.sourceMaximum),
					targetMaximum: String(issue.targetMaximum),
				},
			),
	});
	function inspect(
		moduleUuid: Uuid,
		datums: readonly SessionDatum[],
		formUuid?: Uuid,
	) {
		for (const datum of datums) {
			const parent = datum.parentSelection;
			if (parent?.maxSelectValue === undefined) continue;
			const sourceModuleUuid = context.selectionSourceModules.get(parent);
			const targetModuleUuid = context.selectionSourceModules.get(datum);
			if (sourceModuleUuid === undefined || targetModuleUuid === undefined)
				continue;
			add(
				moduleUuid,
				"CommCare HQ cannot filter related cases from a selection of several parent cases. Download the app to keep this workflow, or change the parent menu to select one case before exporting to HQ.",
				{
					reason: "multiple-parent-relation",
					sourceModuleUuid,
					targetModuleUuid,
					sourceMaximum: String(parent.maxSelectValue),
					...(formUuid !== undefined && { formUuid }),
				},
			);
		}
	}
	for (const moduleUuid of context.moduleOrder) {
		for (const formUuid of context.formOrder[moduleUuid] ?? []) {
			inspect(
				moduleUuid,
				entrySessionDatums(doc, context, moduleUuid, formUuid),
				formUuid,
			);
		}
		if (doc.modules[moduleUuid].caseListOnly) {
			inspect(moduleUuid, caseListSessionDatums(doc, context, moduleUuid));
		}
	}
	return [...findings.values()];
}
