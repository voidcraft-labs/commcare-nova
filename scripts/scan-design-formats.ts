/** Read-only scan before the design-format cutover. */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { scanLegacyAuthoring } from "./lib/migrateAuthoring";
import { targetProdDb } from "./lib/prodDb";

const program = new Command()
	.name("scan-design-formats")
	.description(
		"Find sessions using the old authoring format and their migration blockers. Read only.",
	)
	.option("--prod", "read production using the operator identity");
program.parse();
if (program.opts<{ prod?: boolean }>().prod) targetProdDb();

runMain(async () => {
	try {
		const findings = await scanLegacyAuthoring();
		for (const finding of findings) console.log(JSON.stringify(finding));
		if (findings.length > 0) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
});
