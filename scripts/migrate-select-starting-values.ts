import "./lib/loadEnv";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import {
	migrateSelectStartingValues,
	selectStartingValueRepairSchema,
} from "./lib/selectStartingValueRepair";

const options = new Command()
	.description(
		"Apply the reviewed choice-starting-value repair plan. Dry-run by default. Production execution uses the migration Job identity.",
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
			.array(selectStartingValueRepairSchema)
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
						? await migrateSelectStartingValues(entry)
						: {
								appId: entry.appId,
								expectedBaseSeq: entry.expectedBaseSeq,
								patches: entry.patches,
								reason: entry.reason,
							},
				),
			);
	} finally {
		await closeCaseStoreDatabase();
	}
});
