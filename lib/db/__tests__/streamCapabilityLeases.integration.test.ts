/**
 * Stream receiver registration against real Postgres. These tests pin the
 * app -> membership -> compatibility lock order, database-authored identity and
 * statement-time lease clock, exact cleanup key, bounded expiry purge, and both
 * cutoff winner orders.
 */

import { sql } from "kysely";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import type { AppAccessError } from "@/lib/db/appAccess";
import {
	deleteStreamCapabilityLease,
	purgeExpiredStreamCapabilityLeases,
	registerStreamCapabilityLease,
	registerStreamCapabilityLeaseInTransaction,
	STREAM_CAPABILITY_PURGE_BATCH_SIZE,
} from "@/lib/db/streamCapabilityLeases";
import { STREAM_LEASE_TTL_SECONDS } from "@/lib/runtimeCapabilities";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("stream_capability_lease_");

const USER = "stream-user";
const PROJECT = "stream-project";

async function seedAuthorizedApp(): Promise<string> {
	return h.seedApp({ owner: USER, project_id: PROJECT });
}

async function setReceiverFloor(version: number): Promise<void> {
	await h
		.db()
		.updateTable("lookup_reference_compatibility")
		.set({ minimum_stream_receiver_version: version })
		.where("id", "=", 1)
		.executeTakeFirstOrThrow();
}

async function backendPid(client: Client): Promise<number> {
	const result = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = result.rows[0]?.pid;
	if (pid === undefined) throw new Error("backend pid query returned no row");
	return pid;
}

async function waitUntilBackendIsBlocked(
	observer: Client,
	waitingPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const result = await observer.query<{ blockers: number[] }>(
			"SELECT pg_blocking_pids($1) AS blockers",
			[waitingPid],
		);
		if ((result.rows[0]?.blockers.length ?? 0) > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Backend ${waitingPid} did not block within two seconds.`);
}

async function waitUntilAnyBackendIsBlockedBy(
	observer: Client,
	blockingPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const result = await observer.query<{ pid: number }>(
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
				AND pid <> pg_backend_pid()
				AND $1 = ANY(pg_blocking_pids(pid))
			 LIMIT 1`,
			[blockingPid],
		);
		if (result.rows[0]?.pid !== undefined) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`No backend blocked behind ${blockingPid} within two seconds.`,
	);
}

describe("stream capability leases", () => {
	it("authenticates before a below-floor verdict and inserts no lease on either denial", async () => {
		const appId = await seedAuthorizedApp();
		await setReceiverFloor(1);
		await sql`
			DELETE FROM auth_member
			WHERE "userId" = ${USER} AND "organizationId" = ${PROJECT}
		`.execute(h.db());

		await expect(
			registerStreamCapabilityLease({
				appId,
				userId: USER,
				receiverVersion: 0,
			}),
		).rejects.toMatchObject({
			name: "AppAccessError",
			reason: "not_member",
		} satisfies Partial<AppAccessError>);

		await h.seedProjectMember(USER, PROJECT, "viewer");
		await expect(
			registerStreamCapabilityLease({
				appId,
				userId: USER,
				receiverVersion: 0,
			}),
		).resolves.toEqual({
			kind: "receiver-below-floor",
			receiverVersion: 0,
			minimumStreamReceiverVersion: 1,
		});

		const leases = await h
			.db()
			.selectFrom("lookup_stream_capability_leases")
			.select(({ fn }) => fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		expect(Number(leases.count)).toBe(0);
	});

	it("mints UUIDv7 identity and the exact manifest TTL from statement time after an app-lock wait", async () => {
		const appId = await seedAuthorizedApp();
		const blocker = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([blocker.connect(), observer.connect()]);
		let registration:
			| Promise<Awaited<ReturnType<typeof registerStreamCapabilityLease>>>
			| undefined;
		let blockerCommitted = false;
		try {
			await blocker.query("BEGIN");
			await blocker.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [
				appId,
			]);
			const blockerPid = await backendPid(blocker);
			registration = registerStreamCapabilityLease({
				appId,
				userId: USER,
				receiverVersion: 1,
			});
			await waitUntilAnyBackendIsBlockedBy(observer, blockerPid);
			const releaseClock = await observer.query<{ observed_at: Date }>(
				"SELECT clock_timestamp()::timestamptz(3) AS observed_at",
			);
			const releasedAfter = releaseClock.rows[0]?.observed_at;
			if (!releasedAfter) throw new Error("release clock returned no row");
			await blocker.query("COMMIT");
			blockerCommitted = true;

			const result = await registration;
			if (result.kind !== "registered") {
				throw new Error("authorized v1 registration was rejected");
			}
			expect(result.connectionId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(
				releasedAfter.getTime(),
			);
			expect(result.expiresAt.getTime() - result.createdAt.getTime()).toBe(
				STREAM_LEASE_TTL_SECONDS * 1_000,
			);
			expect(result.scope).toMatchObject({
				projectId: PROJECT,
				actorUserId: USER,
				baseSeq: 0,
			});
		} finally {
			if (!blockerCommitted) {
				await Promise.allSettled([blocker.query("ROLLBACK")]);
			}
			if (registration !== undefined) {
				await Promise.allSettled([registration]);
			}
			await Promise.all([blocker.end(), observer.end()]);
		}
	});

	it("deletes only the exact app and database-minted connection UUID", async () => {
		const appId = await seedAuthorizedApp();
		const first = await registerStreamCapabilityLease({
			appId,
			userId: USER,
			receiverVersion: 1,
		});
		const second = await registerStreamCapabilityLease({
			appId,
			userId: USER,
			receiverVersion: 1,
		});
		if (first.kind !== "registered" || second.kind !== "registered") {
			throw new Error("authorized registrations were rejected");
		}

		await expect(
			deleteStreamCapabilityLease("different-app", first.connectionId),
		).resolves.toBe(false);
		await expect(
			deleteStreamCapabilityLease(appId, first.connectionId),
		).resolves.toBe(true);
		const remaining = await h
			.db()
			.selectFrom("lookup_stream_capability_leases")
			.select("connection_id")
			.where("app_id", "=", appId)
			.execute();
		expect(remaining.map((row) => row.connection_id)).toEqual([
			second.connectionId,
		]);
	});

	it("purges one index-ordered bounded batch of expired leases and preserves unexpired rows", async () => {
		const appId = await seedAuthorizedApp();
		const createdAt = new Date(Date.now() - 120_000);
		const expiredAt = new Date(Date.now() - 60_000);
		await h
			.db()
			.insertInto("lookup_stream_capability_leases")
			.values(
				Array.from({ length: STREAM_CAPABILITY_PURGE_BATCH_SIZE + 2 }, () => ({
					app_id: appId,
					receiver_version: 1,
					created_at: createdAt,
					expires_at: expiredAt,
				})),
			)
			.execute();
		const liveLease = await h
			.db()
			.insertInto("lookup_stream_capability_leases")
			.values({
				app_id: appId,
				receiver_version: 1,
				created_at: createdAt,
				expires_at: new Date(Date.now() + 60_000),
			})
			.returning("connection_id")
			.executeTakeFirstOrThrow();
		const liveConnectionId = liveLease.connection_id;

		expect(await purgeExpiredStreamCapabilityLeases()).toBe(
			STREAM_CAPABILITY_PURGE_BATCH_SIZE,
		);
		const remaining = await h
			.db()
			.selectFrom("lookup_stream_capability_leases")
			.select(["connection_id", "expires_at"])
			.where("app_id", "=", appId)
			.execute();
		expect(remaining).toHaveLength(3);
		expect(
			remaining.some((row) => row.connection_id === liveConnectionId),
		).toBe(true);
		expect(remaining.filter((row) => row.expires_at <= new Date()).length).toBe(
			2,
		);
	});

	it("lets a registered v0 lease commit before a concurrent floor cutoff", async () => {
		const appId = await seedAuthorizedApp();
		const cutoff = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([cutoff.connect(), observer.connect()]);
		let cutoffWrite: Promise<void> | undefined;
		try {
			const cutoffPid = await backendPid(cutoff);
			const registration = await h
				.db()
				.transaction()
				.execute(async (tx) => {
					const admitted = await registerStreamCapabilityLeaseInTransaction(
						tx,
						{
							appId,
							userId: USER,
							receiverVersion: 0,
						},
					);
					cutoffWrite = cutoff
						.query(
							`UPDATE lookup_reference_compatibility
						 SET minimum_stream_receiver_version = 1
						 WHERE id = 1`,
						)
						.then(() => undefined);
					await waitUntilBackendIsBlocked(observer, cutoffPid);
					return admitted;
				});
			if (cutoffWrite === undefined) throw new Error("cutoff did not start");
			await cutoffWrite;

			expect(registration).toMatchObject({
				kind: "registered",
				receiverVersion: 0,
			});
			const status = await h
				.db()
				.selectFrom("lookup_reference_compatibility")
				.select("minimum_stream_receiver_version")
				.where("id", "=", 1)
				.executeTakeFirstOrThrow();
			expect(status.minimum_stream_receiver_version).toBe(1);
			const leases = await h
				.db()
				.selectFrom("lookup_stream_capability_leases")
				.select("receiver_version")
				.where("app_id", "=", appId)
				.execute();
			expect(leases.map((row) => row.receiver_version)).toEqual([0]);
		} finally {
			if (cutoffWrite !== undefined) {
				await Promise.allSettled([cutoffWrite]);
			}
			await Promise.all([cutoff.end(), observer.end()]);
		}
	});

	it("rejects a v0 registration when the concurrent floor cutoff commits first", async () => {
		const appId = await seedAuthorizedApp();
		const cutoff = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([cutoff.connect(), observer.connect()]);
		let registration:
			| Promise<Awaited<ReturnType<typeof registerStreamCapabilityLease>>>
			| undefined;
		let cutoffCommitted = false;
		try {
			await cutoff.query("BEGIN");
			await cutoff.query(
				`UPDATE lookup_reference_compatibility
				 SET minimum_stream_receiver_version = 1
				 WHERE id = 1`,
			);
			const cutoffPid = await backendPid(cutoff);
			registration = registerStreamCapabilityLease({
				appId,
				userId: USER,
				receiverVersion: 0,
			});
			await waitUntilAnyBackendIsBlockedBy(observer, cutoffPid);
			await cutoff.query("COMMIT");
			cutoffCommitted = true;

			await expect(registration).resolves.toEqual({
				kind: "receiver-below-floor",
				receiverVersion: 0,
				minimumStreamReceiverVersion: 1,
			});
			const leases = await h
				.db()
				.selectFrom("lookup_stream_capability_leases")
				.select(({ fn }) => fn.countAll<number>().as("count"))
				.executeTakeFirstOrThrow();
			expect(Number(leases.count)).toBe(0);
		} finally {
			if (!cutoffCommitted) {
				await Promise.allSettled([cutoff.query("ROLLBACK")]);
			}
			if (registration !== undefined) {
				await Promise.allSettled([registration]);
			}
			await Promise.all([cutoff.end(), observer.end()]);
		}
	});
});
