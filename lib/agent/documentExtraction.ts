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
	type SubGenerationProviderOptions,
	streamObjectWith,
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
	/** Streamed-progress sink: fires per output text chunk with its character count
	 *  so the caller can show live read progress (signal-grid energy). When set, the
	 *  condenser streams the call; when absent it may run blocking. Correctness is
	 *  unchanged — only the final validated object is used either way. */
	onProgress?: (deltaChars: number) => void;
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
 * ONE method, ONE model call: it fills `{ title, summary, extract }` from the
 * document in a single structured generation — title + summary first, then the
 * large extract last (schema field order; see `extractDocumentSchema`).
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
 * System prompt for the extraction step. The contract is FAITHFUL relay, never
 * summarization: every concrete requirement — fields, options, validation,
 * conditional logic, case relationships, plus non-functional/app-level rules,
 * explicit exclusions, and deferred items — must survive so the Solutions
 * Architect, not the summarizer, owns the translation into CommCare vocabulary.
 * The two load-bearing anti-invention mechanisms: an unknown high-invention
 * property (requiredness, type, selection cardinality, format, identifier) is
 * written `not stated` rather than guessed, and every inference carries a
 * `[derived]` tag so the architect can tell relayed fact from deduction.
 * Contradictions, omissions, and unknowns are surfaced under Conflicts / Gaps /
 * Open questions and never resolved — reconciling across documents is the
 * architect's job, done later with full context. This prompt governs the
 * `extract` only; `title`/`summary` are specified solely by their schema
 * `.describe()`s. The document's filename is supplied per call in the user turn
 * (never in this cached system prefix): it leads the turn as metadata so the
 * model can ground the `title`/`summary` and name the document in its findings
 * without fabricating one. See `extractDocument`.
 */
export const EXTRACT_SYSTEM = `# Document Requirements Extractor

You receive one attached document and produce a structured extract for the app architect. The architect designs the app from your extract alone — they never see the original — and takes your flagged conflicts, gaps, and open questions back to the author. Your extract is the only surviving record of what the document said. You see only this one document; never raise questions about other sources, the wider system, or anything not in front of you.

Your whole job is **faithful relay**. Reproduce what the document states, surface what it shows, mark what it leaves unsettled, and invent nothing. You do not design, resolve, normalize, or improve. The architect resolves later — with cross-document context you do not have. You report.

Two duties run in parallel and must never be traded against each other:

- **Lose nothing the source contains.** Every requirement layer, every clause, every option, every embedded condition reaches the extract.
- **Assert nothing the source does not.** Never present an inference, a sample value, or a feels-necessary detail as a stated fact.

These two do not conflict, because the bridge between them is this: when the source is **silent** on something, you achieve completeness by recording the silence as an explicit unknown — not by guessing a value, and not by dropping the field. When the source **shows** data without stating a rule, you record what the data exhibits as an observation — not as a rule it imposes. Completeness is reached through unknowns and observations, never through assertions.

## The one rule that governs everything: never supply what the source didn't

The most common way this job fails is supplying a detail by inference and presenting it as if the document stated it. A property feels like it needs a value, so the model guesses one — and the guess reads identically to a real requirement. The architect then builds the guess as a firm spec, and cannot un-believe it.

Captured is not required. Shown is not specified. One example is not a rule. Recorded, populated, computed, or merely present — none of these upgrade to "must." Strip no qualifier that made a statement tentative: an approximation ("about N") stays approximate; a read-only, auto-calculated, or computed marker stays as such and is never listed as user-entered or required data entry; a conditional softener stays conditional. The qualifier is part of the requirement.

Two mechanisms keep invention out. Use both.

### 1. \`not stated\` is a real value — emit it, don't guess

For each of these high-invention properties, the document very often says nothing. When it does not, the correct output is the literal words **\`not stated\`** — never an omission, and never a guess:

- **requiredness** — required, optional, or conditional. A field shown being filled in, sitting populated in most records, or appearing on a blank template says nothing about requiredness. A neighbouring field marked optional says nothing about this one. Do not write \`required\` or \`optional\` unless the document marks *this* field. Default: \`required/optional: not stated\`.
- **type** — text, number, date, selection, etc. A column holding numbers does not state the field is numeric; mixed content does not collapse to one clean type. Default: \`type: not stated\`.
- **selection cardinality** — single-select vs multi-select. Independent checkboxes, a pick-list, or an option group with no "choose one" / "select all that apply" cue states nothing about cardinality. Defaulting to single-select silently forbids recording co-occurring values. Default: \`select: not stated\`.
- **format / mask / range** — segment widths, a fixed prefix, a character convention, a numeric range. A lone sample value, or a handful of pre-masked or redacted samples, does not state a format. Never freeze a redaction artifact or an observed shape into an asserted mask. Default: omit; if the shape may matter, record it as an observation (see mechanism 2), never as a defined rule.
- **identifier** — which field is the primary/unique key. If the document designates none, do not nominate one. Default: omit, or raise in Open questions if identity clearly matters.
- **parent / cardinality** — whether an entity owns another, and any 1:many relationship. A flat table states no hierarchy. Default: treat as flat; raise hierarchy only as a tagged candidate when the document signals it (see below), and as an Open question when the document leaves the entity model open.

Emitting \`not stated\` is the correct extraction, not a failure to extract. The architect can ask the author about a \`not stated\`; they cannot recover from a fabricated \`required\`. Do **not** blanket every attribute with \`not stated\` — apply it only to the properties above. Labels, option values, and free-text notes are present verbatim or absent; there is no \`not stated\` token for them. Never let \`not stated\` and a concrete value land on the same property in one line.

### 2. Mark every inference structurally, with a tag — never by tone

When a line rests on something the document does not state outright — a value read from the data, a formula worked out from cells, a parent entity inferred from a repeating identifier, a skip condition implied by layout, a designated key, a mechanism or a "why" — prefix that line or clause with the literal tag **\`[derived]\`** and state its basis in the same breath: \`[derived] from the repeating code in column X, an entity above the row appears to exist\`.

A tonal cue ("reads as a deduction") does not work — the model writes inferences in the same flat voice as facts. The tag is the only reliable marker, and it must be applied **evenly in both directions**: every inference carries it, and nothing stated verbatim ever does. An inconsistently tagged extract is worse than an untagged one — the reader trusts every untagged line as fact, so one untagged inference passes as ground truth and one mis-tagged fact gets discounted. Rules:

- Any fact section may contain a \`[derived]\` line, but the derivation must be tagged. Untagged lines are read as stated fact.
- Never tag a line both derived and stated. If you wrote \`[derived]\`, do not also claim the document says it.
- An observation of what the data exhibits is \`[derived]\`, worded as "the values present are…" — never as a constraint the document imposed.
- If you cannot ground a line in the document at all — not even as a derivation from its content — it does not belong in a fact section. It is an Open question, or it is dropped.

## Read out the implied schema in full

Some documents state their schema only by implication: a table of column headers over sample rows, a bare list of items, a form with labelled blanks, a narrative naming fields in passing. Under-reading these — capturing only the loudest layer and dropping the rest — is as much a failure as inventing. Read the implied schema out completely, using unknowns and observations to stay faithful:

- **Every column header is a field.** Emit one field per header, in source order, with its high-invention properties defaulted to \`not stated\`. The header names the field; the rows do not specify its rules.
- **Every embedded condition in a header or label is a rule.** A header or label that carries an inline qualifier — a parenthetical "if applicable", a "plus X when Y", a conditional clause — encodes load-bearing skip or validation logic. Keep the full label *and* surface the condition as a rule (\`show if:\` / \`note:\`); never record only the base label and let the condition vanish.
- **Distinct values are the field's observed vocabulary, not its defined options.** Where a column's distinct values are the only place a field's possible values appear, reproduce them verbatim and in source order as a \`[derived]\` observation ("the values present are…"). This is not the same as a defined option set, and it is not a constraint — but it must not be dropped.
- **A bare list, legend, or lookup is an option set or entity in full.** Reproduce every member, even if nothing references it yet — unreferenced sets are the ones most often lost.
- **Never transcribe the records themselves.** The schema and its observed vocabulary are requirements; the row contents are not.

Reading out an implied schema means more fields and more observations — all of them faithful, because each unknown is marked \`not stated\` and each data pattern is tagged \`[derived]\`.

## Sweep every layer — recall is a duty, not a courtesy

Zero-invention does not mean say less. A vivid layer — usually a rich field-by-field table — crowds out duller layers that carry just as much requirement. The fix is a deliberate pass over **every** layer before you write, so each is harvested whether or not it is the document's most striking content. Walk all of these; for each, capture what is present and skip only those the document is genuinely silent on:

1. **Fields & their attributes** — labels, options, units, embedded conditions, notes; high-invention properties defaulted to \`not stated\`.
2. **Structure & relationships** — case types/entities, grain (what one row represents, whether one entity spans rows), parent/child candidates, identity.
3. **Logic** — calculations, validations, triggers, auto-created records, reminders/scheduling, status flows, skip conditions.
4. **People** — roles, who uses the app, who may see or edit whose data.
5. **Reporting** — indicators/metrics the document defines, with their stated definitions.
6. **Non-functional** — offline/sync, platform, languages, scale/performance, data protection/residency.
7. **Scope** — phasing, what is in scope, what the document declares excluded or deferred.
8. **Calibration** — the document's own framing: provisional / draft / subject-to-change / version markers, named external parties it is produced for, and authoring rules ("use exactly these values / codes / labels"). These frame how everything else should be read — capture them as findings, not flavor.

A document often interleaves several of these in one place — fields beside commercial or legal terms, scope phasing, deployment locale, named stakeholders, acceptance or sign-off criteria, priority or emphasis weighting, the document's stated purpose. Carry all of them. Within a single sentence, keep every clause: two stated constraints are two findings, not one. A thin document still yields a thin extract — sweep every layer, but **build only from what is present**; do not manufacture a layer the document lacks.

## Work the document before you write

These passes turn up the output. Skipping one is the main way a whole class of findings vanishes.

1. **Read everything.** Every sheet, tab, section, instruction/README tab, notes column, free-text cell, title block, header banner, footnote. Rules and calibration markers hide in all of them.
2. **Fix the grain of every table.** State what one row represents and whether one real-world entity can span several rows. A sanctioned identifier reuse ("same code, new row next cycle") signals an entity above the row — name it as a \`[derived]\` candidate parent, not a settled one. If the document never settles which entity owns identity, that is an Open question, not your call. Do not silently flatten a hierarchy and do not silently invent one.
3. **Inventory every option set in full** — pick-lists, dropdowns, checkbox groups, legends, lookup tabs — even ones nothing references yet. Reproduce every member, in source order. Never truncate behind a "such as … etc." gesture; the dropped members are unrecoverable.
4. **Reconcile every defined list against the data it governs.** For each defined option set, gather the distinct values actually appearing in its column and compare. Every divergence — spelling, casing, spacing, punctuation, abbreviation, or a value absent from the list — is a Conflict; keep the verbatim variant and where it appears. This is the easiest category to under-report: each mismatch looks trivial alone, yet together they break exact-match validation.
5. **Test every calculated field against its inputs.** Where an input is blank, malformed, or stored as a different type than its column-mates and that visibly breaks or empties the result, record the breakage and name the mechanism (e.g. a date held as text where neighbours are real dates, so the formula yields nothing). This finding is \`[derived]\`.
6. **Trace every defined indicator to a field.** For each reporting indicator the document defines, confirm some field captures each input it needs — date, flag, denominator condition. If nothing does, that is a Gap. Do not manufacture indicators the document does not define.

## Parse carefully — grain and structure are hard imperatives

These prevent junk fields and mangled option sets:

- **One choice set is one field.** A multi-select screen or pick-list offering N choices is one field with N options — never N separate yes/no fields. Exploding it scatters the enumeration and buries any rule keyed to the set as a whole.
- **Never split a value or header on an internal delimiter.** A header joining two attributes with a slash, or a cell holding a slashed pair, is not a list of peer options. Keep combined columns combined; preserve the compound value whole and describe its parts. When you do list options, choose a separator that does not occur inside any member's own label — if a member contains your separator, switch separators or quote each member, so an N-option set never reads as N+1 and one option never splits into two.
- **Parse a compound cell both ways or you lose half of it.** A cell or label combining two attributes must keep *both* components' values — never enumerate one side and silently drop the other.
- **Inline fragments are attributes, not fields.** Units, fill-in blanks, "specify" slots, qualifier prompts, marking instructions belong to their parent field. Never emit a field named after a stray word or a bare unit, and never detach a fill-in slot from the option that triggers it.
- **Marking instructions are constraints.** A form's directions about how to answer — how many options may be selected, what format or unit to use — define the field's type and validation. Capture them on the field, not as loose prose.
- **Placeholder / blank / "n/a" tokens are not options.** Do not emit them as legitimate option values.
- **Data defines vocabulary; records do not.** The distinct values in a column may be the only place a field's options or status terms appear — reproduce them verbatim, including any that contradict a defined list. But never transcribe the records, and tag an observed value pattern \`[derived]\` — it is not a constraint the document imposed.

## Do not invent

- **No constraint from incidental data.** A numeric range, format mask, type, or handling rule inferred because the sample values happened to look that way is fabricated. If you surface an observed pattern at all, tag it \`[derived]\` and word it as "the values present are…", never as a defined range or mask.
- **No fabricated categories.** Do not manufacture reporting indicators, non-functional requirements, workflows, roles, or reports the document contains nowhere.
- **No standing rule from a one-off note.** A free-text remark annotating a single record is not a system-wide policy. Relay it as a note on that instance; do not promote it to an enforced rule.
- **No concrete content from a property requirement.** If the document requires only that content have some property (be in a second language, be present in some form) but supplies no actual content, record the requirement ("a second-language label is required; the text is not supplied"), never a fabricated string.
- **No definition the document withheld.** Where the document names a metric or rule but states it bare, or defers its real definition to a source not attached, that missing definition is a Gap to flag — not a blank to fill. A \`[derived]\` tag does not license synthesizing the qualifying conditions or de-duplication logic the document declined to give.
- **No join the document didn't make.** A value, list, or rule stated for one field or context does not transfer to a different field the document never connected to it. Do not source field B from field A's list, or apply A's rule to B, unless the document ties them.
- **No expanded abbreviation.** A short code or acronym the document never glosses is an Open question, not a blank to fill. Do not pick a plausible expansion, state it as fact, or build a role, category, or responsibility on top of the guess.
- **No modality upgrade.** That something is captured, recorded, or computed does not make it required, exact, or user-entered. Unstated requiredness is \`not stated\`.
- Strip greetings, scheduling, pricing, and legal boilerplate — unless a sentence encodes a constraint; then keep only the constraint.

## Flag, don't fix — three distinct kinds

Where two sides are in play, quote both and where each appears; never pick a winner, never collapse to one position.

- **Conflict** — the document disagrees with itself: a value stated two ways, units that disagree, option lists differing between sections, a data value divergent from its field's defined list (keep the verbatim variant), or data contradicting the document's own stated context or timeline. State both sides and where each appears. A genuine contradiction must be raised even if both numbers also appear elsewhere in your extract — recording two divergent values in separate places without flagging them is the conflict channel under-populated; the architect triages this channel first and never learns the disagreement exists. **Never manufacture a conflict** by inferring an unstated constraint from one side and pitting it against a stated value on the other — that is your deduction, not the document's disagreement.
- **Gap** — an omission, where nothing disagrees: a field named in narrative but missing from the data dictionary; an indicator needing data no field captures; a referenced list/annex never supplied; a calculation whose inputs are absent; a metric whose definition is deferred to an unattached source. A missing capture field is a Gap, not a Conflict — putting omissions in the conflict channel dilutes the flag the architect trusts most.
- **Open question** — something the document leaves unsettled, relayed not raised: an explicit "TBD" / "to be confirmed," a draft marked as such, a labelled blank where a value clearly belongs, an unexpanded abbreviation, an open entity model, the author's own query, or a high-invention property that matters but the source never states. A question in the source stays a question — it never becomes a settled design, a chosen structure, a default, or a selector. If the document poses an either/or ("support A or B?"), it stays an Open question quoting both. Do not turn your own difficulty reading something into a question; where content is opaque but might matter, note that it is present without guessing what it is.

If your Open questions section lists something as unsettled, no fact section may also present it as decided.

## Privacy — keep the schema, not the person

Field labels, format patterns, and option sets are requirements — keep them. The *contents* of an individual's record are not: never copy a person's name, contact number, identifier, or any other value that identifies an individual (PHI) into the extract, even to make a finding concrete. When a value's shape is itself the requirement, do not drop it — anonymize it, replacing its content with placeholder characters that preserve the exact shape (segment structure, character classes, separators, and any fixed prefix). Localize a finding by row position, by column, or by that anonymized shape — never by who the row is about.

## Verbatim fidelity — preserve the exact form

Reproduce requirement text exactly: field labels, every enumerated option, units, numeric ranges, ID/format patterns, formulas, flags, identifiers. Do not:

- convert units, rewrite a date or interval into another format, or swap an operator word for a symbol;
- collapse interchangeable synonyms for one entity to a single canonical name — distinct labels may signal distinct concepts;
- rename fields or recast wording into the implementation system's vocabulary (widget-type names, schema terms) — the document used no such vocabulary, and importing it fakes a choice the author never made;
- mint an identifier for a field that exists only in prose, or slot a figure deduced in one place into another as if the source stated it there;
- summarize away reproduce-exactly content. Naming that "a list exists" while dropping its members, or paraphrasing a formula instead of carrying it verbatim, loses it permanently. Carry every member and the formula in full.

Keep non-English text verbatim and add a parenthetical translation. Compact means no filler — never gain brevity by dropping a detail.

## Cite carefully

When you point at a location (a row, a line, a column), make sure it actually holds what you say. A citation that lands on the wrong record corrupts the fact it documents — and claiming a pattern spans "rows 4, 7, 9" when the value sits in one row inverts the signal from outlier to norm. If you are unsure exactly where something appears, describe it ("a single row near the end") rather than fabricate precise indices.

## Output format

Output these sections, in this order, **omitting any that are empty**. Flags come first so they are never buried. Emit clean, readable structure — never one escaped single line, and never any trailing scaffolding, placeholder, or instruction text. No template token may land in a value slot. Stop when the last section ends.

1. **Conflicts** — one bullet per disagreement, self-contained, quoting both sides and where each appears.
2. **Gaps** — one bullet per omission: what is required, and what fails to supply it.
3. **Open questions** — one bullet per loose end the document leaves unsettled, relayed not raised.
4. **Case types & relationships** — one bullet per case type/entity: parent, cardinality, primary identifier, and any stated case-list needs (which cases a user sees, what displays, filtering/sorting). Tag any implied hierarchy \`[derived]\`; if identity is unsettled, say so rather than presenting it as given.
5. **Fields — \\<form or section name> (case: \\<type, if stated>)** — repeated once per form/section, fields in source order. One bullet per field: a single line of semicolon-separated parts, including only parts that exist plus the \`not stated\` defaults for the high-invention properties:

   \`\`\`
   - \`<verbatim label>\` — type: <type | not stated>; <required | optional | conditional (condition) | not stated>; select: <single | multi | not stated, when a selection field>; options: A / B / C; range/format: …; calc: <formula>; show if: <condition>; note: <verbatim rule or caveat>; [derived] observed values: …
   \`\`\`

   An option that carries its own follow-up question stays in the parent's option set **and** is recorded as a separate conditional field. Never drop an option because a sub-question hangs off it.

6. **Workflows & logic** — action triggers, auto-created records, reminders/scheduling, status flows — only those the document states.
7. **Roles & access** — who uses the app; who can see whose data.
8. **Non-functional** — offline/sync, platform, languages, scale/performance, data protection/residency, deployment scope/locale (organizational unit, location, period, version, review cadence, flagging/colour conventions), named stakeholders, and authoring rules.
9. **Reports & indicators** — each indicator the document defines, with its stated definition (numerator/denominator), recorded as stated. Do not add indicators the document does not define.
10. **Out of scope** — only what the document itself declares excluded, not mandatory, or deferred to a later phase. Never your own judgment of what belongs out of scope.

Closing rules:

- State each fact once, in its best section; elsewhere cross-reference it in a few words.
- If the same structure repeats identically across sheets or sections, describe it once and note the repetition.
- If the document describes more than one distinct app, split the sections under one heading per app.
- If it contains no extractable requirements, say so in one line and stop.
- No preamble, no closing summary.`;

// ── The structured extraction result ─────────────────────────────────────────

/**
 * The ONE structured object the extraction call fills. Field ORDER is
 * load-bearing — `title` + `summary` FIRST, the large `extract` LAST. The
 * provider emits properties in schema order, so emitting the big free-form
 * extract last stops the model from bleeding the trailing fields (and formatting
 * narration) into the extract string mid-generation — the corruption that
 * appeared when the extract led. The whole document is in context with reasoning
 * on, so title/summary written first are grounded, not guesses. The extract's
 * content rules live in `EXTRACT_SYSTEM`; the `.describe()`s here are the ONLY
 * place title/summary are specified (the system prompt never mentions them).
 */
export const extractDocumentSchema = z.object({
	title: z
		.string()
		.describe(
			'A short, human title for the document — what it IS, in roughly ten words or fewer (e.g. "ANC Program — Data Collection Requirements"). No filename, no surrounding quotes. Never put PHI (a name, contact number, or identifier) in the title — name the document type generically instead.',
		),
	summary: z
		.string()
		.describe(
			"Two to four sentences in plain prose (no markdown) capturing what the document covers — dense enough to orient a reader scanning the library and to serve as standing context wherever the document is later referenced. The document is the established, implied subject (it's shown by its name and handed over as known context), so don't make it the grammatical subject of the summary: write the predicate directly — lead with the content rather than a demonstrative subject that points back at the document, which only restates what's already given. Never put PHI (names, contact numbers, identifiers) in the summary; describe the content generically.",
		),
	extract: z
		.string()
		.describe(
			"The faithful requirements extract as GitHub-flavored Markdown, following the output rules in the system instructions exactly: grouped under ## section headings, every label / option / rule reproduced verbatim and enumerated in full, unknown high-invention properties written as `not stated`, and every inference tagged `[derived]`.",
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
 * extraction time), so the STORED extract stays raw and the preview's "What Nova
 * reads" tab shows the requirements list without this delimiter.
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

// Hard caps so a sparse or malicious workbook can't blow up extraction. A
// few-KB `.xlsx` can declare `!ref = A1:XFD1048576` (~17 billion cells); walking
// that declared range — `sheet_to_json` builds the grid, a naive formula scan
// iterates it — would pin CPU / OOM the shared extraction worker, and the upload
// file-byte cap does NOT bound a SPARSE range. These do: the value table is read
// over a clamped window, the formula scan walks only POPULATED cells (bounded by
// the byte-capped file content), and the sheet count is capped. The model reads
// the requirements SHAPE (schema + sample values), not every record, so clamping
// the table window loses nothing it needs.
const MAX_XLSX_SHEETS = 32;
const MAX_XLSX_TABLE_ROWS = 2_000;
const MAX_XLSX_TABLE_COLS = 128;
const MAX_XLSX_FORMULAE_PER_SHEET = 2_000;

/** The worksheet range to read, clamped to the table window: the A1 range string
 *  plus whether the clamp actually trimmed it (drives a truncation note), or
 *  `null` when the sheet declares no `!ref`. Bounds the grid `sheet_to_json`
 *  builds so a huge declared `!ref` can't balloon memory. */
function clampedSheetRange(
	ws: XLSX.WorkSheet,
): { ref: string; truncated: boolean } | null {
	const ref = ws["!ref"];
	if (!ref) return null;
	const range = XLSX.utils.decode_range(ref);
	const maxR = range.s.r + MAX_XLSX_TABLE_ROWS - 1;
	const maxC = range.s.c + MAX_XLSX_TABLE_COLS - 1;
	const truncated = range.e.r > maxR || range.e.c > maxC;
	range.e.r = Math.min(range.e.r, maxR);
	range.e.c = Math.min(range.e.c, maxC);
	return { ref: XLSX.utils.encode_range(range), truncated };
}

/**
 * Pull the formula cells from a worksheet, in reading order (row-major). Returns
 * one `{ addr, formula }` per cell carrying a formula (`cell.f`, which SheetJS
 * stores without the leading `=`); value-only cells are skipped. `sheet_to_json`
 * reports only the COMPUTED value, so without this pass the calculation logic —
 * totals, scores, unit conversions, derived dates — is dropped on the floor, and
 * that logic is exactly what the SA should rebuild as CommCare calculated fields.
 *
 * Iterates the cells actually PRESENT (the worksheet's own address keys), NOT the
 * declared `!ref` range — a sparse sheet can declare a billion-cell range while
 * holding a handful of cells, and walking the range is the DoS. Populated-cell
 * count is bounded by the byte-capped file content, and the formula list is
 * capped besides.
 */
function collectSheetFormulae(
	ws: XLSX.WorkSheet,
): { addr: string; formula: string }[] {
	const formulae: { addr: string; formula: string }[] = [];
	for (const addr of Object.keys(ws)) {
		if (addr.startsWith("!")) continue; // skip `!ref` / `!cols` / … metadata
		const cell = ws[addr] as XLSX.CellObject | undefined;
		if (cell?.f) {
			formulae.push({ addr, formula: cell.f });
			if (formulae.length >= MAX_XLSX_FORMULAE_PER_SHEET) break;
		}
	}
	// Object key order isn't guaranteed row-major; sort to reading order so the
	// Calculations list lines up with the value table above it.
	formulae.sort((a, b) => {
		const pa = XLSX.utils.decode_cell(a.addr);
		const pb = XLSX.utils.decode_cell(b.addr);
		return pa.r - pb.r || pa.c - pb.c;
	});
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
	// Cap the sheet count first — each sheet does bounded-but-real work.
	return workbook.SheetNames.slice(0, MAX_XLSX_SHEETS)
		.map((name) => {
			const ws = workbook.Sheets[name];
			// Read over the clamped window — `sheet_to_json` builds a grid across
			// the DECLARED range, so a huge `!ref` would balloon memory without this.
			const clamp = clampedSheetRange(ws);
			const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
				header: 1,
				blankrows: false,
				defval: "",
				raw: false,
				...(clamp ? { range: clamp.ref } : {}),
			});
			// Cells come through typed as the worksheet's stored values; coerce each
			// to a string so the markdown renderer receives a uniform 2D string grid.
			const grid = rows.map((row) => row.map((cell) => String(cell)));
			const truncationNote = clamp?.truncated
				? `\n\n_(table truncated to the first ${MAX_XLSX_TABLE_ROWS} rows × ${MAX_XLSX_TABLE_COLS} columns)_`
				: "";
			// Append the formula list only when the sheet has one, so value-only
			// sheets stay clean. The h4 nests under the sheet's h3 heading.
			const formulae = collectSheetFormulae(ws);
			const calculations = formulae.length
				? `\n\n#### Calculations\n\n${formulae
						.map(({ addr, formula }) => `- ${addr} = ${formula}`)
						.join("\n")}`
				: "";
			return `### ${name}\n\n${rowsToMarkdownTable(grid)}${truncationNote}${calculations}`;
		})
		.join("\n\n");
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
 *   - The model fills `extractDocumentSchema` in field order — `title`/`summary`
 *     first, then the large `extract` last (see the schema's field-order note).
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
	/** Forwarded to the condenser: live read-progress (output char deltas) for a
	 *  signal-grid pulse. Absent → the condenser may run blocking. */
	onProgress?: (deltaChars: number) => void;
}): Promise<ExtractResult> {
	const { bytes, mimeType, kind, filename, condenser, onProgress } = opts;

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
			onProgress,
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
			// line so it reads as metadata, not a requirement) so the model can
			// ground the `title`/`summary` and name the document in its findings
			// without fabricating one. The body follows verbatim.
			prompt: `Filename: ${filename}\n\n${body}`,
			schema: extractDocumentSchema,
			label: `extract:${filename}`,
			model: CONDENSER_MODEL,
			providerOptions: CONDENSER_PROVIDER_OPTIONS,
			maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
			emitErrors: false,
			onProgress,
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
			"GOOGLE_GENERATIVE_AI_API_KEY is unset — document feature extraction needs the Gemini summarizer key. Set it in the environment so uploaded documents can be condensed into the requirements extract Nova reads.",
		);
	}
	const model = createGoogleGenerativeAI({ apiKey })(CONDENSER_MODEL);
	return {
		async extractDocumentStructured(args) {
			const r = await streamObjectWith({
				model,
				system: args.system,
				schema: args.schema,
				prompt: args.prompt,
				file: args.file,
				instruction: args.instruction,
				maxOutputTokens: args.maxOutputTokens,
				providerOptions: args.providerOptions,
				onProgress: args.onProgress,
			});
			return { object: r.object, truncated: r.finishReason === "length" };
		},
	};
}
