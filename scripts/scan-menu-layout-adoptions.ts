import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { runMain } from "./lib/main";
import { scanMenuLayoutAdoptions } from "./lib/menuLayoutAdoptionScan";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.description(
		"Read retained CommCare HQ menu layouts and count the apps that could adopt them.",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--output <path>",
		"write a new private JSON file with deployment evidence and planned layout choices",
	)
	.option(
		"--prod",
		"read the production Cloud SQL instance as your gcloud IAM identity",
	)
	.parse()
	.opts<{ app?: string; output?: string; prod?: boolean }>();
if (options.prod) targetProdDb();

runMain(async () => {
	try {
		const db = await getAppDb();
		const scan = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => scanMenuLayoutAdoptions(tx, options.app));
		const counts: Record<string, number> = {};
		for (const { standing } of scan.outcomes)
			counts[standing] = (counts[standing] ?? 0) + 1;
		console.log(
			JSON.stringify(
				{ deployments: scan.outcomes.length, counts, digest: scan.digest },
				null,
				2,
			),
		);
		if (options.output !== undefined) {
			await writeFile(options.output, `${JSON.stringify(scan, null, 2)}\n`, {
				flag: "wx",
				mode: 0o600,
			});
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
