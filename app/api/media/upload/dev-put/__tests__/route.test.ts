/**
 * `PUT /api/media/upload/dev-put` — the local-dev signed-PUT proxy.
 *
 * The pending object key embeds the PROJECT id (`pending/<projectId>/…`,
 * `pendingGcsObjectKeyFor`), so the route's guard must gate Project
 * membership — a guard that demands the session USER id in that segment
 * rejects every legitimate dev upload with a 403. These tests pin that
 * regression plus the route's other boundary rejections (malformed key,
 * byte cap, prod hard-gate).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "../route";

const { requireSessionMock, resolveProjectAccessMock, uploadAssetBytesMock } =
	vi.hoisted(() => ({
		requireSessionMock: vi.fn(),
		resolveProjectAccessMock: vi.fn(),
		uploadAssetBytesMock: vi.fn(),
	}));

// The route branches on `err instanceof AppAccessError`, so the mocked
// module must export a real class the tests can throw. Hoisted because the
// factory runs while the route module is being imported.
const { MockAppAccessError } = vi.hoisted(() => {
	class MockAppAccessError extends Error {
		readonly name = "AppAccessError";
	}
	return { MockAppAccessError };
});

vi.mock("@/lib/auth-utils", () => ({
	requireSession: requireSessionMock,
}));
vi.mock("@/lib/db/appAccess", () => ({
	resolveProjectAccess: resolveProjectAccessMock,
	AppAccessError: MockAppAccessError,
}));
vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: uploadAssetBytesMock,
}));

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
	return {
		url: `http://localhost:3000/api/media/upload/dev-put?${params.toString()}`,
		headers: new Headers(
			opts.contentType ? { "content-type": opts.contentType } : {},
		),
		arrayBuffer: async () => bytes.buffer as ArrayBuffer,
	} as Parameters<typeof PUT>[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	// The route hard-gates on NODE_ENV (vitest runs as "test").
	vi.stubEnv("NODE_ENV", "development");
	requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
	resolveProjectAccessMock.mockResolvedValue(undefined);
	uploadAssetBytesMock.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("PUT /api/media/upload/dev-put", () => {
	it("writes the bytes when the key's Project is one the caller can edit", async () => {
		// The tenant segment is the PROJECT id, never the user id — the same
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
			bytes: expect.any(Buffer),
			contentType: "image/png",
		});
	});

	it("403s when the caller can't edit the key's Project, writing nothing", async () => {
		resolveProjectAccessMock.mockRejectedValue(
			new MockAppAccessError("not_member"),
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
		// dev-put target — only initiate-minted `pending/<projectId>/<object>`.
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
