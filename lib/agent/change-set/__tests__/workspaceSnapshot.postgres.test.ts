import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import {
	beginWork,
	executeWorkTool,
	getWorkSnapshot,
} from "@/lib/agent/authoring/session";
import { getAuthDb } from "@/lib/auth/db";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { CommitReauthError } from "@/lib/db/commitGuard";
import { ChangeSetIntegrityError } from "../errors";
import * as runtime from "../runtime";

const h = setupAppStateTestDb("workspace_snapshot_", {
	authSchema: "migrated",
	poolMax: 4,
});

async function pendingWork() {
	const actorUserId = "snapshot-author";
	const projectId = "snapshot-project";
	const host = { kind: "mcp" } as const;
	await h.seedProjectMember(actorUserId, projectId, "owner");
	const work = await beginWork({
		actorUserId,
		projectId,
		host,
		target: { name: "Original" },
		requestId: "begin",
	});
	const args = { actorUserId, host, workId: work.workId };
	await executeWorkTool({
		...args,
		requestId: "initial-name",
		toolName: "updateApp",
		input: { name: "Before append" },
	});
	return args;
}

function settle<T>(pending: Promise<T>) {
	return pending.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

it("reads one authorized revision while a concurrent MCP call appends to the candidate", async () => {
	const args = await pendingWork();
	const before = await getWorkSnapshot(args);
	const reachedRead = Promise.withResolvers<void>();
	const releaseRead = Promise.withResolvers<void>();
	const rehydrate = runtime.rehydrateChangeSet;
	// Pause only scheduling at the real replay boundary; authority, SQL reads,
	// stored mutations, and replay all remain production implementations.
	const pausedRead = vi
		.spyOn(runtime, "rehydrateChangeSet")
		.mockImplementationOnce(async (...input) => {
			reachedRead.resolve();
			await releaseRead.promise;
			return rehydrate(...input);
		});
	const read = settle(getWorkSnapshot(args));
	let write:
		| ReturnType<typeof settle<Awaited<ReturnType<typeof executeWorkTool>>>>
		| undefined;
	try {
		await Promise.race([
			reachedRead.promise,
			read.then((result) => {
				if (!result.ok) throw result.error;
				throw new Error("The read did not reach the replay boundary.");
			}),
		]);
		let writeSettled = false;
		write = settle(
			executeWorkTool({
				...args,
				requestId: "concurrent-name",
				toolName: "updateApp",
				input: { name: "After append" },
			}),
		).then((result) => {
			writeSettled = true;
			return result;
		});
		await expect
			.poll(async () => {
				const { rows } = await sql<{ blocked: number }>`
				SELECT count(*)::int AS blocked
				FROM pg_stat_activity
				WHERE datname = current_database()
				AND query LIKE '%"authoring_sessions"%'
				AND wait_event_type = 'Lock'
				AND cardinality(pg_blocking_pids(pid)) > 0
			`.execute(h.db());
				return writeSettled || rows[0].blocked > 0;
			})
			.toBe(true);
		expect(writeSettled).toBe(false);
		releaseRead.resolve();
		const readResult = await read;
		if (!readResult.ok) throw readResult.error;
		expect(readResult.value.revision).toBe(before.revision);
		expect(readResult.value.doc.appName).toBe("Before append");
		const writeResult = await write;
		if (!writeResult.ok) throw writeResult.error;
		expect(writeResult.value).toMatchObject({ result: { ok: true } });
		const after = await getWorkSnapshot(args);
		expect(after.revision).toBe(before.revision + 1);
		expect(after.doc.appName).toBe("After append");
	} finally {
		releaseRead.resolve();
		await read;
		if (write) await write;
		pausedRead.mockRestore();
	}
});

it("still rejects corrupted steps and checks current authority before exposing them", async () => {
	const args = await pendingWork();
	const candidate = await h
		.db()
		.selectFrom("authoring_workspaces")
		.select("id")
		.where("authoring_session_id", "=", args.workId)
		.executeTakeFirstOrThrow();
	await h
		.db()
		.updateTable("authoring_steps")
		.set({ mutation_digest: "0".repeat(64) })
		.where("change_set_id", "=", candidate.id)
		.execute();
	await expect(getWorkSnapshot(args)).rejects.toBeInstanceOf(
		ChangeSetIntegrityError,
	);
	await (await getAuthDb())
		.deleteFrom("auth_member")
		.where("userId", "=", args.actorUserId)
		.execute();
	await expect(getWorkSnapshot(args)).rejects.toBeInstanceOf(CommitReauthError);
});
