import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "../route";

const mocks = vi.hoisted(() => ({
	requireSession: vi.fn(),
	resolveAppScope: vi.fn(),
	retarget: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: mocks.requireSession,
}));

vi.mock("@/lib/db/appAccess", () => ({
	resolveAppScope: mocks.resolveAppScope,
}));

vi.mock("@/lib/db/formAttachments", () => ({
	confirmFormAttachment: vi.fn(),
	deleteUnsubmittedFormAttachment: vi.fn(),
	loadFormAttachmentForEdit: vi.fn(),
	retargetStagedFormAttachment: mocks.retarget,
	FormAttachmentWriteRejectedError: class extends Error {},
}));

vi.mock("@/lib/storage/media", () => ({
	deleteAsset: vi.fn(),
	deleteAssetGeneration: vi.fn(),
	getStoredObjectMetadata: vi.fn(),
}));

function request(body: unknown): NextRequest {
	return new Request(
		"http://localhost/api/apps/app-1/attachments/attachment-1",
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	) as NextRequest;
}

const params = {
	params: Promise.resolve({
		id: "app-1",
		attachmentId: "attachment-1",
	}),
};

describe("PATCH /api/apps/[id]/attachments/[attachmentId]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.resolveAppScope.mockResolvedValue({ projectId: "project-1" });
		mocks.retarget.mockResolvedValue({ attachmentId: "attachment-1" });
	});

	it("revalidates one positional repeat-path move through the exact row", async () => {
		const response = await PATCH(
			request({
				expectedInstancePath: "/data/visits[1]/photo",
				instancePath: "/data/visits[0]/photo",
			}),
			params,
		);

		expect(response.status).toBe(200);
		expect(mocks.retarget).toHaveBeenCalledWith({
			attachmentId: "attachment-1",
			actorUserId: "user-1",
			expectedProjectId: "project-1",
			expectedInstancePath: "/data/visits[1]/photo",
			instancePath: "/data/visits[0]/photo",
		});
		await response.json();
	});

	it("rejects an over-posted path body before touching the row", async () => {
		const response = await PATCH(
			request({
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
});
