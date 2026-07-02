/**
 * BlueprintDoc Zustand store factory.
 *
 * Middleware stack (outer → inner):
 *   devtools               Redux-DevTools inspection, named "BlueprintDoc"
 *   temporal               zundo — undo/redo of every state change
 *   subscribeWithSelector  fine-grained subscriptions used by domain hooks
 *   immer                  structural-sharing mutable-syntax updates
 *
 * The store is created via a factory function so each builder mount gets
 * its own isolated store instance. `<BlueprintDocProvider>` calls this
 * factory at mount time and exposes the instance via React context.
 *
 * Suppression depth — the store owns undo tracking, not its callers.
 *   The store holds a `suppressionDepth` counter and derives `isTracking`
 *   from it: tracking is live only at depth 0, paused at any depth > 0.
 *   The zundo `temporal.pause/resume` calls are internal helpers driven
 *   when the depth crosses 0 — no external caller ever touches
 *   `temporal.resume()` directly (a raw resume can't compose with a second
 *   suppression source, so two concurrent brackets would fight over the
 *   flag). `beginAgentWrite`/`beginRemoteApply` increment the depth and
 *   `endAgentWrite`/`endRemoteApply` decrement it; the provider decrements
 *   once after `load()` when the live builder wants tracking.
 *
 *   Depths (depth > 0 ⇒ paused):
 *     - factory init → 1 (no meaningful history at birth).
 *     - after `load()`: the provider decrements to 0 for the live builder;
 *       an agent-stream / replay mount stays at 1.
 *     - `beginAgentWrite` / `beginRemoteApply` ++; the paired end -- .
 *     - `load()` / `clear()` reset the depth to 1 (paused) and clear the
 *       temporal stacks; a `load()` inside an open begin/end bracket is
 *       illegal (asserts) — the reset would desync the counter.
 *
 * Two suppression kinds bracket writes that must stay off the undo stack:
 *   - `beginAgentWrite`/`endAgentWrite` — an SA run streams one whole
 *     undoable snapshot; opened at `beginRun`, closed at stream-close.
 *   - `beginRemoteApply`/`endRemoteApply` — a single inbound reconciler
 *     frame's write (an echo/remote apply, a reload re-fold, a `data-done`
 *     reseed). `remoteFrameApplyInProgress` flips true for exactly that
 *     synchronous bracket so `useAutoSave`'s leading edge (which fires
 *     synchronously from the store subscriber) skips re-PUTing a
 *     server-originated change.
 */

import { temporal } from "zundo";
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import {
	hydratePersistedBlueprint,
	rebuildFieldParent,
} from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, Mutation, MutationResult } from "@/lib/doc/types";
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
	 * `set()` call. zundo records exactly one undo entry for the whole batch,
	 * regardless of array length — a single user edit and a multi-step agent
	 * write both collapse to one undoable snapshot.
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
	commitDoc: (next: BlueprintDoc) => void;
	/**
	 * Replace the entire doc from a `PersistableDoc` (the Firestore-persisted
	 * shape that omits `fieldParent`).
	 *
	 * Accepts the normalized doc shape directly. `fieldParent` is always
	 * rebuilt from `fieldOrder`, so callers never need to supply it.
	 *
	 * Does NOT create an undo entry — loads are session hydration, not
	 * user edits. Clears any prior history and keeps temporal paused.
	 * Callers must call `store.temporal.getState().resume()` afterward
	 * if they want undo tracking to begin.
	 */
	load: (doc: PersistableDoc) => void;
	/**
	 * Open an agent-write suppression bracket before an SA run streams.
	 *
	 * Increments `suppressionDepth`; all `applyMany()` calls while the
	 * depth is > 0 take effect but stay off the undo stack. Call
	 * `endAgentWrite()` at stream-close — the depth decrements and, if it
	 * reaches 0, tracking resumes so the next user mutation is one undo
	 * entry spanning the entire agent write.
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
	 * Open a remote-apply suppression bracket for one inbound reconciler
	 * frame's write (an echo/remote apply, a reload re-fold, a `data-done`
	 * reseed). Increments `suppressionDepth` AND sets
	 * `remoteFrameApplyInProgress` so `useAutoSave`'s synchronous leading
	 * edge skips re-PUTing the server-originated change. The reconciler
	 * pairs it with `endRemoteApply()` in the same synchronous turn.
	 */
	beginRemoteApply: () => void;
	/** Close the remote-apply bracket (decrements `suppressionDepth` and
	 *  clears `remoteFrameApplyInProgress`). */
	endRemoteApply: () => void;
	/**
	 * Re-key the undo/redo stacks through `fold` after a remote frame
	 * advances `confirmedDoc` — so a past/future state the user can undo
	 * to still folds the peer's committed change in, instead of snapping
	 * it back out. `fold` maps a full recorded state to its rebased twin.
	 */
	rebaseHistory: (fold: (state: BlueprintDoc) => BlueprintDoc) => void;
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
 * `fieldParent` starts as an empty object — `rebuildFieldParent` is a
 * no-op on an empty doc but ensures the field is always defined on the
 * store shape.
 */
const EMPTY_DOC: BlueprintDoc = {
	appId: "",
	appName: "",
	connectType: null,
	caseTypes: null,
	modules: {},
	forms: {},
	fields: {},
	moduleOrder: [],
	formOrder: {},
	fieldOrder: {},
	fieldParent: {},
};

/**
 * Create a fresh BlueprintDoc store.
 *
 * Each builder mount gets its own store instance — this is NOT a
 * module-level singleton. History tracking is paused immediately after
 * creation; call `store.temporal.getState().resume()` once the builder
 * UI is ready to record user edits.
 */
export function createBlueprintDocStore() {
	// The store owns undo tracking through a suppression-depth counter, not
	// the zundo `temporal.pause/resume` calls directly. Tracking is live
	// only at depth 0. `openBrackets` is the separate count of currently-open
	// `begin*/end*` pairs — `load()`/`clear()` reset the depth, which is only
	// coherent when no bracket is mid-flight, so they assert on it.
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
	let birthPauseReleased = false;
	let pendingStartTracking = false;

	// `store` is declared here so the depth helpers and the action closures
	// (`load`, `beginAgentWrite`, `beginRemoteApply`, …) can reference
	// `store.temporal` / `store.setState` after the store has been fully
	// constructed. JavaScript's closure semantics allow the variable to be
	// captured before its value is assigned — these closures are only
	// *called* at runtime, by which point `store` is fully initialized.

	/** Reflect the current `suppressionDepth` onto zundo: track at 0, pause
	 *  otherwise. The single place `temporal.pause/resume` is called. */
	function syncTracking(): void {
		const temporal = store.temporal.getState();
		const shouldTrack = suppressionDepth === 0;
		if (shouldTrack && !temporal.isTracking) temporal.resume();
		else if (!shouldTrack && temporal.isTracking) temporal.pause();
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
		syncTracking();
		return true;
	}

	/** Open a suppression bracket. `remote` also raises
	 *  `remoteFrameApplyInProgress` for the synchronous window. The flag flip is
	 *  itself a `set()`, so it must land AFTER `syncTracking()` has paused —
	 *  otherwise zundo records the flag change as an undo entry. */
	function openBracket(remote: boolean): void {
		suppressionDepth += 1;
		openBrackets += 1;
		syncTracking();
		if (remote) store.setState({ remoteFrameApplyInProgress: true });
	}

	/** Close a suppression bracket opened by `openBracket`. The flag clear must
	 *  land BEFORE `syncTracking()` resumes (the depth is still ≥ the paused
	 *  base at this point), so the clearing `set()` stays off the undo stack. */
	function closeBracket(remote: boolean): void {
		if (remote) store.setState({ remoteFrameApplyInProgress: false });
		suppressionDepth = Math.max(0, suppressionDepth - 1);
		openBrackets = Math.max(0, openBrackets - 1);
		syncTracking();
		// A `startTracking()` that arrived while a bracket was open (a fresh build's
		// first `endRun` closes the agent bracket) releases the birth pause now that
		// no bracket remains — so undo works after a build with no page reload.
		if (pendingStartTracking) {
			pendingStartTracking = false;
			maybeReleaseBirthPause();
		}
	}

	const store = create<BlueprintDocState>()(
		devtools(
			temporal(
				subscribeWithSelector(
					immer((set) => ({
						// ── Initial state ──────────────────────────────────────────
						...EMPTY_DOC,
						/* Off unless a `beginRemoteApply` bracket is currently open —
						 * an inbound reconciler frame's synchronous write window. */
						remoteFrameApplyInProgress: false,

						// ── Mutation actions ───────────────────────────────────────

						/**
						 * Apply multiple mutations in a single `set()` call — the
						 * ONLY write path into the store.
						 *
						 * Because all mutations touch the same Immer draft, zundo sees
						 * only one state transition and records exactly one undo entry —
						 * the batch collapses to an atomic history snapshot regardless of
						 * array length. A one-element array is the normal per-action case;
						 * multi-element arrays collapse compound edits and agent writes
						 * into a single undo snapshot.
						 *
						 * Returns an array of reducer results, one entry per input in
						 * the same order. Most mutation kinds produce `undefined`; the
						 * two kinds that produce metadata (`renameField`, `moveField`)
						 * return `FieldRenameMeta` / `MoveFieldResult`. The `let`
						 * variable pattern captures the inner return synchronously — by
						 * the time `set()` returns, `results` has been assigned.
						 */
						applyMany: (muts: Mutation[]): MutationResult[] => {
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
						 * the committed doc EXACTLY the doc the gate validated —
						 * load-bearing for `duplicateField`, whose reducer mints a
						 * fresh clone uuid per run.
						 *
						 * One `set()` call, so zundo records exactly one undo
						 * entry, same as `applyMany`. The key walk handles the
						 * candidate's structure faithfully: assignments copy every
						 * doc field (structural sharing keeps unchanged maps the
						 * same reference), and optional doc keys the candidate
						 * dropped (e.g. a cleared `logo`) are deleted — a plain
						 * `Object.assign` would leave them stale.
						 *
						 * Only the mutation hook's gate should call this; every
						 * other writer routes through `applyMany` so the reducer
						 * stays the one mutation interpreter.
						 */
						commitDoc: (next: BlueprintDoc): void => {
							set((draft) => {
								const d = draft as unknown as Record<string, unknown>;
								for (const key of Object.keys(d)) {
									// Action methods live alongside data on the state —
									// never touch them; drop data keys the candidate
									// no longer carries.
									if (typeof d[key] === "function") continue;
									if (!(key in next)) delete d[key];
								}
								Object.assign(d, next);
							});
						},

						/**
						 * Hydrate the store from a normalized `BlueprintDoc`.
						 *
						 * Accepts the doc shape that Firestore stores directly. The
						 * incoming doc may omit `fieldParent` (Firestore does not
						 * persist it); this method always rebuilds it from `fieldOrder`
						 * so every downstream consumer can rely on it being present.
						 *
						 * Writes every field atomically, then clears and re-pauses the
						 * undo history so the hydration transition never enters history.
						 * Callers that want undo tracking must call
						 * `store.temporal.getState().resume()` afterward.
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
							// The single hydration chokepoint: fieldParent rebuilt +
							// deterministic `order`/option-`uuid` backfill of a legacy doc,
							// on a deep clone so `doc` is never mutated. Position-seeded, so
							// this client and the server agree on the same legacy doc and a
							// diff against it never disagrees on an entity's position or an
							// option's identity.
							const hydrated = hydratePersistedBlueprint(doc);
							set((draft) => {
								// Copy EVERY doc field onto the draft in one pass. A
								// hand-listed field-by-field assignment silently drops any
								// top-level slot it omits — omit `logo` and the saved logo
								// blanks on the next load. `Object.assign` can't forget a
								// field. The cast strips the action-overlay
								// (`BlueprintDocState = BlueprintDoc & { actions }`) whose
								// readonly Record maps otherwise reject the swap; the draft's
								// own action methods aren't keys on `hydrated`, so they survive.
								// Immer records each assignment through its proxy and produces
								// the next state with structural sharing.
								Object.assign(draft as BlueprintDoc, hydrated);
								// The reference index is assigned (not merged) — the
								// reference index stays per-boundary: `hydrated` carries no
								// `refIndex` key, so the Object.assign above would otherwise
								// leave a prior app's stale index in place.
								(draft as unknown as BlueprintDoc).refIndex =
									buildReferenceIndex(draft as unknown as BlueprintDoc);
							});
							// Clear any undo history accumulated since last load (e.g.
							// stale entries from a prior session in the same store instance)
							// and reset the depth to the paused base (1). The caller
							// (the provider) calls `startTracking()` afterward if it wants
							// tracking. A load is a fresh birth-paused baseline, so re-arm
							// the one-time birth-pause release.
							store.temporal.getState().clear();
							suppressionDepth = 1;
							openBrackets = 0;
							birthPauseReleased = false;
							pendingStartTracking = false;
							syncTracking();
						},

						/**
						 * Open the agent-write suppression bracket (see the
						 * suppression-depth note at the top of the file). All
						 * `applyMany` calls while the depth is > 0 modify state
						 * normally but stay off the undo stack; pairing with
						 * `endAgentWrite()` collapses the entire agent output into one
						 * undoable snapshot from the user's perspective.
						 */
						beginAgentWrite: () => {
							openBracket(false);
						},

						/** Close the agent-write bracket (decrements the depth; tracking
						 *  resumes when it reaches 0). */
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

						/**
						 * Re-key the undo/redo stacks through `fold`. Called after a
						 * remote frame advances `confirmedDoc` so a past/future state
						 * still folds the peer's committed change in rather than
						 * snapping it back out on undo/redo.
						 *
						 * `fold` maps the doc-DATA of one recorded state to its rebased
						 * twin; zundo records the full state (data + action closures, no
						 * `partialize`), so the folded doc is overlaid onto the recorded
						 * entry to keep the action methods intact. `toPersistableDoc`
						 * isn't needed — the recorded state already carries the working
						 * shape; `fold` operates on it directly.
						 */
						rebaseHistory: (fold: (doc: BlueprintDoc) => BlueprintDoc) => {
							const rebase = (s: Partial<BlueprintDocState>) => ({
								...s,
								...fold(s as unknown as BlueprintDoc),
							});
							const temporal = store.temporal.getState();
							// `store.temporal` is the temporal StoreApi; `setState` lives on
							// it, not on the snapshot `getState()` returns.
							store.temporal.setState({
								pastStates: temporal.pastStates.map(rebase),
								futureStates: temporal.futureStates.map(rebase),
							});
						},
					})),
				),
				{
					/**
					 * Cap the undo history at 100 entries to bound memory usage.
					 *
					 * For `applyMany`, the entire batch is one entry because all
					 * mutations run inside a single `set()` call — zundo sees a
					 * single state transition regardless of how many mutations are
					 * in the batch.
					 */
					limit: 100,
				},
			),
			{ name: "BlueprintDoc", enabled: process.env.NODE_ENV === "development" },
		),
	);

	// Reflect the birth depth (1 ⇒ paused). Factory-created stores start
	// with no meaningful history — the initial empty-doc state is not
	// something the user should be able to undo to.
	syncTracking();

	return store;
}

/** The Zustand store API type — used for context and hook typing. */
export type BlueprintDocStoreApi = ReturnType<typeof createBlueprintDocStore>;
