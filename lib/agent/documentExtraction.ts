// lib/agent/documentExtraction.ts
//
// The requirements-extraction core: bytes of ONE document in, a faithful
// requirements extract out. This is the single home for the extraction prompt,
// the summarizer model + options, the office→markdown converters, and the
// `extractDocument` entry point. Two callers drive it:
//
//   - the upload-time extract route (`/api/media/[assetId]/extract`), via the
//     standalone `createGeminiCondenser()` — a separate request, off the chat
//     run, so it builds its own provider-bound condenser;
//   - the chat resolve step's lazy backstop, via the live `GenerationContext`
//     (which satisfies `AttachmentCondenser` and tracks the call's usage).
//
// It is deliberately pure of HTTP + Firestore: the extract store
// (`documentExtractionStore`) owns loading the bytes and persisting the result.
// Storing the extract once (keyed by content hash +
// `EXTRACTOR_VERSION`) and reusing it every turn is what keeps a multi-page spec
// from being re-condensed — or re-billed at the Opus input rate across dozens of
// tool-loop steps — on every send.

import {
	createGoogleGenerativeAI,
	type GoogleLanguageModelOptions,
} from "@ai-sdk/google";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { z } from "zod";
import type { DocumentKind } from "@/lib/domain/multimedia";
import {
	extractFromContentWith,
	generateObjectWith,
	generatePlainTextWith,
	type SubGenerationProviderOptions,
} from "./subGeneration";

// `EXTRACTOR_VERSION` lives in `@/lib/domain/multimedia` (beside the extract key
// + status it versions) so the pure key helper `extractObjectKeyForAsset` can be
// imported without dragging this module's office-parsing libraries (mammoth/
// xlsx) into a caller's graph. Bump it there on any prompt/model/conversion
// change here.

/**
 * One condensing sub-generation's result: the extracted `text`, and whether the
 * model hit its output ceiling (`truncated`). Truncation is an extreme edge —
 * only a document whose faithful extract exceeds the model's max output (64k
 * tokens) — but it must not pass silently: the chat resolve step appends a note
 * so the SA knows the extract is incomplete rather than treating a cut-off as
 * the whole document (and retrying the same doc to the same dead end).
 */
export interface CondenseResult {
	text: string;
	truncated: boolean;
}

/**
 * What `extractDocument` returns: the faithful `extract` (the text the SA reads)
 * and whether it was `truncated`, plus an OPTIONAL `title` / `summary` from a
 * separate structured pass over the extract. Title/summary are best-effort —
 * absent when that pass fails — and exist for a future "browse my attachments"
 * tool to scan attachments without opening each one; the SA reading path uses
 * only `extract`.
 */
export interface ExtractResult {
	extract: string;
	truncated: boolean;
	title?: string;
	summary?: string;
}

/** Options for the structured pass (`generateStructured`): a system prompt, the
 *  text `prompt` (the already-produced extract), and the Zod `schema` to fill. */
export interface GenerateStructuredOpts<T> {
	system: string;
	prompt: string;
	schema: z.ZodType<T>;
	label: string;
	model?: string;
	maxOutputTokens?: number;
	providerOptions?: SubGenerationProviderOptions;
}

/**
 * The slice of generation capability extraction needs. Narrowing to this
 * interface (rather than the full `GenerationContext`) is what lets BOTH the
 * standalone Gemini condenser (the upload route) and the live `GenerationContext`
 * (the chat lazy backstop) drive the exact same orchestration.
 * `GenerationContext` satisfies this structurally; `createGeminiCondenser` builds
 * a tiny backend over `subGeneration.ts`.
 *
 * `generatePlainText` / `extractFromContent` produce the (free-form) extract;
 * `generateStructured` produces the small `{ title, summary }` over that extract
 * — a SEPARATE method so the extract is never routed through constrained
 * decoding, which both risks a weaker extract and, on a large document,
 * truncates the whole object into something unparseable.
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
	/** Structured pass over an extract. Returns `null` when the model can't
	 *  produce a valid object — the caller treats the fields as unavailable. */
	generateStructured<T>(opts: GenerateStructuredOpts<T>): Promise<T | null>;
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
 * handled with a note. Note Gemini bills thinking tokens as output, so
 * high-reasoning extraction shares this budget with the visible text — another
 * reason to keep the cap at the true maximum.
 */
export const EXTRACT_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Safety bound for reading a stored extract back out of GCS. An extract is
 * bounded above by `EXTRACT_MAX_OUTPUT_TOKENS` (~256 KB of UTF-8 text in the
 * worst case), so 4 MB is generous headroom; the cap exists only so a corrupted
 * or oversized object can't pull unbounded bytes into a request's memory.
 */
export const EXTRACT_MAX_BYTES = 4 * 1024 * 1024;

// ── Summarizer model + provider options ──────────────────────────────────

/**
 * The official document summarizer: Google Gemini 3.5 Flash. The standalone
 * condenser builds it from `GOOGLE_GENERATIVE_AI_API_KEY` — a PLATFORM env var,
 * not the shared Anthropic key; extraction is a platform feature, so a missing
 * key fails loud rather than silently degrading. The preview script reuses the
 * same id + options so what it tests matches production.
 */
export const CONDENSER_MODEL = "gemini-3.5-flash";

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
 * this cached system prefix); see `extractDocument`.
 */
export const EXTRACT_SYSTEM = `You are a requirements extractor for a CommCare app builder. You receive ONE
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

OUTPUT — Markdown, structured by SECTIONS rather than per-line tags:
- Begin with one line: \`Document type: <type> | Source: <filename>\`.
- Group everything under \`##\` headings that follow the document's own structure
  (each form, each case type, app-level requirements, out-of-scope, annexes).
  Put MANY items under one heading — never a heading per item.
- Under each heading, one compact bullet per requirement, carrying its full
  detail: label, every option enumerated in full, ranges/limits, required vs
  optional, and any rule. The bullet's own words say what it is.
- Do NOT label the TYPE of each line — no [FIELD] / [OPTIONS] / [VALIDATION] /
  [CALC] / [SKIP] / [CASE] / [WORKFLOW] / [ROLE] / [NFR] / [REPORT]. The heading
  plus the bullet's wording already convey that; a tag on every line wastes space
  and tells the reader nothing new. Put out-of-scope and deferred items under an
  "Out of scope" / "Deferred" heading instead of tagging each one.
- DO keep these SEMANTIC flags inline, ONLY on the items they apply to — they are
  sparse and load-bearing: [CONFLICT] (two parts of the document disagree), [GAP]
  (one part needs what another never supplies), [OPEN] (an unfilled / TBD value),
  [INFERRED] (implied but not stated). Never drop these.
- No preamble, no closing summary.`;

// ── Title + summary (the decoupled structured pass) ──────────────────────────

/**
 * The structured `{ title, summary }` produced by a SECOND small call over the
 * already-produced extract. Decoupled from the extract on purpose: the extract
 * stays free-form (so constrained decoding can't weaken it, and a huge document
 * only loses its tail), while title/summary — which a future "browse my
 * attachments" tool reads to scan attachments without opening each extract —
 * come from a structured call rather than by parsing the extract's markdown.
 */
export const extractMetaSchema = z.object({
	title: z
		.string()
		.describe(
			'A short, human title for the document — what it IS, in roughly ten words or fewer (e.g. "ANC Program — Data Collection Requirements"). No filename, no surrounding quotes.',
		),
	summary: z
		.string()
		.describe(
			"Two to four sentences in plain prose (no markdown): what this document is and what it covers, enough for someone to judge whether it's the one they need WITHOUT opening the full extract.",
		),
});
export type ExtractMeta = z.infer<typeof extractMetaSchema>;

/** System prompt for the title/summary pass. It runs over the EXTRACT, not the
 *  raw document, so it's cheap and can't truncate the way a giant raw file can.
 *  Triage, not re-extraction — and faithful to the extract (invent no scope). */
export const EXTRACT_META_SYSTEM = `You are labeling a requirements extract for a CommCare app builder so it can be browsed without being opened. Given the extract, produce a short title and a brief summary of what the document contains. Be faithful to the extract — never invent scope it doesn't mention. The summary is for triage ("is this the document I need?"), not a re-extraction.`;

/** Output ceiling for the title/summary pass. A title plus a few sentences sits
 *  far under this even with the model's thinking tokens, so — unlike the extract
 *  — it does not truncate; a failure here just leaves title/summary absent. */
const EXTRACT_META_MAX_OUTPUT_TOKENS = 8_000;

// ── Pure conversion helpers ────────────────────────────────────────────────

/**
 * Wrap an extract with a labeled marker so the SA can tell where an
 * attachment's content begins and which file it came from. When the extract was
 * cut off at the model's output ceiling, append a note so the SA treats it as
 * incomplete — and knows the recovery is to ask the user to split the document,
 * not to retry the same oversized file. Applied at chat-resolve time (not at
 * extraction time), so the STORED extract stays raw and the preview's "What the
 * AI reads" tab shows the requirements list without this delimiter.
 */
export function wrapAttachment(
	filename: string,
	body: string,
	truncated = false,
): string {
	const note = truncated
		? "\n\n<<Note: this extract reached the summarizer's maximum output length, so trailing content from the original document may be missing. If a needed detail seems absent, ask the user to split the document or paste the missing section directly.>>"
		: "";
	return `<<Attachment: ${filename}>>\n${body}${note}`;
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

// ── Extraction entry point ────────────────────────────────────────────────

/**
 * Extract ONE document into an `ExtractResult` — the faithful `extract` text the
 * SA reads (no chat-context framing; the resolve step wraps it with the
 * `<<Attachment: …>>` marker + any truncation note) PLUS a best-effort
 * `{ title, summary }`. Two passes:
 *
 *   1. The extract (FREE-FORM). PDF → a NATIVE document block (the model reads
 *      the original, preserving layout a flat decode would lose); text/docx/xlsx
 *      → decode to markdown (docx via mammoth, xlsx via SheetJS, text verbatim),
 *      then condense.
 *   2. Title + summary — a separate small STRUCTURED pass over the extract. It's
 *      decoupled so the extract is never routed through constrained decoding; a
 *      failure there leaves title/summary absent (the extract is already in hand).
 *
 * Throws only if the EXTRACT pass fails — the caller decides how to handle it:
 * the upload route records a `failed` status; the chat lazy backstop falls back
 * to inlining the raw document so the requirement detail still reaches the SA.
 * The title/summary pass never throws out of here (it resolves to `null`).
 */
export async function extractDocument(opts: {
	bytes: Buffer;
	mimeType: string;
	kind: DocumentKind;
	filename: string;
	condenser: AttachmentCondenser;
}): Promise<ExtractResult> {
	const { bytes, mimeType, kind, filename, condenser } = opts;

	// 1. The faithful extract — free-form (see the JSDoc).
	let condensed: CondenseResult;
	if (kind === "pdf") {
		condensed = await condenser.extractFromContent({
			system: EXTRACT_SYSTEM,
			instruction: `Extract every requirement from this document. Filename: ${filename}.`,
			file: {
				mediaType: mimeType,
				data: `data:${mimeType};base64,${bytes.toString("base64")}`,
			},
			label: `extract:${filename}`,
			model: CONDENSER_MODEL,
			providerOptions: CONDENSER_PROVIDER_OPTIONS,
			maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
			// The caller (route / backstop) owns the failure path; don't surface a
			// user-facing generation error from inside the condenser.
			emitErrors: false,
		});
	} else {
		const body =
			kind === "docx"
				? await docxToMarkdown(bytes)
				: kind === "xlsx"
					? xlsxToMarkdown(bytes)
					: bytes.toString("utf-8");
		condensed = await condenser.generatePlainText({
			system: EXTRACT_SYSTEM,
			// The filename leads the user turn (separated from the body by a blank
			// line so it reads as metadata, not a requirement) — it's the only way
			// the model can fill the prompt's `Source:` line without violating the
			// same prompt's "never invent a value" rule. The body follows verbatim.
			prompt: `Filename: ${filename}\n\n${body}`,
			label: `extract:${filename}`,
			model: CONDENSER_MODEL,
			providerOptions: CONDENSER_PROVIDER_OPTIONS,
			maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
			emitErrors: false,
		});
	}

	// 2. Title + summary — a separate small structured pass over the extract just
	//    produced. Best-effort: a `null` object (the model couldn't produce a valid
	//    one) OR a thrown transport error both leave title/summary absent. The
	//    extract is already in hand and must never be discarded over a metadata
	//    failure. The guard lives HERE, not only inside a condenser, so the JSDoc's
	//    "never throws out of here" contract holds for EVERY `AttachmentCondenser`:
	//    `GenerationContext`'s swallows its own errors, but the Gemini condenser
	//    surfaces the non-`NoObjectGenerated` re-throw that `generateObjectWith`
	//    deliberately propagates (a transient network/auth/5xx on the meta call).
	let meta: ExtractMeta | null = null;
	try {
		meta = await condenser.generateStructured<ExtractMeta>({
			system: EXTRACT_META_SYSTEM,
			prompt: condensed.text,
			schema: extractMetaSchema,
			label: `extract-meta:${filename}`,
			model: CONDENSER_MODEL,
			maxOutputTokens: EXTRACT_META_MAX_OUTPUT_TOKENS,
		});
	} catch {
		// Swallowed deliberately: the extract succeeded; title/summary stay absent.
	}

	return {
		extract: condensed.text,
		truncated: condensed.truncated,
		title: meta?.title,
		summary: meta?.summary,
	};
}

/**
 * The production document condenser: a `gemini-3.5-flash`-bound
 * `AttachmentCondenser` over the provider-agnostic `subGeneration` helpers.
 * Built per call (cheap) by the upload-time extract route, which runs OUTSIDE a
 * chat `GenerationContext` and so needs its own provider-bound backend.
 *
 * Fails loud if `GOOGLE_GENERATIVE_AI_API_KEY` is unset — extraction is a
 * platform feature, not something to silently skip. It ignores the `model`/
 * `label`/`emitErrors` opts (those are `GenerationContext`-isms): the model is
 * pre-bound here, there's no SSE to emit to, and `truncated` is derived from the
 * sub-generation's `finishReason`.
 */
export function createGeminiCondenser(): AttachmentCondenser {
	const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	if (!apiKey) {
		throw new Error(
			"GOOGLE_GENERATIVE_AI_API_KEY is unset — document feature extraction needs the Gemini summarizer key. Set it in the environment so uploaded documents can be condensed into the requirements extract the assistant reads.",
		);
	}
	const model = createGoogleGenerativeAI({ apiKey })(CONDENSER_MODEL);
	return {
		async generatePlainText(args) {
			const r = await generatePlainTextWith({
				model,
				system: args.system,
				prompt: args.prompt,
				maxOutputTokens: args.maxOutputTokens,
				providerOptions: args.providerOptions,
			});
			return { text: r.text, truncated: r.finishReason === "length" };
		},
		async extractFromContent(args) {
			const r = await extractFromContentWith({
				model,
				system: args.system,
				instruction: args.instruction,
				file: args.file,
				maxOutputTokens: args.maxOutputTokens,
				providerOptions: args.providerOptions,
			});
			return { text: r.text, truncated: r.finishReason === "length" };
		},
		async generateStructured<T>(
			args: GenerateStructuredOpts<T>,
		): Promise<T | null> {
			const r = await generateObjectWith<T>({
				model,
				system: args.system,
				prompt: args.prompt,
				schema: args.schema,
				maxOutputTokens: args.maxOutputTokens,
				providerOptions: args.providerOptions,
			});
			return r.object;
		},
	};
}
