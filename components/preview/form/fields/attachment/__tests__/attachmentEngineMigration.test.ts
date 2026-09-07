import type { MockAgent } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Field, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	admittedControllerDoc,
	applyControllerEdit,
} from "@/lib/preview/engine/__tests__/fixtures/controllerDoc";
import { EngineController } from "@/lib/preview/engine/engineController";
import {
	__resetAttachmentCoordinatorForTests,
	getAttachmentSlotDraft,
	getAttachmentSlotIssue,
	getAttachmentSlotPath,
	getOwnedStagedAttachment,
	getSignatureDraft,
	reconcileAttachmentAuthoredPathMigration,
	registerAttachmentSlotPath,
	rememberAttachmentSlotDraft,
	rememberOwnedStagedAttachment,
	rememberSignatureDraft,
	runAttachmentTask,
	setAttachmentEntryAuthority,
} from "../attachmentClient";

const APP_ID = "test-app";
const MODULE_UUID = testUuid("migration-module");
const FORM_UUID = testUuid("migration-form");
const A = testUuid("migration-a"),
	B = testUuid("migration-b"),
	C = testUuid("migration-c");
const nativeFetch = globalThis.fetch;
const controllers = new Set<EngineController>();
const subscriptions = new Set<() => void>();
async function withAttachmentPeer(run: (peer: MockAgent) => Promise<void>) {
	await withHttpPeer(async (peer) => {
		const requests: Promise<Response>[] = [];
		// Node has no document base URL. Preserve native fetch and normalize only
		// the same-origin URL that a browser would resolve before its HTTP request.
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
			const request = nativeFetch(
				new URL(String(input), "https://nova.test"),
				init,
			);
			requests.push(request);
			return request;
		});
		try {
			await run(peer);
		} finally {
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.clear();
			for (const controller of controllers) controller.dispose();
			await Promise.all(
				[...controllers].map((controller) => controller.awaitSettled()),
			);
			controllers.clear();
			await __resetAttachmentCoordinatorForTests();
			const responses = await Promise.all(requests);
			for (const response of responses)
				expect(response.body === null || response.bodyUsed).toBe(true);
			vi.unstubAllGlobals();
		}
	});
}
function fixture(fields: Field[], fieldOrder: Record<string, Uuid[]>) {
	const store = createBlueprintDocStore();
	store.getState().load(
		admittedControllerDoc({
			appId: APP_ID,
			appName: "Attachment migration",
			connectType: null,
			caseTypes: null,
			modules: {
				[MODULE_UUID]: { uuid: MODULE_UUID, id: "module", name: "Module" },
			},
			forms: {
				[FORM_UUID]: {
					uuid: FORM_UUID,
					id: "survey",
					name: "Survey",
					type: "survey",
				},
			},
			fields: Object.fromEntries(fields.map((field) => [field.uuid, field])),
			moduleOrder: [MODULE_UUID],
			formOrder: { [MODULE_UUID]: [FORM_UUID] },
			fieldOrder,
		}),
	);
	store.getState().startTracking();
	const controller = new EngineController();
	controllers.add(controller);
	controller.setDocStore(store);
	controller.activateForm(FORM_UUID);
	const entryKey = controller.entryKey;
	if (!entryKey) throw new Error("No entry key");
	const snapshot = {
		appId: APP_ID,
		entryKey,
		formUuid: FORM_UUID,
		projectId: "project",
		actorUserId: "actor",
		ownerId: "actor",
		scopeEpoch: 1,
		accessPhase: "authorized" as const,
		canEdit: true,
	};
	setAttachmentEntryAuthority({
		entryKey,
		snapshot,
		readCurrent: () => ({
			...snapshot,
			entryKey: controller.entryKey,
			formUuid: controller.formUuid,
		}),
	});
	const pending: Promise<unknown>[] = [];
	subscriptions.add(
		controller.subscribeAuthoredCapturePathMigration((migration) => {
			pending.push(
				reconcileAttachmentAuthoredPathMigration({
					appId: APP_ID,
					entryKey,
					migration,
				}),
			);
		}),
	);
	const slotArgs = (slotKey: string) => ({ appId: APP_ID, entryKey, slotKey });
	return { store, controller, entryKey, pending, slotArgs };
}
function ownSlot(
	entryKey: string,
	slotKey: string,
	fieldUuid: Uuid,
	instancePath: string,
	captureKind = "image",
) {
	registerAttachmentSlotPath({
		appId: APP_ID,
		entryKey,
		slotKey,
		fieldUuid,
		instancePath,
		captureKind,
	});
	rememberOwnedStagedAttachment({
		appId: APP_ID,
		entryKey,
		slotKey,
		instancePath,
		attachment: {
			attachmentId: slotKey,
			attachmentName: `${slotKey}.png`,
			originalFilename: `${slotKey}.png`,
			sizeBytes: 3,
		},
	});
}
function replyToMove(
	peer: MockAgent,
	id: string,
	before: string,
	after: string,
	observe?: () => void,
) {
	peer
		.get("https://nova.test")
		.intercept({
			method: "PATCH",
			path: `/api/apps/${APP_ID}/attachments/${id}`,
		})
		.reply(async (request) => {
			expect(
				JSON.parse((await readHttpRequestBody(request)).toString()),
			).toEqual({ expectedInstancePath: before, instancePath: after });
			observe?.();
			return { statusCode: 200, data: JSON.stringify({ instancePath: after }) };
		});
}
function repeat(uuid: Uuid, id: string): Field {
	return {
		uuid,
		id,
		kind: "repeat",
		label: proseText(id),
		repeat_mode: "user_controlled",
	};
}

describe("admitted engine edits through the attachment HTTP adapter", () => {
	it("installs both swap destinations before either compare-and-swap request reaches the peer", async () =>
		withAttachmentPeer(async (peer) => {
			const h = fixture(
				[
					{
						uuid: A,
						id: "photo",
						kind: "signature",
						label: proseText("Signature"),
						relevant: xp("false()"),
					},
					{
						uuid: B,
						id: "document",
						kind: "file",
						label: proseText("Document"),
					},
				],
				{ [FORM_UUID]: [A, B] },
			);
			ownSlot(h.entryKey, "signature", A, "/data/photo", "signature");
			ownSlot(h.entryKey, "document", B, "/data/document", "file");
			const file = new File(["new document"], "new.pdf", {
				type: "application/pdf",
			});
			rememberAttachmentSlotDraft({
				...h.slotArgs("document"),
				file,
				status: "uploading",
				generation: 4,
			});
			const ink = [[{ x: 0.25, y: 0.75 }]];
			rememberSignatureDraft(h.entryKey, "signature", ink);
			const started = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			const upload = runAttachmentTask({
				entryKey: h.entryKey,
				slotKey: "document",
				task: async () => {
					started.resolve();
					await release.promise;
				},
			});
			const observedPaths: unknown[] = [];
			const observe = () =>
				observedPaths.push([
					getAttachmentSlotPath(h.slotArgs("signature")),
					getAttachmentSlotPath(h.slotArgs("document")),
				]);
			replyToMove(peer, "signature", "/data/photo", "/data/document", observe);
			replyToMove(peer, "document", "/data/document", "/data/photo", observe);
			try {
				await started.promise;
				applyControllerEdit(h.store, [
					{
						kind: "updateField",
						uuid: A,
						targetKind: "signature",
						patch: { id: "document" },
					},
					{
						kind: "updateField",
						uuid: B,
						targetKind: "file",
						patch: { id: "photo" },
					},
				]);
				expect(peer.getCallHistory()?.calls()).toEqual([]);
				expect(getAttachmentSlotPath(h.slotArgs("signature"))).toBe(
					"/data/document",
				);
				expect(getAttachmentSlotPath(h.slotArgs("document"))).toBe(
					"/data/photo",
				);
				release.resolve();
				await upload;
				expect(await Promise.all(h.pending)).toEqual([[]]);
				expect(observedPaths).toEqual([
					["/data/document", "/data/photo"],
					["/data/document", "/data/photo"],
				]);
				expect(
					getOwnedStagedAttachment(h.slotArgs("signature"))?.attachmentId,
				).toBe("signature");
				expect(
					getOwnedStagedAttachment(h.slotArgs("document"))?.attachmentId,
				).toBe("document");
				expect(getAttachmentSlotIssue(h.slotArgs("signature"))).toBeUndefined();
				expect(getAttachmentSlotIssue(h.slotArgs("document"))).toBeUndefined();
				expect(getAttachmentSlotDraft(h.slotArgs("document"))).toMatchObject({
					file,
					status: "uploading",
					generation: 4,
				});
				expect(getSignatureDraft(h.entryKey, "signature")).toEqual(ink);
			} finally {
				release.resolve();
				await upload;
				await Promise.all(h.pending);
			}
		}));
	it("retargets index zero and deletes only the higher instance when moving between distinct repeats", async () =>
		withAttachmentPeer(async (peer) => {
			const h = fixture(
				[
					repeat(A, "left"),
					repeat(B, "right"),
					{ uuid: C, id: "photo", kind: "image", label: proseText("Photo") },
				],
				{ [FORM_UUID]: [A, B], [A]: [C], [B]: [] },
			);
			h.controller.addRepeat(A);
			ownSlot(h.entryKey, "left-0", C, "/data/left[0]/photo");
			ownSlot(h.entryKey, "left-1", C, "/data/left[1]/photo");
			replyToMove(
				peer,
				"left-0",
				"/data/left[0]/photo",
				"/data/right[0]/photo",
			);
			peer
				.get("https://nova.test")
				.intercept({
					method: "DELETE",
					path: `/api/apps/${APP_ID}/attachments/left-1`,
				})
				.reply(204, "");
			applyControllerEdit(h.store, [
				{ kind: "moveField", uuid: C, toParentUuid: B, after: null },
			]);
			expect(await Promise.all(h.pending)).toEqual([[]]);
			await vi.waitFor(() =>
				expect(peer.getCallHistory()?.calls()).toHaveLength(2),
			);
			expect(getAttachmentSlotPath(h.slotArgs("left-0"))).toBe(
				"/data/right[0]/photo",
			);
			expect(getAttachmentSlotPath(h.slotArgs("left-1"))).toBeUndefined();
			expect(getAttachmentSlotIssue(h.slotArgs("left-0"))).toBeUndefined();
		}));
	it("preserves both retained inner indices when their repeat gains a new ancestor", async () =>
		withAttachmentPeer(async (peer) => {
			const h = fixture(
				[
					repeat(A, "rounds"),
					repeat(B, "visits"),
					{ uuid: C, id: "photo", kind: "image", label: proseText("Photo") },
				],
				{ [FORM_UUID]: [A, B], [A]: [], [B]: [C] },
			);
			h.controller.addRepeat(B);
			for (const index of [0, 1]) {
				ownSlot(
					h.entryKey,
					`visit-${index}`,
					C,
					`/data/visits[${index}]/photo`,
				);
				replyToMove(
					peer,
					`visit-${index}`,
					`/data/visits[${index}]/photo`,
					`/data/rounds[0]/visits[${index}]/photo`,
				);
			}
			applyControllerEdit(h.store, [
				{ kind: "moveField", uuid: B, toParentUuid: A, after: null },
			]);
			expect(await Promise.all(h.pending)).toEqual([[]]);
			for (const index of [0, 1]) {
				expect(getAttachmentSlotPath(h.slotArgs(`visit-${index}`))).toBe(
					`/data/rounds[0]/visits[${index}]/photo`,
				);
				expect(
					getAttachmentSlotIssue(h.slotArgs(`visit-${index}`)),
				).toBeUndefined();
			}
			expect(peer.getCallHistory()?.calls()).toHaveLength(2);
		}));
});
