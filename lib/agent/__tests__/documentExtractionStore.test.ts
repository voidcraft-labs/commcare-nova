// lib/agent/__tests__/documentExtractionStore.test.ts
//
// Tests for the single-flight extract STORE — the one entry point both the
// eager route and the chat backstop go through.
//
//   - `decideExtractAction` is the PURE policy (status + time → wait vs claim);
//     tested as in/out, no I/O, no timers.
//   - `ensureStoredExtract` is the orchestration: GCS-first fast path, then the
//     status-driven branch (reuse / report-in-flight / claim+extract). Driven
//     against mocked storage/db + a mocked extraction core so no GCS, Firestore,
//     or model call happens. This is where the single-flight LIFECYCLE coverage
//     lives (it used to sit on the route, before the two paths were unified).
//
// The `onInflight: "wait"` poll loop is deliberately NOT unit-tested: it needs
// real timers, which the async-leak gate (rightly) forbids in tests. The DECISION
// of when to wait is covered by `decideExtractAction`; the wait itself is plain
// I/O polling.

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
	setAssetExtractStatus,
} from "@/lib/db/mediaAssets";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { writeTextObject } from "@/lib/storage/media";

const {
	loadAssetByIdMock,
	setAssetExtractStatusMock,
	claimExtractionIfIdleMock,
	extractDocumentMock,
	downloadAssetBytesMock,
	readTextObjectMock,
	writeTextObjectMock,
} = vi.hoisted(() => ({
	loadAssetByIdMock: vi.fn(),
	setAssetExtractStatusMock: vi.fn(),
	claimExtractionIfIdleMock: vi.fn(),
	extractDocumentMock: vi.fn(),
	downloadAssetBytesMock: vi.fn(),
	readTextObjectMock: vi.fn(),
	writeTextObjectMock: vi.fn(),
}));

vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetById: loadAssetByIdMock,
	setAssetExtractStatus: setAssetExtractStatusMock,
	claimExtractionIfIdle: claimExtractionIfIdleMock,
}));
vi.mock("@/lib/storage/media", () => ({
	downloadAssetBytes: downloadAssetBytesMock,
	readTextObject: readTextObjectMock,
	writeTextObject: writeTextObjectMock,
}));
// Mock the extraction core wholesale: keeps the real module (mammoth + the
// Google provider) from loading, and lets us assert claim-vs-reuse without a
// model call. The store reads these constants and calls `extractDocument`.
vi.mock("@/lib/agent/documentExtraction", () => ({
	extractDocument: extractDocumentMock,
	CONDENSER_MODEL: "gemini-3.5-flash",
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
		model: "gemini-3.5-flash",
		truncated: false,
		charCount: 0,
		extractedAt: Date.now() - ageMs,
	};
}

/** extractDocument is mocked, so the condenser is never actually invoked. */
const stubCondenser = {} as AttachmentCondenser;

beforeEach(() => {
	vi.clearAllMocks();
	setAssetExtractStatusMock.mockResolvedValue(undefined);
	// Default: the atomic claim succeeds (no live job holds the field), so the
	// store proceeds to run the model. Tests that exercise a lost race override
	// this to resolve `false`.
	claimExtractionIfIdleMock.mockResolvedValue(true);
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
			truncated: false,
			charCount: 6,
		});
		expect(loadAssetByIdMock).not.toHaveBeenCalled();
		expect(extractDocumentMock).not.toHaveBeenCalled();
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
		// setAssetExtractStatus now records ONLY the terminal `ready` (the claim
		// owns the `extracting` write), so it fires exactly once.
		expect(setAssetExtractStatus).toHaveBeenCalledTimes(1);
		expect(setAssetExtractStatus).toHaveBeenCalledWith(
			"asset-1",
			expect.objectContaining({ status: "ready", charCount: 13 }),
		);
		expect(writeTextObject).toHaveBeenCalledWith(
			expect.stringContaining(`.extract.v${EXTRACTOR_VERSION}.md`),
			"FRESH EXTRACT",
		);
	});

	it("reports in-flight (no model call) when the atomic claim is lost", async () => {
		// The pre-claim status read saw no live job, but a concurrent caller won
		// the transaction in that window — `claimExtractionIfIdle` returns false.
		// Under `onInflight: "report"` the store must defer to that winner: report
		// `extracting`, never run a second model call.
		readTextObjectMock.mockResolvedValue(null); // GCS miss
		loadAssetByIdMock.mockResolvedValue(docAsset()); // no live job at read time
		claimExtractionIfIdleMock.mockResolvedValue(false); // lost the claim race

		const result = await ensureStoredExtract({
			asset: docAsset(),
			documentKind: "pdf",
			condenser: stubCondenser,
			onInflight: "report",
		});

		expect(result).toEqual({ status: "extracting" });
		expect(extractDocumentMock).not.toHaveBeenCalled();
		expect(setAssetExtractStatus).not.toHaveBeenCalled();
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
		expect(setAssetExtractStatus).not.toHaveBeenCalled();
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
		expect(setAssetExtractStatus).toHaveBeenLastCalledWith(
			"asset-1",
			expect.objectContaining({
				status: "failed",
				failureReason: "model exploded",
			}),
		);
	});
});
