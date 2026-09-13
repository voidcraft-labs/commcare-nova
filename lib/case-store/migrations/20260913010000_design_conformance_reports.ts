import { type Kysely, sql } from "kysely";

/** Reports are immutable observations. Tenancy follows the app/session;
 * no copied Project field can become stale after a Project move. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE design_conformance_reports (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
			design_revision_id uuid NOT NULL REFERENCES design_revisions(id),
			build_plan_id uuid NOT NULL REFERENCES design_build_plans(id),
			app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			app_seq bigint NOT NULL CHECK (app_seq >= 1),
			snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
			assessment_digest text NOT NULL CHECK (assessment_digest ~ '^[a-f0-9]{64}$'),
			artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			UNIQUE (design_session_id, build_plan_id, app_id, app_seq, assessment_digest)
		);
		CREATE INDEX design_conformance_reports_app ON design_conformance_reports(app_id, app_seq DESC, created_at DESC);
	`.execute(db);
}
