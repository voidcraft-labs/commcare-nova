"use client";

import { useExpressionEditorContext } from "@/lib/doc/hooks/useXPathSlots";
import type { FormExpressionSlotRef } from "@/lib/domain/expression/types";

/** The form slot's editor context: lint, completion and chips read it. */
export function useFormLintContext(slot: FormExpressionSlotRef) {
	return useExpressionEditorContext(slot);
}
