import { type Element, isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	type CaseListConfigSpec,
	caseListConfig,
	type DocSpec,
	f,
	resolveCaseListConfig,
	xp,
} from "@/lib/__tests__/docHelpers";
import { expandDoc as projectUncheckedDoc } from "@/lib/commcare/expander";
import { expandCaseToWire } from "@/lib/commcare/hashtags";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { lowerXPathForJavaRosa } from "@/lib/commcare/xpath";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	blueprintDocSchema,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	linkColumn,
	type Module,
	type ProseTemplate,
	phoneColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	dateLiteral,
	eq,
	literal,
	matchAll,
	prop,
	relationStep,
	sessionUser,
	term,
	today,
	toValueExpression,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { captureExpanderEvidence } from "./expanderEvidence";

function expandDoc(doc: BlueprintDoc) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = projectUncheckedDoc(doc);
	captureExpanderEvidence(doc, hq);
	return hq;
}

function prose(...parts: ProseTemplate["parts"]): ProseTemplate {
	return { parts };
}

function elements(xml: string, name?: string): Element[] {
	return findAll(
		(element) => name === undefined || element.name === name,
		parseDocument(xml, { xmlMode: true }).children,
	);
}
function one(
	xml: string,
	name: string,
	attributes: Record<string, string> = {},
): Element {
	const matches = elements(xml, name).filter((element) =>
		Object.entries(attributes).every(
			([key, value]) => element.attribs[key] === value,
		),
	);
	expect(matches, `${name} ${JSON.stringify(attributes)}`).toHaveLength(1);
	return matches[0];
}
function values(xml: string, id: string): Element[] {
	return one(xml, "text", { id }).children.filter(
		(node): node is Element => isTag(node) && node.name === "value",
	);
}
function proseParts(value: Element): unknown[] {
	return value.children.map((node) =>
		isTag(node)
			? { element: node.name, attributes: node.attribs }
			: textContent(node),
	);
}
function itextValues(xml: string, id: string) {
	return values(xml, id).map((value) => ({
		form: value.attribs.form ?? "plain",
		parts: proseParts(value),
	}));
}

function expectProse(xml: string, id: string, parts: unknown[]) {
	expect(itextValues(xml, id)).toEqual(
		["plain", "markdown"].map((form) => ({ form, parts })),
	);
}
function caseOutput(property: string) {
	return {
		element: "output",
		attributes: {
			value: `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/${property}`,
			"vellum:value": `#case/${property}`,
		},
	};
}
function expectChoices(
	xml: string,
	path: string,
	choices: readonly (readonly [string, string, string])[],
) {
	const control = elements(xml).filter(
		(element) =>
			(element.name === "select1" || element.name === "select") &&
			element.attribs.ref === path,
	);
	expect(control).toHaveLength(1);
	const items = control[0].children.filter(
		(child): child is Element => isTag(child) && child.name === "item",
	);
	expect(
		items.map((item) =>
			item.children.filter(isTag).map((child) => ({
				name: child.name,
				attributes: child.attribs,
				text: textContent(child),
			})),
		),
	).toEqual(
		choices.map(([id, value]) => [
			{ name: "label", attributes: { ref: `jr:itext('${id}')` }, text: "" },
			{ name: "value", attributes: {}, text: value },
		]),
	);
	for (const [id, , label] of choices) expectProse(xml, id, [label]);
}

describe("display-condition HQ projection", () => {
	it("projects typed module/form conditions and selects the menu-instance build", () => {
		const displayDoc = buildDoc({
			appName: "Conditional navigation",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					displayCondition: eq(sessionUser("role"), literal("supervisor")),
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "notes", label: proseText("Notes") }),
							],
							displayCondition: eq(prop("patient", "status"), literal("open")),
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "status", label: proseText("Status") }],
				},
			],
		});
		const hq = expandDoc(displayDoc);
		expect(hq.build_spec.version).toBe("2.54.0");
		expect(hq.modules[0].module_filter).toBe(
			"instance('commcaresession')/session/user/data/role = 'supervisor'",
		);
		expect(hq.modules[0].forms[0].form_filter).toBe("#case/@status = 'open'");
	});

	it("folds always-true conditions to null in HQ shells", () => {
		const displayDoc = buildDoc({
			modules: [
				{
					name: "Surveys",
					displayCondition: matchAll(),
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({ kind: "text", id: "notes", label: proseText("Notes") }),
							],
							displayCondition: matchAll(),
						},
					],
				},
			],
		});
		const hq = expandDoc(displayDoc);
		expect(hq.modules[0].module_filter).toBeNull();
		expect(hq.modules[0].forms[0].form_filter).toBeNull();
	});
});

// Shared fixtures used across the main expander cases below. Each test
// outside this block constructs its own fixture inline to keep the
// given-when-then narrative next to the assertion.
const followupDoc = buildDoc({
	appName: "Test App",
	modules: [
		{
			name: "Visits",
			caseType: "patient",
			caseListConfig: caseListConfig([{ field: "full_name", header: "Name" }]),
			forms: [
				{
					name: "Follow-up Visit",
					type: "followup",
					fields: [
						f({
							kind: "group",
							id: "client_info",
							label: proseText("Client Info"),
							children: [
								f({
									kind: "text",
									id: "full_name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "full_name" },
								}),
							],
						}),
						f({
							kind: "hidden",
							id: "total_visits",
							calculate: "#patient/total_visits + 1",
							caseWrite: { caseType: "patient", property: "total_visits" },
						}),
						f({ kind: "text", id: "notes", label: proseText("Notes") }),
					],
				},
			],
		},
	],
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "full_name", label: proseText("Full Name") },
				{ name: "total_visits", label: proseText("Total Visits") },
			],
		},
	],
});

const registrationDoc = buildDoc({
	appName: "Reg App",
	modules: [
		{
			name: "Registration",
			caseType: "patient",
			caseListConfig: caseListConfig([
				{ field: "case_name", header: "Name" },
				{ field: "age", header: "Age" },
			]),
			forms: [
				{
					name: "Register Patient",
					type: "registration",
					fields: [
						f({
							kind: "text",
							id: "case_name",
							label: proseText("Full Name"),
							required: "true()",
							caseWrite: { caseType: "patient", property: "case_name" },
						}),
						f({
							kind: "int",
							id: "age",
							label: proseText("Age"),
							validate: ". > 0 and . < 150",
							caseWrite: { caseType: "patient", property: "age" },
						}),
						f({
							kind: "hidden",
							id: "risk",
							calculate: "if(/data/age > 65, 'high', 'low')",
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
				{ name: "case_name", label: proseText("Full Name") },
				{ name: "age", label: proseText("Age") },
			],
		},
	],
});

describe("expandDoc", () => {
	it("projects typed case refs into HQ's private #case load vocabulary", () => {
		const hq = expandDoc(followupDoc);
		const form = hq.modules[0].forms[0];
		const load = form.case_references_data.load;

		expect(load["/data/total_visits"]).toEqual(["#case/total_visits"]);
		// Fields without hashtags should not appear in load
		expect(load["/data/notes"]).toBeUndefined();
	});

	it("leaves case_references_data.load empty when no hashtags exist", () => {
		const hq = expandDoc(registrationDoc);
		const form = hq.modules[0].forms[0];

		expect(form.case_references_data.load).toEqual({});
	});

	it("resolves nested field paths in case_references_data", () => {
		const doc = buildDoc({
			appName: "Nested",
			modules: [
				{
					name: "M",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "group",
									id: "grp",
									label: proseText("G"),
									children: [
										f({
											kind: "hidden",
											id: "some_prop",
											calculate: "#patient/some_prop + #user/role",
											caseWrite: {
												caseType: "patient",
												property: "some_prop",
											},
										}),
									],
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "some_prop", label: proseText("Some Prop") }],
				},
			],
		});
		const load = expandDoc(doc).modules[0].forms[0].case_references_data.load;
		expect(load["/data/grp/some_prop"]).toEqual(
			expect.arrayContaining(["#case/some_prop", "#user/role"]),
		);
	});

	it("expands a typed case ref and emits private HQ editor shorthand", () => {
		const hq = expandDoc(followupDoc);
		const xform: string = Object.values(hq._attachments)[0] as string;

		expect(
			one(xform, "bind", { nodeset: "/data/total_visits" }).attribs,
		).toMatchObject({
			calculate:
				"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/total_visits + 1",
			"vellum:calculate": "#case/total_visits + 1",
		});
		expect(one(xform, "vellum:hashtags").parent).toMatchObject({
			name: "h:head",
		});
		expect(
			JSON.parse(textContent(one(xform, "vellum:hashtags")))[
				"#case/total_visits"
			],
		).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/total_visits",
		);
		expect(
			JSON.parse(textContent(one(xform, "vellum:hashtagTransforms"))).prefixes[
				"#case/"
			],
		).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/",
		);
		expect(
			elements(xform).filter(
				(element) =>
					"vellum:hashtags" in element.attribs ||
					"vellum:hashtagTransforms" in element.attribs,
			),
		).toEqual([]);
	});

	it("wires registration form actions correctly", () => {
		const hq = expandDoc(registrationDoc);
		const actions = hq.modules[0].forms[0].actions;

		expect(actions.open_case.condition.type).toBe("always");
		expect(actions.open_case.name_update.question_path).toBe("/data/case_name");
		expect(actions.update_case.update.age.question_path).toBe("/data/age");
	});

	it("wires followup preload and update actions correctly", () => {
		const hq = expandDoc(followupDoc);
		const actions = hq.modules[0].forms[0].actions;

		expect(actions.open_case.condition.type).toBe("never");
		expect(actions.case_preload.condition.type).toBe("always");
		expect(actions.case_preload.preload["/data/total_visits"]).toBe(
			"total_visits",
		);
		// Nested field paths should be resolved
		expect(actions.case_preload.preload["/data/client_info/full_name"]).toBe(
			"full_name",
		);
		expect(actions.update_case.update.total_visits.question_path).toBe(
			"/data/total_visits",
		);
	});

	it("generates XForm with setvalue for default_value", () => {
		const doc = buildDoc({
			appName: "DV",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "hidden",
									id: "status",
									calculate: "'pending'",
									default_value: "'pending'",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(one(xform, "setvalue", { ref: "/data/status" }).attribs).toEqual({
			"vellum:ref": "#form/status",
			ref: "/data/status",
			value: "'pending'",
			event: "xforms-ready",
		});
	});

	it("expands a typed case ref in default_value and emits HQ editor shorthand", () => {
		const doc = buildDoc({
			appName: "DV",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "full_name",
									label: proseText("Name"),
									default_value: "#c/full_name",
									caseWrite: { caseType: "c", property: "full_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "c",
					properties: [{ name: "full_name", label: proseText("Full Name") }],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "setvalue", { ref: "/data/full_name" }).attribs,
		).toMatchObject({
			value:
				"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/full_name",
			"vellum:value": "#case/full_name",
			event: "xforms-ready",
		});
	});

	it("omits itext label for hidden fields without a label", () => {
		const hq = expandDoc(followupDoc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			elements(xform, "text").map((element) => element.attribs.id),
		).not.toContain("total_visits-label");
		expect(itextValues(xform, "notes-label")).toEqual([
			{ form: "plain", parts: ["Notes"] },
			{ form: "markdown", parts: ["Notes"] },
		]);
	});

	it("handles close forms — conditional and unconditional", () => {
		const doc = buildDoc({
			appName: "Close",
			modules: [
				{
					name: "M",
					caseType: "record",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Conditional Close",
							type: "close",
							closeCondition: { field: "confirm", answer: "yes" },
							fields: [
								f({
									kind: "single_select",
									id: "confirm",
									label: proseText("Close?"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
							],
						},
						{
							name: "Always Close",
							type: "close",
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "record",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "dob", label: proseText("Birth date"), data_type: "date" },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		/* Conditional close form → "if" condition */
		expect(hq.modules[0].forms[0].actions.close_case.condition.type).toBe("if");
		expect(hq.modules[0].forms[0].actions.close_case.condition.answer).toBe(
			"yes",
		);
		/* Unconditional close form → "always" condition */
		expect(hq.modules[0].forms[1].actions.close_case.condition.type).toBe(
			"always",
		);
		/* Close forms require a case datum (requires: "case") */
		expect(hq.modules[0].forms[0].requires).toBe("case");
		expect(hq.modules[0].forms[1].requires).toBe("case");
	});
});

describe("case_name in case list columns", () => {
	const doc = buildDoc({
		appName: "CL",
		modules: [
			{
				name: "M",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Full Name" },
					{ field: "age", header: "Age" },
				]),
				forms: [
					{
						name: "F",
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
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "dob", label: proseText("Birth date"), data_type: "date" },
				],
			},
		],
	});

	it("expander keeps case_name column in case details", () => {
		const hq = expandDoc(doc);
		const cols = hq.modules[0].case_details.short.columns;
		expect(cols.some((c) => c.field === "case_name")).toBe(true);
	});

	it("validator allows case_name in case_list_columns", () => {
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "RESERVED_CASE_PROPERTY",
			),
		).toBe(false);
	});
});

describe("registration admission", () => {
	it.each(["case-type", "reserved-property", "name-write"] as const)(
		"rejects one %s corruption of an admitted registration",
		(fault) => {
			const doc = structuredClone(registrationDoc);
			expandDoc(doc);
			const module = doc.modules[doc.moduleOrder[0]];
			const field = Object.values(doc.fields).find(
				(field) => field.id === "case_name",
			);
			if (!field || !("caseWrite" in field) || !field.caseWrite)
				throw new Error("Missing case-name writer");
			if (fault === "case-type") delete module.caseType;
			else if (fault === "reserved-property") field.caseWrite.property = "name";
			else delete field.caseWrite;
			const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			expect(findings.map((finding) => finding.code)).toEqual(
				fault === "case-type"
					? [
							"NO_CASE_TYPE",
							"CASE_WRITE_NO_CASE_ACTION",
							"CASE_WRITE_NO_CASE_ACTION",
						]
					: fault === "reserved-property"
						? ["CASE_CREATE_NAME_MISSING", "RESERVED_CASE_PROPERTY"]
						: ["CASE_CREATE_NAME_MISSING"],
			);
		},
	);
});

// ── Feature 1: Output References in Labels ──────────────────────────────

describe("output references in labels", () => {
	// Authoring surfaces turn friendly hashtags (`#form/name`,
	// `#patient/prop`) into typed prose refs; the emitter lowers those refs into
	// `<output>` elements.
	// Raw `<output ...>` markup is NOT a supported authoring input — a label
	// that literally contains it is prose and serializes as escaped text.
	it("escapes author-written <output> markup as literal label text", () => {
		const doc = buildDoc({
			appName: "Output",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "name", label: proseText("Name") }),
								f({
									kind: "label",
									id: "greeting",
									label: proseText(
										'Hello <output value="/data/name"/>, welcome!',
									),
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "greeting-label", [
			'Hello <output value="/data/name"/>, welcome!',
		]);
		expect(elements(xform, "output")).toEqual([]);
	});

	it("expands a typed current-case ref in label prose into an <output>", () => {
		const doc = buildDoc({
			appName: "Output",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "full_name",
									label: proseText("Name"),
									caseWrite: { caseType: "c", property: "full_name" },
								}),
								f({
									kind: "label",
									id: "msg",
									label: prose(
										{ kind: "text", text: "Patient: " },
										{
											kind: "case-ref",
											caseType: "c",
											property: "full_name",
										},
									),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "c",
					properties: [{ name: "full_name", label: proseText("Full Name") }],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "msg-label", ["Patient: ", caseOutput("full_name")]);
	});

	it("lowers several typed current-case refs with expanded XPath", () => {
		const doc = buildDoc({
			appName: "BareRef",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "c", property: "case_name" },
								}),
								f({
									kind: "date",
									id: "start_date",
									label: proseText("Start"),
									caseWrite: { caseType: "c", property: "start_date" },
								}),
								f({
									kind: "date",
									id: "end_date",
									label: proseText("End"),
									caseWrite: { caseType: "c", property: "end_date" },
								}),
								f({
									kind: "label",
									id: "summary",
									label: prose(
										{ kind: "text", text: "Plan: **" },
										{
											kind: "case-ref",
											caseType: "c",
											property: "case_name",
										},
										{ kind: "text", text: "**, from " },
										{
											kind: "case-ref",
											caseType: "c",
											property: "start_date",
										},
										{ kind: "text", text: " to " },
										{
											kind: "case-ref",
											caseType: "c",
											property: "end_date",
										},
									),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "c",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "start_date", label: proseText("Start") },
						{ name: "end_date", label: proseText("End") },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "summary-label", [
			"Plan: **",
			caseOutput("case_name"),
			"**, from ",
			caseOutput("start_date"),
			" to ",
			caseOutput("end_date"),
		]);
	});

	it("lowers a typed form-field ref in label text", () => {
		const userNameUuid = testUuid("bare-form.user-name");
		const doc = buildDoc({
			appName: "BareForm",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "user_name",
									uuid: userNameUuid,
									label: proseText("Your name"),
								}),
								f({
									kind: "label",
									id: "greeting",
									label: prose(
										{ kind: "text", text: "Hello " },
										{ kind: "field-ref", uuid: userNameUuid },
										{ kind: "text", text: "!" },
									),
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "greeting-label", [
			"Hello ",
			{
				element: "output",
				attributes: {
					value: "/data/user_name",
					"vellum:value": "#form/user_name",
				},
			},
			"!",
		]);
	});

	it("lowers multiple typed current-case refs in one label", () => {
		const doc = buildDoc({
			appName: "Mixed",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "c", property: "case_name" },
								}),
								f({
									kind: "text",
									id: "status",
									label: proseText("Status"),
									caseWrite: {
										caseType: "c",
										property: "workflow_status",
									},
								}),
								f({
									kind: "label",
									id: "info",
									label: prose(
										{ kind: "text", text: "Hello " },
										{
											kind: "case-ref",
											caseType: "c",
											property: "case_name",
										},
										{ kind: "text", text: ", status: " },
										{
											kind: "case-ref",
											caseType: "c",
											property: "workflow_status",
										},
									),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "c",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "workflow_status", label: proseText("Status") },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "info-label", [
			"Hello ",
			caseOutput("case_name"),
			", status: ",
			caseOutput("workflow_status"),
		]);
	});
});

// ── Label/hint prose is XML-entity-escaped (issues #3 + #15) ─────────────
//
// Author prose is natural language, not markup. A bare `<` / `>` / `&` in a
// label must reach the wire as `&lt;` / `&gt;` / `&amp;` so JavaRosa's XForm
// parser accepts the itext `<value>` and so the literal characters render on
// device — never consumed as a bogus tag. The emitter builds the itext value
// by DOM construction (Text nodes for prose + constructed `<output>`
// elements for hashtag refs) and serializes once, so dom-serializer owns all
// escaping. `<output>` elements come ONLY from hashtag refs Nova lowers; a
// label that literally contains `<output ...>` text is prose and escapes.

describe("label/hint prose entity escaping", () => {
	/** Pull the first form's XForm XML out of an expanded HQ application. */
	function firstFormXml(doc: ReturnType<typeof buildDoc>): string {
		const first = Object.values(expandDoc(doc)._attachments)[0];
		if (typeof first !== "string") {
			throw new Error("expected the first attachment to be the XForm XML");
		}
		return first;
	}

	/** Build a single-survey doc whose only field is a label carrying `text`. */
	function labelDoc(text: string): ReturnType<typeof buildDoc> {
		return buildDoc({
			appName: "Prose",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [f({ kind: "label", id: "note", label: text })],
						},
					],
				},
			],
		});
	}

	it("escapes a tag-like `<` / `>` run that htmlparser2 would otherwise eat", () => {
		// Issue #3: `(<2kg, …, >10kg)` previously parsed as a bogus tag, leaking
		// a bare `<` to the wire that CommCare HQ hard-rejects.
		const xml = firstFormXml(labelDoc("(<2kg, 2-10kg, >10kg)"));
		expectProse(xml, "note-label", ["(<2kg, 2-10kg, >10kg)"]);
		expect(elements(xml, "output")).toEqual([]);
	});

	it("escapes a bare ampersand to `&amp;`", () => {
		const xml = firstFormXml(labelDoc("Tom & Jerry"));
		expectProse(xml, "note-label", ["Tom & Jerry"]);
		expect(elements(xml, "output")).toEqual([]);
	});

	it("escapes both comparison operators in prose", () => {
		const xml = firstFormXml(labelDoc("Rating < 100 and > 50"));
		expectProse(xml, "note-label", ["Rating < 100 and > 50"]);
		expect(elements(xml, "output")).toEqual([]);
	});

	it("expands a typed case ref in mixed prose while escaping surrounding `<`", () => {
		// Issue #15: a label combining prose with a `<` AND a hashtag ref must
		// escape the prose `<` (no bogus tag / no itext corruption) while
		// lowering the hashtag into a real <output> element with the expanded
		// XPath + `vellum:value` shorthand.
		const doc = buildDoc({
			appName: "Mixed prose",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "full_name",
									label: proseText("Name"),
									caseWrite: { caseType: "c", property: "full_name" },
								}),
								f({
									kind: "label",
									id: "msg",
									label: prose(
										{ kind: "text", text: "Weight < 5kg for " },
										{
											kind: "case-ref",
											caseType: "c",
											property: "full_name",
										},
									),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "c",
					properties: [{ name: "full_name", label: proseText("Full Name") }],
				},
			],
		});
		const xml = firstFormXml(doc);
		expectProse(xml, "msg-label", [
			"Weight < 5kg for ",
			caseOutput("full_name"),
		]);
	});

	it("escapes author-written `<output>` markup as literal text (new contract)", () => {
		// `<output>` is NOT a supported authoring input — only hashtag refs
		// are. A label that literally contains `<output ...>` text is prose,
		// so it must serialize as escaped literal text (well-formed), NOT be
		// honored as a real element. This documents the post-fix contract.
		const xml = firstFormXml(labelDoc('See <output value="x"/> here'));
		expectProse(xml, "note-label", ['See <output value="x"/> here']);
		expect(elements(xml, "output")).toEqual([]);
	});

	it("still expands a typed case ref in prose (regression)", () => {
		const doc = buildDoc({
			appName: "Bare in prose",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: proseText("Name"),
									caseWrite: { caseType: "c", property: "display_name" },
								}),
								f({
									kind: "label",
									id: "hi",
									label: prose(
										{ kind: "text", text: "Hello " },
										{
											kind: "case-ref",
											caseType: "c",
											property: "display_name",
										},
									),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "c",
					properties: [{ name: "display_name", label: proseText("Name") }],
				},
			],
		});
		const xml = firstFormXml(doc);
		expectProse(xml, "hi-label", ["Hello ", caseOutput("display_name")]);
	});

	it("round-trips a pre-escaped `&lt;` without double-escaping (regression)", () => {
		// The historical workaround: authors pre-escaped `<` as `&lt;`. After
		// the fix, decode-then-escape keeps the on-wire byte at exactly `&lt;`
		// (not `&amp;lt;`), so the display still shows `<`.
		const xml = firstFormXml(labelDoc("Less than &lt; threshold"));
		expectProse(xml, "note-label", ["Less than < threshold"]);
		expect(elements(xml, "output")).toEqual([]);
	});
});

// ── Select option itext ids keyed by index, not value (issue #10) ────────
//
// Two options sharing the same `value` previously collapsed onto one itext
// id (`${field.id}-${opt.value}-label`), making CommCare's XForm parser
// throw `duplicate definition for text ID` (verified against
// commcare-core XFormParser.java::parseTranslation). Keying the id by the
// option's stable array index makes the ids unique regardless of value.
// JavaRosa accepts two `<item>`s sharing a `<value>`
// (XFormParser.java::parseItem adds each SelectChoice with no value-
// uniqueness check) — the collision was purely in the itext layer.

describe("select option itext ids — index-keyed (issue #10)", () => {
	function firstFormXml(doc: ReturnType<typeof buildDoc>): string {
		const first = Object.values(expandDoc(doc)._attachments)[0];
		if (typeof first !== "string") {
			throw new Error("expected the first attachment to be the XForm XML");
		}
		return first;
	}

	it("single_select with duplicate option values emits distinct itext ids", () => {
		const doc = buildDoc({
			appName: "Dup single",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "rating",
									label: proseText("Rating"),
									// Both options carry value "3" — the bug trigger.
									options: [
										{ value: "3", label: "Three (low scale)" },
										{ value: "3", label: "Three (high scale)" },
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		expectChoices(xml, "/data/rating", [
			["rating-opt0-label", "3", "Three (low scale)"],
			["rating-opt1-label", "3", "Three (high scale)"],
		]);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("multi_select with duplicate option values emits distinct itext ids", () => {
		const doc = buildDoc({
			appName: "Dup multi",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "multi_select",
									id: "tags",
									label: proseText("Tags"),
									options: [
										{ value: "x", label: "First X" },
										{ value: "x", label: "Second X" },
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		expectChoices(xml, "/data/tags", [
			["tags-opt0-label", "x", "First X"],
			["tags-opt1-label", "x", "Second X"],
		]);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});

	it("distinct-value single_select still emits one item + ref per option (regression)", () => {
		const doc = buildDoc({
			appName: "Distinct",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "confirm",
									label: proseText("Confirm?"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = firstFormXml(doc);
		// Index-keyed ids, one per option, refs and values aligned.
		expectChoices(xml, "/data/confirm", [
			["confirm-opt0-label", "yes", "Yes"],
			["confirm-opt1-label", "no", "No"],
		]);
		expect(validateXForm(xml, "F", "M")).toEqual([]);
	});
});

// ── Markdown itext for all field kinds ───────────────────────────────────

describe("markdown itext for all field kinds", () => {
	it("emits markdown form for regular text field labels", () => {
		const doc = buildDoc({
			appName: "MD",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: proseText("Enter your **full name**"),
								}),
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;
		expectProse(xform, "name-label", ["Enter your **full name**"]);
	});

	it("emits markdown form for select field labels and option labels", () => {
		const doc = buildDoc({
			appName: "MD",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "status",
									label: proseText("Current **status**"),
									options: [
										{
											value: "active",
											label: "**Active** — currently enrolled",
										},
										{ value: "inactive", label: "_Inactive_" },
									],
								}),
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;
		// Field label
		expectProse(xform, "status-label", ["Current **status**"]);
		expectProse(xform, "status-opt0-label", [
			"**Active** — currently enrolled",
		]);
		expectProse(xform, "status-opt1-label", ["_Inactive_"]);
	});

	it("emits markdown form for hint text", () => {
		const doc = buildDoc({
			appName: "MD",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									hint: proseText("Enter age in **years**"),
								}),
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;
		expectProse(xform, "age-hint", ["Enter age in **years**"]);
	});

	it("emits markdown form for group labels", () => {
		const doc = buildDoc({
			appName: "MD",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "demographics",
									label: proseText("## Demographics"),
									children: [
										f({ kind: "text", id: "name", label: proseText("Name") }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;
		expectProse(xform, "demographics-label", ["## Demographics"]);
	});

	it("emits markdown form for repeat group labels", () => {
		const doc = buildDoc({
			appName: "MD",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "children",
									label: proseText("Add **child** details"),
									children: [
										f({
											kind: "text",
											id: "child_name",
											label: proseText("Child name"),
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;
		expectProse(xform, "children-label", ["Add **child** details"]);
	});

	it("emits markdown form for date, decimal, and media field labels", () => {
		const doc = buildDoc({
			appName: "MD",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "date",
									id: "visit_date",
									label: proseText("Date of **visit**"),
								}),
								f({
									kind: "decimal",
									id: "weight",
									label: proseText("Weight _(kg)_"),
								}),
								f({
									kind: "image",
									id: "photo",
									label: proseText("Take a **photo**"),
								}),
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;
		expectProse(xform, "visit_date-label", ["Date of **visit**"]);
		expectProse(xform, "weight-label", ["Weight _(kg)_"]);
		expectProse(xform, "photo-label", ["Take a **photo**"]);
	});
});

// ── #form/ hashtag expansion ─────────────────────────────────────────────

describe("#form/ hashtag expansion", () => {
	it("expands #form/ in calculate to /data/, keeps shorthand in vellum:calculate", () => {
		const doc = buildDoc({
			appName: "FormRef",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "first_name",
									label: proseText("First"),
								}),
								f({ kind: "text", id: "last_name", label: proseText("Last") }),
								f({
									kind: "hidden",
									id: "full_name",
									calculate:
										"normalize-space(concat(#form/first_name, ' ', #form/last_name))",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		const bind = one(xform, "bind", { nodeset: "/data/full_name" });
		expect(bind.attribs.calculate).toBe(
			lowerXPathForJavaRosa(
				"normalize-space(concat(/data/first_name, ' ', /data/last_name))",
			),
		);
		expect(bind.attribs["vellum:calculate"]).toBe(
			lowerXPathForJavaRosa(
				"normalize-space(concat(#form/first_name, ' ', #form/last_name))",
			),
		);
	});

	it("expands #form/ in relevant to /data/, keeps shorthand in vellum:relevant", () => {
		const doc = buildDoc({
			appName: "FormRef",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "consent",
									label: proseText("Consent?"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
								f({
									kind: "text",
									id: "details",
									label: proseText("Details"),
									relevant: "#form/consent = 'yes'",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "bind", { nodeset: "/data/details" }).attribs,
		).toMatchObject({
			relevant: "/data/consent = 'yes'",
			"vellum:relevant": "#form/consent = 'yes'",
		});
	});

	it("expands #form/ in validation constraint", () => {
		const doc = buildDoc({
			appName: "FormRef",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "date",
									id: "start_date",
									label: proseText("Start"),
								}),
								f({
									kind: "date",
									id: "end_date",
									label: proseText("End"),
									validate: ". >= #form/start_date",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "bind", { nodeset: "/data/end_date" }).attribs,
		).toMatchObject({
			constraint: ". >= /data/start_date",
			"vellum:constraint": ". >= #form/start_date",
		});
	});

	// Regression: validate_msg must round-trip through CommCare HQ.
	//
	// HQ's XForm parser
	// (`corehq/apps/app_manager/xform.py::XForm.get_questions` —
	// inside the inner `_get_select_question_option`, where the
	// `'{jr}constraintMsg'` lookup lives) only reads `jr:constraintMsg`
	// when it points at an itext id via `jr:itext(...)` —
	// inline text values are silently dropped at import time. The expander
	// must therefore (a) emit the bind attribute as an itext reference and
	// (b) register a matching `<text>` entry in the form's translation block.
	// Previously we emitted the literal string as the attribute value, which
	// is why the message vanished after upload.
	it("emits validate_msg as an itext-referenced constraintMsg", () => {
		const doc = buildDoc({
			appName: "ValMsg",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									validate: ". > 0 and . < 150",
									validate_msg: proseText("Age must be between 1 and 149"),
								}),
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;

		expect(
			one(xform, "bind", { nodeset: "/data/age" }).attribs["jr:constraintMsg"],
		).toBe("jr:itext('age-constraintMsg')");
		expectProse(xform, "age-constraintMsg", ["Age must be between 1 and 149"]);
	});

	// Regression: validation is only legal on input field kinds.
	//
	// Hidden fields are computed from `calculate`/`default_value`, so the
	// user can never see or correct a failing constraint — a `validate_msg`
	// on them is dead metadata. Structural containers (group/repeat) and
	// display-only labels similarly can't surface an error. The XForm
	// emitter drops both the bind attributes and the itext entry for these
	// kinds so a stale `validate_msg` can't leak into HQ.

	it("expands #form/ in required condition", () => {
		const doc = buildDoc({
			appName: "FormRef",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "has_issue",
									label: proseText("Issue?"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
								f({
									kind: "text",
									id: "details",
									label: proseText("Details"),
									required: "#form/has_issue = 'yes'",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "bind", { nodeset: "/data/details" }).attribs,
		).toMatchObject({
			required: "/data/has_issue = 'yes'",
			"vellum:requiredCondition": "#form/has_issue = 'yes'",
		});
	});

	it("lowers a typed form-field prose ref with vellum:value", () => {
		const textValueUuid = testUuid("form-ref.text-value");
		const doc = buildDoc({
			appName: "FormRef",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "hidden",
									id: "text_value",
									uuid: textValueUuid,
									calculate: "'Text'",
									default_value: "'Text'",
								}),
								f({
									kind: "label",
									id: "here",
									label: prose(
										{ kind: "text", text: "Here " },
										{ kind: "field-ref", uuid: textValueUuid },
									),
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "here-label", [
			"Here ",
			{
				element: "output",
				attributes: {
					value: "/data/text_value",
					"vellum:value": "#form/text_value",
				},
			},
		]);
	});

	it("expands #form/ in default_value setvalue", () => {
		const doc = buildDoc({
			appName: "FormRef",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "int", id: "score_a", label: proseText("Score A") }),
								f({ kind: "int", id: "score_b", label: proseText("Score B") }),
								f({
									kind: "hidden",
									id: "total",
									calculate: "#form/score_a + #form/score_b",
									default_value: "#form/score_a + #form/score_b",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "setvalue", { ref: "/data/total" }).attribs,
		).toMatchObject({
			value: "/data/score_a + /data/score_b",
			"vellum:value": "#form/score_a + #form/score_b",
			event: "xforms-ready",
		});
	});

	it("generates vellum:nodeset on all binds", () => {
		const doc = buildDoc({
			appName: "VN",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "text", id: "name", label: proseText("Name") }),
								f({ kind: "int", id: "age", label: proseText("Age") }),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(elements(xform, "bind").map((bind) => bind.attribs)).toEqual([
			{
				nodeset: "/data/name",
				"vellum:nodeset": "#form/name",
				type: "xsd:string",
			},
			{ nodeset: "/data/age", "vellum:nodeset": "#form/age", type: "xsd:int" },
		]);
	});

	it("generates vellum:nodeset for nested fields in groups", () => {
		const doc = buildDoc({
			appName: "VN",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "grp",
									label: proseText("Group"),
									children: [
										f({ kind: "text", id: "inner", label: proseText("Inner") }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "bind", { nodeset: "/data/grp/inner" }).attribs,
		).toMatchObject({ "vellum:nodeset": "#form/grp/inner" });
	});

	it("generates vellum:ref on setvalue elements", () => {
		const doc = buildDoc({
			appName: "VR",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "hidden",
									id: "ts",
									calculate: "now()",
									default_value: "now()",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(one(xform, "setvalue", { ref: "/data/ts" }).attribs).toEqual({
			ref: "/data/ts",
			"vellum:ref": "#form/ts",
			value: "now()",
			event: "xforms-ready",
		});
	});

	it("expands #form/ in group relevant and adds vellum attributes", () => {
		const doc = buildDoc({
			appName: "GR",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "show",
									label: proseText("Show?"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
								f({
									kind: "group",
									id: "details",
									label: proseText("Details"),
									relevant: "#form/show = 'yes'",
									children: [
										f({ kind: "text", id: "info", label: proseText("Info") }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "bind", { nodeset: "/data/details" }).attribs,
		).toMatchObject({
			relevant: "/data/show = 'yes'",
			"vellum:relevant": "#form/show = 'yes'",
			"vellum:nodeset": "#form/details",
		});
	});

	it("does not add vellum:hashtags or vellum:hashtagTransforms for #form/-only expressions", () => {
		const doc = buildDoc({
			appName: "FormRef",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "int", id: "a", label: proseText("A") }),
								f({
									kind: "hidden",
									id: "b",
									calculate: "#form/a * 2",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(elements(xform, "vellum:hashtags")).toEqual([]);
		expect(elements(xform, "vellum:hashtagTransforms")).toEqual([]);
		expect(one(xform, "bind", { nodeset: "/data/b" }).attribs).toMatchObject({
			calculate: "/data/a * 2",
			"vellum:calculate": "#form/a * 2",
		});
	});

	it("resolves a typed case ref to the private HQ parent-index wire walk", () => {
		// `pregnancy` (own, depth 0) → `mother` (parent, depth 1). A field's
		// calculate reads the mother's household_code via the per-type namespace;
		// the wire XPath must be the depth-1 parent-index walk, byte-identical to
		// the private HQ `#case/parent/household_code` projection names. This is
		// also the casedb-instance guard: the only authored case reference here
		// is `#mother/...`, so a
		// missing instance declaration would emit a casedb lookup with no source.
		const doc = buildDoc({
			appName: "CaseTypeRefs",
			modules: [
				{
					name: "Pregnancies",
					caseType: "pregnancy",
					caseListConfig: caseListConfig([{ field: "ga", header: "GA" }]),
					forms: [
						{
							name: "ANC Visit",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "mother_code",
									calculate: "#mother/household_code",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "pregnancy",
					parent_type: "mother",
					properties: [{ name: "ga", label: proseText("GA") }],
				},
				{
					name: "mother",
					properties: [
						{ name: "household_code", label: proseText("Household Code") },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;
		const bind = one(xform, "bind", { nodeset: "/data/mother_code" });
		expect(bind.attribs.calculate).toBe(expandCaseToWire(1, "household_code"));
		expect(bind.attribs["vellum:calculate"]).toBeUndefined();
		expect(one(xform, "instance", { id: "casedb" }).attribs.src).toBe(
			"jr://instance/casedb",
		);
	});

	it("lowers a #<case_type>/<prop> prose label ref to an <output> with the parent-index walk", () => {
		const doc = buildDoc({
			appName: "CaseTypeProse",
			modules: [
				{
					name: "Pregnancies",
					caseType: "pregnancy",
					caseListConfig: caseListConfig([{ field: "ga", header: "GA" }]),
					forms: [
						{
							name: "ANC Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "code_note",
									label: prose(
										{ kind: "text", text: "Code: " },
										{
											kind: "case-ref",
											caseType: "mother",
											property: "household_code",
										},
									),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "pregnancy",
					parent_type: "mother",
					properties: [{ name: "ga", label: proseText("GA") }],
				},
				{
					name: "mother",
					properties: [
						{ name: "household_code", label: proseText("Household Code") },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "code_note-label", [
			"Code: ",
			{
				element: "output",
				attributes: { value: expandCaseToWire(1, "household_code") },
			},
		]);
		expect(one(xform, "instance", { id: "casedb" }).attribs.src).toBe(
			"jr://instance/casedb",
		);
	});

	it("emits the editor-vocabulary wire shape for a mixed #form + per-type display condition", () => {
		// The regression scenario behind issue-report "Cannot make new version":
		// a followup form's relevant mixes a #form ref with a per-type case ref.
		// HQ's form designer only speaks #form/#case/#user (its XPath engine
		// rejects an unknown namespace at parse and re-serializes the raw
		// hashtag into the REAL attribute on the next editor save, which then
		// fails HQ's build validation) — so the vellum:* shadow must carry the
		// #case spelling and the raw per-type namespace must not reach the wire.
		const doc = buildDoc({
			appName: "AllergyAlert",
			modules: [
				{
					name: "Patient Search",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "New Encounter",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "selected_medication",
									label: proseText("Medication"),
								}),
								f({
									kind: "label",
									id: "penicillin_allergy_alert",
									label: proseText("Allergy alert!"),
									relevant:
										"#form/selected_medication != '' and contains(lower-case(#patient/allergen), 'penicillin')",
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
						{ name: "allergen", label: proseText("Allergen") },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;

		expect(
			one(xform, "bind", { nodeset: "/data/penicillin_allergy_alert" }).attribs,
		).toMatchObject({
			relevant:
				"/data/selected_medication != '' and contains(lower-case(" +
				expandCaseToWire(0, "allergen") +
				"), 'penicillin')",
			"vellum:relevant":
				"#form/selected_medication != '' and contains(lower-case(#case/allergen), 'penicillin')",
		});
		expect(JSON.parse(textContent(one(xform, "vellum:hashtags")))).toEqual({
			"#case/allergen": expandCaseToWire(0, "allergen"),
		});
		expect(
			JSON.parse(textContent(one(xform, "vellum:hashtagTransforms"))),
		).toEqual({
			prefixes: {
				"#case/":
					"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/",
			},
		});
		expect(
			hq.modules[0].forms[0].case_references_data.load[
				"/data/penicillin_allergy_alert"
			],
		).toEqual(["#case/allergen"]);
	});

	it("records no case_id load for a registration form — the ref reads the form-local new-case id", () => {
		// `#<own_type>/case_id` on a registration form expands to
		// `/data/case/@case_id` (the registration narrowing), not a casedb read,
		// so a `#case/case_id` load entry would tell HQ's App Summary the form
		// loads a case property it never touches.
		const doc = buildDoc({
			appName: "RegLoad",
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
									kind: "hidden",
									id: "tracking_code",
									calculate: "concat('P-', #patient/case_id)",
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
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "dob", label: proseText("Birth date"), data_type: "date" },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		expect(hq.modules[0].forms[0].case_references_data.load).toEqual({});
		const xform = Object.values(hq._attachments)[0];
		const bind = one(xform, "bind", { nodeset: "/data/tracking_code" });
		expect(bind.attribs.calculate).toBe("concat('P-', /data/case/@case_id)");
		expect(bind.attribs["vellum:calculate"]).toBeUndefined();
	});

	it("keeps an unresolvable prose token literal — no <output>, no casedb", () => {
		// Plain prose has no implicit reference syntax. An unreachable namespace
		// (`#section/intro`), junk token (`#N/A`), or child case-looking token
		// remains literal text and never lowers to `<output>` or a casedb read.
		const doc = buildDoc({
			appName: "JunkProse",
			modules: [
				{
					name: "Pregnancies",
					caseType: "pregnancy",
					caseListConfig: caseListConfig([{ field: "ga", header: "GA" }]),
					forms: [
						{
							name: "ANC Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "junk_note",
									label: proseText(
										"Codes #N/A and #child/name and #section/intro",
									),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "pregnancy",
					properties: [{ name: "ga", label: proseText("GA") }],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;
		expect(elements(xform, "output")).toEqual([]);
		expectProse(xform, "junk_note-label", [
			"Codes #N/A and #child/name and #section/intro",
		]);
		expect(
			elements(xform, "instance").map((instance) => instance.attribs.id),
		).not.toContain("casedb");
	});

	it("declares the casedb instance for a per-type ref whose ONLY home is a validate_msg", () => {
		// `validate_msg` is lowered by `buildLabelNodes` just like `label`/`hint`,
		// so a reachable `#mother/...` ref there must force the `casedb` `<instance>`
		// even when the field has no case-ref calculate/relevant. Driving the prose
		// instance scan from `addItext` (the single lowering funnel) is what makes
		// this hold for every prose surface, not just label + hint.
		const doc = buildDoc({
			appName: "ValidateMsgRef",
			modules: [
				{
					name: "Pregnancies",
					caseType: "pregnancy",
					caseListConfig: caseListConfig([{ field: "ga", header: "GA" }]),
					forms: [
						{
							name: "ANC Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "code",
									label: proseText("Code"),
									validate: "string-length(.) > 0",
									validate_msg: prose(
										{ kind: "text", text: "Must match " },
										{
											kind: "case-ref",
											caseType: "mother",
											property: "household_code",
										},
									),
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "pregnancy",
					parent_type: "mother",
					properties: [{ name: "ga", label: proseText("GA") }],
				},
				{
					name: "mother",
					properties: [
						{ name: "household_code", label: proseText("Household Code") },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "code-constraintMsg", [
			"Must match ",
			{
				element: "output",
				attributes: { value: expandCaseToWire(1, "household_code") },
			},
		]);
		expect(one(xform, "instance", { id: "casedb" }).attribs.src).toBe(
			"jr://instance/casedb",
		);
	});

	it("declares no secondary instances for #form/-only expressions", () => {
		// The HQ-upload source carries no meta block (CCHQ injects it at render
		// time), so a survey form whose only XPath is a `#form/` self-reference
		// declares NO secondary instances at all: no casedb (no case reference)
		// and no commcaresession (the meta setvalues that referenced it ship on
		// the `.ccz` path, not here).
		const doc = buildDoc({
			appName: "FormRef",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "int", id: "a", label: proseText("A") }),
								f({
									kind: "hidden",
									id: "b",
									calculate: "#form/a * 2",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			elements(xform, "instance").map((instance) => instance.attribs),
		).toEqual([{}]);
	});
});

// ── Feature 3: Conditional Required ─────────────────────────────────────

describe("conditional required", () => {
	it('generates required="true()" for required: "true()"', () => {
		const doc = buildDoc({
			appName: "R",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "q",
									label: proseText("Q"),
									required: "true()",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(one(xform, "bind", { nodeset: "/data/q" }).attribs).toMatchObject({
			required: "true()",
		});
	});

	it("generates required XPath expression for string required", () => {
		const doc = buildDoc({
			appName: "R",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "consent",
									label: proseText("Consent?"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
								f({
									kind: "text",
									id: "details",
									label: proseText("Details"),
									required: "/data/consent = 'yes'",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "bind", { nodeset: "/data/details" }).attribs,
		).toMatchObject({ required: "/data/consent = 'yes'" });
	});

	it("expands a typed case ref in required XPath and emits HQ shorthand", () => {
		const doc = buildDoc({
			appName: "R",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "risk",
									label: proseText("Q"),
									caseWrite: { caseType: "c", property: "risk" },
								}),
								f({
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
									required: "#c/risk = 'high'",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "c", properties: [{ name: "risk", label: proseText("Risk") }] },
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "bind", { nodeset: "/data/notes" }).attribs,
		).toMatchObject({
			required:
				"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/risk = 'high'",
			"vellum:requiredCondition": "#case/risk = 'high'",
		});
	});
});

// ── Feature 4: Case Detail (Long) View ──────────────────────────────────

describe("case detail (long) view", () => {
	it("mirrors short columns to long detail when case_detail_columns is not set", () => {
		const doc = buildDoc({
			appName: "D",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "age", header: "Age" },
					]),
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "c", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "c",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "dob", label: proseText("Birth date"), data_type: "date" },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const longCols = hq.modules[0].case_details.long.columns;
		expect(longCols.length).toBe(2);
		expect(longCols[0].field).toBe("case_name");
	});

	it("uses visibleInList / visibleInDetail flags to surface a wider long detail", () => {
		// `case_name` shows in both surfaces (defaults). `age` and
		// `dob` carry `visibleInList: false` so the short detail
		// renders them with CCHQ's `invisible` format (the column
		// stays present for sort + index purposes per CCHQ's
		// `detail_screen.py::Invisible.HideShortColumn` template); the
		// long detail still renders all three with their normal
		// `plain` format because `visibleInDetail` is unset (default
		// true).
		const caseNameCol = plainColumn(
			testUuid("00000000-0000-4000-8000-000000000001"),
			"case_name",
			"Name",
		);
		const ageCol = plainColumn(
			testUuid("00000000-0000-4000-8000-000000000002"),
			"age",
			"Age",
			{ visibleInList: false },
		);
		const dobCol = plainColumn(
			testUuid("00000000-0000-4000-8000-000000000003"),
			"dob",
			"Date of Birth",
			{ visibleInList: false },
		);
		const doc = buildDoc({
			appName: "D",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListConfig: resolveCaseListConfig({
						columns: [caseNameCol, ageCol, dobCol],
						searchInputs: [],
					}),
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Name"),
									caseWrite: { caseType: "c", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "c",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "dob", label: proseText("Birth date"), data_type: "date" },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const shortCols = hq.modules[0].case_details.short.columns;
		const longCols = hq.modules[0].case_details.long.columns;
		// Results persists only the field people see. Details-only fields do not
		// become zero-width technical rows unless they carry a Results sort rule.
		expect(shortCols.length).toBe(1);
		expect(shortCols[0].field).toBe("case_name");
		expect(shortCols[0].format).toBe("plain");
		// Details keeps all three columns, in its independent display order, with
		// normal `plain` format because `visibleInDetail` is unset.
		expect(longCols.length).toBe(3);
		expect(longCols[0].field).toBe("case_name");
		expect(longCols[0].format).toBe("plain");
		expect(longCols[1].field).toBe("age");
		expect(longCols[1].format).toBe("plain");
		expect(longCols[2].field).toBe("dob");
		expect(longCols[2].format).toBe("plain");
	});
});

// ── Feature 5: Single Language itext ────────────────────────────────────

describe("single language itext", () => {
	it("generates a single English translation block", () => {
		const doc = buildDoc({
			appName: "App",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: proseText("Patient Name"),
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			elements(xform, "translation").map((translation) => translation.attribs),
		).toEqual([{ lang: "en", default: "" }]);
		expectProse(xform, "name-label", ["Patient Name"]);
		expect(hq.langs).toEqual(["en"]);
	});
});

// ── Feature 6: jr-insert for Repeat Defaults ────────────────────────────

describe("jr-insert for repeat defaults", () => {
	it("uses jr-insert event for default_value inside repeat groups", () => {
		const doc = buildDoc({
			appName: "Rep",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "items",
									label: proseText("Items"),
									children: [
										f({
											kind: "hidden",
											id: "status",
											calculate: "'pending'",
											default_value: "'pending'",
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "setvalue", { ref: "/data/items/status" }).attribs,
		).toMatchObject({ event: "jr-insert", value: "'pending'" });
	});

	it("uses xforms-ready event for default_value outside repeat groups", () => {
		const doc = buildDoc({
			appName: "NR",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "hidden",
									id: "status",
									calculate: "'pending'",
									default_value: "'pending'",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(
			one(xform, "setvalue", { ref: "/data/status" }).attribs,
		).toMatchObject({ event: "xforms-ready", value: "'pending'" });
	});

	it('adds jr:template="" attribute on repeat data elements', () => {
		const doc = buildDoc({
			appName: "Rep",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "items",
									label: proseText("Items"),
									children: [
										f({
											kind: "text",
											id: "item_name",
											label: proseText("Item"),
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(one(xform, "items").attribs).toEqual({ "jr:template": "" });
		expect(one(xform, "repeat", { nodeset: "/data/items" })).toBeDefined();
	});
});

// ── Expansion with complete fields (no merge from case_types) ────────────

describe("expansion with complete fields", () => {
	it('derives case name from field with id "case_name"', () => {
		const doc = buildDoc({
			appName: "Case Name Test",
			modules: [
				{
					name: "M",
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
									label: proseText("Patient Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
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
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "dob", label: proseText("Birth date"), data_type: "date" },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const actions = hq.modules[0].forms[0].actions;
		expect(actions.open_case.condition.type).toBe("always");
		expect(actions.open_case.name_update.question_path).toBe("/data/case_name");
	});

	it("uses field labels directly without case_types merge", () => {
		const doc = buildDoc({
			appName: "Complete Fields",
			modules: [
				{
					name: "M",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Patient Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("WRONG") }],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expectProse(xform, "case_name-label", ["Patient Name"]);
	});
});

// ── Unquoted String Literal Detection ────────────────────────────────────

describe("unquoted string literal detection", () => {
	function expressionDoc(
		kind: "text" | "int" | "date" | "hidden",
		slot: string,
		expression: string,
		nested = false,
	) {
		const question = f({
			kind,
			id: "q",
			...(kind === "hidden" && { calculate: "1" }),
			[slot]: expression,
		} as Parameters<typeof f>[0]);
		return buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "int", id: "age" }),
								...(nested
									? [f({ kind: "group", id: "group", children: [question] })]
									: [question]),
							],
						},
					],
				},
			],
		});
	}
	it.each([
		["text", "default_value", "'no'"],
		["int", "required", "true()"],
		["int", "relevant", "#form/age > 18"],
		["hidden", "calculate", "#form/age"],
		["int", "default_value", "0"],
		["date", "default_value", "today()"],
		["int", "validate", ". > 0"],
	] as const)("admits and emits %s %s = %s", (kind, slot, expression) => {
		expandDoc(expressionDoc(kind, slot, expression));
	});
	it.each([
		["text", "default_value", "no", false],
		["hidden", "calculate", "pending", false],
		["text", "relevant", "yes", false],
		["hidden", "default_value", "active", true],
	] as const)(
		"reports the exact %s %s bare word %s (nested=%s)",
		(kind, slot, word, nested) => {
			const doc = expressionDoc(
				kind,
				slot,
				slot === "relevant" ? "true()" : "'safe'",
				nested,
			);
			expandDoc(doc);
			const question = Object.values(doc.fields).find(
				(field) => field.id === "q",
			);
			if (!question) throw new Error("Missing question");
			Object.assign(question, { [slot]: xp(word) });
			const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			expect(
				findings.map((finding) => ({
					code: finding.code,
					field: finding.location.field,
					uuid: finding.location.fieldUuid,
					bareWord: finding.details?.bareWord,
				})),
			).toEqual([
				{
					code: "UNQUOTED_STRING_LITERAL",
					field: slot,
					uuid: question.uuid,
					bareWord: word,
				},
				{
					code: "INVALID_REF",
					field: slot,
					uuid: question.uuid,
					bareWord: undefined,
				},
			]);
		},
	);
});

// ── Child Case Type Module Requirement ─────────────────────────────────

// ── case_list_only Validation ──────────────────────────────────────────

describe("case-list-only admission", () => {
	function browseDoc(withForm = false) {
		return buildDoc({
			caseTypes: [{ name: "thing", properties: [] }],
			modules: [
				{
					name: "Things",
					caseType: "thing",
					caseListOnly: !withForm,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: withForm
						? [
								{
									name: "Visit",
									type: "followup",
									fields: [f({ kind: "text", id: "note" })],
								},
							]
						: [],
				},
			],
		});
	}
	it.each(["forms", "case-type", "browse-flag"] as const)(
		"refuses removing the %s invariant from an admitted workflow",
		(fault) => {
			const doc = browseDoc(fault === "forms");
			expandDoc(doc);
			const module = doc.modules[doc.moduleOrder[0]];
			if (fault === "forms") module.caseListOnly = true;
			else if (fault === "case-type") delete module.caseType;
			else delete module.caseListOnly;
			const codes = {
				forms: "CASE_LIST_ONLY_HAS_FORMS",
				"case-type": "CASE_LIST_ONLY_NO_CASE_TYPE",
				"browse-flag": "NO_FORMS_OR_CASE_LIST",
			};
			expect(
				runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((finding) => ({
					code: finding.code,
					moduleUuid: finding.location.moduleUuid,
				})),
			).toEqual([{ code: codes[fault], moduleUuid: module.uuid }]);
		},
	);
});

// ── case_list_only Expansion ───────────────────────────────────────────

describe("case_list_only expansion", () => {
	it("sets case_list.show on case_list_only modules", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Plans",
					caseType: "plan",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Create Plan",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Plan Name"),
									caseWrite: { caseType: "plan", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					name: "Services",
					caseType: "service",
					caseListOnly: true,
					forms: [],
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			],
			caseTypes: [
				{
					name: "plan",
					properties: [{ name: "case_name", label: proseText("Plan Name") }],
				},
				{
					name: "service",
					parent_type: "plan",
					properties: [{ name: "case_name", label: proseText("Service Name") }],
				},
			],
		});
		const hq = expandDoc(doc);
		expect(hq.modules[1].case_list.show).toBe(true);
		expect(hq.modules[1].case_list.label).toEqual({ en: "Services" });
		expect(hq.modules[0].case_list.show).toBe(false);
	});

	it("sets case_type on case_list_only modules", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Services",
					caseType: "service",
					caseListOnly: true,
					forms: [],
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			],
			caseTypes: [
				{
					name: "service",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "dob", label: proseText("Birth date"), data_type: "date" },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		expect(hq.modules[0].case_type).toBe("service");
	});

	it("sets parent_select on child case type modules", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Plans",
					caseType: "plan",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Create Plan",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Plan Name"),
									caseWrite: { caseType: "plan", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					name: "Services",
					caseType: "service",
					caseListOnly: true,
					forms: [],
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			],
			caseTypes: [
				{
					name: "plan",
					properties: [{ name: "case_name", label: proseText("Plan Name") }],
				},
				{
					name: "service",
					parent_type: "plan",
					properties: [{ name: "case_name", label: proseText("Service Name") }],
				},
			],
		});
		const hq = expandDoc(doc);
		expect(hq.modules[1].parent_select.active).toBe(true);
		expect(hq.modules[1].parent_select.module_id).toBe(hq.modules[0].unique_id);
	});
});

// ── Structural edge cases ──────────────────────────────────────────────
//
// Admission rejects an empty form. Empty and nested containers remain
// representable and retain their authored wrappers.

describe("empty form expansion", () => {
	it("refuses an empty form before export", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Surveys",
					forms: [{ name: "Empty", type: "survey", fields: [] }],
				},
			],
		});
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).toEqual(["EMPTY_FORM"]);
	});
});

describe("empty container expansion", () => {
	// Empty groups are admitted authored containers and preserve their label.
	it("emits an empty <group> wrapper when a group has zero children", () => {
		const doc = buildDoc({
			appName: "EmptyGroup",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "demographics",
									label: proseText("Demographics"),
									children: [],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		// Body wraps the group — no children inside the `<group>` body. The
		// serializer encodes `'` as `&apos;` inside the itext ref.
		const group = one(xml, "group", { ref: "/data/demographics" });
		expect(group.attribs.appearance).toBe("field-list");
		expect(
			group.children
				.filter(isTag)
				.map((child) => ({ name: child.name, attributes: child.attribs })),
		).toEqual([
			{ name: "label", attributes: { ref: "jr:itext('demographics-label')" } },
		]);
		expect(one(xml, "demographics").children).toEqual([]);
		expectProse(xml, "demographics-label", ["Demographics"]);
	});
});

describe("nested container expansion", () => {
	// Repeat containing a group: the XForm must preserve both levels of
	// wrapper, and every descendant's XPath must be built relative to
	// `/data/<repeat>/<group>/<leaf>`. Repeats also carry `jr:template=""`
	// on the data element; that attribute attaches to the outermost
	// repeat, never its nested children.
	it("preserves both container levels for repeat containing a group", () => {
		const doc = buildDoc({
			appName: "Nested",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "visits",
									label: proseText("Visits"),
									children: [
										f({
											kind: "group",
											id: "vitals",
											label: proseText("Vitals"),
											children: [
												f({
													kind: "int",
													id: "temperature",
													label: proseText("Temperature"),
												}),
												f({
													kind: "int",
													id: "heart_rate",
													label: proseText("Heart Rate"),
												}),
											],
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		// Outer repeat carries the template marker; the inner group does not.
		expect(one(xml, "visits").attribs).toEqual({ "jr:template": "" });
		expect(one(xml, "vitals").attribs).toEqual({});
		for (const id of ["temperature", "heart_rate"])
			expect(
				one(xml, "bind", { nodeset: "/data/visits/vitals/" + id }).attribs[
					"vellum:nodeset"
				],
			).toBe("#form/visits/vitals/" + id);
		const repeat = one(xml, "repeat", { nodeset: "/data/visits" });
		expect(
			findAll((element) => element.name === "group", repeat.children).map(
				(group) => group.attribs.ref,
			),
		).toEqual(["/data/visits/vitals"]);
	});
});

// ── Connect opt-in ─────────────────────────────────────────────────────
//
// A Connect learn app may run with just a learn module (no assessment,
// no deliver unit). The expander must not inject deliver/task blocks
// that aren't configured, and the compiler must still produce a valid
// archive. Regression coverage against accidentally coupling the Connect
// blocks to each other.

// ── Deliver-unit entity-XPath defaults ────────────────────────────────
//
// `deliver_unit.entity_id` and `entity_name` are optional in the domain
// (`lib/domain/forms.ts`). The XForm builder substitutes the canonical
// XPath defaults when the doc carries no explicit value — this is the
// single home for those defaults. Without the wire-time fallback the
// emitter would write `<bind … calculate=""/>` and CCHQ would reject
// the upload with an XPath parse error.

// ── Case-property rename pipeline regression ──────────────────────────
//
// A case-bound `updateField.patch.id` cascades through sibling fields'
// XPath references — the
// unit coverage lives in `lib/doc/__tests__/mutations-pathRewrite.test.ts`
// and `mutations-fields.test.ts`. The pipeline-level invariant: the
// emitted XForm's bind/calculate attributes must reference the renamed
// id everywhere the original reference stood. Without this assertion, a
// refactor of the field-ID cascade could silently break downstream
// expression rewriting — validation would still pass because references
// remain syntactically well-formed, but they would point at nothing.

describe("field rename through mutation and export", () => {
	it("keeps reference identity while changing both the data node and executable path", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "int", id: "age" }),
								f({
									kind: "hidden",
									id: "risk",
									calculate: "if(#form/age > 65, 'high', 'low')",
								}),
							],
						},
					],
				},
			],
		});
		const original = expandDoc(doc);
		const field = Object.values(doc.fields).find((field) => field.id === "age");
		if (!field) throw new Error("Missing age");
		const renamed = produce(doc, (draft) => {
			applyMutations(
				draft,
				admitMutationBatch([
					{
						kind: "updateField",
						uuid: field.uuid,
						targetKind: "int",
						patch: { id: "patient_age" },
					},
				]),
			);
		});
		const after = expandDoc(renamed);
		for (const [app, id] of [
			[original, "age"],
			[after, "patient_age"],
		] as const) {
			const xml = Object.values(app._attachments)[0];
			expect(
				one(xml, "bind", { nodeset: "/data/risk" }).attribs.calculate,
			).toBe("if(/data/" + id + " > 65, 'high', 'low')");
			expect(
				one(xml, "bind", { nodeset: "/data/" + id }).attribs["vellum:nodeset"],
			).toBe("#form/" + id);
		}
		expect(renamed.fields[field.uuid].uuid).toBe(field.uuid);
	});
});

// ── Form links ─────────────────────────────────────────────────────────
//
// The expander emits `doc.forms[*].formLinks` into `HqForm.form_links` in
// HQ's own `FormLink` shape: the exclusive guard as `xpath`, the target as
// `form_id` + `form_module_id` (or `module_unique_id`), explicit datums as
// `datums`, with `post_form_workflow = "form"` (the only workflow under
// which HQ reads links) and the authored `postSubmit` as
// `post_form_workflow_fallback` when the list ends conditionally. A dangling
// target aborts projection (the validator catches it first in production;
// the expander stays fail-closed so an unchecked call never produces HQ
// JSON pointing nowhere).

describe("form_links emission", () => {
	it("emits HQ form_links with form_id / form_module_id targets and the fallback workflow", () => {
		// Pre-assign UUIDs so the DSL-level `formLinks` target can reference
		// the sibling form without post-construction mutation.
		const moduleUuid = "mod-fl";
		const intakeUuid = "frm-intake";
		const followupUuid = "frm-followup";

		const doc = buildDoc({
			appName: "FL",
			modules: [
				{
					uuid: moduleUuid,
					name: "M",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: intakeUuid,
							name: "Intake",
							type: "followup",
							postSubmit: "module",
							formLinks: [
								{
									condition: "normalize-space(#patient/status) = 'open'",
									target: {
										type: "form",
										moduleUuid: testUuid(moduleUuid),
										formUuid: testUuid(followupUuid),
									},
									// The target's one selection datum, named by hand.
									datums: [{ name: "case_id", xpath: "#user/username" }],
								},
							],
							fields: [
								f({
									kind: "single_select",
									id: "outcome",
									label: proseText("Outcome"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
							],
						},
						{
							uuid: followupUuid,
							name: "Followup",
							type: "followup",
							fields: [
								f({ kind: "text", id: "notes", label: proseText("Notes") }),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "status", label: proseText("Status") }],
				},
			],
		});

		// Validator accepts the configuration.
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) =>
				e.code.startsWith("FORM_LINK"),
			),
		).toEqual([]);

		const hq = expandDoc(doc);
		const module = hq.modules[0];
		const [intake, followup] = module.forms;
		expect(intake.post_form_workflow).toBe("form");
		// The list ends conditionally, so the authored `module` destination
		// is the fallback HQ reads when the guard is false.
		expect(intake.post_form_workflow_fallback).toBe("module");
		expect(intake.form_links).toEqual([
			{
				xpath: lowerXPathForJavaRosa(
					"normalize-space(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/status) = 'open'",
				),
				form_id: followup.unique_id,
				form_module_id: module.unique_id,
				datums: [
					{
						name: "case_id",
						xpath:
							"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/username",
					},
				],
			},
		]);
		// The target form keeps the ordinary workflow: no links of its own.
		expect(followup.post_form_workflow).toBe("previous_screen");
		expect(followup.post_form_workflow_fallback).toBeNull();
	});

	it("emits module-target links with module index only", () => {
		const modA = "mod-a";
		const modB = "mod-b";
		const formAUuid = "frm-a";

		const doc = buildDoc({
			appName: "FL",
			modules: [
				{
					uuid: modA,
					name: "A",
					forms: [
						{
							uuid: formAUuid,
							name: "FA",
							type: "survey",
							formLinks: [
								{
									target: { type: "module", moduleUuid: testUuid(modB) },
								},
							],
							fields: [f({ kind: "text", id: "x", label: proseText("X") })],
						},
					],
				},
				{
					uuid: modB,
					name: "B",
					forms: [
						{
							name: "FB",
							type: "survey",
							fields: [f({ kind: "text", id: "y", label: proseText("Y") })],
						},
					],
				},
			],
		});

		const hq = expandDoc(doc);
		expect(hq.modules[0].forms[0].form_links).toEqual([
			{ xpath: "", module_unique_id: hq.modules[1].unique_id, datums: [] },
		]);
		expect(hq.modules[0].forms[0].post_form_workflow).toBe("form");
		// A sole unconditional link always fires: no fallback to declare.
		expect(hq.modules[0].forms[0].post_form_workflow_fallback).toBeNull();
	});

	it("forwards literal condition + datum overrides", () => {
		const moduleUuid = "mod-d";
		const intakeUuid = "frm-i";
		const triageUuid = "frm-t";

		const doc = buildDoc({
			appName: "FL",
			modules: [
				{
					uuid: moduleUuid,
					name: "M",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: intakeUuid,
							name: "Intake",
							type: "survey",
							postSubmit: "module",
							formLinks: [
								{
									condition: "true()",
									target: {
										type: "form",
										moduleUuid: testUuid(moduleUuid),
										formUuid: testUuid(triageUuid),
									},
									datums: [{ name: "case_id", xpath: "'patient-id'" }],
								},
							],
							fields: [
								f({
									kind: "text",
									id: "severity",
									label: proseText("Severity"),
								}),
							],
						},
						{
							uuid: triageUuid,
							name: "Triage",
							type: "followup",
							fields: [
								f({ kind: "text", id: "notes", label: proseText("Notes") }),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});

		const hq = expandDoc(doc);
		const module = hq.modules[0];
		expect(module.forms[0].form_links).toEqual([
			{
				xpath: "true()",
				form_id: module.forms[1].unique_id,
				form_module_id: module.unique_id,
				datums: [{ name: "case_id", xpath: "'patient-id'" }],
			},
		]);
	});

	it("emits the exclusive guard, not the raw condition, on every link after the first", () => {
		const moduleUuid = "mod-x";
		const [a, b, c] = ["frm-a", "frm-b", "frm-c"];
		const doc = buildDoc({
			appName: "FL",
			modules: [
				{
					uuid: moduleUuid,
					name: "M",
					forms: [
						{
							uuid: a,
							name: "A",
							type: "survey",
							formLinks: [
								{
									condition: "#user/role = 'chw' or #user/role = 'nurse'",
									target: {
										type: "form",
										moduleUuid: testUuid(moduleUuid),
										formUuid: testUuid(b),
									},
								},
								{
									condition: "#user/role = 'super'",
									target: {
										type: "form",
										moduleUuid: testUuid(moduleUuid),
										formUuid: testUuid(c),
									},
								},
								{
									target: { type: "module", moduleUuid: testUuid(moduleUuid) },
								},
							],
							fields: [f({ kind: "text", id: "x", label: proseText("X") })],
						},
						{
							uuid: b,
							name: "B",
							type: "survey",
							fields: [f({ kind: "text", id: "y", label: proseText("Y") })],
						},
						{
							uuid: c,
							name: "C",
							type: "survey",
							fields: [f({ kind: "text", id: "z", label: proseText("Z") })],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const form = hq.modules[0].forms[0];
		const role =
			"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/role";
		const first = `${role} = 'chw' or ${role} = 'nurse'`;
		const second = `${role} = 'super'`;
		expect(form.form_links.map((link) => link.xpath)).toEqual([
			// The first guard is the bare condition (byte-identical to HQ's
			// own first frame); the second wraps its `or` before ANDing the
			// negated prior; the terminal else is the negation of every prior.
			first,
			`(${second}) and not(${first})`,
			`not(${first}) and not(${second})`,
		]);
		// A terminal unconditional link is the exhaustive else: HQ's
		// fallback frame is suppressed by leaving the fallback null.
		expect(form.post_form_workflow).toBe("form");
		expect(form.post_form_workflow_fallback).toBeNull();
	});

	it("defaults to [] when no formLinks are defined", () => {
		const doc = buildDoc({
			appName: "FL",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [f({ kind: "text", id: "x", label: proseText("X") })],
						},
					],
				},
			],
		});
		const form = expandDoc(doc).modules[0].forms[0];
		expect(form.form_links).toEqual([]);
		expect(form.post_form_workflow).toBe("default");
		expect(form.post_form_workflow_fallback).toBeNull();
	});

	// The validator blocks dangling targets before they reach the expander.
	// The wire boundary must also fail closed if an unchecked caller violates
	// that invariant; silently dropping authored behavior would turn an
	// invalid document into a different export.
	it("refuses a form-link target whose uuid isn't registered", () => {
		const moduleUuid = "mod-dangling";
		const formUuid = "frm-dangling";
		const doc = buildDoc({
			appName: "FL",
			modules: [
				{
					uuid: moduleUuid,
					name: "M",
					forms: [
						{
							uuid: formUuid,
							name: "Intake",
							type: "survey",
							formLinks: [
								{
									target: {
										type: "module",
										moduleUuid: testUuid(moduleUuid),
									},
								},
							],
							fields: [
								f({ kind: "text", id: "notes", label: proseText("Notes") }),
							],
						},
					],
				},
			],
		});

		expandDoc(doc);
		const source = doc.forms[doc.formOrder[doc.moduleOrder[0]][0]];
		const link = source.formLinks?.[0];
		if (link === undefined) throw new Error("Expected the admitted form link");
		doc.forms[source.uuid] = {
			...source,
			formLinks: [
				{
					...link,
					target: {
						type: "module",
						moduleUuid: testUuid("mod-never-registered"),
					},
				},
			],
		};
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((error) => error.code),
		).toEqual(["FORM_LINK_TARGET_NOT_FOUND"]);
		expect(() => projectUncheckedDoc(doc)).toThrowError(
			/Cannot project a form link: target module .* is missing/,
		);
	});
});

// ── Connect mode gate ──────────────────────────────────────────────────
//
// Connect content and the app's Connect mode are one exact topology. There is
// no dormant/stashed form arm for the emitter to strip.

// ── HQ JSON projection: per-column kind, sort, filter, search config ──
//
// The HQ JSON layer is what flows to CCHQ via `/api/import_app/` — the
// production export pathway. Every authored slot must land in the
// projected JSON, otherwise "Upload to CCHQ" silently drops it.
//
// Test sections below pin each surface independently:
//
//   1. Per-kind column projection — every Nova column kind maps to the
//      correct CCHQ `DetailColumn.format` token + per-kind slot.
//   2. Per-surface visibility — `visibleInList: false` / `visibleInDetail: false`
//      flip the column to CCHQ's `invisible` format on the matching
//      surface; both surfaces keep the column present (CCHQ uses
//      `invisible` for search-only / detail-only semantics).
//   3. Sort projection — `caseListConfig.columns[*].sort` lands in
//      `case_details.short.sort_elements` ordered by priority + tie-
//      breaker; calc columns route through `sort_calculation`.
//   4. Case-list filter projection — `caseListConfig.filter` lands at
//      `case_details.short.filter` with `match-all` collapsing to `null`.
//   5. Search-config projection — `caseSearchConfig` + both search-input
//      arms map to `module.search_config.properties`; advanced prompts
//      suppress Core's implicit property matcher while their predicates
//      + filter AND-compose into `_xpath_query` on `default_properties`.

const HQ_PROJECTION_MODULE_UUID = testUuid(
	"77777777-7777-4777-8777-777777777771",
);

const HQ_PROJECTION_PATIENT_CASE_TYPE = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Name", data_type: "text" as const },
		{ name: "age", label: "Age", data_type: "int" as const },
		{ name: "phone", label: "Phone", data_type: "text" as const },
		{ name: "photo_url", label: "Photo", data_type: "text" as const },
		{ name: "visit_count", label: "Visits", data_type: "int" as const },
		{ name: "region", label: "Region", data_type: "text" as const },
		{ name: "last_visit", label: "Last Visit", data_type: "date" as const },
		{ name: "dob", label: "DOB", data_type: "date" as const },
		{ name: "status", label: "Status", data_type: "text" as const },
		{
			name: "workflow_status",
			label: "Workflow status",
			data_type: "text" as const,
		},
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select" as const,
			options: [
				{ value: "vip", label: "VIP" },
				{ value: "follow_up", label: "Needs follow-up" },
			],
		},
	],
};

/**
 * Build a doc with one followup form sourcing the named fields. The
 * followup form keeps the module's `case_type` active so the
 * expander's `hasCases` gate admits the projected search config.
 */
function buildHqProjectionDoc(
	caseListConfig: CaseListConfigSpec,
	caseSearchConfig?: Module["caseSearchConfig"],
	caseTypes: NonNullable<DocSpec["caseTypes"]> = [
		HQ_PROJECTION_PATIENT_CASE_TYPE,
	],
) {
	return buildDoc({
		appName: "HQ Projection",
		modules: [
			{
				uuid: HQ_PROJECTION_MODULE_UUID,
				name: "Patients",
				caseType: "patient",
				caseListConfig,
				caseSearchConfig,
				forms: [
					{
						name: "Follow-up",
						type: "followup",
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
		],
		caseTypes,
	});
}

describe("expandDoc HQ JSON projection — column kinds", () => {
	it("projects plain columns with the bare property reference and `plain` format", () => {
		// Plain columns are CCHQ's baseline `DetailColumn` shape —
		// `field` carries the case-property name and `format` stays
		// `"plain"`. Mirrors `detail_screen.py::Plain`'s no-override
		// rendering.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000010001"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [],
		});
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols).toHaveLength(1);
		expect(shortCols[0].field).toBe("case_name");
		expect(shortCols[0].format).toBe("plain");
		expect(shortCols[0].useXpathExpression).toBe(false);
	});

	it("projects a plain select as a label expression with raw-token fallback", () => {
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000010013"),
					"tags",
					"Tags",
				),
			],
			searchInputs: [],
		});

		const [column] = expandDoc(doc).modules[0].case_details.short.columns;

		expect(column.format).toBe("translatable-enum");
		expect(column.useXpathExpression).toBe(true);
		expect(column.field).toContain(
			"if(selected(tags, 'vip'), $nova_text_0000000000, '')",
		);
		expect(column.field).toContain(
			lowerXPathForJavaRosa("normalize-space(tags)"),
		);
		expect(column.field).not.toContain("normalize-space(");
		expect(column.enum).toContainEqual({
			key: "nova_text_0000000000",
			value: { en: "VIP" },
		});
	});

	it("keeps HQ enum placeholders prefix-free across double-digit option indexes", () => {
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000010015"),
					"tags",
					"Tags",
				),
			],
			searchInputs: [],
		});
		const tags = doc.caseTypes?.[0]?.properties.find(
			(property) => property.name === "tags",
		);
		if (tags === undefined) throw new Error("Expected tags property.");
		tags.options = Array.from({ length: 11 }, (_, index) => ({
			value: `tag_${index}`,
			label: proseText(`Tag ${index}`),
		}));

		const [column] = expandDoc(doc).modules[0].case_details.short.columns;
		expect(column.enum).toEqual(
			Array.from({ length: 11 }, (_, index) => ({
				key: "nova_text_" + String(index).padStart(10, "0"),
				value: { en: "Tag " + index },
			})),
		);
		// Actual HQ XPathEnum replacement and Core rendering are exercised by
		// ExpanderRuntimeTest; this assertion describes the emitted table only.
	});

	it("projects date columns with `date` format and the authored `date_format` pattern", () => {
		// Date columns ride CCHQ's `Date` format. The authored
		// `pattern` lands on `date_format`; the runtime formatter
		// consumes it. CCHQ's default pattern is `%d/%m/%y`; an
		// authored pattern overrides cleanly.
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					dateColumn(
						testUuid("00000000-0000-4000-8000-000000010002"),
						"last_visit",
						"Last Visit",
						"%Y-%m-%d",
					),
				],
				searchInputs: [],
			}),
		);
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols).toHaveLength(1);
		expect(shortCols[0].format).toBe("date");
		expect(shortCols[0].date_format).toBe("%Y-%m-%d");
		expect(shortCols[0].field).toBe("last_visit");
	});

	it("emits an authored literal pattern without semantic reinterpretation", () => {
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					dateColumn(
						testUuid("00000000-0000-4000-8000-000000010012"),
						"last_visit",
						"Last Visit",
						"long",
					),
				],
				searchInputs: [],
			}),
		);
		const [column] = expandDoc(doc).modules[0].case_details.short.columns;
		expect(column.format).toBe("date");
		expect(column.date_format).toBe("long");
	});

	it("projects phone columns with `phone` format and the bare property reference", () => {
		// Phone columns route through CCHQ's `Phone` format; the
		// runtime overlays a tap-to-call affordance on long detail
		// (CCHQ's `template_form="phone"` divergence). The HQ JSON
		// layer carries only the format token; the long-vs-short
		// template divergence is emitted at suite-XML time.
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					phoneColumn(
						testUuid("00000000-0000-4000-8000-000000010003"),
						"phone",
						"Phone",
					),
				],
				searchInputs: [],
			}),
		);
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("phone");
		expect(shortCols[0].field).toBe("phone");
	});

	it("projects id-mapping columns with `enum` format and per-language label entries", () => {
		// ID-mapping rows lower to CCHQ's translatable enum-variable format.
		// The display expression keeps raw ids separate from localized labels.
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					idMappingColumn(
						testUuid("00000000-0000-4000-8000-000000010004"),
						"region",
						"Region",
						[idMappingEntry("N", "North"), idMappingEntry("S", "South")],
					),
				],
				searchInputs: [],
			}),
		);
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("translatable-enum");
		expect(shortCols[0].useXpathExpression).toBe(true);
		expect(shortCols[0].field).toContain(
			"if(selected(region, 'N'), $nova_text_0000000000, '')",
		);
		expect(shortCols[0].enum).toEqual([
			{ key: "nova_text_0000000000", value: { en: "North" } },
			{ key: "nova_text_0000000001", value: { en: "South" } },
		]);
	});

	it("projects a link column as a markdown-format calculated cell", () => {
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					linkColumn(
						testUuid("00000000-0000-4000-8000-000000010009"),
						"photo_url",
						"Photo",
						"Open photo",
					),
				],
				searchInputs: [],
			}),
		);
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;

		// `markdown` is `detail_screen.py::Markdown`, whose only job is
		// `template_form = 'markdown'`; paired with `useXpathExpression` HQ
		// wraps the expression as `$calculated_property` and renders the
		// result through it.
		expect(shortCols[0].format).toBe("markdown");
		expect(shortCols[0].useXpathExpression).toBe(true);
		// The SAME expression the suite emitter writes, so importing this
		// app into HQ and downloading it produce the same cell.
		expect(shortCols[0].field).toBe(
			"if(photo_url = '', '', concat('[Open photo](', photo_url, ')'))",
		);
		// No `enum` entries: HQ builds locale variables only for its `Enum`
		// format subclasses, and `Markdown` is not one, so the label has to
		// ride inside the expression.
		expect(shortCols[0].enum).toEqual([]);
	});

	it("preserves an always interval's threshold and authored text in HQ JSON", () => {
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					intervalColumn(
						testUuid("00000000-0000-4000-8000-000000010005"),
						"last_visit",
						"Days since visit",
						3,
						"days",
						"always",
						"OVERDUE",
					),
				],
				searchInputs: [],
			}),
		);
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("translatable-enum");
		expect(shortCols[0].useXpathExpression).toBe(true);
		expect(shortCols[0].field).toBe(
			"if(last_visit = '', '', if(today() - date(last_visit) > 3, $nova_text_0000000000, string(int((today() - date(last_visit)) div 1))))",
		);
		expect(shortCols[0].enum).toEqual([
			{ key: "nova_text_0000000000", value: { en: "OVERDUE" } },
		]);
	});

	it("preserves a flag interval's threshold and authored text in HQ JSON", () => {
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					intervalColumn(
						testUuid("00000000-0000-4000-8000-000000010006"),
						"last_visit",
						"Overdue",
						2,
						"weeks",
						"flag",
						"OVERDUE",
					),
				],
				searchInputs: [],
			}),
		);
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("translatable-enum");
		expect(shortCols[0].useXpathExpression).toBe(true);
		expect(shortCols[0].field).toBe(
			"if(last_visit = '', $nova_text_0000000000, if(today() - date(last_visit) > 14, $nova_text_0000000000, ''))",
		);
		expect(shortCols[0].enum).toEqual([
			{ key: "nova_text_0000000000", value: { en: "OVERDUE" } },
		]);
	});

	it("projects calculated columns with `useXpathExpression: true` and the lowered XPath as `field`", () => {
		// Calc columns route through CCHQ's `useXpathExpression`
		// branch — `format: "calculate"`, `useXpathExpression: true`,
		// and `field` carries the lowered XPath expression rather
		// than a property name (per CCHQ's
		// `detail_screen.py::FormattedDetailColumn.xpath` switch).
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					calculatedColumn(
						testUuid("00000000-0000-4000-8000-000000010007"),
						"Age Next Year",
						toValueExpression(prop("patient", "age")),
					),
				],
				searchInputs: [],
			}),
		);
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("calculate");
		expect(shortCols[0].useXpathExpression).toBe(true);
		// `field` carries the lowered XPath — for a bare property ref
		// the on-device emitter renders just the property name.
		expect(shortCols[0].field).toBe("age");
	});

	it("omits a Details-only field from Results while preserving it on Details", () => {
		// A field with no Results behavior should not persist as a zero-width
		// technical row. Off-screen fields remain only when Default order needs
		// their sort carrier.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000010008"),
					"phone",
					"Phone",
					{ visibleInList: false },
				),
				plainColumn(testUuid("expander-visible-identity"), "case_name", "Name"),
			],
			searchInputs: [],
		});
		const details = expandDoc(doc).modules[0].case_details;
		expect(details.short.columns.map((column) => column.field)).toEqual([
			"case_name",
		]);
		expect(details.long.columns[0].format).toBe("plain");
		expect(details.long.columns[0].field).toBe("phone");
	});
});

describe("expandDoc HQ JSON projection — sort_elements", () => {
	it("emits one sort_element per `column.sort`, ordered by priority ascending", () => {
		// Two sort directives at priorities 0 and 1; CCHQ stores them
		// in array order matching priority ascending.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000020001"),
					"case_name",
					"Name",
					{ sort: { direction: "asc", priority: 1 } },
				),
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000020002"),
					"age",
					"Age",
					{ sort: { direction: "desc", priority: 0 } },
				),
			],
			searchInputs: [],
		});
		const sortElements =
			expandDoc(doc).modules[0].case_details.short.sort_elements;
		expect(sortElements).toHaveLength(2);
		// Priority 0 wins → `age desc` is the primary sort.
		expect(sortElements[0].field).toBe("age");
		expect(sortElements[0].direction).toBe("descending");
		expect(sortElements[0].type).toBe("int");
		expect(sortElements[1].field).toBe("case_name");
		expect(sortElements[1].direction).toBe("ascending");
		expect(sortElements[1].type).toBe("string");
	});

	it("routes calc-column sort through `sort_calculation` with field=`_cc_calculated_<index>`", () => {
		// Calc-column sort directives write `field` as CCHQ's synthetic
		// per-column key shape `_cc_calculated_{columnIndex}`, matching
		// the regex `commcare-hq/.../app_manager/const.py::CALCULATED_SORT_FIELD_RX`.
		// CCHQ's `case_search.case_search_helpers::get_sort_and_sort_only_columns`
		// parses the index out of the field name and attaches the sort
		// to the source-array calc column at that position; without a
		// per-column key, sibling calc sorts collide in the
		// `sort_elements_by_field` dict and only the last directive
		// survives.
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					calculatedColumn(
						testUuid("00000000-0000-4000-8000-000000020003"),
						"Age Next Year",
						toValueExpression(prop("patient", "age")),
						{ sort: { direction: "asc", priority: 0 } },
					),
				],
				searchInputs: [],
			}),
		);
		const sortElements =
			expandDoc(doc).modules[0].case_details.short.sort_elements;
		expect(sortElements).toHaveLength(1);
		expect(sortElements[0].sort_calculation).toBe("age");
		expect(sortElements[0].field).toBe("_cc_calculated_0");
		expect(sortElements[0].direction).toBe("ascending");
	});

	it("keeps every calc-column sort distinct across multiple calc columns (no dict collision)", () => {
		// Regression for CCHQ's `sort_elements_by_field` keyed by
		// `field`: two calc columns both writing the same placeholder
		// key would overwrite each other on the HQ-uploaded path even
		// though Nova's local `.ccz` renders both. The synthetic
		// `_cc_calculated_{index}` field per column is the unique
		// key that survives the dict.
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					calculatedColumn(
						testUuid("00000000-0000-4000-8000-000000020003"),
						"Age Next Year",
						toValueExpression(prop("patient", "age")),
						{ sort: { direction: "asc", priority: 0 } },
					),
					calculatedColumn(
						testUuid("00000000-0000-4000-8000-000000020004"),
						"Visits Doubled",
						toValueExpression(prop("patient", "visit_count")),
						{ sort: { direction: "desc", priority: 1 } },
					),
				],
				searchInputs: [],
			}),
		);
		const sortElements =
			expandDoc(doc).modules[0].case_details.short.sort_elements;
		expect(sortElements).toHaveLength(2);
		// Field-key uniqueness — both directives survive CCHQ's
		// `sort_elements_by_field[field] = element` overwrite.
		expect(sortElements[0].field).toBe("_cc_calculated_0");
		expect(sortElements[0].sort_calculation).toBe("age");
		expect(sortElements[0].direction).toBe("ascending");
		expect(sortElements[1].field).toBe("_cc_calculated_1");
		expect(sortElements[1].sort_calculation).toBe("visit_count");
		expect(sortElements[1].direction).toBe("descending");
	});

	it("routes a select-typed plain column's sort through the positional calc join", () => {
		// A plain column on a select-typed property projects with
		// `useXpathExpression: true` and `field` = the derived label
		// expression, so a property-name sort element would no longer
		// join it (CCHQ's `get_sort_and_sort_only_columns` joins by
		// exact `column.field` string) and the visible column would
		// lose its `<sort>` on the HQ-regenerated suite. The sort
		// element must use the positional `_cc_calculated_{index}` key
		// and carry the RAW property in `sort_calculation` — the same
		// sort source Nova's direct suite emits.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000020005"),
					"case_name",
					"Name",
				),
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000020006"),
					"tags",
					"Tags",
					{ sort: { direction: "asc", priority: 0 } },
				),
			],
			searchInputs: [],
		});
		const details = expandDoc(doc).modules[0].case_details;
		// The join is positional into the emitted short array — index 1,
		// counting the unsorted plain column ahead of it.
		expect(details.short.columns[1].useXpathExpression).toBe(true);
		const sortElements = details.short.sort_elements;
		expect(sortElements).toHaveLength(1);
		expect(sortElements[0].field).toBe("_cc_calculated_1");
		expect(sortElements[0].sort_calculation).toBe("tags");
		expect(sortElements[0].type).toBe("string");
	});

	it("routes an interval column's sort through the positional calc join on the raw property", () => {
		const doc = buildHqProjectionDoc(
			resolveCaseListConfig({
				columns: [
					intervalColumn(
						testUuid("00000000-0000-4000-8000-000000020007"),
						"last_visit",
						"Since Visit",
						30,
						"days",
						"always",
						"Overdue",
						{ sort: { direction: "desc", priority: 0 } },
					),
				],
				searchInputs: [],
			}),
		);
		const details = expandDoc(doc).modules[0].case_details;
		expect(details.short.columns[0].useXpathExpression).toBe(true);
		const sortElements = details.short.sort_elements;
		expect(sortElements).toHaveLength(1);
		expect(sortElements[0].field).toBe("_cc_calculated_0");
		// Sorts by the raw date property (ISO-string comparator), not by
		// the rendered interval count.
		expect(sortElements[0].sort_calculation).toBe("last_visit");
		expect(sortElements[0].type).toBe("string");
		expect(sortElements[0].direction).toBe("descending");
	});

	it("keeps the positional calc join aligned for an off-Results sort carrier", () => {
		// A select-typed column hidden from Results but carrying Default
		// order persists as an `invisible` short column; the projection
		// keeps `useXpathExpression`, so the sort element must still join
		// positionally (CCHQ's `Invisible` format class inherits the base
		// sort path and honors `sort_calculation`).
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000020008"),
					"tags",
					"Tags",
					{ visibleInList: false, sort: { direction: "asc", priority: 0 } },
				),
				plainColumn(testUuid("expander-visible-identity"), "case_name", "Name"),
			],
			searchInputs: [],
		});
		const details = expandDoc(doc).modules[0].case_details;
		expect(details.short.columns[0].format).toBe("invisible");
		expect(details.short.columns[0].useXpathExpression).toBe(true);
		expect(details.short.columns[0].field).toBe("tags");
		expect(details.short.columns[0].field).not.toContain("$nova_text_");
		expect(details.short.columns[0].enum).toEqual([]);
		const sortElements = details.short.sort_elements;
		expect(sortElements[0].field).toBe("_cc_calculated_0");
		expect(sortElements[0].sort_calculation).toBe("tags");
	});

	it("leaves sort_elements empty when no column carries a sort directive", () => {
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000020004"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [],
		});
		expect(expandDoc(doc).modules[0].case_details.short.sort_elements).toEqual(
			[],
		);
	});
});

describe("expandDoc HQ JSON projection — case_list_filter", () => {
	it("compiles `caseListConfig.filter` to bare on-device XPath at `case_details.short.filter`", () => {
		// CCHQ stores the filter at `case_details.short.filter`; the
		// `module.case_list_filter` getter reads through to this
		// slot. The wire form is the bare on-device XPath body —
		// no `[...]` wrap (CCHQ wraps at runtime via
		// `EntriesHelper.get_filter_xpath`). `region` is a plain
		// case property (vs. the reserved case-attribute names like
		// `status` that prefix `@` per `RESERVED_CASE_ATTRIBUTES`).
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000030001"),
					"case_name",
					"Name",
				),
			],
			filter: eq(prop("patient", "region"), literal("North")),
			searchInputs: [],
		});
		const filter = expandDoc(doc).modules[0].case_details.short.filter;
		expect(filter).toBe("region = 'North'");
	});

	it("emits `null` when no filter is authored", () => {
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000030002"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [],
		});
		expect(expandDoc(doc).modules[0].case_details.short.filter).toBeNull();
	});

	it("projects an owner-only availability rule without enabling remote Search", () => {
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						testUuid("00000000-0000-4000-8000-000000030003"),
						"case_name",
						"Name",
					),
				],
				searchInputs: [],
			},
			{
				searchActionEnabled: false,
				excludedOwnerIds: toValueExpression(literal("owner-a owner-b")),
			},
		);
		const module = expandDoc(doc).modules[0];

		expect(module.case_details.short.filter).toBe(
			lowerXPathForJavaRosa(
				"normalize-space('owner-a owner-b') = '' or not(selected(normalize-space('owner-a owner-b'), @owner_id))",
			),
		);
		expect(module.search_config.properties).toEqual([]);
		expect(module.search_config.default_properties).toEqual([]);
		expect(
			module.search_config.blacklisted_owner_ids_expression,
		).toBeUndefined();
	});

	it("AND-composes the list rule and owner exclusion in the HQ detail filter", () => {
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						testUuid("00000000-0000-4000-8000-000000030004"),
						"case_name",
						"Name",
					),
				],
				filter: eq(prop("patient", "region"), literal("North")),
				searchInputs: [],
			},
			{
				searchActionEnabled: false,
				excludedOwnerIds: toValueExpression(literal("owner-a")),
			},
		);

		expect(expandDoc(doc).modules[0].case_details.short.filter).toBe(
			lowerXPathForJavaRosa(
				"(region = 'North') and (normalize-space('owner-a') = '' or not(selected(normalize-space('owner-a'), @owner_id)))",
			),
		);
	});
});

describe("expandDoc HQ JSON projection — search_config", () => {
	describe("parent information", () => {
		const relatedCaseTypes = [
			{ ...HQ_PROJECTION_PATIENT_CASE_TYPE, parent_type: "household" },
			{
				name: "household",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" as const },
					{ name: "case_id", label: "Case id", data_type: "text" as const },
				],
			},
		];
		const parentName = (slots: Parameters<typeof calculatedColumn>[3] = {}) =>
			calculatedColumn(
				testUuid("00000000-0000-4000-8000-000000040090"),
				"Household",
				term(
					prop(
						"patient",
						"case_name",
						ancestorPath(relationStep("parent", "household")),
					),
				),
				slots,
			);

		it("carries a parent property with one typed expression for ordinary and Search details", () => {
			const module = expandDoc(
				buildHqProjectionDoc(
					{ columns: [parentName()], searchInputs: [] },
					{},
					relatedCaseTypes,
				),
			).modules[0];

			expect(module.search_config.include_all_related_cases).toBe(true);
			for (const detail of [
				module.case_details.short,
				module.case_details.long,
			]) {
				expect(detail.columns[0]).toMatchObject({
					field:
						"current()/../case[@case_id=current()/index/parent and @case_type='household']/case_name",
					format: "calculate",
					useXpathExpression: true,
				});
			}
		});

		it("stores a parent case id as an attribute-backed typed expression", () => {
			const parentCaseId = calculatedColumn(
				testUuid("00000000-0000-4000-8000-000000040091"),
				"Household id",
				term(
					prop(
						"patient",
						"case_id",
						ancestorPath(relationStep("parent", "household")),
					),
				),
			);
			const module = expandDoc(
				buildHqProjectionDoc(
					{ columns: [parentCaseId], searchInputs: [] },
					{},
					relatedCaseTypes,
				),
			).modules[0];

			expect(module.case_details.short.columns[0]).toMatchObject({
				field:
					"current()/../case[@case_id=current()/index/parent and @case_type='household']/@case_id",
				format: "calculate",
				useXpathExpression: true,
			});
		});

		it("does not change a parent calculation when Search is not part of the module", () => {
			const module = expandDoc(
				buildHqProjectionDoc(
					{ columns: [parentName()], searchInputs: [] },
					undefined,
					relatedCaseTypes,
				),
			).modules[0];

			expect(module.search_config.include_all_related_cases).toBe(false);
			expect(module.case_details.short.columns[0]).toMatchObject({
				format: "calculate",
				useXpathExpression: true,
			});
		});

		it("ignores a fully hidden unsorted definition", () => {
			const module = expandDoc(
				buildHqProjectionDoc(
					{
						columns: [
							parentName({
								visibleInList: false,
								visibleInDetail: false,
							}),
							plainColumn(
								testUuid("expander-visible-identity"),
								"case_name",
								"Name",
							),
						],
						searchInputs: [],
					},
					{},
					relatedCaseTypes,
				),
			).modules[0];

			expect(module.search_config.include_all_related_cases).toBe(false);
		});

		it("joins a hidden parent-property sort to the typed calculation", () => {
			const module = expandDoc(
				buildHqProjectionDoc(
					{
						columns: [
							parentName({
								visibleInList: false,
								visibleInDetail: false,
								sort: { direction: "asc", priority: 0 },
							}),
							plainColumn(
								testUuid("expander-visible-identity"),
								"case_name",
								"Name",
							),
						],
						searchInputs: [],
					},
					{},
					relatedCaseTypes,
				),
			).modules[0];

			expect(module.search_config.include_all_related_cases).toBe(true);
			expect(module.case_details.short.columns[0]).toMatchObject({
				field:
					"current()/../case[@case_id=current()/index/parent and @case_type='household']/case_name",
				format: "invisible",
				useXpathExpression: true,
			});
			expect(module.case_details.short.sort_elements[0]).toMatchObject({
				field: "_cc_calculated_0",
				sort_calculation:
					"current()/../case[@case_id=current()/index/parent and @case_type='household']/case_name",
			});
		});
	});

	it("preserves an intentional zero-input Search action through HQ JSON", () => {
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						testUuid("00000000-0000-4000-8000-000000040099"),
						"case_name",
						"Name",
					),
				],
				searchInputs: [],
			},
			{},
		);

		const searchConfig = expandDoc(doc).modules[0].search_config;
		// CCHQ's module_offers_search() ignores a CaseSearch document that has
		// neither properties nor default_properties. The neutral CSQL identity
		// is therefore load-bearing provenance for Nova's manual action.
		expect(searchConfig.properties).toEqual([]);
		expect(searchConfig.default_properties).toEqual([
			{ property: "_xpath_query", defaultValue: "'match-all()'" },
		]);
		expect(searchConfig.auto_launch).toBe(false);
		expect(searchConfig.default_search).toBe(false);
		expect(searchConfig.inline_search).toBe(false);
	});

	it("does not turn an ordinary always-on list filter into dormant server-search configuration", () => {
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000040000"),
					"case_name",
					"Name",
				),
			],
			// Property-to-property equality is valid for the on-device list
			// evaluator but intentionally outside CCHQ's server query language.
			// With search disabled it belongs only on the short detail filter.
			filter: eq(prop("patient", "age"), prop("patient", "age")),
			searchInputs: [],
		});

		const module = expandDoc(doc).modules[0];
		expect(module.case_details.short.filter).toBe("age = age");
		expect(module.search_config.properties).toEqual([]);
		expect(module.search_config.default_properties).toEqual([]);
	});

	it("lands display chrome on `title_label`, `description`, `search_button_label`, and `search_button_display_condition`", () => {
		// Each authored display slot in `caseSearchConfig` maps to its
		// matching CCHQ slot in `search_config`. Empty / absent
		// subtitle elides the description; an authored value lifts to
		// the `{en: ...}` LabelProperty shape.
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						testUuid("00000000-0000-4000-8000-000000040001"),
						"case_name",
						"Name",
					),
				],
				searchInputs: [],
			},
			{
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: "Search by **name** or village.",
				searchButtonLabel: "Search patients",
				searchButtonDisplayCondition: eq(sessionUser("role"), literal("Alice")),
			},
		);
		const searchConfig = expandDoc(doc).modules[0].search_config;
		expect(searchConfig.title_label).toEqual({ en: "Find a patient" });
		expect(searchConfig.description).toEqual({
			en: "Search by **name** or village.",
		});
		expect(searchConfig.search_button_label).toEqual({
			en: "Search patients",
		});
		expect(searchConfig.search_button_display_condition).toBe(
			"instance('commcaresession')/session/user/data/role = 'Alice'",
		);
	});

	it("compiles `excludedOwnerIds` to `blacklisted_owner_ids_expression`", () => {
		// CCHQ stores the excluded-owners filter as a normalized on-device
		// XPath string. The suite-XML side uses the same normalization and
		// wraps it as a `<data>` slot
		// at search time; the persistent doc carries the expression
		// directly because CCHQ regenerates the suite from the doc.
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						testUuid("00000000-0000-4000-8000-000000040002"),
						"case_name",
						"Name",
					),
				],
				searchInputs: [],
			},
			{
				excludedOwnerIds: toValueExpression(literal("excluded-owner-id")),
			},
		);
		const searchConfig = expandDoc(doc).modules[0].search_config;
		expect(searchConfig.blacklisted_owner_ids_expression).toBe(
			lowerXPathForJavaRosa("normalize-space('excluded-owner-id')"),
		);
	});

	it("projects simple-arm search inputs to `properties` with the right `input_` / `appearance` slots per input type", () => {
		// Simple-arm inputs land on `properties` as
		// `CaseSearchProperty` entries; the wire-attribute mapping
		// matches `PROMPT_ATTRIBUTE_MAPPINGS`. `text` leaves both
		// slots absent; `date` carries `input_: "date"`; barcode rides
		// `appearance: "barcode_scan"`.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000040003"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000040011"),
					"name_search",
					"Name",
					"text",
					"case_name",
				),
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000040012"),
					"dob_search",
					"DOB",
					"date",
					"dob",
				),
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000040013"),
					"scan_search",
					"Scan",
					"barcode",
					"case_name",
				),
			],
		});
		const properties = expandDoc(doc).modules[0].search_config.properties;
		expect(properties).toHaveLength(3);
		// Plain text: no `input_` / `appearance`.
		expect(properties[0].name).toBe("name_search");
		expect(properties[0].input_).toBeUndefined();
		expect(properties[0].appearance).toBeUndefined();
		// Date widget.
		expect(properties[1].name).toBe("dob_search");
		expect(properties[1].input_).toBe("date");
		// Barcode rides `appearance`.
		expect(properties[2].name).toBe("scan_search");
		expect(properties[2].appearance).toBe("barcode_scan");
	});

	it("refuses a scalar default on a paired date-range property", () => {
		expect(() =>
			simpleSearchInputDef(
				testUuid("00000000-0000-4000-8000-000000040015"),
				"last_visit",
				"Visit window",
				"date-range",
				"last_visit",
				{ default: today() },
			),
		).toThrow();
	});

	it("keeps mixed simple and advanced prompt bindings with shared widget/default metadata", () => {
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-0000000400a1"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-0000000400a2"),
					"case_name",
					"Name",
					"text",
					"case_name",
				),
				advancedSearchInputDef(
					testUuid("00000000-0000-4000-8000-0000000400a3"),
					"status",
					"Status rule",
					"text",
					eq(prop("patient", "status"), literal("open")),
				),
				advancedSearchInputDef(
					testUuid("00000000-0000-4000-8000-0000000400a4"),
					"visited_after",
					"",
					"date",
					eq(prop("patient", "last_visit"), dateLiteral("2026-07-17")),
					{ default: today() },
				),
			],
		});

		const properties = expandDoc(doc).modules[0].search_config.properties;
		expect(properties).toHaveLength(3);
		expect(properties[0]).toEqual(
			expect.objectContaining({ name: "case_name" }),
		);
		expect(properties[0].exclude).toBeUndefined();
		// Even a real/reserved case-property name must be excluded for an
		// advanced row: its authored predicate, not Core's exact matcher,
		// owns the comparison.
		expect(properties[1]).toEqual(
			expect.objectContaining({
				name: "status",
				label: { en: "Status rule" },
				exclude: true,
			}),
		);
		expect(properties[2]).toEqual(
			expect.objectContaining({
				name: "visited_after",
				label: { en: "visited_after" },
				input_: "date",
				default_value: "today()",
				exclude: true,
			}),
		);
	});

	it("never sets a `fuzzy` or `starts_with_search` boolean on `CaseSearchProperty` (CCHQ has no such field — non-exact modes route through `_xpath_query`)", () => {
		// Verified against
		// `commcare-hq/corehq/apps/app_manager/models.py::CaseSearchProperty`:
		// the field set is name / label / appearance / input_ /
		// default_value / hint / hidden / allow_blank_value / exclude /
		// required / validations / receiver_expression / itemset /
		// is_group / group_key. CCHQ's `DocumentSchema` ingest silently
		// drops unrecognized keys, so a `fuzzy: true` on the wire JSON
		// would land on the database as nothing — the runtime defaults
		// to exact full-string match.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-0000000400f1"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-0000000400f2"),
					"name_fuzzy",
					"Name",
					"text",
					"case_name",
					{ mode: { kind: "fuzzy" } },
				),
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-0000000400f3"),
					"name_starts",
					"Starts",
					"text",
					"case_name",
					{ mode: { kind: "starts-with" } },
				),
			],
		});
		const searchConfig = expandDoc(doc).modules[0].search_config;
		for (const property of searchConfig.properties) {
			expect(property).not.toHaveProperty("fuzzy");
			expect(property).not.toHaveProperty("starts_with_search");
		}
		// The matcher strategy rides on `_xpath_query` via the
		// `simpleArmDerivation` lift — one row per derived input.
		const xpathQueryValues = searchConfig.default_properties
			.filter((d) => d.property === "_xpath_query")
			.map((d) => d.defaultValue)
			.join("\n");
		expect(xpathQueryValues).toContain("fuzzy-match(case_name,");
		expect(xpathQueryValues).toContain("starts-with(case_name,");
	});

	it("projects `caseListConfig.filter` and every advanced-arm predicate as sibling `_xpath_query` rows on `default_properties`", () => {
		// CCHQ AND-composes every `_xpath_query` value it receives
		// (`corehq/apps/case_search/utils.py::_apply_filter` loops the
		// multi-term criteria into one ES filter each), so the filter
		// and each advanced-arm predicate project as their own rows. The
		// suite-XML side emits the same clauses as sibling `<data>`
		// elements — `composeXPathQueryEmission` is the shared helper.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000040004"),
					"case_name",
					"Name",
				),
			],
			// The baseline region rule AND-composes with every advanced-arm
			// predicate before emission.
			filter: eq(prop("patient", "region"), literal("North")),
			searchInputs: [
				advancedSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000040014"),
					"status_search",
					"Status",
					"text",
					eq(prop("patient", "workflow_status"), literal("active")),
				),
			],
		});
		const searchConfig = expandDoc(doc).modules[0].search_config;
		// CCHQ only creates input bindings from `search_config.properties`.
		// The advanced row therefore stays present as an excluded prompt:
		// its value is bound for `_xpath_query`, but Core does not also
		// submit `status_search=<value>` as an implicit property filter.
		expect(searchConfig.properties).toEqual([
			expect.objectContaining({ name: "status_search", exclude: true }),
		]);
		const defaults = searchConfig.default_properties;
		const xpathQueryValues = defaults
			.filter((d) => d.property === "_xpath_query")
			.map((d) => d.defaultValue);
		// One row per composed clause: the filter and the advanced-arm
		// predicate emit as independent bare CSQL literals; CCHQ's search
		// endpoint AND-composes every `_xpath_query` value it receives
		// (`case_search/utils.py::_apply_filter`).
		expect(xpathQueryValues).toEqual([
			`"region = 'North'"`,
			`"workflow_status = 'active'"`,
		]);
	});

	it("omits the `_xpath_query` slot entirely when no filter and no advanced-arm predicates are authored", () => {
		// CCHQ encodes "no server-side filter" by an absent slot, not
		// by emitting `_xpath_query = true()`.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000040005"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [],
		});
		const defaults = expandDoc(doc).modules[0].search_config.default_properties;
		expect(defaults.find((d) => d.property === "_xpath_query")).toBeUndefined();
	});

	it("inlines CSQL-non-grammar value expressions into the `_xpath_query` slot's concat, with no sibling `default_properties` entries", () => {
		// CSQL's value-function whitelist excludes `arith(...)`. The
		// CSQL emitter inlines each non-grammar value expression as
		// an on-device XPath fragment inside the wrapper concat —
		// the canonical CCHQ pattern at
		// `commcare-hq/docs/case_search_query_language.rst::"Example
		// Query + Tips"`. The wire shape on `default_properties` is
		// a single `_xpath_query` entry; sibling entries with
		// synthetic keys would be wire-incorrect because CCHQ's
		// `RemoteQuerySessionManager.initUserAnswers` only seeds the
		// `search-input:results` instance from `<prompt>` defaults
		// and the server-side `_apply_filter` would re-interpret the
		// sibling slot as a literal case-property filter against
		// case data.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000040006"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				advancedSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000040016"),
					"age_filter",
					"Age",
					"text",
					// Right-hand operand is a pure runtime `arith(18, +, 1)` — CSQL
					// doesn't admit arith inline, so the emitter
					// inlines the whole expression as an on-device
					// XPath fragment inside the wrapper concat.
					eq(
						prop("patient", "age"),
						toValueExpression(
							// Lift via the arith helper at builder layer.
							{
								kind: "arith",
								op: "+",
								left: term(literal(18)),
								right: term(literal(1)),
							},
						),
					),
				),
			],
		});
		const defaults = expandDoc(doc).modules[0].search_config.default_properties;
		// Exactly one entry — the `_xpath_query` slot. No sibling
		// entries for the inlined on-device fragment.
		expect(defaults).toHaveLength(1);
		expect(defaults[0].property).toBe("_xpath_query");
		// The arith's on-device emission `(18 + 1)` lands as a
		// runtime fragment inside the wrapper concat.
		expect(defaults[0].defaultValue).toContain("(18 + 1)");
		// The `_xpath_query` value never references a synthetic
		// search-input ref — that shape would silently zero out at
		// runtime per the CCHQ-side reasoning above.
		expect(defaults[0].defaultValue).not.toContain("csql_hoist_");
	});

	it("lifts an operator-direct prop(via) into an ancestor-exists envelope on the `_xpath_query` slot", () => {
		// CCHQ's CSQL grammar exposes relational reads only through
		// the `ancestor-exists` / `subcase-exists` query functions on
		// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`.
		// A `caseListConfig.filter` that reads a property on an
		// ancestor case lifts the via into an enclosing envelope
		// before the CSQL emitter walks the result; the
		// `_xpath_query` slot on `default_properties` carries the
		// envelope wire form. The same filter would emit a bare
		// property name on the wire without the lift — the same
		// authored AST would match different rows on the on-device
		// case list versus the server-side `<remote-request>`.
		const doc = buildDoc({
			appName: "Via Lift",
			modules: [
				{
					uuid: HQ_PROJECTION_MODULE_UUID,
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(
								testUuid("00000000-0000-4000-8000-000000040007"),
								"case_name",
								"Name",
							),
						],
						searchInputs: [],
						// Filter reads `region` on the patient's
						// `household` ancestor — without the lift
						// the wire emission would drop the via and
						// match `region` on the patient case itself.
						filter: eq(
							prop(
								"patient",
								"region",
								ancestorPath(relationStep("parent", "household")),
							),
							literal("North"),
						),
					},
					// Explicitly enable the rare filter-only search surface. Without
					// this marker the same rule is only the on-device list filter and
					// correctly does not create `_xpath_query` configuration.
					caseSearchConfig: {},
					forms: [
						{
							name: "Follow-up",
							type: "followup",
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
			],
			caseTypes: [
				{
					name: "patient",
					parent_type: "household",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "region", label: proseText("Region"), data_type: "text" },
					],
				},
				{
					name: "household",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "region", label: proseText("Region"), data_type: "text" },
					],
				},
			],
		});
		const defaults = expandDoc(doc).modules[0].search_config.default_properties;
		const xpathEntry = defaults.find((d) => d.property === "_xpath_query");
		expect(xpathEntry).toBeDefined();
		// The envelope shape: `ancestor-exists(<rel>, <inner>)` —
		// bare path on the first argument (CCHQ's
		// `_is_ancestor_path_expression` requires a path AST node,
		// not a string Literal). Inner reads the property bare (no
		// relation walk) because the envelope's destination scope
		// owns the resolution.
		expect(xpathEntry?.defaultValue).toContain("ancestor-exists(parent");
		expect(xpathEntry?.defaultValue).toContain("region = 'North'");
		// Defensive: the pre-lift bug emitted `region = 'North'`
		// without the envelope, so absence of `ancestor-exists` would
		// be the regression signal.
		expect(xpathEntry?.defaultValue).not.toMatch(
			/^(?!.*ancestor-exists).*region = 'North'/,
		);
	});
});

describe("expandDoc HQ JSON projection — case-search integration", () => {
	it("preserves the realistic case-search blueprint round-trip through every wire slot", () => {
		// One realistic blueprint exercises every authored slot — display
		// chrome, advanced cluster, simple + advanced search inputs, an
		// always-on filter, and per-kind columns + sort. The assertion
		// cluster pins the cross-slot composition: each slot lands on
		// its CCHQ-targeted wire field without clobbering the others.
		// `region` is a plain case property; the reserved `status`
		// case-attribute would prefix `@` in the on-device emission
		// and obscure the per-slot composition assertion. The advanced
		// arm gates against a different property (`age`) so this fixture
		// exercises several independent query clauses.
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						testUuid("00000000-0000-4000-8000-000000050001"),
						"case_name",
						"Name",
					),
					dateColumn(
						testUuid("00000000-0000-4000-8000-000000050002"),
						"last_visit",
						"Last Visit",
						"%Y-%m-%d",
						{ sort: { direction: "desc", priority: 0 } },
					),
				],
				filter: eq(prop("patient", "region"), literal("North")),
				searchInputs: [
					simpleSearchInputDef(
						testUuid("00000000-0000-4000-8000-000000050011"),
						"name_search",
						"Name",
						"text",
						"case_name",
					),
					advancedSearchInputDef(
						testUuid("00000000-0000-4000-8000-000000050012"),
						"age_filter",
						"Age",
						"text",
						eq(prop("patient", "age"), literal(30)),
					),
				],
			},
			{
				searchScreenTitle: "Find a patient",
				searchButtonLabel: "Search patients",
				excludedOwnerIds: toValueExpression(term(literal("excluded"))),
			},
		);
		const module = expandDoc(doc).modules[0];

		// Detail columns: per-kind formats survive.
		expect(module.case_details.short.columns).toHaveLength(2);
		expect(module.case_details.short.columns[0].format).toBe("plain");
		expect(module.case_details.short.columns[1].format).toBe("date");

		// Sort directive on the date column lifts to `sort_elements`.
		expect(module.case_details.short.sort_elements).toHaveLength(1);
		expect(module.case_details.short.sort_elements[0].field).toBe("last_visit");

		// Both always-on availability rules share
		// `case_details.short.filter`; owner exclusion is not limited to the
		// remote Search request.
		expect(module.case_details.short.filter).toBe(
			lowerXPathForJavaRosa(
				"(region = 'North') and (normalize-space('excluded') = '' or not(selected(normalize-space('excluded'), @owner_id)))",
			),
		);

		// Search-config chrome lands on the matching CCHQ slots.
		expect(module.search_config.title_label).toEqual({ en: "Find a patient" });
		expect(module.search_config.search_button_label).toEqual({
			en: "Search patients",
		});
		expect(module.search_config.blacklisted_owner_ids_expression).toBe(
			lowerXPathForJavaRosa("normalize-space('excluded')"),
		);

		// Both arms land on `properties`: CCHQ creates runtime prompt
		// bindings only from this list. The advanced prompt is excluded
		// from Core's implicit property matcher because its predicate is
		// already carried by `_xpath_query`.
		expect(module.search_config.properties).toHaveLength(2);
		expect(module.search_config.properties[0].name).toBe("name_search");
		expect(module.search_config.properties[0].exclude).toBe(true);
		expect(module.search_config.properties[1]).toEqual(
			expect.objectContaining({ name: "age_filter", exclude: true }),
		);

		// Advanced-arm predicate + filter emit as sibling `_xpath_query`
		// rows on `default_properties`; the server ANDs the values.
		const xpathValues = module.search_config.default_properties
			.filter((d) => d.property === "_xpath_query")
			.map((d) => d.defaultValue)
			.join("\n");
		expect(xpathValues).toContain("region");
		expect(xpathValues).toContain("age");
	});

	// ── Simple-arm-with-via routing into _xpath_query ──────────────

	it("projects a simple-arm input with non-self `via` as both a CaseSearchProperty AND a `_xpath_query` predicate", () => {
		// CCHQ's `<prompt>` / `CaseSearchProperty` binds exactly one
		// runtime value but carries no relation-walk metadata, so a
		// simple-arm input with `via: ancestor` would silently drop
		// its relation walk on the wire. The fix routes the derived
		// predicate through `_xpath_query` while keeping the
		// `CaseSearchProperty` slot present so CCHQ still binds the
		// user's typed value to the prompt key.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000060001"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000060011"),
					"parent_region",
					"Parent region",
					"text",
					"region",
					{
						via: ancestorPath(relationStep("parent")),
					},
				),
			],
		});
		const module = expandDoc(doc).modules[0];

		// CaseSearchProperty stays — CCHQ binds the typed value to
		// the prompt key at runtime.
		expect(module.search_config.properties).toHaveLength(1);
		expect(module.search_config.properties[0].name).toBe("parent_region");

		// The relation-walked predicate lands in `_xpath_query`. The
		// stored value is an on-device XPath that runtime-builds the
		// CSQL string via `concat(...)`, so the assertions pin the
		// XPath-level fragments rather than the runtime-evaluated CSQL.
		const xpathEntry = module.search_config.default_properties.find(
			(d) => d.property === "_xpath_query",
		);
		expect(xpathEntry).toBeDefined();
		// CCHQ requires the first arg of `ancestor-exists` to be a
		// bare path expression (`_is_ancestor_path_expression`
		// rejects a string Literal). The on-device emitter inlines
		// `parent` verbatim into the `concat(...)` constant text.
		expect(xpathEntry?.defaultValue).toContain("ancestor-exists(parent,");
		expect(xpathEntry?.defaultValue).toContain("region");
		// Wrapped in `when-input-present` so an unset input
		// contributes `match-all()` instead of matching empty-string
		// related properties.
		expect(xpathEntry?.defaultValue).toContain("if(count(");
		expect(xpathEntry?.defaultValue).toContain("'match-all()'");
	});

	it("keeps the bare-prompt-compatible simple-arm input out of `_xpath_query` (only the cross-walk input lands there)", () => {
		// The bare-prompt-compatible shape is self-walk + default
		// exact + `name === property` — CCHQ's runtime auto-match on
		// the prompt key IS the authored comparison. The cross-walk
		// input alongside it routes through `_xpath_query` because
		// the bare prompt has no relation-walk metadata.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000060002"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000060021"),
					"case_name",
					"Self name",
					"text",
					"case_name",
				),
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000060022"),
					"parent_region",
					"Parent region",
					"text",
					"region",
					{ via: ancestorPath(relationStep("parent")) },
				),
			],
		});
		const module = expandDoc(doc).modules[0];

		// Both inputs surface as CaseSearchProperty entries.
		expect(module.search_config.properties).toHaveLength(2);

		// Only the cross-walk input contributes a `_xpath_query`
		// predicate; the self-walk one rides on its prompt binding
		// alone.
		const xpathEntry = module.search_config.default_properties.find(
			(d) => d.property === "_xpath_query",
		);
		expect(xpathEntry).toBeDefined();
		// `ancestor-exists` first arg is a bare path AST node, not a
		// string Literal — CCHQ's
		// `_is_ancestor_path_expression` rejects the literal shape.
		expect(xpathEntry?.defaultValue).toContain("ancestor-exists(parent,");
		expect(xpathEntry?.defaultValue).toContain("@name='parent_region'");
		// The bare-prompt-compatible input's name (`case_name`) does
		// NOT appear in the derived `_xpath_query` predicate — it
		// rides on its prompt binding alone, with CCHQ's runtime
		// auto-match doing the comparison.
		expect(xpathEntry?.defaultValue).not.toContain("@name='case_name'");
	});

	// ── exclude="true()" / exclude: true bogus-auto-match suppression ──

	it("sets `exclude: true` on simple-arm CaseSearchProperty when `name !== property` (default exact, self-walk)", () => {
		// CCHQ's runtime auto-matches the typed value against the
		// case property NAMED BY the prompt key. When `name !==
		// property` the auto-match queries a case property that may
		// not exist (or queries the wrong one); the `exclude: true`
		// flag suppresses the auto-match. Verified against
		// `commcare-hq/.../suite_xml/post_process/remote_requests.py::build_query_prompts`
		// (`'key': prop.name` + `if prop.exclude: kwargs['exclude']
		// = "true()"`) and
		// `commcare-core/.../session/RemoteQuerySessionManager.java::RemoteQuerySessionManager.getRawQueryParams`
		// (the `excludeExpr.eval` check skips the auto-match while
		// keeping the typed value bound to the search-input
		// instance for the explicit `_xpath_query` predicate).
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000060030"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000060031"),
					"name_search",
					"Name",
					"text",
					"case_name",
				),
			],
		});
		const module = expandDoc(doc).modules[0];
		expect(module.search_config.properties).toHaveLength(1);
		expect(module.search_config.properties[0].name).toBe("name_search");
		expect(module.search_config.properties[0].exclude).toBe(true);

		// And the `_xpath_query` slot carries the explicit comparison
		// the suppressed auto-match would otherwise have done — the
		// typed value matches against the authored target property
		// `case_name`, not the prompt key `name_search`.
		const xpathEntry = module.search_config.default_properties.find(
			(d) => d.property === "_xpath_query",
		);
		expect(xpathEntry).toBeDefined();
		expect(xpathEntry?.defaultValue).toContain("case_name");
		expect(xpathEntry?.defaultValue).toContain("@name='name_search'");
	});

	it("omits the `exclude` field on a bare-prompt-compatible simple-arm input (`name === property`, self-walk, default exact)", () => {
		// The bare-prompt-correct case: CCHQ's auto-match against the
		// prompt key IS the authored comparison. Emitting `exclude:
		// true` here would suppress the very behaviour the user
		// wants. Pin the negative so a regression that over-applies
		// the field surfaces.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					testUuid("00000000-0000-4000-8000-000000060040"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000060041"),
					"case_name",
					"Name",
					"text",
					"case_name",
				),
			],
		});
		const property = expandDoc(doc).modules[0].search_config.properties[0];
		expect(property.exclude).toBeUndefined();
	});
});
