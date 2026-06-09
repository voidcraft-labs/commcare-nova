import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { expandHashtags } from "@/lib/commcare/hashtags";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import {
	advancedSearchInputDef,
	asUuid,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	type Module,
	phoneColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	literal,
	prop,
	relationStep,
	term,
	toValueExpression,
} from "@/lib/domain/predicate";

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
							label: "Client Info",
							children: [
								f({
									kind: "text",
									id: "full_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						}),
						f({
							kind: "hidden",
							id: "total_visits",
							calculate: "#case/total_visits + 1",
							case_property_on: "patient",
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
							label: "Full Name",
							required: "true()",
							case_property_on: "patient",
						}),
						f({
							kind: "int",
							id: "age",
							label: "Age",
							validate: ". > 0 and . < 150",
							case_property_on: "patient",
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
											case_property_on: "case",
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
			'calculate="instance(&apos;casedb&apos;)/casedb/case[@case_id = instance(&apos;commcaresession&apos;)/session/data/case_id]/total_visits + 1"',
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
		expect(xform).toContain('value="&apos;pending&apos;"');
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
									case_property_on: "c",
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
		expect(xform).toContain("instance(&apos;casedb&apos;)");
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
								label: "Name",
								case_property_on: "patient",
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
									case_property_on: "patient",
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
									id: "name",
									label: "Q",
									case_property_on: "c",
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
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
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
	// Authors reference fields in prose with hashtags (`#form/name`,
	// `#case/prop`); the emitter lowers those into `<output>` elements.
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
		// The literal `<output ...>` text is escaped, not honored as markup.
		expect(xform).toContain(
			'<text id="greeting-label"><value>Hello &lt;output value=&quot;/data/name&quot;/&gt;, welcome!</value>',
		);
		// No real <output> element leaked from the author text.
		expect(xform).not.toContain('<output value="/data/name"');
	});

	it("expands a #case/ hashtag ref in label prose into an <output>", () => {
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
									case_property_on: "c",
								}),
								f({
									kind: "label",
									id: "msg",
									label: "Patient: #case/full_name",
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
		// The output value= has the expanded XPath; vellum:value the shorthand.
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
									case_property_on: "c",
								}),
								f({
									kind: "date",
									id: "start_date",
									label: "Start",
									case_property_on: "c",
								}),
								f({
									kind: "date",
									id: "end_date",
									label: "End",
									case_property_on: "c",
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
									case_property_on: "c",
								}),
								f({
									kind: "text",
									id: "status",
									label: "Status",
									case_property_on: "c",
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
		expect(xml).toContain("<value>(&lt;2kg, 2-10kg, &gt;10kg)</value>");
		// No bare `<`/`>` survived inside the itext value text.
		expect(xml).not.toContain("(<2kg");
		expect(xml).not.toContain(">10kg)");
	});

	it("escapes a bare ampersand to `&amp;`", () => {
		const xml = firstFormXml(labelDoc("Tom & Jerry"));
		expect(xml).toContain("<value>Tom &amp; Jerry</value>");
	});

	it("escapes both comparison operators in prose", () => {
		const xml = firstFormXml(labelDoc("Rating < 100 and > 50"));
		expect(xml).toContain("<value>Rating &lt; 100 and &gt; 50</value>");
	});

	it("expands a hashtag ref in mixed prose while escaping surrounding `<`", () => {
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
					forms: [
						{
							name: "F",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "full_name",
									label: "Name",
									case_property_on: "c",
								}),
								f({
									kind: "label",
									id: "msg",
									label: "Weight < 5kg for #case/full_name",
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
		const xml = firstFormXml(doc);
		// Prose `<` escaped …
		expect(xml).toContain("Weight &lt; 5kg for");
		// … while the hashtag lowered into a real <output> ref + shorthand.
		expect(xml).toContain('<output value="instance(');
		expect(xml).toContain('vellum:value="#case/full_name"');
	});

	it("escapes author-written `<output>` markup as literal text (new contract)", () => {
		// `<output>` is NOT a supported authoring input — only hashtag refs
		// are. A label that literally contains `<output ...>` text is prose,
		// so it must serialize as escaped literal text (well-formed), NOT be
		// honored as a real element. This documents the post-fix contract.
		const xml = firstFormXml(labelDoc('See <output value="x"/> here'));
		expect(xml).toContain(
			"<value>See &lt;output value=&quot;x&quot;/&gt; here</value>",
		);
		// No real <output> element leaked from the author text.
		expect(xml).not.toContain('<output value="x"');
	});

	it("still expands a bare hashtag in prose (regression)", () => {
		const doc = buildDoc({
			appName: "Bare in prose",
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
									id: "name",
									label: "Name",
									case_property_on: "c",
								}),
								f({ kind: "label", id: "hi", label: "Hello #case/name" }),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "c", properties: [{ name: "name", label: "Name" }] }],
		});
		const xml = firstFormXml(doc);
		expect(xml).not.toContain("Hello #case/name<");
		expect(xml).toContain('vellum:value="#case/name"');
		expect(xml).toContain('<output value="instance(');
	});

	it("round-trips a pre-escaped `&lt;` without double-escaping (regression)", () => {
		// The historical workaround: authors pre-escaped `<` as `&lt;`. After
		// the fix, decode-then-escape keeps the on-wire byte at exactly `&lt;`
		// (not `&amp;lt;`), so the display still shows `<`.
		const xml = firstFormXml(labelDoc("Less than &lt; threshold"));
		expect(xml).toContain("<value>Less than &lt; threshold</value>");
		expect(xml).not.toContain("&amp;lt;");
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
									label: "Rating",
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
		// Two distinct, index-keyed itext ids — no collision.
		expect(xml).toContain('<text id="rating-opt0-label">');
		expect(xml).toContain('<text id="rating-opt1-label">');
		// Each <item>'s label ref points at its per-index id; both <value>s
		// emit the verbatim "3".
		expect(xml).toContain(
			`<item><label ref="jr:itext(&apos;rating-opt0-label&apos;)"/><value>3</value></item>`,
		);
		expect(xml).toContain(
			`<item><label ref="jr:itext(&apos;rating-opt1-label&apos;)"/><value>3</value></item>`,
		);
		// The labels round-trip into the respective itext entries.
		expect(xml).toContain(
			'<text id="rating-opt0-label"><value>Three (low scale)</value>',
		);
		expect(xml).toContain(
			'<text id="rating-opt1-label"><value>Three (high scale)</value>',
		);
		// The old value-keyed id must be gone.
		expect(xml).not.toContain("rating-3-label");
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
									label: "Tags",
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
		expect(xml).toContain('<text id="tags-opt0-label">');
		expect(xml).toContain('<text id="tags-opt1-label">');
		expect(xml).toContain(
			`<item><label ref="jr:itext(&apos;tags-opt0-label&apos;)"/><value>x</value></item>`,
		);
		expect(xml).toContain(
			`<item><label ref="jr:itext(&apos;tags-opt1-label&apos;)"/><value>x</value></item>`,
		);
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
									label: "Confirm?",
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
		expect(xml).toContain(
			`<item><label ref="jr:itext(&apos;confirm-opt0-label&apos;)"/><value>yes</value></item>`,
		);
		expect(xml).toContain(
			`<item><label ref="jr:itext(&apos;confirm-opt1-label&apos;)"/><value>no</value></item>`,
		);
		expect(xml).toContain('<text id="confirm-opt0-label"><value>Yes</value>');
		expect(xml).toContain('<text id="confirm-opt1-label"><value>No</value>');
		expect(validateXForm(xml, "F", "M")).toEqual([]);
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
		// Option labels — itext ids are keyed by array index (issue #10 fix),
		// not by option value, so the first option is `-opt0-label`.
		const activeOpt = extractItext(xform, "status-opt0-label");
		expect(activeOpt).toContain(
			'<value form="markdown">**Active** &#x2014; currently enrolled</value>',
		);
		const inactiveOpt = extractItext(xform, "status-opt1-label");
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
			'calculate="concat(/data/first_name, &apos; &apos;, /data/last_name)"',
		);
		expect(xform).toContain(
			'vellum:calculate="concat(#form/first_name, &apos; &apos;, #form/last_name)"',
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
		expect(xform).toContain('relevant="/data/consent = &apos;yes&apos;"');
		expect(xform).toContain(
			'vellum:relevant="#form/consent = &apos;yes&apos;"',
		);
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
		expect(xform).toContain(
			`jr:constraintMsg="jr:itext(&apos;age-constraintMsg&apos;)"`,
		);
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
		expect(xform).toContain('required="/data/has_issue = &apos;yes&apos;"');
		expect(xform).toContain(
			'vellum:required="#form/has_issue = &apos;yes&apos;"',
		);
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
		expect(xform).toContain('relevant="/data/show = &apos;yes&apos;"');
		expect(xform).toContain('vellum:relevant="#form/show = &apos;yes&apos;"');
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

	it("resolves a #<case_type>/<prop> ref to the same parent-index walk as #case/", () => {
		// `pregnancy` (own, depth 0) → `mother` (parent, depth 1). A field's
		// calculate reads the mother's household_code via the per-type namespace;
		// the wire XPath must be the depth-1 parent-index walk, byte-identical to
		// what `#case/parent/household_code` emits. This is also the casedb-instance
		// guard: the ONLY case reference here is `#mother/...` (no `#case/`), so a
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
					properties: [{ name: "ga", label: "GA" }],
				},
				{
					name: "mother",
					properties: [{ name: "household_code", label: "Household Code" }],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;
		// The resolved `calculate` is byte-identical to the legacy `#case/parent`
		// walk (apostrophes XML-escaped by the serializer in the attribute value).
		const escapedWalk = expandHashtags(
			"#case/parent/household_code",
		).replaceAll("'", "&apos;");
		expect(xform).toContain(`calculate="${escapedWalk}"`);
		// The per-type shorthand round-trips for the Vellum editor.
		expect(xform).toContain('vellum:calculate="#mother/household_code"');
		// A per-type ref needs casedb just like `#case/` — the instance MUST be
		// declared, or the emitted lookup references a non-existent source.
		expect(xform).toContain(
			'<instance src="jr://instance/casedb" id="casedb"/>',
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
									label: "Code: #mother/household_code",
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
					properties: [{ name: "ga", label: "GA" }],
				},
				{
					name: "mother",
					properties: [{ name: "household_code", label: "Household Code" }],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;
		const escapedWalk = expandHashtags(
			"#case/parent/household_code",
		).replaceAll("'", "&apos;");
		// Prose lowers to an `<output>` carrying the resolved parent-index walk.
		expect(xform).toContain(`<output value="${escapedWalk}"`);
		// Prose case refs force the casedb instance declaration too.
		expect(xform).toContain(
			'<instance src="jr://instance/casedb" id="casedb"/>',
		);
	});

	it("keeps an unresolvable prose token literal — no <output>, no casedb", () => {
		// The broad `BARE_HASHTAG_RE` matches innocent prose tokens too: an
		// unreachable namespace (`#section/intro`), a junk token (`#N/A`), or a
		// CHILD case type (`#child/name` — a write target, absent from the form's
		// reachable read set). `expand` returns each verbatim, and prose lowering is
		// gated on a CHANGED string, so none lower to `<output>` (a verbatim
		// `<output value="#N/A">` would be broken XPath on device). They stay
		// literal escaped text, exactly as before the regex was broadened —
		// authoring-time flagging of a misdirected per-type prose ref is a separate
		// validator job.
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
									label: "Codes #N/A and #child/name and #section/intro",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "pregnancy", properties: [{ name: "ga", label: "GA" }] },
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;
		// The tokens stay literal — no lowering happened at all.
		expect(xform).not.toContain("<output");
		expect(xform).toContain("Codes #N/A and #child/name and #section/intro");
		// No case resolution → no casedb instance declared.
		expect(xform).not.toContain('id="casedb"');
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
									label: "Code",
									validate: "string-length(.) > 0",
									validate_msg: "Must match #mother/household_code",
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
					properties: [{ name: "ga", label: "GA" }],
				},
				{
					name: "mother",
					properties: [{ name: "household_code", label: "Household Code" }],
				},
			],
		});
		const hq = expandDoc(doc);
		const xform = Object.values(hq._attachments)[0] as string;
		const escapedWalk = expandHashtags(
			"#case/parent/household_code",
		).replaceAll("'", "&apos;");
		// The validate_msg prose lowered to an <output> carrying the resolved walk…
		expect(xform).toContain(`<output value="${escapedWalk}"`);
		// …and the casedb instance is declared (the bug this guards against).
		expect(xform).toContain(
			'<instance src="jr://instance/casedb" id="casedb"/>',
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
		expect(xform).toContain('required="/data/consent = &apos;yes&apos;"');
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
									case_property_on: "c",
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
		expect(xform).toContain('vellum:required="#case/risk = &apos;high&apos;"');
		expect(xform).toContain("instance(&apos;casedb&apos;)");
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
									label: "Name",
									case_property_on: "c",
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
			asUuid("00000000-0000-4000-8000-000000000001"),
			"case_name",
			"Name",
		);
		const ageCol = plainColumn(
			asUuid("00000000-0000-4000-8000-000000000002"),
			"age",
			"Age",
			{ visibleInList: false },
		);
		const dobCol = plainColumn(
			asUuid("00000000-0000-4000-8000-000000000003"),
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
					caseListConfig: {
						columns: [caseNameCol, ageCol, dobCol],
						searchInputs: [],
					},
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "c",
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
		const shortCols = hq.modules[0].case_details.short.columns;
		const longCols = hq.modules[0].case_details.long.columns;
		// Short detail: all three columns appear; the two hidden ones
		// carry `format: "invisible"`. CCHQ keeps the column rows
		// present so sort + index keep working.
		expect(shortCols.length).toBe(3);
		expect(shortCols[0].field).toBe("case_name");
		expect(shortCols[0].format).toBe("plain");
		expect(shortCols[1].field).toBe("age");
		expect(shortCols[1].format).toBe("invisible");
		expect(shortCols[2].field).toBe("dob");
		expect(shortCols[2].format).toBe("invisible");
		// Long detail: all three columns, in source-array order, with
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
		// The repeat-default setvalue specifically must be jr-insert, not
		// xforms-ready. Assert structurally on the status setvalue rather than
		// blanket-rejecting xforms-ready, so a non-repeat default_value
		// elsewhere on a form can't make the test brittle.
		const statusSetvalue = xform.match(
			/<setvalue\b[^>]*ref="\/data\/items\/status"[^/]*\/>/,
		);
		expect(statusSetvalue).not.toBeNull();
		expect(statusSetvalue?.[0]).toContain('event="jr-insert"');
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
									case_property_on: "patient",
								}),
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
									label: "Plan Name",
									case_property_on: "plan",
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
									label: "Plan Name",
									case_property_on: "plan",
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
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
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
									case_property_on: "plan",
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
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
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
									case_property_on: "plan",
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
	it("emits a valid XForm shell when a survey form has zero fields", () => {
		const doc = buildDoc({
			appName: "Empty",
			modules: [
				{ name: "M", forms: [{ name: "F", type: "survey", fields: [] }] },
			],
		});
		const hq = expandDoc(doc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		// Shell present. With no fields the body has no children, so the
		// serializer renders it self-closing (`<h:body/>` ≡ `<h:body></h:body>`).
		expect(xml).toContain("<h:head>");
		expect(xml).toMatch(/<h:body\s*\/>/);
		// The `orx:` prefix is declared on the root unconditionally (matching
		// Vellum's writer) so the `.ccz` meta splice has it in scope.
		// The HQ-upload source carries NO meta block: CCHQ injects it at render
		// time (`_add_meta_2`), and a meta node in the source breaks CCHQ's form
		// builder. The block lands only on the `.ccz` path; the compiler test
		// pins the injected shape.
		expect(xml).toContain('xmlns:orx="http://openrosa.org/jr/xforms"');
		expect(xml).not.toContain("<orx:meta");
		expect(xml).not.toContain("<orx:deviceID/>");
		expect(xml).not.toContain("<orx:instanceID/>");
		expect(xml).not.toContain("<cc:appVersion/>");
		// No meta binds either — the dateTime typing binds (`timeStart` /
		// `timeEnd`) ship with the meta block, on the `.ccz` path only.
		expect(xml).not.toContain('nodeset="/data/meta/timeStart"');
		expect(xml).not.toContain('nodeset="/data/meta/timeEnd"');
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

		// Body wraps the group — no children inside the `<group>` body. The
		// serializer encodes `'` as `&apos;` inside the itext ref.
		expect(xml).toMatch(
			/<group ref="\/data\/demographics" appearance="field-list">[\s\S]*?<label ref="jr:itext\(&apos;demographics-label&apos;\)"\/>[\s\S]*?<\/group>/,
		);
		// Data element is the empty container — rendered self-closing
		// (`<demographics/>` ≡ `<demographics></demographics>`).
		expect(xml).toMatch(/<demographics\/>/);
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

// ── Deliver-unit entity-XPath defaults ────────────────────────────────
//
// `deliver_unit.entity_id` and `entity_name` are optional in the domain
// (`lib/domain/forms.ts`). The XForm builder substitutes the canonical
// XPath defaults when the doc carries no explicit value — this is the
// single home for those defaults. Without the wire-time fallback the
// emitter would write `<bind … calculate=""/>` and CCHQ would reject
// the upload with an XPath parse error.

describe("Connect deliver_unit entity defaults", () => {
	const deliverWithoutEntityFields = buildDoc({
		appName: "DeliverDefaults",
		connectType: "deliver",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Vendor visit",
						type: "survey",
						connect: {
							deliver_unit: {
								id: "vendor_visit",
								name: "Vendor visit",
								// entity_id / entity_name omitted — exercise the
								// wire-time fallback.
							},
						},
						fields: [f({ kind: "text", id: "vendor", label: "Vendor" })],
					},
				],
			},
		],
	});

	it("emits the canonical entity_id/entity_name defaults when the doc carries no explicit values", () => {
		const hq = expandDoc(deliverWithoutEntityFields);
		const xml: string = Object.values(hq._attachments)[0] as string;

		// Match the binds by their target nodeset and assert the
		// calculate carries a non-empty XPath that originated from the
		// canonical defaults — `today()` for entity_id (from
		// `concat(#user/username, '-', today())`) and the `#user/...`
		// expansion for entity_name. We don't pin the full expanded
		// XPath because `expandHashtags` is allowed to evolve (it
		// already differs for case-loading vs survey contexts); the
		// load-bearing assertion is "the calculate is non-empty and
		// derived from the SA-invisible defaults".
		const idBindMatch = xml.match(
			/<bind nodeset="\/data\/vendor_visit\/deliver\/entity_id" calculate="([^"]+)"\/>/,
		);
		expect(idBindMatch).not.toBeNull();
		expect(idBindMatch?.[1]).toContain("today()");
		expect(idBindMatch?.[1]).toContain("username");

		const nameBindMatch = xml.match(
			/<bind nodeset="\/data\/vendor_visit\/deliver\/entity_name" calculate="([^"]+)"\/>/,
		);
		expect(nameBindMatch).not.toBeNull();
		expect(nameBindMatch?.[1]).toContain("username");
	});

	it("preserves an explicit entity_id/entity_name when the doc carries them", () => {
		const customDoc = buildDoc({
			appName: "DeliverCustom",
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Vendor visit",
							type: "survey",
							connect: {
								deliver_unit: {
									id: "vendor_visit",
									name: "Vendor visit",
									entity_id: "uuid()",
									entity_name: "'manual override'",
								},
							},
							fields: [f({ kind: "text", id: "vendor", label: "Vendor" })],
						},
					],
				},
			],
		});

		const hq = expandDoc(customDoc);
		const xml: string = Object.values(hq._attachments)[0] as string;

		// Custom expressions land on the binds verbatim — the wire
		// layer's `||` fallback only activates on falsy (undefined /
		// empty) values.
		expect(xml).toContain(
			'<bind nodeset="/data/vendor_visit/deliver/entity_id" calculate="uuid()"/>',
		);
		expect(xml).toContain(
			'<bind nodeset="/data/vendor_visit/deliver/entity_name" calculate="&apos;manual override&apos;"/>',
		);
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
			'calculate="if(/data/patient_age &gt; 65, &apos;high&apos;, &apos;low&apos;)"',
		);
		// The structural XPath targets exist as binds.
		expect(xml).toContain('nodeset="/data/patient_age"');
		expect(xml).toContain('nodeset="/data/risk_label"');
	});
});

// ── Form links ─────────────────────────────────────────────────────────
//
// The expander emits `doc.forms[*].formLinks` into `HqForm.form_links`,
// translating uuid-based targets into HQ's 0-based module/form indices.
// Links with dangling target uuids are dropped at the boundary (the
// validator catches these first in production, but the expander stays
// defense-in-depth so an unchecked call never produces HQ JSON with
// null targets).

describe("form_links emission", () => {
	it("emits HQ form_links with indexed form targets", () => {
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

		const hq = expandDoc(doc);
		// Expander resolves uuid target → indexed target:
		// followup form is index 1 within module 0.
		expect(hq.modules[0].forms[0].form_links).toEqual([
			{
				condition: "/data/outcome = 'yes'",
				target: { type: "form", moduleIndex: 0, formIndex: 1 },
			},
		]);
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
									target: { type: "module", moduleUuid: asUuid(modB) },
								},
							],
							fields: [f({ kind: "text", id: "x", label: "X" })],
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
							fields: [f({ kind: "text", id: "y", label: "Y" })],
						},
					],
				},
			],
		});

		const hq = expandDoc(doc);
		expect(hq.modules[0].forms[0].form_links).toEqual([
			{ target: { type: "module", moduleIndex: 1 } },
		]);
	});

	it("forwards condition + datum overrides verbatim", () => {
		const moduleUuid = "mod-d";
		const intakeUuid = "frm-i";
		const triageUuid = "frm-t";

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
									condition: "/data/severity = 'high'",
									target: {
										type: "form",
										moduleUuid: asUuid(moduleUuid),
										formUuid: asUuid(triageUuid),
									},
									datums: [{ name: "case_id", xpath: "/data/patient_id" }],
								},
							],
							fields: [f({ kind: "text", id: "severity", label: "Severity" })],
						},
						{
							uuid: triageUuid,
							name: "Triage",
							type: "survey",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
		});

		const hq = expandDoc(doc);
		expect(hq.modules[0].forms[0].form_links).toEqual([
			{
				condition: "/data/severity = 'high'",
				target: { type: "form", moduleIndex: 0, formIndex: 1 },
				datums: [{ name: "case_id", xpath: "/data/patient_id" }],
			},
		]);
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
							fields: [f({ kind: "text", id: "x", label: "X" })],
						},
					],
				},
			],
		});
		expect(expandDoc(doc).modules[0].forms[0].form_links).toEqual([]);
	});

	// Defense-in-depth: the validator (FORM_LINK_TARGET_NOT_FOUND) blocks
	// dangling targets before they ever reach the expander in production,
	// but `translateFormLinks` drops them anyway so an unchecked caller
	// (e.g. a test bypass or a future codepath) never produces HQ JSON
	// with an unresolvable index. Pinning the drop prevents a future
	// refactor from silently switching to "throw" — every current
	// assertion would still pass, but an upload path would suddenly
	// start 500-ing on a formerly-tolerable input.
	it("drops form-link entries whose target uuid isn't registered", () => {
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
									// Target points at a module that doesn't exist in
									// `doc.moduleOrder`. Construct the uuid via
									// `asUuid` so it satisfies the branded type; the
									// validator would flag this in production, but
									// the expander must still render it harmless.
									target: {
										type: "module",
										moduleUuid: asUuid("mod-never-registered"),
									},
								},
							],
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
		});

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
//   5. Search-config projection — `caseSearchConfig` + simple-arm
//      `searchInputs` map to `module.search_config` slots; advanced-arm
//      predicates + filter AND-compose into `_xpath_query` on
//      `default_properties`.

const HQ_PROJECTION_MODULE_UUID = asUuid(
	"77777777-7777-4777-8777-777777777771",
);

const HQ_PROJECTION_PATIENT_CASE_TYPE = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Name", data_type: "text" as const },
		{ name: "age", label: "Age", data_type: "int" as const },
		{ name: "phone", label: "Phone", data_type: "text" as const },
		{ name: "region", label: "Region", data_type: "text" as const },
		{ name: "last_visit", label: "Last Visit", data_type: "date" as const },
		{ name: "dob", label: "DOB", data_type: "date" as const },
		{ name: "status", label: "Status", data_type: "text" as const },
	],
};

/**
 * Build a doc with one followup form sourcing the named fields. The
 * followup form keeps the module's `case_type` active so the
 * expander's `hasCases` gate admits the projected search config.
 */
function buildHqProjectionDoc(
	caseListConfig: Module["caseListConfig"],
	caseSearchConfig?: Module["caseSearchConfig"],
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
								label: "Name",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [HQ_PROJECTION_PATIENT_CASE_TYPE],
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
					asUuid("00000000-0000-4000-8000-000000010001"),
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

	it("projects date columns with `date` format and the authored `date_format` pattern", () => {
		// Date columns ride CCHQ's `Date` format. The authored
		// `pattern` lands on `date_format`; the runtime formatter
		// consumes it. CCHQ's default pattern is `%d/%m/%y`; an
		// authored pattern overrides cleanly.
		const doc = buildHqProjectionDoc({
			columns: [
				dateColumn(
					asUuid("00000000-0000-4000-8000-000000010002"),
					"last_visit",
					"Last Visit",
					"%Y-%m-%d",
				),
			],
			searchInputs: [],
		});
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols).toHaveLength(1);
		expect(shortCols[0].format).toBe("date");
		expect(shortCols[0].date_format).toBe("%Y-%m-%d");
		expect(shortCols[0].field).toBe("last_visit");
	});

	it("projects phone columns with `phone` format and the bare property reference", () => {
		// Phone columns route through CCHQ's `Phone` format; the
		// runtime overlays a tap-to-call affordance on long detail
		// (CCHQ's `template_form="phone"` divergence). The HQ JSON
		// layer carries only the format token; the long-vs-short
		// template divergence is emitted at suite-XML time.
		const doc = buildHqProjectionDoc({
			columns: [
				phoneColumn(
					asUuid("00000000-0000-4000-8000-000000010003"),
					"phone",
					"Phone",
				),
			],
			searchInputs: [],
		});
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("phone");
		expect(shortCols[0].field).toBe("phone");
	});

	it("projects id-mapping columns with `enum` format and per-language label entries", () => {
		// ID-mapping rows lower to CCHQ's `enum` format. Each entry's
		// label lifts under the `en` lang key per CCHQ's
		// `MappingItem.value = DictProperty()` shape. The wire field
		// stays the bare property reference.
		const doc = buildHqProjectionDoc({
			columns: [
				idMappingColumn(
					asUuid("00000000-0000-4000-8000-000000010004"),
					"region",
					"Region",
					[idMappingEntry("N", "North"), idMappingEntry("S", "South")],
				),
			],
			searchInputs: [],
		});
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("enum");
		expect(shortCols[0].field).toBe("region");
		expect(shortCols[0].enum).toEqual([
			{ key: "N", value: { en: "North" } },
			{ key: "S", value: { en: "South" } },
		]);
	});

	it("projects interval columns with `display: always` as `time-ago` and the unit divisor", () => {
		// `interval` columns split on `display`: `always` → CCHQ's
		// `time-ago` with `time_ago_interval` set to the unit's
		// days-equivalent divisor (`TIME_AGO_DIVISOR_DAYS`).
		const doc = buildHqProjectionDoc({
			columns: [
				intervalColumn(
					asUuid("00000000-0000-4000-8000-000000010005"),
					"last_visit",
					"Days since visit",
					3,
					"days",
					"always",
					"OVERDUE",
				),
			],
			searchInputs: [],
		});
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("time-ago");
		expect(shortCols[0].time_ago_interval).toBe(1);
		expect(shortCols[0].field).toBe("last_visit");
	});

	it("projects interval columns with `display: flag` as `late-flag` and the threshold in days", () => {
		// `flag` arm → CCHQ's `late-flag` with `late_flag` set to
		// `threshold × divisor` rounded to int. CCHQ's schema is
		// `IntegerProperty(default=30)`; the suite-XML side carries
		// the float threshold inline in the XPath, but CCHQ's
		// persistent doc rounds. `2 weeks` → 14 days.
		const doc = buildHqProjectionDoc({
			columns: [
				intervalColumn(
					asUuid("00000000-0000-4000-8000-000000010006"),
					"last_visit",
					"Overdue",
					2,
					"weeks",
					"flag",
					"OVERDUE",
				),
			],
			searchInputs: [],
		});
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("late-flag");
		expect(shortCols[0].late_flag).toBe(14);
		expect(shortCols[0].field).toBe("last_visit");
	});

	it("projects calculated columns with `useXpathExpression: true` and the lowered XPath as `field`", () => {
		// Calc columns route through CCHQ's `useXpathExpression`
		// branch — `format: "calculate"`, `useXpathExpression: true`,
		// and `field` carries the lowered XPath expression rather
		// than a property name (per CCHQ's
		// `detail_screen.py::FormattedDetailColumn.xpath` switch).
		const doc = buildHqProjectionDoc({
			columns: [
				calculatedColumn(
					asUuid("00000000-0000-4000-8000-000000010007"),
					"Age Next Year",
					toValueExpression(prop("patient", "age")),
				),
			],
			searchInputs: [],
		});
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols[0].format).toBe("calculate");
		expect(shortCols[0].useXpathExpression).toBe(true);
		// `field` carries the lowered XPath — for a bare property ref
		// the on-device emitter renders just the property name.
		expect(shortCols[0].field).toBe("age");
	});

	it("surfaces visibleInList: false as `invisible` format on the short detail while keeping the column on long detail", () => {
		// CCHQ's `invisible` format renders a zero-width column;
		// the column stays present for sort + index purposes. The
		// long detail keeps its normal format when `visibleInDetail`
		// is unset.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					asUuid("00000000-0000-4000-8000-000000010008"),
					"phone",
					"Phone",
					{ visibleInList: false },
				),
			],
			searchInputs: [],
		});
		const details = expandDoc(doc).modules[0].case_details;
		expect(details.short.columns[0].format).toBe("invisible");
		expect(details.short.columns[0].field).toBe("phone");
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
					asUuid("00000000-0000-4000-8000-000000020001"),
					"case_name",
					"Name",
					{ sort: { direction: "asc", priority: 1 } },
				),
				plainColumn(
					asUuid("00000000-0000-4000-8000-000000020002"),
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
		const doc = buildHqProjectionDoc({
			columns: [
				calculatedColumn(
					asUuid("00000000-0000-4000-8000-000000020003"),
					"Age Next Year",
					toValueExpression(prop("patient", "age")),
					{ sort: { direction: "asc", priority: 0 } },
				),
			],
			searchInputs: [],
		});
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
		const doc = buildHqProjectionDoc({
			columns: [
				calculatedColumn(
					asUuid("00000000-0000-4000-8000-000000020003"),
					"Age Next Year",
					toValueExpression(prop("patient", "age")),
					{ sort: { direction: "asc", priority: 0 } },
				),
				calculatedColumn(
					asUuid("00000000-0000-4000-8000-000000020004"),
					"Visits Doubled",
					toValueExpression(prop("patient", "visit_count")),
					{ sort: { direction: "desc", priority: 1 } },
				),
			],
			searchInputs: [],
		});
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

	it("leaves sort_elements empty when no column carries a sort directive", () => {
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					asUuid("00000000-0000-4000-8000-000000020004"),
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
					asUuid("00000000-0000-4000-8000-000000030001"),
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
					asUuid("00000000-0000-4000-8000-000000030002"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [],
		});
		expect(expandDoc(doc).modules[0].case_details.short.filter).toBeNull();
	});
});

describe("expandDoc HQ JSON projection — search_config", () => {
	it("lands display chrome on `title_label`, `description`, `search_button_label`, and `search_button_display_condition`", () => {
		// Each authored display slot in `caseSearchConfig` maps to its
		// matching CCHQ slot in `search_config`. Empty / absent
		// subtitle elides the description; an authored value lifts to
		// the `{en: ...}` LabelProperty shape.
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						asUuid("00000000-0000-4000-8000-000000040001"),
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
				searchButtonDisplayCondition: eq(
					prop("patient", "case_name"),
					literal("Alice"),
				),
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
			"case_name = 'Alice'",
		);
	});

	it("compiles `excludedOwnerIds` to `blacklisted_owner_ids_expression`", () => {
		// CCHQ stores the excluded-owners filter as a bare on-device
		// XPath string. The suite-XML side wraps it as a `<data>` slot
		// at search time; the persistent doc carries the expression
		// directly because CCHQ regenerates the suite from the doc.
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						asUuid("00000000-0000-4000-8000-000000040002"),
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
			"'excluded-owner-id'",
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
					asUuid("00000000-0000-4000-8000-000000040003"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000040011"),
					"name_search",
					"Name",
					"text",
					"case_name",
				),
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000040012"),
					"dob_search",
					"DOB",
					"date",
					"dob",
				),
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000040013"),
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
					asUuid("00000000-0000-4000-8000-0000000400f1"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-0000000400f2"),
					"name_fuzzy",
					"Name",
					"text",
					"case_name",
					{ mode: { kind: "fuzzy" } },
				),
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-0000000400f3"),
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
		// `simpleArmDerivation` lift.
		const xpathQueryEntry = searchConfig.default_properties.find(
			(d) => d.property === "_xpath_query",
		);
		expect(xpathQueryEntry).toBeDefined();
		expect(xpathQueryEntry?.defaultValue).toContain("fuzzy-match(case_name,");
		expect(xpathQueryEntry?.defaultValue).toContain("starts-with(case_name,");
	});

	it("AND-composes `caseListConfig.filter` and every advanced-arm predicate into a single `_xpath_query` slot on `default_properties`", () => {
		// CCHQ accepts one `_xpath_query` per search; the AST-level
		// `and(...)` collapses the unified filter + every advanced-arm
		// predicate before the CSQL emitter walks the result. The
		// suite-XML side does the same — `composeXPathQueryEmission`
		// is the shared helper.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					asUuid("00000000-0000-4000-8000-000000040004"),
					"case_name",
					"Name",
				),
			],
			// Filter on `region` — distinct from the simple-arm input
			// target so the filter/simple-input conflict rule admits
			// the pair.
			filter: eq(prop("patient", "region"), literal("North")),
			searchInputs: [
				advancedSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000040014"),
					"status_search",
					"Status",
					"text",
					eq(prop("patient", "status"), literal("active")),
				),
			],
		});
		const defaults = expandDoc(doc).modules[0].search_config.default_properties;
		const xpathQueryEntry = defaults.find((d) => d.property === "_xpath_query");
		expect(xpathQueryEntry).toBeDefined();
		// The CSQL emitter wraps the AND-composed predicate in a
		// `concat(...)` runtime expression; both authored property
		// fragments survive the wrap.
		expect(xpathQueryEntry?.defaultValue).toMatch(/concat\(/);
		expect(xpathQueryEntry?.defaultValue).toContain("region");
		expect(xpathQueryEntry?.defaultValue).toContain("status");
		// Bare `and` survives between the two fragments.
		expect(xpathQueryEntry?.defaultValue).toContain(" and ");
	});

	it("omits the `_xpath_query` slot entirely when no filter and no advanced-arm predicates are authored", () => {
		// CCHQ encodes "no server-side filter" by an absent slot, not
		// by emitting `_xpath_query = true()`.
		const doc = buildHqProjectionDoc({
			columns: [
				plainColumn(
					asUuid("00000000-0000-4000-8000-000000040005"),
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
					asUuid("00000000-0000-4000-8000-000000040006"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				advancedSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000040016"),
					"age_filter",
					"Age",
					"text",
					// Right-hand operand is `arith(age, +, 1)` — CSQL
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
								left: term(prop("patient", "age")),
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
		// The arith's on-device emission `(age + 1)` lands as a
		// runtime fragment inside the wrapper concat.
		expect(defaults[0].defaultValue).toContain("(age + 1)");
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
								asUuid("00000000-0000-4000-8000-000000040007"),
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
					forms: [
						{
							name: "Follow-up",
							type: "followup",
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
			],
			caseTypes: [
				{
					name: "patient",
					parent_type: "household",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
					],
				},
				{
					name: "household",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
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
		// arm gates against a different property (`age`) so the
		// `filterSearchInputConflict` validator rule admits the pair.
		const doc = buildHqProjectionDoc(
			{
				columns: [
					plainColumn(
						asUuid("00000000-0000-4000-8000-000000050001"),
						"case_name",
						"Name",
					),
					dateColumn(
						asUuid("00000000-0000-4000-8000-000000050002"),
						"last_visit",
						"Last Visit",
						"%Y-%m-%d",
						{ sort: { direction: "desc", priority: 0 } },
					),
				],
				filter: eq(prop("patient", "region"), literal("North")),
				searchInputs: [
					simpleSearchInputDef(
						asUuid("00000000-0000-4000-8000-000000050011"),
						"name_search",
						"Name",
						"text",
						"case_name",
					),
					advancedSearchInputDef(
						asUuid("00000000-0000-4000-8000-000000050012"),
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

		// Always-on filter at `case_details.short.filter`.
		expect(module.case_details.short.filter).toBe("region = 'North'");

		// Search-config chrome lands on the matching CCHQ slots.
		expect(module.search_config.title_label).toEqual({ en: "Find a patient" });
		expect(module.search_config.search_button_label).toEqual({
			en: "Search patients",
		});
		expect(module.search_config.blacklisted_owner_ids_expression).toBe(
			"'excluded'",
		);

		// Simple-arm input lands on `properties`.
		expect(module.search_config.properties).toHaveLength(1);
		expect(module.search_config.properties[0].name).toBe("name_search");

		// Advanced-arm predicate + filter AND-compose into
		// `_xpath_query` on `default_properties`.
		const xpathEntry = module.search_config.default_properties.find(
			(d) => d.property === "_xpath_query",
		);
		expect(xpathEntry).toBeDefined();
		expect(xpathEntry?.defaultValue).toContain("region");
		expect(xpathEntry?.defaultValue).toContain("age");
		expect(xpathEntry?.defaultValue).toContain(" and ");
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
					asUuid("00000000-0000-4000-8000-000000060001"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000060011"),
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
					asUuid("00000000-0000-4000-8000-000000060002"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000060021"),
					"case_name",
					"Self name",
					"text",
					"case_name",
				),
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000060022"),
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
					asUuid("00000000-0000-4000-8000-000000060030"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000060031"),
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
					asUuid("00000000-0000-4000-8000-000000060040"),
					"case_name",
					"Name",
				),
			],
			searchInputs: [
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000060041"),
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
