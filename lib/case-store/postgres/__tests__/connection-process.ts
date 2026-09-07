/** A real Node process: an unowned pg error must fail this scenario rather
 * than being absorbed by Vitest's own process error handlers. */
import { sql } from "kysely";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
	getCaseStorePool,
} from "../connection";

async function run() {
	const mode = process.argv[2];
	const db = await getCaseStoreDatabase();
	const pool = await getCaseStorePool();
	if (
		db !== (await getCaseStoreDatabase()) ||
		pool !== (await getCaseStorePool())
	)
		throw new Error("Runtime singleton changed");
	try {
		const client = await pool.connect();
		const {
			rows: [{ pid }],
		} = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
		const disconnected = new Promise<void>((resolve) =>
			client.once("end", resolve),
		);
		if (mode === "idle") client.release();
		// The parent terminates this exact backend; the long query is owned and
		// interrupted, never awaited as a wall-clock delay.
		const activeQuery =
			mode === "query"
				? client.query("SELECT pg_sleep(30)").then(
						() => false,
						() => true,
					)
				: null;
		process.send?.({ ready: pid });
		await disconnected;
		let rejected = false;
		if (mode !== "idle") {
			if (activeQuery !== null) rejected = await activeQuery;
			else {
				try {
					await client.query("SELECT 1");
				} catch {
					rejected = true;
				}
			}
			client.release();
		}
		const replacement = await sql<{
			pid: number;
			schema: string;
		}>`SELECT pg_backend_pid() AS pid, current_setting('search_path') AS schema`.execute(
			db,
		);
		process.send?.({
			done: { rejected, oldPid: pid, replacement: replacement.rows[0] },
		});
	} finally {
		await closeCaseStoreDatabase();
		await closeCaseStoreDatabase();
	}
}
run().then(
	() => process.disconnect?.(),
	(error) => {
		console.error(error);
		process.exitCode = 1;
		process.disconnect?.();
	},
);
