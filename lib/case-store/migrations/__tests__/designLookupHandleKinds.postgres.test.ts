import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
	DESIGN_IDENTITY_HANDLE_ENTITY_KINDS,
	type DesignIdentityHandleEntityKind,
} from "@/lib/agent/design/ids";
import { up } from "@/lib/case-store/migrations/20260830000000_design_lookup_handle_kinds";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const h = setupAppStateTestDb("design_lookup_handle_kinds_");

const PREVIOUS_KINDS = DESIGN_IDENTITY_HANDLE_ENTITY_KINDS.filter(
	(kind) => !kind.startsWith("lookup_"),
);

function quoted(kinds: readonly DesignIdentityHandleEntityKind[]): string {
	return kinds.map((kind) => `'${kind}'`).join(", ");
}

describe("design lookup handle kinds migration", () => {
	it("moves the database constraint to the complete current runtime vocabulary", async () => {
		const db = h.db();
		await sql`
			ALTER TABLE design_identity_handles
				DROP CONSTRAINT design_identity_handles_entity_kind_check,
				ADD CONSTRAINT design_identity_handles_entity_kind_check
					CHECK (entity_kind IN (${sql.raw(quoted(PREVIOUS_KINDS))}))
		`.execute(db);

		await up(db as unknown as Kysely<unknown>);

		const constraint = await sql<{ definition: string }>`
			SELECT pg_get_constraintdef(oid) AS definition
			FROM pg_constraint
			WHERE conname = 'design_identity_handles_entity_kind_check'
				AND conrelid = 'design_identity_handles'::regclass
		`.execute(db);
		const definition = constraint.rows[0]?.definition ?? "";
		for (const kind of DESIGN_IDENTITY_HANDLE_ENTITY_KINDS)
			expect(definition).toContain(kind);
	});
});
