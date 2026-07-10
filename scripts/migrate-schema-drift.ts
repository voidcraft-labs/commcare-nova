/**
 * ⚠️ WRITER — converge every stored `case_type_schemas` row (and its
 * expression indexes, and its rows' typed values) onto the schemas
 * the blueprint derives today.
 *
 * The scan-then-migrate pair for the derived-property-typing deploy
 * boundary: run `scan-schema-drift.ts` first (read-only sizing), then
 * this with `--execute`. Per drifted case type:
 *
 *   - each RETYPED property runs `applySchemaChange` with a `retype`
 *     change — per-row cast in one transaction, uncastable rows moved
 *     to `cases_quarantine` with their original values preserved;
 *   - a plain `applySchemaChange` re-sync converges everything else
 *     (missing rows, added/removed properties, spec refinements) and
 *     rebuilds the expression indexes (Phase B, `CONCURRENTLY`).
 *
 * Unresolvable stored specs are never auto-migrated — the scan names
 * them for an owner decision.
 *
 * Default is a DRY RUN printing the plan; nothing writes without
 * `--execute`. Per-app fault isolation: one app's failure costs that
 * app's migration, never the run.
 */

import { Command } from "commander";
import { buildCaseTypeMap, withSchemaContext } from "../lib/case-store";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { loadApp } from "../lib/db/apps";
import { getAppDb } from "../lib/db/pg";
import { runMain } from "./lib/main";
import { computeSchemaDrift } from "./lib/schemaDrift";

interface MigrateOptions {
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-schema-drift")
	.description(
		"Converge stored case_type_schemas rows (+ indexes + row values) onto the blueprint-derived schemas. " +
			"Dry-run by default; --execute writes. Run scan-schema-drift.ts before AND after.",
	)
	.option("--execute", "actually write (default: print the plan and exit)")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-schema-drift.ts            # dry-run plan\n" +
			"  $ npx tsx scripts/migrate-schema-drift.ts --execute\n",
	);
program.parse();
const { execute = false } = program.opts<MigrateOptions>();

async function main() {
	const appDb = await getAppDb();
	const caseDb = await getCaseStoreDatabase();
	const store = await withSchemaContext();
	console.log(
		execute
			? "Migrating stored schemas onto the derived views…\n"
			: "DRY RUN — printing the migration plan (nothing writes without --execute)…\n",
	);

	const appRows = await appDb.selectFrom("apps").select("id").execute();
	let migratedTypes = 0;
	let retypesRun = 0;
	let rowsMigrated = 0;
	let rowsQuarantined = 0;
	const failedApps: string[] = [];

	for (const { id } of appRows) {
		const appDoc = await loadApp(id).catch(() => null);
		if (!appDoc) continue;

		try {
			const drifts = await computeSchemaDrift(caseDb, id, appDoc.blueprint);
			if (drifts.length === 0) continue;
			console.log(`${id} (${appDoc.app_name || "unnamed"})`);
			const caseTypeSchemas = buildCaseTypeMap(appDoc.blueprint);

			for (const drift of drifts) {
				console.log(`  case type "${drift.caseType}":`);
				for (const r of drift.retyped) {
					if (!execute) {
						console.log(
							`    would RETYPE ${r.property}: ${r.fromType} → ${r.toType}`,
						);
						continue;
					}
					const report = await store.applySchemaChange({
						appId: id,
						caseType: drift.caseType,
						caseTypeSchemas,
						property: r.property,
						change: {
							kind: "retype",
							fromType: r.fromType,
							toType: r.toType,
						},
					});
					retypesRun++;
					rowsMigrated += report?.migrated ?? 0;
					rowsQuarantined += report?.quarantined ?? 0;
					console.log(
						`    retyped ${r.property}: ${r.fromType} → ${r.toType} — ` +
							`${report?.migrated ?? 0} migrated, ${report?.quarantined ?? 0} quarantined, ${report?.skipped ?? 0} skipped`,
					);
					if (report && report.failureReasons.length > 0) {
						for (const reason of report.failureReasons) {
							console.log(`      quarantined: ${reason}`);
						}
					}
				}
				if (drift.unresolvable.length > 0) {
					console.log(
						`    ✗ skipping unresolvable spec(s) — needs owner: ${drift.unresolvable.join(", ")}`,
					);
				}
				if (!execute) {
					console.log("    would re-sync schema + rebuild indexes");
					continue;
				}
				// The plain re-sync converges added/removed/refined entries
				// and (re)builds the expression indexes; idempotent after
				// the retype calls above (each already re-synced).
				await store.applySchemaChange({
					appId: id,
					caseType: drift.caseType,
					caseTypeSchemas,
				});
				migratedTypes++;
				console.log("    re-synced schema + indexes");
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
					`${rowsMigrated} row(s) migrated, ${rowsQuarantined} quarantined` +
					(failedApps.length > 0
						? `; FAILED apps: ${failedApps.join(", ")}`
						: "") +
					"\nRe-run scan-schema-drift.ts now — it must report zero drift."
			: "Dry run complete. Re-run with --execute to write.",
	);
	await closeCaseStoreDatabase();
}

runMain(main);
