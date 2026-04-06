/**
 * useAutoSave — leading+trailing throttle for Firestore persistence.
 *
 * Subscribes to blueprint mutations via builder.subscribeMutation. On the
 * first mutation after a quiet period, saves immediately (leading edge).
 * Mutations that arrive while a save is in-flight or during the post-save
 * cooldown are batched — a single trailing save fires once the cooldown
 * expires. This means "Saving…" only appears when a fetch is actually
 * in-flight (~300ms), not during an artificial debounce window.
 *
 * Only active when: (a) user is authenticated, (b) an appId exists,
 * (c) the builder has a blueprint, and (d) phase is Ready.
 *
 * Returns a SaveState with the current status and the timestamp of the last
 * successful save. The SaveIndicator uses `savedAt` to display a persistent
 * relative timestamp ("Saved 2m ago") so the user always knows when their
 * work was last persisted.
 *
 * Tracks builder.mutationCount to avoid unnecessary Firestore writes —
 * subscribeMutation fires on selection changes too, but mutationCount only
 * increments on actual blueprint mutations. Since Firestore charges per
 * write regardless of data changes, this distinction matters.
 *
 * All builder state is read live inside the subscribeMutation callback
 * (not captured from the render scope) to avoid stale closures — the builder
 * is a stable singleton so direct property access is always current.
 */
"use client";
import { useEffect, useRef, useState } from "react";
import { reportClientError } from "@/lib/clientErrorReporter";
import type { Builder } from "@/lib/services/builder";

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

export function useAutoSave(
	builder: Builder,
	isAuthenticated: boolean,
): SaveState {
	const [state, setState] = useState<SaveState>(IDLE_STATE);

	/** The mutationCount at the time of the last successful save. When this
	 *  matches the current builder.mutationCount, there's nothing new to persist. */
	const lastSavedMutationRef = useRef(builder.mutationCount);

	/* Track the current auth state in a ref so the subscription callback
	 * always reads the latest value without needing to re-subscribe. */
	const authRef = useRef(isAuthenticated);
	authRef.current = isAuthenticated;

	/* Throttle state — all mutable, read/written inside the subscription
	 * callback and cleanup. Never triggers re-renders. */
	const inFlightRef = useRef(false);
	const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const pendingTrailingRef = useRef(false);
	const unmountedRef = useRef(false);

	/* Reset state when the app changes — new app means a fresh save watermark
	 * and no pending/in-flight state from the old app. Uses React's "derive
	 * state from props" pattern: detect the change during render so the effect
	 * doesn't reference mutationCount (which would cause a reset on every
	 * mutation). clearTimeout is idempotent so safe in render. */
	const prevAppIdRef = useRef(builder.appId);
	if (prevAppIdRef.current !== builder.appId) {
		prevAppIdRef.current = builder.appId;
		lastSavedMutationRef.current = builder.mutationCount;
		inFlightRef.current = false;
		if (cooldownTimerRef.current) {
			clearTimeout(cooldownTimerRef.current);
			cooldownTimerRef.current = undefined;
		}
		pendingTrailingRef.current = false;
		setState(IDLE_STATE);
	}

	/* Single long-lived subscription — reads all state live from the builder
	 * singleton inside the callback to avoid stale closure issues. The effect
	 * only re-runs if the builder instance itself changes. */
	useEffect(() => {
		unmountedRef.current = false;

		/**
		 * Fire the actual Firestore PUT and transition status honestly:
		 * saving → saved/error. Starts a cooldown timer after completion
		 * so the trailing edge can fire if mutations arrived mid-flight.
		 */
		async function executeSave() {
			const bp = builder.blueprint;
			const pid = builder.appId;
			const count = builder.mutationCount;
			if (!bp || !pid || count === lastSavedMutationRef.current) return;

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
					lastSavedMutationRef.current = count;
					setState({ status: "saved", savedAt: Date.now() });
				} else {
					/* Extract the server's error message for diagnostics. The status
					 * code alone distinguishes auth (401), validation (400), and
					 * Firestore (500) failures — the body adds the human detail. */
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
		 * Cooldown after errors provides natural 1s backoff.
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

		const unsub = builder.subscribeMutation(() => {
			/* Gate on auth, phase, and app existence — all read live. */
			if (!authRef.current) return;
			if (!builder.isReady) return;
			if (!builder.appId || !builder.blueprint) return;

			/* Skip if no actual blueprint mutations since last save. */
			if (builder.mutationCount === lastSavedMutationRef.current) return;

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
		});

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
