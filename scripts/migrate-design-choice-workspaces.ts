/** One-time writer. Dry-run by default; scan separately before and afterward. */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import {
	resetDesignChoiceWorkspace,
	scanDesignChoiceWorkspaces,
} from "./lib/designChoiceWorkspaceRepair";
import { runMain } from "./lib/main";

const program = new Command()
	.name("migrate-design-choice-workspaces")
	.description(
		"Retire private workspaces with incorrect historical choice evidence. Preserves history, accepted designs, apps, and Project data.",
	)
	.option("--execute", "write the resets; otherwise report only")
	.addHelpText(
		"after",
		"\nUses NOVA_DB_LOCAL_URL or the configured Cloud SQL connector. Production writes require an explicit write-capable environment. Active session or app holders block repair; finish or recover those runs first.\n",
	);
program.parse();
const execute = program.opts<{ execute?: boolean }>().execute === true;

runMain(async () => {
	try {
		for (const finding of await scanDesignChoiceWorkspaces()) {
			const result =
				execute && finding.invalidProofs > 0
					? await resetDesignChoiceWorkspace(finding.workspaceId)
					: finding;
			console.log(JSON.stringify(result));
			if (execute && result?.standing === "busy") process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
