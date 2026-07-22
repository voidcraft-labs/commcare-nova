/**
 * useAutoSave — leading+trailing throttle that dispatches human edits to the
 * reconciler, which owns the durable write path.
 *
 * Subscribes to the BlueprintDoc store's entity-map references. On the first
 * mutation after a quiet period it dispatches immediately (leading edge);
 * mutations that arrive during a cooldown batch into one trailing dispatch, so
 * "Saving…" appears only while a PUT is actually in flight, not during an
 * artificial debounce window.
 *
 * The reconciler (`lib/collab/reconciler.ts`) owns `confirmedDoc ⊕ sentPending`
 * — the diff base — and the PUT itself (`dispatchHumanBatch` mints a batchId,
 * registers the batch, PUTs `{ mutations, batchId }`, and re-sends on network
 * failure via its own retry loop). This hook is the throttle + the save-status
 * surface: it computes when to dispatch, hands the reconciler a
 * `SaveObserver`, and renders the status from the signals it gets back. Access
 * transitions are a separate builder-level surface, not save errors.
 *
 * Gate order (load-bearing): `remoteFrameApplyInProgress` is checked FIRST —
 * the store subscriber fires synchronously from `applyMany`, including when the
 * reconciler applies an inbound frame, and a server-originated frame must never
 * bounce back out as a client PUT. There is deliberately NO agent-run gate: a
 * human edit made during an agent run is a `humanUncommitted` delta (the run's
 * own batches are in the reconciler's `sentPending`), so the reconciler's diff
 * picks it up and PUTs it on the next tick.
 *
 * Returns a SaveState the SaveIndicator renders.
 */
"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { shallow } from "zustand/shallow";
import { useReconcilerContext } from "@/lib/collab/context";
import type { SaveSignal } from "@/lib/collab/reconciler";
import { useCurrentProjectToast } from "@/lib/collab/useProjectToast";
import { docHasData } from "@/lib/doc/predicates";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { derivePhase, useProjectScopeEpoch } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import { toastStore } from "@/lib/ui/toastStore";

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
 * mutation has landed. This MUST list every persisted, user-editable
 * top-level field: a field omitted here is invisible to the save
 * subscription, so a change touching ONLY that field never dispatches.
 * `setAppLogo` mutates only `s.logo`, so `logo` belongs here; entity maps
 * (`modules` / `forms` / `fields`) cover their nested media, so the standalone
 * top-level slots are the ones to watch.
 *
 * Excluded by design: `fieldParent` (derived, stripped on save) and `appId`
 * (bookkeeping — set once on load, never a user edit). The `projectSaveSlice`
 * regression test holds these keys against the persisted schema so a
 * newly-added field can't be dropped from saves unnoticed.
 */
export function projectSaveSlice(s: BlueprintDoc) {
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
		logo: s.logo,
	};
}

/**
 * Auto-save hook — dispatches blueprint edits to the reconciler.
 *
 * Auth is guaranteed by the server layout (`requireAuth` in
 * `app/build/layout.tsx`) — no client-side auth check needed. The reconciler
 * (from `useReconcilerContext`) owns the write path; this hook throttles the
 * dispatch and renders its status. With no reconciler in context it inertly
 * stays idle.
 */
export function useAutoSave(): SaveState {
	const [state, setState] = useState<SaveState>(IDLE_STATE);

	/* The doc store owns blueprint entity data; the session store's `appId` and
	 * lifecycle flags gate whether dispatching is enabled; the reconciler owns
	 * the diff base + the PUT. */
	const docStore = useContext(BlueprintDocContext);
	const sessionApi = useContext(BuilderSessionContext);
	const reconcilerCtx = useReconcilerContext();
	const scopeEpoch = useProjectScopeEpoch();
	/* Save retries intentionally survive reversible Project/access transitions,
	 * so their toast provenance resolves at signal time instead of being pinned
	 * to the dispatch epoch like an ordinary async Project action. */
	const projectToast = useCurrentProjectToast();

	/* Throttle state — all mutable, read/written inside the subscription
	 * callback and cleanup. Never triggers re-renders. */
	const inFlightRef = useRef(false);
	const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const pendingTrailingRef = useRef(false);
	const unmountedRef = useRef(false);
	/* True while the last dispatch errored. Gates the "Saving…" flash so a
	 * SUSTAINED error episode doesn't bounce the indicator error→saving→error on
	 * every edit and re-announce the alert region. Cleared on any successful
	 * save / reload; reset on app change. */
	const lastErroredRef = useRef(false);
	/* Once-per-episode gate for the TERMINAL toasts (`permanent` / `tooLarge`) —
	 * the reconciler re-surfaces the signal on every post-freeze edit so the
	 * indicator stays honest, but the persistent toast must show ONCE, not once
	 * per keystroke. The toast id is captured so the app-change reset and the
	 * unmount cleanup can DISMISS it — a persistent toast must not strand on
	 * whatever app/screen the user lands on next (the 404 warning's rule). */
	const warnedTerminalRef = useRef(false);
	const terminalToastIdRef = useRef<string | undefined>(undefined);

	/* Clear the terminal (`permanent` / `tooLarge`) warning + dismiss its
	 * persistent toast — run on the
	 * app-change reset, a successful save, and unmount. */
	const dismissTerminalWarning = useCallback(() => {
		warnedTerminalRef.current = false;
		if (terminalToastIdRef.current) {
			toastStore.dismiss(terminalToastIdRef.current);
			terminalToastIdRef.current = undefined;
		}
	}, []);

	/* Reset state when the app changes — new app means a fresh save state and
	 * no pending/in-flight state from the old app. Uses React's "derive state
	 * from props" pattern. */
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
		dismissTerminalWarning();
		lastErroredRef.current = false;
		setState(IDLE_STATE);
	}

	/* Single long-lived subscription — subscribes to doc entity map changes.
	 * Entity reference checks via shallow equality are the watermark — if no
	 * entity map changed reference, the subscriber doesn't fire. */
	useEffect(() => {
		if (!docStore || !sessionApi) return;
		const session = sessionApi;
		const reconciler = reconcilerCtx?.reconciler ?? null;
		unmountedRef.current = false;

		/**
		 * Map a reconciler save signal to the indicator + the 404 warning. The
		 * `appId` guard: the reconciler is per-mount, but a fast app swap could
		 * fire a late signal — ignore anything once unmounted or after an app
		 * change (the reset above already cleared state).
		 */
		function observe(signal: SaveSignal): void {
			if (unmountedRef.current) return;
			switch (signal.kind) {
				case "saving":
					inFlightRef.current = true;
					/* During a sustained error episode skip the flash — it would bounce
					 * status error→saving→error on each retry and re-announce the alert
					 * region. */
					if (!lastErroredRef.current) {
						setState((prev) => ({ ...prev, status: "saving" }));
					}
					return;
				case "saved":
					inFlightRef.current = false;
					lastErroredRef.current = false;
					dismissTerminalWarning();
					setState({ status: "saved", savedAt: Date.now() });
					startCooldown();
					return;
				case "conflict":
					/* The reconciler runs the reload (GET fresh + re-fold) itself; the
					 * toast tells the user their edit conflicted. Reaching a 409 proves
					 * edit access, so a stale 404 warning is dismissed. */
					inFlightRef.current = false;
					lastErroredRef.current = false;
					setState(IDLE_STATE);
					projectToast(
						"warning",
						"App reloaded",
						"This app changed in a way that conflicts with your last edit — by an agent connection or another collaborator. We loaded the latest version; redo that change if you still want it.",
					);
					startCooldown();
					return;
				case "accessChanged":
					/* A reversible capability/scope boundary. The reconciler keeps the
					 * batch, pauses PUTs, and owns the atomic GET. Release only this
					 * hook's request indicator; the builder-level access status explains
					 * why editing is paused without a modal or error toast. */
					inFlightRef.current = false;
					lastErroredRef.current = false;
					setState(IDLE_STATE);
					return;
				case "permanent":
					/* Terminal — the server permanently rejected a change (a 400
					 * "Invalid mutations", a client↔server gate disagreement): the
					 * reconciler FROZE saving (no retry, no discard — the edits stay in
					 * the store) and OWNS the Sentry report (`onSaveError`). Tell the
					 * user to reload; ONE persistent toast per episode — the reconciler
					 * re-surfaces the signal on every post-freeze edit to keep the
					 * indicator honest, and un-gated that would toast per keystroke. */
					inFlightRef.current = false;
					lastErroredRef.current = true;
					if (!warnedTerminalRef.current) {
						warnedTerminalRef.current = true;
						terminalToastIdRef.current = projectToast(
							"error",
							"These edits couldn't be saved",
							"The server rejected a change, so saving is paused to avoid losing work. Reload the app to continue from the last saved version.",
							{ persistent: true },
						);
					}
					setState((prev) =>
						prev.status === "error" ? prev : { ...prev, status: "error" },
					);
					startCooldown();
					return;
				case "tooLarge":
					/* A 413 — the accumulated unsaved changes are too large to save in
					 * one request. The reconciler stopped retrying (no storm) but KEPT
					 * the edits and OWNS the report. Tell the user to reload; ONE
					 * persistent toast per episode (the signal re-fires on every edit
					 * dispatched behind the stuck batch). */
					inFlightRef.current = false;
					lastErroredRef.current = true;
					if (!warnedTerminalRef.current) {
						warnedTerminalRef.current = true;
						terminalToastIdRef.current = projectToast(
							"error",
							"Your unsaved changes are too large to save",
							"There are too many unsaved changes to save at once. Reload the app to continue from the last saved version.",
							{ persistent: true },
						);
					}
					setState((prev) =>
						prev.status === "error" ? prev : { ...prev, status: "error" },
					);
					startCooldown();
					return;
				case "error":
					inFlightRef.current = false;
					lastErroredRef.current = true;
					setState((prev) =>
						prev.status === "error" ? prev : { ...prev, status: "error" },
					);
					startCooldown();
					return;
			}
		}

		/**
		 * Dispatch the human delta through the reconciler. The reconciler
		 * computes it from `localBase()` (so a batch it already holds isn't
		 * re-sent) and returns undefined when there is nothing to send.
		 */
		function dispatch(): void {
			if (!docStore || !reconciler) return;
			/* A viewer holds no `edit` capability — never dispatch. The read-only
			 * builder suppresses edit affordances; this is the airtight backstop. */
			if (!session.getState().canEdit) return;
			reconciler.dispatchHumanBatch();
		}

		/**
		 * After a save signal settles, pause before allowing the next dispatch.
		 * If mutations arrived during the in-flight save or this cooldown, the
		 * trailing edge fires once the timer expires.
		 */
		function startCooldown() {
			if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
			cooldownTimerRef.current = setTimeout(() => {
				cooldownTimerRef.current = undefined;
				if (pendingTrailingRef.current) {
					pendingTrailingRef.current = false;
					dispatch();
				}
			}, COOLDOWN_MS);
		}

		/* The reconciler owns the mutable observer indirection. A Project epoch
		 * dependency recreates this closure, and registration
		 * retargets preserved pending batches before their retry can report into a
		 * stale epoch. Recovery-created human batches use the same current sink. */
		const unregisterSaveObserver = reconciler?.registerSaveObserver(
			observe,
			scopeEpoch,
		);

		/* Subscribe to doc entity map changes — fires only when a map gets a new
		 * Immer reference. Shallow equality on the projected slice short-circuits
		 * unrelated doc updates (e.g. appId bookkeeping). */
		const unsub = docStore.subscribe(
			projectSaveSlice,
			() => {
				/* Gate on `remoteFrameApplyInProgress` FIRST — this subscriber fires
				 * SYNCHRONOUSLY from `applyMany`, including when the reconciler
				 * applies an inbound frame (echo / remote / reload re-fold /
				 * data-done reseed). A server-originated change must never bounce
				 * back out as a client PUT. */
				if (docStore.getState().remoteFrameApplyInProgress) return;

				const sessionState = session.getState();
				/* A viewer holds no `edit` capability — never dispatch. */
				if (!sessionState.canEdit) return;

				/* Gate on lifecycle phase + app existence. Only dispatch when the
				 * builder is Ready or Completed (a usable blueprint, no initial
				 * generation in progress). A human edit made DURING an agent run is
				 * deliberately NOT gated out — it is a `humanUncommitted` delta the
				 * reconciler diffs + PUTs on the next tick (the run's own batches
				 * are in `sentPending`). */
				const docSnap = docStore.getState();
				const phase = derivePhase(sessionState, docHasData(docSnap));
				if (phase !== BuilderPhase.Ready && phase !== BuilderPhase.Completed)
					return;
				if (!sessionState.appId || !docHasData(docSnap)) return;

				/* Dispatch is in-flight → queue for trailing edge after completion. */
				if (inFlightRef.current) {
					pendingTrailingRef.current = true;
					return;
				}
				/* Cooldown active → queue for trailing edge when it expires. */
				if (cooldownTimerRef.current) {
					pendingTrailingRef.current = true;
					return;
				}
				/* No dispatch in-flight, no cooldown → leading edge. */
				dispatch();
			},
			{ equalityFn: shallow },
		);

		return () => {
			unmountedRef.current = true;
			unregisterSaveObserver?.();
			unsub();
			if (cooldownTimerRef.current) {
				clearTimeout(cooldownTimerRef.current);
				cooldownTimerRef.current = undefined;
			}
			pendingTrailingRef.current = false;
			/* Leaving the builder must not strand a persistent toast on whatever
			 * screen the user lands on next. */
			dismissTerminalWarning();
		};
	}, [
		sessionApi,
		docStore,
		reconcilerCtx,
		scopeEpoch,
		projectToast,
		dismissTerminalWarning,
	]);

	return state;
}
