/**
 * `/api/media/[assetId]/extract` route tests.
 *
 * POST owns running + persisting a document's requirements extract; GET serves
 * the stored text. These pin the lifecycle the file manager + chat resolve step
 * depend on: a ready document with no current extract gets `extracting` →
 * `ready` (text written to GCS); a current-version extract is returned without
 * re-running the model (idempotent); a non-document is rejected; a model failure
 * records `failed` and keeps the asset; GET 404s until an extract exists.
 *
 * The extraction core, storage, db, and auth are mocked at the import boundary
 * so no Gemini call, GCS, or Firestore is touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractDocument } from "@/lib/agent/documentExtraction";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	MediaAssetOwnershipError,
	setAssetExtractStatus,
} from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import { readTextObject, writeTextObject } from "@/lib/storage/media";
import { GET, POST } from "../route";

const {
	requireSessionMock,
	loadAssetForOwnerMock,
	setAssetExtractStatusMock,
	extractDocumentMock,
	downloadAssetBytesMock,
	writeTextObjectMock,
	readTextObjectMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	loadAssetForOwnerMock: vi.fn(),
	setAssetExtractStatusMock: vi.fn(),
	extractDocumentMock: vi.fn(),
	downloadAssetBytesMock: vi.fn(),
	writeTextObjectMock: vi.fn(),
	readTextObjectMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetForOwner: loadAssetForOwnerMock,
	setAssetExtractStatus: setAssetExtractStatusMock,
	MediaAssetOwnershipError: class extends Error {},
}));
// Mock the extraction core wholesale so the real module (mammoth + the Google
// provider) never loads, while keeping the constants the route reads.
vi.mock("@/lib/agent/documentExtraction", () => ({
	extractDocument: extractDocumentMock,
	createGeminiCondenser: vi.fn(() => ({})),
	CONDENSER_MODEL: "gemini-3.5-flash",
	EXTRACTOR_VERSION: 1,
	EXTRACT_MAX_BYTES: 4 * 1024 * 1024,
}));
vi.mock("@/lib/storage/media", () => ({
	downloadAssetBytes: downloadAssetBytesMock,
	writeTextObject: writeTextObjectMock,
	readTextObject: readTextObjectMock,
}));

/** Build a ready document asset record, overridable per test. */
function docAsset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: "asset-1",
		owner: "user-1",
		contentHash: "a".repeat(64),
		mimeType: "application/pdf",
		extension: ".pdf",
		sizeBytes: 1234,
		kind: "pdf",
		gcsObjectKey: "users/user-1/aaaa.pdf",
		originalFilename: "form.pdf",
		status: "ready",
		// biome-ignore lint/suspicious/noExplicitAny: Timestamp is irrelevant to these tests
		created_at: {} as any,
		...over,
	} as MediaAssetRecord;
}

const ctx = (assetId = "asset-1") => ({
	params: Promise.resolve({ assetId }),
});
const req = () => ({}) as Parameters<typeof POST>[0];

beforeEach(() => {
	vi.clearAllMocks();
	requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
	setAssetExtractStatusMock.mockResolvedValue(undefined);
	downloadAssetBytesMock.mockResolvedValue(Buffer.from("bytes"));
	writeTextObjectMock.mockResolvedValue(undefined);
});

describe("POST extract", () => {
	it("extracts a ready document with no extract: extracting → ready, writes text", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		extractDocumentMock.mockResolvedValue({
			text: "EXTRACT BODY",
			truncated: false,
		});

		const res = await POST(req(), ctx());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.extract).toEqual({
			status: "ready",
			version: 1,
			truncated: false,
			charCount: "EXTRACT BODY".length,
		});
		// Marked extracting before the model call, then ready after.
		expect(setAssetExtractStatus).toHaveBeenNthCalledWith(
			1,
			"asset-1",
			expect.objectContaining({ status: "extracting", version: 1 }),
		);
		expect(setAssetExtractStatus).toHaveBeenNthCalledWith(
			2,
			"asset-1",
			expect.objectContaining({ status: "ready", charCount: 12 }),
		);
		expect(writeTextObject).toHaveBeenCalledWith(
			expect.stringContaining(".extract.v1.md"),
			"EXTRACT BODY",
		);
	});

	it("is idempotent: a current-version ready extract is not re-run", async () => {
		loadAssetForOwnerMock.mockResolvedValue(
			docAsset({
				extract: {
					status: "ready",
					version: 1,
					model: "gemini-3.5-flash",
					truncated: false,
					charCount: 42,
					// biome-ignore lint/suspicious/noExplicitAny: Timestamp irrelevant here
					extractedAt: {} as any,
				},
			}),
		);
		const res = await POST(req(), ctx());
		expect(res.status).toBe(200);
		expect(extractDocument).not.toHaveBeenCalled();
		expect(setAssetExtractStatus).not.toHaveBeenCalled();
	});

	it("re-extracts when the stored extract is a stale version", async () => {
		loadAssetForOwnerMock.mockResolvedValue(
			docAsset({
				extract: {
					status: "ready",
					version: 0,
					model: "gemini-3.5-flash",
					truncated: false,
					charCount: 42,
					// biome-ignore lint/suspicious/noExplicitAny: Timestamp irrelevant here
					extractedAt: {} as any,
				},
			}),
		);
		extractDocumentMock.mockResolvedValue({ text: "FRESH", truncated: false });
		const res = await POST(req(), ctx());
		expect(res.status).toBe(200);
		expect(extractDocument).toHaveBeenCalledOnce();
	});

	it("short-circuits with 202 when a current-version extraction is already in flight", async () => {
		loadAssetForOwnerMock.mockResolvedValue(
			docAsset({
				extract: {
					status: "extracting",
					version: 1,
					model: "gemini-3.5-flash",
					truncated: false,
					charCount: 0,
					// Just now — well within the staleness window.
					extractedAt: { toMillis: () => Date.now() } as never,
				},
			}),
		);
		const res = await POST(req(), ctx());
		expect(res.status).toBe(202);
		expect(extractDocument).not.toHaveBeenCalled();
		expect(setAssetExtractStatus).not.toHaveBeenCalled();
	});

	it("re-extracts when an `extracting` record is stale (a hung/crashed job)", async () => {
		loadAssetForOwnerMock.mockResolvedValue(
			docAsset({
				extract: {
					status: "extracting",
					version: 1,
					model: "gemini-3.5-flash",
					truncated: false,
					charCount: 0,
					// Older than maxDuration (300s) → treated as a dead in-flight marker.
					extractedAt: { toMillis: () => Date.now() - 400_000 } as never,
				},
			}),
		);
		extractDocumentMock.mockResolvedValue({ text: "REDONE", truncated: false });
		const res = await POST(req(), ctx());
		expect(res.status).toBe(200);
		expect(extractDocument).toHaveBeenCalledOnce();
	});

	it("rejects a non-document kind with 400", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset({ kind: "image" }));
		const res = await POST(req(), ctx());
		expect(res.status).toBe(400);
		expect(extractDocument).not.toHaveBeenCalled();
	});

	it("rejects a still-uploading (pending) document with 409", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset({ status: "pending" }));
		const res = await POST(req(), ctx());
		expect(res.status).toBe(409);
	});

	it("records failed + returns 502 when extraction throws", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		extractDocumentMock.mockRejectedValue(new Error("model exploded"));
		const res = await POST(req(), ctx());
		expect(res.status).toBe(502);
		expect(setAssetExtractStatus).toHaveBeenLastCalledWith(
			"asset-1",
			expect.objectContaining({
				status: "failed",
				failureReason: "model exploded",
			}),
		);
	});

	it("404s a missing asset", async () => {
		loadAssetForOwnerMock.mockResolvedValue(null);
		const res = await POST(req(), ctx());
		expect(res.status).toBe(404);
	});

	it("404s a foreign-owned asset so ids stay non-enumerable", async () => {
		// loadAssetForOwner THROWS for a row owned by someone else; the route's
		// catch maps that to a 404 — identical to not-found — so a caller can't
		// distinguish "isn't yours" from "doesn't exist".
		loadAssetForOwnerMock.mockRejectedValue(
			new MediaAssetOwnershipError(asAssetId("asset-1"), "user-2", "user-1"),
		);
		const res = await POST(req(), ctx());
		expect(res.status).toBe(404);
		expect(extractDocument).not.toHaveBeenCalled();
	});
});

describe("GET extract", () => {
	it("returns the stored extract text as markdown when ready", async () => {
		loadAssetForOwnerMock.mockResolvedValue(
			docAsset({
				extract: {
					status: "ready",
					version: 1,
					model: "gemini-3.5-flash",
					truncated: false,
					charCount: 5,
					// biome-ignore lint/suspicious/noExplicitAny: Timestamp irrelevant here
					extractedAt: {} as any,
				},
			}),
		);
		readTextObjectMock.mockResolvedValue("HELLO");
		const res = await GET(req(), ctx());
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/markdown");
		expect(await res.text()).toBe("HELLO");
	});

	it("404s when the document has no current-version extract", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset()); // no extract field
		const res = await GET(req(), ctx());
		expect(res.status).toBe(404);
		expect(readTextObject).not.toHaveBeenCalled();
	});

	it("404s a foreign-owned asset so ids stay non-enumerable", async () => {
		loadAssetForOwnerMock.mockRejectedValue(
			new MediaAssetOwnershipError(asAssetId("asset-1"), "user-2", "user-1"),
		);
		const res = await GET(req(), ctx());
		expect(res.status).toBe(404);
		expect(readTextObject).not.toHaveBeenCalled();
	});
});
