// The form menu a search action's claim leads to: its conditions read the
// device once the device holds the claimed case, and wait until then, so a
// claimed case never reads as missing and the menu never decides early.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { CaseRow } from "@/lib/case-store";
import { proseText } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import {
	formDisplayVisibility,
	type NavigationDeviceCases,
	navigationSelectedCase,
} from "@/lib/preview/engine/displayConditionEvaluation";
import { previewAutomaticForm } from "@/lib/preview/menuProjection";
import {
	claimableCaseIds,
	claimPostsAtResult,
	deviceCasesHoldingClaims,
	formEntryClaimChoices,
} from "@/lib/preview/searchClaims";

const MODULE = testUuid("claim-module");
const FORM = testUuid("claim-form");
const DOC = buildDoc({
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "region", data_type: "text", label: proseText("Region") },
			],
		},
	],
	modules: [
		{
			uuid: MODULE,
			name: "Patients",
			caseType: "patient",
			forms: [
				{
					uuid: FORM,
					name: "Visit",
					type: "followup",
					displayCondition: eq(prop("patient", "region"), literal("north")),
				},
			],
		},
	],
});

function patient(caseId: string): CaseRow {
	return {
		case_id: caseId,
		app_id: "app-1",
		case_type: "patient",
		owner_id: "u1",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: caseId,
		external_id: null,
		parent_case_id: null,
		properties: { region: "north" },
	};
}

function device(...caseIds: string[]): NavigationDeviceCases {
	return {
		snapshot: { rows: caseIds.map(patient), indices: [] },
		caseTypes: DOC.caseTypes ?? [],
	};
}

/** The form menu's decision for the case `claimed`, as the running
 *  case list makes it right after the choice. */
function decide(deviceCases: NavigationDeviceCases) {
	const form = DOC.forms[FORM];
	const types = slotContext(
		DOC,
		{ entity: "form", uuid: FORM, slot: "form_display_condition" },
		new Map(),
	);
	if (form === undefined || types === undefined)
		throw new Error("The claim fixture has no follow-up form.");
	return [
		{
			form,
			visibility: formDisplayVisibility({
				condition: form.displayCondition,
				session: {
					context: { userid: "u1", username: "ada" },
					user: {},
					userPropertySlugs: {},
				},
				types,
				selectedCase: navigationSelectedCase(DOC, MODULE, FORM, "claimed"),
				deviceCases: deviceCasesHoldingClaims(deviceCases, ["claimed"]),
				lookup: { kind: "idle" },
			}),
		},
	];
}

describe("deviceCasesHoldingClaims", () => {
	it("waits for the claimed case rather than reading it as missing", () => {
		const decided = decide(device("held"));
		expect(decided[0]?.visibility).toBe("pending");
		/* No form opens on its own while the claim is on its way. */
		expect(previewAutomaticForm(decided)).toBeUndefined();
	});

	it("decides, and continues into the form, once the device holds the claim", () => {
		const decided = decide(device("held", "claimed"));
		expect(decided[0]?.visibility).toBe("shown");
		expect(previewAutomaticForm(decided)).toBe(FORM);
	});

	it("reads the device as it is for a choice that claimed nothing", () => {
		const cases = device("held");
		expect(deviceCasesHoldingClaims(cases, [])).toBe(cases);
		const holding = device("claimed");
		expect(deviceCasesHoldingClaims(holding, ["claimed"])).toBe(holding);
	});

	it("waits while any case of a claim in flight is missing, and not on a device still loading", () => {
		/* Two claims in flight: the device holds one of their cases so far. */
		expect(
			deviceCasesHoldingClaims(device("claimed"), ["claimed", "second"])
				.snapshot,
		).toBeNull();
		const loading: NavigationDeviceCases = {
			snapshot: null,
			caseTypes: DOC.caseTypes ?? [],
		};
		expect(deviceCasesHoldingClaims(loading, ["claimed"])).toBe(loading);
	});
});

describe("where a claim posts", () => {
	const PARENT_MODULE = testUuid("claim-parent-module");
	const SEARCH_MODULE = testUuid("claim-search-module");
	const SEARCH_FORM = testUuid("claim-search-form");
	const REGISTER_FORM = testUuid("claim-register-form");
	const searchDoc = (formsReadSearch: boolean) =>
		buildDoc({
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "patient", parent_type: "household", properties: [] },
			],
			modules: [
				{
					uuid: PARENT_MODULE,
					name: "Households",
					caseType: "household",
					forms: [{ name: "Visit household", type: "followup" }],
				},
				{
					uuid: SEARCH_MODULE,
					name: "Patients",
					caseType: "patient",
					parentCaseModuleUuid: PARENT_MODULE,
					caseSearchConfig: formsReadSearch ? { formsReadSearch: true } : {},
					forms: [
						{ uuid: SEARCH_FORM, name: "Visit", type: "followup" },
						{ uuid: REGISTER_FORM, name: "Register", type: "registration" },
					],
				},
			],
		});
	const chosen = [{ caseId: "searched", claimable: true as const }];
	const selections = {
		[PARENT_MODULE]: {
			caseType: "household",
			cases: [
				{
					caseId: "household",
					caseName: "Household",
					caseProperties: {},
					claimable: true as const,
				},
			],
		},
	};

	it("posts at the form's entry, with the parent's datum, in a menu whose forms read the search", () => {
		const doc = searchDoc(true);
		expect(claimPostsAtResult(doc.modules[SEARCH_MODULE])).toBe(false);
		const choices = formEntryClaimChoices({
			doc,
			moduleUuid: SEARCH_MODULE,
			formUuid: SEARCH_FORM,
			chosen,
			selections,
		});
		expect(claimableCaseIds(choices)).toEqual(["searched", "household"]);
		/* A form that loads no case posts no claim at its entry. */
		expect(
			formEntryClaimChoices({
				doc,
				moduleUuid: SEARCH_MODULE,
				formUuid: REGISTER_FORM,
				chosen,
				selections,
			}),
		).toEqual([]);
	});

	it("posts at the chosen result in a menu whose forms do not read the search", () => {
		const doc = searchDoc(false);
		expect(claimPostsAtResult(doc.modules[SEARCH_MODULE])).toBe(true);
		expect(
			formEntryClaimChoices({
				doc,
				moduleUuid: SEARCH_MODULE,
				formUuid: SEARCH_FORM,
				chosen,
				selections,
			}),
		).toEqual([]);
	});
});
