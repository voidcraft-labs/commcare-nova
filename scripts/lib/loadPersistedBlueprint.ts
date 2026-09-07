/** Script-safe exact Blueprint loader with no route/server-only dependency. */

import { sql, type Transaction } from "kysely";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedBlueprintRootText,
	type PersistedEntityRowText,
} from "../../lib/db/persistedJson";
import { type AppDatabase, getAppDb } from "../../lib/db/pg";
import type { PersistableDoc } from "../../lib/domain";
import { safePersistedSequence } from "../../lib/utils/persistedSequence";

async function loadPersistedBlueprint(
	tx: Transaction<AppDatabase>,
	appId: string,
	lockApp: boolean,
): Promise<PersistableDoc | null> {
	let rootQuery = tx
		.selectFrom("apps")
		.select(["app_name", "connect_type", "logo"])
		.select(
			sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.select(
			sql<string | null>`${sql.ref("apps.localization")}::text`.as(
				"localization_text",
			),
		)
		.where("id", "=", appId);
	if (lockApp) rootQuery = rootQuery.forShare();
	const root = await rootQuery.executeTakeFirst();
	if (root === undefined) return null;
	const entities = await tx
		.selectFrom("blueprint_entities")
		.select(["uuid", "kind", "parent_uuid", "ordinal"])
		.select(sql<string>`${sql.ref("data")}::text`.as("data_text"))
		.where("app_id", "=", appId)
		.orderBy("kind")
		.orderBy("parent_uuid")
		.orderBy("ordinal")
		.orderBy("uuid")
		.execute();
	return assemblePersistedBlueprintJsonText(
		appId,
		root as PersistedBlueprintRootText,
		entities as PersistedEntityRowText[],
	);
}

/**
 * Exact loader for a write-capable app transaction. The share lock keeps the
 * Blueprint carriers stable while a separate derived-state proof runs.
 */
export function loadPersistedBlueprintInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<PersistableDoc | null> {
	return loadPersistedBlueprint(tx, appId, true);
}

/**
 * Exact nonlocking loader for a REPEATABLE READ, READ ONLY transaction. This
 * is the production inspector path: human IAM users have SELECT but cannot
 * take row locks, and the transaction snapshot supplies consistency instead.
 */
export function loadPersistedBlueprintReadOnly(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<PersistableDoc | null> {
	return loadPersistedBlueprint(tx, appId, false);
}

/** One app's exact persisted document with the identity a repair reports and
 *  the sequence its write must be fenced on. */
export interface PersistedBlueprintSnapshot {
	readonly appId: string;
	readonly appName: string;
	readonly mutationSeq: number;
	readonly blueprint: PersistableDoc;
}

/**
 * The read every historical repair starts from: one REPEATABLE READ, READ
 * ONLY transaction over the app row and its Blueprint carriers, so the
 * sequence and the document describe the same instant. `null` when the app
 * does not exist. Soft-deleted apps load like live ones; each repair decides
 * whether to list them.
 */
export async function loadPersistedBlueprintSnapshot(
	appId: string,
): Promise<PersistedBlueprintSnapshot | null> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const row = await tx
				.selectFrom("apps")
				.select(["id", "app_name", "mutation_seq"])
				.where("id", "=", appId)
				.executeTakeFirst();
			if (row === undefined) return null;
			const blueprint = await loadPersistedBlueprintReadOnly(tx, appId);
			if (blueprint === null) return null;
			return {
				appId,
				appName: row.app_name,
				mutationSeq: safePersistedSequence(
					row.mutation_seq,
					`apps.mutation_seq for app ${appId}`,
				),
				blueprint,
			};
		});
}
