/**
 * BlueprintDoc Zustand store factory.
 *
 * Middleware stack (outer → inner):
 *   devtools               Redux-DevTools inspection, named "BlueprintDoc"
 *   subscribeWithSelector  fine-grained subscriptions used by domain hooks
 *   immer                  structural-sharing mutable-syntax updates
 *
 * Undo is a COMMAND LOG.
 *   Every authored write records `{ forward, inverse }` — the batch applied,
 *   and the batch that takes the document back. Undo applies the inverse
 *   through the ordinary write path, so it queues for persistence like any
 *   other edit; redo applies the forward batch the same way.
 *
 *   A command carries its own anchors — "put X after Y" — so a peer's
 *   concurrent insert cannot move where an undo lands, and the history needs no
 *   rebasing when a remote frame arrives.
 *
 * The store is created via a factory function so each builder mount gets
 * its own isolated store instance. `<BlueprintDocProvider>` calls this
 * factory at mount time and exposes the instance via React context.
 *
 * Suppression depth — the store owns undo tracking, not its callers.
 *   The store holds a `suppressionDepth` counter: a write becomes an undo step
 *   only at depth 0. `beginAgentWrite`/`beginRemoteApply` increment it and
 *   `endAgentWrite`/`endRemoteApply` decrement it; the provider decrements once
 *   after `load()` when the live builder wants tracking.
 *
 *   Depths (depth > 0 ⇒ not an undo step):
 *     - factory init → 1 (no meaningful history at birth).
 *     - after `load()`: the provider decrements to 0 for the live builder;
 *       an agent-stream / replay mount stays at 1.
 *     - `beginAgentWrite` / `beginRemoteApply` ++; the paired end -- .
 *     - `load()` resets the depth to 1 and clears the history; a `load()`
 *       inside an open begin/end bracket is illegal (asserts) — the reset
 *       would desync the counter.
 *
 * Two suppression kinds bracket writes that must stay off the undo history:
 *   - `beginAgentWrite`/`endAgentWrite` — an SA run is one undoable step;
 *     opened at `beginRun`, closed at stream-close.
 *   - `beginRemoteApply`/`endRemoteApply` — a single inbound reconciler
 *     frame's write (an echo/remote apply, a reload re-fold, a `data-done`
 *     reseed). `remoteFrameApplyInProgress` flips true for exactly that
 *     synchronous bracket so `useAutoSave`'s leading edge (which fires
 *     synchronously from the store subscriber) skips re-PUTing a
 *     server-originated change.
 *
 * `replayDepth` counts only the REPLAY brackets, and answers the narrower
 * question persistence asks — "did the author just do this". An SA run is one
 * undo step and none of the author's writes; an edit made while it streams is
 * the author's, and its own step.
 */

import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	rebuildFieldParent,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, Mutation, MutationResult } from "@/lib/doc/types";
import { recordFromEntries } from "@/lib/domain";
import type { PersistableDoc } from "@/lib/domain/blueprint";

export { rebuildFieldParent };

/**
 * The complete public state surface of the BlueprintDoc store.
 *
 * Extends `BlueprintDoc` (pure data) with the action methods that
 * components and engine code call. Separating data from actions here
 * keeps the type as the single source of truth — no need for a separate
 * interface listing only the actions.
 */
export type BlueprintDocState = BlueprintDoc & {
	/**
	 * The ONLY write path into the store.
	 *
	 * Applies every mutation in the array to a single Immer draft inside one
	 * `set()` call, so the whole batch is one history entry regardless of
	 * length — a single user edit and a multi-step agent write are each one
	 * step the author can take back.
	 *
	 * Returns an array of reducer results, one per input mutation, same
	 * order. Most kinds produce `undefined`. `renameField` returns
	 * `FieldRenameMeta` with the XPath rewrite count. `moveField` returns
	 * `MoveFieldResult` with cross-level auto-rename info. Callers that
	 * need metadata destructure the known position; callers that don't
	 * care ignore the return value.
	 */
	applyMany: (muts: Mutation[]) => MutationResult[];
	/**
	 * Commit a gate-validated candidate doc as one undo entry — the
	 * gated-dispatch twin of `applyMany`, called only by
	 * `useBlueprintMutations`' gate with a verdict's `nextDoc` (produced
	 * by the same reducer). See the implementation note for why this
	 * exists instead of a second `applyMany` run.
	 */
	commitDoc: (next: BlueprintDoc, commands?: readonly Mutation[]) => void;
	/**
	 * The commands dispatched since the last take, in order, and clear them.
	 *
	 * The builder KNOWS what the author did — every write surface hands the
	 * store the exact `Mutation[]` — so the store keeps it rather than
	 * re-deriving it later by diffing two documents.
	 *
	 * A write enters the queue when it is the AUTHOR's, which is narrower than
	 * "is this an undo step". Recording is gated on the REPLAY bracket
	 * (`beginRemoteApply`) alone: every write the author did not just make — an
	 * inbound remote frame, a reload reseed, an SA stream frame — arrives inside
	 * one, and nothing else does. An edit made while an SA run streams is the
	 * author's and queues normally.
	 *
	 * The reconciler takes the queue when it PUTs: from that moment the batch
	 * is its business, tracked in `sentPending` until the server echoes it.
	 */
	takeCommands: () => Mutation[];
	/** The queue without clearing it — for deciding whether there is anything
	 *  to save. */
	peekCommands: () => readonly Mutation[];
	/**
	 * Replace the entire doc from a `PersistableDoc` (the persisted shape that
	 * omits `fieldParent`).
	 *
	 * Accepts the normalized doc shape directly. `fieldParent` is always
	 * rebuilt from `fieldOrder`, so callers never need to supply it.
	 *
	 * Does NOT create an undo entry — a load is session hydration, not a user
	 * edit. Clears the history and the command queue, and re-arms the birth
	 * pause; callers wanting undo live call `startTracking()` afterward.
	 */
	load: (doc: PersistableDoc) => void;
	/**
	 * Open an agent-write suppression bracket before an SA run streams.
	 *
	 * Increments `suppressionDepth`; writes while the depth is > 0 take effect
	 * but record no undo entry. Call `endAgentWrite()` at stream-close, so the
	 * whole run is one step the author can take back.
	 */
	beginAgentWrite: () => void;
	/** Close the agent-write bracket (decrements `suppressionDepth`). */
	endAgentWrite: () => void;
	/**
	 * Release the store's one-time birth pause so undo tracking goes live.
	 *
	 * The store is born paused (depth 1) so the initial hydration / generation
	 * doesn't enter history. `startTracking()` drives the depth to 0 exactly
	 * once, when the builder becomes editable: at provider mount for an existing
	 * app, and — for a fresh build (which mounts paused and generates first) —
	 * when its first run ends. Idempotent (a second call no-ops), and DEFERRED
	 * when a suppression bracket is open at the call (a fresh build's `endRun`
	 * closes the agent bracket, so the release rides that bracket close). This
	 * is what makes undo work after a build without a page reload.
	 */
	startTracking: () => void;
	/**
	 * Open a remote-apply suppression bracket for one already-persisted write
	 * arriving from the server: an echo/remote apply, a reload re-fold, a
	 * `data-done` reseed, or an SA stream's `data-mutations` frame.
	 *
	 * This is the REPLAY bracket, and the one signal that says "the author did
	 * not just do this". It increments `suppressionDepth` (no undo entry),
	 * raises `remoteFrameApplyInProgress` so `useAutoSave`'s synchronous leading
	 * edge skips re-PUTing the server-originated change, and keeps the write out
	 * of the command queue so it is never sent back. The caller pairs it with
	 * `endRemoteApply()` in the same synchronous turn.
	 */
	beginRemoteApply: () => void;
	/** Close the remote-apply bracket (decrements `suppressionDepth` and the
	 *  replay depth, and clears `remoteFrameApplyInProgress`). */
	endRemoteApply: () => void;
	/** The batch an `undo()` applies, or `undefined` when the history is empty.
	 *  Callers verdict it through the commit gate before applying. */
	undoBatch: () => Mutation[] | undefined;
	/** The batch a `redo()` applies, or `undefined` when nothing is redoable. */
	redoBatch: () => Mutation[] | undefined;
	/** Apply `undoBatch()` through the ordinary write path, so it queues for
	 *  persistence like any other edit, and move the entry to the redo side. */
	undo: () => void;
	/** The mirror of `undo()`. */
	redo: () => void;
	/** Drop both histories — a new baseline (a reload, a `data-done` reseed) has
	 *  nothing the author can take back. */
	clearHistory: () => void;
	/** Whether `undo()` / `redo()` would do anything. Store state rather than
	 *  closure state so the toolbar re-renders when either flips. */
	canUndo: boolean;
	canRedo: boolean;
	/**
	 * True for exactly the synchronous window a `beginRemoteApply` bracket
	 * is open. Read by `useAutoSave` to gate the re-PUT — a server-applied
	 * frame must not bounce back out as a client save.
	 */
	remoteFrameApplyInProgress: boolean;
};

/**
 * Initial empty document state.
 *
 * Used as the starting value for freshly created stores and as a reset
 * target. All entity maps and order arrays start empty; nullable fields
 * (`connectType`, `caseTypes`) start as `null` to match the blueprint
 * schema (surveys and empty apps may omit them entirely).
 *
 * Identity-keyed records start with null prototypes, matching the post-hydrate
 * and post-mutation invariant before the first write has happened.
 */
const EMPTY_DOC: BlueprintDoc = {
	appId: "",
	appName: "",
	connectType: null,
	caseTypes: null,
	modules: recordFromEntries([]),
	forms: recordFromEntries([]),
	fields: recordFromEntries([]),
	moduleOrder: [],
	formOrder: recordFromEntries([]),
	fieldOrder: recordFromEntries([]),
	fieldParent: recordFromEntries([]),
};

/**
 * Overlay a whole target doc onto the state draft, BLANKING every data key the
 * target no longer carries (a cleared `logo`, a dropped `refIndex`).
 *
 * The blank is `= undefined`, deliberately NOT `delete`: the produced state is
 * shallow-MERGED over the previous one by zustand's top-level `setState`
 * (`Object.assign({}, prev, next)`), so a key deleted on the draft is silently
 * RESURRECTED from `prev` — a reconciler reseed whose server-hydrated target
 * legitimately lacks an optional slot would keep the stale value displayed,
 * and the next autosave diff would re-commit it server-side (un-deleting a
 * peer's clear with no conflict signal). An explicit `undefined` survives the
 * merge, and every reader treats an `undefined` slot as absent (serialization
 * strips it).
 *
 * Skipped: action methods (functions living alongside data on the state) and
 * the store's own bookkeeping flag `remoteFrameApplyInProgress` — a reseed
 * runs INSIDE a remote-apply bracket, and blanking the raised flag would let
 * the synchronous store subscriber bounce the server's own write back out as
 * a PUT (the exact loop the flag exists to prevent).
 */
function overlayDoc(draft: Record<string, unknown>, next: object): void {
	for (const key of Object.keys(draft)) {
		if (!isDocDataKey(key, draft[key])) continue;
		if (!(key in next)) draft[key] = undefined;
	}
	Object.assign(draft, next);
}

/**
 * Whether a store-state key is DOC DATA — as opposed to an action method or
 * the store's own bookkeeping (`remoteFrameApplyInProgress`). The ONE
 * definition every doc-shaped state walker uses: `overlayDoc` above (which
 * must not blank the raised bookkeeping flag mid-bracket) and the
 * reconciler's `normalizeConfirmed` (which must not let bookkeeping leak into
 * `confirmedDoc`) — a future bookkeeping field handled in one but not the
 * other would reopen exactly one of those two failure modes.
 */
export function isDocDataKey(key: string, value: unknown): boolean {
	if (typeof value === "function") return false;
	return key !== "remoteFrameApplyInProgress";
}

/**
 * Create a fresh BlueprintDoc store.
 *
 * Each builder mount gets its own store instance — this is NOT a
 * module-level singleton. History tracking is paused immediately after
 * creation; call `startTracking()` once the builder UI is ready to record
 * user edits.
 */
export function createBlueprintDocStore() {
	// Tracking is live only at depth 0. `openBrackets` is the separate count of
	// currently-open `begin*/end*` pairs — `load()` resets the depth, which is
	// only coherent when no bracket is mid-flight, so it asserts on that.
	//
	// Born at 1: a fresh store has no meaningful history, so it starts paused.
	// `startTracking()` releases that birth pause (depth 1 → 0) exactly once when
	// the builder goes live — for an existing app at provider mount, for a fresh
	// build when its first run ends. `birthPauseReleased` makes it idempotent;
	// `pendingStartTracking` defers the release when a bracket is open at the call
	// (a fresh build's `endRun` closes the agent bracket, so the release rides the
	// bracket close), so undo works after a build without a page reload.
	let suppressionDepth = 1;
	let openBrackets = 0;
	/**
	 * How many replay brackets are open — writes that arrived already persisted
	 * from the server (`beginRemoteApply`).
	 *
	 * Separate from `suppressionDepth` because "is this one undo step" and "did
	 * the author just do this" are different questions. An SA run is one step
	 * for its whole duration, but the author keeps editing the canvas while it
	 * streams, and those edits are theirs to save.
	 */
	let replayDepth = 0;
	/**
	 * The commands the author has dispatched but not yet persisted.
	 *
	 * Session-scoped closure state rather than a doc field: it is not part of
	 * the blueprint and must not serialize. `load` clears it — a hydration
	 * replaces the document these commands describe.
	 */
	let pendingCommands: Mutation[] = [];
	let birthPauseReleased = false;
	let pendingStartTracking = false;
	/**
	 * One authored write, and the write that takes it back.
	 *
	 * `inverse` is derived at dispatch, while both documents are in hand.
	 * Deriving it at undo time instead would need the pre-edit document kept
	 * alongside every entry, which is the whole cost of a snapshot stack.
	 */
	interface HistoryEntry {
		readonly forward: readonly Mutation[];
		readonly inverse: readonly Mutation[];
	}
	let undoStack: HistoryEntry[] = [];
	let redoStack: HistoryEntry[] = [];
	/** True while `undo()`/`redo()` is applying, so the write it performs
	 *  persists like any other edit without becoming a new history entry. */
	let applyingHistory = false;

	// `store` is declared here so the depth helpers and the action closures
	// (`load`, `beginAgentWrite`, `beginRemoteApply`, …) can reference
	// `store.setState` after the store has been fully constructed. JavaScript's
	// closure semantics allow the variable to be captured before its value is
	// assigned — these closures are only *called* at runtime, by which point
	// `store` is fully initialized.

	/** Publish whether either history has anything in it, so the toolbar's
	 *  controls re-render when that flips. */
	function syncHistoryFlags(): void {
		const canUndo = undoStack.length > 0;
		const canRedo = redoStack.length > 0;
		const current = store.getState();
		if (current.canUndo !== canUndo || current.canRedo !== canRedo) {
			store.setState({ canUndo, canRedo });
		}
	}

	function clearHistory(): void {
		undoStack = [];
		redoStack = [];
		syncHistoryFlags();
	}

	/** Release the one-time birth pause (depth 1 → 0) if it hasn't been released
	 *  and no bracket is open. Returns whether it fired. `startTracking()` and
	 *  `closeBracket()` both drive it so the release can ride a bracket close. */
	function maybeReleaseBirthPause(): boolean {
		if (birthPauseReleased || openBrackets > 0 || suppressionDepth !== 1) {
			return false;
		}
		birthPauseReleased = true;
		suppressionDepth = 0;
		return true;
	}

	/** Open a suppression bracket. `remote` also raises
	 *  `remoteFrameApplyInProgress` for the synchronous window. */
	function openBracket(remote: boolean): void {
		suppressionDepth += 1;
		openBrackets += 1;
		if (remote) {
			replayDepth += 1;
			store.setState({ remoteFrameApplyInProgress: true });
		}
	}

	/** Close a suppression bracket opened by `openBracket`. */
	function closeBracket(remote: boolean): void {
		if (remote) store.setState({ remoteFrameApplyInProgress: false });
		suppressionDepth = Math.max(0, suppressionDepth - 1);
		openBrackets = Math.max(0, openBrackets - 1);
		if (remote) replayDepth = Math.max(0, replayDepth - 1);
		// A `startTracking()` that arrived while a bracket was open (a fresh build's
		// first `endRun` closes the agent bracket) releases the birth pause now that
		// no bracket remains — so undo works after a build with no page reload.
		if (pendingStartTracking) {
			pendingStartTracking = false;
			maybeReleaseBirthPause();
		}
	}

	/**
	 * Queue an authored write for persistence.
	 *
	 * Asks "did the author just do this": every write they did not make arrives
	 * inside a REPLAY bracket, and nothing else does — so an edit made while an
	 * SA run streams queues normally.
	 *
	 * MUST run before the `set()` that applies the write. `set()` notifies
	 * subscribers synchronously and `useAutoSave` is one of them, reading the
	 * queue the instant the document changes; a queue filled afterwards leaves
	 * every save one edit behind, and a lone edit unsaved entirely.
	 */
	function queueForPersistence(mutations: readonly Mutation[]): void {
		if (replayDepth > 0 || mutations.length === 0) return;
		for (const mutation of mutations) {
			pendingCommands.push(structuredClone(mutation));
		}
	}

	/**
	 * Record an applied write as a step the author can take back.
	 *
	 * Asks the different question "is this a step to take back": a whole SA run
	 * is one step and hydration is none at all, which is what `suppressionDepth`
	 * counts. Runs AFTER the write, because the inverse is the delta from the
	 * document that now exists back to `before`.
	 */
	function recordHistoryStep(
		before: BlueprintDoc,
		forward: readonly Mutation[],
	): void {
		if (forward.length === 0 || suppressionDepth > 0 || applyingHistory) return;
		undoStack.push({
			forward: structuredClone(forward),
			inverse: deltaBetween(store.getState(), before),
		});
		// A fresh edit forks the timeline: whatever was redoable no longer is.
		redoStack = [];
		syncHistoryFlags();
	}

	/** The document-to-document delta, which is what an inverse is. */
	function deltaBetween(from: BlueprintDoc, to: BlueprintDoc): Mutation[] {
		return diffDocsToMutations(
			toPersistableDoc(from) as BlueprintDoc,
			toPersistableDoc(to) as BlueprintDoc,
		);
	}

	const store = create<BlueprintDocState>()(
		devtools(
			subscribeWithSelector(
				immer((set) => ({
					// ── Initial state ──────────────────────────────────────────
					...EMPTY_DOC,
					/* Off unless a `beginRemoteApply` bracket is currently open —
					 * an inbound reconciler frame's synchronous write window. */
					remoteFrameApplyInProgress: false,
					canUndo: false,
					canRedo: false,

					// ── Mutation actions ───────────────────────────────────────

					/**
					 * Apply multiple mutations in a single `set()` call — the
					 * ONLY write path into the store.
					 *
					 * One `set()` per call, so the batch is one history entry
					 * whatever its length: a per-action dispatch, a compound edit,
					 * and a whole agent write are each one step.
					 *
					 * Returns an array of reducer results, one entry per input in
					 * the same order. Most mutation kinds produce `undefined`; the
					 * two kinds that produce metadata (`renameField`, `moveField`)
					 * return `FieldRenameMeta` / `MoveFieldResult`. The `let`
					 * variable pattern captures the inner return synchronously — by
					 * the time `set()` returns, `results` has been assigned.
					 */
					applyMany: (muts: Mutation[]): MutationResult[] => {
						const before = store.getState();
						queueForPersistence(muts);
						let results: MutationResult[] = [];
						set((draft) => {
							// `draft` includes action methods alongside data fields,
							// but `applyMutations` is typed for `Draft<BlueprintDoc>`.
							// The extra action fields are structurally harmless — Immer
							// will not attempt to track the function references.
							results = applyMutations(
								draft as unknown as Parameters<typeof applyMutations>[0],
								muts,
							);
						});
						recordHistoryStep(before, muts);
						return results;
					},

					/**
					 * Commit a doc the validity gate already produced AND
					 * validated — the gated-dispatch twin of `applyMany`.
					 *
					 * `useBlueprintMutations`' gate runs the batch through the
					 * shared reducer once to build its candidate; committing
					 * that candidate here (instead of re-running `applyMany`)
					 * keeps every UI dispatch a single reducer run and makes
					 * the committed doc EXACTLY the doc the gate validated.
					 *
					 * One `set()` call, so the commit is one history entry, same
					 * as `applyMany`. The key walk handles the candidate's
					 * structure faithfully: assignments copy every doc field
					 * (structural sharing keeps unchanged maps the same
					 * reference), and optional doc keys the candidate dropped
					 * (e.g. a cleared `logo`) are BLANKED to `undefined` — a
					 * plain `Object.assign` would leave them stale, and a
					 * `delete` is resurrected by zustand's shallow setState
					 * merge (see `overlayDoc`).
					 *
					 * Only the mutation hook's gate should call this; every
					 * other writer routes through `applyMany` so the reducer
					 * stays the one mutation interpreter.
					 */
					commitDoc: (next: BlueprintDoc, commands = []): void => {
						const before = store.getState();
						queueForPersistence(commands);
						set((draft) => {
							overlayDoc(draft as unknown as Record<string, unknown>, next);
						});
						recordHistoryStep(before, commands);
					},

					undoBatch: (): Mutation[] | undefined =>
						undoStack.at(-1)?.inverse.slice(),

					redoBatch: (): Mutation[] | undefined =>
						redoStack.at(-1)?.forward.slice(),

					undo: (): void => {
						const entry = undoStack.pop();
						if (entry === undefined) return;
						applyingHistory = true;
						try {
							store.getState().applyMany(entry.inverse.slice());
						} finally {
							applyingHistory = false;
						}
						redoStack.push(entry);
						syncHistoryFlags();
					},

					redo: (): void => {
						const entry = redoStack.pop();
						if (entry === undefined) return;
						applyingHistory = true;
						try {
							store.getState().applyMany(entry.forward.slice());
						} finally {
							applyingHistory = false;
						}
						undoStack.push(entry);
						syncHistoryFlags();
					},

					clearHistory,

					takeCommands: (): Mutation[] => {
						const taken = pendingCommands;
						pendingCommands = [];
						return taken;
					},

					peekCommands: (): readonly Mutation[] => pendingCommands,

					/**
					 * Hydrate the store from a normalized `BlueprintDoc`.
					 *
					 * Accepts the normalized persisted doc shape directly. The
					 * incoming doc may omit `fieldParent` (it is never persisted);
					 * this method always rebuilds it from `fieldOrder`
					 * so every downstream consumer can rely on it being present.
					 *
					 * Writes every field atomically, then clears the history and
					 * re-arms the birth pause so the hydration never becomes a step
					 * the author can take back. Callers that want undo live call
					 * `startTracking()` afterward.
					 */
					load: (doc: PersistableDoc) => {
						// A `load()` inside an open `begin*/end*` bracket would reset
						// the depth counter out from under the bracket, desyncing it —
						// the reconciler's `data-done` reseed path reseeds through a
						// suppressed `commitDoc` for exactly this reason (the agent
						// bracket is still open at `data-done`). Assert rather than
						// silently corrupt the counter.
						if (openBrackets > 0) {
							throw new Error(
								"BlueprintDoc.load() called inside an open suppression bracket — reseed via commitDoc instead so the depth counter stays coherent.",
							);
						}
						// A load replaces the document, so any command still waiting to
						// persist describes an edit to a document that no longer exists.
						pendingCommands = [];
						// The single hydration chokepoint: fieldParent rebuilt +
						// deterministic option-`uuid` backfill of a legacy doc, on a deep
						// clone so `doc` is never mutated. Position-seeded, so this client
						// and the server agree on the same legacy doc and an edit against
						// it never disagrees on which option it addressed.
						const hydrated = hydratePersistedBlueprint(doc);
						set((draft) => {
							// Overlay EVERY doc field in one pass, blanking data keys the
							// incoming doc no longer carries (a prior load's `logo` must
							// not survive a load whose doc lacks one) — see `overlayDoc`
							// for why the blank must be `undefined`, not `delete`. A
							// hand-listed field-by-field assignment silently drops any
							// top-level slot it omits; the overlay can't forget a field.
							overlayDoc(draft as unknown as Record<string, unknown>, hydrated);
							// The reference index is assigned (not merged) — the
							// reference index stays per-boundary: `hydrated` carries no
							// `refIndex` key, so the overlay above just blanked any prior
							// app's stale index.
							(draft as unknown as BlueprintDoc).refIndex = buildReferenceIndex(
								draft as unknown as BlueprintDoc,
							);
						});
						// A load is a fresh baseline: nothing before it is a step the
						// author can take back, and the depth returns to its paused base
						// so the provider's `startTracking()` can release it again.
						clearHistory();
						suppressionDepth = 1;
						openBrackets = 0;
						birthPauseReleased = false;
						pendingStartTracking = false;
					},

					/**
					 * Open the agent-write suppression bracket (see the
					 * suppression-depth note at the top of the file). Writes while
					 * the depth is > 0 modify state normally but record no history
					 * entry, so the whole agent output is one step.
					 */
					beginAgentWrite: () => {
						openBracket(false);
					},

					/** Close the agent-write bracket. */
					endAgentWrite: () => {
						closeBracket(false);
					},

					/** Release the one-time birth pause so undo tracking goes live
					 *  (see the type doc). Idempotent; deferred to the next bracket
					 *  close when a bracket is open at the call. */
					startTracking: () => {
						if (openBrackets > 0) {
							// A bracket is open (a fresh build mid-run): defer the
							// release to the bracket close so we don't unbalance the
							// depth counter.
							pendingStartTracking = true;
							return;
						}
						maybeReleaseBirthPause();
					},

					/**
					 * Open the remote-apply suppression bracket for one inbound
					 * reconciler frame's write. Raises `remoteFrameApplyInProgress`
					 * so `useAutoSave`'s synchronous leading edge skips re-PUTing
					 * the server-originated change; pairs with `endRemoteApply()`.
					 */
					beginRemoteApply: () => {
						openBracket(true);
					},

					/** Close the remote-apply bracket (decrements the depth and
					 *  clears `remoteFrameApplyInProgress`). */
					endRemoteApply: () => {
						closeBracket(true);
					},
				})),
			),
			{ name: "BlueprintDoc", enabled: process.env.NODE_ENV === "development" },
		),
	);

	return store;
}

/** The Zustand store API type — used for context and hook typing. */
export type BlueprintDocStoreApi = ReturnType<typeof createBlueprintDocStore>;
