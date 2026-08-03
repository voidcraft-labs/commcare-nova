/** Script-safe exact Blueprint loader with no route/server-only dependency. */

import { sql, type Transaction } from "kysely";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedBlueprintRootText,
	type PersistedEntityRowText,
} from "../../lib/db/persistedJson";
import type { AppDatabase } from "../../lib/db/pg";
import type { PersistableDoc } from "../../lib/domain";

export async function loadPersistedBlueprintInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<PersistableDoc | null> {
	const root = await tx
		.selectFrom("apps")
		.select(["app_name", "connect_type", "logo"])
		.select(
			sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.where("id", "=", appId)
		.forShare()
		.executeTakeFirst();
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
