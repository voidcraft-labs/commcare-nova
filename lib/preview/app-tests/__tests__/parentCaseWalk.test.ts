/**
 * An App Test walks a menu's parent case as Preview does
 * (`lib/preview/engine/parentCaseSelection.ts`): a menu asks for its parent
 * case before it lists its screen only where every entry it lists asks for
 * it first, as `CommCareSession.getNeededData` does; otherwise it lists its
 * forms and asks for the parent after the command of the form or case list
 * that needs it, and a survey opens with none. A case chosen on a parent's
 * list goes on at its row unless the datum it chooses for names a details
 * screen, which a basic entry never gives a parent case's datum. Back lets
 * go every case chosen after the screen it returns to, so the walk past it
 * asks for the parent again.
 */

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
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, CaseOperation, FormType, Uuid } from "@/lib/domain";
import { effectiveAppLocalization } from "@/lib/domain/localization";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import type { CaseRowWithCalculated } from "../../engine/caseDataBindingTypes";
import { previewAsMe } from "../../engine/identity";
import { previewLookupData } from "../../engine/lookupEvaluation";
import type { AppTestContext } from "../context";
import {
	appTestCaseListScreen,
	appTestHistoryEntry,
	appTestRecordsHaveDetails,
	appTestStepBack,
	enterAppTestForm,
	enterAppTestMenu,
	selectAppTestRecords,
} from "../navigation";
import type { AppTestScreen, AppTestSessionState } from "../types";

const HOUSEHOLDS = testUuid("walk-households");
const MEMBERS = testUuid("walk-members");

/** Households, case first, and Members, a household's members, holding
 *  `forms` and its case list as an entry of its own. */
function membersDoc(forms: readonly FormType[]): BlueprintDoc {
	const list = () => caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		appName: "Parent walk",
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
						type: "followup",
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
				caseListMenuItem: {},
				forms: forms.map((type, index) => ({
					uuid: testUuid(`walk-form-${index}`),
					name: `Form ${index}`,
					type,
					fields: [f({ kind: "text", id: "note" })],
				})),
			},
		],
	});
	rebuildFieldParent(doc);
	return doc;
}

function contextOf(doc: BlueprintDoc): AppTestContext {
	return {
		doc,
		language: effectiveAppLocalization(doc.localization).defaultLanguage,
		identity: previewAsMe({ id: "worker", name: "Worker" }, doc),
		device: webAppsDevice(),
		lookup: previewLookupData({
			projectRevision: "walk",
			definitions: [],
			rowsByTable: new Map(),
		}),
	} as unknown as AppTestContext;
}

function stateOn(screen: AppTestScreen): AppTestSessionState {
	return {
		screen,
		history: [],
		selections: {},
		deviceCases: { rows: [], indices: [] },
	} as unknown as AppTestSessionState;
}

const household: CaseRowWithCalculated = {
	case_id: "household-1",
	case_type: "household",
	case_name: "Rao household",
	app_id: "walk",
	owner_id: "worker",
	status: "open",
	opened_on: null,
	modified_on: null,
	closed_on: null,
	external_id: null,
	parent_case_id: null,
	properties: {},
	calculated: {},
};

it("asks for the parent case before a menu whose every entry asks for it first", () => {
	const doc = membersDoc(["followup", "close"]);
	const context = contextOf(doc);
	expect(enterAppTestMenu(context, stateOn({ kind: "home" }), MEMBERS)).toEqual(
		{ kind: "records", moduleUuid: HOUSEHOLDS, returnModules: [MEMBERS] },
	);
});

it("lists a menu's forms first where a survey stands beside its follow-up, and asks for the parent after the command that needs it", () => {
	const doc = membersDoc(["followup", "survey"]);
	const context = contextOf(doc);
	const [visit, survey] = (doc.formOrder[MEMBERS] ?? []) as Uuid[];
	const home = stateOn({ kind: "home" });
	expect(enterAppTestMenu(context, home, MEMBERS)).toEqual({
		kind: "menu",
		moduleUuid: MEMBERS,
	});
	const menu = stateOn({ kind: "menu", moduleUuid: MEMBERS });

	// The survey's entry chooses no case: it opens with none.
	expect(enterAppTestForm(context, menu, MEMBERS, survey)).toMatchObject({
		kind: "form",
		moduleUuid: MEMBERS,
		formUuid: survey,
		caseIds: [],
	});

	// The follow-up asks for the household, then the member, then opens.
	const parentList = enterAppTestForm(context, menu, MEMBERS, visit);
	expect(parentList).toEqual({
		kind: "records",
		moduleUuid: HOUSEHOLDS,
		returnModules: [MEMBERS],
		retainedFormTarget: { moduleUuid: MEMBERS, formUuid: visit },
	});
	const chosen = selectAppTestRecords(context, stateOn(parentList), [
		household,
	]);
	expect(chosen.selections[HOUSEHOLDS]?.cases).toEqual([
		expect.objectContaining({ caseId: "household-1" }),
	]);
	expect(chosen.screen).toEqual({
		kind: "records",
		moduleUuid: MEMBERS,
		formUuid: visit,
		returnModules: [],
		retainedFormTarget: { moduleUuid: MEMBERS, formUuid: visit },
		taskCases: undefined,
	});

	// The menu's case list asks for the household too, then opens with its
	// mark, so a member chosen there takes the entry's route.
	const listParent = appTestCaseListScreen(context, menu, {
		kind: "records",
		moduleUuid: MEMBERS,
		openedFrom: "case-list-menu-item",
	});
	expect(listParent).toEqual({
		kind: "records",
		moduleUuid: HOUSEHOLDS,
		returnModules: [MEMBERS],
		resumesList: { openedFrom: "case-list-menu-item" },
	});
	expect(
		selectAppTestRecords(context, stateOn(listParent), [household]).screen,
	).toEqual({
		kind: "records",
		moduleUuid: MEMBERS,
		openedFrom: "case-list-menu-item",
	});
});

/* Each screen the walk leaves is kept as `run.ts` keeps it, with the
 * selections the session held while it was shown. */
function leave(
	state: AppTestSessionState,
	next: AppTestSessionState,
): AppTestSessionState {
	return {
		...next,
		history: [
			...state.history,
			appTestHistoryEntry(state.screen, state.selections),
		],
	};
}

it("lets a parent case chosen after a form's command go at Back, so the form asks for it again", () => {
	const doc = membersDoc(["followup", "survey"]);
	const context = contextOf(doc);
	const [visit] = (doc.formOrder[MEMBERS] ?? []) as Uuid[];
	const home = stateOn({ kind: "home" });
	const onMenu = leave(home, {
		...home,
		screen: enterAppTestMenu(context, home, MEMBERS),
	});
	const parentList = enterAppTestForm(context, onMenu, MEMBERS, visit);
	const onParentList = leave(onMenu, { ...onMenu, screen: parentList });
	const onMembers = leave(
		onParentList,
		selectAppTestRecords(context, onParentList, [household]),
	);
	expect(onMembers.screen).toMatchObject({
		kind: "records",
		moduleUuid: MEMBERS,
	});
	expect(onMembers.selections[HOUSEHOLDS]).toBeDefined();

	// Back from the members' list pops the household just chosen and shows
	// the households' list again (`CommCareSession.stepBack`).
	const backOnParentList = appTestStepBack(onMembers);
	expect(backOnParentList.screen).toEqual(parentList);
	expect(backOnParentList.selections).toEqual({});

	// Back again pops the form's command and stops on the menu, which holds
	// no household, so the follow-up asks for one again.
	const backOnMenu = appTestStepBack(backOnParentList);
	expect(backOnMenu.screen).toEqual({ kind: "menu", moduleUuid: MEMBERS });
	expect(backOnMenu.selections).toEqual({});
	expect(enterAppTestForm(context, backOnMenu, MEMBERS, visit)).toEqual(
		parentList,
	);

	// So does Home after Back, where the menu is entered again.
	const backHome = appTestStepBack(backOnMenu);
	expect(backHome).toMatchObject({
		screen: { kind: "home" },
		history: [],
		selections: {},
	});
	expect(() => appTestStepBack(backHome)).toThrow(
		"There is no previous screen.",
	);
});

it("goes on at a parent's row on a basic menu, though the parent's own list shows details", () => {
	const doc = membersDoc(["followup", "survey"]);
	const context = contextOf(doc);
	const [visit] = (doc.formOrder[MEMBERS] ?? []) as Uuid[];
	const parentStep: AppTestScreen = {
		kind: "records",
		moduleUuid: HOUSEHOLDS,
		returnModules: [MEMBERS],
		retainedFormTarget: { moduleUuid: MEMBERS, formUuid: visit },
	};
	if (parentStep.kind !== "records") throw new Error("A records screen.");
	expect(appTestRecordsHaveDetails(context, parentStep, true)).toBe(false);
	// Households' own list, chosen for its own forms, opens details.
	expect(
		appTestRecordsHaveDetails(
			context,
			{ kind: "records", moduleUuid: HOUSEHOLDS },
			true,
		),
	).toBe(true);
	// Members' own list after its parent keeps its own datum's details.
	expect(
		appTestRecordsHaveDetails(
			context,
			{
				kind: "records",
				moduleUuid: MEMBERS,
				formUuid: visit,
				returnModules: [],
				retainedFormTarget: { moduleUuid: MEMBERS, formUuid: visit },
			},
			true,
		),
	).toBe(true);
});

it("opens a parent's details on an advanced menu where an open action indexes the parent's load", () => {
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
	const { doc } = advancedFixture({
		formType: "followup",
		menu: "members",
		operations: () => [
			{ uuid: OP("own"), id: "own_case", action: "own" } as CaseOperation,
			visitUnderHousehold(),
		],
	});
	const context = contextOf(doc);
	const parentStep = enterAppTestMenu(
		context,
		stateOn({ kind: "home" }),
		ADVANCED_MEMBERS,
	);
	expect(parentStep).toEqual({
		kind: "records",
		moduleUuid: ADVANCED_HOUSEHOLDS,
		returnModules: [ADVANCED_MEMBERS],
	});
	if (parentStep.kind !== "records") throw new Error("A records screen.");
	expect(appTestRecordsHaveDetails(context, parentStep, true)).toBe(true);
});
