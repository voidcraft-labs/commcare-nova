/**
 * Integration tests for the event-log reader, against a real Postgres (the
 * per-test-database harness). Seeds `events` rows directly, then exercises the
 * reader's contract: `readEvents` filters by `(app_id, run_id)` and orders by
 * `(ts, seq)` and drops-but-counts a drifted payload; `readLatestRunId` reads
 * the newest run off the `run_id` COLUMN (never the payload); and
 * `decodeEventsLenient` isolates an unparseable row from the valid ones around
 * it.
 *
 * `readRunSummary` is a thin delegate to `lib/db/runSummary.ts::loadRunSummary`
 * — its behavior is covered by that module's own tests, not duplicated here.
 *
 * Runs unconditionally under `npm test` (the case-store testcontainer boots in
 * `globalSetup`).
 */
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { decodeEventsLenient, readEvents, readLatestRunId } from "../reader";
import type { Event } from "../types";

const h = setupAppStateTestDb("log_reader_");

const APP = "app-reader-int";

function mutationEvent(seq: number, ts: number, runId: string): Event {
	return {
		kind: "mutation",
		runId,
		ts,
		seq,
		source: "chat",
		actor: "agent",
		stage: "app",
		mutation: { kind: "setAppName", name: `n-${seq}` },
	};
}

/** Insert one `events` row; `payloadOverride` lets a test store a jsonb payload
 *  that will fail `eventSchema` while keeping valid envelope columns. */
async function insertEvent(
	ev: Event,
	payloadOverride?: unknown,
): Promise<void> {
	await h
		.db()
		.insertInto("events")
		.values({
			app_id: APP,
			run_id: ev.runId,
			ts: ev.ts,
			seq: ev.seq,
			source: ev.source,
			kind: ev.kind,
			event: JSON.stringify(payloadOverride ?? ev),
		})
		.execute();
}

describe("readEvents", () => {
	it("returns one run's events sorted by (ts, seq), filtering out other runs", async () => {
		/* Insert out of chronological order + a foreign run so the query's
		 * WHERE + ORDER BY both have to do real work. */
		await insertEvent(mutationEvent(2, 11, "r1"));
		await insertEvent(mutationEvent(0, 10, "r1"));
		await insertEvent(mutationEvent(1, 10, "r1"));
		await insertEvent(mutationEvent(0, 10, "r2"));

		const { events, skipped } = await readEvents(APP, "r1");

		expect(skipped).toBe(0);
		expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
		expect(events.every((e) => e.runId === "r1")).toBe(true);
	});

	it("returns empty events + zero skipped for a run with no rows", async () => {
		expect(await readEvents(APP, "no-such-run")).toEqual({
			events: [],
			skipped: 0,
		});
	});

	it("drops an unparseable payload and counts it, keeping the valid rows", async () => {
		await insertEvent(mutationEvent(0, 10, "r1"));
		/* Envelope columns valid, but the jsonb payload fails `eventSchema`
		 * (unknown `kind`) — the forward-version / schema-drift case. */
		await insertEvent(mutationEvent(1, 11, "r1"), {
			kind: "bogus-future-kind",
			runId: "r1",
			ts: 11,
			seq: 1,
			source: "chat",
		});
		await insertEvent(mutationEvent(2, 12, "r1"));

		const { events, skipped } = await readEvents(APP, "r1");

		expect(skipped).toBe(1);
		expect(events.map((e) => e.seq)).toEqual([0, 2]);
	});
});

describe("readLatestRunId", () => {
	it("returns the run id of the most recent event by ts", async () => {
		await insertEvent(mutationEvent(0, 10, "older"));
		await insertEvent(mutationEvent(0, 99, "newer"));
		await insertEvent(mutationEvent(1, 50, "older"));

		expect(await readLatestRunId(APP)).toBe("newer");
	});

	it("returns null when the app has no events", async () => {
		expect(await readLatestRunId("app-with-no-events")).toBeNull();
	});

	it("reads run_id off the column, surviving a drifted newest payload", async () => {
		/* The newest row's payload would fail `eventSchema`, but `run_id` is a
		 * real column present regardless — the read must still resolve it. */
		await insertEvent(mutationEvent(0, 10, "old-run"));
		await insertEvent(mutationEvent(0, 99, "latest-run"), {
			kind: "bogus-future-kind",
			runId: "latest-run",
			ts: 99,
			seq: 0,
			source: "chat",
		});

		expect(await readLatestRunId(APP)).toBe("latest-run");
	});
});

describe("decodeEventsLenient", () => {
	/**
	 * The core resilience contract: a raw payload that fails `eventSchema`
	 * (forward-version / schema drift) is dropped and counted, while the valid
	 * payloads around it still decode.
	 */
	it("drops payloads that fail the schema and keeps the valid ones", () => {
		const good = mutationEvent(0, 1, "r");
		const { events, skipped, sample } = decodeEventsLenient([
			good,
			{ kind: "attachment-prep-but-wrong-shape" },
			good,
			42,
		]);
		expect(events).toEqual([good, good]);
		expect(skipped).toBe(2);
		expect(typeof sample).toBe("string");
	});

	it("returns zero skipped for an all-valid page", () => {
		const good = mutationEvent(0, 1, "r");
		expect(decodeEventsLenient([good, good])).toEqual({
			events: [good, good],
			skipped: 0,
			sample: undefined,
		});
	});
});
