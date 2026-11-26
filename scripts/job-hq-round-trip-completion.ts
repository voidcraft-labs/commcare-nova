import { Command } from "commander";
import { sql } from "kysely";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	applyCompletion,
	completionArtifacts,
} from "./lib/hqRoundTripCompletion";
import { runMain } from "./lib/main";
import {
	readCompletionJobPlan,
	requireCompletionJobEnvironment,
} from "./lib/step7CompletionJob";
import { step7CompletionStorage } from "./lib/step7CompletionStorage";

const options = new Command()
	.description(
		"Verify the reviewed Step 7 plan. Execution requires drained production writers.",
	)
	.requiredOption("--scan-digest <sha256>", "reviewed private plan digest")
	.requiredOption(
		"--plan-generation <id>",
		"exact Cloud Storage generation of the private plan",
	)
	.option("--execute", "commit or independently verify the conversion")
	.parse()
	.opts<{ scanDigest: string; planGeneration: string; execute?: boolean }>();

runMain(async () => {
	try {
		const { role, database } = requireCompletionJobEnvironment(process.env);
		const plan = await readCompletionJobPlan(
			options.scanDigest,
			options.planGeneration,
		);
		const migration = await completionArtifacts(
			"/app/step7-artifacts/manifest.json",
			plan.conversionSettings,
		);
		if (migration.provenance !== plan.provenance)
			throw new Error(
				"The Job decoder or converter differs from the reviewed scan.",
			);

		let result: "plan-verified" | "converted" | "verified" = "plan-verified";
		if (options.execute === true) {
			const db = await getAppDb();
			const identity = await sql<{ eligible: boolean }>`
				SELECT session_user = ${role} AND current_user = ${role}
					AND current_database() = ${database} AS eligible
			`.execute(db);
			if (identity.rows[0]?.eligible !== true)
				throw new Error(
					"The cutover requires the migration database authority.",
				);
			result = await applyCompletion(
				db,
				migration,
				plan,
				step7CompletionStorage,
			);
		}
		console.log(
			JSON.stringify({
				result,
				apps: plan.apps.length,
				openWorkspaces: plan.workspaces.length,
				digest: options.scanDigest,
				planGeneration: options.planGeneration,
			}),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
