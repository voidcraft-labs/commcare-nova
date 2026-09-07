import { describe, expect, it } from "vitest";
import type { CheckError } from "@/lib/domain/predicate";
import { presentCheckErrorForEditor } from "../checkErrorPresentation";

describe("PredicateCardEditor — user-facing diagnostics", () => {
	it.each([
		[
			"property",
			{ code: "unknown-property", path: ["left"] },
			"Choose available case information",
		],
		[
			"value type",
			{ code: "incompatible-values", path: ["right"] },
			"Choose values that use compatible kinds of information",
		],
		[
			"search question",
			{ code: "unknown-search-input", path: ["input"] },
			"Choose an available Search field",
		],
		[
			"relationship",
			{ code: "relation-path", path: ["via"] },
			"Choose an available connection to another case",
		],
		[
			"relationship destination",
			{ code: "relation-destination", path: ["via"] },
			"Choose a connection that leads to an available kind of case",
		],
		[
			"matching property",
			{ code: "match-value", path: ["property"] },
			"Choose other case information or a different matching method",
		],
		[
			"empty matching value",
			{ code: "match-value-empty", path: ["value"] },
			"Enter a value to match",
		],
		[
			"built-in case status",
			{ code: "case-status-value", path: ["right"] },
			"Use open or closed for built-in case status",
		],
	] as const)(
		"presents a next action for %s errors",
		(_label, finding, copy) => {
			const error: CheckError = {
				code: finding.code,
				path: [...finding.path],
				message: "Detailed checker prose that must stay out of the UI",
			};
			expect(presentCheckErrorForEditor(error)).toBe(copy);
		},
	);

	it.each([
		[["property"], "Choose available case information"],
		[["input"], "Choose an available Search field"],
		[["via"], "Choose an available connection to another case"],
		[["right"], "Choose a value that works here"],
	] as const)(
		"keeps a path-specific next action for an unknown diagnostic at %j",
		(path, copy) => {
			const futureError = {
				path: [...path],
				code: "future-checker-category",
				message: "Raw future checker detail",
			} as unknown as CheckError;
			expect(presentCheckErrorForEditor(futureError)).toBe(copy);
		},
	);
});
