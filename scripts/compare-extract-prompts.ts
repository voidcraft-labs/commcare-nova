#!/usr/bin/env -S npx tsx
/**
 * Compare the two extraction PROMPTS on a real document — the previous full-tag
 * prompt (the last one approved, pre-#27) vs the proposed clean-markdown prompt
 * (structure carries meaning, no tags) — both run on the SAME model so the only
 * variable is the prompt. Prints each extract in full plus token/cost AND a count
 * of how many `[BRACKET]` tags each output contains, so the format difference is
 * unmissable.
 *
 *   npx tsx scripts/compare-extract-prompts.ts <file> [--model gemini|haiku] [--only proposed|full-tag] [--structured]
 *
 * Default model is the production Gemini summarizer (needs
 * GOOGLE_GENERATIVE_AI_API_KEY); `--model haiku` runs both prompts on Haiku
 * (needs ANTHROPIC_API_KEY). `--only proposed` runs JUST the proposed prompt
 * (one model call) — the fast path for iterating on `extract-prompt-proposed.md`
 * without re-running the baseline; `--only full-tag` runs only the baseline.
 * Omit it to run both side by side.
 *
 * `--structured` runs the REAL production call — `generateObject` against the
 * actual `extractDocumentSchema` ({ extract, title, summary }, extract-first) —
 * so you see exactly how `title`/`summary` come out, not just the extract text.
 * (Default is a plain `generateText` extract-only run, which is enough to compare
 * the prompt FORMAT but never produces title/summary.) Note: in structured mode
 * `title`/`summary` are driven by the schema's per-field `.describe()`s — the
 * prompt files here carry the extract instructions only.
 *
 * This file does NOT touch the shipped EXTRACT_SYSTEM — both prompts live here
 * as constants so the comparison is reproducible.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText, type LanguageModel } from "ai";
import {
	CONDENSER_MODEL,
	CONDENSER_PROVIDER_OPTIONS,
	docxToMarkdown,
	EXTRACT_MAX_OUTPUT_TOKENS,
	extractDocumentSchema,
	xlsxToMarkdown,
} from "../lib/agent/documentExtraction";
import type { SubGenerationProviderOptions } from "../lib/agent/subGeneration";
import {
	assetKindForExtension,
	isDocumentKind,
} from "../lib/domain/multimedia";
import { MODEL_PRICING } from "../lib/models";

// ── The two prompts under comparison ─────────────────────────────────────────

/**
 * A — the previous FULL-TAG prompt, verbatim from git (`e0655026`, the version
 * approved before the #27 format change). Its output is tag-heavy: every line
 * may carry a [FIELD] / [OPTIONS] / [VALIDATION] / … bracket tag.
 */
const PROMPT_FULL_TAG = `You are a requirements extractor for a CommCare app builder. You receive ONE
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

/**
 * B — the proposed clean-markdown prompt, read from a sibling markdown file
 * (`extract-prompt-proposed.md`) so it can be edited and re-run without touching
 * this script. Temporary scaffolding for the prompt comparison.
 */
const PROMPT_PROPOSED = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "extract-prompt-proposed.md"),
	"utf-8",
);

const PROMPTS = [
	{
		key: "full-tag",
		label: "A · PREVIOUS — full-tag prompt (last approved, pre-#27)",
		system: PROMPT_FULL_TAG,
	},
	{
		key: "proposed",
		label: "B · PROPOSED — clean markdown, no tags",
		system: PROMPT_PROPOSED,
	},
] as const;

/** The selectable prompt keys, derived from `PROMPTS` so they can't drift. */
type PromptKey = (typeof PROMPTS)[number]["key"];

// ── Model config (the prompt is the variable; the model is held fixed) ────────

const HAIKU_ID = "claude-haiku-4-5-20251001";
/** Gemini 3.5 Flash pricing, $/1M tokens (output billed inclusive of thinking).
 *  Verify against https://ai.google.dev/gemini-api/docs/pricing if Google revises. */
const GEMINI_PRICING = { input: 1.5, output: 9 } as const;
const HAIKU_PRICING = MODEL_PRICING[HAIKU_ID];

/** MIME type by file extension — drives the PDF native-block media type. */
const MIME_BY_EXT: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".pdf": "application/pdf",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

type ModelKey = "gemini" | "haiku";

interface ResolvedModel {
	model: LanguageModel;
	label: string;
	id: string;
	pricing: { input: number; output: number };
	/** Gemini's thinking/media options; unset for Haiku (provider defaults). */
	providerOptions?: SubGenerationProviderOptions;
}

/** Resolve the chosen model to a `LanguageModel`, or a skip reason when its key
 *  is unset. Both prompts run on whichever model this returns. */
function resolveModel(key: ModelKey): ResolvedModel | { skip: string } {
	if (key === "haiku") {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) return { skip: "ANTHROPIC_API_KEY not set" };
		return {
			model: createAnthropic({ apiKey })(HAIKU_ID),
			label: "Haiku 4.5",
			id: HAIKU_ID,
			pricing: HAIKU_PRICING,
		};
	}
	const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	if (!apiKey) return { skip: "GOOGLE_GENERATIVE_AI_API_KEY not set" };
	return {
		model: createGoogleGenerativeAI({ apiKey })(CONDENSER_MODEL),
		label: "Gemini 3.5 Flash (thinking: high)",
		id: CONDENSER_MODEL,
		pricing: GEMINI_PRICING,
		providerOptions: CONDENSER_PROVIDER_OPTIONS,
	};
}

// ── Document input — built ONCE and fed identically to both prompts ───────────

/** The model input for a document: a decoded text `prompt` (text/docx/xlsx) or a
 *  native `file` block with an `instruction` (PDF). Mirrors how the production
 *  `extractDocument` builds each kind, so the comparison matches real conditions. */
type DocInput =
	| { prompt: string }
	| { file: { mediaType: string; data: string }; instruction: string };

async function buildInput(path: string): Promise<DocInput | { error: string }> {
	const ext = extname(path).toLowerCase();
	const kind = assetKindForExtension(ext);
	if (!kind || !isDocumentKind(kind)) {
		return {
			error: `${ext || "this file"} is not a document kind — pass a pdf / docx / xlsx / txt / md / csv.`,
		};
	}
	const bytes = readFileSync(path);
	const filename = basename(path);
	if (kind === "pdf") {
		const mediaType = MIME_BY_EXT[ext] ?? "application/pdf";
		return {
			file: {
				mediaType,
				data: `data:${mediaType};base64,${bytes.toString("base64")}`,
			},
			instruction: `Extract every requirement from this document. Filename: ${filename}.`,
		};
	}
	const body =
		kind === "docx"
			? await docxToMarkdown(bytes)
			: kind === "xlsx"
				? xlsxToMarkdown(bytes)
				: bytes.toString("utf-8");
	return { prompt: `Filename: ${filename}\n\n${body}` };
}

/** The shared input as the call-arg fragment each generate* function takes — a
 *  native `file` message (PDF) or a plain text `prompt`. Built once per run so
 *  the text and structured paths feed the model identically. */
function callArgs(input: DocInput) {
	return "file" in input
		? {
				messages: [
					{
						role: "user" as const,
						content: [
							{ type: "text" as const, text: input.instruction },
							{
								type: "file" as const,
								data: input.file.data,
								mediaType: input.file.mediaType,
							},
						],
					},
				],
			}
		: { prompt: input.prompt };
}

/** Normalized result across the text and structured paths: always an `extract`,
 *  plus `title`/`summary` only when the structured (`generateObject`) path ran. */
interface RunResult {
	extract: string;
	title?: string;
	summary?: string;
	usage: { inputTokens?: number; outputTokens?: number } | undefined;
	finishReason: string;
}

/** Run one prompt against the resolved model + shared document input. With
 *  `structured`, runs the production `generateObject` call against
 *  `extractDocumentSchema` so title/summary surface; otherwise a plain
 *  `generateText` extract-only run. */
async function runPrompt(
	system: string,
	resolved: ResolvedModel,
	input: DocInput,
	structured: boolean,
): Promise<RunResult> {
	const common = {
		model: resolved.model,
		system,
		maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
		providerOptions: resolved.providerOptions,
		...callArgs(input),
	};
	if (structured) {
		const r = await generateObject({
			...common,
			schema: extractDocumentSchema,
		});
		return {
			extract: r.object.extract,
			title: r.object.title,
			summary: r.object.summary,
			usage: r.usage,
			finishReason: r.finishReason,
		};
	}
	const r = await generateText(common);
	return { extract: r.text, usage: r.usage, finishReason: r.finishReason };
}

// ── Rendering ─────────────────────────────────────────────────────────────

const RULE = "─".repeat(76);
const DOLLARS = (n: number) => `$${n.toFixed(5)}`;
/** Count of `[BRACKET]` tags in an output — the whole point of the comparison. */
const countTags = (text: string) =>
	(text.match(/\[[A-Z][A-Z_]*\]/g) ?? []).length;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let modelKey: ModelKey = "gemini";
	let only: PromptKey | undefined;
	let structured = false;
	let file: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model") {
			modelKey = argv[++i] === "haiku" ? "haiku" : "gemini";
		} else if (arg === "--structured") {
			structured = true;
		} else if (arg === "--only") {
			const which = argv[++i];
			if (which !== "proposed" && which !== "full-tag") {
				console.error(
					`--only takes "proposed" or "full-tag"; got "${which ?? ""}". Omit --only to run both.`,
				);
				process.exit(1);
			}
			only = which;
		} else {
			file ??= arg;
		}
	}
	if (!file) {
		console.error(
			"usage: npx tsx scripts/compare-extract-prompts.ts <file> [--model gemini|haiku] [--only proposed|full-tag] [--structured]",
		);
		process.exit(1);
	}

	// `--only` runs a single prompt (one model call) — the fast iterate loop for
	// the proposed prompt; omitting it runs both side by side.
	const selected = only ? PROMPTS.filter((p) => p.key === only) : PROMPTS;

	const resolved = resolveModel(modelKey);
	if ("skip" in resolved) {
		console.error(`cannot run on ${modelKey}: ${resolved.skip}`);
		process.exit(1);
	}

	const input = await buildInput(file);
	if ("error" in input) {
		console.error(input.error);
		process.exit(1);
	}

	const heading =
		selected.length === 1
			? `Running the ${selected[0].key} prompt on`
			: "Comparing extraction prompts on";
	const mode = structured ? " · structured (extract + title + summary)" : "";
	console.log(`${heading} "${basename(file)}" via ${resolved.label}${mode}\n`);

	for (const p of selected) {
		const r = await runPrompt(p.system, resolved, input, structured);
		const inTok = r.usage?.inputTokens ?? 0;
		const outTok = r.usage?.outputTokens ?? 0;
		const cost =
			(inTok / 1_000_000) * resolved.pricing.input +
			(outTok / 1_000_000) * resolved.pricing.output;
		console.log(RULE);
		console.log(`### ${p.label}`);
		console.log(
			`tokens: ${inTok.toLocaleString()} in → ${outTok.toLocaleString()} out  ·  est. cost ${DOLLARS(cost)}  ·  finish: ${r.finishReason}  ·  ${r.extract.length.toLocaleString()} chars  ·  [BRACKET] tags in output: ${countTags(r.extract)}`,
		);
		// In structured mode, show the title/summary the model produced AFTER the
		// extract — the whole reason for the --structured run.
		if (structured) {
			console.log(RULE);
			console.log(`title:   ${r.title ?? "(none)"}`);
			console.log(`summary: ${r.summary ?? "(none)"}`);
		}
		console.log(RULE);
		console.log(r.extract);
		console.log();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
