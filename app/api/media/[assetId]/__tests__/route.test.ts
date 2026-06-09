/**
 * `DELETE /api/media/[assetId]` route tests.
 *
 * The route is a thin wrapper: owner-gate → reference scan → purge. These pin
 * the wrapper's mapping — 204 on a clean delete (purge called with the asset +
 * its extract-sibling key), 409 when an app still references it (purge NOT
 * called), 404 on missing/foreign — with the shared deletion logic + storage +
 * auth mocked at the boundary.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { MediaAssetOwnershipError } from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import {
	findAppReferencesToAsset,
	purgeAssetStorage,
} from "@/lib/media/assetDeletion";
import { DELETE } from "../route";

const {
	requireSessionMock,
	loadAssetForOwnerMock,
	findAppReferencesToAssetMock,
	purgeAssetStorageMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	loadAssetForOwnerMock: vi.fn(),
	findAppReferencesToAssetMock: vi.fn(() => Promise.resolve([] as string[])),
	purgeAssetStorageMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetForOwner: loadAssetForOwnerMock,
	MediaAssetOwnershipError: class extends Error {},
}));
vi.mock("@/lib/media/assetDeletion", () => ({
	findAppReferencesToAsset: findAppReferencesToAssetMock,
	purgeAssetStorage: purgeAssetStorageMock,
}));
// `extractObjectKeyForAsset` comes from the real (pure, mammoth-free)
// `@/lib/domain/multimedia`, so the route computes the actual extract-sibling
// key — no need to mock it. The route imports `streamAsset` for its GET handler;
// stub it so the real GCS storage module never loads (these tests only exercise
// DELETE).
vi.mock("@/lib/storage/media", () => ({ streamAsset: vi.fn() }));

/** A ready document asset row, overridable per test. `referencingAppIds` is the
 *  reverse index the route must thread to the guard as its candidate set. */
function docAsset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: "asset-1",
		owner: "user-1",
		gcsObjectKey: "users/user-1/asset-1.pdf",
		originalFilename: "spec.pdf",
		contentHash: "abc",
		mimeType: "application/pdf",
		kind: "pdf",
		extension: ".pdf",
		sizeBytes: 100,
		status: "ready",
		referencingAppIds: ["app-x"],
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
	findAppReferencesToAssetMock.mockResolvedValue([]);
	purgeAssetStorageMock.mockResolvedValue(undefined);
});

describe("DELETE media asset", () => {
	it("purges and returns 204 when no app references it", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());

		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(204);
		// The route must thread the asset's reverse index as the guard's candidate
		// set — that's the whole index optimization on the browser side. A regression
		// that dropped this 3rd arg (back to the ~8s owner-wide scan) is caught here.
		expect(findAppReferencesToAsset).toHaveBeenCalledWith("user-1", "asset-1", [
			"app-x",
		]);
		// alsoDelete carries the document's real extract-sibling key (computed
		// from the asset's content hash + the current extractor version).
		expect(purgeAssetStorage).toHaveBeenCalledWith(
			expect.objectContaining({ id: "asset-1" }),
			{ alsoDelete: [expect.stringContaining(".extract.v")] },
		);
	});

	it("refuses with 409 when an app still references it (no purge)", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		findAppReferencesToAssetMock.mockResolvedValue([
			'"My App" (app-1) on the app logo',
		]);

		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(409);
		expect(purgeAssetStorage).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("404s a missing asset", async () => {
		loadAssetForOwnerMock.mockResolvedValue(null);
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(404);
		expect(findAppReferencesToAsset).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("404s a foreign-owned asset so ids stay non-enumerable", async () => {
		loadAssetForOwnerMock.mockRejectedValue(
			new MediaAssetOwnershipError(asAssetId("asset-1"), "user-2", "user-1"),
		);
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(404);
		expect(purgeAssetStorage).not.toHaveBeenCalled();
		await drainBody(res);
	});
});
