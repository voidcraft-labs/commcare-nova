/**
 * The authoritative app-writer membership read against real Postgres.
 *
 * Better Auth owns `auth_member`, so `AppDatabase` intentionally has no typed
 * table entry for it. This suite executes the raw-SQL seam against the exact
 * quoted column names and proves its existing-row `FOR SHARE` lock holds a
 * concurrent role update until the caller's app transaction commits.
 */

import { sql } from "kysely";
import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { projectRoleForInTransaction } from "../projectMembership";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("project_membership_tx_");

const USER = "membership-user";
const PROJECT = "membership-project";

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
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const result = await observer.query<{ blockers: number[] }>(
			"SELECT pg_blocking_pids($1) AS blockers",
			[waitingPid],
		);
		if (result.rows[0]?.blockers.includes(blockingPid)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`Backend ${waitingPid} did not block behind ${blockingPid} within one second.`,
	);
}

beforeEach(async () => {
	await h.pool().query(`
		CREATE TABLE auth_member (
			id text PRIMARY KEY,
			"userId" text NOT NULL,
			"organizationId" text NOT NULL,
			role text NOT NULL,
			UNIQUE ("organizationId", "userId")
		);
		INSERT INTO auth_member (id, "userId", "organizationId", role)
		VALUES ('membership-row', '${USER}', '${PROJECT}', 'editor');
	`);
});

describe("projectRoleForInTransaction", () => {
	it("reads hit/miss through the raw Better Auth shape and holds the existing role row FOR SHARE", async () => {
		const updater = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([updater.connect(), observer.connect()]);
		let updateOutcome:
			| Promise<{ ok: true; error: undefined } | { ok: false; error: unknown }>
			| undefined;
		try {
			const updaterPid = await backendPid(updater);
			await h
				.db()
				.transaction()
				.execute(async (tx) => {
					expect(await projectRoleForInTransaction(tx, USER, PROJECT)).toBe(
						"editor",
					);
					expect(
						await projectRoleForInTransaction(tx, "absent-user", PROJECT),
					).toBeNull();
					const identity = await sql<{ pid: number }>`
						SELECT pg_backend_pid() AS pid
					`.execute(tx);
					const holderPid = identity.rows[0]?.pid;
					if (holderPid === undefined) {
						throw new Error("transaction backend pid query returned no row");
					}

					updateOutcome = updater
						.query(
							`UPDATE auth_member
							 SET role = 'viewer'
							 WHERE "userId" = $1 AND "organizationId" = $2`,
							[USER, PROJECT],
						)
						.then(
							() => ({ ok: true as const, error: undefined }),
							(error: unknown) => ({ ok: false as const, error }),
						);
					await waitUntilBlockedBy(observer, updaterPid, holderPid);
				});

			if (updateOutcome === undefined) {
				throw new Error("role update was never started");
			}
			expect((await updateOutcome).ok).toBe(true);
			await h
				.db()
				.transaction()
				.execute(async (tx) => {
					expect(await projectRoleForInTransaction(tx, USER, PROJECT)).toBe(
						"viewer",
					);
				});
		} finally {
			if (updateOutcome !== undefined) {
				await Promise.allSettled([updateOutcome]);
			}
			await Promise.allSettled([
				updater.query("ROLLBACK"),
				observer.query("ROLLBACK"),
			]);
			await Promise.all([updater.end(), observer.end()]);
		}
	});
});
