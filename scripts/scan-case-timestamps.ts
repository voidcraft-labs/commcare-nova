/**
 * READ-ONLY — report every `cases` row whose creation stamps are NULL.
 *
 * Inserts predating the store-level `creationStamps` default left
 * `opened_on` / `modified_on` NULL (only followup updates stamped
 * `modified_on`), so the standard-name aliases (`date_opened`,
 * `last_modified`) read blank on those rows in every case list, filter,
 * and sort. This scan sizes the backfill; `migrate-case-timestamps.ts`
 * converges it. Run this before the migrate, and again after (the
 * re-scan must report zero rows).
 *
 * `--prod` targets the production instance over its public IP (see
 * `./lib/prodDb.ts`). Run with `--help` for flags.
 */

import "dotenv/config";
import { Command } from "commander";
import { sql } from "kysely";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-timestamps")
	.description(
		"Report cases rows with NULL opened_on / modified_on (read-only). " +
			"Run before migrate-case-timestamps.ts, and again after it (the re-scan must report zero rows).",
	)
	.option(
		"--prod",
		"target the production Cloud SQL instance over its public IP as your gcloud IAM identity",
	)
	.parse();

const options = program.opts<ScanOptions>();

runMain(async () => {
	if (options.prod) targetProdDb();
	const db = await getCaseStoreDatabase();
	try {
		const rows = await db
			.selectFrom("cases")
			.select(({ fn }) => [
				"app_id",
				"case_type",
				fn.countAll().as("total"),
				sql<number>`count(*) filter (where opened_on is null)`.as(
					"null_opened",
				),
				sql<number>`count(*) filter (where modified_on is null)`.as(
					"null_modified",
				),
			])
			.where((eb) =>
				eb.or([eb("opened_on", "is", null), eb("modified_on", "is", null)]),
			)
			.groupBy(["app_id", "case_type"])
			.orderBy("app_id")
			.orderBy("case_type")
			.execute();

		if (rows.length === 0) {
			console.log("No cases rows carry a NULL opened_on / modified_on.");
			return;
		}
		let opened = 0;
		let modified = 0;
		for (const row of rows) {
			opened += Number(row.null_opened);
			modified += Number(row.null_modified);
			console.log(
				`${row.app_id}  ${row.case_type}  rows=${row.total}  null_opened=${row.null_opened}  null_modified=${row.null_modified}`,
			);
		}
		console.log(
			`\n${rows.length} (app, case_type) groups — ${opened} NULL opened_on, ${modified} NULL modified_on.`,
		);
		console.log(
			"Backfill with: npx tsx scripts/migrate-case-timestamps.ts --execute" +
				(options.prod ? " --prod" : ""),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
