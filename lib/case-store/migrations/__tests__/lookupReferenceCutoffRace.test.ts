// Two-connection serialization and one-physical-connection GUC reset coverage
// for S02a's writer floor. This suite uses one isolated database (not another
// container) because the floor is intentionally monotonic and the race commits.

import { type Kysely, sql } from "kysely";
import { Client } from "pg";
import { beforeEach, describe, expect, test } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	type AppDatabase,
	setTransactionWriterVersion,
	WRITER_VERSION_GUC,
} from "@/lib/db/pg";

const h = setupPerTestDatabase({
	databaseNamePrefix: "lookup_ref_cutoff_",
});

beforeEach(async () => {
	await runCaseStoreMigrations(h.db);
});

async function backendPid(client: Client): Promise<number> {
	const result = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = result.rows[0]?.pid;
	if (pid === undefined) throw new Error("backend pid query returned no row");
	return pid;
}

async function waitUntilBlockedBy(
	observer: Client,
	waitingPid: number,
	blockingPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const result = await observer.query<{ blockers: number[] }>(
			"SELECT pg_blocking_pids($1) AS blockers",
			[waitingPid],
		);
		if (result.rows[0]?.blockers.includes(blockingPid)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`backend ${waitingPid} did not block behind ${blockingPid} within 1 second`,
	);
}

describe("lookup-reference writer cutoff", () => {
	test("serializes both floor/write winner orders and resets the production SET LOCAL helper", async () => {
		const writer = new Client({ connectionString: h.uri });
		const floor = new Client({ connectionString: h.uri });
		await Promise.all([writer.connect(), floor.connect()]);
		try {
			const writerPid = await backendPid(writer);
			const floorPid = await backendPid(floor);

			// Writer first: its statement-level guard holds the compatibility row
			// FOR SHARE until commit, so the floor raise waits and the write at the
			// deployed floor lands before the higher cutoff commits.
			await writer.query("BEGIN");
			await writer.query("SET LOCAL nova.writer_version = '1'");
			await writer.query(
				`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
				 VALUES ('writer-first-v1', 'actor', 'project-a', 'Writer first', 'writer first')`,
			);
			await floor.query("BEGIN");
			const raiseToTwo = floor.query(
				`UPDATE lookup_reference_compatibility
				 SET minimum_writer_version = 2 WHERE id = 1`,
			);
			await waitUntilBlockedBy(writer, floorPid, writerPid);
			await writer.query("COMMIT");
			await raiseToTwo;
			await floor.query("COMMIT");

			// Floor first: v2 waits on the row update, wakes against floor 3, and
			// fails with the non-retryable compatibility SQLSTATE.
			await floor.query("BEGIN");
			await floor.query(
				`UPDATE lookup_reference_compatibility
				 SET minimum_writer_version = 3 WHERE id = 1`,
			);
			await writer.query("BEGIN");
			await writer.query("SET LOCAL nova.writer_version = '2'");
			const staleWrite = writer
				.query(
					`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
					 VALUES ('floor-first-v2', 'actor', 'project-a', 'Floor first', 'floor first')`,
				)
				.then(
					() => ({ ok: true as const, error: undefined }),
					(error: unknown) => ({ ok: false as const, error }),
				);
			await waitUntilBlockedBy(floor, writerPid, floorPid);
			await floor.query("COMMIT");
			const staleOutcome = await staleWrite;
			expect(staleOutcome.ok).toBe(false);
			expect((staleOutcome.error as { code?: string } | undefined)?.code).toBe(
				"55000",
			);
			await writer.query("ROLLBACK");

			const committed = await floor.query<{
				writer_first: string;
				floor_first: string;
				floor: number;
			}>(
				`SELECT
					(SELECT count(*)::text FROM apps WHERE id = 'writer-first-v1')
						AS writer_first,
					(SELECT count(*)::text FROM apps WHERE id = 'floor-first-v2')
						AS floor_first,
					minimum_writer_version AS floor
				 FROM lookup_reference_compatibility WHERE id = 1`,
			);
			expect(committed.rows[0]).toEqual({
				writer_first: "1",
				floor_first: "0",
				floor: 3,
			});

			// Independent floor raisers still serialize on the singleton row. The
			// waiter must re-evaluate its single-column UPDATE against the committed
			// tuple, preserving the first transaction's different floor increase.
			await writer.query("BEGIN");
			await writer.query(
				`UPDATE lookup_reference_compatibility
				 SET minimum_stream_receiver_version = 3 WHERE id = 1`,
			);
			await floor.query("BEGIN");
			const raiseRuntimeReader = floor.query(
				`UPDATE lookup_reference_compatibility
				 SET minimum_runtime_reader_version = 1 WHERE id = 1`,
			);
			await waitUntilBlockedBy(writer, floorPid, writerPid);
			await writer.query("COMMIT");
			await raiseRuntimeReader;
			await floor.query("COMMIT");

			const combinedFloors = await writer.query<{
				stream_floor: number;
				runtime_floor: number;
			}>(
				`SELECT
					minimum_stream_receiver_version AS stream_floor,
					minimum_runtime_reader_version AS runtime_floor
				 FROM lookup_reference_compatibility WHERE id = 1`,
			);
			expect(combinedFloors.rows[0]).toEqual({
				stream_floor: 3,
				runtime_floor: 1,
			});
		} finally {
			await Promise.allSettled([
				writer.query("ROLLBACK"),
				floor.query("ROLLBACK"),
			]);
			await Promise.all([writer.end(), floor.end()]);
		}

		// `setupPerTestDatabase`'s pool is max=1, so every transaction below
		// demonstrably reuses one physical backend. Exercise the exact helper later
		// writers call, then prove both COMMIT and ROLLBACK restore the empty custom
		// setting placeholder and an unset new transaction fails at floor 3.
		const db = h.db as Kysely<AppDatabase>;
		const beforeDeclaration = await db.transaction().execute(async (tx) => {
			const result = await sql<{ pid: number; setting: string | null }>`
				SELECT pg_backend_pid() AS pid,
					current_setting(${WRITER_VERSION_GUC}, true) AS setting
			`.execute(tx);
			return result.rows[0];
		});
		if (!beforeDeclaration)
			throw new Error("initial backend query returned no row");
		expect(beforeDeclaration.setting).toBeNull();
		const physicalPid = beforeDeclaration.pid;

		await db.transaction().execute(async (tx) => {
			const identity = await sql<{
				pid: number;
			}>`SELECT pg_backend_pid() AS pid`.execute(tx);
			expect(identity.rows[0]?.pid).toBe(physicalPid);
			await setTransactionWriterVersion(tx, 3);
			await sql`
				INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
				VALUES ('helper-commit-v3', 'actor', 'project-a', 'Helper', 'helper')
			`.execute(tx);
		});

		const afterCommit = await db.transaction().execute(async (tx) => {
			const result = await sql<{ pid: number; setting: string | null }>`
				SELECT pg_backend_pid() AS pid,
					current_setting(${WRITER_VERSION_GUC}, true) AS setting
			`.execute(tx);
			return result.rows[0];
		});
		expect(afterCommit?.pid).toBe(physicalPid);
		expect(afterCommit?.setting).toBe("");

		await expect(
			db.transaction().execute(async (tx) => {
				await setTransactionWriterVersion(tx, 3);
				throw new Error("intentional writer-version rollback");
			}),
		).rejects.toThrow("intentional writer-version rollback");

		const afterRollback = await db.transaction().execute(async (tx) => {
			const result = await sql<{ pid: number; setting: string | null }>`
				SELECT pg_backend_pid() AS pid,
					current_setting(${WRITER_VERSION_GUC}, true) AS setting
			`.execute(tx);
			return result.rows[0];
		});
		expect(afterRollback?.pid).toBe(physicalPid);
		expect(afterRollback?.setting).toBe("");

		let unsetError: unknown;
		try {
			await db.transaction().execute(async (tx) => {
				await sql`
					INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
					VALUES ('helper-unset-v0', 'actor', 'project-a', 'Unset', 'unset')
				`.execute(tx);
			});
		} catch (error) {
			unsetError = error;
		}
		expect((unsetError as { code?: string } | undefined)?.code).toBe("55000");
	});
});
