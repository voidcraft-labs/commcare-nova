import { describe, expect, it } from "vitest";
import {
	buildDoc,
	type FieldSpec,
	type FormSpec,
	f,
	xp,
} from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { ConnectConfig, ConnectType } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

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
					id: "main",
					name: "ILC Module",
					description: "Training for ILC",
					time_estimate: 5,
				},
			},
			"ILC Training",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		// The stored id is the wire element name — the resolver passes it
		// through verbatim (ids are valid by construction at the source).
		expect(xml).toContain('<main vellum:role="ConnectLearnModule">');
		expect(xml).toContain('xmlns="http://commcareconnect.com/data/v1/learn"');
		expect(xml).toContain("<name>ILC Module</name>");
		expect(xml).toContain("<description>Training for ILC</description>");
		expect(xml).toContain("<time_estimate>5</time_estimate>");
		expect(xml).toContain("</main>");
	});

	it("generates correct assessment block with calculate bind", () => {
		const doc = makeConnectExpandDoc(
			"learn",
			{
				learn_module: {
					id: "main",
					name: "Test",
					description: "Test",
					time_estimate: 1,
				},
				assessment: { id: "main_ilc_training", user_score: xp("100") },
			},
			"ILC Training",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain(
			'<main_ilc_training vellum:role="ConnectAssessment">',
		);
		expect(xml).toContain("<user_score/>");
		expect(xml).toContain(
			'nodeset="/data/main_ilc_training/assessment/user_score" calculate="100"',
		);
	});

	it("generates correct deliver unit block with XPath binds", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					id: "main",
					name: "Weekly Report",
					entity_id: xp("concat('user', '-', today())"),
					entity_name: xp("'test_user'"),
				},
			},
			"Weekly Report",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('<main vellum:role="ConnectDeliverUnit">');
		expect(xml).toContain(
			'<deliver xmlns="http://commcareconnect.com/data/v1/learn"',
		);
		expect(xml).toContain("<name>Weekly Report</name>");
		expect(xml).toContain("<entity_id/>");
		expect(xml).toContain("<entity_name/>");
		expect(xml).toContain('nodeset="/data/main/deliver/entity_id"');
		expect(xml).toContain('nodeset="/data/main/deliver/entity_name"');
	});

	it("generates task block", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					id: "main",
					name: "Unit",
					entity_id: xp("'id'"),
					entity_name: xp("'name'"),
				},
				task: {
					id: "main_weekly_report",
					name: "Delivery Task",
					description: "Complete the delivery",
				},
			},
			"Weekly Report",
		);
		const hq = expandDoc(doc);
		const xml = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('<main_weekly_report vellum:role="ConnectTask">');
		expect(xml).toContain("<name>Delivery Task</name>");
		expect(xml).toContain("<description>Complete the delivery</description>");
	});

	it("includes secondary instances when Connect XPaths reference session data", () => {
		const doc = makeConnectExpandDoc(
			"deliver",
			{
				deliver_unit: {
					id: "main",
					name: "Unit",
					entity_id: xp("concat(#user/username, '-', today())"),
					entity_name: xp("#user/username"),
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
	connectType: ConnectType,
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
	it("passes validation for well-formed learn config", () => {
		// The stored schema requires every present block's id.
		const doc = makeConnectValidationDoc(
			"learn",
			{
				learn_module: {
					id: "module",
					name: "Module",
					description: "Desc",
					time_estimate: 5,
				},
				assessment: { id: "module_quiz", user_score: xp("100") },
			},
			"Form",
			[f({ kind: "text", id: "q", label: proseText("Q") })],
		);
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors).toHaveLength(0);
	});

	it("passes validation for well-formed deliver config", () => {
		const doc = makeConnectValidationDoc(
			"deliver",
			{
				deliver_unit: {
					id: "unit",
					name: "Unit",
					entity_id: xp("concat('user', '-', today())"),
					entity_name: xp("'test_user'"),
				},
			},
			"Form",
			[f({ kind: "text", id: "q", label: proseText("Q") })],
		);
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors).toHaveLength(0);
	});
});
