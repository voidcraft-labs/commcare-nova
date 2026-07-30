/**
 * READ-ONLY — find stored Search-input AST leaves that still address an input
 * by mutable name instead of immutable UUID.
 *
 * The scan reads raw module entity JSON because the final Blueprint schema
 * intentionally has no legacy parser. It also scans accepted mutation history;
 * the writer refuses an app whose history contains a legacy leaf rather than
 * leaving a replay trap behind.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import {
	findLegacySearchInputRefs,
	migrateModuleSearchInputRefs,
} from "./lib/searchInputIdentity";

interface ScanOptions {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-search-input-identity")
	.description(
		"Find raw stored Search-input references that still use mutable names (read-only). Run before and after migrate-search-input-identity.ts.",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--prod",
		"scan production Cloud SQL through the read-only gcloud IAM connection",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-search-input-identity.ts\n" +
			"  $ npx tsx scripts/scan-search-input-identity.ts --prod\n" +
			"  $ npx tsx scripts/scan-search-input-identity.ts --app <appId> --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	try {
		const report = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(async (tx) => {
				let modulesQuery = tx
					.selectFrom("blueprint_entities")
					.innerJoin("apps", "apps.id", "blueprint_entities.app_id")
					.select([
						"blueprint_entities.app_id as appId",
						"apps.app_name as appName",
						"blueprint_entities.uuid as moduleUuid",
						"blueprint_entities.data as data",
					])
					.where("blueprint_entities.kind", "=", "module")
					.orderBy("blueprint_entities.app_id")
					.orderBy("blueprint_entities.uuid");
				let eventsQuery = tx
					.selectFrom("accepted_mutations")
					.select(["app_id as appId", "seq", "mutations"])
					.orderBy("app_id")
					.orderBy("seq");
				if (opts.app !== undefined) {
					modulesQuery = modulesQuery.where(
						"blueprint_entities.app_id",
						"=",
						opts.app,
					);
					eventsQuery = eventsQuery.where("app_id", "=", opts.app);
				}
				return {
					modules: await modulesQuery.execute(),
					events: await eventsQuery.execute(),
				};
			});

		let moduleRefs = 0;
		let historyRefs = 0;
		let issues = 0;
		console.log("Scanning Search-input identities (read-only)…\n");
		for (const row of report.modules) {
			const transformed = migrateModuleSearchInputRefs(row.data);
			if (
				transformed.converted.length === 0 &&
				transformed.issues.length === 0
			) {
				continue;
			}
			moduleRefs += transformed.converted.length;
			issues += transformed.issues.length;
			console.log(
				`${row.appId} (${row.appName || "unnamed"}) / ${row.moduleUuid}`,
			);
			for (const ref of transformed.converted) {
				console.log(`  legacy ${ref.path}: ${JSON.stringify(ref.name)}`);
			}
			for (const issue of transformed.issues) {
				console.log(
					`  BLOCKED ${issue.path}: ${JSON.stringify(issue.name)} — ${issue.reason}` +
						(issue.candidateUuids.length > 0
							? ` (${issue.candidateUuids.join(", ")})`
							: ""),
				);
			}
		}
		for (const row of report.events) {
			const refs = findLegacySearchInputRefs(row.mutations);
			if (refs.length === 0) continue;
			historyRefs += refs.length;
			console.log(`${row.appId} accepted_mutations seq ${row.seq}`);
			for (const ref of refs) {
				console.log(
					`  BLOCKED history ${ref.path}: ${JSON.stringify(ref.name)}`,
				);
			}
		}
		console.log(
			`\n${moduleRefs} convertible current-state reference(s), ${issues} unresolved current-state reference(s), and ${historyRefs} history reference(s).`,
		);
		if (moduleRefs + issues + historyRefs > 0) {
			console.log(
				"\nNext: dry-run migrate-search-input-identity.ts, execute it in the intended write-capable environment, then re-run this scan to zero.",
			);
			process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
