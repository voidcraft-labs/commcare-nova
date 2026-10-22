// A form that reads what its search found waits on one load of it. A search
// its own inputs or settings refuse fails the same way on every try, so its
// refusal keeps the search's message and is no retryable load failure.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { SearchCsqlRuntimeWire } from "@/lib/preview/engine/searchCsqlRuntime";
import type { PreviewSearchState } from "@/lib/session/types";
import type { SubmissionValuesState } from "../useSearchCsqlRuntime";
import {
	searchResultsLoadState,
	searchResultsSnapshotKey,
} from "../useSearchResultsSnapshot";

it("keeps a refused search's own message apart from a failed load", () => {
	expect(
		searchResultsLoadState({
			kind: "invalid-search",
			message: "Patient name is required.",
		}),
	).toEqual({ kind: "invalid-search", message: "Patient name is required." });
	expect(
		searchResultsLoadState({
			kind: "error",
			message: "We couldn't load the cases. Try again.",
		}),
	).toEqual({
		kind: "error",
		message: "We couldn't load the cases. Try again.",
	});
});

// The form's snapshot and Results read one search: both are keyed by what the
// device worked out for its `_xpath_query` rows, so a value that arrives
// later (the device's cases, a lookup table) reads the snapshot again.
describe("searchResultsSnapshotKey", () => {
	const completed = (registeredCaseId?: string): PreviewSearchState => ({
		kind: "completed",
		attempt: 1,
		submission: "search-1",
		answers: { name: "Ada" },
		matchCount: 1,
		...(registeredCaseId === undefined ? {} : { registeredCaseId }),
	});
	const key = (
		csqlRuntime: SearchCsqlRuntimeWire | undefined | SubmissionValuesState,
		searchState: PreviewSearchState = completed(),
	) =>
		searchResultsSnapshotKey({
			ready: true,
			appId: "app",
			moduleUuid: testUuid("snapshot-module"),
			caseType: "patient",
			searchState,
			personaUuid: undefined,
			parentCase: undefined,
			deviceValues:
				csqlRuntime !== undefined && "kind" in csqlRuntime
					? csqlRuntime
					: { kind: "ready", value: csqlRuntime },
			retries: 0,
		});
	const before: SearchCsqlRuntimeWire = { segments: {}, choices: {} };
	const after: SearchCsqlRuntimeWire = {
		segments: { '0:["right"]': "red" },
		choices: {},
	};

	it("reads again when the device's values change, and not for the same content", () => {
		expect(key(after)).not.toBe(key(before));
		expect(key(undefined)).not.toBe(key(before));
		expect(key({ ...after })).toBe(key(after));
	});

	it("ignores the values for the registered case, whose read sends none", () => {
		expect(key(after, completed("case-1"))).toBe(
			key(before, completed("case-1")),
		);
	});

	it("waits for the completed search's values, never loading without them", () => {
		expect(key({ kind: "pending" })).toBeUndefined();
		expect(key({ kind: "unavailable" })).toBeUndefined();
		// The registered case's read sends none, so it waits for none.
		expect(key({ kind: "pending" }, completed("case-1"))).toBe(
			key(before, completed("case-1")),
		);
	});

	it("reads each search as its own, even where Search again restarted the count", () => {
		const again: PreviewSearchState = {
			kind: "completed",
			attempt: 1,
			submission: "search-2",
			answers: { name: "Ada" },
			matchCount: 1,
		};
		expect(key(after, again)).not.toBe(key(after));
	});

	it("starts no load before the search completes", () => {
		expect(
			key(after, {
				kind: "running",
				attempt: 1,
				submission: "search-1",
				answers: { name: "Ada" },
			}),
		).toBeUndefined();
	});
});
