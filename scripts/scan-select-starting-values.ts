/** Read-only inventory before and after the choice-starting-value repair.
 * Full diagnostic output goes only to the requested private JSON artifact. */
import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import { inspectSelectStartingValues } from "./lib/selectStartingValueRepair";

const options = new Command()
	.description(
		"Scan persisted inline choice starting values without writing to the database.",
	)
	.option("--app <id>")
	.option("--out <path>", "private diagnostic JSON artifact")
	.option("--prod", "read production as the operator IAM identity")
	.parse()
	.opts<{ app?: string; out?: string; prod?: boolean }>();
if (options.prod) targetProdDb();

runMain(async () => {
	try {
		const db = await getAppDb();
		let query = db.selectFrom("apps").select("id").orderBy("id");
		if (options.app) query = query.where("id", "=", options.app);
		const apps = await query.execute();
		if (options.app && apps.length === 0) throw new Error("App not found.");
		const reports = [];
		const unreadable: string[] = [];
		for (const { id } of apps) {
			try {
				const snapshot = await inspectSelectStartingValues(id);
				if (snapshot.findings.length === 0) continue;
				reports.push(snapshot);
				console.log(
					JSON.stringify({ appId: id, findings: snapshot.findings.length }),
				);
			} catch (error) {
				unreadable.push(id);
				console.error(
					JSON.stringify({
						appId: id,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
		if (options.out)
			await writeFile(
				options.out,
				JSON.stringify({ reports, unreadable }, null, 2),
				{ mode: 0o600 },
			);
		console.log(
			JSON.stringify({
				scanned: apps.length,
				affected: reports.length,
				unreadable: unreadable.length,
			}),
		);
		process.exitCode = unreadable.length ? 2 : reports.length ? 1 : 0;
	} finally {
		await closeCaseStoreDatabase();
	}
});
