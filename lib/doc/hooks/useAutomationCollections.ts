"use client";

import { orderedAutomations } from "@/lib/domain";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/** Automation rows in their canonical blueprint display order. */
export function useAutomations() {
	return useBlueprintDocShallow((doc) => orderedAutomations(doc));
}

/** Forms an automation content event may reference, in stable record order. */
export function useAutomationForms() {
	return useBlueprintDocShallow((doc) => Object.values(doc.forms));
}
