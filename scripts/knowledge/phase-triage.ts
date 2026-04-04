/** Phase 2: Triage — classify crawled pages for relevance using Haiku */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { log, logCost, logSummary } from "./log.js";
import { loadCrawledPages } from "./phase-crawl.js";
import type {
	DiscoveryResult,
	PipelineConfig,
	TriageEntry,
	TriageResult,
} from "./types.js";

const CACHE_DIR = ".data/confluence-cache";
const TRIAGE_PATH = path.join(CACHE_DIR, "triage.json");
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_INPUT_COST = 1; // $/M tokens
const HAIKU_OUTPUT_COST = 5; // $/M tokens
const MAX_CONTENT_CHARS = 6000; // ~1500 tokens per page for triage

const triagePageSchema = z.object({
	pageId: z.string(),
	relevance: z.number().describe("0-10 relevance score"),
	knowledgeType: z.enum([
		"conceptual",
		"how-to",
		"reference",
		"troubleshooting",
		"best-practices",
		"example",
		"api-docs",
	]),
	topicTags: z.array(z.string()),
	quality: z.enum(["rich", "moderate", "stub"]),
	reasoning: z.string(),
});

const triageBatchSchema = z.object({
	pages: z.array(triagePageSchema),
});

function truncateContent(content: string): string {
	if (content.length <= MAX_CONTENT_CHARS) return content;
	return `${content.slice(0, MAX_CONTENT_CHARS)}\n... [truncated]`;
}

function estimateTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

async function confirm(message: string): Promise<boolean> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(`${message} (y/N) `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y");
		});
	});
}

function saveTriage(entries: TriageEntry[]) {
	const passedPages = entries.filter((e) => e.relevance >= 6).length;
	const result: TriageResult = {
		entries,
		timestamp: new Date().toISOString(),
		totalPages: entries.length,
		passedPages,
	};
	fs.writeFileSync(TRIAGE_PATH, JSON.stringify(result, null, 2));
}

export async function triage(
	config: PipelineConfig,
	discovery: DiscoveryResult,
): Promise<TriageResult> {
	// Load crawled pages
	const allPages = loadCrawledPages(discovery);
	log("Triage", `Loaded ${allPages.length} crawled pages`);

	// Resume from partial triage if it exists
	const existingEntries: TriageEntry[] = [];
	const triagedIds = new Set<string>();
	if (fs.existsSync(TRIAGE_PATH)) {
		const cached = JSON.parse(
			fs.readFileSync(TRIAGE_PATH, "utf-8"),
		) as TriageResult;
		// If it was a complete run, return it
		if (cached.totalPages >= allPages.length) {
			log(
				"Triage",
				`Found complete triage: ${cached.totalPages} pages, ${cached.passedPages} passed (6+)`,
			);
			return cached;
		}
		// Otherwise resume from where we left off
		existingEntries.push(...cached.entries);
		for (const e of cached.entries) triagedIds.add(e.pageId);
		log(
			"Triage",
			`Resuming: ${existingEntries.length}/${allPages.length} already triaged`,
		);
	}

	const pages = allPages.filter((p) => !triagedIds.has(p.id));

	if (pages.length === 0) {
		throw new Error("No crawled pages found. Run the crawl phase first.");
	}

	// Cost estimate
	const totalContentChars = pages.reduce(
		(sum, p) => sum + Math.min(p.content.length, MAX_CONTENT_CHARS),
		0,
	);
	const estInputTokens = estimateTokens(totalContentChars + pages.length * 500); // content + prompt overhead
	const estOutputTokens = pages.length * 80; // ~80 tokens per classification
	const estCost =
		(estInputTokens / 1_000_000) * HAIKU_INPUT_COST +
		(estOutputTokens / 1_000_000) * HAIKU_OUTPUT_COST;

	log(
		"Triage",
		`Estimated cost: ~$${estCost.toFixed(2)} (${estInputTokens.toLocaleString()} input + ${estOutputTokens.toLocaleString()} output tokens)`,
	);

	if (!config.skipConfirmation) {
		const ok = await confirm(
			`[Triage] Proceed with triaging ${pages.length} pages (~$${estCost.toFixed(2)})?`,
		);
		if (!ok) {
			log("Triage", "Aborted by user.");
			process.exit(0);
		}
	}

	const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
	const entries: TriageEntry[] = [...existingEntries];
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCost = 0;

	// Process in batches
	const batchSize = config.triageBatchSize;
	for (let i = 0; i < pages.length; i += batchSize) {
		const batch = pages.slice(i, i + batchSize);
		const batchNum = Math.floor(i / batchSize) + 1;
		const totalBatches = Math.ceil(pages.length / batchSize);

		try {
			const result = await generateObject({
				model: anthropic(HAIKU_MODEL),
				schema: triageBatchSchema,
				system: `You are classifying Confluence pages for relevance to an AI agent that builds CommCare apps. The agent generates app structures (modules, forms, questions, case configuration, form logic) from natural language.

Rate each page:
- **relevance** (0-10): How useful for an AI building CommCare apps? 0 = irrelevant (HR, sales, internal process). 10 = directly teaches CommCare app-building concepts.
- **knowledgeType**: conceptual, how-to, reference, troubleshooting, best-practices, example, api-docs
- **topicTags**: Specific CommCare concepts (e.g., "case management", "lookup tables", "itemsets", "XPath", "form actions", "mobile workers", "case sharing", "repeat groups", "fixtures", "instances", "multimedia", "form logic", "case list configuration", "detail screens", "user roles", "locations", "stock management", "scheduling", "integrations", "data forwarding", "question types", "form design", "case properties")
- **quality**: "rich" = substantial, detailed content. "moderate" = useful but brief. "stub" = skeleton/placeholder/very short.
- **reasoning**: 1 sentence explaining the score.`,
				prompt: batch
					.map(
						(p) =>
							`--- PAGE ${p.id} ---\nTitle: ${p.title}\nSpace: ${p.spaceKey}\n\n${truncateContent(p.content)}`,
					)
					.join("\n\n"),
			});

			// Map results back, ensuring we have entries for all pages in batch
			for (const page of batch) {
				const classification = result.object.pages.find(
					(c) => c.pageId === page.id,
				);
				if (classification) {
					entries.push({
						...classification,
						title: page.title,
						spaceKey: page.spaceKey,
					});
				} else {
					// Fallback — page wasn't classified
					entries.push({
						pageId: page.id,
						title: page.title,
						spaceKey: page.spaceKey,
						relevance: 0,
						knowledgeType: "conceptual",
						topicTags: [],
						quality: "stub",
						reasoning: "Not classified by model",
					});
				}
			}

			// Track usage
			const usage = result.usage;
			totalInputTokens += usage.inputTokens ?? 0;
			totalOutputTokens += usage.outputTokens ?? 0;
			totalCost += logCost(
				"Triage",
				`Batch ${batchNum}/${totalBatches}`,
				usage.inputTokens ?? 0,
				usage.outputTokens ?? 0,
				HAIKU_INPUT_COST,
				HAIKU_OUTPUT_COST,
			);

			// Save incrementally after each batch
			saveTriage(entries);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log("Triage", `WARNING: Batch ${batchNum} failed: ${msg}`);
			// Add unclassified entries for failed batch
			for (const page of batch) {
				entries.push({
					pageId: page.id,
					title: page.title,
					spaceKey: page.spaceKey,
					relevance: 0,
					knowledgeType: "conceptual",
					topicTags: [],
					quality: "stub",
					reasoning: `Batch failed: ${msg}`,
				});
			}
			saveTriage(entries);
		}
	}

	const passedPages = entries.filter((e) => e.relevance >= 6).length;

	const triageResult: TriageResult = {
		entries,
		timestamp: new Date().toISOString(),
		totalPages: entries.length,
		passedPages,
	};

	// Final save
	fs.writeFileSync(TRIAGE_PATH, JSON.stringify(triageResult, null, 2));
	log("Triage", `Saved triage results to ${TRIAGE_PATH}`);

	// Tag distribution
	const tagCounts = new Map<string, number>();
	for (const entry of entries.filter((e) => e.relevance >= 6)) {
		for (const tag of entry.topicTags) {
			tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
		}
	}
	const topTags = [...tagCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20);

	// Relevance distribution
	const relevanceDist = new Map<number, number>();
	for (const entry of entries) {
		relevanceDist.set(
			entry.relevance,
			(relevanceDist.get(entry.relevance) ?? 0) + 1,
		);
	}

	logSummary("Triage", [
		`Total pages triaged: ${entries.length}`,
		`Passed (relevance 6+): ${passedPages}`,
		`Filtered out: ${entries.length - passedPages}`,
		"",
		"Relevance distribution:",
		...[...relevanceDist.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([score, count]) => `  ${score}: ${count} pages`),
		"",
		"Top topic tags (6+ pages):",
		...topTags.map(([tag, count]) => `  ${tag}: ${count}`),
		"",
		`Total cost: $${totalCost.toFixed(4)} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`,
		"",
		"Top-scoring pages:",
		...entries
			.filter((e) => e.relevance >= 8)
			.sort((a, b) => b.relevance - a.relevance)
			.slice(0, 15)
			.map(
				(e) =>
					`  [${e.relevance}] ${e.title} (${e.spaceKey}) — ${e.topicTags.join(", ")}`,
			),
	]);

	return triageResult;
}
