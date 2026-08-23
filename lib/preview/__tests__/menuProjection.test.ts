import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Module } from "@/lib/domain";
import {
	combineNavigationVisibility,
	inheritedModuleVisibility,
	type PreviewMenuSource,
	previewCaseDescendantModuleUuids,
	previewMenuCaseContext,
	previewMenuModuleUuids,
} from "../menuProjection";

const ROOT = testUuid("root");
const CHILD = testUuid("child");
const OTHER_ROOT = testUuid("other-root");
const SURVEY_ROOT = testUuid("survey-root");
const ROOT_FORM = testUuid("root-form");
const CHILD_FORM = testUuid("child-form");
const OTHER_ROOT_FORM = testUuid("other-root-form");
const SURVEY_FORM = testUuid("survey-form");

function module(
	uuid: typeof ROOT,
	caseType: string,
	parentModuleUuid?: typeof ROOT,
): Module {
	return {
		uuid,
		id: uuid,
		name: uuid,
		caseType,
		...(parentModuleUuid ? { parentModuleUuid } : {}),
	};
}

function source(childCaseType = "household"): PreviewMenuSource {
	return {
		modules: {
			[ROOT]: module(ROOT, "household"),
			[CHILD]: module(CHILD, childCaseType, ROOT),
			[OTHER_ROOT]: module(OTHER_ROOT, "visit"),
		},
		moduleOrder: [ROOT, CHILD, OTHER_ROOT],
		forms: {
			[ROOT_FORM]: {
				uuid: ROOT_FORM,
				id: "root_followup",
				name: "Root follow-up",
				type: "followup",
			},
			[CHILD_FORM]: {
				uuid: CHILD_FORM,
				id: "child_followup",
				name: "Child follow-up",
				type: "followup",
			},
			[OTHER_ROOT_FORM]: {
				uuid: OTHER_ROOT_FORM,
				id: "other_root_followup",
				name: "Other root follow-up",
				type: "followup",
			},
		},
		formOrder: {
			[ROOT]: [ROOT_FORM],
			[CHILD]: [CHILD_FORM],
			[OTHER_ROOT]: [OTHER_ROOT_FORM],
		},
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "person", parent_type: "household", properties: [] },
			{ name: "visit", properties: [] },
		],
	};
}

describe("Preview menu projection", () => {
	it("shows roots on Home and children only on their parent menu", () => {
		const doc = source();
		expect(previewMenuModuleUuids(doc, null)).toEqual([ROOT, OTHER_ROOT]);
		expect(previewMenuModuleUuids(doc, ROOT)).toEqual([CHILD]);
	});

	it("inherits three-valued visibility with hidden winning over pending", () => {
		expect(combineNavigationVisibility("pending", "hidden")).toBe("hidden");
		const doc = source();
		const projected = inheritedModuleVisibility(
			doc,
			new Map([
				[ROOT, "pending" as const],
				[CHILD, "shown" as const],
				[OTHER_ROOT, "shown" as const],
			]),
		);
		expect(projected.get(CHILD)).toBe("pending");
	});

	it("reuses a structural parent's selection only for the same case type", () => {
		const selected = {
			caseType: "household",
			caseId: "h1",
			caseName: "Household one",
		};
		expect(
			previewMenuCaseContext(source(), CHILD, { [ROOT]: selected }),
		).toEqual({
			selectedCase: selected,
			selectedByModuleUuid: ROOT,
			parentCase: undefined,
			parentModuleUuid: undefined,
			requiredParentCase: undefined,
		});
	});

	it("keeps a declared different-type parent as a selection constraint", () => {
		const selected = {
			caseType: "household",
			caseId: "h1",
			caseName: "Household one",
		};
		expect(
			previewMenuCaseContext(source("person"), CHILD, { [ROOT]: selected }),
		).toEqual({
			selectedCase: undefined,
			selectedByModuleUuid: undefined,
			parentCase: selected,
			parentModuleUuid: ROOT,
			requiredParentCase: undefined,
		});
	});

	it("keeps case-parent context after the child itself is selected", () => {
		const parent = {
			caseType: "household",
			caseId: "h1",
			caseName: "Household one",
		};
		const child = {
			caseType: "person",
			caseId: "p1",
			caseName: "Person one",
		};
		expect(
			previewMenuCaseContext(source("person"), CHILD, {
				[ROOT]: parent,
				[CHILD]: child,
			}),
		).toEqual({
			selectedCase: child,
			selectedByModuleUuid: CHILD,
			parentCase: parent,
			parentModuleUuid: ROOT,
			requiredParentCase: undefined,
		});
	});

	it("finds case parentage independently of the structural menu parent", () => {
		const base = source("person");
		const doc = {
			...base,
			modules: {
				...base.modules,
				[ROOT]: module(ROOT, "clinic"),
				[OTHER_ROOT]: module(OTHER_ROOT, "household"),
			},
		};
		const selected = {
			caseType: "household",
			caseId: "h1",
			caseName: "Household one",
		};

		expect(
			previewMenuCaseContext(doc, CHILD, { [OTHER_ROOT]: selected }),
		).toEqual({
			selectedCase: undefined,
			selectedByModuleUuid: undefined,
			parentCase: selected,
			parentModuleUuid: OTHER_ROOT,
			requiredParentCase: undefined,
		});
		expect(previewMenuCaseContext(doc, CHILD, {})).toEqual({
			selectedCase: undefined,
			selectedByModuleUuid: undefined,
			parentCase: undefined,
			parentModuleUuid: undefined,
			requiredParentCase: {
				caseType: "household",
				moduleUuid: OTHER_ROOT,
			},
		});
		expect(previewCaseDescendantModuleUuids(doc, "household")).toEqual([CHILD]);
	});

	it("skips a survey-only case-type module when choosing a parent selector", () => {
		const base = source("person");
		const doc = {
			...base,
			modules: {
				...base.modules,
				[ROOT]: module(ROOT, "clinic"),
				[SURVEY_ROOT]: module(SURVEY_ROOT, "household"),
				[OTHER_ROOT]: module(OTHER_ROOT, "household"),
			},
			moduleOrder: [ROOT, CHILD, SURVEY_ROOT, OTHER_ROOT],
			forms: {
				...base.forms,
				[SURVEY_FORM]: {
					uuid: SURVEY_FORM,
					id: "survey",
					name: "Survey",
					type: "survey" as const,
				},
			},
			formOrder: {
				...base.formOrder,
				[SURVEY_ROOT]: [SURVEY_FORM],
			},
		};

		expect(previewMenuCaseContext(doc, CHILD, {})).toMatchObject({
			requiredParentCase: {
				caseType: "household",
				moduleUuid: OTHER_ROOT,
			},
		});
	});
});
