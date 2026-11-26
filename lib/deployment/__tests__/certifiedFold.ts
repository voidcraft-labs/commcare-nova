import type { Kysely } from "kysely";
import { writeHorizonInTransaction } from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import { loadApp } from "@/lib/db/apps";
import type { AppDatabase } from "@/lib/db/pg";
import {
	scanDeploymentFold,
	writeDeploymentAwareFold,
} from "@/scripts/lib/deploymentFold";
import {
	type DeploymentFoldMigration,
	sameRepresentationFold,
} from "@/scripts/lib/deploymentFoldArtifacts";

/** Real conversion entry point with the selected source dialect. The focused
 * tests independently compare the worker and target values across this seam. */
export async function certifyFold(
	db: Kysely<AppDatabase>,
	appId: string,
	cutover:
		| "hq-round-trip-expressions"
		| "hq-round-trip-case-writes" = "hq-round-trip-expressions",
	migration: DeploymentFoldMigration = sameRepresentationFold,
) {
	const app = await loadApp(appId);
	if (!app) throw new Error("The test app has no saved document.");
	const input = {
		appId,
		projectId: app.project_id,
		headSeq: app.mutation_seq,
		migration,
	};
	const inventory = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute((tx) => scanDeploymentFold(tx, input));
	return db
		.transaction()
		.execute((tx) =>
			writeDeploymentAwareFold(tx, input, inventory, (doc, seq) =>
				writeHorizonInTransaction(tx, appId, doc, seq, cutover),
			),
		);
}
