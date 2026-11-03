/**
 * Which writers `main` seeded from the loaded case, frozen: a copy of
 * `2f985ed6:lib/domain/casePreload.ts::writerPreloadsFromLoadedCase` over a
 * `RawDocument`.
 *
 * On a follow-up or close form whose menu loads one case, every field that
 * wrote a property of the menu's own case type opened showing that case's
 * current value (`main`'s `buildFormActions` copied each own update into
 * HQ's `case_preload` action), capture kinds excepted. Step 5 removes field
 * writes, so the head can only state such a starting value explicitly; the
 * cutover reads this rule to say which (C7,
 * `lib/doc/explicitPreloads.ts::planExplicitPreloads`).
 */

import type { JsonRecord, RawDocument } from "../oldShape";
import {
	RAW_CAPTURE_KINDS,
	RAW_CASE_LOADING_FORM_TYPES,
	rawCaseSelectionCardinality,
	rawFieldCaseWrite,
	rawFieldsInDataOrder,
	rawFormsInOrder,
	rawModuleCaseType,
	stringAt,
} from "./rawForms";

/** Whether `field` opened showing the loaded case's value for what it wrote. */
export function writerPreloadsFromLoadedCase(
	field: JsonRecord,
	module: JsonRecord,
	form: JsonRecord,
): boolean {
	if (
		!RAW_CASE_LOADING_FORM_TYPES.has(stringAt(form, "type") ?? "") ||
		rawCaseSelectionCardinality(module) !== "single"
	)
		return false;
	const moduleCaseType = rawModuleCaseType(module);
	if (moduleCaseType === undefined) return false;
	if (RAW_CAPTURE_KINDS.has(stringAt(field, "kind") ?? "")) return false;
	return rawFieldCaseWrite(field)?.caseType === moduleCaseType;
}

/** Every form's preloaded writers, in data-tree order; a form with none is
 *  absent. */
export function preloadedWriters(
	raw: RawDocument,
): ReadonlyMap<string, readonly string[]> {
	const out = new Map<string, readonly string[]>();
	for (const { formUuid, form, module } of rawFormsInOrder(raw)) {
		const writers = rawFieldsInDataOrder(raw, formUuid).filter((fieldUuid) => {
			const field = raw.fields[fieldUuid];
			return (
				field !== undefined && writerPreloadsFromLoadedCase(field, module, form)
			);
		});
		if (writers.length > 0) out.set(formUuid, writers);
	}
	return out;
}
