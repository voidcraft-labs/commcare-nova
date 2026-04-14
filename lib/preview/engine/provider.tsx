/**
 * BuilderFormEngineProvider — scoped context for the preview EngineController.
 *
 * The EngineController is a plain class that owns the form preview's
 * runtime store (computed visibility, validation, test-mode values) and
 * the blueprint subscriptions that keep it in sync with the doc store.
 * Its lifecycle matches the builder session, not any specific component —
 * so it lives in a context at the provider-stack level rather than in a
 * per-component hook.
 *
 * This provider replaces the `engineController` field that used to live
 * on `BuilderEngine`. Consumers now read it via `useBuilderFormEngine()`
 * instead of `useBuilderEngine().engineController`.
 *
 * The doc store is installed on the controller via a useEffect once both
 * are mounted; teardown deactivates the controller so any in-flight form
 * subscriptions are cleaned up. The controller instance itself is created
 * lazily in `useState` so it's stable for the lifetime of the provider.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { EngineController } from "./engineController";

// ── Context ─────────────────────────────────────────────────────────────

const BuilderFormEngineContext = createContext<EngineController | null>(null);

// ── Provider ────────────────────────────────────────────────────────────

/**
 * Wraps the builder subtree with a single long-lived `EngineController`.
 *
 * Expected placement: inside `BlueprintDocProvider` so the doc store is
 * reachable via context. The controller itself is stable across renders —
 * `useState(() => new EngineController())` ensures a single instance per
 * mount — and the effect installs or clears the doc store reference
 * whenever the provider context changes.
 */
export function BuilderFormEngineProvider({
	children,
}: {
	children: ReactNode;
}) {
	const [controller] = useState(() => new EngineController());
	const docStore = useContext(BlueprintDocContext);

	useEffect(() => {
		if (!docStore) return;
		controller.setDocStore(docStore);
		/* Cleanup: deactivate any active form subscription and clear the doc
		 * store reference. Matches the old SyncBridge teardown path. */
		return () => {
			controller.deactivate();
			controller.setDocStore(null);
		};
	}, [controller, docStore]);

	return (
		<BuilderFormEngineContext value={controller}>
			{children}
		</BuilderFormEngineContext>
	);
}

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Imperative access to the form preview's EngineController. Does NOT
 * subscribe to any state — callers that want to observe runtime state
 * for a specific question should use `useEngineState(uuid)` from
 * `hooks/useFormEngine.ts`.
 *
 * Throws when used outside `BuilderFormEngineProvider` to surface
 * provider-order bugs immediately during development.
 */
export function useBuilderFormEngine(): EngineController {
	const ctx = useContext(BuilderFormEngineContext);
	if (!ctx) {
		throw new Error(
			"useBuilderFormEngine must be used within a BuilderFormEngineProvider",
		);
	}
	return ctx;
}
