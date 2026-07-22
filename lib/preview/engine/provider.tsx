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
 * Descendants access the controller via `useBuilderFormEngine()`. Direct
 * imports of `EngineController` are confined to this file and the
 * controller's own module — components never construct one themselves.
 *
 * Install timing matters: the doc store reference is bound on the
 * controller SYNCHRONOUSLY inside `useState`'s initializer, not in a
 * mount effect. React runs effects child-before-parent, so if the parent
 * (this provider) installed the doc store in `useEffect`, descendant
 * effects that call `controller.activateForm(...)` on first mount would
 * see `docStore === null`, silently no-op, and leave the form preview
 * with no runtime state. Binding inside `useState` avoids that race —
 * by the time any descendant renders, the controller is already wired.
 *
 * A follow-up `useEffect` keeps the binding fresh if the doc store
 * reference changes after mount (rare today since `buildId` changes
 * remount the entire provider tree, but defensive against future
 * refactors) and runs `deactivate()` cleanup on unmount.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { EngineController } from "./engineController";

// ── Context ─────────────────────────────────────────────────────────────

const BuilderFormEngineContext = createContext<EngineController | null>(null);

// ── Provider ────────────────────────────────────────────────────────────

/**
 * Wraps the builder subtree with a single long-lived `EngineController`.
 *
 * Expected placement: inside `BlueprintDocProvider` so the doc store is
 * reachable via context. The controller is created AND wired to the doc
 * store inside `useState`'s initializer so it's ready for descendant
 * effects on first render — see the module header for the race this
 * avoids. The follow-up effect re-syncs on doc-store identity change
 * and tears down the active form subscription on unmount.
 */
export function BuilderFormEngineProvider({
	children,
}: {
	children: ReactNode;
}) {
	const docStore = useContext(BlueprintDocContext);
	const reconcilerContext = useReconcilerContext();

	/* Create the controller AND bind the doc store synchronously on first
	 * render. Child effects (e.g. `useFormEngine.activateForm`) flush
	 * before parent effects, so any install we did in this component's
	 * own `useEffect` would land too late — descendants would already
	 * have called `activateForm` against an unwired controller. The
	 * `useState` initializer runs during render, before any descendant
	 * mounts, so the binding is in place before anyone needs it. */
	const [controller] = useState(() => {
		const c = new EngineController();
		if (docStore) c.setDocStore(docStore);
		return c;
	});

	/* Keep the doc store reference in sync if it changes after mount
	 * (rare — `buildId` changes today fully remount the provider tree,
	 * but explicit handling makes the contract resilient). On unmount we
	 * also deactivate any active form subscription and clear the
	 * reference so stray events can't fire against a destroyed store. */
	useEffect(() => {
		if (!docStore) return;
		controller.setDocStore(docStore);
		return () => {
			controller.deactivate();
			controller.setDocStore(null);
		};
	}, [controller, docStore]);

	/* A same-app Project move does not remount this long-lived controller.
	 * Deactivate synchronously at the reconciler's scope boundary so neither
	 * preloaded case rows nor entered form values can survive until React's
	 * epoch-driven reactivation. */
	useEffect(
		() =>
			reconcilerContext?.subscribeProjectScopeReset(() => {
				controller.deactivate();
			}),
		[controller, reconcilerContext],
	);

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
 * for a specific field should use `useEngineState(uuid)` from
 * `hooks/useEngineState.ts`.
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
