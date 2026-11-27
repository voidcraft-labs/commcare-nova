import { sql, type Transaction } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedBlueprintRootText,
	type PersistedEntityRowText,
} from "./persistedJson";
import type { AppDatabase } from "./pg";

/** A resource writer owns its table or asset lock. Taking app locks here
 * would invert the app writer's lock order. Read each root and all of its
 * normalized entities in one statement snapshot instead. */
export function persistedReferenceApps(tx: Transaction<AppDatabase>) {
	return tx
		.selectFrom("apps as app")
		.select(["app.id", "app.app_name", "app.connect_type", "app.logo"])
		.select(
			sql<string | null>`${sql.ref("app.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.select(
			sql<string | null>`${sql.ref("app.localization")}::text`.as(
				"localization_text",
			),
		)
		.select(
			sql<string | null>`${sql.ref("app.app_settings")}::text`.as(
				"app_settings_text",
			),
		)
		.select((eb) => [
			jsonArrayFrom(
				eb
					.selectFrom("blueprint_entities as entity")
					.select([
						"entity.uuid",
						"entity.kind",
						"entity.parent_uuid",
						"entity.ordinal",
					])
					.select(sql<string>`${sql.ref("entity.data")}::text`.as("data_text"))
					.whereRef("entity.app_id", "=", "app.id")
					.orderBy("entity.uuid"),
			).as("entities"),
		]);
}

export function hydrateReferenceApp(
	app: PersistedBlueprintRootText & {
		id: string;
		entities: readonly PersistedEntityRowText[];
	},
) {
	return hydratePersistedBlueprint(
		assemblePersistedBlueprintJsonText(app.id, app, app.entities),
	);
}
