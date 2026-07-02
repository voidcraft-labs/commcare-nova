/**
 * The client reconciler — one session-scoped owner of confirmed-vs-displayed
 * blueprint state under real-time multiplayer editing.
 *
 * ## The invariant
 *
 *   displayed === fold(confirmedDoc, [...sentPending, humanUncommitted()])
 *
 * where `fold(doc, batches)` folds each batch onto `doc` via `applyMutations`.
 * `displayed` is the doc the store holds (what the user sees + edits);
 * `confirmedDoc` is the last server-confirmed blueprint at `baseSeq`;
 * `sentPending` is every batch this tab has PUT whose own echo hasn't
 * returned yet; `humanUncommitted` is the local human delta not yet PUT.
 *
 * ## Confirmed advances only via inbound frames
 *
 * `confirmedDoc`/`baseSeq` advance ONLY when a `mutation` frame arrives on
 * the durable stream — never on a PUT 200 (which is advisory; it records the
 * assigned seq on the sent batch so a later reload can drop it). A batch
 * leaves `sentPending` only when its OWN echo frame returns. A solo editor
 * therefore receives its own batches back as echoes and reconciles exactly
 * like a collaborator would.
 *
 * ## Echo vs remote
 *
 * A frame is a self-ECHO when its `batchId` is in `awaitingEcho`, OR when it
 * carries this user's `actorId` AND a non-null `runId` equal to the tab's
 * active run (a chat frame). A `runId`-less frame carrying the same user's
 * `actorId` — a peer TAB's autosave — is REMOTE, not an echo: two tabs of one
 * user share a single `actorId`, so an `actorId`-only match would make one
 * tab's autosave look like a self-echo of the other.
 *
 * An echo advances `confirmedDoc`, drops its batch from `sentPending`, and
 * does NOT rebase the undo stacks (the change is already reflected in
 * `displayed`). A remote frame advances `confirmedDoc`, re-folds the remaining
 * `sentPending`, and folds the peer's batch through the undo/redo stacks so an
 * undo target still carries the merge in.
 *
 * ## Reload reconciliation
 *
 * A gap (`seq > baseSeq + 1`), a retention-overrun / migration `reload` event,
 * or a PUT 409 all reconcile by GETting the fresh blueprint at seq `M`, then:
 *   (a) dropping every `sentPending` batch whose `ackedSeq <= M` (its commit is
 *       already folded into the fresh doc), AND
 *   (b) dropping THE batch the 409 rejected — without (b) the rejected batch
 *       (no `ackedSeq`) re-folds + re-sends → 409 → reload, an infinite loop.
 * The remaining un-acked batches + `humanUncommitted` re-fold onto the reloaded
 * `confirmedDoc`, the undo stack clears, and the stream resubscribes at `M`.
 *
 * ## Testability
 *
 * The reconciler is a headless state machine: every side effect (the PUT, the
 * reload GET, the clock, the retry scheduler, the stream resubscribe) is an
 * injected dependency, so the echo/remote/gap/reload/409-loop/two-tab/undo
 * paths are driven synchronously in unit tests with no network or timers. The
 * only store coupling is `applyMany`/`commitDoc`/`beginRemoteApply` — which the
 * tests exercise against a real store instance.
 */

import { produce } from "immer";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";
import type { BuilderSessionStoreApi } from "@/lib/session/store";

/** A projected `mutation` frame off the durable stream (see the `/stream`
 *  route's `send("mutation", …)` — the raw Firestore doc's `Timestamp`s are
 *  stripped before the wire). */
export interface MutationFrame {
	readonly seq: number;
	readonly batchId: string;
	readonly actorId: string;
	/** Present on a chat-SA frame; absent on an autosave/MCP frame. */
	readonly runId?: string;
	readonly kind: "autosave" | "mcp" | "chat" | "migration";
	readonly mutations: Mutation[];
}

/** A batch this tab has PUT (or a chat run has committed) whose own echo
 *  hasn't returned. It stays folded into `localBase()` until its echo drops
 *  it, so a network-failed PUT keeps folding rather than vanishing. */
interface SentBatch {
	readonly batchId: string;
	/** The run this batch belongs to, for a chat batch — used only to keep the
	 *  registration symmetric with the frame's `runId`; echo matching keys on
	 *  `batchId ∈ awaitingEcho`. */
	readonly runId?: string;
	readonly mutations: Mutation[];
	/** The `seq` the server assigned (PUT 200, or the chat `data-mutations`
	 *  committed seq). Set once known; a reload drops batches with
	 *  `ackedSeq <= M`. Undefined until acked. */
	ackedSeq?: number;
	/** True once the PUT has been sent (guards the retry loop from re-sending
	 *  a batch still in its first flight). Chat batches are `sent: true` at
	 *  registration (the server committed them). */
	sent: boolean;
	/** True while a PUT for this batch is currently awaiting its response. The
	 *  retry loop excludes an in-flight batch so it never fires a second,
	 *  concurrent PUT for the one already open. */
	putInFlight: boolean;
	/** True once the batch's echo frame has advanced `confirmedDoc` — it is
	 *  about to leave `sentPending`, so the retry loop must not re-send it. */
	echoed: boolean;
	/** Save-lifecycle observer for a human batch (drives the save indicator +
	 *  404 warning). Absent on a chat batch (registered already-committed). */
	observe?: SaveObserver;
}

/** The result of a PUT: `{ seq }` on 200, a tagged failure so the reconciler
 *  routes each to its handler. `notFound` (404 — edit access revoked
 *  mid-session, or the app was deleted) is retryable like `network` (a
 *  re-promotion / transient 404 self-recovers, idempotent via batchDedup) but
 *  is surfaced distinctly so `useAutoSave` can show its "changes aren't being
 *  saved" warning. */
export type PutOutcome =
	| { ok: true; seq: number }
	| { ok: false; kind: "conflict" }
	| { ok: false; kind: "reauth" }
	| { ok: false; kind: "notFound" }
	/** A PERMANENT rejection — specifically a 400 "Invalid mutations": the
	 *  CLIENT commit gate passed but the server refused, a genuine gate
	 *  disagreement (a bug). TERMINAL: freeze + surface + report (re-sending
	 *  re-hits it forever, and dropping-one would silently lose a dependent
	 *  stacked batch). `detail` carries the status/body. */
	| { ok: false; kind: "permanent"; detail?: string }
	/** A 413 — the accumulated unsaved delta exceeds the request cap. Retrying
	 *  the same body won't shrink it, so it STOPS the retry loop (no 413-storm)
	 *  and surfaces clearly, but does NOT discard the edits — a reload is the
	 *  user's explicit choice, not an automatic data-drop. */
	| { ok: false; kind: "tooLarge"; detail?: string }
	/** A transient 5xx / network failure (and a recoverable 401 — a lapsed
	 *  session that a re-auth can recover): the batch stays in `sentPending` and
	 *  the retry loop re-sends it. `detail` (HTTP status / body / network stack)
	 *  feeds the deduped observability report. */
	| { ok: false; kind: "network"; detail?: string };

/** A save-lifecycle signal `useAutoSave` renders as status + the 404 warning.
 *  The reconciler fires it to the observer passed on `dispatchHumanBatch`. */
export type SaveSignal =
	| { kind: "saving" }
	| { kind: "saved" }
	| { kind: "conflict" }
	| { kind: "reauth" }
	| { kind: "notFound" }
	/** The server permanently rejected the batch (a 400 "Invalid mutations");
	 *  saving is frozen. `useAutoSave` shows a terminal "reload to continue"
	 *  error. */
	| { kind: "permanent" }
	/** The unsaved delta is too large (413); the retry loop stops but the edits
	 *  are kept. `useAutoSave` surfaces a "too large — reload" error. */
	| { kind: "tooLarge" }
	| { kind: "error" };

/** Observe the lifecycle of one dispatched human batch (for the save
 *  indicator + 404 warning). */
export type SaveObserver = (signal: SaveSignal) => void;

/** The fresh blueprint a reload GET returns. */
export interface ReloadedDoc {
	readonly blueprint: PersistableDoc;
	readonly seq: number;
}

/** Injectable side effects — a real provider wires the network/timers; tests
 *  supply synchronous fakes so the state machine runs headless. */
export interface ReconcilerDeps {
	/** PUT `{ mutations, batchId }` to `/api/apps/{appId}`. */
	put: (batchId: string, mutations: Mutation[]) => Promise<PutOutcome>;
	/** GET the fresh blueprint + head seq for a reload. */
	reload: () => Promise<ReloadedDoc>;
	/** Resubscribe the durable stream at `cursor` (the reconciler calls this
	 *  after a reload lands so frames in `(oldCursor, M]` don't re-trip the
	 *  gap check). The provider re-opens the EventSource; a solo test no-ops. */
	resubscribe: (cursor: number) => void;
	/** Schedule the retry loop's next tick (backoff). Returns a canceller.
	 *  The provider uses `setTimeout`; tests drive it manually. */
	scheduleRetry: (attempt: number, run: () => void) => () => void;
	/** Announce a terminal 409 to the user ("this app changed…"). */
	onConflictReload?: () => void;
	/** Announce a terminal reauth denial (403 — edit access lost). */
	onReauthDenied?: () => void;
	/** Report a persistent save-path failure to the observability channel
	 *  (Sentry, via the provider's `reportClientError`). Fires for a 5xx /
	 *  network PUT failure and a reload-GET failure so an app-wide save outage
	 *  isn't invisible; the provider dedupes per-app so a retry storm is one
	 *  issue. `detail` carries the HTTP status / body / network stack. */
	onSaveError?: (detail: string) => void;
}

export interface ReconcilerInit {
	/** The app id. `undefined` for a brand-new build — the reconciler mounts
	 *  DORMANT and activates on `data-app-id`. */
	appId?: string;
	/** The head seq at mount (`app.mutation_seq`). 0 for a fresh app. */
	baseSeq: number;
	/** The loaded blueprint at `baseSeq` — the initial `confirmedDoc`. */
	baseDoc: BlueprintDoc;
	/** The session user id — the `selfUserId` echo classification keys on. */
	userId: string;
}

/** A read-only snapshot for tests + presence wiring. */
export interface ReconcilerSnapshot {
	readonly appId: string | undefined;
	readonly dormant: boolean;
	readonly baseSeq: number;
	readonly confirmedDoc: BlueprintDoc;
	readonly sentPending: readonly SentBatch[];
	readonly awaitingEcho: ReadonlySet<string>;
	readonly reloadPending: boolean;
	readonly reloadInFlight: boolean;
	readonly revoked: boolean;
	readonly disposed: boolean;
	readonly selfActiveRunId: string | undefined;
}

export interface Reconciler {
	/** Whether human-uncommitted edits should PUT (false while dormant). */
	canPut(): boolean;
	/** Whether the reconciler is still dormant (a new build with no app id yet).
	 *  Cheap boolean read for the chat hot path — avoids `getSnapshot()`'s deep
	 *  clone of `sentPending`/`awaitingEcho` per `data-mutations` frame. */
	isDormant(): boolean;
	/** The auto-save diff base: `confirmedDoc ⊕ sentPending`. */
	localBase(): BlueprintDoc;
	/** Dispatch the human delta between `localBase()` and the store's displayed
	 *  doc as a new batch: mint a batchId, register it, and PUT. No-op when the
	 *  delta is empty or the reconciler is dormant/revoked. `observe` receives
	 *  the batch's save lifecycle (saving → saved / conflict / reauth /
	 *  notFound / error), including retry re-sends. Returns the minted batchId
	 *  (or undefined when nothing was sent). */
	dispatchHumanBatch(observe?: SaveObserver): string | undefined;
	/** Register a chat-SA batch the server just committed (from the
	 *  `data-mutations` handler) so its own stream echo is recognized and
	 *  dropped, and its committed seq lets a reload drop it. */
	registerChatBatch(args: {
		batchId: string;
		runId: string | undefined;
		mutations: Mutation[];
		seq: number;
	}): void;
	/** Handle one inbound `mutation` frame. */
	onFrame(frame: MutationFrame): void;
	/** Handle an `event: reload` (retention/migration sentinel). */
	onReloadEvent(): void;
	/** Handle an `event: revoked` — freeze; cancel any pending reload. */
	onRevoked(): void;
	/** Reseed `confirmedDoc`/`baseSeq` from the chat run's `data-done`
	 *  `{ doc, seq }` (the same drop-then-refold a reload runs, but reseeding
	 *  via a suppressed `commitDoc` inside the still-open agent bracket). */
	onDataDone(args: { doc: PersistableDoc; seq: number }): void;
	/** Set the tab's active run id (from `data-run-id`), before any frame. */
	setSelfActiveRunId(runId: string | undefined): void;
	/** Activate a dormant reconciler once the new build's app id is minted
	 *  (`data-app-id`): seed `{ appId, baseSeq: 0, baseDoc: <current doc> }`. */
	activate(args: { appId: string; baseDoc: BlueprintDoc }): void;
	/** A read-only state snapshot (tests + presence). */
	getSnapshot(): ReconcilerSnapshot;
	/** Cancel any scheduled retry (provider teardown). */
	dispose(): void;
}

/** Apply one batch to an Immer draft. `applyMutations` is typed for the
 *  concrete `BlueprintDoc`; the draft is structurally identical (Immer tracks
 *  the same shape), so the cast lives in this one place. It also maintains
 *  `fieldParent` + `refIndex` incrementally, so a folded doc stays a fully
 *  hydrated working doc. */
function applyBatch(draft: BlueprintDoc, batch: Mutation[]): void {
	applyMutations(draft as Parameters<typeof applyMutations>[0], batch);
}

/** Fold a list of mutation batches onto a doc, left to right. Each fold is an
 *  Immer `produce` so `confirmedDoc` / `localBase` stay structurally shared and
 *  the input doc is never mutated. */
function foldBatches(
	doc: BlueprintDoc,
	batches: readonly Mutation[][],
): BlueprintDoc {
	let acc = doc;
	for (const batch of batches) {
		if (batch.length === 0) continue;
		acc = produce(acc, (draft) => {
			applyBatch(draft, batch);
		});
	}
	return acc;
}

/** Hydrate a raw persisted blueprint into a fully-indexed working doc — the
 *  reload GET returns a `PersistableDoc` with no `fieldParent`/`refIndex`, and
 *  `commitDoc` overlays exactly the keys the target carries, so a target
 *  missing those would drop them from the store. */
function hydrateConfirmed(persisted: PersistableDoc): BlueprintDoc {
	const doc = hydratePersistedBlueprint(persisted);
	doc.refIndex = buildReferenceIndex(doc);
	return doc;
}

/** Normalize a `baseDoc` seed into a clean working doc. The provider passes
 *  `docStore.getState()`, which carries the store's action closures +
 *  `remoteFrameApplyInProgress` alongside the doc data; those must not become
 *  part of `confirmedDoc` (a later `structuredClone` on it would throw). Keep
 *  `fieldParent`/`refIndex` if present (the seed is already hydrated). */
function normalizeConfirmed(doc: BlueprintDoc): BlueprintDoc {
	const clean: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(
		doc as unknown as Record<string, unknown>,
	)) {
		if (typeof v === "function") continue;
		if (k === "remoteFrameApplyInProgress") continue;
		clean[k] = v;
	}
	return clean as unknown as BlueprintDoc;
}

export function createReconciler(
	docStore: BlueprintDocStoreApi,
	_sessionApi: BuilderSessionStoreApi,
	init: ReconcilerInit,
	deps: ReconcilerDeps,
): Reconciler {
	// ── State ────────────────────────────────────────────────────────────
	let appId = init.appId;
	let dormant = init.appId === undefined;
	let baseSeq = init.baseSeq;
	let confirmedDoc = normalizeConfirmed(init.baseDoc);
	const selfUserId = init.userId;
	let selfActiveRunId: string | undefined;
	const sentPending: SentBatch[] = [];
	const awaitingEcho = new Set<string>();
	let reloadPending = false;
	/** True while a `runReload` is between its GET request and its completion —
	 *  so a gap/409 arriving mid-reload coalesces (re-arms `reloadPending`) into
	 *  ONE follow-up reload instead of starting a second concurrent one. */
	let reloadInFlight = false;
	let revoked = false;
	/** Set once `dispose()` runs (provider unmount). A reload/PUT promise that
	 *  resolves after this must NOT resubscribe (a leaked EventSource) or write
	 *  into the torn-down store — every async continuation checks it. */
	let disposed = false;
	/** Number of PUTs currently awaiting their 200/failure — a reload defers
	 *  until this is 0 so it never GETs mid-PUT and drops a batch the server is
	 *  about to accept. */
	let putsInFlight = 0;
	/** The batchId a 409 rejected, captured so the deferred reload drops it.
	 *  Preserved across a coalesced reload so the loop-break still holds. */
	let rejectedBatchId: string | undefined;
	/** The active retry-loop canceller, if the loop is scheduled. */
	let cancelRetry: (() => void) | undefined;
	let retryAttempt = 0;

	/** Any async continuation must stop here — the reconciler was torn down or
	 *  access was revoked. */
	function inert(): boolean {
		return disposed || revoked;
	}

	// ── Displayed-doc helpers ────────────────────────────────────────────
	function displayed(): BlueprintDoc {
		return docStore.getState();
	}

	function pendingBatches(): Mutation[][] {
		return sentPending.map((b) => b.mutations);
	}

	function localBase(): BlueprintDoc {
		return foldBatches(confirmedDoc, pendingBatches());
	}

	/** The human delta not yet in `sentPending` — the difference between the
	 *  displayed doc and `localBase()`. */
	function humanUncommitted(): Mutation[] {
		return diffDocsToMutations(
			toPersistableDoc(localBase()) as BlueprintDoc,
			toPersistableDoc(displayed()) as BlueprintDoc,
		);
	}

	/** Re-fold `confirmedDoc ⊕ sentPending ⊕ humanUncommitted` onto the store's
	 *  displayed doc inside a remote-apply bracket (off the undo stack, and
	 *  gating the auto-save re-PUT). Called after every `confirmedDoc` advance
	 *  so the invariant holds. The humanUncommitted delta is captured BEFORE
	 *  the fold (from the store's current displayed doc) so a concurrent local
	 *  edit isn't lost. */
	function refoldDisplayed(humanDelta: Mutation[]): void {
		const target = produce(localBase(), (draft) => {
			applyBatch(draft, humanDelta);
		});
		// Short-circuit when the fold already equals the displayed doc — the solo
		// hot path (an echo with no pending peer edit + no human delta) owes
		// nothing, so skip the whole-doc `commitDoc` (which would churn the store
		// subscriber + the auto-save watermark for no change).
		const delta = diffDocsToMutations(
			toPersistableDoc(displayed()) as BlueprintDoc,
			toPersistableDoc(target) as BlueprintDoc,
		);
		if (delta.length === 0) return;
		const store = docStore.getState();
		store.beginRemoteApply();
		try {
			store.commitDoc(target);
		} finally {
			store.endRemoteApply();
		}
	}

	/** Structural-change wrapper that upholds the invariant: capture the human
	 *  delta relative to the CURRENT `localBase` (which still includes whatever
	 *  `change` is about to mutate), run the structural `change` (a `sentPending`
	 *  drop), then re-fold `localBase ⊕ human` onto the store — so no code path can
	 *  mutate `sentPending` and leave `displayed` stale. Use this for any
	 *  `sentPending` mutation NOT already followed by a full reseed. */
	function withRefold(change: () => void): void {
		const humanDelta = humanUncommitted();
		change();
		refoldDisplayed(humanDelta);
	}

	// ── Dispatch (human edit → PUT) ──────────────────────────────────────
	function canPut(): boolean {
		return !dormant && !revoked && appId !== undefined;
	}

	function isDormant(): boolean {
		return dormant;
	}

	function dispatchHumanBatch(observe?: SaveObserver): string | undefined {
		if (!canPut()) return undefined;
		const mutations = humanUncommitted();
		if (mutations.length === 0) return undefined;
		const batchId = crypto.randomUUID();
		const batch: SentBatch = {
			batchId,
			mutations,
			sent: false,
			putInFlight: false,
			echoed: false,
			observe,
		};
		sentPending.push(batch);
		awaitingEcho.add(batchId);
		void sendBatch(batch);
		return batchId;
	}

	/** PUT one `sentPending` batch and route its outcome. Idempotent on the
	 *  server via the P3 `batchDedup` latch, so a retry re-PUTs the same
	 *  batchId safely. */
	async function sendBatch(batch: SentBatch): Promise<void> {
		batch.sent = true;
		batch.putInFlight = true;
		putsInFlight += 1;
		batch.observe?.({ kind: "saving" });
		let outcome: PutOutcome;
		try {
			outcome = await deps.put(batch.batchId, batch.mutations);
		} catch (err) {
			// A thrown PUT (network) is a transient failure — keep the batch in
			// sentPending and let the retry loop re-send it.
			outcome = {
				ok: false,
				kind: "network",
				detail: err instanceof Error ? err.message : String(err),
			};
		} finally {
			batch.putInFlight = false;
			putsInFlight = Math.max(0, putsInFlight - 1);
		}

		// A teardown/revocation that landed while the PUT was in flight makes any
		// further work a no-op (no store write, no reschedule, no reload).
		if (inert()) return;

		if (outcome.ok) {
			// The 200 records the assigned seq but NEVER advances confirmedDoc —
			// the batch leaves sentPending only when its own echo frame returns.
			batch.ackedSeq = outcome.seq;
			batch.observe?.({ kind: "saved" });
			// A FALSE-network re-send of an already-committed batch: the idempotent
			// PUT returns the ORIGINAL seq via `batchDedup`, and if that seq is at
			// or below `baseSeq` the batch is ALREADY in `confirmedDoc` — its echo
			// frame (seq ≤ baseSeq) was already dropped by `onFrame`, so no future
			// echo will drop it. Drop it here (and REFOLD — the dropped batch may
			// have held a stale LOCAL value for a slot `confirmedDoc` now holds a
			// peer's newer value for; without the refold the stale value survives in
			// `displayed` and the next autosave re-PUTs it, clobbering the peer's
			// edit and inverting commit order) or it double-folds forever.
			if (outcome.seq <= baseSeq) withRefold(() => dropBatch(batch.batchId));
			// A reload deferred behind THIS PUT now runs (putsInFlight is 0).
			maybeRunDeferredReload();
			return;
		}
		if (outcome.kind === "conflict") {
			// A 409 is terminal for THIS batch: its delta can't apply to fresh
			// state. Reconcile via reload, dropping this specific batchId so it
			// isn't re-folded + re-sent into the same 409.
			rejectedBatchId = batch.batchId;
			batch.observe?.({ kind: "conflict" });
			deps.onConflictReload?.();
			requestReload();
			return;
		}
		if (outcome.kind === "reauth") {
			// Terminal authz denial — a reload grants no membership. Freeze the
			// canvas the same way revocation does; surface it.
			revoked = true;
			batch.observe?.({ kind: "reauth" });
			cancelRetry?.();
			cancelRetry = undefined;
			deps.onReauthDenied?.();
			return;
		}
		if (outcome.kind === "permanent") {
			// A 400 "Invalid mutations": the client commit gate PASSED but the
			// server refused — a genuine client↔server gate disagreement (a bug).
			// Re-sending re-hits it forever, and dropping ONLY this batch would
			// SILENTLY lose a dependent later batch (a B2 editing a field B1 added
			// no-ops once B1 is gone, with no error). So this is TERMINAL, not a
			// drop-one: FREEZE the reconciler (like revocation — no more PUTs,
			// ignore frames), stop the retry loop, surface a terminal "these edits
			// couldn't be saved — reload to continue" state, and report it. The user
			// reloads to a clean server-known-good state; the whole doomed local
			// stack is discarded at once — no silent partial application.
			revoked = true;
			reloadPending = false;
			cancelRetry?.();
			cancelRetry = undefined;
			batch.observe?.({ kind: "permanent" });
			deps.onSaveError?.(
				`auto-save PUT permanently rejected — ${outcome.detail ?? "400"}`,
			);
			return;
		}
		if (outcome.kind === "tooLarge") {
			// A 413 — the accumulated unsaved delta exceeds the request cap.
			// Retrying the same body won't shrink it, so STOP the retry loop (no
			// 413-storm) and surface it — but do NOT freeze or discard the edits.
			// The batch stays in `sentPending` (the display is unchanged); a reload
			// is the user's explicit choice, not an automatic data-drop. Report it.
			cancelRetry?.();
			cancelRetry = undefined;
			batch.observe?.({ kind: "tooLarge" });
			deps.onSaveError?.(
				`auto-save PUT too large — ${outcome.detail ?? "413"}`,
			);
			return;
		}
		// notFound (404) / network / 5xx / recoverable 401: leave the batch in
		// sentPending
		// (localBase keeps folding it) and re-send it via the dedicated retry
		// loop — the diff path won't re-emit it (it's already in localBase).
		// Idempotent via batchDedup. A 404 additionally surfaces the "changes
		// aren't being saved" warning but keeps retrying (a re-promotion /
		// transient 404 self-recovers on the next successful save). A network /
		// 5xx failure is reported to the observability channel (deduped per-app)
		// so an app-wide save outage isn't invisible.
		batch.observe?.({
			kind: outcome.kind === "notFound" ? "notFound" : "error",
		});
		if (outcome.kind === "network") {
			deps.onSaveError?.(
				`auto-save PUT failed — ${outcome.detail ?? "network"}`,
			);
		}
		scheduleRetryLoop();
		// A reload deferred behind this PUT must still run even though the PUT
		// FAILED — otherwise it strands until a later re-send happens to 200.
		maybeRunDeferredReload();
	}

	// ── Recovery tick (network/5xx re-send AND a stranded reload) ─────────
	//
	// One backoff tick drives BOTH recovery paths: re-sending failed PUTs and
	// re-attempting a reload whose GET (or whose deferral) is still pending. A
	// quiet tab with no un-acked batch but a failed reload GET has nothing to
	// re-send — the tick must still retry the reload, or the tab is frozen at a
	// stale `baseSeq` forever (peer edits never arrive).
	function scheduleRetryLoop(): void {
		if (cancelRetry) return; // already scheduled
		cancelRetry = deps.scheduleRetry(retryAttempt, runRetry);
	}

	function runRetry(): void {
		cancelRetry = undefined;
		if (inert()) return;
		retryAttempt += 1;

		// Re-send failed batches FIRST, THEN attempt a stranded reload. Ordering is
		// load-bearing: a re-send bumps `putsInFlight`, so a pending reload defers
		// behind it (`maybeRunDeferredReload` returns while a PUT is in flight) —
		// never a reload GET mid-PUT, which the `putsInFlight` guard exists to
		// prevent. `putInFlight` excludes a batch still in its first (or a prior
		// retry's) flight, so the loop never fires a second concurrent PUT for one
		// already open. `rejectedBatchId` is EXCLUDED: a 409'd batch is awaiting the
		// deferred reload that drops it — re-sending it before then just re-409s in
		// a storm (the exact re-send the `rejectedBatchId` break exists to prevent).
		const toResend = sentPending.filter(
			(b) =>
				b.sent &&
				!b.putInFlight &&
				b.ackedSeq === undefined &&
				!b.echoed &&
				b.batchId !== rejectedBatchId,
		);
		for (const b of toResend) void sendBatch(b);

		// Now attempt a stranded reload — a failed reload GET (or one deferred
		// behind a PUT that then failed) re-armed `reloadPending`. If a re-send is
		// now in flight this defers behind it (runs on the PUT's resolution); with
		// nothing to re-send `putsInFlight` is 0 and it runs immediately. A quiet
		// tab (a gap frame, no local edit) recovers via this path alone.
		if (reloadPending) maybeRunDeferredReload();

		// Reschedule while anything is still outstanding — a batch awaiting a
		// re-send/response, or a reload still pending. `reloadInFlight` is NOT a
		// reschedule reason: `runReload` runs its own coalesced follow-up on
		// completion, so a tick churning through a slow reload GET does nothing.
		const outstanding =
			reloadPending ||
			sentPending.some((b) => b.ackedSeq === undefined && !b.echoed);
		if (outstanding) scheduleRetryLoop();
		else retryAttempt = 0;
	}

	// ── Inbound frame ────────────────────────────────────────────────────
	function isEcho(frame: MutationFrame): boolean {
		if (awaitingEcho.has(frame.batchId)) return true;
		// A chat frame from THIS user's active run. A runId-less frame from
		// another tab of the same user is REMOTE (two tabs share one actorId).
		return (
			frame.actorId === selfUserId &&
			frame.runId != null &&
			frame.runId === selfActiveRunId
		);
	}

	function onFrame(frame: MutationFrame): void {
		if (inert()) return;
		// A reload is mid-flight (its GET is in the air, or it is deferred behind a
		// PUT). Applying a frame now would advance `confirmedDoc`/`baseSeq` only
		// for the reload to overwrite them from a snapshot that may be BEHIND the
		// frame — regressing `baseSeq` and discarding the committed change. Instead
		// re-arm `reloadPending`: the authoritative reload sets `baseSeq = M`, and
		// if this frame's seq is past M the post-reload resubscribe re-trips the
		// gap check and a follow-up reload folds it in. No frame is lost; `baseSeq`
		// stays monotonic.
		if (reloadInFlight || reloadPending) {
			reloadPending = true;
			return;
		}
		// A stale/duplicate echo the client already folded — drop silently, no
		// reload, no re-apply.
		if (frame.seq <= baseSeq) return;
		// A true gap — the client missed one or more seqs; replay is impossible.
		if (frame.seq > baseSeq + 1) {
			requestReload();
			return;
		}
		// seq === baseSeq + 1: the contiguous next frame.
		if (isEcho(frame)) applyEcho(frame);
		else applyRemote(frame);
	}

	/** An echo advances confirmedDoc and drops its batch — the change is already
	 *  in `displayed`, so no undo rebase and no full re-fold is owed; but a
	 *  refold keeps the invariant airtight if the human edited since the PUT. */
	function applyEcho(frame: MutationFrame): void {
		const humanDelta = humanUncommitted();
		confirmedDoc = produce(confirmedDoc, (draft) => {
			applyBatch(draft, frame.mutations);
		});
		baseSeq = frame.seq;
		dropBatch(frame.batchId);
		refoldDisplayed(humanDelta);
	}

	/** A remote frame advances confirmedDoc, re-folds sentPending + the human
	 *  delta onto it, and folds the peer's batch through the undo/redo stacks so
	 *  an undo target still carries the merge. */
	function applyRemote(frame: MutationFrame): void {
		const humanDelta = humanUncommitted();
		confirmedDoc = produce(confirmedDoc, (draft) => {
			applyBatch(draft, frame.mutations);
		});
		baseSeq = frame.seq;
		// Fold the remote batch through the undo history: a past/future recorded
		// state gains the peer's change so undo doesn't snap it back out.
		docStore.getState().rebaseHistory((state) =>
			produce(state, (draft) => {
				applyBatch(draft, frame.mutations);
			}),
		);
		refoldDisplayed(humanDelta);
	}

	function dropBatch(batchId: string): void {
		const idx = sentPending.findIndex((b) => b.batchId === batchId);
		if (idx >= 0) {
			sentPending[idx].echoed = true;
			sentPending.splice(idx, 1);
		}
		awaitingEcho.delete(batchId);
	}

	// ── Reload reconciliation ────────────────────────────────────────────
	function requestReload(): void {
		if (inert()) return;
		reloadPending = true;
		maybeRunDeferredReload();
	}

	/** Run the deferred reload once no PUT is in flight AND none is already
	 *  running — so it never GETs mid-PUT (dropping a batch the server is about
	 *  to accept + echo) and never starts a SECOND concurrent reload (which would
	 *  double-resubscribe + clear `rejectedBatchId` out from under the first). */
	function maybeRunDeferredReload(): void {
		if (!reloadPending || inert()) return;
		if (putsInFlight > 0) return;
		if (reloadInFlight) return; // coalesce — the running reload picks it up
		reloadPending = false;
		reloadInFlight = true;
		void runReload();
	}

	async function runReload(): Promise<void> {
		let reloaded: ReloadedDoc;
		try {
			reloaded = await deps.reload();
		} catch (err) {
			// The reload GET itself failed — re-arm so the recovery tick retries
			// it (a quiet tab with no un-acked batch recovers on the tick alone),
			// and report the outage to the observability channel (deduped per-app).
			reloadInFlight = false;
			if (!inert()) {
				reloadPending = true;
				deps.onSaveError?.(
					`reconciler reload GET failed — ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
				scheduleRetryLoop();
			}
			return;
		}
		// A teardown during the GET makes the result a no-op: no resubscribe (a
		// leaked EventSource), no write into a torn-down store.
		if (inert()) {
			reloadInFlight = false;
			return;
		}

		const M = reloaded.seq;

		// MONOTONIC GUARD — `baseSeq` never moves backward. If something
		// authoritative advanced `baseSeq` past M while this GET was in flight (a
		// `data-done` reseed landing mid-await — frames are blocked by the reload
		// guard, so only `data-done` can do this), the reloaded snapshot is STALE.
		// Reseeding it would regress `baseSeq` and discard the newer state. Discard
		// the stale reload and run a fresh one at the current `baseSeq` to pick up
		// anything past it.
		if (M < baseSeq) {
			reloadInFlight = false;
			if (!inert()) {
				reloadPending = true;
				maybeRunDeferredReload();
			}
			return;
		}

		const captureHuman = humanUncommitted();

		// Drop (a) every batch acked at or below M (already in the fresh doc) and
		// (b) the specific batchId a 409 rejected (else it re-folds + re-sends →
		// 409 → reload, forever).
		for (let i = sentPending.length - 1; i >= 0; i--) {
			const b = sentPending[i];
			const ackedBelowM = b.ackedSeq !== undefined && b.ackedSeq <= M;
			const isRejected = b.batchId === rejectedBatchId;
			if (ackedBelowM || isRejected) {
				sentPending.splice(i, 1);
				awaitingEcho.delete(b.batchId);
			}
		}
		rejectedBatchId = undefined;

		// Reseed confirmed at M from the fresh blueprint (hydrated so it carries
		// fieldParent + refIndex — commitDoc overlays exactly the target's keys),
		// re-fold the remaining un-acked batches + the captured human delta, clear
		// undo, and resubscribe at M. Reseed via a suppressed commitDoc — NOT
		// `load()`, which would trip the open-bracket assert if a reload lands
		// mid-chat-run (the agent bracket is open then).
		confirmedDoc = hydrateConfirmed(reloaded.blueprint);
		baseSeq = M;
		reseedConfirmed(captureHuman, /* clearUndo */ true);
		deps.resubscribe(M);

		reloadInFlight = false;
		// A frame arrived DURING the GET (it re-armed `reloadPending` rather than
		// applying, keeping `baseSeq` monotonic). Run the coalesced follow-up now
		// so anything past M is picked up — one reload at a time.
		if (reloadPending && !inert()) maybeRunDeferredReload();
	}

	/** Commit an EXPLICIT hydrated doc onto the store inside a remote-apply
	 *  bracket, optionally clearing the undo stacks. Never `load()` — this path
	 *  can run while the agent bracket is open (a reload / data-done reseed), and
	 *  `load()` asserts inside an open bracket. The one bracket-safe write
	 *  primitive every reseed routes through. */
	function reseedStore(target: BlueprintDoc, clearUndo: boolean): void {
		const store = docStore.getState();
		store.beginRemoteApply();
		try {
			store.commitDoc(target);
			if (clearUndo) docStore.temporal.getState().clear();
		} finally {
			store.endRemoteApply();
		}
	}

	/** Overlay the current `confirmedDoc ⊕ sentPending ⊕ humanDelta` onto the
	 *  store inside a remote-apply bracket, optionally clearing the undo stacks
	 *  (a reload / data-done reseed is a new baseline). */
	function reseedConfirmed(humanDelta: Mutation[], clearUndo: boolean): void {
		const target = produce(localBase(), (draft) => {
			applyBatch(draft, humanDelta);
		});
		reseedStore(target, clearUndo);
	}

	function onReloadEvent(): void {
		requestReload();
	}

	function onRevoked(): void {
		revoked = true;
		reloadPending = false;
		cancelRetry?.();
		cancelRetry = undefined;
	}

	// ── Chat wiring ──────────────────────────────────────────────────────
	function registerChatBatch(args: {
		batchId: string;
		runId: string | undefined;
		mutations: Mutation[];
		seq: number;
	}): void {
		// The server already committed this batch (the chat commit is
		// awaited-inline through the guarded writer). Register it so its own
		// stream echo is recognized + dropped, and record its committed seq so a
		// reload / data-done drain can drop it.
		if (dormant) return; // a new build's initial mutations apply directly
		const batch: SentBatch = {
			batchId: args.batchId,
			runId: args.runId,
			mutations: args.mutations,
			ackedSeq: args.seq,
			sent: true,
			putInFlight: false,
			echoed: false,
		};
		sentPending.push(batch);
		awaitingEcho.add(args.batchId);
	}

	function onDataDone(args: { doc: PersistableDoc; seq: number }): void {
		// Same drop-then-refold a reload runs (drop every batch acked at or below
		// the carried seq), but reseed via a SUPPRESSED commitDoc inside a
		// remote-apply bracket + temporal clear — NOT load(), which trips the
		// "load() illegal inside an open bracket" assert (the agent suppression
		// bracket is still open at data-done; endAgentWrite runs only on stream
		// close).
		if (inert()) return;
		// DORMANT data-done (a new build whose `data-app-id` hasn't activated the
		// reconciler yet, or a build that emitted no `data-app-id`): there is no
		// stream, no `sentPending`, and `baseSeq` is meaningless — but the store
		// must still reconcile to the run's final snapshot. Do it BRACKET-SAFE (a
		// suppressed `commitDoc` + temporal clear, never `load()` — the agent
		// suppression bracket is still open at data-done). This is the crash the
		// dispatcher's old `load()` fallback caused.
		if (dormant) {
			reseedStore(hydrateConfirmed(args.doc), /* clearUndo */ true);
			return;
		}
		const M = args.seq;
		// MONOTONIC GUARD — never regress `baseSeq`. A `data-done` carrying a seq at
		// or below the current `baseSeq` is stale (a reload already advanced past
		// it); reseeding would discard the newer state. A reload landing AFTER this
		// reseed is caught by `runReload`'s own monotonic guard, so the
		// onDataDone↔reload race stays monotonic from both sides. The old
		// unconditional `load()` snapped any streaming divergence; preserve that
		// guarantee by re-folding on the early return (cheap — short-circuits when
		// `displayed` already equals `localBase`, which it does once `baseSeq` is
		// ahead + reconciled).
		if (M < baseSeq) {
			refoldDisplayed(humanUncommitted());
			return;
		}
		const captureHuman = humanUncommitted();
		for (let i = sentPending.length - 1; i >= 0; i--) {
			const b = sentPending[i];
			if (b.ackedSeq !== undefined && b.ackedSeq <= M) {
				sentPending.splice(i, 1);
				awaitingEcho.delete(b.batchId);
			}
		}
		confirmedDoc = hydrateConfirmed(args.doc);
		baseSeq = M;
		// Same suppressed reseed a reload runs (commitDoc + clear undo inside a
		// remote-apply bracket) — NOT load(), which would trip the open-bracket
		// assert (the agent suppression bracket is still open at data-done;
		// endAgentWrite runs only on stream close).
		reseedConfirmed(captureHuman, /* clearUndo */ true);
	}

	function setSelfActiveRunId(runId: string | undefined): void {
		selfActiveRunId = runId;
	}

	// ── Bootstrap (new build) ────────────────────────────────────────────
	function activate(args: { appId: string; baseDoc: BlueprintDoc }): void {
		appId = args.appId;
		baseSeq = 0;
		confirmedDoc = normalizeConfirmed(args.baseDoc);
		dormant = false;
	}

	// ── Snapshot + teardown ──────────────────────────────────────────────
	function getSnapshot(): ReconcilerSnapshot {
		return {
			appId,
			dormant,
			baseSeq,
			confirmedDoc,
			sentPending: sentPending.map((b) => ({ ...b })),
			awaitingEcho: new Set(awaitingEcho),
			reloadPending,
			reloadInFlight,
			revoked,
			disposed,
			selfActiveRunId,
		};
	}

	function dispose(): void {
		// Set the flag FIRST so any in-flight reload/PUT promise that resolves
		// after this becomes a no-op (no resubscribe → no leaked EventSource, no
		// commitDoc into a torn-down store, no reschedule).
		disposed = true;
		reloadPending = false;
		cancelRetry?.();
		cancelRetry = undefined;
	}

	return {
		canPut,
		isDormant,
		localBase,
		dispatchHumanBatch,
		registerChatBatch,
		onFrame,
		onReloadEvent,
		onRevoked,
		onDataDone,
		setSelfActiveRunId,
		activate,
		getSnapshot,
		dispose,
	};
}
