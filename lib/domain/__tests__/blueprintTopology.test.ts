import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { blueprintDocSchema, type PersistableDoc } from "../blueprint";
import type { Form } from "../forms";
import { type Module, plainColumn, simpleSearchInputDef } from "../modules";
import { proseText } from "../prose";

const MODULE = testUuid("topology-module");
const MODULE_2 = testUuid("topology-module-2");
const MODULE_3 = testUuid("topology-module-3");
const FORM = testUuid("topology-form");
const FORM_2 = testUuid("topology-form-2");
const FIELD = testUuid("topology-field");
const GROUP = testUuid("topology-group");
const GROUP_2 = testUuid("topology-group-2");
const UNKNOWN = testUuid("topology-unknown");
const PROPERTY = testUuid("topology-property");
const COLUMN = testUuid("topology-column");
const SEARCH_INPUT = testUuid("topology-search-input");
const OPTION_2 = testUuid("topology-option-2");

function emptyDoc(): PersistableDoc {
	return {
		appId: "topology-app",
		appName: "Topology",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
	};
}

function module(uuid = MODULE): Module {
	return { uuid, id: "module", name: "Module" };
}

function form(uuid = FORM): Form {
	return {
		uuid,
		id: "form",
		name: "Form",
		type: "survey" as const,
	};
}

function textField(uuid = FIELD) {
	return {
		uuid,
		id: "answer",
		kind: "text" as const,
		label: proseText("Answer"),
	};
}

function groupField(uuid = GROUP) {
	return {
		uuid,
		id: "group",
		kind: "group" as const,
		label: proseText("Group"),
	};
}

function oneFormDoc(): PersistableDoc {
	return {
		...emptyDoc(),
		modules: { [MODULE]: module() },
		forms: { [FORM]: form() },
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [] },
	};
}

function messages(input: unknown): string[] {
	const result = blueprintDocSchema.safeParse(input);
	expect(result.success).toBe(false);
	return result.success
		? []
		: result.error.issues.map((issue) => issue.message);
}

describe("closed blueprint topology", () => {
	it("accepts the exact empty and runnable shapes", () => {
		expect(blueprintDocSchema.safeParse(emptyDoc()).success).toBe(true);
		expect(blueprintDocSchema.safeParse(oneFormDoc()).success).toBe(true);
	});

	it("accepts one-tier modules in contiguous depth-first preorder", () => {
		const doc = emptyDoc();
		doc.modules = {
			[MODULE]: module(MODULE),
			[MODULE_2]: {
				...module(MODULE_2),
				parentModuleUuid: MODULE,
			},
			[MODULE_3]: module(MODULE_3),
		};
		doc.moduleOrder = [MODULE, MODULE_2, MODULE_3];
		doc.formOrder = { [MODULE]: [], [MODULE_2]: [], [MODULE_3]: [] };
		expect(blueprintDocSchema.safeParse(doc).success).toBe(true);
	});

	it("rejects missing, nested, and noncontiguous module parents", () => {
		const missing = emptyDoc();
		missing.modules = {
			[MODULE]: { ...module(MODULE), parentModuleUuid: UNKNOWN },
		};
		missing.moduleOrder = [MODULE];
		missing.formOrder = { [MODULE]: [] };
		expect(messages(missing)).toContain(
			`Module ${MODULE} names missing parent module ${UNKNOWN}.`,
		);

		const nested = emptyDoc();
		nested.modules = {
			[MODULE]: module(MODULE),
			[MODULE_2]: {
				...module(MODULE_2),
				parentModuleUuid: MODULE,
			},
			[MODULE_3]: {
				...module(MODULE_3),
				parentModuleUuid: MODULE_2,
			},
		};
		nested.moduleOrder = [MODULE, MODULE_2, MODULE_3];
		nested.formOrder = { [MODULE]: [], [MODULE_2]: [], [MODULE_3]: [] };
		expect(messages(nested)).toContain(
			`Module ${MODULE_3} cannot be nested under child module ${MODULE_2}.`,
		);

		const noncontiguous = emptyDoc();
		noncontiguous.modules = {
			[MODULE]: module(MODULE),
			[MODULE_2]: {
				...module(MODULE_2),
				parentModuleUuid: MODULE,
			},
			[MODULE_3]: module(MODULE_3),
		};
		noncontiguous.moduleOrder = [MODULE, MODULE_3, MODULE_2];
		noncontiguous.formOrder = {
			[MODULE]: [],
			[MODULE_2]: [],
			[MODULE_3]: [],
		};
		expect(messages(noncontiguous)).toContain(
			"moduleOrder must keep every root immediately before its contiguous child modules.",
		);
	});

	it("requires strict UUID record keys", () => {
		const doc = {
			...emptyDoc(),
			modules: { "not-a-uuid": module() },
		};
		expect(messages(doc)).toContain("Expected a canonical lowercase RFC UUID.");
	});

	it("requires every record key to equal its embedded UUID", () => {
		const doc = {
			...emptyDoc(),
			modules: { [MODULE_2]: module() },
			moduleOrder: [MODULE_2],
			formOrder: { [MODULE_2]: [] },
		};
		expect(messages(doc)).toContain(
			`modules record key ${MODULE_2} must equal embedded uuid ${MODULE}.`,
		);
	});

	it("rejects authored UUID collisions across entity records", () => {
		const doc = {
			...oneFormDoc(),
			forms: { [MODULE]: form(MODULE) },
			formOrder: { [MODULE]: [MODULE] },
			fieldOrder: { [MODULE]: [] },
		};
		expect(messages(doc)).toContain(
			`Authored uuid ${MODULE} appears in both modules and forms.`,
		);
	});

	it.each([
		{
			kind: "case-list column",
			build: () => {
				const doc = oneFormDoc();
				doc.modules[MODULE] = {
					...module(),
					caseListConfig: {
						columns: [plainColumn(FORM, "case_name", "Name")],
						listColumnOrder: [FORM],
						detailColumnOrder: [FORM],
						searchInputs: [],
					},
				};
				return doc;
			},
		},
		{
			kind: "Search input",
			build: () => {
				const doc = oneFormDoc();
				doc.modules[MODULE] = {
					...module(),
					caseListConfig: {
						columns: [],
						listColumnOrder: [],
						detailColumnOrder: [],
						searchInputs: [
							simpleSearchInputDef(FORM, "query", "Query", "text", "case_name"),
						],
					},
				};
				return doc;
			},
		},
		{
			kind: "case operation",
			build: () => {
				const doc = oneFormDoc();
				doc.forms[FORM] = {
					...form(),
					caseOperations: [
						{
							uuid: FORM,
							id: "create_case",
							action: "create" as const,
							caseType: "patient",
							target: { kind: "new" as const },
							name: {
								kind: "term" as const,
								term: { kind: "literal" as const, value: "Name" },
							},
						},
					],
				};
				return doc;
			},
		},
		{
			kind: "select option",
			build: () => {
				const doc = {
					...oneFormDoc(),
					fields: {
						[FIELD]: {
							uuid: FIELD,
							id: "choice",
							kind: "single_select" as const,
							label: proseText("Choice"),
							optionsSource: {
								kind: "inline" as const,
								options: [
									{ uuid: FORM, value: "a", label: proseText("A") },
									{ uuid: OPTION_2, value: "b", label: proseText("B") },
								],
							},
						},
					},
					fieldOrder: { [FORM]: [FIELD] },
				};
				return doc;
			},
		},
	])(
		"includes every nested $kind UUID in the global namespace",
		({ kind, build }) => {
			expect(messages(build())).toContain(
				`Authored uuid ${FORM} appears in both forms and ${kind}.`,
			);
		},
	);

	it("rejects a collision between two different nested identity families", () => {
		const doc = oneFormDoc();
		doc.modules[MODULE] = {
			...module(),
			caseListConfig: {
				columns: [plainColumn(COLUMN, "case_name", "Name")],
				listColumnOrder: [COLUMN],
				detailColumnOrder: [COLUMN],
				searchInputs: [
					simpleSearchInputDef(COLUMN, "query", "Query", "text", "case_name"),
				],
			},
		};
		expect(messages(doc)).toContain(
			`Authored uuid ${COLUMN} appears in both case-list column and Search input.`,
		);
	});

	it("requires Connect configuration to match the app mode", () => {
		const doc = oneFormDoc();
		doc.forms[FORM] = {
			...form(),
			connect: {
				learn_module: {
					id: "training",
					name: "Training",
					description: "Training",
					time_estimate: 10,
				},
			},
		};
		expect(messages(doc)).toContain(
			"Form Connect configuration must match the app Connect mode.",
		);
	});

	it("requires Connect ids to be unique across forms and subkinds", () => {
		const doc = {
			...oneFormDoc(),
			connectType: "learn" as const,
			forms: {
				[FORM]: {
					...form(),
					connect: {
						learn_module: {
							id: "shared",
							name: "Training",
							description: "Training",
							time_estimate: 10,
						},
					},
				},
				[FORM_2]: {
					...form(FORM_2),
					connect: {
						assessment: { id: "shared" },
					},
				},
			},
			formOrder: { [MODULE]: [FORM, FORM_2] },
			fieldOrder: { [FORM]: [], [FORM_2]: [] },
		};
		expect(messages(doc)).toContain(
			`Connect id shared appears in both forms.${FORM}.connect.learn_module and forms.${FORM_2}.connect.assessment.`,
		);
	});

	it.each([
		{ connect: null, label: "stored null" },
		{ connect: {}, label: "empty config" },
		{
			connect: {
				learn_module: {
					name: "Training",
					description: "Training",
					time_estimate: 10,
				},
			},
			label: "missing id",
		},
	])("rejects a Connect $label instead of repairing it", ({ connect }) => {
		const doc = oneFormDoc();
		doc.connectType = "learn";
		const targetForm = doc.forms[FORM];
		if (targetForm === undefined) throw new Error("test form missing");
		Object.assign(targetForm, { connect });
		expect(blueprintDocSchema.safeParse(doc).success).toBe(false);
	});

	it("rejects owner-only availability combined with Search inputs", () => {
		const doc = oneFormDoc();
		doc.modules[MODULE] = {
			...module(),
			caseListConfig: {
				columns: [],
				listColumnOrder: [],
				detailColumnOrder: [],
				searchInputs: [
					simpleSearchInputDef(
						SEARCH_INPUT,
						"query",
						"Query",
						"text",
						"case_name",
					),
				],
			},
			caseSearchConfig: {
				searchActionEnabled: false,
				excludedOwnerIds: {
					kind: "term",
					term: { kind: "literal", value: "owner" },
				},
			},
		};
		expect(messages(doc)).toContain(
			"Owner-only case availability cannot coexist with Search inputs.",
		);
	});

	it.each([
		{
			name: "duplicate module membership",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.moduleOrder = [MODULE, MODULE];
			},
			message: `moduleOrder contains duplicate member ${MODULE}.`,
		},
		{
			name: "unknown module membership",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.moduleOrder = [MODULE, UNKNOWN];
			},
			message: `moduleOrder member ${UNKNOWN} does not exist in modules.`,
		},
		{
			name: "missing module membership",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.moduleOrder = [];
			},
			message: `modules member ${MODULE} is absent from moduleOrder.`,
		},
		{
			name: "stray form-order parent",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				Object.assign(doc.formOrder, { [UNKNOWN]: [] });
			},
			message: `formOrder key ${UNKNOWN} is not a module.`,
		},
		{
			name: "missing form-order parent",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.formOrder = {};
			},
			message: `Module ${MODULE} has no formOrder membership array.`,
		},
		{
			name: "unknown form membership",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.formOrder = { [MODULE]: [FORM, UNKNOWN] };
			},
			message: `formOrder member ${UNKNOWN} does not exist in forms.`,
		},
	])("rejects $name", ({ edit, message }) => {
		const doc = oneFormDoc();
		edit(doc);
		expect(messages(doc)).toContain(message);
	});

	it("requires each form under exactly one module", () => {
		const doc = {
			...oneFormDoc(),
			modules: {
				[MODULE]: module(),
				[MODULE_2]: module(MODULE_2),
			},
			moduleOrder: [MODULE, MODULE_2],
			formOrder: {
				[MODULE]: [FORM],
				[MODULE_2]: [FORM],
			},
		};
		expect(messages(doc)).toContain(
			`Form ${FORM} appears under both ${MODULE} and ${MODULE_2}.`,
		);
	});

	it("requires every form to have a field-order root", () => {
		const doc = oneFormDoc();
		doc.fieldOrder = {};
		expect(messages(doc)).toContain(
			`Field parent ${FORM} has no fieldOrder membership array.`,
		);
	});

	it("rejects field-order keys for non-container fields", () => {
		const doc = {
			...oneFormDoc(),
			fields: { [FIELD]: textField() },
			fieldOrder: { [FORM]: [FIELD], [FIELD]: [] },
		};
		expect(messages(doc)).toContain(
			`fieldOrder key ${FIELD} is neither a form nor a container field.`,
		);
	});

	it("requires each field under exactly one form or container", () => {
		const doc = {
			...oneFormDoc(),
			forms: {
				[FORM]: form(),
				[FORM_2]: form(FORM_2),
			},
			formOrder: { [MODULE]: [FORM, FORM_2] },
			fields: { [FIELD]: textField() },
			fieldOrder: {
				[FORM]: [FIELD],
				[FORM_2]: [FIELD],
			},
		};
		expect(messages(doc)).toContain(
			`Field ${FIELD} appears under both ${FORM} and ${FORM_2}.`,
		);
	});

	it("rejects container membership cycles", () => {
		const doc = {
			...oneFormDoc(),
			fields: {
				[GROUP]: groupField(),
				[GROUP_2]: groupField(GROUP_2),
			},
			fieldOrder: {
				[FORM]: [],
				[GROUP]: [GROUP_2],
				[GROUP_2]: [GROUP],
			},
		};
		expect(messages(doc)).toContain(`Field membership cycle reaches ${GROUP}.`);
	});

	it("closes optional flat records and sequences together", () => {
		const doc = {
			...emptyDoc(),
			userProperties: {
				[PROPERTY]: {
					uuid: PROPERTY,
					slug: "region",
					label: "Region",
				},
			},
		};
		expect(messages(doc)).toContain(
			`userProperties member ${PROPERTY} is absent from userPropertyOrder.`,
		);
	});
});
