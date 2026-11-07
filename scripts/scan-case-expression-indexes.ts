import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { getAppDb } from "../lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import { scanCaseExpressionIndexes } from "./lib/retireCaseExpressionIndexes";

const program = new Command()
	.option("--prod", "read production using your gcloud identity")
	.parse();
if (program.opts().prod) targetProdDb();
runMain(async () => {
	try {
		const db = await getAppDb();
		const scan = await db
			.transaction()
			.setAccessMode("read only")
			.execute((tx) => scanCaseExpressionIndexes(tx));
		console.log(JSON.stringify(scan, null, 2));
		if (scan.blockers.length) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
});
