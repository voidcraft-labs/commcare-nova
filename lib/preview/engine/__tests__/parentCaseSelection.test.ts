/**
 * When the running app asks for a menu's parent case, and whether a case
 * chosen for it opens details first: Preview's answers
 * (`parentCaseSelection.ts`) against CommCare Core's own reading of the local
 * suite Nova writes. Core walks the `<menu>` chain to the menu's screen,
 * collecting at each screen every datum all of its commands' entries need
 * first (`CommCareSession.getNeededData` → `getDataNeededByAllEntries`); it
 * asks for the parent case before listing the screen only where that screen
 * collects a case, and otherwise lists the menu and asks for the parent after
 * the command of an entry that needs it. A case chosen for a datum opens its
 * details only where the datum names `detail-confirm` (Formplayer's
 * `EntityListResponse.hasDetails` over `EntityScreen.getLongDetail`, the Web
 * Apps client's `CaseView.rowClick`, Android's `EntitySelectActivity`
 * `mNoDetailMode`), which a basic entry gives its own case's datum and never
 * a parent case's. Both platforms read the session alike, so each answer is
 * one rule for Web Apps and Android.
 */
import AdmZip from "adm-zip";
import type { Element } from "domhandler";
import { findAll, getChildren } from "domutils";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	HOUSEHOLDS as ADVANCED_HOUSEHOLDS,
	MEMBERS as ADVANCED_MEMBERS,
	advancedFixture,
	chosen,
	OP,
	read,
	UNDER_TEST,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import {
	formCommandId,
	formLinkProjectionContext,
	menuIdOf,
} from "@/lib/commcare/formLinkProjection";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { runValidation } from "@/lib/commcare/validator/runner";
import { parseXml } from "@/lib/commcare/xmlParse";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, FormType, Uuid } from "@/lib/domain";
import { previewMenuCaseContext } from "../../menuProjection";
import {
	previewLeafAsksParentCase,
	previewParentCaseBeforeMenu,
	previewParentCaseListHasDetails,
} from "../parentCaseSelection";

type Suite = ReturnType<typeof parseXml>;

const HOUSEHOLDS = testUuid("parent-asked-households");
const MEMBERS = testUuid("parent-asked-members");
const VISIT = testUuid("parent-asked-visit");
const OTHER = testUuid("parent-asked-other");

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

/** Each `<entry>`'s datums by its command id, in order. */
function entryDatums(suite: Suite): Map<string, readonly Element[]> {
	const datums = new Map<string, readonly Element[]>();
	for (const entry of findAll(
		(element) => element.name === "entry",
		suite.children,
	)) {
		const id = tagChildren(entry).find((child) => child.name === "command")
			?.attribs.id;
		if (id === undefined) continue;
		const session = tagChildren(entry).find(
			(child) => child.name === "session",
		);
		datums.set(id, session === undefined ? [] : tagChildren(session));
	}
	return datums;
}

/** Whether Core collects a case on the menu's own screen before it asks
 *  for a command, reached through the menus its `root` names. */
function coreAsksCaseBeforeListing(suite: Suite, menuId: string): boolean {
	return coreCollectsOnScreen(suite, menuId).some(
		(datum) => datum.attribs.nodeset !== undefined,
	);
}

/** The datums Core collects on the menu's own screen before it asks for a
 *  command, having collected on each screen on the way what all of that
 *  screen's entries need first (`getDataNeededByAllEntries`). */
function coreCollectsOnScreen(suite: Suite, menuId: string): Element[] {
	const datums = entryDatums(suite);
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
	const collect = (id: string): Element[] => {
		const lists = menus(id).flatMap((menu) =>
			tagChildren(menu)
				.filter((child) => child.name === "command")
				.flatMap((command) => {
					const list = datums.get(command.attribs.id ?? "");
					return list === undefined ? [] : [list];
				}),
		);
		const taken: Element[] = [];
		for (;;) {
			const firsts = lists.map((list) =>
				list.find((datum) => !collected.has(datum.attribs.id ?? "")),
			);
			const [first] = firsts;
			if (
				first === undefined ||
				firsts.some(
					(datum) =>
						datum === undefined || datum.attribs.id !== first.attribs.id,
				)
			)
				return taken;
			collected.add(first.attribs.id ?? "");
			taken.push(first);
		}
	};
	let own: Element[] = [];
	for (const id of path) own = collect(id);
	return own;
}

/** Households, whose own list shows details, and Members, a child case
 *  chosen under a household Households' list chooses, holding `forms`, a
 *  submenu of Households where `nested`. */
function members(
	forms: readonly FormType[],
	caseListMenuItem = false,
	nested = false,
) {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		appName: "Parent asked",
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "member", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: HOUSEHOLDS,
				name: "Households",
				caseType: "household",
				caseListConfig: list(),
				forms: [
					{
						name: "Visit household",
						type: "followup" as const,
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
			{
				uuid: MEMBERS,
				name: "Members",
				caseType: "member",
				parentCaseModuleUuid: HOUSEHOLDS,
				caseListConfig: list(),
				...(caseListMenuItem && { caseListMenuItem: {} }),
				forms: forms.map((type, index) => ({
					uuid: index === 0 ? VISIT : testUuid(`parent-asked-form-${index}`),
					name: `Form ${index}`,
					type,
					fields: [
						type === "registration"
							? f({
									kind: "text",
									id: "case_name",
									caseWrite: { caseType: "member", property: "case_name" },
								})
							: f({ kind: "text", id: "note" }),
					],
				})),
			},
		],
	});
	// Set before anything reads the document: the projections memoize per
	// document.
	if (nested)
		doc.modules[MEMBERS] = {
			...doc.modules[MEMBERS],
			parentModuleUuid: HOUSEHOLDS,
		};
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

function coreAnswer(doc: BlueprintDoc, moduleUuid: Uuid): boolean {
	const emitted = emissionPlan(doc).doc;
	return coreAsksCaseBeforeListing(
		suiteOf(doc),
		menuIdOf(emitted, formLinkProjectionContext(emitted), moduleUuid),
	);
}

it.each<[string, readonly FormType[], boolean, boolean]>([
	["every form follows a member up", ["followup", "close"], false, true],
	["a survey beside a follow-up", ["followup", "survey"], false, false],
	[
		"a registration beside a follow-up",
		["registration", "followup"],
		false,
		false,
	],
	[
		"a survey beside a follow-up and the case list entry",
		["followup", "survey"],
		true,
		false,
	],
	["a follow-up and the case list entry", ["followup"], true, true],
])(
	"asks for the parent case before listing the menu where Core does: %s",
	(_, forms, item, asks) => {
		const doc = members(forms, item);
		expect(coreAnswer(doc, MEMBERS)).toBe(asks);
		expect(previewParentCaseBeforeMenu(doc, MEMBERS)).toBe(asks);
	},
);

it("never asks for a parent case before a menu with none", () => {
	const doc = members(["followup", "survey"]);
	expect(previewParentCaseBeforeMenu(doc, HOUSEHOLDS)).toBe(false);
	expect(coreAnswer(doc, HOUSEHOLDS)).toBe(true);
});

it("goes on at the row of a parent's list whose own list shows details, as Core's datum names none", () => {
	for (const forms of [
		["followup", "survey"],
		["followup", "close"],
	] as const) {
		const doc = members(forms, true);
		const suite = suiteOf(doc);
		const emitted = emissionPlan(doc).doc;
		const ctx = formLinkProjectionContext(emitted);
		const visit = entryDatums(suite).get(formCommandId(ctx, MEMBERS, VISIT));
		const households = entryDatums(suite).get(
			formCommandId(
				ctx,
				HOUSEHOLDS,
				emitted.formOrder[HOUSEHOLDS]?.[0] ?? HOUSEHOLDS,
			),
		);
		// The households' own list confirms; the members' entry's household
		// datum, its first, names no details, and its member datum does.
		expect(households?.[0]?.attribs["detail-confirm"]).toBeDefined();
		expect(visit?.[0]?.attribs["detail-confirm"]).toBeUndefined();
		expect(visit?.at(-1)?.attribs["detail-confirm"]).toBeDefined();
		for (const formUuid of [VISIT, undefined, OTHER])
			expect(
				previewParentCaseListHasDetails(doc, {
					selectorModuleUuid: HOUSEHOLDS,
					requestingModuleUuid: MEMBERS,
					...(formUuid !== undefined && { formUuid }),
				}),
			).toBe(false);
	}
});

it("asks for the parent case on a leaf whose entry chooses it, and opens a survey or a registration without one", () => {
	const doc = members(["followup", "survey", "registration"]);
	const [visit, survey, registration] = doc.formOrder[MEMBERS] ?? [];
	expect(previewLeafAsksParentCase(doc, MEMBERS, visit)).toBe(true);
	expect(previewLeafAsksParentCase(doc, MEMBERS)).toBe(true);
	expect(previewLeafAsksParentCase(doc, MEMBERS, survey)).toBe(false);
	expect(previewLeafAsksParentCase(doc, MEMBERS, registration)).toBe(false);
	expect(previewLeafAsksParentCase(doc, HOUSEHOLDS)).toBe(false);
	// Core: the survey's and the registration's entries hold no selection.
	const suite = suiteOf(doc);
	const emitted = emissionPlan(doc).doc;
	const ctx = formLinkProjectionContext(emitted);
	for (const formUuid of [survey, registration])
		expect(
			(
				entryDatums(suite).get(formCommandId(ctx, MEMBERS, formUuid as Uuid)) ??
				[]
			).some((datum) => datum.attribs.nodeset !== undefined),
		).toBe(false);
});

/** A follow-up of Members held advanced, chosen under its household
 *  (`advancedPlacementFixture.ts`), with `operations` as its case changes. */
function advancedMembers(operations: () => CaseOperation[]): BlueprintDoc {
	const { doc } = advancedFixture({
		formType: "followup",
		menu: "members",
		operations,
	});
	rebuildFieldParent(doc);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expect(emittedModuleKind(doc, ADVANCED_MEMBERS)).toBe("advanced");
	return doc;
}

const ownCase = (): CaseOperation =>
	({ uuid: OP("own"), id: "own_case", action: "own" }) as CaseOperation;

/** A visit the follow-up creates under the household chosen first. */
const visitUnderHousehold = (): CaseOperation =>
	({
		uuid: OP("visit"),
		id: "visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: read("name"),
		links: [
			{
				identifier: "parent",
				targetType: "household",
				target: { kind: "expression", expr: chosen(ADVANCED_HOUSEHOLDS) },
				relationship: "child",
			},
		],
	}) as CaseOperation;

it.each<[string, () => CaseOperation[], boolean]>([
	[
		"an open action indexes the household",
		() => [ownCase(), visitUnderHousehold()],
		true,
	],
	["no open action indexes the household", () => [ownCase()], false],
])(
	"opens a parent's details on an advanced menu exactly where its load keeps the confirmation: %s",
	(_, operations, confirms) => {
		const doc = advancedMembers(operations);
		const emitted = emissionPlan(doc).doc;
		const ctx = formLinkProjectionContext(emitted);
		const [household, member] =
			entryDatums(suiteOf(doc)).get(
				formCommandId(ctx, ADVANCED_MEMBERS, UNDER_TEST),
			) ?? [];
		// Core reads the household load's datum, the entry's first, and HQ's
		// advanced entry keeps its list's confirmation only where an open
		// action indexes the load (`get_manual_datum`).
		expect(household?.attribs.id).toBe("case_id_load_household0");
		expect(household?.attribs["detail-confirm"] !== undefined).toBe(confirms);
		expect(member?.attribs["detail-confirm"]).toBeDefined();
		// The menu lists one follow-up, so it asks for the household first
		// and reads that entry's datum with or without the form named.
		expect(previewParentCaseBeforeMenu(doc, ADVANCED_MEMBERS)).toBe(true);
		for (const formUuid of [UNDER_TEST, undefined])
			expect(
				previewParentCaseListHasDetails(doc, {
					selectorModuleUuid: ADVANCED_HOUSEHOLDS,
					requestingModuleUuid: ADVANCED_MEMBERS,
					...(formUuid !== undefined && { formUuid }),
				}),
			).toBe(confirms);
	},
);

it("asks for no parent case on a submenu of its parent's own case-first menu, as Core collects it there, and refuses a submenu of another menu of the parent's type", () => {
	const doc = members(["followup", "close"], false, true);
	const emitted = emissionPlan(doc).doc;
	const onMembers = coreCollectsOnScreen(
		suiteOf(doc),
		menuIdOf(emitted, formLinkProjectionContext(emitted), MEMBERS),
	);
	expect(onMembers.map((datum) => datum.attribs.nodeset)).toEqual([
		expect.stringContaining("@case_type = 'member'"),
	]);
	expect(previewParentCaseBeforeMenu(doc, MEMBERS)).toBe(false);
	const household = {
		caseType: "household",
		cases: [{ caseId: "household-1", caseName: "Rao household" }],
	};
	expect(
		previewMenuCaseContext(
			{ ...doc, caseTypes: doc.caseTypes ?? [] },
			MEMBERS,
			{ [HOUSEHOLDS]: household },
		).requiredParentCase,
	).toBeUndefined();

	// Under a menu of households that is not its parent case's menu, the
	// root alignment would hand Members that menu's household in place of
	// the one Households' list chooses, and the document is refused, so
	// Preview never meets a parent case the wire collects elsewhere.
	const other = testUuid("parent-asked-household-list");
	const nested = buildDoc({
		appName: "Parent asked",
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "member", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: HOUSEHOLDS,
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit household",
						type: "followup" as const,
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
			{
				uuid: other,
				name: "Household list",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Check household",
						type: "followup" as const,
						fields: [f({ kind: "text", id: "check" })],
					},
				],
			},
			{
				uuid: MEMBERS,
				name: "Members",
				caseType: "member",
				parentCaseModuleUuid: HOUSEHOLDS,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: VISIT,
						name: "Visit member",
						type: "followup" as const,
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
	nested.modules[MEMBERS] = {
		...nested.modules[MEMBERS],
		parentModuleUuid: other,
	};
	rebuildFieldParent(nested);
	expect(
		runValidation(nested, LOOKUP_CONTEXT_UNAVAILABLE).map(
			(error) => error.code,
		),
	).toContain("CASE_PARENT_SELECTION_CONFLICT");
});
