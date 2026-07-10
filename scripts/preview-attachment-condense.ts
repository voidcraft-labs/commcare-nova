/**
 * Preview the EXACT requirements extract a document condenses to — the text the
 * Solutions Architect reads in place of the raw file ("What Nova reads"),
 * without paying for the SA's tool loop.
 *
 * Drives the REAL extraction core (`extractDocument`: same prompt, same
 * docx/xlsx/PDF routing the upload route uses) against local files, with a
 * SWAPPABLE condenser model:
 *
 *   - `luna`   — OpenAI GPT-5.6 Luna, the official production summarizer
 *     (reuses production's exact model id + reasoning options).
 *   - `gemini` — Google Gemini 3.5 Flash, the prior summarizer, kept as a
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
 *   npx tsx scripts/preview-attachment-condense.ts <file...> [--model luna|gemini|both]
 *
 * Defaults to `both`. Both models route through the AI Gateway, so the one
 * AI_GATEWAY_API_KEY from .env covers them (no key = cleanly skipped, not a
 * crash).
 *
 * Cost: one Luna and/or one Gemini call per file (cents) — never the SA.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { GoogleLanguageModelOptions } from "@ai-sdk/google";
import { createGateway, type LanguageModel } from "ai";
import {
	type AttachmentCondenser,
	CONDENSER_MODEL,
	CONDENSER_PROVIDER_OPTIONS,
	extractDocument,
} from "../lib/agent/documentExtraction";
import {
	generateObjectWith,
	type SubGenerationProviderOptions,
} from "../lib/agent/subGeneration";
import {
	assetKindForExtension,
	isDocumentKind,
} from "../lib/domain/multimedia";
import { MODEL_PRICING } from "../lib/models";

// ── Model + pricing config ──────────────────────────────────────────────────

/** Single-sourced from the production extractor so the preview can't drift from
 *  the model the route actually calls. */
const LUNA_ID = CONDENSER_MODEL;
const GEMINI_ID = "google/gemini-3.5-flash";

/**
 * Gemini 3.5 Flash pricing, $/1M tokens (paid tier). Output is billed inclusive
 * of thinking tokens, so the printed output count IS the billed count. Luna's
 * rates come from the app's own `MODEL_PRICING` (single source of truth). Verify
 * against https://ai.google.dev/gemini-api/docs/pricing if Google revises.
 *
 * NOTE: the estimate prices all input at the base uncached rate. Extraction is
 * a single one-shot call per document, so no cached prefix is reused; OpenAI's
 * implicit caching can still bill part of the prompt as a cache write (1.25×
 * input), which this estimate ignores — close enough for a quality/price
 * comparison. OpenAI, like Gemini, bills reasoning tokens as output.
 */
const GEMINI_PRICING = { input: 1.5, output: 9 } as const;
const LUNA_PRICING = MODEL_PRICING[LUNA_ID];

/**
 * The prior production summarizer's provider options, kept verbatim so the
 * baseline reproduces the extracts Nova used to store: medium thinking with
 * streamed thoughts, and high media resolution for PDF rasterization.
 */
const GEMINI_PROVIDER_OPTIONS: SubGenerationProviderOptions = {
	google: {
		thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
		mediaResolution: "MEDIA_RESOLUTION_HIGH",
	} satisfies GoogleLanguageModelOptions,
};

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

type ModelKey = "luna" | "gemini";

interface ModelSpec {
	key: ModelKey;
	label: string;
	id: string;
	pricing: { input: number; output: number };
	/** Per-call provider options (reasoning depth, and for Gemini the PDF media
	 *  resolution). */
	providerOptions?: SubGenerationProviderOptions;
	/** Reasoning depth shown in the result header, when the model exposes one. */
	reasoning?: string;
}

const MODEL_SPECS: Record<ModelKey, ModelSpec> = {
	luna: {
		key: "luna",
		label: "GPT-5.6 Luna",
		id: LUNA_ID,
		pricing: LUNA_PRICING,
		providerOptions: CONDENSER_PROVIDER_OPTIONS,
		reasoning: "xhigh",
	},
	gemini: {
		key: "gemini",
		label: "Gemini 3.5 Flash",
		id: GEMINI_ID,
		pricing: GEMINI_PRICING,
		providerOptions: GEMINI_PROVIDER_OPTIONS,
		reasoning: "medium",
	},
};

/** Resolve a model to a `LanguageModel`, or a skip reason when the gateway key
 *  is unset (both models ride the same credential). */
function resolveModel(
	spec: ModelSpec,
): { model: LanguageModel } | { skip: string } {
	const apiKey = process.env.AI_GATEWAY_API_KEY;
	if (!apiKey) return { skip: "AI_GATEWAY_API_KEY not set" };
	const gateway = createGateway({ apiKey });
	return { model: gateway(spec.id) };
}

// ── Condenser backend (the swap point) ──────────────────────────────────────

/** Accumulates token usage + truncation across a run. */
interface RunStats {
	inputTokens: number;
	outputTokens: number;
	calls: number;
}

/**
 * An `AttachmentCondenser` backed by a chosen model. It IGNORES the `model` id
 * `extractDocument` passes (production's Luna) and substitutes ours — that's
 * the whole point of the swap — and records usage for the cost print.
 */
function makeCondenser(
	model: LanguageModel,
	stats: RunStats,
	providerOptions?: SubGenerationProviderOptions,
): AttachmentCondenser {
	return {
		// The one structured extraction call. Substitutes THIS run's model for the
		// id extractDocument passes (production's Luna) — the whole point of the
		// swap — and records usage for the cost print.
		async extractDocumentStructured(opts) {
			const r = await generateObjectWith({
				model,
				system: opts.system,
				schema: opts.schema,
				prompt: opts.prompt,
				file: opts.file,
				instruction: opts.instruction,
				maxOutputTokens: opts.maxOutputTokens,
				providerOptions: providerOptions ?? opts.providerOptions,
			});
			stats.calls += 1;
			stats.inputTokens += r.usage?.inputTokens ?? 0;
			stats.outputTokens += r.usage?.outputTokens ?? 0;
			return { object: r.object, truncated: r.finishReason === "length" };
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
	const reasoningNote = spec.reasoning ? `, reasoning: ${spec.reasoning}` : "";
	console.log(`\n### ${spec.label} (${spec.id}${reasoningNote})`);

	const ext = extname(path).toLowerCase();
	const kind = assetKindForExtension(ext);
	if (!kind || !isDocumentKind(kind)) {
		console.log(
			`  no extract — ${ext || "this file"} is not a document kind. Images are read directly by the model's vision pass; audio/video aren't chat attachments.`,
		);
		return;
	}

	const resolved = resolveModel(spec);
	if ("skip" in resolved) {
		console.log(`  ⏭  skipped — ${resolved.skip}`);
		return;
	}

	const stats: RunStats = {
		inputTokens: 0,
		outputTokens: 0,
		calls: 0,
	};
	let result: Awaited<ReturnType<typeof extractDocument>>;
	try {
		result = await extractDocument({
			bytes: readFileSync(path),
			mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
			kind,
			filename: basename(path),
			condenser: makeCondenser(resolved.model, stats, spec.providerOptions),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  ⚠️  extraction failed — ${msg}`);
		return;
	}
	const { extract, title, summary } = result;

	const cost = estimateCost(stats, spec.pricing);
	console.log(
		`  tokens: ${stats.inputTokens.toLocaleString()} in → ${stats.outputTokens.toLocaleString()} out  ·  est. cost ${DOLLARS(cost)}  ·  ${stats.calls} call(s)`,
	);
	// Title/summary come from the same single structured call as the extract
	// (truncation surfaces as a thrown "extraction failed" above, not a partial).
	console.log(`  title:   ${title ?? "—"}`);
	console.log(`  summary: ${summary ?? "—"}`);
	console.log(`  extract: ${extract.length.toLocaleString()} chars\n`);
	console.log(extract);
}

// ── Entry ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const files: string[] = [];
	let selection: "luna" | "gemini" | "both" = "both";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--model") {
			const next = argv[i + 1];
			if (next !== "luna" && next !== "gemini" && next !== "both") {
				console.error(`--model must be luna | gemini | both (got "${next}")`);
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
			"Usage: npx tsx scripts/preview-attachment-condense.ts <file...> [--model luna|gemini|both]",
		);
		process.exit(1);
	}

	const specs: ModelSpec[] =
		selection === "both"
			? [MODEL_SPECS.luna, MODEL_SPECS.gemini]
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
