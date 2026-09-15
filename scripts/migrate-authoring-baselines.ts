import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import {
	repairAuthoringBaseline,
	scanAuthoringBaselines,
} from "./lib/repairAuthoringBaselines";

const program = new Command()
	.description(
		"Give affected apps a complete authoring baseline. Preserves canonical content and immutable history; abandons obsolete private work. Dry-run by default.",
	)
	.option("--app <id>", "repair one app")
	.option(
		"--execute",
		"repair eligible apps after scanning and draining writers",
	)
	.parse();
const options = program.opts<{ app?: string; execute?: boolean }>();
runMain(async () => {
	try {
		for (const finding of await scanAuthoringBaselines(options.app)) {
			const result =
				options.execute && finding.status === "ready"
					? await repairAuthoringBaseline(finding.appId)
					: finding;
			console.log(JSON.stringify(result));
			if (result && result.status !== "repaired" && result.status !== "current")
				process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
