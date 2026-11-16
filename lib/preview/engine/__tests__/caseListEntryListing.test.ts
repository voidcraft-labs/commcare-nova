/**
 * Whether the running app lists a menu's case list entry, Preview's answer
 * (`caseListEntryListing.ts::caseListEntryStillNeedsDatum`) against CommCare
 * Core's own reading of the local suite Nova writes: walking the `<menu>`
 * chain from the first menu to the screen that lists the entry, Core collects
 * at each screen every datum all of its commands' entries need first
 * (`CommCareSession.getNeededData` → `getDataNeededByAllEntries`), and then
 * lists the entry's view only where one of its datums is still missing
 * (`MenuLoader.addRelevantCommandEntries`, `getNeededDatum(e) == null`). Over
 * the `menu-screens` corpus with every menu of a case type given the entry,
 * and over the shapes that list it on a case-first screen.
 */
import AdmZip from "adm-zip";
import type { Element } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import * as fc from "fast-check";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	assertGenerated,
	manifestFor,
} from "@/lib/commcare/__tests__/compilerEvidence";
import { menuScreenDocArbitrary } from "@/lib/commcare/__tests__/menuScreenDocArbitrary";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import {
	formLinkProjectionContext,
	menuIdOf,
	moduleIndexOf,
} from "@/lib/commcare/formLinkProjection";
import { runValidation } from "@/lib/commcare/validator/runner";
import { parseXml } from "@/lib/commcare/xmlParse";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	menuScreenOf,
	moduleHasCaseListMenuItem,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
	type Uuid,
} from "@/lib/domain";
import { caseListEntryStillNeedsDatum } from "../caseListEntryListing";

type Suite = ReturnType<typeof parseXml>;

function tagChildren(element: Element): Element[] {
	return getChildren(element).filter(
		(child): child is Element => child.type === "tag",
	);
}

function suiteOf(doc: BlueprintDoc): Suite {
	const assets = manifestFor(doc);
	const zip = new AdmZip(
		compileCcz(expandDoc(doc, { assets }), doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
			assets,
		}),
	);
	const suite = zip.getEntry("suite.xml");
	if (suite === null) throw new Error("The archive has no suite.xml.");
	return parseXml(suite.getData().toString("utf8"));
}

/** Each `<entry>` and `<remote-request>` by its command id, with the ids of
 *  the datums its session needs, in order. */
function sessionNeeds(suite: Suite): Map<string, readonly string[]> {
	const needs = new Map<string, readonly string[]>();
	for (const entry of findAll(
		(element) => element.name === "entry" || element.name === "remote-request",
		suite.children,
	)) {
		const command = tagChildren(entry).find(
			(child) => child.name === "command",
		);
		const id =
			command === undefined ? undefined : getAttributeValue(command, "id");
		if (id === undefined) continue;
		const session = tagChildren(entry).find(
			(child) => child.name === "session",
		);
		needs.set(
			id,
			(session === undefined ? [] : tagChildren(session)).flatMap((datum) =>
				datum.attribs.id === undefined ? [] : [datum.attribs.id],
			),
		);
	}
	return needs;
}

/** Core's listing of the view `m<i>-case-list` on the screen whose menu id
 *  is `menuId`, reached through the menus its `root` names. */
function coreListsView(
	suite: Suite,
	menuId: string,
	viewCommand: string,
): boolean {
	const needs = sessionNeeds(suite);
	const menus = (id: string) =>
		findAll(
			(element) => element.name === "menu" && element.attribs.id === id,
			suite.children,
		);
	const path: string[] = [];
	for (
		let id: string | undefined = menuId;
		id !== undefined && id !== "root" && !path.includes(id);
		id = menus(id)[0]?.attribs.root
	)
		path.unshift(id);
	const collected = new Set<string>();
	for (const id of path) {
		const entries = menus(id).flatMap((menu) =>
			tagChildren(menu)
				.filter((child) => child.name === "command")
				.map((command) => {
					const entry = needs.get(command.attribs.id ?? "");
					if (entry === undefined)
						throw new Error(
							`The suite has no entry for command ${command.attribs.id}.`,
						);
					return entry;
				}),
		);
		for (;;) {
			const firsts = entries.map((entry) =>
				entry.find((datum) => !collected.has(datum)),
			);
			const [first] = firsts;
			if (
				first === undefined ||
				firsts.some((datum) => datum === undefined || datum !== first)
			)
				break;
			collected.add(first);
		}
	}
	const view = needs.get(viewCommand);
	if (view === undefined)
		throw new Error(`The suite has no entry for ${viewCommand}.`);
	return view.some((datum) => !collected.has(datum));
}

/** Each module's entry that a menu screen lists, Preview's answer and
 *  Core's, with whether that screen chooses its case first. */
function answers(doc: BlueprintDoc) {
	const suite = suiteOf(doc);
	const emitted = emissionPlan(doc).doc;
	const ctx = formLinkProjectionContext(emitted);
	return doc.moduleOrder.flatMap((moduleUuid) => {
		const mod = doc.modules[moduleUuid];
		const screen = menuScreenOf(doc, moduleUuid);
		if (
			mod === undefined ||
			mod.caseType === undefined ||
			!moduleHasCaseListMenuItem(mod) ||
			screenIsBareCaseList(doc, screen)
		)
			return [];
		return [
			{
				menu: mod.name,
				caseFirst: screenChoosesCaseFirst(doc, screen),
				preview: caseListEntryStillNeedsDatum(doc, moduleUuid),
				core: coreListsView(
					suite,
					menuIdOf(emitted, ctx, moduleUuid),
					`m${moduleIndexOf(ctx, moduleUuid)}-case-list`,
				),
			},
		];
	});
}

/** The document with every menu of a case type holding its case list
 *  entry, where the gate admits that; else the document as drawn. */
function withEntries(doc: BlueprintDoc): BlueprintDoc {
	const next = structuredClone(doc);
	for (const mod of Object.values(next.modules))
		if (mod.caseType !== undefined && mod.caseListMenuItem === undefined)
			mod.caseListMenuItem = {};
	rebuildFieldParent(next);
	return runValidation(next, LOOKUP_CONTEXT_UNAVAILABLE).length === 0
		? next
		: doc;
}

it("lists each case list entry where Core lists it over the menu-screens corpus", {
	timeout: 60_000,
}, () => {
	let listed = 0;
	let unlisted = 0;
	assertGenerated(
		fc.property(menuScreenDocArbitrary, (drawn) => {
			for (const answer of answers(withEntries(drawn))) {
				if (answer.core) listed++;
				else unlisted++;
				expect(answer.preview, answer.menu).toBe(answer.core);
			}
		}),
		{ seed: 20261114, numRuns: 60 },
	);
	expect(listed).toBeGreaterThan(10);
	expect(unlisted).toBeGreaterThan(10);
});

const HOUSEHOLDS = testUuid("listing-households");
const PEOPLE = testUuid("listing-people");
const EXTRAS = testUuid("listing-extras");

/** Households, case first with a follow-up and its own case list entry;
 *  under it "People" (a household's members, chosen under the household)
 *  with a follow-up and its case list entry, showing them on the
 *  households' screen or keeping a screen of its own; and, where `extras`,
 *  "Extras", a submenu of households holding a survey and its case list
 *  entry. */
function households(peopleAbove: boolean, extras = false): BlueprintDoc {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const visit = (name: string) => ({
		name,
		type: "followup" as const,
		fields: [f({ kind: "text", id: "note" })],
	});
	const doc = buildDoc({
		appName: "Listing",
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "person", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: HOUSEHOLDS,
				name: "Households",
				caseType: "household",
				caseListMenuItem: {},
				caseListConfig: list(),
				forms: [visit("Visit household")],
			},
			{
				uuid: PEOPLE,
				name: "People",
				caseType: "person",
				parentCaseModuleUuid: HOUSEHOLDS,
				caseListMenuItem: {},
				caseListConfig: list(),
				forms: [visit("Visit person")],
			},
			...(extras
				? [
						{
							uuid: EXTRAS,
							name: "Extras",
							caseType: "household",
							caseListMenuItem: {},
							caseListConfig: list(),
							forms: [
								{
									name: "Survey",
									type: "survey" as const,
									fields: [f({ kind: "text", id: "answer" })],
								},
							],
						},
					]
				: []),
		],
	});
	doc.modules[PEOPLE].parentModuleUuid = HOUSEHOLDS;
	if (peopleAbove) doc.modules[PEOPLE].formsInMenuAbove = true;
	if (extras) doc.modules[EXTRAS].parentModuleUuid = HOUSEHOLDS;
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

const answerOf = (doc: BlueprintDoc, moduleUuid: Uuid) =>
	answers(doc).find((answer) => answer.menu === doc.modules[moduleUuid].name);

it("lists the entry of a menu above whose list chooses a child of the case the screen chose, and never the screen's own", () => {
	const doc = households(true);
	expect(answerOf(doc, PEOPLE)).toEqual({
		menu: "People",
		caseFirst: true,
		preview: true,
		core: true,
	});
	expect(answerOf(doc, HOUSEHOLDS)).toEqual({
		menu: "Households",
		caseFirst: true,
		preview: false,
		core: false,
	});
});

it("does not list a submenu's entry whose cases its screen and the screen above it chose", () => {
	expect(answerOf(households(false), PEOPLE)).toEqual({
		menu: "People",
		caseFirst: true,
		preview: false,
		core: false,
	});
});

it("does not list a forms-first submenu's entry whose case the screen above it chose", () => {
	expect(answerOf(households(false, true), EXTRAS)).toEqual({
		menu: "Extras",
		caseFirst: false,
		preview: false,
		core: false,
	});
});
