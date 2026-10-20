import { type Kysely, sql, type Transaction } from "kysely";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import {
	denormalize,
	loadAppInTransaction,
} from "@/lib/db/canonicalCommitKernel";
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
		await insertHorizon(tx, appId, seq, "hq-round-trip-emission");
		return seq;
	});
}

/**
 * Establish the HQ round-trip expressions fold horizon over one app the way
 * that cutover's fleet transaction writes it: under the app row's lock, the
 * root columns from the target document (here the saved document renamed)
 * with `mutation_seq` one past the base and `updated_at` untouched, every
 * entity row deleted and inserted again from the target's decomposition, then
 * the marker and the baseline with the snapshot the database computes.
 * Returns the horizon's sequence.
 */
export async function writeHqRoundTripExpressionsHorizon(
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
		const saved = await loadAppInTransaction(tx, appId);
		if (saved === null) {
			throw new Error(`The app ${appId} has no saved document to move.`);
		}
		const target = { ...saved.blueprint, appName };
		const seq = Number(app.mutation_seq) + 1;
		await tx
			.updateTable("apps")
			.set({ ...denormalize(target), mutation_seq: seq })
			.where("id", "=", appId)
			.execute();
		await tx
			.deleteFrom("blueprint_entities")
			.where("app_id", "=", appId)
			.execute();
		const rows = decomposeBlueprint(target);
		if (rows.length > 0) {
			await tx
				.insertInto("blueprint_entities")
				.values(
					rows.map((row) => ({
						app_id: appId,
						uuid: row.uuid,
						kind: row.kind,
						parent_uuid: row.parent_uuid,
						ordinal: row.ordinal,
						data: JSON.stringify(row.data),
					})),
				)
				.execute();
		}
		await insertHorizon(tx, appId, seq, "hq-round-trip-expressions");
		return seq;
	});
}

/** The marker row and its baseline, for one cutover's operator identity. */
async function insertHorizon(
	tx: Transaction<AppDatabase>,
	appId: string,
	seq: number,
	cutover: "hq-round-trip-emission" | "hq-round-trip-expressions",
): Promise<void> {
	await tx
		.insertInto("app_changes")
		.values({
			app_id: appId,
			seq,
			batch_id: `fold-baseline:${cutover}`,
			run_id: null,
			actor_id: `system:${cutover}`,
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
}
