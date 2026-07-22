/**
 * The database-wide Project-membership serialization protocol against real
 * Postgres. Better Auth owns `auth_member`, so the app database intentionally
 * reaches it through raw SQL and a Nova-owned auth-app migration.
 *
 * These races prove both winner orders for INSERT / UPDATE / DELETE, including
 * a missing-row decision. The statement trigger must acquire its exclusive
 * gate before tuple work; the app transaction holds the matching shared gate
 * before its membership read. TRUNCATE is rejected separately once its trigger
 * is reached; it must never wait on the advisory lock after taking ACCESS
 * EXCLUSIVE.
 */

import { type Kysely, sql } from "kysely";
import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import {
	up as installAuthMemberSerialization,
	down as removeAuthMemberSerialization,
} from "@/lib/auth/migrations/20260722070000_auth_member_serialization";
import { commitGuardedBatch } from "../apps";
import { CommitReauthError } from "../commitGuard";
import { projectRoleForInTransaction } from "../projectMembership";
import {
	lockProjectMembershipGateShared,
	PROJECT_MEMBERSHIP_GATE_KEY,
	PROJECT_MEMBERSHIP_GATE_NAMESPACE,
} from "../projectMembershipGate";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("project_membership_tx_");

const USER = "membership-user";
const INSERTED_USER = "inserted-user";
const PROJECT = "membership-project";

interface MutationCase {
	name: string;
	userId: string;
	beforeRole: string | null;
	afterRole: string | null;
	statement: string;
	params: readonly string[];
}

const MUTATIONS: readonly MutationCase[] = [
	{
		name: "INSERT",
		userId: INSERTED_USER,
		beforeRole: null,
		afterRole: "viewer",
		statement: `
			INSERT INTO auth_member (id, "userId", "organizationId", role)
			VALUES ('inserted-row', $1, $2, 'viewer')
		`,
		params: [INSERTED_USER, PROJECT],
	},
	{
		name: "UPDATE",
		userId: USER,
		beforeRole: "editor",
		afterRole: "viewer",
		statement: `
			UPDATE auth_member
			SET role = 'viewer'
			WHERE "userId" = $1 AND "organizationId" = $2
		`,
		params: [USER, PROJECT],
	},
	{
		name: "DELETE",
		userId: USER,
		beforeRole: "editor",
		afterRole: null,
		statement: `
			DELETE FROM auth_member
			WHERE "userId" = $1 AND "organizationId" = $2
		`,
		params: [USER, PROJECT],
	},
	{
		name: "zero-row UPDATE",
		userId: "missing-update-user",
		beforeRole: null,
		afterRole: null,
		statement: `
			UPDATE auth_member
			SET role = 'viewer'
			WHERE "userId" = $1 AND "organizationId" = $2
		`,
		params: ["missing-update-user", PROJECT],
	},
];

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
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const result = await observer.query<{ blockers: number[] }>(
			"SELECT pg_blocking_pids($1) AS blockers",
			[waitingPid],
		);
		if (result.rows[0]?.blockers.includes(blockingPid)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`Backend ${waitingPid} did not block behind ${blockingPid} within two seconds.`,
	);
}

async function waitUntilBackendBlockedBy(
	observer: Client,
	blockingPid: number,
): Promise<number> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const result = await observer.query<{ pid: number }>(
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
				AND pid <> pg_backend_pid()
				AND $1 = ANY(pg_blocking_pids(pid))
			 ORDER BY pid
			 LIMIT 1`,
			[blockingPid],
		);
		const pid = result.rows[0]?.pid;
		if (pid !== undefined) return pid;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`No backend blocked behind ${blockingPid} within two seconds.`,
	);
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((onResolve) => {
		resolve = onResolve;
	});
	return { promise, resolve };
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
	await installAuthMemberSerialization(h.db() as unknown as Kysely<unknown>);
});

describe("Project membership advisory gate", () => {
	it.each(MUTATIONS)(
		"lets the app decision win before membership $name",
		async ({ userId, beforeRole, afterRole, statement, params }) => {
			const mutator = new Client({ connectionString: h.uri() });
			const observer = new Client({ connectionString: h.uri() });
			await Promise.all([mutator.connect(), observer.connect()]);
			let mutation:
				| Promise<
						{ ok: true; error: undefined } | { ok: false; error: unknown }
				  >
				| undefined;
			try {
				const mutatorPid = await backendPid(mutator);
				await h
					.db()
					.transaction()
					.execute(async (tx) => {
						expect(await projectRoleForInTransaction(tx, userId, PROJECT)).toBe(
							beforeRole,
						);
						const identity = await sql<{ pid: number }>`
							SELECT pg_backend_pid() AS pid
						`.execute(tx);
						const holderPid = identity.rows[0]?.pid;
						if (holderPid === undefined) {
							throw new Error("transaction backend pid query returned no row");
						}

						mutation = mutator.query(statement, [...params]).then(
							() => ({ ok: true as const, error: undefined }),
							(error: unknown) => ({ ok: false as const, error }),
						);
						await waitUntilBlockedBy(observer, mutatorPid, holderPid);
					});

				if (mutation === undefined) {
					throw new Error("membership mutation was never started");
				}
				expect((await mutation).ok).toBe(true);
				await h
					.db()
					.transaction()
					.execute(async (tx) => {
						expect(await projectRoleForInTransaction(tx, userId, PROJECT)).toBe(
							afterRole,
						);
					});
			} finally {
				if (mutation !== undefined) await Promise.allSettled([mutation]);
				await Promise.allSettled([
					mutator.query("ROLLBACK"),
					observer.query("ROLLBACK"),
				]);
				await Promise.all([mutator.end(), observer.end()]);
			}
		},
	);

	it.each(MUTATIONS)(
		"makes the app decision observe membership $name when DML wins",
		async ({ userId, afterRole, statement, params }) => {
			const mutator = new Client({ connectionString: h.uri() });
			const observer = new Client({ connectionString: h.uri() });
			await Promise.all([mutator.connect(), observer.connect()]);
			const readerPid = deferred<number>();
			let read:
				| Promise<
						{ ok: true; role: string | null } | { ok: false; error: unknown }
				  >
				| undefined;
			let committed = false;
			try {
				await mutator.query("BEGIN");
				await mutator.query(statement, [...params]);
				const mutatorPid = await backendPid(mutator);

				read = h
					.db()
					.transaction()
					.execute(async (tx) => {
						const identity = await sql<{ pid: number }>`
							SELECT pg_backend_pid() AS pid
						`.execute(tx);
						const pid = identity.rows[0]?.pid;
						if (pid === undefined) {
							throw new Error("transaction backend pid query returned no row");
						}
						readerPid.resolve(pid);
						return projectRoleForInTransaction(tx, userId, PROJECT);
					})
					.then(
						(role) => ({ ok: true as const, role }),
						(error: unknown) => ({ ok: false as const, error }),
					);

				await waitUntilBlockedBy(observer, await readerPid.promise, mutatorPid);
				await mutator.query("COMMIT");
				committed = true;
				const outcome = await read;
				expect(outcome.ok).toBe(true);
				if (outcome.ok) expect(outcome.role).toBe(afterRole);
			} finally {
				if (!committed) await Promise.allSettled([mutator.query("ROLLBACK")]);
				if (read !== undefined) await Promise.allSettled([read]);
				await Promise.allSettled([observer.query("ROLLBACK")]);
				await Promise.all([mutator.end(), observer.end()]);
			}
		},
	);

	it("rejects TRUNCATE without waiting on the shared advisory gate", async () => {
		const truncater = new Client({ connectionString: h.uri() });
		await truncater.connect();
		try {
			await truncater.query("SET statement_timeout = '1s'");
			await h
				.db()
				.transaction()
				.execute(async (tx) => {
					await lockProjectMembershipGateShared(tx);
					await expect(
						truncater.query("TRUNCATE auth_member"),
					).rejects.toMatchObject({
						code: "55000",
						message: "TRUNCATE auth_member is prohibited; use membership DML.",
					});
				});
		} finally {
			await Promise.allSettled([truncater.query("ROLLBACK")]);
			await truncater.end();
		}
	});

	it("makes a production guarded writer lock the app before waiting on membership", async () => {
		const appId = await h.seedApp({
			id: "membership-writer-app",
			owner: USER,
			project_id: PROJECT,
			status: "complete",
		});
		const mutator = new Client({ connectionString: h.uri() });
		const contender = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([
			mutator.connect(),
			contender.connect(),
			observer.connect(),
		]);
		let guardedWrite:
			| Promise<{ ok: true } | { ok: false; error: unknown }>
			| undefined;
		let appLockAttempt:
			| Promise<{ ok: true } | { ok: false; error: unknown }>
			| undefined;
		let membershipCommitted = false;
		try {
			await mutator.query("BEGIN");
			await mutator.query(
				`UPDATE auth_member
				 SET role = 'viewer'
				 WHERE "userId" = $1 AND "organizationId" = $2`,
				[USER, PROJECT],
			);
			const mutatorPid = await backendPid(mutator);

			guardedWrite = commitGuardedBatch({
				appId,
				batchId: crypto.randomUUID(),
				mutations: [],
				actorUserId: USER,
				kind: "autosave",
				preauthorized: { projectId: PROJECT },
			}).then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			const writerPid = await waitUntilBackendBlockedBy(observer, mutatorPid);

			await contender.query("BEGIN");
			const contenderPid = await backendPid(contender);
			appLockAttempt = contender
				.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [appId])
				.then(
					() => ({ ok: true as const }),
					(error: unknown) => ({ ok: false as const, error }),
				);
			await waitUntilBlockedBy(observer, contenderPid, writerPid);

			await mutator.query("COMMIT");
			membershipCommitted = true;
			const writeOutcome = await guardedWrite;
			expect(writeOutcome.ok).toBe(false);
			if (!writeOutcome.ok) {
				expect(writeOutcome.error).toBeInstanceOf(CommitReauthError);
			}
			expect((await appLockAttempt).ok).toBe(true);
		} finally {
			if (!membershipCommitted) {
				await Promise.allSettled([mutator.query("ROLLBACK")]);
			}
			await Promise.allSettled([
				guardedWrite,
				appLockAttempt,
				contender.query("ROLLBACK"),
				observer.query("ROLLBACK"),
			]);
			await Promise.all([mutator.end(), contender.end(), observer.end()]);
		}
	});

	it("installs statement triggers with the exact TypeScript advisory keys", async () => {
		const result = await h.pool().query<{
			name: string;
			definition: string;
			function_definition: string;
		}>(`
			SELECT
				t.tgname AS name,
				pg_get_triggerdef(t.oid) AS definition,
				pg_get_functiondef(t.tgfoid) AS function_definition
			FROM pg_trigger t
			WHERE t.tgrelid = 'public.auth_member'::regclass
				AND NOT t.tgisinternal
			ORDER BY t.tgname
		`);

		expect(result.rows.map((row) => row.name)).toEqual([
			"nova_auth_member_membership_gate",
			"nova_auth_member_reject_truncate",
		]);
		for (const row of result.rows) {
			expect(row.definition).toContain("FOR EACH STATEMENT");
		}
		const gate = result.rows.find(
			(row) => row.name === "nova_auth_member_membership_gate",
		);
		expect(gate?.definition).toContain("BEFORE INSERT OR DELETE OR UPDATE");
		expect(gate?.function_definition).toContain(
			String(PROJECT_MEMBERSHIP_GATE_NAMESPACE),
		);
		expect(gate?.function_definition).toContain(
			String(PROJECT_MEMBERSHIP_GATE_KEY),
		);
	});

	it("removes and reinstalls its triggers and functions cleanly", async () => {
		const db = h.db() as unknown as Kysely<unknown>;
		await removeAuthMemberSerialization(db);
		const removed = await h.pool().query<{ count: string }>(`
			SELECT count(*)::text AS count
			FROM pg_trigger
			WHERE tgrelid = 'public.auth_member'::regclass
				AND NOT tgisinternal
		`);
		expect(removed.rows[0]?.count).toBe("0");
		const functions = await h
			.pool()
			.query<{ gate: string | null; trunc: string | null }>(`
			SELECT
				to_regprocedure('public.nova_lock_auth_member_membership_gate()')::text AS gate,
				to_regprocedure('public.nova_reject_auth_member_truncate()')::text AS trunc
		`);
		expect(functions.rows[0]).toEqual({ gate: null, trunc: null });

		await installAuthMemberSerialization(db);
		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				expect(await projectRoleForInTransaction(tx, USER, PROJECT)).toBe(
					"editor",
				);
			});
	});
});
