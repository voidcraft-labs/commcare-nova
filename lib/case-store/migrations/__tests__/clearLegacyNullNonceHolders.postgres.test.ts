// Live-Postgres contract for retiring pre-nonce run holders.
//
// The shared harness has already applied the production chain, so the seeded
// rows below are re-run through the migration's own `up` — the shipped SQL is
// what executes, not a copy of it.

import type { Kysely } from "kysely";
import { describe } from "vitest";
import { expect, test } from "../../sql/__tests__/setup";
import { up as clearLegacyNullNonceHolders } from "../20260725060000_clear_legacy_null_nonce_holders";

/* The migration's `up` is schema-agnostic raw SQL, while the harness hands out
 * the typed handle for that same connection — re-typing it is the whole
 * adaptation, and Kysely's schema parameter is invariant so it must be explicit. */
type MigrationDb = Kysely<unknown>;

/** `updated_at` is what separates an abandoned holder from a live one. */
async function seedApp(
	client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
	row: {
		id: string;
		status: string;
		ageHours: number;
		nonce: string | null;
		awaitingInput?: boolean;
		lockRunId?: string | null;
		resRunId?: string | null;
		resSettled?: boolean | null;
	},
): Promise<void> {
	await client.query(
		// Every app carries a nonblank Project; this migration predates that
		// requirement but its fixture still has to satisfy the current schema.
		`INSERT INTO apps (
			id, owner, project_id, app_name, app_name_lower, status, awaiting_input,
			run_id, lock_run_id, res_run_id, res_settled, run_holder_nonce, updated_at
		) VALUES ($1, 'owner-a', 'nonce-holder-project', $1, $1, $2, $3, 'run-1', $4, $5, $6, $7,
			now() - ($8 || ' hours')::interval)`,
		[
			row.id,
			row.status,
			row.awaitingInput ?? false,
			row.lockRunId ?? null,
			row.resRunId ?? null,
			row.resSettled ?? null,
			row.nonce,
			String(row.ageHours),
		],
	);
}

async function readApp(
	client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
	id: string,
): Promise<{ status: string; error_type: string | null }> {
	const result = (await client.query(
		"SELECT status, error_type, awaiting_input FROM apps WHERE id = $1",
		[id],
	)) as { rows: Array<{ status: string; error_type: string | null }> };
	const row = result.rows[0];
	if (!row) throw new Error(`app ${id} vanished`);
	return row;
}

describe("clear legacy null-nonce holders migration", () => {
	test("retires only abandoned nonce-less holders, and leaves every other row alone", async ({
		db,
		pgClient,
	}) => {
		// Retired: the two shapes an unreapable pre-nonce holder can take.
		await seedApp(pgClient, {
			id: "stale-build",
			status: "generating",
			ageHours: 5,
			nonce: null,
		});
		await seedApp(pgClient, {
			id: "stale-paused-build",
			status: "generating",
			ageHours: 5,
			nonce: null,
			awaitingInput: true,
		});
		await seedApp(pgClient, {
			id: "stale-edit-lock",
			status: "complete",
			ageHours: 5,
			nonce: null,
			lockRunId: "run-1",
		});

		// Untouched: a live run, a nonce-bearing holder, an idle app, and a
		// holder whose unsettled reservation owes a credit refund.
		await seedApp(pgClient, {
			id: "fresh-build",
			status: "generating",
			ageHours: 0,
			nonce: null,
		});
		await seedApp(pgClient, {
			id: "nonce-build",
			status: "generating",
			ageHours: 5,
			nonce: "00000000-0000-4000-8000-000000000001",
		});
		await seedApp(pgClient, {
			id: "idle-app",
			status: "complete",
			ageHours: 5,
			nonce: null,
		});
		await seedApp(pgClient, {
			id: "unsettled-reservation",
			status: "generating",
			ageHours: 5,
			nonce: null,
			resRunId: "run-1",
			resSettled: false,
		});

		await clearLegacyNullNonceHolders(db as unknown as MigrationDb);

		// A crashed build reads `internal`; a paused one reads `paused_timeout`,
		// exactly as `refundStaleGeneration` would have written them.
		expect(await readApp(pgClient, "stale-build")).toMatchObject({
			status: "error",
			error_type: "internal",
		});
		expect(await readApp(pgClient, "stale-paused-build")).toMatchObject({
			status: "error",
			error_type: "paused_timeout",
			awaiting_input: false,
		});
		expect(await readApp(pgClient, "stale-edit-lock")).toMatchObject({
			status: "error",
		});

		for (const id of [
			"fresh-build",
			"nonce-build",
			"unsettled-reservation",
		] as const) {
			expect(await readApp(pgClient, id)).toMatchObject({
				status: "generating",
			});
		}
		expect(await readApp(pgClient, "idle-app")).toMatchObject({
			status: "complete",
		});
	});

	test("is idempotent — a second run retires nothing further", async ({
		db,
		pgClient,
	}) => {
		await seedApp(pgClient, {
			id: "stale-build",
			status: "generating",
			ageHours: 5,
			nonce: null,
		});

		await clearLegacyNullNonceHolders(db as unknown as MigrationDb);
		const afterFirst = await readApp(pgClient, "stale-build");
		await clearLegacyNullNonceHolders(db as unknown as MigrationDb);

		expect(await readApp(pgClient, "stale-build")).toEqual(afterFirst);
	});
});
