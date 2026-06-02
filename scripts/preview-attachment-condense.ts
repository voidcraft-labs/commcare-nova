/**
 * Preview the EXACT text a document attachment condenses to before it reaches
 * the Solutions Architect — without paying for the SA's Opus tool loop.
 *
 * This drives the REAL `prepareAttachments` pipeline (same routing, same
 * extraction prompt, same docx/xlsx conversion) against local files, with a
 * SWAPPABLE condenser model:
 *
 *   - `haiku`  — Anthropic claude-haiku-4-5 (what production uses today)
 *   - `gemini` — Google gemini-3.5-flash
 *
 * The pipeline is unchanged; only the model backend differs. That works because
 * `prepareAttachments` depends on the narrow `AttachmentCondenser` interface, and
 * the condensing model call (`lib/agent/subGeneration.ts`) is provider-agnostic —
 * Gemini exists ONLY in this script, never in production.
 *
 * For each file it prints what the SA would receive plus input/output tokens and
 * an estimated cost per model, so you can compare condenser quality AND price.
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
import {
	createGoogleGenerativeAI,
	type GoogleLanguageModelOptions,
} from "@ai-sdk/google";
import type { LanguageModel, UIMessage } from "ai";
import {
	type AttachmentCondenser,
	prepareAttachments,
} from "../lib/agent/attachments";
import {
	extractFromContentWith,
	generatePlainTextWith,
	type SubGenerationProviderOptions,
	type SubGenerationResult,
} from "../lib/agent/subGeneration";
import { MODEL_PRICING } from "../lib/models";

// ── Model + pricing config ──────────────────────────────────────────────────

const HAIKU_ID = "claude-haiku-4-5-20251001";
const GEMINI_ID = "gemini-3.5-flash";

/**
 * Gemini 3.5 Flash pricing, $/1M tokens (paid tier). Output is billed inclusive
 * of thinking tokens, so the printed output count IS the billed count. Haiku's
 * rates come from the app's own `MODEL_PRICING` (single source of truth). Verify
 * against https://ai.google.dev/gemini-api/docs/pricing if Google revises.
 *
 * NOTE: caching does not enter here — condensing is a single one-shot call per
 * document, so neither Anthropic's cache-write/read nor Gemini's cached-token +
 * hourly-storage model applies. Only input + output rates matter.
 */
const GEMINI_PRICING = { input: 1.5, output: 9 } as const;
const HAIKU_PRICING = MODEL_PRICING[HAIKU_ID];

/**
 * Gemini provider options for this quality comparison, both dialed to maximum:
 *
 *   - `thinkingLevel: "high"` — Flash supports 'minimal' | 'low' | 'medium' |
 *     'high' and otherwise defaults lower, so we set it explicitly. Output
 *     billing includes thinking tokens, so the printed cost reflects it.
 *   - `mediaResolution: "MEDIA_RESOLUTION_HIGH"` — governs how a PDF is rendered
 *     to image tiles per page before the model reads it. HIGH preserves small
 *     print, dense tables, and checkbox glyphs in scanned/typeset forms that LOW
 *     would blur away — at the cost of more input tokens per page.
 *
 * This lives only here — Gemini, and its provider options, never touch the
 * production condense path; the shared helper takes `providerOptions` generically.
 */
const GEMINI_PROVIDER_OPTIONS: SubGenerationProviderOptions = {
	google: {
		thinkingConfig: { thinkingLevel: "high" },
		mediaResolution: "MEDIA_RESOLUTION_HIGH",
	} satisfies GoogleLanguageModelOptions,
};

/** data: URL media type by file extension — mirrors the client's accept set. */
const MEDIA_BY_EXT: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
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
		providerOptions: GEMINI_PROVIDER_OPTIONS,
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

/** Accumulates token usage, truncation, and the first model error across a run. */
interface RunStats {
	inputTokens: number;
	outputTokens: number;
	calls: number;
	truncated: boolean;
	error?: unknown;
}

/**
 * An `AttachmentCondenser` backed by a chosen model. It IGNORES the `model` id
 * the pipeline passes (production's Haiku) and substitutes ours — that's the
 * whole point of the swap. On a model error it records the error and re-throws,
 * so the pipeline runs its real fallback (inline the raw doc); the caller reads
 * `stats.error` to print the failure instead of a giant raw dump.
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
			try {
				const r = await generatePlainTextWith({
					model,
					system: opts.system,
					prompt: opts.prompt,
					maxOutputTokens: opts.maxOutputTokens,
					providerOptions,
				});
				track(r);
				return { text: r.text, truncated: r.finishReason === "length" };
			} catch (err) {
				stats.error ??= err;
				throw err;
			}
		},
		async extractFromContent(opts) {
			try {
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
			} catch (err) {
				stats.error ??= err;
				throw err;
			}
		},
	};
}

// ── Rendering ───────────────────────────────────────────────────────────────

const RULE = "─".repeat(72);
const DOLLARS = (n: number) => `$${n.toFixed(5)}`;

/** Estimated cost of one condense call given token usage + the model's rates. */
function estimateCost(
	stats: RunStats,
	pricing: { input: number; output: number },
): number {
	return (
		(stats.inputTokens / 1_000_000) * pricing.input +
		(stats.outputTokens / 1_000_000) * pricing.output
	);
}

/** Turn the rewritten message parts into the printable text the SA would see —
 *  condensed/inlined text verbatim, file parts noted as native pass-throughs. */
function renderParts(parts: UIMessage["parts"]): string {
	return parts
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "file") {
				return `[native pass-through to the SA: ${part.filename ?? "file"} (${part.mediaType}) — sent to Opus as-is, not condensed]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

/** Build the synthetic user message the pipeline rewrites — one file part, the
 *  same shape the chat client produces. */
function fileMessage(path: string): UIMessage {
	const bytes = readFileSync(path);
	const ext = extname(path).toLowerCase();
	const mediaType = MEDIA_BY_EXT[ext] ?? "application/octet-stream";
	const filename = basename(path);
	const url = `data:${mediaType};base64,${bytes.toString("base64")}`;
	return {
		id: `preview-${filename}`,
		role: "user",
		parts: [{ type: "file", mediaType, filename, url }],
	};
}

/** Run one model against one file and print the result block. */
async function runModel(spec: ModelSpec, message: UIMessage): Promise<void> {
	const resolved = resolveModel(spec.key);
	const reasoningNote = spec.reasoning ? `, thinking: ${spec.reasoning}` : "";
	console.log(`\n### ${spec.label} (${spec.id}${reasoningNote})`);
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
	const [rewritten] = await prepareAttachments(
		[message],
		makeCondenser(resolved.model, stats, spec.providerOptions),
	);
	const output = renderParts(rewritten.parts);

	if (stats.error) {
		const msg =
			stats.error instanceof Error ? stats.error.message : String(stats.error);
		console.log(`  ⚠️  model call failed — ${msg}`);
		console.log("  (pipeline fell back to inlining the raw document)");
		return;
	}

	if (stats.calls === 0) {
		console.log(
			"  no model call — an image (sent to Opus's vision pass) or an oversize file. The SA receives the content below as-is.",
		);
	} else {
		const cost = estimateCost(stats, spec.pricing);
		console.log(
			`  tokens: ${stats.inputTokens.toLocaleString()} in → ${stats.outputTokens.toLocaleString()} out  ·  est. cost ${DOLLARS(cost)}  ·  ${stats.calls} call(s)`,
		);
		if (stats.truncated) {
			console.log(
				"  ⚠️  hit the output ceiling — extract is truncated; the SA gets a note saying so.",
			);
		}
	}
	console.log(`  output: ${output.length.toLocaleString()} chars\n`);
	console.log(output);
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
		const message = fileMessage(path);
		for (const spec of specs) {
			await runModel(spec, message);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
