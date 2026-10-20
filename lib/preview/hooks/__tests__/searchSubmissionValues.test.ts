// A search's device values are worked out once per submission and sent as
// they were kept: Results waits while they are pending, and a value kept for
// one submission is never sent for another.

import { describe, expect, it } from "vitest";
import {
	searchWorldReady,
	submittedSearchDeviceValues,
} from "../useSearchCsqlRuntime";

const submission = { key: "attempt:2", answers: new Map([["name", "Ada"]]) };
const value = { segments: { '0:["right"]': "Ada" }, choices: {} };

describe("submittedSearchDeviceValues", () => {
	it("sends nothing without a submission", () => {
		expect(submittedSearchDeviceValues(undefined, [])).toEqual({
			kind: "none",
		});
	});

	it("waits for a submission none were kept for", () => {
		expect(
			submittedSearchDeviceValues(submission, [
				undefined,
				{ key: "attempt:1", values: { value } },
			]),
		).toEqual({ kind: "pending" });
	});

	it("sends the values kept for the submission, the module's search first", () => {
		const kept = { value: { ...value, choices: { "0": true } } };
		expect(
			submittedSearchDeviceValues(submission, [
				{ key: "attempt:2", values: kept },
				{ key: "attempt:2", values: { value } },
			]),
		).toEqual({ kind: "ready", value: kept.value });
		expect(
			submittedSearchDeviceValues(submission, [
				undefined,
				{ key: "attempt:2", values: { value: undefined } },
			]),
		).toEqual({ kind: "ready", value: undefined });
	});
});

describe("searchWorldReady", () => {
	it("waits for the device's cases and for lookups still loading", () => {
		const cases = { rows: [], indices: [] };
		expect(searchWorldReady(null, { kind: "data" })).toBe(false);
		expect(searchWorldReady(cases, { kind: "loading" })).toBe(false);
		expect(searchWorldReady(cases, { kind: "idle" })).toBe(true);
		expect(searchWorldReady(cases, { kind: "error" })).toBe(true);
	});
});
