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
// Opus, condensing EVERY non-image document to a faithful requirements extract
// with Gemini 3.5 Flash (the official summarizer). Real attachments (SOWs,
// contracts, transcripts)
// are mostly prose with requirements buried in them, so extracting once strips
// the noise AND shrinks what Opus re-reads on every tool-loop step — denser and
// cheaper than the raw doc at any size worth attaching. The extract, not the raw
// doc, is what Opus and every step re-read. Images always pass through untouched
// for Opus's own vision pass (a text description would discard the pixels).
//
// Two invariants the rest of the system depends on:
//   - Never mutate the input messages array (the route reuses `messages`
//     elsewhere); always return a fresh array with a rewritten last message.
//   - Never DROP an attachment. Every failure path (extraction error, unknown
//     type) falls back to inlining the raw/converted text or a human-readable
//     placeholder, so the SA always learns the attachment existed.

import type { GoogleLanguageModelOptions } from "@ai-sdk/google";
import type { UIMessage } from "ai";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { SubGenerationProviderOptions } from "./subGeneration";

/**
 * One condensing sub-generation's result: the extracted `text`, and whether the
 * model hit its output ceiling (`truncated`). Truncation is an extreme edge —
 * only a document whose faithful extract exceeds the model's max output (64k
 * tokens) — but it must not pass silently: the pipeline appends a note so the SA
 * knows the extract is incomplete rather than treating a cut-off as the whole
 * document (and retrying the same doc to the same dead end).
 */
export interface CondenseResult {
	text: string;
	truncated: boolean;
}

/**
 * The slice of generation capability `prepareAttachments` actually needs: the
 * two condensing sub-generations. Narrowing to this interface (rather than the
 * full `GenerationContext`) is what lets the attachment-preview script drive the
 * exact same orchestration against a swappable model backend — Haiku or Gemini —
 * without constructing a real context (SSE writer, usage accumulator, Firestore).
 * `GenerationContext` satisfies this structurally; the script supplies a tiny
 * backend over `lib/agent/subGeneration.ts`.
 */
export interface AttachmentCondenser {
	generatePlainText(opts: {
		system: string;
		prompt: string;
		label: string;
		model?: string;
		maxOutputTokens?: number;
		providerOptions?: SubGenerationProviderOptions;
		emitErrors?: boolean;
	}): Promise<CondenseResult>;
	extractFromContent(opts: {
		system: string;
		instruction: string;
		file: { mediaType: string; data: string };
		label: string;
		model?: string;
		maxOutputTokens?: number;
		providerOptions?: SubGenerationProviderOptions;
		emitErrors?: boolean;
	}): Promise<CondenseResult>;
}

// ── Tuning constants (not user-configurable) ────────────────────────────
//
// Per Nova's model-config convention, the cost-vs-fidelity dial lives in code,
// not in user settings — there is one correct policy and surfacing it as a
// toggle would only invite misconfiguration.

/**
 * Output ceiling for the condense call, set to the summarizer's MAX output
 * (Gemini 3.5 Flash caps at 64k tokens). This is NOT a cost or effort dial —
 * `maxOutputTokens` is a hard guillotine that chops the response mid-stream when
 * hit; a faithful extract's length tracks the document's actual content, so the
 * only correct value is the model's real ceiling. Lower values would silently
 * truncate legitimate extracts. Truncation at THIS value is the extreme edge
 * handled with a note (see `CondenseResult`). Note Gemini bills thinking tokens
 * as output, so high-reasoning extraction shares this budget with the visible
 * text — another reason to keep the cap at the true maximum.
 */
const EXTRACT_MAX_OUTPUT_TOKENS = 64_000;

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

// ── Summarizer model + provider options ──────────────────────────────────

/**
 * The official document summarizer: Google Gemini 3.5 Flash. Resolved by
 * `GenerationContext.resolveModel` to the Google provider (built from
 * `GOOGLE_GENERATIVE_AI_API_KEY` — a PLATFORM env var, not the shared Anthropic
 * key; condensing is a platform feature, so a missing key fails loud and the
 * pipeline falls back to raw inlining). The preview script reuses the same id +
 * options so what it tests matches production.
 */
const CONDENSER_MODEL = "gemini-3.5-flash";

/**
 * Gemini provider options for the summarizer, both dialed to maximum:
 *   - `thinkingLevel: "high"` — deepest reasoning for the extraction.
 *   - `mediaResolution: "MEDIA_RESOLUTION_HIGH"` — governs how a PDF is
 *     rasterized to image tiles before the model reads it; HIGH preserves small
 *     print, dense tables, and checkbox glyphs in scanned/typeset forms (no
 *     effect on text/office docs, which reach the model as text).
 * Output billing on Gemini includes thinking tokens, so high reasoning is the
 * cost lever here — see `EXTRACT_MAX_OUTPUT_TOKENS`.
 */
export const CONDENSER_PROVIDER_OPTIONS: SubGenerationProviderOptions = {
	google: {
		thinkingConfig: { thinkingLevel: "high" },
		mediaResolution: "MEDIA_RESOLUTION_HIGH",
	} satisfies GoogleLanguageModelOptions,
};

/**
 * System prompt for the extraction step. The contract is FAITHFUL extraction,
 * never summarization: every concrete requirement — fields, options, validation,
 * conditional logic, case relationships, plus non-functional/app-level rules,
 * explicit exclusions, and deferred items — must survive so the Solutions
 * Architect, not the summarizer, owns the translation into CommCare vocabulary. The
 * load-bearing disciplines, all downstream-protecting: enumerate option sets in
 * full (even defined-but-unused ones), keep inline fragments as attributes of
 * their parent field rather than spawning junk fields, record contradictions as
 * [CONFLICT] and omissions (one part needs what another never supplies) as [GAP]
 * instead of resolving either, keep unfilled values as [OPEN] and
 * implied-but-unstated conditionals as [INFERRED] rather than inventing or
 * upgrading anything — resolving ambiguity and reconciling across documents are
 * the architect's job, done later with full context. The filename the model
 * echoes in its `Source:` line is supplied per call in the user turn (never in
 * this cached system prefix); see `condenseText` and the PDF branch of
 * `prepareAttachments`.
 */
const EXTRACT_SYSTEM = `You are a requirements extractor for a CommCare app builder. You receive ONE
document — an email, a contract/SOW, a spreadsheet, a CSV/line-list, or a PDF
form — and output a compact, structured list of every requirement that could
become a form, field/question, case type, validation rule, workflow, user role,
report, or app-level setting. (Images are handled elsewhere; you won't receive them.)

REPRODUCE VERBATIM — never normalize, convert, or rename:
- field/question labels, every enumerated option, units, numeric ranges/limits,
  format or ID patterns, calculated-field formulas, required/optional flags,
  identifiers, and case / parent-child relationships including cardinality (1:many).

ENUMERATE COMPLETELY — the most common miss:
- List every option of every pick-list, dropdown, checkbox group, legend, lookup
  table, or "lists/validation" tab IN FULL — even if no column, field, or row
  currently references it. A defined-but-unused option set is still a requirement.
- When an option appears inline with a follow-up question (e.g.
  "[ ] Episiotomy — repaired? [ ] Yes [ ] No", or "Other ____"), capture BOTH: keep
  the option in its parent's option set AND record the follow-up field. Do not drop
  the option just because it carries a sub-question.
- In spreadsheets, read EVERY sheet/tab, including instruction/README and lookup tabs.

DON'T MIS-SPLIT INLINE FRAGMENTS:
- Treat units, fill-in blanks, "(specify)", "at __:__", and similar fragments as
  attributes of their parent field — not new fields. Never emit a field named after
  a stray word ("at", "of") or a bare unit.
- "(tick one)" → single-select; "(tick all that apply)" → multi-select.

ALSO CAPTURE — commonly dropped:
- Non-functional / app-level: offline/sync, devices/OS, languages, user roles & data
  visibility, scale/performance, data protection/residency, reporting/indicator definitions.
- Negative & scope: anything excluded or forbidden ("do NOT collect X", "must NOT be
  mandatory"), out-of-scope, and deferred/"phase 2" items. Label them; don't delete.
- Rules buried in prose, free-text cells, notes columns, README/instruction tabs, and a
  form's footnotes — mine these for validation rules, flags, exclusions, and skip logic.

PRESERVE, DON'T RESOLVE:
- Conflicts: if two parts of the document disagree — a requirement stated two ways or a
  value that's inconsistent (4 vs 8 visits, kg vs grams, an option list that differs
  between two sections, a data value not in the field's defined list) — record BOTH sides
  and mark [CONFLICT]. Never reconcile, across sections OR documents; that's the architect's job.
- Unknowns: keep "TBD" / "to be confirmed" / a labelled blank as [OPEN]. Never invent a value.

RECONCILE & FLAG GAPS:
- [GAP] means one part of the document requires or names something another part never
  supplies. It is NOT a contradiction (that's [CONFLICT]); it's an omission.
- If the document has a data dictionary, register, or table, scan the narrative for any
  field, option, or rule it mentions but the table omits — include it and mark [GAP]
  (add [OPEN] if its details are unspecified).
- Flag as [GAP]: a report/indicator that needs data no field captures; a referenced list
  ("see Annex B", "...others TBD") that isn't supplied; a calculation whose inputs are absent.
- In sample/data rows, flag any value NOT in the field's defined option list as [CONFLICT],
  keeping the verbatim variant (e.g. "convulsions / fits" vs "convulsions/fits").
- Where a field has no option set defined anywhere, you MAY list the distinct values seen
  in data, marked [INFERRED] — but only when informative; do not list obvious sets
  (M/F, Yes/No, a single observed value) just to list them.

DON'T INVENT:
- Do not add fields, options, roles, reports, validation ranges, or skip logic the
  document does not state. Strip only true noise — greetings, scheduling, pricing/payment,
  legal boilerplate, signatures — UNLESS a sentence encodes a constraint; then keep only
  the constraint.
- Record only skip/show-if logic the document actually indicates (a stated "if X", a
  "(tick one)", layout grouping, or a note). If a conditional is strongly implied but not
  stated, mark it [INFERRED] — do not assert it as a firm requirement.
- Do not upgrade required/optional status the document doesn't give: "record whether…" is
  not "required". If unstated, leave it [OPEN].

OUTPUT:
- Begin with one line: \`Document type: <type> | Source: <filename>\`.
- Compact bullets grouped by source section, form, or case type.
- Tag where useful: [FIELD] [OPTIONS] [VALIDATION] [CALC] [SKIP] [CASE] [WORKFLOW]
  [ROLE] [NFR] [REPORT] [EXCLUDE] [DEFER] [CONFLICT] [GAP] [OPEN] [INFERRED].
- No preamble, no closing summary.`;

/** Media types we decode straight to text (no library round-trip needed). */
const TEXT_MEDIA = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"text/tab-separated-values",
]);

const isImage = (mediaType: string): boolean => mediaType.startsWith("image/");

/** Wrap a document body with a labeled marker so the SA can tell where an
 *  attachment's content begins and which file it came from. When the extract was
 *  cut off at the model's output ceiling, append a note so the SA treats it as
 *  incomplete — and knows the recovery is to ask the user to split the document,
 *  not to retry the same oversized file. */
const wrapAttachment = (
	filename: string,
	body: string,
	truncated = false,
): string => {
	const note = truncated
		? "\n\n<<Note: this extract reached the summarizer's maximum output length, so trailing content from the original document may be missing. If a needed detail seems absent, ask the user to split the document or paste the missing section directly.>>"
		: "";
	return `<<Attachment: ${filename}>>\n${body}${note}`;
};

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
