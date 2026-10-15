/**
 * The matcher's Nova side, walked from the raw carriers, against its
 * definition and its retained output.
 *
 * The definition is the pre-step emitter's own: every menu of
 * `emissionPlan(doc)` in order, its name and case type, and under each form
 * the paths `collectFieldLocations` gives for every field that is not a
 * container, plus, for a container under which no such field sits, its own
 * path past `descendFormPathIntoField`. That definition reads a hydrated
 * document of the tree's current schema, so this half holds only while the
 * fixtures still parse under it; the walk is held to each fixture's
 * `paths.json` at every head.
 */

import { describe, expect, it } from "vitest";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { collectFieldLocations } from "@/lib/commcare/xform/caseOps";
import { descendFormPathIntoField } from "@/lib/commcare/xform/formPath";
import { assemblePersistedBlueprintJsonText } from "@/lib/db/persistedJson";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { asUuid, type BlueprintDoc, isContainerKindName } from "@/lib/domain";
import { readRawDocument } from "../oldShape";
import { type QuestionPathMenu, questionPaths } from "../questionPaths";
import { HISTORIES } from "./fixtures/fixtureDocuments";
import {
	type FixtureCarriers,
	readFixtureCarriers,
	readFixtureHistory,
	readFixtureManifest,
	readFixturePaths,
	readHistoryCarriers,
} from "./fixtures/preStep";

/** The production definition of the matcher's Nova side. */
function definedPaths(doc: BlueprintDoc): QuestionPathMenu[] {
	const plan = emissionPlan(doc);
	return plan.doc.moduleOrder.map((menuUuid) => {
		const menu = plan.doc.modules[menuUuid];
		return {
			uuid: menuUuid,
			name: menu?.name ?? "",
			caseType:
				menu?.caseType === undefined || menu.caseType === ""
					? null
					: menu.caseType,
			lifted: plan.synthetic.has(menuUuid),
			forms: (plan.doc.formOrder[menuUuid] ?? []).map((formUuid) => {
				const locations = collectFieldLocations(plan.doc, formUuid);
				const paths: string[] = [];
				for (const [fieldUuid, location] of locations) {
					const field = plan.doc.fields[fieldUuid];
					if (field === undefined) continue;
					if (!isContainerKindName(field.kind)) {
						paths.push(location.path.toXPath());
						continue;
					}
					const holdsLeaf = [...locations].some(
						([otherUuid, other]) =>
							!isContainerKindName(plan.doc.fields[otherUuid]?.kind) &&
							other.path.toXPath().startsWith(`${location.path.toXPath()}/`),
					);
					if (!holdsLeaf) {
						paths.push(
							descendFormPathIntoField(field, location.path).toXPath(),
						);
					}
				}
				return {
					uuid: formUuid,
					name: plan.doc.forms[formUuid]?.name ?? "",
					paths,
				};
			}),
		};
	});
}

function hydrate(id: string, carriers: FixtureCarriers): BlueprintDoc {
	return hydratePersistedBlueprint(
		assemblePersistedBlueprintJsonText(id, carriers.root, carriers.rows),
	);
}

function sorted(menus: readonly QuestionPathMenu[]) {
	return menus.map((menu) => ({
		...menu,
		forms: menu.forms.map((form) => ({
			...form,
			paths: [...form.paths].sort(),
		})),
	}));
}

const fixtures = readFixtureManifest().fixtures.map((fixture) => fixture.id);

describe("the matcher's Nova side", () => {
	it.each(fixtures)("walks %s to its retained paths.json", (id) => {
		const raw = readRawDocument(id, readFixtureCarriers(id));
		expect(questionPaths(raw)).toEqual(readFixturePaths(id));
	});

	it.each(fixtures)(
		"walks %s exactly as the pre-step emitter's definition",
		(id) => {
			const carriers = readFixtureCarriers(id);
			expect(sorted(questionPaths(readRawDocument(id, carriers)))).toEqual(
				sorted(definedPaths(hydrate(id, carriers))),
			);
		},
	);

	describe.each(HISTORIES.map((history) => [history.document, history.name]))(
		"over %s's history %s",
		(document, name) => {
			it("walks every document after a row to its retained paths and the definition", () => {
				for (const row of readFixtureHistory(document, name).rows) {
					const carriers = readHistoryCarriers(document, name, row.seq);
					const walked = questionPaths(readRawDocument(document, carriers));
					expect(walked).toEqual(
						readFixturePaths(document, "histories", name, `after-${row.seq}`),
					);
					expect(sorted(walked)).toEqual(
						sorted(definedPaths(hydrate(document, carriers))),
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
