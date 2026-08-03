/**
 * ⚠️ WRITER — converge every stored `case_type_schemas` row (and its
 * expression indexes, and its rows' typed values) onto the schemas
 * the blueprint derives today.
 *
 * The scan-then-migrate pair for the derived-property-typing deploy
 * boundary: run `scan-schema-drift.ts` first (read-only sizing), then
 * this with `--execute`. Per drifted case type:
 *
 *   - one app-row transaction loads the exact Blueprint and runs the shared,
 *     versioned schema Phase A for every drifted type;
 *   - that primitive detects every retype/reshape from the stored schema,
 *     parks uncastable values, and cannot overwrite a newer schema from a
 *     stale Blueprint snapshot;
 *   - expression indexes rebuild after the app transaction commits (Phase B,
 *     `CONCURRENTLY`).
 *
 * Unresolvable stored specs are never auto-migrated — the scan names
 * them for an owner decision.
 *
 * Default is a DRY RUN printing the plan; nothing writes without
 * `--execute`. Per-app fault isolation: one app's failure costs that
 * app's migration, never the run.
 */

import { Command } from "commander";
import { withSchemaContext } from "../lib/case-store";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { loadApp } from "../lib/db/apps";
import { getAppDb, withAppTx } from "../lib/db/pg";
import { runMain } from "./lib/main";
import { computeSchemaDrift } from "./lib/schemaDrift";
import { prepareSchemaDriftRepairInAppTransaction } from "./lib/schemaDriftMigration";

interface MigrateOptions {
	execute?: boolean;
	app?: string;
}

const program = new Command();
program
	.name("migrate-schema-drift")
	.description(
		"Converge stored case_type_schemas rows (+ indexes + row values) onto the blueprint-derived schemas. " +
			"Dry-run by default; --execute writes. Run scan-schema-drift.ts before AND after.",
	)
	.option("--execute", "actually write (default: print the plan and exit)")
	.option("--app <appId>", "scope the migration to one app")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx --conditions=react-server scripts/migrate-schema-drift.ts            # dry-run plan\n" +
			"  $ npx tsx --conditions=react-server scripts/migrate-schema-drift.ts --execute\n" +
			"\nProduction writes run through the configured commcare-nova-case-type-schema-retirement Cloud Run Job; human --prod credentials are read-only.\n",
	);
program.parse();
const { execute = false, app: appId } = program.opts<MigrateOptions>();

async function main() {
	const appDb = await getAppDb();
	const caseDb = await getCaseStoreDatabase();
	const store = await withSchemaContext();
	console.log(
		execute
			? "Migrating stored schemas onto the derived views…\n"
			: "DRY RUN — printing the migration plan (nothing writes without --execute)…\n",
	);

	let appQuery = appDb.selectFrom("apps").select("id");
	if (appId !== undefined) appQuery = appQuery.where("id", "=", appId);
	const appRows = await appQuery.execute();
	if (appId !== undefined && appRows.length === 0) {
		throw new Error(`App ${appId} not found.`);
	}
	let migratedTypes = 0;
	let retypesRun = 0;
	let rowsMigrated = 0;
	let valuesParked = 0;
	const failedApps: string[] = [];

	for (const { id } of appRows) {
		try {
			if (!execute) {
				const appDoc = await loadApp(id);
				if (appDoc === null) continue;
				const drifts = await computeSchemaDrift(caseDb, id, appDoc.blueprint);
				if (drifts.length === 0) continue;
				console.log(`${id} (${appDoc.app_name || "unnamed"})`);
				for (const drift of drifts) {
					console.log(`  case type "${drift.caseType}":`);
					for (const retype of drift.retyped) {
						console.log(
							`    would RETYPE ${retype.property}: ${retype.fromType} → ${retype.toType}`,
						);
					}
					if (drift.unresolvable.length > 0) {
						console.log(
							`    ✗ skipping unresolvable spec(s) — needs owner: ${drift.unresolvable.map((entry) => entry.property).join(", ")}`,
						);
					} else {
						console.log("    would re-sync schema + rebuild indexes");
					}
				}
				console.log("");
				continue;
			}

			const prepared = await withAppTx((tx) =>
				prepareSchemaDriftRepairInAppTransaction(tx, store, id),
			);
			if (prepared === null || prepared.drifts.length === 0) continue;
			await prepared.completeAfterCommit();
			console.log(`${id} (${prepared.appName || "unnamed"})`);
			for (const repair of prepared.repairs) {
				const { drift, report } = repair;
				retypesRun += drift.retyped.length;
				rowsMigrated += report.migrated + report.retyped + report.reshaped;
				valuesParked += report.parkedIds.length;
				migratedTypes++;
				console.log(
					`  case type "${drift.caseType}": re-synced schema + indexes — ` +
						`${report.retyped} retyped row(s), ${report.reshaped} reshaped row(s), ` +
						`${report.parkedIds.length} value(s) parked, ${report.restored} restored`,
				);
				for (const reason of report.failureReasons) {
					console.log(`      parked: ${reason}`);
				}
			}
			console.log("");
		} catch (err) {
			failedApps.push(id);
			console.log(
				`  ✗ FAILED — this app's migration stopped; every other app continues:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	console.log(
		execute
			? `Done: ${migratedTypes} case type(s) re-synced; ${retypesRun} retype(s) — ` +
					`${rowsMigrated} row(s) migrated, ${valuesParked} value(s) parked` +
					(failedApps.length > 0
						? `; FAILED apps: ${failedApps.join(", ")}`
						: "") +
					"\nRe-run scan-schema-drift.ts now — it must report zero drift."
			: "Dry run complete. Re-run with --execute to write.",
	);
	if (failedApps.length > 0) process.exitCode = 1;
	await closeCaseStoreDatabase();
}

runMain(main);
