/**
 * resetBuilder — composite reset helper used when navigating between
 * replay stages.
 *
 * Each store owns its own reset, and the signal grid has a module-level
 * reset too — this helper fans out the calls so `ReplayController` doesn't
 * need to know the individual store shapes.
 *
 * Lives in `lib/services/` (not in the React layer) so the replay
 * controller can call it imperatively from a click handler without
 * routing through an effect.
 */

import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { EngineController } from "@/lib/preview/engine/engineController";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
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

/** Empty blueprint used to wipe the doc store between replay stages.
 *  Matches the shape that `createApp` writes for brand-new apps, so the
 *  doc's `load()` path can rebuild from empty without choking on missing
 *  fields. */
const EMPTY_BLUEPRINT: AppBlueprint = {
	app_name: "",
	modules: [],
	case_types: null,
};

/**
 * Reset the entire builder session back to a clean Idle state.
 *
 * Call order is significant:
 *   1. Deactivate the form engine controller FIRST so its blueprint-store
 *      subscriptions are torn down before the doc store's entity maps get
 *      cleared — otherwise the controller would fire subscriptions against
 *      a half-emptied store and push corrupt runtime state.
 *   2. Wipe the doc store via `load(EMPTY_BLUEPRINT, "")`. This clears
 *      undo history and pauses temporal — session setup, not undoable.
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
	docStore.getState().load(EMPTY_BLUEPRINT, "");

	/* 3. Session state back to defaults. */
	sessionStore.getState().reset();

	/* 4. Signal grid energy baseline — prevents a leftover burst when the
	 *    next stage's emissions land. */
	signalGrid.reset();
}
