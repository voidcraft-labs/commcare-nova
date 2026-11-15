// proof/first-publish-changes.json is the lane's copy of the first-publish
// register: the lane's shards hold no TypeScript, so its judge reads which
// differences each change allows from this file. Where the checkout is whole
// the file is held to the register itself: one object a change, every
// change in registry order; each object's `source` rows exactly the
// stored-app pointers the register's entry allows; every other row one of
// the three proofs a run's evidence writes; and a `proof3` row, a difference
// a worker meets, only under an entry that touches workers. Otherwise the
// lane would accept a stored-app difference the register does not allow,
// or a behavior difference under an entry that declares none.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_PUBLISH_CHANGES } from "@/lib/deployment/reading/firstPublishChanges";
import {
	FIRST_PUBLISH_CHANGE_IDS,
	type FirstPublishChangeId,
} from "@/lib/publish/firstPublishChangeIds";

interface Row {
	readonly check: string;
	readonly artifact: string;
	readonly path: string;
	readonly kind?: string;
}

interface Change {
	readonly change: string;
	readonly rows: readonly Row[];
}

const CHECKS = new Set(["source", "proof1", "proof2", "proof3"]);

function load(): Change[] {
	return JSON.parse(
		readFileSync(
			join(process.cwd(), "proof/first-publish-changes.json"),
			"utf8",
		),
	) as Change[];
}

describe("proof/first-publish-changes.json", () => {
	it("holds one object a change, in registry order", () => {
		expect(load().map((one) => one.change)).toEqual([
			...FIRST_PUBLISH_CHANGE_IDS,
		]);
	});

	it("holds as each change's source rows exactly the stored-app pointers its entry allows", () => {
		for (const one of load()) {
			const entry = FIRST_PUBLISH_CHANGES[one.change as FirstPublishChangeId];
			const source = one.rows.filter((row) => row.check === "source");
			for (const row of source)
				expect([one.change, row.artifact, row.kind]).toEqual([
					one.change,
					"app.json",
					undefined,
				]);
			expect([one.change, source.map((row) => row.path)]).toEqual([
				one.change,
				[...entry.paths],
			]);
		}
	});

	it("names in every row a check of the four, an artifact and a structural path, and no class twice in one change", () => {
		for (const one of load()) {
			const classes = new Set<string>();
			for (const row of one.rows) {
				expect(CHECKS.has(row.check), `${one.change}: ${row.check}`).toBe(true);
				expect(row.artifact.length).toBeGreaterThan(0);
				expect(row.path.startsWith("/"), `${one.change}: ${row.path}`).toBe(
					true,
				);
				const key = JSON.stringify([
					row.check,
					row.artifact,
					row.path,
					row.kind ?? null,
				]);
				expect(classes.has(key), `${one.change}: ${key}`).toBe(false);
				classes.add(key);
			}
		}
	});

	it("allows a difference a worker meets only under a change that touches workers", () => {
		for (const one of load())
			if (one.rows.some((row) => row.check === "proof3"))
				expect([
					one.change,
					FIRST_PUBLISH_CHANGES[one.change as FirstPublishChangeId]
						.touchesWorkers,
				]).toEqual([one.change, true]);
	});
});
