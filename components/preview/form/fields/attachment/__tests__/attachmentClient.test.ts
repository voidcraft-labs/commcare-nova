import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__resetAttachmentCoordinatorForTests,
	type AttachmentAuthoredPathMigration,
	type AttachmentEntryAuthoritySnapshot,
	type AttachmentEntryWriteAuthorityToken,
	cancelAttachmentEntry,
	captureAttachmentEntryWriteAuthority,
	clearAttachmentNotReady,
	discardAttachment,
	discardAttachmentEntry,
	discardAttachmentInvariantRecovery,
	getAttachmentSlotDraft,
	getAttachmentSlotIssue,
	getAttachmentSlotPath,
	getOwnedStagedAttachment,
	getSignatureDraft,
	isAttachmentTaskAbort,
	listAttachmentInvariantRecoveries,
	markAttachmentNotReady,
	reconcileAttachmentAuthoredPathMigration,
	reconcileAttachmentRepeatCompaction,
	registerAttachmentSlotPath,
	rememberAttachmentSlotDraft,
	rememberOwnedStagedAttachment,
	rememberSignatureDraft,
	resolveAttachmentSlotKey,
	retargetAttachment,
	retryAttachmentRetarget,
	runAttachmentTask,
	runFormAttachmentBarrier,
	runWithAttachmentEntryWriteAuthority,
	setAttachmentEntryAuthority,
	stageAttachment,
} from "../attachmentClient";

function defaultSegmentKeys(pathTemplate: string, fieldUuid: string): string[] {
	const depth = pathTemplate.split("/").filter(Boolean).length;
	return [
		"$data",
		...Array.from(
			{ length: Math.max(0, depth - 2) },
			(_, index) => `ancestor-${index}`,
		),
		fieldUuid,
	];
}

function retainedCaptureMove(args: {
	fieldUuid: string;
	previousPath: string;
	currentPath: string;
	previousCaptureKind?: string | null;
	currentCaptureKind?: string | null;
	previousSegmentKeys?: readonly string[];
	currentSegmentKeys?: readonly string[];
}): AttachmentAuthoredPathMigration["moves"][number] {
	return {
		kind: "retained",
		fieldUuid: args.fieldUuid,
		previous: {
			pathTemplate: args.previousPath,
			segmentKeys:
				args.previousSegmentKeys ??
				defaultSegmentKeys(args.previousPath, args.fieldUuid),
			...(args.previousCaptureKind === null
				? {}
				: { captureKind: args.previousCaptureKind ?? "image" }),
		},
		current: {
			pathTemplate: args.currentPath,
			segmentKeys:
				args.currentSegmentKeys ??
				defaultSegmentKeys(args.currentPath, args.fieldUuid),
			...(args.currentCaptureKind === null
				? {}
				: { captureKind: args.currentCaptureKind ?? "image" }),
		},
	};
}

function deletedCaptureMove(args: {
	fieldUuid: string;
	previousPath: string;
	previousSegmentKeys?: readonly string[];
	captureKind?: string;
}): AttachmentAuthoredPathMigration["moves"][number] {
	return {
		kind: "deleted",
		fieldUuid: args.fieldUuid,
		previous: {
			pathTemplate: args.previousPath,
			segmentKeys:
				args.previousSegmentKeys ??
				defaultSegmentKeys(args.previousPath, args.fieldUuid),
			captureKind: args.captureKind ?? "image",
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function waitForAbort(
	signal: AbortSignal | null | undefined,
): Promise<Response> {
	return new Promise((_resolve, reject) => {
		if (signal === undefined || signal === null) {
			reject(new Error("Expected cleanup fetch to carry an abort signal."));
			return;
		}
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

function waitForBodyAbort(
	signal: AbortSignal | null | undefined,
): Promise<ArrayBuffer> {
	return new Promise((_resolve, reject) => {
		if (signal === undefined || signal === null) {
			reject(
				new Error("Expected response-body read to carry an abort signal."),
			);
			return;
		}
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

afterEach(async () => {
	await __resetAttachmentCoordinatorForTests();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("form attachment coordinator", () => {
	it("rejects destructive callbacks captured before authority loss and restoration", async () => {
		const entryKey = "entry-stale-destructive-authority";
		const slotKey = "photo:stale-destructive-authority";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		let current: AttachmentEntryAuthoritySnapshot = {
			appId: "app-1",
			scopeEpoch: 1,
			accessPhase: "authorized",
			canEdit: true,
		};
		const install = () =>
			setAttachmentEntryAuthority({
				entryKey,
				snapshot: current,
				readCurrent: () => current,
			});
		install();
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/legacy/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/legacy/photo",
			attachment: {
				attachmentId: "attachment-stale-destructive-authority",
				attachmentName: "attachment-stale-destructive-authority.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/legacy/photo",
						currentPath: "/data/current/photo",
						previousSegmentKeys: ["$data", "duplicate", "duplicate"],
						currentSegmentKeys: ["$data", "duplicate", "duplicate"],
					}),
				],
			},
		});
		expect(
			listAttachmentInvariantRecoveries({ appId: "app-1", entryKey }),
		).toHaveLength(1);
		const staleAuthority = captureAttachmentEntryWriteAuthority(entryKey, 1);
		expect(staleAuthority).toBeDefined();
		const fabricatedAuthority = {} as AttachmentEntryWriteAuthorityToken;
		const fabricatedRemoval = vi.fn();
		expect(
			runWithAttachmentEntryWriteAuthority({
				entryKey,
				token: fabricatedAuthority,
				action: fabricatedRemoval,
			}),
		).toBe(false);
		expect(fabricatedRemoval).not.toHaveBeenCalled();

		current = {
			appId: "app-1",
			scopeEpoch: 2,
			accessPhase: "refreshing",
			canEdit: false,
		};
		install();
		current = {
			appId: "app-1",
			scopeEpoch: 2,
			accessPhase: "authorized",
			canEdit: true,
		};
		install();

		const staleRepeatRemoval = vi.fn();
		expect(
			runWithAttachmentEntryWriteAuthority({
				entryKey,
				token: staleAuthority,
				action: staleRepeatRemoval,
			}),
		).toBe(false);
		expect(staleRepeatRemoval).not.toHaveBeenCalled();
		expect(
			discardAttachmentInvariantRecovery({
				appId: "app-1",
				entryKey,
				slotKey,
				authority: staleAuthority,
			}),
		).toBe(false);
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		).toMatchObject({
			attachmentId: "attachment-stale-destructive-authority",
		});

		const restoredAuthority = captureAttachmentEntryWriteAuthority(entryKey, 2);
		expect(restoredAuthority).toBeDefined();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, status: 200 }),
		);
		expect(
			discardAttachmentInvariantRecovery({
				appId: "app-1",
				entryKey,
				slotKey,
				authority: restoredAuthority,
			}),
		).toBe(true);
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
	});

	it("entry authority fences queued slotless work and preserves a clean restored submit", async () => {
		const entryKey = "entry-authority-generation";
		let current: AttachmentEntryAuthoritySnapshot = {
			appId: "app-1",
			scopeEpoch: 1,
			accessPhase: "authorized",
			canEdit: true,
		};
		const install = () =>
			setAttachmentEntryAuthority({
				entryKey,
				snapshot: current,
				readCurrent: () => current,
			});
		install();

		const blockerRelease = deferred<void>();
		const blockerStarted = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey,
			slotKey: "other-slot",
			task: async () => {
				blockerStarted.resolve();
				await blockerRelease.promise;
			},
		});
		await blockerStarted.promise;
		const emitted = vi.fn();
		const staleSignature = runAttachmentTask({
			entryKey,
			slotKey: "signature-slot",
			task: async () => {
				emitted();
			},
		});
		const blockerRejected = expect(blocker).rejects.toMatchObject({
			name: "AbortError",
		});
		const signatureRejected = expect(staleSignature).rejects.toMatchObject({
			name: "AbortError",
		});

		current = {
			appId: "app-1",
			scopeEpoch: 2,
			accessPhase: "refreshing",
			canEdit: false,
		};
		install();
		current = {
			appId: "app-1",
			scopeEpoch: 2,
			accessPhase: "authorized",
			canEdit: true,
		};
		install();
		const submitted = vi.fn();
		const submit = runFormAttachmentBarrier(entryKey, async () => {
			submitted();
		});

		blockerRelease.resolve();
		await Promise.all([blockerRejected, signatureRejected, submit]);
		expect(emitted).not.toHaveBeenCalled();
		expect(submitted).toHaveBeenCalledOnce();
	});

	it("restores an authority-canceled retarget before the first restored Submit", async () => {
		const entryKey = "entry-authority-retarget-restore";
		const slotKey = "photo:authority-retarget";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		let current: AttachmentEntryAuthoritySnapshot = {
			appId: "app-1",
			scopeEpoch: 1,
			accessPhase: "authorized",
			canEdit: true,
		};
		const install = () =>
			setAttachmentEntryAuthority({
				entryKey,
				snapshot: current,
				readCurrent: () => current,
			});
		install();
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
			attachment: {
				attachmentId: "attachment-authority-retarget",
				attachmentName: "attachment-authority-retarget.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		const firstPatchStarted = deferred<void>();
		const order: string[] = [];
		const patchBodies: unknown[] = [];
		let patchCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				patchCount += 1;
				patchBodies.push(JSON.parse(String(init?.body)));
				if (patchCount === 1) {
					firstPatchStarted.resolve();
					return waitForAbort(init?.signal);
				}
				order.push(patchCount === 2 ? "restored-retarget" : "next-retarget");
				return Promise.resolve({ ok: true, status: 200 });
			}),
		);

		const interrupted = reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/photo",
						currentPath: "/data/evidence",
					}),
				],
			},
		});
		await firstPatchStarted.promise;

		current = {
			appId: "app-1",
			scopeEpoch: 2,
			accessPhase: "refreshing",
			canEdit: false,
		};
		install();
		current = {
			appId: "app-1",
			scopeEpoch: 2,
			accessPhase: "authorized",
			canEdit: true,
		};
		install();
		const submit = runFormAttachmentBarrier(entryKey, async () => {
			order.push("submit");
		});
		await Promise.all([interrupted, submit]);

		expect(order).toEqual(["restored-retarget", "submit"]);
		expect(getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey })).toBe(
			"/data/evidence",
		);
		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/evidence",
						currentPath: "/data/archive",
					}),
				],
			},
		});
		expect(patchBodies).toEqual([
			{
				expectedInstancePath: "/data/photo",
				instancePath: "/data/evidence",
			},
			{
				expectedInstancePath: "/data/photo",
				instancePath: "/data/evidence",
			},
			{
				expectedInstancePath: "/data/evidence",
				instancePath: "/data/archive",
			},
		]);
	});

	it("preserves upload retarget intent through a hung PATCH and access refresh", async () => {
		const entryKey = "entry-upload-move-authority-restore";
		const slotKey = "photo:upload-move";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		let current: AttachmentEntryAuthoritySnapshot = {
			appId: "app-1",
			scopeEpoch: 1,
			accessPhase: "authorized",
			canEdit: true,
		};
		const install = () =>
			setAttachmentEntryAuthority({
				entryKey,
				snapshot: current,
				readCurrent: () => current,
			});
		install();
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/photo",
			captureKind: "image",
		});

		const uploadRelease = deferred<void>();
		const upload = runAttachmentTask({
			entryKey,
			slotKey,
			task: async () => {
				await uploadRelease.promise;
				rememberOwnedStagedAttachment({
					appId: "app-1",
					entryKey,
					slotKey,
					// Upload started before the author moved the question.
					instancePath: "/data/photo",
					attachment: {
						attachmentId: "attachment-upload-move",
						attachmentName: "attachment-upload-move.png",
						originalFilename: "photo.png",
						sizeBytes: 3,
					},
				});
			},
		});
		const firstPatchStarted = deferred<void>();
		const order: string[] = [];
		let patchCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				patchCount += 1;
				if (patchCount === 1) {
					firstPatchStarted.resolve();
					return waitForAbort(init?.signal);
				}
				order.push("restored-retarget");
				return Promise.resolve({ ok: true, status: 200 });
			}),
		);
		const moved = reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/photo",
						currentPath: "/data/evidence",
					}),
				],
			},
		});
		uploadRelease.resolve();
		await upload;
		await firstPatchStarted.promise;

		current = {
			appId: "app-1",
			scopeEpoch: 2,
			accessPhase: "refreshing",
			canEdit: false,
		};
		install();
		current = {
			appId: "app-1",
			scopeEpoch: 2,
			accessPhase: "authorized",
			canEdit: true,
		};
		install();
		const submit = runFormAttachmentBarrier(entryKey, async () => {
			order.push("submit");
			return "submitted";
		});
		await expect(moved).resolves.toEqual([]);
		await expect(submit).resolves.toBe("submitted");

		expect(order).toEqual(["restored-retarget", "submit"]);
		expect(patchCount).toBe(2);
		expect(getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey })).toBe(
			"/data/evidence",
		);
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		).toMatchObject({ attachmentId: "attachment-upload-move" });
	});

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

	it("identifies the exact active attachment recovery target that blocks Submit", async () => {
		const entryKey = "entry-targeted-blocker";
		const slotKey = "signature:stable-row";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/visits[1]/signature",
			captureKind: "signature",
		});
		markAttachmentNotReady(
			entryKey,
			slotKey,
			"The signature needs recovery before this form can be submitted.",
		);

		const error = await runFormAttachmentBarrier(
			entryKey,
			async () => "must not submit",
		).catch((reason: unknown) => reason);

		expect(error).toMatchObject({
			name: "AttachmentNotReadyError",
			slotKey,
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/visits[1]/signature",
			message:
				"The signature needs recovery before this form can be submitted.",
		});
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

	it("pre-classifies and cancels a signal-aware dormant task before joining its queue", async () => {
		const entryKey = "entry-dormant-before-barrier";
		const slotKey = "signature:conditional";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/conditional/signature",
		});
		markAttachmentNotReady(
			entryKey,
			slotKey,
			"The hidden signature is still being saved.",
		);
		const started = deferred<void>();
		let aborted = false;
		const active = runAttachmentTask({
			entryKey,
			slotKey,
			task: async ({ signal }) => {
				started.resolve();
				await new Promise<never>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(signal.reason);
						},
						{ once: true },
					);
				});
			},
		}).catch((error: unknown) => {
			expect(isAttachmentTaskAbort(error)).toBe(true);
		});
		await started.promise;

		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted", {
				classifySlot: () => "dormant",
			}),
		).resolves.toBe("submitted");
		await active;
		expect(aborted).toBe(true);

		// Dormancy preserves the draft blocker. If the question reappears,
		// its failed/unfinished signature becomes actionable again.
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "must not submit", {
				classifySlot: () => "active",
			}),
		).rejects.toThrow(/hidden signature is still being saved/i);
	});

	it("reclassifies a slot that becomes dormant while Submit is waiting", async () => {
		vi.useFakeTimers();
		try {
			const entryKey = "entry-dormant-during-barrier";
			const slotKey = "signature:changing-relevance";
			registerAttachmentSlotPath({
				appId: "app-1",
				entryKey,
				slotKey,
				instancePath: "/data/conditional/signature",
			});
			const started = deferred<void>();
			const active = runAttachmentTask({
				entryKey,
				slotKey,
				task: async ({ signal }) => {
					started.resolve();
					await new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				},
			}).catch((error: unknown) => {
				expect(isAttachmentTaskAbort(error)).toBe(true);
			});
			await started.promise;
			let disposition: "active" | "dormant" = "active";
			let submitted = false;
			const barrier = runFormAttachmentBarrier(
				entryKey,
				async () => {
					submitted = true;
				},
				{ classifySlot: () => disposition },
			);
			await Promise.resolve();
			expect(submitted).toBe(false);

			disposition = "dormant";
			await vi.advanceTimersByTimeAsync(100);
			await barrier;
			await active;
			expect(submitted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves a queued Clear intent when its real slot becomes dormant", async () => {
		const entryKey = "entry-dormant-clear";
		const slotKey = "signature:conditional-clear";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/conditional/signature",
			captureKind: "signature",
		});
		const activeStarted = deferred<void>();
		const active = runAttachmentTask({
			entryKey,
			slotKey,
			task: async ({ signal }) => {
				activeStarted.resolve();
				await new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			},
		}).catch((error: unknown) => {
			expect(isAttachmentTaskAbort(error)).toBe(true);
		});
		await activeStarted.promise;

		let clearRan = false;
		const clear = runAttachmentTask({
			entryKey,
			slotKey: "$nova-clear$signature:conditional-clear:1",
			target: {
				slotKey,
				instancePath: "/data/conditional/signature",
			},
			task: async () => {
				clearRan = true;
			},
		}).catch((error: unknown) => {
			expect(isAttachmentTaskAbort(error)).toBe(true);
		});

		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted", {
				classifySlot: () => "dormant",
			}),
		).resolves.toBe("submitted");
		await Promise.all([active, clear]);
		expect(clearRan).toBe(true);
	});

	it("suspends a dormant confirmed retarget and repairs it before a later active Submit", async () => {
		const entryKey = "entry-dormant-retarget";
		const slotKey = "photo:conditional-repeat";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			attachment: {
				attachmentId: "attachment-retarget-hung",
				attachmentName: "attachment-retarget-hung.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		const firstPatchStarted = deferred<void>();
		const lostResponse = deferred<Response>();
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(() => {
				firstPatchStarted.resolve();
				// The server may have committed this PATCH even though its response
				// remains unavailable when dormancy cancels the client boundary.
				return lostResponse.promise;
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ instancePath: "/data/visits[0]/photo" }),
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
		});
		await firstPatchStarted.promise;

		await expect(
			runFormAttachmentBarrier(
				entryKey,
				async () => {
					throw new Error("server rejected stale attachment path");
				},
				{
					classifySlot: () => "dormant",
				},
			),
		).rejects.toThrow("server rejected stale attachment path");
		await expect(maintenance).resolves.toEqual([]);
		expect(
			getAttachmentSlotIssue({ appId: "app-1", entryKey, slotKey }),
		).toMatchObject({ kind: "retarget" });
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		).toMatchObject({ attachmentId: "attachment-retarget-hung" });
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
		).toHaveLength(0);

		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted", {
				classifySlot: () => "active",
			}),
		).resolves.toBe("submitted");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
			expectedInstancePath: "/data/visits[1]/photo",
			instancePath: "/data/visits[0]/photo",
		});
		expect(
			getAttachmentSlotIssue({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();

		lostResponse.resolve({
			ok: true,
			status: 200,
			json: async () => ({ instancePath: "/data/visits[0]/photo" }),
		} as Response);
		await Promise.resolve();
		expect(
			getAttachmentSlotIssue({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
	});

	it("lets a newer slot intent supersede a hung retarget", async () => {
		const entryKey = "entry-replacement-over-retarget";
		const slotKey = "photo:replacement-repeat";
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
				attachmentId: "attachment-retarget-before-replacement",
				attachmentName: "attachment-retarget-before-replacement.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		const retargetStarted = deferred<void>();
		vi.stubGlobal(
			"fetch",
			vi.fn((_url, init?: RequestInit) => {
				retargetStarted.resolve();
				return new Promise<never>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				});
			}),
		);
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
		await retargetStarted.promise;

		const replacement = vi.fn();
		await runAttachmentTask({
			entryKey,
			slotKey,
			task: async () => replacement(),
		});

		expect(replacement).toHaveBeenCalledOnce();
		await expect(maintenance).resolves.toEqual([]);
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

	it.each([
		{
			name: "capture field",
			oldTemplate: "/data/photo",
			newTemplate: "/data/evidence",
			oldPath: "/data/photo",
			newPath: "/data/evidence",
		},
		{
			name: "capture ancestor",
			oldTemplate: "/data/visit/photo",
			newTemplate: "/data/encounter/photo",
			oldPath: "/data/visit/photo",
			newPath: "/data/encounter/photo",
		},
	])(
		"retargets a confirmed row when its authored $name is renamed",
		async ({ name, oldTemplate, newTemplate, oldPath, newPath }) => {
			const entryKey = `entry-authored-${name}`;
			const slotKey = `photo:${name}`;
			const fieldUuid = "22222222-2222-4222-8222-222222222222";
			registerAttachmentSlotPath({
				appId: "app-1",
				entryKey,
				slotKey,
				fieldUuid,
				instancePath: oldPath,
				captureKind: "image",
			});
			rememberOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				slotKey,
				instancePath: oldPath,
				attachment: {
					attachmentId: `attachment-${name}`,
					attachmentName: `attachment-${name}.png`,
					originalFilename: "photo.png",
					sizeBytes: 3,
				},
			});
			const order: string[] = [];
			const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
				order.push("retarget");
				expect(JSON.parse(String(init?.body))).toEqual({
					expectedInstancePath: oldPath,
					instancePath: newPath,
				});
				return { ok: true, status: 200 };
			});
			vi.stubGlobal("fetch", fetchMock);

			const maintenance = reconcileAttachmentAuthoredPathMigration({
				appId: "app-1",
				entryKey,
				migration: {
					moves: [
						retainedCaptureMove({
							fieldUuid,
							previousPath: oldTemplate,
							currentPath: newTemplate,
						}),
					],
				},
			});
			const submit = runFormAttachmentBarrier(entryKey, async () => {
				order.push("submit");
			});
			await Promise.all([maintenance, submit]);

			expect(order).toEqual(["retarget", "submit"]);
			expect(getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey })).toBe(
				newPath,
			);
		},
	);

	it("serializes an authored rename behind an in-flight upload and ahead of Submit", async () => {
		const entryKey = "entry-authored-upload-race";
		const slotKey = "photo:stable";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/photo",
			captureKind: "image",
		});
		const uploadRelease = deferred<void>();
		const order: string[] = [];
		const upload = runAttachmentTask({
			entryKey,
			slotKey,
			task: async () => {
				await uploadRelease.promise;
				rememberOwnedStagedAttachment({
					appId: "app-1",
					entryKey,
					slotKey,
					instancePath: "/data/photo",
					attachment: {
						attachmentId: "attachment-uploaded-before-rename",
						attachmentName: "attachment-uploaded-before-rename.png",
						originalFilename: "photo.png",
						sizeBytes: 3,
					},
				});
				order.push("upload");
			},
		});
		const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
			order.push("retarget");
			expect(JSON.parse(String(init?.body))).toEqual({
				expectedInstancePath: "/data/photo",
				instancePath: "/data/evidence",
			});
			return { ok: true, status: 200 };
		});
		vi.stubGlobal("fetch", fetchMock);
		const maintenance = reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/photo",
						currentPath: "/data/evidence",
					}),
				],
			},
		});
		const submit = runFormAttachmentBarrier(entryKey, async () => {
			order.push("submit");
		});
		await Promise.resolve();
		expect(order).toEqual([]);

		uploadRelease.resolve();
		await Promise.all([upload, maintenance, submit]);
		expect(order).toEqual(["upload", "retarget", "submit"]);
	});

	it("migrates group↔repeat ownership by stable field UUID and retires extra repeat instances", async () => {
		const entryKey = "entry-authored-container-conversion";
		const slotKey = "photo:group-owner";
		const extraSlotKey = "photo:repeat-extra";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/visit/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visit/photo",
			attachment: {
				attachmentId: "attachment-first-instance",
				attachmentName: "attachment-first-instance.png",
				originalFilename: "first.png",
				sizeBytes: 3,
			},
		});
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);

		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/visit/photo",
						currentPath: "/data/visit[0]/photo",
					}),
				],
			},
		});
		expect(
			resolveAttachmentSlotKey({
				appId: "app-1",
				entryKey,
				requestedSlotKey: "photo:new-repeat-render-key",
				instancePath: "/data/visit[0]/photo",
				fieldUuid,
			}),
		).toBe(slotKey);

		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey: extraSlotKey,
			fieldUuid,
			instancePath: "/data/visit[1]/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey: extraSlotKey,
			instancePath: "/data/visit[1]/photo",
			attachment: {
				attachmentId: "attachment-extra-instance",
				attachmentName: "attachment-extra-instance.png",
				originalFilename: "extra.png",
				sizeBytes: 3,
			},
		});
		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/visit[0]/photo",
						currentPath: "/data/visit/photo",
					}),
				],
			},
		});
		await vi.waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					([url, init]) =>
						String(url).endsWith("/attachment-extra-instance") &&
						init?.method === "DELETE",
				),
			).toBe(true),
		);

		expect(getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey })).toBe(
			"/data/visit/photo",
		);
		expect(
			getAttachmentSlotPath({
				appId: "app-1",
				entryKey,
				slotKey: extraSlotKey,
			}),
		).toBeUndefined();
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
		).toHaveLength(2);
	});

	it("cleans an incompatible capture kind and keeps a targeted replacement blocker", async () => {
		const entryKey = "entry-incompatible-capture-kind";
		const slotKey = "capture:stable-field";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/evidence",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/evidence",
			attachment: {
				attachmentId: "attachment-wrong-kind",
				attachmentName: "attachment-wrong-kind.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);

		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/evidence",
						currentPath: "/data/evidence",
						currentCaptureKind: "signature",
					}),
				],
			},
		});

		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
		expect(
			getAttachmentSlotIssue({ appId: "app-1", entryKey, slotKey }),
		).toEqual({
			kind: "replace",
			message:
				"This question is now a signature. Draw a new signature before submitting.",
		});
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "must not submit"),
		).rejects.toThrow(/draw a new signature/i);
		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/apps/app-1/attachments/attachment-wrong-kind",
				expect.objectContaining({ method: "DELETE" }),
			),
		);
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
		).toHaveLength(0);
	});

	it("retires an owner only for an explicit stable-field deletion", async () => {
		const entryKey = "entry-authored-delete";
		const slotKey = "photo:deleted";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/photo",
			attachment: {
				attachmentId: "attachment-deleted-field",
				attachmentName: "attachment-deleted-field.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);

		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					deletedCaptureMove({
						fieldUuid,
						previousPath: "/data/photo",
					}),
				],
			},
		});
		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/apps/app-1/attachments/attachment-deleted-field",
				expect.objectContaining({ method: "DELETE" }),
			),
		);

		expect(
			getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
		).toHaveLength(0);
	});

	it("preserves owners, picked files, and signature ink when a migration event is malformed", async () => {
		const entryKey = "entry-invalid-authored-migration";
		const fileSlotKey = "photo:stable";
		const signatureSlotKey = "signature:stable";
		const fileFieldUuid = "22222222-2222-4222-8222-222222222221";
		const signatureFieldUuid = "22222222-2222-4222-8222-222222222222";
		const file = new File(["draft"], "draft.png", { type: "image/png" });
		for (const [slotKey, fieldUuid, instancePath, captureKind] of [
			[fileSlotKey, fileFieldUuid, "/data/photo", "image"],
			[signatureSlotKey, signatureFieldUuid, "/data/signature", "signature"],
		] as const) {
			registerAttachmentSlotPath({
				appId: "app-1",
				entryKey,
				slotKey,
				fieldUuid,
				instancePath,
				captureKind,
			});
			rememberOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				slotKey,
				instancePath,
				attachment: {
					attachmentId: `attachment-${slotKey}`,
					attachmentName: `${slotKey}.png`,
					originalFilename: `${slotKey}.png`,
					sizeBytes: 5,
				},
			});
		}
		rememberAttachmentSlotDraft({
			appId: "app-1",
			entryKey,
			slotKey: fileSlotKey,
			file,
			status: "uploading",
			generation: 7,
		});
		const strokes = [[{ x: 0.2, y: 0.4 }]];
		rememberSignatureDraft(entryKey, signatureSlotKey, strokes);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				// Missing retained destinations are runtime-invalid and must
				// never be interpreted as authoritative field deletion.
				moves: [
					{
						kind: "retained",
						fieldUuid: fileFieldUuid,
						previous: {
							pathTemplate: "/data/photo",
							segmentKeys: ["$data", fileFieldUuid],
							captureKind: "image",
						},
					},
					{
						kind: "retained",
						fieldUuid: signatureFieldUuid,
						previous: {
							pathTemplate: "/data/signature",
							segmentKeys: ["$data", signatureFieldUuid],
							captureKind: "signature",
						},
					},
				] as unknown as AttachmentAuthoredPathMigration["moves"],
			},
		});

		let submitted = false;
		await expect(
			runFormAttachmentBarrier(
				entryKey,
				async () => {
					submitted = true;
				},
				{ classifySlot: () => "removed" },
			),
		).rejects.toThrow(/could not be verified/i);
		expect(submitted).toBe(false);
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				slotKey: fileSlotKey,
			}),
		).toMatchObject({ attachmentId: `attachment-${fileSlotKey}` });
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				slotKey: signatureSlotKey,
			}),
		).toMatchObject({ attachmentId: `attachment-${signatureSlotKey}` });
		expect(
			getAttachmentSlotDraft({
				appId: "app-1",
				entryKey,
				slotKey: fileSlotKey,
			}),
		).toMatchObject({ file, status: "needs-attention", generation: 7 });
		expect(getSignatureDraft(entryKey, signatureSlotKey)).toEqual(strokes);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("retires empty invalid siblings while preserving owned, File-draft, and signature-ink payloads", async () => {
		const entryKey = "entry-invalid-payload-classification";
		const imageFieldUuid = "22222222-2222-4222-8222-222222222222";
		const signatureFieldUuid = "33333333-3333-4333-8333-333333333333";
		const emptySlotKey = "photo:empty-current-control";
		const ownedSlotKey = "photo:owned-orphan";
		const draftSlotKey = "photo:draft-only-orphan";
		const inkSlotKey = "signature:ink-only-orphan";
		for (const [slotKey, fieldUuid, instancePath, captureKind] of [
			[emptySlotKey, imageFieldUuid, "/data/current/photo", "image"],
			[ownedSlotKey, imageFieldUuid, "/data/legacy_owned/photo", "image"],
			[draftSlotKey, imageFieldUuid, "/data/legacy_draft/photo", "image"],
			[
				inkSlotKey,
				signatureFieldUuid,
				"/data/legacy_signature/consent",
				"signature",
			],
		] as const) {
			registerAttachmentSlotPath({
				appId: "app-1",
				entryKey,
				slotKey,
				fieldUuid,
				instancePath,
				captureKind,
			});
		}
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey: ownedSlotKey,
			instancePath: "/data/legacy_owned/photo",
			attachment: {
				attachmentId: "attachment-owned-orphan",
				attachmentName: "attachment-owned-orphan.png",
				originalFilename: "owned.png",
				sizeBytes: 3,
			},
		});
		const draftFile = new File(["draft"], "draft.png", { type: "image/png" });
		rememberAttachmentSlotDraft({
			appId: "app-1",
			entryKey,
			slotKey: draftSlotKey,
			file: draftFile,
			status: "queued-upload",
			generation: 4,
		});
		const ink = [[{ x: 0.2, y: 0.4 }]];
		rememberSignatureDraft(entryKey, inkSlotKey, ink);

		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					{
						kind: "retained",
						fieldUuid: imageFieldUuid,
						previous: {
							pathTemplate: "/data/legacy/photo",
							segmentKeys: ["$data", "duplicate", "duplicate"],
							captureKind: "image",
						},
						current: {
							pathTemplate: "/data/current/photo",
							segmentKeys: ["$data", "duplicate", "duplicate"],
							captureKind: "image",
						},
					},
					{
						kind: "retained",
						fieldUuid: signatureFieldUuid,
						previous: {
							pathTemplate: "/data/legacy/consent",
							segmentKeys: ["$data", "duplicate", "duplicate"],
							captureKind: "signature",
						},
						current: {
							pathTemplate: "/data/current/consent",
							segmentKeys: ["$data", "duplicate", "duplicate"],
							captureKind: "signature",
						},
					},
				],
			},
		});

		expect(
			getAttachmentSlotPath({
				appId: "app-1",
				entryKey,
				slotKey: emptySlotKey,
			}),
		).toBeUndefined();
		expect(
			getOwnedStagedAttachment({
				appId: "app-1",
				entryKey,
				slotKey: ownedSlotKey,
			}),
		).toMatchObject({ attachmentId: "attachment-owned-orphan" });
		expect(
			getAttachmentSlotDraft({
				appId: "app-1",
				entryKey,
				slotKey: draftSlotKey,
			}),
		).toMatchObject({
			file: draftFile,
			status: "needs-attention",
			generation: 4,
		});
		expect(getSignatureDraft(entryKey, inkSlotKey)).toEqual(ink);
		expect(
			listAttachmentInvariantRecoveries({ appId: "app-1", entryKey }).map(
				(recovery) => recovery.slotKey,
			),
		).toEqual([ownedSlotKey, draftSlotKey, inkSlotKey]);
	});

	it("lets an explicit stable-field deletion retire a previously invalid slot", async () => {
		const entryKey = "entry-invalid-then-deleted";
		const slotKey = "signature:invalid-then-deleted";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/visits[1]/signature",
			captureKind: "signature",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/signature",
			attachment: {
				attachmentId: "attachment-invalid-then-deleted",
				attachmentName: "attachment-invalid-then-deleted.png",
				originalFilename: "signature.png",
				sizeBytes: 3,
			},
		});
		rememberSignatureDraft(entryKey, slotKey, [[{ x: 0.2, y: 0.4 }]]);
		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					{
						kind: "retained",
						fieldUuid,
						previous: {
							pathTemplate: "/data/visits/signature",
							segmentKeys: ["$data", "duplicate", "duplicate"],
							captureKind: "signature",
						},
					},
				] as unknown as AttachmentAuthoredPathMigration["moves"],
			},
		});
		expect(
			listAttachmentInvariantRecoveries({ appId: "app-1", entryKey }),
		).toHaveLength(1);

		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);
		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					deletedCaptureMove({
						fieldUuid,
						// Deliberately no longer matches the retained slot. Stable
						// UUID deletion must win before path projection.
						previousPath: "/data/no_longer_here/signature",
						captureKind: "signature",
					}),
				],
			},
		});

		expect(
			listAttachmentInvariantRecoveries({ appId: "app-1", entryKey }),
		).toEqual([]);
		expect(getSignatureDraft(entryKey, slotKey)).toEqual([]);
		expect(
			getAttachmentSlotPath({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted"),
		).resolves.toBe("submitted");
		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/apps/app-1/attachments/attachment-invalid-then-deleted",
				expect.objectContaining({ method: "DELETE" }),
			),
		);
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

	it("adopts the server path after a lost retarget response before moving again", async () => {
		const entryKey = "entry-retarget-lost-response";
		const slotKey = "photo:stable-row";
		const fieldUuid = "22222222-2222-4222-8222-222222222222";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			fieldUuid,
			instancePath: "/data/visits[1]/photo",
			captureKind: "image",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			attachment: {
				attachmentId: "attachment-lost-response",
				attachmentName: "attachment-lost-response.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		const patchBodies: unknown[] = [];
		let patch = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init?: RequestInit) => {
				if (init?.method !== "PATCH") {
					return { ok: true, status: 200 };
				}
				patchBodies.push(JSON.parse(String(init.body)));
				patch += 1;
				if (patch === 1) {
					// The server committed A→B, but the response disappeared.
					throw new TypeError("connection closed after commit");
				}
				const instancePath =
					patch === 2 ? "/data/visits[0]/photo" : "/data/visits/photo";
				return new Response(JSON.stringify({ ok: true, instancePath }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		await reconcileAttachmentRepeatCompaction({
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
		expect(
			getAttachmentSlotIssue({ appId: "app-1", entryKey, slotKey }),
		).toBeDefined();

		await reconcileAttachmentAuthoredPathMigration({
			appId: "app-1",
			entryKey,
			migration: {
				moves: [
					retainedCaptureMove({
						fieldUuid,
						previousPath: "/data/visits[0]/photo",
						currentPath: "/data/visits/photo",
					}),
				],
			},
		});

		expect(patchBodies).toEqual([
			{
				expectedInstancePath: "/data/visits[1]/photo",
				instancePath: "/data/visits[0]/photo",
			},
			{
				expectedInstancePath: "/data/visits[1]/photo",
				instancePath: "/data/visits/photo",
			},
			{
				expectedInstancePath: "/data/visits[0]/photo",
				instancePath: "/data/visits/photo",
			},
		]);
		expect(
			getAttachmentSlotIssue({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted"),
		).resolves.toBe("submitted");
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

	it("does not let a hung repeat-removal DELETE hold the form queue", async () => {
		const entryKey = "entry-hung-repeat-delete";
		const slotKey = "photo:removed-row";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[0]/photo",
		});
		rememberOwnedStagedAttachment({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[0]/photo",
			attachment: {
				attachmentId: "attachment-hung-delete",
				attachmentName: "attachment-hung-delete.png",
				originalFilename: "photo.png",
				sizeBytes: 3,
			},
		});
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
			waitForAbort(init?.signal),
		);
		vi.stubGlobal("fetch", fetchMock);

		const maintenance = reconcileAttachmentRepeatCompaction({
			appId: "app-1",
			entryKey,
			compaction: {
				removedPrefix: "/data/visits[0]",
				moves: [],
			},
		});
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted"),
		).resolves.toBe("submitted");
		await expect(maintenance).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/apps/app-1/attachments/attachment-hung-delete",
			expect.objectContaining({ method: "DELETE" }),
		);
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

	it("preserves a failed retarget as a recoverable blocker and retries it in place", async () => {
		const entryKey = "entry-retarget-failure";
		const slotKey = "photo:stable-row-2";
		registerAttachmentSlotPath({
			appId: "app-1",
			entryKey,
			slotKey,
			instancePath: "/data/visits[1]/photo",
			captureKind: "image",
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
		let offline = true;
		const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
			if (init?.method === "PATCH") {
				return { ok: !offline, status: offline ? 409 : 200 };
			}
			return { ok: true, status: 200 };
		});
		vi.stubGlobal("fetch", fetchMock);

		await reconcileAttachmentRepeatCompaction({
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
		expect(
			getOwnedStagedAttachment({ appId: "app-1", entryKey, slotKey }),
		)?.toMatchObject({ attachmentId: "attachment-failed-retarget" });
		expect(
			getAttachmentSlotIssue({ appId: "app-1", entryKey, slotKey }),
		).toEqual({
			kind: "retarget",
			message:
				"This attachment could not move to the question's current location. Retry now, attach a replacement, or remove it.",
		});
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
		).toHaveLength(0);
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "must not submit"),
		).rejects.toThrow(/retry now, attach a replacement, or remove it/i);

		offline = false;
		await retryAttachmentRetarget({ appId: "app-1", entryKey, slotKey });
		expect(
			getAttachmentSlotIssue({ appId: "app-1", entryKey, slotKey }),
		).toBeUndefined();
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "submitted"),
		).resolves.toBe("submitted");
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

	it("compensates a failed PUT out of band without waiting for DELETE", async () => {
		const fetchMock = vi
			.fn((_input: RequestInfo | URL, init?: RequestInit) =>
				waitForAbort(init?.signal),
			)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					attachmentId: "attachment-compensate",
					attachmentName: "attachment-compensate.png",
					uploadUrl: "https://storage.test/upload",
					uploadContentType: "image/png",
					uploadHeaders: { "x-goog-if-generation-match": "0" },
				}),
			} as Response)
			.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			stageAttachment({
				appId: "app-1",
				entryKey: "11111111-1111-4111-8111-111111111111",
				fieldUuid: "22222222-2222-4222-8222-222222222222",
				instancePath: "/data/photo",
				file: { name: "photo.png", size: 3 } as File,
			}),
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/api/apps/app-1/attachments/attachment-compensate",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("times out a hung initiate request", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
			waitForAbort(init?.signal),
		);
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
		});
		const rejection = expect(stage).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the initiate deadline open through a stalled success body", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
			Promise.resolve({
				ok: true,
				json: () => waitForAbort(init?.signal),
			} as unknown as Response),
		);
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
		});
		const rejection = expect(stage).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the initiate deadline open through a stalled error body", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
			Promise.resolve({
				ok: false,
				status: 409,
				json: () => waitForAbort(init?.signal),
			} as unknown as Response),
		);
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
		});
		const rejection = expect(stage).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("times out a hung PUT and schedules cleanup for the minted attempt", async () => {
		vi.useFakeTimers();
		let call = 0;
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			call += 1;
			if (call === 1) {
				return Promise.resolve({
					ok: true,
					json: async () => ({
						attachmentId: "attachment-put-timeout",
						attachmentName: "attachment-put-timeout.png",
						uploadUrl: "https://storage.test/upload",
						uploadContentType: "image/png",
						uploadHeaders: { "x-goog-if-generation-match": "0" },
					}),
				} as Response);
			}
			if (init?.method === "DELETE") {
				return Promise.resolve({ ok: true, status: 200 } as Response);
			}
			return waitForAbort(init?.signal);
		});
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
		});
		const rejection = expect(stage).rejects.toThrow(/timed out/i);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith(
				"/api/apps/app-1/attachments/attachment-put-timeout",
				expect.objectContaining({ method: "DELETE" }),
			),
		);
	});

	it("keeps the PUT deadline open through a stalled success body", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "https://storage.test/upload") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => waitForBodyAbort(init?.signal),
				} as unknown as Response);
			}
			if (init?.method === "DELETE") {
				return Promise.resolve({ ok: true, status: 200 } as Response);
			}
			if (fetchMock.mock.calls.length === 1) {
				return Promise.resolve({
					ok: true,
					json: async () => ({
						attachmentId: "attachment-put-body-timeout",
						attachmentName: "attachment-put-body-timeout.png",
						uploadUrl: "https://storage.test/upload",
						uploadContentType: "image/png",
						uploadHeaders: { "x-goog-if-generation-match": "0" },
					}),
				} as Response);
			}
			return Promise.resolve({
				ok: true,
				json: async () => ({
					attachmentId: "attachment-put-body-timeout",
					attachmentName: "attachment-put-body-timeout.png",
					originalFilename: "photo.png",
					sizeBytes: 3,
				}),
			} as Response);
		});
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
		});
		const rejection = expect(stage).rejects.toThrow(/timed out/i);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		expect(
			fetchMock.mock.calls.filter(
				([input]) => String(input) === "https://storage.test/upload",
			),
		).toHaveLength(1);
		expect(
			fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
		).toBe(true);
	});

	it("keeps external cancellation attached while a PUT response body stalls", async () => {
		const controller = new AbortController();
		const bodyStarted = deferred<void>();
		const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "https://storage.test/upload") {
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => {
						bodyStarted.resolve();
						return waitForBodyAbort(init?.signal);
					},
				} as unknown as Response);
			}
			if (init?.method === "DELETE") {
				return Promise.resolve({ ok: true, status: 200 } as Response);
			}
			return Promise.resolve({
				ok: true,
				json: async () => ({
					attachmentId: "attachment-put-body-abort",
					attachmentName: "attachment-put-body-abort.png",
					uploadUrl: "https://storage.test/upload",
					uploadContentType: "image/png",
					uploadHeaders: { "x-goog-if-generation-match": "0" },
				}),
			} as Response);
		});
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
			signal: controller.signal,
		});
		const rejection = expect(stage).rejects.toMatchObject({
			name: "AbortError",
		});
		await bodyStarted.promise;
		controller.abort(new DOMException("Question hidden", "AbortError"));

		await rejection;
	});

	it("times out a hung confirm and schedules cleanup for the uploaded attempt", async () => {
		vi.useFakeTimers();
		let call = 0;
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			call += 1;
			if (call === 1) {
				return Promise.resolve({
					ok: true,
					json: async () => ({
						attachmentId: "attachment-confirm-timeout",
						attachmentName: "attachment-confirm-timeout.png",
						uploadUrl: "https://storage.test/upload",
						uploadContentType: "image/png",
						uploadHeaders: { "x-goog-if-generation-match": "0" },
					}),
				} as Response);
			}
			if (call === 2 || init?.method === "DELETE") {
				return Promise.resolve({ ok: true, status: 200 } as Response);
			}
			return waitForAbort(init?.signal);
		});
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
		});
		const rejection = expect(stage).rejects.toThrow(/timed out/i);
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith(
				"/api/apps/app-1/attachments/attachment-confirm-timeout",
				expect.objectContaining({ method: "DELETE" }),
			),
		);
	});

	it("keeps the confirm deadline open through a stalled success body", async () => {
		vi.useFakeTimers();
		let call = 0;
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			call += 1;
			if (call === 1) {
				return Promise.resolve({
					ok: true,
					json: async () => ({
						attachmentId: "attachment-confirm-body-timeout",
						attachmentName: "attachment-confirm-body-timeout.png",
						uploadUrl: "https://storage.test/upload",
						uploadContentType: "image/png",
						uploadHeaders: { "x-goog-if-generation-match": "0" },
					}),
				} as Response);
			}
			if (call === 2 || init?.method === "DELETE") {
				return Promise.resolve({ ok: true, status: 200 } as Response);
			}
			return Promise.resolve({
				ok: true,
				json: () => waitForAbort(init?.signal),
			} as unknown as Response);
		});
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
		});
		const rejection = expect(stage).rejects.toThrow(/timed out/i);
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith(
				"/api/apps/app-1/attachments/attachment-confirm-body-timeout",
				expect.objectContaining({ method: "DELETE" }),
			),
		);
	});

	it("keeps the confirm deadline open through a stalled error body", async () => {
		vi.useFakeTimers();
		let call = 0;
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			call += 1;
			if (call === 1) {
				return Promise.resolve({
					ok: true,
					json: async () => ({
						attachmentId: "attachment-confirm-error-body-timeout",
						attachmentName: "attachment-confirm-error-body-timeout.png",
						uploadUrl: "https://storage.test/upload",
						uploadContentType: "image/png",
						uploadHeaders: { "x-goog-if-generation-match": "0" },
					}),
				} as Response);
			}
			if (call === 2 || init?.method === "DELETE") {
				return Promise.resolve({ ok: true, status: 200 } as Response);
			}
			return Promise.resolve({
				ok: false,
				status: 409,
				json: () => waitForAbort(init?.signal),
			} as unknown as Response);
		});
		vi.stubGlobal("fetch", fetchMock);

		const stage = stageAttachment({
			appId: "app-1",
			entryKey: "11111111-1111-4111-8111-111111111111",
			fieldUuid: "22222222-2222-4222-8222-222222222222",
			instancePath: "/data/photo",
			file: { name: "photo.png", size: 3 } as File,
		});
		const rejection = expect(stage).rejects.toThrow(/timed out/i);
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenLastCalledWith(
				"/api/apps/app-1/attachments/attachment-confirm-error-body-timeout",
				expect.objectContaining({ method: "DELETE" }),
			),
		);
	});

	it("bounds and cancels repeat retarget requests", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
			waitForAbort(init?.signal),
		);
		vi.stubGlobal("fetch", fetchMock);

		const retarget = retargetAttachment({
			appId: "app-1",
			attachmentId: "attachment-retarget-timeout",
			expectedInstancePath: "/data/visits[1]/photo",
			instancePath: "/data/visits[0]/photo",
		});
		const rejection = expect(retarget).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/apps/app-1/attachments/attachment-retarget-timeout",
			expect.objectContaining({
				method: "PATCH",
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("keeps the retarget deadline open through a stalled success body", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
			Promise.resolve({
				ok: true,
				status: 200,
				arrayBuffer: () => waitForBodyAbort(init?.signal),
			} as unknown as Response),
		);
		vi.stubGlobal("fetch", fetchMock);

		const retarget = retargetAttachment({
			appId: "app-1",
			attachmentId: "attachment-retarget-body-timeout",
			expectedInstancePath: "/data/visits[1]/photo",
			instancePath: "/data/visits[0]/photo",
		});
		const rejection = expect(retarget).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
	});

	it("keeps external cancellation attached while a retarget body stalls", async () => {
		const controller = new AbortController();
		const bodyStarted = deferred<void>();
		vi.stubGlobal(
			"fetch",
			vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
				Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => {
						bodyStarted.resolve();
						return waitForBodyAbort(init?.signal);
					},
				} as unknown as Response),
			),
		);
		const retarget = retargetAttachment({
			appId: "app-1",
			attachmentId: "attachment-retarget-body-abort",
			expectedInstancePath: "/data/visits[1]/photo",
			instancePath: "/data/visits[0]/photo",
			signal: controller.signal,
		});
		const rejection = expect(retarget).rejects.toMatchObject({
			name: "AbortError",
		});
		await bodyStarted.promise;
		controller.abort(new DOMException("Question hidden", "AbortError"));

		await rejection;
	});

	it("keeps the cleanup deadline open through a stalled success body", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
				Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => waitForBodyAbort(init?.signal),
				} as unknown as Response),
			),
		);
		const cleanup = discardAttachment({
			appId: "app-1",
			attachmentId: "attachment-delete-body-timeout",
		});
		const rejection = expect(cleanup).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
	});

	it("keeps the cleanup deadline open through a stalled error body", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
				Promise.resolve({
					ok: false,
					status: 503,
					arrayBuffer: () => waitForBodyAbort(init?.signal),
				} as unknown as Response),
			),
		);
		const cleanup = discardAttachment({
			appId: "app-1",
			attachmentId: "attachment-delete-error-body-timeout",
		});
		const rejection = expect(cleanup).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(30_000);

		await rejection;
	});

	it("keeps external cancellation attached while a cleanup body stalls", async () => {
		const controller = new AbortController();
		const bodyStarted = deferred<void>();
		vi.stubGlobal(
			"fetch",
			vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
				Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => {
						bodyStarted.resolve();
						return waitForBodyAbort(init?.signal);
					},
				} as unknown as Response),
			),
		);
		const cleanup = discardAttachment({
			appId: "app-1",
			attachmentId: "attachment-delete-body-abort",
			signal: controller.signal,
		});
		const rejection = expect(cleanup).rejects.toMatchObject({
			name: "AbortError",
		});
		await bodyStarted.promise;
		controller.abort(new DOMException("Entry retired", "AbortError"));

		await rejection;
	});
});
