import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/case-store/migrations/20260814000000_design_composition_handle_kinds";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

import { checkConstraintVerdicts } from "./checkConstraint";

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

		const accepted = [
			"contract",
			"module_composition",
			"form_composition",
			"composition_section",
			"composition_item",
		];
		expect(
			await checkConstraintVerdicts(
				db as unknown as Kysely<unknown>,
				"design_identity_handles",
				"design_identity_handles_entity_kind_check",
				"entity_kind",
				[...accepted, "unknown_kind", "lookup_table_intent"],
			),
		).toEqual([
			...accepted.map((value) => ({ value, admitted: true })),
			{ value: "unknown_kind", admitted: false },
			{ value: "lookup_table_intent", admitted: false },
		]);
	});
});
