import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { DESIGN_IDENTITY_HANDLE_ENTITY_KINDS } from "@/lib/agent/design/ids";
import { up } from "@/lib/case-store/migrations/20260830000000_design_lookup_handle_kinds";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

import { checkConstraintVerdicts } from "./checkConstraint";

const h = setupAppStateTestDb("design_lookup_handle_kinds_");

describe("design lookup handle kinds migration", () => {
	it("admits lookup handles while preserving previous kinds", async () => {
		const db = h.db();
		// Latest-schema compatibility belongs before replaying a historical migration.
		expect(
			await checkConstraintVerdicts(
				db as unknown as Kysely<unknown>,
				"design_identity_handles",
				"design_identity_handles_entity_kind_check",
				"entity_kind",
				DESIGN_IDENTITY_HANDLE_ENTITY_KINDS,
			),
		).toEqual(
			DESIGN_IDENTITY_HANDLE_ENTITY_KINDS.map((value) => ({
				value,
				admitted: true,
			})),
		);
		await sql`ALTER TABLE design_identity_handles
			DROP CONSTRAINT design_identity_handles_entity_kind_check,
			ADD CONSTRAINT design_identity_handles_entity_kind_check CHECK (entity_kind IN ('contract', 'referenced'))`.execute(
			db,
		);

		await up(db as unknown as Kysely<unknown>);

		expect(
			await checkConstraintVerdicts(
				db as unknown as Kysely<unknown>,
				"design_identity_handles",
				"design_identity_handles_entity_kind_check",
				"entity_kind",
				[
					"contract",
					"referenced",
					"lookup_table_intent",
					"lookup_column_intent",
					"lookup_row_intent",
					"unknown_kind",
				],
			),
		).toEqual([
			...[
				"contract",
				"referenced",
				"lookup_table_intent",
				"lookup_column_intent",
				"lookup_row_intent",
			].map((value) => ({
				value,
				admitted: true,
			})),
			{ value: "unknown_kind", admitted: false },
		]);
	});
});
