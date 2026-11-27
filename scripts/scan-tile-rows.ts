/** Read-only inventory before and after the case tile row repair
 * (`scripts/lib/tileRowRepair.ts` says what the repair does and why). It
 * writes nothing to the database; `--out` writes the reviewed plan the migrate
 * script takes, one entry per affected app, every cell move named. */
import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import { inspectTileRows, type TileRowRepair } from "./lib/tileRowRepair";

const options = new Command()
	.description(
		"Scan saved case tiles for a cell below the rows CommCare HQ's own pages keep, without writing to the database.",
	)
	.option("--app <id>")
	.option("--out <path>", "private repair plan JSON for migrate-tile-rows")
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
		const plans: TileRowRepair[] = [];
		const unreadable: string[] = [];
		const unrepaired: string[] = [];
		for (const { id } of apps) {
			try {
				const inspected = await inspectTileRows(id);
				if (inspected.plan === null) continue;
				plans.push(inspected.plan);
				if (inspected.left?.length) unrepaired.push(id);
				console.log(
					JSON.stringify({
						appId: id,
						findings: inspected.findings.length,
						moves: inspected.plan.moves.map((move) => ({
							module: move.moduleUuid,
							screen: move.screen,
							column: move.columnUuid,
							from: [
								move.before.x,
								move.before.y,
								move.before.width,
								move.before.height,
							],
							to: [
								move.after.x,
								move.after.y,
								move.after.width,
								move.after.height,
							],
							how: move.how,
						})),
						leftAfterRepair: inspected.left?.length ?? 0,
					}),
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
			await writeFile(options.out, JSON.stringify(plans, null, 2), {
				mode: 0o600,
			});
		console.log(
			JSON.stringify({
				scanned: apps.length,
				affected: plans.length,
				unrepaired: unrepaired.length,
				unreadable: unreadable.length,
			}),
		);
		process.exitCode =
			unreadable.length || unrepaired.length ? 2 : plans.length ? 1 : 0;
	} finally {
		await closeCaseStoreDatabase();
	}
});
