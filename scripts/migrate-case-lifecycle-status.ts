/**
 * WRITER — converge cases with `closed_on != null` onto the canonical
 * built-in `status = "closed"` value.
 *
 * Dry-run by default; nothing writes without `--execute`. Run the read-only
 * scan first for sizing, execute this against the intended environment, then
 * re-run the scan to zero. The repair preserves `closed_on` and `modified_on`
 * because the former close path already recorded the correct event time.
 */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import {
	migrateClosedStatusMismatches,
	scanClosedStatusMismatches,
} from "./lib/caseLifecycleStatus";
import { runMain } from "./lib/main";

interface MigrateOptions {
	app?: string;
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-case-lifecycle-status")
	.description(
		"Converge closed rows onto status `closed`. Dry-run by default; --execute writes. Run scan-case-lifecycle-status.ts before and after.",
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
			"  $ npx tsx scripts/migrate-case-lifecycle-status.ts\n" +
			"  $ npx tsx scripts/migrate-case-lifecycle-status.ts --execute\n" +
			"  $ npx tsx scripts/migrate-case-lifecycle-status.ts --app <appId> --execute\n",
	);
program.parse();
const opts = program.opts<MigrateOptions>();

async function main(): Promise<void> {
	const db = await getCaseStoreDatabase();
	try {
		const scope = { appId: opts.app };
		const before = await scanClosedStatusMismatches(db, scope);
		const planned = before.reduce((sum, group) => sum + group.rowCount, 0);
		console.log(
			opts.execute === true
				? `Repairing ${planned} mismatched closed row(s)…`
				: `DRY RUN — would repair ${planned} mismatched closed row(s). Nothing writes without --execute.`,
		);
		for (const group of before) {
			console.log(
				`  ${group.appId} / ${group.caseType} / ${JSON.stringify(group.storedStatus)}: ${group.rowCount}`,
			);
		}
		if (opts.execute !== true) return;

		const migrated = await migrateClosedStatusMismatches(db, scope);
		const after = await scanClosedStatusMismatches(db, scope);
		const remaining = after.reduce((sum, group) => sum + group.rowCount, 0);
		console.log(`\nRepaired ${migrated} row(s); ${remaining} remain.`);
		if (remaining > 0) {
			throw new Error(
				"case lifecycle status repair did not converge to zero; inspect concurrent writers and re-run the read-only scan",
			);
		}
		console.log(
			"Re-run scan-case-lifecycle-status.ts in the same environment to record the zero-row post-check.",
		);
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
