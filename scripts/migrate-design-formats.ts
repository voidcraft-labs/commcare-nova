/** One-time writer; scan first and again after the cutover. */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import {
	retireObsoleteDesignSession,
	scanObsoleteDesignFormats,
} from "./lib/retireDesignFormats";

const program = new Command()
	.name("migrate-design-formats")
	.description(
		"Retire obsolete design metadata while preserving apps, conversations and billing. Dry-run by default.",
	)
	.option("--execute", "retire eligible design sessions")
	.addHelpText(
		"after",
		"\nRun during the documented design cutover with old writers drained. Held runs, unfinished apps and unaccounted usage block retirement. Uses the configured database; production writes require an explicit write-capable environment.\n",
	);
program.parse();
const execute = program.opts<{ execute?: boolean }>().execute === true;

runMain(async () => {
	try {
		const findings = await scanObsoleteDesignFormats();
		for (const finding of findings) {
			const result =
				execute && finding.status === "ready"
					? await retireObsoleteDesignSession(finding.sessionId)
					: finding;
			console.log(JSON.stringify(result));
			if (
				result !== null &&
				result.status !== "retired" &&
				result.status !== "current"
			)
				process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
