/**
 * ⚠️  WRITES — recover every repairable pre-design-pipeline build to
 * `complete`.
 *
 * The migrate sibling of `scan-legacy-preplan-builds.ts`: for each
 * non-`complete`, non-deleted app with NO bound design session, a nonzero
 * module count, and either no present run holder or an exactly provable stale
 * build holder, it first reaps that stale holder when necessary and delegates
 * to `recoverAppStatus(appId, null)` — the same reviewed operator-recovery
 * authority `recover-app.ts` uses, which re-proves the free row under the
 * app lock, flips status → `complete`, and clears `error_type`. Live-held,
 * unprovable stale-holder, and empty rows are skipped and reported (the scan
 * explains each).
 *
 * Dry-run by default; nothing writes without `--execute`. Run the scan
 * first for sizing, execute against the intended environment, then re-run
 * the scan to zero repairable rows.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadApp, reapStaleRun, recoverAppStatus } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { toExactRunHolderIdentity } from "@/lib/db/runHolderWrites";
import { runLeaseState } from "@/lib/db/runLiveness";
import { runMain } from "./lib/main";

const program = new Command();
program
	.name("migrate-legacy-preplan-builds")
	.description(
		"Recover repairable pre-cutover builds to complete. Dry-run by default; --execute writes.",
	)
	.option("--execute", "write the recoveries (default: print the plan only)")
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Uses the database selected by NOVA_DB_LOCAL_URL or the Cloud SQL\n" +
			"  connector environment. There is intentionally no --prod writer\n" +
			"  shortcut; production execution requires an explicit write-capable env.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-legacy-preplan-builds.ts\n" +
			"  $ npx tsx scripts/migrate-legacy-preplan-builds.ts --execute\n",
	);
program.parse();
const opts = program.opts<{ execute?: boolean }>();
const productionJob = process.env.NOVA_LEGACY_PREPLAN_PRODUCTION_JOB === "true";

async function main(): Promise<void> {
	try {
		const db = await getAppDb();
		const candidates = await db
			.selectFrom("apps")
			.select(["id"])
			.where("status", "!=", "complete")
			.where("deleted_at", "is", null)
			.where(({ not, exists, selectFrom }) =>
				not(
					exists(
						selectFrom("design_sessions")
							.select("design_sessions.id")
							.whereRef("design_sessions.app_id", "=", "apps.id"),
					),
				),
			)
			.orderBy("updated_at", "asc")
			.execute();

		let recovered = 0;
		let skipped = 0;
		for (const candidate of candidates) {
			let app = await loadApp(candidate.id);
			if (!app) continue;
			let lease = runLeaseState(app);
			let holder = lease.holderIdentity;
			if (app.module_count === 0) {
				skipped++;
				console.log(`skip     ${candidate.id}  zero modules`);
				continue;
			}
			if (lease.reapableStaleBuild) {
				const exactHolder = toExactRunHolderIdentity(holder);
				if (exactHolder === null) {
					skipped++;
					console.log(
						`skip     ${candidate.id}  stale holder has no exact run/nonce identity`,
					);
					continue;
				}
				if (opts.execute !== true) {
					recovered++;
					console.log(
						`would reap ${candidate.id}  holder=${exactHolder.mode}:${exactHolder.runId}, then recover "${app.app_name}"`,
					);
					continue;
				}
				const reap = await reapStaleRun(candidate.id, exactHolder);
				app = await loadApp(candidate.id);
				if (!app) continue;
				lease = runLeaseState(app);
				holder = lease.holderIdentity;
				if (reap !== "reaped" && holder !== null) {
					skipped++;
					console.log(
						`skip     ${candidate.id}  holder changed while the stale reap was locking`,
					);
					continue;
				}
			}
			if (holder !== null) {
				skipped++;
				console.log(
					`skip     ${candidate.id}  held by ${holder.mode}:${holder.runId ?? "?"}`,
				);
				continue;
			}
			if (opts.execute !== true) {
				recovered++;
				console.log(`would recover ${candidate.id}  "${app.app_name}"`);
				continue;
			}
			const outcome = await recoverAppStatus(candidate.id, null);
			if (outcome.kind === "recovered") {
				recovered++;
				console.log(`recovered ${candidate.id}  "${app.app_name}"`);
			} else {
				skipped++;
				console.log(
					`skip     ${candidate.id}  recovery answered ${outcome.kind}`,
				);
			}
		}
		console.log(
			opts.execute === true
				? `\nRecovered ${recovered}, skipped ${skipped}. Re-run the scan to confirm zero repairable rows.`
				: `\nDRY RUN — would recover ${recovered}, skip ${skipped}. Nothing writes without --execute.`,
		);
		if (opts.execute === true) {
			console.log(
				`Independent proof: npx tsx scripts/scan-legacy-preplan-builds.ts${productionJob ? " --prod" : ""}`,
			);
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
