/**
 * WRITER — move each case's `location_id` out of its JSONB property document
 * into the case's own location column, and remove it from every stored case
 * schema that declares it (`scripts/lib/caseLocationProperties.ts`).
 *
 * Dry-run by default; nothing writes without `--execute`. Run the read-only
 * scan first for sizing, execute this against the intended environment, then
 * re-run the scan to zero. A column that already holds a location keeps it.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import {
	migrateCaseLocationProperties,
	migrateCaseLocationSchemas,
	scanCaseLocationProperties,
	scanCaseLocationSchemas,
} from "./lib/caseLocationProperties";
import { runMain } from "./lib/main";

interface MigrateOptions {
	app?: string;
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-case-location-properties")
	.description(
		"Move location_id from case property documents into the case's location column. Dry-run by default; --execute writes. Run scan-case-location-properties.ts before and after.",
	)
	.option("--app <appId>", "scope the repair to one app")
	.option("--execute", "write the repair (default: print the plan only)")
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Uses the database selected by NOVA_DB_LOCAL_URL or the Cloud SQL\n" +
			"  connector environment. There is intentionally no --prod writer\n" +
			"  shortcut; production execution requires an explicit write-capable env.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-case-location-properties.ts\n" +
			"  $ npx tsx scripts/migrate-case-location-properties.ts --execute\n",
	);
program.parse();
const opts = program.opts<MigrateOptions>();

async function main(): Promise<void> {
	const db = await getCaseStoreDatabase();
	try {
		const scope = { appId: opts.app };
		const before = await scanCaseLocationProperties(db, scope);
		const planned = before.reduce((sum, group) => sum + group.rowCount, 0);
		console.log(
			opts.execute === true
				? `Moving location_id out of ${planned} case property document(s)…`
				: `DRY RUN — would move location_id out of ${planned} case property document(s). Nothing writes without --execute.`,
		);
		for (const group of before)
			console.log(
				`  ${group.appId} / ${group.caseType}: ${group.rowCount} (${group.columnHeld} keep their column)`,
			);
		const schemas = await scanCaseLocationSchemas(db, scope);
		console.log(
			`${opts.execute === true ? "Removing" : "Would remove"} location_id from ${schemas.length} stored case schema(s).`,
		);
		for (const schema of schemas)
			console.log(`  ${schema.appId} / ${schema.caseType}`);
		if (opts.execute !== true) return;
		const moved = await migrateCaseLocationProperties(db, scope);
		const cleared = await migrateCaseLocationSchemas(db, scope);
		const after = await scanCaseLocationProperties(db, scope);
		const remaining =
			after.reduce((sum, group) => sum + group.rowCount, 0) +
			(await scanCaseLocationSchemas(db, scope)).length;
		console.log(
			`\nMoved ${moved} row(s) and cleared ${cleared} schema(s); ${remaining} remain.`,
		);
		if (remaining > 0)
			throw new Error(
				"the case location repair did not converge to zero; inspect concurrent writers and re-run the read-only scan",
			);
		console.log(
			"Re-run scan-case-location-properties.ts in the same environment to record the zero-row post-check.",
		);
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
