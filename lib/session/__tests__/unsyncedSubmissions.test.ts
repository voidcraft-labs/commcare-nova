/**
 * The submissions a Preview run's device holds until it syncs, which every
 * later signed opening of the run lays over the restore. The plausible
 * failures: an entry kept past a sync, another run's entries read as this
 * run's, or the list growing past what an opening takes.
 */
import { describe, expect, it } from "vitest";
import {
	createBuilderSessionStore,
	MAX_UNSYNCED_ENTRIES,
} from "@/lib/session/store";

describe("a Preview run's unsynced submissions", () => {
	it("keeps each entry of its run once, in order, until the device syncs", () => {
		const store = createBuilderSessionStore();
		const run = store.getState().previewSessionId;
		store.getState().notePreviewSubmission(run, "first");
		store.getState().notePreviewSubmission(run, "second");
		store.getState().notePreviewSubmission(run, "first");
		expect(store.getState().previewUnsyncedEntries).toEqual({
			run,
			keys: ["first", "second"],
		});
		store.getState().markPreviewDeviceSynced(Date.now());
		expect(store.getState().previewUnsyncedEntries).toBeUndefined();
	});

	it("starts afresh for another run and keeps the newest an opening takes", () => {
		const store = createBuilderSessionStore();
		store.getState().notePreviewSubmission("earlier-run", "old");
		store.getState().notePreviewSubmission("this-run", "new");
		expect(store.getState().previewUnsyncedEntries).toEqual({
			run: "this-run",
			keys: ["new"],
		});
		for (let i = 0; i < MAX_UNSYNCED_ENTRIES + 3; i++)
			store.getState().notePreviewSubmission("this-run", `entry-${i}`);
		const keys = store.getState().previewUnsyncedEntries?.keys ?? [];
		expect(keys).toHaveLength(MAX_UNSYNCED_ENTRIES);
		expect(keys.at(-1)).toBe(`entry-${MAX_UNSYNCED_ENTRIES + 2}`);
	});
});
