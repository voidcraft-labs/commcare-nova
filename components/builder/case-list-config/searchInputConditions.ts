// components/builder/case-list-config/searchInputConditions.ts
//
// One read and one write per Search-condition slot, so the center canvas can
// edit a field's custom match, required condition, or check rule through a
// single pair of functions. The read returns `undefined` when the field has
// no condition in that slot (a simple-arm field has no custom match; a field
// that is optional has no required condition), which is also the canvas's cue
// that another editor removed it while it was open.

import type { SearchInputDef } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { SearchConditionSlot } from "./workspaceSelection";

/** The predicate a field carries in `slot`, if any. */
export function searchInputConditionAt(
	input: SearchInputDef,
	slot: SearchConditionSlot,
): Predicate | undefined {
	if (input.kind === "hidden") return undefined;
	switch (slot) {
		case "match":
			return input.kind === "advanced" ? input.predicate : undefined;
		case "required":
			return input.required?.when;
		case "validation":
			return input.validation?.rule;
	}
}

/**
 * The same field with `slot` replaced by `predicate`. Only a field that
 * already carries a condition in that slot is rewritten; the canvas never
 * opens on a slot that is empty, so any other shape returns the field as is.
 */
export function withSearchInputCondition(
	input: SearchInputDef,
	slot: SearchConditionSlot,
	predicate: Predicate,
): SearchInputDef {
	if (input.kind === "hidden") return input;
	switch (slot) {
		case "match":
			return input.kind === "advanced" ? { ...input, predicate } : input;
		case "required":
			return input.required?.when === undefined
				? input
				: { ...input, required: { ...input.required, when: predicate } };
		case "validation":
			return input.validation === undefined
				? input
				: { ...input, validation: { ...input.validation, rule: predicate } };
	}
}
