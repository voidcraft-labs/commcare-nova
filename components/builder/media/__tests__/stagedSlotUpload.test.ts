import { afterEach, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { createBuilderSessionStore } from "@/lib/session/store";
import type { MediaAssetView } from "../mediaClient";
import { uploadToStagedSlot } from "../stagedSlotUpload";
import type { AttachBudgetVerdict } from "../useAttachBudget";

const file = new File(["photo"], "photo.png", { type: "image/png" });
const asset: MediaAssetView = {
	id: testMediaAssetId("staged-upload"),
	contentHash: "a".repeat(64),
	mimeType: "image/png",
	kind: "image",
	extension: ".png",
	sizeBytes: file.size,
	originalFilename: file.name,
	status: "ready",
	createdAt: "2026-09-05T00:00:00Z",
};
const stores: ReturnType<typeof createBuilderSessionStore>[] = [];
const tasks: Promise<void>[] = [];
const settle: (() => void)[] = [];

function setup(buildUnfinished = false, canEdit = true) {
	const session = createBuilderSessionStore({
		appId: "app-a",
		projectId: "project-a",
		role: canEdit ? "editor" : "viewer",
		canEdit,
		buildUnfinished,
	});
	stores.push(session);
	const onReady = vi.fn();
	const onRetained = vi.fn();
	const checkAttachBudget = vi
		.fn<(asset: MediaAssetView) => Promise<AttachBudgetVerdict>>()
		.mockResolvedValue({ ok: true });
	return {
		session,
		onReady,
		onRetained,
		checkAttachBudget,
		upload: () => {
			const task = uploadToStagedSlot({
				session,
				slotKey: "field:image",
				kind: "image",
				file,
				checkAttachBudget,
				onReady,
				onRetained,
			});
			tasks.push(task);
			return task;
		},
	};
}

function holdUpload() {
	const reached = Promise.withResolvers<AbortSignal | null | undefined>();
	const response = Promise.withResolvers<Response>();
	settle.push(() =>
		response.resolve(Response.json({ deduplicated: true, asset })),
	);
	vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => {
		reached.resolve(init?.signal);
		return response.promise;
	});
	return { reached: reached.promise, response };
}

afterEach(async () => {
	try {
		for (const store of stores) store.getState().resetProjectScope();
		for (const release of settle) release();
		const results = await Promise.allSettled(tasks);
		expect(results.every((result) => result.status === "fulfilled")).toBe(true);
	} finally {
		stores.length = 0;
		tasks.length = 0;
		settle.length = 0;
		vi.restoreAllMocks();
	}
});

it.each([true, false])(
	"uploads with Project authority and attaches only to an editable blueprint (locked: %s)",
	async (locked) => {
		const transfer = holdUpload();
		const model = setup(locked);
		const task = model.upload();
		await transfer.reached;
		expect(model.session.getState().stagedUploads["field:image"]).toBeDefined();
		transfer.response.resolve(Response.json({ deduplicated: true, asset }));
		await task;
		expect(model.session.getState().stagedUploads).toEqual({});
		if (locked) {
			expect(model.onRetained).toHaveBeenCalledOnce();
			expect(model.onReady).not.toHaveBeenCalled();
			expect(model.checkAttachBudget).not.toHaveBeenCalled();
			model.session.getState().markBuildFinished();
			expect(model.onReady).not.toHaveBeenCalled();
		} else {
			expect(model.onReady).toHaveBeenCalledWith(asset);
			expect(model.onRetained).not.toHaveBeenCalled();
			expect(model.checkAttachBudget).toHaveBeenCalledWith(asset);
		}
	},
);

it("refuses a viewer before staging or sending a file", async () => {
	const fetcher = vi.spyOn(globalThis, "fetch");
	const model = setup(false, false);
	await model.upload();
	expect(fetcher).not.toHaveBeenCalled();
	expect(model.session.getState().stagedUploads).toEqual({});
	expect(model.onReady).not.toHaveBeenCalled();
});

it("retains the confirmed file after its destination locks, even if editing returns before confirmation", async () => {
	const transfer = holdUpload();
	const model = setup();
	const task = model.upload();
	const signal = await transfer.reached;
	model.session.getState().markBuildUnfinished();
	expect(signal?.aborted).toBe(false);
	model.session.getState().markBuildFinished();
	transfer.response.resolve(Response.json({ deduplicated: true, asset }));
	await task;
	expect(model.onReady).not.toHaveBeenCalled();
	expect(model.onRetained).toHaveBeenCalledOnce();
	expect(model.session.getState().stagedUploads).toEqual({});
});

it("rechecks attachment availability after the budget check and keeps the confirmed file", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ deduplicated: true, asset }),
	);
	const budget = Promise.withResolvers<AttachBudgetVerdict>();
	const reachedBudget = Promise.withResolvers<void>();
	settle.push(() => budget.resolve({ ok: true }));
	const model = setup();
	model.checkAttachBudget.mockImplementation(() => {
		reachedBudget.resolve();
		return budget.promise;
	});
	const task = model.upload();
	await reachedBudget.promise;
	model.session.getState().markBuildUnfinished();
	budget.resolve({ ok: true });
	await task;
	expect(model.onReady).not.toHaveBeenCalled();
	expect(model.onRetained).toHaveBeenCalledOnce();
	expect(model.session.getState().stagedUploads).toEqual({});
});

it("keeps an upload failure visible while blueprint editing is locked", async () => {
	const transfer = holdUpload();
	const model = setup();
	const task = model.upload();
	await transfer.reached;
	model.session.getState().markBuildUnfinished();
	transfer.response.resolve(
		Response.json({ error: "Upload service unavailable" }, { status: 503 }),
	);
	await task;
	expect(model.session.getState().stagedUploads["field:image"]?.status).toEqual(
		{
			state: "error",
			message: "Upload service unavailable",
		},
	);
	expect(model.onRetained).not.toHaveBeenCalled();
});

it.each([false, true])(
	"settles a rejected attachment check and releases its subscription (locked: %s)",
	async (locked) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ deduplicated: true, asset }),
		);
		const model = setup();
		const budget = Promise.withResolvers<AttachBudgetVerdict>();
		const reachedBudget = Promise.withResolvers<void>();
		settle.push(() => budget.resolve({ ok: true }));
		model.checkAttachBudget.mockImplementation(() => {
			reachedBudget.resolve();
			return budget.promise;
		});
		const subscribe = model.session.subscribe;
		const released = vi.fn();
		vi.spyOn(model.session, "subscribe").mockImplementation((listener) => {
			const unsubscribe = subscribe(listener);
			return () => {
				unsubscribe();
				released();
			};
		});
		const task = model.upload();
		await reachedBudget.promise;
		if (locked) model.session.getState().markBuildUnfinished();
		budget.reject(new Error("Attachment check failed"));
		await task;
		expect(released).toHaveBeenCalledOnce();
		expect(model.onReady).not.toHaveBeenCalled();
		if (locked) {
			expect(model.onRetained).toHaveBeenCalledOnce();
			expect(model.session.getState().stagedUploads).toEqual({});
		} else {
			expect(model.onRetained).not.toHaveBeenCalled();
			expect(
				model.session.getState().stagedUploads["field:image"]?.status,
			).toEqual({
				state: "error",
				message: expect.stringContaining("choose it from the library"),
			});
		}
	},
);

it("keeps a rejected attachment on its staged chip without dispatching", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ deduplicated: true, asset }),
	);
	const model = setup();
	model.checkAttachBudget.mockResolvedValue({
		ok: false,
		error: "This file would exceed the app's media export limit",
	});
	await model.upload();
	expect(model.session.getState().stagedUploads["field:image"]?.status).toEqual(
		{
			state: "error",
			message: "This file would exceed the app's media export limit",
		},
	);
	expect(model.onReady).not.toHaveBeenCalled();
	expect(model.onRetained).not.toHaveBeenCalled();
});

it.each(["cancel", "refresh", "reconnect", "revoke", "viewer", "project"])(
	"clears and cancels a transfer on %s and ignores its late confirmation",
	async (boundary) => {
		const transfer = holdUpload();
		const model = setup();
		const task = model.upload();
		const signal = await transfer.reached;
		const state = model.session.getState();
		if (boundary === "cancel") state.cancelStagedUpload("field:image");
		else if (boundary === "refresh") state.beginAccessRefresh();
		else if (boundary === "reconnect") state.markAccessReconnecting();
		else if (boundary === "revoke") state.revokeAccess();
		else
			state.applyAccessSnapshot({
				projectId: boundary === "project" ? "project-b" : "project-a",
				role: boundary === "viewer" ? "viewer" : "editor",
				canEdit: boundary !== "viewer",
			});
		expect(signal?.aborted).toBe(true);
		expect(model.session.getState().stagedUploads).toEqual({});
		transfer.response.resolve(Response.json({ deduplicated: true, asset }));
		await task;
		expect(model.onReady).not.toHaveBeenCalled();
		expect(model.onRetained).not.toHaveBeenCalled();
		expect(model.session.getState().stagedUploads).toEqual({});
	},
);

it.each(["confirm", "error"])(
	"does not let a replaced transfer's late %s clear or fail the replacement slot",
	async (outcome) => {
		const original = holdUpload();
		const model = setup();
		const oldTask = model.upload();
		const oldSignal = await original.reached;
		const replacement = holdUpload();
		const newTask = model.upload();
		await replacement.reached;
		expect(oldSignal?.aborted).toBe(true);
		original.response.resolve(
			outcome === "confirm"
				? Response.json({ deduplicated: true, asset })
				: Response.json({ error: "Old upload failed" }, { status: 503 }),
		);
		await oldTask;
		expect(
			model.session.getState().stagedUploads["field:image"]?.status,
		).toEqual({
			state: "uploading",
			progress: 0,
		});
		expect(model.onReady).not.toHaveBeenCalled();
		replacement.response.resolve(Response.json({ deduplicated: true, asset }));
		await newTask;
		expect(model.onReady).toHaveBeenCalledOnce();
		expect(model.session.getState().stagedUploads).toEqual({});
	},
);
