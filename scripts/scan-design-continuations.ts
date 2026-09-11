/** Read-only census. Does not contact a model or change a session. */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { scanDesignContinuationMigration } from "./lib/designContinuationMigration";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.option("--prod", "read production using operator IAM credentials")
	.parse();
if (program.opts<{ prod?: boolean }>().prod) targetProdDb();
runMain(async () => {
	try {
		for (const row of await scanDesignContinuationMigration())
			console.log(JSON.stringify(row));
	} finally {
		await closeCaseStoreDatabase();
	}
});
