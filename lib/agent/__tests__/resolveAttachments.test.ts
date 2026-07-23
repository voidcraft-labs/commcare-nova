// lib/agent/__tests__/resolveAttachments.test.ts
//
// Unit tests for the chat attachment resolver: refs (in message metadata) →
// model-ready parts. Driven against mocked storage/db + a stub condenser so no
// GCS, Postgres, or model call happens. Covers the contracts the chat route
// and the multi-turn fix depend on: ready-extract reuse, the lazy backstop,
// image → data-URL file part, never-drop placeholders, cross-turn dedup, and —
// the multi-turn crash fix — that NO raw file part with a document media type
// is ever produced (every doc becomes a text part).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentCondenser } from "@/lib/agent/documentExtraction";
import {
	countDocumentsNeedingRead,
	resolveAttachments,
} from "@/lib/agent/resolveAttachments";
import type { AttachmentRef, NovaUIMessage } from "@/lib/chat/attachmentRefs";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	loadAssetsByIds,
	publishClaimedAssetExtract,
} from "@/lib/db/mediaAssets";
import { asAssetId, EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { readTextObject, writeTextObject } from "@/lib/storage/media";

// mammoth pulls bluebird (a module-level promise the leak detector flags); the
// real documentExtraction core imports it. We never exercise the docx path here,
// so mock it at the boundary.
vi.mock("mammoth", () => ({
	default: { convertToMarkdown: vi.fn(async () => ({ value: "" })) },
}));

const {
	loadAssetsByIdsMock,
	loadAssetByIdMock,
	publishClaimedAssetExtractMock,
	findReadyExtractForProjectAndHashMock,
	hasReadyExtractForProjectAndHashMock,
	installCopiedReadyExtractMock,
	claimExtractionIfIdleMock,
	deleteAssetMock,
	downloadAssetBytesMock,
	readTextObjectMock,
	writeTextObjectMock,
	withMediaObjectKeyLockMock,
} = vi.hoisted(() => ({
	loadAssetsByIdsMock: vi.fn(),
	loadAssetByIdMock: vi.fn(),
	publishClaimedAssetExtractMock: vi.fn(),
	findReadyExtractForProjectAndHashMock: vi.fn(),
	hasReadyExtractForProjectAndHashMock: vi.fn(),
	installCopiedReadyExtractMock: vi.fn(),
	claimExtractionIfIdleMock: vi.fn(),
	deleteAssetMock: vi.fn(),
	downloadAssetBytesMock: vi.fn(),
	readTextObjectMock: vi.fn(),
	writeTextObjectMock: vi.fn(),
	withMediaObjectKeyLockMock: vi.fn(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) =>
			body({ pinned: true }),
	),
}));

// `loadAssetById` + `claimExtractionIfIdle` are pulled in transitively via the
// shared extract store (the backstop delegates to it); on a GCS miss the store
// re-reads status fresh by id, then atomically claims via `claimExtractionIfIdle`
// before running the model.
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetsByIds: loadAssetsByIdsMock,
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

/** A condenser whose lazy-backstop extraction returns a fixed result from the
 *  one structured call. Title/summary are irrelevant to these resolve-path
 *  assertions; cast because `vi.fn` can't express the generic method signature. */
function stubCondenser(text = "LAZY EXTRACT"): AttachmentCondenser {
	return {
		extractDocumentStructured: vi.fn(async () => ({
			object: { extract: text, title: "T", summary: "S" },
			truncated: false,
		})) as unknown as AttachmentCondenser["extractDocumentStructured"],
	};
}

function asset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: "doc-1",
		owner: "user-1",
		project_id: "project-1",
		contentHash: "a".repeat(64),
		mimeType: "text/markdown",
		extension: ".md",
		sizeBytes: 100,
		kind: "text",
		gcsObjectKey: "projects/project-1/aaaa.md",
		originalFilename: "spec.md",
		status: "ready",
		// biome-ignore lint/suspicious/noExplicitAny: Timestamp irrelevant to these tests
		created_at: {} as any,
		...over,
	} as MediaAssetRecord;
}

function readyExtract(): MediaAssetRecord["extract"] {
	return {
		status: "ready",
		version: EXTRACTOR_VERSION,
		model: "gpt-5.6-luna",
		truncated: false,
		charCount: 100,
		extractedAt: 123,
	};
}

/** A user message carrying one attachment ref. */
function userMsg(
	id: string,
	ref: { assetId: string; kind: MediaAssetRecord["kind"]; filename: string },
): NovaUIMessage {
	return {
		id,
		role: "user",
		parts: [{ type: "text", text: "please build this" }],
		metadata: {
			attachments: [{ ...ref, mimeType: "text/markdown" }],
		},
	} as NovaUIMessage;
}

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
	deleteAssetMock.mockResolvedValue(undefined);
	// The store atomically claims before extracting; the backstop's lazy path
	// always wins the claim in these single-caller tests.
	claimExtractionIfIdleMock.mockResolvedValue({
		kind: "claimed",
		claim: {
			version: EXTRACTOR_VERSION,
			model: "gpt-5.6-luna",
			extractedAt: 123,
		},
	});
	downloadAssetBytesMock.mockResolvedValue(Buffer.from("raw bytes"));
	writeTextObjectMock.mockResolvedValue(undefined);
	// Default fresh status read: an asset with no extract record yet, so the
	// store's miss path decides "extract now" (no in-flight job to wait on).
	loadAssetByIdMock.mockResolvedValue(asset());
});

describe("resolveAttachments", () => {
	it("appends a document's STORED extract as a text part (no model call)", async () => {
		loadAssetsByIdsMock.mockResolvedValue([asset({ extract: readyExtract() })]);
		readTextObjectMock.mockResolvedValue("STORED EXTRACT BODY");
		const condenser = stubCondenser();

		const [msg] = await resolveAttachments(
			[userMsg("u1", { assetId: "doc-1", kind: "text", filename: "spec.md" })],
			"user-1",
			condenser,
		);
		const texts = msg.parts.filter((p) => p.type === "text").map((p) => p.text);
		expect(texts.some((t) => t.includes("STORED EXTRACT BODY"))).toBe(true);
		expect(texts.some((t) => t.includes("spec.md"))).toBe(true);
		// Reused the stored extract — no lazy extraction.
		expect(condenser.extractDocumentStructured).not.toHaveBeenCalled();
		expect(writeTextObject).not.toHaveBeenCalled();
	});

	it("lazily extracts + persists when no stored extract exists", async () => {
		loadAssetsByIdsMock.mockResolvedValue([asset()]);
		readTextObjectMock.mockResolvedValue(null); // no current extract
		const condenser = stubCondenser("FRESH EXTRACT");

		const [msg] = await resolveAttachments(
			[userMsg("u1", { assetId: "doc-1", kind: "text", filename: "spec.md" })],
			"user-1",
			condenser,
		);
		const texts = msg.parts.filter((p) => p.type === "text").map((p) => p.text);
		expect(texts.some((t) => t.includes("FRESH EXTRACT"))).toBe(true);
		expect(condenser.extractDocumentStructured).toHaveBeenCalledOnce();
		// Persisted for reuse next turn.
		expect(writeTextObject).toHaveBeenCalledOnce();
		expect(publishClaimedAssetExtract).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: "doc-1",
				extract: expect.objectContaining({ status: "ready" }),
			}),
			expect.anything(),
		);
	});

	it("appends an image as a data-URL file part for the vision pass", async () => {
		loadAssetsByIdsMock.mockResolvedValue([
			asset({ id: asAssetId("img-1"), kind: "image", mimeType: "image/png" }),
		]);
		const [msg] = await resolveAttachments(
			[
				userMsg("u1", {
					assetId: "img-1",
					kind: "image",
					filename: "diagram.png",
				}),
			],
			"user-1",
			stubCondenser(),
		);
		const filePart = msg.parts.find((p) => p.type === "file");
		expect(filePart).toBeDefined();
		expect(filePart).toMatchObject({
			type: "file",
			mediaType: "image/png",
			// The image rides as an inline base64 data URL for the vision pass —
			// not a GCS path. Assert the url the test name promises (a regression
			// emitting an empty/path url would otherwise still pass).
			url: expect.stringContaining("data:image/png;base64,"),
		});
		expect(readTextObject).not.toHaveBeenCalled();
	});

	it("never emits a raw document file part (the multi-turn crash fix)", async () => {
		loadAssetsByIdsMock.mockResolvedValue([asset({ extract: readyExtract() })]);
		readTextObjectMock.mockResolvedValue("EXTRACT");
		const [msg] = await resolveAttachments(
			[userMsg("u1", { assetId: "doc-1", kind: "text", filename: "spec.md" })],
			"user-1",
			stubCondenser(),
		);
		// A document resolves to TEXT, never a file part Anthropic would reject.
		expect(msg.parts.some((p) => p.type === "file")).toBe(false);
	});

	it("placeholders a missing/foreign asset rather than dropping it", async () => {
		loadAssetsByIdsMock.mockResolvedValue([]); // id not owned / not found
		const [msg] = await resolveAttachments(
			[userMsg("u1", { assetId: "ghost", kind: "text", filename: "gone.md" })],
			"user-1",
			stubCondenser(),
		);
		const texts = msg.parts.filter((p) => p.type === "text").map((p) => p.text);
		expect(
			texts.some(
				(t) => t.includes("gone.md") && t.includes("couldn't be loaded"),
			),
		).toBe(true);
	});

	it("placeholders a still-pending asset without downloading bytes or extracting", async () => {
		// A ref to an owned-but-pending (not-yet-confirmed) asset must NOT feed
		// unvalidated bytes to the model or the extractor — it resolves to a
		// placeholder, like the proxy GET (404) and extract route (409) do.
		loadAssetsByIdsMock.mockResolvedValue([asset({ status: "pending" })]);
		const condenser = stubCondenser();

		const [msg] = await resolveAttachments(
			[userMsg("u1", { assetId: "doc-1", kind: "text", filename: "spec.md" })],
			"user-1",
			condenser,
		);

		const texts = msg.parts.filter((p) => p.type === "text").map((p) => p.text);
		expect(
			texts.some(
				(t) => t.includes("spec.md") && t.includes("still being prepared"),
			),
		).toBe(true);
		// No bytes read, no extraction run.
		expect(downloadAssetBytesMock).not.toHaveBeenCalled();
		expect(readTextObjectMock).not.toHaveBeenCalled();
		expect(condenser.extractDocumentStructured).not.toHaveBeenCalled();
	});

	it("resolves EVERY turn's attachments and dedups a repeated ref to one read", async () => {
		loadAssetsByIdsMock.mockResolvedValue([asset({ extract: readyExtract() })]);
		readTextObjectMock.mockResolvedValue("SHARED EXTRACT");
		const ref = {
			assetId: "doc-1",
			kind: "text" as const,
			filename: "spec.md",
		};

		const resolved = await resolveAttachments(
			[userMsg("u1", ref), userMsg("u2", ref)],
			"user-1",
			stubCondenser(),
		);
		// Both turns carry the extract — the historical turn is resolved too.
		for (const msg of resolved) {
			const texts = msg.parts
				.filter((p) => p.type === "text")
				.map((p) => p.text);
			expect(texts.some((t) => t.includes("SHARED EXTRACT"))).toBe(true);
		}
		// One batch load (unique ids) + one extract read (deduped by assetId).
		expect(loadAssetsByIds).toHaveBeenCalledOnce();
		expect(loadAssetsByIds).toHaveBeenCalledWith(["doc-1"], "user-1");
		expect(readTextObject).toHaveBeenCalledOnce();
	});

	it("degrades to placeholders (never throws) when the batch asset load fails", async () => {
		// A Postgres outage in loadAssetsByIds must not fail the whole turn from
		// outside the route's try/finally — it degrades to placeholders, upholding
		// the never-drop invariant.
		loadAssetsByIdsMock.mockRejectedValue(new Error("postgres down"));
		const resolved = await resolveAttachments(
			[userMsg("u1", { assetId: "doc-1", kind: "text", filename: "spec.md" })],
			"user-1",
			stubCondenser(),
		);
		const texts = resolved[0].parts
			.filter((p) => p.type === "text")
			.map((p) => p.text);
		expect(texts.some((t) => t.includes("spec.md"))).toBe(true);
	});

	it("passes messages without attachments through untouched", async () => {
		const plain: NovaUIMessage = {
			id: "u1",
			role: "user",
			parts: [{ type: "text", text: "no files here" }],
		} as NovaUIMessage;
		const result = await resolveAttachments([plain], "user-1", stubCondenser());
		// Pass-through by reference: a ref-free message is returned as the SAME
		// object, never cloned (source short-circuits with `return messages` when
		// there are no attachment ids to resolve).
		expect(result[0]).toBe(plain);
		expect(result[0].parts).toHaveLength(1);
		expect(loadAssetsByIds).not.toHaveBeenCalled();
	});
});

/* The gate for the "Reading your documents" status: a document attachment counts
 * only when its extract wasn't ready when attached (no `title` snapshot on the
 * ref). An already-read document — or an image — resolves instantly and must not
 * make the status flash. Pure function; no storage/db. */
describe("countDocumentsNeedingRead", () => {
	const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({
		assetId: "a",
		kind: "text",
		filename: "spec.md",
		mimeType: "text/markdown",
		...over,
	});

	const userMsgWith = (...refs: AttachmentRef[]): NovaUIMessage =>
		({
			id: "u",
			role: "user",
			parts: [{ type: "text", text: "build this" }],
			metadata: { attachments: refs },
		}) as NovaUIMessage;

	it("counts a document whose extract wasn't ready (no title snapshot)", () => {
		expect(countDocumentsNeedingRead([userMsgWith(ref({}))])).toBe(1);
	});

	it("does NOT count a document already read (title snapshot present)", () => {
		expect(
			countDocumentsNeedingRead([userMsgWith(ref({ title: "Spec" }))]),
		).toBe(0);
	});

	it("does NOT count an image (read directly, never extracted)", () => {
		expect(
			countDocumentsNeedingRead([
				userMsgWith(ref({ kind: "image", filename: "d.png" })),
			]),
		).toBe(0);
	});

	it("counts only the unread documents in a mixed batch", () => {
		expect(
			countDocumentsNeedingRead([
				userMsgWith(
					ref({ assetId: "read", title: "Done" }),
					ref({ assetId: "unread1" }),
					ref({ assetId: "unread2" }),
					ref({ assetId: "img", kind: "image", filename: "d.png" }),
				),
			]),
		).toBe(2);
	});

	it("returns 0 when the last message carries no attachments", () => {
		const plain = {
			id: "u",
			role: "user",
			parts: [{ type: "text", text: "no files" }],
		} as NovaUIMessage;
		expect(countDocumentsNeedingRead([plain])).toBe(0);
	});

	it("ignores attachments on anything but the LAST message", () => {
		// A prior turn's unread doc must not re-trigger the status on a later turn —
		// the status is for the new turn's docs only.
		const prior = userMsgWith(ref({ assetId: "old" }));
		const latest = {
			id: "u2",
			role: "user",
			parts: [{ type: "text", text: "follow-up, no files" }],
		} as NovaUIMessage;
		expect(countDocumentsNeedingRead([prior, latest])).toBe(0);
	});

	it("returns 0 when the last message isn't a user message", () => {
		const assistant = {
			id: "a",
			role: "assistant",
			parts: [{ type: "text", text: "done" }],
		} as NovaUIMessage;
		expect(countDocumentsNeedingRead([assistant])).toBe(0);
	});
});
