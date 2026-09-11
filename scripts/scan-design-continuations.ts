/** Read-only census. Does not contact a model or change a session. */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { scanDesignContinuations } from "@/lib/db/designContinuationRecovery";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.option("--prod", "read production using operator IAM credentials")
	.parse();
if (program.opts<{ prod?: boolean }>().prod) targetProdDb();
runMain(async () => {
	try {
		for (const row of await scanDesignContinuations())
			console.log(
				JSON.stringify({
					...row,
					continuation:
						row.run_id !== null ||
						row.run_holder_nonce !== null ||
						row.res_run_id !== null
							? "held"
							: row.active_build_plan_id !== null
								? "already-planned"
								: row.continuation_recovery?.preparedAt ===
										row.updated_at.toISOString()
									? "prepared"
									: "new-user-turn",
				}),
			);
	} finally {
		await closeCaseStoreDatabase();
	}
});
