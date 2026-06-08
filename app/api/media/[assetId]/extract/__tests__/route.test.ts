/**
 * `/api/media/[assetId]/extract` route tests.
 *
 * The route is a thin HTTP wrapper now: it owns auth + the extractable-document
 * guards (kind / upload-status / ownership), then delegates producing the extract
 * to the shared single-flight store (`ensureStoredExtract`) and STREAMS the result
 * as NDJSON: `{type:"progress",chars}` lines while the model runs, then one
 * `{type:"done",extract}`. So these tests pin the WRAPPER: the streamed result
 * shape (ready / extracting / failed all ride the terminal `done` line at HTTP
 * 200; progress lines forward the store's `onProgress`), the request guards
 * (400/404/409/429/503, foreign → 404) which still reject as plain JSON BEFORE the
 * stream opens, and the GET that serves stored text. The single-flight LIFECYCLE
 * itself (claim/reuse/stale/in-flight) is covered at the store level in
 * `documentExtractionStore.test.ts`.
 *
 * The store, storage, db, and auth are mocked at the import boundary so no
 * Gemini call, GCS, or Firestore is touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureStoredExtract } from "@/lib/agent/documentExtractionStore";
import { ACTUAL_COST_BACKSTOP_USD } from "@/lib/db/creditPolicy";
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
// The gate reads the user's month-to-date usage and compares it to the actual-
// cost backstop (`ACTUAL_COST_BACKSTOP_USD`, the real client-safe constant the
// route imports from creditPolicy — not mocked here). Only `getMonthlyUsage` is
// stubbed so the over/under-budget tests are deterministic.
vi.mock("@/lib/db/usage", () => ({
	getMonthlyUsage: getMonthlyUsageMock,
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
// GET reads `req.url` (the `?meta` switch), so the stub carries a realistic URL;
// pass a query (e.g. "?meta=1") to exercise the metadata branch.
const req = (query = "") =>
	({ url: `http://localhost/api/media/asset-1/extract${query}` }) as Parameters<
		typeof POST
	>[0];

/** Drain a handler response's body. An unread `NextResponse.json` body leaves a
 *  pending promise the async-leak gate flags, so status-only assertions still
 *  consume the body. */
const drainBody = (res: Response): Promise<string> => res.text();

/** Read the POST's NDJSON stream into its parts: the progress char-deltas in
 *  order, and the single terminal `done` line's extract. */
async function readNdjson(res: Response): Promise<{
	progress: number[];
	done: { status: string; title?: string; summary?: string } | undefined;
}> {
	const lines = (await res.text())
		.split("\n")
		.filter(Boolean)
		.map(
			(l) =>
				JSON.parse(l) as { type: string; chars?: number; extract?: unknown },
		);
	return {
		progress: lines
			.filter((l) => l.type === "progress")
			.map((l) => l.chars as number),
		done: lines.find((l) => l.type === "done")?.extract as
			| { status: string; title?: string; summary?: string }
			| undefined,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	requireSessionMock.mockResolvedValue({ user: { id: "user-1" } });
	// Default: comfortably under the spend cap so the gate is transparent to the
	// mapping tests. The spend-gate test overrides this.
	getMonthlyUsageMock.mockResolvedValue({ cost_estimate: 0 });
});

describe("POST extract (streamed result)", () => {
	it("ends a ready result with a `done` line carrying the extract metadata", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		ensureStoredExtractMock.mockResolvedValue({
			status: "ready",
			text: "EXTRACT BODY",
			truncated: false,
			charCount: "EXTRACT BODY".length,
		});

		const res = await POST(req(), ctx());
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
		const { done } = await readNdjson(res);
		expect(done).toEqual({
			status: "ready",
			version: EXTRACTOR_VERSION,
			truncated: false,
			charCount: 12,
		});
		expect(ensureStoredExtract).toHaveBeenCalledWith(
			expect.objectContaining({ onInflight: "report" }),
		);
	});

	it("streams the store's onProgress as `progress` lines before the `done` line", async () => {
		// The whole point of streaming: the store's per-chunk `onProgress` becomes
		// `progress` wire lines the client maps to signal-grid energy.
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		ensureStoredExtractMock.mockImplementation(
			async (opts: { onProgress?: (n: number) => void }) => {
				opts.onProgress?.(5);
				opts.onProgress?.(7);
				return {
					status: "ready",
					text: "EXTRACT BODY",
					truncated: false,
					charCount: 12,
				};
			},
		);

		const { progress, done } = await readNdjson(await POST(req(), ctx()));
		expect(progress).toEqual([5, 7]);
		expect(done?.status).toBe("ready");
	});

	it("includes the persisted title/summary in the ready `done` line", async () => {
		// The store returns extract TEXT only; the route re-reads the asset doc for
		// the title/summary it persisted, so the caller can refresh a staged
		// snapshot the instant extraction finishes (chip preview shows them at once).
		loadAssetForOwnerMock.mockResolvedValue(
			docAsset({
				extract: {
					status: "ready",
					version: EXTRACTOR_VERSION,
					model: "gemini-3.5-flash",
					truncated: false,
					charCount: 12,
					title: "ANC Program Requirements",
					summary: "A data-collection spec for antenatal care visits.",
					// biome-ignore lint/suspicious/noExplicitAny: Timestamp irrelevant here
					extractedAt: {} as any,
				},
			}),
		);
		ensureStoredExtractMock.mockResolvedValue({
			status: "ready",
			text: "EXTRACT BODY",
			truncated: false,
			charCount: "EXTRACT BODY".length,
		});

		const { done } = await readNdjson(await POST(req(), ctx()));
		expect(done).toMatchObject({
			status: "ready",
			title: "ANC Program Requirements",
			summary: "A data-collection spec for antenatal care visits.",
		});
	});

	it("ends an in-flight result with a `done` line at status extracting", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		ensureStoredExtractMock.mockResolvedValue({ status: "extracting" });

		const res = await POST(req(), ctx());
		expect(res.status).toBe(200);
		const { done } = await readNdjson(res);
		expect(done?.status).toBe("extracting");
	});

	it("ends a failed result with a `done` line at status failed (the bytes are kept)", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		ensureStoredExtractMock.mockResolvedValue({
			status: "failed",
			reason: "model exploded",
		});

		const { done } = await readNdjson(await POST(req(), ctx()));
		expect(done?.status).toBe("failed");
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
		// A user at/over the monthly actual-cost backstop must not keep triggering
		// paid extractions. The gate fires AFTER the document guards (the asset is
		// fine) but BEFORE the store call, so no model work happens.
		loadAssetForOwnerMock.mockResolvedValue(docAsset());
		getMonthlyUsageMock.mockResolvedValue({
			cost_estimate: ACTUAL_COST_BACKSTOP_USD,
		}); // at the backstop

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

	it("?meta=1 returns the header title/summary as JSON without reading the body", async () => {
		// The preview's fallback for a frozen-ref message attachment: a cheap
		// asset-doc read, never the GCS extract text.
		loadAssetForOwnerMock.mockResolvedValue(
			docAsset({
				extract: {
					status: "ready",
					version: EXTRACTOR_VERSION,
					model: "gemini-3.5-flash",
					truncated: false,
					charCount: 5,
					title: "ANC Program Requirements",
					summary: "A data-collection spec for antenatal care visits.",
					// biome-ignore lint/suspicious/noExplicitAny: Timestamp irrelevant here
					extractedAt: {} as any,
				},
			}),
		);
		const res = await GET(req("?meta=1"), ctx());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: "ready",
			title: "ANC Program Requirements",
			summary: "A data-collection spec for antenatal care visits.",
		});
		// Metadata comes off the asset doc — the extract body is never fetched.
		expect(readTextObject).not.toHaveBeenCalled();
	});

	it("?meta=1 omits title/summary for a not-yet-extracted document", async () => {
		loadAssetForOwnerMock.mockResolvedValue(docAsset()); // no extract field
		const res = await GET(req("?meta=1"), ctx());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: null });
	});
});
