import { describe, expect, it } from "vitest";
import {
	beginSearch,
	NOT_SEARCHED,
	newSearchSubmission,
	noMatchesActionAvailable,
	recordRegisteredCase,
	recordSearchDeviceValues,
	searchesAwaitingDeviceValues,
	settleSearch,
} from "../previewSearchState";
import type { PreviewSearchState } from "../types";

const answers = { patient_name: "Zzz", search_time: "2026-09-04T10:00:00Z" };

describe("previewSearchState", () => {
	it("begins a first search at attempt 1 with the worker's answers", () => {
		expect(beginSearch(undefined, answers, "s1")).toEqual({
			kind: "running",
			attempt: 1,
			submission: "s1",
			answers,
		});
		expect(beginSearch(NOT_SEARCHED, answers, "s1")).toEqual({
			kind: "running",
			attempt: 1,
			submission: "s1",
			answers,
		});
	});

	it("numbers a later search after the last one, whatever it settled to", () => {
		const completed: PreviewSearchState = {
			kind: "completed",
			attempt: 3,
			submission: "s3",
			answers,
			matchCount: 0,
		};
		expect(beginSearch(completed, { patient_name: "A" })).toMatchObject({
			attempt: 4,
		});
		const failed: PreviewSearchState = {
			kind: "failed",
			attempt: 2,
			submission: "s2",
			answers,
			reason: "error",
		};
		expect(beginSearch(failed, answers)).toMatchObject({ attempt: 3 });
	});

	it("settles the running attempt to completed with its match count", () => {
		const running = beginSearch(undefined, answers, "s1");
		const completed = { kind: "completed", attempt: 1, submission: "s1" };
		expect(
			settleSearch(running, 1, { kind: "completed", matchCount: 0 }),
		).toEqual({ ...completed, answers, matchCount: 0 });
		expect(
			settleSearch(running, 1, { kind: "completed", matchCount: 12 }),
		).toEqual({ ...completed, answers, matchCount: 12 });
	});

	it("settles the running attempt to failed with its reason", () => {
		const running = beginSearch(undefined, answers, "s1");
		expect(
			settleSearch(running, 1, { kind: "failed", reason: "invalid-search" }),
		).toEqual({
			kind: "failed",
			attempt: 1,
			submission: "s1",
			answers,
			reason: "invalid-search",
		});
	});

	it("ignores a settlement for a stale attempt or when nothing runs", () => {
		const second = beginSearch(beginSearch(undefined, answers), answers);
		expect(second.kind === "running" && second.attempt).toBe(2);
		expect(settleSearch(second, 1, { kind: "completed", matchCount: 0 })).toBe(
			second,
		);
		const completed = settleSearch(second, 2, {
			kind: "completed",
			matchCount: 0,
		});
		expect(
			settleSearch(completed, 2, { kind: "completed", matchCount: 5 }),
		).toBe(completed);
		expect(
			settleSearch(undefined, 1, { kind: "failed", reason: "error" }),
		).toBe(undefined);
	});

	it("offers registration only on a completed search that found nothing", () => {
		expect(noMatchesActionAvailable(undefined)).toBe(false);
		expect(noMatchesActionAvailable(NOT_SEARCHED)).toBe(false);
		const running = beginSearch(undefined, answers);
		expect(noMatchesActionAvailable(running)).toBe(false);
		expect(
			noMatchesActionAvailable(
				settleSearch(running, 1, { kind: "failed", reason: "error" }),
			),
		).toBe(false);
		expect(
			noMatchesActionAvailable(
				settleSearch(running, 1, { kind: "completed", matchCount: 2 }),
			),
		).toBe(false);
		expect(
			noMatchesActionAvailable(
				settleSearch(running, 1, { kind: "completed", matchCount: 0 }),
			),
		).toBe(true);
	});

	it("records the registered case as the one match of the same attempt", () => {
		const empty = settleSearch(beginSearch(undefined, answers, "s1"), 1, {
			kind: "completed",
			matchCount: 0,
		});
		const registered = recordRegisteredCase(empty, "case-new");
		expect(registered).toEqual({
			kind: "completed",
			attempt: 1,
			submission: "s1",
			answers,
			matchCount: 1,
			registeredCaseId: "case-new",
		});
		// Registration closes the no-matches door for this attempt.
		expect(noMatchesActionAvailable(registered)).toBe(false);
	});

	it("records a registration with no search context as a fresh completed attempt", () => {
		expect(recordRegisteredCase(undefined, "case-new")).toEqual({
			kind: "completed",
			attempt: 1,
			submission: expect.any(String),
			answers: {},
			matchCount: 1,
			registeredCaseId: "case-new",
		});
	});
});

// A device works out a search's `_xpath_query` rows once, as it sends the
// search, and keeps that query for the session's query step: Results and the
// module's forms read the value kept with the attempt.
describe("a search's device values", () => {
	const first = { segments: { '0:["right"]': "North" }, choices: {} };
	const later = { segments: { '0:["right"]': "South" }, choices: {} };

	it("keeps the first value for the attempt and carries it to the settled search", () => {
		const running = recordSearchDeviceValues(
			beginSearch(undefined, answers, "s1"),
			"s1",
			first,
		);
		expect(running).toMatchObject({ deviceValues: { value: first } });
		expect(recordSearchDeviceValues(running, "s1", later)).toBe(running);
		expect(
			settleSearch(running, 1, { kind: "completed", matchCount: 2 }),
		).toEqual({
			kind: "completed",
			attempt: 1,
			submission: "s1",
			answers,
			matchCount: 2,
			deviceValues: { value: first },
		});
	});

	it("records nothing for another search, and a new search starts without", () => {
		const running = beginSearch(undefined, answers, "s1");
		expect(recordSearchDeviceValues(running, "s2", first)).toBe(running);
		const settled = settleSearch(
			recordSearchDeviceValues(running, "s1", first),
			1,
			{ kind: "completed", matchCount: 0 },
		);
		expect(beginSearch(settled, answers)).not.toHaveProperty("deviceValues");
	});

	it("keeps a search retired by Search again apart from the next, whose count starts over", () => {
		// Search again clears the module's search, so the next search is
		// attempt 1 again: its values are its own, never the last search's.
		const retired = recordSearchDeviceValues(
			beginSearch(undefined, answers, "s1"),
			"s1",
			first,
		);
		expect(retired).toMatchObject({ deviceValues: { value: first } });
		const next = beginSearch(undefined, answers);
		if (next.kind === "not-searched") throw new Error("Not begun.");
		expect(next.attempt).toBe(1);
		expect(next.submission).not.toBe("s1");
		// The retired search's evaluation, arriving late, lands nowhere.
		expect(recordSearchDeviceValues(next, "s1", first)).toBe(next);
		expect(
			recordSearchDeviceValues(next, next.submission, later),
		).toMatchObject({ attempt: 1, deviceValues: { value: later } });
	});

	it("keeps a search with no row to fold apart from one not worked out", () => {
		expect(
			recordSearchDeviceValues(
				beginSearch(undefined, answers, "s1"),
				"s1",
				undefined,
			),
		).toMatchObject({ deviceValues: { value: undefined } });
	});
});

// The session works a search's values out from its Search press, whatever
// screen shows: a search waits for them while it runs, and once recorded
// (and carried to the settled search) nothing works them out again, so no
// value is ever read from the device's cases after a claim.
describe("the searches awaiting the device's values", () => {
	const value = { segments: { '0:["right"]': "North" }, choices: {} };

	it("lists a pressed search until its values are recorded, then never again", () => {
		const running = beginSearch(undefined, answers, "s1");
		expect(searchesAwaitingDeviceValues({ m1: running })).toEqual([
			{ moduleUuid: "m1", submission: "s1", answers },
		]);
		const recorded = recordSearchDeviceValues(running, "s1", value);
		if (recorded === undefined) throw new Error("Not recorded.");
		expect(searchesAwaitingDeviceValues({ m1: recorded })).toEqual([]);
		const completed = settleSearch(recorded, 1, {
			kind: "completed",
			matchCount: 1,
		});
		if (completed === undefined) throw new Error("Not settled.");
		expect(completed).toMatchObject({ deviceValues: { value } });
		expect(searchesAwaitingDeviceValues({ m1: completed })).toEqual([]);
	});

	it("never works out values for a settled search, nor the registered case", () => {
		// A completed search holds its values or is the registered case, read
		// by its id: neither is the session's to evaluate after the fact.
		const registered = recordRegisteredCase(
			beginSearch(undefined, answers, "s1"),
			"case-1",
		);
		expect(searchesAwaitingDeviceValues({ m1: registered })).toEqual([]);
		const failed = settleSearch(beginSearch(undefined, answers, "s2"), 1, {
			kind: "failed",
			reason: "invalid-search",
		});
		if (failed === undefined) throw new Error("Not settled.");
		expect(searchesAwaitingDeviceValues({ m2: failed })).toEqual([]);
	});

	it("lists each module's search apart", () => {
		expect(
			searchesAwaitingDeviceValues({
				m1: beginSearch(undefined, answers, "s1"),
				m2: recordSearchDeviceValues(
					beginSearch(undefined, answers, "s2"),
					"s2",
					value,
				) as PreviewSearchState,
			}).map((search) => search.moduleUuid),
		).toEqual(["m1"]);
	});
});

describe("a search's identity", () => {
	it("is made without crypto.randomUUID, which only a secure context holds", () => {
		const own = Object.getOwnPropertyDescriptor(
			globalThis.crypto,
			"randomUUID",
		);
		Object.defineProperty(globalThis.crypto, "randomUUID", {
			value: undefined,
			configurable: true,
		});
		try {
			const ids = new Set([newSearchSubmission(), newSearchSubmission()]);
			expect(ids.size).toBe(2);
		} finally {
			if (own === undefined)
				Reflect.deleteProperty(globalThis.crypto, "randomUUID");
			else Object.defineProperty(globalThis.crypto, "randomUUID", own);
		}
	});
});
