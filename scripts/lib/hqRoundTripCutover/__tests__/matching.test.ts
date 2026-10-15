/**
 * Path two's rules, each on inputs built to reach it: the three facts, the
 * one deciding rule, every stage, the HQ-side collector's exclusions, the
 * alignment of the two reads, and the identity rows the pairs give. That the
 * rules pair HQ's real forms is `matchingOverHq.test.ts`, over HQ's own
 * answers.
 */

import { describe, expect, it } from "vitest";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import { asUuid } from "@/lib/domain";
import {
	alignStoredFormIds,
	collectHqPaths,
	deploymentIdentities,
	type HqSideMenu,
	hqSideOf,
	matchByEvidence,
	nameFact,
	pathsFact,
} from "../matching";
import type { QuestionPathMenu } from "../questionPaths";
import {
	hq,
	hqForm,
	hqMenu,
	novaForm,
	novaMenu,
	reordered,
	uuidOf,
} from "./fixtures/matchingInputs";

type Evidence = ReturnType<typeof matchByEvidence>;

/** Each HQ menu position's paired Nova uuid, and each HQ form's, by "menu/form". */
function pairsOf(result: Evidence) {
	return {
		menus: Object.fromEntries(
			[...result.pairs.menus].map(([position, uuid]) => [position, uuid]),
		),
		forms: Object.fromEntries(
			result.pairs.forms.map((pair) => [
				`${pair.menu}/${pair.form}`,
				pair.uuid,
			]),
		),
	};
}

function causeOf(result: Evidence, label: string) {
	return result.unpaired.find((entity) => entity.uuid === uuidOf(label))?.cause;
}

/** Every order of Nova's side the test draws gives the same pairs. */
function expectOrderFree(hqSide: HqSideMenu[], today: QuestionPathMenu[]) {
	const expected = pairsOf(matchByEvidence(hqSide, today));
	for (let seed = 1; seed <= 12; seed++) {
		expect(pairsOf(matchByEvidence(hqSide, reordered(today, seed)))).toEqual(
			expected,
		);
	}
}

const xform = (instance: string) =>
	`<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa"><h:head><model><instance>${instance}</instance></model></h:head><h:body/></h:html>`;

describe("the facts", () => {
	it("hold paths at more than half of the HQ form's paths, and not at exactly half", () => {
		expect(
			pathsFact(
				[
					{ path: "/data/a", generated: false },
					{ path: "/data/b", generated: false },
					{ path: "/data/c", generated: false },
				],
				["/data/a", "/data/b"],
			),
		).toEqual({ holds: true, shared: 2, apart: 1 });
		expect(
			pathsFact(
				[
					{ path: "/data/a", generated: false },
					{ path: "/data/b", generated: false },
				],
				["/data/a"],
			).holds,
		).toBe(false);
	});

	it("hold no paths for an HQ form with none", () => {
		expect(pathsFact([], [])).toEqual({ holds: false, shared: 0, apart: 0 });
		expect(pathsFact([], ["/data/a"]).holds).toBe(false);
	});

	it("drop a generated leaf the Nova form does not hold, and keep one it does", () => {
		const generated = [
			{ path: "/data/age", generated: false },
			{ path: "/data/nova_constraint_message_age", generated: true },
		];
		expect(pathsFact(generated, ["/data/age"])).toEqual({
			holds: true,
			shared: 1,
			apart: 0,
		});
		expect(
			pathsFact(generated, ["/data/age", "/data/nova_constraint_message_age"])
				.shared,
		).toBe(2);
	});

	it("hold a name that is one of several texts, never an empty one", () => {
		expect(nameFact("Visita", ["Visit", "Visita"])).toBe(true);
		expect(nameFact("", ["", "Visit"])).toBe(false);
		expect(nameFact("Visit", [])).toBe(false);
	});

	it("read HQ's names from the object of texts, and none where name is no object", () => {
		const [menu] = hqSideOf({
			modules: [
				{
					uniqueId: "m1",
					caseType: "",
					forms: [{ xmlns: "x1", readUniqueId: "f1", attachment: null }],
				},
			],
			raw: {
				modules: [
					{ name: { en: "Visits", es: "Visitas" }, forms: [{ name: "Visit" }] },
				],
			},
		});
		expect(menu?.names).toEqual(["Visits", "Visitas"]);
		expect(menu?.forms[0]?.names).toEqual([]);
	});
});

describe("the HQ side's paths", () => {
	it("takes each element with no element child, an empty container among them", () => {
		expect(
			collectHqPaths(
				xform(
					'<data xmlns="http://openrosa.org/formdesigner/X"><name/><demographics/><empty/><roster jr:template=""/><queried><item id=""/></queried></data>',
				),
			).map((entry) => entry.path),
		).toEqual([
			"/data/name",
			"/data/demographics",
			"/data/empty",
			"/data/roster",
			"/data/queried/item",
		]);
	});

	it("drops every __nova_ subtree, and a group that held only one is a leaf", () => {
		expect(
			collectHqPaths(
				xform(
					"<data><name/><__nova_ops><case><create/></case></__nova_ops><household><__nova_child/></household></data>",
				),
			).map((entry) => entry.path),
		).toEqual(["/data/name", "/data/household"]);
	});

	it("drops a Connect block by its namespace, never by its name, and keeps a question named task", () => {
		const paths = collectHqPaths(
			xform(
				'<data><age/><task/><deliver_unit><deliver xmlns="http://commcareconnect.com/data/v1/learn" id="d"><name/><entity_id/></deliver></deliver_unit><work><task xmlns="http://commcareconnect.com/data/v1/learn"><name/></task><note/></work></data>',
			),
		).map((entry) => entry.path);
		expect(paths).toEqual(["/data/age", "/data/task", "/data/work/note"]);
	});

	it("marks the two generated leaf families", () => {
		expect(
			collectHqPaths(
				xform(
					"<data><age/><nova_count_kids/><nova_constraint_message_age/></data>",
				),
			),
		).toEqual([
			{ path: "/data/age", generated: false },
			{ path: "/data/nova_count_kids", generated: true },
			{ path: "/data/nova_constraint_message_age", generated: true },
		]);
	});

	it("holds no leaf for a form with no question", () => {
		expect(collectHqPaths(xform("<data><__nova_ops/></data>"))).toEqual([]);
		expect(collectHqPaths(xform("<data/>"))).toEqual([]);
	});
});

describe("the deciding rule", () => {
	it("pairs a lone candidate, and ties two that share an end, closing both", () => {
		const hqSide = hq([
			hqMenu("Patients", "", [hqForm("Visit", ["/data/a"])]),
			hqMenu("Patients", "", []),
		]);
		const today = [
			novaMenu("patients", "Patients", null, [
				novaForm("visit", "Visit", ["/data/a"]),
			]),
		];
		const result = matchByEvidence(hqSide, today);
		// Stage 1 ties the two HQ menus named Patients; the tie stays open for
		// stage 4, where the forms pair the menu.
		expect(pairsOf(result).menus).toEqual({ 0: uuidOf("patients") });
		expect(result.pairsPerStage[4]).toBe(1);
		expect(result.pairsPerStage[3]).toBe(1);
	});

	it("pairs nothing that a tie closed at a later stage", () => {
		const hqSide = hq([
			hqMenu("Follow up", "", [
				hqForm("Visit", ["/data/note"]),
				hqForm("Visit", ["/data/note"]),
			]),
		]);
		const today = [
			novaMenu("menu", "Follow up", null, [
				novaForm("one", "Visit", ["/data/note"]),
				novaForm("two", "Visit", ["/data/note"]),
			]),
		];
		const result = matchByEvidence(hqSide, today);
		expect(result.pairs.forms).toEqual([]);
		expect(causeOf(result, "one")).toEqual({ kind: "tie", stage: 2 });
		expect(causeOf(result, "two")).toEqual({ kind: "tie", stage: 2 });
	});
});

describe("stage 1: menus by name", () => {
	it("pairs a moved menu by its name, a menu with no forms included, whatever order", () => {
		const hqSide = hq([
			hqMenu("Households", "household", []),
			hqMenu("Patients", "patient", [hqForm("Register", ["/data/name"])]),
		]);
		const today = [
			novaMenu("patients", "Patients", "patient", [
				novaForm("register", "Register", ["/data/name"]),
			]),
			novaMenu("households", "Households", "household", []),
		];
		const result = matchByEvidence(hqSide, today);
		expect(pairsOf(result).menus).toEqual({
			0: uuidOf("households"),
			1: uuidOf("patients"),
		});
		expect(result.pairsPerStage[1]).toBe(2);
		expectOrderFree(hqSide, today);
	});

	it("ties two menus of one name and no case type, and pairs two of one name and two case types", () => {
		const untyped = matchByEvidence(
			hq([hqMenu("Surveys", "", []), hqMenu("Surveys", "", [])]),
			[novaMenu("a", "Surveys", null, []), novaMenu("b", "Surveys", null, [])],
		);
		expect(untyped.pairs.menus.size).toBe(0);
		expect(causeOf(untyped, "a")).toEqual({ kind: "tie", stage: 1 });
		const typed = matchByEvidence(
			hq([
				hqMenu("Clients", "patient", []),
				hqMenu("Clients", "household", []),
			]),
			[
				novaMenu("households", "Clients", "household", []),
				novaMenu("patients", "Clients", "patient", []),
			],
		);
		expect(pairsOf(typed).menus).toEqual({
			0: uuidOf("patients"),
			1: uuidOf("households"),
		});
	});

	it("pairs the hidden no-matches menu by its form's name", () => {
		const result = matchByEvidence(
			hq([
				hqMenu("Patients", "patient", [hqForm("Visit", ["/data/a"])]),
				hqMenu("Register patient", "patient", [
					hqForm("Register patient", ["/data/name"]),
				]),
			]),
			[
				novaMenu("patients", "Patients", "patient", [
					novaForm("visit", "Visit", ["/data/a"]),
				]),
				novaMenu(
					"hidden",
					"Register patient",
					"patient",
					[novaForm("register", "Register patient", ["/data/name"])],
					true,
				),
			],
		);
		expect(pairsOf(result).menus[1]).toBe(uuidOf("hidden"));
		expect(result.pairsPerStage[1]).toBe(2);
	});

	it("pairs no menu by its case type alone, and never against a contradicting one", () => {
		const result = matchByEvidence(hq([hqMenu("Patients", "patient", [])]), [
			novaMenu("clients", "Clients", "patient", []),
		]);
		expect(result.pairsPerStage[1]).toBe(0);
		expect(result.pairsPerStage[5]).toBe(1);
		const contradicted = matchByEvidence(
			hq([hqMenu("Patients", "household", [hqForm("Visit", ["/data/a"])])]),
			[
				novaMenu("patients", "Patients", "patient", [
					novaForm("visit", "Visit", ["/data/a"]),
				]),
			],
		);
		expect(contradicted.pairs.menus.size).toBe(0);
	});
});

describe("stages 2 and 3: forms by name and paths", () => {
	it("of two forms with one name, pairs the one that shares more paths, then fewer apart", () => {
		const result = matchByEvidence(
			hq([
				hqMenu("Patients", "", [
					hqForm("Visit", ["/data/a", "/data/b", "/data/c"]),
				]),
			]),
			[
				novaMenu("patients", "Patients", null, [
					novaForm("two", "Visit", ["/data/a", "/data/b"]),
					novaForm("three", "Visit", ["/data/a", "/data/b", "/data/c"]),
				]),
			],
		);
		expect(pairsOf(result).forms).toEqual({ "0/0": uuidOf("three") });
		const apart = matchByEvidence(
			hq([
				hqMenu("Patients", "", [
					hqForm("Visit", ["/data/a", "/data/b", "/data/c"]),
				]),
			]),
			[
				novaMenu("patients", "Patients", null, [
					novaForm("more", "Visit", [
						"/data/a",
						"/data/b",
						"/data/x",
						"/data/y",
					]),
					novaForm("fewer", "Visit", ["/data/a", "/data/b"]),
				]),
			],
		);
		expect(pairsOf(apart).forms).toEqual({ "0/0": uuidOf("fewer") });
	});

	it("pairs a form moved to another menu at stage 3", () => {
		const result = matchByEvidence(
			hq([
				hqMenu("Patients", "", [hqForm("Review", ["/data/r1", "/data/r2"])]),
				hqMenu("Sites", "", []),
			]),
			[
				novaMenu("patients", "Patients", null, []),
				novaMenu("sites", "Sites", null, [
					novaForm("review", "Review", ["/data/r1", "/data/r2"]),
				]),
			],
		);
		expect(pairsOf(result).forms).toEqual({ "0/0": uuidOf("review") });
		expect(result.pairsPerStage[3]).toBe(1);
	});

	it("pairs each of two twin forms in its own menu, because stage 2 runs first", () => {
		const hqSide = hq([
			hqMenu("North", "", [hqForm("Visit", ["/data/notes"])]),
			hqMenu("South", "", [hqForm("Visit", ["/data/notes"])]),
		]);
		const today = [
			novaMenu("north", "North", null, [
				novaForm("north-visit", "Visit", ["/data/notes"]),
			]),
			novaMenu("south", "South", null, [
				novaForm("south-visit", "Visit", ["/data/notes"]),
			]),
		];
		const result = matchByEvidence(hqSide, today);
		expect(pairsOf(result).forms).toEqual({
			"0/0": uuidOf("north-visit"),
			"1/0": uuidOf("south-visit"),
		});
		expectOrderFree(hqSide, today);
	});

	it("dissolves a contested pair and closes its three ends", () => {
		// The twin history: South's Visit moved into North, North's own Visit
		// renamed Zone visit. Every fact names the moved form.
		const result = matchByEvidence(
			hq([
				hqMenu("North", "", [hqForm("Visit", ["/data/notes"])]),
				hqMenu("South", "", [hqForm("Visit", ["/data/notes"])]),
			]),
			[
				novaMenu("north", "North", null, [
					novaForm("moved", "Visit", ["/data/notes"]),
					novaForm("renamed", "Zone visit", ["/data/notes"]),
				]),
				novaMenu("south", "South", null, []),
			],
		);
		expect(result.contests).toBe(1);
		expect(result.pairs.forms).toEqual([]);
		expect(causeOf(result, "moved")).toEqual({ kind: "contest" });
		// Both HQ forms are closed, so the renamed form finds no candidate left.
		expect(causeOf(result, "renamed")).toEqual({ kind: "no-candidate" });
	});
});

describe("stages 4 and 5: the menus still unpaired", () => {
	it("pairs a renamed menu by the forms it kept", () => {
		const result = matchByEvidence(
			hq([hqMenu("Patients", "patient", [hqForm("Visit", ["/data/a"])])]),
			[
				novaMenu("clients", "Clients", "patient", [
					novaForm("visit", "Visit", ["/data/a"]),
				]),
			],
		);
		expect(pairsOf(result).menus).toEqual({ 0: uuidOf("clients") });
		expect(result.pairsPerStage[4]).toBe(1);
	});

	it("pairs a removed menu's forms moved into a menu of another type, and not the two menus", () => {
		const result = matchByEvidence(
			hq([hqMenu("Old", "visit", [hqForm("Check", ["/data/c1", "/data/c2"])])]),
			[
				novaMenu("new", "New", "household", [
					novaForm("check", "Check", ["/data/c1", "/data/c2"]),
				]),
			],
		);
		expect(pairsOf(result).forms).toEqual({ "0/0": uuidOf("check") });
		expect(result.pairs.menus.size).toBe(0);
	});

	it("pairs a renamed menu with no forms by its case type, and two free menus of one type with neither", () => {
		const lone = matchByEvidence(hq([hqMenu("Households", "household", [])]), [
			novaMenu("homes", "Homes", "household", []),
		]);
		expect(pairsOf(lone).menus).toEqual({ 0: uuidOf("homes") });
		const two = matchByEvidence(hq([hqMenu("Households", "household", [])]), [
			novaMenu("homes", "Homes", "household", []),
			novaMenu("dwellings", "Dwellings", "household", []),
		]);
		expect(two.pairs.menus.size).toBe(0);
		expect(causeOf(two, "homes")).toEqual({ kind: "tie", stage: 5 });
	});

	it("hands no removed menu's id to a renamed menu of its type whose forms paired elsewhere", () => {
		const result = matchByEvidence(
			hq([
				hqMenu("Removed", "patient", []),
				hqMenu("Patients", "patient", [hqForm("Visit", ["/data/a"])]),
			]),
			[
				novaMenu("clients", "Clients", "patient", [
					novaForm("visit", "Visit", ["/data/a"]),
				]),
			],
		);
		expect(pairsOf(result).menus).toEqual({ 1: uuidOf("clients") });
		expect(result.hqUnpaired).toContainEqual({ menu: 0 });
	});
});

describe("stage 6: forms of paired menus, by name or by paths", () => {
	const paired = (
		hqForms: ReturnType<typeof hqForm>[],
		novaForms: ReturnType<typeof novaForm>[],
	) =>
		matchByEvidence(hq([hqMenu("Patients", "", hqForms)]), [
			novaMenu("patients", "Patients", null, novaForms),
		]);

	it("pairs a renamed form by its paths", () => {
		const result = paired(
			[hqForm("Visit", ["/data/a", "/data/b"])],
			[novaForm("home", "Home visit", ["/data/a", "/data/b"])],
		);
		expect(pairsOf(result).forms).toEqual({ "0/0": uuidOf("home") });
		expect(result.pairsPerStage[6]).toBe(1);
	});

	it("pairs a form that shares no path, and an HQ form with no path, by its name", () => {
		expect(
			pairsOf(
				paired(
					[hqForm("Visit", ["/data/answer"])],
					[novaForm("visit", "Visit", ["/data/reply"])],
				),
			).forms,
		).toEqual({ "0/0": uuidOf("visit") });
		expect(
			pairsOf(
				paired(
					[hqForm("Visit", [])],
					[novaForm("visit", "Visit", ["/data/a"])],
				),
			).forms,
		).toEqual({ "0/0": uuidOf("visit") });
	});

	it("pairs a form that one free form names and another's paths name with neither", () => {
		const result = paired(
			[hqForm("Visit", ["/data/a", "/data/b"])],
			[
				novaForm("named", "Visit", ["/data/x"]),
				novaForm("pathed", "Review", ["/data/a", "/data/b"]),
			],
		);
		expect(result.pairs.forms).toEqual([]);
		expect(causeOf(result, "named")).toEqual({ kind: "tie", stage: 6 });
	});
});

describe("the HQ copies the collector exists for", () => {
	it("pairs a form whose every question has a reference-bearing validation message", () => {
		const paths = collectHqPaths(
			xform(
				"<data><age/><nova_constraint_message_age/><weight/><nova_constraint_message_weight/></data>",
			),
		);
		const result = matchByEvidence(
			hq([hqMenu("Patients", "", [hqForm("Intake", paths)])]),
			[
				novaMenu("patients", "Patients", null, [
					novaForm("intake", "Intake", ["/data/age", "/data/weight"]),
				]),
			],
		);
		expect(result.pairsPerStage[2]).toBe(1);
		// With the generated-leaf rule off, the form holds exactly half.
		expect(
			pathsFact(
				paths.map((entry) => ({ ...entry, generated: false })),
				["/data/age", "/data/weight"],
			).holds,
		).toBe(false);
	});

	it("pairs a form whose one question is counted by a generated leaf only with the rule on", () => {
		const paths = collectHqPaths(
			xform("<data><kids/><nova_count_kids/></data>"),
		);
		expect(pathsFact(paths, ["/data/kids"]).holds).toBe(true);
		expect(
			pathsFact(
				paths.map((entry) => ({ ...entry, generated: false })),
				["/data/kids"],
			).holds,
		).toBe(false);
	});

	it("pairs a Connect deliver form with a question named task, which a collector keeping Connect leaves would not", () => {
		const paths = collectHqPaths(
			xform(
				'<data><name/><dose/><task/><deliver_unit><deliver xmlns="http://commcareconnect.com/data/v1/learn"><name/><entity_id/><entity_name/></deliver></deliver_unit><task_block><task xmlns="http://commcareconnect.com/data/v1/learn"><name/><description/></task></task_block></data>',
			),
		);
		const today = [
			novaMenu("deliveries", "Deliveries", null, [
				novaForm("deliver", "Deliver", [
					"/data/name",
					"/data/dose",
					"/data/task",
				]),
			]),
		];
		expect(
			matchByEvidence(
				hq([hqMenu("Deliveries", "", [hqForm("Deliver", paths)])]),
				today,
			).pairsPerStage[2],
		).toBe(1);
		const kept = [
			...paths,
			...[
				"/data/deliver_unit/deliver/name",
				"/data/deliver_unit/deliver/entity_id",
				"/data/deliver_unit/deliver/entity_name",
				"/data/task_block/task/name",
				"/data/task_block/task/description",
			].map((path) => ({ path, generated: false })),
		];
		expect(
			pathsFact(kept, ["/data/name", "/data/dose", "/data/task"]).holds,
		).toBe(false);
	});
});

describe("the two reads aligned", () => {
	const hqSide = hq([
		hqMenu(
			"Patients",
			"",
			[
				hqForm("Register", ["/data/a"], { xmlns: "x-register" }),
				hqForm("Visit", ["/data/b"], { xmlns: "x-visit" }),
			],
			"m-patients",
		),
		hqMenu(
			"Broken",
			"",
			[hqForm("Bad", ["/data/c"], { xmlns: "x-bad" })],
			"m-broken",
		),
	]);

	it("takes each stored id by menu id and position where the xmlns agrees", () => {
		const aligned = alignStoredFormIds(hqSide, [
			{ kind: "error" },
			{
				kind: "module",
				uniqueId: "m-patients",
				forms: [
					{ uniqueId: "stored-register", xmlns: "x-register" },
					{ uniqueId: "stored-visit", xmlns: "x-moved" },
				],
			},
		]);
		expect(Object.fromEntries(aligned)).toEqual({
			"0/0": "stored-register",
			"0/1": null,
			"1/0": null,
		});
	});

	it("knows no stored id where no form id read answered", () => {
		expect([...alignStoredFormIds(hqSide, null).values()]).toEqual([
			null,
			null,
			null,
		]);
	});
});

describe("the identity rows", () => {
	const visit = uuidOf("visit");
	const register = uuidOf("register");
	const menu = uuidOf("patients");
	const today = [
		novaMenu("patients", "Patients", null, [
			novaForm("register", "Register", ["/data/a"]),
			novaForm("visit", "Visit", ["/data/b"]),
		]),
	];

	it("drop every value equal to the derivation", () => {
		const hqSide = hq([
			hqMenu(
				"Patients",
				"",
				[
					hqForm("Register", ["/data/a"], {
						xmlns: derivedFormXmlns(asUuid(register)),
					}),
					hqForm("Visit", ["/data/b"], { xmlns: "x-visit" }),
				],
				derivedUniqueId(asUuid(menu)),
			),
		]);
		const result = matchByEvidence(hqSide, today);
		const identities = deploymentIdentities(
			hqSide,
			result.pairs,
			new Map([
				["0/0", derivedUniqueId(asUuid(register))],
				["0/1", "stored-visit"],
			]),
			today,
		);
		expect(identities.rows).toEqual([
			{
				entityKind: "form",
				novaEntityUuid: visit,
				remoteUniqueId: "stored-visit",
				remoteXmlns: "x-visit",
			},
		]);
		expect(identities.formIdsUnknown).toEqual([]);
	});

	it("record no id another entity derives, and name that entity", () => {
		const hqSide = hq([
			hqMenu(
				"Patients",
				"",
				[
					hqForm("Register", ["/data/a"], { xmlns: "x-register" }),
					hqForm("Visit", ["/data/b"], { xmlns: "x-visit" }),
				],
				derivedUniqueId(asUuid(visit)),
			),
		]);
		const result = matchByEvidence(hqSide, today);
		const identities = deploymentIdentities(
			hqSide,
			result.pairs,
			new Map([
				["0/0", "stored-register"],
				["0/1", null],
			]),
			today,
		);
		expect(identities.collisions).toEqual([
			{ kind: "module", uuid: menu, cause: { kind: "id-collision" } },
		]);
		expect(identities.rows.map((row) => row.novaEntityUuid)).toEqual([
			register,
			visit,
		]);
		expect(identities.rows[1]).toEqual({
			entityKind: "form",
			novaEntityUuid: visit,
			remoteUniqueId: null,
			remoteXmlns: "x-visit",
		});
		expect(identities.formIdsUnknown).toEqual([visit]);
	});
});
