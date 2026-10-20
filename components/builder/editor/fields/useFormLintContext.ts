"use client";

import { useExpressionEditorContext } from "@/lib/doc/hooks/useXPathSlots";
import type { FieldExpressionSlotRef } from "@/lib/domain/expression/types";

/** The field's exact slot determines its expected value and form node. */
export function useFormLintContext(slot: FieldExpressionSlotRef) {
	return useExpressionEditorContext(slot);
}
