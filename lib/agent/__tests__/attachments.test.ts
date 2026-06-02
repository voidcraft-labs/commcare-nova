// lib/agent/__tests__/attachments.test.ts
//
// Unit tests for the attachment-preparation pipeline. This file covers two
// layers:
//
//  1. The pure conversion helpers (`decodeTextDataUrl`, `rowsToMarkdownTable`,
//     `xlsxToMarkdown`). These need no model and run synchronously — the office
//     helpers round-trip through the real SheetJS encoder so we verify against
//     the actual library contract, not a hand-rolled mock of its output shape.
//  2. `prepareAttachments` orchestration, driven against a stubbed
//     `AttachmentCondenser` so we assert the branching (condense every text/PDF,
//     image pass-through, truncation note, error fallback) without a network call.

import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
	type AttachmentCondenser,
	decodeTextDataUrl,
	prepareAttachments,
	rowsToMarkdownTable,
	xlsxToMarkdown,
} from "@/lib/agent/attachments";

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

// ── prepareAttachments orchestration ────────────────────────────────────
//
// A user message carrying file parts; the stubbed condenser lets us assert which
// path each part takes without a model call.

function userMsg(parts: UIMessage["parts"]): UIMessage {
	return { id: "u1", role: "user", parts } as UIMessage;
}

/** An `AttachmentCondenser` stub exposing the two entry points
 *  `prepareAttachments` calls. Both resolve to a fixed `CondenseResult` so tests
 *  can assert the condensed text reached the message and exercise the truncation
 *  branch. */
function fakeCtx(text = "EXTRACTED", truncated = false): AttachmentCondenser {
	const result = { text, truncated };
	return {
		generatePlainText: vi.fn().mockResolvedValue(result),
		extractFromContent: vi.fn().mockResolvedValue(result),
	} as unknown as AttachmentCondenser;
}

describe("prepareAttachments", () => {
	it("condenses every text attachment — even a tiny one", async () => {
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
		// Every text/office doc is condensed regardless of size — there is no
		// inline-raw-if-small path.
		expect(ctx.generatePlainText).toHaveBeenCalledOnce();
		expect(parts.some((p) => p.type === "file")).toBe(false);
		expect(
			parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
		).toContain("EXTRACTED");
		// The filename leads the user turn (so the prompt's `Source:` line can be
		// filled without inventing a value) and the decoded body follows it.
		const promptArg = vi.mocked(ctx.generatePlainText).mock.calls[0][0].prompt;
		expect(promptArg).toContain("Filename: r.txt");
		expect(promptArg).toContain(text);
	});

	it("notes a truncated extract instead of passing it off as complete", async () => {
		const b64 = Buffer.from("requirements", "utf-8").toString("base64");
		const ctx = fakeCtx("EXTRACTED", true); // model hit the output ceiling
		const out = await prepareAttachments(
			[
				userMsg([
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
		const text = (out.at(-1)?.parts ?? [])
			.map((p) => (p.type === "text" ? p.text : ""))
			.join("");
		expect(text).toContain("EXTRACTED");
		expect(text).toContain("maximum output length");
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

	it("routes PDFs of any size through extractFromContent (no native pass-through)", async () => {
		const ctx = fakeCtx();
		// A PDF of any size is condensed via extractFromContent — there is no
		// native pass-through on the happy path.
		const smallPdf = `data:application/pdf;base64,${"A".repeat(100)}`;
		const out = await prepareAttachments(
			[
				userMsg([
					{
						type: "file",
						filename: "spec.pdf",
						mediaType: "application/pdf",
						url: smallPdf,
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

	it("falls back to the native PDF on extraction error (never drops)", async () => {
		const ctx = fakeCtx();
		vi.mocked(ctx.extractFromContent).mockRejectedValue(
			new Error("haiku down"),
		);
		const pdf = {
			type: "file",
			filename: "spec.pdf",
			mediaType: "application/pdf",
			url: `data:application/pdf;base64,${"A".repeat(100)}`,
		} as const;
		const out = await prepareAttachments([userMsg([pdf])], ctx);
		// The PDF path's fallback re-emits the ORIGINAL file part (so Opus reads it
		// natively) rather than dropping it — distinct from the text path's
		// raw-text inline.
		expect(out.at(-1)?.parts).toContainEqual(pdf);
	});

	it("replaces an oversize attachment with a placeholder (never drops)", async () => {
		const ctx = fakeCtx();
		// A data URL whose length exceeds the byte ceiling × base64 inflation
		// (10MB × 1.37 ≈ 14.4M chars) — the guard sizes off the URL length, so no
		// real decoded payload is needed.
		const huge = `data:text/plain;base64,${"A".repeat(15 * 1024 * 1024)}`;
		const out = await prepareAttachments(
			[
				userMsg([
					{
						type: "file",
						filename: "huge.txt",
						mediaType: "text/plain",
						url: huge,
					},
				]),
			],
			ctx,
		);
		const parts = out.at(-1)?.parts ?? [];
		expect(ctx.generatePlainText).not.toHaveBeenCalled();
		expect(parts.some((p) => p.type === "file")).toBe(false);
		expect(
			parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
		).toContain("too large");
	});
});
