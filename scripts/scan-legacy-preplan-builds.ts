/**
 * READ-ONLY — census of pre-design-pipeline builds the cutover strands.
 *
 * The chat route's app-target BUILD arm now requires a bound materialized
 * design session; a non-`complete` app WITHOUT one predates the pipeline and
 * can no longer be re-driven through chat (the route answers 409 "being
 * repaired"). Every persisted app is valid by construction, so the honest
 * at-rest state for those rows is `complete`. This scan classifies each
 * candidate:
 *
 *   - `repairable` — holder-free with modules → run
 *     `migrate-legacy-preplan-builds.ts`
 *   - `held`       — a run currently holds the row; wait for it (or the
 *     reaper) and re-scan
 *   - `empty`      — zero modules persisted; recovery refuses these, and
 *     each needs an operator decision (likely soft-delete)
 *
 * Run before and after the migrate sibling; the after-run must show zero
 * repairable rows. `--prod` reads production Cloud SQL via your gcloud IAM
 * identity.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadApp } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { runLeaseState } from "@/lib/db/runLiveness";
import { tsToISO } from "./lib/format";
import { runMain } from "./lib/main";

const program = new Command();
program
	.name("scan-legacy-preplan-builds")
	.description(
		"List non-complete apps with no bound design session (pre-cutover builds). Read-only.",
	)
	.option("--prod", "read production Cloud SQL over its public IP");
program.parse();
const opts = program.opts<{ prod?: boolean }>();

async function main(): Promise<void> {
	try {
		if (opts.prod === true) {
			const { targetProdDb } = await import("./lib/prodDb");
			targetProdDb();
		}
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

		let repairable = 0;
		let held = 0;
		let empty = 0;
		for (const candidate of candidates) {
			const app = await loadApp(candidate.id);
			if (!app) continue;
			const holder = runLeaseState(app).holderIdentity;
			const kind =
				app.module_count === 0
					? "empty"
					: holder !== null
						? "held"
						: "repairable";
			if (kind === "empty") empty++;
			else if (kind === "held") held++;
			else repairable++;
			console.log(
				`${kind.padEnd(10)} ${candidate.id}  status=${app.status} error=${app.error_type ?? "-"} modules=${app.module_count} updated=${tsToISO(app.updated_at)} holder=${holder ? `${holder.mode}:${holder.runId ?? "?"}` : "none"}  "${app.app_name}"`,
			);
		}
		console.log(
			`\n${candidates.length} legacy pre-plan build(s): ${repairable} repairable, ${held} held, ${empty} empty.`,
		);
		if (held > 0) {
			console.log(
				"Held rows: wait for the run to finish or the reaper to settle it, then re-scan.",
			);
		}
		if (empty > 0) {
			console.log(
				"Empty rows: recovery refuses zero-module apps; decide per app (likely soft-delete).",
			);
		}
		if (repairable > 0 && opts.prod === true) {
			console.log(
				"\nRun the immutable write-capable Job after the deploy is green:\n" +
					"  python3 scripts/rollout/deploy-cloud-run.py --execute-job --project=commcare-nova --region=us-central1 " +
					"--job=commcare-nova-legacy-preplan-repair --service=commcare-nova --wait-seconds=960 " +
					"--execution-arg=legacy-preplan-repair.cjs --execution-arg=--execute",
			);
			console.log(
				"\nIndependent proof afterward:\n  npx tsx scripts/scan-legacy-preplan-builds.ts --prod",
			);
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
