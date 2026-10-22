// A search's device values are worked out once per submission and sent as
// they were kept: Results waits while they are pending, and a value kept for
// one submission is never sent for another.

import { describe, expect, it } from "vitest";
import {
	searchWorld,
	submittedSearchDeviceValues,
} from "../useSearchCsqlRuntime";

const submission = { key: "search-b", answers: new Map([["name", "Ada"]]) };
const value = { segments: { '0:["right"]': "Ada" }, choices: {} };

describe("submittedSearchDeviceValues", () => {
	it("sends nothing without a submission", () => {
		expect(submittedSearchDeviceValues(undefined, [], "ready")).toEqual({
			kind: "none",
		});
	});

	it("waits for a submission none were kept for", () => {
		expect(
			submittedSearchDeviceValues(
				submission,
				[undefined, { key: "search-a", values: { value } }],
				"ready",
			),
		).toEqual({ kind: "pending" });
	});

	it("sends the values kept for the submission, the module's search first", () => {
		const kept = { value: { ...value, choices: { "0": true } } };
		expect(
			submittedSearchDeviceValues(
				submission,
				[
					{ key: "search-b", values: kept },
					{ key: "search-b", values: { value } },
				],
				"ready",
			),
		).toEqual({ kind: "ready", value: kept.value });
		expect(
			submittedSearchDeviceValues(
				submission,
				[undefined, { key: "search-b", values: { value: undefined } }],
				"failed",
			),
		).toEqual({ kind: "ready", value: undefined });
	});

	it("fails a submission whose world failed to load, rather than waiting", () => {
		expect(submittedSearchDeviceValues(submission, [], "failed")).toEqual({
			kind: "unavailable",
		});
		expect(submittedSearchDeviceValues(submission, [], "waiting")).toEqual({
			kind: "pending",
		});
	});
});

describe("searchWorld", () => {
	const cases = { rows: [], indices: [] };
	const world = (
		readsCaseDatabase: boolean,
		deviceCases: typeof cases | null,
		deviceCasesLoad: "idle" | "loading" | "ready" | "error",
		lookup = "data",
	) =>
		searchWorld({
			readsCaseDatabase,
			deviceCases,
			deviceCasesLoad,
			lookup: { kind: lookup },
		});

	it("waits for the device's cases only for a search that reads them", () => {
		expect(world(true, null, "loading")).toBe("waiting");
		expect(world(true, cases, "ready")).toBe("ready");
		// An app whose forms read no cases never loads them: a search that
		// reads none sends at once.
		expect(world(false, null, "idle")).toBe("ready");
		expect(world(false, null, "loading")).toBe("ready");
	});

	it("fails a search that reads the device's cases when their load failed", () => {
		expect(world(true, null, "error")).toBe("failed");
		// A search that reads none is not held by their failure.
		expect(world(false, null, "error")).toBe("ready");
	});

	it("waits for lookups still loading", () => {
		expect(world(false, null, "idle", "loading")).toBe("waiting");
		expect(world(true, cases, "ready", "idle")).toBe("ready");
		expect(world(true, cases, "ready", "error")).toBe("ready");
	});
});
