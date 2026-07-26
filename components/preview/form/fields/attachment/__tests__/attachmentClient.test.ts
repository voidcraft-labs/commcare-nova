import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__resetAttachmentCoordinatorForTests,
	cancelAttachmentEntry,
	clearAttachmentNotReady,
	discardAttachmentEntry,
	getAttachmentSlotPath,
	getOwnedStagedAttachment,
	isAttachmentTaskAbort,
	markAttachmentNotReady,
	reconcileAttachmentRepeatCompaction,
	registerAttachmentSlotPath,
	rememberOwnedStagedAttachment,
	runAttachmentTask,
	runFormAttachmentBarrier,
	stageAttachment,
} from "../attachmentClient";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

afterEach(() => {
	__resetAttachmentCoordinatorForTests();
	vi.unstubAllGlobals();
});

describe("form attachment coordinator", () => {
	it("serializes mutations across different paths in one entry", async () => {
		const firstRelease = deferred<void>();
		const order: string[] = [];
		const first = runAttachmentTask({
			entryKey: "entry-serialize",
			instancePath: "/data/first",
			task: async () => {
				order.push("first:start");
				await firstRelease.promise;
				order.push("first:end");
			},
		});
		const second = runAttachmentTask({
			entryKey: "entry-serialize",
			instancePath: "/data/second",
			task: async () => {
				order.push("second:start");
			},
		});
		await vi.waitFor(() => expect(order).toEqual(["first:start"]));
		firstRelease.resolve();
		await Promise.all([first, second]);

		expect(order).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("aborts and generation-fences a superseded path", async () => {
		const observations: string[] = [];
		let firstWasCurrent: (() => boolean) | undefined;
		const first = runAttachmentTask({
			entryKey: "entry-latest",
			instancePath: "/data/photo",
			task: async ({ signal, isCurrent }) => {
				firstWasCurrent = isCurrent;
				observations.push("first:start");
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			},
		}).catch((error: unknown) => {
			expect(isAttachmentTaskAbort(error)).toBe(true);
			observations.push("first:aborted");
		});
		await vi.waitFor(() => expect(observations).toEqual(["first:start"]));

		const second = runAttachmentTask({
			entryKey: "entry-latest",
			instancePath: "/data/photo",
			task: async ({ isCurrent }) => {
				observations.push(`second:current=${isCurrent()}`);
			},
		});
		expect(firstWasCurrent?.()).toBe(false);
		await Promise.all([first, second]);

		expect(observations[0]).toBe("first:start");
		expect(observations.slice(1)).toEqual(
			expect.arrayContaining(["first:aborted", "second:current=true"]),
		);
		expect(observations).toHaveLength(3);
	});

	it("places submit behind prior capture work and before later capture work", async () => {
		const uploadRelease = deferred<void>();
		const submitRelease = deferred<void>();
		const order: string[] = [];
		const upload = runAttachmentTask({
			entryKey: "entry-barrier",
			instancePath: "/data/photo",
			task: async () => {
				order.push("upload");
				await uploadRelease.promise;
			},
		});
		const submit = runFormAttachmentBarrier("entry-barrier", async () => {
			order.push("submit");
			await submitRelease.promise;
		});
		const later = runAttachmentTask({
			entryKey: "entry-barrier",
			instancePath: "/data/signature",
			task: async () => {
				order.push("later");
			},
		});

		await vi.waitFor(() => expect(order).toEqual(["upload"]));
		uploadRelease.resolve();
		await vi.waitFor(() => expect(order).toEqual(["upload", "submit"]));
		submitRelease.resolve();
		await Promise.all([upload, submit, later]);
		expect(order).toEqual(["upload", "submit", "later"]);
	});

	it("cancels every active path before a form reset barrier", async () => {
		const errors: unknown[] = [];
		const active = ["/data/photo", "/data/signature"].map((instancePath) =>
			runAttachmentTask({
				entryKey: "entry-reset",
				instancePath,
				task: async ({ signal }) => {
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				},
			}).catch((error: unknown) => errors.push(error)),
		);
		await Promise.resolve();
		cancelAttachmentEntry("entry-reset");
		let resetRan = false;
		await runFormAttachmentBarrier("entry-reset", async () => {
			resetRan = true;
		});
		await Promise.all(active);

		expect(errors).toHaveLength(2);
		expect(errors.every(isAttachmentTaskAbort)).toBe(true);
		expect(resetRan).toBe(true);
	});

	it("blocks submit while visible capture data is not yet safely encoded", async () => {
		markAttachmentNotReady(
			"entry-dirty",
			"/data/signature",
			"The signature couldn't be saved.",
		);

		await expect(
			runFormAttachmentBarrier("entry-dirty", async () => "submitted"),
		).rejects.toThrow(/signature couldn't be saved/i);

		clearAttachmentNotReady("entry-dirty", "/data/signature");
		await expect(
			runFormAttachmentBarrier("entry-dirty", async () => "submitted"),
		).resolves.toBe("submitted");
	});

	it("only lets effectively visible capture blockers gate submission", async () => {
		const entryKey = "entry-effective-visibility";
		const slotKey = "signature:stable-instance";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visit/signature",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visit/signature",
			attachment: {
				attachmentId: "attachment-deleted-field",
				attachmentName: "attachment-deleted-field.png",
				originalFilename: "signature.png",
				sizeBytes: 3,
			},
		});
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);
		markAttachmentNotReady(
			entryKey,
			slotKey,
			"The signature could not be encoded.",
		);

		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted while hidden", {
				classifySlot: () => "dormant",
			}),
		).resolves.toBe("submitted while hidden");

		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted", {
				classifySlot: () => "active",
			}),
		).rejects.toThrow(/could not be encoded/i);

		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted after delete", {
				classifySlot: () => "removed",
			}),
		).resolves.toBe("submitted after delete");
		expect(
			getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/apps/app-1/attachments/attachment-deleted-field",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("keeps a confirmed row owned by the entry across ordinary component unmounts", async () => {
		const staged = {
			attachmentId: "attachment-keep",
			attachmentName: "attachment-keep.png",
			originalFilename: "photo.png",
			sizeBytes: 3,
		};
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey: "entry-keep",
			instancePath: "/data/photo",
			attachment: staged,
		});

		// A relevance/group/edit-mode remount performs no ownership mutation.
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey: "entry-keep",
				instancePath: "/data/photo",
			}),
		).toEqual(staged);

		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);
		await discardAttachmentEntry({
			appId: "app-1",
			entryKey: "entry-keep",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/apps/app-1/attachments/attachment-keep",
			expect.objectContaining({ method: "DELETE" }),
		);
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey: "entry-keep",
				instancePath: "/data/photo",
			}),
		).toBeUndefined();
	});

	it("retargets a hidden capture before the post-compaction submit barrier", async () => {
		const entryKey = "entry-hidden-repeat";
		const slotKey = "photo:stable-row-2";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			attachment: {
				attachmentId: "attachment-hidden",
				attachmentName: "attachment-hidden.png",
				originalFilename: "hidden.png",
				sizeBytes: 3,
			},
		});
		const order: string[] = [];
		const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
			order.push("retarget");
			expect(init).toMatchObject({ method: "PATCH" });
			expect(JSON.parse(String(init?.body))).toEqual({
				expectedInstancePath: "/data/visits[1]/photo",
				instancePath: "/data/visits[0]/photo",
			});
			return { ok: true, status: 200 };
		});
		vi.stubGlobal("fetch", fetchMock);

		// No AttachmentField is mounted here: relevance hid it before row 1
		// was removed. The entry/form owner still receives compaction.
		const maintenance = reconcileAttachmentRepeatCompaction({
			appId: "app-1",
			entryKey,
			compaction: {
				removedPrefix: "/data/visits[0]",
				moves: [
					{
						fromPrefix: "/data/visits[1]",
						toPrefix: "/data/visits[0]",
					},
				],
			},
		});
		const submit = runFormAttachmentBarrier(entryKey, async () => {
			order.push("submit");
		});
		await Promise.all([maintenance, submit]);

		expect(order).toEqual(["retarget", "submit"]);
		expect(getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey })).toBe(
			"/data/visits[0]/photo",
		);
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		)?.toMatchObject({ attachmentId: "attachment-hidden" });
	});

	it("cancels and discards a hidden capture whose repeat instance was removed", async () => {
		const entryKey = "entry-hidden-removed-repeat";
		const slotKey = "signature:removed-row";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[0]/signature",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[0]/signature",
			attachment: {
				attachmentId: "attachment-removed",
				attachmentName: "attachment-removed.png",
				originalFilename: "signature.png",
				sizeBytes: 3,
			},
		});
		markAttachmentNotReady(
			entryKey,
			slotKey,
			"The removed signature is still being saved.",
		);
		const active = runAttachmentTask({
			entryKey,
			slotKey,
			task: async ({ signal }) => {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			},
		}).catch((error: unknown) => {
			expect(isAttachmentTaskAbort(error)).toBe(true);
		});
		await Promise.resolve();

		const order: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				order.push("discard");
				return { ok: true, status: 200 };
			}),
		);
		const maintenance = reconcileAttachmentRepeatCompaction({
			appId: "app-1",
			entryKey,
			compaction: {
				removedPrefix: "/data/visits[0]",
				moves: [],
			},
		});
		const submit = runFormAttachmentBarrier(entryKey, async () => {
			order.push("submit");
		});
		await Promise.all([active, maintenance, submit]);

		expect(order).toEqual(["discard", "submit"]);
		expect(
			getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
	});

	it("retargets the newest row when compaction races an already queued replacement", async () => {
		const entryKey = "entry-latest-compaction";
		const slotKey = "signature:stable-row-2";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/signature",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/signature",
			attachment: {
				attachmentId: "attachment-old",
				attachmentName: "attachment-old.png",
				originalFilename: "signature.png",
				sizeBytes: 3,
			},
		});
		const replacementRelease = deferred<void>();
		const replacement = runAttachmentTask({
			entryKey,
			slotKey,
			task: async () => {
				await replacementRelease.promise;
				rememberOwnedStagedAttachment({
					appId: "app-1",
					entryKey,
					slotKey,
					// The upload began before compaction, so confirm still owns
					// the old concrete coordinate.
					instancePath: "/data/visits[1]/signature",
					attachment: {
						attachmentId: "attachment-latest",
						attachmentName: "attachment-latest.png",
						originalFilename: "signature.png",
						sizeBytes: 4,
					},
				});
			},
		});
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);
		const maintenance = reconcileAttachmentRepeatCompaction({
			appId: "app-1",
			entryKey,
			compaction: {
				removedPrefix: "/data/visits[0]",
				moves: [
					{
						fromPrefix: "/data/visits[1]",
						toPrefix: "/data/visits[0]",
					},
				],
			},
		});
		let submitted = false;
		const submit = runFormAttachmentBarrier(entryKey, async () => {
			submitted = true;
		});
		await Promise.resolve();
		expect(submitted).toBe(false);

		replacementRelease.resolve();
		await Promise.all([replacement, maintenance, submit]);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/apps/app-1/attachments/attachment-latest",
			expect.objectContaining({ method: "PATCH" }),
		);
		expect(submitted).toBe(true);
	});

	it("clears a failed retarget before the submit barrier can observe the answer", async () => {
		const entryKey = "entry-retarget-failure";
		const slotKey = "photo:stable-row-2";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			attachment: {
				attachmentId: "attachment-failed-retarget",
				attachmentName: "attachment-failed-retarget.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		const order: string[] = [];
		const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
			if (init?.method === "PATCH") {
				order.push("retarget");
				return { ok: false, status: 409 };
			}
			order.push("discard");
			return { ok: true, status: 200 };
		});
		vi.stubGlobal("fetch", fetchMock);

		const maintenance = reconcileAttachmentRepeatCompaction({
			appId: "app-1",
			entryKey,
			compaction: {
				removedPrefix: "/data/visits[0]",
				moves: [
					{
						fromPrefix: "/data/visits[1]",
						toPrefix: "/data/visits[0]",
					},
				],
			},
			onRetargetFailure: ({ instancePath }) => {
				order.push(`clear:${instancePath}`);
			},
		});
		const submit = runFormAttachmentBarrier(entryKey, async () => {
			order.push("submit");
		});

		await Promise.all([maintenance, submit]);

		expect(order).toEqual([
			"retarget",
			"discard",
			"clear:/data/visits[0]/photo",
			"submit",
		]);
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
	});
});

describe("stageAttachment", () => {
	it("confirms after an ambiguous create-only 412", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					attachmentId: "attachment-1",
					attachmentName: "attachment-1.png",
					uploadUrl: "https://storage.test/upload",
					uploadContentType: "image/png",
					uploadHeaders: { "x-goog-if-generation-match": "0" },
				}),
			})
			.mockResolvedValueOnce({ ok: false, status: 412 })
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					attachmentId: "attachment-1",
					attachmentName: "attachment-1.png",
					originalFilename: "photo.png",
					sizeBytes: 3,
				}),
			});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			stageAttachment({
				appId: "app-1",
				entryKey: "11111111-1111-4111-8111-111111111111",
				fieldUuid: "22222222-2222-4222-8222-222222222222",
				instancePath: "/data/photo",
				file: { name: "photo.png", size: 3 } as File,
			}),
		).resolves.toMatchObject({
			attachmentId: "attachment-1",
			attachmentName: "attachment-1.png",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
