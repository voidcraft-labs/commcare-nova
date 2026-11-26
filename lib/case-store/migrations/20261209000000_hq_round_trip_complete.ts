import { type Kysely, sql } from "kysely";
import { installConnectSnapshot } from "./20261208000000_connect_activity_roles";

/** The empty database installs directly. A populated release must first
 * convert its historical heads and private work in this migration transaction. */
export async function up(db: Kysely<unknown>) {
	const {
		rows: [state],
	} = await sql<{ unfinished: boolean }>`
        SELECT EXISTS (
			SELECT 1 FROM public.apps AS app WHERE app.connect_roles IS NULL OR NOT EXISTS (
				SELECT 1 FROM public.app_changes AS change
				JOIN public.app_change_fold_baselines AS baseline
					ON baseline.app_id = change.app_id AND baseline.seq = change.seq
					AND baseline.project_id = app.project_id
				WHERE change.app_id = app.id AND change.seq = app.mutation_seq
					AND change.kind = 'fold-baseline'
					AND change.batch_id = 'fold-baseline:hq-round-trip-completion'
					AND change.actor_id = 'system:hq-round-trip-completion'
			)
		  )
          OR EXISTS (
            SELECT 1 FROM public.authoring_workspaces AS work
            WHERE work.status = 'open' AND NOT EXISTS (
                SELECT 1 FROM public.authoring_workspace_folds AS saved
                WHERE saved.change_set_id = work.id)
          ) AS unfinished
    `.execute(db);
	if (state.unfinished)
		throw new Error(
			"Saved apps or open private work still need the reviewed HQ round-trip conversion.",
		);
	// An ordinary empty installation needs no fleet receipt. The explicit
	// operator records its exact reviewed plan in this same DDL transaction.
	await sql`CREATE TABLE public.hq_round_trip_completion_receipt (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
        source_provenance text NOT NULL CHECK (source_provenance ~ '^[a-f0-9]{64}$')
    )`.execute(db);
	await installConnectSnapshot(db, "complete");
	await sql`ALTER TABLE public.apps
        ALTER COLUMN connect_roles SET DEFAULT ARRAY[]::text[],
        ALTER COLUMN connect_roles SET NOT NULL,
        DROP COLUMN connect_type`.execute(db);
}
