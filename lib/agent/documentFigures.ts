import { fileTypeFromBuffer } from "file-type";
import {
	MODEL_READABLE_IMAGE_MIME_TYPES,
	normalizeMimeType,
} from "@/lib/domain/multimedia";
import type { SubGenerationImage } from "./subGeneration";

// ── Embedded figures (docx) ────────────────────────────────────────────────
//
// mammoth's DEFAULT image converter inlines every embedded image as a base64
// `data:` URI in the markdown TEXT. That is the exact failure this machinery
// replaces: a 2.6 MB design document with a dozen PNGs became a ~900k-token
// prompt that was 96% base64 noise, and the structured call could not produce
// a parseable object (observed in production, 2026-08-04). Instead, each
// embedded image becomes a `<nova:figure index="N"/>` marker at the spot it
// occupied, and the readable images ride the SAME call as native image parts
// (vision tokens, roughly a thousandth of the base64-as-text cost), each
// preceded by a text part naming its marker so the correlation is stated in
// the content rather than left to attachment-order counting.
//
// The marker is deliberately namespaced, never "Figure N" prose: the
// document's OWN captions and cross-references ("Figure 3", "Figure A-2")
// are verbatim content on their own numbering scheme, and a bare "Figure N"
// marker would collide with them the moment any embedded image is uncaptioned
// or decorative. `EXTRACT_SYSTEM` § Figures teaches the model both namespaces
// and forbids reconciling them.

/** Image formats the summarizer reads natively as image parts: the domain's
 *  model-readable subset (`MODEL_READABLE_IMAGE_MIME_TYPES`), so the chat and
 *  extraction can't drift on what the model sees. The provider documents its
 *  vision input set as PNG, JPEG, WEBP, and NON-ANIMATED GIF; animation is
 *  checked separately at collection (`isAnimatedGif`). Anything else a docx
 *  embeds (EMF/WMF vector drawings, TIFF, BMP, which the upload gate accepts
 *  for an app's media) keeps its in-text marker and is reported as
 *  present-but-not-read. */
const MODEL_READABLE_FIGURE_TYPES: ReadonlySet<string> = new Set(
	MODEL_READABLE_IMAGE_MIME_TYPES,
);

/** Attachment caps. Per-figure and whole-document byte bounds keep the
 *  request body sane (base64 inflates bytes by a third), and the count cap
 *  bounds the vision-token spend on a pathological document; a requirements
 *  document's real diagrams sit far inside all three. The count and
 *  total-byte budgets LATCH: once either is spent, every later figure is
 *  omitted as over-budget and its bytes are never read, so a document that
 *  references one large image from thousands of drawing occurrences (mammoth
 *  mints one image element per occurrence) cannot buffer unbounded memory.
 *  Figures past a cap keep their marker and are reported as
 *  present-but-not-read. */
export const MAX_EXTRACT_FIGURES = 24;
export const MAX_EXTRACT_FIGURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXTRACT_FIGURE_TOTAL_BYTES = 20 * 1024 * 1024;

/** Why a collected figure is not attached to the extraction call. */
export type OmittedFigureReason =
	| "unsupported-format"
	| "too-large"
	| "over-attachment-budget"
	| "unreadable";

/** One embedded image occurrence collected during docx conversion, in
 *  document order; `index` is the 1-based marker index. The collector is the
 *  one place attachment verdicts are decided: `omit` records why a figure
 *  will not ride the call, and `bytes` is held ONLY for a figure with no
 *  `omit` (so nothing past the budgets, unreadable, oversized, or in a format
 *  the model can't read ever stays buffered). `byteLength` survives the drop
 *  for reporting. */
export interface DocxFigure {
	index: number;
	/** Canonical sniffed media type when the bytes were read and recognized;
	 *  `""` when unreadable, unrecognizable, or skipped past the budgets. */
	mediaType: string;
	bytes: Buffer;
	byteLength: number;
	/** Trimmed author-supplied alt text, or `null` when the docx has none. */
	altText: string | null;
	/** Collection-time verdict; absent means the figure attaches. */
	omit?: OmittedFigureReason;
}

/** The extraction call's projection of the collector's verdicts: `attached`
 *  entries are ready-to-send image parts (data URL + marker label), `omitted`
 *  entries keep only their marker and are reported as not read. */
export interface FigureAttachmentPlan {
	attached: (SubGenerationImage & { index: number })[];
	omitted: { index: number; reason: OmittedFigureReason }[];
}

/** Minimal XML-attribute escape for the marker's `alt` slot. */
function escapeAttr(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** The namespaced in-text marker for one figure. With alt text the document's
 *  own wording rides along verbatim: `<nova:figure index="3" alt="…"/>`. */
export function figureMarker(index: number, altText?: string | null): string {
	const alt = altText ? ` alt="${escapeAttr(altText)}"` : "";
	return `<nova:figure index="${index}"${alt}/>`;
}

/** Image bytes and descriptive text supplied by the DOCX reader. */
export interface EmbeddedImage {
	contentType?: string;
	altText?: string;
	readAsBuffer(): Promise<Buffer>;
}

/**
 * True when GIF bytes contain more than one image frame, or the block
 * structure can't be walked. Walks the real GIF block layout (extensions and
 * image descriptors with length-prefixed sub-blocks) rather than
 * pattern-matching bytes, so compressed pixel data can't fake a frame
 * boundary. The provider reads only NON-animated GIF, and one bad figure must
 * never fail the whole document's extraction, so anything unprovably still
 * reads as animated and is omitted instead of attached.
 */
export function isAnimatedGif(bytes: Buffer): boolean {
	const at = (i: number): number => bytes[i] ?? -1;
	// Header (6 bytes) + logical screen descriptor (7 bytes).
	if (bytes.length < 13) return true;
	let pos = 13;
	const screenPacked = at(10);
	if (screenPacked & 0x80) pos += 3 * 2 ** ((screenPacked & 0x07) + 1);
	let frames = 0;
	while (pos < bytes.length) {
		const block = at(pos);
		if (block === 0x3b) return frames !== 1; // a complete still GIF has one frame
		if (block === 0x21) {
			// Extension: introducer + label, then sub-blocks to a 0 terminator.
			pos += 2;
			while (pos < bytes.length && at(pos) !== 0) pos += at(pos) + 1;
			pos += 1;
		} else if (block === 0x2c) {
			frames += 1;
			if (frames > 1) return true;
			if (pos + 10 > bytes.length) return true;
			const localPacked = at(pos + 9);
			pos += 10;
			if (localPacked & 0x80) pos += 3 * 2 ** ((localPacked & 0x07) + 1);
			pos += 1; // LZW minimum code size
			while (pos < bytes.length && at(pos) !== 0) pos += at(pos) + 1;
			pos += 1;
		} else {
			return true; // unwalkable structure: don't attach
		}
	}
	return true; // no complete trailer: the stream cannot be proven still
}

/** The stateful figure collector one docx conversion owns: `figures` fills in
 *  document order as mammoth hands `collect` each image occurrence. */
export interface FigureCollector {
	figures: DocxFigure[];
	collect(image: EmbeddedImage): Promise<{ src: string; alt: string }>;
}

/**
 * Create the per-conversion figure collector, split from the mammoth wiring
 * so numbering, sniffing, budget latching, and unreadable-image behavior are
 * unit-testable independently of Mammoth conversion. Every attachment verdict is decided HERE, where it can also bound
 * memory: once the count or total-byte budget latches, later occurrences are
 * recorded without ever reading their bytes; an unreadable, unrecognizable,
 * animated-GIF, or oversized figure records its verdict and drops its buffer
 * immediately. Admission is by SNIFFED bytes (`fileTypeFromBuffer` +
 * `normalizeMimeType`), never the archive-declared content type: mislabeled
 * bytes must be omitted as present-but-not-read, not ride to the provider and
 * fail the whole document's request.
 *
 * `collect` returns the img attributes mammoth should emit: an occurrence identity in `src`. The HTML tree handler resolves it directly
 * to a figure marker; no Markdown image string is searched or replaced.
 */
export function createFigureCollector(): FigureCollector {
	const figures: DocxFigure[] = [];
	let heldCount = 0;
	let heldBytes = 0;
	const record = (
		figure: Omit<DocxFigure, "index">,
	): { src: string; alt: string } => {
		const index = figures.length + 1;
		figures.push({ index, ...figure });
		return { src: String(index), alt: "" };
	};
	return {
		figures,
		async collect(image) {
			const altText = image.altText?.trim() || null;
			const none = Buffer.alloc(0);
			// Budgets latched: nothing later can attach, so skip the read
			// entirely (re-inflating a reused image once per drawing occurrence
			// is the memory the latch exists to bound).
			if (
				heldCount >= MAX_EXTRACT_FIGURES ||
				heldBytes >= MAX_EXTRACT_FIGURE_TOTAL_BYTES
			) {
				return record({
					mediaType: "",
					bytes: none,
					byteLength: 0,
					altText,
					omit: "over-attachment-budget",
				});
			}
			let bytes: Buffer;
			try {
				bytes = await image.readAsBuffer();
			} catch {
				return record({
					mediaType: "",
					bytes: none,
					byteLength: 0,
					altText,
					omit: "unreadable",
				});
			}
			const sniffed = await fileTypeFromBuffer(bytes);
			const mediaType = sniffed ? (normalizeMimeType(sniffed.mime) ?? "") : "";
			if (
				!MODEL_READABLE_FIGURE_TYPES.has(mediaType) ||
				(mediaType === "image/gif" && isAnimatedGif(bytes))
			) {
				return record({
					mediaType,
					bytes: none,
					byteLength: bytes.length,
					altText,
					omit: "unsupported-format",
				});
			}
			if (bytes.length > MAX_EXTRACT_FIGURE_BYTES) {
				return record({
					mediaType,
					bytes: none,
					byteLength: bytes.length,
					altText,
					omit: "too-large",
				});
			}
			if (heldBytes + bytes.length > MAX_EXTRACT_FIGURE_TOTAL_BYTES) {
				// First figure past the byte budget latches it, so no later
				// (even smaller) figure attaches and no later bytes are read.
				heldBytes = MAX_EXTRACT_FIGURE_TOTAL_BYTES;
				return record({
					mediaType,
					bytes: none,
					byteLength: bytes.length,
					altText,
					omit: "over-attachment-budget",
				});
			}
			heldCount += 1;
			heldBytes += bytes.length;
			return record({
				mediaType,
				bytes,
				byteLength: bytes.length,
				altText,
			});
		},
	};
}

/**
 * Project the collector's verdicts into the extraction call's shape:
 * `attached` holds a ready-to-send image part (data URL + the marker label
 * that precedes it in the call) for every figure whose bytes the collector
 * held; `omitted` carries each recorded reason. The verdicts themselves,
 * including the latching budgets, live in `createFigureCollector`, the one
 * place that can also bound what gets buffered.
 */
export function planFigureAttachments(
	figures: DocxFigure[],
): FigureAttachmentPlan {
	const attached: FigureAttachmentPlan["attached"] = [];
	const omitted: FigureAttachmentPlan["omitted"] = [];
	for (const figure of figures) {
		if (figure.omit) {
			omitted.push({ index: figure.index, reason: figure.omit });
		} else {
			attached.push({
				index: figure.index,
				mediaType: figure.mediaType,
				data: `data:${figure.mediaType};base64,${figure.bytes.toString("base64")}`,
				label: figureMarker(figure.index),
			});
		}
	}
	return { attached, omitted };
}

/** Model-facing wording for each omission reason, used by `figuresNote`. */
const OMITTED_REASON_TEXT: Record<OmittedFigureReason, string> = {
	"unsupported-format": "an image format the model can't read",
	"too-large": "too large to attach",
	"over-attachment-budget": "over the attachment budget",
	unreadable: "its image data couldn't be read",
};

/** Ceiling on the omission fragments (`7`, `25-31`) the note spells out;
 *  everything past it collapses into one count. Keeps the note bounded when a
 *  generated document repeats an icon across tens of thousands of drawing
 *  occurrences, which would otherwise rebuild the oversized-prompt failure
 *  this module exists to prevent. */
const MAX_NOTE_FRAGMENTS = 16;

/** Compress sorted marker indexes into range fragments: `[7, 9, 10, 11]` →
 *  `["7", "9-11"]`. Each fragment records how many indexes it covers so the
 *  note's truncation can count what it withheld. */
function indexRangeFragments(
	indexes: number[],
): { label: string; count: number }[] {
	const fragments: { label: string; count: number }[] = [];
	let start = -1;
	let prev = -1;
	const flush = () => {
		if (start === -1) return;
		fragments.push({
			label: start === prev ? String(start) : `${start}-${prev}`,
			count: prev - start + 1,
		});
	};
	for (const index of indexes) {
		if (start === -1) {
			start = index;
		} else if (index !== prev + 1) {
			flush();
			start = index;
		}
		prev = index;
	}
	flush();
	return fragments;
}

/**
 * The figures metadata line(s) for the user turn, or `""` for a document with
 * no embedded images (whose prompt then stays in the plain filename-only
 * shape). States how many figures exist, that markers replaced them in the
 * text, that attached images follow in index order behind their marker
 * labels, and which figures are present but not read. Omissions are named BY
 * MARKER INDEX (the note's opening line defines the marker form), never as
 * prose "figure N", which would collide with the document's own caption
 * numbering; runs compress to ranges and the fragment list is capped.
 */
export function figuresNote(plan: FigureAttachmentPlan): string {
	const total = plan.attached.length + plan.omitted.length;
	if (total === 0) return "";
	const lines: string[] = [];
	if (plan.attached.length > 0) {
		const attachedCount =
			plan.attached.length === total ? "all" : String(plan.attached.length);
		lines.push(
			`Embedded figures: ${total}. Each was replaced in the text by a <nova:figure index="N"/> marker at the spot it occupied; ${attachedCount} attached after the text in index order, each preceded by its marker.`,
		);
	} else {
		lines.push(
			`Embedded figures: ${total}, none attached. Each was replaced in the text by a <nova:figure index="N"/> marker at the spot it occupied.`,
		);
	}
	if (plan.omitted.length > 0) {
		// Group indexes per reason in first-appearance order, compress each
		// group's runs, and stop spelling fragments past the ceiling.
		const byReason = new Map<OmittedFigureReason, number[]>();
		for (const o of plan.omitted) {
			const group = byReason.get(o.reason);
			if (group) group.push(o.index);
			else byReason.set(o.reason, [o.index]);
		}
		const groups: string[] = [];
		let budget = MAX_NOTE_FRAGMENTS;
		let withheld = 0;
		for (const [reason, indexes] of byReason) {
			const fragments = indexRangeFragments(indexes);
			const shown = fragments.slice(0, Math.max(budget, 0));
			withheld += fragments
				.slice(shown.length)
				.reduce((n, f) => n + f.count, 0);
			budget -= shown.length;
			if (shown.length > 0) {
				groups.push(
					`${shown.map((f) => f.label).join(", ")} (${OMITTED_REASON_TEXT[reason]})`,
				);
			}
		}
		const tail =
			withheld > 0
				? `; and ${withheld} more figures are also not attached`
				: "";
		lines.push(
			`Not attached, by marker index: ${groups.join("; ")}${tail}. These are present in the document but were not read.`,
		);
	}
	return lines.join("\n");
}
