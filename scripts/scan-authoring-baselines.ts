import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import { scanAuthoringBaselines } from "./lib/repairAuthoringBaselines";

const program = new Command()
	.description("Read-only scan for incomplete authoring fold baselines.")
	.option("--app <id>", "inspect one app")
	.option("--prod", "read production using the operator identity")
	.parse();
const options = program.opts<{ app?: string; prod?: boolean }>();
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const findings = await scanAuthoringBaselines(options.app);
		for (const finding of findings) console.log(JSON.stringify(finding));
		if (findings.length) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
});
