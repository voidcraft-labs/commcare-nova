"use client";

import { useMemo } from "react";
import { automationFormChoices } from "@/lib/automations/formChoices";
import { orderedAutomations } from "@/lib/domain";
import { useBlueprintDoc, useBlueprintDocShallow } from "./useBlueprintDoc";

/** Automation rows in their canonical blueprint display order. */
export function useAutomations() {
	return useBlueprintDocShallow((doc) => orderedAutomations(doc));
}

/** UUID-backed forms labelled by their published app > module > form path. */
export function useAutomationForms() {
	const appName = useBlueprintDoc((doc) => doc.appName);
	const modules = useBlueprintDoc((doc) => doc.modules);
	const forms = useBlueprintDoc((doc) => doc.forms);
	const moduleOrder = useBlueprintDoc((doc) => doc.moduleOrder);
	const formOrder = useBlueprintDoc((doc) => doc.formOrder);
	return useMemo(
		() =>
			automationFormChoices({
				appName,
				modules,
				forms,
				moduleOrder,
				formOrder,
			}),
		[appName, formOrder, forms, moduleOrder, modules],
	);
}
