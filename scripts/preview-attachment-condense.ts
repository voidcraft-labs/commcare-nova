/**
 * Preview the EXACT requirements extract a document condenses to — the text the
 * Solutions Architect reads in place of the raw file ("What Nova reads"),
 * without paying for the SA's tool loop.
 *
 * Drives the REAL extraction core (`extractDocument`: same prompt, same
 * docx/xlsx/PDF routing the upload route uses) against local files, on the
 * production condenser (OpenAI GPT-5.6 Luna — the exact model id + reasoning
 * options the upload route uses, so the preview can't drift from what the
 * route stores). Images carry no extract (the model reads them directly), so
 * they're reported and skipped.
 *
 * For each file it prints the extract plus input/output tokens and an
 * estimated cost, so you can judge extract quality AND price.
 *
 * Usage:
 *   npx tsx scripts/preview-attachment-condense.ts <file...>
 *
 * Reads OPENAI_API_KEY from .env (no key = cleanly skipped, not a crash).
 * Cost: one Luna call per file (cents) — never the SA.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
	type AttachmentCondenser,
	CONDENSER_MODEL,
	CONDENSER_PROVIDER_OPTIONS,
	extractDocument,
} from "../lib/agent/documentExtraction";
import { generateObjectWith } from "../lib/agent/subGeneration";
import {
	assetKindForExtension,
	isDocumentKind,
} from "../lib/domain/multimedia";
import { MODEL_PRICING } from "../lib/models";

// ── Model + pricing config ──────────────────────────────────────────────────

/** Single-sourced from the production extractor so the preview can't drift from
 *  the model the route actually calls. */
const LUNA_ID = CONDENSER_MODEL;

/**
 * Luna's rates come from the app's own `MODEL_PRICING` (single source of
 * truth). The estimate prices all input at the base uncached rate: extraction
 * is a single one-shot call per document, so no cached prefix is reused.
 */
const LUNA_PRICING = MODEL_PRICING[LUNA_ID];

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

/** Resolve the condenser model, or a skip reason when the key is unset. */
function resolveModel(): { model: LanguageModel } | { skip: string } {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) return { skip: "OPENAI_API_KEY not set" };
	return { model: createOpenAI({ apiKey })(LUNA_ID) };
}

// ── Condenser backend ───────────────────────────────────────────────────────

/** Accumulates token usage + truncation across a run. */
interface RunStats {
	inputTokens: number;
	outputTokens: number;
	calls: number;
}

/**
 * An `AttachmentCondenser` backed by the resolved model, recording usage for
 * the cost print.
 */
function makeCondenser(
	model: LanguageModel,
	stats: RunStats,
): AttachmentCondenser {
	return {
		// The one structured extraction call, with usage recorded for the
		// cost print.
		async extractDocumentStructured(opts) {
			const r = await generateObjectWith({
				model,
				system: opts.system,
				schema: opts.schema,
				prompt: opts.prompt,
				file: opts.file,
				instruction: opts.instruction,
				maxOutputTokens: opts.maxOutputTokens,
				providerOptions: CONDENSER_PROVIDER_OPTIONS,
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

/** Run the condenser against one file and print the extract block. */
async function runFile(path: string): Promise<void> {
	console.log(`\n### GPT-5.6 Luna (${LUNA_ID}, reasoning: xhigh)`);

	const ext = extname(path).toLowerCase();
	const kind = assetKindForExtension(ext);
	if (!kind || !isDocumentKind(kind)) {
		console.log(
			`  no extract — ${ext || "this file"} is not a document kind. Images are read directly by the model's vision pass; audio/video aren't chat attachments.`,
		);
		return;
	}

	const resolved = resolveModel();
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
			condenser: makeCondenser(resolved.model, stats),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  ⚠️  extraction failed — ${msg}`);
		return;
	}
	const { extract, title, summary } = result;

	const cost = estimateCost(stats, LUNA_PRICING);
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
	const files = process.argv.slice(2);

	if (files.length === 0) {
		console.error(
			"Usage: npx tsx scripts/preview-attachment-condense.ts <file...>",
		);
		process.exit(1);
	}

	for (const path of files) {
		console.log(`\n${RULE}\n📄  ${path}\n${RULE}`);
		await runFile(path);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
