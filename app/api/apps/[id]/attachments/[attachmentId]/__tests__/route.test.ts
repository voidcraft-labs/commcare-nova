import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, PATCH, POST } from "../route";

const mocks = vi.hoisted(() => ({
	requireSession: vi.fn(),
	resolveAppScope: vi.fn(),
	load: vi.fn(),
	confirm: vi.fn(),
	remove: vi.fn(),
	retarget: vi.fn(),
	getStoredObjectMetadata: vi.fn(),
	deleteAsset: vi.fn(),
	deleteAssetGeneration: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: mocks.requireSession,
}));

vi.mock("@/lib/db/appAccess", () => ({
	resolveAppScope: mocks.resolveAppScope,
}));

vi.mock("@/lib/db/formAttachments", () => ({
	confirmFormAttachment: mocks.confirm,
	deleteUnsubmittedFormAttachment: mocks.remove,
	loadFormAttachmentForEdit: mocks.load,
	retargetStagedFormAttachment: mocks.retarget,
	FormAttachmentWriteRejectedError: class extends Error {},
}));

vi.mock("@/lib/storage/media", () => ({
	deleteAsset: mocks.deleteAsset,
	deleteAssetGeneration: mocks.deleteAssetGeneration,
	getStoredObjectMetadata: mocks.getStoredObjectMetadata,
}));

function request(
	method: "POST" | "PATCH" | "DELETE",
	body?: unknown,
): NextRequest {
	return new Request(
		"http://localhost/api/apps/app-b/attachments/attachment-from-app-a",
		{
			method,
			...(body === undefined
				? {}
				: {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
		},
	) as NextRequest;
}

const params = {
	params: Promise.resolve({
		id: "app-b",
		attachmentId: "attachment-from-app-a",
	}),
};

describe("/api/apps/[id]/attachments/[attachmentId] URL-app binding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.resolveAppScope.mockResolvedValue({ projectId: "project-1" });
		mocks.retarget.mockResolvedValue({
			attachmentId: "attachment-from-app-a",
		});
		mocks.deleteAsset.mockResolvedValue(undefined);
		mocks.deleteAssetGeneration.mockResolvedValue(undefined);
	});

	it("revalidates one positional repeat-path move through the exact row", async () => {
		const response = await PATCH(
			request("PATCH", {
				expectedInstancePath: "/data/visits[1]/photo",
				instancePath: "/data/visits[0]/photo",
			}),
			params,
		);

		expect(response.status).toBe(200);
		expect(mocks.retarget).toHaveBeenCalledWith({
			attachmentId: "attachment-from-app-a",
			actorUserId: "user-1",
			expectedAppId: "app-b",
			expectedProjectId: "project-1",
			expectedInstancePath: "/data/visits[1]/photo",
			instancePath: "/data/visits[0]/photo",
		});
		await response.json();
	});

	it("rejects an over-posted path body before touching the row", async () => {
		const response = await PATCH(
			request("PATCH", {
				expectedInstancePath: "/data/visits[1]/photo",
				instancePath: "/data/visits[0]/photo",
				foreign: true,
			}),
			params,
		);

		expect(response.status).toBe(400);
		expect(mocks.retarget).not.toHaveBeenCalled();
		await response.json();
	});

	it("collapses a confirm lookup through app B when the row belongs to app A", async () => {
		mocks.load.mockResolvedValue(null);

		const response = await POST(request("POST"), params);

		expect(response.status).toBe(404);
		expect(mocks.load).toHaveBeenCalledWith({
			attachmentId: "attachment-from-app-a",
			actorUserId: "user-1",
			expectedAppId: "app-b",
			expectedProjectId: "project-1",
		});
		expect(mocks.getStoredObjectMetadata).not.toHaveBeenCalled();
		expect(mocks.confirm).not.toHaveBeenCalled();
		await response.json();
	});

	it("binds confirm's second row write to the same URL app", async () => {
		mocks.load.mockResolvedValue({
			gcsObjectKey: "projects/project-1/form-attachments/row",
			sizeBytes: 3,
			contentType: "image/png",
		});
		mocks.getStoredObjectMetadata.mockResolvedValue({
			size: 3,
			contentType: "image/png",
			generation: "17",
			checksum: "checksum",
		});
		mocks.confirm.mockResolvedValue({
			kind: "confirmed",
			attachment: {
				attachmentId: "attachment-from-app-a",
				attachmentName: "attachment-from-app-a.png",
				originalFilename: "photo.png",
			},
		});

		const response = await POST(request("POST"), params);

		expect(response.status).toBe(200);
		expect(mocks.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				attachmentId: "attachment-from-app-a",
				expectedAppId: "app-b",
			}),
		);
		await response.json();
	});

	it("binds idempotent delete to the URL app without revealing a foreign row", async () => {
		mocks.remove.mockResolvedValue(null);

		const response = await DELETE(request("DELETE"), params);

		expect(response.status).toBe(404);
		expect(mocks.remove).toHaveBeenCalledWith({
			attachmentId: "attachment-from-app-a",
			actorUserId: "user-1",
			expectedAppId: "app-b",
			expectedProjectId: "project-1",
		});
		expect(mocks.deleteAsset).not.toHaveBeenCalled();
		expect(mocks.deleteAssetGeneration).not.toHaveBeenCalled();
		await response.json();
	});

	it("leaves a preparing row recoverable for scheduled exact-generation discard", async () => {
		mocks.remove.mockResolvedValue({
			attachmentId: "attachment-from-app-a",
			status: "discarding",
			gcsObjectKey: "captures-staged/project-1/attachment.png",
			objectGeneration: "17",
			preparedGeneration: null,
		});

		const response = await DELETE(request("DELETE"), params);

		expect(response.status).toBe(200);
		expect(mocks.deleteAsset).not.toHaveBeenCalled();
		expect(mocks.deleteAssetGeneration).not.toHaveBeenCalled();
		await response.json();
	});
});
