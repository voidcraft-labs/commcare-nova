import { expect, it } from "vitest";
import { lookupAppFixture } from "@/lib/commcare/__tests__/lookupAppFixtures";
import {
	verifyWorkerChoices,
	type WorkerChoiceRow,
} from "../workerChoiceProof";

it("checks a worker’s own base rows and catches exact duplicate answers across pages and differently chunked bytes", async () => {
	const { doc, table, rows } = lookupAppFixture(false, true);
	function entry(
		index: number,
		value: string,
		chunkSize: number,
	): WorkerChoiceRow {
		return {
			row: rows[index],
			read: (atom) =>
				atom.slot.kind === "attribute"
					? (async function* () {
							const bytes = Buffer.from(value);
							for (let i = 0; i < bytes.length; i += chunkSize)
								yield bytes.subarray(i, i + chunkSize);
						})()
					: undefined,
		};
	}
	const all = [
		entry(0, "001é😀", 2),
		entry(1, "other", 4),
		entry(2, "001é😀", 1),
	];
	async function check(source: WorkerChoiceRow[]) {
		return verifyWorkerChoices(
			doc,
			table,
			(async function* () {
				yield* source;
			})(),
			{
				workerBinding: "one named worker at this source",
				reopenRow: async (position) => source[position - 1],
			},
		);
	}
	const both = await check(all);
	expect(both.issues.filter((is) => is.kind === "duplicate")).not.toHaveLength(
		0,
	);
	expect(
		both.issues.every(
			(issue) =>
				issue.kind === "duplicate" &&
				issue.count === 2 &&
				issue.firstPositions.join() === "1,3",
		),
	).toBe(true);
	expect((await check([all[0], all[1]])).issues).toEqual([]);
	expect((await check([all[2]])).issues).toEqual([]);
	expect(
		(await check([])).issues.every((issue) => issue.kind === "empty-source"),
	).toBe(true);
	const dirty = await check([entry(0, "a\tb", 1)]);
	expect(dirty.issues.some((issue) => issue.kind === "whitespace")).toBe(true);
});
