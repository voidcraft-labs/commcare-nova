/**
 * Shared test helpers for `lib/generation/` test files. Extracted when a
 * third consumer (Task 17d's SA emission integration test) was about to
 * duplicate the same wiring a third time. Any fresh `{ docStore,
 * sessionStore }` pair in this tree should come from here — there must
 * be exactly one wiring helper, not one per file.
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
 * - `resumeUndo`: when true, resume the doc-store's zundo temporal
 *   tracking immediately. The default is `false` because production
 *   code pauses undo until the first user edit lands — tests that
 *   simulate a generation lifecycle from scratch want the same
 *   behavior. Tests that want to observe the `beginAgentWrite → pause`
 *   transition opt-in here so temporal starts in the tracking state.
 */
export interface CreateWiredStoresOptions {
	readonly resumeUndo?: boolean;
}

/**
 * Wire up a fresh pair of stores like SyncBridge does at runtime.
 *
 * The session store holds a reference to the doc store via
 * `_setDocStore`, which cascades `beginAgentWrite` / `endAgentWrite`
 * into the doc store's temporal pause/resume.
 */
export function createWiredStores(options: CreateWiredStoresOptions = {}): {
	docStore: BlueprintDocStoreApi;
	sessionStore: BuilderSessionStoreApi;
} {
	const docStore = createBlueprintDocStore();
	if (options.resumeUndo) {
		docStore.temporal.getState().resume();
	}
	const sessionStore = createBuilderSessionStore();
	sessionStore.getState()._setDocStore(docStore);
	return { docStore, sessionStore };
}

/** Load an initial doc into the store and resume undo tracking. */
export function hydrateDoc(
	docStore: BlueprintDocStoreApi,
	doc: PersistableDoc,
): void {
	docStore.getState().load(doc);
	docStore.temporal.getState().resume();
}
