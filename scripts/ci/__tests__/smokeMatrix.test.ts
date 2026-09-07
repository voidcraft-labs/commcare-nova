import { expect, it } from "vitest";
import { smokeMatrix } from "../smoke-matrix.mjs";

it("allocates the selected hardware budget proportionally and keeps both lanes runnable", () => {
	const matrix = smokeMatrix(6, 2, {
		"[browser] › small": 100,
		"[authed] › long": 400,
		"[public] › public": 100,
	});
	expect(matrix.include).toEqual([
		{ lane: "browser", shard: 1, total: 1, workers: 2 },
		...[1, 2, 3, 4, 5].map((shard) => ({
			lane: "app",
			shard,
			total: 5,
			workers: 2,
		})),
	]);
	expect(
		smokeMatrix(4, 1, {
			"[browser] › long": 10000,
			"[authed] › tiny": 1,
		}).include.filter((row) => row.lane === "app"),
	).toEqual([{ lane: "app", shard: 1, total: 1, workers: 1 }]);
});
it("refuses unsupported budgets and corrupt workload estimates", () => {
	for (const [jobs, workers] of [
		[0, 1],
		[5, 2],
		[6, 0],
		[6, 3],
	])
		expect(() => smokeMatrix(jobs, workers, {})).toThrow();
	expect(() => smokeMatrix(4, 1, { "[browser] › broken": NaN })).toThrow();
	expect(() => smokeMatrix(4, 1, { "[browser] › alone": 1 })).toThrow();
});
