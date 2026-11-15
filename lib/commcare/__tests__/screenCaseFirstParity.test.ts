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
import { menuEmittedAdvanced } from "@/lib/domain/advancedEntryDatums";
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

/**
 * The draw with each menu that has a case type emitted advanced (its kind
 * held, `Module.heldKind`) where `kinds` draws it so, in module order, so a
 * basic submenu meets an advanced parent and the reverse; each case-loading
 * form of an advanced menu with its own load holding the drawn tag (none, the
 * case list entry's own `case_<type>`, or another a published app could
 * keep), where the gate admits it; else undefined.
 */
function advancedVariant(
	base: BlueprintDoc,
	tags: readonly (number | undefined)[],
	kinds: readonly boolean[],
): BlueprintDoc | undefined {
	const doc = structuredClone(base);
	let at = 0;
	let typed = 0;
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod?.caseType === undefined) continue;
		if (kinds[typed++ % kinds.length] !== true) continue;
		mod.heldKind = "advanced";
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const own = doc.forms[formUuid]?.caseOperations?.find(
				(operation) => operation.action === "own",
			);
			const drawn = tags[at++ % tags.length];
			if (own === undefined || drawn === undefined) continue;
			own.placement = {
				kind: "advanced",
				tag: drawn === 0 ? `case_${mod.caseType}` : `kept_${drawn}`,
			};
		}
	}
	rebuildFieldParent(doc);
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).length === 0
		? doc
		: undefined;
}

it("answers as Core does for every screen of the corpus with its menus emitted advanced", {
	timeout: 60_000,
}, () => {
	let screens = 0;
	let caseFirst = 0;
	let admitted = 0;
	assertGenerated(
		fc.property(
			menuScreenDocArbitrary,
			fc.array(fc.option(fc.nat(2), { nil: undefined }), {
				minLength: 1,
				maxLength: 6,
			}),
			fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
			(base, tags, kinds) => {
				const doc = advancedVariant(base, tags, kinds);
				if (doc === undefined) return;
				admitted++;
				for (const answer of answers(doc)) {
					screens++;
					if (answer.core) caseFirst++;
					expect(answer.nova, answer.menu).toBe(answer.core);
				}
			},
		),
		{ seed: 20261114, numRuns: 80 },
	);
	expect(admitted).toBeGreaterThan(20);
	expect(caseFirst).toBeGreaterThan(5);
	expect(screens - caseFirst).toBeGreaterThan(5);
});

const visit = (name: string) => ({
	name,
	type: "followup" as const,
	fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
});

/** A parent menu of patients that keeps its screen, and a submenu that
 *  shows its forms there, or keeps a screen of its own (`ownScreen`), with
 *  its case list as an entry after its forms (`caseListMenuItem`) or as its
 *  only entry (`bareCaseList`). */
function sharedScreen(
	submenu: Partial<{
		caseType: string;
		bareCaseList: boolean;
		caseListMenuItem: boolean;
		registration: boolean;
		ownScreen: boolean;
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
				...((submenu.bareCaseList === true ||
					submenu.caseListMenuItem === true) && { caseListMenuItem: {} }),
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
	if (submenu.ownScreen !== true)
		doc.modules[testUuid("submenu")].formsInMenuAbove = true;
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

/** `sharedScreen(submenu)` with the parent's kind held advanced and the
 *  submenu basic. A new document object, since every projection caches its
 *  answers per document. */
function underAdvancedParent(
	submenu: Parameters<typeof sharedScreen>[0],
): BlueprintDoc {
	const doc = structuredClone(sharedScreen(submenu));
	doc.modules[testUuid("parent")].heldKind = "advanced";
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expect(menuEmittedAdvanced(doc, testUuid("parent"))).toBe(true);
	expect(menuEmittedAdvanced(doc, testUuid("submenu"))).toBe(false);
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

/** A menu emitted advanced (its kind held by a publish, `Module.heldKind`)
 *  holding two follow-up forms and, unless left out, its case list as an
 *  entry of its own. `heldTags` gives a form's own load the tag a publish
 *  recorded (its own operation's `placement`); `reviewQuestion` names the
 *  second form's question. */
function advancedWithCaseListEntry(
	options: {
		readonly caseListMenuItem?: false;
		readonly heldTags?: readonly [string | undefined, string | undefined];
		readonly reviewQuestion?: string;
	} = {},
): BlueprintDoc {
	const review = visit("Review patient");
	const doc = buildDoc({
		appName: "Advanced entry",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "advanced",
				name: "Patients",
				caseType: "patient",
				...(options.caseListMenuItem !== false && { caseListMenuItem: {} }),
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					visit("Check patient"),
					options.reviewQuestion === undefined
						? review
						: {
								...review,
								fields: [
									f({
										kind: "text",
										id: options.reviewQuestion,
										label: proseText("Note"),
									}),
								],
							},
				],
			},
		],
	});
	const moduleUuid = testUuid("advanced");
	doc.modules[moduleUuid].heldKind = "advanced";
	(doc.formOrder[moduleUuid] ?? []).forEach((formUuid, index) => {
		const tag = options.heldTags?.[index];
		const own = doc.forms[formUuid]?.caseOperations?.[0];
		if (tag !== undefined && own?.action === "own")
			own.placement = { kind: "advanced", tag };
	});
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

describe("an advanced menu, by the datum each entry asks for first", () => {
	// Each load gives its entry `case_id_<tag>`
	// (`models/form_actions.py::LoadUpdateAction.case_session_var`), and Core
	// asks for a case first only where every entry needs one datum id first.
	it("asks for the case first where both forms load under one tag", () => {
		expect(
			answers(advancedWithCaseListEntry({ caseListMenuItem: false })),
		).toEqual([{ menu: "Patients", nova: true, core: true }]);
	});

	it("lists forms first where a published app keeps one form's load under another tag", () => {
		expect(
			answers(
				advancedWithCaseListEntry({
					caseListMenuItem: false,
					heldTags: [undefined, "patient"],
				}),
			),
		).toEqual([{ menu: "Patients", nova: false, core: false }]);
	});

	it("lists forms first where a question steps one form's derived tag", () => {
		// `case_load_patient0` at the root takes the block of `load_patient0`,
		// so that form's load is `load_patient1`.
		expect(
			answers(
				advancedWithCaseListEntry({
					caseListMenuItem: false,
					reviewQuestion: "case_load_patient0",
				}),
			),
		).toEqual([{ menu: "Patients", nova: false, core: false }]);
	});

	it("asks for the case first where both forms keep the entry's own tag", () => {
		// A load tagged `case_patient` asks for `case_id_case_patient`, the
		// datum of HQ's case list entry.
		expect(
			answers(
				advancedWithCaseListEntry({
					heldTags: ["case_patient", "case_patient"],
				}),
			),
		).toEqual([{ menu: "Patients", nova: true, core: true }]);
	});

	it("asks for the case first where a submenu's forms align with its advanced parent's", () => {
		// The submenu's selection takes the parent's `case_id_load_patient0`
		// (`formLinkProjection.ts::alignWithRootMenu`).
		expect(
			answers(underAdvancedParent({})).find(
				(answer) => answer.menu === "Patients",
			),
		).toEqual({
			menu: "Patients",
			nova: true,
			core: true,
		});
	});

	it("asks for the case first where a basic submenu's only entry, its case list, aligns with its advanced parent's form", () => {
		// HQ's `add_parent_datums` gives the submenu's case list entry the
		// parent form's `case_id_load_patient0`, so every entry on the parent's
		// screen asks for that datum first.
		expect(
			answers(underAdvancedParent({ bareCaseList: true })).find(
				(answer) => answer.menu === "Patients",
			),
		).toEqual({ menu: "Patients", nova: true, core: true });
	});

	it("asks for the case first on a basic submenu's own screen, whose form and case list entry both align with its advanced parent's form", () => {
		expect(
			answers(
				underAdvancedParent({ ownScreen: true, caseListMenuItem: true }),
			).find((answer) => answer.menu === "More"),
		).toEqual({ menu: "More", nova: true, core: true });
	});
});

describe("an advanced menu's case list entry", () => {
	it("lists forms first, as Core does, because the entry asks for a datum of its own", () => {
		// The forms load `case_id_load_patient0`, the entry asks for HQ's
		// `case_id_case_patient` (`entries.py::EntriesHelper.entry_for_module`),
		// so `getDataNeededByAllEntries` finds no one datum and Core lists
		// the menu.
		expect(answers(advancedWithCaseListEntry())).toEqual([
			{ menu: "Patients", nova: false, core: false },
		]);
	});

	it("asks for the case first, as Core does, once the menu holds no such entry", () => {
		const doc = advancedWithCaseListEntry({ caseListMenuItem: false });
		expect(answers(doc)).toEqual([
			{ menu: "Patients", nova: true, core: true },
		]);
	});
});
