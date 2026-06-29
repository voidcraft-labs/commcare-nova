/**
 * Backfill: stamp `project_id` onto every Postgres `cases` row that predates the
 * Project-spaces case-store rescope. The structural tenant filter moved from
 * `owner_id` to `project_id`; until a row carries a `project_id`, the
 * read-switched store's `WHERE project_id = $bound` filter silently excludes it.
 * This is the BACKFILL phase of expand → backfill → read-switch and MUST run
 * (to completion) before the read-switch revision serves traffic.
 *
 * Mapping: a case's Project is its APP's Project. Every `cases` row carries
 * `app_id`; each app's `project_id` lives on the Firestore app doc. So this
 * builds an `app_id → project_id` map from Firestore (populated by
 * `backfill-apps-project-id.ts` — run that FIRST) and stamps each app's rows in
 * one bulk UPDATE. `owner_id` is left untouched — it is the CommCare case-owner,
 * a separate axis, not the tenant.
 *
 * Idempotent: the UPDATE is scoped `WHERE app_id = $app AND project_id IS NULL`,
 * so a re-run only touches rows still missing the stamp. Dry-run by default and
 * strictly READ-ONLY in that mode (it COUNTs what would be stamped, writes
 * nothing). A per-app try/catch isolates a single failure; the script exits
 * non-zero if any app failed OR any row was left unstamped (an app with rows but
 * no resolvable Firestore `project_id`), so the deploy step knows the migration
 * is incomplete.
 *
 *   npx tsx scripts/backfill-cases-project-id.ts            # dry run
 *   npx tsx scripts/backfill-cases-project-id.ts --apply
 */
import type { DocumentSnapshot } from "@google-cloud/firestore";
import { Command } from "commander";
import { sql } from "kysely";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "@/lib/case-store/postgres/connection";
import { db as firestore } from "./lib/firestore";
import { runMain } from "./lib/main";

interface Options {
	apply?: boolean;
}

const program = new Command();
program
	.description(
		"Stamp project_id (the app's Project) onto pre-existing case rows",
	)
	.option("--apply", "write to Postgres (default: dry run)");
program.parse();
const opts = program.opts<Options>();

async function main() {
	const apply = opts.apply === true;
	console.log(
		apply
			? "backfill-cases-project-id — APPLY"
			: "backfill-cases-project-id — SCAN (dry run, read-only)",
	);

	// app_id → project_id, from the (already-backfilled) Firestore app docs.
	const appToProject = new Map<string, string>();
	const stream = firestore
		.collection("apps")
		.stream() as AsyncIterable<DocumentSnapshot>;
	for await (const snap of stream) {
		const projectId = snap.get("project_id") as string | undefined;
		if (projectId != null) appToProject.set(snap.id, projectId);
	}
	console.log(`apps with a project_id: ${appToProject.size}`);

	const db = await getCaseStoreDatabase();
	let appsTouched = 0;
	let rowsStamped = 0;
	let unresolvable = 0;
	let failed = 0;

	try {
		// Distinct apps that still have un-stamped rows. `project_id` is typed
		// non-null (the read-switch steady state), so the nullity predicate goes
		// through raw SQL — during the transition the column is still nullable.
		const pending = await sql<{ app_id: string; pending: string }>`
			SELECT app_id, COUNT(*)::text AS pending
			  FROM cases
			 WHERE project_id IS NULL
			 GROUP BY app_id
		`.execute(db);

		for (const { app_id, pending: pendingText } of pending.rows) {
			const pendingCount = Number(pendingText);
			const projectId = appToProject.get(app_id);
			if (projectId === undefined) {
				// An app whose rows can't be mapped — its Firestore doc is missing or
				// not yet `project_id`-stamped. Run backfill-apps-project-id first.
				unresolvable += pendingCount;
				console.warn(
					`  ! app ${app_id}: ${pendingCount} row(s) but no resolvable project_id — skipped`,
				);
				continue;
			}
			appsTouched += 1;
			if (!apply) {
				rowsStamped += pendingCount;
				continue;
			}
			try {
				const result = await sql`
					UPDATE cases
					   SET project_id = ${projectId}
					 WHERE app_id = ${app_id}
					   AND project_id IS NULL
				`.execute(db);
				rowsStamped += Number(result.numAffectedRows ?? 0);
			} catch (err) {
				failed += pendingCount;
				console.warn(`  ! app ${app_id}: stamp failed`, err);
			}
		}

		console.log("");
		console.log(`apps with un-stamped rows: ${pending.rows.length}`);
		console.log(
			`apps ${apply ? "stamped" : "to stamp"}:          ${appsTouched}`,
		);
		console.log(
			`rows ${apply ? "stamped" : "would stamp"}:         ${rowsStamped}`,
		);
		if (unresolvable > 0)
			console.log(`rows unresolvable (skipped): ${unresolvable}`);
		if (failed > 0) console.log(`rows FAILED:               ${failed}`);
		if (!apply) {
			console.log("\nmode: dry run — nothing written. Pass --apply to write.");
		}
		// Any unstamped row leaves a gap the read-switch would hide, so a deploy
		// step keying on the exit code must see failure until every row is stamped.
		if (failed > 0 || unresolvable > 0) {
			console.error(
				`\n${failed + unresolvable} row(s) left unstamped. Run backfill-apps-project-id.ts first (for unresolvable apps), then re-run; it is idempotent.`,
			);
			process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
