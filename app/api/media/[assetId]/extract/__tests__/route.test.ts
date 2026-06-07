/**
 * `/api/media/[assetId]/extract` route tests.
 *
 * The route is a thin HTTP wrapper now: it owns auth + the extractable-document
 * guards (kind / upload-status / ownership), then delegates producing the
 * extract to the shared single-flight store (`ensureStoredExtract`) and maps its
 * result to the wire envelope. So these tests pin the WRAPPER: the result→status
 * mapping (ready → 200, extracting → 202, failed → 502), the request guards
 * (400/404/409, foreign → 404), and the GET that serves stored text. The
 * single-flight LIFECYCLE itself (claim/reuse/stale/in-flight) is covered at the
 * store level in `documentExtractionStore.test.ts`.
 *
 * The store, storage, db, and auth are mocked at the import boundary so no
 * Gemini call, GCS, or Firestore is touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureStoredExtract } from "@/lib/agent/documentExtractionStore";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { MediaAssetOwnershipError } from "@/lib/db/mediaAssets";
import { asAssetId, EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { readTextObject } from "@/lib/storage/media";
import { GET, POST } from "../route";

const {
	requireSessionMock,
	loadAssetForOwnerMock,
	ensureStoredExtractMock,
	readTextObjectMock,
	getMonthlyUsageMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	loadAssetForOwnerMock: vi.fn(),
	ensureStoredExtractMock: vi.fn(),
	readTextObjectMock: vi.fn(),
	getMonthlyUsageMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetForOwner: loadAssetForOwnerMock,
	MediaAssetOwnershipError: class extends Error {},
}));
vi.mock("@/lib/agent/documentExtractionStore", () => ({
	ensureStoredExtract: ensureStoredExtractMock,
}));
// The spend gate reads the user's month-to-date usage and compares it to the
// cap. Pin a known cap so the over/under-budget tests are deterministic.
vi.mock("@/lib/db/usage", () => ({
	getMonthlyUsage: getMonthlyUsageMock,
	MONTHLY_SPEND_CAP_USD: 15,
}));
// Keep the constants the route reads + a no-op condenser factory; the real
// module (mammoth + the Google provider) never loads.
vi.mock("@/lib/agent/documentExtraction", () => ({
	createGeminiCondenser: vi.fn(() => ({})),
	EXTRACT_MAX_BYTES: 4 * 1024 * 1024,
}));
vi.mock("@/lib/storage/media", () => ({ readTextObject: readTextObjectMock }));

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

/** Drain a handler response's body. An unread `NextResponse.json` body leaves a
 *  pending promise the async-leak gate flags, so status-only assertions still
 *  consume the body. */
const drainBody = (res: Response): Promise<string> => res.text();

beforeEach(() => {
	vi.clearAllMocks();
	requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
	// Default: comfortably under the spend cap so the gate is transparent to the
	// mapping tests. The spend-gate test overrides this.
	getMonthlyUsageMock.mockResolvedValue({ cost_estimate: 0 });
});

describe("POST extract (wrapper mapping)", () => {
	it("maps a ready result to 200 with the extract metadata", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		ensureStoredExtractMock.mockResolvedValue({
			status: "ready",
			text: "EXTRACT BODY",
			truncated: false,
			charCount: "EXTRACT BODY".length,
		});

		const res = await POST(req(), ctx());
		expect(res.status).toBe(200);
		expect((await res.json()).extract).toEqual({
			status: "ready",
			version: EXTRACTOR_VERSION,
			truncated: false,
			charCount: 12,
		});
		expect(ensureStoredExtract).toHaveBeenCalledWith(
			expect.objectContaining({ onInflight: "report" }),
		);
	});

	it("maps an in-flight result to 202", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		ensureStoredExtractMock.mockResolvedValue({ status: "extracting" });

		const res = await POST(req(), ctx());
		expect(res.status).toBe(202);
		expect((await res.json()).extract.status).toBe("extracting");
	});

	it("maps a failed result to 502 (the bytes are kept)", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		ensureStoredExtractMock.mockResolvedValue({
			status: "failed",
			reason: "model exploded",
		});

		const res = await POST(req(), ctx());
		expect(res.status).toBe(502);
		await drainBody(res);
	});

	it("rejects a non-document kind with 400 (no extraction attempted)", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset({ kind: "image" }));
		const res = await POST(req(), ctx());
		expect(res.status).toBe(400);
		expect(ensureStoredExtract).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("rejects a still-uploading (pending) document with 409", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset({ status: "pending" }));
		const res = await POST(req(), ctx());
		expect(res.status).toBe(409);
		expect(ensureStoredExtract).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("404s a missing asset", async () => {
		loadAssetForOwnerMock.mockResolvedValue(null);
		const res = await POST(req(), ctx());
		expect(res.status).toBe(404);
		await drainBody(res);
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
		expect(ensureStoredExtract).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("429s an over-budget user before running the model", async () => {
		// A user at/over the monthly cap must not keep triggering paid extractions.
		// The gate fires AFTER the document guards (the asset is fine) but BEFORE
		// the store call, so no model work happens.
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		getMonthlyUsageMock.mockResolvedValue({ cost_estimate: 15 }); // == cap

		const res = await POST(req(), ctx());
		expect(res.status).toBe(429);
		expect(ensureStoredExtract).not.toHaveBeenCalled();
		await drainBody(res);
	});

	it("503s (fails closed, no model call) when the usage read fails", async () => {
		// Matching the chat route: if we can't verify usage we can't rule out being
		// over cap, so the gate rejects rather than risk uncapped spend. No
		// extraction is attempted.
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		getMonthlyUsageMock.mockRejectedValue(new Error("firestore down"));

		const res = await POST(req(), ctx());
		expect(res.status).toBe(503);
		expect(ensureStoredExtract).not.toHaveBeenCalled();
		await drainBody(res);
	});
});

describe("GET extract", () => {
	it("returns the stored extract text as markdown when ready", async () => {
		loadAssetForOwnerMock.mockResolvedValue(
			docAsset({
				extract: {
					status: "ready",
					version: EXTRACTOR_VERSION,
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
		await drainBody(res);
	});

	it("404s a foreign-owned asset so ids stay non-enumerable", async () => {
		loadAssetForOwnerMock.mockRejectedValue(
			new MediaAssetOwnershipError(asAssetId("asset-1"), "user-2", "user-1"),
		);
		const res = await GET(req(), ctx());
		expect(res.status).toBe(404);
		expect(readTextObject).not.toHaveBeenCalled();
		await drainBody(res);
	});
});
