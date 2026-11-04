/**
 * The reads of a `RawDocument` every frozen copy shares: forms in menu order
 * with their module, fields in data-tree order, a field's parent, a repeat's
 * data path, and typed reads of raw JSON values.
 *
 * Each is what `main`'s hydrated document gave its rules (`doc.formOrder`,
 * `lib/doc/fieldWalk.ts::orderedFieldUuids`, `doc.fieldParent`,
 * `lib/commcare/xform/formPath.ts::descendFormPathIntoField`), read from the
 * carriers as stored and through no schema, since the stored documents hold
 * keys the head schema refuses.
 */

import type { Json, JsonRecord, RawDocument } from "../oldShape";

export function isRecord(value: Json | undefined): value is JsonRecord {
	return (
		value !== null &&
		value !== undefined &&
		typeof value === "object" &&
		!Array.isArray(value)
	);
}

export function recordAt(
	record: JsonRecord | undefined,
	key: string,
): JsonRecord | undefined {
	const value = record?.[key];
	return isRecord(value) ? value : undefined;
}

export function stringAt(
	record: JsonRecord | undefined,
	key: string,
): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

export function arrayAt(
	record: JsonRecord | undefined,
	key: string,
): readonly Json[] {
	const value = record?.[key];
	return Array.isArray(value) ? value : [];
}

export function recordsAt(
	record: JsonRecord | undefined,
	key: string,
): readonly JsonRecord[] {
	return arrayAt(record, key).filter(isRecord);
}

/** One form of the document with the module whose menu holds it. */
export interface RawFormInMenu {
	readonly moduleUuid: string;
	readonly module: JsonRecord;
	readonly formUuid: string;
	readonly form: JsonRecord;
}

/** Every form in menu order: modules in `moduleOrder`, forms in `formOrder`. */
export function rawFormsInOrder(raw: RawDocument): RawFormInMenu[] {
	return raw.moduleOrder.flatMap((moduleUuid) => {
		const module = raw.modules[moduleUuid];
		if (module === undefined) return [];
		return (raw.formOrder[moduleUuid] ?? []).flatMap((formUuid) => {
			const form = raw.forms[formUuid];
			return form === undefined ? [] : [{ moduleUuid, module, formUuid, form }];
		});
	});
}

/** The form's module, the first in `moduleOrder` whose forms hold it. */
export function rawFormInMenu(
	raw: RawDocument,
	formUuid: string,
): RawFormInMenu | undefined {
	return rawFormsInOrder(raw).find((entry) => entry.formUuid === formUuid);
}

/** The direct children of a form or container, in their stored order. */
export function rawChildren(raw: RawDocument, parentUuid: string): string[] {
	return (raw.fieldOrder[parentUuid] ?? []).filter(
		(uuid) => raw.fields[uuid] !== undefined,
	);
}

/** Every field under `parentUuid`, each before its children: data-tree order. */
export function rawFieldsInDataOrder(
	raw: RawDocument,
	parentUuid: string,
): string[] {
	return rawChildren(raw, parentUuid).flatMap((uuid) => [
		uuid,
		...rawFieldsInDataOrder(raw, uuid),
	]);
}

/** Each field's parent, a form or a container field, as `doc.fieldParent`. */
export function rawFieldParents(raw: RawDocument): ReadonlyMap<string, string> {
	const parents = new Map<string, string>();
	for (const [parentUuid, children] of Object.entries(raw.fieldOrder))
		for (const child of children) parents.set(child, parentUuid);
	return parents;
}

export function isQueryRepeat(field: JsonRecord | undefined): boolean {
	return (
		stringAt(field, "kind") === "repeat" &&
		stringAt(field, "repeat_mode") === "query_bound"
	);
}

/** Where a form's fields stand in its data tree. */
export interface RawDataPaths {
	/** Each field's element names from the data root, `/data` excluded. */
	readonly fieldPath: ReadonlyMap<string, readonly string[]>;
	/** Each repeat's row base from the data root: its path, followed by
	 *  `item` for a query repeat, whose rows sit under that element. */
	readonly repeatBase: ReadonlyMap<string, readonly string[]>;
	/** The nearest repeat around each field (a repeat's own is itself). */
	readonly nearestRepeat: ReadonlyMap<string, string>;
}

/** Each field's data path in the form `formUuid`, as `main`'s XForm builder
 *  wrote it. */
export function rawDataPaths(raw: RawDocument, formUuid: string): RawDataPaths {
	const fieldPath = new Map<string, readonly string[]>();
	const repeatBase = new Map<string, readonly string[]>();
	const nearestRepeat = new Map<string, string>();
	const walk = (
		parentUuid: string,
		parentPath: readonly string[],
		repeat: string | undefined,
	): void => {
		for (const uuid of rawChildren(raw, parentUuid)) {
			const field = raw.fields[uuid];
			const id = stringAt(field, "id") ?? uuid;
			const path = [...parentPath, id];
			fieldPath.set(uuid, path);
			const isRepeat = stringAt(field, "kind") === "repeat";
			const ownRepeat = isRepeat ? uuid : repeat;
			if (ownRepeat !== undefined) nearestRepeat.set(uuid, ownRepeat);
			const childBase = isQueryRepeat(field) ? [...path, "item"] : path;
			if (isRepeat) repeatBase.set(uuid, childBase);
			walk(uuid, childBase, ownRepeat);
		}
	};
	walk(formUuid, [], undefined);
	return { fieldPath, repeatBase, nearestRepeat };
}

/** A field's `{ caseType, property }` write, as `main`'s
 *  `lib/domain/caseTypes.ts::fieldCaseWrite` read it: both non-empty text. */
export function rawFieldCaseWrite(
	field: JsonRecord | undefined,
): { readonly caseType: string; readonly property: string } | undefined {
	const write = recordAt(field, "caseWrite");
	const caseType = stringAt(write, "caseType");
	const property = stringAt(write, "property");
	if (
		caseType === undefined ||
		caseType.length === 0 ||
		property === undefined ||
		property.length === 0
	)
		return undefined;
	return { caseType, property };
}

/** `main`'s `lib/domain/fields/index.ts::captureFieldKinds`. */
export const RAW_CAPTURE_KINDS: ReadonlySet<string> = new Set([
	"image",
	"audio",
	"video",
	"signature",
	"file",
]);

/** `main`'s `lib/domain/forms.ts::CASE_LOADING_FORM_TYPES`. */
export const RAW_CASE_LOADING_FORM_TYPES: ReadonlySet<string> = new Set([
	"followup",
	"close",
]);

/** `main`'s `lib/domain/modules.ts::caseSelectionCardinality`: what the
 *  module's case list lets a worker choose. */
export function rawCaseSelectionCardinality(
	module: JsonRecord | undefined,
): "single" | "multiple" {
	return stringAt(
		recordAt(recordAt(module, "caseListConfig"), "selection"),
		"kind",
	) === "multiple"
		? "multiple"
		: "single";
}

/** The module's case type where it names one. */
export function rawModuleCaseType(
	module: JsonRecord | undefined,
): string | undefined {
	const caseType = stringAt(module, "caseType");
	return caseType === undefined || caseType.length === 0 ? undefined : caseType;
}
