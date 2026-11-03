/**
 * The advanced menu and form shells and the advanced actions, held to the key
 * sets of CommCare HQ's own documents at the pin
 * (`fixtures/hq-advanced-keys.json`: the key sets of HQ's test fixture
 * `suite-advanced.json` and of HQ's models). The failure each catches is a key
 * HQ's save would add or drop: a key Nova writes that HQ's model does not
 * declare, a key HQ's model declares that Nova neither writes nor states it
 * leaves at HQ's default, or a shared key whose value drifts from the basic
 * shell's. Pure.
 */

import { describe, expect, it } from "vitest";
import type { HqAdvancedModule, HqApplication } from "@/lib/commcare";
import {
	type HqFormLinkTree,
	hqXPath,
	hqXPathText,
	serializeHqApplication,
} from "../hqJson/xpath";
import {
	advancedFormShell,
	advancedModuleShell,
	applicationShell,
	detailColumn,
	detailPair,
	emptyAdvancedFormActions,
	emptyFormActions,
	formShell,
	moduleShell,
} from "../hqShells";
import { validateHqJson } from "../validator/hqJsonOracle";
import { w } from "../xpath/wire/builders";
import {
	type advancedActions,
	advancedForm,
	advancedModule,
	LIST_MODULE_ID,
} from "./advancedActionsFixture";
import hqKeys from "./fixtures/hq-advanced-keys.json";

/** The class tags HQ dispatches on, which its models hold as no property. */
const CLASS_TAGS = ["doc_type", "module_type", "form_type"];

/**
 * Each HQ property an advanced menu or form leaves unwritten, at HQ's
 * default. Session endpoint ids are written by the expander where the menu
 * or form has one.
 */
const NOT_WRITTEN = {
	AdvancedModule: [
		"case_list_session_endpoint_id",
		"custom_assertions",
		"fixture_select",
		"has_schedule",
		"report_context_tile",
		"schedule_phases",
		"session_endpoint_id",
		"show_case_list_optimization_options",
		"use_default_audio_for_all",
		"use_default_image_for_all",
	],
	AdvancedForm: [
		"auto_gps_capture",
		"enable_release_notes",
		"function_datum_endpoints",
		"is_release_notes_form",
		"respect_relevancy",
		"schedule",
		"schedule_form_id",
		"session_endpoint_id",
		"show_count",
		"submit_label",
		"submit_notification_label",
		"use_default_audio_for_all",
		"use_default_image_for_all",
		"validation_cache",
	],
} as const;

/** The keys of §7.1, in the order Nova writes them. */
const ADVANCED_MODULE_KEYS = [
	"doc_type",
	"module_type",
	"unique_id",
	"name",
	"case_type",
	"put_in_root",
	"root_module_id",
	"forms",
	"case_details",
	"product_details",
	"case_list",
	"case_list_form",
	"search_config",
	"media_image",
	"media_audio",
	"custom_icons",
	"is_training_module",
	"module_filter",
	"auto_select_case",
	"comment",
];

/** The keys of §7.2, in the order Nova writes them. */
const ADVANCED_FORM_KEYS = [
	"doc_type",
	"form_type",
	"unique_id",
	"name",
	"xmlns",
	"version",
	"actions",
	"arbitrary_datums",
	"case_references_data",
	"form_filter",
	"post_form_workflow",
	"post_form_workflow_fallback",
	"media_image",
	"media_audio",
	"custom_icons",
	"custom_assertions",
	"custom_instances",
	"form_links",
	"comment",
];

type Kind = keyof typeof hqKeys.schemaKeys;

/** A shell's keys as JSON carries them, once serialized. */
function jsonKeys(value: object): string[] {
	return Object.keys(JSON.parse(JSON.stringify(value)));
}

/** The properties of HQ's model of `kind` that Nova writes on `value`. */
function heldToSchema(kind: Kind, value: object) {
	const written = jsonKeys(value).filter((key) => !CLASS_TAGS.includes(key));
	const schema: readonly string[] = hqKeys.schemaKeys[kind];
	return {
		undeclared: written.filter((key) => !schema.includes(key)),
		unwritten: schema.filter((key) => !written.includes(key)),
	};
}

/** The fixture's keys Nova does not write and HQ's model no longer declares. */
function retiredFixtureKeys(kind: keyof typeof hqKeys.fixtureKeys): string[] {
	const schemaKind = kind === "ProductDetailColumn" ? undefined : kind;
	const schema: readonly string[] =
		schemaKind === undefined ? [] : hqKeys.schemaKeys[schemaKind];
	return hqKeys.fixtureKeys[kind].filter(
		(key) => !schema.includes(key) && !CLASS_TAGS.includes(key),
	);
}

function serialized(module = advancedModule()): HqAdvancedModule {
	const app: HqApplication = serializeHqApplication(
		applicationShell("Households", [module], {}, { cloudcareEnabled: true }),
	);
	const emitted = app.modules[0];
	if (emitted?.doc_type !== "AdvancedModule")
		throw new Error("The serialized menu stays advanced.");
	return emitted;
}

describe("advancedModuleShell", () => {
	it("writes §7.1's keys in order, each a property of HQ's AdvancedModule", () => {
		const module = serialized();
		expect(Object.keys(module)).toEqual(ADVANCED_MODULE_KEYS);
		const { undeclared, unwritten } = heldToSchema("AdvancedModule", module);
		expect(undeclared).toEqual([]);
		expect(unwritten).toEqual([...NOT_WRITTEN.AdvancedModule]);
	});

	it("writes every key HQ's fixture holds but the two its model no longer declares", () => {
		const written = jsonKeys(serialized());
		expect(retiredFixtureKeys("AdvancedModule")).toEqual([
			"case_label",
			"referral_label",
		]);
		expect(
			hqKeys.fixtureKeys.AdvancedModule.filter((key) => !written.includes(key)),
		).toEqual(["case_label", "referral_label"]);
	});

	it("writes none of the basic menu's parent selection, display style, schedule or optimization keys", () => {
		const module = serialized();
		for (const key of [
			"parent_select",
			"display_style",
			"has_schedule",
			"schedule_phases",
			"show_case_list_optimization_options",
		])
			expect(module).not.toHaveProperty(key);
	});

	it("gives every key it shares with a basic menu the basic menu's value", () => {
		const details = detailPair([detailColumn("name", "Name")]);
		const basic = moduleShell(
			"m",
			{ en: "Households" },
			"household",
			[],
			details,
			["en", "es"],
			true,
		);
		const advanced = advancedModuleShell(
			"m",
			{ en: "Households" },
			"household",
			[],
			details,
			"en",
			["en", "es"],
			true,
		);
		const shared = Object.keys(advanced).filter(
			(key) => key in basic && !CLASS_TAGS.includes(key),
		);
		expect(shared).toEqual(
			ADVANCED_MODULE_KEYS.filter(
				(key) => !CLASS_TAGS.includes(key) && key !== "product_details",
			),
		);
		for (const key of shared)
			expect(advanced[key as keyof typeof advanced], key).toEqual(
				basic[key as keyof typeof basic],
			);
	});

	it("writes HQ's default product list, headed in the app's default language", () => {
		const module = serialized(
			advancedModuleShell(
				LIST_MODULE_ID,
				{ es: "Hogares" },
				"household",
				[],
				detailPair([detailColumn("name", { es: "Nombre" })]),
				"es",
				["es", "en"],
				true,
			),
		);
		const { short, long } = module.product_details;
		expect(module.product_details.doc_type).toBe("DetailPair");
		expect(short.columns).toHaveLength(1);
		expect(short.columns[0]).toMatchObject({
			...hqKeys.defaultProductColumn,
			header: { es: "Product" },
			useXpathExpression: false,
		});
		expect(long.columns).toEqual([]);
		// The column carries every key HQ's fixture writes on a product column.
		const columnKeys = Object.keys(short.columns[0] ?? {});
		expect(
			hqKeys.fixtureKeys.ProductDetailColumn.filter(
				(key) => !columnKeys.includes(key),
			),
		).toEqual([]);
	});

	it("writes the null case list registration form and an unshown case list", () => {
		const module = serialized();
		expect(module.case_list_form).toEqual({
			doc_type: "CaseListForm",
			form_id: null,
			label: {},
		});
		expect(module.case_list.show).toBe(false);
		expect(module.put_in_root).toBe(false);
		expect(module.root_module_id).toBeNull();
	});
});

describe("advancedFormShell", () => {
	it("writes §7.2's keys in order, each a property of HQ's AdvancedForm, with no requires and no schedule", () => {
		const form = serialized().forms[0];
		if (form === undefined) throw new Error("The menu holds its form.");
		expect(Object.keys(form)).toEqual(ADVANCED_FORM_KEYS);
		expect(form).not.toHaveProperty("requires");
		expect(form).not.toHaveProperty("schedule");
		expect(form.arbitrary_datums).toEqual([]);
		const { undeclared, unwritten } = heldToSchema("AdvancedForm", form);
		expect(undeclared).toEqual([]);
		expect(unwritten).toEqual([...NOT_WRITTEN.AdvancedForm]);
	});

	it("writes every key HQ's fixture holds but show_count, left at HQ's default", () => {
		const form = serialized().forms[0] ?? {};
		const written = jsonKeys(form);
		expect(retiredFixtureKeys("AdvancedForm")).toEqual([]);
		expect(
			hqKeys.fixtureKeys.AdvancedForm.filter((key) => !written.includes(key)),
		).toEqual(["show_count"]);
	});

	it("gives every key it shares with a basic form the basic form's value", () => {
		const args: [
			Record<string, string[]>,
			Record<string, never>,
			string,
			string,
			HqFormLinkTree[],
		] = [
			{},
			{},
			"form",
			"module",
			[{ xpath: "", module_unique_id: "m1", datums: [] }],
		];
		const basic = formShell(
			"f",
			"Visit",
			"http://example.org/f",
			"case",
			emptyFormActions(),
			...args,
		);
		const advanced = advancedFormShell(
			"f",
			"Visit",
			"http://example.org/f",
			emptyAdvancedFormActions(),
			...args,
		);
		const shared = Object.keys(advanced).filter(
			(key) => key in basic && !CLASS_TAGS.includes(key) && key !== "actions",
		);
		expect(shared).toEqual(
			ADVANCED_FORM_KEYS.filter(
				(key) =>
					!CLASS_TAGS.includes(key) &&
					key !== "actions" &&
					key !== "arbitrary_datums",
			),
		);
		for (const key of shared)
			expect(advanced[key as keyof typeof advanced], key).toEqual(
				basic[key as keyof typeof basic],
			);
	});

	it("prints its display condition, the one expression it holds, when the app is serialized", () => {
		const condition = hqXPath(
			w.eq(w.hqCase([w.step("status")]), w.str("open")),
			"case",
		);
		const form = advancedForm();
		form.form_filter = condition;
		const emitted = serialized(advancedModule([form])).forms[0];
		expect(emitted?.form_filter).toBe(hqXPathText(condition));
		expect(typeof emitted?.form_filter).toBe("string");
	});
});

describe("advanced actions", () => {
	const actions = () => {
		const form = serialized().forms[0];
		if (form === undefined) throw new Error("The menu holds its form.");
		return JSON.parse(JSON.stringify(form.actions)) as ReturnType<
			typeof advancedActions
		>;
	};

	it("writes every property of each action kind HQ's model declares, and no other", () => {
		const { load_update_cases, open_cases, ...rest } = actions();
		expect(heldToSchema("AdvancedFormActions", rest)).toEqual({
			undeclared: [],
			unwritten: ["load_update_cases", "open_cases"],
		});
		for (const load of load_update_cases) {
			expect(heldToSchema("LoadUpdateAction", load)).toEqual({
				undeclared: [],
				unwritten: [],
			});
			expect(heldToSchema("CaseIndex", load.case_index)).toEqual({
				undeclared: [],
				unwritten: [],
			});
			for (const condition of [load.close_condition])
				expect(heldToSchema("FormActionCondition", condition)).toEqual({
					undeclared: [],
					unwritten: [],
				});
			for (const update of Object.values(load.case_properties))
				expect(heldToSchema("ConditionalCaseUpdate", update)).toEqual({
					undeclared: [],
					unwritten: [],
				});
		}
		for (const open of open_cases) {
			expect(heldToSchema("AdvancedOpenCaseAction", open)).toEqual({
				undeclared: [],
				unwritten: [],
			});
			for (const index of open.case_indices)
				expect(heldToSchema("CaseIndex", index)).toEqual({
					undeclared: [],
					unwritten: [],
				});
			for (const condition of [open.open_condition, open.close_condition])
				expect(heldToSchema("FormActionCondition", condition)).toEqual({
					undeclared: [],
					unwritten: [],
				});
		}
		const auto = load_update_cases[2]?.auto_select;
		if (auto == null) throw new Error("The worker's load chooses its case.");
		expect(heldToSchema("AutoSelectCase", auto)).toEqual({
			undeclared: [],
			unwritten: [],
		});
	});

	it("writes every key HQ's fixture holds on a load, a create and a condition", () => {
		const { load_update_cases, open_cases } = actions();
		const fixtureHeld = (
			kind:
				| "LoadUpdateAction"
				| "AdvancedOpenCaseAction"
				| "FormActionCondition",
			value: object,
		) => hqKeys.fixtureKeys[kind].filter((key) => !(key in value));
		for (const load of load_update_cases)
			expect(fixtureHeld("LoadUpdateAction", load)).toEqual([]);
		for (const open of open_cases) {
			expect(fixtureHeld("AdvancedOpenCaseAction", open)).toEqual([]);
			expect(fixtureHeld("FormActionCondition", open.open_condition)).toEqual(
				[],
			);
		}
		expect(retiredFixtureKeys("LoadUpdateAction")).toEqual([]);
		expect(retiredFixtureKeys("AdvancedOpenCaseAction")).toEqual([]);
	});

	it("writes a condition's question, answer and operator as nulls where it has none", () => {
		const { open_cases, load_update_cases } = actions();
		expect(open_cases[0]?.open_condition).toEqual({
			type: "always",
			question: null,
			answer: null,
			operator: null,
			doc_type: "FormActionCondition",
		});
		expect(load_update_cases[0]?.close_condition).toEqual({
			type: "never",
			question: null,
			answer: null,
			operator: null,
			doc_type: "FormActionCondition",
		});
		expect(load_update_cases[1]?.close_condition).toEqual({
			type: "if",
			question: "/data/moved",
			answer: "yes",
			operator: "=",
			doc_type: "FormActionCondition",
		});
	});

	it("always writes details_module, null for the worker's own record, and an empty preload", () => {
		const { load_update_cases } = actions();
		expect(load_update_cases.map((load) => load.details_module)).toEqual([
			LIST_MODULE_ID,
			LIST_MODULE_ID,
			null,
		]);
		for (const load of load_update_cases) {
			expect(load).toHaveProperty("details_module");
			expect(load.preload).toEqual({});
			expect(load.load_case_from_fixture).toBeNull();
			expect(load.show_product_stock).toBe(false);
			expect(load.product_program).toBe("");
		}
		expect(load_update_cases.map((load) => load.auto_select)).toEqual([
			null,
			null,
			{
				doc_type: "AutoSelectCase",
				mode: "usercase",
				value_source: "",
				value_key: "",
			},
		]);
	});

	it("writes a load that indexes nothing with HQ's CaseIndex defaults", () => {
		expect(actions().load_update_cases[0]?.case_index).toEqual({
			doc_type: "CaseIndex",
			tag: "",
			reference_id: "parent",
			relationship: "child",
			relationship_question: "",
		});
	});

	it("passes the HQ JSON oracle", () => {
		expect(
			validateHqJson(
				serializeHqApplication(
					applicationShell(
						"Households",
						[advancedModule()],
						{},
						{
							cloudcareEnabled: true,
						},
					),
				),
			),
		).toEqual([]);
	});
});
