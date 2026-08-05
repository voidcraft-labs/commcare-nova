// lib/agent/__tests__/documentExtraction.test.ts
//
// Unit tests for the extraction CORE: the `extractDocument` dispatch (PDF →
// native file block; text/docx/xlsx → markdown body → text prompt) and the
// pure converters. ONE structured call produces { extract, title, summary }, so
// each test asserts which input shape fired (prompt vs file) and that the call's
// result maps straight through. Driven against a stubbed `AttachmentCondenser` so
// we assert routing + the exact model input WITHOUT a network call. The xlsx path
// round-trips through the real SheetJS encoder so we verify the actual library
// contract, not a hand-rolled mock of its output shape. Figure admission sniffs
// real bytes (`file-type`), so the figure tests use genuine magic-byte fixtures,
// never fake buffers with a declared type.

import AdmZip from "adm-zip";
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
	type AttachmentCondenser,
	createFigureCollector,
	type EmbeddedImage,
	type ExtractDocumentResult,
	type ExtractDocumentStructuredOpts,
	extractDocument,
	type FigureAttachmentPlan,
	figureMarker,
	figuresNote,
	isAnimatedGif,
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

// ── Real image fixtures (admission sniffs bytes, so magic must be genuine) ──

/** A real 1×1 transparent PNG. */
const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

/** A real 1×1 single-frame GIF89a. */
const GIF_STATIC = Buffer.from(
	"R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
	"base64",
);

/** A minimal two-frame GIF89a, built block-by-block: header, logical screen
 *  descriptor (no color table), two image descriptors with one-byte LZW data
 *  sub-blocks, trailer. */
function animatedGif(): Buffer {
	const frame = Buffer.from([
		0x2c,
		0x00,
		0x00,
		0x00,
		0x00,
		0x01,
		0x00,
		0x01,
		0x00,
		0x00, // descriptor
		0x02, // LZW minimum code size
		0x01,
		0x44, // one data sub-block
		0x00, // sub-block terminator
	]);
	return Buffer.concat([
		Buffer.from("GIF89a", "ascii"),
		Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
		frame,
		frame,
		Buffer.from([0x3b]),
	]);
}

/** Bytes no image sniffer recognizes (stands in for EMF/WMF vector parts). */
const JUNK_BYTES = Buffer.from("not an image at all", "utf-8");

/** A pad-to-size PNG: real magic (so the sniff still says image/png) followed
 *  by zero filler, for exercising the byte caps without huge real images. */
function paddedPng(totalBytes: number): Buffer {
	return Buffer.concat([PNG_1PX, Buffer.alloc(totalBytes - PNG_1PX.length)]);
}

/** An `EmbeddedImage` fake whose `readAsBuffer` is a spy, so latch tests can
 *  assert bytes were never read once the budgets are spent. */
function fakeImage(
	bytes: Buffer | (() => never),
	over: Partial<Pick<EmbeddedImage, "contentType" | "altText">> = {},
) {
	const readAsBuffer = vi.fn(async () => {
		if (typeof bytes === "function") return bytes();
		return bytes;
	});
	return {
		image: { ...over, readAsBuffer } satisfies EmbeddedImage,
		readAsBuffer,
	};
}

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

/** A minimal real ZIP that passes the office-archive preflight; mammoth is
 *  mocked, so the entry content never matters to the conversion itself. */
function docxStub(): Buffer {
	const zip = new AdmZip();
	zip.addFile("word/document.xml", Buffer.from("<document/>"));
	return zip.toBuffer();
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
		await extractDocument({
			bytes: docxStub(),
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

	it("replaces docx embedded images with nova:figure markers and attaches the sniff-passing ones", async () => {
		// Simulate mammoth: drive the production handler once per embedded image
		// (document order) and emit each returned attribute pair the way the
		// markdown writer would (`![alt](src)`).
		vi.mocked(mammoth.convertToMarkdown).mockImplementationOnce(
			async (_input, options) => {
				const convert = options?.convertImage as unknown as ConvertImageHandler;
				const first = await convert({
					altText: "  Referral flow  ",
					readAsBuffer: async () => PNG_1PX,
				});
				// Junk bytes DECLARED as png: admission sniffs, so the mislabel is
				// omitted rather than riding to the provider.
				const second = await convert({
					contentType: "image/png",
					readAsBuffer: async () => JUNK_BYTES,
				});
				return {
					value: `# Doc\n\n![${first.alt}](${first.src})\n\nmore\n\n![${second.alt}](${second.src})`,
					messages: [],
				};
			},
		);

		const { condenser, call } = recordingCondenser();
		await extractDocument({
			bytes: docxStub(),
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
		// The metadata block reports the counts and the unattached junk figure by
		// marker index, never as prose "figure N".
		expect(prompt).toContain("Embedded figures: 2.");
		expect(prompt).toContain(
			"Not attached, by marker index: 2 (an image format the model can't read)",
		);
		// Only the sniffed PNG rides as an image, behind its marker label.
		expect(opts.images).toEqual([
			{
				index: 1,
				mediaType: "image/png",
				data: `data:image/png;base64,${PNG_1PX.toString("base64")}`,
				label: '<nova:figure index="1"/>',
			},
		]);
	});

	it("keeps alt text carrying replacement metacharacters and sentinel look-alikes verbatim", async () => {
		vi.mocked(mammoth.convertToMarkdown).mockImplementationOnce(
			async (_input, options) => {
				const convert = options?.convertImage as unknown as ConvertImageHandler;
				// $' is a String.replace substitution pattern (the whole following
				// string); the second figure's alt embeds the FIRST figure's literal
				// sentinel syntax. Neither may corrupt the swap.
				const first = await convert({
					altText: "Revenue $'000",
					readAsBuffer: async () => PNG_1PX,
				});
				const second = await convert({
					altText: "see ![](nova-figure://1) above",
					readAsBuffer: async () => PNG_1PX,
				});
				return {
					value: `intro\n\n![${first.alt}](${first.src})\n\nmiddle\n\n![${second.alt}](${second.src})\n\ntail`,
					messages: [],
				};
			},
		);

		const { condenser, call } = recordingCondenser();
		await extractDocument({
			bytes: docxStub(),
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			kind: "docx",
			filename: "dollar.docx",
			condenser,
		});

		const prompt = extractCallOpts(call).prompt ?? "";
		// $-patterns ride verbatim: no spliced document tail, single occurrences.
		expect(prompt).toContain('<nova:figure index="1" alt="Revenue $\'000"/>');
		expect(prompt.match(/middle/g)).toHaveLength(1);
		expect(prompt.match(/tail/g)).toHaveLength(1);
		// The sentinel look-alike inside marker 2's alt is NOT rewritten (the
		// swap never rescans its own output), and marker 1 appears exactly once.
		expect(prompt).toContain('alt="see ![](nova-figure://1) above"');
		expect(prompt.match(/<nova:figure index="1"/g)).toHaveLength(1);
	});

	it("keeps the plain filename-only prompt shape for a docx with no embedded images", async () => {
		const { condenser, call } = recordingCondenser();
		await extractDocument({
			bytes: docxStub(),
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

describe("isAnimatedGif", () => {
	it("reads a real single-frame GIF as still and a two-frame GIF as animated", () => {
		expect(isAnimatedGif(GIF_STATIC)).toBe(false);
		expect(isAnimatedGif(animatedGif())).toBe(true);
	});

	it("treats unwalkable GIF structure as animated (never attach what can't be proven still)", () => {
		expect(isAnimatedGif(Buffer.from("GIF89a then garbage"))).toBe(true);
		expect(isAnimatedGif(Buffer.alloc(4))).toBe(true);
	});
});

describe("createFigureCollector", () => {
	it("numbers figures in order, trims alt text, and admits by SNIFFED type over the declared one", async () => {
		const collector = createFigureCollector();
		// Declared bmp, real PNG bytes: the sniff wins and the figure attaches.
		const first = await collector.collect(
			fakeImage(PNG_1PX, { contentType: "image/bmp", altText: "  Flow  " })
				.image,
		);
		const second = await collector.collect(fakeImage(GIF_STATIC).image);
		expect(first).toEqual({ src: "nova-figure://1", alt: "" });
		expect(second).toEqual({ src: "nova-figure://2", alt: "" });
		expect(collector.figures).toEqual([
			{
				index: 1,
				mediaType: "image/png",
				bytes: PNG_1PX,
				byteLength: PNG_1PX.length,
				altText: "Flow",
			},
			{
				index: 2,
				mediaType: "image/gif",
				bytes: GIF_STATIC,
				byteLength: GIF_STATIC.length,
				altText: null,
			},
		]);
	});

	it("omits mislabeled bytes, animated GIFs, unreadable images, and oversized figures without holding their bytes", async () => {
		const collector = createFigureCollector();
		await collector.collect(
			fakeImage(JUNK_BYTES, { contentType: "image/png" }).image,
		);
		await collector.collect(fakeImage(animatedGif()).image);
		await collector.collect(
			fakeImage(() => {
				throw new Error("corrupt image part");
			}).image,
		);
		await collector.collect(
			fakeImage(paddedPng(MAX_EXTRACT_FIGURE_BYTES + 1)).image,
		);
		expect(
			collector.figures.map((f) => ({
				omit: f.omit,
				held: f.bytes.length > 0,
				byteLength: f.byteLength,
			})),
		).toEqual([
			{
				omit: "unsupported-format",
				held: false,
				byteLength: JUNK_BYTES.length,
			},
			{
				omit: "unsupported-format",
				held: false,
				byteLength: animatedGif().length,
			},
			{ omit: "unreadable", held: false, byteLength: 0 },
			{
				omit: "too-large",
				held: false,
				byteLength: MAX_EXTRACT_FIGURE_BYTES + 1,
			},
		]);
	});

	it("latches the count budget and stops reading bytes entirely", async () => {
		const collector = createFigureCollector();
		for (let i = 0; i < MAX_EXTRACT_FIGURES; i += 1) {
			await collector.collect(fakeImage(PNG_1PX).image);
		}
		const past = fakeImage(PNG_1PX);
		await collector.collect(past.image);
		expect(past.readAsBuffer).not.toHaveBeenCalled();
		const last = collector.figures.at(-1);
		expect(last?.omit).toBe("over-attachment-budget");
		expect(collector.figures.filter((f) => !f.omit)).toHaveLength(
			MAX_EXTRACT_FIGURES,
		);
	});

	it("latches the byte budget: after the first over-budget figure, later smaller figures never attach or read", async () => {
		const collector = createFigureCollector();
		// Five figures fill 19.5 MB, inside every cap.
		const fill = paddedPng(MAX_EXTRACT_FIGURE_TOTAL_BYTES / 5 - 100_000);
		for (let i = 0; i < 5; i += 1) {
			await collector.collect(fakeImage(fill).image);
		}
		// This one busts the total budget: omitted, and the budget latches.
		await collector.collect(fakeImage(paddedPng(1_000_000)).image);
		// A tiny figure that WOULD fit the remaining slack under first-fit:
		// never read, still omitted (the latch is the documented contract).
		const tiny = fakeImage(PNG_1PX);
		await collector.collect(tiny.image);
		expect(tiny.readAsBuffer).not.toHaveBeenCalled();
		expect(collector.figures.map((f) => f.omit)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"over-attachment-budget",
			"over-attachment-budget",
		]);
	});
});

describe("planFigureAttachments", () => {
	it("projects held figures into labeled data-URL parts and passes omission reasons through", async () => {
		const collector = createFigureCollector();
		await collector.collect(fakeImage(PNG_1PX, { altText: "Flow" }).image);
		await collector.collect(
			fakeImage(JUNK_BYTES, { contentType: "image/png" }).image,
		);
		const plan = planFigureAttachments(collector.figures);
		expect(plan.attached).toEqual([
			{
				index: 1,
				mediaType: "image/png",
				data: `data:image/png;base64,${PNG_1PX.toString("base64")}`,
				label: '<nova:figure index="1"/>',
			},
		]);
		expect(plan.omitted).toEqual([{ index: 2, reason: "unsupported-format" }]);
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

/** Build a plan literal for note tests without running a collector. */
function planOf(
	attachedIndexes: number[],
	omitted: FigureAttachmentPlan["omitted"],
): FigureAttachmentPlan {
	return {
		attached: attachedIndexes.map((index) => ({
			index,
			mediaType: "image/png",
			data: "data:image/png;base64,AAAA",
			label: figureMarker(index),
		})),
		omitted,
	};
}

describe("figuresNote", () => {
	it("is empty for a document with no figures", () => {
		expect(figuresNote(planOf([], []))).toBe("");
	});

	it("states the all-attached shape", () => {
		expect(figuresNote(planOf([1], []))).toBe(
			'Embedded figures: 1. Each was replaced in the text by a <nova:figure index="N"/> marker at the spot it occupied; all attached after the text in index order, each preceded by its marker.',
		);
	});

	it("names unattached figures by marker index with reasons, including the none-attached shape", () => {
		const none = figuresNote(
			planOf([], [{ index: 1, reason: "unsupported-format" }]),
		);
		expect(none).toBe(
			[
				'Embedded figures: 1, none attached. Each was replaced in the text by a <nova:figure index="N"/> marker at the spot it occupied.',
				"Not attached, by marker index: 1 (an image format the model can't read). These are present in the document but were not read.",
			].join("\n"),
		);

		const mixed = figuresNote(
			planOf([1], [{ index: 2, reason: "unreadable" }]),
		);
		expect(mixed).toContain("Embedded figures: 2.");
		expect(mixed).toContain(
			"Not attached, by marker index: 2 (its image data couldn't be read).",
		);
	});

	it("compresses omission runs into ranges grouped by reason", () => {
		const omitted: FigureAttachmentPlan["omitted"] = [
			{ index: 2, reason: "unsupported-format" },
			...Array.from({ length: 16 }, (_, i) => ({
				index: 25 + i,
				reason: "over-attachment-budget" as const,
			})),
			{ index: 50, reason: "over-attachment-budget" },
		];
		const note = figuresNote(planOf([1], omitted));
		expect(note).toContain(
			"Not attached, by marker index: 2 (an image format the model can't read); 25-40, 50 (over the attachment budget).",
		);
	});

	it("caps the spelled-out fragments and counts the rest instead of enumerating them", () => {
		// Alternating singleton omissions never form ranges: 40 fragments, so the
		// cap kicks in and the tail is counted, keeping the note bounded however
		// many drawing occurrences a generated document holds.
		const omitted: FigureAttachmentPlan["omitted"] = Array.from(
			{ length: 40 },
			(_, i) => ({
				index: 2 * i + 1,
				reason: "over-attachment-budget" as const,
			}),
		);
		const note = figuresNote(planOf([], omitted));
		expect(note).toContain("; and 24 more figures are also not attached.");
		// 16 spelled fragments, not 40.
		expect(note.match(/\d+ \(over the attachment budget\)/g)).toHaveLength(1);
		expect((note.match(/, \d+/g) ?? []).length).toBeLessThanOrEqual(16);
	});
});
