// `proof/hq/test_endpoint_ids.py` holds these verdicts to CommCare HQ's own
// `get_cleaned_session_endpoint_id`; this file holds Nova's three exports to
// one another.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	ENTRY_POINT_ID_PATTERN,
	editorSafeEntryPointId,
	entryPointIdProblem,
	entryPointIdProblemSentence,
	entryPointIdSchema,
} from "../entryPoints";

/** Every id of one to `max` characters over `alphabet`. */
function idsUpTo(alphabet: readonly string[], max: number): string[] {
	const ids: string[] = [];
	let level = [""];
	for (let length = 1; length <= max; length++) {
		level = level.flatMap((prefix) => alphabet.map((c) => prefix + c));
		ids.push(...level);
	}
	return ids;
}

describe("deep link IDs", () => {
	it("answers no problem for exactly the ids the pattern matches", () => {
		for (const id of idsUpTo(["a", "9", "_", "-", "A", " "], 4))
			expect(entryPointIdProblem(id) === undefined, id).toBe(
				ENTRY_POINT_ID_PATTERN.test(id),
			);
	});

	it.each([
		["intake", undefined],
		["intake-2_b", undefined],
		["a", undefined],
		["9", undefined],
		["Intake", "characters"],
		["in take", "characters"],
		["intake_", "edge"],
		["_intake", "edge"],
		["-", "edge"],
		["in--take", "doubled-hyphen"],
	])("judges %j as %s", (id, problem) => {
		expect(entryPointIdProblem(id)).toBe(problem);
	});

	it("refuses only within what the stored schema admits, for the edge and hyphen rules", () => {
		for (const id of ["intake_", "-intake", "in--take"])
			expect(entryPointIdSchema.safeParse(id).success).toBe(true);
	});

	it.each([
		["intake_", "intake"],
		["-in--take-", "in-take"],
		["Intake Visit", "intake_visit"],
		["__", "entry"],
		["", "entry"],
	])("normalizes %j to %j", (id, safe) => {
		expect(editorSafeEntryPointId(id)).toBe(safe);
	});

	it("always normalizes to an id CommCare HQ saves", () => {
		fc.assert(
			fc.property(fc.string(), (id) => {
				expect(entryPointIdProblem(editorSafeEntryPointId(id))).toBeUndefined();
			}),
			{ seed: 1015, numRuns: 300 },
		);
	});

	it("names the problem and the free ID", () => {
		expect(entryPointIdProblemSentence("edge", "intake")).toBe(
			"A deep link ID starts and ends with a lowercase letter or a digit, because CommCare HQ won't save one that doesn't. \"intake\" is free here.",
		);
	});
});
