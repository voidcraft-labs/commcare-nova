import { describe, expect, it } from "vitest";
import {
	anchorForIndex,
	predecessorOf,
	sequenceMovesTo,
	spliceAfter,
	spliceEntryAfter,
} from "@/lib/doc/mutations/sequence";

/** Apply the derived moves and check they actually reach the target. */
function reaches(before: string[], after: string[]): boolean {
	let seq = before.filter((u) => after.includes(u));
	for (const u of after) if (!seq.includes(u)) seq = [...seq, u];
	for (const m of sequenceMovesTo(before, after)) {
		// Independent imperative application, not the production splice helper.
		const index = seq.indexOf(m.uuid);
		seq.splice(index, 1);
		const landing = m.after === null ? 0 : seq.indexOf(m.after) + 1;
		seq.splice(landing, 0, m.uuid);
	}
	return JSON.stringify(seq) === JSON.stringify(after);
}

describe("sequenceMovesTo", () => {
	it("emits nothing when unchanged", () => {
		expect(sequenceMovesTo(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
	});
	it("emits one move for one relocation", () => {
		expect(sequenceMovesTo(["a", "b", "c"], ["c", "a", "b"])).toEqual([
			{ uuid: "c", after: null },
		]);
	});
	it("ignores removals", () => {
		expect(sequenceMovesTo(["a", "b", "c"], ["a", "c"])).toEqual([]);
	});
	it("does not move a newcomer (its add carries placement)", () => {
		expect(sequenceMovesTo(["a", "c"], ["a", "b", "c"])).toEqual([]);
	});
	it("reaches all 720 permutations of six distinct identities", () => {
		const ids = ["a", "b", "c", "d", "e", "f"];
		function permutations(remaining: string[]): string[][] {
			if (remaining.length === 0) return [[]];
			return remaining.flatMap((id, index) =>
				permutations(remaining.filter((_, at) => at !== index)).map((tail) => [
					id,
					...tail,
				]),
			);
		}
		const corpus = permutations(ids);
		expect(corpus).toHaveLength(720);
		for (const target of corpus) {
			expect(reaches(ids, target), JSON.stringify(target)).toBe(true);
			expect(reaches(target, ids), JSON.stringify(target)).toBe(true);
		}
	});
});

describe("missing logical neighbors", () => {
	it("never converts a missing UUID anchor into append", () => {
		expect(spliceAfter(["a", "b"], "a", "gone")).toEqual(["a", "b"]);
	});

	it("never converts a missing entry anchor into append", () => {
		const entries = [{ uuid: "a" }, { uuid: "b" }];
		expect(spliceEntryAfter(entries, entries[0], "gone")).toEqual(entries);
	});
});

describe("sequence placement and replay", () => {
	it.each([null, undefined, "a", "b"] as const)(
		"is idempotent after %s",
		(after) => {
			const first = spliceAfter(["a", "b", "c"], "c", after);
			expect(spliceAfter(first, "c", after)).toEqual(first);
			expect(new Set(first).size).toBe(3);
		},
	);
	it("distinguishes first, append, and the current predecessor", () => {
		expect(spliceAfter(["a", "b"], "c", null)).toEqual(["c", "a", "b"]);
		expect(spliceAfter(["a", "b"], "c", undefined)).toEqual(["a", "b", "c"]);
		expect(predecessorOf(["a", "b"], "a")).toBeNull();
		expect(predecessorOf(["a", "b"], "b")).toBe("a");
		expect(predecessorOf(["a", "b"], "absent")).toBeUndefined();
		expect(anchorForIndex(["a", "b"], 0)).toBeNull();
		expect(anchorForIndex(["a", "b"], 1)).toBe("a");
		expect(anchorForIndex(["a", "b"], 2)).toBeUndefined();
	});
});
