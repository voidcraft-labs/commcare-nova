import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import { copyAssetsIntoProject, MediaCopyFailedError } from "../moveMedia";

const {
	createReadyAsset,
	findReadyAssetByProjectAndHash,
	findReadyExtractForProjectAndHash,
	getAssetsInTransaction,
	installCopiedReadyExtract,
	loadAssetsByIds,
	copyAssetObject,
	getStoredObjectSize,
	withMediaObjectKeyLocks,
	cleanupUnpublishedAssetObject,
	cleanupUnpublishedExtractObject,
} = vi.hoisted(() => ({
	createReadyAsset: vi.fn(),
	findReadyAssetByProjectAndHash: vi.fn(),
	findReadyExtractForProjectAndHash: vi.fn(),
	getAssetsInTransaction: vi.fn(),
	installCopiedReadyExtract: vi.fn(() => Promise.resolve()),
	loadAssetsByIds: vi.fn(),
	copyAssetObject: vi.fn((_sourceKey: string, _destinationKey: string) =>
		Promise.resolve(),
	),
	getStoredObjectSize: vi.fn<() => Promise<number | null>>(() =>
		Promise.resolve(100),
	),
	withMediaObjectKeyLocks: vi.fn(
		async (_keys: string[], body: (lockedDb: unknown) => Promise<unknown>) =>
			body({
				transaction: () => ({
					execute: (callback: (tx: unknown) => Promise<unknown>) =>
						callback({ pinned: true }),
				}),
			}),
	),
	cleanupUnpublishedAssetObject: vi.fn(() => Promise.resolve()),
	cleanupUnpublishedExtractObject: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/mediaAssets", () => ({
	createReadyAsset,
	findReadyAssetByProjectAndHash,
	findReadyExtractForProjectAndHash,
	getAssetsInTransaction,
	installCopiedReadyExtract,
	loadAssetsByIds,
}));
vi.mock("@/lib/storage/media", () => ({
	copyAssetObject,
	getStoredObjectSize,
}));
vi.mock("@/lib/storage/mediaObjectKeyLock", () => ({
	withMediaObjectKeyLocks,
}));
vi.mock("../assetDeletion", () => ({
	cleanupUnpublishedAssetObject,
	cleanupUnpublishedExtractObject,
}));

const FROM = "project-source";
const TO = "project-destination";
let freshSourceRows = new Map<string, MediaAssetRecord>();

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

function arrangeLoadedAssets(rows: MediaAssetRecord[]): void {
	freshSourceRows = new Map(rows.map((row) => [row.id, row]));
	loadAssetsByIds.mockResolvedValue(rows);
}

function fakeLockedDb() {
	return {
		transaction: () => ({
			execute: (callback: (tx: unknown) => Promise<unknown>) =>
				callback({ pinned: true }),
		}),
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function installContentLockMutex(): void {
	let tail = Promise.resolve();
	withMediaObjectKeyLocks.mockImplementation(
		async (_keys: string[], body: (lockedDb: unknown) => Promise<unknown>) => {
			const prior = tail;
			let release!: () => void;
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await prior;
			try {
				return await body(fakeLockedDb());
			} finally {
				release();
			}
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	freshSourceRows = new Map();
	withMediaObjectKeyLocks.mockImplementation(
		async (_keys: string[], body: (lockedDb: unknown) => Promise<unknown>) =>
			body(fakeLockedDb()),
	);
	findReadyAssetByProjectAndHash.mockResolvedValue(null);
	findReadyExtractForProjectAndHash.mockResolvedValue(null);
	getStoredObjectSize.mockResolvedValue(100);
	copyAssetObject.mockResolvedValue(undefined);
	installCopiedReadyExtract.mockResolvedValue(undefined);
	cleanupUnpublishedAssetObject.mockResolvedValue(undefined);
	cleanupUnpublishedExtractObject.mockResolvedValue(undefined);
	getAssetsInTransaction.mockImplementation(async (_tx, ids: string[]) => {
		return new Map(
			ids.flatMap((id) => {
				const row = freshSourceRows.get(id);
				return row === undefined ? [] : [[id, row] as const];
			}),
		);
	});
	let copy = 0;
	createReadyAsset.mockImplementation(async () => ({
		assetId: asAssetId(`destination-${++copy}`),
	}));
});

describe("copyAssetsIntoProject", () => {
	it("fails closed when a required blueprint asset is missing or unready", async () => {
		arrangeLoadedAssets([]);

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
		arrangeLoadedAssets([image, document]);

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
		expect(withMediaObjectKeyLocks).toHaveBeenCalledWith(
			[document.gcsObjectKey, `projects/${TO}/${"d".repeat(64)}.pdf`],
			expect.any(Function),
		);
	});

	it("re-reads the source extract pair after acquiring source and destination locks", async () => {
		const contentHash = "9".repeat(64);
		const initial = asset("document-source", {
			contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${FROM}/${contentHash}.pdf`,
			extract: {
				status: "ready",
				version: 2,
				model: "stale-model",
				truncated: false,
				charCount: 10,
				extractedAt: 100,
				title: "Stale title",
			},
		});
		const fresh = asset("document-source", {
			...initial,
			extract: {
				status: "ready",
				version: 2,
				model: "fresh-model",
				truncated: true,
				charCount: 40,
				extractedAt: 200,
				title: "Fresh title",
			},
		});
		loadAssetsByIds.mockResolvedValue([initial]);
		freshSourceRows = new Map([[fresh.id, fresh]]);

		await copyAssetsIntoProject({
			requiredAssetIds: [initial.id],
			historicalAssetIds: [],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(withMediaObjectKeyLocks).toHaveBeenCalledWith(
			[initial.gcsObjectKey, `projects/${TO}/${contentHash}.pdf`],
			expect.any(Function),
		);
		expect(getAssetsInTransaction).toHaveBeenCalledWith(expect.anything(), [
			initial.id,
		]);
		expect(getStoredObjectSize).toHaveBeenCalledWith(
			`projects/${FROM}/${contentHash}.extract.v2.md`,
		);
		expect(createReadyAsset).toHaveBeenCalledWith(
			expect.objectContaining({ extract: fresh.extract }),
			expect.anything(),
		);
		expect(createReadyAsset).not.toHaveBeenCalledWith(
			expect.objectContaining({ extract: initial.extract }),
			expect.anything(),
		);
		expect(withMediaObjectKeyLocks.mock.invocationCallOrder[0]).toBeLessThan(
			getAssetsInTransaction.mock.invocationCallOrder[0] ?? Number.MAX_VALUE,
		);
	});

	it("waits for a source publication winner, then copies its exact refreshed pair", async () => {
		installContentLockMutex();
		const contentHash = "6".repeat(64);
		const initial = asset("document-source", {
			contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${FROM}/${contentHash}.pdf`,
			extract: {
				status: "ready",
				version: 2,
				model: "initial-model",
				truncated: false,
				charCount: 10,
				extractedAt: 100,
			},
		});
		const refreshed = asset("document-source", {
			...initial,
			extract: {
				status: "ready",
				version: 2,
				model: "publication-winner",
				truncated: true,
				charCount: 40,
				extractedAt: 200,
			},
		});
		arrangeLoadedAssets([initial]);
		const publisherEntered = deferred();
		const releasePublisher = deferred();
		const sourcePublication = withMediaObjectKeyLocks(
			[initial.gcsObjectKey],
			async () => {
				freshSourceRows = new Map([[refreshed.id, refreshed]]);
				publisherEntered.resolve();
				await releasePublisher.promise;
			},
		);
		await publisherEntered.promise;

		const move = copyAssetsIntoProject({
			requiredAssetIds: [initial.id],
			historicalAssetIds: [],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});
		await Promise.resolve();
		expect(getAssetsInTransaction).not.toHaveBeenCalled();

		releasePublisher.resolve();
		await Promise.all([sourcePublication, move]);

		expect(createReadyAsset).toHaveBeenCalledWith(
			expect.objectContaining({ extract: refreshed.extract }),
			expect.anything(),
		);
	});

	it("holds the source pair stable until a waiting publication can replace it", async () => {
		installContentLockMutex();
		const contentHash = "5".repeat(64);
		const initial = asset("document-source", {
			contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${FROM}/${contentHash}.pdf`,
			extract: {
				status: "ready",
				version: 2,
				model: "move-winner",
				truncated: false,
				charCount: 10,
				extractedAt: 100,
			},
		});
		const refreshed = asset("document-source", {
			...initial,
			extract: {
				status: "ready",
				version: 2,
				model: "later-publication",
				truncated: true,
				charCount: 40,
				extractedAt: 200,
			},
		});
		arrangeLoadedAssets([initial]);
		const baseCopyStarted = deferred();
		const releaseBaseCopy = deferred();
		copyAssetObject.mockImplementation(async (sourceKey: string) => {
			if (sourceKey === initial.gcsObjectKey) {
				baseCopyStarted.resolve();
				await releaseBaseCopy.promise;
			}
		});

		const move = copyAssetsIntoProject({
			requiredAssetIds: [initial.id],
			historicalAssetIds: [],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});
		await baseCopyStarted.promise;
		let sourcePublisherRan = false;
		const sourcePublication = withMediaObjectKeyLocks(
			[initial.gcsObjectKey],
			async () => {
				sourcePublisherRan = true;
				freshSourceRows = new Map([[refreshed.id, refreshed]]);
			},
		);
		await Promise.resolve();
		expect(sourcePublisherRan).toBe(false);

		releaseBaseCopy.resolve();
		await Promise.all([move, sourcePublication]);

		expect(createReadyAsset).toHaveBeenCalledWith(
			expect.objectContaining({ extract: initial.extract }),
			expect.anything(),
		);
		expect(sourcePublisherRan).toBe(true);
	});

	it("cleans copied base and extract objects when destination metadata insertion fails", async () => {
		const contentHash = "8".repeat(64);
		const source = asset("document-source", {
			contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${FROM}/${contentHash}.pdf`,
			extract: {
				status: "ready",
				version: 2,
				model: "extract-model",
				truncated: false,
				charCount: 10,
				extractedAt: 100,
			},
		});
		arrangeLoadedAssets([source]);
		createReadyAsset.mockRejectedValue(new Error("insert failed"));

		await expect(
			copyAssetsIntoProject({
				requiredAssetIds: [source.id],
				historicalAssetIds: [],
				fromProjectId: FROM,
				toProjectId: TO,
				actorUserId: "actor-1",
			}),
		).rejects.toBeInstanceOf(MediaCopyFailedError);

		expect(cleanupUnpublishedAssetObject).toHaveBeenCalledTimes(3);
		expect(cleanupUnpublishedAssetObject).toHaveBeenCalledWith(
			`projects/${TO}/${contentHash}.pdf`,
		);
		expect(cleanupUnpublishedExtractObject).toHaveBeenCalledTimes(3);
		expect(cleanupUnpublishedExtractObject).toHaveBeenCalledWith({
			gcsObjectKey: `projects/${TO}/${contentHash}.extract.v2.md`,
			projectId: TO,
			contentHash,
			version: 2,
		});
	});

	it("cleans a copied repair extract when destination metadata installation fails", async () => {
		const contentHash = "7".repeat(64);
		const source = asset("document-source", {
			contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${FROM}/${contentHash}.pdf`,
			extract: {
				status: "ready",
				version: 2,
				model: "extract-model",
				truncated: false,
				charCount: 10,
				extractedAt: 100,
			},
		});
		const existing = asset("existing-destination", {
			project_id: TO,
			contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			gcsObjectKey: `projects/${TO}/${contentHash}.pdf`,
			extract: undefined,
		});
		arrangeLoadedAssets([source]);
		findReadyAssetByProjectAndHash.mockResolvedValue(existing);
		installCopiedReadyExtract.mockRejectedValue(new Error("install failed"));

		await expect(
			copyAssetsIntoProject({
				requiredAssetIds: [source.id],
				historicalAssetIds: [],
				fromProjectId: FROM,
				toProjectId: TO,
				actorUserId: "actor-1",
			}),
		).rejects.toBeInstanceOf(MediaCopyFailedError);

		expect(cleanupUnpublishedAssetObject).not.toHaveBeenCalled();
		expect(cleanupUnpublishedExtractObject).toHaveBeenCalledTimes(3);
		expect(cleanupUnpublishedExtractObject).toHaveBeenCalledWith({
			gcsObjectKey: `projects/${TO}/${contentHash}.extract.v2.md`,
			projectId: TO,
			contentHash,
			version: 2,
		});
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
		arrangeLoadedAssets([source]);
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

	it("adopts a ready duplicate-row extract instead of overwriting the shared object", async () => {
		const source = asset("document-source", {
			contentHash: "3".repeat(64),
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			extract: {
				status: "ready",
				version: 2,
				model: "source-model",
				truncated: false,
				charCount: 10,
				extractedAt: 123,
			},
		});
		const selectedDestination = asset("selected-destination", {
			project_id: TO,
			contentHash: source.contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			extract: {
				status: "failed",
				version: 2,
				model: "failed-model",
				truncated: false,
				charCount: 0,
				extractedAt: 200,
			},
		});
		const sharedReady = {
			status: "ready" as const,
			version: 2,
			model: "destination-winner",
			truncated: true,
			charCount: 30,
			extractedAt: 300,
			title: "Destination winner",
		};
		arrangeLoadedAssets([source]);
		findReadyAssetByProjectAndHash.mockResolvedValue(selectedDestination);
		findReadyExtractForProjectAndHash.mockResolvedValue(sharedReady);

		const result = await copyAssetsIntoProject({
			requiredAssetIds: [source.id],
			historicalAssetIds: [],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(result.get(source.id)).toBe(selectedDestination.id);
		expect(copyAssetObject).not.toHaveBeenCalled();
		expect(installCopiedReadyExtract).toHaveBeenCalledWith(
			{
				assetId: selectedDestination.id,
				extract: sharedReady,
			},
			expect.anything(),
		);
	});

	it("repairs missing shared extract bytes from the source and canonicalizes metadata", async () => {
		const source = asset("document-source", {
			contentHash: "4".repeat(64),
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			extract: {
				status: "ready",
				version: 2,
				model: "source-model",
				truncated: false,
				charCount: 10,
				extractedAt: 123,
			},
		});
		const selectedDestination = asset("selected-destination", {
			project_id: TO,
			contentHash: source.contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			extract: undefined,
		});
		const brokenSharedMetadata = {
			status: "ready" as const,
			version: 2,
			model: "missing-object-model",
			truncated: true,
			charCount: 30,
			extractedAt: 300,
		};
		arrangeLoadedAssets([source]);
		findReadyAssetByProjectAndHash.mockResolvedValue(selectedDestination);
		findReadyExtractForProjectAndHash.mockResolvedValue(brokenSharedMetadata);
		getStoredObjectSize.mockResolvedValueOnce(100).mockResolvedValueOnce(null);

		await copyAssetsIntoProject({
			requiredAssetIds: [source.id],
			historicalAssetIds: [],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(copyAssetObject).toHaveBeenCalledWith(
			`projects/${FROM}/${"4".repeat(64)}.extract.v2.md`,
			`projects/${TO}/${"4".repeat(64)}.extract.v2.md`,
		);
		expect(installCopiedReadyExtract).toHaveBeenCalledWith(
			{
				assetId: selectedDestination.id,
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
		arrangeLoadedAssets([source]);
		findReadyAssetByProjectAndHash.mockResolvedValue(existing);
		findReadyExtractForProjectAndHash.mockResolvedValue(existing.extract);

		const result = await copyAssetsIntoProject({
			requiredAssetIds: [source.id],
			historicalAssetIds: [],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(result.get(source.id)).toBe(existing.id);
		expect(copyAssetObject).not.toHaveBeenCalled();
		expect(installCopiedReadyExtract).toHaveBeenCalledWith(
			{
				assetId: existing.id,
				extract: existing.extract,
			},
			expect.anything(),
		);
		expect(createReadyAsset).not.toHaveBeenCalled();
	});

	it("preserves a newer in-flight destination extract instead of copying an older ready version", async () => {
		const source = asset("document-source", {
			contentHash: "1".repeat(64),
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
			},
		});
		const existing = asset("existing-destination", {
			project_id: TO,
			contentHash: source.contentHash,
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			extract: {
				status: "extracting",
				version: 3,
				model: "destination-model",
				truncated: false,
				charCount: 0,
				extractedAt: 300,
			},
		});
		arrangeLoadedAssets([source]);
		findReadyAssetByProjectAndHash.mockResolvedValue(existing);
		findReadyExtractForProjectAndHash.mockResolvedValue(existing.extract);

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
	});

	it("does not strand a copied destination with an in-flight source claim", async () => {
		const source = asset("document-source", {
			contentHash: "2".repeat(64),
			mimeType: "application/pdf",
			kind: "pdf",
			extension: ".pdf",
			extract: {
				status: "extracting",
				version: 2,
				model: "source-model",
				truncated: false,
				charCount: 0,
				extractedAt: 200,
			},
		});
		arrangeLoadedAssets([source]);

		await copyAssetsIntoProject({
			requiredAssetIds: [source.id],
			historicalAssetIds: [],
			fromProjectId: FROM,
			toProjectId: TO,
			actorUserId: "actor-1",
		});

		expect(copyAssetObject).toHaveBeenCalledTimes(1);
		expect(createReadyAsset).toHaveBeenCalledWith(
			expect.objectContaining({ extract: undefined }),
			expect.anything(),
		);
	});

	it("does not block when a historical-only attachment is deleted during pre-copy", async () => {
		const historical = asset("historical-race");
		freshSourceRows = new Map([[historical.id, historical]]);
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
		freshSourceRows = new Map([[historical.id, historical]]);
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
