import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { asUuid } from "@/lib/domain";

// Shared fixtures used across the main expander cases below. Each test
// outside this block constructs its own fixture inline to keep the
// given-when-then narrative next to the assertion.
const followupDoc = buildDoc({
	appName: "Test App",
	modules: [
		{
			name: "Visits",
			caseType: "patient",
			caseListColumns: [{ field: "full_name", header: "Name" }],
			forms: [
				{
					name: "Follow-up Visit",
					type: "followup",
					fields: [
						f({
							kind: "group",
							id: "client_info",
							label: "Client Info",
							children: [
								f({
									kind: "text",
									id: "full_name",
									label: "Name",
									case_property: "patient",
								}),
							],
						}),
						f({
							kind: "hidden",
							id: "total_visits",
							calculate: "#case/total_visits + 1",
							case_property: "patient",
						}),
						f({ kind: "text", id: "notes", label: "Notes" }),
					],
				},
			],
		},
	],
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "full_name", label: "Full Name" },
				{ name: "total_visits", label: "Total Visits" },
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
			caseListColumns: [
				{ field: "case_name", header: "Name" },
				{ field: "age", header: "Age" },
			],
			forms: [
				{
					name: "Register Patient",
					type: "registration",
					fields: [
						f({
							kind: "text",
							id: "case_name",
							label: "Full Name",
							required: "true()",
							case_property: "patient",
						}),
						f({
							kind: "int",
							id: "age",
							label: "Age",
							validate: ". > 0 and . < 150",
							case_property: "patient",
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
				{ name: "case_name", label: "Full Name" },
				{ name: "age", label: "Age" },
			],
		},
	],
});

describe("expandDoc", () => {
	it("populates case_references_data.load with #case/ hashtag references", () => {
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
					caseType: "case",
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "group",
									id: "grp",
									label: "G",
									children: [
										f({
											kind: "hidden",
											id: "some_prop",
											calculate: "#case/some_prop + #user/role",
											case_property: "case",
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
					name: "case",
					properties: [{ name: "some_prop", label: "Some Prop" }],
				},
			],
		});
		const load = expandDoc(doc).modules[0].forms[0].case_references_data.load;
		expect(load["/data/grp/some_prop"]).toEqual(
			expect.arrayContaining(["#case/some_prop", "#user/role"]),
		);
	});

	it("expands #case/ to full XPath in calculate, keeps shorthand in vellum:calculate", () => {
		const hq = expandDoc(followupDoc);
		const xform: string = Object.values(hq._attachments)[0] as string;

		// Real calculate should have the expanded instance() XPath
		expect(xform).toContain(
			"calculate=\"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/total_visits + 1\"",
		);
		// Vellum calculate preserves the shorthand for the editor
		expect(xform).toContain('vellum:calculate="#case/total_visits + 1"');
		// Hashtag metadata still present
		expect(xform).toContain("vellum:hashtags=");
		expect(xform).toContain("vellum:hashtagTransforms=");
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
		expect(xform).toContain('vellum:ref="#form/status" ref="/data/status"');
		expect(xform).toContain("value=\"'pending'\"");
		// No vellum:value when there are no hashtags in the value expression
		expect(xform).not.toContain("vellum:value=");
	});

	it("expands #case/ in setvalue default_value, keeps shorthand in vellum:value", () => {
		const doc = buildDoc({
			appName: "DV",
			modules: [
				{
					name: "M",
					caseType: "c",
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "full_name",
									label: "Name",
									default_value: "#case/full_name",
									case_property: "c",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "c", properties: [{ name: "full_name", label: "Full Name" }] },
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		// Real value attribute should have expanded XPath (XML-escaped)
		expect(xform).toContain("instance('casedb')");
		expect(xform).toContain('/full_name"');
		// Vellum value preserves shorthand
		expect(xform).toContain('vellum:value="#case/full_name"');
	});

	it("omits itext label for hidden fields without a label", () => {
		const hq = expandDoc(followupDoc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		// Hidden field 'total_visits' has no label — should not get an itext entry
		expect(xform).not.toContain('id="total_visits-label"');
		// Visible field 'notes' should still get one
		expect(xform).toContain('id="notes-label"');
	});

	it("handles close forms — conditional and unconditional", () => {
		const doc = buildDoc({
			appName: "Close",
			modules: [
				{
					name: "M",
					caseType: "case",
					forms: [
						{
							name: "Conditional Close",
							type: "close",
							closeCondition: { field: "confirm", answer: "yes" },
							fields: [
								f({
									kind: "single_select",
									id: "confirm",
									label: "Close?",
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
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
			caseTypes: [
				{ name: "case", properties: [{ name: "name", label: "Name" }] },
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
				caseListColumns: [
					{ field: "case_name", header: "Full Name" },
					{ field: "age", header: "Age" },
				],
				forms: [
					{
						name: "F",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
	});

	it("expander keeps case_name column in case details", () => {
		const hq = expandDoc(doc);
		const cols = hq.modules[0].case_details.short.columns;
		expect(cols.some((c) => c.field === "case_name")).toBe(true);
	});

	it("validator allows case_name in case_list_columns", () => {
		expect(
			runValidation(doc).some((e) => e.code === "RESERVED_CASE_PROPERTY"),
		).toBe(false);
	});
});

describe("runValidation", () => {
	it("passes for a valid blueprint", () => {
		expect(runValidation(registrationDoc)).toEqual([]);
	});

	it("catches missing case_type on case forms", () => {
		const doc = buildDoc({
			appName: "Bad",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Q",
									case_property: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "NO_CASE_TYPE")).toBe(true);
	});

	it("catches reserved case property names", () => {
		const doc = buildDoc({
			appName: "Bad",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListColumns: [{ field: "case_name", header: "Name" }],
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: "Q",
									case_property: "c",
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "c", properties: [{ name: "name", label: "Q" }] }],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "RESERVED_CASE_PROPERTY")).toBe(true);
	});

	it("catches registration form without case_name field", () => {
		const doc = buildDoc({
			appName: "Bad",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListColumns: [{ field: "case_name", header: "Name" }],
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
			caseTypes: [{ name: "c", properties: [{ name: "q", label: "Q" }] }],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "NO_CASE_NAME_FIELD")).toBe(true);
	});
});

// ── Feature 1: Output References in Labels ──────────────────────────────

describe("output references in labels", () => {
	it('preserves <output value="..."/> in label itext, escaping surrounding text', () => {
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
								f({ kind: "text", id: "name", label: "Name" }),
								f({
									kind: "label",
									id: "greeting",
									label: 'Hello <output value="/data/name"/>, welcome!',
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain(
			'<text id="greeting-label"><value>Hello <output value="/data/name"/>, welcome!</value><value form="markdown">Hello <output value="/data/name"/>, welcome!</value></text>',
		);
	});

	it('expands #case/ hashtags inside <output value="..."/> tags', () => {
		const doc = buildDoc({
			appName: "Output",
			modules: [
				{
					name: "M",
					caseType: "c",
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "full_name",
									label: "Name",
									case_property: "c",
								}),
								f({
									kind: "label",
									id: "msg",
									label: 'Patient: <output value="#case/full_name"/>',
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "c", properties: [{ name: "full_name", label: "Full Name" }] },
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		// The output value= should have expanded XPath, vellum:value preserves shorthand
		expect(xform).toContain('<output value="instance(');
		expect(xform).toContain('vellum:value="#case/full_name"');
	});

	it("wraps bare #case/ in label text as <output> tags with expanded XPath", () => {
		const doc = buildDoc({
			appName: "BareRef",
			modules: [
				{
					name: "M",
					caseType: "c",
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property: "c",
								}),
								f({
									kind: "date",
									id: "start_date",
									label: "Start",
									case_property: "c",
								}),
								f({
									kind: "date",
									id: "end_date",
									label: "End",
									case_property: "c",
								}),
								f({
									kind: "label",
									id: "summary",
									label:
										"Plan: **#case/case_name**, from #case/start_date to #case/end_date",
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
						{ name: "case_name", label: "Name" },
						{ name: "start_date", label: "Start" },
						{ name: "end_date", label: "End" },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		// Bare #case/ text should not appear in label content
		expect(xform).not.toContain("#case/case_name**");
		expect(xform).not.toContain("to #case/end_date");
		// Shorthand preserved in vellum:value attributes on output tags
		expect(xform).toContain('vellum:value="#case/case_name"');
		expect(xform).toContain('vellum:value="#case/start_date"');
		expect(xform).toContain('vellum:value="#case/end_date"');
		// Each output tag should have expanded instance() XPath
		expect(xform).toContain('<output value="instance(');
		// All itext entries get both <value> and <value form="markdown">, so 3 refs × 2 = 6
		const outputCount = (xform.match(/vellum:value="#case\//g) || []).length;
		expect(outputCount).toBe(6);
	});

	it("wraps bare #form/ in label text as <output> tags", () => {
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
								f({ kind: "text", id: "user_name", label: "Your name" }),
								f({
									kind: "label",
									id: "greeting",
									label: "Hello #form/user_name!",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).not.toContain("#form/user_name!");
		expect(xform).toContain(
			'<output value="/data/user_name" vellum:value="#form/user_name"/>',
		);
	});

	it("handles mixed bare hashtags and existing <output> tags in one label", () => {
		const doc = buildDoc({
			appName: "Mixed",
			modules: [
				{
					name: "M",
					caseType: "c",
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property: "c",
								}),
								f({
									kind: "text",
									id: "status",
									label: "Status",
									case_property: "c",
								}),
								f({
									kind: "label",
									id: "info",
									label:
										'Hello <output value="#case/case_name"/>, status: #case/status',
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
						{ name: "case_name", label: "Name" },
						{ name: "status", label: "Status" },
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		// The bare #case/status from the label should be wrapped and expanded
		const infoLabel =
			xform.match(/<text id="info-label">.*?<\/text>/s)?.[0] || "";
		expect(infoLabel).not.toContain("status: #case/status");
		// Both existing <output> and bare ref should be expanded with vellum:value
		expect(infoLabel).toContain('vellum:value="#case/case_name"');
		expect(infoLabel).toContain('vellum:value="#case/status"');
	});
});

// ── Markdown itext for all field kinds ───────────────────────────────────

describe("markdown itext for all field kinds", () => {
	/** Extract a single itext entry by ID from XForm XML. */
	const extractItext = (xform: string, id: string): string =>
		xform.match(new RegExp(`<text id="${id}">.*?</text>`, "s"))?.[0] ?? "";

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
									label: "Enter your **full name**",
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
		const entry = extractItext(xform, "name-label");
		expect(entry).toContain("<value>Enter your **full name**</value>");
		expect(entry).toContain(
			'<value form="markdown">Enter your **full name**</value>',
		);
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
									label: "Current **status**",
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
		const label = extractItext(xform, "status-label");
		expect(label).toContain(
			'<value form="markdown">Current **status**</value>',
		);
		// Option labels
		const activeOpt = extractItext(xform, "status-active-label");
		expect(activeOpt).toContain(
			'<value form="markdown">**Active** &#x2014; currently enrolled</value>',
		);
		const inactiveOpt = extractItext(xform, "status-inactive-label");
		expect(inactiveOpt).toContain('<value form="markdown">_Inactive_</value>');
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
									label: "Age",
									hint: "Enter age in **years**",
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
		const hint = extractItext(xform, "age-hint");
		expect(hint).toContain(
			'<value form="markdown">Enter age in **years**</value>',
		);
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
									label: "## Demographics",
									children: [f({ kind: "text", id: "name", label: "Name" })],
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
		const entry = extractItext(xform, "demographics-label");
		expect(entry).toContain("<value>## Demographics</value>");
		expect(entry).toContain('<value form="markdown">## Demographics</value>');
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
									label: "Add **child** details",
									children: [
										f({ kind: "text", id: "child_name", label: "Child name" }),
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
		const entry = extractItext(xform, "children-label");
		expect(entry).toContain(
			'<value form="markdown">Add **child** details</value>',
		);
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
									label: "Date of **visit**",
								}),
								f({ kind: "decimal", id: "weight", label: "Weight _(kg)_" }),
								f({ kind: "image", id: "photo", label: "Take a **photo**" }),
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;
		expect(extractItext(xform, "visit_date-label")).toContain(
			'<value form="markdown">Date of **visit**</value>',
		);
		expect(extractItext(xform, "weight-label")).toContain(
			'<value form="markdown">Weight _(kg)_</value>',
		);
		expect(extractItext(xform, "photo-label")).toContain(
			'<value form="markdown">Take a **photo**</value>',
		);
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
								f({ kind: "text", id: "first_name", label: "First" }),
								f({ kind: "text", id: "last_name", label: "Last" }),
								f({
									kind: "hidden",
									id: "full_name",
									calculate: "concat(#form/first_name, ' ', #form/last_name)",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain(
			"calculate=\"concat(/data/first_name, ' ', /data/last_name)\"",
		);
		expect(xform).toContain(
			"vellum:calculate=\"concat(#form/first_name, ' ', #form/last_name)\"",
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
									label: "Consent?",
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
								f({
									kind: "text",
									id: "details",
									label: "Details",
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
		expect(xform).toContain("relevant=\"/data/consent = 'yes'\"");
		expect(xform).toContain("vellum:relevant=\"#form/consent = 'yes'\"");
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
								f({ kind: "date", id: "start_date", label: "Start" }),
								f({
									kind: "date",
									id: "end_date",
									label: "End",
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
		expect(xform).toContain('constraint=". &gt;= /data/start_date"');
		expect(xform).toContain('vellum:constraint=". &gt;= #form/start_date"');
	});

	// Regression: validate_msg must round-trip through CommCare HQ.
	//
	// HQ's XForm parser (`corehq/apps/app_manager/xform.py:1167`) only reads
	// `jr:constraintMsg` when it points at an itext id via `jr:itext(...)` —
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
									label: "Age",
									validate: ". > 0 and . < 150",
									validate_msg: "Age must be between 1 and 149",
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

		// Bind references the itext id, not the raw message string.
		expect(xform).toContain(`jr:constraintMsg="jr:itext('age-constraintMsg')"`);
		// Raw message must NOT appear inside the bind attribute (it would be
		// ignored by HQ and Vellum would lose it on save).
		expect(xform).not.toContain(
			'jr:constraintMsg="Age must be between 1 and 149"',
		);

		// Matching itext entry is present, with both plain and markdown forms
		// (every other textual itext entry also emits both — constraint
		// messages shouldn't be a silent exception).
		const entry = xform.match(/<text id="age-constraintMsg">.*?<\/text>/s)?.[0];
		expect(entry).toBeDefined();
		expect(entry).toContain("<value>Age must be between 1 and 149</value>");
		expect(entry).toContain(
			'<value form="markdown">Age must be between 1 and 149</value>',
		);
	});

	// Regression: validation is only legal on input field kinds.
	//
	// Hidden fields are computed from `calculate`/`default_value`, so the
	// user can never see or correct a failing constraint — a `validate_msg`
	// on them is dead metadata. Structural containers (group/repeat) and
	// display-only labels similarly can't surface an error. The XForm
	// emitter drops both the bind attributes and the itext entry for these
	// kinds so a stale `validate_msg` can't leak into HQ.
	it("drops validate and validate_msg on hidden fields", () => {
		// The hidden-field schema doesn't declare `validate` / `validate_msg`,
		// but the emitter must defensively strip them if they ever appear on
		// a field value (e.g. via a stale migration). Use a looser field spec.
		const doc = buildDoc({
			appName: "HiddenVal",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								{
									kind: "hidden",
									id: "risk",
									calculate: "if(/data/age > 65, 'high', 'low')",
									validate: ". != 'unknown'",
									validate_msg: "Risk must resolve",
								},
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;

		expect(xform).not.toContain("jr:constraintMsg");
		expect(xform).not.toContain("constraint=");
		expect(xform).not.toContain(`<text id="risk-constraintMsg">`);
		expect(xform).not.toContain("Risk must resolve");
	});

	it("drops validate_msg on label and group fields", () => {
		const doc = buildDoc({
			appName: "StructuralVal",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								{
									kind: "label",
									id: "section_header",
									label: "Demographics",
									validate_msg: "should never appear",
								},
								{
									kind: "group",
									id: "demographics",
									label: "Demographics",
									validate_msg: "should never appear either",
									children: [f({ kind: "text", id: "name", label: "Name" })],
								},
							],
						},
					],
				},
			],
		});
		const xform: string = Object.values(
			expandDoc(doc)._attachments,
		)[0] as string;

		expect(xform).not.toContain("jr:constraintMsg");
		expect(xform).not.toContain(`<text id="section_header-constraintMsg">`);
		expect(xform).not.toContain(`<text id="demographics-constraintMsg">`);
		expect(xform).not.toContain("should never appear");
	});

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
									label: "Issue?",
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
								f({
									kind: "text",
									id: "details",
									label: "Details",
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
		expect(xform).toContain("required=\"/data/has_issue = 'yes'\"");
		expect(xform).toContain("vellum:required=\"#form/has_issue = 'yes'\"");
	});

	it("expands #form/ in <output> tags with vellum:value", () => {
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
									calculate: "'Text'",
									default_value: "'Text'",
								}),
								f({
									kind: "label",
									id: "here",
									label: 'Here <output value="#form/text_value"/>',
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain(
			'<output value="/data/text_value" vellum:value="#form/text_value"/>',
		);
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
								f({ kind: "int", id: "score_a", label: "Score A" }),
								f({ kind: "int", id: "score_b", label: "Score B" }),
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
		expect(xform).toContain('value="/data/score_a + /data/score_b"');
		expect(xform).toContain('vellum:value="#form/score_a + #form/score_b"');
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
								f({ kind: "text", id: "name", label: "Name" }),
								f({ kind: "int", id: "age", label: "Age" }),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain('vellum:nodeset="#form/name" nodeset="/data/name"');
		expect(xform).toContain('vellum:nodeset="#form/age" nodeset="/data/age"');
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
									label: "Group",
									children: [f({ kind: "text", id: "inner", label: "Inner" })],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain(
			'vellum:nodeset="#form/grp/inner" nodeset="/data/grp/inner"',
		);
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
		expect(xform).toContain('vellum:ref="#form/ts" ref="/data/ts"');
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
									label: "Show?",
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
								f({
									kind: "group",
									id: "details",
									label: "Details",
									relevant: "#form/show = 'yes'",
									children: [f({ kind: "text", id: "info", label: "Info" })],
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain("relevant=\"/data/show = 'yes'\"");
		expect(xform).toContain("vellum:relevant=\"#form/show = 'yes'\"");
		expect(xform).toContain('vellum:nodeset="#form/details"');
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
								f({ kind: "int", id: "a", label: "A" }),
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
		// #form/ is NOT in VELLUM_HASHTAG_TRANSFORMS — no transforms metadata needed
		expect(xform).not.toContain("vellum:hashtags=");
		expect(xform).not.toContain("vellum:hashtagTransforms=");
		// But vellum:calculate IS present (preserves shorthand for Vellum editor)
		expect(xform).toContain('vellum:calculate="#form/a * 2"');
		expect(xform).toContain('calculate="/data/a * 2"');
	});

	it("does not require secondary instances for #form/-only expressions", () => {
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
								f({ kind: "int", id: "a", label: "A" }),
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
		expect(xform).not.toContain('id="casedb"');
		expect(xform).not.toContain('id="commcaresession"');
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
								f({ kind: "text", id: "q", label: "Q", required: "true()" }),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain('required="true()"');
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
									label: "Consent?",
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
								f({
									kind: "text",
									id: "details",
									label: "Details",
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
		expect(xform).toContain("required=\"/data/consent = 'yes'\"");
		expect(xform).not.toContain('required="true()"');
	});

	it("expands #case/ hashtags in required XPath and adds vellum:required", () => {
		const doc = buildDoc({
			appName: "R",
			modules: [
				{
					name: "M",
					caseType: "c",
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "risk",
									label: "Q",
									case_property: "c",
								}),
								f({
									kind: "text",
									id: "notes",
									label: "Notes",
									required: "#case/risk = 'high'",
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "c", properties: [{ name: "risk", label: "Risk" }] }],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain("vellum:required=\"#case/risk = 'high'\"");
		expect(xform).toContain("instance('casedb')");
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
					caseListColumns: [
						{ field: "case_name", header: "Name" },
						{ field: "age", header: "Age" },
					],
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property: "c",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "c", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		const hq = expandDoc(doc);
		const longCols = hq.modules[0].case_details.long.columns;
		expect(longCols.length).toBe(2);
		expect(longCols[0].field).toBe("case_name");
	});

	it("uses explicit case_detail_columns for long detail when provided", () => {
		const doc = buildDoc({
			appName: "D",
			modules: [
				{
					name: "M",
					caseType: "c",
					caseListColumns: [{ field: "case_name", header: "Name" }],
					caseDetailColumns: [
						{ field: "case_name", header: "Full Name" },
						{ field: "age", header: "Age" },
						{ field: "dob", header: "Date of Birth" },
					],
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property: "c",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "c", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		const hq = expandDoc(doc);
		const longCols = hq.modules[0].case_details.long.columns;
		expect(longCols.length).toBe(3);
		expect(longCols[0].header.en).toBe("Full Name");
		expect(longCols[2].field).toBe("dob");
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
							fields: [f({ kind: "text", id: "name", label: "Patient Name" })],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		expect(xform).toContain('lang="en" default=""');
		expect(xform).toContain("Patient Name");
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
									label: "Items",
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
		expect(xform).toContain('event="jr-insert"');
		expect(xform).not.toContain('event="xforms-ready"');
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
		expect(xform).toContain('event="xforms-ready"');
		expect(xform).not.toContain('event="jr-insert"');
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
									label: "Items",
									children: [
										f({ kind: "text", id: "item_name", label: "Item" }),
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
		expect(xform).toContain('<items jr:template="">');
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
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Patient Name",
									case_property: "patient",
								}),
								f({
									kind: "int",
									id: "age",
									label: "Age",
									case_property: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
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
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Patient Name",
									case_property: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "WRONG" }],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform: string = Object.values(hq._attachments)[0] as string;
		// Should use the field's own label, not the case_types label
		expect(xform).toContain("Patient Name");
		expect(xform).not.toContain("WRONG");
	});
});

// ── Unquoted String Literal Detection ────────────────────────────────────

describe("unquoted string literal detection", () => {
	/**
	 * Build a one-field survey doc with the caller's field overrides
	 * merged onto a simple text field.
	 *
	 * `error.details.field` in the validator carries the domain key name
	 * (`validate` instead of wire-format `validation`), so callers using
	 * the old key name should spell the new one.
	 */
	const makeDoc = (overrides: Record<string, unknown>) =>
		buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								{
									kind: "text",
									id: "q",
									label: "Q",
									...overrides,
								} as unknown as Parameters<typeof f>[0],
							],
						},
					],
				},
			],
		});

	it("catches bare string in default_value", () => {
		const errors = runValidation(
			makeDoc({ kind: "hidden", default_value: "no", calculate: "1" }),
		);
		expect(
			errors.some(
				(e) =>
					e.code === "UNQUOTED_STRING_LITERAL" &&
					e.location.field === "default_value",
			),
		).toBe(true);
	});

	it("catches bare string in calculate", () => {
		const errors = runValidation(
			makeDoc({ kind: "hidden", calculate: "pending" }),
		);
		expect(
			errors.some(
				(e) =>
					e.code === "UNQUOTED_STRING_LITERAL" &&
					e.location.field === "calculate",
			),
		).toBe(true);
	});

	it("catches bare string in relevant", () => {
		const errors = runValidation(makeDoc({ relevant: "yes" }));
		expect(
			errors.some(
				(e) =>
					e.code === "UNQUOTED_STRING_LITERAL" &&
					e.location.field === "relevant",
			),
		).toBe(true);
	});

	it("allows quoted string literal", () => {
		const errors = runValidation(
			makeDoc({ kind: "hidden", default_value: "'no'", calculate: "1" }),
		);
		expect(errors.some((e) => e.code === "UNQUOTED_STRING_LITERAL")).toBe(
			false,
		);
	});

	it("allows function calls", () => {
		const errors = runValidation(makeDoc({ required: "true()" }));
		expect(errors.some((e) => e.code === "UNQUOTED_STRING_LITERAL")).toBe(
			false,
		);
	});

	it("allows XPath expressions", () => {
		const errors = runValidation(makeDoc({ relevant: "/data/age > 18" }));
		expect(errors.some((e) => e.code === "UNQUOTED_STRING_LITERAL")).toBe(
			false,
		);
	});

	it("allows hashtag references", () => {
		const errors = runValidation(
			makeDoc({ kind: "hidden", calculate: "#case/status" }),
		);
		expect(errors.some((e) => e.code === "UNQUOTED_STRING_LITERAL")).toBe(
			false,
		);
	});

	it("allows number literals", () => {
		const errors = runValidation(
			makeDoc({ kind: "hidden", default_value: "0", calculate: "1" }),
		);
		expect(errors.some((e) => e.code === "UNQUOTED_STRING_LITERAL")).toBe(
			false,
		);
	});

	it("allows today() function", () => {
		const errors = runValidation(
			makeDoc({ kind: "hidden", default_value: "today()", calculate: "1" }),
		);
		expect(errors.some((e) => e.code === "UNQUOTED_STRING_LITERAL")).toBe(
			false,
		);
	});

	it("allows dot expressions", () => {
		const errors = runValidation(makeDoc({ validate: ". > 0" }));
		expect(errors.some((e) => e.code === "UNQUOTED_STRING_LITERAL")).toBe(
			false,
		);
	});

	it("catches bare string inside group children", () => {
		const doc = buildDoc({
			appName: "Test",
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
									label: "Group",
									children: [
										f({
											kind: "hidden",
											id: "status",
											calculate: "1",
											default_value: "active",
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(
			errors.some(
				(e) =>
					e.code === "UNQUOTED_STRING_LITERAL" &&
					e.details?.bareWord === "active",
			),
		).toBe(true);
	});
});

// ── Child Case Type Module Requirement ─────────────────────────────────

describe("child case type module requirement", () => {
	it("errors when child case type has no module", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Plans",
					caseType: "plan",
					caseListColumns: [{ field: "case_name", header: "Name" }],
					forms: [
						{
							name: "Create Plan",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Plan Name",
									case_property: "plan",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "plan",
					properties: [{ name: "case_name", label: "Plan Name" }],
				},
				{
					name: "service",
					parent_type: "plan",
					properties: [{ name: "case_name", label: "Service Name" }],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "MISSING_CHILD_CASE_MODULE")).toBe(
			true,
		);
	});

	it("no error when child case type has a case_list_only module", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Plans",
					caseType: "plan",
					caseListColumns: [{ field: "case_name", header: "Name" }],
					forms: [
						{
							name: "Create Plan",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Plan Name",
									case_property: "plan",
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
				},
			],
			caseTypes: [
				{
					name: "plan",
					properties: [{ name: "case_name", label: "Plan Name" }],
				},
				{
					name: "service",
					parent_type: "plan",
					properties: [{ name: "case_name", label: "Service Name" }],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "MISSING_CHILD_CASE_MODULE")).toBe(
			false,
		);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_LIST_ONLY_HAS_FORMS" ||
					e.code === "CASE_LIST_ONLY_NO_CASE_TYPE",
			),
		).toBe(false);
	});
});

// ── case_list_only Validation ──────────────────────────────────────────

describe("case_list_only validation", () => {
	it("errors when case_list_only module has forms", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Bad",
					caseType: "thing",
					caseListOnly: true,
					caseListColumns: [{ field: "case_name", header: "Name" }],
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
			caseTypes: [{ name: "thing", properties: [] }],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CASE_LIST_ONLY_HAS_FORMS")).toBe(
			true,
		);
	});

	it("errors when case_list_only module has no case_type", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Bad",
					caseListOnly: true,
					forms: [],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CASE_LIST_ONLY_NO_CASE_TYPE")).toBe(
			true,
		);
	});

	it("errors when module has case_type and no forms but missing case_list_only flag", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Ambiguous",
					caseType: "thing",
					forms: [],
				},
			],
			caseTypes: [{ name: "thing", properties: [] }],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "NO_FORMS_OR_CASE_LIST")).toBe(true);
	});
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
					forms: [
						{
							name: "Create Plan",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Plan Name",
									case_property: "plan",
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
				},
			],
			caseTypes: [
				{
					name: "plan",
					properties: [{ name: "case_name", label: "Plan Name" }],
				},
				{
					name: "service",
					parent_type: "plan",
					properties: [{ name: "case_name", label: "Service Name" }],
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
				},
			],
			caseTypes: [
				{ name: "service", properties: [{ name: "case_name", label: "Name" }] },
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
					forms: [
						{
							name: "Create Plan",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Plan Name",
									case_property: "plan",
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
				},
			],
			caseTypes: [
				{
					name: "plan",
					properties: [{ name: "case_name", label: "Plan Name" }],
				},
				{
					name: "service",
					parent_type: "plan",
					properties: [{ name: "case_name", label: "Service Name" }],
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
// The pipeline must degrade cleanly on corner shapes the builder permits
// mid-edit: forms with no fields yet, containers awaiting children, and
// containers nested inside containers. These tests pin the structural
// invariants so a refactor can't silently stop emitting the wrappers.

describe("empty form expansion", () => {
	// A form with zero fields is a valid intermediate state while the SA
	// or a user scaffolds a module. It must still produce a well-formed
	// XForm shell that downstream validation accepts — no fields means no
	// binds and no body children, but the `<data>` and `<h:body>` wrappers
	// still need to be present for CommCare Mobile to load the form.
	it("emits a valid empty XForm when a survey form has zero fields", () => {
		const doc = buildDoc({
			appName: "Empty",
			modules: [
				{ name: "M", forms: [{ name: "F", type: "survey", fields: [] }] },
			],
		});
		const hq = expandDoc(doc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		// Shell present but inner data/body are empty.
		expect(xml).toContain("<h:head>");
		expect(xml).toContain("<h:body>");
		// The `<data>` element exists but has no children.
		expect(xml).toMatch(/<data[^>]*>\s*<\/data>/);
		// No binds emitted because there are no fields.
		expect(xml).not.toMatch(/<bind[^/]*\/>/);
	});
});

describe("empty container expansion", () => {
	// A group container with no children is another mid-edit state — the
	// SA adds the container first and populates it in a follow-up call.
	// The emitter must still lay down the `<group>` wrapper + its label so
	// the user can see where children will land.
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
									label: "Demographics",
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

		// Body wraps the group — no children inside the `<group>` body.
		expect(xml).toMatch(
			/<group ref="\/data\/demographics" appearance="field-list">[\s\S]*?<label ref="jr:itext\('demographics-label'\)"\/>[\s\S]*?<\/group>/,
		);
		// Data element is the empty container `<demographics></demographics>`.
		expect(xml).toMatch(/<demographics>\s*<\/demographics>/);
		// The group's itext entry still emits because the label is set.
		expect(xml).toContain(`id="demographics-label"`);
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
									label: "Visits",
									children: [
										f({
											kind: "group",
											id: "vitals",
											label: "Vitals",
											children: [
												f({
													kind: "int",
													id: "temperature",
													label: "Temperature",
												}),
												f({
													kind: "int",
													id: "heart_rate",
													label: "Heart Rate",
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
		expect(xml).toMatch(/<visits jr:template=""[^>]*>/);
		expect(xml).not.toMatch(/<vitals jr:template=""/);

		// Leaf binds use the full nested XPath.
		expect(xml).toContain('nodeset="/data/visits/vitals/temperature"');
		expect(xml).toContain('nodeset="/data/visits/vitals/heart_rate"');

		// vellum shorthand mirrors the nested structure.
		expect(xml).toContain('vellum:nodeset="#form/visits/vitals/temperature"');

		// Body nests the group wrapper inside the repeat wrapper.
		expect(xml).toMatch(
			/<repeat nodeset="\/data\/visits">[\s\S]*?<group ref="\/data\/visits\/vitals"[\s\S]*?<\/group>[\s\S]*?<\/repeat>/,
		);
	});
});

// ── Connect opt-in ─────────────────────────────────────────────────────
//
// A Connect learn app may run with just a learn module (no assessment,
// no deliver unit). The expander must not inject deliver/task blocks
// that aren't configured, and the compiler must still produce a valid
// archive. Regression coverage against accidentally coupling the Connect
// blocks to each other.

describe("Connect learn-only expansion", () => {
	const learnOnlyDoc = buildDoc({
		appName: "LearnOnly",
		connectType: "learn",
		modules: [
			{
				name: "Training",
				forms: [
					{
						name: "Lesson",
						type: "survey",
						connect: {
							learn_module: {
								id: "intro_module",
								name: "Intro",
								description: "Intro to CHW work",
								time_estimate: 30,
							},
						},
						fields: [f({ kind: "text", id: "feedback", label: "Feedback" })],
					},
				],
			},
		],
	});

	it("emits a ConnectLearnModule block when only a learn module is configured", () => {
		const hq = expandDoc(learnOnlyDoc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		expect(xml).toContain('vellum:role="ConnectLearnModule"');
		// Module metadata is serialized inside the Connect namespace.
		expect(xml).toContain(
			'<module xmlns="http://commcareconnect.com/data/v1/learn" id="intro_module">',
		);
		expect(xml).toContain("<name>Intro</name>");
		expect(xml).toContain("<time_estimate>30</time_estimate>");
	});

	it("omits deliver/assessment/task blocks when only learn is configured", () => {
		const hq = expandDoc(learnOnlyDoc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		expect(xml).not.toContain('vellum:role="ConnectDeliverUnit"');
		expect(xml).not.toContain('vellum:role="ConnectAssessment"');
		expect(xml).not.toContain('vellum:role="ConnectTask"');
	});

	it("passes validation when a learn-app form carries only a learn module", () => {
		// CONNECT_MISSING_LEARN fires only when a learn form has *neither*
		// a learn_module nor an assessment — the learn-only config here
		// satisfies the requirement.
		expect(
			runValidation(learnOnlyDoc).some(
				(e) => e.code === "CONNECT_MISSING_LEARN",
			),
		).toBe(false);
	});
});

// ── Case-property rename pipeline regression ──────────────────────────
//
// `renameField` cascades through sibling fields' XPath references — the
// unit coverage lives in `lib/doc/__tests__/mutations-pathRewrite.test.ts`
// and `mutations-fields.test.ts`. The pipeline-level invariant: the
// emitted XForm's bind/calculate attributes must reference the renamed
// id everywhere the original reference stood. Without this assertion, a
// refactor of the rename reducer could silently break downstream
// expression rewriting — validation would still pass because references
// remain syntactically well-formed, but they would point at nothing.

describe("case-property rename cascade — pipeline regression", () => {
	it("emits XPath references that match the referenced field's current id", () => {
		// Two fields where `risk_label` references `/data/patient_age`.
		// The doc shape here reflects the post-rename state: the expander
		// is a pure function of the doc, so emitting the renamed id end
		// to end proves the cascade is visible at the pipeline boundary.
		const doc = buildDoc({
			appName: "Rename",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({ kind: "int", id: "patient_age", label: "Age" }),
								f({
									kind: "hidden",
									id: "risk_label",
									calculate: "if(/data/patient_age > 65, 'high', 'low')",
								}),
							],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		// Renamed field's path appears wherever the old reference stood.
		expect(xml).toContain(
			"calculate=\"if(/data/patient_age &gt; 65, 'high', 'low')\"",
		);
		// The structural XPath targets exist as binds.
		expect(xml).toContain('nodeset="/data/patient_age"');
		expect(xml).toContain('nodeset="/data/risk_label"');
	});
});

// ── Form links ─────────────────────────────────────────────────────────
//
// The expander does not consult `doc.forms[*].formLinks`; post-submit
// navigation is emitted through the session stack. `HqForm.form_links`
// is the `formShell` default — `[]` — on every form.

describe("form_links pipeline behavior", () => {
	it("ignores doc.formLinks; HQ form_links stays empty", () => {
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
					forms: [
						{
							uuid: intakeUuid,
							name: "Intake",
							type: "survey",
							postSubmit: "module",
							formLinks: [
								{
									condition: "/data/outcome = 'yes'",
									target: {
										type: "form",
										moduleUuid: asUuid(moduleUuid),
										formUuid: asUuid(followupUuid),
									},
								},
							],
							fields: [
								f({
									kind: "single_select",
									id: "outcome",
									label: "Outcome",
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
							type: "survey",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
		});

		// Validator accepts the configuration.
		expect(
			runValidation(doc).filter((e) => e.code.startsWith("FORM_LINK")),
		).toEqual([]);

		// `hq.modules[0].forms[0].form_links` is the `formShell` default `[]`.
		const hq = expandDoc(doc);
		expect(hq.modules[0].forms[0].form_links).toEqual([]);
	});
});

// ── Connect mode gate ──────────────────────────────────────────────────
//
// `expandDoc` strips `form.connect` when `doc.connectType` is unset —
// the builder stashes per-form Connect configs so mode toggles don't
// lose work, but the emit path must see them as absent when the app is
// out of Connect mode. Without this gate, a stashed learn module would
// leak into a non-Connect export as a spurious data block + bind.

describe("Connect mode gate", () => {
	it("strips form.connect when doc.connectType is unset", () => {
		const doc = buildDoc({
			appName: "Stashed",
			// connectType intentionally omitted — app is not in Connect mode.
			modules: [
				{
					name: "Quiz",
					forms: [
						{
							name: "Take Quiz",
							type: "survey",
							connect: {
								learn_module: {
									id: "stashed",
									name: "Stashed",
									description: "Hidden behind mode toggle",
									time_estimate: 10,
								},
							},
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const hq = expandDoc(doc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		// No Connect role attributes appear anywhere in the XForm.
		expect(xml).not.toMatch(/vellum:role="Connect/);
	});
});
