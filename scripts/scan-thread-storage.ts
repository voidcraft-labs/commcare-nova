/** Read-only transcript census. Never prints conversation content. */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { scanThreadStorage } from "@/lib/db/threadStorageScan";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.description(
		"Read-only census for incremental transcript storage. Reports counts and sizes, never messages.",
	)
	.option("--prod", "read production using the operator identity")
	.parse();
if (program.opts<{ prod?: boolean }>().prod) targetProdDb();

runMain(async () => {
	try {
		const db = await getAppDb();
		const report = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.execute(scanThreadStorage);
		console.log(JSON.stringify(report));
	} finally {
		await closeCaseStoreDatabase();
	}
});
