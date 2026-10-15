/**
 * Path one's rules on built inputs: the agreement between HQ's copy and the
 * published document, the pairs by position, and their carry to today's
 * document by uuid.
 */

import { describe, expect, it } from "vitest";
import {
	type HqSideMenu,
	matchByPublishedDocument,
	publishedAgreement,
} from "../matching";
import type { QuestionPathMenu } from "../questionPaths";
import {
	hq,
	hqForm,
	hqMenu,
	novaForm,
	novaMenu,
	uuidOf,
} from "./fixtures/matchingInputs";

const published: QuestionPathMenu[] = [
	novaMenu("patients", "Patients", "patient", [
		novaForm("register", "Register", ["/data/name"]),
		novaForm("visit", "Visit", ["/data/notes", "/data/weight"]),
	]),
	novaMenu("surveys", "Surveys", null, [
		novaForm("survey", "Survey", ["/data/q1"]),
	]),
];

/** HQ's copy of exactly the published document. */
function hqOf(menus: readonly QuestionPathMenu[]): HqSideMenu[] {
	return hq(
		menus.map((menu) =>
			hqMenu(
				menu.name,
				menu.caseType ?? "",
				menu.forms.map((form) => hqForm(form.name, form.paths)),
			),
		),
	);
}

function agreed(
	hqSide: HqSideMenu[],
	today: readonly QuestionPathMenu[],
	from = published,
) {
	const result = matchByPublishedDocument(hqSide, from, today);
	if (!result.agrees) throw new Error("HQ's copy was expected to agree.");
	if (result.result.path !== "published-document") {
		throw new Error("Path one gives published-document results.");
	}
	return result.result;
}

describe("the agreement", () => {
	it("holds for HQ's copy of the published document", () => {
		expect(publishedAgreement(hqOf(published), published)).toEqual({
			menus: 0,
			forms: 0,
			names: 0,
			caseTypes: 0,
			paths: 0,
		});
	});

	it("passes HQ's empty case type against a typed menu", () => {
		const hqSide = hqOf(published).map((menu) => ({ ...menu, caseType: "" }));
		expect(matchByPublishedDocument(hqSide, published, published).agrees).toBe(
			true,
		);
	});

	it.each([
		[
			"a menu more",
			(side: HqSideMenu[]) => [
				...side,
				{ ...side[1], position: 2 } as HqSideMenu,
			],
			{ menus: 1 },
		],
		["a menu fewer", (side: HqSideMenu[]) => side.slice(0, 1), { menus: 1 }],
		[
			"a form fewer in one menu",
			(side: HqSideMenu[]) => [
				{ ...(side[0] as HqSideMenu), forms: side[0]?.forms.slice(0, 1) ?? [] },
				side[1] as HqSideMenu,
			],
			{ forms: 1 },
		],
		[
			"a menu's name",
			(side: HqSideMenu[]) => [
				{ ...(side[0] as HqSideMenu), names: ["Clients"] },
				side[1] as HqSideMenu,
			],
			{ names: 1 },
		],
		[
			"a menu's case type another than the published one",
			(side: HqSideMenu[]) => [
				{ ...(side[0] as HqSideMenu), caseType: "household" },
				side[1] as HqSideMenu,
			],
			{ caseTypes: 1 },
		],
		[
			"a form's name",
			(side: HqSideMenu[]) => [
				side[0] as HqSideMenu,
				{
					...(side[1] as HqSideMenu),
					forms: [
						{
							...(side[1]?.forms[0] as HqSideMenu["forms"][number]),
							names: ["Poll"],
						},
					],
				},
			],
			{ names: 1 },
		],
		[
			"one path more",
			(side: HqSideMenu[]) => [
				side[0] as HqSideMenu,
				{
					...(side[1] as HqSideMenu),
					forms: [
						{
							...(side[1]?.forms[0] as HqSideMenu["forms"][number]),
							paths: [
								{ path: "/data/q1", generated: false },
								{ path: "/data/q2", generated: false },
							],
						},
					],
				},
			],
			{ paths: 1 },
		],
	] as const)(
		"fails on %s alone, counted under its kind",
		(_, change, counted) => {
			const changed = change(hqOf(published));
			const result = matchByPublishedDocument(changed, published, published);
			expect(result.agrees).toBe(false);
			if (result.agrees) return;
			expect(result.differences).toEqual({
				menus: 0,
				forms: 0,
				names: 0,
				caseTypes: 0,
				paths: 0,
				...counted,
			});
		},
	);
});

describe("the pairs and their carry to today's document", () => {
	it("pairs by position, whatever the names and paths say", () => {
		const twins = [
			novaMenu("north", "Visits", null, [
				novaForm("n", "Visit", ["/data/notes"]),
			]),
			novaMenu("south", "Visits", null, [
				novaForm("s", "Visit", ["/data/notes"]),
			]),
		];
		const result = agreed(hqOf(twins), twins, twins);
		expect([...result.pairs.menus]).toEqual([
			[0, uuidOf("north")],
			[1, uuidOf("south")],
		]);
		expect(result.pairs.forms).toEqual([
			{ menu: 0, form: 0, uuid: uuidOf("n") },
			{ menu: 1, form: 0, uuid: uuidOf("s") },
		]);
	});

	it("keeps the pair of a form moved to another menu, renamed and stripped of every question", () => {
		const today = [
			novaMenu("patients", "Patients", "patient", [
				novaForm("register", "Register", ["/data/name"]),
			]),
			novaMenu("surveys", "Surveys", null, [
				novaForm("survey", "Survey", ["/data/q1"]),
				novaForm("visit", "Check in", []),
			]),
		];
		const result = agreed(hqOf(published), today);
		expect(result.pairs.forms).toContainEqual({
			menu: 0,
			form: 1,
			uuid: uuidOf("visit"),
		});
		expect(result.addedSince).toBe(0);
		expect(result.goneSince).toBe(0);
	});

	it("gives a removed form or menu no pair, and an added one no pair", () => {
		const today = [
			novaMenu("patients", "Patients", "patient", [
				novaForm("register", "Register", ["/data/name"]),
				novaForm("follow-up", "Follow up", ["/data/next"]),
			]),
		];
		const result = agreed(hqOf(published), today);
		expect([...result.pairs.menus]).toEqual([[0, uuidOf("patients")]]);
		expect(result.pairs.forms).toEqual([
			{ menu: 0, form: 0, uuid: uuidOf("register") },
		]);
		expect(result.goneSince).toBe(3);
		expect(result.addedSince).toBe(1);
	});

	it("pairs the hidden menu of a form still lifted, and none of one no longer lifted", () => {
		const lifted = [
			...published,
			novaMenu(
				"hidden",
				"Register patient",
				"patient",
				[novaForm("lifted-form", "Register patient", ["/data/name"])],
				true,
			),
		];
		const still = agreed(hqOf(lifted), lifted, lifted);
		expect(still.pairs.menus.get(2)).toBe(uuidOf("hidden"));
		const noLonger = [
			novaMenu("patients", "Patients", "patient", [
				novaForm("register", "Register", ["/data/name"]),
				novaForm("visit", "Visit", ["/data/notes", "/data/weight"]),
				novaForm("lifted-form", "Register patient", ["/data/name"]),
			]),
			published[1] as QuestionPathMenu,
		];
		const result = agreed(hqOf(lifted), noLonger, lifted);
		expect(result.pairs.menus.has(2)).toBe(false);
		expect(result.pairs.forms).toContainEqual({
			menu: 2,
			form: 0,
			uuid: uuidOf("lifted-form"),
		});
		const newlyLifted = agreed(hqOf(published), lifted);
		expect([...newlyLifted.pairs.menus.values()]).not.toContain(
			uuidOf("hidden"),
		);
		expect(newlyLifted.addedSince).toBe(2);
	});
});
