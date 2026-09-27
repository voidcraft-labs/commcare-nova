import { type Kysely, sql } from "kysely";

/** Ordinary authoring uses its own authority; reviewed builds retain theirs. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE TABLE authoring_sessions (
  id uuid PRIMARY KEY,
  actor_user_id text NOT NULL,
  project_id text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('chat','mcp')),
  thread_id text REFERENCES threads(thread_id) ON DELETE CASCADE,
  app_id text REFERENCES apps(id) ON DELETE CASCADE,
  proposed_app_id text,
  app_name text NOT NULL,
  active_candidate_id uuid,
  begin_request_id text NOT NULL CHECK (btrim(begin_request_id) <> ''),
  begin_input_digest text NOT NULL CHECK (begin_input_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK ((origin = 'chat') = (thread_id IS NOT NULL)),
  CHECK (app_id IS NOT NULL OR proposed_app_id IS NOT NULL),
  UNIQUE(actor_user_id,origin,begin_request_id)
 )`.execute(db);
	await sql`CREATE UNIQUE INDEX authoring_sessions_chat_thread ON authoring_sessions(actor_user_id,thread_id) WHERE origin='chat'`.execute(
		db,
	);
	await sql`ALTER TABLE authoring_workspaces
 ADD COLUMN authoring_session_id uuid REFERENCES authoring_sessions(id) ON DELETE CASCADE,
 ALTER COLUMN design_session_id DROP NOT NULL,
 ALTER COLUMN plan_revision DROP NOT NULL,
 ALTER COLUMN owner_run_id DROP NOT NULL,
 ADD CONSTRAINT authoring_workspaces_authority CHECK (
  (authoring_session_id IS NULL AND design_session_id IS NOT NULL AND plan_revision IS NOT NULL AND owner_run_id IS NOT NULL)
  OR (authoring_session_id IS NOT NULL AND design_session_id IS NULL AND plan_revision IS NULL AND owner_run_id IS NULL)
 )`.execute(db);
	await sql`CREATE UNIQUE INDEX authoring_workspaces_open_authoring_session ON authoring_workspaces(authoring_session_id) WHERE status='open' AND authoring_session_id IS NOT NULL`.execute(
		db,
	);
	await sql`ALTER TABLE authoring_sessions ADD CONSTRAINT authoring_sessions_candidate_fk FOREIGN KEY(active_candidate_id) REFERENCES authoring_workspaces(id)`.execute(
		db,
	);
	await sql`ALTER TABLE authoring_checkpoints
 ADD COLUMN migration_report jsonb,
 ADD COLUMN authoring_session_id uuid REFERENCES authoring_sessions(id) ON DELETE CASCADE,
 ALTER COLUMN design_session_id DROP NOT NULL,
 ALTER COLUMN plan_revision DROP NOT NULL,
 ADD CONSTRAINT authoring_checkpoints_authority CHECK (
  (authoring_session_id IS NULL AND design_session_id IS NOT NULL AND plan_revision IS NOT NULL)
  OR (authoring_session_id IS NOT NULL AND design_session_id IS NULL AND plan_revision IS NULL)
 )`.execute(db);
	await sql`CREATE UNIQUE INDEX authoring_checkpoints_session_request ON authoring_checkpoints(authoring_session_id,request_id) WHERE authoring_session_id IS NOT NULL`.execute(
		db,
	);
	await sql`CREATE TABLE authoring_session_requests (
  ordinary_session_id uuid REFERENCES authoring_sessions(id) ON DELETE CASCADE,
  design_session_id uuid REFERENCES design_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (btrim(request_id) <> ''),
  operation text NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  candidate_id uuid REFERENCES authoring_workspaces(id),
  result_json jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK ((ordinary_session_id IS NULL) <> (design_session_id IS NULL))
 )`.execute(db);
	await sql`CREATE UNIQUE INDEX authoring_session_requests_ordinary ON authoring_session_requests(ordinary_session_id,request_id) WHERE ordinary_session_id IS NOT NULL`.execute(
		db,
	);
	await sql`CREATE UNIQUE INDEX authoring_session_requests_design ON authoring_session_requests(design_session_id,request_id) WHERE design_session_id IS NOT NULL`.execute(
		db,
	);
	// Keep the existing retirement marker admissible while the previous Cloud
	// Run revision serves during migration/build. Current readers normalize it
	// to ordinary work; new writers only mark property renames exclusive.
}
