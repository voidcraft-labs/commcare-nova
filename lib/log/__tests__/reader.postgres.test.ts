/** Seed storage independently of LogWriter to test query scoping, ordering,
 * envelope-column lookup and atomic decoding of the complete event page. */
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { readEvents, readLatestRunId } from "../reader";
import type { Event } from "../types";

const h = setupAppStateTestDb("log_reader_");
const APP = "app-reader";
function event(seq: number, ts: number, runId = "run"): Event {
	return {
		kind: "mutation",
		runId,
		ts,
		seq,
		source: "chat",
		actor: "agent",
		mutation: { kind: "setAppName", name: `Name ${seq}` },
	};
}
async function insert(ev: Event, appId = APP, payload: unknown = ev) {
	await h
		.db()
		.insertInto("events")
		.values({
			app_id: appId,
			run_id: ev.runId,
			ts: ev.ts,
			seq: ev.seq,
			source: ev.source,
			kind: ev.kind,
			event: JSON.stringify(payload),
		})
		.execute();
}

it("returns only the requested app and run in timestamp then sequence order", async () => {
	const expected = [event(7, 10), event(8, 10), event(0, 11)];
	await insert(expected[2]);
	await insert(expected[1]);
	await insert(expected[0]);
	// Both filters must exclude a real row, not merely match an empty table.
	await insert(event(90, 10, "other-run"));
	await insert(event(91, 10), "other-app");
	expect(await readEvents(APP, "run")).toEqual(expected);
	expect(await readEvents(APP, "missing-run")).toEqual([]);
	expect(await readEvents("missing-app", "run")).toEqual([]);
});

it("rejects the entire page when a malformed payload separates valid neighbors", async () => {
	await insert(event(0, 10));
	await insert(event(1, 11), APP, { ...event(1, 11), kind: "unknown-event" });
	await insert(event(2, 12));
	await expect(readEvents(APP, "run")).rejects.toThrow();
	// A corrupt event in one run does not invalidate another run's history.
	const other = event(0, 15, "other-run");
	await insert(other);
	expect(await readEvents(APP, "other-run")).toEqual([other]);
});

it("finds the latest run by timestamp and app using columns even if the payload is undecodable", async () => {
	await insert(event(999, 10, "older"));
	await insert(event(0, 99, "latest"), APP, { kind: "unknown-event" });
	await insert(event(0, 200, "foreign"), "other-app");
	await insert(event(1000, 50, "older"));
	expect(await readLatestRunId(APP)).toBe("latest");
	expect(await readLatestRunId("other-app")).toBe("foreign");
	expect(await readLatestRunId("missing-app")).toBeNull();
});
