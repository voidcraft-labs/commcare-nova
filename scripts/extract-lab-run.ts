#!/usr/bin/env -S npx tsx
/**
 * extract-lab-run — run ONE prompt file against ONE document on the PRODUCTION
 * extraction path, and persist the result as isolated artifacts so many
 * candidate prompts can be evaluated in parallel without clobbering a shared
 * file. This is the workhorse the prompt-optimization workflow drives: the
 * `compare-extract-prompts.ts` script only ever reads the single live
 * `extract-prompt-proposed.md`; this one takes an arbitrary `--prompt` path and
 * writes to an arbitrary `--out` prefix.
 *
 *   npx tsx scripts/extract-lab-run.ts \
 *     --prompt <system-prompt.md> --doc <source-doc> --out <out-prefix> \
 *     [--plain] [--source-out <decoded-input.md>]
 *
 * By DEFAULT it runs the real production call — `generateObject` against
 * `extractDocumentSchema` ({ extract, title, summary }, extract-first) on
 * Gemini 3.5 Flash at thinking:high / mediaResolution:high — so the extract we
 * score is byte-for-byte the kind of extract that ships. `--plain` runs a plain
 * `generateText` extract-only call instead (cheaper, isolates the extract from
 * the title/summary schema), kept only for quick format probes.
 *
 * Outputs, all under `--out`:
 *   <out>.extract.md   the extract text the SA would read (the thing we judge)
 *   <out>.meta.json    { promptFile, docFile, model, structured, tokens, costUSD,
 *                        finishReason, chars, title?, summary? }
 * And, when `--source-out` is given AND the doc decodes to text (not a PDF),
 * the exact decoded markdown the model saw — so a judge scores the extract
 * against the model's real input, not a re-decode that might drift.
 *
 * Cost is computed with the same Gemini 3.5 Flash pricing the compare script
 * uses and printed as the final stdout line (`COST_USD <n>`) so the caller can
 * sum spend across runs.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import {
	CONDENSER_MODEL,
	CONDENSER_PROVIDER_OPTIONS,
	docxToMarkdown,
	EXTRACT_MAX_OUTPUT_TOKENS,
	extractDocumentSchema,
	xlsxToMarkdown,
} from "../lib/agent/documentExtraction";
import {
	assetKindForExtension,
	isDocumentKind,
} from "../lib/domain/multimedia";

/** Gemini 3.5 Flash pricing, $/1M tokens (output billed inclusive of thinking).
 *  Mirrors `compare-extract-prompts.ts` so cost numbers are comparable. */
const GEMINI_PRICING = { input: 1.5, output: 9 } as const;

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

/** The model input for a document: decoded text (text/docx/xlsx) or a native
 *  file block + instruction (PDF). Mirrors production `extractDocument`. */
type DocInput =
	| { kind: "text"; prompt: string; decoded: string }
	| {
			kind: "file";
			file: { mediaType: string; data: string };
			instruction: string;
	  };

async function buildInput(path: string): Promise<DocInput> {
	const ext = extname(path).toLowerCase();
	// Production resolves a document's kind by MIME (`assetKindForMimeType`),
	// where `text/csv` → "text"; the EXTENSION helper is only a fallback and
	// omits `.csv`, so map it explicitly here. A CSV decodes as plain UTF-8,
	// exactly as production does for the "text" kind.
	const kind = ext === ".csv" ? "text" : assetKindForExtension(ext);
	if (!kind || !isDocumentKind(kind)) {
		throw new Error(
			`${ext || "this file"} is not a document kind — pass a pdf / docx / xlsx / txt / md / csv.`,
		);
	}
	const bytes = readFileSync(path);
	const filename = basename(path);
	if (kind === "pdf") {
		const mediaType = MIME_BY_EXT[ext] ?? "application/pdf";
		return {
			kind: "file",
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
	// The filename leads the user turn, exactly as production does, so the
	// model can fill the prompt's `Source:` line without inventing it.
	const prompt = `Filename: ${filename}\n\n${body}`;
	return { kind: "text", prompt, decoded: prompt };
}

/** The shared input as the call-arg fragment generate* takes. */
function callArgs(input: DocInput) {
	return input.kind === "file"
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

interface Args {
	prompt: string;
	doc: string;
	out: string;
	plain: boolean;
	sourceOut?: string;
}

function parseArgs(argv: string[]): Args {
	let prompt: string | undefined;
	let doc: string | undefined;
	let out: string | undefined;
	let sourceOut: string | undefined;
	let plain = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--prompt") prompt = argv[++i];
		else if (a === "--doc") doc = argv[++i];
		else if (a === "--out") out = argv[++i];
		else if (a === "--source-out") sourceOut = argv[++i];
		else if (a === "--plain") plain = true;
		else throw new Error(`unknown arg "${a}"`);
	}
	if (!prompt || !doc || !out) {
		throw new Error(
			"usage: extract-lab-run --prompt <file> --doc <file> --out <prefix> [--plain] [--source-out <file>]",
		);
	}
	return { prompt, doc, out, plain, sourceOut };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is unset");
	const model = createGoogleGenerativeAI({ apiKey })(CONDENSER_MODEL);

	const system = readFileSync(args.prompt, "utf-8");
	const input = await buildInput(args.doc);

	// Persist the exact decoded input the model saw (text docs only; a PDF rides
	// native, so there's nothing to dump — the judge reads the PDF directly).
	if (args.sourceOut && input.kind === "text") {
		writeFileSync(args.sourceOut, input.decoded);
	}

	const common = {
		model,
		system,
		maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
		providerOptions: CONDENSER_PROVIDER_OPTIONS,
		...callArgs(input),
	};

	let extract: string;
	let title: string | undefined;
	let summary: string | undefined;
	let usage: { inputTokens?: number; outputTokens?: number } | undefined;
	let finishReason: string;
	if (args.plain) {
		const r = await generateText(common);
		extract = r.text;
		usage = r.usage;
		finishReason = r.finishReason;
	} else {
		const r = await generateObject({
			...common,
			schema: extractDocumentSchema,
		});
		extract = r.object.extract;
		title = r.object.title;
		summary = r.object.summary;
		usage = r.usage;
		finishReason = r.finishReason;
	}

	const inTok = usage?.inputTokens ?? 0;
	const outTok = usage?.outputTokens ?? 0;
	const costUSD =
		(inTok / 1_000_000) * GEMINI_PRICING.input +
		(outTok / 1_000_000) * GEMINI_PRICING.output;

	writeFileSync(`${args.out}.extract.md`, extract);
	writeFileSync(
		`${args.out}.meta.json`,
		JSON.stringify(
			{
				promptFile: args.prompt,
				docFile: args.doc,
				model: CONDENSER_MODEL,
				structured: !args.plain,
				inputTokens: inTok,
				outputTokens: outTok,
				costUSD: Number(costUSD.toFixed(6)),
				finishReason,
				chars: extract.length,
				title,
				summary,
			},
			null,
			2,
		),
	);

	console.log(
		`OK ${basename(args.doc)} via ${basename(args.prompt)} · ${inTok.toLocaleString()} in → ${outTok.toLocaleString()} out · ${extract.length.toLocaleString()} chars · finish:${finishReason}`,
	);
	// Final line, machine-parseable, so the caller can sum spend.
	console.log(`COST_USD ${costUSD.toFixed(6)}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
