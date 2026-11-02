/**
 * Named hook: a question's "Saves to", the writes of its form's case
 * operations that save its answer (`fieldCaseWriteViews`, read through the
 * reference index). The views are derived once per document object, and the
 * subscription compares them by each view's primitive key, so an edit that
 * changes none of the field's writes does not re-render the rail.
 */

"use client";

import { type FieldCaseWriteView, fieldCaseWriteViews } from "@/lib/domain";
import type { Uuid } from "../types";
import { useBlueprintDocEq } from "./useBlueprintDoc";

const NO_VIEWS: readonly FieldCaseWriteView[] = [];

/** One view's identity and content as one string. */
export function fieldCaseWriteViewKeyString(view: FieldCaseWriteView): string {
	return JSON.stringify([
		view.formUuid,
		view.operationUuid,
		view.slot,
		view.caseType,
		view.property,
		view.via ?? null,
		view.onlyIfChanged,
		view.link,
		view.destination,
	]);
}

/** Whether two view lists say the same thing, view by view. */
export function sameFieldCaseWriteViews(
	a: readonly FieldCaseWriteView[],
	b: readonly FieldCaseWriteView[],
): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every(
		(view, index) =>
			fieldCaseWriteViewKeyString(view) ===
			fieldCaseWriteViewKeyString(b[index]),
	);
}

export function useFieldCaseWrites(
	fieldUuid: Uuid | undefined,
): readonly FieldCaseWriteView[] {
	return useBlueprintDocEq(
		(doc) =>
			fieldUuid === undefined ? NO_VIEWS : fieldCaseWriteViews(doc, fieldUuid),
		sameFieldCaseWriteViews,
	);
}
