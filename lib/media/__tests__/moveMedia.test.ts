import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import { copyAssetsIntoProject, MediaCopyFailedError } from "../moveMedia";

const {
	createReadyAsset,
	findReadyAssetByProjectAndHash,
	installCopiedReadyExtract,
	loadAssetsByIds,
	copyAssetObject,
	withMediaObjectKeyLock,
} = vi.hoisted(() => ({
	createReadyAsset: vi.fn(),
	findReadyAssetByProjectAndHash: vi.fn(),
	installCopiedReadyExtract: vi.fn(() => Promise.resolve()),
	loadAssetsByIds: vi.fn(),
	copyAssetObject: vi.fn(() => Promise.resolve()),
	withMediaObjectKeyLock: vi.fn(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) =>
			body({ pinned: true }),
	),
}));

vi.mock("@/lib/db/mediaAssets", () => ({
	createReadyAsset,
	findReadyAssetByProjectAndHash,
	installCopiedReadyExtract,
	loadAssetsByIds,
}));
vi.mock("@/lib/storage/media", () => ({ copyAssetObject }));
vi.mock("@/lib/storage/mediaObjectKeyLock", () => ({
	withMediaObjectKeyLock,
}));

const FROM = "project-source";
const TO = "project-destination";

function asset(
	id: string,
	overrides: Partial<MediaAssetRecord> = {},
): MediaAssetRecord {
	return {
		id: asAssetId(id),
		owner: "owner-source",
		project_id: FROM,
		contentHash: id.padEnd(64, "a").slice(0, 64),
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 100,
		gcsObjectKey: `projects/${FROM}/${id}.png`,
		originalFilename: `${id}.png`,
		status: "ready",
		created_at: new Date(0),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	findReadyAssetByProjectAndHash.mockResolvedValue(null);
	let copy = 0;
	createReadyAsset.mockImplementation(async () => ({
		assetId: asAssetId(`destination-${++copy}`),
	}));
});

describe("copyAssetsIntoProject", () => {
	it("fails closed when a required blueprint asset is missing or unready", async () => {
		loadAssetsByIds.mockResolvedValue([]);

		await expect(
			copyAssetsIntoProject({
				requiredAssetIds: ["required-missing"],
				historicalAssetIds: ["historical-missing"],
				fromProjectId: FROM,
				toProjectId: TO,
				actorUserId: "actor-1",
			}),
		).rejects.toMatchObject({
			name: "MediaCopyFailedError",
			assetId: "required-missing",
		});
		expect(copyAssetObject).not.toHaveBeenCalled();
	});

	it("copies every ready kind, including a historical document and its ready extract", async () => {
		const image = asset("image-source");
		const document = asset("document-source", {
			contentHash: "d".repeat(64),
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${FROM}/${"d".repeat(64)}.pdf`,
			originalFilename: "requirements.pdf",
			extract: {
				status: "ready",
				version: 2,
				model: "extract-model",
				truncated: false,
				charCount: 42,
				extractedAt: 123,
				title: "Requirements",
			},
		});
		loadAssetsByIds.mockResolvedValue([image, document]);

		const result = await copyAssetsIntoProject({
			requiredAssetIds: [image.id],
			historicalAssetIds: [document.id, "old-missing"],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(result.get(image.id)).toBeDefined();
		expect(result.get(document.id)).toBeDefined();
		expect(result.has("old-missing")).toBe(false);
		expect(copyAssetObject).toHaveBeenCalledWith(
			document.gcsObjectKey,
			`projects/${TO}/${"d".repeat(64)}.pdf`,
		);
		expect(copyAssetObject).toHaveBeenCalledWith(
			`projects/${FROM}/${"d".repeat(64)}.extract.v2.md`,
			`projects/${TO}/${"d".repeat(64)}.extract.v2.md`,
		);
		expect(createReadyAsset).toHaveBeenCalledWith(
			expect.objectContaining({
				project_id: TO,
				kind: "pdf",
				extract: document.extract,
			}),
			expect.anything(),
		);
		expect(withMediaObjectKeyLock).toHaveBeenCalledWith(
			`projects/${TO}/${"d".repeat(64)}.pdf`,
			expect.any(Function),
		);
	});

	it("reuses a destination row and publishes a missing ready extract under the same key lock", async () => {
		const source = asset("document-source", {
			contentHash: "e".repeat(64),
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${FROM}/${"e".repeat(64)}.pdf`,
			extract: {
				status: "ready",
				version: 2,
				model: "extract-model",
				truncated: false,
				charCount: 10,
				extractedAt: 123,
			},
		});
		const existing = asset("existing-destination", {
			project_id: TO,
			contentHash: source.contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${TO}/${"e".repeat(64)}.pdf`,
			extract: undefined,
		});
		loadAssetsByIds.mockResolvedValue([source]);
		findReadyAssetByProjectAndHash.mockResolvedValue(existing);

		const result = await copyAssetsIntoProject({
			requiredAssetIds: [],
			historicalAssetIds: [source.id],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(result.get(source.id)).toBe(existing.id);
		expect(createReadyAsset).not.toHaveBeenCalled();
		expect(copyAssetObject).toHaveBeenCalledTimes(1);
		expect(copyAssetObject).toHaveBeenCalledWith(
			`projects/${FROM}/${"e".repeat(64)}.extract.v2.md`,
			`projects/${TO}/${"e".repeat(64)}.extract.v2.md`,
		);
		expect(installCopiedReadyExtract).toHaveBeenCalledWith(
			{
				assetId: existing.id,
				extract: source.extract,
			},
			expect.anything(),
		);
	});

	it("preserves an equal-version destination extract and its matching object", async () => {
		const source = asset("document-source", {
			contentHash: "f".repeat(64),
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			extract: {
				status: "ready",
				version: 2,
				model: "source-model",
				truncated: false,
				charCount: 20,
				extractedAt: 200,
				title: "Source title",
			},
		});
		const existing = asset("existing-destination", {
			project_id: TO,
			contentHash: source.contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			extract: {
				status: "ready",
				version: 2,
				model: "destination-model",
				truncated: false,
				charCount: 30,
				extractedAt: 300,
				title: "Destination title",
			},
		});
		loadAssetsByIds.mockResolvedValue([source]);
		findReadyAssetByProjectAndHash.mockResolvedValue(existing);

		const result = await copyAssetsIntoProject({
			requiredAssetIds: [source.id],
			historicalAssetIds: [],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(result.get(source.id)).toBe(existing.id);
		expect(copyAssetObject).not.toHaveBeenCalled();
		expect(installCopiedReadyExtract).not.toHaveBeenCalled();
		expect(createReadyAsset).not.toHaveBeenCalled();
	});

	it("does not block when a historical-only attachment is deleted during pre-copy", async () => {
		const historical = asset("historical-race");
		loadAssetsByIds
			.mockResolvedValueOnce([historical])
			.mockResolvedValueOnce([]);
		copyAssetObject.mockRejectedValue(new Error("source object vanished"));

		const result = await copyAssetsIntoProject({
			requiredAssetIds: [],
			historicalAssetIds: [historical.id],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(result.has(historical.id)).toBe(false);
		expect(loadAssetsByIds).toHaveBeenCalledTimes(2);
	});

	it("still fails when a historical asset row remains ready but its bytes cannot be copied", async () => {
		const historical = asset("historical-corrupt");
		loadAssetsByIds
			.mockResolvedValueOnce([historical])
			.mockResolvedValueOnce([historical]);
		copyAssetObject.mockRejectedValue(new Error("source object unavailable"));

		await expect(
			copyAssetsIntoProject({
				requiredAssetIds: [],
				historicalAssetIds: [historical.id],
				fromProjectId: FROM,
				toProjectId: TO,
				actorUserId: "actor-1",
			}),
		).rejects.toBeInstanceOf(MediaCopyFailedError);
	});

	it("exposes a typed error for callers that need an actionable move refusal", () => {
		expect(new MediaCopyFailedError("asset-1").assetId).toBe("asset-1");
	});
});
