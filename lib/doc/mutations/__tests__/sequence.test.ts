import { describe, expect, it } from "vitest";
import { sequenceMovesTo, spliceAfter } from "@/lib/doc/mutations/sequence";

/** Apply the derived moves and check they actually reach the target. */
function reaches(before: string[], after: string[]): boolean {
	let seq = before.filter((u) => after.includes(u));
	for (const u of after) if (!seq.includes(u)) seq = [...seq, u];
	for (const m of sequenceMovesTo(before, after)) {
		seq = spliceAfter(seq, m.uuid, m.after);
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
	it("reaches the target for random permutations", () => {
		const ids = ["a", "b", "c", "d", "e", "f"];
		const perms: string[][] = [];
		for (let i = 0; i < 200; i++) {
			const p = [...ids];
			for (let j = p.length - 1; j > 0; j--) {
				const k = (i * 7 + j * 13) % (j + 1);
				[p[j], p[k]] = [p[k], p[j]];
			}
			perms.push(p);
		}
		for (const p of perms) expect(reaches(ids, p)).toBe(true);
		for (const p of perms) expect(reaches(p, ids)).toBe(true);
	});
});
