/**
 * useFormEngine — activate the form preview's engine for a given form.
 *
 * Calls `controller.activateForm(formUuid, caseData)` on mount and
 * `controller.deactivate()` on unmount (or when the form UUID changes).
 * The controller itself comes from `BuilderFormEngineProvider`, so this
 * hook only owns the per-screen lifecycle: wiring the doc store
 * subscriptions (expression fingerprint, field order, form metadata)
 * that back per-field runtime state for the active form.
 *
 * Pass `undefined` for `formUuid` while the URL is still being parsed —
 * the effect no-ops until a real UUID arrives. The controller is
 * returned for imperative access (`setValue`, `touch`, `validateAll`)
 * by the form screen.
 */
"use client";
import { useEffect } from "react";
import type { Uuid } from "@/lib/doc/types";
import type { EngineController } from "@/lib/preview/engine/engineController";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";

export function useFormEngine(
	formUuid: Uuid | undefined,
	caseData?: Map<string, string>,
): EngineController {
	const controller = useBuilderFormEngine();

	useEffect(() => {
		if (!formUuid) return;
		controller.activateForm(formUuid, caseData);
		return () => controller.deactivate();
	}, [controller, formUuid, caseData]);

	return controller;
}
