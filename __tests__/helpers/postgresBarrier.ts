import { Client as PgClient } from "pg";

/** Hold a real PostgreSQL lock until the operation is observed waiting behind it.
 * Both the operation and the connection are drained even if the assertion fails. */
export async function whileBlocked<T>(
	h: { uri(): string },
	hold: (pg: PgClient) => Promise<unknown>,
	start: () => Promise<T>,
	check: (settled: boolean, controller: PgClient) => Promise<void>,
	/** Release an operation-specific gate even if observing the SQL lock fails. */
	releasePending?: () => void | Promise<void>,
	/** Commit a competing writer after the blocked-state assertions. */
	releaseTransaction: "ROLLBACK" | "COMMIT" = "ROLLBACK",
): Promise<T> {
	const pg = new PgClient({ connectionString: h.uri() });
	let transactionOpen = false;
	let pending:
		| Promise<{ ok: true; value: T } | { ok: false; error: unknown }>
		| undefined;
	try {
		await pg.connect();
		await pg.query("BEGIN");
		transactionOpen = true;
		await hold(pg);
		const pid = (
			await pg.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
		).rows[0].pid;
		let settled = false;
		pending = start().then(
			(value) => {
				settled = true;
				return { ok: true as const, value };
			},
			(error: unknown) => {
				settled = true;
				return { ok: false as const, error };
			},
		);
		const deadline = Date.now() + 1000;
		for (;;) {
			// This controller holds a transaction. Refresh PostgreSQL's cached
			// activity snapshot so a newly connected waiter becomes visible.
			await pg.query("SELECT pg_stat_clear_snapshot()");
			const blocked = await pg.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
				[pid],
			);
			if (blocked.rows[0].count > 0) break;
			if (settled) {
				const outcome = await pending;
				if (!outcome.ok) throw outcome.error;
				throw new Error(
					"The operation completed before reaching the held database lock",
				);
			}
			if (Date.now() > deadline)
				throw new Error("The operation never reached the held database lock");
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		await check(settled, pg);
		await pg.query(releaseTransaction);
		transactionOpen = false;
		const outcome = await pending;
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	} finally {
		if (transactionOpen) await pg.query("ROLLBACK").catch(() => {});
		await releasePending?.();
		if (pending !== undefined) await pending;
		await pg.end();
	}
}
