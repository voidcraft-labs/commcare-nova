/**
 * Rule: every form field with `caseWrite` set writes to a case property whose
 * declared `data_type` matches the field's `kind`.
 * Multiple writers (multiple fields targeting the same `(case_type,
 * property_name)` tuple) must agree on the kind they map to.
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
 * `lib/domain/caseTypes.ts::caseDataTypeForFieldKind` — the single
 * table this rule and the reducer-side catalog sync both consult, so
 * the data type a writer stamps into the catalog and the data type
 * this rule expects can never disagree. Coercion paths (e.g. `text`
 * field → `int` property) are explicitly rejected; `hidden` and the
 * capture kinds are skipped, because neither pins a value type from the
 * kind alone — a hidden field's calculate output does, and a capture's
 * destination mode does, and both are separate concerns.
 *
 * Container kinds (group, repeat) and media kinds (image, audio, video,
 * signature) carry no `caseWrite` slot in their schema and never reach this
 * rule. The walker's `caseWrite` filter is the structural gate; the per-kind
 * switch below handles every remaining input kind.
 */

import {
	type BlueprintDoc,
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	deriveCaseWriteInventory,
	type FieldKind,
	isWritableStandardCaseProperty,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";

/**
 * Per-field-kind → expected case-property `data_type`. Thin alias over
 * the locked domain table (`caseDataTypeForFieldKind`) named for this
 * rule's reading: the data type a writer of this kind is EXPECTED to
 * agree with. `undefined` means the kind is skipped at this rule layer
 * (`hidden` — calculate-driven; container / media kinds — no `caseWrite`
 * slot).
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

	// Consume every form's canonical inventory, collecting writers per `(case_type,
	// property_name)` tuple. The fully-qualified key (`caseType::id`)
	// disambiguates a property name shared between two case types —
	// `(patient, name)` and `(visit, name)` are independent tuples.
	const writersByTuple = new Map<string, Writer[]>();

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const inventory = deriveCaseWriteInventory(doc, formUuid, mod, form.type);
			for (const writer of inventory.writers) {
				const key = encodeTupleKey(writer.caseType, writer.property);
				const bucket = writersByTuple.get(key) ?? [];
				bucket.push({
					moduleUuid,
					moduleName: mod.name,
					formUuid,
					formName: form.name,
					fieldUuid: writer.fieldUuid,
					fieldId: writer.fieldId,
					kind: writer.fieldKind,
				});
				writersByTuple.set(key, bucket);
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

			// (a) Mismatch against the property's declared data_type.
			if (declaredType !== undefined && declaredType !== expected) {
				errors.push(
					validationError(
						"FIELD_KIND_PROPERTY_TYPE_MISMATCH",
						"field",
						`Field "${writer.fieldId}" in "${writer.formName}" is a ${writer.kind} field saving to case property "${propertyName}" on case type "${caseType}", but that property's declared data_type is "${declaredType}". A ${writer.kind} field writes "${expected}"-shaped values; either change the field's kind, change the property's data_type, or change where the field saves.`,
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
		// the disagreeing set. Disagreement means the set of expected
		// data types across all writers has more than one entry; the
		// rule reports each writer so authors can see every site that
		// participates in the conflict.
		const expectedTypes = new Set<CasePropertyDataType>();
		for (const writer of writers) {
			const expected = expectedDataType(writer.kind);
			if (expected !== undefined) expectedTypes.add(expected);
		}
		if (expectedTypes.size > 1) {
			const sortedTypes = [...expectedTypes].sort();
			for (const writer of writers) {
				const expected = expectedDataType(writer.kind);
				if (expected === undefined) continue;
				errors.push(
					validationError(
						"FIELD_KIND_WRITERS_DISAGREE",
						"field",
						`Field "${writer.fieldId}" in "${writer.formName}" is a ${writer.kind} field saving to case property "${propertyName}" on case type "${caseType}", but other fields in this app save to the same property with a different shape (${sortedTypes.map((t) => `"${t}"`).join(" / ")}). Pick one shape across every field that writes to "${propertyName}", or change where the conflicting fields save.`,
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
 * — total over arbitrary docs (reducers are total; event-log replay
 * bypasses the identifier verdicts), so identifiers containing any
 * would-be delimiter can reach it. A delimiter-joined key would alias
 * distinct tuples (`('a::b','c')` vs `('a','b::c')`) into one writers
 * bucket and fabricate a cross-writer conflict.
 */
function encodeTupleKey(caseType: string, propertyName: string): string {
	return JSON.stringify([caseType, propertyName]);
}
function decodeTupleKey(key: string): [string, string] {
	return JSON.parse(key) as [string, string];
}
