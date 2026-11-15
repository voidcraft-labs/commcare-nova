/**
 * Holding an app row from a session of the test's own, so a transaction under
 * test stops at the row it waits for. The database's own lock table says when
 * it is waiting, and PostgreSQL queues waiters on one row in the order they
 * asked, so a hold that asked after the transaction under test gets the row
 * after it, and before anything that asks later.
 */
import { Client } from "pg";

/** Wait until at least `minimum` locks in this database are asked for and not yet granted. */
export async function waitForBlockedLocks(
	observer: Client,
	minimum: number,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const result = await observer.query<{ count: string }>(`
			SELECT count(*)::text AS count
			FROM pg_locks AS locks
			JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
			WHERE activity.datname = current_database()
				AND NOT locks.granted
		`);
		if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${minimum} blocked database lock(s).`);
}

export interface HeldAppRow {
	/** Resolves once the row is held; rejects where asking for it failed. */
	acquired(): Promise<void>;
	/** Commit the hold's transaction, which lets the next waiter have the row. */
	release(): Promise<void>;
	/** Close the session. A hold still waiting for the row stops waiting. */
	end(): Promise<void>;
}

/**
 * Ask for `appId`'s row `FOR UPDATE` in a transaction of a new session. The
 * ask is sent before this returns, so a caller that waits for it to block
 * knows where it stands in the row's queue.
 */
export async function holdAppRow(
	uri: string,
	appId: string,
): Promise<HeldAppRow> {
	const client = new Client({ connectionString: uri });
	await client.connect();
	try {
		await client.query("BEGIN");
	} catch (error) {
		await client.end();
		throw error;
	}
	const asked = client
		.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [appId])
		.then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error }),
		);
	return {
		async acquired() {
			const { error } = await asked;
			if (error !== undefined) throw error;
		},
		async release() {
			await client.query("COMMIT");
		},
		async end() {
			await client.end();
			await asked;
		},
	};
}

/**
 * Run a transaction that starts again whenever what it read before its locks
 * changed under them, and change it under every try: each try stops at
 * `appId`'s row, held here; while it waits, the next change commits and the
 * next hold queues behind it; then the row goes to the try, which finds the
 * change, ends and starts again, and meets the next hold. Settles as `run`
 * settles.
 *
 * Every try must wait for `appId`'s row before any other row a change locks,
 * and no change may wait for a lock a try holds.
 */
export async function changeUnderEachTry<T>(input: {
	readonly uri: string;
	readonly appId: string;
	readonly run: () => Promise<T>;
	readonly changes: readonly (() => Promise<unknown>)[];
}): Promise<T> {
	const observer = new Client({ connectionString: input.uri });
	const holds: HeldAppRow[] = [];
	let running:
		| Promise<
				| { readonly ok: true; readonly value: T }
				| { readonly ok: false; readonly error: unknown }
		  >
		| undefined;
	try {
		await observer.connect();
		let held = await holdAppRow(input.uri, input.appId);
		holds.push(held);
		await held.acquired();
		running = input.run().then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		for (const [index, change] of input.changes.entries()) {
			// This try read the claims and waits for the held row.
			await waitForBlockedLocks(observer, 1);
			await change();
			const next =
				index < input.changes.length - 1
					? await holdAppRow(input.uri, input.appId)
					: null;
			if (next !== null) {
				holds.push(next);
				// The next hold queues behind the try.
				await waitForBlockedLocks(observer, 2);
			}
			await held.release();
			if (next !== null) {
				// The try had the row, found the change, and ended.
				await next.acquired();
				held = next;
			}
		}
		const result = await running;
		if (!result.ok) throw result.error;
		return result.value;
	} finally {
		// Closing a session ends its transaction and gives up what it holds,
		// so a try left waiting after a failure finishes before the test does.
		for (const hold of holds) await hold.end();
		await running;
		await observer.end();
	}
}
