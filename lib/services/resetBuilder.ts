/**
 * resetBuilder — composite reset for the builder's doc-adjacent surfaces.
 *
 * Wipes three coupled surfaces that share a lifecycle: the form preview
 * engine (subscribes to blueprint-store entity maps), the BlueprintDoc
 * store itself (entity data + undo history), and the signal grid's
 * accumulated energy baseline.
 *
 * Session state is a SEPARATE concern and is NOT touched here. Callers
 * that want session cleared (e.g. exiting replay mode, returning to a
 * clean Idle) compose `sessionStore.getState().reset()` themselves
 * alongside this call. Replay scrub callers leave session alone so
 * `replay.events` / `replay.chapters` / `replay.cursor` survive the
 * reset and the transport bar stays mounted. Keeping session reset out
 * of the pipeline makes composition explicit instead of introducing
 * parallel variants.
 *
 * Lives in `lib/services/` (not in the React layer) so the replay
 * controller can call it imperatively from a click handler without
 * routing through an effect.
 */

import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { EngineController } from "@/lib/preview/engine/engineController";
import { signalGrid } from "@/lib/signalGrid/store";

// ── Inputs ──────────────────────────────────────────────────────────────

export interface ResetBuilderInputs {
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
 * Reset the builder's doc + engine + signal-grid surfaces to a clean
 * baseline. Session state is deliberately out of scope — see the module
 * header for the composition rationale.
 *
 * Call order is significant:
 *   1. Deactivate the form engine controller FIRST so its blueprint-store
 *      subscriptions are torn down before the doc store's entity maps get
 *      cleared — otherwise the controller would fire subscriptions against
 *      a half-emptied store and push corrupt runtime state.
 *   2. Wipe the doc store via `load(EMPTY_DOC)`. This clears undo history
 *      and pauses temporal — session setup, not undoable.
 *   3. Drain any queued signal grid energy so stale accumulation from the
 *      previous lifecycle doesn't cause a spurious burst after navigation.
 */
export function resetBuilder(inputs: ResetBuilderInputs): void {
	const { docStore, engineController } = inputs;

	/* 1. Tear down the preview controller before the doc empties. */
	engineController.deactivate();

	/* 2. Wipe the doc store. `load()` pauses + clears undo history, so the
	 *    user can't rewind into the previous replay stage. */
	docStore.getState().load(EMPTY_DOC);

	/* 3. Signal grid energy baseline — prevents a leftover burst when the
	 *    next stage's emissions land. */
	signalGrid.reset();
}
