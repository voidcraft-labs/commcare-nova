/**
 * `POST /api/media/upload` — initiate tests.
 *
 * The browser upload path writes untrusted bytes to a per-attempt pending
 * object, not the final content-hash key; confirm validates and promotes
 * them later. This pins that the initiate response points the byte-PUT at
 * the per-attempt pending key, so a late/duplicate PUT can only overwrite
 * its own attempt.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import {
	createPendingAsset,
	findReadyAssetByOwnerAndHash,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain";
import { POST } from "../route";

const HASH = "a".repeat(64);

const {
	requireSessionMock,
	createPendingAssetMock,
	findReadyAssetByOwnerAndHashMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	createPendingAssetMock: vi.fn(),
	findReadyAssetByOwnerAndHashMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/mediaAssets", () => ({
	createPendingAsset: createPendingAssetMock,
	findReadyAssetByOwnerAndHash: findReadyAssetByOwnerAndHashMock,
	toWireMediaAsset: vi.fn((asset: MediaAssetRecord) => asset),
}));

function reqWith(body: unknown) {
	// `headers` is needed by `readJsonBody`'s Content-Length guard; an empty
	// Headers means no declared length, so it falls through to `json()`.
	return {
		headers: new Headers(),
		json: async () => body,
	} as Parameters<typeof POST>[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue({
		user: { id: "user-1" },
	} as never);
	vi.mocked(findReadyAssetByOwnerAndHash).mockResolvedValue(null);
	vi.mocked(createPendingAsset).mockResolvedValue({
		assetId: asAssetId("asset-1"),
		gcsObjectKey: "pending/user-1/asset-1.png",
	});
});

describe("POST /api/media/upload", () => {
	it("points the byte-PUT at the reserved pending object key", async () => {
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
			uploadContentType: string;
		};

		expect(res.status).toBe(200);
		expect(body.assetId).toBe("asset-1");
		// Same-origin byte-PUT route carrying the reserved `assetId`.
		expect(body.uploadUrl).toBe("/api/media/upload/bytes?assetId=asset-1");
		expect(body.uploadContentType).toBe("image/png");
		const pendingArgs = vi.mocked(createPendingAsset).mock.calls[0]?.[0];
		expect(pendingArgs).toMatchObject({
			owner: "user-1",
			contentHash: HASH,
			extension: ".png",
		});
		expect(pendingArgs).not.toHaveProperty("gcsObjectKey");
	});
});
