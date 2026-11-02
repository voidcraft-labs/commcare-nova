/**
 * Named hook: what a Hidden Value with no value saves, for one whose answer a
 * case operation saves (`lib/domain/casePreload.ts::hiddenWriterBlankNote`,
 * the one sentence the builder and the tools share). The selector returns a
 * string or `undefined`, so an edit that changes neither the field nor its
 * writes does not re-render the control that shows it.
 */

"use client";

import { hiddenWriterBlankNote } from "@/lib/domain";
import type { Uuid } from "../types";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useHiddenWriterBlankNote(fieldUuid: Uuid): string | undefined {
	return useBlueprintDoc((doc) => hiddenWriterBlankNote(doc, fieldUuid));
}
