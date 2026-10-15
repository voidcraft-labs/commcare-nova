/**
 * The matcher's Nova side, walked from the raw carriers, against its
 * retained output.
 *
 * Each fixture's `paths.json` was held equal to the pre-step emitter's own
 * definition (`emissionPlan` and `collectFieldLocations`) in the tree whose
 * schema was still the pre-step one. The frozen fixtures no longer parse
 * under the tree's schema, so from then on the walk is held to the retained
 * files, which need no production function.
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import { readRawDocument } from "../oldShape";
import { questionPaths } from "../questionPaths";
import { HISTORIES } from "./fixtures/fixtureDocuments";
import {
	readFixtureCarriers,
	readFixtureHistory,
	readFixtureManifest,
	readFixturePaths,
	readHistoryCarriers,
} from "./fixtures/preStep";

const fixtures = readFixtureManifest().fixtures.map((fixture) => fixture.id);

describe("the matcher's Nova side", () => {
	it.each(fixtures)("walks %s to its retained paths.json", (id) => {
		const raw = readRawDocument(id, readFixtureCarriers(id));
		expect(questionPaths(raw)).toEqual(readFixturePaths(id));
	});

	describe.each(HISTORIES.map((history) => [history.document, history.name]))(
		"over %s's history %s",
		(document, name) => {
			it("walks every document after a row to its retained paths", () => {
				for (const row of readFixtureHistory(document, name).rows) {
					const carriers = readHistoryCarriers(document, name, row.seq);
					expect(questionPaths(readRawDocument(document, carriers))).toEqual(
						readFixturePaths(document, "histories", name, `after-${row.seq}`),
					);
				}
			});
		},
	);

	it("lifts the no-matches form into the hidden menu emissionPlan derives for it", () => {
		const raw = readRawDocument(
			"no-matches-parent",
			readFixtureCarriers("no-matches-parent"),
		);
		const menus = questionPaths(raw);
		const lifted = menus.filter((menu) => menu.lifted);
		expect(lifted).toHaveLength(1);
		expect(menus.at(-1)).toBe(lifted[0]);
		expect(lifted[0]?.forms.map((form) => form.name)).toEqual([
			"Register patient",
		]);
		expect(lifted[0]?.caseType).toBe("patient");
		expect(lifted[0]?.uuid).not.toBe(asUuid(raw.moduleOrder[0] ?? ""));
	});

	it("takes each empty container as a leaf, a query repeat's past its item step", () => {
		const raw = readRawDocument(
			"navigation-base",
			readFixtureCarriers("navigation-base"),
		);
		const [menu] = raw.moduleOrder;
		const [, register] = raw.formOrder[menu ?? ""] ?? [];
		if (register === undefined) throw new Error("No Register form.");
		const containers: [string, string, Record<string, string>][] = [
			["c1", "group", { id: "empty_group" }],
			["c2", "section", { id: "empty_section" }],
			["c3", "repeat", { id: "counted", repeat_mode: "count_bound" }],
			["c4", "repeat", { id: "queried", repeat_mode: "query_bound" }],
			["c5", "group", { id: "outer" }],
			["c6", "group", { id: "inner" }],
		];
		const fields = { ...raw.fields };
		for (const [uuid, kind, slots] of containers) {
			fields[uuid] = { uuid, kind, ...slots };
		}
		const document = {
			...raw,
			fields,
			fieldOrder: {
				...raw.fieldOrder,
				[register]: [
					...(raw.fieldOrder[register] ?? []),
					"c1",
					"c2",
					"c3",
					"c4",
					"c5",
				],
				c1: [],
				c2: [],
				c3: [],
				c4: [],
				c5: ["c6"],
				c6: [],
			},
		};
		const registerPaths = questionPaths(document)
			.flatMap((entry) => entry.forms)
			.find((form) => form.uuid === register)?.paths;
		expect(registerPaths).toEqual([
			"/data/name",
			"/data/external",
			"/data/empty_group",
			"/data/empty_section",
			"/data/counted",
			"/data/queried/item",
			"/data/outer/inner",
		]);
	});

	it("takes a query repeat's questions past its item step", () => {
		const paths = questionPaths(
			readRawDocument(
				"case-choice-attendance",
				readFixtureCarriers("case-choice-attendance"),
			),
		).flatMap((menu) => menu.forms.flatMap((form) => form.paths));
		expect(paths.some((path) => path.includes("/roster/item/"))).toBe(true);
	});
});
