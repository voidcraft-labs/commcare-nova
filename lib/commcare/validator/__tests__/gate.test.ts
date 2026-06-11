import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc, type Field, type Uuid } from "@/lib/domain";
import { asAssetId } from "@/lib/domain/multimedia";
import { buildDoc, caseListConfig, f, xp } from "../../../__tests__/docHelpers";
import { MEDIA_VALIDATION_CODES, type ValidationError } from "../errors";
import {
	classifyError,
	diffIntroduced,
	errorIdentity,
	evaluateBoundary,
	evaluateCommit,
	replaceLoneSurrogates,
	VALIDITY_CLASS_BY_CODE,
} from "../gate";
import { runValidation } from "../runner";
import { scopeOfMutations } from "../scopeOfMutations";

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
								label: "Name",
								case_property_on: "patient",
							}),
							// A second writer: `case_name` feeds the create block
							// (`case_name_field`), so REGISTRATION_NO_CASE_PROPS
							// needs at least one property-writing field besides it.
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
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
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
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
	return { uuid: asUuid(uuid), id: uuid, name, type: "survey" as const };
}

function textField(
	uuid: string,
	id: string,
	extra?: Record<string, unknown>,
): Field {
	return { uuid: asUuid(uuid), kind: "text", id, label: id, ...extra } as Field;
}

/** Run the full pipeline: derive scope, apply, gate. */
function gateCommit(prevDoc: BlueprintDoc, mutations: Mutation[]) {
	const scope = scopeOfMutations(prevDoc, mutations);
	const nextDoc = apply(prevDoc, mutations);
	return evaluateCommit({ prevDoc, nextDoc, scope });
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
				"NO_CASE_NAME_FIELD",
				"REGISTRATION_NO_CASE_PROPS",
				"CHILD_CASE_NO_NAME_FIELD",
				"MISSING_CHILD_CASE_MODULE",
				"CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE",
				"CONNECT_FORM_MISSING_BLOCK",
				"CONNECT_MISSING_LEARN",
				"CONNECT_MISSING_DELIVER",
			].sort(),
		);
	});

	it("pins the environment classification set (asset-context rules + the export-budget guard)", () => {
		const environment = Object.entries(VALIDITY_CLASS_BY_CODE)
			.filter(([, cls]) => cls === "environment")
			.map(([code]) => code)
			.sort();
		expect(environment).toEqual([
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
		expect(byClass.get("completeness")).toHaveLength(11);
		expect(byClass.get("environment")).toHaveLength(4);
		expect(byClass.get("oracle")).toHaveLength(95);
		expect(byClass.get("shape")).toHaveLength(6);
		expect(byClass.get("soundness")).toHaveLength(75);
		expect(Object.keys(VALIDITY_CLASS_BY_CODE)).toHaveLength(191);
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

// ── Identity ───────────────────────────────────────────────────────

describe("errorIdentity", () => {
	it("is deterministic across runs on the same doc", () => {
		const doc = docWithEmptyForm();
		const a = runValidation(doc).map(errorIdentity);
		const b = runValidation(doc).map(errorIdentity);
		expect(a.length).toBeGreaterThan(0);
		expect(a).toEqual(b);
	});

	it("ignores message wording — only structure enters the key", () => {
		const base: ValidationError = {
			code: "EMPTY_FORM",
			scope: "form",
			message: "original wording",
			location: { moduleUuid: asUuid("m-1"), formUuid: asUuid("f-1") },
		};
		const reworded = { ...base, message: "completely different prose" };
		expect(errorIdentity(base)).toBe(errorIdentity(reworded));
		expect(errorIdentity(base)).not.toContain("wording");
	});

	it("is unchanged by an unrelated edit elsewhere in the doc", () => {
		const doc = docWithEmptyForm();
		const before = runValidation(doc).map(errorIdentity).sort();
		// Unrelated edit: rename the registration form's field — a different
		// form from the one carrying the EMPTY_FORM finding. The rename keeps
		// the same id, so nothing about the doc's findings changes.
		const fieldUuid = Object.values(doc.fields)[0].uuid;
		const edited = apply(doc, [
			{ kind: "renameField", uuid: fieldUuid, newId: "case_name" },
		]);
		const after = runValidation(edited).map(errorIdentity).sort();
		expect(after).toEqual(before);
	});

	it("keys duplicate-module-name findings by the duplicated name, stable under reorder", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Same",
					forms: [
						{
							name: "A",
							type: "survey",
							fields: [f({ kind: "text", id: "q1" })],
						},
					],
				},
				{
					name: "Same",
					forms: [
						{
							name: "B",
							type: "survey",
							fields: [f({ kind: "text", id: "q2" })],
						},
					],
				},
			],
		});
		const before = runValidation(doc)
			.filter((e) => e.code === "DUPLICATE_MODULE_NAME")
			.map(errorIdentity);
		expect(before).toHaveLength(1);
		const reordered = apply(doc, [
			{ kind: "moveModule", uuid: doc.moduleOrder[1], toIndex: 0 },
		]);
		const after = runValidation(reordered)
			.filter((e) => e.code === "DUPLICATE_MODULE_NAME")
			.map(errorIdentity);
		expect(after).toEqual(before);
	});

	it("excludes positional indices: id-mapping findings collapse per column", () => {
		const err = (entryIndex: string): ValidationError => ({
			code: "CASE_LIST_ID_MAPPING_EMPTY_VALUE",
			scope: "module",
			message: `row ${entryIndex}`,
			location: { moduleUuid: asUuid("m-1") },
			details: { columnIndex: "0", entryIndex, columnUuid: "col-1" },
		});
		// Two empty rows in ONE column share an identity — fixing the first
		// must not make the second (its index now shifted) look introduced.
		expect(errorIdentity(err("1"))).toBe(errorIdentity(err("4")));
	});

	it("is total over lone UTF-16 surrogates in authored discriminators", () => {
		// JSON legally transports unpaired surrogates ('"Visits \ud83d"'
		// parses fine), so a truncated-emoji module name reaches the gate
		// through SA tool calls and replayed events. The identity encoder
		// must render a key, never throw — a throwing encoder would crash
		// `diffIntroduced` / `evaluateCommit` instead of producing a verdict.
		const err: ValidationError = {
			code: "DUPLICATE_MODULE_NAME",
			scope: "app",
			message: "duplicate",
			location: {
				moduleUuid: asUuid("m-1"),
				moduleName: "Visits \ud83d",
			},
		};
		expect(() => errorIdentity(err)).not.toThrow();
		expect(errorIdentity(err)).toBe(errorIdentity({ ...err }));
		expect(diffIntroduced([], [err])).toEqual([err]);
		// Well-formed strings keep their exact pre-existing identity shape.
		const wellFormed: ValidationError = {
			...err,
			location: { moduleUuid: asUuid("m-1"), moduleName: "Visites cliniques" },
		};
		expect(errorIdentity(wellFormed)).toBe(
			`DUPLICATE_MODULE_NAME|name=${encodeURIComponent("Visites cliniques")}`,
		);
	});

	it("replaceLoneSurrogates is byte-identical to String.prototype.toWellFormed", () => {
		// The sanitizer is hand-rolled because `toWellFormed` is ES2024 and
		// unpolyfilled here (Firefox ≤118 / Safari ≤16.3 lack it — and the
		// gate runs client-side once wired into the builder commit path).
		// Identity must be deterministic across environments, so the regex
		// pass must agree with the native method wherever the native one
		// exists — this corpus pins that equivalence.
		const samples = [
			"",
			"plain ascii",
			"emoji 👍🏽 and text",
			"\ud83d", // lone high
			"\udc00", // lone low
			"trailing high \ud83d",
			"\udc00 leading low",
			"a\ud800b", // lone high mid-string
			"😀", // well-formed pair
			"\ud800𐀀\udc00", // lone-high, pair, lone-low
			"\udfff\ud800", // low-then-high (reversed — both lone)
			"� already a replacement char",
			"mixé Unicode ñ 中文 👍",
		];
		for (const sample of samples) {
			expect(replaceLoneSurrogates(sample)).toBe(sample.toWellFormed());
		}
	});
});

// ── diffIntroduced ─────────────────────────────────────────────────

describe("diffIntroduced", () => {
	it("fixing one of two same-code findings introduces nothing", () => {
		const base = docWithEmptyForm("form-e1");
		const twoEmpty = apply(base, [
			{
				kind: "addForm",
				moduleUuid: base.moduleOrder[0],
				form: surveyForm("form-e2", "E2"),
			},
		]);
		const fixedOne = apply(twoEmpty, [
			{
				kind: "addField",
				parentUuid: asUuid("form-e1"),
				field: textField("fld-fill", "q1"),
			},
		]);
		expect(
			diffIntroduced(runValidation(twoEmpty), runValidation(fixedOne)),
		).toEqual([]);
	});

	it("a second instance of an existing code at a NEW location IS introduced", () => {
		const oneEmpty = docWithEmptyForm("form-e1");
		const twoEmpty = apply(oneEmpty, [
			{
				kind: "addForm",
				moduleUuid: oneEmpty.moduleOrder[0],
				form: surveyForm("form-e2", "E2"),
			},
		]);
		const introduced = diffIntroduced(
			runValidation(oneEmpty),
			runValidation(twoEmpty),
		).filter((e) => e.code === "EMPTY_FORM");
		expect(introduced).toHaveLength(1);
		expect(introduced[0].location.formUuid).toBe(asUuid("form-e2"));
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
			expect(verdict.introduced.map((e) => e.code)).toContain("EMPTY_FORM");
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
			expect(verdict.introduced.map((e) => e.code)).toContain("INVALID_REF");
		}
	});

	it("pre-existing errors never block an unrelated edit", () => {
		// Legacy-safe: the doc already carries an empty form AND a bad ref.
		const base = docWithEmptyForm("form-e1");
		const broken = apply(base, [
			{
				kind: "addField",
				parentUuid: asUuid("form-e1"),
				field: textField("fld-bad", "q1", { relevant: "#form/missing = '1'" }),
			},
		]);
		expect(runValidation(broken).length).toBeGreaterThan(0);
		const caseNameField = Object.values(broken.fields).find(
			(x) => x.id === "case_name",
		);
		const verdict = gateCommit(broken, [
			{
				kind: "renameField",
				uuid: caseNameField?.uuid as Uuid,
				newId: "case_name",
			},
		]);
		expect(verdict).toEqual({ ok: true });
	});

	it("fixing an error passes", () => {
		const broken = docWithEmptyForm("form-e1");
		const fix: Mutation[] = [
			{
				kind: "addField",
				parentUuid: asUuid("form-e1"),
				field: textField("fld-fill", "q1"),
			},
		];
		expect(gateCommit(broken, fix)).toEqual({ ok: true });
	});

	it("setAppName's empty derived scope still catches EMPTY_APP_NAME (app rules always run)", () => {
		// `setAppName` derives the app-rules-only empty scope (nothing
		// module/form-shaped reads the name); the gate must still reject an
		// empty-name introduction through it, because app rules run on
		// every scoped pass.
		const doc = minDoc();
		const mutations: Mutation[] = [{ kind: "setAppName", name: "" }];
		const scope = scopeOfMutations(doc, mutations);
		expect(scope).not.toBe("full");
		const verdict = gateCommit(doc, mutations);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toEqual(["EMPTY_APP_NAME"]);
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
				media: { image: asAssetId("asset-missing") },
			},
		]);
		expect(verdict).toEqual({ ok: true });
	});

	it("catches a DUPLICATE_FIELD_ID the rename cascade introduces in a cross-module peer's form", () => {
		// Two HOUSEHOLD modules whose forms write the PATIENT type (the
		// child-case pattern). Renaming F1's `age` cascades to F2's peer by
		// (id, case_property_on) — colliding with F2's sibling `weight`.
		// The peer's form shares no caseType with the written type, so any
		// caseType-keyed widening misses it; the derived scope must degrade
		// to full so the introduced soundness error reaches the verdict.
		const doc = buildDoc({
			appName: "Peers",
			modules: [
				{
					name: "Households A",
					caseType: "household",
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
									label: "Age",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
				{
					name: "Households B",
					caseType: "household",
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
									label: "Age",
									case_property_on: "patient",
								}),
								f({ kind: "int", id: "weight", label: "Weight" }),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "household", properties: [{ name: "case_name", label: "N" }] },
				{ name: "patient", properties: [{ name: "age", label: "Age" }] },
			],
		});
		const age = Object.values(doc.fields).find((x) => x.id === "age");
		const verdict = gateCommit(doc, [
			{ kind: "renameField", uuid: age?.uuid as Uuid, newId: "weight" },
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
				"DUPLICATE_FIELD_ID",
			);
		}
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
									label: "Name",
									case_property_on: "patient",
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
								uuid: asUuid("sin-walk"),
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
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "household",
					parent_type: "patient",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
		const registerForm = doc.formOrder[doc.moduleOrder[0]][0];
		const prevCodes = runValidation(doc).map((e) => e.code);
		expect(prevCodes).toContain("CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY");
		const verdict = gateCommit(doc, [
			{
				kind: "addField",
				parentUuid: registerForm,
				field: {
					uuid: asUuid("fld-age-new"),
					kind: "date",
					id: "age",
					label: "Age",
					case_property_on: "patient",
				} as Field,
			},
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
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
									label: "Score",
									case_property_on: "patient",
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
									label: "Score",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "N" }] },
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
		expect(scopeOfMutations(doc, mutations)).toBe("full");
		const verdict = gateCommit(doc, mutations);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			const disagreements = verdict.introduced.filter(
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
				media: { image: asAssetId("asset-missing") },
			},
		]);
		const findings = evaluateBoundary(withMedia, new Map());
		const codes = findings.map((e) => e.code);
		expect(codes).toContain("EMPTY_FORM");
		expect(codes).toContain("MEDIA_ASSET_NOT_FOUND");
	});

	it("returns nothing for a valid doc", () => {
		expect(evaluateBoundary(minDoc(), new Map())).toEqual([]);
	});
});
