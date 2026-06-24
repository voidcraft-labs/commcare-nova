// lib/agent/__tests__/documentExtraction.test.ts
//
// Unit tests for the extraction CORE: the `extractDocument` dispatch (PDF →
// native file block; text/docx/xlsx → markdown body → text prompt) and the
// pure converters. ONE structured call produces { extract, title, summary }, so
// each test asserts which input shape fired (prompt vs file) and that the call's
// result maps straight through. Driven against a stubbed `AttachmentCondenser` so
// we assert routing + the exact model input WITHOUT a network call. The xlsx path
// round-trips through the real SheetJS encoder so we verify the actual library
// contract, not a hand-rolled mock of its output shape.

import AdmZip from "adm-zip";
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
	type AttachmentCondenser,
	type ExtractDocumentResult,
	type ExtractDocumentStructuredOpts,
	extractDocument,
} from "@/lib/agent/documentExtraction";

/* mammoth pulls in bluebird, which creates a module-level promise at import
 * time the async-leak detector flags. We exercise the docx path with a mocked
 * mammoth so the real module (and bluebird) never loads. */
vi.mock("mammoth", () => ({
	default: {
		convertToMarkdown: vi.fn(async () => ({ value: "# Doc heading\n\nbody" })),
	},
}));

/** A condenser that records the single structured call it received and returns a
 *  fixed `{ object, truncated }`, so each test asserts which input shape fired and
 *  with what. `vi.fn` can't express the generic method signature directly, so the
 *  slot is cast; the returned `call` ref stays typed for `mock.calls` assertions. */
function recordingCondenser(
	object: ExtractDocumentResult | null = {
		extract: "EXTRACT",
		title: "A Title",
		summary: "A summary.",
	},
	truncated = false,
) {
	const call = vi.fn(
		async (_opts: ExtractDocumentStructuredOpts<ExtractDocumentResult>) => ({
			object,
			truncated,
		}),
	);
	const condenser: AttachmentCondenser = {
		extractDocumentStructured:
			call as unknown as AttachmentCondenser["extractDocumentStructured"],
	};
	return { condenser, call };
}

/** The opts of the single `extractDocumentStructured` call, or a clear failure. */
function extractCallOpts(call: ReturnType<typeof recordingCondenser>["call"]) {
	const c = call.mock.calls.at(0);
	if (!c) throw new Error("extractDocumentStructured was not called");
	return c[0];
}

describe("extractDocument", () => {
	it("routes a text document through one structured call with the filename + body", async () => {
		const { condenser, call } = recordingCondenser();
		const result = await extractDocument({
			bytes: Buffer.from("danger signs: bleeding, fever", "utf-8"),
			mimeType: "text/markdown",
			kind: "text",
			filename: "notes.md",
			condenser,
		});
		// The single call's object maps straight through to the result.
		expect(result).toEqual({
			extract: "EXTRACT",
			truncated: false,
			title: "A Title",
			summary: "A summary.",
		});
		expect(call).toHaveBeenCalledTimes(1);
		const opts = extractCallOpts(call);
		// Text path: a `prompt` (no `file`) carrying the filename then the body.
		expect(opts.file).toBeUndefined();
		expect(opts.prompt).toContain("Filename: notes.md");
		expect(opts.prompt).toContain("danger signs: bleeding, fever");
	});

	it("converts an xlsx document to a markdown table before condensing", async () => {
		const ws = XLSX.utils.aoa_to_sheet([
			["field", "type"],
			["mother_name", "text"],
		]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Dictionary");
		const bytes = XLSX.write(wb, {
			type: "buffer",
			bookType: "xlsx",
		}) as Buffer;

		const { condenser, call } = recordingCondenser();
		await extractDocument({
			bytes,
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			kind: "xlsx",
			filename: "dict.xlsx",
			condenser,
		});
		const prompt = extractCallOpts(call).prompt ?? "";
		expect(prompt).toContain("Dictionary");
		expect(prompt).toContain("| field | type |");
		expect(prompt).toContain("| mother_name | text |");
	});

	it("converts a docx document via mammoth before condensing", async () => {
		const { condenser, call } = recordingCondenser();
		// A real (minimal) ZIP so the office-archive preflight passes; mammoth is
		// mocked, so the entry content is irrelevant to the conversion itself.
		const docxBytes = new AdmZip();
		docxBytes.addFile("word/document.xml", Buffer.from("<document/>"));
		await extractDocument({
			bytes: docxBytes.toBuffer(),
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			kind: "docx",
			filename: "sow.docx",
			condenser,
		});
		const prompt = extractCallOpts(call).prompt ?? "";
		expect(prompt).toContain("Filename: sow.docx");
		expect(prompt).toContain("# Doc heading");
	});

	it("routes a PDF through one structured call as a native data-URL file block", async () => {
		const bytes = Buffer.from("%PDF-1.7 fake", "utf-8");
		const { condenser, call } = recordingCondenser();
		await extractDocument({
			bytes,
			mimeType: "application/pdf",
			kind: "pdf",
			filename: "form.pdf",
			condenser,
		});
		const opts = extractCallOpts(call);
		// PDF path: a native `file` block (no decoded `prompt`).
		expect(opts.prompt).toBeUndefined();
		expect(opts.file).toEqual({
			mediaType: "application/pdf",
			data: `data:application/pdf;base64,${bytes.toString("base64")}`,
		});
	});

	it("carries title + summary from the single structured call", async () => {
		const { condenser } = recordingCondenser({
			extract: "THE EXTRACT BODY",
			title: "ANC Requirements",
			summary: "What it covers.",
		});
		const result = await extractDocument({
			bytes: Buffer.from("x"),
			mimeType: "text/plain",
			kind: "text",
			filename: "spec.txt",
			condenser,
		});
		expect(result.extract).toBe("THE EXTRACT BODY");
		expect(result.title).toBe("ANC Requirements");
		expect(result.summary).toBe("What it covers.");
	});

	it("fails the extraction (output-ceiling message) when a truncated call yields no object", async () => {
		const { condenser } = recordingCondenser(null, true);
		await expect(
			extractDocument({
				bytes: Buffer.from("x"),
				mimeType: "text/plain",
				kind: "text",
				filename: "big.txt",
				condenser,
			}),
		).rejects.toThrow(/output ceiling/);
	});

	it("fails the extraction (no-parseable-result message) when a non-truncated call yields no object", async () => {
		const { condenser } = recordingCondenser(null, false);
		await expect(
			extractDocument({
				bytes: Buffer.from("x"),
				mimeType: "text/plain",
				kind: "text",
				filename: "spec.txt",
				condenser,
			}),
		).rejects.toThrow(/no parseable result/);
	});

	it("repairs a double-escaped extract returned by the summarizer", async () => {
		// The over-escape failure: the whole extract is one physical line where
		// newlines are the literal characters `\` `n` and quotes are `\` `"`.
		const { condenser } = recordingCondenser({
			extract: '## Conflicts\\n* A \\"wildcard\\" rule.\\n* Second bullet.',
			title: "T",
			summary: "S.",
		});
		const result = await extractDocument({
			bytes: Buffer.from("x"),
			mimeType: "text/plain",
			kind: "text",
			filename: "big.xlsx",
			condenser,
		});
		expect(result.extract).toBe(
			'## Conflicts\n* A "wildcard" rule.\n* Second bullet.',
		);
	});
});
