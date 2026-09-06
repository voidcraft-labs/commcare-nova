import { fork } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
	getCaseStorePool,
} from "../connection";

const h = setupPerTestDatabase({
	databaseNamePrefix: "runtime_connection_",
	establishLocalMigrationAuthority: true,
});
it.each(["idle", "checked out", "query"])(
	"owns a terminated %s connection and recovers in the actual runtime process",
	async (mode) => {
		const child = fork(
			"lib/case-store/postgres/__tests__/connection-process.ts",
			[mode],
			{
				execArgv: ["--import", "tsx", "--conditions=react-server"],
				env: {
					...process.env,
					NOVA_DB_LOCAL_URL: h.uri,
					NOVA_DB_WORKLOAD: "service",
					NODE_ENV: "production",
				},
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		const ready = Promise.withResolvers<number>();
		let result:
			| {
					rejected: boolean;
					oldPid: number;
					replacement: { pid: number; schema: string };
			  }
			| undefined;
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.stdout?.resume();
		child.on("message", (message) => {
			if (typeof message !== "object" || message === null) return;
			if ("ready" in message && typeof message.ready === "number")
				ready.resolve(message.ready);
			if ("done" in message) result = message.done as typeof result;
		});
		const ended = new Promise<{ code: number | null; signal: string | null }>(
			(resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			},
		);
		try {
			const pid = await Promise.race([
				ready.promise,
				ended.then((exit) => {
					throw new Error(
						`Runtime exited before connecting: ${JSON.stringify(exit)}\n${stderr}`,
					);
				}),
			]);
			await h.pool.query("SELECT pg_terminate_backend($1)", [pid]);
			const exit = await ended;
			expect(exit, stderr).toEqual({ code: 0, signal: null });
			expect(result).toMatchObject({
				rejected: mode !== "idle",
				oldPid: pid,
				replacement: { schema: "public,nova_case_runtime" },
			});
			expect(result?.replacement.pid).not.toBe(pid);
			const errors = stderr
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line));
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({
				severity: "ERROR",
				message: "[case-store] database connection failed",
			});
			const remaining = await h.pool.query(
				"SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
			);
			expect(remaining.rows).toEqual([]);
		} finally {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await ended;
		}
	},
);

it("closes a pool used directly by auth even when Kysely never initialized", async () => {
	const pool = await getCaseStorePool();
	try {
		await pool.query("SELECT 1");
		await closeCaseStoreDatabase();
		expect(pool.ended).toBe(true);
	} finally {
		if (!pool.ended) await pool.end();
	}
});

it("waits for an in-flight initialization before closing its pool", async () => {
	const initializing = getCaseStorePool();
	const closing = closeCaseStoreDatabase();
	const pool = await initializing;
	try {
		await closing;
		expect(pool.ended).toBe(true);
	} finally {
		await closeCaseStoreDatabase();
		if (!pool.ended) await pool.end();
	}
});

it("shares concurrent shutdown and prevents a second pool from opening before the old checkout drains", async () => {
	const db = await getCaseStoreDatabase(),
		pool = await getCaseStorePool();
	await sql`SELECT 1`.execute(db);
	const held = await pool.connect();
	let firstClosed = false,
		secondClosed = false,
		opened = false;
	const first = closeCaseStoreDatabase().then(() => {
		firstClosed = true;
	});
	const second = closeCaseStoreDatabase().then(() => {
		secondClosed = true;
	});
	const reopening = getCaseStorePool().then((replacement) => {
		opened = true;
		return replacement;
	});
	try {
		await setImmediate();
		expect([firstClosed, secondClosed, opened]).toEqual([false, false, false]);
	} finally {
		held.release();
		await Promise.all([first, second]);
		const replacement = await reopening;
		try {
			expect(pool.ended).toBe(true);
			expect(replacement).not.toBe(pool);
			expect((await replacement.query("SELECT 7 AS value")).rows).toEqual([
				{ value: 7 },
			]);
		} finally {
			await closeCaseStoreDatabase();
			if (!replacement.ended) await replacement.end();
		}
	}
});
