import { NextRequest } from "next/server";
/**
 * `POST /api/media/upload`: signed-PUT initiate tests.
 *
 * The browser upload path must write untrusted bytes to a per-attempt
 * pending object, not the final content-hash key. Confirm validation
 * promotes the bytes later. This pins the stale-signed-URL data-loss fix:
 * a leaked/late PUT can only overwrite its own pending object.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { requireSession, resolveActiveProjectId } from "@/lib/auth-utils";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	createPendingAsset,
	findReadyAssetByProjectAndHash,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import { createSignedUploadUrl } from "@/lib/storage/media";
import { POST } from "../route";

const HASH = "a".repeat(64);
const ASSET_ID = testMediaAssetId("asset-1");

const {
	requireSessionMock,
	resolveActiveProjectIdMock,
	resolveAppScopeMock,
	resolveProjectAccessMock,
	createPendingAssetMock,
	findReadyAssetByProjectAndHashMock,
	createSignedUploadUrlMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	resolveActiveProjectIdMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
	resolveProjectAccessMock: vi.fn(),
	createPendingAssetMock: vi.fn(),
	findReadyAssetByProjectAndHashMock: vi.fn(),
	createSignedUploadUrlMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
	resolveActiveProjectId: resolveActiveProjectIdMock,
}));
vi.mock("@/lib/db/appAccess", async (original) => ({
	...(await original<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: resolveAppScopeMock,
	resolveProjectAccess: resolveProjectAccessMock,
}));
vi.mock("@/lib/db/mediaAssets", async (original) => ({
	...(await original<typeof import("@/lib/db/mediaAssets")>()),
	createPendingAsset: createPendingAssetMock,
	findReadyAssetByProjectAndHash: findReadyAssetByProjectAndHashMock,
}));
vi.mock("@/lib/storage/media", () => ({
	createSignedUploadUrl: createSignedUploadUrlMock,
}));

function reqWith(body: unknown) {
	return new NextRequest("http://localhost/api/test", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue({
		user: { id: "user-1" },
	} as never);
	vi.mocked(resolveActiveProjectId).mockResolvedValue("project-1");
	// The personal-upload branch gates the active Project at `edit`; resolve it.
	resolveProjectAccessMock.mockResolvedValue(undefined);
	vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(null);
	vi.mocked(createPendingAsset).mockResolvedValue({
		assetId: ASSET_ID,
		gcsObjectKey: "pending/project-1/asset-1.png",
	});
	vi.mocked(createSignedUploadUrl).mockResolvedValue({
		url: "https://storage.example/signed",
		expiresAtMs: 123,
		requiredHeaders: { "x-goog-content-length-range": "0,100" },
	});
});

describe("POST /api/media/upload", () => {
	it("mints the signed URL against the reserved pending object key", async () => {
		const res = await POST(
			reqWith({
				filename: "logo.png",
				mimeType: "image/png",
				sizeBytes: 100,
				contentHash: HASH,
			}),
		);
		const body = (await res.json()) as {
			assetId: string;
			uploadUrl: string;
			uploadHeaders: Record<string, string>;
		};

		expect(res.status).toBe(200);
		expect(body.assetId).toBe(ASSET_ID);
		expect(body.uploadUrl).toBe("https://storage.example/signed");
		// The signed `x-goog-content-length-range` header the browser MUST echo on
		// the PUT: the most deploy-fragile wire of this change. If the route
		// stopped forwarding `requiredHeaders` as `uploadHeaders`, every upload
		// would 403 the V4 signature; this is the tripwire.
		expect(body.uploadHeaders).toEqual({
			"x-goog-content-length-range": "0,100",
		});
		const pendingArgs = vi.mocked(createPendingAsset).mock.calls[0]?.[0];
		expect(pendingArgs).toMatchObject({
			owner: "user-1",
			project_id: "project-1",
			contentHash: HASH,
			extension: ".png",
		});
		expect(pendingArgs).not.toHaveProperty("gcsObjectKey");
		expect(createSignedUploadUrl).toHaveBeenCalledWith({
			gcsObjectKey: "pending/project-1/asset-1.png",
			contentType: "image/png",
			// The per-kind byte cap is bound onto the signed PUT.
			maxBytes: expect.any(Number),
		});
	});

	it("refuses a personal upload when the caller can't EDIT the active Project (a viewer)", async () => {
		// Uploading is a write: a read-only member of a shared active Project must
		// not seed pending rows/objects there. resolveProjectAccess throws
		// AppAccessError, which handleApiError collapses to a 404, and nothing is
		// written.
		const denied = new AppAccessError("insufficient_role");
		resolveProjectAccessMock.mockRejectedValue(denied);

		const res = await POST(
			reqWith({
				filename: "logo.png",
				mimeType: "image/png",
				sizeBytes: 100,
				contentHash: HASH,
			}),
		);

		expect(res.status).toBe(404);
		expect(createPendingAsset).not.toHaveBeenCalled();
		expect(createSignedUploadUrl).not.toHaveBeenCalled();
		// Drain the error response body so its promise settles (the async-leak
		// gate flags an unread `NextResponse.json` body).
		await res.json();
	});
});

it("uses the URL app Project for an upload even when the active Project differs", async () => {
	resolveAppScopeMock.mockResolvedValue({ projectId: "project-app" });
	const response = await POST(
		reqWith({
			filename: "logo.png",
			mimeType: "image/apng",
			sizeBytes: 100,
			contentHash: HASH,
			appId: "app-2",
		}),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		uploadContentType: "image/png",
		deduplicated: false,
	});
	expect(resolveAppScopeMock).toHaveBeenCalledWith("app-2", "user-1", "edit");
	expect(resolveActiveProjectIdMock).not.toHaveBeenCalled();
	expect(createPendingAssetMock).toHaveBeenCalledWith(
		expect.objectContaining({
			project_id: "project-app",
			mimeType: "image/png",
			kind: "image",
		}),
	);
});
it("deduplicates within the authorized Project and returns only public asset metadata", async () => {
	const asset: MediaAssetRecord = {
		id: ASSET_ID,
		owner: "u1",
		project_id: "project-1",
		contentHash: HASH,
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 100,
		gcsObjectKey: "private-storage-key",
		originalFilename: "image.png",
		displayName: "Image",
		status: "ready",
		created_at: new Date(0),
	};
	findReadyAssetByProjectAndHashMock.mockResolvedValue(asset);
	const response = await POST(
		reqWith({
			filename: "logo.png",
			mimeType: "image/png",
			sizeBytes: 100,
			contentHash: HASH,
		}),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		assetId: ASSET_ID,
		deduplicated: true,
		asset: {
			id: ASSET_ID,
			contentHash: HASH,
			mimeType: "image/png",
			kind: "image",
			extension: ".png",
			sizeBytes: 100,
			originalFilename: "image.png",
			displayName: "Image",
			status: "ready",
			createdAt: new Date(0).toISOString(),
		},
	});
	expect(findReadyAssetByProjectAndHashMock).toHaveBeenCalledWith(
		"project-1",
		HASH,
	);
	expect(createPendingAssetMock).not.toHaveBeenCalled();
	expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
});
it.each([
	{ sizeBytes: 0 },
	{ sizeBytes: "100" },
	{ contentHash: "bad" },
	{ mimeType: "application/exe" },
	{ projectId: "foreign" },
])(
	"refuses malformed metadata before reserving or signing: %j",
	async (patch) => {
		const response = await POST(
			reqWith({
				filename: "logo.png",
				mimeType: "image/png",
				sizeBytes: 100,
				contentHash: HASH,
				...patch,
			}),
		);
		expect(response.status).toBe(400);
		await response.json();
		expect(createPendingAssetMock).not.toHaveBeenCalled();
		expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
	},
);
