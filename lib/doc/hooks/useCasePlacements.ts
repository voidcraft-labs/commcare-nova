/**
 * Named hook: where CommCare HQ keeps each of one form's case changes, the
 * form's placement view (`casePlacements.ts::formCasePlacementView`, derived
 * once per document object). The subscription compares the view by its
 * primitive key, so an edit that moves no placement of this form does not
 * re-render the sections that read it.
 */

"use client";

import {
	type FormCasePlacementView,
	formCasePlacementView,
} from "../casePlacements";
import type { Uuid } from "../types";
import { useBlueprintDocEq } from "./useBlueprintDoc";

const keys = new WeakMap<FormCasePlacementView, string>();

/** The view as one string, computed once per view object. */
export function casePlacementViewKey(view: FormCasePlacementView): string {
	const cached = keys.get(view);
	if (cached !== undefined) return cached;
	const key = JSON.stringify(view);
	keys.set(view, key);
	return key;
}

export function useCasePlacements(formUuid: Uuid): FormCasePlacementView {
	return useBlueprintDocEq(
		(doc) => formCasePlacementView(doc, formUuid),
		(a, b) => a === b || casePlacementViewKey(a) === casePlacementViewKey(b),
	);
}
