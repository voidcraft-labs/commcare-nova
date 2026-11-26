import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	completionArtifacts,
	completionPlanSchema,
	scanCompletion,
} from "./lib/hqRoundTripCompletion";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import {
	freezeCompletionSettings,
	step7CompletionStorage,
} from "./lib/step7CompletionStorage";

const options = new Command()
	.description(
		"Scan the released apps, deployment comparisons and private workspaces for the final HQ round trip.",
	)
	.requiredOption(
		"--artifacts <path>",
		"manifest for the exact released reader and candidate converter",
	)
	.requiredOption("--output <path>", "new private conversion plan")
	.option("--prod", "read production using the operator identity")
	.parse()
	.opts<{ artifacts: string; output: string; prod?: boolean }>();

if (options.prod) targetProdDb();
runMain(async () => {
	try {
		const db = await getAppDb();
		const released = await completionArtifacts(options.artifacts);
		const settings = await freezeCompletionSettings(db, released);
		const migration = await completionArtifacts(options.artifacts, settings);
		const started = performance.now();
		const plan = completionPlanSchema.parse(
			await scanCompletion(
				db,
				migration,
				step7CompletionStorage,
				(part, completed, total) => {
					if (completed === 1 || completed % 25 === 0 || completed === total)
						console.error(
							JSON.stringify({
								part,
								completed,
								total,
								seconds: Math.round((performance.now() - started) / 1000),
							}),
						);
				},
			),
		);
		await writeFile(options.output, `${JSON.stringify(plan)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		console.log(
			JSON.stringify({
				apps: plan.apps.length,
				openWorkspaces: plan.workspaces.length,
				admittedPrivateSteps: plan.workspaces.reduce(
					(count, item) => count + item.stepCount,
					0,
				),
				usableTargets: plan.apps.reduce(
					(count, item) => count + item.inventory.usable,
					0,
				),
				unavailableTargets: plan.apps.reduce(
					(count, item) => count + item.inventory.unavailable,
					0,
				),
				digest: canonicalJsonDigest(plan),
			}),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
