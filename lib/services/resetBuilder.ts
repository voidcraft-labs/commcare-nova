/**
 * resetBuilder — composite reset helpers used when navigating between
 * replay stages.
 *
 * Two variants:
 *   - `resetBuilder` (full): wipes doc + session + engine + signal grid.
 *     Used on EXIT from a replay (user leaving) or on a top-level clean
 *     slate where every surface should zero out.
 *   - `resetBuilderForReplay` (scrub): wipes doc + engine + signal grid
 *     only; session state is preserved so `replay.events`,
 *     `replay.chapters`, and the transport bar survive the click.
 *
 * Each store owns its own reset, and the signal grid has a module-level
 * reset too — these helpers fan out the calls so `ReplayController`
 * doesn't need to know the individual store shapes.
 *
 * Lives in `lib/services/` (not in the React layer) so the replay
 * controller can call it imperatively from a click handler without
 * routing through an effect.
 */

import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { EngineController } from "@/lib/preview/engine/engineController";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import { signalGrid } from "@/lib/signalGrid/store";

// ── Inputs ──────────────────────────────────────────────────────────────

export interface ResetBuilderInputs {
	/** Ephemeral UI session store — cursor mode, sidebars, connect stash,
	 *  generation lifecycle, replay state, appId. */
	sessionStore: BuilderSessionStoreApi;
	/** BlueprintDoc store — blueprint entity data + undo history. */
	docStore: BlueprintDocStore;
	/** Form preview engine controller — per-question runtime store. */
	engineController: EngineController;
}

// ── Helper ──────────────────────────────────────────────────────────────

/**
 * Empty normalized doc used to wipe the doc store between replay stages.
 *
 * `appId` is cleared (empty string) and all entity maps/order arrays start
 * empty — matches the initial store state. `load()` rebuilds fieldParent from
 * fieldOrder (both empty here), so the doc is fully valid after the call.
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
 * Reset the entire builder session back to a clean Idle state.
 *
 * Call order is significant:
 *   1. Deactivate the form engine controller FIRST so its blueprint-store
 *      subscriptions are torn down before the doc store's entity maps get
 *      cleared — otherwise the controller would fire subscriptions against
 *      a half-emptied store and push corrupt runtime state.
 *   2. Wipe the doc store via `load(EMPTY_DOC)`. This clears undo history
 *      and pauses temporal — session setup, not undoable.
 *   3. Reset the session store (cursor mode, sidebars, generation lifecycle,
 *      replay state, connect stash, focus hints).
 *   4. Drain any queued signal grid energy so stale accumulation from the
 *      previous lifecycle doesn't cause a spurious burst after navigation.
 */
export function resetBuilder(inputs: ResetBuilderInputs): void {
	const { sessionStore, docStore, engineController } = inputs;

	/* 1. Tear down the preview controller before the doc empties. */
	engineController.deactivate();

	/* 2. Wipe the doc store. `load()` pauses + clears undo history, so the
	 *    user can't rewind into the previous replay stage. */
	docStore.getState().load(EMPTY_DOC);

	/* 3. Session state back to defaults. */
	sessionStore.getState().reset();

	/* 4. Signal grid energy baseline — prevents a leftover burst when the
	 *    next stage's emissions land. */
	signalGrid.reset();
}

// ── Replay-scoped reset ────────────────────────────────────────────────

/**
 * Inputs for `resetBuilderForReplay`. `sessionStore` is deliberately
 * omitted — preserving session state is the whole point of this variant,
 * so the function has no legitimate use for it. Accepting it would
 * invite a future edit that "helpfully" adds `sessionStore.reset()` back
 * and silently re-introduces Bug 3 (scrub clicks wipe `replay.*`,
 * leaving the transport bar mounted with zero chapters).
 */
export interface ResetBuilderForReplayInputs {
	/** BlueprintDoc store — blueprint entity data + undo history. */
	docStore: BlueprintDocStore;
	/** Form preview engine controller — per-question runtime store. */
	engineController: EngineController;
}

/**
 * Reset just the builder surfaces that need to be wiped BETWEEN replay
 * scrub targets — doc, preview engine, signal grid. Session state is
 * preserved: `replay.events`, `replay.chapters`, `replay.cursor`, and
 * every other ephemeral flag carry over so the transport bar stays
 * mounted and the next `goToChapter` call has chapters to render.
 *
 * Call order mirrors the full `resetBuilder` for the three surfaces it
 * touches — engine first so blueprint-store subscriptions unwind before
 * the doc empties, doc next, signal grid last so stale energy doesn't
 * bleed into the next stage's emissions.
 *
 * See Bug 3 context in the Phase 4 plan — the previous behaviour reused
 * `resetBuilder` for scrub, which called `sessionStore.reset()` and
 * cleared `replay: undefined`; the subsequent `setReplayCursor` became a
 * no-op and the controller rendered `0/0` chapters until unmount.
 */
export function resetBuilderForReplay(
	inputs: ResetBuilderForReplayInputs,
): void {
	const { docStore, engineController } = inputs;

	/* 1. Tear down the preview controller before the doc empties — same
	 *    subscription-ordering reason as `resetBuilder`. */
	engineController.deactivate();

	/* 2. Wipe the doc store. The cumulative replay in `goToChapter` will
	 *    rebuild it from event[0] through the target chapter's endIndex. */
	docStore.getState().load(EMPTY_DOC);

	/* 3. Signal grid energy baseline. NB: no `sessionStore.reset()` — see
	 *    the interface docstring above for why. */
	signalGrid.reset();
}
