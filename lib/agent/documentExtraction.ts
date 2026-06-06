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
	generateObjectWith,
	type SubGenerationProviderOptions,
} from "./subGeneration";

// `EXTRACTOR_VERSION` lives in `@/lib/domain/multimedia` (beside the extract key
// + status it versions) so the pure key helper `extractObjectKeyForAsset` can be
// imported without dragging this module's office-parsing libraries (mammoth/
// xlsx) into a caller's graph. Bump it there on any prompt/model/conversion
// change here.

/**
 * What `extractDocument` returns: the faithful `extract` (the text the SA reads),
 * plus a `title` and `summary` describing it. All three come from ONE structured
 * call (see `extractDocument`). `title`/`summary` are typed optional only because
 * older stored extracts (produced before they existed) lack them and a failed
 * extraction has none; a fresh successful extract always carries both. `truncated`
 * is retained for the stored shape but is always `false` on a fresh extract — a
 * structured result is complete by construction (a truncated one is unparseable,
 * so extraction fails rather than returning a partial). `title`/`summary` feed a
 * future "browse my attachments" tool; the SA reading path uses only `extract`.
 */
export interface ExtractResult {
	extract: string;
	truncated: boolean;
	title?: string;
	summary?: string;
}

/**
 * Options for the one structured extraction call. The document arrives either as
 * decoded text (`prompt`, for text/docx/xlsx) or as a native file block (`file` +
 * `instruction`, for a PDF the model reads directly). `schema` is the
 * `{ extract, title, summary }` shape the model fills.
 */
export interface ExtractDocumentStructuredOpts<T> {
	system: string;
	prompt?: string;
	file?: { mediaType: string; data: string };
	instruction?: string;
	schema: z.ZodType<T>;
	label: string;
	model?: string;
	maxOutputTokens?: number;
	providerOptions?: SubGenerationProviderOptions;
	/** When false, a failure is logged but NOT surfaced as a user-facing generation
	 *  error — extraction's callers (the upload route, the chat backstop) own the
	 *  failure path. The error is still thrown so the caller's catch runs. */
	emitErrors?: boolean;
}

/** The one structured call's result: the filled `object` (or `null` when the
 *  model couldn't produce a valid one — truncation or a malformed response) and
 *  whether it hit the output ceiling. */
export interface StructuredExtractResult<T> {
	object: T | null;
	truncated: boolean;
}

/**
 * The slice of generation capability extraction needs. Narrowing to this
 * interface (rather than the full `GenerationContext`) is what lets BOTH the
 * standalone Gemini condenser (the upload route) and the live `GenerationContext`
 * (the chat lazy backstop) drive the exact same orchestration. `GenerationContext`
 * satisfies this structurally; `createGeminiCondenser` builds a tiny backend over
 * `subGeneration.ts`.
 *
 * ONE method, ONE model call: it fills `{ extract, title, summary }` from the
 * document in a single structured generation — the model writes the extract first
 * (schema field order), then names + summarizes what it just produced.
 */
export interface AttachmentCondenser {
	extractDocumentStructured<T>(
		opts: ExtractDocumentStructuredOpts<T>,
	): Promise<StructuredExtractResult<T>>;
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

The \`extract\` FIELD — Markdown, structured by SECTIONS rather than per-line tags:
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
- No preamble, no closing summary.

After the \`extract\`, fill the \`title\` and \`summary\` fields — written AFTER, from
the extract you just produced: \`title\` is a short human name for the document
(what it IS, ~ten words or fewer, no filename); \`summary\` is two to four
plain-prose sentences (no markdown) for triage — enough to judge whether this is
the document someone needs. Both describe the extract faithfully; invent no scope
it doesn't contain.`;

// ── The structured extraction result ─────────────────────────────────────────

/**
 * The ONE structured object the extraction call fills. Field ORDER is
 * load-bearing: a provider's controlled generation emits properties in schema
 * order, so `extract` FIRST means the model does the bulk of the work — the
 * faithful extract — and only THEN writes `title`/`summary` from what it just
 * produced. That yields a better title/summary than guessing up front, and means
 * any output-ceiling truncation lands in the trailing title/summary (the least
 * costly place to lose) rather than mid-extract. The extract's content rules live
 * in `EXTRACT_SYSTEM`; the per-field `.describe()`s carry the title/summary guidance.
 */
export const extractDocumentSchema = z.object({
	extract: z
		.string()
		.describe(
			"The faithful requirements extract as GitHub-flavored Markdown, following the OUTPUT rules in the system instructions exactly: sectioned under ## headings, every label / option / rule reproduced verbatim and enumerated in full, with the sparse [CONFLICT] / [GAP] / [OPEN] / [INFERRED] flags kept inline.",
		),
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
export type ExtractDocumentResult = z.infer<typeof extractDocumentSchema>;

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
 * Pull the formula cells from a worksheet, in reading order (row-major). Returns
 * one `{ addr, formula }` per cell carrying a formula (`cell.f`, which SheetJS
 * stores without the leading `=`); value-only cells are skipped. `sheet_to_json`
 * reports only the COMPUTED value, so without this pass the calculation logic —
 * totals, scores, unit conversions, derived dates — is dropped on the floor, and
 * that logic is exactly what the SA should rebuild as CommCare calculated fields.
 */
function collectSheetFormulae(
	ws: XLSX.WorkSheet,
): { addr: string; formula: string }[] {
	const ref = ws["!ref"];
	if (!ref) return [];
	const range = XLSX.utils.decode_range(ref);
	const formulae: { addr: string; formula: string }[] = [];
	for (let r = range.s.r; r <= range.e.r; r++) {
		for (let c = range.s.c; c <= range.e.c; c++) {
			const addr = XLSX.utils.encode_cell({ r, c });
			const cell = ws[addr] as XLSX.CellObject | undefined;
			if (cell?.f) formulae.push({ addr, formula: cell.f });
		}
	}
	return formulae;
}

/**
 * xlsx buffer → one markdown section per sheet: the sheet name as a heading, the
 * cell VALUES as a table, and — when the sheet has any — a `#### Calculations`
 * block listing each formula cell (`<addr> = <formula>`). `sheet_to_json` with
 * `header: 1` returns each row as an array of cell values; `raw: false` formats
 * cells as display strings and `defval: ""` fills gaps so ragged rows still
 * align into a table. The values table carries only computed results, so the
 * Calculations block is what preserves the derivation logic for the SA; the
 * table directly above it grounds each formula's A1 cell references.
 * `cellFormula: true` (SheetJS's read default, set explicitly) is what keeps the
 * formulas on `cell.f` for `collectSheetFormulae` to read.
 */
export function xlsxToMarkdown(buffer: Buffer): string {
	const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: true });
	return workbook.SheetNames.map((name) => {
		const ws = workbook.Sheets[name];
		const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
			header: 1,
			blankrows: false,
			defval: "",
			raw: false,
		});
		// Cells come through typed as the worksheet's stored values; coerce each
		// to a string so the markdown renderer receives a uniform 2D string grid.
		const grid = rows.map((row) => row.map((cell) => String(cell)));
		// Append the formula list only when the sheet has one, so value-only
		// sheets stay clean. The h4 nests under the sheet's h3 heading.
		const formulae = collectSheetFormulae(ws);
		const calculations = formulae.length
			? `\n\n#### Calculations\n\n${formulae
					.map(({ addr, formula }) => `- ${addr} = ${formula}`)
					.join("\n")}`
			: "";
		return `### ${name}\n\n${rowsToMarkdownTable(grid)}${calculations}`;
	}).join("\n\n");
}

// ── Extraction entry point ────────────────────────────────────────────────

/**
 * Extract ONE document into an `ExtractResult` — the faithful `extract` text the
 * SA reads (no chat-context framing; the resolve step wraps it with the
 * `<<Attachment: …>>` marker), plus a `title` and `summary`, all from a SINGLE
 * structured model call:
 *
 *   - PDF → a NATIVE document block (the model reads the original, preserving
 *     layout a flat decode would lose); text/docx/xlsx → decode to markdown
 *     (docx via mammoth, xlsx via SheetJS, text verbatim), then condense.
 *   - The model fills `extractDocumentSchema` in field order — `extract` first
 *     (the bulk of the work), then `title`/`summary` from what it just produced.
 *
 * Throws when the call yields no parseable object (a transport error propagates;
 * a `null` object — truncation past the output ceiling, or a malformed response —
 * is turned into a thrown error here). There's no partial extract to salvage from
 * a structured call, so the caller treats this as a failed extraction: the upload
 * route records a `failed` status; the chat lazy backstop falls back to inlining
 * the raw document so the requirement detail still reaches the SA.
 */
export async function extractDocument(opts: {
	bytes: Buffer;
	mimeType: string;
	kind: DocumentKind;
	filename: string;
	condenser: AttachmentCondenser;
}): Promise<ExtractResult> {
	const { bytes, mimeType, kind, filename, condenser } = opts;

	// ONE structured call produces { extract, title, summary } together. A PDF
	// rides as a native document block; text/docx/xlsx decode to markdown first.
	// The caller (route / backstop) owns the failure path, so `emitErrors: false`
	// keeps a generation error from surfacing to the user from in here.
	let result: StructuredExtractResult<ExtractDocumentResult>;
	if (kind === "pdf") {
		result = await condenser.extractDocumentStructured({
			system: EXTRACT_SYSTEM,
			file: {
				mediaType: mimeType,
				data: `data:${mimeType};base64,${bytes.toString("base64")}`,
			},
			instruction: `Extract every requirement from this document. Filename: ${filename}.`,
			schema: extractDocumentSchema,
			label: `extract:${filename}`,
			model: CONDENSER_MODEL,
			providerOptions: CONDENSER_PROVIDER_OPTIONS,
			maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
			emitErrors: false,
		});
	} else {
		const body =
			kind === "docx"
				? await docxToMarkdown(bytes)
				: kind === "xlsx"
					? xlsxToMarkdown(bytes)
					: bytes.toString("utf-8");
		result = await condenser.extractDocumentStructured({
			system: EXTRACT_SYSTEM,
			// The filename leads the user turn (separated from the body by a blank
			// line so it reads as metadata, not a requirement) — it's the only way
			// the model can fill the prompt's `Source:` line without violating the
			// same prompt's "never invent a value" rule. The body follows verbatim.
			prompt: `Filename: ${filename}\n\n${body}`,
			schema: extractDocumentSchema,
			label: `extract:${filename}`,
			model: CONDENSER_MODEL,
			providerOptions: CONDENSER_PROVIDER_OPTIONS,
			maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
			emitErrors: false,
		});
	}

	// A `null` object means no parseable result. The common cause is truncation —
	// the extract + title + summary together overran the output ceiling, leaving
	// the JSON cut off. A structured call has no partial to salvage, so this is a
	// failed extraction: throw, and the caller records `failed` / inlines the raw
	// document.
	if (!result.object) {
		throw new Error(
			result.truncated
				? `Extraction of "${filename}" hit the summarizer's output ceiling before it could finish — the document is too large to extract in one pass. Ask the user to split it into smaller documents.`
				: `Extraction of "${filename}" produced no parseable result from the summarizer. Retry, or ask the user to re-save the document in a supported format.`,
		);
	}

	return {
		extract: result.object.extract,
		title: result.object.title,
		summary: result.object.summary,
		// A parsed structured object is complete by construction (a truncated one is
		// unparseable → thrown above), so a successful extract is never partial.
		truncated: false,
	};
}

/**
 * The production document condenser: a `gemini-3.5-flash`-bound
 * `AttachmentCondenser` over the provider-agnostic `subGeneration` helpers.
 * Built per call (cheap) by the upload-time extract route, which runs OUTSIDE a
 * chat `GenerationContext` and so needs its own provider-bound backend.
 *
 * Fails loud if `GOOGLE_GENERATIVE_AI_API_KEY` is unset — extraction is a
 * platform feature, not something to silently skip. It ignores the `model` /
 * `label` / `emitErrors` opts (those are `GenerationContext`-isms): the model is
 * pre-bound here and there's no SSE to emit to, so a transport error simply
 * propagates to the route's catch. `truncated` is derived from the structured
 * call's `finishReason`.
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
		async extractDocumentStructured(args) {
			const r = await generateObjectWith({
				model,
				system: args.system,
				schema: args.schema,
				prompt: args.prompt,
				file: args.file,
				instruction: args.instruction,
				maxOutputTokens: args.maxOutputTokens,
				providerOptions: args.providerOptions,
			});
			return { object: r.object, truncated: r.finishReason === "length" };
		},
	};
}
