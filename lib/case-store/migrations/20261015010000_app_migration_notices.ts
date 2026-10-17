// What a stored-shape cutover changed in one app, told to its members once.
//
// `app_migration_notices` holds one row per app and cutover, its `entries` the
// lines the cutover wrote for that app. `UNIQUE (app_id, cutover)` is the
// writer's idempotency latch. A notice has no `project_id`: it reaches the
// tenant through `apps.project_id` at read time, so a Project move updates
// nothing here and nothing here references `apps.project_id` (the rule
// `20260806000000_deployments.ts` states in its header).
//
// `app_migration_notice_key_readers` holds one row per member, server and
// project space whose stored CommCare HQ key a cutover's execute run sent. It
// is keyed by the cutover and not by a notice, because a key is used per
// project space: every key the run sent has a row whether or not any app has
// an entry, and no row joins to an app the person may no longer reach. The
// span runs from that run's first send of the key to its last.
//
// `app_migration_notice_dismissals` records one member's dismissal of one
// notice (`surface = 'app'`) or of one cutover's home line
// (`surface = 'key-reader'`), so dismissing either leaves the other showing.
//
// Only a migration writes a notice or a key-readers row, as the migration
// role; the runtime role reads both and appends dismissals
// (`lib/db/privilegeConvergence.ts`). Rows have no expiry and go with their
// app.

import { type Kysely, sql } from "kysely";

const SERVERS = "'production', 'india', 'eu'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS app_migration_notices (
			id uuid PRIMARY KEY DEFAULT uuidv7(),
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			cutover text NOT NULL CHECK (btrim(cutover) <> ''),
			entries jsonb NOT NULL
				CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) > 0),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT app_migration_notices_once UNIQUE (app_id, cutover)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS app_migration_notice_key_readers (
			cutover text NOT NULL CHECK (btrim(cutover) <> ''),
			user_id text NOT NULL CHECK (btrim(user_id) <> ''),
			server text NOT NULL CHECK (server IN (${sql.raw(SERVERS)})),
			domain text NOT NULL CHECK (btrim(domain) <> ''),
			first_used_at timestamptz(3) NOT NULL,
			last_used_at timestamptz(3) NOT NULL CHECK (last_used_at >= first_used_at),
			PRIMARY KEY (cutover, user_id, server, domain)
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS app_migration_notice_key_readers_user
			ON app_migration_notice_key_readers (user_id)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS app_migration_notice_dismissals (
			id uuid PRIMARY KEY DEFAULT uuidv7(),
			user_id text NOT NULL CHECK (btrim(user_id) <> ''),
			surface text NOT NULL CHECK (surface IN ('app', 'key-reader')),
			notice_id uuid REFERENCES app_migration_notices(id) ON DELETE CASCADE,
			cutover text,
			dismissed_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT app_migration_notice_dismissals_subject CHECK (
				(surface = 'app') = (notice_id IS NOT NULL)
				AND (surface = 'key-reader') = (cutover IS NOT NULL))
		)
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS app_migration_notice_dismissals_app
			ON app_migration_notice_dismissals (notice_id, user_id)
			WHERE surface = 'app'
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS app_migration_notice_dismissals_key_reader
			ON app_migration_notice_dismissals (cutover, user_id)
			WHERE surface = 'key-reader'
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS app_migration_notice_dismissals`.execute(db);
	await sql`DROP TABLE IF EXISTS app_migration_notice_key_readers`.execute(db);
	await sql`DROP TABLE IF EXISTS app_migration_notices`.execute(db);
}
