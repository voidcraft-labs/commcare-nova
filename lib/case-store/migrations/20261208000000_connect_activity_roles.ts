/** The released and candidate projections coexist while the cutover converts
 * each app and its certified published comparisons in the same transaction.
 * A NULL is an unconverted row. A converted app with neither role has {}. */
import { type Kysely, type RawBuilder, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.apps ADD COLUMN connect_roles text[]
			CHECK (connect_roles IS NULL OR connect_roles IN (
				ARRAY[]::text[], ARRAY['learn']::text[], ARRAY['deliver']::text[],
				ARRAY['learn','deliver']::text[]
			))
	`.execute(db);
	await installConnectSnapshot(db, "converting");
}

/** The IAM scanner can select the released carriers. Building the projection in
 * Postgres preserves exact jsonb text, including decimal scale, in the receipt
 * which the locked writer verifies with the database's installed function. */
function foldSnapshotSelect(
	appId: RawBuilder<unknown>,
	roles: RawBuilder<unknown>,
) {
	return sql`WITH entity AS MATERIALIZED (
				SELECT row.uuid::text AS uuid, row.kind,
					row.parent_uuid::text AS parent_uuid, row.ordinal, row.data
				FROM public.blueprint_entities AS row WHERE row.app_id = ${appId}
			), collection AS (
				SELECT kind, jsonb_object_agg(uuid, data ORDER BY ordinal, uuid) AS entries,
					jsonb_agg(uuid ORDER BY ordinal, uuid) AS ordering
				FROM entity GROUP BY kind
			), flat_keys(kind, entries_key, order_key) AS (
				VALUES
					('user_property', 'userProperties', 'userPropertyOrder'),
					('user_type', 'userTypes', 'userTypeOrder'),
					('persona', 'personas', 'personaOrder'),
					('organization_level', 'organizationLevels', 'organizationLevelOrder'),
					('location_property', 'locationProperties', 'locationPropertyOrder'),
					('automation', 'automations', 'automationOrder')
			), flat AS (
				SELECT pair.key, pair.value FROM collection
				JOIN flat_keys USING (kind)
				CROSS JOIN LATERAL (
					VALUES (entries_key, entries), (order_key, ordering)
				) AS pair(key, value)
			), parent_order AS (
				SELECT parent.uuid, parent.kind, parent.ordinal,
					COALESCE((
						SELECT jsonb_agg(child.uuid ORDER BY child.ordinal, child.uuid)
						FROM entity AS child
						WHERE child.parent_uuid = parent.uuid
							AND child.kind = CASE WHEN parent.kind = 'module' THEN 'form' ELSE 'field' END
					), '[]'::jsonb) AS ordering
				FROM entity AS parent
				WHERE parent.kind IN ('module', 'form')
					OR (parent.kind = 'field' AND parent.data ->> 'kind' IN ('section', 'group', 'repeat'))
			)
			SELECT jsonb_build_object(
				'appId', app.id, 'appName', app.app_name,
				'caseTypes', app.case_types,
				'modules', COALESCE((SELECT entries FROM collection WHERE kind = 'module'), '{}'::jsonb),
				'forms', COALESCE((SELECT entries FROM collection WHERE kind = 'form'), '{}'::jsonb),
				'fields', COALESCE((SELECT entries FROM collection WHERE kind = 'field'), '{}'::jsonb),
				'moduleOrder', COALESCE((SELECT ordering FROM collection WHERE kind = 'module'), '[]'::jsonb),
				'formOrder', COALESCE((SELECT jsonb_object_agg(uuid, ordering ORDER BY ordinal, uuid)
					FROM parent_order WHERE kind = 'module'), '{}'::jsonb),
				'fieldOrder', COALESCE((SELECT jsonb_object_agg(uuid, ordering ORDER BY ordinal, uuid)
					FROM parent_order WHERE kind <> 'module'), '{}'::jsonb)
			)
			|| ${roles}
			|| COALESCE((SELECT jsonb_object_agg(key, value) FROM flat), '{}'::jsonb)
			|| CASE WHEN app.logo IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('logo', app.logo::text) END
			|| CASE WHEN app.localization IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('localization', app.localization) END
			|| CASE WHEN app.app_settings IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('appSettings', app.app_settings) END
			FROM public.apps AS app WHERE app.id = ${appId}`;
}

export async function readReleasedFoldSnapshot(
	db: Kysely<unknown>,
	appId: string,
) {
	const selection = foldSnapshotSelect(
		sql`${appId}`,
		sql`jsonb_build_object('connectType', app.connect_type)`,
	);
	const {
		rows: [row],
	} = await sql<{
		snapshot: string | null;
	}>`SELECT (${selection})::text AS snapshot`.execute(db);
	if (row?.snapshot == null)
		throw new Error("The released app no longer has a fold projection.");
	return row.snapshot;
}

export async function installConnectSnapshot(
	db: Kysely<unknown>,
	phase: "converting" | "complete",
) {
	const roles =
		phase === "converting"
			? sql`CASE WHEN app.connect_roles IS NULL THEN jsonb_build_object('connectType', app.connect_type)
			ELSE jsonb_build_object('connectRoles', to_jsonb(app.connect_roles)) END`
			: sql`jsonb_build_object('connectRoles', to_jsonb(app.connect_roles))`;
	await sql`
		CREATE OR REPLACE FUNCTION nova_current_app_change_fold_snapshot(text)
		RETURNS jsonb LANGUAGE sql STABLE STRICT PARALLEL UNSAFE
		SET search_path = pg_catalog
		AS $function$ ${foldSnapshotSelect(sql.raw("$1"), roles)} $function$
	`.execute(db);
}
