import { type Kysely, sql } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";

/**
 * Establish the HQ round-trip emission fold horizon over one app the way the
 * cutover's fleet transaction does: the app's head moves one sequence with a
 * renamed document, every entity row is rewritten in the same transaction,
 * and the marker and the baseline are inserted with the snapshot the database
 * computes. Returns the horizon's sequence.
 */
export async function writeHqRoundTripHorizon(
	db: Kysely<AppDatabase>,
	appId: string,
	appName: string,
): Promise<number> {
	return db.transaction().execute(async (tx) => {
		const app = await tx
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", appId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		const seq = Number(app.mutation_seq) + 1;
		await tx
			.updateTable("apps")
			.set({
				mutation_seq: seq,
				app_name: appName,
				app_name_lower: appName.toLowerCase(),
			})
			.where("id", "=", appId)
			.execute();
		await sql`UPDATE blueprint_entities SET data = data WHERE app_id = ${appId}`.execute(
			tx,
		);
		await tx
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq,
				batch_id: "fold-baseline:hq-round-trip-emission",
				run_id: null,
				actor_id: "system:hq-round-trip-emission",
				kind: "fold-baseline",
				mutations: "[]",
				from_project_id: null,
				to_project_id: null,
			})
			.execute();
		await sql`
			INSERT INTO app_change_fold_baselines
				(app_id, seq, project_id, snapshot, snapshot_digest)
			SELECT app.id, ${seq}, app.project_id, current.snapshot,
				nova_app_change_fold_snapshot_digest(current.snapshot)
			FROM apps AS app,
				LATERAL (
					SELECT nova_current_app_change_fold_snapshot(app.id) AS snapshot
				) AS current
			WHERE app.id = ${appId}
		`.execute(tx);
		return seq;
	});
}
