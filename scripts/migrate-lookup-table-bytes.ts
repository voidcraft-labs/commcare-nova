/**
 * WRITER — set each inline lookup table's `data_bytes` back to the stored bytes
 * of its rows.
 *
 * Dry-run by default; nothing writes without `--execute`. Run
 * `scan-lookup-table-bytes.ts` first, execute this once the previous revision
 * has stopped serving, then scan again to zero. Each table is repaired in its
 * own transaction under the table row's lock, the lock every row writer takes
 * first, so the total it writes is the one its rows hold when it commits.
 */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	repairLookupTableBytes,
	scanLookupTableBytes,
} from "./lib/lookupTableBytes";
import { runMain } from "./lib/main";

const cli = new Command()
	.name("migrate-lookup-table-bytes")
	.description(
		"Repair inline lookup table byte totals. Dry-run by default; --execute writes. Run scan-lookup-table-bytes.ts before and after.",
	)
	.option("--execute", "write the repair (default: print the plan only)")
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Uses the database selected by NOVA_DB_LOCAL_URL or the Cloud SQL\n" +
			"  connector environment. There is intentionally no --prod writer\n" +
			"  shortcut; production execution requires an explicit write-capable env.\n",
	)
	.parse();
const execute = cli.opts<{ execute?: boolean }>().execute === true;

async function main() {
	try {
		const db = await getAppDb();
		const before = await scanLookupTableBytes(db);
		if (!execute) {
			console.log(
				`DRY RUN — would repair ${before.mismatched} lookup table total(s). Nothing writes without --execute.`,
			);
			return;
		}
		const repaired = await repairLookupTableBytes(db);
		const after = await scanLookupTableBytes(db);
		console.log(JSON.stringify({ repaired, remaining: after.mismatched }));
		if (after.mismatched > 0) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
}
runMain(main);
