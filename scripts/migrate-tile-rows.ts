/** Apply the reviewed case tile row repair plan that `scan-tile-rows --out`
 * wrote (`scripts/lib/tileRowRepair.ts` says what the repair does and why).
 * Dry-run by default: it prints each app's moves. `--execute` writes each app's
 * repair as one `blueprint-migration` change, refusing an app that changed
 * since the scan. Production execution uses the migration Job identity. */
import "./lib/loadEnv";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { migrateTileRows, tileRowRepairSchema } from "./lib/tileRowRepair";

const options = new Command()
	.description(
		"Apply the reviewed case tile row repair plan. Dry-run by default. Production execution uses the migration Job identity.",
	)
	.option("--plan <path>", "reviewed JSON plan file")
	.option("--plan-base64 <value>", "reviewed JSON plan for the maintenance Job")
	.option("--execute")
	.parse()
	.opts<{ plan?: string; planBase64?: string; execute?: boolean }>();
if ((options.plan === undefined) === (options.planBase64 === undefined))
	throw new Error("Provide exactly one of --plan or --plan-base64.");
runMain(async () => {
	try {
		const entries = z
			.array(tileRowRepairSchema)
			.parse(
				JSON.parse(
					options.plan !== undefined
						? await readFile(options.plan, "utf8")
						: Buffer.from(options.planBase64 ?? "", "base64").toString("utf8"),
				),
			);
		if (new Set(entries.map((entry) => entry.appId)).size !== entries.length)
			throw new Error("Repair plan repeats an app.");
		for (const entry of entries)
			console.log(
				JSON.stringify(
					options.execute
						? await migrateTileRows(entry)
						: {
								appId: entry.appId,
								expectedBaseSeq: entry.expectedBaseSeq,
								moves: entry.moves,
								reason: entry.reason,
							},
				),
			);
	} finally {
		await closeCaseStoreDatabase();
	}
});
