import "server-only";

import { type Kysely, sql } from "kysely";
import type { AppDatabase } from "./pg";

export interface AppChangeStreamRow {
	readonly seq: string | number;
	readonly batch_id: string;
	readonly run_id: string | null;
	readonly actor_id: string;
	readonly kind: string;
	readonly from_project_id: string | null;
	readonly to_project_id: string | null;
	readonly baseline_seq: string | number | null;
	readonly mutations_text: string;
}

/**
 * The durable stream's production read, shared by the SSE route and the
 * post-migration runtime-role probe. Keep this query free of row-lock clauses:
 * `app_changes` is append-only and `app_change_fold_baselines` is read-only, so
 * the serving role intentionally lacks the UPDATE privilege PostgreSQL requires
 * for `FOR UPDATE`, `FOR SHARE`, and their variants.
 */
export async function readAppChangeStreamRowsSince(
	db: Kysely<AppDatabase>,
	appId: string,
	deliveredThrough: number,
): Promise<readonly AppChangeStreamRow[]> {
	return db
		.selectFrom("app_changes")
		.leftJoin("app_change_fold_baselines as baseline", (join) =>
			join
				.onRef("baseline.app_id", "=", "app_changes.app_id")
				.onRef("baseline.seq", "=", "app_changes.seq"),
		)
		.select([
			"app_changes.seq as seq",
			"app_changes.batch_id as batch_id",
			"app_changes.run_id as run_id",
			"app_changes.actor_id as actor_id",
			"app_changes.kind as kind",
			"app_changes.from_project_id as from_project_id",
			"app_changes.to_project_id as to_project_id",
			"baseline.seq as baseline_seq",
		])
		.select(
			sql<string>`${sql.ref("app_changes.mutations")}::text`.as(
				"mutations_text",
			),
		)
		.where("app_changes.app_id", "=", appId)
		.where("app_changes.seq", ">", deliveredThrough)
		.orderBy("app_changes.seq")
		.execute();
}
