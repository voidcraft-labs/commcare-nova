// lib/agent/__tests__/documentExtractionStore.test.ts
//
// Tests for the single-flight extract STORE — the one entry point both the
// eager route and the chat backstop go through.
//
//   - `decideExtractAction` is the PURE policy (status + time → wait vs claim);
//     tested as in/out, no I/O, no timers.
//   - `ensureStoredExtract` is the orchestration: GCS-first fast path, then the
//     status-driven branch (reuse / report-in-flight / claim+extract). Driven
//     against mocked storage/db + a mocked extraction core so no GCS, Postgres,
//     or model call happens. This is where the single-flight LIFECYCLE coverage
//     lives (it used to sit on the route, before the two paths were unified).
//
// Poll delay is mocked at the boundary, so winner-order wait regressions exercise
// the real status loop without leaving a timer for the async-leak gate.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentCondenser } from "@/lib/agent/documentExtraction";
import {
	decideExtractAction,
	EXTRACTING_STALE_MS,
	ensureStoredExtract,
} from "@/lib/agent/documentExtractionStore";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	claimExtractionIfIdle,
	publishClaimedAssetExtract,
} from "@/lib/db/mediaAssets";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { deleteAsset, writeTextObject } from "@/lib/storage/media";
import { withMediaObjectKeyLock } from "@/lib/storage/mediaObjectKeyLock";

const {
	loadAssetByIdMock,
	publishClaimedAssetExtractMock,
	findReadyExtractForProjectAndHashMock,
	hasReadyExtractForProjectAndHashMock,
	installCopiedReadyExtractMock,
	claimExtractionIfIdleMock,
	delayMock,
	extractDocumentMock,
	deleteAssetMock,
	downloadAssetBytesMock,
	readTextObjectMock,
	writeTextObjectMock,
	withMediaObjectKeyLockMock,
} = vi.hoisted(() => ({
	loadAssetByIdMock: vi.fn(),
	publishClaimedAssetExtractMock: vi.fn(),
	findReadyExtractForProjectAndHashMock: vi.fn(),
	hasReadyExtractForProjectAndHashMock: vi.fn(),
	installCopiedReadyExtractMock: vi.fn(),
	claimExtractionIfIdleMock: vi.fn(),
	delayMock: vi.fn(),
	extractDocumentMock: vi.fn(),
	deleteAssetMock: vi.fn(),
	downloadAssetBytesMock: vi.fn(),
	readTextObjectMock: vi.fn(),
	writeTextObjectMock: vi.fn(),
	withMediaObjectKeyLockMock: vi.fn(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) =>
			body({ pinned: true }),
	),
}));

vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetById: loadAssetByIdMock,
	publishClaimedAssetExtract: publishClaimedAssetExtractMock,
	findReadyExtractForProjectAndHash: findReadyExtractForProjectAndHashMock,
	hasReadyExtractForProjectAndHash: hasReadyExtractForProjectAndHashMock,
	installCopiedReadyExtract: installCopiedReadyExtractMock,
	claimExtractionIfIdle: claimExtractionIfIdleMock,
}));
vi.mock("@/lib/storage/media", () => ({
	deleteAsset: deleteAssetMock,
	downloadAssetBytes: downloadAssetBytesMock,
	readTextObject: readTextObjectMock,
	writeTextObject: writeTextObjectMock,
}));
vi.mock("@/lib/storage/mediaObjectKeyLock", () => ({
	withMediaObjectKeyLock: withMediaObjectKeyLockMock,
}));
vi.mock("@/lib/utils/delay", () => ({
	delay: delayMock,
}));
// Mock the extraction core wholesale: keeps the real module (mammoth + the
// Google provider) from loading, and lets us assert claim-vs-reuse without a
// model call. The store reads these constants and calls `extractDocument`.
vi.mock("@/lib/agent/documentExtraction", () => ({
	extractDocument: extractDocumentMock,
	CONDENSER_MODEL: "gpt-5.6-luna",
	EXTRACT_MAX_BYTES: 4 * 1024 * 1024,
}));

/** Build a ready document asset record, overridable per test. */
function docAsset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: "asset-1",
		owner: "user-1",
		project_id: "project-1",
		contentHash: "a".repeat(64),
		mimeType: "application/pdf",
		extension: ".pdf",
		sizeBytes: 1234,
		kind: "pdf",
		gcsObjectKey: "projects/project-1/aaaa.pdf",
		originalFilename: "form.pdf",
		status: "ready",
		// biome-ignore lint/suspicious/noExplicitAny: Timestamp irrelevant to these tests
		created_at: {} as any,
		...over,
	} as MediaAssetRecord;
}

/** An `extract` subobject at a given status/age, shaped like the stored
 *  record (`extractedAt` is epoch ms). */
function extractRecord(
	status: "extracting" | "ready" | "failed",
	{
		version = EXTRACTOR_VERSION,
		ageMs = 0,
	}: {
		version?: number;
		ageMs?: number;
	} = {},
): MediaAssetRecord["extract"] {
	return {
		status,
		version,
		model: "gpt-5.6-luna",
		truncated: false,
		charCount: 0,
		extractedAt: Date.now() - ageMs,
	};
}

/** extractDocument is mocked, so the condenser is never actually invoked. */
const stubCondenser = {} as AttachmentCondenser;

beforeEach(() => {
	vi.clearAllMocks();
	publishClaimedAssetExtractMock.mockImplementation(
		async (args: {
			extract: Record<string, unknown>;
			publishReadyObject?: () => Promise<void>;
		}) => {
			await args.publishReadyObject?.();
			return {
				kind: "published",
				extract: { ...args.extract, extractedAt: 456 },
			};
		},
	);
	hasReadyExtractForProjectAndHashMock.mockResolvedValue(false);
	findReadyExtractForProjectAndHashMock.mockResolvedValue(null);
	installCopiedReadyExtractMock.mockImplementation(
		async (args: { extract: MediaAssetRecord["extract"] }) => args.extract,
	);
	// Default: the atomic claim succeeds (no live job holds the field), so the
	// store proceeds to run the model. Tests that exercise a lost race override
	// this to report `in_flight`.
	claimExtractionIfIdleMock.mockResolvedValue({
		kind: "claimed",
		claim: {
			version: EXTRACTOR_VERSION,
			model: "gpt-5.6-luna",
			extractedAt: 123,
		},
	});
	deleteAssetMock.mockResolvedValue(undefined);
	delayMock.mockResolvedValue(undefined);
	downloadAssetBytesMock.mockResolvedValue(Buffer.from("bytes"));
	writeTextObjectMock.mockResolvedValue(undefined);
	extractDocumentMock.mockResolvedValue({
		extract: "FRESH EXTRACT",
		truncated: false,
	});
});

describe("decideExtractAction (single-flight policy)", () => {
	const NOW = 1_700_000_000_000;

	it("claims when there is no extract record", () => {
		expect(decideExtractAction(null, NOW)).toBe("extract-now");
	});

	it("waits on a current, fresh extracting job", () => {
		expect(
			decideExtractAction(
				{
					status: "extracting",
					version: EXTRACTOR_VERSION,
					extractedAtMs: NOW - 1_000,
				},
				NOW,
			),
		).toBe("await-inflight");
	});

	it("claims at/past the staleness ceiling (the job's process died)", () => {
		expect(
			decideExtractAction(
				{
					status: "extracting",
					version: EXTRACTOR_VERSION,
					extractedAtMs: NOW - EXTRACTING_STALE_MS,
				},
				NOW,
			),
		).toBe("extract-now");
	});

	it("claims on a stale-version extracting record (a prompt/model bump)", () => {
		expect(
			decideExtractAction(
				{
					status: "extracting",
					version: EXTRACTOR_VERSION - 1,
					extractedAtMs: NOW,
				},
				NOW,
			),
		).toBe("extract-now");
	});

	it("claims when the last run is ready (object missed) or failed", () => {
		expect(
			decideExtractAction(
				{ status: "ready", version: EXTRACTOR_VERSION, extractedAtMs: NOW },
				NOW,
			),
		).toBe("extract-now");
		expect(
			decideExtractAction(
				{ status: "failed", version: EXTRACTOR_VERSION, extractedAtMs: NOW },
				NOW,
			),
		).toBe("extract-now");
	});
});

describe("ensureStoredExtract (orchestration)", () => {
	it("reuses the stored GCS extract without a status read or a model call", async () => {
		readTextObjectMock.mockResolvedValue("STORED");
		const result = await ensureStoredExtract({
			asset: docAsset({ extract: extractRecord("ready") }),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "wait",
		});
		expect(result).toEqual({
			status: "ready",
			text: "STORED",
			version: EXTRACTOR_VERSION,
			truncated: false,
			charCount: 6,
		});
		expect(loadAssetByIdMock).not.toHaveBeenCalled();
		expect(extractDocumentMock).not.toHaveBeenCalled();
		expect(writeTextObject).not.toHaveBeenCalled();
	});

	it("does not trust an extract object without matching ready metadata", async () => {
		readTextObjectMock.mockResolvedValue("UNPUBLISHED ORPHAN");
		loadAssetByIdMock.mockResolvedValue(
			docAsset({ extract: extractRecord("failed") }),
		);

		const result = await ensureStoredExtract({
			asset: docAsset({ extract: extractRecord("failed") }),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({
			status: "ready",
			text: "FRESH EXTRACT",
			version: EXTRACTOR_VERSION,
			truncated: false,
			charCount: "FRESH EXTRACT".length,
		});
		expect(extractDocumentMock).toHaveBeenCalledOnce();
		expect(writeTextObject).toHaveBeenCalledOnce();
	});

	it("adopts a committed ready sibling instead of overwriting its shared object", async () => {
		const siblingExtract = {
			status: "ready" as const,
			version: EXTRACTOR_VERSION,
			model: "sibling-model",
			truncated: false,
			charCount: 17,
			extractedAt: 456,
			title: "Sibling title",
		};
		readTextObjectMock.mockResolvedValue("SIBLING EXTRACT");
		loadAssetByIdMock.mockResolvedValue(docAsset());
		findReadyExtractForProjectAndHashMock.mockResolvedValue(siblingExtract);

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({
			status: "ready",
			text: "SIBLING EXTRACT",
			version: EXTRACTOR_VERSION,
			truncated: false,
			charCount: "SIBLING EXTRACT".length,
		});
		expect(installCopiedReadyExtractMock).toHaveBeenCalledWith(
			{ assetId: "asset-1", extract: siblingExtract },
			expect.anything(),
		);
		expect(claimExtractionIfIdle).not.toHaveBeenCalled();
		expect(extractDocumentMock).not.toHaveBeenCalled();
		expect(writeTextObject).not.toHaveBeenCalled();
	});

	it("adopts the first committed sibling when this row finishes model work second", async () => {
		const siblingExtract = {
			status: "ready" as const,
			version: EXTRACTOR_VERSION,
			model: "winner-model",
			truncated: true,
			charCount: 14,
			extractedAt: 789,
			title: "Winner title",
		};
		readTextObjectMock
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("WINNER EXTRACT");
		loadAssetByIdMock.mockResolvedValue(docAsset());
		findReadyExtractForProjectAndHashMock.mockResolvedValue(siblingExtract);
		publishClaimedAssetExtractMock.mockImplementationOnce(async (args) => ({
			kind: "adopted",
			extract: args.sharedReadyExtract,
		}));

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({
			status: "ready",
			text: "WINNER EXTRACT",
			version: EXTRACTOR_VERSION,
			truncated: true,
			charCount: "WINNER EXTRACT".length,
		});
		expect(extractDocumentMock).toHaveBeenCalledOnce();
		expect(publishClaimedAssetExtract).toHaveBeenCalledWith(
			expect.objectContaining({ sharedReadyExtract: siblingExtract }),
			expect.anything(),
		);
		expect(writeTextObject).not.toHaveBeenCalled();
	});

	it("atomically claims, then persists ready when no extract exists", async () => {
		readTextObjectMock.mockResolvedValue(null); // GCS miss
		loadAssetByIdMock.mockResolvedValue(docAsset()); // no extract record

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({
			status: "ready",
			text: "FRESH EXTRACT",
			version: EXTRACTOR_VERSION,
			truncated: false,
			charCount: "FRESH EXTRACT".length,
		});
		// The `extracting` write is the atomic claim's job now — assert the store
		// took the lock through it rather than via a plain status write.
		expect(claimExtractionIfIdle).toHaveBeenCalledWith(
			"asset-1",
			expect.objectContaining({
				currentVersion: EXTRACTOR_VERSION,
				staleMs: EXTRACTING_STALE_MS,
			}),
		);
		// Terminal publication proves the exact claim under a row lock before it
		// writes the object and matching metadata.
		expect(publishClaimedAssetExtract).toHaveBeenCalledTimes(1);
		expect(publishClaimedAssetExtract).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: "asset-1",
				claim: expect.objectContaining({ extractedAt: 123 }),
				extract: expect.objectContaining({ status: "ready", charCount: 13 }),
				publishReadyObject: expect.any(Function),
			}),
			expect.anything(),
		);
		expect(writeTextObject).toHaveBeenCalledWith(
			expect.stringContaining(`.extract.v${EXTRACTOR_VERSION}.md`),
			"FRESH EXTRACT",
		);
		expect(withMediaObjectKeyLock).toHaveBeenCalledWith(
			"projects/project-1/aaaa.pdf",
			expect.any(Function),
		);
	});

	it("reports in-flight (no model call) when the atomic claim is lost", async () => {
		// The pre-claim status read saw no live job, but a concurrent caller won
		// the transaction in that window — the claim reports `in_flight`.
		// Under `onInflight: "report"` the store must defer to that winner: report
		// `extracting`, never run a second model call.
		readTextObjectMock.mockResolvedValue(null); // GCS miss
		loadAssetByIdMock.mockResolvedValue(docAsset()); // no live job at read time
		claimExtractionIfIdleMock.mockResolvedValue({ kind: "in_flight" });

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({ status: "extracting" });
		expect(extractDocumentMock).not.toHaveBeenCalled();
		expect(publishClaimedAssetExtract).not.toHaveBeenCalled();
		expect(writeTextObject).not.toHaveBeenCalled();
	});

	it("reuses a higher-version ready result instead of regressing it", async () => {
		readTextObjectMock
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("NEWER EXTRACT");
		loadAssetByIdMock.mockResolvedValue(docAsset());
		claimExtractionIfIdleMock.mockResolvedValue({
			kind: "superseded",
			extract: {
				status: "ready",
				version: EXTRACTOR_VERSION + 1,
				model: "newer-model",
				truncated: false,
				charCount: 13,
				extractedAt: 456,
			},
		});

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({
			status: "ready",
			text: "NEWER EXTRACT",
			version: EXTRACTOR_VERSION + 1,
			truncated: false,
			charCount: "NEWER EXTRACT".length,
		});
		expect(extractDocumentMock).not.toHaveBeenCalled();
		expect(publishClaimedAssetExtract).not.toHaveBeenCalled();
		expect(writeTextObject).not.toHaveBeenCalled();
	});

	it("waits on the newer key when terminal publication loses to a newer job", async () => {
		const newerVersion = EXTRACTOR_VERSION + 1;
		readTextObjectMock
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("NEWER WINNER");
		loadAssetByIdMock.mockResolvedValueOnce(docAsset()).mockResolvedValueOnce(
			docAsset({
				extract: {
					status: "ready",
					version: newerVersion,
					model: "newer-model",
					truncated: false,
					charCount: 12,
					extractedAt: 789,
				},
			}),
		);
		publishClaimedAssetExtractMock.mockResolvedValueOnce({
			kind: "superseded",
			extract: {
				status: "extracting",
				version: newerVersion,
				model: "newer-model",
				truncated: false,
				charCount: 0,
				extractedAt: Date.now(),
			},
		});

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "wait",
		});

		expect(result).toEqual({
			status: "ready",
			text: "NEWER WINNER",
			version: newerVersion,
			truncated: false,
			charCount: "NEWER WINNER".length,
		});
		expect(delayMock).toHaveBeenCalled();
		expect(readTextObjectMock).toHaveBeenLastCalledWith(
			expect.stringContaining(`.extract.v${newerVersion}.md`),
			expect.any(Number),
		);
		expect(writeTextObject).not.toHaveBeenCalled();
	});

	it("reports an in-flight job (no model call) under onInflight:'report'", async () => {
		readTextObjectMock.mockResolvedValue(null);
		loadAssetByIdMock.mockResolvedValue(
			docAsset({ extract: extractRecord("extracting", { ageMs: 0 }) }),
		);
		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});
		expect(result).toEqual({ status: "extracting" });
		expect(extractDocumentMock).not.toHaveBeenCalled();
		expect(publishClaimedAssetExtract).not.toHaveBeenCalled();
	});

	it("claims when an in-flight record is stale (a dead job)", async () => {
		readTextObjectMock.mockResolvedValue(null);
		loadAssetByIdMock.mockResolvedValue(
			docAsset({ extract: extractRecord("extracting", { ageMs: 400_000 }) }),
		);
		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});
		expect(result.status).toBe("ready");
		expect(extractDocumentMock).toHaveBeenCalledOnce();
	});

	it("re-extracts when status is ready but the GCS object is gone", async () => {
		readTextObjectMock.mockResolvedValue(null); // object missing despite ready
		loadAssetByIdMock.mockResolvedValue(
			docAsset({ extract: extractRecord("ready") }),
		);
		const result = await ensureStoredExtract({
			asset: docAsset({ extract: extractRecord("ready") }),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "wait",
		});
		expect(result.status).toBe("ready");
		expect(extractDocumentMock).toHaveBeenCalledOnce();
	});

	it("returns failed (recording the reason) when extraction throws", async () => {
		readTextObjectMock.mockResolvedValue(null);
		loadAssetByIdMock.mockResolvedValue(docAsset());
		extractDocumentMock.mockRejectedValue(new Error("model exploded"));

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({ status: "failed", reason: "model exploded" });
		expect(publishClaimedAssetExtract).toHaveBeenLastCalledWith(
			expect.objectContaining({
				assetId: "asset-1",
				extract: expect.objectContaining({
					status: "failed",
					failureReason: "model exploded",
				}),
			}),
			expect.anything(),
		);
	});

	it("never reports ready when deletion wins before terminal publication", async () => {
		readTextObjectMock.mockResolvedValue(null);
		loadAssetByIdMock.mockResolvedValue(docAsset());
		publishClaimedAssetExtractMock.mockResolvedValue({ kind: "not_found" });

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toMatchObject({ status: "failed" });
		expect(writeTextObject).not.toHaveBeenCalled();
		expect(deleteAsset).not.toHaveBeenCalled();
	});

	it("removes an extract object when ready metadata publication rejects", async () => {
		readTextObjectMock.mockResolvedValue(null);
		loadAssetByIdMock.mockResolvedValue(docAsset());
		publishClaimedAssetExtractMock
			.mockImplementationOnce(
				async (args: { publishReadyObject?: () => Promise<void> }) => {
					await args.publishReadyObject?.();
					throw new Error("ready metadata commit rejected");
				},
			)
			.mockResolvedValueOnce({
				kind: "published",
				extract: {
					status: "failed",
					version: EXTRACTOR_VERSION,
					model: "gpt-5.6-luna",
					truncated: false,
					charCount: 0,
					extractedAt: 789,
					failureReason: "ready metadata commit rejected",
				},
			});

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({
			status: "failed",
			reason: "ready metadata commit rejected",
		});
		expect(hasReadyExtractForProjectAndHashMock).toHaveBeenCalledWith(
			"project-1",
			"a".repeat(64),
			EXTRACTOR_VERSION,
			expect.anything(),
		);
		expect(deleteAsset).toHaveBeenCalledWith(
			expect.stringContaining(`.extract.v${EXTRACTOR_VERSION}.md`),
		);
	});

	it("retains a shared extract object when a committed ready sibling exists", async () => {
		readTextObjectMock
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("COMMITTED EXTRACT");
		loadAssetByIdMock.mockResolvedValue(docAsset());
		hasReadyExtractForProjectAndHashMock.mockResolvedValue(true);
		publishClaimedAssetExtractMock
			.mockImplementationOnce(
				async (args: { publishReadyObject?: () => Promise<void> }) => {
					await args.publishReadyObject?.();
					throw new Error("commit outcome uncertain");
				},
			)
			.mockResolvedValueOnce({
				kind: "superseded",
				extract: {
					status: "ready",
					version: EXTRACTOR_VERSION,
					model: "gpt-5.6-luna",
					truncated: false,
					charCount: 17,
					extractedAt: 789,
				},
			});

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({
			status: "ready",
			text: "COMMITTED EXTRACT",
			version: EXTRACTOR_VERSION,
			truncated: false,
			charCount: "COMMITTED EXTRACT".length,
		});
		expect(deleteAsset).not.toHaveBeenCalled();
	});
});
