// proof/first-publish-changes.json is the lane's copy of the first-publish
// register: the lane's shards hold no TypeScript, so its judge reads which
// differences each change allows from this file. Where the checkout is whole
// the file is held to the register itself: one object a change, every
// change in registry order; each object's `source` rows exactly the
// stored-app pointers the register's entry allows, but the change that
// stands everywhere, which holds a form's source only by the part classes a
// run's evidence writes, never the whole of it; every other row one of
// the three proofs a run's evidence writes; a `proof3` row, a difference
// a worker meets, only under an entry that touches workers; and each
// object's `placeKinds` the kinds of place its entry stands at. Otherwise
// the lane would accept a stored-app difference the register does not allow,
// a behavior difference under an entry that declares none, or a place of a
// kind the entry never gives.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	FIRST_PUBLISH_CHANGES,
	firstPublishPlaceKindsOf,
} from "@/lib/deployment/reading/firstPublishChanges";
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
	readonly placeKinds: readonly string[];
	readonly rows: readonly Row[];
}

const CHECKS = new Set(["source", "proof1", "proof2", "proof3"]);
// A form's source in the stored app, and a part of it as the stored-app comparison names one
// (`proof/checks/xform_parts.py`).
const FORM_SOURCE = "/_attachments/*";
const FORM_PART = `${FORM_SOURCE}/`;

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

	it("holds as each change's place kinds exactly the kinds its entry stands at", () => {
		for (const one of load())
			expect([one.change, one.placeKinds]).toEqual([
				one.change,
				[...firstPublishPlaceKindsOf(one.change as FirstPublishChangeId)],
			]);
	});

	it("holds as each change's source rows exactly the stored-app pointers its entry allows, but a form's source where the change stands everywhere", () => {
		for (const one of load()) {
			const entry = FIRST_PUBLISH_CHANGES[one.change as FirstPublishChangeId];
			const appWide = "appWide" in entry.at;
			const source = one.rows.filter((row) => row.check === "source");
			for (const row of source)
				expect([one.change, row.artifact, row.kind]).toEqual([
					one.change,
					"app.json",
					undefined,
				]);
			// The change that stands everywhere holds a form's source only by the part classes a run's
			// evidence writes (`python3 -m proof.checks.changes rows`), never every part at once.
			const parts = source.filter((row) => row.path.startsWith(FORM_PART));
			expect([one.change, parts.length > 0 && !appWide]).toEqual([
				one.change,
				false,
			]);
			for (const row of parts)
				expect([
					one.change,
					row.path,
					entry.paths.includes(FORM_SOURCE),
				]).toEqual([one.change, row.path, true]);
			expect([
				one.change,
				source
					.filter((row) => !row.path.startsWith(FORM_PART))
					.map((row) => row.path),
			]).toEqual([
				one.change,
				entry.paths.filter((path) => !appWide || path !== FORM_SOURCE),
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
