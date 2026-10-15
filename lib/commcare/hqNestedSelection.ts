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
	/* Each menu's name as the document holds it, for the finding's details;
	 * a menu with no name gives none, and the copy names its role, unquoted,
	 * instead. */
	function menuNames(sourceModuleUuid: Uuid, targetModuleUuid: Uuid) {
		const sourceModuleName = doc.modules[sourceModuleUuid]?.name.trim();
		const targetModuleName = doc.modules[targetModuleUuid]?.name.trim();
		return {
			names: {
				...(sourceModuleName && { sourceModuleName }),
				...(targetModuleName && { targetModuleName }),
			},
			parent: sourceModuleName ? `"${sourceModuleName}"` : "the parent menu",
			child: targetModuleName ? `"${targetModuleName}"` : "this menu",
		};
	}
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
		onHqSelectionBoundMismatch: (issue) => {
			const { names, parent, child } = menuNames(
				issue.sourceModuleUuid,
				issue.targetModuleUuid,
			);
			add(
				issue.moduleUuid,
				`CommCare HQ would reuse the selection of up to ${issue.sourceMaximum} cases from ${parent} in ${child}, which is limited to ${issue.targetMaximum}. Raise the limit in ${child} to ${issue.sourceMaximum} or more to publish this app or make its import file. Preview keeps this limit, and so does a CCZ for a project space the app is already published to.`,
				{
					reason: "smaller-child-maximum",
					sourceModuleUuid: issue.sourceModuleUuid,
					targetModuleUuid: issue.targetModuleUuid,
					...names,
					sourceMaximum: String(issue.sourceMaximum),
					targetMaximum: String(issue.targetMaximum),
				},
			);
		},
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
			const {
				names,
				parent: parentName,
				child: childName,
			} = menuNames(sourceModuleUuid, targetModuleUuid);
			add(
				moduleUuid,
				`CommCare HQ cannot filter the cases of ${childName} by several cases selected in ${parentName}. Set ${parentName} to select one case to publish this app or make its import file. Preview keeps this selection, and so does a CCZ for a project space the app is already published to.`,
				{
					reason: "multiple-parent-relation",
					sourceModuleUuid,
					targetModuleUuid,
					...names,
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
