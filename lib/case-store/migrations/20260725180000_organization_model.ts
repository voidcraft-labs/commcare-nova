// The organization: its SHAPE in the blueprint, its CONTENTS in rows.
//
// `blueprint_entities` gains two flat collections — the organization
// levels and the location-property catalog — which are ordinary blueprint
// entities with no parent and no membership array, so the only change
// they need is a wider kind constraint.
//
// The places themselves are not blueprint entities. A location tree runs
// to thousands of nodes and is routinely maintained from outside Nova, so
// it lives in `app_locations`: app-scoped, authorized through the app
// row, and therefore carried along by a cross-Project move without any
// re-tenanting of its own. `app_organization_state` is its commit-ordered
// revision clock, the app-scoped twin of `lookup_project_state`.
//
// `app_location_references` is the exact edge set naming the location
// rows an app's blueprint points at — today a persona's assignment, later
// any authored location term. Its composite foreign key is what makes a
// referenced place undeletable, proved by the database rather than by a
// scan that races the next commit.

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

	// One row per app, created on first organization write. It carries the
	// commit-ordered revision every reader catches up from, exactly as
	// `lookup_project_state` does for a Project — the difference is only the
	// scope, because an organization belongs to one app while lookup tables
	// are shared across a Project's apps.
	await sql`
		CREATE TABLE IF NOT EXISTS app_organization_state (
			app_id text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
			revision bigint NOT NULL DEFAULT 0,
			location_count integer NOT NULL DEFAULT 0,
			updated_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS app_locations (
			id uuid NOT NULL DEFAULT uuidv7(),
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			-- The blueprint level this place stands at. Deliberately NOT a
			-- foreign key into blueprint_entities: the commit rewrites those
			-- rows from its own diff, so a RESTRICT edge would fire on ordinary
			-- unrelated edits. "No place still stands at a removed level" is
			-- proved inside the commit transaction instead, where it can also
			-- still be true by the time it is acted on.
			level_uuid text NOT NULL,
			parent_id uuid,
			-- Domain-unique on HQ (SQLLocation.Meta.unique_together is
			-- ('domain', 'site_code')), so app-unique here: one Nova app
			-- compiles to one domain's tree.
			site_code text NOT NULL,
			name text NOT NULL,
			external_id text,
			latitude numeric,
			longitude numeric,
			-- Custom-field values keyed by location-property UUID, never by
			-- slug, so renaming a slug rewrites nothing. HQ stores the same
			-- thing as a plain metadata blob beside its definitions.
			"values" jsonb NOT NULL DEFAULT '{}'::jsonb,
			archived_at timestamptz(3),
			order_key text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			created_by text,
			updated_by text,
			PRIMARY KEY (app_id, id),
			-- RESTRICT rather than CASCADE: archiving a subtree is the
			-- supported gesture and it is reversible, so a delete that silently
			-- took descendants with it would be the one destructive path with
			-- no confirmation behind it.
			FOREIGN KEY (app_id, parent_id)
				REFERENCES app_locations(app_id, id) ON DELETE RESTRICT,
			UNIQUE (app_id, site_code)
		)
	`.execute(db);
	// A bare id lookup has to stay cheap even though the primary key leads
	// with app_id; every read still carries its app_id, but the reference
	// table's foreign key needs the composite key above rather than this.
	await sql`CREATE INDEX IF NOT EXISTS app_locations_app_level ON app_locations (app_id, level_uuid)`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS app_locations_app_parent ON app_locations (app_id, parent_id)`.execute(
		db,
	);
	// The tree walk that answers "which places are live" skips archived rows,
	// which are a minority but grow without bound.
	await sql`CREATE INDEX IF NOT EXISTS app_locations_app_live ON app_locations (app_id, order_key, id) WHERE archived_at IS NULL`.execute(
		db,
	);

	await sql`
		CREATE TABLE IF NOT EXISTS app_location_references (
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			location_id uuid NOT NULL,
			PRIMARY KEY (app_id, location_id),
			-- The whole point of the table. A place a persona stands on cannot
			-- be deleted while the reference exists, and the proof is the
			-- database's rather than a scan's — a scan races the very commit
			-- that would introduce the reference.
			FOREIGN KEY (app_id, location_id)
				REFERENCES app_locations(app_id, id) ON DELETE RESTRICT
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS app_location_references`.execute(db);
	await sql`DROP TABLE IF EXISTS app_locations`.execute(db);
	await sql`DROP TABLE IF EXISTS app_organization_state`.execute(db);
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
