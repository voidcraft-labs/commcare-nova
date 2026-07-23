/**
 * Behavioral tests for `remove_media_asset`.
 *
 * Coverage:
 *   1. Deletes the asset row and unshared GCS object when no live reference
 *      exists.
 *   2. Refuses (and deletes nothing) when the current doc still
 *      references the asset, naming the carrier.
 *   3. Refuses when another live app references the asset.
 *   4. Maps a missing/foreign-Project asset to a "not found" message.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListAppsResult } from "@/lib/db/apps";
import { RunHolderLostError } from "@/lib/db/commitGuard";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { removeMediaAssetTool } from "../removeMediaAsset";
import { makeMediaFixture, TEXT_FIELD } from "./fixtures";

// `vi.hoisted` lifts the mock fns above the hoisted `vi.mock` factories so
// the factories can close over them without a "cannot access before
// initialization" hoist error.
const {
	loadAssetById,
	listReferencingAppIds,
	deleteAssetRow,
	hasOtherAssetForGcsObjectKey,
	deleteGcsObject,
	listApps,
	loadApp,
	loadAppProjectId,
	deleteMediaAssetForChatRun,
	deleteMediaAssetForActor,
	withMediaObjectKeyLock,
} = vi.hoisted(() => ({
	loadAssetById: vi.fn(),
	listReferencingAppIds: vi.fn<() => Promise<string[]>>(() =>
		Promise.resolve([]),
	),
	deleteAssetRow: vi.fn(() => Promise.resolve()),
	hasOtherAssetForGcsObjectKey: vi.fn(() => Promise.resolve(false)),
	deleteGcsObject: vi.fn(() => Promise.resolve()),
	listApps: vi.fn<() => Promise<ListAppsResult>>(() =>
		Promise.resolve({ apps: [] }),
	),
	loadApp: vi.fn(),
	loadAppProjectId: vi.fn(() => Promise.resolve("project-1")),
	deleteMediaAssetForChatRun: vi.fn(() => Promise.resolve(true)),
	deleteMediaAssetForActor: vi.fn(),
	withMediaObjectKeyLock: vi.fn(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) =>
			body({ pinned: true }),
	),
}));

vi.mock("@/lib/db/mediaAssets", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/mediaAssets")>();
	return {
		...actual,
		loadAssetById,
		listReferencingAppIds,
		deleteAsset: deleteAssetRow,
		hasOtherAssetForGcsObjectKey,
	};
});
vi.mock("@/lib/db/apps", () => ({
	listApps,
	loadApp,
	loadAppProjectId,
	deleteMediaAssetForChatRun,
}));
vi.mock("@/lib/db/mediaDeletion", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/db/mediaDeletion")>()),
	deleteMediaAssetForActor,
}));
vi.mock("@/lib/storage/media", () => ({
	deleteAsset: deleteGcsObject,
}));
vi.mock("@/lib/storage/mediaObjectKeyLock", () => ({
	withMediaObjectKeyLock,
}));

beforeEach(() => {
	vi.clearAllMocks();
	hasOtherAssetForGcsObjectKey.mockResolvedValue(false);
	listApps.mockResolvedValue({ apps: [] });
	// The reverse index (`media_asset_refs`) is now a separate query, not a field
	// on the asset row — default to no other referencing app.
	listReferencingAppIds.mockResolvedValue([]);
	deleteMediaAssetForChatRun.mockResolvedValue(true);
	deleteMediaAssetForActor.mockImplementation(async ({ assetId }) => ({
		kind: "deleted",
		asset: ownedAsset(assetId),
	}));
});

/** Minimal owned asset row for the load mock. */
function ownedAsset(id: string): MediaAssetRecord {
	return {
		id,
		owner: "user-1",
		project_id: "project-1",
		gcsObjectKey: `projects/project-1/${id}.png`,
		originalFilename: `${id}.png`,
		contentHash: "abc",
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 100,
		status: "ready",
	} as unknown as MediaAssetRecord;
}

/** Attach an asset to the text field's label_media so the doc references it. */
function docReferencing(assetId: string, base: BlueprintDoc): BlueprintDoc {
	const field = base.fields[TEXT_FIELD];
	return {
		...base,
		fields: {
			...base.fields,
			[TEXT_FIELD]: { ...field, label_media: { image: assetId } } as never,
		},
	};
}

describe("removeMediaAsset", () => {
	it("deletes the GCS object and the row when unreferenced", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetById.mockResolvedValue(ownedAsset("free-asset"));

		const result = await removeMediaAssetTool.execute(
			{ assetId: "free-asset" },
			ctx,
			doc,
		);

		expect(result.kind).toBe("read");
		if ("error" in result.data) {
			throw new Error(`unexpected error: ${result.data.error}`);
		}
		expect(result.data.removed).toBe(true);
		expect(hasOtherAssetForGcsObjectKey).toHaveBeenCalledWith(
			"projects/project-1/free-asset.png",
			"free-asset",
			expect.anything(),
		);
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/free-asset.png",
		);
		expect(deleteMediaAssetForActor).toHaveBeenCalledWith({
			assetId: "free-asset",
			actorUserId: ctx.userId,
			expectedProjectId: "project-1",
		});
		expect(deleteAssetRow).not.toHaveBeenCalled();
	});

	it("deletes only the row when another asset shares the same GCS object", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetById.mockResolvedValue(ownedAsset("shared-asset"));
		hasOtherAssetForGcsObjectKey.mockResolvedValue(true);

		const result = await removeMediaAssetTool.execute(
			{ assetId: "shared-asset" },
			ctx,
			doc,
		);

		if ("error" in result.data) {
			throw new Error(`unexpected error: ${result.data.error}`);
		}
		expect(deleteMediaAssetForActor).toHaveBeenCalledWith({
			assetId: "shared-asset",
			actorUserId: ctx.userId,
			expectedProjectId: "project-1",
		});
		expect(deleteAssetRow).not.toHaveBeenCalled();
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("delegates the metadata delete to the exact chat-holder fence", async () => {
		const { doc, ctx } = makeMediaFixture();
		const chatRunHolder = {
			source: "chat" as const,
			mode: "edit" as const,
			runId: "thread-run",
			nonce: "00000000-0000-4000-8000-000000000001",
		};
		loadAssetById.mockResolvedValue(ownedAsset("chat-asset"));

		const result = await removeMediaAssetTool.execute(
			{ assetId: "chat-asset" },
			{ ...ctx, chatRunHolder },
			doc,
		);

		expect(result.data).toMatchObject({ removed: true });
		expect(deleteMediaAssetForChatRun).toHaveBeenCalledWith({
			appId: ctx.appId,
			assetId: "chat-asset",
			actorUserId: ctx.userId,
			expectedProjectId: "project-1",
			holder: chatRunHolder,
		});
		expect(deleteAssetRow).not.toHaveBeenCalled();
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/chat-asset.png",
		);
	});

	it("propagates authoritative chat-holder loss without touching GCS", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetById.mockResolvedValue(ownedAsset("lost-holder-asset"));
		deleteMediaAssetForChatRun.mockRejectedValueOnce(
			new RunHolderLostError("superseded"),
		);

		await expect(
			removeMediaAssetTool.execute(
				{ assetId: "lost-holder-asset" },
				{
					...ctx,
					chatRunHolder: {
						source: "chat",
						mode: "edit",
						runId: "thread-run",
						nonce: "00000000-0000-4000-8000-000000000001",
					},
				},
				doc,
			),
		).rejects.toBeInstanceOf(RunHolderLostError);
		expect(deleteGcsObject).not.toHaveBeenCalled();
		expect(deleteAssetRow).not.toHaveBeenCalled();
	});

	it("refuses and deletes nothing when the doc still references it", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		loadAssetById.mockResolvedValue(ownedAsset("used-asset"));
		const doc = docReferencing("used-asset", baseDoc);

		const result = await removeMediaAssetTool.execute(
			{ assetId: "used-asset" },
			ctx,
			doc,
		);

		if (!("error" in result.data)) {
			throw new Error("expected refusal");
		}
		expect(result.data.error).toContain("Can't delete");
		// Names the carrier — the text field's label.
		expect(result.data.error).toContain("patient_name");
		expect(deleteGcsObject).not.toHaveBeenCalled();
		expect(deleteAssetRow).not.toHaveBeenCalled();
	});

	it("refuses and deletes nothing when another live app references it", async () => {
		const { doc, ctx } = makeMediaFixture();
		// The reverse index names "other-app" as a candidate, so the guard loads
		// ONLY it (not the owner's whole list) and re-walks it to confirm.
		loadAssetById.mockResolvedValue(ownedAsset("used-elsewhere"));
		listReferencingAppIds.mockResolvedValue(["other-app"]);
		loadApp.mockResolvedValue({
			owner: "user-1",
			project_id: "project-1",
			app_name: "Other App",
			deleted_at: null,
			blueprint: docReferencing("used-elsewhere", doc),
		});

		const result = await removeMediaAssetTool.execute(
			{ assetId: "used-elsewhere" },
			ctx,
			doc,
		);

		if (!("error" in result.data)) {
			throw new Error("expected refusal");
		}
		expect(result.data.error).toContain("Other App");
		// Index path — never the owner-wide scan.
		expect(listApps).not.toHaveBeenCalled();
		expect(loadApp).toHaveBeenCalledWith("other-app");
		expect(deleteGcsObject).not.toHaveBeenCalled();
		expect(deleteAssetRow).not.toHaveBeenCalled();
	});

	it("refuses when the authoritative delete re-walk catches a late attach", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetById.mockResolvedValue(ownedAsset("raced-asset"));
		deleteMediaAssetForActor.mockResolvedValue({
			kind: "referenced",
			references: ['"Racing App" (app-2) on the app logo'],
		});

		const result = await removeMediaAssetTool.execute(
			{ assetId: "raced-asset" },
			ctx,
			doc,
		);

		expect(result.data).toMatchObject({
			error: expect.stringContaining("Racing App"),
		});
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("returns a not-found message for a missing asset", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetById.mockResolvedValue(null);

		const result = await removeMediaAssetTool.execute(
			{ assetId: "ghost" },
			ctx,
			doc,
		);
		if (!("error" in result.data)) {
			throw new Error("expected error");
		}
		expect(result.data.error).toContain("No media asset");
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("treats a foreign-Project asset as not found", async () => {
		const { doc, ctx } = makeMediaFixture();
		// A row in ANOTHER Project: the tool loads it id-only, then rejects it
		// because its `project_id` doesn't match the app's Project — the same
		// "not found" a missing row produces, so the two can't be told apart.
		loadAssetById.mockResolvedValue({
			...ownedAsset("other"),
			project_id: "project-2",
		});

		const result = await removeMediaAssetTool.execute(
			{ assetId: "other" },
			ctx,
			doc,
		);
		if (!("error" in result.data)) {
			throw new Error("expected error");
		}
		expect(result.data.error).toContain("No media asset");
	});
});
