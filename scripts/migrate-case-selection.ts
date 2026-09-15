import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import {
	migrateCaseSelectionEntry,
	verifyCaseSelectionManifest,
} from "./lib/caseSelectionMigration";
import { runMain } from "./lib/main";

const options = new Command()
	.description(
		"Apply only the apps in the original frozen case-selection manifest. Dry-run by default; keep and reuse this manifest for retries.",
	)
	.requiredOption("--plan <path>")
	.option("--execute")
	.parse()
	.opts<{ plan: string; execute?: boolean }>();
runMain(async () => {
	try {
		const manifest = verifyCaseSelectionManifest(
			JSON.parse(await readFile(options.plan, "utf8")),
		);
		for (const entry of manifest.entries)
			console.log(
				JSON.stringify(
					options.execute
						? await migrateCaseSelectionEntry(entry)
						: { appId: entry.appId, routes: entry.routes.length },
				),
			);
	} finally {
		await closeCaseStoreDatabase();
	}
});
