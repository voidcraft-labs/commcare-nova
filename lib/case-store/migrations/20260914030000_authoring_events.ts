import { type Kysely, sql } from "kysely";

const SHA256_HEX = "'^[a-f0-9]{64}$'";
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS authoring_events (
			design_session_id uuid NOT NULL
				REFERENCES design_sessions(id) ON DELETE CASCADE,
			revision bigint NOT NULL CHECK (revision >= 1),
			event_id uuid NOT NULL,
			predecessor_event_id uuid,
			predecessor_digest text
				CHECK (predecessor_digest IS NULL OR predecessor_digest ~ ${sql.raw(SHA256_HEX)}),
			run_id text NOT NULL CHECK (btrim(run_id) <> ''),
			holder_nonce_digest text NOT NULL
				CHECK (holder_nonce_digest ~ ${sql.raw(SHA256_HEX)}),
			kind text NOT NULL CHECK (btrim(kind) <> ''),
			payload jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (design_session_id, revision),
			CONSTRAINT authoring_events_event_unique
				UNIQUE (design_session_id, event_id),
			-- The chain's shape: exactly the first event has no predecessor,
			-- and a predecessor id always travels with its digest.
			CONSTRAINT authoring_events_first_has_no_predecessor CHECK (
				(revision = 1) = (predecessor_event_id IS NULL)
			),
			CONSTRAINT authoring_events_predecessor_pair CHECK (
				(predecessor_event_id IS NULL) = (predecessor_digest IS NULL)
			)
		)
	`.execute(db);
	// Two continuations cannot advance the same state: the second insert
	// naming an already-consumed predecessor violates this index.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS authoring_events_predecessor
			ON authoring_events (design_session_id, predecessor_event_id)
			WHERE predecessor_event_id IS NOT NULL
	`.execute(db);
}
