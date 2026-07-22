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
import type { CaseDataByType } from "@/lib/preview/engine/formEngine";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import { useAccessPhase, useProjectScopeEpoch } from "@/lib/session/hooks";

export function useFormEngine(
	formUuid: Uuid | undefined,
	caseData?: CaseDataByType,
): EngineController {
	const controller = useBuilderFormEngine();
	const scopeEpoch = useProjectScopeEpoch();
	const accessPhase = useAccessPhase();

	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeEpoch deliberately tears down and rebuilds per-Project engine subscriptions
	useEffect(() => {
		if (!formUuid || accessPhase !== "authorized") {
			controller.deactivate();
			return;
		}
		controller.activateForm(formUuid, caseData);
		return () => controller.deactivate();
	}, [controller, formUuid, caseData, scopeEpoch, accessPhase]);

	return controller;
}
