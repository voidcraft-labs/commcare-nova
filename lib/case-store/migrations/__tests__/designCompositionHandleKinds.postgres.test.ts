import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/case-store/migrations/20260814000000_design_composition_handle_kinds";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const h = setupAppStateTestDb("design_composition_handle_kinds_");

describe("design composition handle kinds migration", () => {
	it("adds every identity-bearing composition kind to the durable ledger", async () => {
		const db = h.db();
		await sql`
			ALTER TABLE design_identity_handles
				DROP CONSTRAINT design_identity_handles_entity_kind_check,
				ADD CONSTRAINT design_identity_handles_entity_kind_check
					CHECK (entity_kind IN (
						'contract', 'actor', 'record', 'property', 'workflow', 'list',
						'access', 'navigation', 'external_requirement', 'decision',
						'assumption', 'open_question', 'referenced'
					))
		`.execute(db);

		await up(db as unknown as Kysely<unknown>);

		const constraint = await sql<{ definition: string }>`
			SELECT pg_get_constraintdef(oid) AS definition
			FROM pg_constraint
			WHERE conname = 'design_identity_handles_entity_kind_check'
				AND conrelid = 'design_identity_handles'::regclass
		`.execute(db);
		for (const kind of [
			"module_composition",
			"form_composition",
			"composition_section",
			"composition_item",
		]) {
			expect(constraint.rows[0]?.definition).toContain(kind);
		}
	});
});
