"use client";

import type { Uuid } from "@/lib/domain";
import { formIsSectioned } from "@/lib/domain/fieldForm";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** A submitted activity may precede the first worker page. */
export function useFormIsSectioned(formUuid: Uuid | undefined): boolean {
	return useBlueprintDoc(
		(doc) => formUuid !== undefined && formIsSectioned(doc, formUuid),
	);
}
