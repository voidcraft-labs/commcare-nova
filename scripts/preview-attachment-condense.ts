/**
 * Preview the EXACT requirements extract a document condenses to — the text the
 * Solutions Architect reads in place of the raw file ("What the AI reads"),
 * without paying for the SA's Opus tool loop.
 *
 * Drives the REAL extraction core (`extractDocument`: same prompt, same
 * docx/xlsx/PDF routing the upload route uses) against local files, with a
 * SWAPPABLE condenser model:
 *
 *   - `gemini` — Google gemini-3.5-flash, the official production summarizer
 *     (reuses production's exact thinking + media-resolution options).
 *   - `haiku`  — Anthropic claude-haiku-4-5, the prior summarizer, kept as a
 *     comparison baseline.
 *
 * Only the model backend differs. That works because `extractDocument` depends
 * on the narrow `AttachmentCondenser` interface and the condensing call
 * (`lib/agent/subGeneration.ts`) is provider-agnostic. Images carry no extract
 * (the model reads them directly), so they're reported and skipped.
 *
 * For each file it prints the extract plus input/output tokens and an estimated
 * cost per model, so you can compare extract quality AND price.
 *
 * Usage:
 *   npx tsx scripts/preview-attachment-condense.ts <file...> [--model haiku|gemini|both]
 *
 * Defaults to `both`. Reads ANTHROPIC_API_KEY and GOOGLE_GENERATIVE_AI_API_KEY
 * from .env (a model with no key is cleanly skipped, not a crash).
 *
 * Cost: one Haiku and/or one Gemini call per file (cents) — never the SA.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import {
	type AttachmentCondenser,
	CONDENSER_MODEL,
	CONDENSER_PROVIDER_OPTIONS,
	extractDocument,
} from "../lib/agent/documentExtraction";
import {
	extractFromContentWith,
	generatePlainTextWith,
	type SubGenerationProviderOptions,
	type SubGenerationResult,
} from "../lib/agent/subGeneration";
import {
	assetKindForExtension,
	isDocumentKind,
} from "../lib/domain/multimedia";
import { MODEL_PRICING } from "../lib/models";

// ── Model + pricing config ──────────────────────────────────────────────────

const HAIKU_ID = "claude-haiku-4-5-20251001";
/** Single-sourced from the production extractor so the preview can't drift from
 *  the model the route actually calls. */
const GEMINI_ID = CONDENSER_MODEL;

/**
 * Gemini 3.5 Flash pricing, $/1M tokens (paid tier). Output is billed inclusive
 * of thinking tokens, so the printed output count IS the billed count. Haiku's
 * rates come from the app's own `MODEL_PRICING` (single source of truth). Verify
 * against https://ai.google.dev/gemini-api/docs/pricing if Google revises.
 *
 * NOTE: caching does not enter here — extraction is a single one-shot call per
 * document, so neither Anthropic's cache-write/read nor Gemini's cached-token +
 * hourly-storage model applies. Only input + output rates matter.
 */
const GEMINI_PRICING = { input: 1.5, output: 9 } as const;
const HAIKU_PRICING = MODEL_PRICING[HAIKU_ID];

/** MIME type by file extension — mirrors the client's accept set. Drives the
 *  PDF native-block media type; the kind is resolved from the extension. */
const MIME_BY_EXT: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".pdf": "application/pdf",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// ── Model selection ───────────────────────────────────────────────────────

type ModelKey = "haiku" | "gemini";

interface ModelSpec {
	key: ModelKey;
	label: string;
	id: string;
	pricing: { input: number; output: number };
	/** Per-call provider options (e.g. Gemini's thinking level). Unset for Haiku,
	 *  which uses provider defaults. */
	providerOptions?: SubGenerationProviderOptions;
	/** Reasoning depth shown in the result header, when the model exposes one. */
	reasoning?: string;
}

const MODEL_SPECS: Record<ModelKey, ModelSpec> = {
	haiku: {
		key: "haiku",
		label: "Haiku 4.5",
		id: HAIKU_ID,
		pricing: HAIKU_PRICING,
	},
	gemini: {
		key: "gemini",
		label: "Gemini 3.5 Flash",
		id: GEMINI_ID,
		pricing: GEMINI_PRICING,
		providerOptions: CONDENSER_PROVIDER_OPTIONS,
		reasoning: "high",
	},
};

/** Resolve a model to a `LanguageModel`, or a skip reason when its key is unset
 *  (so `--model both` with only one key configured runs what it can). */
function resolveModel(
	key: ModelKey,
): { model: LanguageModel } | { skip: string } {
	if (key === "haiku") {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) return { skip: "ANTHROPIC_API_KEY not set" };
		return { model: createAnthropic({ apiKey })(HAIKU_ID) };
	}
	const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	if (!apiKey) return { skip: "GOOGLE_GENERATIVE_AI_API_KEY not set" };
	return { model: createGoogleGenerativeAI({ apiKey })(GEMINI_ID) };
}

// ── Condenser backend (the swap point) ──────────────────────────────────────

/** Accumulates token usage + truncation across a run. */
interface RunStats {
	inputTokens: number;
	outputTokens: number;
	calls: number;
	truncated: boolean;
}

/**
 * An `AttachmentCondenser` backed by a chosen model. It IGNORES the `model` id
 * `extractDocument` passes (production's Gemini) and substitutes ours — that's
 * the whole point of the swap — and records usage for the cost print.
 */
function makeCondenser(
	model: LanguageModel,
	stats: RunStats,
	providerOptions?: SubGenerationProviderOptions,
): AttachmentCondenser {
	const track = (result: SubGenerationResult) => {
		stats.calls += 1;
		stats.inputTokens += result.usage?.inputTokens ?? 0;
		stats.outputTokens += result.usage?.outputTokens ?? 0;
		if (result.finishReason === "length") stats.truncated = true;
	};
	return {
		async generatePlainText(opts) {
			const r = await generatePlainTextWith({
				model,
				system: opts.system,
				prompt: opts.prompt,
				maxOutputTokens: opts.maxOutputTokens,
				providerOptions,
			});
			track(r);
			return { text: r.text, truncated: r.finishReason === "length" };
		},
		async extractFromContent(opts) {
			const r = await extractFromContentWith({
				model,
				system: opts.system,
				instruction: opts.instruction,
				file: opts.file,
				maxOutputTokens: opts.maxOutputTokens,
				providerOptions,
			});
			track(r);
			return { text: r.text, truncated: r.finishReason === "length" };
		},
	};
}

// ── Rendering ───────────────────────────────────────────────────────────────

const RULE = "─".repeat(72);
const DOLLARS = (n: number) => `$${n.toFixed(5)}`;

/** Estimated cost of one extract call given token usage + the model's rates. */
function estimateCost(
	stats: RunStats,
	pricing: { input: number; output: number },
): number {
	return (
		(stats.inputTokens / 1_000_000) * pricing.input +
		(stats.outputTokens / 1_000_000) * pricing.output
	);
}

/** Run one model against one file and print the extract block. */
async function runModel(spec: ModelSpec, path: string): Promise<void> {
	const reasoningNote = spec.reasoning ? `, thinking: ${spec.reasoning}` : "";
	console.log(`\n### ${spec.label} (${spec.id}${reasoningNote})`);

	const ext = extname(path).toLowerCase();
	const kind = assetKindForExtension(ext);
	if (!kind || !isDocumentKind(kind)) {
		console.log(
			`  no extract — ${ext || "this file"} is not a document kind. Images are read directly by the model's vision pass; audio/video aren't chat attachments.`,
		);
		return;
	}

	const resolved = resolveModel(spec.key);
	if ("skip" in resolved) {
		console.log(`  ⏭  skipped — ${resolved.skip}`);
		return;
	}

	const stats: RunStats = {
		inputTokens: 0,
		outputTokens: 0,
		calls: 0,
		truncated: false,
	};
	let extract: string;
	try {
		const result = await extractDocument({
			bytes: readFileSync(path),
			mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
			kind,
			filename: basename(path),
			condenser: makeCondenser(resolved.model, stats, spec.providerOptions),
		});
		extract = result.text;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  ⚠️  extraction failed — ${msg}`);
		return;
	}

	const cost = estimateCost(stats, spec.pricing);
	console.log(
		`  tokens: ${stats.inputTokens.toLocaleString()} in → ${stats.outputTokens.toLocaleString()} out  ·  est. cost ${DOLLARS(cost)}  ·  ${stats.calls} call(s)`,
	);
	if (stats.truncated) {
		console.log(
			"  ⚠️  hit the output ceiling — extract is truncated; the SA gets a note saying so.",
		);
	}
	console.log(`  extract: ${extract.length.toLocaleString()} chars\n`);
	console.log(extract);
}

// ── Entry ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const files: string[] = [];
	let selection: "haiku" | "gemini" | "both" = "both";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--model") {
			const next = argv[i + 1];
			if (next !== "haiku" && next !== "gemini" && next !== "both") {
				console.error(`--model must be haiku | gemini | both (got "${next}")`);
				process.exit(1);
			}
			selection = next;
			i += 1;
		} else {
			files.push(argv[i]);
		}
	}

	if (files.length === 0) {
		console.error(
			"Usage: npx tsx scripts/preview-attachment-condense.ts <file...> [--model haiku|gemini|both]",
		);
		process.exit(1);
	}

	const specs: ModelSpec[] =
		selection === "both"
			? [MODEL_SPECS.haiku, MODEL_SPECS.gemini]
			: [MODEL_SPECS[selection]];

	for (const path of files) {
		console.log(`\n${RULE}\n📄  ${path}\n${RULE}`);
		for (const spec of specs) {
			await runModel(spec, path);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
