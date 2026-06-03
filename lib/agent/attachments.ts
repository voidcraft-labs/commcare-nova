// lib/agent/attachments.ts
//
// The legacy in-request attachment pipeline: file parts arrive as base64 `data:`
// URLs on the last user `UIMessage` and are condensed inline before reaching the
// Solutions Architect. This path is being retired in favor of the media store —
// attachments now upload to per-owner storage and the chat carries asset-id refs
// (see `resolveAttachments`), with the extract computed ONCE at upload and reused.
// Until that lands end to end, this module stays the working chat path.
//
// The extraction CORE (the prompt, the summarizer model/options, the
// office→markdown converters, `extractDocument`) lives in `documentExtraction.ts`
// now; this file imports it and adds only the base64-data-URL routing. The
// re-exports at the bottom keep the existing consumers (the preview script,
// `generationContext`, the attachments test) importing from here until the
// retirement repoints them.
//
// Two invariants the rest of the system depends on:
//   - Never mutate the input messages array (the route reuses `messages`
//     elsewhere); always return a fresh array with a rewritten last message.
//   - Never DROP an attachment. Every failure path (extraction error, unknown
//     type) falls back to inlining the raw/converted text or a human-readable
//     placeholder, so the SA always learns the attachment existed.

import type { UIMessage } from "ai";
import {
	type AttachmentCondenser,
	CONDENSER_MODEL,
	CONDENSER_PROVIDER_OPTIONS,
	type CondenseResult,
	docxToMarkdown,
	EXTRACT_MAX_OUTPUT_TOKENS,
	EXTRACT_SYSTEM,
	rowsToMarkdownTable,
	wrapAttachment,
	xlsxToMarkdown,
} from "./documentExtraction";

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

/** Media types we decode straight to text (no library round-trip needed). */
const TEXT_MEDIA = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"text/tab-separated-values",
]);

const isImage = (mediaType: string): boolean => mediaType.startsWith("image/");

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

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Faithfully condense a text body with the summarizer, returning the labeled
 * extract. EVERY text/office attachment is condensed regardless of size: real
 * attachments (SOWs, contracts, transcripts) are mostly prose with requirements
 * buried in them, so extraction concentrates the signal AND shrinks what Opus
 * re-reads on every tool-loop step — cheaper than inlining the raw doc at any
 * size past a trivial note. On any extraction failure the raw body inlines
 * instead — fidelity over failure, so a transient summarizer outage degrades to
 * "Opus reads the full doc" rather than "the attachment silently vanishes." A
 * truncated extract (hit the output ceiling) passes through WITH a note rather
 * than erroring.
 */
async function condenseText(
	ctx: AttachmentCondenser,
	filename: string,
	body: string,
): Promise<string> {
	try {
		const { text, truncated } = await ctx.generatePlainText({
			system: EXTRACT_SYSTEM,
			// The filename leads the user turn (separated from the body by a blank
			// line so it reads as metadata, not a requirement) — it's the only way
			// the model can fill the prompt's `Source:` line without violating the
			// same prompt's "never invent a value" rule. The body follows verbatim.
			prompt: `Filename: ${filename}\n\n${body}`,
			label: `attachment:${filename}`,
			model: CONDENSER_MODEL,
			providerOptions: CONDENSER_PROVIDER_OPTIONS,
			maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
			// We recover below by inlining the raw body, so a transient summarizer
			// failure must NOT surface a user-facing "generation failed" error.
			emitErrors: false,
		});
		return wrapAttachment(filename, text, truncated);
	} catch {
		// Extraction failed — inline the raw body so the requirement detail
		// still reaches the SA. Costs more tokens this turn but never drops data.
		return wrapAttachment(filename, body);
	}
}

/**
 * Rewrite ONE part of the user turn into model-ready content, BEFORE it reaches
 * Opus. Self-contained per part — the branches share no state, which is what
 * lets `prepareAttachments` run them concurrently:
 *
 *   - Non-file parts (the user's typed text) carry through unchanged.
 *   - Images pass through untouched (Opus does its own vision pass — a text
 *     description would discard the pixels).
 *   - Text / office docs decode to text (docx/xlsx → markdown) and are ALWAYS
 *     condensed via the summarizer — real attachments bury requirements in
 *     prose, so extraction concentrates the signal and shrinks Opus's re-read.
 *   - PDFs ALWAYS go to the summarizer as a NATIVE document block (it reads the
 *     original, preserving layout/structure a flat text decode would lose).
 *   - Oversize files (beyond the byte ceiling) become a placeholder note.
 *
 * Every branch resolves to exactly one replacement part and handles its own
 * failure — a condense failure falls back to raw text / native PDF, a decode
 * failure to a placeholder — so the call never rejects and an attachment is
 * never dropped. A condensed extract that hit the model's output ceiling carries
 * a truncation note (see `wrapAttachment`).
 */
async function prepareUserPart(
	part: UIMessage["parts"][number],
	ctx: AttachmentCondenser,
): Promise<UIMessage["parts"][number]> {
	// Non-file parts (the user's typed text, etc.) carry through unchanged.
	if (part.type !== "file") return part;

	const { mediaType, url } = part;
	const filename = part.filename ?? "attachment";

	// Readable-URL guard. Every processable attachment arrives as a base64
	// `data:` URL (the client reads the staged file into one before sending).
	// Anything else — a `blob:` / `http:` URL that slipped through, e.g. a
	// client-side conversion the CSP blocked — is NOT readable here: base64-
	// decoding it would yield binary noise, and passing a non-data URL through to
	// the model (an image) is just as unreadable. Stop before any decode and hand
	// the SA a clear placeholder, never garbage. This is the never-garble backstop
	// to the client always sending data URLs.
	if (!url.startsWith("data:")) {
		return textPart(
			`<<Attachment ${filename} could not be read — its upload didn't complete. Try attaching it again.>>`,
		);
	}

	// Oversize guard — compare the data-URL length against the byte ceiling
	// scaled for base64 inflation, so we reject without decoding.
	if (url.length > ATTACHMENT_MAX_BYTES * BASE64_INFLATION) {
		return textPart(
			`<<Attachment ${filename} was too large to process. Attach a smaller file or split it into parts.>>`,
		);
	}

	// Images: Opus reads them directly, so pass the part through untouched.
	if (isImage(mediaType)) return part;

	// PDFs: condense via the summarizer as a native document block (no client-side
	// text extraction — it reads the original PDF, preserving layout/structure).
	if (mediaType === "application/pdf") {
		try {
			const { text, truncated } = await ctx.extractFromContent({
				system: EXTRACT_SYSTEM,
				instruction: `Extract every requirement from this document. Filename: ${filename}.`,
				file: { mediaType, data: url },
				label: `attachment:${filename}`,
				model: CONDENSER_MODEL,
				providerOptions: CONDENSER_PROVIDER_OPTIONS,
				maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
				// Recovered below via native PDF pass-through — don't surface a
				// user-facing error for a failure we handle.
				emitErrors: false,
			});
			return textPart(wrapAttachment(filename, text, truncated));
		} catch {
			// Extraction failed — fall back to the native PDF pass-through so
			// Opus still sees the document rather than losing it.
			return part;
		}
	}

	// Text + office formats: decode to text, then condense.
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
		return textPart(await condenseText(ctx, filename, body));
	} catch {
		// Decode/convert failed entirely (corrupt file, wrong type) — leave a
		// placeholder so the SA knows an unreadable attachment was present.
		return textPart(`<<Attachment ${filename} could not be read.>>`);
	}
}

/**
 * Count the attachments on the last user message that `prepareAttachments` will
 * condense — non-image `file` parts. Images pass through untouched and typed
 * text isn't a file, so a turn with none does no condensing work. The chat
 * route uses this to bracket the condense step with `attachment-prep` lifecycle
 * events (the "reading documents" status) ONLY when there is real work to
 * narrate, and to record the document count on the log annotation.
 */
export function countCondensableAttachments(messages: UIMessage[]): number {
	const last = messages.at(-1);
	if (!last || last.role !== "user") return 0;
	return last.parts.filter(
		(part) => part.type === "file" && !isImage(part.mediaType),
	).length;
}

/**
 * Rewrite the last user message's file parts into model-ready content, BEFORE
 * the message reaches Opus — see `prepareUserPart` for the per-attachment
 * routing. Only the last message is touched, and only when it is a user message;
 * every other message and every non-file part is preserved verbatim.
 *
 * Parts are rewritten CONCURRENTLY: each attachment's condense is an independent
 * summarizer call, so a turn carrying N documents waits on the SLOWEST call, not the
 * sum of all of them. `.map` preserves order and `prepareUserPart` always
 * resolves to exactly one part, so `Promise.all` can't reject and an attachment
 * is never dropped.
 *
 * Returns a NEW messages array — the input is never mutated.
 */
export async function prepareAttachments(
	messages: UIMessage[],
	ctx: AttachmentCondenser,
): Promise<UIMessage[]> {
	const last = messages.at(-1);
	if (!last || last.role !== "user") return messages;

	const nextParts = await Promise.all(
		last.parts.map((part) => prepareUserPart(part, ctx)),
	);

	const nextLast: UIMessage = { ...last, parts: nextParts };
	return [...messages.slice(0, -1), nextLast];
}

export type { AttachmentCondenser, CondenseResult };
// ── Back-compat re-exports ──────────────────────────────────────────────────
//
// The extraction core moved to `documentExtraction.ts`; these re-exports keep
// the existing importers (the preview script, `generationContext`, the
// attachments test) resolving through here until the media-store retirement
// repoints them at the new home.
export { CONDENSER_PROVIDER_OPTIONS, rowsToMarkdownTable, xlsxToMarkdown };
