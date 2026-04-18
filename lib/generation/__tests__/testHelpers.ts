/**
 * Shared test helpers for `lib/generation/` test files. Extracted when a
 * third consumer (Task 17d's SA emission integration test) was about to
 * duplicate the same wiring a third time.
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

/** Wire up a fresh pair of stores like SyncBridge does at runtime. */
export function createWiredStores(): {
	docStore: BlueprintDocStoreApi;
	sessionStore: BuilderSessionStoreApi;
} {
	const docStore = createBlueprintDocStore();
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
