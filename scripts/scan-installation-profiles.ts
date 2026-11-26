/** Pre-DDL aggregate census. A missing or unverifiable source is a separate
 * result; no deployment key or private worker can be inferred from it. */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { scanInstallationProfileBaselines } from "./lib/installationProfileBaselines";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.option("--prod", "Read production with the operator's read-only connection.")
	.parse()
	.opts<{ prod?: boolean }>();
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		console.log(
			JSON.stringify(await scanInstallationProfileBaselines(await getAppDb())),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
