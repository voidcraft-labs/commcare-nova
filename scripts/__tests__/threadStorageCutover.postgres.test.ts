import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { Client } from "pg";
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { assertThreadCutoverRuntimeStopped } from "../lib/threadStorageCutover";

const h = setupAppStateTestDb("thread_cutover_role_");

it("requires disabled runtime login and the end of every existing runtime connection", async () => {
	const role = `cutover_${randomUUID().replaceAll("-", "")}`;
	await sql`CREATE ROLE ${sql.id(role)} LOGIN PASSWORD 'synthetic-test-password'`.execute(
		h.db(),
	);
	let client: Client | undefined;
	try {
		await expect(
			assertThreadCutoverRuntimeStopped(h.db(), role),
		).rejects.toThrow("NOLOGIN");
		const url = new URL(h.uri());
		url.username = role;
		url.password = "synthetic-test-password";
		client = new Client({ connectionString: url.href });
		await client.connect();
		await sql`ALTER ROLE ${sql.id(role)} NOLOGIN`.execute(h.db());
		await expect(
			assertThreadCutoverRuntimeStopped(h.db(), role),
		).rejects.toThrow("no remaining sessions");
		await client.end();
		client = undefined;
		// pg_stat_activity can lag a client FIN; native backend state supplies
		// the observation, with an owned bounded loop, not a guessed delay.
		await expect
			.poll(
				async () =>
					(
						await sql<{
							sessions: number;
						}>`SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE usename = ${role}`.execute(
							h.db(),
						)
					).rows[0].sessions,
			)
			.toBe(0);
		await assertThreadCutoverRuntimeStopped(h.db(), role);
	} finally {
		await client?.end();
		await sql`DROP ROLE ${sql.id(role)}`.execute(h.db());
	}
});
