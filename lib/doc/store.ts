/**
 * BlueprintDoc Zustand store factory.
 *
 * Middleware stack (outer → inner):
 *   devtools               Redux-DevTools inspection, named "BlueprintDoc"
 *   temporal               zundo — undo/redo of every state change
 *   subscribeWithSelector  fine-grained subscriptions (used by domain hooks
 *                          in Phase 3+)
 *   immer                  structural-sharing mutable-syntax updates
 *
 * The store is created via a factory function so each builder mount gets
 * its own isolated store instance. This matches the existing pattern in
 * `lib/services/builderStore.ts`. Phase 1b's `<BlueprintDocProvider>`
 * calls this factory at mount time and exposes the instance via React
 * context.
 *
 * Temporal lifecycle:
 *   - Created with tracking paused — a freshly created store has no history.
 *   - `load()` replaces the entire doc and clears + re-pauses temporal, so
 *     the hydration from a blueprint never enters undo history.
 *   - Callers that want undo support (the live builder) must call
 *     `store.temporal.getState().resume()` after `load()` returns.
 *   - Agent writes (Phase 4) call `beginAgentWrite()` / `endAgentWrite()` to
 *     bracket the stream: changes inside are invisible to undo, and the
 *     entire stream collapses to a single undoable snapshot on resume.
 */

import { temporal } from "zundo";
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { toDoc } from "@/lib/doc/converter";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { applyMutation, applyMutations } from "@/lib/doc/mutations";
import type {
	FieldRenameMeta,
	MoveFieldResult,
} from "@/lib/doc/mutations/fields";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

export { rebuildFieldParent };

/**
 * The complete public state surface of the BlueprintDoc store.
 *
 * Extends `BlueprintDoc` (pure data) with five action methods that
 * components and engine code call. Separating data from actions here
 * keeps the type as the single source of truth — no need for a separate
 * interface listing only the actions.
 */
export type BlueprintDocState = BlueprintDoc & {
	/** Apply a single mutation; captured as one undo entry while tracking. */
	apply: (mut: Mutation) => void;
	/**
	 * Apply a single mutation and return metadata from the reducer.
	 *
	 * Typed overloads ensure callers get the correct result per mutation kind:
	 *   - `moveField`    → `MoveFieldResult`
	 *   - `renameField`  → `FieldRenameMeta`
	 *   - all other kinds   → `void`
	 *
	 * `apply()` stays the fire-and-forget path for 90% of call sites;
	 * `applyWithResult()` is the typed-return path for the 2 mutations
	 * that produce actionable metadata (rename toast, xpath count).
	 */
	applyWithResult: {
		(
			mut: Extract<Mutation, { kind: "moveField" }>,
		): MoveFieldResult | undefined;
		(
			mut: Extract<Mutation, { kind: "renameField" }>,
		): FieldRenameMeta | undefined;
		(mut: Mutation): void;
	};
	/** Apply a batch of mutations as one atomic undo entry. */
	applyMany: (muts: Mutation[]) => void;
	/**
	 * Replace the entire doc from an AppBlueprint.
	 *
	 * Does NOT create an undo entry — loads are session hydration, not
	 * user edits. Clears any prior history and keeps temporal paused.
	 * Callers must call `store.temporal.getState().resume()` afterward
	 * if they want undo tracking to begin.
	 */
	load: (bp: AppBlueprint, appId: string) => void;
	/**
	 * Pause undo tracking before an agent write stream begins.
	 *
	 * All `apply()` / `applyMany()` calls while paused take effect but
	 * are invisible to the undo stack. Call `endAgentWrite()` when the
	 * stream is done — tracking resumes and the next user mutation will
	 * create a single undo entry spanning the entire agent write.
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
						 * Apply a single mutation to the doc.
						 *
						 * Each call is a discrete state transition — when temporal is
						 * active, it creates one undo entry. Immer handles structural
						 * sharing so unchanged entity references remain stable.
						 */
						apply: (mut: Mutation) => {
							set((draft) => {
								// `draft` includes action methods alongside data fields,
								// but `applyMutation` is typed for `Draft<BlueprintDoc>`.
								// The extra action fields are structurally harmless — Immer
								// will not attempt to track the function references.
								applyMutation(
									draft as unknown as Parameters<typeof applyMutation>[0],
									mut,
								);
							});
						},

						/**
						 * Apply a single mutation and capture the reducer's return value.
						 *
						 * Identical to `apply()` except it threads back the metadata that
						 * `applyMutation` returns for `moveField` (rename info) and
						 * `renameField` (xpath rewrite count). A `let result` variable
						 * captures the return inside the Immer draft callback — the variable
						 * is assigned synchronously before `set()` returns, so the caller
						 * can use it immediately.
						 */
						applyWithResult: ((mut: Mutation): unknown => {
							let result: unknown;
							set((draft) => {
								result = applyMutation(
									draft as unknown as Parameters<typeof applyMutation>[0],
									mut,
								);
							});
							return result;
						}) as BlueprintDocState["applyWithResult"],

						/**
						 * Apply multiple mutations in a single `set()` call.
						 *
						 * Because all mutations touch the same Immer draft, zundo sees
						 * only one state transition and records exactly one undo entry —
						 * the batch collapses to an atomic history snapshot.
						 */
						applyMany: (muts: Mutation[]) => {
							set((draft) => {
								applyMutations(
									draft as unknown as Parameters<typeof applyMutations>[0],
									muts,
								);
							});
						},

						/**
						 * Hydrate the store from an AppBlueprint.
						 *
						 * Converts the nested blueprint to a normalized doc via `toDoc`,
						 * writes every field atomically, then clears and re-pauses the
						 * undo history. Rebuilds the fieldParent reverse index after
						 * loading the new doc shape.
						 *
						 * The transition from empty→loaded is not an undoable user action —
						 * it's session setup.
						 */
						load: (bp: AppBlueprint, appId: string) => {
							const next = toDoc(bp, appId);
							set((draft) => {
								draft.appId = next.appId;
								draft.appName = next.appName;
								draft.connectType = next.connectType;
								draft.caseTypes = next.caseTypes;
								// `draft` is `WritableDraft<BlueprintDocState>`, where
								// `BlueprintDocState = BlueprintDoc & { actions }`. Primitive
								// fields assign fine, but Immer's draft wrapping on the
								// Record-valued entity maps rejects direct assignment from
								// plain objects (`next.modules` etc.) because the draft type
								// is marked readonly in the intersection. The narrow cast
								// to `BlueprintDoc` strips the action-type overlay so we can
								// wholesale-swap the maps. Immer still produces the correct
								// next state via its own structural sharing.
								(draft as BlueprintDoc).modules = next.modules;
								(draft as BlueprintDoc).forms = next.forms;
								(draft as BlueprintDoc).fields = next.fields;
								draft.moduleOrder = next.moduleOrder;
								(draft as BlueprintDoc).formOrder = next.formOrder;
								(draft as BlueprintDoc).fieldOrder = next.fieldOrder;
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
						 * All `apply`/`applyMany` calls while paused modify state
						 * normally but are invisible to the undo stack. Pairing with
						 * `endAgentWrite()` collapses the entire agent output into one
						 * undoable snapshot from the user's perspective.
						 */
						beginAgentWrite: () => {
							store.temporal.getState().pause();
						},

						/**
						 * Resume undo tracking after an agent write stream completes.
						 *
						 * From this point, any further `apply`/`applyMany` calls will
						 * create undo entries as normal.
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
