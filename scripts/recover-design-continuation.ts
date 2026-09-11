import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { prepareDesignContinuation } from "@/lib/db/designContinuationRecovery";
import { runMain } from "./lib/main";

const program = new Command()
	.description(
		"Prepare one stopped design for a new user turn. Dry-run by default. Uses explicitly configured database credentials; never calls a model.",
	)
	.requiredOption("--session <id>")
	.requiredOption("--actor <id>", "design owner's user ID")
	.requiredOption(
		"--expected-updated-at <timestamp>",
		"exact timestamp from the read-only scan",
	)
	.option("--execute", "record the versioned recovery receipt")
	.parse();
const options = program.opts<{
	session: string;
	actor: string;
	expectedUpdatedAt: string;
	execute?: boolean;
}>();
runMain(async () => {
	try {
		console.log(
			JSON.stringify(
				await prepareDesignContinuation({
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
