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
 * What changed under multiplayer: the reconciler (`lib/collab/reconciler.ts`)
 * owns `confirmedDoc ⊕ sentPending` — the diff base — and the PUT itself
 * (`dispatchHumanBatch` mints a batchId, registers the batch, PUTs
 * `{ mutations, batchId }`, and re-sends on network failure via its own retry
 * loop). This hook is the throttle + the save-status surface: it computes when
 * to dispatch, hands the reconciler a `SaveObserver`, and renders the status +
 * the "changes aren't being saved" warning from the signals it gets back.
 *
 * Gate order (load-bearing): `remoteFrameApplyInProgress` is checked FIRST —
 * the store subscriber fires synchronously from `applyMany`, including when the
 * reconciler applies an inbound frame, and a server-originated frame must never
 * bounce back out as a client PUT. The run gate is gone: a human edit made
 * during an agent run is a `humanUncommitted` delta (the run's own batches are
 * in the reconciler's `sentPending`), so the reconciler's diff picks it up and
 * PUTs it on the next tick — the old "fold the human edit into the base and
 * lose it" limitation is closed.
 *
 * Returns a SaveState the SaveIndicator renders.
 */
"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { shallow } from "zustand/shallow";
import { reportClientError } from "@/lib/clientErrorReporter";
import { useReconcilerContext } from "@/lib/collab/context";
import type { SaveSignal } from "@/lib/collab/reconciler";
import { docHasData } from "@/lib/doc/predicates";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { derivePhase } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import { showToast, toastStore } from "@/lib/ui/toastStore";

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
 * dispatch and renders its status. In replay (no reconciler) it inertly stays
 * idle — replay never edits.
 */
export function useAutoSave(): SaveState {
	const [state, setState] = useState<SaveState>(IDLE_STATE);

	/* The doc store owns blueprint entity data; the session store's `appId` and
	 * lifecycle flags gate whether dispatching is enabled; the reconciler owns
	 * the diff base + the PUT. */
	const docStore = useContext(BlueprintDocContext);
	const sessionApi = useContext(BuilderSessionContext);
	const reconcilerCtx = useReconcilerContext();

	/* Throttle state — all mutable, read/written inside the subscription
	 * callback and cleanup. Never triggers re-renders. */
	const inFlightRef = useRef(false);
	const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const pendingTrailingRef = useRef(false);
	const unmountedRef = useRef(false);
	/* 404 warning state. `warned404Ref` gates the persistent toast to ONCE per
	 * failure episode (not every edit); it does NOT disable dispatching — the
	 * reconciler keeps retrying, so a transient 404 / re-promotion auto-recovers.
	 * On recovery the captured `warn404ToastIdRef` toast is DISMISSED. Both reset
	 * on app change. The Sentry signal is deduped by `reportClientError`'s own
	 * message Set (the message carries the app id). */
	const warned404Ref = useRef(false);
	const warn404ToastIdRef = useRef<string | undefined>(undefined);
	/* True while the last dispatch errored. Gates the "Saving…" flash so a
	 * SUSTAINED error episode doesn't bounce the indicator error→saving→error on
	 * every edit and re-announce the alert region. Cleared on any successful
	 * save / reload; reset on app change. */
	const lastErroredRef = useRef(false);

	/* Clear the 404 warning + dismiss its persistent toast. Called wherever the
	 * "can't save" state ends — a successful save, an app change, unmount — so
	 * the pinned toast never outlives the condition it describes. */
	const dismiss404Warning = useCallback(() => {
		warned404Ref.current = false;
		if (warn404ToastIdRef.current) {
			toastStore.dismiss(warn404ToastIdRef.current);
			warn404ToastIdRef.current = undefined;
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
		dismiss404Warning();
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
					dismiss404Warning();
					setState({ status: "saved", savedAt: Date.now() });
					startCooldown();
					return;
				case "conflict":
					/* The reconciler runs the reload (GET fresh + re-fold) itself; the
					 * toast tells the user their edit conflicted. Reaching a 409 proves
					 * edit access, so a stale 404 warning is dismissed. */
					inFlightRef.current = false;
					dismiss404Warning();
					lastErroredRef.current = false;
					setState(IDLE_STATE);
					showToast(
						"warning",
						"App reloaded",
						"This app changed in a way that conflicts with your last edit — by an agent connection or another collaborator. We loaded the latest version; redo that change if you still want it.",
					);
					startCooldown();
					return;
				case "reauth":
					/* Terminal — edit access was removed. The reconciler froze the
					 * canvas and OWNS the single Sentry report for a 403
					 * (`onReauthDenied`), so warn the user WITHOUT a second report
					 * here (a duplicate would double-count every revocation). */
					inFlightRef.current = false;
					lastErroredRef.current = true;
					warnNotWritable(/* report */ false);
					setState((prev) =>
						prev.status === "error" ? prev : { ...prev, status: "error" },
					);
					startCooldown();
					return;
				case "notFound":
					/* 404 — edit access revoked mid-session, or the app was deleted.
					 * The reconciler keeps retrying (no terminal signal owns this), so
					 * warn AND report from here. */
					inFlightRef.current = false;
					lastErroredRef.current = true;
					warnNotWritable(/* report */ true);
					setState((prev) =>
						prev.status === "error" ? prev : { ...prev, status: "error" },
					);
					startCooldown();
					return;
				case "permanent":
					/* Terminal — the server permanently rejected a change (a 400
					 * "Invalid mutations", a client↔server gate disagreement): the
					 * reconciler FROZE saving (no retry, no discard — the edits stay in
					 * the store) and OWNS the Sentry report (`onSaveError`). Tell the
					 * user to reload; a persistent toast, since it won't auto-recover. */
					inFlightRef.current = false;
					lastErroredRef.current = true;
					showToast(
						"error",
						"These edits couldn't be saved",
						"The server rejected a change, so saving is paused to avoid losing work. Reload the app to continue from the last saved version.",
						{ persistent: true },
					);
					setState((prev) =>
						prev.status === "error" ? prev : { ...prev, status: "error" },
					);
					startCooldown();
					return;
				case "tooLarge":
					/* A 413 — the accumulated unsaved changes are too large to save in
					 * one request. The reconciler stopped retrying (no storm) but KEPT
					 * the edits and OWNS the report. Tell the user to reload; persistent,
					 * since retrying the same body won't help. */
					inFlightRef.current = false;
					lastErroredRef.current = true;
					showToast(
						"error",
						"Your unsaved changes are too large to save",
						"There are too many unsaved changes to save at once. Reload the app to continue from the last saved version.",
						{ persistent: true },
					);
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

		/** Warn ONCE per failure episode that the app can't be saved from here
		 *  (edit access removed, or the app was deleted). The reconciler keeps
		 *  retrying, so a re-promotion / transient failure auto-recovers. `report`
		 *  gates the Sentry signal: a 404 reports here, but a 403 does NOT — the
		 *  reconciler's `onReauthDenied` owns the single 403 report, so warning
		 *  from both would double-count a revocation. */
		function warnNotWritable(report: boolean): void {
			if (warned404Ref.current) return;
			warned404Ref.current = true;
			warn404ToastIdRef.current = showToast(
				"warning",
				"Your changes aren't being saved",
				"This app can't be saved from here right now — your edit access may have been removed, or the app was deleted. If this persists, reload to see the current version.",
				{ persistent: true },
			);
			if (report) {
				reportClientError({
					message: `Auto-save failed — app ${session.getState().appId} not writable`,
					source: "manual",
					url: window.location.href,
				});
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
			reconciler.dispatchHumanBatch(observe);
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
				/* Never dispatch during replay — the doc is being rebuilt from a
				 * historical event log; any mutation is a scrub reconstruction, not
				 * a user edit. */
				if (sessionState.replay !== undefined) return;

				/* Gate on lifecycle phase + app existence. Only dispatch when the
				 * builder is Ready or Completed (a usable blueprint, no initial
				 * generation in progress). A human edit made DURING an agent run is
				 * NOT gated out any more — it is a `humanUncommitted` delta the
				 * reconciler diffs + PUTs on the next tick (the run's own batches
				 * are in `sentPending`), closing the old fold-and-lose limitation. */
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
			unsub();
			if (cooldownTimerRef.current) {
				clearTimeout(cooldownTimerRef.current);
				cooldownTimerRef.current = undefined;
			}
			pendingTrailingRef.current = false;
			/* Leaving the builder must not strand the persistent 404 toast on
			 * whatever screen the user lands on next. */
			dismiss404Warning();
		};
	}, [sessionApi, docStore, reconcilerCtx, dismiss404Warning]);

	return state;
}
