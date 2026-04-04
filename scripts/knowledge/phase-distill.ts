/** Phase 3: Distill — cluster relevant pages by tags and generate knowledge files */

import { createAnthropic } from "@ai-sdk/anthropic";
import { Output, streamText } from "ai";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { z } from "zod";
import { log, logCost, logSummary } from "./log.js";
import { loadCrawledPages } from "./phase-crawl.js";
import type {
	CrawledPage,
	DiscoveryResult,
	PipelineConfig,
	TriageResult,
} from "./types.js";

const DISTILL_DIR = ".data/confluence-cache/distilled";
const SONNET_MODEL = "claude-sonnet-4-6";
const SONNET_INPUT_COST = 3; // $/M tokens
const SONNET_OUTPUT_COST = 15; // $/M tokens

const tagClusterSchema = z.object({
	clusters: z.array(
		z.object({
			name: z.string().describe("Human-readable topic name"),
			filename: z
				.string()
				.describe("Kebab-case filename without .md extension"),
			description: z
				.string()
				.describe("1-2 sentence summary of what knowledge this cluster covers"),
			tags: z
				.array(z.string())
				.describe("Every tag string that belongs in this cluster"),
		}),
	),
});

type TagCluster = z.infer<typeof tagClusterSchema>["clusters"][number];

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

/** Assign pages to clusters deterministically using tag overlap */
function assignPagesToClusters(
	triageEntries: { pageId: string; topicTags: string[] }[],
	clusters: TagCluster[],
): Map<string, string[]> {
	// Build tag → cluster name map
	const tagToCluster = new Map<string, string>();
	for (const cluster of clusters) {
		for (const tag of cluster.tags) {
			tagToCluster.set(tag, cluster.name);
		}
	}

	// For each page, count cluster hits and assign to the one with most
	const clusterPages = new Map<string, string[]>();
	for (const cluster of clusters) {
		clusterPages.set(cluster.name, []);
	}

	let orphaned = 0;
	for (const entry of triageEntries) {
		const hits = new Map<string, number>();
		for (const tag of entry.topicTags) {
			const clusterName = tagToCluster.get(tag);
			if (clusterName) {
				hits.set(clusterName, (hits.get(clusterName) ?? 0) + 1);
			}
		}

		if (hits.size === 0) {
			// No tags matched any cluster — assign to the largest cluster as catch-all
			orphaned++;
			let largest = clusters[0].name;
			let largestSize = 0;
			for (const [name, pages] of clusterPages) {
				if (pages.length > largestSize) {
					largest = name;
					largestSize = pages.length;
				}
			}
			clusterPages.get(largest)!.push(entry.pageId);
		} else {
			// Assign to the cluster with the most tag hits
			let bestCluster = "";
			let bestCount = 0;
			for (const [name, count] of hits) {
				if (count > bestCount) {
					bestCluster = name;
					bestCount = count;
				}
			}
			clusterPages.get(bestCluster)!.push(entry.pageId);
		}
	}

	if (orphaned > 0) {
		log(
			"Distill",
			`  ${orphaned} pages had no matching tags — assigned to catch-all cluster`,
		);
	}

	return clusterPages;
}

export async function distill(
	config: PipelineConfig,
	discovery: DiscoveryResult,
	triageResult: TriageResult,
): Promise<void> {
	const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });

	// Load relevant pages (6+ relevance)
	const relevantEntries = triageResult.entries.filter((e) => e.relevance >= 6);
	const relevantIds = new Set(relevantEntries.map((e) => e.pageId));
	const allPages = loadCrawledPages(discovery);
	const relevantPages = allPages.filter((p) => relevantIds.has(p.id));
	const pageMap = new Map(relevantPages.map((p) => [p.id, p]));

	log("Distill", `${relevantPages.length} relevant pages loaded`);

	if (relevantPages.length === 0) {
		throw new Error("No relevant pages found. Run the triage phase first.");
	}

	// Collect all unique tags
	const allTags = new Set<string>();
	for (const entry of relevantEntries) {
		for (const tag of entry.topicTags) allTags.add(tag);
	}
	const tagArray = [...allTags].sort();

	log(
		"Distill",
		`${tagArray.length} unique tags across ${relevantEntries.length} pages`,
	);

	// Cost estimate
	const tagsInputChars = JSON.stringify(tagArray).length;
	const clusteringInputTokens = estimateTokens(tagsInputChars) + 500;
	const clusteringOutputTokens = 3000;
	const clusteringCost =
		(clusteringInputTokens / 1_000_000) * SONNET_INPUT_COST +
		(clusteringOutputTokens / 1_000_000) * SONNET_OUTPUT_COST;

	const totalContentChars = relevantPages.reduce(
		(sum, p) => sum + p.content.length,
		0,
	);
	const distillInputTokens = estimateTokens(totalContentChars);
	const distillOutputTokens = 12 * 3000;
	const distillCost =
		(distillInputTokens / 1_000_000) * SONNET_INPUT_COST +
		(distillOutputTokens / 1_000_000) * SONNET_OUTPUT_COST;

	const estCost = clusteringCost + distillCost;

	log("Distill", "Cost estimate:");
	log(
		"Distill",
		`  Step 1 — Tag clustering (${tagArray.length} tag strings, 1 API call): ~$${clusteringCost.toFixed(2)} (~${clusteringInputTokens.toLocaleString()} input tokens)`,
	);
	log(
		"Distill",
		`  Step 2 — Distillation (full page content, ~12 separate API calls): ~$${distillCost.toFixed(2)} (~${distillInputTokens.toLocaleString()} input tokens)`,
	);
	log("Distill", `  Total: ~$${estCost.toFixed(2)}`);

	if (!config.skipConfirmation) {
		const ok = await confirm(`[Distill] Proceed? (~$${estCost.toFixed(2)})`);
		if (!ok) {
			log("Distill", "Aborted by user.");
			process.exit(0);
		}
	}

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCost = 0;

	// Step 1: Cluster the tags
	log("Distill", "");
	log("Distill", `Step 1: Clustering ${tagArray.length} tags...`);
	log(
		"Distill",
		`  Sending tag array (~${estimateTokens(tagsInputChars).toLocaleString()} tokens) to Sonnet...`,
	);

	const clusterStream = streamText({
		model: anthropic(SONNET_MODEL),
		output: Output.object({ schema: tagClusterSchema }),
		system: `You are organizing CommCare platform knowledge for an AI agent that builds CommCare apps.

You will receive a flat array of topic tag strings. These tags were extracted from Confluence pages about CommCare. Many are near-duplicates with different formatting (e.g., "case management" vs "case-management").

Define 20-30 topic clusters and assign EVERY SINGLE TAG to exactly one cluster. No tag may be left out. Keep clusters granular — no cluster should be so broad that it covers more than ~40-50 tags. Each cluster should have:
- name: descriptive topic name oriented around what an AI app-builder needs
- filename: kebab-case, no .md extension
- description: 1-2 sentences explaining what knowledge this cluster covers
- tags: the exact tag strings from the input that belong in this cluster

Guidelines:
- Normalize near-duplicates into the same cluster (e.g., "form design" and "form-design" go together)
- Orient clusters around app-building concepts, not Confluence organization
- Aim for roughly even cluster sizes — split broad topics (e.g., "case management" is too broad; split into case creation, case lists, case sharing, parent-child cases, etc.)
- EVERY tag in the input array MUST appear in exactly one cluster's tags array`,
		prompt: JSON.stringify(tagArray),
	});

	// Stream clustering progress — render full table in-place
	let lastLineCount = 0;
	for await (const partial of clusterStream.partialOutputStream) {
		const arr = (partial as z.infer<typeof tagClusterSchema>)?.clusters;
		if (!arr?.length) continue;

		// Move cursor up to overwrite previous table
		if (lastLineCount > 0) {
			process.stdout.write(`\x1b[${lastLineCount}A`);
		}

		// Render table
		const lines: string[] = [];
		for (let c = 0; c < arr.length; c++) {
			const cl = arr[c];
			const name = cl?.name ?? "...";
			const tags = cl?.tags?.length ?? 0;
			const status =
				c < arr.length - 1 ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⟳\x1b[0m";
			lines.push(
				`  ${status} ${(c + 1).toString().padStart(2)}. ${name.padEnd(50).slice(0, 50)} ${String(tags).padStart(4)} tags`,
			);
		}

		for (const line of lines) {
			process.stdout.write(`\x1b[2K${line}\n`);
		}
		lastLineCount = lines.length;
	}
	process.stdout.write("\n");

	const finalOutput = await clusterStream.output;
	const tagClusters = finalOutput!.clusters;
	const clusterUsage = await clusterStream.usage;
	totalInputTokens += clusterUsage.inputTokens ?? 0;
	totalOutputTokens += clusterUsage.outputTokens ?? 0;
	totalCost += logCost(
		"Distill",
		"  Clustering done",
		clusterUsage.inputTokens ?? 0,
		clusterUsage.outputTokens ?? 0,
		SONNET_INPUT_COST,
		SONNET_OUTPUT_COST,
	);

	// Log clusters
	const assignedTags = new Set(tagClusters.flatMap((c) => c.tags));
	const missingTags = tagArray.filter((t) => !assignedTags.has(t));
	log(
		"Distill",
		`  ${tagClusters.length} clusters defined, ${assignedTags.size}/${tagArray.length} tags assigned`,
	);
	if (missingTags.length > 0) {
		log(
			"Distill",
			`  WARNING: ${missingTags.length} tags not assigned: ${missingTags.slice(0, 10).join(", ")}${missingTags.length > 10 ? "..." : ""}`,
		);
	}
	for (const c of tagClusters) {
		log("Distill", `    ${c.name} (${c.filename}.md) — ${c.tags.length} tags`);
	}

	// Step 2: Assign pages to clusters deterministically
	log("Distill", "");
	log("Distill", "Assigning pages to clusters by tag overlap...");

	const clusterPages = assignPagesToClusters(relevantEntries, tagClusters);

	for (const c of tagClusters) {
		const pages = clusterPages.get(c.name) ?? [];
		log("Distill", `  ${c.name}: ${pages.length} pages`);
	}

	// Step 3: Distill each cluster
	fs.mkdirSync(DISTILL_DIR, { recursive: true });

	log("Distill", "");
	log("Distill", `Step 3: Distilling ${tagClusters.length} clusters...`);

	const MAX_INPUT_TOKENS = 140_000; // Stay well under 200K limit (system prompt + output headroom)

	for (let i = 0; i < tagClusters.length; i++) {
		const cluster = tagClusters[i];
		const pageIds = clusterPages.get(cluster.name) ?? [];

		const sourcePages = pageIds
			.map((id) => pageMap.get(id))
			.filter((p): p is CrawledPage => p !== undefined);

		if (sourcePages.length === 0) {
			log(
				"Distill",
				`  [${i + 1}/${tagClusters.length}] ${cluster.name} — no pages, skipping`,
			);
			continue;
		}

		// Split pages into batches that fit within context limit
		const batches: CrawledPage[][] = [];
		let currentBatch: CrawledPage[] = [];
		let currentTokens = 0;
		for (const page of sourcePages) {
			const pageTokens = estimateTokens(
				page.content.length + page.title.length + 50,
			);
			if (
				currentTokens + pageTokens > MAX_INPUT_TOKENS &&
				currentBatch.length > 0
			) {
				batches.push(currentBatch);
				currentBatch = [];
				currentTokens = 0;
			}
			currentBatch.push(page);
			currentTokens += pageTokens;
		}
		if (currentBatch.length > 0) batches.push(currentBatch);

		log(
			"Distill",
			`  [${i + 1}/${tagClusters.length}] ${cluster.name} — ${sourcePages.length} pages in ${batches.length} batch${batches.length > 1 ? "es" : ""}`,
		);

		const distillSystem = `You are creating a technical reference for an AI agent that builds CommCare apps. The agent generates app structures (modules, forms, questions with various types, case configuration, form logic) from natural language descriptions. It knows the schema of what it can produce but lacks deep platform knowledge.

Given these source pages about "${cluster.name}", distill the knowledge into a concise reference covering:
- Core concepts and mental models (how does this feature/system actually work under the hood?)
- Available options and when to use each one
- Implementation details — instance names, XPath patterns, configuration fields, property names
- Relationships to other CommCare features
- Common mistakes, anti-patterns, or non-obvious constraints
- Concrete examples where they clarify a concept

Write for an AI agent, not a human learner. Be precise and information-dense. This is a reference card, not a tutorial. The agent already understands XML forms, case management basics, and CommCare's data model at a structural level — it needs the depth and nuance to make expert-level design decisions.

Format as clean markdown. Start with a level-1 heading matching the topic name. Use level-2 and level-3 headings to organize sections. Include code blocks for XPath patterns, XML snippets, and configuration examples where they add clarity.`;

		const batchOutputs: string[] = [];

		for (let b = 0; b < batches.length; b++) {
			const batch = batches[b];
			const sourceContent = batch
				.map((p) => `=== ${p.title} (${p.spaceKey}) ===\n\n${p.content}`)
				.join("\n\n---\n\n");

			const inputTokenEst = estimateTokens(sourceContent.length);
			const batchLabel =
				batches.length > 1 ? ` (batch ${b + 1}/${batches.length})` : "";
			log(
				"Distill",
				`    ${batchLabel} ${batch.length} pages, ~${inputTokenEst.toLocaleString()} input tokens — sending...`,
			);

			try {
				const isFollowup = b > 0;
				const prompt = isFollowup
					? `Topic: ${cluster.name}\nDescription: ${cluster.description}\n\nContinuing with more source pages. Add to the reference — do not repeat what was already covered.\n\nSource pages (${batch.length}):\n\n${sourceContent}`
					: `Topic: ${cluster.name}\nDescription: ${cluster.description}\n\nSource pages (${batch.length}):\n\n${sourceContent}`;

				const result = streamText({
					model: anthropic(SONNET_MODEL),
					system: distillSystem,
					prompt,
				});

				let fullText = "";
				process.stdout.write("\n");
				for await (const chunk of result.textStream) {
					fullText += chunk;
					process.stdout.write(chunk);
				}
				process.stdout.write("\n");

				batchOutputs.push(fullText);

				const usage = await result.usage;
				totalInputTokens += usage.inputTokens ?? 0;
				totalOutputTokens += usage.outputTokens ?? 0;
				const batchCost = logCost(
					"Distill",
					`    ${cluster.name}${batchLabel}`,
					usage.inputTokens ?? 0,
					usage.outputTokens ?? 0,
					SONNET_INPUT_COST,
					SONNET_OUTPUT_COST,
				);
				totalCost += batchCost;
				log("Distill", `    Running total: $${totalCost.toFixed(4)}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log("Distill", `    ERROR${batchLabel}: ${msg}`);
			}
		}

		// Combine batch outputs and save
		const combined = batchOutputs.join("\n\n");
		if (combined.length > 0) {
			const outputPath = path.join(DISTILL_DIR, `${cluster.filename}.md`);
			fs.writeFileSync(outputPath, combined);
			log(
				"Distill",
				`    Saved: ${outputPath} (${combined.length.toLocaleString()} chars)`,
			);
		}
	}

	// Step 4: Generate index.md
	log("Distill", "");
	log("Distill", "Generating index.md...");

	const indexContent = [
		"# CommCare Knowledge Base",
		"",
		"Distilled platform knowledge for the Solutions Architect agent.",
		`Generated from ${relevantPages.length} Confluence pages on ${new Date().toISOString().split("T")[0]}.`,
		"",
		"## Topics",
		"",
		...tagClusters.map((c) => {
			const outputPath = path.join(DISTILL_DIR, `${c.filename}.md`);
			const exists = fs.existsSync(outputPath);
			const pageCount = clusterPages.get(c.name)?.length ?? 0;
			return `- **[${c.name}](${c.filename}.md)** (${pageCount} pages) — ${c.description}${exists ? "" : " *(failed to generate)*"}`;
		}),
		"",
	].join("\n");

	fs.writeFileSync(path.join(DISTILL_DIR, "index.md"), indexContent);
	log("Distill", `Written: ${path.join(DISTILL_DIR, "index.md")}`);

	// Summary
	const generatedFiles = tagClusters.filter((c) =>
		fs.existsSync(path.join(DISTILL_DIR, `${c.filename}.md`)),
	);

	logSummary("Distill", [
		`Clusters: ${tagClusters.length}`,
		`Knowledge files generated: ${generatedFiles.length}`,
		`Source pages used: ${relevantPages.length}`,
		"",
		"Files:",
		...generatedFiles.map(
			(c) =>
				`  ${c.filename}.md — ${c.name} (${clusterPages.get(c.name)?.length ?? 0} pages)`,
		),
		"",
		`Total cost: $${totalCost.toFixed(4)} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`,
	]);
}
