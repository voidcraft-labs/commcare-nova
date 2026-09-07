import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, fieldSchema, type Module } from "@/lib/domain";
import {
	combineNavigationVisibility,
	inheritedModuleVisibility,
	previewCaseDescendantModuleUuids,
	previewMenuCaseContext,
	previewMenuModuleUuids,
} from "../menuProjection";
import { assertAdmittedPreviewDoc } from "./fixtures/admittedDoc";

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
		id: `m_${uuid.replaceAll("-", "")}`,
		name: uuid,
		caseType,
		caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
		...(parentModuleUuid ? { parentModuleUuid } : {}),
	};
}

function source(
	childCaseType = "household",
): BlueprintDoc & { caseTypes: NonNullable<BlueprintDoc["caseTypes"]> } {
	const caseTypes = [
		{ name: "household", properties: [] },
		{ name: "person", parent_type: "household", properties: [] },
		{ name: "visit", properties: [] },
		{ name: "clinic", properties: [] },
	];
	const doc = buildDoc({
		caseTypes,
		modules: (
			[
				[ROOT, "household", ROOT_FORM, undefined],
				[CHILD, childCaseType, CHILD_FORM, ROOT],
				[OTHER_ROOT, "visit", OTHER_ROOT_FORM, undefined],
			] as const
		).map(([uuid, caseType, formUuid]) => ({
			uuid,
			name: `Module ${uuid}`,
			caseType,
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
			forms: [
				{
					uuid: formUuid,
					name: "Follow-up",
					type: "followup" as const,
					fields: [f({ kind: "text", id: "notes" })],
				},
			],
		})),
	});
	doc.modules[CHILD].parentModuleUuid = ROOT;
	assertAdmittedPreviewDoc(doc);
	return { ...doc, caseTypes };
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
			cases: [{ caseId: "h1", caseName: "Household one" }],
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

	it("carries an authored set only to a compatible child with enough room", () => {
		const base = source();
		const selection = {
			caseType: "household",
			cases: [{ caseId: "h1", caseName: "One" }],
		};
		const multiConfig = {
			...caseListConfig([{ field: "case_name", header: "Name" }]),
			selection: { kind: "multiple" as const, maximum: 3 },
		};
		const root = base.modules[ROOT];
		const child = base.modules[CHILD];
		if (!root || !child) throw new Error("fixture modules are missing");
		const childConfig = {
			...caseListConfig([{ field: "case_name", header: "Name" }]),
			selection: multiConfig.selection,
		};
		const compatible = {
			...base,
			modules: {
				...base.modules,
				[ROOT]: { ...root, caseListConfig: multiConfig },
				[CHILD]: {
					...child,
					caseListConfig: childConfig,
				},
			},
		};
		assertAdmittedPreviewDoc(compatible);
		expect(
			previewMenuCaseContext(compatible, CHILD, { [ROOT]: selection })
				.selectedCase,
		).toEqual(selection);

		const tooSmall = {
			...compatible,
			modules: {
				...compatible.modules,
				[CHILD]: {
					...child,
					caseListConfig: {
						...childConfig,
						selection: { kind: "multiple" as const, maximum: 2 },
					},
				},
			},
		};
		assertAdmittedPreviewDoc(tooSmall);
		expect(
			previewMenuCaseContext(tooSmall, CHILD, { [ROOT]: selection })
				.selectedCase,
		).toBeUndefined();
	});

	it("keeps a declared different-type parent as a selection constraint", () => {
		const selected = {
			caseType: "household",
			cases: [
				{ caseId: "h1", caseName: "Household one" },
				{ caseId: "h2", caseName: "Household two" },
			],
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
			cases: [{ caseId: "h1", caseName: "Household one" }],
		};
		const child = {
			caseType: "person",
			cases: [{ caseId: "p1", caseName: "Person one" }],
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
			cases: [{ caseId: "h1", caseName: "Household one" }],
		};

		assertAdmittedPreviewDoc(doc);
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
		const surveyField = fieldSchema.parse({
			uuid: testUuid("survey_notes"),
			kind: "text",
			id: "survey_notes",
			label: { parts: [{ kind: "text", text: "Notes" }] },
		});
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
			fields: { ...base.fields, [surveyField.uuid]: surveyField },
			fieldParent: { ...base.fieldParent, [surveyField.uuid]: SURVEY_FORM },
			fieldOrder: { ...base.fieldOrder, [SURVEY_FORM]: [surveyField.uuid] },
		};

		assertAdmittedPreviewDoc(doc);
		expect(previewMenuCaseContext(doc, CHILD, {})).toMatchObject({
			requiredParentCase: {
				caseType: "household",
				moduleUuid: OTHER_ROOT,
			},
		});
	});
});
