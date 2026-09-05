import { type Kysely, sql } from "kysely";
import { expect, it } from "vitest";
import { stagedEntityKindSchema } from "@/lib/agent/change-set/schemas";
import { up } from "@/lib/case-store/migrations/20260904010000_entry_point_handles";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

import { checkConstraintVerdicts } from "./checkConstraint";

const h = setupAppStateTestDb("entry_point_handles_");

it("admits entry points while preserving existing staged kinds", async () => {
	const db = h.db();
	expect(
		await checkConstraintVerdicts(
			db as unknown as Kysely<unknown>,
			"design_change_set_handles",
			"design_change_set_handles_entity_kind_check",
			"entity_kind",
			stagedEntityKindSchema.options,
		),
	).toEqual(
		stagedEntityKindSchema.options.map((value) => ({ value, admitted: true })),
	);

	// Simulate an existing deployment's old constraint without changing historical migrations.
	await sql`ALTER TABLE design_change_set_handles DROP CONSTRAINT design_change_set_handles_entity_kind_check, ADD CONSTRAINT design_change_set_handles_entity_kind_check CHECK (entity_kind IN ('module', 'form'))`.execute(
		db,
	);
	await up(db as unknown as Kysely<unknown>);
	expect(
		await checkConstraintVerdicts(
			db as unknown as Kysely<unknown>,
			"design_change_set_handles",
			"design_change_set_handles_entity_kind_check",
			"entity_kind",
			["module", "form", "field", "entry_point", "unknown_kind"],
		),
	).toEqual([
		...["module", "form", "field", "entry_point"].map((value) => ({
			value,
			admitted: true,
		})),
		{ value: "unknown_kind", admitted: false },
	]);
});
