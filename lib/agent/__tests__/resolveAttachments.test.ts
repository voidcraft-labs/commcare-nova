// lib/agent/__tests__/resolveAttachments.test.ts
//
// Unit tests for the chat attachment resolver: refs (in message metadata) →
// model-ready parts. Driven against mocked storage/db + a stub condenser so no
// GCS, Firestore, or model call happens. Covers the contracts the chat route
// and the multi-turn fix depend on: ready-extract reuse, the lazy backstop,
// image → data-URL file part, never-drop placeholders, cross-turn dedup, and —
// the multi-turn crash fix — that NO raw file part with a document media type
// is ever produced (every doc becomes a text part).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentCondenser } from "@/lib/agent/documentExtraction";
import { resolveAttachments } from "@/lib/agent/resolveAttachments";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { loadAssetsByIds, setAssetExtractStatus } from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import { readTextObject, writeTextObject } from "@/lib/storage/media";

// mammoth pulls bluebird (a module-level promise the leak detector flags); the
// real documentExtraction core imports it. We never exercise the docx path here,
// so mock it at the boundary.
vi.mock("mammoth", () => ({
	default: { convertToMarkdown: vi.fn(async () => ({ value: "" })) },
}));

const {
	loadAssetsByIdsMock,
	loadAssetForOwnerMock,
	setAssetExtractStatusMock,
	downloadAssetBytesMock,
	readTextObjectMock,
	writeTextObjectMock,
} = vi.hoisted(() => ({
	loadAssetsByIdsMock: vi.fn(),
	loadAssetForOwnerMock: vi.fn(),
	setAssetExtractStatusMock: vi.fn(),
	downloadAssetBytesMock: vi.fn(),
	readTextObjectMock: vi.fn(),
	writeTextObjectMock: vi.fn(),
}));

// `loadAssetForOwner` + `MediaAssetOwnershipError` are pulled in transitively via
// the shared extract store (the backstop delegates to it); the store re-reads
// status fresh on a GCS miss before deciding whether to claim or wait.
vi.mock("@/lib/db/mediaAssets", () => ({
	loadAssetsByIds: loadAssetsByIdsMock,
	loadAssetForOwner: loadAssetForOwnerMock,
	setAssetExtractStatus: setAssetExtractStatusMock,
	MediaAssetOwnershipError: class MediaAssetOwnershipError extends Error {},
}));
vi.mock("@/lib/storage/media", () => ({
	downloadAssetBytes: downloadAssetBytesMock,
	readTextObject: readTextObjectMock,
	writeTextObject: writeTextObjectMock,
}));

/** A condenser whose lazy-backstop extraction returns a fixed result. */
function stubCondenser(text = "LAZY EXTRACT"): AttachmentCondenser {
	return {
		generatePlainText: vi.fn(async () => ({ text, truncated: false })),
		extractFromContent: vi.fn(async () => ({ text, truncated: false })),
		// These tests assert on the EXTRACT resolution, not title/summary; the
		// structured pass returns null (metadata simply absent). Cast because
		// `vi.fn` can't express the generic method signature.
		generateStructured: vi.fn(
			async () => null,
		) as unknown as AttachmentCondenser["generateStructured"],
	};
}

function asset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: "doc-1",
		owner: "user-1",
		contentHash: "a".repeat(64),
		mimeType: "text/markdown",
		extension: ".md",
		sizeBytes: 100,
		kind: "text",
		gcsObjectKey: "users/user-1/aaaa.md",
		originalFilename: "spec.md",
		status: "ready",
		// biome-ignore lint/suspicious/noExplicitAny: Timestamp irrelevant to these tests
		created_at: {} as any,
		...over,
	} as MediaAssetRecord;
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
	setAssetExtractStatusMock.mockResolvedValue(undefined);
	downloadAssetBytesMock.mockResolvedValue(Buffer.from("raw bytes"));
	writeTextObjectMock.mockResolvedValue(undefined);
	// Default fresh status read: an asset with no extract record yet, so the
	// store's miss path decides "extract now" (no in-flight job to wait on).
	loadAssetForOwnerMock.mockResolvedValue(asset());
});

describe("resolveAttachments", () => {
	it("appends a document's STORED extract as a text part (no model call)", async () => {
		loadAssetsByIdsMock.mockResolvedValue([asset()]);
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
		expect(condenser.generatePlainText).not.toHaveBeenCalled();
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
		expect(condenser.generatePlainText).toHaveBeenCalledOnce();
		// Persisted for reuse next turn.
		expect(writeTextObject).toHaveBeenCalledOnce();
		expect(setAssetExtractStatus).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({ status: "ready" }),
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
		});
		expect(readTextObject).not.toHaveBeenCalled();
	});

	it("never emits a raw document file part (the multi-turn crash fix)", async () => {
		loadAssetsByIdsMock.mockResolvedValue([asset()]);
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

	it("resolves EVERY turn's attachments and dedups a repeated ref to one read", async () => {
		loadAssetsByIdsMock.mockResolvedValue([asset()]);
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
		expect(loadAssetsByIds).toHaveBeenCalledWith("user-1", ["doc-1"]);
		expect(readTextObject).toHaveBeenCalledOnce();
	});

	it("degrades to placeholders (never throws) when the batch asset load fails", async () => {
		// A Firestore outage in loadAssetsByIds must not fail the whole turn from
		// outside the route's try/finally — it degrades to placeholders, upholding
		// the never-drop invariant.
		loadAssetsByIdsMock.mockRejectedValue(new Error("firestore down"));
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
		expect(result).toBe(result); // returns array
		expect(result[0].parts).toHaveLength(1);
		expect(loadAssetsByIds).not.toHaveBeenCalled();
	});
});
