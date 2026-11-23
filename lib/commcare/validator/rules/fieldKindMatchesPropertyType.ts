/**
 * Rule: every form field whose answer a case operation saves (the field's
 * "Saves to", `lib/domain/caseWriteViews.ts::formCaseWriteViews`) saves to a
 * case property whose declared `data_type` can hold the values the field's
 * `kind` gives. Multiple writers (multiple fields saving to the same
 * `(case_type, property_name)` tuple) must agree on one type that holds
 * every one of theirs.
 *
 * A declared type holds a kind's values where it is the kind's own type, or
 * where the declaration stores them and every reader the declaration
 * describes reads them back (`declaredTypeHolds`): an `int` answer as a
 * `decimal`, and a `single_select` answer as `text`. The reverse directions
 * stay apart although storage takes them: a `decimal` property's readers
 * include decimal questions, which read a whole number fine, but a `text`
 * question's free text saved to a declared choice property reaches a choice
 * question that starts on it with a value it may not offer, which Web Apps
 * can't open. Writers of an undeclared property agree on the one type of
 * theirs that holds them all (`ruleSets.ts::agreedStorageType`: `int` with
 * `decimal` on `decimal`, `text` with `single_select` on `text`), the type
 * inference gives the property. Writers that agree on no one type are saved
 * as text where text holds every one of them (a number, a date, text or a
 * choice, `ruleSets.ts::joinsAsText`) and no question opens on the
 * property's value through an answer class that casts it; such a question
 * is named in the finding (`details.castBy`).
 *
 * App-scoped because the multi-writer disagreement check is by
 * definition cross-form: a `text` field and an `int` field that both
 * target `(patient, age)` are individually structurally valid but
 * collectively inconsistent. The runner aggregates writers across
 * every form in the app, partitions them by their `(case_type,
 * property_name)` tuple, and emits one error per writer so each
 * authoring surface highlights the specific field it owns rather
 * than emitting a single composite error against an arbitrary writer.
 *
 * The kind→data_type mapping itself lives at
 * `lib/domain/caseTypes.ts::caseDataTypeForFieldKind`, the single
 * table this rule and the reducer-side catalog sync both consult, so
 * the data type a writer stamps into the catalog and the data type
 * this rule reads can never disagree. Every other coercion path (e.g.
 * `text` field → `int` property) is rejected; `hidden` and the
 * capture kinds are skipped, because neither pins a value type from the
 * kind alone. A Hidden Value is a typed writer whose type is inferred from
 * its value, judged by `hiddenValueWriterAgreement.ts`; a capture saves a
 * link to its file, whatever its kind.
 *
 * A name counts as a write of `case_name`; an owner is no property a field
 * kind types, so the owner slot is outside the rule.
 */

import {
	type BlueprintDoc,
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	type FieldKind,
	formCaseWriteViews,
	isWritableStandardCaseProperty,
	type Uuid,
} from "@/lib/domain";
import { inferExpressionTypes } from "@/lib/domain/expression/inference";
import { agreedStorageType } from "@/lib/domain/expression/ruleSets";
import { formOfField } from "@/lib/domain/fieldForm";
import { valueKindPhrase } from "@/lib/domain/valueKindPhrases";
import { type ValidationError, validationError } from "../errors";

/** Whether a property declared `declared` holds the values a question of
 *  a kind giving `given` saves: its own type, an integer as a decimal, a
 *  choice as text. */
export function declaredTypeHolds(
	given: CasePropertyDataType,
	declared: CasePropertyDataType,
): boolean {
	return (
		given === declared ||
		(given === "int" && declared === "decimal") ||
		(given === "single_select" && declared === "text") ||
		(given === "single_select" && declared === "multi_select")
	);
}

/**
 * Per-field-kind → the case-property `data_type` its values have. Thin
 * alias over the locked domain table (`caseDataTypeForFieldKind`) named
 * for this rule's reading: the data type a writer of this kind gives. `undefined` means the kind is skipped at this rule layer
 * (a Hidden Value's type comes from its value, which
 * `hiddenValueWriterAgreement.ts` judges, and captures are mode-dependent).
 */
const expectedDataType = caseDataTypeForFieldKind;

/**
 * One field that writes to a case property — collected across the
 * app's full form set so the multi-writer-disagreement check can run
 * cross-form.
 */
interface Writer {
	moduleUuid: Uuid;
	moduleName: string;
	formUuid: Uuid;
	formName: string;
	fieldUuid: Uuid;
	fieldId: string;
	kind: FieldKind;
}

export function fieldKindMatchesPropertyType(
	doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// Read every form's case-write views, collecting writers per `(case_type,
	// property_name)` tuple. The fully-qualified key (`caseType::id`)
	// disambiguates a property name shared between two case types —
	// `(patient, name)` and `(visit, name)` are independent tuples.
	const writersByTuple = new Map<string, Writer[]>();

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			for (const [fieldUuid, views] of formCaseWriteViews(doc, formUuid)) {
				const field = doc.fields[fieldUuid];
				if (field === undefined) continue;
				for (const view of views) {
					if (view.slot === "owner") continue;
					const key = encodeTupleKey(view.caseType, view.property);
					const bucket = writersByTuple.get(key) ?? [];
					bucket.push({
						moduleUuid,
						moduleName: mod.name,
						formUuid,
						formName: form.name,
						fieldUuid,
						fieldId: field.id,
						kind: field.kind,
					});
					writersByTuple.set(key, bucket);
				}
			}
		}
	}

	// Per-tuple resolution: compare each writer's kind to (a) the
	// declared property's `data_type` if the property exists on the
	// case type, and (b) other writers' kinds if more than one writer
	// targets the tuple.
	for (const [tupleKey, writers] of writersByTuple) {
		const [caseType, propertyName] = decodeTupleKey(tupleKey);
		const ct = doc.caseTypes?.find((c) => c.name === caseType);
		const property = ct?.properties.find((p) => p.name === propertyName);
		// The two writable standard scalars are always text-shaped even when
		// the catalog omits their implicit entries. An explicitly declared
		// standard entry may carry authoring metadata/order, but may not
		// redefine the row column's storage type.
		const declaredType: CasePropertyDataType | undefined =
			isWritableStandardCaseProperty(propertyName)
				? "text"
				: property?.data_type;

		for (const writer of writers) {
			const expected = expectedDataType(writer.kind);
			if (expected === undefined) continue; // skipped kind — see expectedDataType

			// (a) A declared data_type that can't hold the field's values.
			if (
				declaredType !== undefined &&
				!declaredTypeHolds(expected, declaredType)
			) {
				errors.push(
					validationError(
						"FIELD_KIND_PROPERTY_TYPE_MISMATCH",
						"field",
						`Field "${writer.fieldId}" in "${writer.formName}" is of kind "${writer.kind}" and saves to case property "${propertyName}" on case type "${caseType}", but that property's declared data_type is "${declaredType}", which can't hold the "${expected}" values a field of kind "${writer.kind}" gives. You can change the field's kind, change the property's data_type, or change where the field saves.`,
						{
							moduleUuid: writer.moduleUuid,
							moduleName: writer.moduleName,
							formUuid: writer.formUuid,
							formName: writer.formName,
							fieldUuid: writer.fieldUuid,
							fieldId: writer.fieldId,
						},
						{
							caseType,
							property: propertyName,
							fieldKind: writer.kind,
							expectedDataType: expected,
							declaredDataType: declaredType,
						},
					),
				);
			}
		}

		// (b) Cross-writer disagreement — one error per writer in
		// the disagreeing set. Disagreement means no one of the writers'
		// data types holds every other (`agreedStorageType`); the rule
		// reports each writer so authors can see every site that
		// participates in the conflict.
		const expectedTypes = new Set<CasePropertyDataType>();
		for (const writer of writers) {
			const expected = expectedDataType(writer.kind);
			if (expected !== undefined) expectedTypes.add(expected);
		}
		const agreement = inferExpressionTypes(doc)
			.propertyTypes.get(caseType)
			?.get(propertyName);
		if (
			expectedTypes.size > 1 &&
			agreedStorageType(expectedTypes) === undefined &&
			agreement?.origin?.kind !== "joined"
		) {
			const sortedTypes = [...expectedTypes].sort();
			const castBy = agreement?.castBy;
			const reader =
				castBy === undefined ? undefined : doc.fields[castBy.field];
			const readerForm =
				castBy === undefined ? undefined : formOfField(doc, castBy.field);
			const readerSentence =
				castBy === undefined
					? ""
					: ` "${reader?.id ?? "A question"}" in "${(readerForm === undefined ? undefined : doc.forms[readerForm]?.name) ?? "another form"}" opens on its value as ${valueKindPhrase(castBy.type)}, so it can't be saved as text either.`;
			for (const writer of writers) {
				const expected = expectedDataType(writer.kind);
				if (expected === undefined) continue;
				errors.push(
					validationError(
						"FIELD_KIND_WRITERS_DISAGREE",
						"field",
						`Field "${writer.fieldId}" in "${writer.formName}" is of kind "${writer.kind}" and saves to case property "${propertyName}" on case type "${caseType}", but the fields in this app that save there give values no one type can hold (${sortedTypes.map((t) => `"${t}"`).join(" / ")}).${readerSentence} You can give every field that saves to "${propertyName}" a kind one type holds, ${castBy === undefined ? "or change where the conflicting fields save." : `change where the conflicting fields save, or change "${reader?.id ?? "that question"}" so it starts another way.`}`,
						{
							moduleUuid: writer.moduleUuid,
							moduleName: writer.moduleName,
							formUuid: writer.formUuid,
							formName: writer.formName,
							fieldUuid: writer.fieldUuid,
							fieldId: writer.fieldId,
						},
						{
							caseType,
							property: propertyName,
							fieldKind: writer.kind,
							expectedDataType: expected,
							conflictingDataTypes: sortedTypes.join(","),
							...(castBy === undefined ? {} : { castBy: reader?.id ?? "" }),
						},
					),
				);
			}
		}
	}

	return errors;
}

/**
 * Encode `(caseType, propertyName)` as a single string key for the
 * writers map. JSON-encoding the pair is collision-free over ALL
 * strings, which matters because this rule runs inside `runValidation`
 * without depending on identifier admission or a reserved delimiter. A delimiter-joined key would alias
 * distinct tuples (`('a::b','c')` vs `('a','b::c')`) into one writers
 * bucket and fabricate a cross-writer conflict.
 */
function encodeTupleKey(caseType: string, propertyName: string): string {
	return JSON.stringify([caseType, propertyName]);
}
function decodeTupleKey(key: string): [string, string] {
	return JSON.parse(key) as [string, string];
}
