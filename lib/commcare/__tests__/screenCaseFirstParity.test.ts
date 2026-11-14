/**
 * Whether a screen asks for a case before its forms, Nova's answer
 * (`lib/domain/menuScreens.ts::screenChoosesCaseFirst`, with
 * `screenIsBareCaseList` for a screen Core opens on its list) against
 * CommCare Core's own question over the local suite Nova writes: every entry
 * of every command of every `<menu>` whose id is the screen's
 * (`CommCareSession.getEntriesForCommand`), and whether each needs the same
 * datum first and it is a case choice (`getDataNeededByAllEntries`), a
 * computed datum every entry shares being collected first, as Core collects
 * it before asking again. Over the `menu-screens` corpus and documents built
 * for each case-first blocker.
 */
import AdmZip from "adm-zip";
import type { Element } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import {
	formLinkProjectionContext,
	menuIdOf,
} from "@/lib/commcare/formLinkProjection";
import { runValidation } from "@/lib/commcare/validator/runner";
import { parseXml } from "@/lib/commcare/xmlParse";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type MenuScreen,
	moduleHasOwnScreen,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertGenerated, manifestFor } from "./compilerEvidence";
import { menuScreenDocArbitrary } from "./menuScreenDocArbitrary";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

function tagChildren(element: Element): Element[] {
	return getChildren(element).filter(
		(child): child is Element => child.type === "tag",
	);
}

type SessionNeed = { readonly id: string; readonly computed: boolean };

/** Each `<entry>` and `<remote-request>` by its command id, with the datums
 *  its session needs in order. */
function sessionNeeds(suite: ReturnType<typeof parseXml>) {
	const needs = new Map<string, readonly SessionNeed[]>();
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
				datum.attribs.id === undefined
					? []
					: [
							{
								id: datum.attribs.id,
								computed:
									datum.name === "datum" &&
									datum.attribs.function !== undefined,
							},
						],
			),
		);
	}
	return needs;
}

/** Core's answer for the screen whose menu id is `menuId`. */
function wireChoosesCaseFirst(
	suite: ReturnType<typeof parseXml>,
	menuId: string,
): boolean {
	const needs = sessionNeeds(suite);
	const commands = findAll(
		(element) => element.name === "menu" && element.attribs.id === menuId,
		suite.children,
	).flatMap((menu) =>
		tagChildren(menu)
			.filter((child) => child.name === "command")
			.map((command) => command.attribs.id ?? ""),
	);
	const entries = commands.map((command) => {
		const entry = needs.get(command);
		if (entry === undefined)
			throw new Error(`The suite has no entry for command ${command}.`);
		return entry;
	});
	if (entries.length === 0) return false;
	const collected = new Set<string>();
	for (;;) {
		const firsts = entries.map((entry) =>
			entry.find((need) => !collected.has(need.id)),
		);
		const [first] = firsts;
		if (
			first === undefined ||
			firsts.some((need) => need === undefined || need.id !== first.id)
		)
			return false;
		if (!first.computed) return true;
		collected.add(first.id);
	}
}

function suiteOf(doc: BlueprintDoc): ReturnType<typeof parseXml> {
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

/** Every screen of the document, with Nova's answer and Core's. */
function answers(doc: BlueprintDoc) {
	const suite = suiteOf(doc);
	const emitted = emissionPlan(doc).doc;
	const ctx = formLinkProjectionContext(emitted);
	return doc.moduleOrder
		.filter((moduleUuid) => moduleHasOwnScreen(doc, moduleUuid))
		.map((moduleUuid) => {
			const screen: MenuScreen = { kind: "menu", moduleUuid };
			return {
				menu: doc.modules[moduleUuid]?.name,
				nova:
					screenChoosesCaseFirst(doc, screen) ||
					screenIsBareCaseList(doc, screen),
				core: wireChoosesCaseFirst(suite, menuIdOf(emitted, ctx, moduleUuid)),
			};
		});
}

it("answers as Core does for every screen of the menu-screens corpus", {
	timeout: 60_000,
}, () => {
	let screens = 0;
	let caseFirst = 0;
	assertGenerated(
		fc.property(menuScreenDocArbitrary, (doc) => {
			for (const answer of answers(doc)) {
				screens++;
				if (answer.core) caseFirst++;
				expect(answer.nova, answer.menu).toBe(answer.core);
			}
		}),
		{ seed: 20261116, numRuns: 80 },
	);
	expect(caseFirst).toBeGreaterThan(10);
	expect(screens - caseFirst).toBeGreaterThan(10);
});

const visit = (name: string) => ({
	name,
	type: "followup" as const,
	fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
});

/** A parent menu of patients that keeps its screen, and a submenu that
 *  shows its forms there. */
function sharedScreen(
	submenu: Partial<{
		caseType: string;
		bareCaseList: boolean;
		registration: boolean;
	}>,
): BlueprintDoc {
	const caseType = submenu.caseType ?? "patient";
	const doc = buildDoc({
		appName: "Shared screen",
		caseTypes: [
			{ name: "patient", properties: [] },
			...(caseType === "patient" ? [] : [{ name: caseType, properties: [] }]),
		],
		modules: [
			{
				uuid: "parent",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [visit("Patient visit")],
			},
			{
				uuid: "submenu",
				name: "More",
				caseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				...(submenu.bareCaseList === true && { caseListMenuItem: {} }),
				forms:
					submenu.bareCaseList === true
						? []
						: submenu.registration === true
							? [
									{
										name: "Register",
										type: "registration",
										fields: [
											f({
												kind: "text",
												id: "case_name",
												label: proseText("Name"),
												caseWrite: { caseType, property: "case_name" },
											}),
										],
									},
								]
							: [visit("Second visit")],
			},
		],
	});
	doc.modules[testUuid("submenu")].parentModuleUuid = testUuid("parent");
	doc.modules[testUuid("submenu")].formsInMenuAbove = true;
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

describe("a screen two menus list forms on", () => {
	const parentScreen = (doc: BlueprintDoc) =>
		answers(doc).find((answer) => answer.menu === "Patients");

	it("asks for the case first where every entry opens the same case", () => {
		expect(parentScreen(sharedScreen({}))).toEqual({
			menu: "Patients",
			nova: true,
			core: true,
		});
	});

	it("lists forms first where a submenu's form opens without a case", () => {
		// The submenu registers a household: a patient's registration under
		// "Patients" is refused (`NESTED_MENU_NEW_CASE_TAKES_ROOT_CASE`).
		expect(
			parentScreen(sharedScreen({ registration: true, caseType: "household" })),
		).toEqual({
			menu: "Patients",
			nova: false,
			core: false,
		});
	});

	it("stays case first where a submenu whose only entry is its case list chooses the same case", () => {
		expect(parentScreen(sharedScreen({ bareCaseList: true }))).toEqual({
			menu: "Patients",
			nova: true,
			core: true,
		});
	});

	it("lists forms first where that case list chooses another case", () => {
		expect(
			parentScreen(sharedScreen({ bareCaseList: true, caseType: "household" })),
		).toEqual({ menu: "Patients", nova: false, core: false });
	});
});
