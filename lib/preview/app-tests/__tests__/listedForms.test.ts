/**
 * An App Test through a menu that lists another menu's forms: the route takes
 * its case type and selection from the source, lists only the forms it shows,
 * and opens a follow-up with the case the worker chose on its own list. A form
 * submitted through the route returns to the route, not to the source.
 */

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	REGISTER,
	ROUTE,
	SOURCE,
	twoMenus,
	VISIT,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import {
	WEB_APPS_RULES,
	webAppsDevice,
} from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { afterSubmitRoute } from "../../afterSubmitRouting";
import type { CaseRowWithCalculated } from "../../engine/caseDataBindingTypes";
import { previewAsMe } from "../../engine/identity";
import { previewLookupData } from "../../engine/lookupEvaluation";
import { previewCaseFirstModuleUuids } from "../../menuProjection";
import type { AppTestContext } from "../context";
import {
	appTestForms,
	enterAppTestForm,
	selectAppTestRecords,
} from "../navigation";
import type { AppTestScreen, AppTestSessionState } from "../types";

function contextOf(doc: BlueprintDoc): AppTestContext {
	return {
		doc,
		identity: previewAsMe({ id: "worker", name: "Worker" }, doc),
		device: webAppsDevice(),
		lookup: previewLookupData({
			projectRevision: "listed",
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

const patient: CaseRowWithCalculated = {
	case_id: "patient-1",
	case_type: "patient",
	case_name: "Ada",
	app_id: "listed",
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

function listedDoc(): BlueprintDoc {
	const doc = twoMenus();
	rebuildFieldParent(doc);
	return doc;
}

it("lists only the forms the route shows, and refuses the one it hides", () => {
	const context = contextOf(listedDoc());
	const menu = stateOn({ kind: "menu", moduleUuid: ROUTE });
	expect(
		appTestForms(context, menu, ROUTE).map((item) => item.form.uuid),
	).toEqual([VISIT]);
	expect(() => enterAppTestForm(context, menu, ROUTE, REGISTER)).toThrow(
		"This form is not available on the current menu.",
	);
});

it("chooses one record on the route's own list with the source's case type, and opens the route's follow-up with it", () => {
	const context = contextOf(listedDoc());
	const list = stateOn({ kind: "records", moduleUuid: ROUTE });
	const chosen = selectAppTestRecords(context, list, [patient]);
	expect(chosen.screen).toMatchObject({
		kind: "menu",
		moduleUuid: ROUTE,
		selection: {
			caseType: "patient",
			cases: [expect.objectContaining({ caseId: "patient-1" })],
		},
	});
	expect(enterAppTestForm(context, chosen, ROUTE, VISIT)).toMatchObject({
		kind: "form",
		moduleUuid: ROUTE,
		formUuid: VISIT,
		caseIds: ["patient-1"],
	});
	expect(() =>
		selectAppTestRecords(context, list, [
			patient,
			{ ...patient, case_id: "patient-2" },
		]),
	).toThrow("Choose the number of records this menu allows.");
});

it("asks for a record before opening a follow-up through the route", () => {
	const context = contextOf(listedDoc());
	const menu = stateOn({ kind: "menu", moduleUuid: ROUTE });
	expect(enterAppTestForm(context, menu, ROUTE, VISIT)).toEqual({
		kind: "records",
		moduleUuid: ROUTE,
		formUuid: VISIT,
	});
});

it("returns a form submitted through the route to the route, and through its owner to the owner", () => {
	const doc = listedDoc();
	const link = { uuid: testUuid("visit-again"), target: { type: "this-form" } };
	doc.forms[VISIT].formLinks = [link as never];
	for (const [submittedThrough, landsIn] of [
		[ROUTE, ROUTE],
		[SOURCE, SOURCE],
	] as const)
		expect(
			afterSubmitRoute({
				sourceModuleUuid: submittedThrough,
				sourceFormUuid: VISIT,
				rules: WEB_APPS_RULES,
				targetVisibility: () => "shown",
				choice: { kind: "destination", index: 0, link: link as never },
				doc,
				caseFirstModules: previewCaseFirstModuleUuids(doc),
				caseSelections: () => [],
				carriedCase: () => ({ kind: "none" }),
			}),
		).toMatchObject({ kind: "form", moduleUuid: landsIn, formUuid: VISIT });
});
