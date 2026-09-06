import { expect, it } from "vitest";
import { buildIsolatedDb, setupPerTestDatabase } from "./perTestDatabase";

const h = setupPerTestDatabase({ databaseNamePrefix: "pool_owner_" });
it.each(["idle", "checked out"])(
	"reports a failed %s fixture connection after closing its pool",
	async (mode) => {
		const owned = buildIsolatedDb(h.uri);
		const client = await owned.pool.connect();
		const {
			rows: [{ pid }],
		} = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
		const ended = new Promise<void>((resolve) => client.once("end", resolve));
		let released = false;
		try {
			if (mode === "idle") {
				client.release();
				released = true;
			}
			await h.pool.query("SELECT pg_terminate_backend($1)", [pid]);
			await ended;
			if (!released) {
				client.release();
				released = true;
			}
			await expect(owned.destroy()).rejects.toMatchObject({
				name: "AggregateError",
				message: "Test database connection failed",
				errors: [expect.objectContaining({ code: "57P01" })],
			});
			expect(owned.pool.ended).toBe(true);
			expect(
				(
					await h.pool.query(
						"SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
					)
				).rows,
			).toEqual([]);
		} finally {
			if (!released) client.release();
			if (!owned.pool.ended) await owned.pool.end();
		}
	},
);
it("closes direct pool use without requiring Kysely to initialize first", async () => {
	const owned = buildIsolatedDb(h.uri);
	try {
		await owned.pool.query("SELECT 1");
		await owned.destroy();
		expect(owned.pool.ended).toBe(true);
	} finally {
		if (!owned.pool.ended) await owned.pool.end();
	}
});
