/**
 * READ-ONLY — inventory every stored old-shape language occurrence across the
 * four stores (localization roots, app_changes payloads, fold-baseline
 * snapshots, translation-batch state) with its proposed structured-identity
 * rewrite, before the migrate run rewrites them in place.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	languageIdentityPlanHasRewrites,
	loadLanguageIdentityRepairSource,
	planLanguageIdentityRepair,
} from "./lib/languageIdentityRepair";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-language-identity")
	.description(
		"Read every store that can hold the retired free-code language shape and report each occurrence with its proposed structured-identity rewrite; never writes.",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option("--prod", "scan production through the read-only operator identity");
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id").orderBy("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const rows = await query.execute();
	if (options.app !== undefined && rows.length === 0) {
		throw new Error(`App ${options.app} not found.`);
	}

	let appsNeedingRewrites = 0;
	let occurrences = 0;
	let blockedFindings = 0;
	let failedApps = 0;
	const neededMappings = new Set<string>();
	for (const { id } of rows) {
		let source: Awaited<ReturnType<typeof loadLanguageIdentityRepairSource>>;
		try {
			source = await loadLanguageIdentityRepairSource(id);
		} catch (error) {
			failedApps += 1;
			console.error(
				`${id}: could not read stored language state: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (source === null) {
			failedApps += 1;
			console.error(`${id}: app disappeared while the scan was reading it`);
			continue;
		}
		const plan = planLanguageIdentityRepair(source);
		for (const finding of plan.findings) {
			console.log(
				`${id}\t${finding.store}\t${finding.ref}\t${finding.classification}\t${finding.detail}`,
			);
			if (finding.classification !== "informational") occurrences += 1;
			if (finding.classification === "blocked") blockedFindings += 1;
		}
		for (const code of plan.neededMappings) neededMappings.add(code);
		if (languageIdentityPlanHasRewrites(plan)) appsNeedingRewrites += 1;
	}

	if (neededMappings.size > 0) {
		console.log(
			`\nThese stored codes need reviewed entries in LANGUAGE_IDENTITY_EXPLICIT_MAPPINGS (scripts/lib/languageIdentityRepair.ts) before the migrate run will write: ${[...neededMappings].sort().join(", ")}`,
		);
	}
	console.log(
		`\nScanned ${rows.length} app(s): ${appsNeedingRewrites} app(s) with rewrites, ${occurrences} occurrence(s), ${neededMappings.size} code(s) needing an explicit mapping, ${blockedFindings} blocked finding(s), ${failedApps} unreadable app(s).`,
	);
	if (neededMappings.size > 0 || blockedFindings > 0 || failedApps > 0) {
		process.exitCode = 1;
	}
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
