import { type Kysely, sql } from "kysely";
import { expect, it } from "vitest";
import { stagedEntityKindSchema } from "@/lib/agent/change-set/schemas";
import { up } from "@/lib/case-store/migrations/20260904010000_entry_point_handles";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const h = setupAppStateTestDb("entry_point_handles_");

it("upgrades the already installed handle constraint to every current staged kind", async () => {
	const db = h.db();
	// Simulate an existing deployment's old constraint without changing historical migrations.
	await sql`ALTER TABLE design_change_set_handles DROP CONSTRAINT design_change_set_handles_entity_kind_check, ADD CONSTRAINT design_change_set_handles_entity_kind_check CHECK (entity_kind IN ('module', 'form'))`.execute(
		db,
	);
	await up(db as unknown as Kysely<unknown>);
	const result = await sql<{
		definition: string;
	}>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'design_change_set_handles_entity_kind_check' AND conrelid = 'design_change_set_handles'::regclass`.execute(
		db,
	);
	for (const kind of stagedEntityKindSchema.options)
		expect(result.rows[0]?.definition).toContain(`'${kind}'`);
});
