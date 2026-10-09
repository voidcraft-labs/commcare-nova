/** Read-only census. Outputs identifiers/digests only, never conversation content. */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { inspectAuthoringAmplification } from "./lib/authoringAmplificationStore";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.description(
		"Scan all design-targeted threads for proven final-response amplification. Read only.",
	)
	.option("--prod", "read production using the operator identity")
	.parse();
if (program.opts<{ prod?: boolean }>().prod) targetProdDb();
runMain(async () => {
	try {
		const db = await getAppDb();
		let after = "";
		let scanned = 0;
		let affected = 0;
		while (true) {
			const rows = await db
				.selectFrom("threads")
				.select("thread_id")
				.where("design_session_id", "is not", null)
				.where("thread_id", ">", after)
				.orderBy("thread_id")
				.limit(100)
				.execute();
			if (!rows.length) break;
			for (const row of rows) {
				scanned++;
				const finding = await inspectAuthoringAmplification(row.thread_id);
				if (finding) {
					affected++;
					const { snapshot: _snapshot, plan: _plan, ...report } = finding;
					console.log(JSON.stringify(report));
				}
				after = row.thread_id;
			}
		}
		console.log(JSON.stringify({ scanned, affected }));
	} finally {
		await closeCaseStoreDatabase();
	}
});
