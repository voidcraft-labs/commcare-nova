/**
 * useFormEngine — thin React wrapper around the EngineController.
 *
 * The EngineController (plain class on BuilderEngine) owns the computation
 * engine, blueprint store subscriptions, and the UUID-keyed runtime store.
 * This hook just activates/deactivates the controller when the form screen
 * mounts/unmounts, and provides the runtime store to descendant components
 * via context.
 *
 * Components read runtime state via `useEngineState(uuid)` — a Zustand
 * selector on the controller's store. Only questions whose computed state
 * actually changed re-render.
 */
"use client";
import { createContext, useContext, useEffect } from "react";
import { useStore } from "zustand";
import { useBuilderEngine } from "@/hooks/useBuilder";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { RuntimeStoreState } from "@/lib/preview/engine/engineController";
import {
	DEFAULT_RUNTIME_STATE,
	type EngineController,
} from "@/lib/preview/engine/engineController";
import type { QuestionState } from "@/lib/preview/engine/types";

// ── Context ─────────────────────────────────────────────────────────────

/**
 * Provides the EngineController to descendant components. The controller
 * reference is stable (lives on BuilderEngine), so context consumers don't
 * re-render from context value changes.
 */
export const EngineControllerContext = createContext<EngineController | null>(
	null,
);

/**
 * Read the EngineController from context. Throws if outside a provider.
 * Use `useEngineState(uuid)` for reactive runtime state subscriptions.
 */
export function useEngineController(): EngineController {
	const controller = useContext(EngineControllerContext);
	if (!controller)
		throw new Error(
			"useEngineController must be used within EngineControllerContext",
		);
	return controller;
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
 * The controller's blueprint store subscriptions (expression fingerprint,
 * question order, form metadata) are set up during `activateForm` and
 * cleaned up by `deactivate` on unmount or form navigation.
 */
export function useFormEngine(
	moduleIndex: number,
	formIndex: number,
	caseData?: Map<string, string>,
): EngineController {
	const builderEngine = useBuilderEngine();
	const controller = builderEngine.engineController;

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
