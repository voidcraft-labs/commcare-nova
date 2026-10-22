// A form that reads what its search found waits on one load of it. A search
// its own inputs or settings refuse fails the same way on every try, so its
// refusal keeps the search's message and is no retryable load failure.

import { expect, it } from "vitest";
import { searchResultsLoadState } from "../useSearchResultsSnapshot";

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
