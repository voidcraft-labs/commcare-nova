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
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { shallow } from "zustand/shallow";
import { reportClientError } from "@/lib/clientErrorReporter";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { docHasData } from "@/lib/doc/predicates";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";
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
	/* 404 warning state. `warned404Ref` gates the persistent toast to ONCE per
	 * failure episode (not every edit); it does NOT disable saving — later edits
	 * retry, so a transient 404 / re-promotion auto-recovers. On recovery the
	 * captured `warn404ToastIdRef` toast is DISMISSED (persistent toasts never
	 * auto-expire, so leaving it would contradict the restored "Saved" state).
	 * Both reset on app change. The Sentry signal is deduped by
	 * `reportClientError`'s own message Set (the message carries the app id), so
	 * no separate once-flag is needed. */
	const warned404Ref = useRef(false);
	const warn404ToastIdRef = useRef<string | undefined>(undefined);
	/* True while the last save attempt errored (404 / generic / network). Gates
	 * the "Saving…" flash so a SUSTAINED error episode doesn't bounce the
	 * indicator error→saving→error on every edit and re-announce the alert
	 * region. Cleared on any successful save / reload; reset on app change. */
	const lastErroredRef = useRef(false);

	/* The diff base: the blueprint as the server last persisted it (a
	 * `toPersistableDoc` snapshot — no live references). Each save sends the
	 * `diffDocsToMutations(lastSaved, current)` delta, never the whole doc;
	 * on success the base advances to the doc that was sent. Seeded to the
	 * loaded doc when the subscription mounts (before any edit) and re-synced
	 * during agent runs (the run streams + persists its own mutations).
	 * Null only until that first seed. */
	const lastSavedDocRef = useRef<PersistableDoc | null>(null);

	/* Clear the 404 warning + dismiss its persistent toast. Called wherever the
	 * "can't save" state ends — a successful save, a 409 reload, an app change,
	 * unmount — so the pinned toast never outlives the condition it describes.
	 * The error-churn flag (`lastErroredRef`) is managed separately by each
	 * branch, since a failed 409-reload ends the 404 warning but stays errored. */
	const dismiss404Warning = useCallback(() => {
		warned404Ref.current = false;
		if (warn404ToastIdRef.current) {
			toastStore.dismiss(warn404ToastIdRef.current);
			warn404ToastIdRef.current = undefined;
		}
	}, []);

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
		/* A different app starts fresh — drop the previous app's 404 warning +
		 * error-churn state so neither haunts the new app. */
		dismiss404Warning();
		lastErroredRef.current = false;
		/* Drop the old app's diff base — the subscription re-seeds it from
		 * the freshly loaded doc before the first edit can save. */
		lastSavedDocRef.current = null;
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

		/* Seed the diff base from the loaded doc, before any edit can fire a
		 * save. The provider loads `initialDoc` synchronously at store
		 * creation, so the doc here is the persisted blueprint (or the empty
		 * doc for a brand-new build — the run then streams into it and keeps
		 * the base synced via the run gate below). */
		if (lastSavedDocRef.current === null) {
			lastSavedDocRef.current = toPersistableDoc(docStore.getState());
		}

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
			/* A viewer can't persist — the server would reject the write as a
			 * 404 (no `edit` capability). Bail before the PUT so a stray local
			 * change degrades to local-only rather than a failed request; the
			 * read-only UI keeps those changes from happening in the first place. */
			if (!session.getState().canEdit) return;
			const appIdAtStart = session.getState().appId;
			const doc = docStore.getState();
			if (!appIdAtStart || doc.moduleOrder.length === 0) return;

			/* A run owns the doc — it streams its mutations in and persists them
			 * server-side. Never auto-save over a run; keep the diff base synced
			 * to the run's streamed/reconciled doc so the first user edit
			 * afterward diffs against the run's result. Defensive twin of the
			 * subscription's run gate, for a cooldown that fires after a run
			 * has begun. */
			if (session.getState().events.length > 0) {
				lastSavedDocRef.current = toPersistableDoc(doc);
				return;
			}

			/* The diff base must exist — the subscription seeds it before the
			 * first save can fire. If it somehow doesn't (an in-place app swap
			 * before the re-seed lands), establish it now and skip: the doc on
			 * disk equals what we just loaded, so there is nothing to send. */
			const base = lastSavedDocRef.current;
			if (base === null) {
				lastSavedDocRef.current = toPersistableDoc(doc);
				return;
			}

			/* Send the DELTA, never the whole doc. The snapshot is taken once
			 * here (stripped of the derived fieldParent + reference index) so
			 * it is both the diff target and the new base on success — the doc
			 * can't move under us mid-build. An empty delta (e.g. edit then
			 * undo back to the saved state) needs no request. */
			const snapshot = toPersistableDoc(doc);
			const mutations = diffDocsToMutations(
				base as BlueprintDoc,
				snapshot as BlueprintDoc,
			);
			if (mutations.length === 0) return;

			inFlightRef.current = true;
			/* During a sustained error episode (every edit retries, hoping for
			 * recovery) skip the "Saving…" flash — it would bounce status
			 * error→saving→error on each edit and re-announce the alert region.
			 * The retry still fires; a SUCCESS clears `lastErroredRef` and sets
			 * "saved". Applies to ALL error kinds (404 / generic / network). */
			if (!unmountedRef.current && !lastErroredRef.current) {
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
					/* The mutation delta — plain JSON arrays, never the whole
					 * doc. The server replays them onto the FRESH stored
					 * blueprint and re-runs the validity verdict, so concurrent
					 * edits MERGE and an invalid batch is refused (409). No basis
					 * precondition rides along — the merge, not a token compare,
					 * is what makes a concurrent save safe. */
					body: JSON.stringify({ mutations }),
				});
				if (!stillCurrent()) return;
				if (res.ok) {
					/* The delta landed — advance the diff base to exactly what
					 * we sent so the next save diffs against it. */
					lastSavedDocRef.current = snapshot;
					try {
						const body = await res.json();
						if (typeof body?.basisToken === "string") {
							session.getState().setSaveBasis(body.basisToken);
						}
					} catch {
						/* body unreadable — the version marker is advisory; the
						 * next save still diffs against the advanced base. */
					}
					/* A save landed — recovery. Clear the error-churn flag and dismiss
					 * the 404 warning + its pinned toast (it would otherwise
					 * contradict the restored "Saved"), so a later loss of access
					 * warns afresh. */
					lastErroredRef.current = false;
					dismiss404Warning();
					setState({ status: "saved", savedAt: Date.now() });
				} else if (res.status === 409) {
					/* The delta is invalid against the FRESH server doc — a
					 * genuine concurrent conflict (this edit targets an entity
					 * another writer changed out from under it). Re-sending
					 * replays the rejection, so resync to the server's version
					 * and tell the user. */
					await reloadAfterConflict(appIdAtStart, stillCurrent);
				} else if (res.status === 404) {
					/* The write path can no longer PUT this app: the gate collapses
					 * both "edit access revoked mid-session" (a shared-Project
					 * demotion — `canEdit` was captured at mount, so the read-only
					 * gates never engaged and the user kept editing) AND "the app was
					 * deleted by another admin" to a 404. WARN ONCE (the persistent
					 * toast would otherwise re-stack on every later edit) but DON'T
					 * disable saving — later edits keep retrying the PUT, so a
					 * re-promotion or a transient/spurious 404 auto-recovers on the
					 * next successful save (which clears `warned404Ref`). Keep the
					 * Sentry signal so a routing regression isn't masked as a benign
					 * role change. Guarded by `stillCurrent()` — a 404 for an app the
					 * user already navigated away from must not warn on the new app. */
					if (stillCurrent()) {
						lastErroredRef.current = true;
						if (!warned404Ref.current) {
							warned404Ref.current = true;
							warn404ToastIdRef.current = showToast(
								"warning",
								"Your changes aren't being saved",
								"This app can't be saved from here right now — your edit access may have been removed, or the app was deleted. If this persists, reload to see the current version.",
								{ persistent: true },
							);
							/* Report inside the once-per-episode gate; the app id in the
							 * message lets `reportClientError`'s own message-dedup keep
							 * this to once per app per page-load (no flap spam). */
							reportClientError({
								message: `Auto-save failed — HTTP 404 (app ${appIdAtStart} not writable)`,
								source: "manual",
								url: window.location.href,
							});
						}
						/* Don't churn the alert region on every retry — only transition
						 * INTO error (a no-op `set` returning `prev` skips the re-render
						 * and the screen-reader re-announce; the saving-flash skip above
						 * keeps the label constant). */
						setState((prev) =>
							prev.status === "error" ? prev : { ...prev, status: "error" },
						);
					}
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
						lastErroredRef.current = true;
						setState((prev) =>
							prev.status === "error" ? prev : { ...prev, status: "error" },
						);
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
					lastErroredRef.current = true;
					setState((prev) =>
						prev.status === "error" ? prev : { ...prev, status: "error" },
					);
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
		 * Recover from a 409 conflict rejection: the mutation delta could not
		 * apply to the server's current doc (another writer changed the same
		 * entity), so fetch the server's version, replace the local doc with
		 * it, re-sync the diff base + version marker, and tell the user. The
		 * common case — non-overlapping concurrent edits — never reaches here:
		 * the server merges those by replaying the delta on the fresh doc.
		 */
		async function reloadAfterConflict(
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
				lastSavedDocRef.current = data.blueprint;
				session.getState().setSaveBasis(data.basis_token ?? null);
				/* Reaching a 409 means the server accepted the write attempt — edit
				 * access exists, so any prior 404 "can't save" warning is stale,
				 * and the conflict is now resolved (fresh doc loaded). Clear both
				 * the warning and the error-churn flag before the reload toast. */
				dismiss404Warning();
				lastErroredRef.current = false;
				setState(IDLE_STATE);
				showToast(
					"warning",
					"App reloaded",
					"This app changed in a way that conflicts with your last edit — by an agent connection or another collaborator. We loaded the latest version; redo that change if you still want it.",
				);
			} catch (err) {
				/* The reload itself failed — surface as a save error so the
				 * indicator shows something is wrong; the next mutation retries
				 * the whole save → 409 → reload sequence. The 409 already proved
				 * edit access, so a prior 404 warning is stale even though the
				 * reload failed — dismiss it so it can't contradict the true state. */
				reportClientError(
					{
						message: `Auto-save conflict reload failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
						source: "manual",
						url: window.location.href,
					},
					err,
				);
				if (stillCurrent()) {
					dismiss404Warning();
					lastErroredRef.current = true;
					setState((prev) =>
						prev.status === "error" ? prev : { ...prev, status: "error" },
					);
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
				/* A viewer holds no `edit` capability — never persist their
				 * session. The read-only builder suppresses edit affordances, but
				 * this is the airtight backstop: no PUT is ever attempted, so a
				 * missed affordance can only ever change the local doc, never the
				 * server's. */
				if (!sessionState.canEdit) return;
				/* Never save during replay. The doc is being rebuilt from a
				 * historical event log; any mutation it receives is a scrub
				 * reconstruction, not a user edit. Persisting those writes
				 * would overwrite the app's real data with a partial playback
				 * snapshot. Gate here before the phase check — replay now
				 * derives to Ready (see `derivePhase`), so the phase gate
				 * alone would let scrub writes through. */
				if (sessionState.replay !== undefined) return;
				/* A run owns the doc (it streams + persists its own mutations).
				 * Keep the diff base synced to the latest streamed doc and never
				 * auto-save over a run, so the first user edit afterward diffs
				 * against the run's result, not the pre-run snapshot — and so
				 * the run's own streamed mutations are never re-sent as a user
				 * delta (which would re-apply on a fresh doc that already has
				 * them).
				 *
				 * KNOWN LIMITATION — a HUMAN edit made DURING an agent edit-run
				 * is folded into this base and not separately persisted until
				 * the next standalone edit, because the run gate can't tell the
				 * agent's streamed mutations from a concurrent human edit
				 * (separating them needs per-write origin tracking — the
				 * concurrent-editing machinery this project's multiplayer goal
				 * will add). The dominant sequential flow (edit, then ask the
				 * agent, or vice versa) is unaffected. */
				if (sessionState.events.length > 0) {
					lastSavedDocRef.current = toPersistableDoc(docStore.getState());
					return;
				}
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
			/* Leaving the builder must not strand the persistent 404 toast on
			 * whatever screen the user lands on next. */
			dismiss404Warning();
		};
	}, [sessionApi, docStore, dismiss404Warning]);

	return state;
}
