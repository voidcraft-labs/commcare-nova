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
 * Temporal lifecycle:
 *   - Created with tracking paused — a freshly created store has no history.
 *   - `load()` replaces the entire doc and clears + re-pauses temporal, so
 *     the hydration from a blueprint never enters undo history.
 *   - Callers that want undo support (the live builder) must call
 *     `store.temporal.getState().resume()` after `load()` returns.
 *   - Agent writes call `beginAgentWrite()` / `endAgentWrite()` to
 *     bracket the stream: changes inside are invisible to undo, and the
 *     entire stream collapses to a single undoable snapshot on resume.
 */

import { temporal } from "zundo";
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
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
	 * Pause undo tracking before an agent write stream begins.
	 *
	 * All `applyMany()` calls while paused take effect but are invisible
	 * to the undo stack. Call `endAgentWrite()` when the stream is done —
	 * tracking resumes and the next user mutation will create a single
	 * undo entry spanning the entire agent write.
	 */
	beginAgentWrite: () => void;
	/** Resume undo tracking after an agent write stream completes. */
	endAgentWrite: () => void;
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
	// `store` is declared here so the `load`, `beginAgentWrite`, and
	// `endAgentWrite` action closures can reference `store.temporal` after
	// the store has been fully constructed. JavaScript's closure semantics
	// allow the variable to be captured before its value is assigned —
	// these closures are only *called* at runtime, by which point `store`
	// is fully initialized.
	const store = create<BlueprintDocState>()(
		devtools(
			temporal(
				subscribeWithSelector(
					immer((set) => ({
						// ── Initial state ──────────────────────────────────────────
						...EMPTY_DOC,

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
							// Spread the on-disk doc (which has no fieldParent) into a full
							// in-memory BlueprintDoc by initializing fieldParent to {} first.
							// rebuildFieldParent below fills it in from fieldOrder atomically.
							const next: BlueprintDoc = { ...doc, fieldParent: {} };
							set((draft) => {
								// Copy EVERY doc field onto the draft in one pass. A
								// hand-listed field-by-field assignment silently drops any
								// top-level slot it omits — omit `logo` and the saved logo
								// blanks on the next load. `Object.assign` can't forget a
								// field. The cast strips the action-overlay
								// (`BlueprintDocState = BlueprintDoc & { actions }`) whose
								// readonly Record maps otherwise reject the swap; the draft's
								// own action methods aren't keys on `next`, so they survive.
								// Immer records each assignment through its proxy and produces
								// the next state with structural sharing.
								Object.assign(draft as BlueprintDoc, next);
								// Rebuild the reverse-parent index so hooks can read
								// fieldParent immediately after load.
								rebuildFieldParent(draft as unknown as BlueprintDoc);
							});
							// Clear any undo history accumulated since last load (e.g.
							// stale entries from a prior session in the same store instance).
							store.temporal.getState().clear();
							// Keep temporal paused — the caller decides when to resume.
							store.temporal.getState().pause();
						},

						/**
						 * Pause undo tracking for an agent write stream.
						 *
						 * All `applyMany` calls while paused modify state normally but
						 * are invisible to the undo stack. Pairing with `endAgentWrite()`
						 * collapses the entire agent output into one undoable snapshot
						 * from the user's perspective.
						 */
						beginAgentWrite: () => {
							store.temporal.getState().pause();
						},

						/**
						 * Resume undo tracking after an agent write stream completes.
						 *
						 * From this point, any further `applyMany` calls will create
						 * undo entries as normal.
						 */
						endAgentWrite: () => {
							store.temporal.getState().resume();
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

	// Pause temporal immediately after creation. Factory-created stores
	// start with no meaningful history — the initial empty-doc state is
	// not something the user should be able to undo to.
	store.temporal.getState().pause();

	return store;
}

/** The Zustand store API type — used for context and hook typing. */
export type BlueprintDocStoreApi = ReturnType<typeof createBlueprintDocStore>;
