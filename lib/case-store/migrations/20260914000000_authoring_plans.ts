import { type Kysely, sql } from "kysely";

/** Private plan content has one revision history; it never becomes app state. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE authoring_plans (
			session_id uuid PRIMARY KEY REFERENCES design_sessions(id) ON DELETE CASCADE,
			revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
			review_id uuid,
			review_complete boolean NOT NULL DEFAULT false,
			reviewed_revision bigint CHECK (reviewed_revision >= 1 AND reviewed_revision <= revision),
			CHECK (NOT review_complete OR review_id IS NOT NULL)
		);
		CREATE TABLE authoring_plan_revisions (
			session_id uuid NOT NULL REFERENCES authoring_plans(session_id) ON DELETE CASCADE,
			revision bigint NOT NULL CHECK (revision >= 1),
			markdown text NOT NULL CHECK (length(btrim(markdown)) > 0 AND length(markdown) <= 200000),
			editor text NOT NULL CHECK (editor IN ('architect', 'peer')),
			run_id text NOT NULL,
			request_id text NOT NULL,
			request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (session_id, revision),
			UNIQUE (session_id, request_id)
		);
		CREATE TABLE authoring_reviews (
			id uuid PRIMARY KEY,
			session_id uuid NOT NULL REFERENCES authoring_plans(session_id) ON DELETE CASCADE,
			request_id text NOT NULL,
			plan_revision bigint NOT NULL,
			source_digest text,
			app_seq bigint CHECK (app_seq >= 1),
			context_id uuid REFERENCES design_model_contexts(id),
			summary text,
			completed_revision bigint,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			UNIQUE (session_id, request_id),
			FOREIGN KEY (session_id, plan_revision) REFERENCES authoring_plan_revisions(session_id, revision),
			FOREIGN KEY (session_id, completed_revision) REFERENCES authoring_plan_revisions(session_id, revision)
		);
	`.execute(db);
}
