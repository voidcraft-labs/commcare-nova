import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { scanLocationCaptureAdoptions } from "./lib/locationCaptureAdoption";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.description(
		"Freeze automatic location choices from active HQ targets for the deployment conversion.",
	)
	.requiredOption("--out <path>")
	.option("--prod")
	.parse()
	.opts<{ out: string; prod?: boolean }>();
if (options.prod) targetProdDb();

runMain(async () => {
	try {
		const manifest = await scanLocationCaptureAdoptions();
		await writeFile(options.out, JSON.stringify(manifest, null, 2), {
			flag: "wx",
			mode: 0o600,
		});
		const byStanding: Record<string, number> = {};
		for (const decision of manifest.decisions)
			byStanding[decision.standing] = (byStanding[decision.standing] ?? 0) + 1;
		const targets = manifest.decisions.flatMap((decision) => decision.targets);
		console.log(
			JSON.stringify({
				apps: manifest.decisions.length,
				byStanding,
				targets: targets.length,
				observedOn: targets.filter((target) => target.previous === true).length,
				observedOff: targets.filter((target) => target.previous === false)
					.length,
				unobservedTargets: targets.filter((target) => target.previous === null)
					.length,
				digest: manifest.digest,
			}),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
