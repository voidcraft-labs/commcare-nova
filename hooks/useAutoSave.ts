/**
 * useAutoSave — leading+trailing throttle for Firestore persistence.
 *
 * Subscribes to entity map changes via Zustand's subscribeWithSelector.
 * On the first mutation after a quiet period, saves immediately (leading edge).
 * Mutations that arrive while a save is in-flight or during the post-save
 * cooldown are batched — a single trailing save fires once the cooldown
 * expires. This means "Saving..." only appears when a fetch is actually
 * in-flight (~300ms), not during an artificial debounce window.
 *
 * Only active when: (a) an appId exists, (b) the builder has entity
 * data, and (c) phase is Ready. Auth is guaranteed by the server layout.
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
import { useEffect, useRef, useState } from "react";
import { shallow } from "zustand/shallow";
import { reportClientError } from "@/lib/clientErrorReporter";
import type { BuilderEngine } from "@/lib/services/builderEngine";
import {
	assembleBlueprint,
	getEntityData,
} from "@/lib/services/normalizedState";

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
 * Auto-save hook — persists blueprint edits to Firestore via API route.
 *
 * Auth is guaranteed by the server layout (`requireAuth` in
 * `app/build/layout.tsx`) — no client-side auth check needed.
 */
export function useAutoSave(builder: BuilderEngine): SaveState {
	const [state, setState] = useState<SaveState>(IDLE_STATE);

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
	const currentAppId = builder.store.getState().appId;
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

	/* Single long-lived subscription — subscribes to entity map changes.
	 * Entity reference checks via shallow equality are the watermark — if no
	 * entity map changed reference, the subscriber doesn't fire. */
	useEffect(() => {
		unmountedRef.current = false;

		/**
		 * Fire the actual Firestore PUT and transition status honestly:
		 * saving → saved/error. Starts a cooldown timer after completion
		 * so the trailing edge can fire if mutations arrived mid-flight.
		 */
		async function executeSave() {
			const s = builder.store.getState();
			const pid = s.appId;
			if (!pid || s.moduleOrder.length === 0) return;

			/* Assemble the wire-format blueprint for persistence */
			const bp = assembleBlueprint(getEntityData(s));

			inFlightRef.current = true;
			if (!unmountedRef.current) {
				setState((prev) => ({ ...prev, status: "saving" }));
			}

			try {
				const res = await fetch(`/api/apps/${pid}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ blueprint: bp }),
				});
				if (unmountedRef.current) return;
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
					setState((prev) => ({ ...prev, status: "error" }));
				}
			} catch (err) {
				if (!unmountedRef.current) {
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

		/* Subscribe to entity data changes — fires only when an entity map
		 * or ordering array changes reference (Immer structural sharing). */
		const unsub = builder.store.subscribe(
			(s) => ({
				modules: s.modules,
				forms: s.forms,
				questions: s.questions,
				moduleOrder: s.moduleOrder,
				formOrder: s.formOrder,
				questionOrder: s.questionOrder,
				appName: s.appName,
				connectType: s.connectType,
				caseTypes: s.caseTypes,
			}),
			() => {
				/* Gate on phase and app existence — read live from the store. */
				if (!builder.isReady) return;
				const snap = builder.store.getState();
				if (!snap.appId || snap.moduleOrder.length === 0) return;

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
	}, [builder]);

	return state;
}
