import { describe, expect, it } from "vitest";
import {
	beginSearch,
	NOT_SEARCHED,
	noMatchesActionAvailable,
	recordRegisteredCase,
	recordSearchDeviceValues,
	settleSearch,
} from "../previewSearchState";
import type { PreviewSearchState } from "../types";

const answers = { patient_name: "Zzz", search_time: "2026-09-04T10:00:00Z" };

describe("previewSearchState", () => {
	it("begins a first search at attempt 1 with the worker's answers", () => {
		expect(beginSearch(undefined, answers)).toEqual({
			kind: "running",
			attempt: 1,
			answers,
		});
		expect(beginSearch(NOT_SEARCHED, answers)).toEqual({
			kind: "running",
			attempt: 1,
			answers,
		});
	});

	it("numbers a later search after the last one, whatever it settled to", () => {
		const completed: PreviewSearchState = {
			kind: "completed",
			attempt: 3,
			answers,
			matchCount: 0,
		};
		expect(beginSearch(completed, { patient_name: "A" })).toMatchObject({
			attempt: 4,
		});
		const failed: PreviewSearchState = {
			kind: "failed",
			attempt: 2,
			answers,
			reason: "error",
		};
		expect(beginSearch(failed, answers)).toMatchObject({ attempt: 3 });
	});

	it("settles the running attempt to completed with its match count", () => {
		const running = beginSearch(undefined, answers);
		expect(
			settleSearch(running, 1, { kind: "completed", matchCount: 0 }),
		).toEqual({ kind: "completed", attempt: 1, answers, matchCount: 0 });
		expect(
			settleSearch(running, 1, { kind: "completed", matchCount: 12 }),
		).toEqual({ kind: "completed", attempt: 1, answers, matchCount: 12 });
	});

	it("settles the running attempt to failed with its reason", () => {
		const running = beginSearch(undefined, answers);
		expect(
			settleSearch(running, 1, { kind: "failed", reason: "invalid-search" }),
		).toEqual({
			kind: "failed",
			attempt: 1,
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
		const empty = settleSearch(beginSearch(undefined, answers), 1, {
			kind: "completed",
			matchCount: 0,
		});
		const registered = recordRegisteredCase(empty, "case-new");
		expect(registered).toEqual({
			kind: "completed",
			attempt: 1,
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
			beginSearch(undefined, answers),
			1,
			first,
		);
		expect(running).toMatchObject({ deviceValues: { value: first } });
		expect(recordSearchDeviceValues(running, 1, later)).toBe(running);
		expect(
			settleSearch(running, 1, { kind: "completed", matchCount: 2 }),
		).toEqual({
			kind: "completed",
			attempt: 1,
			answers,
			matchCount: 2,
			deviceValues: { value: first },
		});
	});

	it("records nothing for another attempt, and a new search starts without", () => {
		const running = beginSearch(undefined, answers);
		expect(recordSearchDeviceValues(running, 2, first)).toBe(running);
		const settled = settleSearch(
			recordSearchDeviceValues(running, 1, first),
			1,
			{ kind: "completed", matchCount: 0 },
		);
		expect(beginSearch(settled, answers)).not.toHaveProperty("deviceValues");
	});

	it("keeps a search with no row to fold apart from one not worked out", () => {
		expect(
			recordSearchDeviceValues(beginSearch(undefined, answers), 1, undefined),
		).toMatchObject({ deviceValues: { value: undefined } });
	});
});
