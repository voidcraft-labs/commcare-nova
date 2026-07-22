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
 * or a reversible PUT authority/scope response all reconcile by GETting the
 * fresh blueprint + capability tuple at seq `M`, then:
 *   (a) dropping every `sentPending` batch whose `ackedSeq <= M` (its commit is
 *       already folded into the fresh doc), AND
 *   (b) dropping only THE batch a typed semantic `commit_rejected` rejected —
 *       without (b), it re-folds + re-sends into an infinite loop. Access/scope
 *       changes preserve their batch for a possible editor snapshot.
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
import { type BlueprintDocStoreApi, isDocDataKey } from "@/lib/doc/store";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";

/** A projected `mutation` frame off the durable stream (see the `/stream`
 *  route's `send("mutation", …)` — the raw stream row's timestamp is
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
	/** True while a PUT for this batch is currently awaiting its response. The
	 *  send pump treats an in-flight head as blocking, so it never fires a
	 *  second, concurrent PUT for the one already open. */
	putInFlight: boolean;
	/** True once a 413 rejected the batch — re-PUTting the same body can't
	 *  shrink it, so the send pipeline holds behind it (nothing later is sent,
	 *  no dependent 409 churn) while the batch stays folded into `localBase()`
	 *  (the edits are KEPT; the user's explicit reload is the only discard). */
	tooLarge: boolean;
	/** Save-lifecycle observer for a human batch (drives the save indicator).
	 *  Absent on a chat batch (registered already-committed). */
	observe?: SaveObserver;
}

/** The result of a PUT: `{ seq }` on 200, or a tagged failure. Capability and
 *  scope failures preserve the batch and trigger an authoritative GET; a PUT
 *  response alone never proves view revocation. */
export type PutOutcome =
	| { ok: true; seq: number }
	/** The delta is semantically invalid against the fresh server doc. This is
	 *  the ONLY outcome that drops its batch after the authoritative reload. */
	| { ok: false; kind: "commitRejected" }
	/** The app moved Projects while this request was in flight. */
	| { ok: false; kind: "scopeChanged" }
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

/** A save-lifecycle signal `useAutoSave` renders as status.
 *  The reconciler fires it to the observer passed on `dispatchHumanBatch`. */
export type SaveSignal =
	| { kind: "saving" }
	| { kind: "saved" }
	| { kind: "conflict" }
	/** A reversible access/scope transition. Autosave releases its in-flight
	 *  indicator while the batch remains preserved for the atomic GET. */
	| { kind: "accessChanged" }
	/** The server permanently rejected the batch (a 400 "Invalid mutations");
	 *  saving is frozen. `useAutoSave` shows a terminal "reload to continue"
	 *  error. */
	| { kind: "permanent" }
	/** The unsaved delta is too large (413); the retry loop stops but the edits
	 *  are kept. `useAutoSave` surfaces a "too large — reload" error. */
	| { kind: "tooLarge" }
	| { kind: "error" };

/** Observe the lifecycle of one dispatched human batch (save indicator). */
export type SaveObserver = (signal: SaveSignal) => void;

/** Authorization tuple returned in the same transaction as a blueprint. */
export interface AuthorizedAccessSnapshot {
	readonly projectId: string;
	readonly role: string;
	readonly canEdit: boolean;
}

/** The authoritative outcome of the reload GET. PUT responses never prove
 *  revocation; only this view check (or the stream's confirmed revoked frame)
 *  may enter the terminal state. */
export type ReloadOutcome =
	| ({
			readonly kind: "authorized";
			readonly blueprint: PersistableDoc;
			readonly seq: number;
	  } & AuthorizedAccessSnapshot)
	| { readonly kind: "revoked" };

/** Injectable side effects — a real provider wires the network/timers; tests
 *  supply synchronous fakes so the state machine runs headless. */
export interface ReconcilerDeps {
	/** PUT `{ mutations, batchId }` to `/api/apps/{appId}`. */
	put: (batchId: string, mutations: Mutation[]) => Promise<PutOutcome>;
	/** GET the fresh blueprint + head seq for a reload. */
	reload: () => Promise<ReloadOutcome>;
	/** Live capability gate from BuilderSession. */
	canEdit: () => boolean;
	/** Resubscribe the durable stream at `cursor` (the reconciler calls this
	 *  after a reload lands so frames in `(oldCursor, M]` don't re-trip the
	 *  gap check). The provider re-opens the EventSource; a solo test no-ops. */
	resubscribe: (cursor: number) => void;
	/** Schedule the retry loop's next tick (backoff). Returns a canceller.
	 *  The provider uses `setTimeout`; tests drive it manually. */
	scheduleRetry: (attempt: number, run: () => void) => () => void;
	/** Announce a terminal 409 to the user ("this app changed…"). */
	onConflictReload?: () => void;
	/** Pause editing and synchronously reset Project-scoped client state. Must
	 *  be idempotent while one serialized reload is already pending/in flight. */
	/** Return `false` when any tenant cache failed to clear; the reconciler then
	 *  fails closed instead of loading a new scope over retained old data. */
	beginAccessRefresh?: () => boolean;
	/** A retryable GET failure: remain paused and communicate reconnection. */
	markAccessReconnecting?: () => void;
	/** Install the tuple carried by a successful authoritative GET. */
	applyAccessSnapshot?: (
		snapshot: AuthorizedAccessSnapshot,
		options: { hasWaitingChanges: boolean },
	) => void;
	/** Confirmed loss of view access. */
	onViewRevoked?: () => void;
	/** The one-shot hard refresh was already attempted, but this compiled stream
	 *  receiver is still below the server floor. */
	onClientUpgradeRequired?: () => void;
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
	 *  the batch's save lifecycle (saving → saved / conflict / accessChanged /
	 *  error), including retry re-sends. Returns the minted batchId
	 *  (or undefined when nothing was sent). */
	dispatchHumanBatch(observe?: SaveObserver): string | undefined;
	/** Register a chat-SA batch the server just committed (from the
	 *  `data-mutations` handler) so its own stream echo is recognized and
	 *  dropped, and its committed seq lets a reload drop it. Returns
	 *  `alreadyConfirmed: true` when the batch's echo already beat this call and
	 *  folded these mutations into `confirmedDoc` + `displayed` — the dispatcher
	 *  must then SKIP its `applyMany`, or the non-dedup add reducers apply the
	 *  batch to the store a second time (a duplicated entity). */
	registerChatBatch(args: {
		batchId: string;
		runId: string | undefined;
		mutations: Mutation[];
		seq: number;
	}): { alreadyConfirmed: boolean };
	/** Handle one inbound `mutation` frame. */
	onFrame(frame: MutationFrame): void;
	/** Handle an `event: reload` (retention/migration sentinel). */
	onReloadEvent(): void;
	/** Handle an `event: revoked` — freeze; cancel any pending reload. */
	onRevoked(): void;
	/** Freeze for a receiver-version mismatch without mislabeling it as an
	 *  authorization loss. */
	onClientUpgradeRequired(): void;
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
	/**
	 * Drop the recovery machine's scheduled-tick latch — the provider's effect
	 * cleanup (`suspend`) clears the backing timers DIRECTLY, and without this
	 * the reconciler's `cancelRetry` would stay truthy pointing at a cleared
	 * timer, wedging `scheduleRetryLoop`'s "already scheduled" early-return
	 * forever after a StrictMode-replay resume.
	 */
	suspendRecovery(): void;
	/**
	 * Re-arm the recovery machine after a `suspendRecovery` (the provider's
	 * effect setup): schedules a tick if outstanding work survived the suspend
	 * window (an un-acked batch, a pending reload). No-op when idle.
	 */
	resumeRecovery(): void;
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
		if (!isDocDataKey(k, v)) continue;
		clean[k] = v;
	}
	return clean as unknown as BlueprintDoc;
}

export function createReconciler(
	docStore: BlueprintDocStoreApi,
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
	/** True when the freeze was a PERMANENT 400 rejection (a client↔server gate
	 *  disagreement), not an authz revocation — the two share the `revoked`
	 *  no-more-PUTs machinery but must surface DIFFERENT terminal signals: a
	 *  post-freeze edit warns "reload to continue", never the false "your edit
	 *  access may have been removed". */
	let frozenPermanently = false;
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
		return !dormant && !revoked && appId !== undefined && deps.canEdit();
	}

	function isDormant(): boolean {
		return dormant;
	}

	function dispatchHumanBatch(observe?: SaveObserver): string | undefined {
		if (!canPut()) {
			// A member REVOKED via the cadence `revoked` frame (`onRevoked` just sets
			// `revoked`) — or a
			// PERMANENT 400 freeze (which rides the same no-more-PUTs flag). Without
			// this, a subsequent edit hits `canPut() === false` and returns SILENTLY:
			// no PUT, no observer signal → `useAutoSave` shows no "Save failed" and
			// the member keeps editing edits that never persist. Emit the matching
			// TERMINAL signal so `useAutoSave` surfaces the right persistent toast:
			// `permanent` ("reload to continue") for the 400 freeze, `accessChanged`
			// for a real revocation — a permanent-frozen user must not be sent chasing
			// phantom permission problems. Each
			// signal's once-per-episode gating in `useAutoSave` means repeated
			// post-freeze edits toast once. Only for a real freeze with an actual
			// unsaved delta; dormant / no-appId stay clean no-ops.
			if (revoked && appId !== undefined && humanUncommitted().length > 0) {
				observe?.({
					kind: frozenPermanently ? "permanent" : "accessChanged",
				});
			}
			return undefined;
		}
		// A 413-stuck batch holds the pipeline: minting more batches behind it
		// would either never send or 409-churn (each is diffed against a
		// localBase the server can't reach). The delta stays in
		// `humanUncommitted` (kept + rendered); re-surface the terminal signal
		// so the indicator stays in its "too large — reload" state.
		if (sentPending.some((b) => b.tooLarge)) {
			if (humanUncommitted().length > 0) observe?.({ kind: "tooLarge" });
			return undefined;
		}
		const mutations = humanUncommitted();
		if (mutations.length === 0) return undefined;
		const batchId = crypto.randomUUID();
		const batch: SentBatch = {
			batchId,
			mutations,
			putInFlight: false,
			tooLarge: false,
			observe,
		};
		sentPending.push(batch);
		awaitingEcho.add(batchId);
		pumpSend();
		return batchId;
	}

	/**
	 * The single-flight, IN-ORDER send pipeline. Stacked batches are dependent
	 * by construction (each is diffed against a `localBase` that already folds
	 * its predecessors), so two un-acked batches must never race over the wire —
	 * two PUTs landing on different instances commit in arbitrary order, and the
	 * later-diffed batch then 409s on entities its predecessor hadn't created
	 * yet (a silent drop with no real conflict). The pump sends ONLY the first
	 * un-acked, un-echoed batch (in `sentPending` order); everything behind it
	 * waits for its ack. An ACKED batch (committed — only its echo is pending)
	 * doesn't block: the server already holds it, so a successor's PUT is safe.
	 * A 409-rejected batch is the deferred reload's to drop, and a 413 batch
	 * blocks the pipeline (see `SentBatch.tooLarge`).
	 */
	function pumpSend(): void {
		if (inert() || !deps.canEdit()) return;
		// A reload is the pipeline's synchronization barrier: it drops the
		// 409-rejected batch (and everything acked at or below M), re-folds the
		// survivors onto the fresh doc, and only then does sending resume (the
		// reload's own completion pumps). Sending into a state the reload is
		// about to replace would race the very reconciliation it exists for.
		if (reloadPending || reloadInFlight) return;
		for (const b of sentPending) {
			if (b.ackedSeq !== undefined) continue;
			if (b.batchId === rejectedBatchId) continue;
			// The head of the un-acked pipeline: in flight or 413-stuck → wait;
			// otherwise send it (first flight, or a retry-tick re-send).
			if (b.putInFlight || b.tooLarge) return;
			void sendBatch(b);
			return;
		}
	}

	/** PUT one `sentPending` batch and route its outcome. Idempotent on the
	 *  server via the P3 `batchDedup` latch, so a retry re-PUTs the same
	 *  batchId safely. */
	async function sendBatch(batch: SentBatch): Promise<void> {
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
			// The pipeline head just acked — the next queued batch may fly.
			pumpSend();
			// A reload deferred behind THIS PUT now runs (putsInFlight is 0).
			maybeRunDeferredReload();
			return;
		}
		if (outcome.kind === "commitRejected") {
			// A 409 is terminal for THIS batch: its delta can't apply to fresh
			// state. Reconcile via reload, dropping this specific batchId so it
			// isn't re-folded + re-sent into the same 409.
			rejectedBatchId = batch.batchId;
			batch.observe?.({ kind: "conflict" });
			deps.onConflictReload?.();
			requestReload();
			return;
		}
		if (
			outcome.kind === "reauth" ||
			outcome.kind === "scopeChanged" ||
			outcome.kind === "notFound"
		) {
			// A PUT can only prove that this write's authority is stale. Preserve
			// the batch, pause further PUTs immediately, and let one atomic GET decide
			// whether the user is a viewer, an editor in a new Project, or revoked.
			batch.observe?.({ kind: "accessChanged" });
			requestReload();
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
			// `frozenPermanently` keeps this freeze's TERMINAL SIGNAL distinct from
			// a revocation's: a post-freeze edit re-surfaces `permanent` ("reload to
			// continue"), never the false "edit access removed" warning.
			revoked = true;
			frozenPermanently = true;
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
			// Retrying the same body won't shrink it, so mark the batch 413-stuck
			// (the pump never re-sends it and holds everything behind it — no
			// 413-storm, no dependent 409 churn) and surface it — but do NOT freeze
			// or discard the edits. The batch stays in `sentPending` (the display
			// is unchanged); a reload is the user's explicit choice, not an
			// automatic data-drop. Report it. The SHARED recovery machinery keeps
			// running: this is a live (non-frozen) PUT resolution, so it must still
			// run a deferred reload — a reload armed behind this PUT would
			// otherwise strand, and `onFrame` would swallow every subsequent peer
			// frame against the armed `reloadPending` forever.
			batch.tooLarge = true;
			batch.observe?.({ kind: "tooLarge" });
			deps.onSaveError?.(
				`auto-save PUT too large — ${outcome.detail ?? "413"}`,
			);
			maybeRunDeferredReload();
			return;
		}
		// Network / 5xx / recoverable 401: leave the batch in
		// sentPending
		// (localBase keeps folding it) and re-send it via the dedicated retry
		// loop — the diff path won't re-emit it (it's already in localBase).
		// Idempotent via batchDedup. The failure is reported to the observability
		// channel (deduped per-app)
		// so an app-wide save outage isn't invisible.
		batch.observe?.({ kind: "error" });
		deps.onSaveError?.(`auto-save PUT failed — ${outcome.detail ?? "network"}`);
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

		// The pump and the reload attempt are mutually exclusive per tick: with a
		// reload pending/in-flight the pump HOLDS (the reload barrier — see
		// `pumpSend`) and the stranded reload runs below; with none pending the
		// pump re-sends the HEAD of the un-acked pipeline (stacked batches are
		// dependent, so they must land in order), skipping one already in flight,
		// the `rejectedBatchId` (a 409'd batch is awaiting the reload that drops
		// it — re-sending it just re-409s in a storm), and a 413-stuck batch.
		pumpSend();

		// Now attempt a stranded reload — a failed reload GET (or one deferred
		// behind a PUT that then failed) re-armed `reloadPending`. If a re-send is
		// now in flight this defers behind it (runs on the PUT's resolution); with
		// nothing to re-send `putsInFlight` is 0 and it runs immediately. A quiet
		// tab (a gap frame, no local edit) recovers via this path alone.
		if (reloadPending) maybeRunDeferredReload();

		// Reschedule while anything is still outstanding; reset the backoff when
		// nothing is.
		if (hasOutstandingRecovery()) scheduleRetryLoop();
		else retryAttempt = 0;
	}

	/**
	 * Whether the recovery machine still has work a tick could advance: a
	 * pending reload, or an un-acked batch the pump can (eventually) re-send.
	 * `reloadInFlight` is NOT outstanding — `runReload` runs its own coalesced
	 * follow-up on completion, so a tick churning through a slow reload GET
	 * does nothing. A 413-stuck batch holds the whole pipeline — neither it NOR
	 * anything queued behind it is sendable — so a held pipeline contributes
	 * nothing (counting a follower would spin the backoff loop forever over a
	 * tick whose pump returns at the stuck head).
	 */
	function hasOutstandingRecovery(): boolean {
		if (reloadPending) return true;
		if (!deps.canEdit()) return false;
		if (sentPending.some((b) => b.tooLarge)) return false;
		return sentPending.some((b) => b.ackedSeq === undefined);
	}

	// ── Inbound frame ────────────────────────────────────────────────────
	function isEcho(frame: MutationFrame): boolean {
		if (awaitingEcho.has(frame.batchId)) return true;
		// A CHAT frame from THIS user's active run. A runId-less frame from
		// another tab of the same user is REMOTE (two tabs share one actorId) —
		// and so is an MCP frame even when it CARRIES this run id: MCP's
		// deriveRunId CONTINUES the app's stored run_id inside a sliding window,
		// so a same-user MCP edit made after a chat run re-uses that run's id.
		// Its mutations were never applied to this tab's store, so classifying
		// it as an echo would skip both the apply-refold and the undo rebase —
		// the next Ctrl+Z would silently revert the committed MCP change. Only
		// `kind: "chat"` frames can be this tab's run echoes.
		return (
			frame.kind === "chat" &&
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
		if (idx >= 0) sentPending.splice(idx, 1);
		awaitingEcho.delete(batchId);
	}

	// ── Reload reconciliation ────────────────────────────────────────────
	function requestReload(): void {
		if (inert()) return;
		if (deps.beginAccessRefresh?.() === false) {
			onRevoked();
			return;
		}
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
		let reloaded: ReloadOutcome;
		try {
			reloaded = await deps.reload();
		} catch (err) {
			// The reload GET itself failed — re-arm so the recovery tick retries
			// it (a quiet tab with no un-acked batch recovers on the tick alone),
			// and report the outage to the observability channel (deduped per-app).
			reloadInFlight = false;
			if (!inert()) {
				deps.markAccessReconnecting?.();
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
		if (reloaded.kind === "revoked") {
			reloadInFlight = false;
			onRevoked();
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
		reloadInFlight = false;
		// A frame arrived DURING the GET (it re-armed `reloadPending` rather than
		// applying, keeping `baseSeq` monotonic). Run the coalesced follow-up now
		// so anything past M is picked up — one reload at a time, no intermediate
		// stream, and editing stays paused. Only the final snapshot publishes its
		// capability tuple and owns the one replacement stream.
		if (reloadPending && !inert()) {
			maybeRunDeferredReload();
			return;
		}
		const hasWaitingChanges =
			sentPending.length > 0 || humanUncommitted().length > 0;
		deps.applyAccessSnapshot?.(
			{
				projectId: reloaded.projectId,
				role: reloaded.role,
				canEdit: reloaded.canEdit,
			},
			{ hasWaitingChanges },
		);
		deps.resubscribe(M);
		// The barrier is down: resume a preserved un-acked batch immediately when
		// edit access survived, rather than waiting for a backoff tick.
		pumpSend();
		/* `humanUncommitted` may never have entered `sentPending`: an autosave
		 * trailing tick can fire while access is paused and legitimately decline.
		 * A successful editor snapshot is therefore an active recovery edge — mint
		 * that remaining delta now instead of waiting for another keystroke. */
		if (reloaded.canEdit && humanUncommitted().length > 0) {
			dispatchHumanBatch();
		}
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
		if (revoked) return;
		revoked = true;
		reloadPending = false;
		cancelRetry?.();
		cancelRetry = undefined;
		deps.onViewRevoked?.();
	}

	function onClientUpgradeRequired(): void {
		if (revoked) return;
		revoked = true;
		reloadPending = false;
		cancelRetry?.();
		cancelRetry = undefined;
		deps.onClientUpgradeRequired?.();
	}

	// ── Chat wiring ──────────────────────────────────────────────────────
	function registerChatBatch(args: {
		batchId: string;
		runId: string | undefined;
		mutations: Mutation[];
		seq: number;
	}): { alreadyConfirmed: boolean } {
		// The server already committed this batch (the chat commit is
		// awaited-inline through the guarded writer). Register it so its own
		// stream echo is recognized + dropped, and record its committed seq so a
		// reload / data-done drain can drop it.
		if (dormant) return { alreadyConfirmed: false }; // a new build applies direct
		// The batch's echo can beat its `data-mutations` chunk here — the commit
		// writes the durable stream (→ the /stream echo frame) BEFORE the chat
		// chunk is written, two independent transports. If the echo landed first, `onFrame`
		// already classified it (actorId + active runId) as an echo and `applyEcho`
		// folded these mutations into `confirmedDoc` (advancing `baseSeq` to this
		// seq) AND into `displayed` (its `refoldDisplayed`). Registering the batch
		// now would fold the SAME mutations a SECOND time through `localBase()`, and
		// re-applying them to the store (the caller's `applyMany`) would splice the
		// non-dedup add reducers' uuid twice — a duplicated entity. Mirror
		// `onFrame`'s stale-drop: a seq already confirmed is in `confirmedDoc` +
		// `displayed` already — nothing to register, and the caller MUST skip its
		// `applyMany`.
		if (args.seq <= baseSeq) return { alreadyConfirmed: true };
		const batch: SentBatch = {
			batchId: args.batchId,
			runId: args.runId,
			mutations: args.mutations,
			ackedSeq: args.seq,
			putInFlight: false,
			tooLarge: false,
		};
		sentPending.push(batch);
		awaitingEcho.add(args.batchId);
		return { alreadyConfirmed: false };
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
		// suppression bracket is still open at data-done, and `load()` asserts
		// inside an open bracket).
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

	function suspendRecovery(): void {
		cancelRetry?.();
		cancelRetry = undefined;
	}

	function resumeRecovery(): void {
		if (inert()) return;
		// Drop any latch acquired DURING the suspend window first: a PUT/reload
		// continuation resolving while the provider is suspended stores the
		// inactive scheduler's no-op canceller, and `scheduleRetryLoop`'s
		// "already scheduled" early-return would wedge on that stale truthy latch.
		cancelRetry?.();
		cancelRetry = undefined;
		if (hasOutstandingRecovery()) scheduleRetryLoop();
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
		onClientUpgradeRequired,
		onDataDone,
		setSelfActiveRunId,
		activate,
		getSnapshot,
		suspendRecovery,
		resumeRecovery,
		dispose,
	};
}
