/**
 * Rule: every form field with `case_property_on` set writes to a case
 * property whose declared `data_type` matches the field's `kind`.
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
 * field → `int` property) are explicitly rejected; `hidden` fields
 * are skipped: `kind === "hidden"` doesn't pin a value type — the
 * calculate expression's output type does, and that's a separate
 * type-checker concern.
 *
 * Container kinds (group, repeat) and media kinds (image, audio,
 * video, signature) carry no `case_property_on` slot in their schema
 * and never reach this rule. The walker's `case_property_on` filter
 * is the structural gate; the per-kind switch below handles every
 * remaining input kind.
 */

import {
	type BlueprintDoc,
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	type Field,
	type FieldKind,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";

/**
 * Per-field-kind → expected case-property `data_type`. Thin alias over
 * the locked domain table (`caseDataTypeForFieldKind`) named for this
 * rule's reading: the data type a writer of this kind is EXPECTED to
 * agree with. `undefined` means the kind is skipped at this rule layer
 * (`hidden` — calculate-driven; container / media kinds — no
 * `case_property_on` slot).
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

/**
 * Read `case_property_on` off any `Field` variant without manual
 * narrowing per kind. The slot is an optional string on every kind
 * whose schema declares it (every `inputFieldBaseSchema` extender +
 * `hidden`); structural containers and media kinds resolve to
 * `undefined` because their schemas omit the key. Mirrors the
 * `fieldProps.ts` pattern: structural reads through a Record cast
 * stay free of N×M narrowing cascades.
 */
function readCasePropertyOn(field: Field): string | undefined {
	const value = (field as unknown as Record<string, unknown>).case_property_on;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function fieldKindMatchesPropertyType(
	doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// Walk every form in the app, collecting writers per `(case_type,
	// property_name)` tuple. The fully-qualified key (`caseType::id`)
	// disambiguates a property name shared between two case types —
	// `(patient, name)` and `(visit, name)` are independent tuples.
	const writersByTuple = new Map<string, Writer[]>();

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			collectWriters(
				doc,
				formUuid,
				moduleUuid,
				mod.name,
				formUuid,
				form.name,
				writersByTuple,
			);
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
		const declaredType = property?.data_type;

		for (const writer of writers) {
			const expected = expectedDataType(writer.kind);
			if (expected === undefined) continue; // skipped kind — see expectedDataType

			// (a) Mismatch against the property's declared data_type.
			if (declaredType !== undefined && declaredType !== expected) {
				errors.push(
					validationError(
						"FIELD_KIND_PROPERTY_TYPE_MISMATCH",
						"field",
						`Field "${writer.fieldId}" in "${writer.formName}" is a ${writer.kind} field saving to case property "${propertyName}" on case type "${caseType}", but that property's declared data_type is "${declaredType}". A ${writer.kind} field writes "${expected}"-shaped values; either change the field's kind, change the property's data_type, or pick a different case_property_on target.`,
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
						`Field "${writer.fieldId}" in "${writer.formName}" is a ${writer.kind} field saving to case property "${propertyName}" on case type "${caseType}", but other fields in this app save to the same property with a different shape (${sortedTypes.map((t) => `"${t}"`).join(" / ")}). Pick one shape across every field that writes to "${propertyName}", or change the conflicting fields' \`case_property_on\` to a different property name.`,
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
 * Walk the form's field tree, collecting every field with a
 * non-empty `case_property_on` into the per-tuple writers map.
 * Recurses through container kinds via `fieldOrder` so nested writers
 * (a field inside a group inside a repeat) are surfaced uniformly.
 */
function collectWriters(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	moduleUuid: Uuid,
	moduleName: string,
	formUuid: Uuid,
	formName: string,
	writersByTuple: Map<string, Writer[]>,
): void {
	const order = doc.fieldOrder[parentUuid] ?? [];
	for (const fieldUuid of order) {
		const field = doc.fields[fieldUuid];
		if (!field) continue;
		const caseType = readCasePropertyOn(field);
		if (caseType !== undefined) {
			const key = encodeTupleKey(caseType, field.id);
			let bucket = writersByTuple.get(key);
			if (!bucket) {
				bucket = [];
				writersByTuple.set(key, bucket);
			}
			bucket.push({
				moduleUuid,
				moduleName,
				formUuid,
				formName,
				fieldUuid,
				fieldId: field.id,
				kind: field.kind,
			});
		}
		// Recurse into container kinds — `fieldOrder[uuid]` exists iff
		// the field is a container, matching the existing walkers in
		// `validator/index.ts` and `runner.ts`. The `formUuid` /
		// `formName` arguments stay constant through descent so writers
		// inside groups / repeats attribute back to their owning form.
		if (doc.fieldOrder[fieldUuid] !== undefined) {
			collectWriters(
				doc,
				fieldUuid,
				moduleUuid,
				moduleName,
				formUuid,
				formName,
				writersByTuple,
			);
		}
	}
}

/**
 * Encode `(caseType, propertyName)` as a single string key for the
 * writers map. The `::` separator is structurally safe because both
 * `caseType` (`CASE_TYPE_REGEX` at `lib/commcare/constants.ts`) and
 * field-id-derived property names (`XML_ELEMENT_NAME_REGEX`) reject
 * `:`, so the delimiter never appears inside either component.
 * `decodeTupleKey` splits on the first occurrence — the encoded key
 * is round-trip lossless against any pair drawn from the validator's
 * accepted character set.
 */
function encodeTupleKey(caseType: string, propertyName: string): string {
	return `${caseType}::${propertyName}`;
}
function decodeTupleKey(key: string): [string, string] {
	const idx = key.indexOf("::");
	return [key.slice(0, idx), key.slice(idx + 2)];
}
