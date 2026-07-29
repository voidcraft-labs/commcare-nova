import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

const mocks = vi.hoisted(() => ({
	requireSession: vi.fn(),
	resolveAuthorizedAppSnapshot: vi.fn(),
	createPending: vi.fn(),
	compensatePending: vi.fn(),
	purgeExpired: vi.fn(),
	createSignedUploadUrl: vi.fn(),
	captureExtensionFor: vi.fn(),
	deleteAsset: vi.fn(),
	deleteAssetGeneration: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: mocks.requireSession,
}));

vi.mock("@/lib/db/appAccess", () => ({
	resolveAuthorizedAppSnapshot: mocks.resolveAuthorizedAppSnapshot,
}));

vi.mock("@/lib/db/formAttachments", () => ({
	compensatePendingFormAttachmentInitiation: mocks.compensatePending,
	createPendingFormAttachment: mocks.createPending,
	purgeExpiredFormAttachments: mocks.purgeExpired,
	FormAttachmentWriteRejectedError: class extends Error {},
}));

vi.mock("@/lib/domain", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/domain")>();
	return {
		...actual,
		isCaptureFieldKind: vi.fn(() => true),
	};
});

vi.mock("@/lib/domain/captureFormats", () => ({
	CAPTURE_EXTENSIONS_BY_KIND: { image: [".jpg"] },
	MAX_CAPTURE_BYTES: 4_000_000,
	captureContentType: vi.fn(() => "image/jpeg"),
	captureExtensionFor: mocks.captureExtensionFor,
	captureInstancePathMatchesTemplate: vi.fn(() => true),
	committedCapturePath: vi.fn(() => ({
		instancePathTemplate: "/data/photo",
	})),
}));

vi.mock("@/lib/storage/media", () => ({
	createSignedUploadUrl: mocks.createSignedUploadUrl,
	deleteAsset: mocks.deleteAsset,
	deleteAssetGeneration: mocks.deleteAssetGeneration,
}));

vi.mock("@/lib/logger", () => ({
	log: {
		error: mocks.error,
		warn: mocks.warn,
	},
}));

const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";
const FIELD_UUID = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";

function request(signal?: AbortSignal): NextRequest {
	return new Request("http://localhost/api/apps/app-1/attachments", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		...(signal === undefined ? {} : { signal }),
		body: JSON.stringify({
			entryKey: ENTRY_KEY,
			fieldUuid: FIELD_UUID,
			instancePath: "/data/photo",
			filename: "photo.jpg",
			sizeBytes: 17,
		}),
	}) as NextRequest;
}

const params = { params: Promise.resolve({ id: "app-1" }) };
const signingError = new Error("IAM signing unavailable");

describe("POST /api/apps/[id]/attachments initiation compensation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.resolveAuthorizedAppSnapshot.mockResolvedValue({
			projectId: "project-1",
			baseSeq: 7,
			app: {
				blueprint: {
					fields: {
						[FIELD_UUID]: { uuid: FIELD_UUID, kind: "image" },
					},
				},
			},
		});
		mocks.createPending.mockResolvedValue({
			attachmentId: ATTACHMENT_ID,
			attachmentName: `${ATTACHMENT_ID}.jpg`,
			objectKey: `captures-staged/project-1/${ATTACHMENT_ID}.jpg`,
		});
		mocks.createSignedUploadUrl.mockRejectedValue(signingError);
		mocks.captureExtensionFor.mockReturnValue(".jpg");
		mocks.compensatePending.mockResolvedValue(true);
		mocks.purgeExpired.mockResolvedValue({
			processed: 0,
			transitioned: 0,
			objects: [],
		});
	});

	it("uses the correct article for an image-format rejection", async () => {
		mocks.captureExtensionFor.mockReturnValue(undefined);

		const response = await POST(request(), params);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "An image question accepts .jpg. Attach one of those instead.",
		});
		expect(mocks.createPending).not.toHaveBeenCalled();
	});

	it("removes the exact pending row when URL signing fails", async () => {
		const response = await POST(request(), params);

		expect(response.status).toBe(500);
		expect(mocks.compensatePending).toHaveBeenCalledWith({
			attachmentId: ATTACHMENT_ID,
			attachmentName: `${ATTACHMENT_ID}.jpg`,
			appId: "app-1",
			projectId: "project-1",
			createdBy: "user-1",
			entryKey: ENTRY_KEY,
			fieldUuid: FIELD_UUID,
			instancePath: "/data/photo",
			objectKey: `captures-staged/project-1/${ATTACHMENT_ID}.jpg`,
		});
		expect(mocks.warn).not.toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledWith(
			"[apiError] unhandled",
			signingError,
		);
		await response.json();
	});

	it("preserves the signing failure when best-effort compensation fails", async () => {
		const cleanupError = new Error("database cleanup unavailable");
		mocks.compensatePending.mockRejectedValue(cleanupError);

		const response = await POST(request(), params);

		expect(response.status).toBe(500);
		expect(mocks.warn).toHaveBeenCalledWith(
			"[attachments] initiate compensation failed; expiry sweep remains the fallback",
			{
				err: cleanupError,
				attachmentId: ATTACHMENT_ID,
				appId: "app-1",
				projectId: "project-1",
			},
		);
		expect(mocks.error).toHaveBeenCalledWith(
			"[apiError] unhandled",
			signingError,
		);
		await response.json();
	});

	it("leaves a lost pending-row CAS to the expiry sweep without masking signing", async () => {
		mocks.compensatePending.mockResolvedValue(false);

		const response = await POST(request(), params);

		expect(response.status).toBe(500);
		expect(mocks.warn).toHaveBeenCalledWith(
			"[attachments] initiate compensation lost its pending-row CAS; expiry sweep remains the fallback",
			{
				attachmentId: ATTACHMENT_ID,
				appId: "app-1",
				projectId: "project-1",
			},
		);
		expect(mocks.error).toHaveBeenCalledWith(
			"[apiError] unhandled",
			signingError,
		);
		await response.json();
	});

	it("compensates the pending row when the request aborts during URL signing", async () => {
		const controller = new AbortController();
		mocks.createSignedUploadUrl.mockReturnValue(
			new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener(
					"abort",
					() => reject(controller.signal.reason),
					{ once: true },
				);
			}),
		);

		const responsePromise = POST(request(controller.signal), params);
		await vi.waitFor(() =>
			expect(mocks.createSignedUploadUrl).toHaveBeenCalled(),
		);
		controller.abort(new DOMException("Worker left the form", "AbortError"));
		const response = await responsePromise;

		expect(response.status).toBe(499);
		expect(mocks.compensatePending).toHaveBeenCalledWith(
			expect.objectContaining({
				attachmentId: ATTACHMENT_ID,
				appId: "app-1",
				projectId: "project-1",
			}),
		);
		await response.json();
	});

	it("does not create an unobserved rejecting signer promise for an already-aborted request", async () => {
		const controller = new AbortController();
		controller.abort(new DOMException("Worker left the form", "AbortError"));
		mocks.createSignedUploadUrl.mockImplementation(() =>
			Promise.reject(new Error("late signer rejection")),
		);

		const response = await POST(request(controller.signal), params);

		expect(response.status).toBe(499);
		expect(mocks.createSignedUploadUrl).not.toHaveBeenCalled();
		expect(mocks.compensatePending).toHaveBeenCalledWith(
			expect.objectContaining({
				attachmentId: ATTACHMENT_ID,
				appId: "app-1",
				projectId: "project-1",
			}),
		);
		await response.json();
		// Give Vitest an unhandled-rejection checkpoint. The test runner would
		// fail this test if the rejecting signer promise had been constructed.
		await Promise.resolve();
	});
});
