import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { POST } from "../route";

const mocks = vi.hoisted(() => ({
	requireSession: vi.fn(),
	resolveAuthorizedAppSnapshot: vi.fn(),
	createPending: vi.fn(),
	compensatePending: vi.fn(),
	createSignedUploadUrl: vi.fn(),
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
	FormAttachmentWriteRejectedError: class extends Error {},
}));

vi.mock("@/lib/storage/media", () => ({
	createSignedUploadUrl: mocks.createSignedUploadUrl,
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

function request(
	signal?: AbortSignal,
	changes: Record<string, unknown> = {},
): NextRequest {
	return new NextRequest("http://localhost/api/apps/app-1/attachments", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		...(signal === undefined ? {} : { signal }),
		body: JSON.stringify({
			entryKey: ENTRY_KEY,
			fieldUuid: FIELD_UUID,
			instancePath: "/data/photo",
			filename: "photo.jpg",
			sizeBytes: 17,
			...changes,
		}),
	});
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
				blueprint: captureBlueprint(),
			},
		});
		mocks.createPending.mockResolvedValue({
			attachmentId: ATTACHMENT_ID,
			attachmentName: `${ATTACHMENT_ID}.jpg`,
			objectKey: `captures-staged/project-1/${ATTACHMENT_ID}.jpg`,
		});
		mocks.createSignedUploadUrl.mockRejectedValue(signingError);
		mocks.compensatePending.mockResolvedValue(true);
	});

	it("rejects a real unsupported image extension before creating a pending row", async () => {
		const response = await POST(
			request(undefined, { filename: "photo.exe" }),
			params,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error:
				"An image question accepts .jpg, .jpeg, .png. Attach one of those instead.",
		});
		expect(mocks.createPending).not.toHaveBeenCalled();
	});

	it("returns the signed upload binding after an admitted capture proposal", async () => {
		mocks.createSignedUploadUrl.mockResolvedValue({
			url: "https://storage.example.test/upload",
			requiredHeaders: { "x-goog-if-generation-match": "0" },
		});
		const response = await POST(request(), params);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			attachmentId: ATTACHMENT_ID,
			attachmentName: `${ATTACHMENT_ID}.jpg`,
			uploadUrl: "https://storage.example.test/upload",
			uploadContentType: "image/jpeg",
			uploadHeaders: { "x-goog-if-generation-match": "0" },
		});
		expect(mocks.createPending).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: "app-1",
				projectId: "project-1",
				expectedAppMutationSeq: 7,
				fieldUuid: FIELD_UUID,
				instancePath: "/data/photo",
				contentType: "image/jpeg",
				sizeBytes: 17,
			}),
		);
		expect(mocks.compensatePending).not.toHaveBeenCalled();
	});
	it.each([
		{ instancePath: "/data/different" },
		{ fieldUuid: "44444444-4444-4444-8444-444444444444" },
		{ filename: "photo.exe" },
		{ foreign: true },
	])(
		"rejects a malformed capture proposal before persistence: %j",
		async (changes) => {
			const response = await POST(request(undefined, changes), params);
			expect(response.status).toBe(400);
			await response.json();
			expect(mocks.createPending).not.toHaveBeenCalled();
			expect(mocks.createSignedUploadUrl).not.toHaveBeenCalled();
		},
	);

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

	it("compensates on abort while a noncancellable signer settles later", async () => {
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const signed = Promise.withResolvers<never>();
		mocks.createSignedUploadUrl.mockImplementation(() => {
			entered.resolve();
			return signed.promise;
		});
		const responsePromise = POST(request(controller.signal), params);
		try {
			await entered.promise;
			controller.abort(new DOMException("Worker left the form", "AbortError"));
			const response = await responsePromise;
			expect(response.status).toBe(499);
			await response.json();
			expect(mocks.compensatePending).toHaveBeenCalledWith(
				expect.objectContaining({
					attachmentId: ATTACHMENT_ID,
					appId: "app-1",
					projectId: "project-1",
				}),
			);
		} finally {
			controller.abort();
			signed.reject(new Error("Signer failed after disconnect"));
			await Promise.allSettled([signed.promise, responsePromise]);
		}
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
	});
});

function captureBlueprint() {
	const doc = buildDoc({
		modules: [
			{
				name: "Evidence",
				forms: [
					{
						name: "Evidence",
						type: "survey",
						fields: [f({ uuid: FIELD_UUID, id: "photo", kind: "image" })],
					},
				],
			},
		],
	});
	const wire = toPersistableDoc(doc);
	blueprintDocSchema.parse(wire);
	const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	return wire;
}
