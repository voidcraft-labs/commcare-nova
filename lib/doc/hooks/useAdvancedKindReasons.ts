/**
 * Named hook: the line module settings' **In CommCare HQ** row reads for one
 * menu, why CommCare HQ receives it as an advanced menu
 * (`moduleKindMoves.ts::moduleAdvancedKindLine`, over the first reason
 * `lib/commcare/moduleKind.ts::advancedKindReasons` gives). Undefined where
 * the menu is emitted ordinary. The line is a string, so the subscription
 * compares it by value and an edit that leaves the first reason, its form's
 * name and its case type alone does not re-render the row.
 */

"use client";

import { moduleAdvancedKindLine } from "../moduleKindMoves";
import type { Uuid } from "../types";
import { useBlueprintDocEq } from "./useBlueprintDoc";

export function useAdvancedKindLine(moduleUuid: Uuid): string | undefined {
	return useBlueprintDocEq(
		(doc) => moduleAdvancedKindLine(doc, moduleUuid),
		Object.is,
	);
}
