import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/case-store/migrations/20260811000000_executor_attempt_recovery";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const h = setupAppStateTestDb("executor_attempt_recovery_");

describe("executor attempt recovery migration", () => {
	it("converges an already-installed handle CHECK and adds durable counters", async () => {
		const db = h.db();
		const lineage = await h.seedDesignLineage();
		await sql`
			ALTER TABLE design_slice_attempts
				DROP COLUMN outcome_evidence_state,
				DROP COLUMN validator_repair_count,
				DROP COLUMN private_mutation_rejected_count,
				DROP COLUMN wire_invalid_count,
				DROP COLUMN execution_run_ids,
				DROP COLUMN blocker_reports_used,
				DROP COLUMN commit_attempts_used,
				DROP COLUMN mutation_calls_used,
				DROP COLUMN model_steps_used
		`.execute(db);
		await sql`
			ALTER TABLE design_change_set_requests
				DROP CONSTRAINT design_change_set_requests_status_check,
				ADD CONSTRAINT design_change_set_requests_status_check
					CHECK (status IN ('staged', 'rejected'))
		`.execute(db);
		await sql`
			ALTER TABLE design_change_set_handles
				DROP CONSTRAINT design_change_set_handles_entity_kind_check,
				ADD CONSTRAINT design_change_set_handles_entity_kind_check
					CHECK (entity_kind IN (
						'module', 'form', 'field', 'option', 'case_list_column',
						'search_input', 'case_operation'
					))
		`.execute(db);

		await up(db as unknown as Kysely<unknown>);

		const constraint = await sql<{ definition: string }>`
			SELECT pg_get_constraintdef(oid) AS definition
			FROM pg_constraint
			WHERE conname = 'design_change_set_handles_entity_kind_check'
				AND conrelid = 'design_change_set_handles'::regclass
		`.execute(db);
		expect(constraint.rows[0]?.definition).toContain("worker_property");
		expect(constraint.rows[0]?.definition).toContain(
			"automation_user_data_filter",
		);

		const counters = await sql<{ column_name: string }>`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = 'public'
				AND table_name = 'design_slice_attempts'
				AND column_name IN (
					'model_steps_used', 'mutation_calls_used',
					'commit_attempts_used', 'blocker_reports_used',
					'execution_run_ids', 'wire_invalid_count',
					'private_mutation_rejected_count', 'validator_repair_count',
					'outcome_evidence_state'
				)
		`.execute(db);
		expect(counters.rows.map((row) => row.column_name).sort()).toEqual([
			"blocker_reports_used",
			"commit_attempts_used",
			"execution_run_ids",
			"model_steps_used",
			"mutation_calls_used",
			"outcome_evidence_state",
			"private_mutation_rejected_count",
			"validator_repair_count",
			"wire_invalid_count",
		]);
		const migrated = await db
			.selectFrom("design_slice_attempts")
			.select([
				"model_steps_used",
				"mutation_calls_used",
				"commit_attempts_used",
				"blocker_reports_used",
				"execution_run_ids",
				"wire_invalid_count",
				"private_mutation_rejected_count",
				"validator_repair_count",
				"outcome_evidence_state",
			])
			.where("id", "=", lineage.attemptId)
			.executeTakeFirstOrThrow();
		expect(migrated).toEqual({
			model_steps_used: 0,
			mutation_calls_used: 0,
			commit_attempts_used: 0,
			blocker_reports_used: 0,
			execution_run_ids: [],
			wire_invalid_count: 0,
			private_mutation_rejected_count: 0,
			validator_repair_count: 0,
			outcome_evidence_state: "legacy-missing",
		});
		const requestStatus = await sql<{ definition: string }>`
			SELECT pg_get_constraintdef(oid) AS definition
			FROM pg_constraint
			WHERE conname = 'design_change_set_requests_status_check'
				AND conrelid = 'design_change_set_requests'::regclass
		`.execute(db);
		expect(requestStatus.rows[0]?.definition).toContain("noop");
	});
});
