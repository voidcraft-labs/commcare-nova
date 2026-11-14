import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { fieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	type Form,
	fieldSchema,
	formSchema,
	moduleSchema,
	type ProseTemplate,
	postSubmitDestinationsOffered,
	postSubmitNotOfferedReason,
	proseText,
	type Uuid,
} from "@/lib/domain";
import {
	concat,
	eq,
	gt,
	literal,
	matchAll,
	term,
	today,
} from "@/lib/domain/expression/builders";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
} from "../../__tests__/docHelpers";
import type { ValidationError } from "../validator/errors";
import { runValidation } from "../validator/runner";
import { parseFormExpression } from "../xpath/expressionAst";

// These tests exercise Nova's complete validator verdict. Wire execution is
// covered by the native suites in proof/native; a clean verdict here is
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
	childTypes: NonNullable<BlueprintDoc["caseTypes"]> = [],
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
			...childTypes,
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
/** The write of the question `fieldUuid` saves, in whichever case change
 * of the doc holds it. */
function writeOf(doc: BlueprintDoc, fieldUuid: string) {
	for (const form of Object.values(doc.forms))
		for (const operation of form.caseOperations ?? [])
			for (const write of operation.writes ?? [])
				if (
					write.value.kind === "term" &&
					write.value.term.kind === "field" &&
					write.value.term.uuid === fieldUuid
				)
					return write;
	throw new Error(`No case change saves ${fieldUuid}`);
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
	it.each(["patient record", "patient@home", "ñ"])(
		"rejects invalid case type %s without breaking its catalog links",
		(caseType) => {
			const base = patient();
			const doc = candidate(base, (d) => {
				d.modules[m].caseType = caseType;
				catalog(d)[0].name = caseType;
			});
			findings(doc, ["INVALID_CASE_TYPE_FORMAT"]);
		},
	);
	it("rejects a case type over the authoring limit", () => {
		findings(patient("registration", [plain], "p".repeat(256)), [
			"CASE_TYPE_TOO_LONG",
		]);
	});
	it.each(["user", "case", "form", "parent", "search", "Parent", "1patient"])(
		"admits the case type %s, a word reference text names as #record/<type>/",
		(caseType) => {
			assertAdmittedDoc(patient("registration", [plain], caseType));
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
					caseListMenuItem: {},
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
	// Nova reserves no question names for its own nodes: the allocator steps
	// around an authored name equal to a generated one.
	it.each([
		"answer_value",
		"nova_answer",
		"nova_url_x",
		"xmlcode",
		"metadata",
		"cases",
		"instances",
		"itext",
		"answer-value",
		"copy-1-of-answer",
	])("admits field id %s", (id) => {
		assertAdmittedDoc(survey([{ ...plain, id }]));
	});
	it.each([
		["1answer", "not-letter-first", "q1answer"],
		["answer value", "characters", "answer_value"],
		["-answer", "not-letter-first", "answer"],
		["_answer", "leading-underscore", "answer"],
		["__nova_x", "leading-underscore", "nova_x"],
		["XMLcode", "xml-prefix", "qXMLcode"],
		["Meta", "reserved-name", "q_Meta"],
		["case", "reserved-name", "q_case"],
		["Script", "reserved-name", "q_Script"],
		["parsererror", "reserved-name", "q_parsererror"],
	])(
		"rejects field id %s under Nova's identifier policy as %s, offering %s",
		(id, problem, suggestedId) => {
			const [finding] = findings(
				candidate(survey(), (d) => {
					d.fields[q].id = id;
				}),
				["INVALID_FIELD_ID"],
			);
			expect(finding?.details).toMatchObject({ problem, suggestedId });
			// The builder's verdict says the same sentence the finding ends with.
			const verdict = fieldIdVerdict({
				doc: survey(),
				parentUuid: a,
				proposedId: id,
				excludeUuid: q,
			});
			expect(verdict.ok).toBe(false);
			expect(finding?.message.endsWith(verdict.ok ? "" : verdict.message)).toBe(
				true,
			);
		},
	);
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
	// The write names the property, so its grammar is the operation's rule.
	it.each([
		["1note", "CASE_OPERATION_UNKNOWN_PROPERTY"],
		["n".repeat(256), "CASE_OPERATION_UNKNOWN_PROPERTY"],
	])(
		"rejects property %s with a complete linked candidate",
		(property, code) => {
			const doc = patient("registration", [
				{ ...plain, caseWrite: { caseType: "patient", property: "note" } },
			]);
			findings(
				candidate(doc, (d) => {
					catalog(d)[0].properties[1].name = property;
					writeOf(d, q).property = property;
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
		["hidden", "required", matchAll(), "REQUIRED_ON_HIDDEN"],
		[
			"hidden",
			"validate_msg",
			proseText("Wrong"),
			"VALIDATION_ON_NON_INPUT_KIND",
		],
		["label", "validate", matchAll(), "VALIDATION_ON_NON_INPUT_KIND"],
		["group", "validate", matchAll(), "VALIDATION_ON_NON_INPUT_KIND"],
		["text", "calculate", term(literal(1)), "CALCULATE_ON_VISIBLE_INPUT"],
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
	it("admits a hidden field with neither a calculate nor a default", () => {
		findings(
			candidate(hidden(), (d) => {
				const field = d.fields[q];
				if (field.kind === "hidden") delete field.calculate;
			}),
			[],
		);
	});
	it("admits a hidden field with only a default and rejects one carrying both value sources at the default", () => {
		assertAdmittedDoc(
			survey([{ ...plain, kind: "hidden", default_value: "today()" }]),
		);
		const doc = candidate(hidden(), (d) => {
			fieldPatch(d, { default_value: today() });
		});
		/* Schema-legal: both slots are optional so historical documents
		 * hydrate. The rule is what refuses the pair. */
		expect(fieldSchema.safeParse(doc.fields[q]).success).toBe(true);
		const [error] = findings(doc, ["HIDDEN_VALUE_BOTH_SOURCES"]);
		expect(error?.location.fieldId).toBe("answer");
		expect(error?.location.field).toBeUndefined();
	});
	it.each(["count_bound", "query_bound", "user_controlled"] as const)(
		"admits a complete %s repeat",
		(mode) => {
			assertAdmittedDoc(repeatDoc(mode));
		},
	);
	it.each(["", "   ", { parts: [] }])(
		"refuses a raw or fragment repeat expression at the schema (%j)",
		(source) => {
			for (const mode of ["count_bound", "query_bound"] as const) {
				const field = repeatDoc(mode).fields[q];
				const candidate =
					mode === "count_bound"
						? { ...field, repeat_count: source }
						: { ...field, data_source: { ids_query: source } };
				expect(fieldSchema.safeParse(candidate).success).toBe(false);
			}
		},
	);
	it.each(["count_bound", "query_bound"] as const)(
		"keeps a missing %s expression behind the semantic gate too",
		(mode) => {
			const doc = candidate(repeatDoc(mode), (d) => {
				fieldPatch(
					d,
					mode === "count_bound"
						? { repeat_count: undefined }
						: { data_source: { ids_query: undefined } },
				);
			});
			findings(doc, [
				mode === "count_bound" ? "EMPTY_REPEAT_COUNT" : "EMPTY_IDS_QUERY",
			]);
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
		// The child type is declared from the start, so each field's "Saves
		// to" makes its create as the document is built.
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
			"patient",
			[
				{
					name: "visit",
					parent_type: "patient",
					properties: [
						{ name: "note", data_type: "text", label: proseText("Note") },
					],
				},
			],
		);
		const viewer = buildDoc({
			appName: "Viewer",
			modules: [
				{
					uuid: childModule,
					name: "Visits",
					caseType: "visit",
					caseListMenuItem: {},
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
	// A create holds its name by its shape, so a child with no name is no
	// document: the "Saves to" planner refuses the write that would make one.
	it.each(["root", "count_bound", "query_bound", "user_controlled"] as const)(
		"admits a named child create at %s",
		(mode) => {
			const base = children(mode);
			assertAdmittedDoc(base);
			expect(
				base.forms[a].caseOperations?.flatMap((operation) =>
					operation.action === "create"
						? [[operation.caseType, operation.forEach !== undefined]]
						: [],
				),
			).toEqual([["visit", mode !== "root"]]);
		},
	);
	it.each(["count_bound", "query_bound", "user_controlled"] as const)(
		"refuses a primary-case writer inside a %s repeat",
		(mode) => {
			// The own case saves the repeat's answer once per submission.
			const doc = candidate(children(mode), (d) => {
				const own = d.forms[a].caseOperations?.find(
					(operation) => operation.action === "own",
				);
				if (own === undefined) throw new Error("Missing the own case");
				own.writes = [
					...(own.writes ?? []),
					{ property: "note", value: writeOf(d, q).value },
				];
			});
			// Once per submission, a row's answer has many values: the
			// checker's own refusal, located at the own case.
			const many = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
				(error) =>
					error.code === "CASE_OPERATION_EXPRESSION_TYPE" &&
					error.details?.checkCode === "many-values",
			);
			expect(many).toMatchObject([
				{ scope: "form", details: { checkReason: "repeat" } },
			]);
		},
	);
	it("admits planned child types, and forms that create them with no module listing them", () => {
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
		// CommCare HQ has no rule that a created case type have a menu, so a
		// form may create child cases no module lists.
		assertAdmittedDoc(doc);
	});
	it("refuses a survey that keeps the own case of the form it was", () => {
		findings(
			candidate(patient(), (d) => {
				d.forms[a].type = "survey";
			}),
			["CASE_OWN_OPERATION"],
		);
	});
});

describe("POST_SUBMIT_NOT_OFFERED", () => {
	const child = testUuid("rules-child-module");
	const childForm = testUuid("rules-child-form");
	/** A survey module "Survey" (`m`) with a child survey module "Follow-up
	 * visits" under it, whose one form is the subject. */
	function nested(): BlueprintDoc {
		const doc = buildDoc({
			appName: "Outreach",
			modules: [
				{
					uuid: m,
					name: "Survey",
					forms: [{ uuid: a, name: "Intake", type: "survey", fields: [plain] }],
				},
				{
					uuid: child,
					name: "Follow-up visits",
					forms: [
						{
							uuid: childForm,
							name: "Check-in",
							type: "survey",
							fields: [{ kind: "text", id: "note", label: "Note" }],
						},
					],
				},
			],
		});
		doc.modules[child].parentModuleUuid = m;
		return doc;
	}
	function notOffered(doc: BlueprintDoc) {
		return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			({ code }) => code === "POST_SUBMIT_NOT_OFFERED",
		);
	}
	function only(doc: BlueprintDoc) {
		const errors = notOffered(doc);
		expect(errors).toHaveLength(1);
		return errors[0];
	}
	const several = { kind: "multiple" as const, maximum: 5 };

	it("menu-selects-several: refuses previous in a module that selects several cases", () => {
		const base = patient("followup");
		const refused = only(
			candidate(base, (d) => {
				d.modules[m].caseListConfig = {
					...(d.modules[m].caseListConfig ?? caseListConfig([])),
					selection: several,
				};
				d.forms[a].postSubmit = "previous";
			}),
		);
		expect(refused.details).toMatchObject({
			reason: "menu-selects-several",
			destination: "previous",
			offered: "app_home,firstMenu,module",
		});
		expect(refused.message).toBe(
			'"Intake" goes to the previous screen after submit, but "Patients" selects several cases, and CommCare has no previous screen to return to there. Choose one of: "app_home", "firstMenu", "module".',
		);
		expect(userFacingError(refused)).toBe(
			'"Intake" goes to the previous screen after submit, but "Patients" selects several cases, and CommCare has no previous screen to return to there. Choose one of: "App home", "First menu", "This module".',
		);
		expect(
			notOffered(
				candidate(base, (d) => {
					d.modules[m].caseListConfig = {
						...(d.modules[m].caseListConfig ?? caseListConfig([])),
						selection: several,
					};
					d.forms[a].postSubmit = "module";
				}),
			),
		).toEqual([]);
	});

	it("parent-selects-several: refuses module, parentMenu and previous under a parent that selects several cases", () => {
		for (const destination of ["module", "parentMenu", "previous"] as const) {
			const refused = only(
				candidate(nested(), (d) => {
					d.modules[m].caseListConfig = {
						...caseListConfig([]),
						selection: several,
					};
					d.forms[childForm].postSubmit = destination;
				}),
			);
			expect(refused.details).toMatchObject({
				reason: "parent-selects-several",
				destination,
				offered: "app_home,firstMenu",
				parentName: "Survey",
			});
		}
		const refused = only(
			candidate(nested(), (d) => {
				d.modules[m].caseListConfig = {
					...caseListConfig([]),
					selection: several,
				};
				d.forms[childForm].postSubmit = "module";
			}),
		);
		expect(refused.message).toBe(
			'"Check-in" goes to its module after submit, but "Follow-up visits" sits under "Survey", which selects several cases. Choose one of: "app_home", "firstMenu".',
		);
		expect(userFacingError(refused)).toBe(
			'"Check-in" goes to its module after submit, but "Follow-up visits" sits under "Survey", which selects several cases. Choose one of: "App home", "First menu".',
		);
		expect(
			notOffered(
				candidate(nested(), (d) => {
					d.modules[m].caseListConfig = {
						...caseListConfig([]),
						selection: several,
					};
					d.forms[childForm].postSubmit = "firstMenu";
				}),
			),
		).toEqual([]);
	});

	it("menu-forms-read-search: refuses previous in a module whose forms read the search", () => {
		const base = patient("followup");
		const refused = only(
			candidate(base, (d) => {
				d.modules[m].caseSearchConfig = { formsReadSearch: true };
				d.forms[a].postSubmit = "previous";
			}),
		);
		expect(refused.details).toMatchObject({ reason: "menu-forms-read-search" });
		expect(refused.message).toBe(
			'"Intake" goes to the previous screen after submit, but "Patients" has its forms read the search, and CommCare can\'t go back to the previous screen there. Choose one of: "app_home", "firstMenu", "module".',
		);
		expect(userFacingError(refused)).toBe(
			'"Intake" goes to the previous screen after submit, but "Patients" has its forms read the search, and CommCare can\'t go back to the previous screen there. Choose one of: "App home", "First menu", "This module".',
		);
		// A search first whose forms don't read the search goes back, as
		// HQ's build lets it (`helpers/validators.py`, `workflow previous
		// inline search`).
		expect(
			notOffered(
				candidate(base, (d) => {
					d.modules[m].caseSearchConfig = {};
					d.forms[a].postSubmit = "previous";
				}),
			),
		).toEqual([]);
		expect(
			notOffered(
				candidate(base, (d) => {
					d.modules[m].caseSearchConfig = { formsReadSearch: true };
					d.forms[a].postSubmit = "module";
				}),
			),
		).toEqual([]);
	});

	it("menu-is-bare-case-list: withholds module in a bare case list", () => {
		// The menu's one form is its case list registration form, on no
		// menu, so the menu is its case list alone. That form's own rule
		// holds its after-submit destination to First menu, so the reason is
		// the domain's statement alone.
		const doc = candidate(patient("registration"), (d) => {
			d.modules[m].caseListMenuItem = {};
			d.modules[m].caseListRegistrationForm = {
				kind: "after-empty-search",
				formUuid: a,
			};
			d.forms[a].postSubmit = "module";
		});
		expect(postSubmitNotOfferedReason(doc, a, "module")).toBe(
			"menu-is-bare-case-list",
		);
		expect(postSubmitDestinationsOffered(doc, a)).not.toContain("module");
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(({ code }) => code),
		).toContain("CASE_LIST_REGISTRATION_HAS_NAVIGATION");
	});

	it("no-parent-menu: refuses parentMenu in a top-level module", () => {
		const refused = only(
			candidate(survey(), (d) => {
				d.forms[a].postSubmit = "parentMenu";
			}),
		);
		expect(refused.details).toMatchObject({ reason: "no-parent-menu" });
		expect(refused.message).toBe(
			'"Intake" goes to the parent module after submit, but "Survey" has no parent module. Choose one of: "app_home", "firstMenu", "module", "previous".',
		);
		expect(userFacingError(refused)).toBe(
			'"Intake" goes to the parent module after submit, but "Survey" has no parent module. Choose one of: "App home", "First menu", "This module", "Previous screen".',
		);
		assertAdmittedDoc(
			candidate(nested(), (d) => {
				d.forms[childForm].postSubmit = "parentMenu";
			}),
		);
	});

	it("menu-off-the-menu: refuses module and previous in a module off the menu", () => {
		for (const destination of ["module", "previous"] as const) {
			const refused = only(
				candidate(survey(), (d) => {
					d.modules[m].hiddenFromMenu = true;
					d.forms[a].postSubmit = destination;
				}),
			);
			expect(refused.details).toMatchObject({
				reason: "menu-off-the-menu",
				destination,
			});
		}
		const refused = only(
			candidate(survey(), (d) => {
				d.modules[m].hiddenFromMenu = true;
				d.forms[a].postSubmit = "previous";
			}),
		);
		expect(refused.message).toBe(
			'"Intake" goes to the previous screen after submit, but "Survey" is off the menu: on Android that screen lists nothing, and Web Apps opens another screen instead. Choose one of: "app_home", "firstMenu".',
		);
		expect(userFacingError(refused)).toBe(
			'"Intake" goes to the previous screen after submit, but "Survey" is off the menu: on Android that screen lists nothing, and Web Apps opens another screen instead. Choose one of: "App home", "First menu".',
		);
		assertAdmittedDoc(
			candidate(survey(), (d) => {
				d.modules[m].hiddenFromMenu = true;
				d.forms[a].postSubmit = "firstMenu";
			}),
		);
	});

	it("parent-off-the-menu: refuses parentMenu under a parent off the menu", () => {
		const refused = only(
			candidate(nested(), (d) => {
				d.modules[m].hiddenFromMenu = true;
				d.forms[childForm].postSubmit = "parentMenu";
			}),
		);
		expect(refused.details).toMatchObject({
			reason: "parent-off-the-menu",
			parentName: "Survey",
		});
		expect(refused.message).toBe(
			'"Check-in" goes to the parent module after submit, but "Survey" is off the menu: on Android it lists none of its own forms, and Web Apps opens the app\'s first screen instead. Choose one of: "app_home", "firstMenu", "module", "previous".',
		);
		expect(userFacingError(refused)).toBe(
			'"Check-in" goes to the parent module after submit, but "Survey" is off the menu: on Android it lists none of its own forms, and Web Apps opens the app\'s first screen instead. Choose one of: "App home", "First menu", "This module", "Previous screen".',
		);
		assertAdmittedDoc(
			candidate(nested(), (d) => {
				d.modules[m].hiddenFromMenu = true;
				d.forms[childForm].postSubmit = "module";
			}),
		);
	});

	it("leaves a form with destinations to the otherwise's rules", () => {
		const linked = (d: BlueprintDoc) => {
			d.forms[a].formLinks = [
				{
					uuid: testUuid("rules-link"),
					target: { type: "module", moduleUuid: m },
					condition: eq(
						{
							kind: "session-user",
							field: "username",
							source: "worker-record",
						},
						literal("reviewer"),
					),
				},
			];
		};
		const multi = (d: BlueprintDoc) => {
			d.modules[m].caseListConfig = {
				...(d.modules[m].caseListConfig ?? caseListConfig([])),
				selection: several,
			};
		};
		// A postSubmit beside destinations is its own finding, not a
		// destination the menu withholds.
		const beside = candidate(patient("followup"), (d) => {
			multi(d);
			linked(d);
			d.forms[a].postSubmit = "previous";
		});
		const codesOf = (doc: BlueprintDoc) =>
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(({ code }) => code);
		expect(notOffered(beside)).toEqual([]);
		expect(codesOf(beside)).toContain("POST_SUBMIT_BESIDE_FORM_LINKS");
		// The several-case reasons withhold a built-in otherwise as they
		// withhold an after-submit destination.
		const otherwise = candidate(patient("followup"), (d) => {
			multi(d);
			linked(d);
			d.forms[a].otherwise = { kind: "destination", destination: "previous" };
		});
		const refused = runValidation(otherwise, LOOKUP_CONTEXT_UNAVAILABLE).find(
			({ code }) => code === "FORM_OTHERWISE_NOT_OFFERED",
		);
		expect(codesOf(otherwise)).not.toContain("POST_SUBMIT_BESIDE_FORM_LINKS");
		expect(refused?.details).toMatchObject({
			reason: "menu-selects-several",
			slot: "otherwise",
		});
		expect(
			only(
				candidate(patient("followup"), (d) => {
					multi(d);
					d.forms[a].postSubmit = "previous";
				}),
			).details,
		).toMatchObject({ reason: "menu-selects-several" });
	});

	it("never refuses an absent slot", () => {
		assertAdmittedDoc(
			candidate(nested(), (d) => {
				d.modules[m].hiddenFromMenu = true;
			}),
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
	it.each(["app_home", "firstMenu", "module", "previous"] as const)(
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
	it("admits conditional session-scope links with no otherwise, and refuses a postSubmit beside them", () => {
		const doc = candidate(linkedBase(), (d) => {
			d.forms[a].formLinks = [
				{
					...link(b),
					condition: eq(
						{
							kind: "session-user",
							field: "username",
							source: "worker-record",
						},
						literal("reviewer"),
					),
				},
			];
		});
		assertAdmittedDoc(doc);
		const beside = structuredClone(doc);
		beside.forms[a].postSubmit = "app_home";
		findings(beside, ["POST_SUBMIT_BESIDE_FORM_LINKS"]);
		const otherwise = structuredClone(doc);
		otherwise.forms[a].otherwise = {
			kind: "destination",
			destination: "module",
		};
		assertAdmittedDoc(otherwise);
	});
	it("admits several destinations that each run every time", () => {
		assertAdmittedDoc(
			candidate(linkedBase(), (d) => {
				d.forms[a].formLinks = [link(b), link(c, "second")];
			}),
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
	it.each([1, 2, 3])("admits a %i-form cycle", (length) => {
		const forms = [a, b, c].slice(0, length);
		const doc = candidate(linkedBase(), (d) => {
			forms.forEach((uuid, index) => {
				d.forms[uuid].formLinks = [
					length === 1
						? { uuid: testUuid("cycle-0"), target: { type: "this-form" } }
						: link(forms[(index + 1) % length], `cycle-${index}`),
				];
			});
		});
		assertAdmittedDoc(doc);
	});
	it("refuses a form target naming the source form", () => {
		findings(
			candidate(linkedBase(), (d) => {
				d.forms[a].formLinks = [link(a, "self")];
			}),
			["FORM_LINK_SELF_REFERENCE"],
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
					[slot]:
						slot === "calculate" || slot === "default_value"
							? term({
									kind: "form-case",
									caseType: "patient",
									property: "age",
								})
							: gt(
									{ kind: "form-case", caseType: "patient", property: "age" },
									literal(0),
								),
				});
			});
			findings(doc, ["CASE_HASHTAG_ON_CREATE_FORM"]);
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
				fieldPatch(d, {
					default_value: term({
						kind: "form-case",
						caseType: "patient",
						property: "case_id_extra",
					}),
				});
			}),
			["CASE_HASHTAG_ON_CREATE_FORM"],
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
			["CASE_HASHTAG_ON_CREATE_FORM"],
		);
	});
	it.each([
		"item-list:lookup",
		"commcare:reports",
		"commcare-reports:abc",
		"missing",
	])(
		"refuses an unavailable instance %s before it enters a stored expression",
		(instance) => {
			const doc = survey([{ ...plain, kind: "hidden", calculate: "1" }]);
			const result = parseFormExpression(`instance('${instance}')/items/item`, {
				doc,
				slot: { entity: "field", uuid: q, slot: "calculate" },
				lookup: new Map(),
			});
			expect(result.ok).toBe(false);
			if (result.ok)
				throw new Error("Unavailable source entered the expression model");
			expect(result.issues).toHaveLength(1);
			expect(result.issues[0]).toMatchObject({ code: "instance-unknown" });
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
				["_lesson", "CONNECT_ID_INVALID_FORMAT"],
				["XMLquiz", "CONNECT_ID_INVALID_FORMAT"],
				["meta", "CONNECT_ID_INVALID_FORMAT"],
				["task", "CONNECT_ID_INVALID_FORMAT"],
				["deliver", "CONNECT_ID_INVALID_FORMAT"],
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
	/* A Connect block's wrapper and the form's top-level fields are children
	 * of one data root, so the two kinds share one set of names there. */
	it("refuses a top-level field named like its form's Connect block, offering a free name", () => {
		expect(
			findings(
				candidate(connect("deliver"), (d) => {
					d.fields[q].id = "visit";
				}),
				["FIELD_ID_NAMES_CONNECT_BLOCK"],
			),
		).toMatchObject([
			{
				location: { fieldUuid: q, fieldId: "visit" },
				details: { suggestedId: "visit_2" },
			},
		]);
		assertAdmittedDoc(
			candidate(connect("deliver"), (d) => {
				d.fields[q].id = "visit_2";
			}),
		);
	});
	it("offers a refused field id or Connect id a name neither kind holds at the root", () => {
		expect(
			findings(
				candidate(connect("deliver"), (d) => {
					d.fields[q].id = "_visit";
				}),
				["INVALID_FIELD_ID"],
			),
		).toMatchObject([{ details: { suggestedId: "visit_2" } }]);
		expect(
			findings(
				candidate(connect("deliver"), (d) => {
					d.fields[q].id = "visit";
					d.forms[a].connect = {
						deliver_unit: { id: "_visit", name: "Visit" },
					};
				}),
				["CONNECT_ID_INVALID_FORMAT"],
			),
		).toMatchObject([{ details: { suggestedId: "visit_2" } }]);
	});
	it.each(["entity_id", "entity_name"] as const)(
		"refuses raw or fragment deliver %s and admits absent defaults",
		(slot) => {
			const base = connect("deliver", {
				deliver_unit: {
					id: "visit",
					name: "Visit",
					entity_id: concat(
						term({
							kind: "session-user",
							field: "username",
							source: "worker-record",
						}),
						term(literal("-")),
						today(),
					),
					entity_name: term({
						kind: "session-user",
						field: "username",
						source: "worker-record",
					}),
				},
			});
			assertAdmittedDoc(base);
			const form = base.forms[a];
			const config = form.connect;
			if (
				config === undefined ||
				!("deliver_unit" in config) ||
				config.deliver_unit === undefined
			)
				throw new Error("Missing deliver unit");
			const block = config.deliver_unit;
			for (const source of ["", "   ", { parts: [] }]) {
				expect(
					formSchema.safeParse({
						...form,
						connect: { deliver_unit: { ...block, [slot]: source } },
					}).success,
				).toBe(false);
			}
			assertAdmittedDoc(
				connect("deliver", { deliver_unit: { id: "visit", name: "Visit" } }),
			);
		},
	);
	it("refuses raw or fragment scores and admits the default", () => {
		const base = connect("learn", {
			assessment: { id: "quiz", user_score: term(literal(1)) },
		});
		assertAdmittedDoc(base);
		for (const source of ["", "   ", { parts: [] }]) {
			expect(
				formSchema.safeParse({
					...base.forms[a],
					connect: { assessment: { id: "quiz", user_score: source } },
				}).success,
			).toBe(false);
		}
		assertAdmittedDoc(connect("learn", { assessment: { id: "quiz" } }));
	});
});

describe("count source admission", () => {
	const countFields = (kind: FieldSpec["kind"], count: string): FieldSpec[] => [
		{ id: "size", kind },
		{
			id: "rows",
			kind: "repeat",
			repeat_mode: "count_bound",
			repeat_count: count,
			children: [{ id: "note", kind: "text" }],
		},
	];
	const countFindings = (kind: FieldSpec["kind"], count: string) =>
		runValidation(
			survey(countFields(kind, count)),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter((e) => e.code === "REPEAT_COUNT_TYPE");

	it.each([
		{ kind: "decimal", words: "a decimal number" },
		{ kind: "text", words: "text" },
	] as const)(
		"refuses a $kind count, read directly or through number()",
		({ kind, words }) => {
			for (const [count, countWords] of [
				["#form/size", words],
				["../size", words],
				// number() of any value is a decimal number to the checker.
				["number(#form/size)", "a decimal number"],
			]) {
				const errors = countFindings(kind, count);
				expect(errors).toHaveLength(1);
				expect(errors[0]?.location).toMatchObject({
					fieldId: "rows",
					field: "repeat_count",
				});
				expect(userFacingError(errors[0] as ValidationError)).toBe(
					`The count for "rows" can be ${countWords}, and a repeat needs a whole number of rows. CommCare stops the form at a count that isn't whole. You can wrap the count in int(...) to keep its whole part.`,
				);
			}
		},
	);

	it.each(["decimal", "text"] as const)(
		"admits a %s count wrapped in int()",
		(kind) => {
			expect(
				runValidation(
					survey(countFields(kind, "int(number(#form/size))")),
					LOOKUP_CONTEXT_UNAVAILABLE,
				),
			).toEqual([]);
		},
	);

	it("admits an integer count read directly, relatively or through number()", () => {
		for (const count of [
			"#form/size",
			"number(#form/size)",
			"../size",
			"#form/size + 1",
		])
			expect(
				runValidation(
					survey(countFields("int", count)),
					LOOKUP_CONTEXT_UNAVAILABLE,
				),
			).toEqual([]);
	});
});
