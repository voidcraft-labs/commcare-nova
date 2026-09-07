import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Form,
	fieldSchema,
	formSchema,
	moduleSchema,
	type ProseTemplate,
	proseText,
	type Uuid,
} from "@/lib/domain";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	xp,
} from "../../__tests__/docHelpers";
import { runValidation } from "../validator/runner";

// These tests exercise Nova's complete validator verdict. Wire execution is
// covered by the native suites in scripts/fixtures; a clean verdict here is
// authoring admission, not independent evidence that HQ or Core accepted XML.
const m = testUuid("rules-module");
const a = testUuid("rules-form-a");
const b = testUuid("rules-form-b");
const c = testUuid("rules-form-c");
const q = testUuid("rules-question");
const name = testUuid("rules-name");
const plain: FieldSpec = { uuid: q, kind: "text", id: "answer" };

function survey(fields: FieldSpec[] = [plain]): BlueprintDoc {
	return buildDoc({
		appName: "Outreach",
		modules: [
			{
				uuid: m,
				name: "Survey",
				forms: [{ uuid: a, name: "Intake", type: "survey", fields }],
			},
		],
	});
}
function patient(
	type: Form["type"] = "registration",
	fields: FieldSpec[] = [plain],
	caseType = "patient",
): BlueprintDoc {
	return buildDoc({
		appName: "Outreach",
		caseTypes: [
			{
				name: caseType,
				properties: [
					{ name: "age", data_type: "int", label: proseText("Age") },
					{ name: "note", data_type: "text", label: proseText("Note") },
				],
			},
		],
		modules: [
			{
				uuid: m,
				name: "Patients",
				caseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: a,
						name: "Intake",
						type,
						fields: [
							{
								uuid: name,
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType, property: "case_name" },
							},
							...fields,
						],
					},
				],
			},
		],
	});
}
function catalog(doc: BlueprintDoc) {
	if (doc.caseTypes === null) throw new Error("Fixture has no case catalog");
	return doc.caseTypes;
}
/** A private invalid candidate, not a successful Builder/SA mutation. */
function candidate(
	base: BlueprintDoc,
	change: (doc: BlueprintDoc) => void,
): BlueprintDoc {
	assertAdmittedDoc(base);
	const doc = structuredClone(base);
	change(doc);
	return doc;
}
function findings(doc: BlueprintDoc, codes: string[]) {
	const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(errors.map(({ code }) => code)).toEqual(codes);
	// Complete ordered code lists catch unrelated fixture failures. Also pin
	// actual entity attribution for every scoped finding, without matching copy.
	for (const error of errors) {
		if (error.scope === "module") expect(error.location.moduleUuid).toBe(m);
		if (error.scope === "form" || error.scope === "field") {
			expect(doc.forms[error.location.formUuid ?? ""]).toBeDefined();
			expect(error.location.moduleUuid).toBe(m);
		}
		if (error.scope === "field")
			expect(doc.fields[error.location.fieldUuid ?? ""]).toBeDefined();
	}
	return errors;
}
function fieldPatch(doc: BlueprintDoc, patch: Record<string, unknown>) {
	Object.assign(doc.fields[q], patch);
}

describe("whole-document structural admission", () => {
	it("admits complete registration and survey documents", () => {
		assertAdmittedDoc(patient());
		assertAdmittedDoc(survey());
	});
	it("reports the empty app name at app scope", () => {
		expect(
			findings(
				candidate(survey(), (d) => {
					d.appName = "";
				}),
				["EMPTY_APP_NAME"],
			),
		).toMatchObject([{ scope: "app", location: {} }]);
	});
	it("reports a moduleless private candidate and gives the remove-last-module remedy", () => {
		const errors = findings(buildDoc({ appName: "Outreach", modules: [] }), [
			"NO_MODULES",
		]);
		expect(errors).toMatchObject([
			{
				scope: "app",
				location: {},
				message: expect.stringContaining("if you're removing your last one"),
			},
		]);
	});
	it("admits duplicate display names with distinct identities and form namespaces", () => {
		const doc = buildDoc({
			appName: "Outreach",
			modules: [0, 1].map((i) => ({
				name: "Surveys",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [{ kind: "text", id: `answer_${i}`, label: "Answer" }],
					},
				],
			})),
		});
		assertAdmittedDoc(doc);
	});
	it.each(["health-check", "home_visit", "p".repeat(255)])(
		"admits the complete catalog and writer graph for case type %s",
		(caseType) => {
			assertAdmittedDoc(patient("registration", [plain], caseType));
		},
	);
	it.each(["1patient", "patient record", "patient@home"])(
		"rejects invalid case type %s without breaking its catalog links",
		(caseType) => {
			const base = patient();
			const doc = candidate(base, (d) => {
				d.modules[m].caseType = caseType;
				catalog(d)[0].name = caseType;
				const field = d.fields[name];
				if ("caseWrite" in field && field.caseWrite)
					field.caseWrite.caseType = caseType;
			});
			findings(doc, ["INVALID_CASE_TYPE_FORMAT"]);
		},
	);
	it("rejects a case type over the authoring limit", () => {
		findings(patient("registration", [plain], "p".repeat(256)), [
			"CASE_TYPE_TOO_LONG",
		]);
	});
	it.each(["user", "case", "form", "parent", "search", "Parent"])(
		"reserves reference namespace %s",
		(caseType) => {
			const doc = patient("registration", [plain], caseType);
			expect(findings(doc, ["RESERVED_CASE_TYPE_NAME"])).toMatchObject([
				{ scope: "app", location: { moduleUuid: m }, details: { caseType } },
			]);
		},
	);
	it.each(["hidden", "empty"])(
		"requires a visible Results column when columns are %s",
		(shape) => {
			findings(
				candidate(patient(), (d) => {
					const config = d.modules[m].caseListConfig;
					if (!config) throw new Error("missing fixture columns");
					if (shape === "hidden")
						config.columns.forEach((column) => {
							column.visibleInList = false;
						});
					else {
						config.columns = [];
						config.listColumnOrder = [];
						config.detailColumnOrder = [];
					}
				}),
				["MISSING_CASE_LIST_COLUMNS"],
			);
		},
	);
	it("admits Results without Details", () => {
		const doc = candidate(patient(), (d) => {
			const config = d.modules[m].caseListConfig;
			if (!config) throw new Error("missing fixture columns");
			config.columns.forEach((column) => {
				column.visibleInDetail = false;
			});
		});
		assertAdmittedDoc(doc);
	});
	it("requires identifying Results on a formless viewer too", () => {
		const viewer = buildDoc({
			appName: "Outreach",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: m,
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [],
				},
			],
		});
		findings(
			candidate(viewer, (d) => {
				const config = d.modules[m].caseListConfig;
				if (!config) throw new Error("missing fixture columns");
				config.columns.forEach((column) => {
					column.visibleInList = false;
				});
			}),
			["MISSING_CASE_LIST_COLUMNS"],
		);
	});
});

describe("field and property identity policy", () => {
	it.each(["answer_value", "_answer", "nova_answer"])(
		"admits field id %s",
		(id) => {
			assertAdmittedDoc(survey([{ ...plain, id }]));
		},
	);
	it.each(["1answer", "answer-value"])(
		"rejects field id %s under Nova's identifier policy",
		(id) => {
			findings(
				candidate(survey(), (d) => {
					d.fields[q].id = id;
				}),
				["INVALID_FIELD_ID"],
			);
		},
	);
	it("reserves generated node names", () => {
		findings(
			candidate(survey(), (d) => {
				d.fields[q].id = "__nova_counter";
			}),
			["RESERVED_FIELD_ID_PREFIX"],
		);
	});
	it("detects duplicate sibling paths", () => {
		const doc = survey([
			plain,
			{ kind: "text", id: "other", label: "Other", uuid: testUuid("other") },
		]);
		findings(
			candidate(doc, (d) => {
				d.fields[testUuid("other")].id = "answer";
			}),
			["DUPLICATE_FIELD_ID"],
		);
	});
	it("allows the same leaf name in separate groups and rejects a sibling duplicate within one", () => {
		const doc = survey([
			{
				kind: "group",
				id: "first",
				children: [
					plain,
					{
						uuid: testUuid("other"),
						kind: "text",
						id: "other",
						label: "Other",
					},
				],
			},
			{
				kind: "group",
				id: "second",
				children: [{ kind: "text", id: "answer", label: "Answer" }],
			},
		]);
		assertAdmittedDoc(doc);
		findings(
			candidate(doc, (d) => {
				d.fields[testUuid("other")].id = "answer";
			}),
			["DUPLICATE_FIELD_ID"],
		);
	});
	it("admits distinct writers declared in the case catalog", () => {
		assertAdmittedDoc(
			patient("registration", [
				{ ...plain, caseWrite: { caseType: "patient", property: "note" } },
				{
					kind: "int",
					id: "age",
					label: "Age",
					caseWrite: { caseType: "patient", property: "age" },
				},
			]),
		);
	});
	it.each([
		["1note", "CASE_PROPERTY_BAD_FORMAT"],
		["n".repeat(256), "CASE_PROPERTY_TOO_LONG"],
	])(
		"rejects property %s with a complete linked candidate",
		(property, code) => {
			const doc = patient("registration", [
				{ ...plain, caseWrite: { caseType: "patient", property: "note" } },
			]);
			findings(
				candidate(doc, (d) => {
					catalog(d)[0].properties[1].name = property;
					const field = d.fields[q];
					if ("caseWrite" in field && field.caseWrite)
						field.caseWrite.property = property;
				}),
				[code],
			);
		},
	);
});

describe("strict field shape and semantic backstops", () => {
	const hidden = () => survey([{ ...plain, kind: "hidden", calculate: "1" }]);
	it("admits hidden calculations and visible validation with canonical references", () => {
		assertAdmittedDoc(hidden());
		assertAdmittedDoc(
			survey([
				{
					...plain,
					kind: "int",
					validate: ". >= 0",
					validate_msg: "Enter zero or more",
					required: "true()",
				},
			]),
		);
	});
	it.each([
		["hidden", "required", xp("true()"), "REQUIRED_ON_HIDDEN"],
		[
			"hidden",
			"validate_msg",
			proseText("Wrong"),
			"VALIDATION_ON_NON_INPUT_KIND",
		],
		["label", "validate", xp("true()"), "VALIDATION_ON_NON_INPUT_KIND"],
		["group", "validate", xp("true()"), "VALIDATION_ON_NON_INPUT_KIND"],
		["text", "calculate", xp("1"), "CALCULATE_ON_VISIBLE_INPUT"],
	] as const)(
		"rejects undeclared %s.%s at schema and backstop boundaries",
		(kind, slot, value, code) => {
			const base =
				kind === "hidden"
					? hidden()
					: survey([
							{
								...plain,
								kind,
								...(kind === "group"
									? {
											children: [{ kind: "text", id: "child", label: "Child" }],
										}
									: {}),
							},
						]);
			const doc = candidate(base, (d) => {
				fieldPatch(d, { [slot]: value });
			});
			const parsed = fieldSchema.safeParse(doc.fields[q]);
			expect(parsed.success).toBe(false);
			if (parsed.success) throw new Error("invalid field admitted");
			/* The kind's strict branch is the only one that fails purely on an
			 * undeclared key, so zod reports that branch's issue as the parse
			 * failure instead of wrapping every branch in `invalid_union`. */
			expect(parsed.error.issues).toMatchObject([
				{ code: "unrecognized_keys", keys: [slot] },
			]);
			findings(doc, [code]);
		},
	);
	it("rejects a hidden field without any value", () => {
		findings(
			candidate(hidden(), (d) => {
				const field = d.fields[q];
				if (field.kind === "hidden") delete field.calculate;
			}),
			["HIDDEN_NO_VALUE"],
		);
	});
	it("admits a hidden field with only a default and rejects one carrying both value sources at the default", () => {
		assertAdmittedDoc(
			survey([{ ...plain, kind: "hidden", default_value: "today()" }]),
		);
		const doc = candidate(hidden(), (d) => {
			fieldPatch(d, { default_value: xp("today()") });
		});
		/* Schema-legal: both slots are optional so historical documents
		 * hydrate. The rule is what refuses the pair. */
		expect(fieldSchema.safeParse(doc.fields[q]).success).toBe(true);
		const [error] = findings(doc, ["HIDDEN_VALUE_BOTH_SOURCES"]);
		expect(error?.location.field).toBe("default_value");
		expect(error?.details).toEqual({ field: "answer" });
	});
	it.each(["count_bound", "query_bound", "user_controlled"] as const)(
		"admits a complete %s repeat",
		(mode) => {
			assertAdmittedDoc(repeatDoc(mode));
		},
	);
	it.each(["", "   "])(
		"rejects blank count/query repeat expressions (%j)",
		(source) => {
			for (const mode of ["count_bound", "query_bound"] as const) {
				const doc = candidate(repeatDoc(mode), (d) => {
					fieldPatch(
						d,
						mode === "count_bound"
							? { repeat_count: xp(source) }
							: { data_source: { ids_query: xp(source) } },
					);
				});
				findings(doc, [
					mode === "count_bound" ? "EMPTY_REPEAT_COUNT" : "EMPTY_IDS_QUERY",
				]);
			}
		},
	);
});
function repeatDoc(
	mode: "count_bound" | "query_bound" | "user_controlled",
): BlueprintDoc {
	return survey([
		{
			...plain,
			kind: "repeat",
			repeat_mode: mode,
			...(mode === "count_bound"
				? { repeat_count: "2" }
				: mode === "query_bound"
					? {
							data_source: {
								ids_query: "instance('casedb')/casedb/case/@case_id",
							},
						}
					: {}),
			children: [{ kind: "text", id: "item", label: "Item" }],
		},
	]);
}

describe("case action destinations and repeat scope", () => {
	const childModule = testUuid("child-module");
	const childName = testUuid("child-name");
	function children(
		mode: "count_bound" | "query_bound" | "user_controlled" | "root",
	) {
		const fields: FieldSpec[] = [
			{
				uuid: childName,
				kind: "text",
				id: "visit_name",
				label: "Visit name",
				caseWrite: { caseType: "visit", property: "case_name" },
			},
			{ ...plain, caseWrite: { caseType: "visit", property: "note" } },
		];
		const doc = patient(
			"registration",
			mode === "root"
				? fields
				: [
						{
							kind: "repeat",
							id: "visits",
							repeat_mode: mode,
							...(mode === "count_bound"
								? { repeat_count: "2" }
								: mode === "query_bound"
									? {
											data_source: {
												ids_query: "instance('casedb')/casedb/case/@case_id",
											},
										}
									: {}),
							children: fields,
						},
					],
		);
		catalog(doc).push({
			name: "visit",
			parent_type: "patient",
			properties: [
				{ name: "note", data_type: "text", label: proseText("Note") },
			],
		});
		const viewer = buildDoc({
			appName: "Viewer",
			modules: [
				{
					uuid: childModule,
					name: "Visits",
					caseType: "visit",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [],
				},
			],
		});
		doc.modules[childModule] = viewer.modules[childModule];
		doc.moduleOrder.push(childModule);
		doc.formOrder[childModule] = [];
		return doc;
	}
	it.each(["root", "count_bound", "query_bound", "user_controlled"] as const)(
		"admits a named child bucket at %s and refuses its missing name",
		(mode) => {
			const base = children(mode);
			assertAdmittedDoc(base);
			const errors = findings(
				candidate(base, (d) => {
					const field = d.fields[childName];
					if ("caseWrite" in field) delete field.caseWrite;
				}),
				["CASE_CREATE_NAME_MISSING"],
			);
			expect(errors).toMatchObject([
				{
					scope: "form",
					details: {
						caseType: "visit",
						writerCount: "0",
						...(mode === "root" ? {} : { repeatId: "visits" }),
					},
				},
			]);
		},
	);
	it.each(["count_bound", "query_bound", "user_controlled"] as const)(
		"refuses a primary-case writer inside a %s repeat",
		(mode) => {
			const doc = candidate(children(mode), (d) => {
				const field = d.fields[q];
				if ("caseWrite" in field && field.caseWrite)
					field.caseWrite.caseType = "patient";
			});
			expect(findings(doc, ["PRIMARY_CASE_FIELD_IN_REPEAT"])).toMatchObject([
				{
					scope: "form",
					location: { fieldUuid: q },
					details: { repeatId: "visits", caseType: "patient" },
				},
			]);
		},
	);
	it("admits planned child types but requires a module once forms create them", () => {
		const planned = candidate(patient(), (d) => {
			catalog(d).push({
				name: "visit",
				parent_type: "patient",
				properties: [],
			});
		});
		assertAdmittedDoc(planned);
		const doc = candidate(children("root"), (d) => {
			delete d.modules[childModule];
			delete d.formOrder[childModule];
			d.moduleOrder = [m];
		});
		expect(findings(doc, ["MISSING_CHILD_CASE_MODULE"])).toMatchObject([
			{ scope: "app", details: { caseType: "visit" } },
		]);
	});
	it("rejects survey case annotations instead of treating them as an admitted no-op", () => {
		findings(
			candidate(patient(), (d) => {
				d.forms[a].type = "survey";
			}),
			["CASE_WRITE_NO_CASE_ACTION"],
		);
	});
});

describe("form navigation admission", () => {
	function linkedBase() {
		return buildDoc({
			appName: "Outreach",
			modules: [
				{
					uuid: m,
					name: "Surveys",
					forms: [a, b, c].map((uuid, index) => ({
						uuid,
						name: `Form ${index + 1}`,
						type: "survey",
						fields: [{ kind: "text", id: "answer", label: "Answer" }],
					})),
				},
			],
		});
	}
	const link = (formUuid: Uuid, id = "link") => ({
		uuid: testUuid(id),
		target: { type: "form" as const, moduleUuid: m, formUuid },
	});
	it.each(["app_home", "module", "previous"] as const)(
		"admits explicit %s destination",
		(postSubmit) => {
			assertAdmittedDoc(
				candidate(linkedBase(), (d) => {
					d.forms[a].postSubmit = postSubmit;
				}),
			);
		},
	);
	it("rejects retired destinations at the schema and validator backstop", () => {
		const base = linkedBase();
		const doc = candidate(base, (d) => {
			Object.assign(d.forms[a], { postSubmit: "case_list" });
		});
		const parsed = formSchema.safeParse(doc.forms[a]);
		if (parsed.success) throw new Error("retired destination admitted");
		expect(parsed.error.issues).toMatchObject([
			{ code: "invalid_value", path: ["postSubmit"] },
		]);
		findings(doc, ["INVALID_POST_SUBMIT"]);
	});
	it("admits absent navigation and unconditional form/module links", () => {
		const base = linkedBase();
		assertAdmittedDoc(base);
		assertAdmittedDoc(
			candidate(base, (d) => {
				d.forms[a].formLinks = [link(b)];
			}),
		);
		assertAdmittedDoc(
			candidate(base, (d) => {
				d.forms[a].formLinks = [
					{
						uuid: testUuid("module-link"),
						target: { type: "module", moduleUuid: m },
					},
				];
			}),
		);
	});
	it("requires an explicit fallback for conditional session-scope links", () => {
		const doc = candidate(linkedBase(), (d) => {
			d.forms[a].formLinks = [
				{ ...link(b), condition: xp("#user/username = 'reviewer'") },
			];
		});
		findings(doc, ["FORM_LINK_NO_FALLBACK"]);
		const repaired = structuredClone(doc);
		repaired.forms[a].postSubmit = "app_home";
		assertAdmittedDoc(repaired);
	});
	it("rejects a terminal link hidden behind an unconditional earlier link", () => {
		findings(
			candidate(linkedBase(), (d) => {
				d.forms[a].formLinks = [link(b), link(c, "second")];
			}),
			["FORM_LINK_UNREACHABLE"],
		);
	});
	it("rejects an explicitly empty link collection", () => {
		findings(
			candidate(linkedBase(), (d) => {
				d.forms[a].formLinks = [];
			}),
			["FORM_LINK_EMPTY"],
		);
	});
	it.each(["module", "form"] as const)(
		"rejects a missing target %s",
		(target) => {
			const doc = candidate(linkedBase(), (d) => {
				d.forms[a].formLinks = [
					{
						...link(b),
						target:
							target === "module"
								? { type: "module", moduleUuid: testUuid("missing-module") }
								: {
										type: "form",
										moduleUuid: m,
										formUuid: testUuid("missing-form"),
									},
					},
				];
			});
			findings(doc, ["FORM_LINK_TARGET_NOT_FOUND"]);
		},
	);
	it.each([1, 2, 3])("reports every member of a %i-form cycle", (length) => {
		const forms = [a, b, c].slice(0, length);
		const doc = candidate(linkedBase(), (d) => {
			forms.forEach((uuid, index) => {
				d.forms[uuid].formLinks = [
					link(forms[(index + 1) % length], `cycle-${index}`),
				];
			});
		});
		const errors = findings(doc, [
			...forms.map(() => "FORM_LINK_CIRCULAR"),
			...(length === 1 ? ["FORM_LINK_SELF_REFERENCE"] : []),
		]);
		expect(errors.slice(0, length)).toMatchObject(
			forms.map((formUuid) => ({ scope: "app", details: { formUuid } })),
		);
	});
});

describe("raw wire keys never enter the authoring vocabulary", () => {
	it.each(["put_in_root", "case_list_form", "schedule", "parent_select"])(
		"rejects module.%s for exactly that unknown key",
		(key) => {
			const doc = survey();
			assertAdmittedDoc(doc);
			const base = doc.modules[m];
			moduleSchema.parse(base);
			const result = moduleSchema.safeParse({ ...base, [key]: {} });
			if (result.success) throw new Error(`accepted ${key}`);
			expect(result.error.issues).toMatchObject([
				{ code: "unrecognized_keys", path: [], keys: [key] },
			]);
		},
	);
	it.each(["usercase_update", "usercase_preload"])(
		"rejects form.%s for exactly that unknown key",
		(key) => {
			const doc = survey();
			assertAdmittedDoc(doc);
			const base = doc.forms[a];
			formSchema.parse(base);
			const result = formSchema.safeParse({ ...base, [key]: {} });
			if (result.success) throw new Error(`accepted ${key}`);
			expect(result.error.issues).toMatchObject([
				{ code: "unrecognized_keys", path: [], keys: [key] },
			]);
		},
	);
});

describe("case reads in expressions and prose", () => {
	it.each(["calculate", "default_value", "relevant", "validate", "required"])(
		"requires form answers instead of new-case properties in %s",
		(slot) => {
			const base = patient("registration", [
				{
					...plain,
					...(slot === "calculate" ? { kind: "hidden", calculate: "1" } : {}),
				},
			]);
			const doc = candidate(base, (d) => {
				fieldPatch(d, {
					[slot]: xp(
						slot === "calculate" || slot === "default_value"
							? "#patient/age"
							: "#patient/age > 0",
					),
				});
			});
			findings(doc, ["CASE_HASHTAG_ON_CREATE_FORM", "INVALID_CASE_REF"]);
		},
	);
	it("admits the created case id, a typed form answer, and existing-case reads on followup", () => {
		assertAdmittedDoc(
			patient("registration", [
				{ ...plain, kind: "hidden", calculate: "#patient/case_id" },
			]),
		);
		assertAdmittedDoc(
			patient("registration", [
				{ ...plain, kind: "hidden", calculate: "#form/name" },
			]),
		);
		assertAdmittedDoc(
			patient("followup", [
				{ ...plain, kind: "hidden", calculate: "#patient/age" },
			]),
		);
	});
	it("does not mistake a property prefixed case_id for the allocated identity", () => {
		const base = patient();
		catalog(base)[0].properties.push({
			name: "case_id_extra",
			data_type: "text",
			label: proseText("Extra"),
		});
		findings(
			candidate(base, (d) => {
				fieldPatch(d, { default_value: xp("#patient/case_id_extra") });
			}),
			["CASE_HASHTAG_ON_CREATE_FORM", "INVALID_CASE_REF"],
		);
	});
	const ref = (property: string): ProseTemplate => ({
		parts: [
			{ kind: "text", text: "Value: " },
			{ kind: "case-ref", caseType: "patient", property },
		],
	});
	it.each(["label", "hint", "help", "validate_msg"])(
		"checks typed case reads on %s without interpreting literal hashtags",
		(slot) => {
			const base = patient("followup");
			assertAdmittedDoc(
				candidate(base, (d) => {
					fieldPatch(d, { [slot]: ref("note") });
				}),
			);
			const doc = candidate(base, (d) => {
				fieldPatch(d, { [slot]: ref("typo") });
			});
			expect(findings(doc, ["INVALID_CASE_REF"])).toMatchObject([
				{ scope: "field", location: { fieldUuid: q, field: slot } },
			]);
			assertAdmittedDoc(
				candidate(base, (d) => {
					fieldPatch(d, {
						[slot]: proseText("Literal #patient/typo and #unknown/ref"),
					});
				}),
			);
		},
	);
	it("checks answer-option labels as prose and rejects a new-case label read", () => {
		const doc = patient("followup", [
			{
				...plain,
				kind: "single_select",
				optionsSource: {
					kind: "inline",
					options: [
						{ uuid: testUuid("yes"), value: "yes", label: ref("note") },
						{ uuid: testUuid("no"), value: "no", label: proseText("No") },
					],
				},
			},
		]);
		assertAdmittedDoc(doc);
		const bad = candidate(doc, (d) => {
			const field = d.fields[q];
			if (
				field.kind !== "single_select" ||
				field.optionsSource.kind !== "inline"
			)
				throw new Error("missing choices");
			field.optionsSource.options[0].label = ref("typo");
		});
		expect(findings(bad, ["INVALID_CASE_REF"])).toMatchObject([
			{ location: { field: "option_label" } },
		]);
		findings(
			candidate(patient(), (d) => {
				fieldPatch(d, { label: ref("note") });
			}),
			["CASE_HASHTAG_ON_CREATE_FORM", "INVALID_CASE_REF"],
		);
	});
	it.each(["item-list:lookup", "commcare:reports", "commcare-reports:abc"])(
		"rejects an unavailable instance %s on the authored carrier",
		(instance) => {
			const doc = candidate(
				survey([{ ...plain, kind: "hidden", calculate: "1" }]),
				(d) => {
					fieldPatch(d, {
						calculate: xp(`instance('${instance}')/items/item`),
					});
				},
			);
			expect(findings(doc, ["XPATH_INSTANCE_UNAVAILABLE"])).toMatchObject([
				{ scope: "app", details: { slot: "calculate" } },
			]);
		},
	);
	it.each(["default_value", "relevant", "validate", "required"])(
		"checks unavailable instances in %s too",
		(slot) => {
			const doc = candidate(survey(), (d) => {
				fieldPatch(d, {
					[slot]: xp("count(instance('missing')/items/item) > 0"),
				});
			});
			expect(findings(doc, ["XPATH_INSTANCE_UNAVAILABLE"])).toMatchObject([
				{ details: { slot } },
			]);
		},
	);
	it("admits declared case and session instances", () => {
		assertAdmittedDoc(
			survey([
				{
					...plain,
					kind: "hidden",
					calculate: "count(instance('casedb')/casedb/case)",
				},
			]),
		);
		assertAdmittedDoc(
			survey([
				{
					...plain,
					kind: "hidden",
					calculate: "instance('commcaresession')/session/context/userid",
				},
			]),
		);
	});
});

describe("Connect participant admission", () => {
	function connect(mode: "learn" | "deliver", block?: Form["connect"]) {
		return buildDoc({
			appName: "Training",
			connectType: mode,
			modules: [
				{
					uuid: m,
					name: "Training",
					forms: [
						{
							uuid: a,
							name: "Lesson",
							type: "survey",
							connect:
								block ??
								(mode === "learn"
									? {
											learn_module: {
												id: "lesson",
												name: "Lesson",
												description: "Practice",
												time_estimate: 5,
											},
										}
									: { deliver_unit: { id: "visit", name: "Visit" } }),
							fields: [plain],
						},
						{
							uuid: b,
							name: "Feedback",
							type: "survey",
							fields: [{ kind: "text", id: "feedback", label: "Feedback" }],
						},
					],
				},
			],
		});
	}
	it.each(["learn", "deliver"] as const)(
		"admits %s participants alongside nonempty auxiliary forms",
		(mode) => {
			assertAdmittedDoc(connect(mode));
		},
	);
	it.each(["learn", "deliver"] as const)(
		"requires a participant in %s mode",
		(mode) => {
			findings(
				candidate(connect(mode), (d) => {
					delete d.forms[a].connect;
				}),
				["CONNECT_NO_PARTICIPATING_FORMS"],
			);
		},
	);
	it("rejects dormant and mismatched blocks", () => {
		findings(
			candidate(connect("learn"), (d) => {
				d.connectType = null;
			}),
			["BLUEPRINT_TOPOLOGY_INVALID", "CONNECT_MODE_MISMATCH"],
		);
		findings(
			candidate(connect("learn"), (d) => {
				d.connectType = "deliver";
			}),
			[
				"BLUEPRINT_TOPOLOGY_INVALID",
				"CONNECT_NO_PARTICIPATING_FORMS",
				"CONNECT_MODE_MISMATCH",
			],
		);
	});
	const configs: {
		mode: "learn" | "deliver";
		kind: string;
		make: (id: string) => Form["connect"];
	}[] = [
		{
			mode: "learn",
			kind: "learn_module",
			make: (id) => ({
				learn_module: {
					id,
					name: "Lesson",
					description: "Practice",
					time_estimate: 5,
				},
			}),
		},
		{
			mode: "learn",
			kind: "assessment",
			make: (id) => ({ assessment: { id } }),
		},
		{
			mode: "deliver",
			kind: "deliver_unit",
			make: (id) => ({ deliver_unit: { id, name: "Visit" } }),
		},
		{
			mode: "deliver",
			kind: "task",
			make: (id) => ({
				task: { id, name: "Task", description: "Complete the task" },
			}),
		},
	];
	it.each(configs)(
		"enforces ID policy for $kind with admitted controls",
		({ mode, make }) => {
			assertAdmittedDoc(connect(mode, make("a".repeat(50))));
			for (const [id, code] of [
				["bad id", "CONNECT_ID_INVALID_FORMAT"],
				["1bad", "CONNECT_ID_INVALID_FORMAT"],
				["a".repeat(51), "CONNECT_ID_TOO_LONG"],
			]) {
				const base = connect(mode, make("valid_id"));
				findings(
					candidate(base, (d) => {
						d.forms[a].connect = make(id);
					}),
					[code],
				);
			}
		},
	);
	it("reports duplicate IDs at their second participant and admits distinct IDs", () => {
		const doc = candidate(connect("learn"), (d) => {
			d.forms[b].connect = { assessment: { id: "quiz" } };
		});
		assertAdmittedDoc(doc);
		expect(
			findings(
				candidate(doc, (d) => {
					d.forms[b].connect = { assessment: { id: "lesson" } };
				}),
				["BLUEPRINT_TOPOLOGY_INVALID", "CONNECT_ID_DUPLICATE"],
			),
		).toMatchObject([
			{ scope: "app", details: { path: `forms.${b}.connect.assessment.id` } },
			{
				scope: "app",
				location: { formUuid: b },
				details: { connectId: "lesson" },
			},
		]);
	});
	it.each(["entity_id", "entity_name"] as const)(
		"rejects explicit empty deliver %s and admits absent defaults",
		(slot) => {
			const base = connect("deliver", {
				deliver_unit: {
					id: "visit",
					name: "Visit",
					entity_id: xp("concat(#user/username, '-', today())"),
					entity_name: xp("#user/username"),
				},
			});
			assertAdmittedDoc(base);
			findings(
				candidate(base, (d) => {
					const block = d.forms[a].connect;
					if (!block || !("deliver_unit" in block) || !block.deliver_unit)
						throw new Error("missing deliver unit");
					block.deliver_unit[slot] = xp("");
				}),
				["CONNECT_EMPTY_XPATH"],
			);
		},
	);
	it("rejects an explicitly empty score", () => {
		const base = connect("learn", {
			assessment: { id: "quiz", user_score: xp("1") },
		});
		findings(
			candidate(base, (d) => {
				d.forms[a].connect = { assessment: { id: "quiz", user_score: xp("") } };
			}),
			["CONNECT_EMPTY_XPATH"],
		);
	});
});
