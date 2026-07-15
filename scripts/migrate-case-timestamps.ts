/**
 * ⚠️ WRITER — backfill NULL `opened_on` / `modified_on` on existing
 * `cases` rows. `scan-case-timestamps.ts` is the read-only sizing pass;
 * run it first, then this with `--execute`, then the scan again (it must
 * report zero rows).
 *
 * The backfill value is the row's own creation time recovered from its
 * `case_id`: every case id is a UUIDv7 (the column default and every TS
 * mint), whose first 48 bits are the creation unix-milliseconds. A row
 * whose extracted timestamp falls outside a sane window (a non-v7 id)
 * falls back to `now()` rather than writing garbage. `modified_on`
 * prefers the same creation time — rows a followup already touched
 * carry a real `modified_on` and are left alone by the `COALESCE`.
 *
 * Dry run (default) prints the would-be update count and a sample.
 * `--prod` targets production (see `./lib/prodDb.ts`).
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

interface MigrateOptions {
	execute?: boolean;
	prod?: boolean;
}

const program = new Command();
program
	.name("migrate-case-timestamps")
	.description(
		"Backfill NULL opened_on / modified_on from each row's UUIDv7 creation time (dry-run unless --execute).",
	)
	.option("--execute", "apply the backfill (default is a dry run)")
	.option(
		"--prod",
		"target the production Cloud SQL instance over its public IP as your gcloud IAM identity",
	)
	.parse();

const options = program.opts<MigrateOptions>();

/** The row's UUIDv7-embedded creation time, guarded to a sane window —
 *  outside it (a non-v7 id) the expression falls back to `now()`. */
const UUID_CREATION_TIME = sql<Date>`
	case
		when to_timestamp(
			('x' || substring(replace(case_id::text, '-', '') from 1 for 12))::bit(48)::bigint / 1000.0
		) between timestamptz '2024-01-01' and now() + interval '1 day'
		then to_timestamp(
			('x' || substring(replace(case_id::text, '-', '') from 1 for 12))::bit(48)::bigint / 1000.0
		)
		else now()
	end
`;

runMain(async () => {
	if (options.prod) targetProdDb();
	const db = await getCaseStoreDatabase();
	try {
		const pending = await db
			.selectFrom("cases")
			.select(({ fn }) => [fn.countAll().as("total")])
			.where((eb) =>
				eb.or([eb("opened_on", "is", null), eb("modified_on", "is", null)]),
			)
			.executeTakeFirstOrThrow();
		const total = Number(pending.total);
		if (total === 0) {
			console.log("Nothing to backfill.");
			return;
		}
		if (!options.execute) {
			console.log(
				`DRY RUN — ${total} rows carry a NULL opened_on / modified_on. Re-run with --execute to backfill.`,
			);
			return;
		}

		const result = await db
			.updateTable("cases")
			.set({
				opened_on: sql<Date>`coalesce(opened_on, ${UUID_CREATION_TIME})`,
				modified_on: sql<Date>`coalesce(modified_on, ${UUID_CREATION_TIME})`,
			})
			.where((eb) =>
				eb.or([eb("opened_on", "is", null), eb("modified_on", "is", null)]),
			)
			.executeTakeFirst();
		console.log(
			`Backfilled ${result.numUpdatedRows} rows. Re-run scan-case-timestamps.ts — it must report zero.`,
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
