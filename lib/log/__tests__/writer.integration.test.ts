/**
 * Integration test for the LogWriter's default Postgres sink (`pgSink`),
 * against a real Postgres (the per-test-database harness). The batching /
 * flush / failure-isolation logic is covered by the injected-sink unit tests
 * in `writer.test.ts`; this file pins the ONE thing the default sink does that
 * a stub can't: the batch INSERT maps each `Event` onto the `events` columns
 * (`app_id` / `run_id` / `ts` / `seq` / `source` / `kind`, plus the full event
 * as `event` jsonb) and lands each as its own row with a server-assigned `id`.
 *
 * Runs unconditionally under `npm test` (the case-store testcontainer boots in
 * `globalSetup`).
 */
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { Event } from "../types";
import { LogWriter } from "../writer";

const h = setupAppStateTestDb("log_writer_");

const APP = "app-writer-int";

function mutationEvent(seq: number, runId = "run-1"): Event {
	return {
		kind: "mutation",
		runId,
		ts: 1000 + seq,
		seq,
		source: "chat",
		actor: "agent",
		stage: "app",
		mutation: { kind: "setAppName", name: `n-${seq}` },
	};
}

function conversationEvent(seq: number, runId = "run-1"): Event {
	return {
		kind: "conversation",
		runId,
		ts: 1000 + seq,
		seq,
		source: "chat",
		payload: { type: "user-message", text: "hi" },
	};
}

describe("LogWriter default pgSink", () => {
	it("inserts a batch into the events table with the envelope columns projected", async () => {
		const writer = new LogWriter(APP, "chat");
		writer.logEvent(mutationEvent(0));
		writer.logEvent(conversationEvent(1));
		await writer.flush();

		const rows = await h
			.db()
			.selectFrom("events")
			.selectAll()
			.where("app_id", "=", APP)
			.orderBy("seq")
			.execute();

		expect(rows).toHaveLength(2);

		/* Envelope columns projected out of the payload for filter/order. */
		expect(rows[0]).toMatchObject({
			app_id: APP,
			run_id: "run-1",
			seq: 0,
			source: "chat",
			kind: "mutation",
		});
		/* `ts` is a bigint column — pg returns it as a string. */
		expect(Number(rows[0].ts)).toBe(1000);
		/* The full event rides the `event` jsonb column (pg parses it back). */
		expect(rows[0].event).toMatchObject({
			kind: "mutation",
			seq: 0,
			mutation: { kind: "setAppName", name: "n-0" },
		});
		expect(rows[1]).toMatchObject({
			run_id: "run-1",
			seq: 1,
			kind: "conversation",
		});

		/* Server-assigned identity ids are distinct — collision-free by
		 * construction, so concurrent writers in one run never overwrite. */
		expect(rows[0].id).not.toBe(rows[1].id);
	});

	it("stamps the writer's own source onto persisted rows, overwriting the caller's", async () => {
		const writer = new LogWriter(APP, "mcp");
		/* Caller lies and says "chat"; a writer built with "mcp" must win both
		 * on the projected column and inside the persisted payload. */
		writer.logEvent({ ...mutationEvent(0), source: "chat" } as Event);
		await writer.flush();

		const row = await h
			.db()
			.selectFrom("events")
			.select(["source", "event"])
			.where("app_id", "=", APP)
			.executeTakeFirstOrThrow();

		expect(row.source).toBe("mcp");
		expect((row.event as { source: string }).source).toBe("mcp");
	});
});
