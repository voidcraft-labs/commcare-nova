// lib/agent/attachments.ts
//
// Server-side attachment-preparation pipeline. The interactive builder lets a
// user attach requirements documents (txt/md/csv, docx, xlsx, pdf, images) to a
// chat turn. Those arrive as `file` parts on the last user `UIMessage`. Left
// alone, a large document's full text would ride into the Solutions Architect's
// Opus context and be re-read at full input rate on EVERY tool-loop step (the
// SA can take dozens of steps per turn) — a multi-megabyte spec would dominate
// the per-run cost and crowd the context window.
//
// `prepareAttachments` rewrites those file parts BEFORE the message reaches
// Opus, condensing large documents to a faithful requirements extract with the
// cheap Haiku model. The dial is fidelity-vs-cost: small documents inline raw
// (perfect fidelity, negligible tokens); large ones are extracted once by Haiku
// and the extract — not the raw doc — is what Opus and every tool-loop step
// re-read. Images always pass through untouched for Opus's own vision pass.
//
// Two invariants the rest of the system depends on:
//   - Never mutate the input messages array (the route reuses `messages`
//     elsewhere); always return a fresh array with a rewritten last message.
//   - Never DROP an attachment. Every failure path (extraction error, unknown
//     type) falls back to inlining the raw/converted text or a human-readable
//     placeholder, so the SA always learns the attachment existed.

import type { UIMessage } from "ai";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { GenerationContext } from "./generationContext";

// ── Tuning constants (not user-configurable) ────────────────────────────
//
// Per Nova's model-config convention, the cost-vs-fidelity dial lives in code,
// not in user settings — there is one correct policy and surfacing it as a
// toggle would only invite misconfiguration.

/**
 * Above this many extracted characters (~8k tokens at ~4 chars/token), condense
 * the document with Haiku; below it, inline the raw text for perfect fidelity.
 * Set well above a typical short note so small attachments never pay a model
 * round-trip, but low enough that a real multi-page spec gets condensed before
 * it inflates the Opus context across the tool loop.
 */
export const ATTACHMENT_EXTRACT_CHAR_THRESHOLD = 32_000;

/**
 * Hard ceiling on a single decoded attachment. Above this we refuse to process
 * the file rather than risk Cloud Run's request-memory and body-size limits on
 * a runaway upload. This is defense-in-depth BEHIND the client's PromptInput
 * `maxFileSize` — the client should reject first, but the server must not trust
 * the client to have done so.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * A base64 payload is ~1.37× the size of the bytes it encodes (4 output chars
 * per 3 input bytes). A `data:` URL's string length is therefore a cheap proxy
 * for the decoded byte size — we compare the URL length against the byte
 * ceiling scaled by this factor to avoid decoding an oversize payload just to
 * measure it.
 */
const BASE64_INFLATION = 1.37;

// ── Extraction prompt ────────────────────────────────────────────────────

/** Haiku model id — the cheap model used for faithful document condensation.
 *  Lives in lib/models.ts pricing; named here as the extraction policy's model. */
const HAIKU = "claude-haiku-4-5-20251001";

/**
 * System prompt for the extraction step. The goal is FAITHFUL condensation, not
 * summarization: every concrete requirement that could become a form, field,
 * case type, validation rule, or workflow must survive verbatim, because the
 * Solutions Architect — not Haiku — owns the translation into CommCare
 * vocabulary. Haiku's only job is to strip prose and boilerplate while
 * preserving the structured detail the SA needs.
 */
const EXTRACT_SYSTEM =
	"You are a requirements extractor for a CommCare app builder. Given a document, " +
	"reproduce EVERY requirement that could become a form, field, case type, validation rule, " +
	"or workflow: preserve all field names, enumerated options, units, validation constraints, " +
	"conditional logic, and case/parent-child relationships VERBATIM. Strip only prose, " +
	"boilerplate, and formatting. Do NOT invent, summarize away detail, or normalize to CommCare " +
	"vocabulary — that is the architect's job. Output compact bulleted structure grouped by section.";

/** Media types we decode straight to text (no library round-trip needed). */
const TEXT_MEDIA = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"text/tab-separated-values",
]);

const isImage = (mediaType: string): boolean => mediaType.startsWith("image/");

/** Wrap a document body with a labeled marker so the SA can tell where an
 *  attachment's content begins and which file it came from. */
const wrapAttachment = (filename: string, body: string): string =>
	`<<Attachment: ${filename}>>\n${body}`;

/** Build a text `UIMessage` part. */
const textPart = (text: string): UIMessage["parts"][number] => ({
	type: "text",
	text,
});

// ── Pure conversion helpers ────────────────────────────────────────────────

/** Decode the base64 payload of a `data:` URL to a utf-8 string. */
export function decodeTextDataUrl(url: string): string {
	const comma = url.indexOf(",");
	const b64 = comma >= 0 ? url.slice(comma + 1) : url;
	return Buffer.from(b64, "base64").toString("utf-8");
}

/** Decode the base64 payload of a `data:` URL to a Buffer (for binary office
 *  formats that the conversion libraries unzip). */
export function decodeBinaryDataUrl(url: string): Buffer {
	const comma = url.indexOf(",");
	const b64 = comma >= 0 ? url.slice(comma + 1) : url;
	return Buffer.from(b64, "base64");
}

/**
 * Render a 2D string array as a GitHub-flavored markdown table. The first row
 * is the header; a separator row follows. An empty input yields an empty
 * string (a sheet with no rows contributes nothing).
 */
export function rowsToMarkdownTable(rows: string[][]): string {
	if (rows.length === 0) return "";
	const header = rows[0];
	const separator = header.map(() => "---");
	const body = rows.slice(1);
	const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
	return [line(header), line(separator), ...body.map(line)].join("\n");
}

/** docx buffer → markdown. mammoth maps Word styles (headings, lists, tables)
 *  to clean markdown structure, which preserves the document's outline far
 *  better than a flat text extraction. */
export async function docxToMarkdown(buffer: Buffer): Promise<string> {
	const { value } = await mammoth.convertToMarkdown({ buffer });
	return value;
}

/**
 * xlsx buffer → one markdown table per sheet, each prefixed with the sheet
 * name as a heading. `sheet_to_json` with `header: 1` returns each row as an
 * array of cell values; `raw: false` formats cells as display strings and
 * `defval: ""` fills gaps so ragged rows still align into a table.
 */
export function xlsxToMarkdown(buffer: Buffer): string {
	const workbook = XLSX.read(buffer, { type: "buffer" });
	return workbook.SheetNames.map((name) => {
		const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], {
			header: 1,
			blankrows: false,
			defval: "",
			raw: false,
		});
		// Cells come through typed as the worksheet's stored values; coerce each
		// to a string so the markdown renderer receives a uniform 2D string grid.
		const grid = rows.map((row) => row.map((cell) => String(cell)));
		return `### ${name}\n\n${rowsToMarkdownTable(grid)}`;
	}).join("\n\n");
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Faithfully condense a long text body with Haiku, returning the labeled
 * extract. Bodies below the threshold inline raw (no model call). On any
 * extraction failure the raw body inlines instead — fidelity over failure, so
 * a transient Haiku outage degrades to "Opus reads the full doc" rather than
 * "the attachment silently vanishes."
 */
async function condenseText(
	ctx: GenerationContext,
	filename: string,
	body: string,
): Promise<string> {
	if (body.length < ATTACHMENT_EXTRACT_CHAR_THRESHOLD) {
		return wrapAttachment(filename, body);
	}
	try {
		const extracted = await ctx.generatePlainText({
			system: EXTRACT_SYSTEM,
			prompt: body,
			label: `attachment:${filename}`,
			model: HAIKU,
			maxOutputTokens: 16_000,
		});
		return wrapAttachment(filename, extracted);
	} catch {
		// Extraction failed — inline the raw body so the requirement detail
		// still reaches the SA. Costs more tokens this turn but never drops data.
		return wrapAttachment(filename, body);
	}
}

/**
 * Rewrite the last user message's file parts into model-ready content under a
 * cost budget, BEFORE the message reaches Opus.
 *
 *   - Images pass through untouched (Opus does its own vision pass).
 *   - Text / office docs decode to text, then condense via Haiku if large or
 *     inline raw if small.
 *   - Large PDFs go to Haiku as a NATIVE document block (we don't decode PDF
 *     text ourselves — Haiku reads the original, preserving layout/structure);
 *     small PDFs pass through for Opus to read natively.
 *   - Oversize files (beyond the byte ceiling) become a human-readable
 *     placeholder note instead of being processed.
 *
 * Returns a NEW messages array — the input is never mutated. Only the last
 * message is touched, and only when it is a user message with file parts;
 * every other message and non-file part is preserved verbatim.
 */
export async function prepareAttachments(
	messages: UIMessage[],
	ctx: GenerationContext,
): Promise<UIMessage[]> {
	const last = messages.at(-1);
	if (!last || last.role !== "user") return messages;

	const nextParts: UIMessage["parts"] = [];
	for (const part of last.parts) {
		// Non-file parts (the user's typed text, etc.) carry through unchanged.
		if (part.type !== "file") {
			nextParts.push(part);
			continue;
		}

		const { mediaType, url } = part;
		const filename = part.filename ?? "attachment";

		// Oversize guard — compare the data-URL length against the byte ceiling
		// scaled for base64 inflation, so we reject without decoding.
		if (url.length > ATTACHMENT_MAX_BYTES * BASE64_INFLATION) {
			nextParts.push(
				textPart(
					`<<Attachment ${filename} was too large to process. Attach a smaller file or split it into parts.>>`,
				),
			);
			continue;
		}

		// Images: Opus reads them directly, so pass the part through untouched.
		if (isImage(mediaType)) {
			nextParts.push(part);
			continue;
		}

		// PDFs: condense large ones via Haiku as a native document block (no
		// client-side text extraction — Haiku reads the original). Small PDFs
		// pass through for Opus to read natively. URL length is a byte proxy.
		if (mediaType === "application/pdf") {
			const isLarge = url.length > ATTACHMENT_EXTRACT_CHAR_THRESHOLD;
			if (!isLarge) {
				nextParts.push(part);
				continue;
			}
			try {
				const extracted = await ctx.extractFromContent({
					system: EXTRACT_SYSTEM,
					instruction: `Extract every requirement from this document (${filename}).`,
					file: { mediaType, data: url },
					label: `attachment:${filename}`,
					model: HAIKU,
					maxOutputTokens: 16_000,
				});
				nextParts.push(textPart(wrapAttachment(filename, extracted)));
			} catch {
				// Extraction failed — fall back to the native PDF pass-through so
				// Opus still sees the document rather than losing it.
				nextParts.push(part);
			}
			continue;
		}

		// Text + office formats: decode to text, then condense-or-inline.
		try {
			let body: string;
			if (TEXT_MEDIA.has(mediaType)) {
				body = decodeTextDataUrl(url);
			} else if (
				mediaType.includes("wordprocessingml") ||
				filename.endsWith(".docx")
			) {
				body = await docxToMarkdown(decodeBinaryDataUrl(url));
			} else if (
				mediaType.includes("spreadsheetml") ||
				filename.endsWith(".xlsx")
			) {
				body = xlsxToMarkdown(decodeBinaryDataUrl(url));
			} else {
				// An unknown non-image type slipped past the client's accept
				// allowlist: best-effort text decode rather than a hard refusal.
				body = decodeTextDataUrl(url);
			}
			nextParts.push(textPart(await condenseText(ctx, filename, body)));
		} catch {
			// Decode/convert failed entirely (corrupt file, wrong type) — leave a
			// placeholder so the SA knows an unreadable attachment was present.
			nextParts.push(textPart(`<<Attachment ${filename} could not be read.>>`));
		}
	}

	const nextLast: UIMessage = { ...last, parts: nextParts };
	return [...messages.slice(0, -1), nextLast];
}
