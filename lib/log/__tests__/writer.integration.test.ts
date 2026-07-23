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
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type LookupOptionsSource,
	lookupOptionsSourceSchema,
} from "@/lib/domain";
import { readEvents } from "../reader";
import type { Event } from "../types";
import { LogWriter } from "../writer";

const h = setupAppStateTestDb("log_writer_");

const APP = "app-writer-int";
const LOOKUP_FIELD = asUuid("30000000-0000-4000-8000-000000000000");
const LOOKUP_SOURCE_A = lookupOptionsSourceSchema.parse({
	kind: "lookup-table",
	tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
	valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
	labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
});
const LOOKUP_SOURCE_B = lookupOptionsSourceSchema.parse({
	kind: "lookup-table",
	tableId: "018f3e8a-7b2c-7def-8abc-1234567890ac",
	valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890af",
	labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890b0",
});

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

function lookupSourceMutation(
	optionsSource: LookupOptionsSource | null,
): Mutation {
	return {
		kind: "updateField",
		uuid: LOOKUP_FIELD,
		targetKind: "single_select",
		patch: {},
		optionsSource,
	};
}

function lookupMutationEvent(
	seq: number,
	optionsSource: LookupOptionsSource | null,
): Event {
	return {
		kind: "mutation",
		runId: "run-lookup-carriers",
		ts: 2_000 + seq,
		seq,
		source: "chat",
		actor: "agent",
		stage: "lookup",
		mutation: lookupSourceMutation(optionsSource),
	};
}

function owns(value: object, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
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

	it("round-trips lookup-source set, replace, and explicit-null clear through the Postgres writer and reader", async () => {
		const carrierEvents = [
			lookupMutationEvent(0, LOOKUP_SOURCE_A),
			lookupMutationEvent(1, LOOKUP_SOURCE_B),
			lookupMutationEvent(2, null),
		];
		const inputClear = carrierEvents[2];
		if (inputClear?.kind !== "mutation") {
			throw new Error("input clear event is missing");
		}
		expect(owns(inputClear.mutation, "optionsSource")).toBe(true);
		expect(inputClear.mutation).toHaveProperty("optionsSource", null);

		const writer = new LogWriter(APP, "chat");
		for (const event of carrierEvents) writer.logEvent(event);
		await writer.flush();

		/* The writer's JSON.stringify → jsonb hop preserves all three top-level
		 * extensions, especially the clear's own null property. */
		const storedRows = await h
			.db()
			.selectFrom("events")
			.select("event")
			.where("app_id", "=", APP)
			.where("run_id", "=", "run-lookup-carriers")
			.orderBy("seq")
			.execute();
		expect(storedRows).toHaveLength(3);
		const storedMutations = storedRows.map((row) => {
			const event = row.event as {
				kind?: string;
				mutation?: Record<string, unknown>;
			};
			if (event.kind !== "mutation" || !event.mutation) {
				throw new Error("stored carrier MutationEvent is malformed");
			}
			return event.mutation;
		});
		expect(storedMutations.map((mutation) => mutation.optionsSource)).toEqual([
			LOOKUP_SOURCE_A,
			LOOKUP_SOURCE_B,
			null,
		]);
		expect(owns(storedMutations[2] ?? {}, "optionsSource")).toBe(true);
		expect(storedMutations[2]?.optionsSource).toBeNull();
		expect(storedMutations[2]?.patch).toEqual({});
		expect(storedMutations[2]?.patch).not.toHaveProperty("optionsSource");

		/* readEvents performs the production jsonb decode plus
		 * canonicalMutationSchema validation. A skipped clear would make the
		 * persisted run stream partial, so assert both the count and exact shape. */
		const read = await readEvents(APP, "run-lookup-carriers");
		expect(read.skipped).toBe(0);
		expect(read.events).toHaveLength(3);
		const decodedMutations = read.events.map((event) => {
			if (event.kind !== "mutation") {
				throw new Error("decoded carrier event is not a mutation");
			}
			return event.mutation;
		});
		expect(
			decodedMutations.map((mutation) =>
				"optionsSource" in mutation ? mutation.optionsSource : undefined,
			),
		).toEqual([LOOKUP_SOURCE_A, LOOKUP_SOURCE_B, null]);
		const decodedClear = decodedMutations[2];
		if (decodedClear?.kind !== "updateField") {
			throw new Error("decoded clear updateField mutation is missing");
		}
		expect(owns(decodedClear, "optionsSource")).toBe(true);
		expect(decodedClear).toHaveProperty("optionsSource", null);
		expect(decodedClear.patch).toEqual({});
		expect(decodedClear.patch).not.toHaveProperty("optionsSource");
	});
});
