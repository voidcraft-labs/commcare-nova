/**
 * `GET` + `DELETE /api/media/[assetId]` route tests.
 *
 * GET pins the serve contract: the object's presence and size are resolved
 * from storage BEFORE the response is constructed — a ready row whose object
 * is gone returns a clean 404 (never a 200 that dies mid-stream and gets
 * dropped as malformed downstream), and Content-Length reflects the stored
 * bytes, not the row's recorded size.
 *
 * DELETE is a thin wrapper around the authoritative metadata transaction and
 * post-commit object purge. These pin 204 on a clean delete, 409 when the
 * transaction re-walk finds a carrier, and 404 on missing/foreign.
 */

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { deleteMediaAssetForActor } from "@/lib/db/mediaDeletion";
import { purgeAssetStorage } from "@/lib/media/assetDeletion";
import { DELETE, GET } from "../route";

const {
	requireSessionMock,
	userInProjectMock,
	loadAssetByIdMock,
	deleteMediaAssetForActorMock,
	purgeAssetStorageMock,
	streamAssetMock,
	getStoredObjectSizeMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	userInProjectMock: vi.fn(() => Promise.resolve(true)),
	loadAssetByIdMock: vi.fn(),
	deleteMediaAssetForActorMock: vi.fn(),
	purgeAssetStorageMock: vi.fn(
		async (_asset: unknown, opts?: { deleteRow?: () => Promise<boolean> }) =>
			opts?.deleteRow ? opts.deleteRow() : true,
	),
	streamAssetMock: vi.fn(),
	getStoredObjectSizeMock: vi.fn(() => Promise.resolve<number | null>(null)),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/appAccess", () => ({ userInProject: userInProjectMock }));
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetById: loadAssetByIdMock,
}));
vi.mock("@/lib/db/mediaDeletion", () => ({
	deleteMediaAssetForActor: deleteMediaAssetForActorMock,
}));
vi.mock("@/lib/media/assetDeletion", () => ({
	purgeAssetStorage: purgeAssetStorageMock,
}));
// `extractObjectKeyForAsset` comes from the real (pure, mammoth-free)
// `@/lib/domain/multimedia`, so the route computes the actual extract-sibling
// key — no need to mock it. Storage is mocked at the boundary so the real GCS
// module never loads.
vi.mock("@/lib/storage/media", () => ({
	streamAsset: streamAssetMock,
	getStoredObjectSize: getStoredObjectSizeMock,
}));

/** A ready document asset row, overridable per test. The reverse-index candidate
 *  set the route threads to the guard comes from `listReferencingAppIds` (mocked
 *  to `["app-x"]`), not a field on the row. */
function docAsset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: "asset-1",
		owner: "user-1",
		project_id: "project-1",
		gcsObjectKey: "projects/project-1/asset-1.pdf",
		originalFilename: "spec.pdf",
		contentHash: "abc",
		mimeType: "application/pdf",
		kind: "pdf",
		extension: ".pdf",
		sizeBytes: 100,
		status: "ready",
		...over,
	} as unknown as MediaAssetRecord;
}

const ctx = (assetId = "asset-1") => ({ params: Promise.resolve({ assetId }) });
const req = () => ({}) as Parameters<typeof DELETE>[0];
/** Drain a handler response's body so its underlying promise settles (the
 *  async-leak gate flags an unread `NextResponse.json` body). */
const drainBody = (res: Response): Promise<string> => res.text();

beforeEach(() => {
	vi.clearAllMocks();
	requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
	userInProjectMock.mockResolvedValue(true);
	deleteMediaAssetForActorMock.mockResolvedValue({
		kind: "deleted",
		asset: docAsset(),
	});
	purgeAssetStorageMock.mockImplementation(
		async (_asset: unknown, opts?: { deleteRow?: () => Promise<boolean> }) =>
			opts?.deleteRow ? opts.deleteRow() : true,
	);
	getStoredObjectSizeMock.mockResolvedValue(100);
	streamAssetMock.mockImplementation(() => Readable.from(Buffer.from("bytes")));
});

/** GET needs an abort signal — the route wires client-disconnect cleanup. */
const getReq = () =>
	({ signal: new AbortController().signal }) as unknown as Parameters<
		typeof GET
	>[0];

describe("GET media asset", () => {
	it("streams no-store bytes with Content-Length from the stored object, not the row", async () => {
		loadAssetByIdMock.mockResolvedValue(docAsset({ sizeBytes: 999 }));
		getStoredObjectSizeMock.mockResolvedValue(5);

		const res = await GET(getReq(), ctx());
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Length")).toBe("5");
		expect(res.headers.get("Content-Type")).toBe("application/pdf");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await drainBody(res)).toBe("bytes");
	});

	it("404s a ready row whose object is missing from storage — before any byte streams", async () => {
		loadAssetByIdMock.mockResolvedValue(docAsset());
		getStoredObjectSizeMock.mockResolvedValue(null);

		const res = await GET(getReq(), ctx());
		expect(res.status).toBe(404);
		// The contract under test: the failure is decided before a stream (and
		// therefore a 200 + Content-Length) ever starts.
		expect(streamAssetMock).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("404s a missing row without touching storage", async () => {
		loadAssetByIdMock.mockResolvedValue(null);

		const res = await GET(getReq(), ctx());
		expect(res.status).toBe(404);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(getStoredObjectSizeMock).not.toHaveBeenCalled();
		expect(streamAssetMock).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("500s a metadata lookup failure before any byte streams", async () => {
		loadAssetByIdMock.mockResolvedValue(docAsset());
		getStoredObjectSizeMock.mockRejectedValue(new Error("GCS unavailable"));

		const res = await GET(getReq(), ctx());
		expect(res.status).toBe(500);
		expect(streamAssetMock).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("404s a foreign-Project asset so ids stay non-enumerable (no bytes served)", async () => {
		// The row exists and is ready, but the caller isn't a member of its
		// Project (`userInProject` → false); the route collapses that to the same
		// 404 as a missing row, never touching storage — the byte-serving twin of
		// the DELETE enumeration-hardening test below.
		loadAssetByIdMock.mockResolvedValue(docAsset());
		userInProjectMock.mockResolvedValue(false);

		const res = await GET(getReq(), ctx());
		expect(res.status).toBe(404);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(getStoredObjectSizeMock).not.toHaveBeenCalled();
		expect(streamAssetMock).not.toHaveBeenCalled();
		await drainBody(res);
	});
});

describe("DELETE media asset", () => {
	it("purges and returns 204 when no app references it", async () => {
		loadAssetByIdMock.mockResolvedValue(docAsset());

		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(204);
		expect(deleteMediaAssetForActor).toHaveBeenCalledWith({
			assetId: "asset-1",
			actorUserId: "user-1",
			expectedProjectId: "project-1",
		});
		// alsoDelete carries the document's real extract-sibling key (computed
		// from the asset's content hash + the current extractor version).
		expect(purgeAssetStorage).toHaveBeenCalledWith(
			expect.objectContaining({ id: "asset-1" }),
			expect.objectContaining({
				alsoDeleteForAsset: expect.any(Function),
				deleteRow: expect.any(Function),
			}),
		);
		const purgeOptions = purgeAssetStorageMock.mock.calls[0]?.[1] as {
			alsoDeleteForAsset?: (asset: MediaAssetRecord) => Array<string | null>;
		};
		expect(purgeOptions.alsoDeleteForAsset?.(docAsset())[0]).toContain(
			".extract.v",
		);
	});

	it("refuses with 409 when the authoritative transaction finds a reference", async () => {
		loadAssetByIdMock.mockResolvedValue(docAsset());
		deleteMediaAssetForActorMock.mockResolvedValue({
			kind: "referenced",
			references: ['"My App" (app-1) on the app logo'],
		});

		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(409);
		expect(deleteMediaAssetForActor).toHaveBeenCalledOnce();
		await drainBody(res);
	});

	it("404s a missing asset", async () => {
		loadAssetByIdMock.mockResolvedValue(null);
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(404);
		expect(deleteMediaAssetForActor).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("404s a foreign-Project asset so ids stay non-enumerable", async () => {
		loadAssetByIdMock.mockResolvedValue(docAsset());
		userInProjectMock.mockResolvedValue(false);
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(404);
		expect(purgeAssetStorage).not.toHaveBeenCalled();
		await drainBody(res);
	});
});
