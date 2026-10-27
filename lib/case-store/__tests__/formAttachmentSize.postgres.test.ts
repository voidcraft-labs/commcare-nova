// The capture row's size check after the platform migration: as large as
// Android sends (15 MiB less 1 KiB), and back to Web Apps' 4,000,000 bytes
// when the migration is undone. The installed CHECK is evaluated against
// candidate sizes, so no unrelated parent rows are built.

import { type Kysely, sql } from "kysely";
import { expect, it } from "vitest";
import {
	down,
	up,
} from "../migrations/20261101025000_hq_round_trip_platforms_android_capture_size";
import { setupPerTestDatabase } from "../sql/__tests__/perTestDatabase";

const database = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "form_attachment_size_",
});

async function admitted(
	db: Kysely<unknown>,
	sizes: readonly number[],
): Promise<readonly boolean[]> {
	const installed = await sql<{ expression: string }>`
		SELECT pg_get_expr(conbin, conrelid) AS expression
		FROM pg_constraint
		WHERE conrelid = 'form_attachments'::regclass
		  AND conname = 'form_attachments_size_check'
		  AND contype = 'c' AND convalidated
	`.execute(db);
	const expression = installed.rows[0]?.expression;
	if (installed.rows.length !== 1 || expression === undefined)
		throw new Error("Expected one validated form_attachments_size_check.");
	const result = await sql<{ admitted: boolean }>`
		SELECT (${sql.raw(expression)}) AS admitted
		FROM unnest(${sizes.map(String)}::bigint[]) WITH ORDINALITY
			AS candidate(size_bytes, position)
		ORDER BY position
	`.execute(db);
	return result.rows.map((row) => row.admitted);
}

it("admits Android's largest capture and refuses one byte more", async () => {
	const db = database.db as unknown as Kysely<unknown>;
	expect(await admitted(db, [1, 15_727_616, 15_727_617, 0])).toEqual([
		true,
		true,
		false,
		false,
	]);
});

it("restores Web Apps' 4,000,000 bytes when undone, and widens again when reapplied", async () => {
	const db = database.db as unknown as Kysely<unknown>;
	await down(db);
	expect(await admitted(db, [4_000_000, 4_000_001])).toEqual([true, false]);
	await up(db);
	expect(await admitted(db, [4_000_001, 15_727_616])).toEqual([true, true]);
});
