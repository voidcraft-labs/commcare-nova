/**
 * Return the app's case types, with `null` normalized to an empty array.
 *
 * The doc stores `CaseType[] | null` — `null` means "no case types
 * defined for this app." Consumers uniformly want a `CaseType[]` so they
 * can iterate or `.find()` without optional-chaining boilerplate. This
 * hook is the single point of null-to-[] conversion.
 *
 * The `EMPTY` constant ensures the selector returns a referentially stable
 * value when `caseTypes` is null — without it, `?? []` would create a new
 * array literal on every call, defeating `Object.is` memoization.
 */

"use client";

import {
	type CasePropertyDataType,
	type CaseType,
	effectiveCaseTypes,
	materializableCaseTypes,
	propertyAgreedType,
} from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

const EMPTY: readonly CaseType[] = [];

export function useCaseTypes(): CaseType[] {
	return useBlueprintDoc((s) => s.caseTypes ?? (EMPTY as CaseType[]));
}

/**
 * The EFFECTIVE case-type view (`lib/domain/effectiveCaseTypes.ts`) —
 * declared annotations with writer-derived `data_type`s filled, plus
 * the standard + writer-derived properties. The case-list workspace
 * reads THIS view for its verdicts, pickers, and editor type
 * contexts, because the commit gate's validator resolves properties
 * against the same function — one admission set, so the two can't
 * disagree about whether a column is broken.
 *
 * Referential stability rides the domain memo: `effectiveCaseTypes`
 * caches per doc reference, and the store replaces the doc reference
 * on every mutation, so `Object.is` sees one stable array per doc
 * state.
 */
export function useEffectiveCaseTypes(): readonly CaseType[] {
	return useBlueprintDoc((s) => effectiveCaseTypes(s));
}

/**
 * The type a property's values can be: its declaration, else the one its
 * writers agree on (`lib/domain/startingValueFit.ts::propertyAgreedType`,
 * the reading the "Saves to" planner judges a starting value by); undefined
 * where nothing types it. Memoized per doc through the inference fixpoint.
 */
export function usePropertyAgreedType(
	caseType: string | undefined,
	property: string | undefined,
): CasePropertyDataType | undefined {
	return useBlueprintDoc((s) =>
		caseType === undefined || property === undefined
			? undefined
			: propertyAgreedType(s, caseType, property),
	);
}

/**
 * The MATERIALIZABLE flavor — the effective view minus the implicit
 * standard entries; exactly what the stored `case_type_schemas` row
 * (and so AJV insert validation) is derived from. Anything that
 * GENERATES case-row payloads (sample data) must consume this view:
 * a generator fed the standard-inflated view writes keys like
 * `date_opened` into the JSONB document, which the stored schema's
 * `additionalProperties: false` rejects wholesale.
 */
export function useMaterializableCaseTypes(): readonly CaseType[] {
	return useBlueprintDoc((s) => materializableCaseTypes(s));
}
