// The document's `appSettings` root, in its own column on `apps`, and the fold
// snapshot that projects it.
//
// The column is nullable because its DDL is applied while the image before the
// HQ round trip's cutover still serves: that image never writes it, and the
// cutover fills every row. A row left NULL fails the document's strict parse
// rather than reading as a default, and the snapshot leaves the root out for
// it, so the function's output for such a row is what it was before this
// migration.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE apps ADD COLUMN app_settings jsonb
			CHECK (app_settings IS NULL OR jsonb_typeof(app_settings) = 'object')
	`.execute(db);
	await sql`
		CREATE OR REPLACE FUNCTION nova_current_app_change_fold_snapshot(text)
		RETURNS jsonb LANGUAGE sql STABLE STRICT PARALLEL UNSAFE
		SET search_path = pg_catalog
		AS $function$
			WITH entity AS MATERIALIZED (
				SELECT row.uuid::text AS uuid, row.kind,
					row.parent_uuid::text AS parent_uuid, row.ordinal, row.data
				FROM public.blueprint_entities AS row WHERE row.app_id = $1
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
				'connectType', app.connect_type, 'caseTypes', app.case_types,
				'modules', COALESCE((SELECT entries FROM collection WHERE kind = 'module'), '{}'::jsonb),
				'forms', COALESCE((SELECT entries FROM collection WHERE kind = 'form'), '{}'::jsonb),
				'fields', COALESCE((SELECT entries FROM collection WHERE kind = 'field'), '{}'::jsonb),
				'moduleOrder', COALESCE((SELECT ordering FROM collection WHERE kind = 'module'), '[]'::jsonb),
				'formOrder', COALESCE((SELECT jsonb_object_agg(uuid, ordering ORDER BY ordinal, uuid)
					FROM parent_order WHERE kind = 'module'), '{}'::jsonb),
				'fieldOrder', COALESCE((SELECT jsonb_object_agg(uuid, ordering ORDER BY ordinal, uuid)
					FROM parent_order WHERE kind <> 'module'), '{}'::jsonb)
			)
			|| COALESCE((SELECT jsonb_object_agg(key, value) FROM flat), '{}'::jsonb)
			|| CASE WHEN app.logo IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('logo', app.logo::text) END
			|| CASE WHEN app.localization IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('localization', app.localization) END
			|| CASE WHEN app.app_settings IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('appSettings', app.app_settings) END
			FROM public.apps AS app WHERE app.id = $1
		$function$
	`.execute(db);
}
