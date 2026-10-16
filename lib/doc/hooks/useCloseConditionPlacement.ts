/**
 * Named hook: where a close form's close is written, CommCare HQ's close
 * action or a Save to Case close in the form's source
 * (`lib/domain/closeCondition.ts::closeConditionPlacement`). The placement is
 * derived from the document and a string, so the subscription re-renders only
 * when it changes.
 */

"use client";

import { closeConditionPlacement, type Uuid } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useCloseConditionPlacement(formUuid: Uuid) {
	return useBlueprintDoc((doc) => closeConditionPlacement(doc, formUuid));
}
