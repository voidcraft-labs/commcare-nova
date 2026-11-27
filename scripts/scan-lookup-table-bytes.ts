/**
 * READ-ONLY — count inline lookup tables whose `data_bytes` total differs from
 * the stored bytes of their rows.
 *
 * `20261206000000_lookup_generations` widens `lookup_tables.data_bytes` to
 * bigint while the previous revision still serves. node-postgres hands an
 * int8 back as a string, and that revision adds a row as
 * `table.data_bytes + inserted.value_bytes`, which concatenates: a 5,000-byte
 * table that gains a 120-byte row is stored as 5,000,120 bytes. Run this after
 * the rollout to size the repair, run `migrate-lookup-table-bytes.ts`, then run
 * this again to zero. A table with an active generation keeps its total from
 * that generation, which the previous revision never wrote, so it is not read.
 * Output is aggregate only: no table name, tag or row content.
 */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { scanLookupTableBytes } from "./lib/lookupTableBytes";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const cli = new Command()
	.name("scan-lookup-table-bytes")
	.option("--prod", "read production through the operator IAM connection")
	.parse();
if (cli.opts().prod) targetProdDb();

async function main() {
	try {
		const report = await scanLookupTableBytes(await getAppDb());
		console.log(JSON.stringify(report));
		if (report.mismatched > 0) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
}
runMain(main);
