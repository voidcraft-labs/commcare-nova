/**
 * `PUT /api/media/upload/bytes` — byte-PUT route tests.
 *
 * The route writes an upload's body to its pending GCS key. Pins the owner
 * guard (a key outside the caller's own `pending/<userId>/` namespace is
 * rejected) and the 413 mapping for an oversized stream.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import {
	AssetUploadTooLargeError,
	uploadAssetStream,
} from "@/lib/storage/media";
import { PUT } from "../route";

const { requireSessionMock, uploadAssetStreamMock } = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	uploadAssetStreamMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
// Spread the real module so `AssetUploadTooLargeError` stays the genuine
// class (the route's `instanceof` check must match), overriding only the
// streamed write.
vi.mock("@/lib/storage/media", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/storage/media")>();
	return { ...actual, uploadAssetStream: uploadAssetStreamMock };
});

function reqWith(opts: { key?: string; contentType?: string; body?: unknown }) {
	const url =
		opts.key === undefined
			? "https://commcare.app/api/media/upload/bytes"
			: `https://commcare.app/api/media/upload/bytes?key=${encodeURIComponent(opts.key)}`;
	return {
		url,
		headers: new Headers(
			opts.contentType ? { "content-type": opts.contentType } : {},
		),
		body: "body" in opts ? opts.body : new ReadableStream(),
	} as unknown as Parameters<typeof PUT>[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue({
		user: { id: "user-1" },
	} as never);
	vi.mocked(uploadAssetStream).mockResolvedValue();
});

describe("PUT /api/media/upload/bytes", () => {
	it("streams the body to the caller's own pending key", async () => {
		const res = await PUT(
			reqWith({ key: "pending/user-1/asset-1.png", contentType: "image/png" }),
		);

		expect(res.status).toBe(200);
		expect(uploadAssetStream).toHaveBeenCalledTimes(1);
		expect(vi.mocked(uploadAssetStream).mock.calls[0]?.[0]).toMatchObject({
			gcsObjectKey: "pending/user-1/asset-1.png",
			contentType: "image/png",
		});
	});

	it("rejects a key outside the caller's pending namespace", async () => {
		const res = await PUT(
			reqWith({
				key: "pending/other-user/asset-1.png",
				contentType: "image/png",
			}),
		);

		expect(res.status).toBe(403);
		expect(uploadAssetStream).not.toHaveBeenCalled();
	});

	it("rejects a missing key", async () => {
		const res = await PUT(reqWith({ contentType: "image/png" }));

		expect(res.status).toBe(400);
		expect(uploadAssetStream).not.toHaveBeenCalled();
	});

	it("rejects a request with no body", async () => {
		const res = await PUT(
			reqWith({ key: "pending/user-1/asset-1.png", body: null }),
		);

		expect(res.status).toBe(400);
		expect(uploadAssetStream).not.toHaveBeenCalled();
	});

	it("maps an oversized stream to 413", async () => {
		vi.mocked(uploadAssetStream).mockRejectedValue(
			new AssetUploadTooLargeError(50 * 1024 * 1024),
		);

		const res = await PUT(
			reqWith({ key: "pending/user-1/asset-1.png", contentType: "video/mp4" }),
		);

		expect(res.status).toBe(413);
	});
});
