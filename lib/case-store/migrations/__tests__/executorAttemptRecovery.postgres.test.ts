import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/case-store/migrations/20260811000000_executor_attempt_recovery";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

import { checkConstraintVerdicts } from "./checkConstraint";

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

		expect(
			await checkConstraintVerdicts(
				db as unknown as Kysely<unknown>,
				"design_change_set_handles",
				"design_change_set_handles_entity_kind_check",
				"entity_kind",
				[
					"module",
					"worker_property",
					"automation_user_data_filter",
					"unknown_kind",
				],
			),
		).toEqual([
			{ value: "module", admitted: true },
			{ value: "worker_property", admitted: true },
			{ value: "automation_user_data_filter", admitted: true },
			{ value: "unknown_kind", admitted: false },
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
		expect(
			await checkConstraintVerdicts(
				db as unknown as Kysely<unknown>,
				"design_change_set_requests",
				"design_change_set_requests_status_check",
				"status",
				["staged", "noop", "rejected", "unknown_status"],
			),
		).toEqual([
			{ value: "staged", admitted: true },
			{ value: "noop", admitted: true },
			{ value: "rejected", admitted: true },
			{ value: "unknown_status", admitted: false },
		]);
		for (const column of [
			"model_steps_used",
			"mutation_calls_used",
			"commit_attempts_used",
			"blocker_reports_used",
			"wire_invalid_count",
			"private_mutation_rejected_count",
			"validator_repair_count",
		]) {
			await expect(
				sql`UPDATE design_slice_attempts SET ${sql.id(column)} = -1
    WHERE id = ${lineage.attemptId}::uuid`.execute(db),
			).rejects.toMatchObject({
				code: "23514",
				constraint: `design_slice_attempts_${column}_check`,
			});
		}
	});
});
