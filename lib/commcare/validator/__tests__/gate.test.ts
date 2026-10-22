import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type Field,
} from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	now,
	term,
	today,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { buildDoc, caseListConfig, f } from "../../../__tests__/docHelpers";
import { evaluateBoundary, evaluateCommit } from "../gate";
import { runValidation } from "../runner";

function valid(doc: BlueprintDoc): BlueprintDoc {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

function fieldNamed(doc: BlueprintDoc, id: string): Field {
	const field = Object.values(doc.fields).find((field) => field.id === id);
	if (field === undefined) throw new Error(`Missing fixture field ${id}`);
	return field;
}

function codes(verdict: ReturnType<typeof evaluateCommit>) {
	if (verdict.ok) throw new Error("Expected the candidate to be refused");
	return verdict.findings.map(({ code }) => code);
}

// ── Fixtures ───────────────────────────────────────────────────────

/** Minimal valid doc: one registration module/form writing "patient". */
function minDoc(): BlueprintDoc {
	return valid(
		buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Form",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								// A second case-writing field, for a realistic registration
								// form (a name-only create is also valid — see form.ts).
								f({
									kind: "text",
									id: "village",
									label: proseText("Village"),
									caseWrite: { caseType: "patient", property: "village" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
					],
				},
			],
		}),
	);
}

/** Two valid top-level modules; tests reparent the second under a form-less
 * case-list-only root so the gate sees the topology change atomically. */
function caseListRootDoc(childCaseType: "household" | "visit"): BlueprintDoc {
	return valid(
		buildDoc({
			appName: "Nested case list",
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				...(childCaseType === "household"
					? []
					: [
							{
								name: "visit",
								properties: [{ name: "case_name", label: proseText("Name") }],
							},
						]),
			],
			modules: [
				{
					name: "Households",
					caseType: "household",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [],
				},
				{
					name: "Visits",
					caseType: childCaseType,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
								}),
							],
						},
					],
				},
			],
		}),
	);
}

function peerWriters(property: string): BlueprintDoc {
	return valid(
		buildDoc({
			appName: "Peer writers",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: property, label: proseText(property) },
					],
				},
			],
			modules: ["A", "B"].map((name) => ({
				name,
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "int",
								id: property,
								caseWrite: { caseType: "patient", property },
							}),
						],
					},
				],
			})),
		}),
	);
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

/** A bare survey form payload for addForm mutations. */
function surveyForm(uuid: string, name: string) {
	return { uuid: testUuid(uuid), id: uuid, name, type: "survey" as const };
}

function textField(
	uuid: string,
	id: string,
	extra?: Partial<Extract<Field, { kind: "text" }>>,
): Field {
	return {
		uuid: testUuid(uuid),
		kind: "text",
		id,
		label: proseText(id),
		...extra,
	};
}

/** Run the full pipeline: apply, then validate the complete candidate. */
function gateCommit(prevDoc: BlueprintDoc, mutations: Mutation[]) {
	const nextDoc = apply(prevDoc, mutations);
	blueprintDocSchema.parse(toPersistableDoc(nextDoc));
	return evaluateCommit({
		nextDoc,
		lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
	});
}

/** `minDoc()` plus one empty survey form with a known uuid. */
function docWithEmptyForm(formUuid = "form-e1"): BlueprintDoc {
	const base = minDoc();
	return apply(base, [
		{
			kind: "addForm",
			moduleUuid: base.moduleOrder[0],
			form: surveyForm(formUuid, `Empty ${formUuid}`),
		},
	]);
}

// ── evaluateCommit ─────────────────────────────────────────────────

describe("evaluateCommit", () => {
	it("rejects a different-case child under a form-less case-list root", () => {
		const doc = caseListRootDoc("visit");
		const [rootUuid, childUuid] = doc.moduleOrder;
		if (rootUuid === undefined || childUuid === undefined) {
			throw new Error("missing nested-menu gate fixture modules");
		}
		const verdict = gateCommit(doc, [
			{
				kind: "moveModule",
				uuid: childUuid,
				parentModuleUuid: rootUuid,
				after: null,
			},
		]);
		expect(codes(verdict)).toEqual([
			"NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM",
		]);
		if (verdict.ok) throw new Error("Expected the nested menu to be refused");
		expect(verdict.findings[0].location.moduleUuid).toBe(childUuid);
	});

	it("accepts a same-case child under a form-less case-list root", () => {
		const doc = caseListRootDoc("household");
		const [rootUuid, childUuid] = doc.moduleOrder;
		if (rootUuid === undefined || childUuid === undefined) {
			throw new Error("missing nested-menu gate fixture modules");
		}
		expect(
			gateCommit(doc, [
				{
					kind: "moveModule",
					uuid: childUuid,
					parentModuleUuid: rootUuid,
					after: null,
				},
			]),
		).toMatchObject({ ok: true });
	});

	it("a new EMPTY_FORM (completeness) is rejected — an entity lands complete or not at all", () => {
		const doc = minDoc();
		const verdict = gateCommit(doc, [
			{
				kind: "addForm",
				moduleUuid: doc.moduleOrder[0],
				form: surveyForm("form-new", "New"),
			},
		]);
		expect(codes(verdict)).toEqual(["EMPTY_FORM"]);
	});

	it("accepts a new form together with the question that makes it complete", () => {
		const doc = minDoc();
		expect(
			gateCommit(doc, [
				{
					kind: "addForm",
					moduleUuid: doc.moduleOrder[0],
					form: surveyForm("new", "Interview"),
				},
				{
					kind: "addField",
					parentUuid: testUuid("new"),
					field: textField("answer", "answer"),
				},
			]),
		).toEqual({ ok: true });
	});

	it("retains a shape backstop for a legacy hidden field carrying required", () => {
		const doc = buildDoc({
			appName: "Legacy",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Interview",
							type: "survey",
							fields: [
								f({ kind: "text", id: "answer" }),
								f({
									kind: "hidden",
									id: "computed",
									calculate: "1",
									required: "true()",
								}),
							],
						},
					],
				},
			],
		});
		expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
			false,
		);
		expect(
			codes(
				evaluateCommit({
					nextDoc: doc,
					lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
				}),
			),
		).toEqual(["REQUIRED_ON_HIDDEN"]);
	});

	it("a hidden field carrying both value sources is schema-legal and refused as soundness; clearing one slot is admitted", () => {
		// Both slots are optional so historical documents hydrate; the gate is
		// what makes the pair unrepresentable. A commit that introduces it is
		// refused, and the clearing commit (the shape the one-off repair wrote)
		// is admitted.
		const doc = minDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const hidden: Field = {
			uuid: testUuid("fld-hidden-both"),
			kind: "hidden",
			id: "computed",
			calculate: term(literal(1)),
			default_value: today(),
		};
		const both = apply(doc, [
			{ kind: "addField", parentUuid: formUuid, field: hidden },
		]);
		expect(blueprintDocSchema.safeParse(toPersistableDoc(both)).success).toBe(
			true,
		);
		expect(
			codes(
				gateCommit(doc, [
					{ kind: "addField", parentUuid: formUuid, field: hidden },
				]),
			),
		).toEqual(["HIDDEN_VALUE_BOTH_SOURCES"]);
		expect(
			gateCommit(both, [
				{
					kind: "updateField",
					uuid: hidden.uuid,
					targetKind: "hidden",
					patch: { default_value: null },
				},
			]),
		).toEqual({ ok: true });
	});

	it("a new INVALID_REF (soundness) is rejected", () => {
		const doc = minDoc();
		const fieldUuid = Object.values(doc.fields)[0].uuid;
		const verdict = gateCommit(doc, [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: {
					relevant: eq(formField(testUuid("does-not-exist")), literal("x")),
				},
			},
		]);
		expect(codes(verdict)).toEqual(["INVALID_REF"]);
	});

	it("rejects an unrelated edit when the complete candidate remains invalid", () => {
		// The deliberately damaged candidate carries a bad reference in another form.
		const base = docWithEmptyForm("form-e1");
		const broken = apply(base, [
			{
				kind: "addField",
				parentUuid: testUuid("form-e1"),
				field: textField("fld-bad", "q1", {
					relevant: eq(formField(testUuid("missing")), literal("1")),
				}),
			},
		]);
		expect(
			runValidation(broken, LOOKUP_CONTEXT_UNAVAILABLE).length,
		).toBeGreaterThan(0);
		const caseNameField = fieldNamed(broken, "case_name");
		const verdict = gateCommit(broken, [
			{
				kind: "updateField",
				uuid: caseNameField.uuid,
				targetKind: "text",
				patch: { id: "case_name" },
			},
		]);
		expect(codes(verdict)).toEqual(["INVALID_REF"]);
	});

	it("fixing an error passes", () => {
		const broken = docWithEmptyForm("form-e1");
		const fix: Mutation[] = [
			{
				kind: "addField",
				parentUuid: testUuid("form-e1"),
				field: textField("fld-fill", "q1"),
			},
		];
		expect(gateCommit(broken, fix)).toEqual({ ok: true });
	});

	it("setAppName catches EMPTY_APP_NAME on the complete candidate", () => {
		const doc = minDoc();
		const mutations: Mutation[] = [{ kind: "setAppName", name: "" }];
		const verdict = gateCommit(doc, mutations);
		expect(codes(verdict)).toEqual(["EMPTY_APP_NAME"]);
	});

	it("never fires environment rules — commit runs carry no manifest", () => {
		// A field media ref pointing at an asset that doesn't exist would be
		// MEDIA_ASSET_NOT_FOUND at a boundary; the commit gate must not see it.
		const doc = minDoc();
		const fieldUuid = Object.values(doc.fields)[0].uuid;
		const verdict = gateCommit(doc, [
			{
				kind: "setFieldMedia",
				fieldUuid,
				slot: "label",
				media: { image: testMediaAssetId("asset-missing") },
			},
		]);
		expect(verdict).toEqual({ ok: true });
	});

	it("renaming one field preserves a peer writer's identity and case destination", () => {
		const doc = peerWriters("age");
		const [first, second] = Object.values(doc.fields);
		const nextDoc = apply(doc, [
			{
				kind: "updateField",
				uuid: first.uuid,
				targetKind: "int",
				patch: { id: "weight" },
			},
		]);
		blueprintDocSchema.parse(toPersistableDoc(nextDoc));
		expect(
			evaluateCommit({ nextDoc, lookupContext: LOOKUP_CONTEXT_UNAVAILABLE }),
		).toEqual({ ok: true });
		expect(nextDoc.fields[first.uuid]).toEqual({ ...first, id: "weight" });
		expect(nextDoc.fields[second.uuid]).toEqual(second);
	});

	it("catches a search-input finding a new writer flips in a relation-walking module of another type", () => {
		// The Households module's search input `via`-walks to the PATIENT
		// type. Adding a date writer for `patient.age` types the property,
		// flipping UNKNOWN_PROPERTY to MODE_PROPERTY_TYPE_MISMATCH in another
		// module. The complete-candidate gate must still refuse that app.
		const doc = buildDoc({
			appName: "Walk",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					name: "Households",
					caseType: "household",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						searchInputs: [
							{
								kind: "simple",
								uuid: testUuid("sin-walk"),
								name: "age",
								label: "Age",
								type: "text",
								property: "age",
								mode: { kind: "starts-with" },
								via: {
									kind: "ancestor",
									via: [{ identifier: "parent" }],
								},
							},
						],
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "household",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		});
		const registerForm = doc.formOrder[doc.moduleOrder[0]][0];
		const prevCodes = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
			(e) => e.code,
		);
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(prevCodes).toEqual(["CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY"]);
		const verdict = gateCommit(doc, [
			{
				kind: "addField",
				parentUuid: registerForm,
				field: {
					uuid: testUuid("fld-age-new"),
					kind: "date",
					id: "age",
					label: proseText("Age"),
					caseWrite: { caseType: "patient", property: "age" },
				},
			},
		]);
		expect(codes(verdict)).toEqual([
			"CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
		]);
	});

	it("reports both conflicting writers after a kind change in one module", () => {
		const doc = peerWriters("score");
		const [first, second] = Object.values(doc.fields);
		const verdict = gateCommit(doc, [
			{ kind: "convertField", uuid: first.uuid, toKind: "decimal" },
		]);
		expect(codes(verdict)).toEqual([
			"FIELD_KIND_WRITERS_DISAGREE",
			"FIELD_KIND_WRITERS_DISAGREE",
		]);
		if (verdict.ok)
			throw new Error("Expected conflicting writers to be refused");
		expect(
			verdict.findings.map(({ location }) => location.fieldUuid).sort(),
		).toEqual([first.uuid, second.uuid].sort());
	});
});

// ── The checker's and writer agreement's codes ─────────────────────

const WRITER = testUuid("gate-stamp");
const STAGE_WRITER = testUuid("gate-stage-value");
const NOTES = testUuid("gate-notes");
const DAY = testUuid("gate-day");
const INSIDE = testUuid("gate-inside");

/** A registration form whose Hidden Values save a date and a choice that a
 * follow-up's questions fill themselves from, beside a question whose display
 * condition the cases below rewrite. */
function writersDoc(): BlueprintDoc {
	return valid(
		buildDoc({
			appName: "Writers",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "visit_date", label: proseText("Visit date") },
						{ name: "stage", label: proseText("Stage") },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									uuid: "gate-stamp",
									kind: "hidden",
									id: "stamp",
									calculate: "today()",
									caseWrite: { caseType: "patient", property: "visit_date" },
								}),
								f({
									uuid: "gate-stage-value",
									kind: "hidden",
									id: "stage_value",
									calculate: "'a'",
									caseWrite: { caseType: "patient", property: "stage" },
								}),
								f({
									uuid: "gate-notes",
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
								}),
								f({
									uuid: "gate-day",
									kind: "date",
									id: "day",
									label: proseText("Day"),
								}),
								f({
									kind: "repeat",
									id: "rows",
									label: proseText("Rows"),
									children: [
										f({
											uuid: "gate-inside",
											kind: "text",
											id: "inside",
											label: proseText("Inside"),
										}),
									],
								}),
							],
						},
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "date",
									id: "visit_date",
									label: proseText("Visit date"),
									caseWrite: { caseType: "patient", property: "visit_date" },
								}),
								f({
									kind: "single_select",
									id: "stage_question",
									label: proseText("Stage"),
									caseWrite: { caseType: "patient", property: "stage" },
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
								}),
							],
						},
					],
				},
			],
		}),
	);
}

describe("evaluateCommit — the checker's and writer agreement's codes", () => {
	const hiddenPatch = (
		uuid: typeof WRITER,
		calculate: Expression,
	): Mutation => ({
		kind: "updateField",
		uuid,
		targetKind: "hidden",
		patch: { calculate },
	});
	const notesRelevant = (relevant: Expression): Mutation => ({
		kind: "updateField",
		uuid: NOTES,
		targetKind: "text",
		patch: { relevant },
	});
	it.each([
		{
			code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
			refused: hiddenPatch(WRITER, term(literal("soon"))),
			admitted: hiddenPatch(WRITER, today()),
		},
		{
			code: "SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
			refused: hiddenPatch(STAGE_WRITER, term(literal("z"))),
			admitted: hiddenPatch(STAGE_WRITER, term(literal("b"))),
		},
		{
			code: "XPATH_INCOMPATIBLE_VALUES",
			refused: notesRelevant(eq(formField(DAY), now())),
			admitted: notesRelevant(eq(formField(DAY), today())),
		},
		{
			code: "XPATH_MANY_VALUES",
			refused: notesRelevant(eq(formField(INSIDE), literal("yes"))),
			admitted: notesRelevant(
				eq({ kind: "count", via: term(formField(INSIDE)) }, literal(1)),
			),
		},
	] as const)(
		"$code gates the commit that introduces it",
		({ code, refused, admitted }) => {
			const doc = writersDoc();
			expect(codes(gateCommit(doc, [refused]))).toEqual([code]);
			expect(gateCommit(doc, [admitted])).toEqual({ ok: true });
		},
	);
});

// ── evaluateBoundary ───────────────────────────────────────────────

describe("evaluateBoundary", () => {
	it("returns every finding on a full run, media included", () => {
		const doc = docWithEmptyForm("form-e1");
		const withMedia = apply(doc, [
			{
				kind: "setFieldMedia",
				fieldUuid: Object.values(doc.fields)[0].uuid,
				slot: "label",
				media: { image: testMediaAssetId("asset-missing") },
			},
		]);
		const findings = evaluateBoundary(
			withMedia,
			new Map(),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		const codes = findings.map((e) => e.code);
		expect(codes.sort()).toEqual(["EMPTY_FORM", "MEDIA_ASSET_NOT_FOUND"]);
	});

	it("returns nothing for a valid doc", () => {
		expect(
			evaluateBoundary(minDoc(), new Map(), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
	});
});
