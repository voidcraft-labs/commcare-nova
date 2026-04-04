/** Phase 1: Crawl — fetch page content for all discovered pages */

import * as fs from "fs";
import * as path from "path";
import { cleanStorageFormat } from "./clean-content.js";
import { ConfluenceClient } from "./confluence.js";
import { log, logSummary } from "./log.js";
import type { CrawledPage, DiscoveryResult, PipelineConfig } from "./types.js";

const CACHE_DIR = ".data/confluence-cache";
const PAGES_DIR = path.join(CACHE_DIR, "pages");

function pageCachePath(spaceKey: string, pageId: string): string {
	return path.join(PAGES_DIR, spaceKey, `${pageId}.json`);
}

export async function crawl(
	config: PipelineConfig,
	discovery: DiscoveryResult,
): Promise<void> {
	const client = new ConfluenceClient(
		config.confluenceBaseUrl,
		config.confluenceEmail,
		config.confluenceApiToken,
		config.rateLimitMs,
	);

	const pages = discovery.pages;
	let fetched = 0;
	let skipped = 0;
	let failed = 0;
	const failures: { id: string; title: string; error: string }[] = [];

	for (const space of discovery.spaces) {
		const spacePages = pages.filter((p) => p.spaceKey === space.key);
		const spaceDir = path.join(PAGES_DIR, space.key);
		fs.mkdirSync(spaceDir, { recursive: true });

		log(
			"Crawl",
			`Space "${space.name}" (${space.key}): ${spacePages.length} pages`,
		);
		let spaceDone = 0;

		for (let i = 0; i < spacePages.length; i++) {
			const page = spacePages[i];
			const cachePath = pageCachePath(page.spaceKey, page.id);

			// Check cache — skip if last modified matches
			if (fs.existsSync(cachePath)) {
				try {
					const cached = JSON.parse(
						fs.readFileSync(cachePath, "utf-8"),
					) as CrawledPage;
					if (cached.lastModified === page.lastModified && cached.content) {
						skipped++;
						spaceDone++;
						continue;
					}
				} catch {
					// Corrupted cache — re-fetch
				}
			}

			// Fetch content
			try {
				const { body, lastModified } = await client.getPageContent(page.id);
				const content = cleanStorageFormat(body);

				const crawled: CrawledPage = {
					...page,
					lastModified: lastModified || page.lastModified,
					content,
					contentLength: content.length,
				};

				fs.writeFileSync(cachePath, JSON.stringify(crawled, null, 2));
				fetched++;
				spaceDone++;

				if (spaceDone % 50 === 0) {
					log(
						"Crawl",
						`  Space ${space.key}: ${spaceDone}/${spacePages.length}`,
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				failures.push({ id: page.id, title: page.title, error: msg });
				failed++;
				log(
					"Crawl",
					`  WARNING: Failed to fetch page "${page.title}" (${page.id}): ${msg}`,
				);
			}
		}
	}

	// Summary
	const summaryLines = [
		`Total pages: ${pages.length}`,
		`Fetched: ${fetched}`,
		`Cached (skipped): ${skipped}`,
		`Failed: ${failed}`,
	];
	if (failures.length > 0) {
		summaryLines.push("", "Failures:");
		for (const f of failures.slice(0, 20)) {
			summaryLines.push(`  ${f.title} (${f.id}): ${f.error}`);
		}
		if (failures.length > 20) {
			summaryLines.push(`  ... and ${failures.length - 20} more`);
		}
	}
	logSummary("Crawl", summaryLines);
}

/** Load all crawled pages from the cache */
export function loadCrawledPages(discovery: DiscoveryResult): CrawledPage[] {
	const pages: CrawledPage[] = [];
	for (const page of discovery.pages) {
		const cachePath = pageCachePath(page.spaceKey, page.id);
		if (fs.existsSync(cachePath)) {
			try {
				const crawled = JSON.parse(
					fs.readFileSync(cachePath, "utf-8"),
				) as CrawledPage;
				if (crawled.content) pages.push(crawled);
			} catch {
				// Skip corrupted
			}
		}
	}
	return pages;
}
