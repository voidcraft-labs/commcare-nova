#!/usr/bin/env npx tsx
/**
 * Confluence → CommCare Knowledge Base Distillation Pipeline
 *
 * Usage:
 *   npx tsx scripts/sync-knowledge.ts                  # Run all phases
 *   npx tsx scripts/sync-knowledge.ts --phase discover  # Run a single phase
 *   npx tsx scripts/sync-knowledge.ts --phase crawl
 *   npx tsx scripts/sync-knowledge.ts --phase triage
 *   npx tsx scripts/sync-knowledge.ts --phase distill
 *   npx tsx scripts/sync-knowledge.ts --phase reorganize    # Plan + confirm + execute
 *   npx tsx scripts/sync-knowledge.ts --phase reorg-plan    # Plan only (saves to cache)
 *   npx tsx scripts/sync-knowledge.ts --phase reorg-execute # Execute saved plan
 *   npx tsx scripts/sync-knowledge.ts --yes             # Skip cost confirmations
 *
 * Environment variables:
 *   CONFLUENCE_BASE_URL   — Atlassian Cloud URL (e.g., https://dimagi.atlassian.net/wiki)
 *   CONFLUENCE_EMAIL      — Atlassian account email (optional if Confluence is public)
 *   CONFLUENCE_API_TOKEN  — Atlassian API token (optional if Confluence is public)
 *   ANTHROPIC_API_KEY     — Anthropic API key (for triage + distillation)
 */

import * as fs from "fs";
import * as path from "path";
import type {
	PipelineConfig,
	DiscoveryResult,
	TriageResult,
} from "./knowledge/types.js";
import { discover } from "./knowledge/phase-discover.js";
import { crawl } from "./knowledge/phase-crawl.js";
import { triage } from "./knowledge/phase-triage.js";
import { distill } from "./knowledge/phase-distill.js";
import {
	reorganize,
	reorgPlan,
	reorgExecute,
} from "./knowledge/phase-reorganize.js";

// Load .env if dotenv is available (optional)
try {
	require("dotenv").config();
} catch {
	// dotenv not installed — rely on shell env vars
}

const CACHE_DIR = ".data/confluence-cache";

function parseArgs(): { phase: string | null; skipConfirmation: boolean } {
	const args = process.argv.slice(2);
	let phase: string | null = null;
	let skipConfirmation = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--phase" && args[i + 1]) {
			phase = args[++i];
		} else if (args[i] === "--yes" || args[i] === "-y") {
			skipConfirmation = true;
		}
	}

	if (
		phase &&
		![
			"discover",
			"crawl",
			"triage",
			"distill",
			"reorganize",
			"reorg-plan",
			"reorg-execute",
		].includes(phase)
	) {
		console.error(
			`Unknown phase: ${phase}. Valid phases: discover, crawl, triage, distill, reorganize, reorg-plan, reorg-execute`,
		);
		process.exit(1);
	}

	return { phase, skipConfirmation };
}

function loadConfig(skipConfirmation: boolean): PipelineConfig {
	const confluenceBaseUrl = process.env.CONFLUENCE_BASE_URL;
	const confluenceEmail = process.env.CONFLUENCE_EMAIL;
	const confluenceApiToken = process.env.CONFLUENCE_API_TOKEN;
	const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

	if (!confluenceBaseUrl) {
		console.error("Missing required environment variable: CONFLUENCE_BASE_URL");
		console.error("Set it in .env or export it in your shell.");
		process.exit(1);
	}

	if (!confluenceEmail || !confluenceApiToken) {
		console.log(
			"No CONFLUENCE_EMAIL/CONFLUENCE_API_TOKEN set — using anonymous access.",
		);
	}

	return {
		confluenceBaseUrl,
		confluenceEmail: confluenceEmail ?? "",
		confluenceApiToken: confluenceApiToken ?? "",
		anthropicApiKey: anthropicApiKey ?? "",
		rateLimitMs: parseInt(process.env.RATE_LIMIT_MS ?? "100", 10),
		triageBatchSize: parseInt(process.env.TRIAGE_BATCH_SIZE ?? "5", 10),
		skipConfirmation,
	};
}

function requireAnthropicKey(config: PipelineConfig) {
	if (!config.anthropicApiKey) {
		console.error("ANTHROPIC_API_KEY is required for this phase.");
		process.exit(1);
	}
}

function loadCachedDiscovery(): DiscoveryResult | null {
	const discoveryPath = path.join(CACHE_DIR, "discovery.json");
	if (fs.existsSync(discoveryPath)) {
		return JSON.parse(fs.readFileSync(discoveryPath, "utf-8"));
	}
	return null;
}

function loadCachedTriage(): TriageResult | null {
	const triagePath = path.join(CACHE_DIR, "triage.json");
	if (fs.existsSync(triagePath)) {
		return JSON.parse(fs.readFileSync(triagePath, "utf-8"));
	}
	return null;
}

async function main() {
	const { phase, skipConfirmation } = parseArgs();
	const config = loadConfig(skipConfirmation);

	console.log("\n🔬 CommCare Knowledge Base Sync Pipeline");
	console.log(`   Base URL: ${config.confluenceBaseUrl}`);
	console.log(`   Phase: ${phase ?? "all"}\n`);

	const shouldRun = (p: string) => !phase || phase === p;

	// Phase 0: Discover
	let discoveryResult: DiscoveryResult | null = null;
	if (shouldRun("discover")) {
		discoveryResult = await discover(config);
	}

	// Phase 1: Crawl
	if (shouldRun("crawl")) {
		discoveryResult ??= loadCachedDiscovery();
		if (!discoveryResult) {
			console.error("No discovery data found. Run --phase discover first.");
			process.exit(1);
		}
		await crawl(config, discoveryResult);
	}

	// Phase 2: Triage
	let triageResult: TriageResult | null = null;
	if (shouldRun("triage")) {
		requireAnthropicKey(config);
		discoveryResult ??= loadCachedDiscovery();
		if (!discoveryResult) {
			console.error("No discovery data found. Run --phase discover first.");
			process.exit(1);
		}
		triageResult = await triage(config, discoveryResult);
	}

	// Phase 3: Distill
	if (shouldRun("distill")) {
		requireAnthropicKey(config);
		discoveryResult ??= loadCachedDiscovery();
		triageResult ??= loadCachedTriage();
		if (!discoveryResult) {
			console.error("No discovery data found. Run --phase discover first.");
			process.exit(1);
		}
		if (!triageResult) {
			console.error("No triage data found. Run --phase triage first.");
			process.exit(1);
		}
		await distill(config, discoveryResult, triageResult);
	}

	// Phase 4: Reorganize — must be explicitly requested (not part of "run all")
	if (phase === "reorganize") {
		requireAnthropicKey(config);
		await reorganize(config);
	} else if (phase === "reorg-plan") {
		requireAnthropicKey(config);
		await reorgPlan(config);
	} else if (phase === "reorg-execute") {
		requireAnthropicKey(config);
		await reorgExecute(config);
	}

	console.log("\nDone!");
}

main().catch((err) => {
	console.error("\nFatal error:", err.message ?? err);
	process.exit(1);
});
