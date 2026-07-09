// App-state tables — the Firestore→Postgres cutover's base schema.
//
// Everything `lib/db` persists lives here: the `apps` row (metadata + run
// lease + credit-reservation marker as plain columns — no blueprint blob),
// the blueprint's entity rows (one row per module/form/field, `data` jsonb),
// the PERMANENT `accepted_mutations` batch log (the multiplayer stream AND
// the durable edit history — no TTL, no prune; `UNIQUE (app_id, batch_id)`
// is the idempotency latch that used to be the `batchDedup` subcollection),
// the event log, chat threads, per-run summaries, live presence, media-asset
// metadata (+ the `media_asset_refs` join table that replaces the append-only
// `referencingAppIds` array), and the two per-user monthly ledgers.
//
// Design invariants the DDL encodes:
//  - An app's current state is `apps` + its `blueprint_entities`; the
//    membership arrays round-trip byte-identically via the stored `ordinal`
//    (DISPLAY sequence stays derived from the entities' fractional `order`
//    keys inside `data`, as ever).
//  - Every timestamptz is `(3)` — millisecond precision — so a stored value
//    (including a `DEFAULT now()`) round-trips exactly through a JS `Date`;
//    the list/library cursors compare `(timestamp, id)` tuples and a sub-ms
//    residue would let boundary rows slip between pages.
//  - The reservation marker is "present" iff `res_period IS NOT NULL`; the
//    edit lock iff `lock_run_id IS NOT NULL` — the same optional-map
//    semantics the Firestore doc had, as nullable column groups.
//  - `accepted_mutations` is append-only and permanent: fold(all batches from
//    seq 1) reproduces the entity rows for any app whose full history is
//    retained (apps migrated from Firestore start at their cutover snapshot).
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS apps (
			id text PRIMARY KEY,
			owner text NOT NULL,
			project_id text,
			app_name text NOT NULL,
			app_name_lower text NOT NULL,
			connect_type text,
			case_types jsonb,
			logo text,
			module_count integer NOT NULL DEFAULT 0,
			form_count integer NOT NULL DEFAULT 0,
			mutation_seq bigint NOT NULL DEFAULT 0,
			status text NOT NULL DEFAULT 'complete',
			awaiting_input boolean NOT NULL DEFAULT false,
			error_type text,
			deleted_at timestamptz(3),
			recoverable_until timestamptz(3),
			run_id text,
			res_period text,
			res_reserved integer,
			res_settled boolean,
			res_user_id text,
			res_run_id text,
			lock_run_id text,
			lock_actor_user_id text,
			lock_expire_at timestamptz(3),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);
	// The live listing matrix: project- and owner-scoped, updated/name sorts,
	// all partial on live rows (deleted_at IS NULL). Status filters ride these
	// as row filters — app counts are small and status is low-cardinality.
	await sql`CREATE INDEX IF NOT EXISTS apps_project_live_updated ON apps (project_id, updated_at DESC, id) WHERE deleted_at IS NULL`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS apps_project_live_name ON apps (project_id, app_name_lower, id) WHERE deleted_at IS NULL`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS apps_owner_live_updated ON apps (owner, updated_at DESC, id) WHERE deleted_at IS NULL`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS apps_owner_live_name ON apps (owner, app_name_lower, id) WHERE deleted_at IS NULL`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS apps_project_deleted ON apps (project_id, deleted_at DESC, id) WHERE deleted_at IS NOT NULL`.execute(
		db,
	);
	// The concurrency guard's actor scan (`hasActiveGeneration`): live
	// `generating` rows by owner or by the reservation's charged actor.
	await sql`CREATE INDEX IF NOT EXISTS apps_generating_owner ON apps (owner) WHERE deleted_at IS NULL AND status = 'generating'`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS apps_generating_actor ON apps (res_user_id) WHERE deleted_at IS NULL AND status = 'generating'`.execute(
		db,
	);

	await sql`
		CREATE TABLE IF NOT EXISTS blueprint_entities (
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			uuid text NOT NULL,
			kind text NOT NULL CHECK (kind IN ('module', 'form', 'field')),
			parent_uuid text,
			ordinal integer NOT NULL DEFAULT 0,
			data jsonb NOT NULL,
			PRIMARY KEY (app_id, uuid)
		)
	`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS blueprint_entities_kind ON blueprint_entities (app_id, kind)`.execute(
		db,
	);

	await sql`
		CREATE TABLE IF NOT EXISTS accepted_mutations (
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			seq bigint NOT NULL,
			batch_id text NOT NULL,
			run_id text,
			actor_id text NOT NULL,
			kind text NOT NULL,
			mutations jsonb NOT NULL,
			ts timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (app_id, seq),
			UNIQUE (app_id, batch_id)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS events (
			id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			app_id text NOT NULL,
			run_id text NOT NULL,
			ts bigint NOT NULL,
			seq integer NOT NULL,
			source text NOT NULL,
			kind text NOT NULL,
			event jsonb NOT NULL
		)
	`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS events_run ON events (app_id, run_id, ts, seq)`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS events_latest ON events (app_id, ts DESC)`.execute(
		db,
	);

	await sql`
		CREATE TABLE IF NOT EXISTS threads (
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			thread_id text NOT NULL,
			created_at text NOT NULL,
			thread_type text NOT NULL,
			summary text NOT NULL,
			run_id text NOT NULL,
			messages jsonb NOT NULL,
			PRIMARY KEY (app_id, thread_id)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS run_summaries (
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			run_id text NOT NULL,
			started_at text NOT NULL,
			finished_at text NOT NULL,
			prompt_mode text NOT NULL,
			fresh_edit boolean NOT NULL,
			app_ready boolean NOT NULL,
			cache_expired boolean NOT NULL,
			module_count integer NOT NULL,
			step_count integer NOT NULL,
			model text NOT NULL,
			input_tokens bigint NOT NULL,
			output_tokens bigint NOT NULL,
			cache_read_tokens bigint NOT NULL,
			cache_write_tokens bigint NOT NULL,
			cost_estimate double precision NOT NULL,
			tool_call_count integer NOT NULL,
			PRIMARY KEY (app_id, run_id)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS presence (
			app_id text NOT NULL,
			user_id text NOT NULL,
			session_id text NOT NULL,
			name text NOT NULL,
			image text,
			email text NOT NULL DEFAULT '',
			color text NOT NULL,
			location jsonb NOT NULL,
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			expire_at timestamptz(3) NOT NULL,
			PRIMARY KEY (app_id, user_id, session_id)
		)
	`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS presence_expire ON presence (expire_at)`.execute(
		db,
	);

	await sql`
		CREATE TABLE IF NOT EXISTS user_settings (
			user_id text PRIMARY KEY,
			commcare_username text NOT NULL,
			commcare_api_key text NOT NULL,
			commcare_server text,
			approved_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
			updated_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS usage_months (
			user_id text NOT NULL,
			period text NOT NULL,
			input_tokens bigint NOT NULL DEFAULT 0,
			output_tokens bigint NOT NULL DEFAULT 0,
			cost_estimate double precision NOT NULL DEFAULT 0,
			request_count integer NOT NULL DEFAULT 0,
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (user_id, period)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS credit_months (
			user_id text NOT NULL,
			period text NOT NULL,
			allowance integer NOT NULL,
			consumed integer NOT NULL DEFAULT 0,
			bonus integer NOT NULL DEFAULT 0,
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (user_id, period),
			CHECK (allowance >= 0 AND consumed >= 0 AND bonus >= 0)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS credit_grants (
			id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			user_id text NOT NULL,
			amount integer NOT NULL CHECK (amount >= 0),
			type text NOT NULL CHECK (type IN ('reset', 'grant')),
			actor text NOT NULL,
			actor_email text NOT NULL,
			reason text,
			period text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS credit_grants_user ON credit_grants (user_id, created_at DESC)`.execute(
		db,
	);

	await sql`
		CREATE TABLE IF NOT EXISTS media_assets (
			id text PRIMARY KEY,
			project_id text NOT NULL,
			owner text NOT NULL,
			content_hash text NOT NULL,
			mime_type text NOT NULL,
			extension text NOT NULL,
			size_bytes bigint NOT NULL,
			dimensions jsonb,
			duration_ms bigint,
			kind text NOT NULL,
			gcs_object_key text NOT NULL,
			original_filename text NOT NULL,
			display_name text,
			status text NOT NULL,
			extract jsonb,
			created_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);
	await sql`CREATE INDEX IF NOT EXISTS media_assets_dedup ON media_assets (project_id, content_hash) WHERE status = 'ready'`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS media_assets_library ON media_assets (project_id, status, created_at DESC, id DESC)`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS media_assets_library_kind ON media_assets (project_id, status, kind, created_at DESC, id DESC)`.execute(
		db,
	);
	await sql`CREATE INDEX IF NOT EXISTS media_assets_gcs_key ON media_assets (gcs_object_key)`.execute(
		db,
	);

	await sql`
		CREATE TABLE IF NOT EXISTS media_asset_refs (
			asset_id text NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
			app_id text NOT NULL,
			PRIMARY KEY (asset_id, app_id)
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const table of [
		"media_asset_refs",
		"media_assets",
		"credit_grants",
		"credit_months",
		"usage_months",
		"user_settings",
		"presence",
		"run_summaries",
		"threads",
		"events",
		"accepted_mutations",
		"blueprint_entities",
		"apps",
	]) {
		await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
	}
}
