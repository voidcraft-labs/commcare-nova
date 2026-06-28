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
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { docHasData } from "@/lib/doc/predicates";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { derivePhase } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import { showToast } from "@/lib/ui/toastStore";

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
 * subscription, so a change touching ONLY that field never persists.
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

			/* Strip the derived state (fieldParent + the reference index)
			 * before sending — the server rebuilds both on load and the
			 * strict persistable schema rejects unknown keys. */
			const persistable = toPersistableDoc(doc);

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
					// stays consistent. The value is a normalized BlueprintDoc
					// (minus fieldParent — rebuilt on load). `basisToken` is the
					// optimistic-save basis — the server `blueprint_token` this
					// client last observed; the server compares it transactionally
					// and rejects with 409 when the doc advanced under us.
					body: JSON.stringify({
						blueprint: persistable,
						basisToken: session.getState().saveBasis,
					}),
				});
				if (!stillCurrent()) return;
				if (res.ok) {
					/* Advance the basis to the freshly rotated token so the next
					 * save's precondition compares against the doc THIS save just
					 * wrote. */
					try {
						const body = await res.json();
						if (typeof body?.basisToken === "string") {
							session.getState().setSaveBasis(body.basisToken);
						}
					} catch {
						/* body unreadable — the next save's stale basis will 409 and
						 * recover via the reload path below. */
					}
					setState({ status: "saved", savedAt: Date.now() });
				} else if (res.status === 409) {
					/* Stale basis: a writer this window never saw advanced the doc
					 * (another tab's save, an agent working over MCP). Saving would
					 * have erased that work, so the server refused. Recover by
					 * reloading the server's version and telling the user what
					 * happened — their last local change here is discarded. */
					await reloadAfterStaleBasis(appIdAtStart, stillCurrent);
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
					reportClientError(
						{
							message: `Auto-save network error: ${err instanceof Error ? err.message : String(err)}`,
							stack: err instanceof Error ? err.stack : undefined,
							source: "manual",
							url: window.location.href,
						},
						err,
					);
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
		 * Recover from a 409 stale-basis rejection: fetch the server's
		 * current doc, replace the local one with it, re-sync the basis, and
		 * tell the user in plain language what happened. The local doc was
		 * built on a snapshot another writer has since replaced, so the
		 * server's version is the one source of truth worth keeping — the
		 * user's most recent local change is the cost, and the toast says so.
		 *
		 * This is the deliberate, SAFE conflict resolution. A non-destructive
		 * REBASE (replay the local edits onto the server's fresh doc instead
		 * of discarding them) is the multiplayer-GA follow-up — it requires a
		 * client mutation op-log replayed through the commit gate, because the
		 * auto-save PUT does no whole-doc validation (validity is gated
		 * per-mutation), so a merged doc must be re-verdicted client-side or
		 * it could persist an invalid blueprint. The only consumer of a
		 * human-vs-human rebase is concurrent editing, which `PROJECTS_ENABLED`
		 * gates off; the reachable conflict today (an MCP agent vs. this tab)
		 * is correctly handled by this reload.
		 */
		async function reloadAfterStaleBasis(
			appId: string,
			stillCurrent: () => boolean,
		): Promise<void> {
			try {
				const res = await fetch(`/api/apps/${appId}`);
				if (!stillCurrent()) return;
				if (!res.ok) throw new Error(`reload failed: HTTP ${res.status}`);
				const data = (await res.json()) as {
					blueprint: PersistableDoc;
					basis_token: string | null;
				};
				if (!stillCurrent() || !docStore) return;
				/* `load()` clears + re-pauses undo tracking (the empty→populated
				 * swap must not enter history); resume right after so the user's
				 * next edit is undoable again. */
				docStore.getState().load(data.blueprint);
				docStore.temporal.getState().resume();
				session.getState().setSaveBasis(data.basis_token ?? null);
				setState(IDLE_STATE);
				showToast(
					"warning",
					"App reloaded",
					"This app was changed outside this window — by an agent connection or another tab. We loaded the latest version so nothing gets overwritten; your last change here wasn't saved, so redo it if you still want it.",
				);
			} catch (err) {
				/* The reload itself failed — surface as a save error so the
				 * indicator shows something is wrong; the next mutation retries
				 * the whole save → 409 → reload sequence. */
				reportClientError(
					{
						message: `Auto-save stale-basis reload failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
						source: "manual",
						url: window.location.href,
					},
					err,
				);
				if (stillCurrent()) {
					setState((prev) => ({ ...prev, status: "error" }));
				}
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
				const sessionState = session.getState();
				/* Never save during replay. The doc is being rebuilt from a
				 * historical event log; any mutation it receives is a scrub
				 * reconstruction, not a user edit. Persisting those writes
				 * would overwrite the app's real data with a partial playback
				 * snapshot. Gate here before the phase check — replay now
				 * derives to Ready (see `derivePhase`), so the phase gate
				 * alone would let scrub writes through. */
				if (sessionState.replay !== undefined) return;
				/* Gate on lifecycle phase and app existence. Derive the builder
				 * phase from session state + doc presence — only save when the
				 * builder is in Ready or Completed (i.e. the user has a usable
				 * blueprint and no initial generation is in progress). */
				const docSnap = docStore.getState();
				const phase = derivePhase(sessionState, docHasData(docSnap));
				if (phase !== BuilderPhase.Ready && phase !== BuilderPhase.Completed)
					return;
				const pid = sessionState.appId;
				/* Redundant with the phase gate above (Ready/Completed both
				 * require a populated doc), but defensive — the flags are
				 * updated independently and we never want to PUT an empty
				 * blueprint. Use the shared predicate for consistency. */
				if (!pid || !docHasData(docSnap)) return;

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
