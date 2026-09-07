/**
 * The private HQ JSON consistency oracle uses deliberately partial shell
 * fixtures to isolate corruption diagnostics. Those fixtures do not claim app
 * admission or native HQ acceptance. Reachable projection examples separately
 * pass Blueprint schema and the full authoring validator before expansion.
 * Native HQ/Core producers own external compatibility; this oracle supplements
 * them with local enum, identity and media-reference diagnostics.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	applicationShell,
	detailColumn,
	detailPair,
	emptyFormActions,
	formShell,
	type HqApplication,
	type HqModule,
	moduleShell,
	type OpenSubCaseAction,
} from "@/lib/commcare";
import { expandDoc as projectUncheckedDoc } from "@/lib/commcare/expander";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { validateHqJson as checkHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	calculatedColumn,
	hiddenSearchInputDef,
	plainColumn,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	eq,
	input,
	isBlank,
	literal,
	matchesPattern,
	now,
	prop,
	sessionUser,
	term,
	toValueExpression,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { lookupRevisionSchema } from "@/lib/lookup/schema";

const nativeRecords: {
	test: string;
	app: HqApplication;
	codes: ValidationErrorCode[];
}[] = [];
function validateHqJson(app: HqApplication) {
	const findings = checkHqJson(app);
	if (process.env.NOVA_HQ_ORACLE_EVIDENCE_DIR)
		nativeRecords.push({
			test: expect.getState().currentTestName ?? "unnamed",
			app: structuredClone(app),
			codes: findings.map((finding) => finding.code),
		});
	return findings;
}
afterAll(() => {
	const destination = process.env.NOVA_HQ_ORACLE_EVIDENCE_DIR;
	if (!destination) return;
	mkdirSync(destination, { recursive: true });
	writeFileSync(
		resolve(destination, "hq-oracle-probes.json"),
		JSON.stringify(nativeRecords, null, 2),
	);
});

function expandDoc(
	doc: Parameters<typeof projectUncheckedDoc>[0],
	options?: Parameters<typeof projectUncheckedDoc>[1],
	lookup: LookupValidationContext = LOOKUP_CONTEXT_UNAVAILABLE,
) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, lookup)).toEqual([]);
	return projectUncheckedDoc(doc, options);
}

// ── Fixture builders ───────────────────────────────────────────────

/** Pull just the error codes for terse assertions. */
function codes(
	errors: ReturnType<typeof validateHqJson>,
): ValidationErrorCode[] {
	return errors.map((e) => e.code);
}

/** Partial wire-object fixture for the private consistency checker only. */
function baselineApp(): HqApplication {
	const actions = emptyFormActions();
	// Activate the open-case condition so the condition check has a non-`never`
	// value to validate, and add a subcase so the relationship + subcase-condition
	// + subcase-update_mode checks run on a real entry.
	actions.open_case.condition = {
		type: "always",
		question: null,
		answer: null,
		operator: null,
		doc_type: "FormActionCondition",
	};
	actions.update_case.condition = {
		type: "if",
		question: "/data/q",
		answer: "yes",
		operator: "=",
		doc_type: "FormActionCondition",
	};
	actions.update_case.update = {
		notes: { question_path: "/data/notes", update_mode: "always" },
	};
	const subcase: OpenSubCaseAction = {
		doc_type: "OpenSubCaseAction",
		case_type: "visit",
		name_update: { question_path: "/data/child_name", update_mode: "always" },
		reference_id: "",
		case_properties: {
			detail: { question_path: "/data/detail", update_mode: "edit" },
		},
		repeat_context: "",
		relationship: "child",
		close_condition: {
			type: "never",
			question: null,
			answer: null,
			operator: null,
			doc_type: "FormActionCondition",
		},
		condition: {
			type: "always",
			question: null,
			answer: null,
			operator: null,
			doc_type: "FormActionCondition",
		},
	};
	actions.subcases = [subcase];

	const form = formShell(
		"form-unique-id",
		"Registration",
		"http://openrosa.org/formdesigner/abc",
		"none",
		actions,
		{},
		"default",
		null,
		[],
	);

	const detail = detailPair(
		[detailColumn("name", "Name")],
		[detailColumn("name", "Name")],
	);
	const module = moduleShell(
		"module-unique-id",
		"Patients",
		"patient",
		[form],
		detail,
	);

	return applicationShell("Clinic", [module], {});
}

/** The single module of a baseline app (every negative reaches into it). */
function moduleOf(app: HqApplication): HqModule {
	return app.modules[0];
}

// ── Clean baseline ─────────────────────────────────────────────────

describe("HQ-JSON oracle — clean baseline", () => {
	it("accepts resolved root-module and parent-select identities", () => {
		const app = baselineApp();
		const root = app.modules[0];
		const child = moduleShell(
			"child-module",
			{ en: "Child" },
			"visit",
			[],
			detailPair([]),
		);
		child.root_module_id = root.unique_id;
		child.parent_select = {
			active: true,
			relationship: "parent",
			module_id: root.unique_id,
		};
		app.modules.push(child);
		expect(validateHqJson(app)).toEqual([]);
	});

	it("flags unresolved root-module and parent-select identities", () => {
		const app = baselineApp();
		const module = moduleOf(app);
		module.root_module_id = "missing-root";
		module.parent_select = {
			active: true,
			relationship: "parent",
			module_id: "missing-parent",
		};
		expect(codes(validateHqJson(app))).toEqual(
			expect.arrayContaining([
				"HQJSON_BAD_ROOT_MODULE_ID",
				"HQJSON_BAD_PARENT_SELECT_MODULE_ID",
			]),
		);
	});

	it("accepts independently ordered short and long column arrays with list-indexed calculated sort", () => {
		const name = plainColumn(
			testUuid("00000000-0000-4000-8000-000000000091"),
			"case_name",
			"Name",
		);
		const age = calculatedColumn(
			testUuid("00000000-0000-4000-8000-000000000092"),
			"Age",
			toValueExpression(prop("patient", "age")),
			{
				sort: { direction: "asc", priority: 0 },
			},
		);
		const app = expandDoc(
			buildDoc({
				appName: "Independent details",
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListOnly: true,
						caseListConfig: {
							columns: [name, age],
							// Results shows Name then Age; Details shows them the other
							// way round. Two sequences, one set of columns.
							listColumnOrder: [name.uuid, age.uuid],
							detailColumnOrder: [age.uuid, name.uuid],
							searchInputs: [],
						},
					},
				],
				caseTypes: [
					{
						name: "patient",
						properties: [
							{
								name: "case_name",
								label: proseText("Name"),
								data_type: "text",
							},
							{ name: "age", label: proseText("Age"), data_type: "int" },
						],
					},
				],
			}),
		);

		const details = app.modules[0].case_details;
		expect(details.short.columns.map((column) => column.header.en)).toEqual([
			"Name",
			"Age",
		]);
		expect(details.long.columns.map((column) => column.header.en)).toEqual([
			"Age",
			"Name",
		]);
		// The calculated column is index 1 in the short array even though it is
		// index 0 in long; CCHQ resolves this synthetic key against short only.
		expect(details.short.sort_elements[0]?.field).toBe("_cc_calculated_1");
		expect(validateHqJson(app)).toEqual([]);
	});

	it("keeps a Results sort carrier invisible and omits it from Details", () => {
		const name = plainColumn(
			testUuid("00000000-0000-4000-8000-000000000093"),
			"case_name",
			"Name",
		);
		const sortOnly = plainColumn(
			testUuid("00000000-0000-4000-8000-000000000094"),
			"external_id",
			"External ID",
			{
				visibleInList: false,
				visibleInDetail: false,
				sort: { direction: "asc", priority: 0 },
			},
		);
		const app = expandDoc(
			buildDoc({
				appName: "Sort-only field",
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListOnly: true,
						caseListConfig: {
							columns: [name, sortOnly],
							searchInputs: [],
						},
					},
				],
				caseTypes: [
					{
						name: "patient",
						properties: [
							{
								name: "case_name",
								label: proseText("Name"),
								data_type: "text",
							},
							{
								name: "external_id",
								label: proseText("External ID"),
								data_type: "text",
							},
						],
					},
				],
			}),
		);

		const details = app.modules[0].case_details;
		expect(details.short.columns.map((column) => column.field)).toEqual([
			"case_name",
			"external_id",
		]);
		expect(details.short.columns[1].format).toBe("invisible");
		expect(details.long.columns.map((column) => column.field)).toEqual([
			"case_name",
		]);
		expect(details.short.sort_elements[0]?.field).toBe("external_id");
		expect(validateHqJson(app)).toEqual([]);
	});

	it("joins attribute-backed sorts to their visible HQ column and drops useless hidden definitions", () => {
		const status = plainColumn(
			testUuid("00000000-0000-4000-8000-000000000095"),
			"status",
			"Case status",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const hidden = plainColumn(
			testUuid("00000000-0000-4000-8000-000000000096"),
			"external_id",
			"External ID",
			{ visibleInList: false, visibleInDetail: false },
		);
		const app = expandDoc(
			buildDoc({
				appName: "Canonical HQ fields",
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListOnly: true,
						caseListConfig: {
							columns: [status, hidden],
							searchInputs: [],
						},
					},
				],
				caseTypes: [{ name: "patient", properties: [] }],
			}),
		);
		const short = app.modules[0].case_details.short;

		expect(short.columns.map((column) => column.field)).toEqual(["status"]);
		expect(short.sort_elements.map((element) => element.field)).toEqual([
			"status",
		]);
		expect(validateHqJson(app)).toEqual([]);
	});

	it("the partial shell fixture passes this private checker", () => {
		expect(validateHqJson(baselineApp())).toEqual([]);
	});

	it("a real expandDoc of a minimal valid doc passes clean", () => {
		// A registration form that opens a `patient` case (active open-case
		// action) plus a child `visit` case (subcase) — exercises the condition,
		// update_mode, and subcase-relationship slots through genuine emitter
		// output, not a hand-built shell.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "notes", label: proseText("Notes"), data_type: "text" },
					],
					parent_type: undefined,
				},
				{
					name: "visit",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
					parent_type: "patient",
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(
								testUuid("oracle-patient-column"),
								"case_name",
								"Name",
							),
						],
						searchInputs: [],
					},
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								{
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								},
								{
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
									caseWrite: { caseType: "patient", property: "notes" },
								},
							],
						},
					],
				},
				{
					name: "Visits",
					caseType: "visit",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("oracle-visit-column"), "case_name", "Name"),
						],
						searchInputs: [],
					},
					forms: [
						{
							name: "Visit",
							type: "registration",
							fields: [
								{
									kind: "text",
									id: "case_name",
									label: proseText("Visit name"),
									caseWrite: { caseType: "visit", property: "case_name" },
								},
							],
						},
					],
				},
			],
		});

		expect(validateHqJson(expandDoc(doc))).toEqual([]);
	});
});

// ── Application-level doc_type ──────────────────────────────────────

describe("HQ-JSON oracle — application doc_type", () => {
	it("flags an application doc_type that isn't 'Application'", () => {
		const app = baselineApp();
		// HQ recognizes RemoteApp, but Nova must emit its Application model.
		(app as { doc_type: string }).doc_type = "RemoteApp";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_DOC_TYPE"]);
	});
});

// ── Module / form doc_type dispatch ─────────────────────────────────

describe("HQ-JSON oracle — doc_type dispatch", () => {
	it("flags a module doc_type outside the ModuleBase.wrap dispatch set", () => {
		const app = baselineApp();
		(moduleOf(app) as { doc_type: string }).doc_type = "BogusModule";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_MODULE_DOC_TYPE"]);
	});

	it("flags an unknown form tag as a generator convention", () => {
		const app = baselineApp();
		(moduleOf(app).forms[0] as { doc_type: string }).doc_type = "BogusForm";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_FORM_DOC_TYPE"]);
	});
});

// ── Form choices: requires + post_form_workflow ─────────────────────

describe("HQ-JSON oracle — form choice slots", () => {
	it("flags a form requires value outside the choice list", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].requires = "always";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_FORM_REQUIRES"]);
	});

	it("flags a post_form_workflow value outside ALL_WORKFLOWS", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].post_form_workflow = "home";
		expect(codes(validateHqJson(app))).toEqual([
			"HQJSON_BAD_POST_FORM_WORKFLOW",
		]);
	});

	it("flags a form link whose form_id lives in a different module than its form_module_id", () => {
		// HQ resolves `form_id` INSIDE `form_module_id`
		// (`get_module_by_unique_id(...).get_form_by_unique_id`), so a pair
		// that each exist but disagree fails on the first build.
		const app = baselineApp();
		const second = structuredClone(moduleOf(app));
		second.unique_id = "second-module-id";
		second.forms[0].unique_id = "second-form-id";
		app.modules.push(second);
		const form = moduleOf(app).forms[0];
		form.post_form_workflow = "form";
		form.form_links = [
			{
				xpath: "",
				form_id: "second-form-id",
				form_module_id: "module-unique-id",
				datums: [],
			},
		];
		const mismatched = validateHqJson(app).filter(
			(error) => error.code === "HQJSON_BAD_FORM_LINK",
		);
		expect(mismatched).toHaveLength(1);
		expect(mismatched[0]?.message).toContain("belongs to a different module");

		form.form_links = [
			{
				xpath: "",
				form_id: "second-form-id",
				form_module_id: "second-module-id",
				datums: [],
			},
		];
		expect(codes(validateHqJson(app))).not.toContain("HQJSON_BAD_FORM_LINK");
	});
});

describe("HQ-JSON oracle — case_list_form", () => {
	it("flags a registration form id no module carries", () => {
		const app = baselineApp();
		moduleOf(app).case_list_form = {
			doc_type: "CaseListForm",
			form_id: "not-a-form-in-this-app",
			label: { en: "Register" },
			post_form_workflow: "case_list",
		};
		const findings = validateHqJson(app).filter(
			(error) => error.code === "HQJSON_BAD_CASE_LIST_FORM",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toContain("no module in this app carries");
	});

	it("flags a post_form_workflow outside CaseListForm's choices", () => {
		const app = baselineApp();
		moduleOf(app).case_list_form = {
			doc_type: "CaseListForm",
			form_id: moduleOf(app).forms[0].unique_id,
			label: { en: "Register" },
			post_form_workflow: "previous_screen" as "default",
		};
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_CASE_LIST_FORM"]);
	});

	it("accepts a resolvable form under case_list", () => {
		const app = baselineApp();
		moduleOf(app).case_list_form = {
			doc_type: "CaseListForm",
			form_id: moduleOf(app).forms[0].unique_id,
			label: { en: "Register" },
			post_form_workflow: "case_list",
			relevancy_expression:
				"count(instance('results:inline')/results/case) = 0",
		};
		expect(codes(validateHqJson(app))).not.toContain(
			"HQJSON_BAD_CASE_LIST_FORM",
		);
	});
});

// ── Condition choices: type + operator ──────────────────────────────

describe("HQ-JSON oracle — condition choice slots", () => {
	it("flags a condition type outside {if, always, never}", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.open_case.condition.type =
			"maybe" as "always";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_CONDITION_TYPE"]);
	});

	it("flags a non-null condition operator outside the choice list", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.update_case.condition.operator = "~=";
		expect(codes(validateHqJson(app))).toEqual([
			"HQJSON_BAD_CONDITION_OPERATOR",
		]);
	});

	it("does NOT flag a null operator (the always/never factory default)", () => {
		// The clean baseline's open/close conditions emit a null operator; the
		// oracle must treat null as the absent state jsonobject leaves at default.
		expect(codes(validateHqJson(baselineApp()))).not.toContain(
			"HQJSON_BAD_CONDITION_OPERATOR",
		);
	});
});

// ── update_mode choices (update map + subcase) ──────────────────────

describe("HQ-JSON oracle — update_mode choice slot", () => {
	it("flags an update_mode in the update-case map outside {always, edit}", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.update_case.update.notes.update_mode =
			"sometimes";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_UPDATE_MODE"]);
	});

	it("flags an update_mode on a subcase name_update outside the choice list", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.subcases[0].name_update.update_mode =
			"never";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_UPDATE_MODE"]);
	});
});

// ── subcase relationship choice ─────────────────────────────────────

describe("HQ-JSON oracle — subcase relationship choice slot", () => {
	it("flags a subcase relationship outside {child, extension}", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].actions.subcases[0].relationship = "sibling";
		expect(codes(validateHqJson(app))).toEqual([
			"HQJSON_BAD_SUBCASE_RELATIONSHIP",
		]);
	});
});

// ── detail display choice ───────────────────────────────────────────

describe("HQ-JSON oracle — detail display choice slot", () => {
	it("flags a case detail display outside {short, long}", () => {
		const app = baselineApp();
		moduleOf(app).case_details.short.display = "medium" as "short";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_DETAIL_DISPLAY"]);
	});
});

// ── finite-number column slots ──────────────────────────────────────

describe("HQ-JSON oracle — column finite-number slots", () => {
	it("flags a non-finite late_flag (NaN serializes to null at import)", () => {
		const app = baselineApp();
		moduleOf(app).case_details.short.columns[0].late_flag = Number.NaN;
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_TYPE"]);
	});

	it("flags a non-finite time_ago_interval (Infinity from a bad divisor)", () => {
		const app = baselineApp();
		moduleOf(app).case_details.long.columns[0].time_ago_interval =
			Number.POSITIVE_INFINITY;
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_TYPE"]);
	});
});

// ── Multimedia map shape regression ─────────────────────────────────

describe("HQ-JSON oracle — multimedia_map shape", () => {
	it("flags a multimedia_map key missing the jr://file/ prefix", () => {
		const app = baselineApp();
		// A bare path with no `jr://file/` prefix — CCHQ's media_resources
		// raises MediaResourceError on the next suite regeneration. This is
		// exactly the shape an earlier Segment-3 emit bug produced before
		// CR-4 caught it.
		app.multimedia_map["commcare/aaa.png"] = {
			multimedia_id: "aaa",
			media_type: "CommCareImage",
			version: 1,
		};
		expect(codes(validateHqJson(app))).toEqual([
			"HQJSON_BAD_MULTIMEDIA_MAP_KEY",
		]);
	});

	it("flags an unknown multimedia_map media_type", () => {
		const app = baselineApp();
		app.multimedia_map["jr://file/commcare/aaa.png"] = {
			multimedia_id: "aaa",
			media_type: "CommCareTypo",
			version: 1,
		};
		expect(codes(validateHqJson(app))).toEqual([
			"HQJSON_BAD_MULTIMEDIA_MAP_MEDIA_TYPE",
		]);
	});

	it("accepts every live CommCare media class name", () => {
		const app = baselineApp();
		app.multimedia_map["jr://file/commcare/img.png"] = {
			multimedia_id: "1",
			media_type: "CommCareImage",
			version: 1,
		};
		app.multimedia_map["jr://file/commcare/aud.mp3"] = {
			multimedia_id: "2",
			media_type: "CommCareAudio",
			version: 1,
		};
		app.multimedia_map["jr://file/commcare/vid.mp4"] = {
			multimedia_id: "3",
			media_type: "CommCareVideo",
			version: 1,
		};
		expect(validateHqJson(app)).toEqual([]);
	});
});

// ── Nav media dict shape ───────────────────────────────────────────

describe("HQ-JSON oracle — nav media dict shape", () => {
	it("flags a module media_image value missing the jr://file/ prefix", () => {
		const app = baselineApp();
		moduleOf(app).media_image = { en: "commcare/no-prefix.png" };
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_NAV_MEDIA_VALUE"]);
	});

	it("flags a module media_audio value missing the prefix", () => {
		const app = baselineApp();
		moduleOf(app).media_audio = { en: "/audio/no-prefix.mp3" };
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_NAV_MEDIA_VALUE"]);
	});

	it("flags a form media_image value missing the prefix", () => {
		const app = baselineApp();
		moduleOf(app).forms[0].media_image = { en: "no-prefix" };
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_NAV_MEDIA_VALUE"]);
	});

	it("flags a case-list media_image value missing the prefix", () => {
		const app = baselineApp();
		moduleOf(app).case_list.media_image = { en: "no-prefix" };
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_NAV_MEDIA_VALUE"]);
	});

	it("accepts well-formed jr://file/ media values across all carriers", () => {
		const app = baselineApp();
		moduleOf(app).media_image = { en: "jr://file/commcare/m-icon.png" };
		moduleOf(app).media_audio = { en: "jr://file/commcare/m-audio.mp3" };
		moduleOf(app).forms[0].media_image = {
			en: "jr://file/commcare/f-icon.png",
		};
		moduleOf(app).case_list.media_image = {
			en: "jr://file/commcare/cl-icon.png",
		};
		expect(validateHqJson(app)).toEqual([]);
	});

	it("accepts an empty media dict (no carrier media)", () => {
		// The baseline app already emits `media_image: {}` / `media_audio: {}` —
		// the empty-dict shape every shell produces by default. The clean
		// baseline test (above) proves this passes, but pin it explicitly so a
		// future emitter change that drops the empty default is caught.
		const app = baselineApp();
		expect(moduleOf(app).media_image).toEqual({});
		expect(validateHqJson(app)).toEqual([]);
	});
});

// ── Logo refs shape ────────────────────────────────────────────────

describe("HQ-JSON oracle — logo_refs shape", () => {
	it("flags a logo_refs path missing the jr://file/ prefix", () => {
		const app = baselineApp();
		app.logo_refs = {
			hq_logo_web_apps: { path: "commcare/no-prefix.png" },
		};
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_LOGO_REF"]);
	});

	it("accepts a well-formed jr://file/ logo path", () => {
		const app = baselineApp();
		app.logo_refs = {
			hq_logo_web_apps: { path: "jr://file/commcare/logo.png" },
		};
		expect(validateHqJson(app)).toEqual([]);
	});

	it("accepts an absent logo_refs (no logo configured)", () => {
		/* No logo means the field is left off the wire entirely — an emitted
		 * empty dict would remove an HQ-uploaded logo on the in-place
		 * update's overlay merge — and the oracle has nothing to check. */
		const app = baselineApp();
		expect(app.logo_refs).toBeUndefined();
		expect(validateHqJson(app)).toEqual([]);
	});
});

// ── Search prompt children ─────────────────────────────────────────
//
// `CaseSearchProperty` (`commcare-hq/corehq/apps/app_manager/models/case_search.py`)
// stores each prompt child beside the prompt: `hint` as a language map,
// `hidden` / `exclude` as booleans, `default_value` and `input_` as strings,
// `itemset` as `{instance_id, nodeset, label, value}`, and `required` plus
// `validations[]` as `Assertion {test, text}` (`models/base.py::Assertion`).
// These tests run a real `expandDoc` over each authored shape and pin the
// projected slots, then prove the oracle accepts the result.

describe("HQ-JSON oracle — search prompt children", () => {
	const SI_NAME = testUuid("44444444-4444-4444-4444-cccccccc0001");
	const SI_EMAIL = testUuid("44444444-4444-4444-4444-cccccccc0002");
	const SI_TIME = testUuid("44444444-4444-4444-4444-cccccccc0003");
	const SI_REGION = testUuid("44444444-4444-4444-4444-cccccccc0004");
	const REGIONS = lookupTableIdSchema.parse(
		"018f3e8a-7b2c-7def-8abc-0000000000a1",
	);
	const REGIONS_VALUE = lookupColumnIdSchema.parse(
		"018f3e8a-7b2c-7def-8abc-0000000000b1",
	);
	const REGIONS_LABEL = lookupColumnIdSchema.parse(
		"018f3e8a-7b2c-7def-8abc-0000000000b2",
	);
	const REGIONS_DEFINITIONS = [
		{
			id: REGIONS,
			name: "Regions",
			tag: "regions",
			definitionRevision: lookupRevisionSchema.parse("1"),
			columns: [
				{
					id: REGIONS_VALUE,
					wireName: "value",
					label: "Value",
					dataType: "text",
				},
				{
					id: REGIONS_LABEL,
					wireName: "label",
					label: "Label",
					dataType: "text",
				},
			],
		},
	] satisfies import("@/lib/lookup/types").LookupTableDefinition[];
	const REGIONS_NAMING = lookupWireNaming(REGIONS_DEFINITIONS);
	const REGIONS_CONTEXT: LookupValidationContext = {
		kind: "available",
		projectId: "oracle-project",
		projectRevision: lookupRevisionSchema.parse("1"),
		definitions: REGIONS_DEFINITIONS,
	};

	function promptDoc(searchInputs: SearchInputDef[]) {
		return buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "email", label: proseText("Email"), data_type: "text" },
						{ name: "region", label: proseText("Region"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(
								testUuid("44444444-4444-4444-4444-dddddddd0001"),
								"case_name",
								"Name",
							),
						],
						searchInputs,
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								{
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								},
							],
						},
					],
				},
			],
		});
	}

	function propertiesOf(app: HqApplication) {
		return app.modules[0].search_config.properties;
	}

	it("projects hint, required, and one validation as language-mapped Assertions", () => {
		const doc = promptDoc([
			simpleSearchInputDef(SI_NAME, "case_name", "Name", "text", "case_name", {
				hint: "First and last name",
				required: {},
			}),
			simpleSearchInputDef(SI_EMAIL, "email", "Email", "text", "email", {
				required: {
					when: isBlank(input(SI_NAME)),
					message: "Give an email when the name is blank.",
				},
				validation: {
					rule: matchesPattern(input(SI_EMAIL), "@"),
					message: "Enter an email address.",
				},
			}),
		]);
		const app = expandDoc(doc);
		const [name, email] = propertiesOf(app);

		expect(name).toMatchObject({
			name: "case_name",
			hint: { en: "First and last name" },
			required: {
				test: "true()",
				text: { en: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE },
			},
		});
		expect(name?.validations).toBeUndefined();
		expect(name?.hidden).toBeUndefined();
		expect(email).toMatchObject({
			name: "email",
			required: {
				test: "instance('search-input:results')/input/field[@name='case_name'] = ''",
				text: { en: "Give an email when the name is blank." },
			},
			validations: [
				{
					test: "regex(instance('search-input:results')/input/field[@name='email'], '@')",
					text: { en: "Enter an email address." },
				},
			],
		});
		expect(email?.hint).toBeUndefined();
		expect(validateHqJson(app)).toEqual([]);
	});

	it("projects a hidden input as hidden + default_value + exclude with no children", () => {
		const doc = promptDoc([
			simpleSearchInputDef(SI_NAME, "case_name", "Name", "text", "case_name"),
			hiddenSearchInputDef(SI_TIME, "search_time", "Search time", now()),
		]);
		const app = expandDoc(doc);
		const hidden = propertiesOf(app).find((p) => p.name === "search_time");

		expect(hidden).toEqual({
			name: "search_time",
			label: { en: "Search time" },
			default_value: "now()",
			hidden: true,
			exclude: true,
		});
		expect(validateHqJson(app)).toEqual([]);
	});

	it("projects a visible seed to default_value and a session-gated requirement", () => {
		const doc = promptDoc([
			simpleSearchInputDef(SI_NAME, "case_name", "Name", "text", "case_name", {
				default: term(literal("foo")),
				required: { when: eq(sessionUser("is_supervisor"), literal("n")) },
			}),
		]);
		const app = expandDoc(doc);
		const [name] = propertiesOf(app);

		expect(name?.default_value).toBe("'foo'");
		expect(name?.hidden).toBeUndefined();
		expect(name?.required?.test).toBe(
			"instance('commcaresession')/session/user/data/is_supervisor = 'n'",
		);
		expect(validateHqJson(app)).toEqual([]);
	});

	it("projects lookup-backed select and multi-select prompts as input_ + itemset", () => {
		const options = {
			kind: "lookup" as const,
			tableId: REGIONS,
			valueColumnId: REGIONS_VALUE,
			labelColumnId: REGIONS_LABEL,
		};
		// A multiple-choice prompt must be named after its property (its
		// any-of match rides CCHQ's auto-match, never `_xpath_query`), so the
		// two widgets live in two docs rather than colliding on one key.
		const singleApp = expandDoc(
			promptDoc([
				simpleSearchInputDef(
					SI_REGION,
					"region",
					"Region",
					"select",
					"region",
					{
						options,
					},
				),
			]),
			{ lookupNaming: REGIONS_NAMING },
			REGIONS_CONTEXT,
		);
		const multiApp = expandDoc(
			promptDoc([
				simpleSearchInputDef(
					SI_REGION,
					"region",
					"Regions",
					"multi-select",
					"region",
					{ options },
				),
			]),
			{ lookupNaming: REGIONS_NAMING },
			REGIONS_CONTEXT,
		);
		const [single] = propertiesOf(singleApp);
		const [multi] = propertiesOf(multiApp);

		expect(single).toMatchObject({
			name: "region",
			input_: "select1",
			itemset: {
				instance_id: "item-list:regions",
				nodeset: "instance('item-list:regions')/regions_list/regions",
				label: "label",
				value: "value",
			},
		});
		expect(single?.exclude).toBeUndefined();
		expect(multi).toMatchObject({
			name: "region",
			input_: "select",
			itemset: {
				instance_id: "item-list:regions",
				nodeset: "instance('item-list:regions')/regions_list/regions",
			},
		});
		expect(multi?.exclude).toBeUndefined();
		expect(validateHqJson(singleApp)).toEqual([]);
		expect(validateHqJson(multiApp)).toEqual([]);
	});
});
