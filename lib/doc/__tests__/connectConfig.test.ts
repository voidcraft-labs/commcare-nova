import { describe, expect, it } from "vitest";
import {
	buildDoc,
	type FieldSpec,
	type FormSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import type {
	BlueprintDoc,
	ConnectConfig,
	ConnectLearnModule,
	ConnectType,
	ConnectType as DomainConnectType,
	Uuid,
} from "@/lib/domain";
import { deriveConnectDefaults } from "../connectConfig";

// ── Helpers ──────────────────────────────────────────────────────────
//
// `deriveConnectDefaults` operates on `BlueprintDoc` directly. The
// builders below wrap a form's fields + connect block in a single-module
// doc so every assertion has the shape the helper actually sees.

const LEARN_FIELDS: FieldSpec[] = [
	f({ kind: "label", id: "intro", label: "Welcome to the training module" }),
	f({
		kind: "single_select",
		id: "q1",
		label: "What is the correct dosage?",
		options: [
			{ value: "a", label: "10mg" },
			{ value: "b", label: "20mg" },
		],
	}),
	f({
		kind: "single_select",
		id: "q2",
		label: "How often should you check?",
		options: [
			{ value: "daily", label: "Daily" },
			{ value: "weekly", label: "Weekly" },
		],
	}),
	f({
		kind: "hidden",
		id: "assessment_score",
		calculate: "if(/data/q1 = 'b' and /data/q2 = 'daily', 100, 0)",
	}),
];

const DELIVER_FIELDS: FieldSpec[] = [
	f({
		kind: "date",
		id: "report_date",
		label: "Report Date",
		required: "true()",
	}),
	f({
		kind: "int",
		id: "chlorine_level",
		label: "Chlorine Level",
		validate: ". >= 0 and . <= 10",
	}),
];

/**
 * Build a one-module single-form doc with the given connect config + fields.
 * Returns both the doc and the form's uuid so tests can read the form back
 * after `deriveConnectDefaults` returns.
 */
function buildConnectDoc(params: {
	connectType: ConnectType;
	moduleName?: string;
	formName: string;
	connect?: ConnectConfig;
	fields?: FieldSpec[];
}): { doc: BlueprintDoc; formUuid: Uuid } {
	const doc = buildDoc({
		connectType: params.connectType,
		modules: [
			{
				name: params.moduleName ?? "Main",
				forms: [
					{
						name: params.formName,
						type: "survey",
						connect: params.connect,
						fields: params.fields,
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	return { doc, formUuid };
}

// ── deriveConnectDefaults ────────────────────────────────────────────

describe("deriveConnectDefaults", () => {
	it("returns undefined when form has no connect config", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "learn",
			formName: "ILC Training",
			fields: LEARN_FIELDS,
		});
		expect(
			deriveConnectDefaults({ connectType: "learn", doc, formUuid }),
		).toBeUndefined();
	});

	it("fills learn_module defaults when learn_module is present", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "learn",
			formName: "ILC Training",
			connect: {
				learn_module: {
					name: "",
					description: "",
				} as Partial<ConnectLearnModule> as ConnectLearnModule,
			},
			fields: LEARN_FIELDS,
		});
		const next = deriveConnectDefaults({
			connectType: "learn",
			doc,
			formUuid,
			moduleName: "Main",
		});
		expect(next?.learn_module).toEqual({
			id: "main",
			name: "ILC Training",
			description: "ILC Training",
			// 4 fields / 3 rounded up = 2 — hidden assessment_score included;
			// label/singleSelect/singleSelect/hidden all count (containers don't).
			time_estimate: 2,
		});
	});

	it("auto-detects assessment score when assessment is present", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "learn",
			formName: "ILC Training",
			connect: { assessment: { user_score: "" } },
			fields: LEARN_FIELDS,
		});
		const next = deriveConnectDefaults({
			connectType: "learn",
			doc,
			formUuid,
			moduleName: "Main",
		});
		expect(next?.assessment).toEqual({
			id: "main_ilc_training",
			user_score: "if(/data/q1 = 'b' and /data/q2 = 'daily', 100, 0)",
		});
	});

	it("does not auto-create learn_module or assessment from empty connect", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "learn",
			formName: "ILC Training",
			connect: {},
			fields: LEARN_FIELDS,
		});
		const next = deriveConnectDefaults({
			connectType: "learn",
			doc,
			formUuid,
			moduleName: "Main",
		});
		expect(next?.learn_module).toBeUndefined();
		expect(next?.assessment).toBeUndefined();
	});

	it("does not overwrite existing learn_module", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "learn",
			formName: "ILC Training",
			connect: {
				learn_module: {
					name: "Custom Name",
					description: "Custom Desc",
					time_estimate: 10,
				},
			},
			fields: LEARN_FIELDS,
		});
		const next = deriveConnectDefaults({ connectType: "learn", doc, formUuid });
		expect(next?.learn_module?.name).toBe("Custom Name");
		expect(next?.learn_module?.time_estimate).toBe(10);
	});

	it("does not overwrite existing assessment", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "learn",
			formName: "ILC Training",
			connect: { assessment: { user_score: "50" } },
			fields: LEARN_FIELDS,
		});
		const next = deriveConnectDefaults({ connectType: "learn", doc, formUuid });
		expect(next?.assessment?.user_score).toBe("50");
	});

	it("fills deliver_unit defaults when deliver_unit is present", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "deliver",
			formName: "Weekly Report",
			connect: {
				deliver_unit: { name: "", entity_id: "", entity_name: "" },
			},
			fields: DELIVER_FIELDS,
		});
		const next = deriveConnectDefaults({
			connectType: "deliver",
			doc,
			formUuid,
			moduleName: "Main",
		});
		expect(next?.deliver_unit).toEqual({
			id: "main",
			name: "Weekly Report",
			entity_id: "concat(#user/username, '-', today())",
			entity_name: "#user/username",
		});
	});

	it("does not overwrite existing deliver_unit", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "deliver",
			formName: "Weekly Report",
			connect: {
				deliver_unit: {
					name: "Custom Unit",
					entity_id: "custom_id",
					entity_name: "custom_name",
				},
			},
			fields: DELIVER_FIELDS,
		});
		const next = deriveConnectDefaults({
			connectType: "deliver",
			doc,
			formUuid,
		});
		expect(next?.deliver_unit?.name).toBe("Custom Unit");
	});

	it("fills assessment default score of 100 when no score field exists", () => {
		const { doc, formUuid } = buildConnectDoc({
			connectType: "learn",
			moduleName: "Training",
			formName: "Simple Learn",
			connect: { assessment: { user_score: "" } },
			fields: [f({ kind: "label", id: "content", label: "Read this." })],
		});
		const next = deriveConnectDefaults({
			connectType: "learn",
			doc,
			formUuid,
			moduleName: "Training",
		});
		expect(next?.assessment).toEqual({
			id: "training_simple_learn",
			user_score: "100",
		});
	});
});

// ── XForm Export ─────────────────────────────────────────────────────

/**
 * Minimal domain doc carrying one survey form with the supplied Connect
 * config + optional fields. Used exclusively for `expandDoc` assertions
 * — the XForm export tests only care about the emitted Connect blocks,
 * so the field content is irrelevant beyond what each sub-test names.
 */
function makeConnectExpandDoc(
	connectType: ConnectType,
	connect: ConnectConfig | undefined,
	formName: string,
	fields: FieldSpec[] = [],
) {
	return buildDoc({
		appName: "Connect Test App",
		connectType,
		modules: [
			{
				name: "Main",
				forms: [
					{
						name: formName,
						type: "survey",
						connect,
						fields,
					},
				],
			},
		],
	});
}

describe("Connect XForm export", () => {
	it("generates correct learn module data block", () => {
		const doc = makeConnectExpandDoc(
			"learn",
			{
				learn_module: {
					name: "ILC Module",
					description: "Training for ILC",
					time_estimate: 5,
				},
			},
			"ILC Training",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('<connect_learn vellum:role="ConnectLearnModule">');
		expect(xml).toContain('xmlns="http://commcareconnect.com/data/v1/learn"');
		expect(xml).toContain("<name>ILC Module</name>");
		expect(xml).toContain("<description>Training for ILC</description>");
		expect(xml).toContain("<time_estimate>5</time_estimate>");
		expect(xml).toContain("</connect_learn>");
	});

	it("generates correct assessment block with calculate bind", () => {
		const doc = makeConnectExpandDoc(
			"learn",
			{
				learn_module: { name: "Test", description: "Test", time_estimate: 1 },
				assessment: { user_score: "100" },
			},
			"ILC Training",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain(
			'<connect_assessment vellum:role="ConnectAssessment">',
		);
		expect(xml).toContain("<user_score/>");
		expect(xml).toContain(
			'nodeset="/data/connect_assessment/assessment/user_score" calculate="100"',
		);
	});

	it("generates correct deliver unit block with XPath binds", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					name: "Weekly Report",
					entity_id: "concat('user', '-', today())",
					entity_name: "'test_user'",
				},
			},
			"Weekly Report",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('<connect_deliver vellum:role="ConnectDeliverUnit">');
		expect(xml).toContain(
			'<deliver xmlns="http://commcareconnect.com/data/v1/learn"',
		);
		expect(xml).toContain("<name>Weekly Report</name>");
		expect(xml).toContain("<entity_id/>");
		expect(xml).toContain("<entity_name/>");
		expect(xml).toContain('nodeset="/data/connect_deliver/deliver/entity_id"');
		expect(xml).toContain(
			'nodeset="/data/connect_deliver/deliver/entity_name"',
		);
	});

	it("generates task block", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					name: "Unit",
					entity_id: "'id'",
					entity_name: "'name'",
				},
				task: { name: "Delivery Task", description: "Complete the delivery" },
			},
			"Weekly Report",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('<connect_task vellum:role="ConnectTask">');
		expect(xml).toContain("<name>Delivery Task</name>");
		expect(xml).toContain("<description>Complete the delivery</description>");
	});

	it("includes secondary instances when Connect XPaths reference session data", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					name: "Unit",
					entity_id: "concat(#user/username, '-', today())",
					entity_name: "#user/username",
				},
			},
			"Weekly Report",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('id="commcaresession"');
	});

	it("does not emit Connect blocks when connect is absent", () => {
		const doc = makeConnectExpandDoc("learn", undefined, "ILC Training");
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).not.toContain("commcareconnect.com");
		expect(xml).not.toContain("connect_learn");
	});
});

// ── Validation ──────────────────────────────────────────────────────

/**
 * Build a one-module, one-form BlueprintDoc carrying the supplied Connect
 * config. Mirrors `makeConnectExpandDoc` but sized for the validator:
 * the validator reads the form's metadata + connect block, not the
 * field content, so tests inline minimal field sets where needed.
 */
function makeConnectValidationDoc(
	connectType: DomainConnectType,
	connect: ConnectConfig | undefined,
	formName = "Form",
	extraFields: FormSpec["fields"] = [],
) {
	return buildDoc({
		appName: "Connect Test App",
		connectType,
		modules: [
			{
				name: "Main",
				forms: [
					{
						name: formName,
						type: "survey",
						connect,
						fields: extraFields,
					},
				],
			},
		],
	});
}

describe("Connect validation", () => {
	it("validates learn form with neither learn_module nor assessment", () => {
		const doc = makeConnectValidationDoc("learn", {});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_LEARN")).toBe(true);
	});

	it("passes validation for learn form with only assessment", () => {
		const doc = makeConnectValidationDoc("learn", {
			assessment: { user_score: "100" },
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_LEARN")).toBe(false);
	});

	it("validates deliver form missing both deliver_unit and task", () => {
		const doc = makeConnectValidationDoc("deliver", {});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_DELIVER")).toBe(true);
	});

	it("passes validation for deliver form with only task", () => {
		const doc = makeConnectValidationDoc("deliver", {
			task: { name: "Delivery Task", description: "Complete the delivery" },
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_DELIVER")).toBe(
			false,
		);
	});

	it("passes validation for well-formed learn config", () => {
		const doc = makeConnectValidationDoc(
			"learn",
			{
				learn_module: { name: "Module", description: "Desc", time_estimate: 5 },
				assessment: { user_score: "100" },
			},
			"Form",
			[f({ kind: "text", id: "q", label: "Q" })],
		);
		const errors = runValidation(doc);
		expect(errors).toHaveLength(0);
	});

	it("passes validation for well-formed deliver config", () => {
		const doc = makeConnectValidationDoc(
			"deliver",
			{
				deliver_unit: {
					name: "Unit",
					entity_id: "concat('user', '-', today())",
					entity_name: "'test_user'",
				},
			},
			"Form",
			[f({ kind: "text", id: "q", label: "Q" })],
		);
		const errors = runValidation(doc);
		expect(errors).toHaveLength(0);
	});
});
