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
	collectEmbeddedImage,
	type DocxFigure,
	type EmbeddedImage,
	type ExtractDocumentResult,
	type ExtractDocumentStructuredOpts,
	extractDocument,
	figureMarker,
	figuresNote,
	MAX_EXTRACT_FIGURE_BYTES,
	MAX_EXTRACT_FIGURE_TOTAL_BYTES,
	MAX_EXTRACT_FIGURES,
	planFigureAttachments,
} from "@/lib/agent/documentExtraction";

/* mammoth pulls in bluebird, which creates a module-level promise at import
 * time the async-leak detector flags. We exercise the docx path with a mocked
 * mammoth so the real module (and bluebird) never loads. `imgElement` is an
 * identity wrap, so a test's `convertToMarkdown` impl receives the production
 * per-image handler directly via `options.convertImage` and can drive it with
 * fake embedded images. */
vi.mock("mammoth", () => ({
	default: {
		convertToMarkdown: vi.fn(async () => ({
			value: "# Doc heading\n\nbody",
			messages: [],
		})),
		images: { imgElement: (handler: unknown) => handler },
	},
}));

import mammoth from "mammoth";

/** The identity-wrapped per-image handler a test's `convertToMarkdown` impl
 *  receives as `options.convertImage` (see the mammoth mock above). */
type ConvertImageHandler = (
	image: EmbeddedImage,
) => Promise<{ src: string; alt: string }>;

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

	it("replaces docx embedded images with nova:figure markers and attaches the readable ones", async () => {
		const png = Buffer.from("PNGDATA");
		const emf = Buffer.from("EMFDATA");
		// Simulate mammoth: drive the production handler once per embedded image
		// (document order) and emit each returned attribute pair the way the
		// markdown writer would (`![alt](src)`).
		vi.mocked(mammoth.convertToMarkdown).mockImplementationOnce(
			async (_input, options) => {
				const convert = options?.convertImage as unknown as ConvertImageHandler;
				const first = await convert({
					contentType: "image/png",
					altText: "  Referral flow  ",
					readAsBuffer: async () => png,
				});
				const second = await convert({
					contentType: "image/x-emf",
					readAsBuffer: async () => emf,
				});
				return {
					value: `# Doc\n\n![${first.alt}](${first.src})\n\nmore\n\n![${second.alt}](${second.src})`,
					messages: [],
				};
			},
		);

		const { condenser, call } = recordingCondenser();
		const docxBytes = new AdmZip();
		docxBytes.addFile("word/document.xml", Buffer.from("<document/>"));
		await extractDocument({
			bytes: docxBytes.toBuffer(),
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			kind: "docx",
			filename: "design.docx",
			condenser,
		});

		const opts = extractCallOpts(call);
		const prompt = opts.prompt ?? "";
		// Markers land where the images sat, alt text preserved (trimmed) on the
		// in-text marker; no sentinel or base64 residue survives.
		expect(prompt).toContain('<nova:figure index="1" alt="Referral flow"/>');
		expect(prompt).toContain('<nova:figure index="2"/>');
		expect(prompt).not.toContain("nova-figure://");
		expect(prompt).not.toContain(";base64,");
		// The metadata block reports the counts and the unattached EMF figure.
		expect(prompt).toContain("Embedded figures: 2.");
		expect(prompt).toContain("figure 2 (an image format the model can't read)");
		// Only the readable PNG rides as an image, behind its marker label.
		expect(opts.images).toEqual([
			{
				mediaType: "image/png",
				data: `data:image/png;base64,${png.toString("base64")}`,
				label: '<nova:figure index="1"/>',
			},
		]);
	});

	it("keeps the plain filename-only prompt shape for a docx with no embedded images", async () => {
		const { condenser, call } = recordingCondenser();
		const docxBytes = new AdmZip();
		docxBytes.addFile("word/document.xml", Buffer.from("<document/>"));
		await extractDocument({
			bytes: docxBytes.toBuffer(),
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			kind: "docx",
			filename: "plain.docx",
			condenser,
		});
		const opts = extractCallOpts(call);
		expect(opts.prompt).toContain("Filename: plain.docx\n\n# Doc heading");
		expect(opts.images).toBeUndefined();
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

/** A collected figure with test defaults; override what the case exercises. */
function figure(over: Partial<DocxFigure> & { index: number }): DocxFigure {
	return {
		mediaType: "image/png",
		bytes: Buffer.from("data"),
		altText: null,
		...over,
	};
}

describe("collectEmbeddedImage", () => {
	it("numbers figures in collection order, trims alt text, lowercases the media type", async () => {
		const figures: DocxFigure[] = [];
		const first = await collectEmbeddedImage(figures, {
			contentType: "image/PNG",
			altText: "  Flow  ",
			readAsBuffer: async () => Buffer.from("a"),
		});
		const second = await collectEmbeddedImage(figures, {
			readAsBuffer: async () => Buffer.from("b"),
		});
		// The emitted attrs keep the sentinel byte-exact: empty alt on both, so
		// mammoth can't merge the document's own alt text into the image syntax.
		expect(first).toEqual({ src: "nova-figure://1", alt: "" });
		expect(second).toEqual({ src: "nova-figure://2", alt: "" });
		expect(figures).toEqual([
			{
				index: 1,
				mediaType: "image/png",
				bytes: Buffer.from("a"),
				altText: "Flow",
			},
			{ index: 2, mediaType: "", bytes: Buffer.from("b"), altText: null },
		]);
	});

	it("keeps the marker and records empty bytes when the image data can't be read", async () => {
		const figures: DocxFigure[] = [];
		const attrs = await collectEmbeddedImage(figures, {
			contentType: "image/png",
			readAsBuffer: async () => {
				throw new Error("corrupt image part");
			},
		});
		expect(attrs.src).toBe("nova-figure://1");
		expect(figures[0].bytes.length).toBe(0);
	});
});

describe("planFigureAttachments", () => {
	it("attaches readable figures in order with data URLs and marker labels", () => {
		const plan = planFigureAttachments([
			figure({ index: 1, bytes: Buffer.from("one") }),
			figure({ index: 2, mediaType: "image/jpeg", bytes: Buffer.from("two") }),
		]);
		expect(plan.omitted).toEqual([]);
		expect(plan.attached).toEqual([
			{
				index: 1,
				mediaType: "image/png",
				data: `data:image/png;base64,${Buffer.from("one").toString("base64")}`,
				label: '<nova:figure index="1"/>',
			},
			{
				index: 2,
				mediaType: "image/jpeg",
				data: `data:image/jpeg;base64,${Buffer.from("two").toString("base64")}`,
				label: '<nova:figure index="2"/>',
			},
		]);
	});

	it("omits unreadable, unsupported-format, and oversized figures with their reasons", () => {
		const plan = planFigureAttachments([
			figure({ index: 1, bytes: Buffer.alloc(0) }),
			figure({ index: 2, mediaType: "image/x-emf" }),
			figure({ index: 3, bytes: Buffer.alloc(MAX_EXTRACT_FIGURE_BYTES + 1) }),
			figure({ index: 4 }),
		]);
		expect(plan.omitted).toEqual([
			{ index: 1, reason: "unreadable" },
			{ index: 2, reason: "unsupported-format" },
			{ index: 3, reason: "too-large" },
		]);
		expect(plan.attached.map((a) => a.index)).toEqual([4]);
	});

	it("stops attaching past the figure-count cap", () => {
		const figures = Array.from({ length: MAX_EXTRACT_FIGURES + 2 }, (_, i) =>
			figure({ index: i + 1 }),
		);
		const plan = planFigureAttachments(figures);
		expect(plan.attached.length).toBe(MAX_EXTRACT_FIGURES);
		expect(plan.omitted).toEqual([
			{ index: MAX_EXTRACT_FIGURES + 1, reason: "over-attachment-budget" },
			{ index: MAX_EXTRACT_FIGURES + 2, reason: "over-attachment-budget" },
		]);
	});

	it("stops attaching past the total-byte budget", () => {
		// Five figures fill the budget exactly (allowed); the sixth byte tips over.
		const fill = Buffer.alloc(MAX_EXTRACT_FIGURE_TOTAL_BYTES / 5);
		const plan = planFigureAttachments([
			figure({ index: 1, bytes: fill }),
			figure({ index: 2, bytes: fill }),
			figure({ index: 3, bytes: fill }),
			figure({ index: 4, bytes: fill }),
			figure({ index: 5, bytes: fill }),
			figure({ index: 6, bytes: Buffer.from("x") }),
		]);
		expect(plan.attached.map((a) => a.index)).toEqual([1, 2, 3, 4, 5]);
		expect(plan.omitted).toEqual([
			{ index: 6, reason: "over-attachment-budget" },
		]);
	});
});

describe("figureMarker", () => {
	it("emits the bare marker, and escapes alt text on the alt-bearing form", () => {
		expect(figureMarker(3)).toBe('<nova:figure index="3"/>');
		expect(figureMarker(4, 'A <"flow"> & more')).toBe(
			'<nova:figure index="4" alt="A &lt;&quot;flow&quot;&gt; &amp; more"/>',
		);
	});
});

describe("figuresNote", () => {
	it("is empty for a document with no figures", () => {
		expect(figuresNote({ attached: [], omitted: [] })).toBe("");
	});

	it("states the all-attached shape", () => {
		const plan = planFigureAttachments([figure({ index: 1 })]);
		expect(figuresNote(plan)).toBe(
			'Embedded figures: 1. Each was replaced in the text by a <nova:figure index="N"/> marker at the spot it occupied; all attached after the text in index order, each preceded by its marker.',
		);
	});

	it("enumerates unattached figures with reasons, including the none-attached shape", () => {
		const none = planFigureAttachments([
			figure({ index: 1, mediaType: "image/x-wmf" }),
		]);
		expect(figuresNote(none)).toBe(
			[
				'Embedded figures: 1, none attached. Each was replaced in the text by a <nova:figure index="N"/> marker at the spot it occupied.',
				"Not attached: figure 1 (an image format the model can't read). These are present in the document but were not read.",
			].join("\n"),
		);

		const mixed = planFigureAttachments([
			figure({ index: 1 }),
			figure({ index: 2, bytes: Buffer.alloc(0) }),
		]);
		expect(figuresNote(mixed)).toContain("Embedded figures: 2.");
		expect(figuresNote(mixed)).toContain(
			"Not attached: figure 2 (its image data couldn't be read).",
		);
	});
});
