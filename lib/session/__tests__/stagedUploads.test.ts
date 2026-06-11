/**
 * Staged media uploads — the session-store state model behind the slot
 * upload chips. UI is f(state), so what's tested is the model, mounted
 * nowhere:
 *
 *   1. stage → uploading record at progress 0.
 *   2. progress advances, clamps to [0,1], and skips no-op writes.
 *   3. failure flips to the error state (progress events can't
 *      resurrect it) and drops the abort handle.
 *   4. clear removes the record (upload confirmed → the gated attach
 *      took over, or the user dismissed an error).
 *   5. cancel aborts the in-flight transfer, then clears — and a
 *      failure racing the cancel stays cleared.
 *   6. reset aborts every in-flight upload and empties the table.
 */

import { describe, expect, it, vi } from "vitest";
import { createBuilderSessionStore } from "../store";

const KEY = "field:f-1:label_media/image";

function stage(
	store: ReturnType<typeof createBuilderSessionStore>,
	abort: () => void = () => {},
	key = KEY,
) {
	store.getState().stageUpload(key, {
		filename: "photo.png",
		kind: "image",
		abort,
	});
}

describe("staged media uploads", () => {
	it("stages an uploading record at progress 0", () => {
		const store = createBuilderSessionStore();
		stage(store);
		expect(store.getState().stagedUploads[KEY]).toEqual({
			filename: "photo.png",
			kind: "image",
			status: { state: "uploading", progress: 0 },
		});
	});

	it("advances progress, clamps to [0,1], and skips same-value writes", () => {
		const store = createBuilderSessionStore();
		stage(store);
		store.getState().setStagedUploadProgress(KEY, 0.4);
		expect(store.getState().stagedUploads[KEY]?.status).toEqual({
			state: "uploading",
			progress: 0.4,
		});

		store.getState().setStagedUploadProgress(KEY, 1.7);
		expect(store.getState().stagedUploads[KEY]?.status).toEqual({
			state: "uploading",
			progress: 1,
		});

		// Same value → no state write (record reference is stable).
		const before = store.getState().stagedUploads[KEY];
		store.getState().setStagedUploadProgress(KEY, 1);
		expect(store.getState().stagedUploads[KEY]).toBe(before);

		// Unknown slot → no-op, no record materialized.
		store.getState().setStagedUploadProgress("nope", 0.5);
		expect(store.getState().stagedUploads.nope).toBeUndefined();
	});

	it("failure flips to the error state and freezes progress out", () => {
		const store = createBuilderSessionStore();
		stage(store);
		store.getState().failStagedUpload(KEY, "Storage rejected the bytes.");
		expect(store.getState().stagedUploads[KEY]?.status).toEqual({
			state: "error",
			message: "Storage rejected the bytes.",
		});

		// A straggler progress event from the dead transfer must not
		// resurrect the uploading state.
		store.getState().setStagedUploadProgress(KEY, 0.9);
		expect(store.getState().stagedUploads[KEY]?.status.state).toBe("error");
	});

	it("clear removes the record", () => {
		const store = createBuilderSessionStore();
		stage(store);
		store.getState().clearStagedUpload(KEY);
		expect(store.getState().stagedUploads[KEY]).toBeUndefined();
	});

	it("cancel aborts the transfer then clears; a racing failure stays cleared", () => {
		const store = createBuilderSessionStore();
		const abort = vi.fn();
		stage(store, abort);

		store.getState().cancelStagedUpload(KEY);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(store.getState().stagedUploads[KEY]).toBeUndefined();

		// The driver's rejection handler firing AFTER the cancel (the
		// aborted request settles) must not re-create the record.
		store.getState().failStagedUpload(KEY, "canceled");
		expect(store.getState().stagedUploads[KEY]).toBeUndefined();
	});

	it("a re-stage on the same slot replaces the record and the abort handle", () => {
		const store = createBuilderSessionStore();
		const firstAbort = vi.fn();
		const secondAbort = vi.fn();
		stage(store, firstAbort);
		store.getState().failStagedUpload(KEY, "network died");
		stage(store, secondAbort);
		expect(store.getState().stagedUploads[KEY]?.status).toEqual({
			state: "uploading",
			progress: 0,
		});
		store.getState().cancelStagedUpload(KEY);
		expect(firstAbort).not.toHaveBeenCalled();
		expect(secondAbort).toHaveBeenCalledTimes(1);
	});

	it("reset aborts every in-flight upload and empties the table", () => {
		const store = createBuilderSessionStore();
		const abortA = vi.fn();
		const abortB = vi.fn();
		stage(store, abortA, "app:logo");
		stage(store, abortB, "module:m-1:icon");

		store.getState().reset();
		expect(abortA).toHaveBeenCalledTimes(1);
		expect(abortB).toHaveBeenCalledTimes(1);
		expect(store.getState().stagedUploads).toEqual({});
	});
});
