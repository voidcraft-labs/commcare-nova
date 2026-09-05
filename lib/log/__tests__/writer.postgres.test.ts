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
import { testUuid } from "@/__tests__/helpers/uuid";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { Mutation } from "@/lib/doc/types";
import {
	lookupOptionsSourceSchema,
	type SelectOptionsSource,
} from "@/lib/domain";
import { readEvents } from "../reader";
import type { Event } from "../types";
import { LogWriter } from "../writer";

const h = setupAppStateTestDb("log_writer_");

const APP = "app-writer-int";
const LOOKUP_FIELD = testUuid("30000000-0000-4000-8000-000000000000");
const LOOKUP_SOURCE_A = lookupOptionsSourceSchema.parse({
	kind: "lookup",
	tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
	valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
	labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
});
const LOOKUP_SOURCE_B = lookupOptionsSourceSchema.parse({
	kind: "lookup",
	tableId: "018f3e8a-7b2c-7def-8abc-1234567890ac",
	valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890af",
	labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890b0",
});
const INLINE_SOURCE: SelectOptionsSource = {
	kind: "inline",
	options: [
		{
			uuid: testUuid("inline-a"),
			value: "a",
			label: { parts: [{ kind: "text", text: "A" }] },
		},
		{
			uuid: testUuid("inline-b"),
			value: "b",
			label: { parts: [{ kind: "text", text: "B" }] },
		},
	],
};

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

function lookupSourceMutation(optionsSource: SelectOptionsSource): Mutation {
	return {
		kind: "updateField",
		uuid: LOOKUP_FIELD,
		targetKind: "single_select",
		patch: { optionsSource },
	};
}

function lookupMutationEvent(
	seq: number,
	optionsSource: SelectOptionsSource,
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

	it("round-trips lookup-source set, replace, and inline-source replacement through the Postgres writer and reader", async () => {
		const carrierEvents = [
			lookupMutationEvent(0, LOOKUP_SOURCE_A),
			lookupMutationEvent(1, LOOKUP_SOURCE_B),
			lookupMutationEvent(2, INLINE_SOURCE),
		];
		const inputReplacement = carrierEvents[2];
		if (inputReplacement?.kind !== "mutation") {
			throw new Error("input replacement event is missing");
		}
		if (
			inputReplacement.mutation.kind !== "updateField" ||
			inputReplacement.mutation.targetKind !== "single_select"
		) {
			throw new Error("input replacement is not a select-field update");
		}
		expect(inputReplacement.mutation.patch).toHaveProperty(
			"optionsSource",
			INLINE_SOURCE,
		);

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
		expect(
			storedMutations.map(
				(mutation) =>
					(mutation.patch as Record<string, unknown>)?.optionsSource,
			),
		).toEqual([LOOKUP_SOURCE_A, LOOKUP_SOURCE_B, INLINE_SOURCE]);

		/* readEvents performs the production jsonb decode plus canonical
		 * mutationSchema validation and never returns partial history. */
		const read = await readEvents(APP, "run-lookup-carriers");
		expect(read).toHaveLength(3);
		const decodedMutations = read.map((event) => {
			if (event.kind !== "mutation") {
				throw new Error("decoded carrier event is not a mutation");
			}
			return event.mutation;
		});
		expect(
			decodedMutations.map((mutation) =>
				mutation.kind === "updateField" &&
				mutation.targetKind === "single_select"
					? mutation.patch.optionsSource
					: undefined,
			),
		).toEqual([LOOKUP_SOURCE_A, LOOKUP_SOURCE_B, INLINE_SOURCE]);
		const decodedReplacement = decodedMutations[2];
		if (
			decodedReplacement?.kind !== "updateField" ||
			decodedReplacement.targetKind !== "single_select"
		) {
			throw new Error("decoded replacement updateField mutation is missing");
		}
		expect(decodedReplacement.patch.optionsSource).toEqual(INLINE_SOURCE);
	});
});
