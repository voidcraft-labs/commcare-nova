import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { scanCaseSelection } from "./lib/caseSelectionMigration";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.description(
		"Freeze the old parent-selection routes in a private, read-only migration manifest. Run after draining writers and repairing authoring baselines.",
	)
	.requiredOption("--out <path>")
	.requiredOption("--source-revision <sha>")
	.option("--app <id>")
	.option("--prod")
	.parse()
	.opts<{
		out: string;
		sourceRevision: string;
		app?: string;
		prod?: boolean;
	}>();
if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const manifest = await scanCaseSelection(
			options.sourceRevision,
			options.app ? [options.app] : undefined,
		);
		await writeFile(options.out, JSON.stringify(manifest, null, 2), {
			mode: 0o600,
			flag: "wx",
		});
		const blocked = manifest.entries.filter((entry) => entry.refusals.length);
		console.log(
			JSON.stringify({
				apps: manifest.entries.length,
				blocked: blocked.length,
				digest: manifest.digest,
			}),
		);
		if (blocked.length) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
});
