import {
	type BlueprintDoc,
	caseSelectionCardinality,
	effectiveCaseTypes,
	formOpensWithOneCase,
	moduleUuidOfForm,
	reachableCaseTypes,
	type Uuid,
} from "@/lib/domain";

/** Read sources follow the same selected-record and ancestor rules as Preview
 * and export. They are distinct from the form's possible write destinations. */
export function formRecordContext(doc: BlueprintDoc, formUuid: Uuid) {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid && doc.modules[moduleUuid];
	if (!form || !module) return undefined;
	const loadsOne = formOpensWithOneCase(
		form.type,
		caseSelectionCardinality(module),
	);
	return {
		selectedCaseType: loadsOne ? (module.caseType ?? null) : null,
		readableRecords: reachableCaseTypes(
			loadsOne ? module.caseType : undefined,
			effectiveCaseTypes(doc),
		).map(({ name, depth }) => ({
			caseType: name,
			ancestorDepth: depth,
			propertyReference: `#${name}/property`,
			identityReference: `#${name}/case_id`,
		})),
	};
}
