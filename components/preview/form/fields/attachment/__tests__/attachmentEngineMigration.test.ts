import { afterEach, describe, expect, it, vi } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Field, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { EngineController } from "@/lib/preview/engine/engineController";
import {
	__resetAttachmentCoordinatorForTests,
	getAttachmentSlotDraft,
	getAttachmentSlotPath,
	getOwnedStagedAttachment,
	getSignatureDraft,
	reconcileAttachmentAuthoredPathMigration,
	registerAttachmentSlotPath,
	rememberAttachmentSlotDraft,
	rememberOwnedStagedAttachment,
	rememberSignatureDraft,
	runAttachmentTask,
} from "../attachmentClient";

const APP_ID = "test-app";
const MODULE_UUID = asUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const FORM_UUID = asUuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

function makeDoc(
	fields: Record<string, Field>,
	fieldOrder: Record<string, Uuid[]>,
): PersistableDoc {
	return {
		appId: APP_ID,
		appName: "Attachment migration boundary",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "module",
				name: "Module",
			},
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "survey",
				name: "Survey",
				type: "survey",
			},
		},
		fields,
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder,
	};
}

function loadedController(doc: PersistableDoc) {
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.temporal.getState().resume();
	const controller = new EngineController();
	controller.setDocStore(store);
	controller.activateForm(FORM_UUID);
	const entryKey = controller.entryKey;
	if (entryKey === undefined) {
		throw new Error("The activated form did not mint an attachment entry key.");
	}
	return { store, controller, entryKey };
}

function ownSlot(args: {
	entryKey: string;
	slotKey: string;
	fieldUuid: Uuid;
	instancePath: string;
	attachmentId: string;
	captureKind?: string;
}): void {
	registerAttachmentSlotPath({
		appId: APP_ID,
		entryKey: args.entryKey,
		slotKey: args.slotKey,
		fieldUuid: args.fieldUuid,
		instancePath: args.instancePath,
		captureKind: args.captureKind ?? "image",
	});
	rememberOwnedStagedAttachment({
		appId: APP_ID,
		entryKey: args.entryKey,
		slotKey: args.slotKey,
		instancePath: args.instancePath,
		attachment: {
			attachmentId: args.attachmentId,
			attachmentName: `${args.attachmentId}.png`,
			originalFilename: `${args.attachmentId}.png`,
			sizeBytes: 3,
		},
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function wireCoordinator(controller: EngineController) {
	const pending: Array<Promise<unknown>> = [];
	const unsubscribe = controller.subscribeAuthoredCapturePathMigration(
		(event) => {
			pending.push(
				reconcileAttachmentAuthoredPathMigration({
					appId: APP_ID,
					entryKey: event.entryKey,
					migration: event,
				}),
			);
		},
	);
	return { pending, unsubscribe };
}

afterEach(async () => {
	await __resetAttachmentCoordinatorForTests();
	vi.unstubAllGlobals();
});

describe("engine-to-attachment migration boundary", () => {
	it("installs both sides of an atomic capture swap before either PATCH starts", async () => {
		const firstUuid = asUuid("11111111-1111-4111-8111-111111111111");
		const secondUuid = asUuid("22222222-2222-4222-8222-222222222222");
		const { store, controller, entryKey } = loadedController(
			makeDoc(
				{
					[firstUuid]: {
						uuid: firstUuid,
						id: "photo",
						kind: "signature",
						label: "Signature",
						relevant: xp("false()"),
					},
					[secondUuid]: {
						uuid: secondUuid,
						id: "document",
						kind: "file",
						label: "Document",
					},
				},
				{ [FORM_UUID]: [firstUuid, secondUuid] },
			),
		);
		ownSlot({
			entryKey,
			slotKey: "photo-slot",
			fieldUuid: firstUuid,
			instancePath: "/data/photo",
			attachmentId: "photo-owner",
			captureKind: "signature",
		});
		ownSlot({
			entryKey,
			slotKey: "document-slot",
			fieldUuid: secondUuid,
			instancePath: "/data/document",
			attachmentId: "document-owner",
			captureKind: "file",
		});
		const fileDraft = new File(["new document"], "new-document.pdf", {
			type: "application/pdf",
		});
		rememberAttachmentSlotDraft({
			appId: APP_ID,
			entryKey,
			slotKey: "document-slot",
			file: fileDraft,
			status: "uploading",
			generation: 4,
		});
		const signatureInk = [[{ x: 0.25, y: 0.75 }]];
		rememberSignatureDraft(entryKey, "photo-slot", signatureInk);
		const uploadStarted = deferred<void>();
		const uploadRelease = deferred<void>();
		const upload = runAttachmentTask({
			entryKey,
			slotKey: "document-slot",
			task: async () => {
				uploadStarted.resolve();
				await uploadRelease.promise;
			},
		});
		await uploadStarted.promise;
		const fetchMock = vi.fn(async () => {
			expect(
				getAttachmentSlotPath({
					appId: APP_ID,
					entryKey,
					slotKey: "photo-slot",
				}),
			).toBe("/data/document");
			expect(
				getAttachmentSlotPath({
					appId: APP_ID,
					entryKey,
					slotKey: "document-slot",
				}),
			).toBe("/data/photo");
			return { ok: true, status: 200 };
		});
		vi.stubGlobal("fetch", fetchMock);
		const wired = wireCoordinator(controller);

		store.getState().applyMany([
			{
				kind: "updateField",
				uuid: firstUuid,
				targetKind: "signature",
				patch: { id: "document" },
			},
			{
				kind: "updateField",
				uuid: secondUuid,
				targetKind: "file",
				patch: { id: "photo" },
			},
		]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			getAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey: "photo-slot",
			}),
		).toBe("/data/document");
		expect(
			getAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey: "document-slot",
			}),
		).toBe("/data/photo");
		uploadRelease.resolve();
		await Promise.all([upload, ...wired.pending]);
		wired.unsubscribe();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(
			getOwnedStagedAttachment({
				appId: APP_ID,
				entryKey,
				slotKey: "photo-slot",
			}),
		).toMatchObject({ attachmentId: "photo-owner" });
		expect(
			getOwnedStagedAttachment({
				appId: APP_ID,
				entryKey,
				slotKey: "document-slot",
			}),
		).toMatchObject({ attachmentId: "document-owner" });
		expect(
			getAttachmentSlotDraft({
				appId: APP_ID,
				entryKey,
				slotKey: "document-slot",
			}),
		).toMatchObject({ file: fileDraft, status: "uploading", generation: 4 });
		expect(getSignatureDraft(entryKey, "photo-slot")).toEqual(signatureInk);
	});

	it("maps index zero and retires only higher instances across distinct repeat parents", async () => {
		const leftUuid = asUuid("33333333-3333-4333-8333-333333333333");
		const rightUuid = asUuid("44444444-4444-4444-8444-444444444444");
		const captureUuid = asUuid("55555555-5555-4555-8555-555555555555");
		const { store, controller, entryKey } = loadedController(
			makeDoc(
				{
					[leftUuid]: {
						uuid: leftUuid,
						id: "left",
						kind: "repeat",
						label: "Left",
						repeat_mode: "user_controlled",
					},
					[rightUuid]: {
						uuid: rightUuid,
						id: "right",
						kind: "repeat",
						label: "Right",
						repeat_mode: "user_controlled",
					},
					[captureUuid]: {
						uuid: captureUuid,
						id: "photo",
						kind: "image",
						label: "Photo",
					},
				},
				{
					[FORM_UUID]: [leftUuid, rightUuid],
					[leftUuid]: [captureUuid],
					[rightUuid]: [],
				},
			),
		);
		controller.addRepeat(leftUuid);
		ownSlot({
			entryKey,
			slotKey: "left-0",
			fieldUuid: captureUuid,
			instancePath: "/data/left[0]/photo",
			attachmentId: "left-owner-0",
		});
		ownSlot({
			entryKey,
			slotKey: "left-1",
			fieldUuid: captureUuid,
			instancePath: "/data/left[1]/photo",
			attachmentId: "left-owner-1",
		});
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);
		const wired = wireCoordinator(controller);

		store.getState().applyMany([
			{
				kind: "moveField",
				uuid: captureUuid,
				toParentUuid: rightUuid,
				toIndex: 0,
			},
		]);
		await Promise.all(wired.pending);
		await vi.waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					([url, init]) =>
						String(url).endsWith("/left-owner-1") && init?.method === "DELETE",
				),
			).toBe(true),
		);
		wired.unsubscribe();

		expect(
			getAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey: "left-0",
			}),
		).toBe("/data/right[0]/photo");
		expect(
			getAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey: "left-1",
			}),
		).toBeUndefined();
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
		).toHaveLength(1);
	});

	it("preserves retained inner repeat indices when its ancestor gains depth", async () => {
		const outerUuid = asUuid("66666666-6666-4666-8666-666666666666");
		const innerUuid = asUuid("77777777-7777-4777-8777-777777777777");
		const captureUuid = asUuid("88888888-8888-4888-8888-888888888888");
		const { store, controller, entryKey } = loadedController(
			makeDoc(
				{
					[outerUuid]: {
						uuid: outerUuid,
						id: "rounds",
						kind: "repeat",
						label: "Rounds",
						repeat_mode: "user_controlled",
					},
					[innerUuid]: {
						uuid: innerUuid,
						id: "visits",
						kind: "repeat",
						label: "Visits",
						repeat_mode: "user_controlled",
					},
					[captureUuid]: {
						uuid: captureUuid,
						id: "photo",
						kind: "image",
						label: "Photo",
					},
				},
				{
					[FORM_UUID]: [outerUuid, innerUuid],
					[outerUuid]: [],
					[innerUuid]: [captureUuid],
				},
			),
		);
		controller.addRepeat(innerUuid);
		ownSlot({
			entryKey,
			slotKey: "visit-0",
			fieldUuid: captureUuid,
			instancePath: "/data/visits[0]/photo",
			attachmentId: "visit-owner-0",
		});
		ownSlot({
			entryKey,
			slotKey: "visit-1",
			fieldUuid: captureUuid,
			instancePath: "/data/visits[1]/photo",
			attachmentId: "visit-owner-1",
		});
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchMock);
		const wired = wireCoordinator(controller);

		store.getState().applyMany([
			{
				kind: "moveField",
				uuid: innerUuid,
				toParentUuid: outerUuid,
				toIndex: 0,
			},
		]);
		await Promise.all(wired.pending);
		wired.unsubscribe();

		expect(
			getAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey: "visit-0",
			}),
		).toBe("/data/rounds[0]/visits[0]/photo");
		expect(
			getAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey: "visit-1",
			}),
		).toBe("/data/rounds[0]/visits[1]/photo");
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
		).toHaveLength(2);
		expect(
			fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
		).toHaveLength(0);
	});
});
