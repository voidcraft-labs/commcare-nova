/**
 * The frozen copies of `main`'s rules, held to what `main` derived.
 *
 * `facts.json` is what `main`'s own code (`2f985ed6`) said about each
 * pre-step fixture: where its emission wrote every case block, which writers
 * it preloaded, which group labels showed. Those functions are gone at the
 * head, so the cutover carries copies of them over the raw stored document;
 * each copy must give the same answers over every fixture read the way the
 * cutover reads an app, through its carriers and no schema. A copy that
 * drifted from `main` would hold a published app's case changes somewhere
 * HQ never had them, or set a starting value or a one-screen group `main`
 * never showed.
 */

import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { preloadedWriters } from "../frozen/casePreload";
import { labelledGroups } from "../frozen/groupLabel";
import { rawDataPaths } from "../frozen/rawForms";
import { todaysPlacements } from "../frozen/todaysPlacements";
import { type RawDocument, rawDocumentAssembly } from "../oldShape";
import type { TodaysPlacement } from "../types";
import {
	PRE_STEP_FIXTURE_IDS,
	rawFixture,
	readPreStepJson,
} from "./rawFixture";

interface FixtureFacts {
	readonly placements: readonly {
		readonly formUuid: string;
		readonly unit: string;
		readonly emitted: string;
	}[];
	readonly preloadedWriters: Readonly<Record<string, readonly string[]>>;
	readonly labelledGroups: readonly string[];
}

const facts = (
	readPreStepJson("facts.json") as {
		readonly fixtures: Readonly<Record<string, FixtureFacts>>;
	}
).fixtures;

/**
 * Each case block one placement names, in `facts.json`'s spelling of
 * `main`'s emission: a basic slot, a Save to Case element by its scope and
 * its path from that scope (the unit's own block and each guard block beside
 * it), or a model-iteration row by its data path.
 */
function emittedIdentities(
	raw: RawDocument,
	placement: TodaysPlacement,
): string[] {
	const { placement: where, unit, formUuid } = placement;
	if (where === "model-iteration") {
		const repeatUuid = unit.slice("query-repeat:".length);
		const path = rawDataPaths(raw, formUuid).fieldPath.get(repeatUuid);
		if (path === undefined)
			throw new Error(
				`Query repeat ${repeatUuid} has no data path in form ${formUuid}.`,
			);
		return [`model-iteration:/data/${path.join("/")}/item`];
	}
	if (where.kind === "basic") {
		switch (where.slot) {
			case "own":
				return ["basic-own"];
			case "usercase":
				return ["basic-usercase"];
			case "subcase":
				return [`basic-subcase:${where.index}`];
			case "subcase-row":
				return ["basic-subcase-row"];
		}
	}
	return [where, ...placement.guards].map(
		(block) => `save-to-case:${block.repeat ?? "root"}:${block.path.join("/")}`,
	);
}

function sortedLines(lines: readonly string[]): string[] {
	return [...lines].sort();
}

describe("the frozen copies of main's rules", () => {
	it("holds facts for exactly the fixtures the directory holds", () => {
		expect(Object.keys(facts).sort()).toEqual([...PRE_STEP_FIXTURE_IDS]);
	});

	it.each(PRE_STEP_FIXTURE_IDS)(
		"reads %s's carriers back to the document it stores",
		(id) => {
			const stored = readPreStepJson(`${id}.json`) as { appId: string };
			expect(
				canonicalJsonDigest(rawDocumentAssembly(stored.appId, rawFixture(id))),
			).toBe(canonicalJsonDigest(stored));
		},
	);

	it.each(PRE_STEP_FIXTURE_IDS)(
		"places every unit of %s where main's emission wrote it",
		(id) => {
			const raw = rawFixture(id);
			const derived = [...todaysPlacements(raw).values()].flatMap((placement) =>
				emittedIdentities(raw, placement).map((emitted) =>
					JSON.stringify({
						formUuid: placement.formUuid,
						unit: placement.unit,
						emitted,
					}),
				),
			);
			const recorded = facts[id].placements.map((entry) =>
				JSON.stringify({
					formUuid: entry.formUuid,
					unit: entry.unit,
					emitted: entry.emitted,
				}),
			);
			expect(sortedLines(derived)).toEqual(sortedLines(recorded));
		},
	);

	it.each(PRE_STEP_FIXTURE_IDS)(
		"preloads the writers main preloaded in %s",
		(id) => {
			expect(Object.fromEntries(preloadedWriters(rawFixture(id)))).toEqual(
				facts[id].preloadedWriters,
			);
		},
	);

	it.each(PRE_STEP_FIXTURE_IDS)(
		"shows the group labels main showed in %s",
		(id) => {
			expect(labelledGroups(rawFixture(id))).toEqual(facts[id].labelledGroups);
		},
	);
});
