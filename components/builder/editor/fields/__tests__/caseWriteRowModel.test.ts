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
import { formCasePlacementView } from "@/lib/doc/casePlacements";
import { caseWriteChoiceVerdict } from "@/lib/doc/caseWriteChoices";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Field,
	type FieldCaseWriteView,
	fieldCaseWriteViewKey,
	fieldCaseWriteViews,
	humanizeId,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	ancestorCaseWriteChoices,
	caseWriteRowModel,
	KEPT_IN_SAVE_TO_CASE_REASON,
	NEW_CASE_NO_EARLIER_VALUE_REASON,
	OPENS_WITH_CASE_VALUE_LINE,
	onlyIfChangedDestination,
	SAVE_ONLY_IF_CHANGED_LABEL,
	SAVE_ONLY_IF_CHANGED_LINE,
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
				caseListMenuItem: {},
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

// ── Cases above it, and Save only if changed ─────────────────────────────

const ABOVE_NOTE = testUuid("row-above-note");
const ABOVE_NAME = testUuid("row-above-name");

/**
 * A menu over `member` cases: a member belongs to a household (`child`),
 * and a household extends a village (`extension`).
 */
function aboveFixture(formType: FormType): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "village",
				properties: [{ name: "region", label: proseText("Region") }],
			},
			{
				name: "household",
				parent_type: "village",
				relationship: "extension",
				properties: [{ name: "address", label: proseText("Address") }],
			},
			{
				name: "member",
				parent_type: "household",
				properties: [{ name: "note", label: proseText("Note") }],
			},
		],
		modules: [
			{
				name: "Members",
				caseType: "member",
				caseListConfig: caseListConfig([{ field: "note", header: "Note" }]),
				forms: [
					{
						name: "Visit",
						type: formType,
						fields: [
							f({
								uuid: ABOVE_NAME,
								kind: "text",
								id: "member_name",
								label: proseText("Name"),
								caseWrite: { caseType: "member", property: "case_name" },
							}),
							f({
								uuid: ABOVE_NOTE,
								kind: "text",
								id: "note",
								label: proseText("Note"),
								caseWrite: { caseType: "member", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
}

function rowWith(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	options: {
		readonly placement?: boolean;
		readonly verdict?: { ok: true } | { ok: false; reason: string };
	} = {},
) {
	const view = fieldCaseWriteViews(doc, fieldUuid)[0];
	if (view === undefined)
		throw new Error("The fixture question saves its answer nowhere.");
	return caseWriteRowModel({
		view,
		field: doc.fields[fieldUuid] as Field,
		form: doc.forms[view.formUuid],
		module: doc.modules[doc.moduleOrder[0]],
		propertyLabel: (_caseType, property) => humanizeId(property),
		operationDescription: () => undefined,
		...(options.placement !== false && {
			placement: formCasePlacementView(doc, view.formUuid),
		}),
		...(options.verdict !== undefined && {
			onlyIfChangedVerdict: options.verdict,
		}),
	});
}

/** The verdict of the row's switch destination, replacing the row's write. */
function switchVerdict(doc: BlueprintDoc, fieldUuid: Uuid) {
	const view = fieldCaseWriteViews(doc, fieldUuid)[0];
	if (view === undefined)
		throw new Error("The fixture question saves its answer nowhere.");
	return caseWriteChoiceVerdict(
		doc,
		fieldUuid,
		{
			destination: onlyIfChangedDestination(view),
			replace: fieldCaseWriteViewKey(view),
		},
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
}

function committed(doc: BlueprintDoc, mutations: readonly unknown[]) {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations as Parameters<typeof applyMutations>[1]);
	});
}

describe("the cases above it", () => {
	it("lists one choice per chain of links, walking an extension as parent and as host", () => {
		const doc = aboveFixture("followup");
		const choices = ancestorCaseWriteChoices(
			doc.caseTypes ?? [],
			"member",
			"followup",
		);
		expect(choices).toEqual([
			{
				caseType: "household",
				via: [{ identifier: "parent" }],
				label: "household (parent)",
			},
			{
				caseType: "village",
				via: [{ identifier: "parent" }, { identifier: "parent" }],
				label: "village (parent, then parent)",
			},
			{
				caseType: "village",
				via: [
					{ identifier: "parent" },
					{ identifier: "host", throughCaseType: "village" },
				],
				label: "village (parent, then host)",
			},
		]);
	});

	it("lists an extension's host from a menu over the extension", () => {
		const doc = aboveFixture("followup");
		expect(
			ancestorCaseWriteChoices(doc.caseTypes ?? [], "household", "close").map(
				(choice) => choice.label,
			),
		).toEqual(["village (parent)", "village (host)"]);
	});

	it("offers none on a registration or a survey, and stops at a cycle", () => {
		const doc = aboveFixture("followup");
		const caseTypes = doc.caseTypes ?? [];
		expect(
			ancestorCaseWriteChoices(caseTypes, "member", "registration"),
		).toEqual([]);
		expect(ancestorCaseWriteChoices(caseTypes, "member", "survey")).toEqual([]);
		const cyclic = [
			{ name: "a", parent_type: "b", properties: [] },
			{ name: "b", parent_type: "a", properties: [] },
		];
		expect(
			ancestorCaseWriteChoices(cyclic, "a", "followup").map(
				(choice) => choice.label,
			),
		).toEqual(["b (parent)"]);
	});

	it("admits every choice as a replacement of a row, and the row it lands edits its write", () => {
		const doc = aboveFixture("followup");
		const view = fieldCaseWriteViews(doc, ABOVE_NOTE)[0];
		if (view === undefined) throw new Error("The note saves nowhere.");
		for (const choice of ancestorCaseWriteChoices(
			doc.caseTypes ?? [],
			"member",
			"followup",
		)) {
			const verdict = caseWriteChoiceVerdict(
				doc,
				ABOVE_NOTE,
				{
					destination: {
						caseType: choice.caseType,
						property: "note",
						via: choice.via,
					},
					replace: fieldCaseWriteViewKey(view),
				},
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict, choice.label).toMatchObject({ ok: true });
			if (!verdict.ok) continue;
			const row = rowWith(committed(doc, verdict.mutations), ABOVE_NOTE);
			expect(row.readOnly).toBe(false);
			expect(row.destination).toBe(
				choice.via.length === 1
					? "Household it belongs to · Note"
					: "Village above it · Note",
			);
			expect(row.onlyIfChanged?.on).toBe(false);
			expect(row.onlyIfChanged?.disabledReason).toBeUndefined();
		}
	});
});

describe("the Save only if changed switch", () => {
	it("shows on a write to this form's case and turns on through the gate on a follow-up", () => {
		const doc = aboveFixture("followup");
		const row = rowWith(doc, ABOVE_NOTE);
		expect(row.onlyIfChanged).toMatchObject({
			label: SAVE_ONLY_IF_CHANGED_LABEL,
			line: SAVE_ONLY_IF_CHANGED_LINE,
			on: false,
			destination: {
				caseType: "member",
				property: "note",
				onlyIfChanged: true,
			},
		});
		expect(row.onlyIfChanged?.disabledReason).toBeUndefined();
		const on = switchVerdict(doc, ABOVE_NOTE);
		expect(on).toMatchObject({ ok: true });
		if (!on.ok) return;
		const turnedOn = committed(doc, on.mutations);
		const onRow = rowWith(turnedOn, ABOVE_NOTE);
		expect(onRow.onlyIfChanged?.on).toBe(true);
		// The switch's way back is the plain write, which the gate admits.
		expect(onRow.onlyIfChanged?.destination).toEqual({
			caseType: "member",
			property: "note",
		});
		expect(switchVerdict(turnedOn, ABOVE_NOTE)).toMatchObject({ ok: true });
	});

	it("is not offered on a name, a new child case or the worker's record", () => {
		const doc = aboveFixture("followup");
		expect(rowWith(doc, ABOVE_NAME).onlyIfChanged).toBeUndefined();
		const followup = fixture("followup");
		expect(rowOf(followup, VISIT_NOTE).onlyIfChanged).toBeUndefined();
		expect(rowOf(followup, REGION).onlyIfChanged).toBeUndefined();
	});

	it("is disabled on a registration, whose new case has no earlier value", () => {
		const doc = aboveFixture("registration");
		const row = rowWith(doc, ABOVE_NOTE);
		expect(row.onlyIfChanged?.disabledReason).toBe(
			NEW_CASE_NO_EARLIER_VALUE_REASON,
		);
		// The gate refuses the same switch.
		expect(switchVerdict(doc, ABOVE_NOTE).ok).toBe(false);
	});

	it("is disabled while CommCare HQ keeps the change in Save to Case", () => {
		// A several-case form keeps its own case's change in Save to Case.
		const doc = fixture("followup", "several");
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		expect(formCasePlacementView(doc, formUuid).own?.home).toBe("save-to-case");
		const verdict = switchVerdict(doc, NICKNAME);
		expect(verdict.ok).toBe(false);
		const row = rowWith(doc, NICKNAME, {
			verdict: verdict.ok ? { ok: true } : verdict,
		});
		expect(row.onlyIfChanged?.disabledReason).toBe(KEPT_IN_SAVE_TO_CASE_REASON);
	});

	it("says the gate's reason where nothing else names one", () => {
		const doc = fixture("followup", "several");
		const verdict = switchVerdict(doc, NICKNAME);
		if (verdict.ok) throw new Error("The gate admitted the switch.");
		const row = rowWith(doc, NICKNAME, { placement: false, verdict });
		expect(row.onlyIfChanged?.disabledReason).toBe(verdict.reason);
	});
});
