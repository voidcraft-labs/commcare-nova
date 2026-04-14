/**
 * useFormEngine — thin React wrapper around the EngineController.
 *
 * The EngineController owns the form preview's computation engine, doc
 * store subscriptions, and the UUID-keyed runtime store. Its instance
 * comes from `BuilderFormEngineProvider` (see `lib/preview/engine/provider`)
 * — a single controller per builder session, not per form.
 *
 * `useFormEngine` just activates / deactivates the controller when a
 * form screen mounts or unmounts, and provides the runtime store to
 * descendant components via Zustand's `useStore` helper.
 *
 * Components read per-question runtime state via `useEngineState(uuid)` —
 * a Zustand selector on the controller's store. Only questions whose
 * computed state actually changed re-render.
 */
"use client";
import { useEffect } from "react";
import { useStore } from "zustand";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { RuntimeStoreState } from "@/lib/preview/engine/engineController";
import {
	DEFAULT_RUNTIME_STATE,
	type EngineController,
} from "@/lib/preview/engine/engineController";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import type { QuestionState } from "@/lib/preview/engine/types";

// ── Controller access ───────────────────────────────────────────────────

/**
 * Read the current EngineController from `BuilderFormEngineProvider`.
 *
 * Re-exported here so form-level call sites don't need to know the
 * provider lives under `lib/preview/engine/provider` — they import from
 * `hooks/useFormEngine` like before Phase 3.
 */
export function useEngineController(): EngineController {
	return useBuilderFormEngine();
}

/**
 * Subscribe to runtime state for a specific question by UUID.
 *
 * Delegates to Zustand's `useStore` with a UUID-based selector on the
 * controller's runtime store. Zustand compares by reference — unchanged
 * UUIDs keep their old RuntimeState object and skip re-rendering.
 *
 * Editing question A only re-renders SortableQuestion(A). SortableQuestion(B)
 * keeps the same state reference and skips.
 */
export function useEngineState(uuid: string): QuestionState {
	const controller = useEngineController();
	return useStore(
		controller.store,
		(s: RuntimeStoreState) => s[uuid] ?? DEFAULT_RUNTIME_STATE,
	);
}

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Activate the engine controller for the given form. Returns the controller
 * for imperative access (setValue, touch, validateAll, etc.).
 *
 * The controller's doc store subscriptions (expression fingerprint,
 * question order, form metadata) are set up during `activateForm` and
 * cleaned up by `deactivate` on unmount or form navigation.
 */
export function useFormEngine(
	moduleIndex: number,
	formIndex: number,
	caseData?: Map<string, string>,
): EngineController {
	const controller = useBuilderFormEngine();

	/** Reactive formId subscription — when the form identity at these indices
	 *  changes (e.g., form deleted and another takes its index), the effect
	 *  re-runs and reactivates the controller with the new form. Reads from
	 *  the BlueprintDoc store, the single source of truth for entity data. */
	const formId = useBlueprintDoc((s) => {
		const moduleId = s.moduleOrder[moduleIndex];
		return moduleId ? s.formOrder[moduleId]?.[formIndex] : undefined;
	});

	useEffect(() => {
		if (!formId) return;
		controller.activateForm(moduleIndex, formIndex, caseData);
		return () => controller.deactivate();
	}, [controller, moduleIndex, formIndex, formId, caseData]);

	return controller;
}
