import type { BlueprintDoc } from "./blueprint";
import { formOpensWithOneCase } from "./casePreload";
import { reachableCaseTypes } from "./caseTypes";
import { effectiveCaseTypes } from "./effectiveCaseTypes";
import { caseSelectionCardinality } from "./modules";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

/** Only a scalar selected record and its ancestors can be read during a form. */
export function formRecordScope(doc: BlueprintDoc, formUuid: Uuid) {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid ? doc.modules[moduleUuid] : undefined;
	const selectedCaseType =
		form &&
		module &&
		formOpensWithOneCase(form.type, caseSelectionCardinality(module))
			? module.caseType
			: undefined;
	return {
		selectedCaseType,
		caseTypes: new Set(
			reachableCaseTypes(selectedCaseType, effectiveCaseTypes(doc)).map(
				({ name }) => name,
			),
		),
	};
}
