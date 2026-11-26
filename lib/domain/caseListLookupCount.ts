import { menuEmittedAdvanced } from "./advancedEntryDatums";
import type { BlueprintDoc } from "./blueprint";
import { entrySelections } from "./entryDatumSupplies";
import { formLinkEntries } from "./forms";
import { formRouteUuids } from "./listedForms";
import { firstMenuOpensOneCase } from "./menuScreens";
import { caseSelectionCardinality, effectiveCaseSearchConfig } from "./modules";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

/** Identify the physical selection behind a scalar lookup count. Core puts
 * the counts next to one another without tagging their suppliers. Admit the
 * direct list-to-form frame only, where that selection is the sole possible one. */
export function caseListLookupCountSource(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Uuid | undefined {
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (moduleUuid === undefined) return undefined;
	const module = doc.modules[moduleUuid];
	const form = doc.forms[formUuid];
	if (
		module?.caseListConfig?.deviceLookup === undefined ||
		module.parentModuleUuid !== undefined ||
		module.parentCaseModuleUuid !== undefined ||
		module.formsFromMenu !== undefined ||
		module.formsInMenuAbove ||
		module.hiddenFromMenu ||
		caseSelectionCardinality(module) !== "single" ||
		effectiveCaseSearchConfig(module) !== undefined ||
		form === undefined ||
		form.type !== "followup" ||
		form.shadowOf !== undefined ||
		form.caseSelections !== undefined ||
		firstMenuOpensOneCase(doc) ||
		menuEmittedAdvanced(doc, moduleUuid) ||
		formRouteUuids(doc, moduleUuid, formUuid).length !== 1
	)
		return undefined;
	const selections = entrySelections(doc, {
		kind: "form",
		module: moduleUuid,
		form: formUuid,
	});
	if (selections.length !== 1 || selections[0]?.module !== moduleUuid)
		return undefined;
	for (const source of Object.values(doc.forms)) {
		if (source.shadowOf?.form === formUuid) return undefined;
		for (const { link } of formLinkEntries(source)) {
			const target = link.target;
			if (
				(target.type === "this-form" && source.uuid === formUuid) ||
				(target.type === "form" && target.formUuid === formUuid) ||
				(target.type === "module" && target.moduleUuid === moduleUuid)
			)
				return undefined;
		}
	}
	return moduleUuid;
}
