/** Phase 0: Discover — map out what's in the Confluence */

import * as fs from "fs";
import * as path from "path";
import { ConfluenceClient } from "./confluence.js";
import { log, logSummary } from "./log.js";
import type {
	DiscoveryResult,
	PageMeta,
	PipelineConfig,
	SpaceInfo,
} from "./types.js";

const RELEVANT_SPACE_NAMES = [
	"CommCare Division",
	"CommCare Help Site",
	"Global Solutions Division",
	"US Solutions Division",
];

const CACHE_DIR = ".data/confluence-cache";

export async function discover(
	config: PipelineConfig,
): Promise<DiscoveryResult> {
	const client = new ConfluenceClient(
		config.confluenceBaseUrl,
		config.confluenceEmail,
		config.confluenceApiToken,
		config.rateLimitMs,
	);

	// Check for cached discovery
	const discoveryPath = path.join(CACHE_DIR, "discovery.json");
	if (fs.existsSync(discoveryPath)) {
		log("Discover", `Found cached discovery at ${discoveryPath}`);
		const cached = JSON.parse(
			fs.readFileSync(discoveryPath, "utf-8"),
		) as DiscoveryResult;
		log(
			"Discover",
			`Cached: ${cached.spaces.length} spaces, ${cached.pages.length} pages`,
		);
		return cached;
	}

	// List all spaces and filter to relevant ones
	log("Discover", "Listing all Confluence spaces...");
	const allSpaces = await client.listSpaces();
	log("Discover", `Found ${allSpaces.length} total spaces`);

	const relevantSpaces: SpaceInfo[] = [];
	for (const name of RELEVANT_SPACE_NAMES) {
		const space = allSpaces.find((s) => s.name === name);
		if (space) {
			relevantSpaces.push(space);
			log(
				"Discover",
				`  Matched: "${name}" → key=${space.key}, id=${space.id}`,
			);
		} else {
			log("Discover", `  WARNING: Space "${name}" not found!`);
		}
	}

	if (relevantSpaces.length === 0) {
		throw new Error(
			"No relevant spaces found. Check space names and permissions.",
		);
	}

	// Get page trees for each space
	const allPages: PageMeta[] = [];
	for (const space of relevantSpaces) {
		log("Discover", `Fetching page tree for "${space.name}" (${space.key})...`);
		const pages = await client.listPagesInSpace(space.id);
		// Fill in space key
		for (const page of pages) {
			page.spaceKey = space.key;
		}
		allPages.push(...pages);
		log("Discover", `  Found ${pages.length} pages`);
	}

	const result: DiscoveryResult = {
		spaces: relevantSpaces,
		pages: allPages,
		timestamp: new Date().toISOString(),
	};

	// Save to cache
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	fs.writeFileSync(discoveryPath, JSON.stringify(result, null, 2));
	log("Discover", `Saved discovery to ${discoveryPath}`);

	// Print summary
	const spaceLines = relevantSpaces.map((s) => {
		const count = allPages.filter((p) => p.spaceKey === s.key).length;
		return `${s.name} (${s.key}): ${count} pages`;
	});

	// Build top-level page tree
	const rootPages = allPages.filter((p) => !p.parentId);
	const treeLines = rootPages.slice(0, 30).map((p) => {
		const children = allPages.filter((c) => c.parentId === p.id);
		return `  ${p.title} (${children.length} children)`;
	});

	logSummary("Discover", [
		`Spaces: ${relevantSpaces.length}`,
		...spaceLines,
		`Total pages: ${allPages.length}`,
		"",
		"Top-level pages (first 30):",
		...treeLines,
		rootPages.length > 30 ? `  ... and ${rootPages.length - 30} more` : "",
	]);

	return result;
}
