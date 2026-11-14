/**
 * Which screen lists what (`lib/domain/menuScreens.ts`), over documents
 * built by the production fixture builder. A screen is CommCare Core's
 * `MenuLoader.getMenuDisplayables` over the `<menu>` elements both exports
 * write: a menu that shows its forms in the menu above contributes its forms
 * and case list entry in place, where its own entry would be. Whether the
 * screen chooses a case first is Core's one question over every entry it
 * lists (`CommCareSession.getDataNeededByAllEntries`); the wire's own
 * answer is held by the parity test over the emitted suite.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FormSpec } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	conditionModulesOf,
	type MenuScreen,
	type MenuScreenEntry,
	menuAbove,
	menuFormUuidsOf,
	menuScreenContributors,
	menuScreenEntries,
	menuScreenOf,
	menuTileScreenOf,
	moduleHasCaseListMenuItem,
	moduleHasOwnScreen,
	moduleIsCaseFirst,
	moduleSiblingUuids,
	screenCaseFirstBlocker,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const FIRST_MENU: MenuScreen = { kind: "first-menu" };
const screenOf = (moduleUuid: Uuid): MenuScreen => ({
	kind: "menu",
	moduleUuid,
});

const followup = (uuid: string, name = uuid): FormSpec => ({
	uuid,
	name,
	type: "followup",
	fields: [{ kind: "text", id: "note", label: "Note" }],
});
const registration = (uuid: string, name = uuid): FormSpec => ({
	uuid,
	name,
	type: "registration",
	fields: [
		{
			kind: "text",
			id: "case_name",
			label: "Name",
			caseWrite: { caseType: "patient", property: "case_name" },
		},
	],
});
const survey = (uuid: string): FormSpec => ({
	uuid,
	name: uuid,
	type: "survey",
	fields: [{ kind: "text", id: "q", label: "Q" }],
});

/** Sets the menu hierarchy and the slot after the fixture is assembled:
 *  `parents` maps a child's label to its parent's, `above` lists the labels
 *  that show their forms in the menu above. Modules are given in preorder. */
function arranged(
	doc: BlueprintDoc,
	parents: Readonly<Record<string, string>>,
	above: readonly string[],
): void {
	for (const [child, parent] of Object.entries(parents))
		doc.modules[testUuid(child)].parentModuleUuid = testUuid(parent);
	for (const label of above)
		doc.modules[testUuid(label)].formsInMenuAbove = true;
}

const form = (moduleLabel: string, formLabel: string): MenuScreenEntry => ({
	kind: "form",
	moduleUuid: testUuid(moduleLabel),
	formUuid: testUuid(formLabel),
});
const tile = (moduleLabel: string): MenuScreenEntry => ({
	kind: "menu",
	moduleUuid: testUuid(moduleLabel),
});
const caseList = (moduleLabel: string): MenuScreenEntry => ({
	kind: "case-list",
	moduleUuid: testUuid(moduleLabel),
});

/** Today's listing for a document without the slot: the first menu lists
 *  every top-level module, and a menu its menu forms, its case list entry,
 *  then its submenus. */
function listingWithoutTheSlot(
	doc: BlueprintDoc,
	screen: MenuScreen,
): MenuScreenEntry[] {
	if (screen.kind === "first-menu")
		return moduleSiblingUuids(doc, null).map((moduleUuid) => ({
			kind: "menu",
			moduleUuid,
		}));
	const mod = doc.modules[screen.moduleUuid];
	return [
		...menuFormUuidsOf(doc, screen.moduleUuid).map(
			(formUuid): MenuScreenEntry => ({
				kind: "form",
				moduleUuid: screen.moduleUuid,
				formUuid,
			}),
		),
		...(mod !== undefined && moduleHasCaseListMenuItem(mod)
			? [{ kind: "case-list" as const, moduleUuid: screen.moduleUuid }]
			: []),
		...moduleSiblingUuids(doc, screen.moduleUuid).map(
			(moduleUuid): MenuScreenEntry => ({ kind: "menu", moduleUuid }),
		),
	];
}

describe("a document without the slot", () => {
	const doc = buildDoc(
		{
			modules: [
				{
					uuid: "households",
					name: "Households",
					caseType: "patient",
					caseListMenuItem: {},
					forms: [registration("h-register"), followup("h-visit")],
				},
				{
					uuid: "members",
					name: "Members",
					caseType: "patient",
					forms: [followup("m-visit")],
				},
				{ uuid: "surveys", name: "Surveys", forms: [survey("s-one")] },
			],
		},
		(draft) => arranged(draft, { members: "households" }, []),
	);

	it("lists every screen as it does today", () => {
		for (const screen of [
			FIRST_MENU,
			...doc.moduleOrder.map((uuid) => screenOf(uuid)),
		])
			expect(menuScreenEntries(doc, screen)).toEqual(
				listingWithoutTheSlot(doc, screen),
			);
	});

	it("gives every module its own screen, entered from where it sits", () => {
		for (const moduleUuid of doc.moduleOrder) {
			expect(moduleHasOwnScreen(doc, moduleUuid)).toBe(true);
			expect(menuScreenOf(doc, moduleUuid)).toEqual(screenOf(moduleUuid));
			expect(conditionModulesOf(doc, moduleUuid)).toEqual([moduleUuid]);
		}
		expect(menuTileScreenOf(doc, testUuid("households"))).toEqual(FIRST_MENU);
		expect(menuTileScreenOf(doc, testUuid("members"))).toEqual(
			screenOf(testUuid("households")),
		);
	});

	it("answers case first as each module's own forms do", () => {
		for (const moduleUuid of doc.moduleOrder)
			expect(screenChoosesCaseFirst(doc, screenOf(moduleUuid))).toBe(
				moduleIsCaseFirst(doc, moduleUuid),
			);
		expect(screenChoosesCaseFirst(doc, FIRST_MENU)).toBe(false);
	});
});

describe("a top-level menu that shows its forms on the first menu", () => {
	const doc = buildDoc(
		{
			modules: [
				{ uuid: "intro", name: "Intro", forms: [survey("intro-form")] },
				{
					uuid: "clients",
					name: "Clients",
					caseType: "patient",
					caseListMenuItem: {},
					forms: [registration("register"), followup("visit")],
				},
				{
					uuid: "follow",
					name: "Follow up",
					caseType: "patient",
					forms: [followup("follow-visit")],
				},
				{
					uuid: "notes",
					name: "Notes",
					caseType: "patient",
					forms: [followup("note")],
				},
				{ uuid: "outro", name: "Outro", forms: [survey("outro-form")] },
			],
		},
		(draft) =>
			arranged(draft, { follow: "clients", notes: "clients" }, [
				"clients",
				"notes",
			]),
	);
	const clients = testUuid("clients");

	it("lists its forms and case list entry in place, then its submenus", () => {
		expect(menuScreenEntries(doc, FIRST_MENU)).toEqual([
			tile("intro"),
			form("clients", "register"),
			form("clients", "visit"),
			caseList("clients"),
			tile("follow"),
			form("notes", "note"),
			tile("outro"),
		]);
		expect(menuScreenContributors(doc, FIRST_MENU)).toEqual([
			clients,
			testUuid("notes"),
		]);
	});

	it("has no entry and no screen of its own", () => {
		expect(moduleHasOwnScreen(doc, clients)).toBe(false);
		expect(menuTileScreenOf(doc, clients)).toBeUndefined();
		expect(menuScreenOf(doc, clients)).toEqual(FIRST_MENU);
		expect(menuScreenEntries(doc, screenOf(clients))).toEqual([]);
	});

	it("lists a submenu that keeps its screen on the first menu by itself", () => {
		const follow = testUuid("follow");
		expect(menuTileScreenOf(doc, follow)).toEqual(FIRST_MENU);
		expect(conditionModulesOf(doc, follow)).toEqual([follow]);
	});

	it("gates a submenu above by its parent too", () => {
		expect(menuScreenOf(doc, testUuid("notes"))).toEqual(FIRST_MENU);
		expect(conditionModulesOf(doc, testUuid("notes"))).toEqual([
			testUuid("notes"),
			clients,
		]);
		expect(menuAbove(doc, testUuid("notes"))).toEqual({ kind: "first-menu" });
		expect(menuAbove(doc, clients)).toEqual({ kind: "first-menu" });
	});

	it("chooses a form first, since Core asks for a command there", () => {
		expect(screenCaseFirstBlocker(doc, FIRST_MENU)).toEqual({
			reason: "first-menu",
		});
		expect(screenChoosesCaseFirst(doc, FIRST_MENU)).toBe(false);
	});
});

describe("a submenu that shows its forms in a parent that keeps its screen", () => {
	const build = (child: {
		forms: FormSpec[];
		caseType?: string;
		caseListMenuItem?: true;
	}) =>
		buildDoc(
			{
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
					},
					{
						name: "visit",
						parent_type: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
					},
				],
				modules: [
					{
						uuid: "patients",
						name: "Patients",
						caseType: "patient",
						forms: [followup("p-visit", "Patient visit")],
					},
					{
						uuid: "extra",
						name: "Extra",
						caseType: child.caseType ?? "patient",
						...(child.caseListMenuItem && { caseListMenuItem: {} }),
						forms: child.forms,
					},
				],
			},
			(draft) => arranged(draft, { extra: "patients" }, ["extra"]),
		);
	const patients = testUuid("patients");
	const extra = testUuid("extra");

	it("lists the submenu's forms on the parent's screen after the parent's own", () => {
		const doc = build({ forms: [followup("e-visit")] });
		expect(menuScreenOf(doc, extra)).toEqual(screenOf(patients));
		expect(menuScreenEntries(doc, screenOf(patients))).toEqual([
			form("patients", "p-visit"),
			form("extra", "e-visit"),
		]);
		expect(menuScreenEntries(doc, FIRST_MENU)).toEqual([tile("patients")]);
		expect(conditionModulesOf(doc, extra)).toEqual([extra, patients]);
		expect(menuAbove(doc, extra)).toEqual({
			kind: "menu",
			moduleUuid: patients,
			name: "Patients",
		});
	});

	it("keeps the parent's screen case first while every form opens its case", () => {
		const doc = build({ forms: [followup("e-visit")] });
		expect(screenCaseFirstBlocker(doc, screenOf(patients))).toBeUndefined();
		expect(screenChoosesCaseFirst(doc, screenOf(patients))).toBe(true);
	});

	it("turns the parent's screen forms first with a form that opens without a case", () => {
		const doc = build({ forms: [registration("e-register")] });
		expect(moduleIsCaseFirst(doc, patients)).toBe(true);
		expect(screenCaseFirstBlocker(doc, screenOf(patients))).toEqual({
			reason: "opens-without-a-case",
			moduleUuid: extra,
			formUuid: testUuid("e-register"),
		});
		expect(screenChoosesCaseFirst(doc, screenOf(patients))).toBe(false);
	});

	it("turns the parent's screen forms first where the submenu chooses another case", () => {
		const doc = build({ caseType: "visit", forms: [followup("e-visit")] });
		expect(screenCaseFirstBlocker(doc, screenOf(patients))).toEqual({
			reason: "chooses-another-case",
			moduleUuid: extra,
		});
	});

	it("reads a case-list-only submenu by its list's selection", () => {
		const same = build({ forms: [], caseListMenuItem: true });
		expect(menuScreenEntries(same, screenOf(patients))).toEqual([
			form("patients", "p-visit"),
			caseList("extra"),
		]);
		expect(screenChoosesCaseFirst(same, screenOf(patients))).toBe(true);

		const other = build({
			forms: [],
			caseType: "visit",
			caseListMenuItem: true,
		});
		expect(screenCaseFirstBlocker(other, screenOf(patients))).toEqual({
			reason: "chooses-another-case",
			moduleUuid: extra,
		});
	});

	it("reads a prepared form's type in place of the stored one", () => {
		const doc = build({ forms: [followup("e-visit")] });
		expect(
			screenChoosesCaseFirst(doc, screenOf(patients), {
				formUuid: testUuid("e-visit"),
				type: "registration",
			}),
		).toBe(false);
	});
});

describe("a submenu above under a parent above", () => {
	const doc = buildDoc(
		{
			modules: [
				{
					uuid: "outer",
					name: "Outer",
					caseType: "patient",
					forms: [followup("o-visit")],
				},
				{
					uuid: "inner",
					name: "Inner",
					caseType: "patient",
					forms: [followup("i-visit")],
				},
			],
		},
		(draft) => arranged(draft, { inner: "outer" }, ["outer", "inner"]),
	);

	it("lists both menus' forms on the first menu", () => {
		expect(menuScreenOf(doc, testUuid("inner"))).toEqual(FIRST_MENU);
		expect(menuScreenEntries(doc, FIRST_MENU)).toEqual([
			form("outer", "o-visit"),
			form("inner", "i-visit"),
		]);
		expect(menuAbove(doc, testUuid("inner"))).toEqual({ kind: "first-menu" });
	});
});

describe("a bare case list", () => {
	const doc = buildDoc({
		modules: [
			{
				uuid: "browse",
				name: "Browse",
				caseType: "patient",
				caseListMenuItem: {},
				forms: [],
			},
		],
	});

	it("is named by its one case list entry, never by case first", () => {
		const screen = screenOf(testUuid("browse"));
		expect(screenIsBareCaseList(doc, screen)).toBe(true);
		expect(screenCaseFirstBlocker(doc, screen)).toEqual({
			reason: "bare-case-list",
		});
		expect(screenChoosesCaseFirst(doc, screen)).toBe(
			moduleIsCaseFirst(doc, testUuid("browse")),
		);
	});
});
