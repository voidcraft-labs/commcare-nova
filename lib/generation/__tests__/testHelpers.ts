/**
 * Shared test helpers for `lib/generation/` test files. Any fresh
 * `{ docStore, sessionStore }` pair in this tree comes from here so the
 * wiring between the doc + session stores stays consistent — there is
 * exactly one wiring helper, not one per file.
 */

import {
	type BlueprintDocStoreApi,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import type { PersistableDoc } from "@/lib/domain";
import {
	type BuilderSessionStoreApi,
	createBuilderSessionStore,
} from "@/lib/session/store";

/**
 * Options for `createWiredStores`.
 *
 * - `resumeUndo`: when true, start the doc store tracking undo immediately.
 *   The default is `false` because production code pauses undo until the
 *   first user edit lands — tests that simulate a generation lifecycle from
 *   scratch want the same behavior. Tests that want to observe the
 *   `beginAgentWrite → pause` transition opt-in here so temporal starts in
 *   the tracking state.
 */
export interface CreateWiredStoresOptions {
	readonly resumeUndo?: boolean;
}

/**
 * Wire up a fresh pair of stores like SyncBridge does at runtime.
 *
 * The session store holds a reference to the doc store via
 * `_setDocStore`, which cascades `beginAgentWrite` / `endAgentWrite`
 * into the doc store's suppression-depth counter.
 *
 * Starting tracking decrements the birth depth (1 ⇒ paused) to 0 via the store
 * method `endAgentWrite()` — the same call the `BlueprintDocProvider` makes —
 * never `temporal.resume()` directly (a raw resume desyncs the store's depth
 * counter, so a later `beginRun`/`endRun` pair wouldn't restore tracking).
 */
export function createWiredStores(options: CreateWiredStoresOptions = {}): {
	docStore: BlueprintDocStoreApi;
	sessionStore: BuilderSessionStoreApi;
} {
	const docStore = createBlueprintDocStore();
	if (options.resumeUndo) {
		docStore.getState().startTracking();
	}
	const sessionStore = createBuilderSessionStore();
	sessionStore.getState()._setDocStore(docStore);
	return { docStore, sessionStore };
}

/** Load an initial doc into the store and start undo tracking. `load()` resets
 *  the depth to the paused base (1); `endAgentWrite()` decrements it to 0. */
export function hydrateDoc(
	docStore: BlueprintDocStoreApi,
	doc: PersistableDoc,
): void {
	docStore.getState().load(doc);
	docStore.getState().startTracking();
}
