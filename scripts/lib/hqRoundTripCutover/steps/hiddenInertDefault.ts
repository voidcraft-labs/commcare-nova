/**
 * Step `hidden-inert-default`: removes the placeholder default every
 * authoring surface used to seed a Hidden Value with, now that a Hidden Value
 * with neither a calculate nor a default is valid (part 08 of step 2's plan,
 * The Hidden Value with neither a calculate nor a default). The placeholder
 * is a `default_value` that is structurally the one text part `''`, beside no
 * `calculate`; a calculate of `''` is a calculation someone typed and is left
 * as it is. A bare node and one seeded with `''` both hold `''` once the form
 * has loaded on Core, so nothing a worker or an export sees changes.
 *
 * One `hidden-value-saves-blank` line per field that writes a case property
 * its form does not preload, since each submission saves that property
 * blank: the form, the field and the property. Whether the form preloads is
 * this module's own walk of the raw rows, written to the rule of
 * `lib/domain/casePreload.ts::writerPreloadsFromLoadedCase` and held equal to
 * it by `__tests__/equality.test.ts`: the form opens one case of its menu's
 * case type (a follow-up or close form under single selection), the field is
 * no capture field, and it writes that case type.
 */

import { asUuid } from "@/lib/domain";
import { isCaptureFieldKind } from "@/lib/domain/fields";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { writableRecord } from "./caseLists";
import { formOfField, isRecord, rawText } from "./relativePaths";

/** Whether a stored default is the placeholder: the one text part `''`. */
function isPlaceholder(value: Json | undefined): boolean {
	if (!isRecord(value) || !Array.isArray(value.parts)) return false;
	if (value.parts.length !== 1) return false;
	const [part] = value.parts;
	return isRecord(part) && part.kind === "text" && part.text === "''";
}

/** The menu a form sits in. */
function moduleOfForm(
	document: RawDocument,
	formUuid: string,
): JsonRecord | undefined {
	for (const moduleUuid of document.moduleOrder) {
		if ((document.formOrder[moduleUuid] ?? []).includes(formUuid)) {
			return document.modules[moduleUuid];
		}
	}
	return undefined;
}

/** The case property a field writes, where it writes one. */
export function rawCaseWrite(
	field: JsonRecord,
): { caseType: string; property: string } | undefined {
	const write = field.caseWrite;
	if (!isRecord(write)) return undefined;
	const caseType = rawText(write.caseType);
	const property = rawText(write.property);
	return caseType === "" || property === ""
		? undefined
		: { caseType, property };
}

/**
 * `writerPreloadsFromLoadedCase` over the raw rows: whether the field opens
 * showing the loaded case's current value for the property it writes.
 */
export function rawWriterPreloads(
	field: JsonRecord,
	module: JsonRecord | undefined,
	form: JsonRecord | undefined,
): boolean {
	const formType = rawText(form?.type);
	if (formType !== "followup" && formType !== "close") return false;
	const config = module?.caseListConfig;
	const selection = isRecord(config) ? config.selection : undefined;
	const cardinality = isRecord(selection)
		? rawText(selection.kind) || "single"
		: "single";
	if (cardinality !== "single") return false;
	const caseType = module?.caseType;
	if (typeof caseType !== "string") return false;
	if (isCaptureFieldKind(rawText(field.kind))) return false;
	return rawCaseWrite(field)?.caseType === caseType;
}

/** What a placeholder's field writes, which decides whether it gets a line. */
export type InertDefaultWrite = "not-writing" | "preloaded" | "saves-blank";

interface InertDefault {
	readonly fieldUuid: string;
	readonly field: JsonRecord;
	readonly write: InertDefaultWrite;
	readonly property: string;
	readonly formName: string;
}

/**
 * Every Hidden Value holding the placeholder, each with what it writes: no
 * case property, one its form preloads, or one each submission saves blank.
 */
function inertDefaults(document: RawDocument): InertDefault[] {
	const found: InertDefault[] = [];
	for (const [fieldUuid, field] of Object.entries(document.fields)) {
		if (field.kind !== "hidden") continue;
		if (field.calculate !== undefined && field.calculate !== null) continue;
		if (!isPlaceholder(field.default_value)) continue;
		const caseWrite = rawCaseWrite(field);
		const formUuid = formOfField(document, fieldUuid);
		const form = formUuid === undefined ? undefined : document.forms[formUuid];
		const write: InertDefaultWrite =
			caseWrite === undefined || formUuid === undefined
				? "not-writing"
				: rawWriterPreloads(field, moduleOfForm(document, formUuid), form)
					? "preloaded"
					: "saves-blank";
		found.push({
			fieldUuid,
			field,
			write,
			property: caseWrite?.property ?? "",
			formName: rawText(form?.name),
		});
	}
	return found;
}

/**
 * The scan's split of this step's removals: how many placeholders sit on a
 * field that writes no case property, on a writer its form preloads, and on
 * a writer each submission saves blank (the ones that get a line).
 */
export function inertDefaultCounts(
	document: RawDocument,
): Readonly<Record<InertDefaultWrite, number>> {
	const counts: Record<InertDefaultWrite, number> = {
		"not-writing": 0,
		preloaded: 0,
		"saves-blank": 0,
	};
	for (const { write } of inertDefaults(document)) counts[write] += 1;
	return counts;
}

export const hiddenInertDefaultStep: CutoverStep = {
	id: "hidden-inert-default",
	apply(document) {
		const changes: DocumentChange[] = [];
		for (const inert of inertDefaults(document)) {
			delete writableRecord(inert.field).default_value;
			if (inert.write !== "saves-blank") continue;
			changes.push({
				reason: "hidden-value-saves-blank",
				entity: {
					type: "field",
					uuid: asUuid(inert.fieldUuid),
					nameAtMigration: rawText(inert.field.id),
				},
				detail: { form: inert.formName, property: inert.property },
			});
		}
		return changes;
	},
};
