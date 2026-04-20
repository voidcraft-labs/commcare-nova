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

import type { CaseType } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

const EMPTY: readonly CaseType[] = [];

export function useCaseTypes(): CaseType[] {
	return useBlueprintDoc((s) => s.caseTypes ?? (EMPTY as CaseType[]));
}
