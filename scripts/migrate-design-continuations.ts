import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { migrateDesignContinuation } from "./lib/designContinuationMigration";
import { runMain } from "./lib/main";

const program = new Command()
	.description(
		"Migrate one design workspace and its historical turn attribution. Dry-run by default; no model calls or artifact/usage rewrites.",
	)
	.requiredOption("--session <id>")
	.requiredOption("--actor <id>", "design owner's user ID")
	.requiredOption(
		"--expected-updated-at <timestamp>",
		"exact timestamp from the read-only scan",
	)
	.option(
		"--turn-assignments <path>",
		"JSON map of inspected context/step keys to exact logical turns for ambiguous history",
	)
	.option("--execute", "apply the inspected one-time migration")
	.parse();
const options = program.opts<{
	session: string;
	actor: string;
	expectedUpdatedAt: string;
	execute?: boolean;
	turnAssignments?: string;
}>();
runMain(async () => {
	try {
		console.log(
			JSON.stringify(
				await migrateDesignContinuation({
					turnAssignments:
						options.turnAssignments === undefined
							? undefined
							: z
									.record(z.string(), z.string())
									.parse(
										JSON.parse(await readFile(options.turnAssignments, "utf8")),
									),
					designSessionId: options.session,
					actorUserId: options.actor,
					expectedUpdatedAt: options.expectedUpdatedAt,
					execute: options.execute === true,
				}),
			),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
