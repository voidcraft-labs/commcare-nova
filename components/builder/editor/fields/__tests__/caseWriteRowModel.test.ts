// components/builder/editor/fields/__tests__/caseWriteRowModel.test.ts
//
// One row of a question's "Saves to", read from a real document: each
// destination's text and guidance from the views the one planner wrote,
// and each preload state's line and action, whose `updateField` the commit
// gate admits. Catches a row that names the wrong case, a preload line on a
// form that opens no single case, and an action the gate would refuse.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Field,
	type FieldCaseWriteView,
	fieldCaseWriteViews,
	humanizeId,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	caseWriteRowModel,
	OPENS_WITH_CASE_VALUE_LINE,
	STARTS_BLANK_LINE,
} from "../caseWriteRowModel";

const NICKNAME = testUuid("row-nickname");
const VISIT_NAME = testUuid("row-visit-name");
const VISIT_NOTE = testUuid("row-visit-note");
const REGION = testUuid("row-region");
const PHOTO = testUuid("row-photo");
const BLANK = testUuid("row-blank");
const COMPUTED = testUuid("row-computed");
const WORKER_REGION = testUuid("row-worker-region");

type FormType = "registration" | "followup" | "close";

function fixture(
	formType: FormType,
	selection: "one" | "several" = "one",
): BlueprintDoc {
	const config = caseListConfig([{ field: "nickname", header: "Nickname" }]);
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "nickname", label: proseText("Nickname") },
					{ name: "status", label: proseText("Status") },
					{ name: "photo", label: proseText("Photo") },
					{ name: "score", label: proseText("Score") },
				],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "note", label: proseText("Note") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig:
					selection === "several"
						? { ...config, selection: { kind: "multiple", maximum: 10 } }
						: config,
				forms: [
					{
						name: "Visit",
						type: formType,
						fields: [
							f({
								uuid: NICKNAME,
								kind: "text",
								id: "nickname",
								label: proseText("Nickname"),
								caseWrite: {
									caseType: "patient",
									property:
										formType === "registration" ? "case_name" : "nickname",
								},
							}),
							f({
								uuid: VISIT_NAME,
								kind: "text",
								id: "visit_name",
								label: proseText("Visit name"),
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
							f({
								uuid: VISIT_NOTE,
								kind: "text",
								id: "visit_note",
								label: proseText("Visit note"),
								caseWrite: { caseType: "visit", property: "note" },
							}),
							f({
								uuid: REGION,
								kind: "text",
								id: "region",
								label: proseText("Region"),
								caseWrite: { caseType: "commcare-user", property: "region" },
							}),
							f({
								uuid: PHOTO,
								kind: "image",
								id: "photo",
								label: proseText("Photo"),
								caseWrite: { caseType: "patient", property: "photo" },
							}),
							f({
								uuid: BLANK,
								kind: "text",
								id: "status",
								label: proseText("Status"),
							}),
							f({
								uuid: COMPUTED,
								kind: "hidden",
								id: "score",
								calculate: "1 + 1",
								caseWrite: { caseType: "patient", property: "score" },
							}),
						],
					},
				],
			},
			{
				name: "Visits",
				caseType: "visit",
				caseListOnly: true,
				caseListConfig: caseListConfig([{ field: "note", header: "Note" }]),
			},
		],
	});
	doc.userProperties = {
		[WORKER_REGION]: { uuid: WORKER_REGION, slug: "region", label: "Region" },
	};
	doc.userPropertyOrder = [WORKER_REGION];
	return doc;
}

function rowOf(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	view: FieldCaseWriteView | undefined = fieldCaseWriteViews(doc, fieldUuid)[0],
) {
	if (view === undefined)
		throw new Error("The fixture question saves its answer nowhere.");
	const formUuid = view.formUuid;
	const moduleUuid = doc.moduleOrder[0];
	return caseWriteRowModel({
		view,
		field: doc.fields[fieldUuid] as Field,
		form: doc.forms[formUuid],
		module: doc.modules[moduleUuid],
		propertyLabel: (_caseType, property) => humanizeId(property),
		operationDescription: () => "Update the case this form opened",
	});
}

/** The gate's findings for one mutation over `doc`: none when admitted. */
function admitted(doc: BlueprintDoc, mutation: unknown): readonly string[] {
	const verdict = mutationCommitVerdict(
		doc,
		[mutation as Parameters<typeof applyMutations>[1][number]],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok
		? []
		: verdict.findings.map((finding) => `${finding.code}: ${finding.message}`);
}

describe("each destination's row", () => {
	it("names this form's case by what the form does with it", () => {
		expect(rowOf(fixture("registration"), NICKNAME).destination).toBe(
			"The new patient · Case name",
		);
		for (const type of ["followup", "close"] as const) {
			expect(rowOf(fixture(type), NICKNAME).destination).toBe(
				"This form's case · Nickname",
			);
		}
	});

	it("names a new child case and says each submission creates one", () => {
		const row = rowOf(fixture("followup"), VISIT_NOTE);
		expect(row.destination).toBe("A new visit · Note");
		expect(row.readOnly).toBe(false);
		expect(row.guidance.help).toBe(
			"Creates a new Visit case on each submission.",
		);
	});

	it("names the worker's record", () => {
		const row = rowOf(fixture("followup"), REGION);
		expect(row.destination).toBe("The worker's record · Region");
		expect(row.guidance.help).toBeUndefined();
	});

	it("says a capture saves a link to its file", () => {
		const doc = fixture("followup");
		const view = fieldCaseWriteViews(doc, PHOTO)[0];
		expect(view?.link).toBe(true);
		expect(rowOf(doc, PHOTO).destination).toBe(
			"Saves a link to the file in Photo",
		);
		expect(rowOf(doc, PHOTO).preload).toBeUndefined();
	});

	it("reads another change's write read-only, by that change's sentence", () => {
		const doc = fixture("followup");
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		doc.forms[formUuid].caseOperations?.push({
			uuid: testUuid("row-other-update"),
			id: "update_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [
				{
					property: "status",
					value: { kind: "term", term: { kind: "field", uuid: BLANK } },
				},
			],
		});
		const row = rowOf(doc, BLANK);
		expect(row.readOnly).toBe(true);
		expect(row.destination).toBe("Update the case this form opened · Status");
	});

	it("says a write to the own case reaches every selected case on a several-case form", () => {
		const row = rowOf(fixture("followup", "several"), NICKNAME);
		expect(row.guidance.writesEverySelectedCase).toBe(true);
		expect(row.guidance.help).toContain("on every selected case");
		// A several-case form opens no single case, so there is no preload.
		expect(row.preload).toBeUndefined();
	});
});

describe("the preload line", () => {
	it("opens with the case's value when the starting value is that read, and Start blank instead clears it", () => {
		// The planner gave the follow-up write the case's value as its
		// starting value.
		const doc = fixture("followup");
		const row = rowOf(doc, NICKNAME);
		expect(row.preload?.line).toBe(OPENS_WITH_CASE_VALUE_LINE);
		expect(row.preload?.action.label).toBe("Start blank instead");
		expect(row.preload?.action.mutation).toMatchObject({
			kind: "updateField",
			uuid: NICKNAME,
			patch: { default_value: null },
		});
		expect(admitted(doc, row.preload?.action.mutation)).toEqual([]);
	});

	it("starts blank with no starting value, and Open with the case's current value sets the read", () => {
		const opened = fixture("close");
		const start = rowOf(opened, NICKNAME).preload?.action.mutation;
		const doc = produce(opened, (draft) => {
			if (start !== undefined) applyMutations(draft, [start]);
		});
		const row = rowOf(doc, NICKNAME);
		expect(row.preload?.line).toBe(STARTS_BLANK_LINE);
		expect(row.preload?.action.label).toBe(
			"Open with the case's current value",
		);
		expect(row.preload?.action.mutation).toMatchObject({
			kind: "updateField",
			uuid: NICKNAME,
			patch: {
				default_value: {
					kind: "term",
					term: {
						kind: "form-case",
						caseType: "patient",
						property: "nickname",
					},
				},
			},
		});
		expect(admitted(doc, row.preload?.action.mutation)).toEqual([]);
	});

	it("says nothing over another starting value or a calculation", () => {
		const doc = produce(fixture("followup"), (draft) => {
			const field = draft.fields[NICKNAME];
			if (field !== undefined && "default_value" in field)
				field.default_value = {
					kind: "term",
					term: { kind: "literal", value: "x" },
				};
		});
		expect(rowOf(doc, NICKNAME).preload).toBeUndefined();
		expect(rowOf(fixture("followup"), COMPUTED).preload).toBeUndefined();
	});

	it("says nothing off this form's case or on a registration", () => {
		const followup = fixture("followup");
		expect(rowOf(followup, VISIT_NOTE).preload).toBeUndefined();
		expect(rowOf(followup, REGION).preload).toBeUndefined();
		expect(rowOf(fixture("registration"), NICKNAME).preload).toBeUndefined();
	});
});
