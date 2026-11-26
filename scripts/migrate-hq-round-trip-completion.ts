import "./lib/loadEnv";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	applyCompletion,
	completionArtifacts,
	completionPlanSchema,
} from "./lib/hqRoundTripCompletion";
import { runMain } from "./lib/main";
import { step7CompletionStorage } from "./lib/step7CompletionStorage";

const options = new Command()
	.description(
		"Verify the private Step 7 plan, or rehearse it in a local Postgres database.",
	)
	.requiredOption("--artifacts <path>", "manifest used by the reviewed scan")
	.requiredOption("--plan <path>", "private plan written by the read-only scan")
	.requiredOption(
		"--digest <sha256>",
		"the reviewed plan digest printed by the scanner",
	)
	.option("--execute", "commit the conversion to local Postgres")
	.parse()
	.opts<{
		artifacts: string;
		plan: string;
		digest: string;
		execute?: boolean;
	}>();

function requireLocalDatabase() {
	const localUrl = process.env.NOVA_DB_LOCAL_URL;
	if (!localUrl)
		throw new Error("The rehearsal requires a local NOVA_DB_LOCAL_URL.");
	const target = new URL(localUrl);
	if (
		!["postgres:", "postgresql:"].includes(target.protocol) ||
		!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
		["host", "hostaddr", "service"].some((key) => target.searchParams.has(key))
	)
		throw new Error("The rehearsal requires a loopback Postgres connection.");
}

runMain(async () => {
	try {
		const plan = completionPlanSchema.parse(
			JSON.parse(await readFile(options.plan, "utf8")),
		);
		const digest = canonicalJsonDigest(plan);
		if (digest !== options.digest)
			throw new Error("The selected plan differs from the reviewed scan.");
		const migration = await completionArtifacts(
			options.artifacts,
			plan.conversionSettings,
		);
		if (migration.provenance !== plan.provenance)
			throw new Error(
				"The selected converter or released decoder differs from the scan.",
			);

		let result: "plan-verified" | "converted" | "verified" = "plan-verified";
		if (options.execute === true) {
			requireLocalDatabase();
			result = await applyCompletion(
				await getAppDb(),
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
				digest,
			}),
		);
	} finally {
		await closeCaseStoreDatabase();
	}
});
