import { NextRequest } from "next/server";
import { AppAccessError } from "@/lib/db/appAccess";
/**
 * `PUT /api/media/upload/dev-put`: the local-dev signed-PUT proxy.
 *
 * The pending object key embeds the PROJECT id (`pending/<projectId>/…`,
 * `pendingGcsObjectKeyFor`), so the route's guard must gate Project
 * membership: a guard that demands the session USER id in that segment
 * rejects every legitimate dev upload with a 403. These tests pin that
 * regression plus the route's other boundary rejections (malformed key,
 * byte cap, prod hard-gate).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "../route";

const {
	requireSessionMock,
	resolveProjectAccessMock,
	authorizePendingFormAttachmentUploadMock,
	uploadAssetBytesMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	resolveProjectAccessMock: vi.fn(),
	authorizePendingFormAttachmentUploadMock: vi.fn(),
	uploadAssetBytesMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
}));
vi.mock("@/lib/db/appAccess", async (original) => ({
	...(await original<typeof import("@/lib/db/appAccess")>()),
	resolveProjectAccess: resolveProjectAccessMock,
}));
vi.mock("@/lib/db/formAttachments", () => ({
	authorizePendingFormAttachmentUpload:
		authorizePendingFormAttachmentUploadMock,
}));
vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: uploadAssetBytesMock,
}));

const ownedRequests: NextRequest[] = [];
function devPutReq(opts: {
	key?: string;
	max?: string;
	body?: Uint8Array;
	contentType?: string;
}) {
	const params = new URLSearchParams();
	if (opts.key !== undefined) params.set("key", opts.key);
	if (opts.max !== undefined) params.set("max", opts.max);
	const bytes = opts.body ?? new TextEncoder().encode("png-bytes");
	const req = new NextRequest(
		`http://localhost:3000/api/media/upload/dev-put?${params.toString()}`,
		{
			method: "PUT",
			headers: opts.contentType ? { "content-type": opts.contentType } : {},
			body: new Uint8Array(bytes),
		},
	);
	ownedRequests.push(req);
	return req;
}

beforeEach(() => {
	vi.clearAllMocks();
	// The route hard-gates on NODE_ENV (vitest runs as "test").
	vi.stubEnv("NODE_ENV", "development");
	requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
	resolveProjectAccessMock.mockResolvedValue(undefined);
	authorizePendingFormAttachmentUploadMock.mockResolvedValue(null);
	uploadAssetBytesMock.mockResolvedValue(undefined);
});

afterEach(async () => {
	try {
		for (const req of ownedRequests.splice(0))
			if (!req.bodyUsed) await req.body?.cancel();
	} finally {
		vi.unstubAllEnvs();
	}
});

describe("PUT /api/media/upload/dev-put", () => {
	it("writes the bytes when the key's Project is one the caller can edit", async () => {
		// The tenant segment is the PROJECT id, never the user id: the same
		// `edit` gate initiate ran before minting this URL.
		const res = await PUT(
			devPutReq({
				key: "pending/project-1/asset-1.png",
				max: "1000",
				contentType: "image/png",
			}),
		);

		expect(res.status).toBe(200);
		expect(resolveProjectAccessMock).toHaveBeenCalledWith(
			"user-1",
			"project-1",
			"edit",
		);
		expect(uploadAssetBytesMock).toHaveBeenCalledWith({
			gcsObjectKey: "pending/project-1/asset-1.png",
			bytes: Buffer.from("png-bytes"),
			contentType: "image/png",
			ifAbsent: true,
		});
	});

	it("binds a capture PUT to the exact actor-owned pending row", async () => {
		authorizePendingFormAttachmentUploadMock.mockResolvedValue({
			contentType: "image/png",
			maxBytes: 9,
		});
		const res = await PUT(
			devPutReq({
				key: "captures-staged/project-1/attachment-1.png",
				max: "999999",
				contentType: "image/png",
			}),
		);

		expect(res.status).toBe(200);
		expect(authorizePendingFormAttachmentUploadMock).toHaveBeenCalledWith({
			objectKey: "captures-staged/project-1/attachment-1.png",
			actorUserId: "user-1",
		});
		expect(resolveProjectAccessMock).not.toHaveBeenCalled();
		expect(uploadAssetBytesMock).toHaveBeenCalledWith({
			gcsObjectKey: "captures-staged/project-1/attachment-1.png",
			bytes: Buffer.from("png-bytes"),
			contentType: "image/png",
			ifAbsent: true,
		});
	});

	it("derives a capture's exact byte count from the row, not the URL", async () => {
		authorizePendingFormAttachmentUploadMock.mockResolvedValue({
			contentType: "image/png",
			maxBytes: 4,
		});
		const res = await PUT(
			devPutReq({
				key: "captures-staged/project-1/attachment-1.png",
				max: "999999",
				contentType: "image/png",
			}),
		);

		expect(res.status).toBe(413);
		expect(uploadAssetBytesMock).not.toHaveBeenCalled();
		await res.json();
	});

	it("collapses a foreign or non-pending capture attempt to not found", async () => {
		const res = await PUT(
			devPutReq({
				key: "captures-staged/project-1/attachment-1.png",
				contentType: "image/png",
			}),
		);

		expect(res.status).toBe(404);
		expect(uploadAssetBytesMock).not.toHaveBeenCalled();
		await res.json();
	});

	it("returns the storage precondition status for a reused attempt", async () => {
		authorizePendingFormAttachmentUploadMock.mockResolvedValue({
			contentType: "image/png",
			maxBytes: 9,
		});
		uploadAssetBytesMock.mockRejectedValue({ code: 412 });
		const res = await PUT(
			devPutReq({
				key: "captures-staged/project-1/attachment-1.png",
				contentType: "image/png",
			}),
		);

		expect(res.status).toBe(412);
		await res.json();
	});

	it("403s when the caller can't edit the key's Project, writing nothing", async () => {
		resolveProjectAccessMock.mockRejectedValue(
			new AppAccessError("not_member"),
		);

		const res = await PUT(
			devPutReq({ key: "pending/project-2/asset-1.png", max: "1000" }),
		);

		expect(res.status).toBe(403);
		expect(uploadAssetBytesMock).not.toHaveBeenCalled();
		await res.json();
	});

	it("400s a key outside the pending upload shape, without a membership lookup", async () => {
		// A final content-hash key (or anything else) is never a legitimate
		// dev-put target: only initiate-minted `pending/<projectId>/<object>`.
		const res = await PUT(
			devPutReq({ key: "projects/project-1/abc.png", max: "1000" }),
		);

		expect(res.status).toBe(400);
		expect(resolveProjectAccessMock).not.toHaveBeenCalled();
		expect(uploadAssetBytesMock).not.toHaveBeenCalled();
		await res.json();
	});

	it("413s a body over the per-attempt cap", async () => {
		const res = await PUT(
			devPutReq({
				key: "pending/project-1/asset-1.png",
				max: "4",
				body: new TextEncoder().encode("way-over-cap"),
			}),
		);

		expect(res.status).toBe(413);
		expect(uploadAssetBytesMock).not.toHaveBeenCalled();
		await res.json();
	});

	it("400s a present-but-invalid max instead of failing open", async () => {
		const res = await PUT(
			devPutReq({ key: "pending/project-1/asset-1.png", max: "abc" }),
		);

		expect(res.status).toBe(400);
		expect(uploadAssetBytesMock).not.toHaveBeenCalled();
		await res.json();
	});

	it("404s outside development", async () => {
		vi.stubEnv("NODE_ENV", "test");

		const res = await PUT(
			devPutReq({ key: "pending/project-1/asset-1.png", max: "1000" }),
		);

		expect(res.status).toBe(404);
		expect(uploadAssetBytesMock).not.toHaveBeenCalled();
		await res.json();
	});
});

it("refuses a foreign Project before consuming any upload bytes", async () => {
	resolveProjectAccessMock.mockRejectedValue(new AppAccessError("not_member"));
	const req = devPutReq({ key: "pending/project-foreign/a.png", max: "100" });
	const response = await PUT(req);
	try {
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("can't edit"),
		});
		expect(response.status).toBe(403);
		expect(req.bodyUsed).toBe(false);
		expect(uploadAssetBytesMock).not.toHaveBeenCalled();
	} finally {
		if (!req.bodyUsed) await req.body?.cancel();
	}
});
