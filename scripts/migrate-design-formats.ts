/** One-time writer; scan first and again after the cutover. */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import {
	migrateLegacyAuthoring,
	scanLegacyAuthoring,
} from "./lib/migrateAuthoring";

const program = new Command()
	.name("migrate-design-formats")
	.description(
		"Convert old designs to Markdown and retire their private execution state. Preserves apps, conversations and billing. Dry-run by default.",
	)
	.option("--execute", "migrate eligible design sessions")
	.addHelpText(
		"after",
		"\nDrain old writers and scan first. Held runs and unaccounted usage block migration. Incomplete apps resume from their source, imported plan and actual saved app. Uses the configured database; production writes require an explicit write-capable environment.\n",
	);
program.parse();
const execute = program.opts<{ execute?: boolean }>().execute === true;

runMain(async () => {
	try {
		const findings = await scanLegacyAuthoring();
		for (const finding of findings) {
			const result =
				execute && finding.status === "ready"
					? await migrateLegacyAuthoring(finding.sessionId)
					: finding;
			console.log(JSON.stringify(result));
			if (
				result !== null &&
				result.status !== "migrated" &&
				result.status !== "current"
			)
				process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
