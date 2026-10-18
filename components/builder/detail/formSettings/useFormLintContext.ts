"use client";

import { useFormExpressionLintContext } from "@/lib/doc/hooks/useXPathSlots";
import type { FormExpressionSlotRef } from "@/lib/domain/expression/types";

export function useFormLintContext(slot: FormExpressionSlotRef) {
	return useFormExpressionLintContext(slot);
}
