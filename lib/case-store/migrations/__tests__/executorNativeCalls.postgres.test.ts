import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/case-store/migrations/20260814010000_executor_native_calls";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const h = setupAppStateTestDb("executor_native_calls_");

describe("native-call executor cleanup migration", () => {
	it("converges an installed pre-release Unit E database onto the clean schema", async () => {
		const db = h.db();
		const lineage = await h.seedDesignLineage();

		await sql`
			ALTER TABLE design_slice_attempts
				RENAME COLUMN mutation_calls_used TO staged_requests_used
		`.execute(db);
		await sql`
			ALTER TABLE design_slice_attempts
				RENAME COLUMN private_mutation_rejected_count TO stage_rejected_count
		`.execute(db);
		await sql`
			ALTER TABLE design_slice_attempts
				ADD COLUMN validation_requested boolean NOT NULL DEFAULT false,
				ADD COLUMN finalization_eligible boolean NOT NULL DEFAULT false
		`.execute(db);
		await sql`
			ALTER TABLE design_change_sets
				ADD COLUMN finalization_model_step integer
		`.execute(db);
		await sql`
			ALTER TABLE design_change_set_steps
				ADD COLUMN intent_ids jsonb NOT NULL DEFAULT '[]'::jsonb
		`.execute(db);
		await sql`
			ALTER TABLE design_committed_slices
				ADD COLUMN owning_intent_ids jsonb NOT NULL DEFAULT '[]'::jsonb
		`.execute(db);
		await sql`
			CREATE TABLE app_change_intents (
				id uuid PRIMARY KEY
			)
		`.execute(db);
		await sql`
			ALTER TABLE design_slice_attempt_budget_claims
				DROP CONSTRAINT design_slice_attempt_budget_claims_counter_check,
				ADD CONSTRAINT design_slice_attempt_budget_claims_counter_check
					CHECK (counter IN (
						'modelSteps', 'stagedRequests', 'commitAttempts', 'blockerReports'
					))
		`.execute(db);
		await sql`
			INSERT INTO design_slice_attempt_budget_claims (
				attempt_id, claim_key, counter
			) VALUES (
				${lineage.attemptId}::uuid, 'call:1', 'stagedRequests'
			)
		`.execute(db);

		await up(db as unknown as Kysely<unknown>);

		const columns = await sql<{ column_name: string }>`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = 'public'
				AND (
					(table_name = 'design_slice_attempts' AND column_name IN (
						'mutation_calls_used', 'private_mutation_rejected_count',
						'staged_requests_used', 'stage_rejected_count',
						'validation_requested', 'finalization_eligible'
					))
					OR (table_name = 'design_change_sets' AND column_name = 'finalization_model_step')
					OR (table_name = 'design_change_set_steps' AND column_name = 'intent_ids')
					OR (table_name = 'design_committed_slices' AND column_name = 'owning_intent_ids')
				)
		`.execute(db);
		expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
			"mutation_calls_used",
			"private_mutation_rejected_count",
		]);

		const retiredTable = await sql<{ exists: string | null }>`
			SELECT to_regclass('public.app_change_intents')::text AS exists
		`.execute(db);
		expect(retiredTable.rows[0]?.exists).toBeNull();

		const claim = await db
			.selectFrom("design_slice_attempt_budget_claims")
			.select("counter")
			.where("attempt_id", "=", lineage.attemptId)
			.executeTakeFirstOrThrow();
		expect(claim.counter).toBe("mutationCalls");

		await expect(
			sql`
				INSERT INTO design_slice_attempt_budget_claims (
					attempt_id, claim_key, counter
				) VALUES (
					${lineage.attemptId}::uuid, 'call:2', 'stagedRequests'
				)
			`.execute(db),
		).rejects.toThrow();
	});
});
