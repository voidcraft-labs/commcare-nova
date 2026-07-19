/**
 * WRITER — repair the persisted states the case-workspace SCHEMA
 * tightenings would refuse to load, in place on the raw
 * `blueprint_entities` module rows:
 *
 *   - unsupported date patterns (date columns / `format-date`) → the ISO
 *     default `%Y-%m-%d` (JavaRosa already rejected the stored pattern at
 *     runtime, so this restores a broken cell rather than changing a
 *     working one);
 *   - `within-distance` with a non-positive distance → `match-none`
 *     (the stored filter matched at most the exact center point);
 *   - `within-distance` with a meters-overflow distance → `match-all`
 *     (the stored filter matched everything).
 *
 * Every app is verified BEFORE writing: the repaired rows must assemble
 * and pass `blueprintDocSchema.parse`, or that app is reported and
 * skipped. Dry-run by default; nothing writes without `--execute`. Run
 * scan-case-list-tightening.ts before (sizing) and after (must be zero).
 *
 * The permanent `accepted_mutations` history is deliberately untouched:
 * it is replayed only as a SUFFIX on top of a loaded doc, so historical
 * payloads carrying the old shapes never re-enter a load once the rows
 * are repaired.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { getAppDb } from "../lib/db/pg";
import { planTightening, writeAppTightening } from "./lib/caseListTightening";
import { runMain } from "./lib/main";

interface MigrateOptions {
	app?: string;
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-case-list-tightening")
	.description(
		"Repair date-pattern / within-distance strands the tightened schemas refuse to load. Dry-run by default; --execute writes. " +
			"Run scan-case-list-tightening.ts before and after.",
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
			"  $ npx tsx scripts/migrate-case-list-tightening.ts\n" +
			"  $ npx tsx scripts/migrate-case-list-tightening.ts --execute\n" +
			"  $ npx tsx scripts/migrate-case-list-tightening.ts --app <appId> --execute\n",
	);
program.parse();
const opts = program.opts<MigrateOptions>();

async function main(): Promise<void> {
	const db = await getAppDb();
	const reports = await planTightening(db, { appId: opts.app });
	const writable = reports.filter((r) => r.parseError === null);
	const blocked = reports.filter((r) => r.parseError !== null);

	console.log(
		opts.execute === true
			? `Repairing ${writable.length} app(s)…`
			: `DRY RUN — would repair ${writable.length} app(s). Nothing writes without --execute.`,
	);
	for (const report of reports) {
		console.log(`  ${report.appId} (${report.appName}):`);
		for (const fix of report.fixes) {
			console.log(
				`    [${fix.kind}] ${fix.path} — stored ${JSON.stringify(fix.stored)}`,
			);
		}
		if (report.parseError !== null) {
			console.log(
				`    ✗ SKIPPED — the repaired doc still fails parse: ${report.parseError}`,
			);
		}
	}
	if (opts.execute !== true) return;

	for (const report of writable) {
		await writeAppTightening(db, report);
	}
	const after = await planTightening(db, { appId: opts.app });
	console.log(
		`\nRepaired ${writable.length} app(s); ${after.length} app(s) still carry strands.`,
	);
	if (after.length > blocked.length) {
		throw new Error(
			"case-list tightening repair did not converge; inspect concurrent writers and re-run the read-only scan",
		);
	}
	if (blocked.length > 0) {
		console.log(
			`${blocked.length} app(s) need the owner (scripts/recover-app.ts) — see the per-app reports above.`,
		);
	}
	console.log(
		"Re-run scan-case-list-tightening.ts in the same environment to record the zero-app post-check.",
	);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
