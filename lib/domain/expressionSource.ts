// Stored expressions are read as trees. Human text is a projection with the
// actual form context; prose has its own projection over current names.

import { type FormPrintContext, printFormExpression } from "./expression/print";
import type { Expression, ExpressionSlotRef } from "./expression/types";
import type { Field } from "./fields";
import {
	isProseTemplate,
	type ProseTemplate,
	projectProseTemplate,
} from "./prose";
import type { ReferenceNamesDoc } from "./referenceNames";
import {
	type ExpressionReadableDoc,
	expressionSlotValue,
	FIELD_REFERENCE_SLOTS,
	type FieldProseSlotId,
	fieldSlotApplies,
	readSlotValues,
	type SlotStringEntry,
} from "./referenceSlots";

/** The actual stored tree behind one registered, identity-bearing slot. */
export function expressionAt(
	doc: ExpressionReadableDoc,
	ref: ExpressionSlotRef,
): Expression | undefined {
	return expressionSlotValue(doc, ref);
}

/** Display only. Runtime and wire consumers read the tree directly. */
export function expressionDisplayText(
	expression: Expression | undefined,
	context: FormPrintContext,
): string | undefined {
	return expression === undefined
		? undefined
		: printFormExpression(expression, context).text;
}

const PROSE_SLOTS = FIELD_REFERENCE_SLOTS.filter(
	(entry) => entry.kind === "prose",
);

/** The canonical stored template behind a scalar prose slot. */
export function fieldProseTemplate(
	field: Field,
	slot: Exclude<FieldProseSlotId, "option_label">,
): ProseTemplate | undefined {
	const entry = PROSE_SLOTS.find((candidate) => candidate.slot === slot);
	if (entry === undefined) return undefined;
	const value = readSlotValues(field, entry.path)[0]?.value;
	return isProseTemplate(value) ? value : undefined;
}

/** Inspection projection; unresolved names remain visible as repair text. */
export function proseSource(
	field: Field,
	slot: Exclude<FieldProseSlotId, "option_label">,
	doc: ReferenceNamesDoc,
): string | undefined {
	const template = fieldProseTemplate(field, slot);
	return template === undefined
		? undefined
		: projectProseTemplate(template, doc).text;
}

export function proseSourceEntries(
	field: Field,
	slot: FieldProseSlotId,
	doc: ReferenceNamesDoc,
): SlotStringEntry[] {
	const entry = PROSE_SLOTS.find((candidate) => candidate.slot === slot);
	if (entry === undefined) return [];
	return readSlotValues(field, entry.path).flatMap(({ indices, value }) =>
		isProseTemplate(value)
			? [{ indices, text: projectProseTemplate(value, doc).text }]
			: [],
	);
}

export interface ProseRead {
	readonly slot: FieldProseSlotId;
	readonly text: string;
	readonly indices: readonly number[];
	readonly template: ProseTemplate;
}

/** Registered prose carriers applicable to this field kind, in member order. */
export function proseSurfaceReads(
	field: Field,
	doc: ReferenceNamesDoc,
): ProseRead[] {
	const reads: ProseRead[] = [];
	const repeatMode = field.kind === "repeat" ? field.repeat_mode : undefined;
	for (const entry of PROSE_SLOTS) {
		if (!fieldSlotApplies(entry, field.kind, repeatMode)) continue;
		for (const { indices, value } of readSlotValues(field, entry.path)) {
			if (!isProseTemplate(value)) continue;
			reads.push({
				slot: entry.slot,
				indices,
				template: value,
				text: projectProseTemplate(value, doc).text,
			});
		}
	}
	return reads;
}
