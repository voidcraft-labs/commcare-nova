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
	type SortElement,
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
	eq,
	input,
	isBlank,
	literal,
	matchesPattern,
	now,
	prop,
	sessionUser,
	term,
} from "@/lib/domain/expression";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { lookupRevisionSchema } from "@/lib/lookup/schema";
import {
	type HqApplicationTree,
	serializeHqApplication,
} from "../hqJson/xpath";

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
function baselineTree(): HqApplicationTree {
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
		["en"],
	);

	return applicationShell("Clinic", [module], {});
}

/** Malformed-wire tests edit only the serialized consumer object. */
function baselineApp(): HqApplication {
	return serializeHqApplication(baselineTree());
}

/** The single module of a baseline app (every negative reaches into it). */
function moduleOf(app: HqApplication): HqModule {
	return app.modules[0];
}

// ── Clean baseline ─────────────────────────────────────────────────

describe("HQ-JSON oracle — clean baseline", () => {
	it("accepts resolved root-module and parent-select identities", () => {
		const app = baselineTree();
		const root = app.modules[0];
		const child = moduleShell(
			"child-module",
			{ en: "Child" },
			"visit",
			[],
			detailPair([detailColumn("name", "Name")]),
			["en"],
		);
		child.root_module_id = root.unique_id;
		child.parent_select = {
			active: true,
			relationship: "parent",
			module_id: root.unique_id,
		};
		app.modules.push(child);
		expect(validateHqJson(serializeHqApplication(app))).toEqual([]);
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
			term(prop("patient", "age")),
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

	it("writes attribute-backed columns as expressions, joins their sorts by position and stores fully hidden definitions", () => {
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

		expect(
			short.columns.map((column) => [
				column.field,
				column.format,
				column.useXpathExpression,
			]),
		).toEqual([
			["@status", "plain", true],
			["external_id", "invisible", false],
		]);
		expect(short.sort_elements.map((element) => element.field)).toEqual([
			"_cc_calculated_0",
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

// ── external id spelling ────────────────────────────────────────────

describe("HQ-JSON oracle — external id spelling", () => {
	it("flags an external id written on open_case.external_id", () => {
		const app = baselineApp();
		const actions = moduleOf(app).forms[0].actions;
		actions.open_case.external_id = "/data/nova_trimmed_external";
		expect(codes(validateHqJson(app))).toEqual([
			"HQJSON_OPEN_CASE_EXTERNAL_ID",
		]);
	});

	it("accepts the same external id as an update_case.update row", () => {
		const app = baselineApp();
		const actions = moduleOf(app).forms[0].actions;
		actions.open_case.external_id = null;
		actions.update_case.update.external_id = {
			question_path: "/data/nova_trimmed_external",
			update_mode: "always",
		};
		expect(codes(validateHqJson(app))).toEqual([]);
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

// ── sort element spelling and property-name fields ──────────────────

describe("HQ-JSON oracle — sort elements and property-name fields", () => {
	/** A baseline app whose short detail carries one sort element in the
	 *  Case List page's own spelling, with `edit` applied over it. */
	function sortedApp(edit: (element: SortElement) => void): HqApplication {
		const app = baselineApp();
		const element: SortElement = {
			field: "name",
			type: "plain",
			direction: "ascending",
			blanks: "first",
			display: { en: "" },
			sort_calculation: "",
		};
		edit(element);
		moduleOf(app).case_details.short.sort_elements = [element];
		return app;
	}

	it("accepts a sort element in the Case List page's spelling", () => {
		expect(validateHqJson(sortedApp(() => {}))).toEqual([]);
	});

	it('flags a sort element whose type is "string"', () => {
		const app = sortedApp((element) => {
			element.type = "string";
		});
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_SORT_ELEMENT"]);
	});

	it("flags a sort element with empty blanks", () => {
		const app = sortedApp((element) => {
			element.blanks = "";
		});
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_SORT_ELEMENT"]);
	});

	it("flags a sort element that holds a sort_calculation", () => {
		const app = sortedApp((element) => {
			element.field = "_cc_calculated_0";
			element.sort_calculation = "name";
		});
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_SORT_ELEMENT"]);
	});

	it("flags a sort element whose field holds @", () => {
		const app = sortedApp((element) => {
			element.field = "@status";
		});
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_DETAIL_FIELD"]);
	});

	it("flags a property column whose field holds @", () => {
		const app = baselineApp();
		moduleOf(app).case_details.short.columns[0].field = "@status";
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_DETAIL_FIELD"]);
	});
});

// ── search configuration labels ─────────────────────────────────────

describe("HQ-JSON oracle — search configuration labels", () => {
	it("accepts title_label and description that hold every app language", () => {
		const app = baselineApp();
		app.langs = ["en", "es"];
		moduleOf(app).search_config.title_label = { en: "Find", es: "" };
		moduleOf(app).search_config.description = { en: "", es: "" };
		expect(validateHqJson(app)).toEqual([]);
	});

	it("flags a description that lacks an app language", () => {
		const app = baselineApp();
		app.langs = ["en", "es"];
		moduleOf(app).search_config.title_label = { en: "", es: "" };
		moduleOf(app).search_config.description = { en: "" };
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_SEARCH_LABEL"]);
	});

	it("flags a title_label that lacks an app language", () => {
		const app = baselineApp();
		moduleOf(app).search_config.title_label = {};
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_BAD_SEARCH_LABEL"]);
	});
});

describe("HQ-JSON oracle — the search button label", () => {
	it("accepts HQ's default keyed en alone", () => {
		const app = baselineApp();
		expect(moduleOf(app).search_config.search_button_label).toEqual({
			en: "Search All Cases",
		});
		expect(validateHqJson(app)).toEqual([]);
	});

	it("flags another label, and the default under another language", () => {
		const labels: Record<string, string>[] = [
			{ en: "Search" },
			{ en: "Search All Cases", es: "Search All Cases" },
		];
		for (const label of labels) {
			const app = baselineApp();
			moduleOf(app).search_config.search_button_label = label;
			expect(codes(validateHqJson(app))).toEqual([
				"HQJSON_BAD_SEARCH_BUTTON_LABEL",
			]);
		}
	});
});

// ── spellings HQ's editors write ────────────────────────────────────

describe("HQ-JSON oracle — the spellings HQ's editors write", () => {
	it("flags a calculated column written calculate, beside the plain one", () => {
		const plain = baselineApp();
		const column = {
			...moduleOf(plain).case_details.short.columns[0],
			field: "today()",
			header: { en: "Today" },
			useXpathExpression: true as const,
		};
		moduleOf(plain).case_details.short.columns = [column];
		expect(validateHqJson(plain)).toEqual([]);
		const calculate = baselineApp();
		moduleOf(calculate).case_details.short.columns = [
			{ ...column, format: "calculate" as never },
		];
		expect(codes(validateHqJson(calculate))).toEqual([
			"HQJSON_BAD_DETAIL_FORMAT",
		]);
	});

	it("flags an empty short detail, beside an empty long one", () => {
		const app = baselineApp();
		moduleOf(app).case_details.long.columns = [];
		expect(validateHqJson(app)).toEqual([]);
		moduleOf(app).case_details.short.columns = [];
		expect(codes(validateHqJson(app))).toEqual(["HQJSON_EMPTY_SHORT_DETAIL"]);
	});

	it("flags no_vellum on a form and custom_variables on a detail", () => {
		const app = baselineApp();
		Object.assign(moduleOf(app).forms[0], { no_vellum: false });
		Object.assign(moduleOf(app).case_details.short, { custom_variables: null });
		expect(codes(validateHqJson(app))).toEqual([
			"HQJSON_UNWRITTEN_KEY",
			"HQJSON_UNWRITTEN_KEY",
		]);
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
				test: "string-length(string(instance('search-input:results')/input/field[@name = 'case_name'])) = 0",
				text: { en: "Give an email when the name is blank." },
			},
			validations: [
				{
					test: "regex(instance('search-input:results')/input/field[@name = 'email'], '@')",
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
				sort: "label",
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

		// A chosen sort column is written in place of the label column.
		const sortedApp = expandDoc(
			promptDoc([
				simpleSearchInputDef(
					SI_REGION,
					"region",
					"Region",
					"select",
					"region",
					{
						options: { ...options, sortColumnId: REGIONS_VALUE },
					},
				),
			]),
			{ lookupNaming: REGIONS_NAMING },
			REGIONS_CONTEXT,
		);
		expect(propertiesOf(sortedApp)[0]?.itemset?.sort).toBe("value");
		expect(validateHqJson(sortedApp)).toEqual([]);

		// HQ's Case List save refuses an itemset without its sort.
		const sortless = structuredClone(singleApp);
		const [prompt] = propertiesOf(sortless);
		if (prompt?.itemset === undefined) throw new Error("Expected an itemset");
		prompt.itemset.sort = "";
		expect(codes(validateHqJson(sortless))).toEqual([
			"HQJSON_BAD_SEARCH_ITEMSET",
		]);
	});
});
