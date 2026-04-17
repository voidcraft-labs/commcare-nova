/**
 * useAutoSave — leading+trailing throttle for Firestore persistence.
 *
 * Subscribes to the BlueprintDoc store's entity map references. On the first
 * mutation after a quiet period, saves immediately (leading edge). Mutations
 * that arrive while a save is in-flight or during the post-save cooldown are
 * batched — a single trailing save fires once the cooldown expires. This means
 * "Saving..." only appears when a fetch is actually in-flight (~300ms), not
 * during an artificial debounce window.
 *
 * Only active when: (a) an appId exists (from the legacy session store),
 * (b) the doc has entities, and (c) phase is Ready. Auth is guaranteed by
 * the server layout.
 *
 * Returns a SaveState with the current status and the timestamp of the last
 * successful save. The SaveIndicator uses `savedAt` to display a persistent
 * relative timestamp ("Saved 2m ago") so the user always knows when their
 * work was last persisted.
 *
 * Entity reference changes are the watermark — if no entity map changed
 * reference (Immer structural sharing), the subscriber doesn't fire.
 * No mutationCount needed.
 */
"use client";
import { useContext, useEffect, useRef, useState } from "react";
import { shallow } from "zustand/shallow";
import { reportClientError } from "@/lib/clientErrorReporter";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { BuilderPhase } from "@/lib/services/builder";
import { derivePhase } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";

/** Post-save cooldown before the trailing edge can fire (ms). */
const COOLDOWN_MS = 1000;

/**
 * Save lifecycle states — drives the subheader indicator.
 * - `idle`: no saves have occurred this session, nothing to show
 * - `saving`: PUT request in-flight
 * - `saved`: last save succeeded — `savedAt` carries the timestamp
 * - `error`: last save failed
 */
export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface SaveState {
	status: SaveStatus;
	/** Epoch ms of the last successful save — null until the first save. */
	savedAt: number | null;
}

const IDLE_STATE: SaveState = { status: "idle", savedAt: null };

/**
 * Project the doc slice that matters for save equality checks.
 *
 * A new reference on any of these fields implies at least one user-visible
 * mutation has landed. Fields excluded from the projection (e.g. `fieldParent`,
 * which is derived and never mutated directly) don't trigger unnecessary saves.
 */
function projectSaveSlice(s: BlueprintDoc) {
	return {
		modules: s.modules,
		forms: s.forms,
		fields: s.fields,
		moduleOrder: s.moduleOrder,
		formOrder: s.formOrder,
		fieldOrder: s.fieldOrder,
		appName: s.appName,
		connectType: s.connectType,
		caseTypes: s.caseTypes,
	};
}

/**
 * Auto-save hook — persists blueprint edits to Firestore via API route.
 *
 * Auth is guaranteed by the server layout (`requireAuth` in
 * `app/build/layout.tsx`) — no client-side auth check needed.
 *
 * Reads the session store handle via `BuilderSessionContext` — the hook
 * gates saving on `appId` + derived phase (Ready/Completed). The doc
 * store is read from context for subscription + blueprint assembly.
 */
export function useAutoSave(): SaveState {
	const [state, setState] = useState<SaveState>(IDLE_STATE);

	/* The doc store owns blueprint entity data — the session store's `appId`
	 * and lifecycle flags gate whether saving is enabled. */
	const docStore = useContext(BlueprintDocContext);
	const sessionApi = useContext(BuilderSessionContext);

	/* Throttle state — all mutable, read/written inside the subscription
	 * callback and cleanup. Never triggers re-renders. */
	const inFlightRef = useRef(false);
	const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const pendingTrailingRef = useRef(false);
	const unmountedRef = useRef(false);

	/* Reset state when the app changes — new app means a fresh save state
	 * and no pending/in-flight state from the old app. Uses React's "derive
	 * state from props" pattern. */
	const currentAppId = sessionApi?.getState().appId;
	const prevAppIdRef = useRef(currentAppId);
	if (prevAppIdRef.current !== currentAppId) {
		prevAppIdRef.current = currentAppId;
		inFlightRef.current = false;
		if (cooldownTimerRef.current) {
			clearTimeout(cooldownTimerRef.current);
			cooldownTimerRef.current = undefined;
		}
		pendingTrailingRef.current = false;
		setState(IDLE_STATE);
	}

	/* Single long-lived subscription — subscribes to doc entity map changes.
	 * Entity reference checks via shallow equality are the watermark — if no
	 * entity map changed reference, the subscriber doesn't fire. */
	useEffect(() => {
		if (!docStore || !sessionApi) return;
		/* Capture the narrowed non-null reference so nested closures
		 * can read it without non-null assertions (TypeScript loses
		 * the guard narrowing inside closures). */
		const session = sessionApi;
		unmountedRef.current = false;

		/**
		 * Fire the actual Firestore PUT and transition status honestly:
		 * saving → saved/error. Starts a cooldown timer after completion
		 * so the trailing edge can fire if mutations arrived mid-flight.
		 *
		 * The `appId` is captured at save-start; every state transition
		 * re-checks the current `appId` and bails if it has changed. This
		 * prevents an in-flight save for app A from resolving after the
		 * user switches to app B and marking the new app as "Saved" — or
		 * marking it as "error" — for a save that didn't belong to it.
		 */
		async function executeSave() {
			if (!docStore) return;
			const appIdAtStart = session.getState().appId;
			const doc = docStore.getState();
			if (!appIdAtStart || doc.moduleOrder.length === 0) return;

			/* Strip the derived fieldParent before sending — the server rebuilds it
			 * from fieldOrder on load and should not store it. */
			const { fieldParent: _fp, ...persistable } = doc;

			inFlightRef.current = true;
			if (!unmountedRef.current) {
				setState((prev) => ({ ...prev, status: "saving" }));
			}

			/** True iff the current store still belongs to the app we
			 *  started saving. If false, the user navigated to a different
			 *  app while the request was in flight — discard the result. */
			const stillCurrent = () =>
				session.getState().appId === appIdAtStart && !unmountedRef.current;

			try {
				const res = await fetch(`/api/apps/${appIdAtStart}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					// Send under the `blueprint` key so the API route's body parsing
					// stays consistent. The value is now a normalized BlueprintDoc
					// (minus fieldParent) rather than the legacy nested AppBlueprint.
					body: JSON.stringify({ blueprint: persistable }),
				});
				if (!stillCurrent()) return;
				if (res.ok) {
					setState({ status: "saved", savedAt: Date.now() });
				} else {
					let detail = `HTTP ${res.status}`;
					try {
						const body = await res.json();
						if (typeof body?.error === "string") detail += `: ${body.error}`;
					} catch {
						/* body unreadable — status code alone is still useful */
					}

					reportClientError({
						message: `Auto-save failed — ${detail}`,
						source: "manual",
						url: window.location.href,
					});
					if (stillCurrent()) {
						setState((prev) => ({ ...prev, status: "error" }));
					}
				}
			} catch (err) {
				if (stillCurrent()) {
					reportClientError({
						message: `Auto-save network error: ${err instanceof Error ? err.message : String(err)}`,
						stack: err instanceof Error ? err.stack : undefined,
						source: "manual",
						url: window.location.href,
					});
					setState((prev) => ({ ...prev, status: "error" }));
				}
			} finally {
				inFlightRef.current = false;
				/* Cooldown is local to this hook instance; safe to start
				 * even on a stale save because the next leading-edge call
				 * still queues correctly via pendingTrailingRef. */
				if (!unmountedRef.current) startCooldown();
			}
		}

		/**
		 * After a save completes (success or error), pause before allowing
		 * the next save. If mutations arrived during the in-flight save or
		 * this cooldown, the trailing edge fires once the timer expires.
		 */
		function startCooldown() {
			cooldownTimerRef.current = setTimeout(() => {
				cooldownTimerRef.current = undefined;
				if (pendingTrailingRef.current) {
					pendingTrailingRef.current = false;
					executeSave();
				}
			}, COOLDOWN_MS);
		}

		/* Subscribe to doc entity map changes — fires only when a map gets a
		 * new Immer reference. Shallow equality on the projected slice short-
		 * circuits unrelated doc updates (e.g. appId bookkeeping). */
		const unsub = docStore.subscribe(
			projectSaveSlice,
			() => {
				/* Gate on lifecycle phase and app existence. Derive the builder
				 * phase from session state + doc presence — only save when the
				 * builder is in Ready or Completed (i.e. the user has a usable
				 * blueprint and no initial generation is in progress). */
				const sessionState = session.getState();
				const docSnap = docStore.getState();
				const docHasData = docSnap.moduleOrder.length > 0;
				const phase = derivePhase(sessionState, docHasData);
				if (phase !== BuilderPhase.Ready && phase !== BuilderPhase.Completed)
					return;
				const pid = sessionState.appId;
				if (!pid || docSnap.moduleOrder.length === 0) return;

				/* Save is in-flight — queue for trailing edge after completion. */
				if (inFlightRef.current) {
					pendingTrailingRef.current = true;
					return;
				}

				/* Cooldown active — queue for trailing edge when it expires. */
				if (cooldownTimerRef.current) {
					pendingTrailingRef.current = true;
					return;
				}

				/* No save in-flight, no cooldown → leading edge: save immediately. */
				executeSave();
			},
			{ equalityFn: shallow },
		);

		return () => {
			unmountedRef.current = true;
			unsub();
			if (cooldownTimerRef.current) {
				clearTimeout(cooldownTimerRef.current);
				cooldownTimerRef.current = undefined;
			}
			pendingTrailingRef.current = false;
		};
	}, [sessionApi, docStore]);

	return state;
}
