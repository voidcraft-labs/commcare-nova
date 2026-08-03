// Blueprint-owned organization shape plus the app-scoped locations store.

import { type Kysely, sql } from "kysely";

const KINDS =
	"'module', 'form', 'field', 'user_property', 'user_type', 'persona', " +
	"'organization_level', 'location_property'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.blueprint_entities
			DROP CONSTRAINT IF EXISTS blueprint_entities_kind_check
	`.execute(db);
	await sql`
		ALTER TABLE public.blueprint_entities
			ADD CONSTRAINT blueprint_entities_kind_check
				CHECK (kind IN (${sql.raw(KINDS)}))
	`.execute(db);

	await sql`
		CREATE TABLE app_organization_state (
			app_id text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
			revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
			location_count integer NOT NULL DEFAULT 0 CHECK (location_count >= 0),
			updated_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);

	await sql`
		CREATE TABLE app_locations (
			id uuid NOT NULL DEFAULT uuidv7(),
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			level_uuid uuid NOT NULL,
			parent_id uuid,
			site_code text NOT NULL,
			name text NOT NULL,
			external_id text,
			latitude numeric(20, 10),
			longitude numeric(20, 10),
			"values" jsonb NOT NULL DEFAULT '{}'::jsonb,
			archived_at timestamptz(3),
			order_key text COLLATE "C" NOT NULL
				CHECK (
					order_key ~ '^[0-9A-Za-z]+$'
					AND right(order_key, 1) <> '0'
					AND char_length(order_key) <= 256
				),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			created_by text,
			updated_by text,
			PRIMARY KEY (app_id, id),
			FOREIGN KEY (app_id, parent_id)
				REFERENCES app_locations(app_id, id) ON DELETE RESTRICT,
			UNIQUE (app_id, site_code)
		)
	`.execute(db);
	await sql`CREATE INDEX app_locations_app_level ON app_locations (app_id, level_uuid)`.execute(
		db,
	);
	await sql`CREATE INDEX app_locations_app_parent ON app_locations (app_id, parent_id)`.execute(
		db,
	);
	await sql`CREATE INDEX app_locations_app_live ON app_locations (app_id, order_key, id) WHERE archived_at IS NULL`.execute(
		db,
	);

	await sql`
		CREATE TABLE app_location_references (
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			location_id uuid NOT NULL,
			PRIMARY KEY (app_id, location_id),
			FOREIGN KEY (app_id, location_id)
				REFERENCES app_locations(app_id, id) ON DELETE RESTRICT
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE app_location_references`.execute(db);
	await sql`DROP TABLE app_locations`.execute(db);
	await sql`DROP TABLE app_organization_state`.execute(db);
	await sql`
		DELETE FROM public.blueprint_entities
			WHERE kind IN ('organization_level', 'location_property')
	`.execute(db);
	await sql`
		ALTER TABLE public.blueprint_entities
			DROP CONSTRAINT IF EXISTS blueprint_entities_kind_check
	`.execute(db);
	await sql`
		ALTER TABLE public.blueprint_entities
			ADD CONSTRAINT blueprint_entities_kind_check
				CHECK (kind IN ('module', 'form', 'field', 'user_property', 'user_type', 'persona'))
	`.execute(db);
}
