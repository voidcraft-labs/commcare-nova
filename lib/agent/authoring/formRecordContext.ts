import {
	type BlueprintDoc,
	caseSelectionCardinality,
	effectiveCaseTypes,
	formOpensWithOneCase,
	moduleUuidOfForm,
	reachableCaseTypes,
	type Uuid,
} from "@/lib/domain";
import { formEntryRecord } from "@/lib/domain/advancedEntryDatums";
import { caseReferenceText } from "@/lib/domain/hashtagSegments";

/** Read sources follow the same selected-record and ancestor rules as Preview
 * and export. They are distinct from the form's possible write destinations. */
export function formRecordContext(doc: BlueprintDoc, formUuid: Uuid) {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid && doc.modules[moduleUuid];
	if (!form || !module) return undefined;
	const record = formEntryRecord(doc, formUuid);
	const loadsOne =
		record.requiresCase &&
		formOpensWithOneCase(
			form.type,
			caseSelectionCardinality(record.menu ?? {}),
		);
	return {
		selectedCaseType: loadsOne ? (record.caseType ?? null) : null,
		readableRecords: reachableCaseTypes(
			loadsOne ? record.contentCaseType : undefined,
			effectiveCaseTypes(doc),
		).map(({ name, depth }) => ({
			caseType: name,
			ancestorDepth: depth,
			propertyReference: caseReferenceText(name, "property"),
			identityReference: caseReferenceText(name, "case_id"),
		})),
	};
}
