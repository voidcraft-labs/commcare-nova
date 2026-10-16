/**
 * Case property names HQ's form builder can't keep in a form's source.
 *
 * Every write a Save to Case block holds is an element named by its
 * property, and HQ's form builder reads those elements by name. It can't
 * open a form holding an element named `instance`, `bind` or `parsererror`
 * anywhere (Vellum `src/parser.js::_getInstances`, `parseBindList`, and
 * jQuery's `parseXML` for `parsererror`), and it reads a `close` element
 * inside a block's `<case>` as the block closing its case
 * (`src/saveToCase.js::parseDataNode`, `case_.find('close')`), so a save
 * there would close the case on every submission. A property written only
 * through a basic action is not refused: HQ's build adds that block, and the
 * form's source never holds it. Which writes stand in the source is
 * `lib/commcare/xform/sourceCaseWrites.ts`'s answer, the one the emitter
 * writes from.
 */

import type { FormLinkProjectionContext } from "@/lib/commcare/formLinkProjection";
import { sourceBlockCaseWrites } from "@/lib/commcare/xform/sourceCaseWrites";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	sourceWritePropertyProblem,
	sourceWritePropertySentence,
} from "@/lib/domain/questionId";
import { type ValidationError, validationError } from "../errors";

export function casePropertyNameFormBuilderCannotKeep(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	linkContext: FormLinkProjectionContext,
): ValidationError[] {
	const form = doc.forms[formUuid];
	const mod = doc.modules[moduleUuid];
	if (form === undefined || mod === undefined) return [];
	const errors: ValidationError[] = [];
	for (const write of sourceBlockCaseWrites(
		doc,
		moduleUuid,
		formUuid,
		linkContext,
	)) {
		const problem = sourceWritePropertyProblem(write.property);
		if (problem === undefined) continue;
		const location = {
			moduleUuid,
			moduleName: mod.name,
			formUuid,
			formName: form.name,
		};
		const sentence = sourceWritePropertySentence(write.property, problem);
		if (write.origin.kind === "field") {
			const field = doc.fields[write.origin.fieldUuid];
			errors.push(
				validationError(
					"CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP",
					"field",
					`"${field?.id ?? write.property}" in "${form.name}" saves the case property "${write.property}". ${sentence}`,
					{
						...location,
						fieldUuid: write.origin.fieldUuid,
						...(field !== undefined && { fieldId: field.id }),
					},
					{ property: write.property, problem },
				),
			);
			continue;
		}
		const { operationUuid } = write.origin;
		const operation = form.caseOperations?.find(
			(candidate) => candidate.uuid === operationUuid,
		);
		errors.push(
			validationError(
				"CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP",
				"form",
				`The case change "${operation?.id ?? operationUuid}" in "${form.name}" saves the case property "${write.property}". ${sentence}`,
				{ ...location, field: operationUuid },
				{
					operationUuid,
					...(operation !== undefined && { operationId: operation.id }),
					property: write.property,
					problem,
				},
			),
		);
	}
	return errors;
}
