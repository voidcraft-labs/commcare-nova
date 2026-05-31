// lib/agent/__tests__/attachments.test.ts
//
// Unit tests for the attachment-preparation pipeline. This file covers two
// layers:
//
//  1. The pure conversion helpers (`decodeTextDataUrl`, `rowsToMarkdownTable`,
//     `xlsxToMarkdown`) + the threshold constant. These need no model and run
//     synchronously — the office helpers round-trip through the real SheetJS
//     encoder so we verify against the actual library contract, not a hand-
//     rolled mock of its output shape.
//  2. `prepareAttachments` orchestration (added in a later task), driven
//     against a stubbed `GenerationContext` so we assert the branching
//     (inline-small / extract-large / image-passthrough / error-fallback)
//     without a network call.

import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
	ATTACHMENT_EXTRACT_CHAR_THRESHOLD,
	decodeTextDataUrl,
	prepareAttachments,
	rowsToMarkdownTable,
	xlsxToMarkdown,
} from "@/lib/agent/attachments";
import type { GenerationContext } from "@/lib/agent/generationContext";

/* mammoth (the docx→markdown converter imported by attachments.ts) pulls in
 * bluebird, which creates a module-level promise at import time that the
 * async-leak detector flags as a leaked async resource — keeping the test
 * worker from going idle. We don't exercise the docx path in these tests, so we
 * mock mammoth at the import boundary: the real module (and bluebird) never
 * loads, and the worker stays leak-free. Same pattern as mocking mcp-handler's
 * session-GC interval and motion's frame loop in vitest.setup.ts. */
vi.mock("mammoth", () => ({
	default: { convertToMarkdown: vi.fn(async () => ({ value: "" })) },
}));

describe("decodeTextDataUrl", () => {
	it("decodes a base64 text data URL to utf-8", () => {
		const b64 = Buffer.from("hello, world", "utf-8").toString("base64");
		expect(decodeTextDataUrl(`data:text/plain;base64,${b64}`)).toBe(
			"hello, world",
		);
	});
});

describe("rowsToMarkdownTable", () => {
	it("renders a GFM table from a 2D array", () => {
		const md = rowsToMarkdownTable([
			["a", "b"],
			["1", "2"],
		]);
		expect(md).toContain("| a | b |");
		expect(md).toContain("| --- | --- |");
		expect(md).toContain("| 1 | 2 |");
	});
});

describe("xlsxToMarkdown (round-trip)", () => {
	it("converts a workbook buffer to markdown tables per sheet", () => {
		const ws = XLSX.utils.aoa_to_sheet([
			["name", "age"],
			["Ada", 36],
		]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "People");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
		const md = xlsxToMarkdown(buf);
		expect(md).toContain("People");
		expect(md).toContain("| name | age |");
		expect(md).toContain("| Ada | 36 |");
	});
});

describe("threshold", () => {
	it("is a fixed constant ~32k chars", () => {
		expect(ATTACHMENT_EXTRACT_CHAR_THRESHOLD).toBeGreaterThanOrEqual(20_000);
	});
});

// ── prepareAttachments orchestration ────────────────────────────────────
//
// A user message carrying file parts; the stubbed ctx lets us assert which
// extraction path each part takes without a model call.

function userMsg(parts: UIMessage["parts"]): UIMessage {
	return { id: "u1", role: "user", parts } as UIMessage;
}

/** A `GenerationContext` stub exposing only the two extraction entry points
 *  `prepareAttachments` calls. Both resolve to a fixed marker so tests can
 *  assert the condensed text reached the message. */
function fakeCtx(extractReturn = "EXTRACTED") {
	return {
		generatePlainText: vi.fn().mockResolvedValue(extractReturn),
		extractFromContent: vi.fn().mockResolvedValue(extractReturn),
	} as unknown as GenerationContext;
}

describe("prepareAttachments", () => {
	it("inlines small text attachments raw (no model call)", async () => {
		const text = "short requirements";
		const b64 = Buffer.from(text, "utf-8").toString("base64");
		const ctx = fakeCtx();
		const out = await prepareAttachments(
			[
				userMsg([
					{ type: "text", text: "build" },
					{
						type: "file",
						filename: "r.txt",
						mediaType: "text/plain",
						url: `data:text/plain;base64,${b64}`,
					},
				]),
			],
			ctx,
		);
		const parts = out.at(-1)?.parts ?? [];
		// The file part is gone — replaced by inlined text.
		expect(parts.some((p) => p.type === "file")).toBe(false);
		expect(
			parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
		).toContain("short requirements");
		expect(ctx.generatePlainText).not.toHaveBeenCalled();
	});

	it("Haiku-extracts large text attachments", async () => {
		const big = "x".repeat(40_000);
		const b64 = Buffer.from(big, "utf-8").toString("base64");
		const ctx = fakeCtx();
		const out = await prepareAttachments(
			[
				userMsg([
					{
						type: "file",
						filename: "big.txt",
						mediaType: "text/plain",
						url: `data:text/plain;base64,${b64}`,
					},
				]),
			],
			ctx,
		);
		expect(ctx.generatePlainText).toHaveBeenCalledOnce();
		const parts = out.at(-1)?.parts ?? [];
		expect(parts.some((p) => p.type === "file")).toBe(false);
		const textPart = parts.find((p) => p.type === "text");
		expect(textPart?.type === "text" ? textPart.text : "").toContain(
			"EXTRACTED",
		);
	});

	it("leaves image attachments untouched", async () => {
		const ctx = fakeCtx();
		const img = {
			type: "file",
			filename: "f.png",
			mediaType: "image/png",
			url: "data:image/png;base64,AAAA",
		} as const;
		const out = await prepareAttachments([userMsg([img])], ctx);
		expect(out.at(-1)?.parts).toContainEqual(img);
		expect(ctx.generatePlainText).not.toHaveBeenCalled();
		expect(ctx.extractFromContent).not.toHaveBeenCalled();
	});

	it("routes large PDFs through extractFromContent", async () => {
		const ctx = fakeCtx();
		const bigPdf = `data:application/pdf;base64,${"A".repeat(60_000)}`;
		const out = await prepareAttachments(
			[
				userMsg([
					{
						type: "file",
						filename: "spec.pdf",
						mediaType: "application/pdf",
						url: bigPdf,
					},
				]),
			],
			ctx,
		);
		expect(ctx.extractFromContent).toHaveBeenCalledOnce();
		expect(out.at(-1)?.parts.some((p) => p.type === "file")).toBe(false);
	});

	it("inlines raw on extraction error (never drops)", async () => {
		const big = "y".repeat(40_000);
		const b64 = Buffer.from(big, "utf-8").toString("base64");
		const ctx = fakeCtx();
		vi.mocked(ctx.generatePlainText).mockRejectedValue(new Error("haiku down"));
		const out = await prepareAttachments(
			[
				userMsg([
					{
						type: "file",
						filename: "big.txt",
						mediaType: "text/plain",
						url: `data:text/plain;base64,${b64}`,
					},
				]),
			],
			ctx,
		);
		const parts = out.at(-1)?.parts ?? [];
		const textPart = parts.find((p) => p.type === "text");
		// Falls back to the raw decoded body — the repeated "y" payload.
		expect(textPart?.type === "text" ? textPart.text : "").toContain("yyyy");
	});
});
