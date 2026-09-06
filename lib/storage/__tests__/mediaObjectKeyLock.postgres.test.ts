import { sql } from "kysely";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { __setAppPoolForTests } from "@/lib/db/pg";
import {
	withMediaObjectKeyLock,
	withMediaObjectKeyLocks,
} from "../mediaObjectKeyLock";

const h = setupAppStateTestDb("media_session_locks_");
const HASH = "c".repeat(64);
async function connected<T>(run: (pool: Pool, observer: Client) => Promise<T>) {
	const pool = new Pool({ connectionString: h.uri(), max: 3 });
	const observer = new Client({ connectionString: h.uri() });
	__setAppPoolForTests(pool);
	try {
		await observer.connect();
		return await run(pool, observer);
	} finally {
		__setAppPoolForTests(h.pool());
		try {
			await pool.end();
		} finally {
			await observer.end();
		}
	}
}
async function until(predicate: () => Promise<boolean>) {
	const deadline = Date.now() + 1000;
	while (!(await predicate())) {
		if (Date.now() > deadline)
			throw new Error("Expected database state was not reached");
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
async function owns(observer: Client, identity: string) {
	const result = await observer.query<{ acquired: boolean }>(
		"SELECT pg_try_advisory_lock(hashtextextended($1, 0::bigint)) AS acquired",
		[identity],
	);
	if (result.rows[0].acquired) {
		await observer.query(
			"SELECT pg_advisory_unlock(hashtextextended($1, 0::bigint))",
			[identity],
		);
		return false;
	}
	return true;
}

it("metadata transactions share the held session and every distinct identity stays locked through commit", async () => {
	await h.pool().query("CREATE TABLE proof (value text NOT NULL)");
	await connected(async (pool, observer) => {
		const a = `projects/a/${HASH}`,
			z = `projects/z/${HASH}`;
		await withMediaObjectKeyLocks(
			[`${z}.txt`, `${a}.md`, `${a}.extract.v2.md`],
			async (db) => {
				const first = (
					await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)
				).rows[0].pid;
				await db.transaction().execute(async (tx) => {
					expect(
						(
							await sql<{
								pid: number;
							}>`SELECT pg_backend_pid() AS pid`.execute(tx)
						).rows[0].pid,
					).toBe(first);
					await sql`INSERT INTO proof VALUES ('committed')`.execute(tx);
				});
				expect((await observer.query("SELECT value FROM proof")).rows).toEqual([
					{ value: "committed" },
				]);
				expect(await owns(observer, a)).toBe(true);
				expect(await owns(observer, z)).toBe(true);
				expect(
					(
						await observer.query<{ count: number }>(
							"SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND pid = $1",
							[first],
						)
					).rows[0].count,
				).toBe(2);
				expect(pool.totalCount).toBe(1);
			},
		);
		expect(await owns(observer, a)).toBe(false);
		expect(await owns(observer, z)).toBe(false);
		expect(pool.idleCount).toBe(1);
	});
});

it("acquires the first identity in global order before any later identity, regardless of input order", async () => {
	await connected(async (_pool, observer) => {
		const first = `projects/a/${HASH}`,
			last = `projects/z/${HASH}`;
		await whileBlocked(
			h,
			(pg) =>
				pg.query(
					"SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
					[first],
				),
			() =>
				withMediaObjectKeyLocks(
					[`${last}.txt`, `${first}.txt`],
					async () => "done",
				),
			async (settled) => {
				expect(settled).toBe(false);
				expect(await owns(observer, last)).toBe(false);
			},
		);
	});
});

it("a second extension waits for the same content lock and then runs after the first owner exits", async () => {
	await connected(async (_pool, observer) => {
		const release = Promise.withResolvers<void>();
		const order: string[] = [];
		let firstPid: number | undefined;
		const first = withMediaObjectKeyLock(
			`projects/a/${HASH}.txt`,
			async (db) => {
				firstPid = (
					await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)
				).rows[0].pid;
				order.push("txt");
				await release.promise;
				order.push("txt closed");
			},
		);
		const settledFirst = Promise.allSettled([first]);
		let settledBoth: Promise<PromiseSettledResult<void>[]> = settledFirst;
		try {
			await until(async () => {
				await observer.query("SELECT 1");
				return firstPid !== undefined;
			});
			const second = withMediaObjectKeyLock(
				`projects/a/${HASH}.md`,
				async () => {
					order.push("md");
				},
			);
			settledBoth = Promise.allSettled([first, second]);
			await until(async () => {
				const waiting = await observer.query<{ count: number }>(
					"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
					[firstPid],
				);
				return waiting.rows[0].count === 1;
			});
			expect(order).toEqual(["txt"]);
			release.resolve();
			expect(await settledBoth).toEqual([
				{ status: "fulfilled", value: undefined },
				{ status: "fulfilled", value: undefined },
			]);
			expect(order).toEqual(["txt", "txt closed", "md"]);
		} finally {
			release.resolve();
			await settledBoth;
		}
	});
});

it("admits two long-lived owners while leaving the third pool connection usable for ordinary SQL", async () => {
	await connected(async (pool, observer) => {
		const release = Promise.withResolvers<void>();
		let active = 0,
			peak = 0;
		const results = Promise.allSettled(
			["a", "b", "c"].map((key) =>
				withMediaObjectKeyLock(key, async () => {
					active++;
					peak = Math.max(peak, active);
					try {
						await release.promise;
					} finally {
						active--;
					}
				}),
			),
		);
		try {
			await until(async () => {
				await observer.query("SELECT 1");
				return active >= 2;
			});
			expect(active).toBe(2);
			expect(pool.totalCount).toBe(2);
			expect((await pool.query("SELECT 42 AS answer")).rows).toEqual([
				{ answer: 42 },
			]);
			expect(pool.totalCount).toBe(3);
			expect(active).toBe(2);
			release.resolve();
			expect(await results).toEqual(
				Array.from({ length: 3 }, () => ({
					status: "fulfilled",
					value: undefined,
				})),
			);
			expect(peak).toBe(2);
			expect(active).toBe(0);
		} finally {
			release.resolve();
			await results;
		}
	});
});

it("releases all locks and preserves the original body failure", async () => {
	await connected(async (pool, observer) => {
		const failure = new Error("body rejected");
		await expect(
			withMediaObjectKeyLocks(["a", "b"], async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(await owns(observer, "a")).toBe(false);
		expect(await owns(observer, "b")).toBe(false);
		expect(pool.idleCount).toBe(1);
		await expect(withMediaObjectKeyLock("a", async () => "next")).resolves.toBe(
			"next",
		);
	});
});

it("connection loss between queries fails the owner and a subsequent operation gets a healthy session", async () => {
	await connected(async (_pool, observer) => {
		let lostPid: number | undefined;
		await expect(
			withMediaObjectKeyLock("lost", async (db) => {
				lostPid = (
					await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)
				).rows[0].pid;
				await observer.query("SELECT pg_terminate_backend($1)", [lostPid]);
				return "cannot succeed without the lock";
			}),
		).rejects.toThrow(/terminat|queryable/i);
		const freshPid = await withMediaObjectKeyLock(
			"lost",
			async (db) =>
				(await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db))
					.rows[0].pid,
		);
		expect(freshPid).not.toBe(lostPid);
		expect(await owns(observer, "lost")).toBe(false);
	});
});

it("a reset that silently released session locks is a failure and discards that connection", async () => {
	await connected(async (_pool, observer) => {
		let resetPid: number | undefined;
		await expect(
			withMediaObjectKeyLock("reset", async (db) => {
				resetPid = (
					await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)
				).rows[0].pid;
				await sql`SELECT pg_advisory_unlock_all()`.execute(db);
			}),
		).rejects.toThrow("advisory unlock reported no held lock");
		const freshPid = await withMediaObjectKeyLock(
			"reset",
			async (db) =>
				(await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db))
					.rows[0].pid,
		);
		expect(freshPid).not.toBe(resetPid);
		expect(await owns(observer, "reset")).toBe(false);
	});
});

it("rejects an empty request without acquiring a database session or invoking its body", async () => {
	await connected(async (pool) => {
		let called = false;
		await expect(
			withMediaObjectKeyLocks([], async () => {
				called = true;
			}),
		).rejects.toThrow("at least one media object key");
		expect(called).toBe(false);
		expect(pool.totalCount).toBe(0);
	});
});
