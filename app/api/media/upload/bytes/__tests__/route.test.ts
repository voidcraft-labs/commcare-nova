/**
 * `PUT /api/media/upload/bytes` — byte-PUT route tests.
 *
 * The route writes an upload's body to its reserved pending row's GCS key.
 * Pins: it only writes for a pending row the caller owns (a foreign/missing/
 * already-ready row is rejected), it streams to the row's own key, and it maps
 * an oversized stream to 413.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import {
	loadAssetForOwner,
	MediaAssetOwnershipError,
} from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain";
import {
	AssetUploadTooLargeError,
	uploadAssetStream,
} from "@/lib/storage/media";
import { PUT } from "../route";

const { requireSessionMock, loadAssetForOwnerMock, uploadAssetStreamMock } =
	vi.hoisted(() => ({
		requireSessionMock: vi.fn(),
		loadAssetForOwnerMock: vi.fn(),
		uploadAssetStreamMock: vi.fn(),
	}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/mediaAssets", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/mediaAssets")>();
	return { ...actual, loadAssetForOwner: loadAssetForOwnerMock };
});
// Spread the real module so `AssetUploadTooLargeError` stays the genuine class
// (the route's `instanceof` check must match), overriding only the streamed write.
vi.mock("@/lib/storage/media", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/storage/media")>();
	return { ...actual, uploadAssetStream: uploadAssetStreamMock };
});

const PENDING_ASSET = {
	id: asAssetId("asset-1"),
	owner: "user-1",
	status: "pending" as const,
	kind: "image" as const,
	gcsObjectKey: "pending/user-1/asset-1.png",
};

// `uploadAssetStream` is mocked, so the body is never consumed — a plain
// truthy sentinel stands in (a real `ReadableStream` would leak unconsumed
// under the async-leak detector).
const BODY_SENTINEL = "stream-sentinel";

function reqWith(opts: {
	assetId?: string;
	contentType?: string;
	body?: unknown;
}) {
	const url =
		opts.assetId === undefined
			? "https://commcare.app/api/media/upload/bytes"
			: `https://commcare.app/api/media/upload/bytes?assetId=${encodeURIComponent(opts.assetId)}`;
	return {
		url,
		headers: new Headers(
			opts.contentType ? { "content-type": opts.contentType } : {},
		),
		body: "body" in opts ? opts.body : BODY_SENTINEL,
	} as unknown as Parameters<typeof PUT>[0];
}

/** Drain an error response's JSON body so its stream settles (no leak). */
async function expectError(res: Response, status: number) {
	expect(res.status).toBe(status);
	const body = (await res.json()) as { error?: string };
	expect(typeof body.error).toBe("string");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue({
		user: { id: "user-1" },
	} as never);
	vi.mocked(loadAssetForOwner).mockResolvedValue(PENDING_ASSET as never);
	vi.mocked(uploadAssetStream).mockResolvedValue();
});

describe("PUT /api/media/upload/bytes", () => {
	it("streams the body to the reserved pending row's key, capped at its kind", async () => {
		const res = await PUT(
			reqWith({ assetId: "asset-1", contentType: "image/png" }),
		);

		expect(res.status).toBe(200);
		expect(uploadAssetStream).toHaveBeenCalledTimes(1);
		expect(vi.mocked(uploadAssetStream).mock.calls[0]?.[0]).toMatchObject({
			gcsObjectKey: "pending/user-1/asset-1.png",
			contentType: "image/png",
			maxBytes: 5 * 1024 * 1024, // image cap, not the global max
		});
	});

	it("rejects a foreign asset (ownership error → not found)", async () => {
		vi.mocked(loadAssetForOwner).mockRejectedValue(
			new MediaAssetOwnershipError(
				asAssetId("asset-1"),
				"user-1",
				"someone-else",
			),
		);
		await expectError(
			await PUT(reqWith({ assetId: "asset-1", contentType: "image/png" })),
			404,
		);
		expect(uploadAssetStream).not.toHaveBeenCalled();
	});

	it("rejects a missing pending row", async () => {
		vi.mocked(loadAssetForOwner).mockResolvedValue(null);
		await expectError(
			await PUT(reqWith({ assetId: "asset-1", contentType: "image/png" })),
			404,
		);
		expect(uploadAssetStream).not.toHaveBeenCalled();
	});

	it("rejects an already-finalized (ready) asset", async () => {
		vi.mocked(loadAssetForOwner).mockResolvedValue({
			...PENDING_ASSET,
			status: "ready",
		} as never);
		await expectError(
			await PUT(reqWith({ assetId: "asset-1", contentType: "image/png" })),
			404,
		);
		expect(uploadAssetStream).not.toHaveBeenCalled();
	});

	it("rejects a missing assetId", async () => {
		await expectError(await PUT(reqWith({ contentType: "image/png" })), 400);
		expect(uploadAssetStream).not.toHaveBeenCalled();
	});

	it("rejects a request with no body", async () => {
		await expectError(
			await PUT(reqWith({ assetId: "asset-1", body: null })),
			400,
		);
		expect(uploadAssetStream).not.toHaveBeenCalled();
	});

	it("maps an oversized stream to 413", async () => {
		vi.mocked(uploadAssetStream).mockRejectedValue(
			new AssetUploadTooLargeError(5 * 1024 * 1024),
		);
		await expectError(
			await PUT(reqWith({ assetId: "asset-1", contentType: "image/png" })),
			413,
		);
	});
});
