/** Read-only scan for the design choice-evidence cutover. */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { scanDesignChoiceWorkspaces } from "./lib/designChoiceWorkspaceRepair";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.name("scan-design-choice-workspaces")
	.description(
		"Find private design workspaces containing incorrect historical choice evidence. Read only.",
	)
	.option("--prod", "read production using the operator identity");
program.parse();
if (program.opts<{ prod?: boolean }>().prod) targetProdDb();

runMain(async () => {
	try {
		const findings = await scanDesignChoiceWorkspaces();
		for (const finding of findings) console.log(JSON.stringify(finding));
		if (findings.some((finding) => finding.invalidProofs > 0))
			process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
});
