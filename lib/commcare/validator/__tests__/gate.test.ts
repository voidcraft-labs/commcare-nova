import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { buildDoc, caseListConfig, f, xp } from "../../../__tests__/docHelpers";
import { MEDIA_VALIDATION_CODES } from "../errors";
import {
	classifyError,
	evaluateBoundary,
	evaluateCommit,
	VALIDITY_CLASS_BY_CODE,
} from "../gate";
import { runValidation } from "../runner";

// ── Fixtures ───────────────────────────────────────────────────────

/** Minimal valid doc: one registration module/form writing "patient". */
function minDoc(): BlueprintDoc {
	return buildDoc({
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
	});
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
	extra?: Record<string, unknown>,
): Field {
	return {
		uuid: testUuid(uuid),
		kind: "text",
		id,
		label: proseText(id),
		...extra,
	} as Field;
}

/** Run the full pipeline: apply, then validate the complete candidate. */
function gateCommit(prevDoc: BlueprintDoc, mutations: Mutation[]) {
	const nextDoc = apply(prevDoc, mutations);
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

// ── Classification ─────────────────────────────────────────────────

describe("classification table", () => {
	it("covers every code declared in errors.ts (runtime audit of the union source)", () => {
		// The Record type makes totality a compile error; this audit pins the
		// runtime table against the union SOURCE so neither side can carry a
		// stray code the other lost.
		const errorsSource = readFileSync(
			fileURLToPath(new URL("../errors.ts", import.meta.url)),
			"utf8",
		);
		const declared = [
			...errorsSource.matchAll(/\|\s+"([A-Z][A-Z0-9_]*)"/g),
		].map((m) => m[1]);
		expect(new Set(declared).size).toBe(declared.length);
		expect([...new Set(declared)].sort()).toEqual(
			Object.keys(VALIDITY_CLASS_BY_CODE).sort(),
		);
	});

	it("pins the completeness classification set exactly", () => {
		const completeness = Object.entries(VALIDITY_CLASS_BY_CODE)
			.filter(([, cls]) => cls === "completeness")
			.map(([code]) => code)
			.sort();
		expect(completeness).toEqual(
			[
				"NO_MODULES",
				"EMPTY_FORM",
				"MISSING_CASE_LIST_COLUMNS",
				"CASE_CREATE_NAME_MISSING",
				"MISSING_CHILD_CASE_MODULE",
				"CONNECT_NO_PARTICIPATING_FORMS",
			].sort(),
		);
	});

	it("pins the environment classification set (asset/row-context rules + the export-budget guards)", () => {
		const environment = Object.entries(VALIDITY_CLASS_BY_CODE)
			.filter(([, cls]) => cls === "environment")
			.map(([code]) => code)
			.sort();
		expect(environment).toEqual([
			"LOOKUP_FIXTURE_EXPORT_TOO_LARGE",
			"LOOKUP_SELECT_SOURCE_LABEL_BLANK",
			"LOOKUP_SELECT_SOURCE_VALUE_BLANK",
			"LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE",
			"LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE",
			"MEDIA_ASSET_NOT_FOUND",
			"MEDIA_ASSET_NOT_READY",
			"MEDIA_EXPORT_TOO_LARGE",
			"MEDIA_KIND_MISMATCH",
		]);
	});

	it("classifies exactly the wire-oracle families as oracle", () => {
		const mediaSuiteResourceFamily = new Set([
			"MEDIA_NO_PATH",
			"MEDIA_NO_RESOURCE",
			"MEDIA_RESOURCE_NO_ID",
			"MEDIA_RESOURCE_VERSION_NOT_INTEGER",
			"MEDIA_RESOURCE_NO_LOCATION",
			"MEDIA_LOCATION_NO_AUTHORITY",
			"MEDIA_LOCATION_NO_PATH",
			"MEDIA_LOCATION_UNKNOWN_AUTHORITY",
			"MEDIA_RESOURCE_DUPLICATE_ID",
			"MEDIA_LOCATION_PATH_NOT_BUNDLED",
		]);
		const oraclePrefix =
			/^(XFORM_|SUITE_|HQJSON_|BINDING_RESOLUTION_|MEDIA_SUITE_)/;
		for (const [code, cls] of Object.entries(VALIDITY_CLASS_BY_CODE)) {
			const expected =
				oraclePrefix.test(code) || mediaSuiteResourceFamily.has(code);
			expect(cls === "oracle", `${code} oracle classification`).toBe(expected);
		}
	});

	it("pins the shape backstops and the per-class tallies", () => {
		const byClass = new Map<string, string[]>();
		for (const [code, cls] of Object.entries(VALIDITY_CLASS_BY_CODE)) {
			byClass.set(cls, [...(byClass.get(cls) ?? []), code]);
		}
		expect(byClass.get("shape")?.sort()).toEqual([
			"CALCULATE_ON_VISIBLE_INPUT",
			"INVALID_POST_SUBMIT",
			"MEDIA_CASE_PROPERTY",
			"REQUIRED_ON_HIDDEN",
			"SELECT_NO_OPTIONS",
			"VALIDATION_ON_NON_INPUT_KIND",
		]);
		expect(byClass.get("completeness")).toHaveLength(6);
		expect(byClass.get("environment")).toHaveLength(9);
		expect(byClass.get("oracle")).toHaveLength(101);
		expect(byClass.get("shape")).toHaveLength(6);
		expect(byClass.get("soundness")).toHaveLength(164);
		expect(Object.keys(VALIDITY_CLASS_BY_CODE)).toHaveLength(286);
	});

	it("keeps the structural image-map rule out of the environment class", () => {
		// CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE is in MEDIA_VALIDATION_CODES (the
		// media boundary surfaces it) but is doc-structural — it must gate
		// commits as soundness, not defer to the boundary.
		expect(
			MEDIA_VALIDATION_CODES.has("CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE"),
		).toBe(true);
		expect(classifyError("CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE")).toBe(
			"soundness",
		);
	});
});

// ── evaluateCommit ─────────────────────────────────────────────────

describe("evaluateCommit", () => {
	it("a new EMPTY_FORM (completeness) is rejected — an entity lands complete or not at all", () => {
		const doc = minDoc();
		const verdict = gateCommit(doc, [
			{
				kind: "addForm",
				moduleUuid: doc.moduleOrder[0],
				form: surveyForm("form-new", "New"),
			},
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain("EMPTY_FORM");
		}
	});

	it("a new INVALID_REF (soundness) is rejected", () => {
		const doc = minDoc();
		const fieldUuid = Object.values(doc.fields)[0].uuid;
		const verdict = gateCommit(doc, [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: { relevant: xp("#form/does_not_exist = 'x'") },
			} as Mutation,
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain("INVALID_REF");
		}
	});

	it("rejects an unrelated edit when the complete candidate remains invalid", () => {
		// The deliberately damaged candidate already carries an empty form and
		// a bad reference.
		const base = docWithEmptyForm("form-e1");
		const broken = apply(base, [
			{
				kind: "addField",
				parentUuid: testUuid("form-e1"),
				field: textField("fld-bad", "q1", {
					relevant: xp("#form/missing = '1'"),
				}),
			},
		]);
		expect(
			runValidation(broken, LOOKUP_CONTEXT_UNAVAILABLE).length,
		).toBeGreaterThan(0);
		const caseNameField = Object.values(broken.fields).find(
			(x) => x.id === "case_name",
		);
		const verdict = gateCommit(broken, [
			{
				kind: "updateField",
				uuid: caseNameField?.uuid as Uuid,
				targetKind: "text",
				patch: { id: "case_name" },
			},
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.findings.length).toBeGreaterThan(0);
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
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toEqual(["EMPTY_APP_NAME"]);
		}
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

	it("keeps field-id edits local when peer fields share an explicit case destination", () => {
		// Two PATIENT modules contain fields with the same canonical
		// `patient.age` destination. Changing F1's editable field id must not
		// rewrite F2.
		const doc = buildDoc({
			appName: "Peers",
			modules: [
				{
					name: "Patients A",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F1",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
								}),
							],
						},
					],
				},
				{
					name: "Patients B",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F2",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
								}),
								f({ kind: "int", id: "weight", label: proseText("Weight") }),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("N") },
						{ name: "age", label: proseText("Age") },
					],
				},
			],
		});
		const age = Object.values(doc.fields).find((x) => x.id === "age");
		const verdict = gateCommit(doc, [
			{
				kind: "updateField",
				uuid: age?.uuid as Uuid,
				targetKind: "int",
				patch: { id: "weight" },
			},
		]);
		expect(verdict).toEqual({ ok: true });
	});

	it("catches a search-input finding a new writer flips in a relation-walking module of another type", () => {
		// The Households module's search input `via`-walks to the PATIENT
		// type. Adding a date writer for `patient.age` types the property,
		// flipping the module's UNKNOWN_PROPERTY finding into a
		// MODE_PROPERTY_TYPE_MISMATCH (starts-with is text-only) — a NEW
		// identity in a module whose own caseType never matches the written
		// type. The derived scope must reach it.
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
		expect(prevCodes).toContain("CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY");
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
				} as Field,
			},
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain(
				"CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			);
		}
	});

	it("catches a writers-disagreement introduced by convertField on a case-bound field", () => {
		// `convertField` is the single live kind-change path (`updateField`
		// strips `kind` from patches). Two agreeing int writers of
		// patient.score live in different modules; converting one to
		// decimal introduces FIELD_KIND_WRITERS_DISAGREE on BOTH writers,
		// and the derived scope must be full so the verdict carries every
		// copy — a scope filter applied before the diff, or a location
		// keying that collapses the two writers' findings into one, fails
		// here.
		const doc = buildDoc({
			appName: "Writers",
			modules: [
				{
					name: "Mod A",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F1",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "score",
									label: proseText("Score"),
									caseWrite: { caseType: "patient", property: "score" },
								}),
							],
						},
					],
				},
				{
					name: "Mod B",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F2",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "score",
									label: proseText("Score"),
									caseWrite: { caseType: "patient", property: "score" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("N") }],
				},
			],
		});
		const firstScore = Object.values(doc.fields).find((x) => x.id === "score");
		const mutations: Mutation[] = [
			{
				kind: "convertField",
				uuid: firstScore?.uuid as Uuid,
				toKind: "decimal",
			},
		];
		const verdict = gateCommit(doc, mutations);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			const disagreements = verdict.findings.filter(
				(e) => e.code === "FIELD_KIND_WRITERS_DISAGREE",
			);
			// One finding per writer — both sides of the conflict surface.
			expect(disagreements).toHaveLength(2);
		}
	});
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
		expect(codes).toContain("EMPTY_FORM");
		expect(codes).toContain("MEDIA_ASSET_NOT_FOUND");
	});

	it("returns nothing for a valid doc", () => {
		expect(
			evaluateBoundary(minDoc(), new Map(), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
	});
});
