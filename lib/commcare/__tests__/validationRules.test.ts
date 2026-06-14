import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { buildDoc, caseListConfig, f, xp } from "../../__tests__/docHelpers";
import { errorIdentity, evaluateBoundary } from "../validator/gate";
import { runValidation } from "../validator/runner";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Minimal registration-form doc with a "patient" case type, a single
 * `case_name` field mapped to the module's case type, and the default
 * case list column. Used as the baseline for rules that need a
 * well-formed registration form and assert on specific deviations.
 */
function minDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Form",
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
}

/** A survey doc is the simplest possible fixture — one module, one survey form, arbitrary fields. */
function surveyDoc(fields: Parameters<typeof f>[0][]): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "M",
				forms: [{ name: "F", type: "survey", fields }],
			},
		],
	});
}

/** Mutate a doc in-place to simulate the builder/SA applying an update. */
function update(
	doc: BlueprintDoc,
	mutate: (d: BlueprintDoc) => void,
): BlueprintDoc {
	return produce(doc, (draft) => mutate(draft as BlueprintDoc));
}

// ── App-level rules ────────────────────────────────────────────────

describe("app rules", () => {
	it("catches empty app name", () => {
		const doc = update(minDoc(), (d) => {
			d.appName = "";
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "EMPTY_APP_NAME")).toBe(true);
	});

	it("catches an app with no modules", () => {
		// CommCare HQ rejects a moduleless app at build time; the validator must
		// catch it at authoring time rather than let it surface as an HQ failure.
		const doc = buildDoc({ appName: "Test", modules: [] });
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "NO_MODULES")).toBe(true);
	});

	it("does not flag NO_MODULES when a module exists", () => {
		expect(runValidation(minDoc()).some((e) => e.code === "NO_MODULES")).toBe(
			false,
		);
	});

	it("allows duplicate module names — CommCare keys modules by id, not name", () => {
		// Module names are display labels in app_strings keyed by position
		// (`modules.m0`, `m1`); the suite refs menus by index id. CommCare's
		// build validator (`app_manager/helpers/validators.py`) checks
		// duplicate form xmlns but NOT duplicate module/form names. Two
		// "Surveys" menus is a valid app, so Nova must not block it.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Same",
					forms: [
						{
							name: "F1",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
				{
					name: "Same",
					forms: [
						{
							name: "F2",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		expect(runValidation(doc)).toEqual([]);
	});

	it("catches child case type missing module", () => {
		const doc = update(minDoc(), (d) => {
			d.caseTypes = [
				{ name: "patient", properties: [] },
				{ name: "visit", parent_type: "patient", properties: [] },
			];
		});
		expect(
			runValidation(doc).some((e) => e.code === "MISSING_CHILD_CASE_MODULE"),
		).toBe(true);
	});
});

// ── Module-level rules ─────────────────────────────────────────────

describe("module rules", () => {
	it("catches invalid case_type — starts with digit", () => {
		const doc = update(minDoc(), (d) => {
			const mod = d.modules[d.moduleOrder[0]];
			mod.caseType = "123_bad";
		});
		expect(
			runValidation(doc).some((e) => e.code === "INVALID_CASE_TYPE_FORMAT"),
		).toBe(true);
	});

	it("catches invalid case_type — contains spaces", () => {
		const doc = update(minDoc(), (d) => {
			d.modules[d.moduleOrder[0]].caseType = "my case";
		});
		expect(
			runValidation(doc).some((e) => e.code === "INVALID_CASE_TYPE_FORMAT"),
		).toBe(true);
	});

	it("catches invalid case_type — special characters", () => {
		const doc = update(minDoc(), (d) => {
			d.modules[d.moduleOrder[0]].caseType = "case@type!";
		});
		expect(
			runValidation(doc).some((e) => e.code === "INVALID_CASE_TYPE_FORMAT"),
		).toBe(true);
	});

	it("allows valid case_type with hyphens and underscores", () => {
		const doc = update(minDoc(), (d) => {
			d.modules[d.moduleOrder[0]].caseType = "health-check_v2";
		});
		expect(
			runValidation(doc).some((e) => e.code === "INVALID_CASE_TYPE_FORMAT"),
		).toBe(false);
	});

	it("catches case_type too long", () => {
		const doc = update(minDoc(), (d) => {
			d.modules[d.moduleOrder[0]].caseType = "a".repeat(256);
		});
		expect(
			runValidation(doc).some((e) => e.code === "CASE_TYPE_TOO_LONG"),
		).toBe(true);
	});

	it("catches missing case list columns", () => {
		const doc = update(minDoc(), (d) => {
			const mod = d.modules[d.moduleOrder[0]];
			mod.caseListConfig = undefined;
		});
		expect(
			runValidation(doc).some((e) => e.code === "MISSING_CASE_LIST_COLUMNS"),
		).toBe(true);
	});

	it("does not require columns on case_list_only modules", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [{ name: "M", caseType: "c", caseListOnly: true, forms: [] }],
			caseTypes: [{ name: "c", properties: [] }],
		});
		expect(
			runValidation(doc).some((e) => e.code === "MISSING_CASE_LIST_COLUMNS"),
		).toBe(false);
	});
});

// ── Form-level rules ───────────────────────────────────────────────

describe("form rules", () => {
	it("allows different fields saving to different case properties", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Form",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
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
		expect(
			runValidation(doc).some((e) => e.code === "DUPLICATE_CASE_PROPERTY"),
		).toBe(false);
	});

	it("catches registration form with no case properties", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Form",
							type: "registration",
							fields: [f({ kind: "text", id: "q", label: "Name" })],
						},
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		expect(
			runValidation(doc).some((e) => e.code === "REGISTRATION_NO_CASE_PROPS"),
		).toBe(true);
	});

	it("catches case property with bad format (leading digit)", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Form",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "123bad",
									label: "Bad",
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
		const errors = runValidation(doc);
		// Fires both INVALID_FIELD_ID and CASE_PROPERTY_BAD_FORMAT
		expect(errors.some((e) => e.code === "CASE_PROPERTY_BAD_FORMAT")).toBe(
			true,
		);
		expect(errors.some((e) => e.code === "INVALID_FIELD_ID")).toBe(true);
	});

	it("catches case property name too long", () => {
		const longId = "a".repeat(256);
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Form",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: longId,
									label: "Long",
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
		expect(
			runValidation(doc).some((e) => e.code === "CASE_PROPERTY_TOO_LONG"),
		).toBe(true);
	});

	it("allows case_name even though it is technically reserved", () => {
		const doc = minDoc();
		expect(
			runValidation(doc).some((e) => e.code === "RESERVED_CASE_PROPERTY"),
		).toBe(false);
	});

	it("duplicate field IDs at the same scope are caught", () => {
		const doc = surveyDoc([
			f({ kind: "text", id: "name", label: "A" }),
			f({ kind: "text", id: "name", label: "B" }),
		]);
		expect(
			runValidation(doc).some((e) => e.code === "DUPLICATE_FIELD_ID"),
		).toBe(true);
	});

	it("same field ID in different groups is allowed (different XML paths)", () => {
		const doc = surveyDoc([
			f({ kind: "text", id: "name", label: "Top-level name" }),
			f({
				kind: "group",
				id: "details",
				label: "Details",
				children: [f({ kind: "text", id: "name", label: "Nested name" })],
			}),
		]);
		expect(
			runValidation(doc).some((e) => e.code === "DUPLICATE_FIELD_ID"),
		).toBe(false);
	});

	it("duplicate field IDs within a group are caught", () => {
		const doc = surveyDoc([
			f({
				kind: "group",
				id: "grp",
				label: "G",
				children: [
					f({ kind: "text", id: "q", label: "A" }),
					f({ kind: "text", id: "q", label: "B" }),
				],
			}),
		]);
		expect(
			runValidation(doc).some((e) => e.code === "DUPLICATE_FIELD_ID"),
		).toBe(true);
	});
});

// ── Field-level (field-level) rules ─────────────────────────────

describe("field rules", () => {
	it("catches field ID starting with digit", () => {
		const errors = runValidation(
			surveyDoc([f({ kind: "text", id: "123_bad", label: "Q" })]),
		);
		expect(errors.some((e) => e.code === "INVALID_FIELD_ID")).toBe(true);
	});

	it("catches field ID with hyphens (not valid XML element name)", () => {
		const errors = runValidation(
			surveyDoc([f({ kind: "text", id: "my-field", label: "Q" })]),
		);
		expect(errors.some((e) => e.code === "INVALID_FIELD_ID")).toBe(true);
	});

	it("allows field IDs with underscores", () => {
		const errors = runValidation(
			surveyDoc([f({ kind: "text", id: "my_question", label: "Q" })]),
		);
		expect(errors.some((e) => e.code === "INVALID_FIELD_ID")).toBe(false);
	});

	it("allows field IDs starting with underscore", () => {
		const errors = runValidation(
			surveyDoc([f({ kind: "text", id: "_hidden", label: "Q" })]),
		);
		expect(errors.some((e) => e.code === "INVALID_FIELD_ID")).toBe(false);
	});

	// `__nova_` is reserved for nodes the XForm emitter synthesizes (the
	// hidden node a hoisted count_bound repeat's `jr:count` points at). An
	// authored field under that prefix could shadow a synthesized node and
	// corrupt a sibling repeat's cardinality, so the validator rejects it.
	it("rejects a field ID under the reserved __nova_ prefix", () => {
		const errors = runValidation(
			surveyDoc([f({ kind: "text", id: "__nova_count_x", label: "Q" })]),
		);
		expect(errors.some((e) => e.code === "RESERVED_FIELD_ID_PREFIX")).toBe(
			true,
		);
	});

	it("allows a single leading underscore (not the reserved prefix)", () => {
		const errors = runValidation(
			surveyDoc([f({ kind: "text", id: "_my_field", label: "Q" })]),
		);
		expect(errors.some((e) => e.code === "RESERVED_FIELD_ID_PREFIX")).toBe(
			false,
		);
	});

	// Validation (constraint + message) is a user-facing concept: the user
	// enters a value, the constraint fails, the message explains why.
	// Hidden/computed/structural fields have no such interaction — so
	// setting `validate` or `validate_msg` on them is a category error,
	// not a no-op. The rule catches it before the XForm emitter silently
	// drops it.
	it("flags validate_msg on hidden fields", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "hidden",
					id: "risk",
					calculate: "if(/data/age > 65, 'high', 'low')",
					validate_msg: "Risk must resolve",
				}),
			]),
		);
		expect(errors.some((e) => e.code === "VALIDATION_ON_NON_INPUT_KIND")).toBe(
			true,
		);
	});

	// `required` on a hidden field is unsatisfiable: the field is never shown,
	// so if its computed value resolves empty the form can't be submitted and
	// the user has no input to fix it. Vellum forbids it (DataBindOnly:
	// requiredAttr notallowed); the schema drops it and this rule backstops a
	// value reaching the doc through a lenient path. `f()` is an identity
	// builder (no strict parse), so it can stand in that pre-schema shape.
	it("flags required on hidden fields", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "hidden",
					id: "risk",
					calculate: "if(/data/age > 65, 'high', 'low')",
					required: "true()",
				}),
			]),
		);
		expect(errors.some((e) => e.code === "REQUIRED_ON_HIDDEN")).toBe(true);
	});

	it("does not flag a hidden field with no required", () => {
		const errors = runValidation(
			surveyDoc([
				f({ kind: "hidden", id: "risk", calculate: "/data/age + 1" }),
			]),
		);
		expect(errors.some((e) => e.code === "REQUIRED_ON_HIDDEN")).toBe(false);
	});

	// `calculate` is the read-only-but-looks-editable footgun on a visible
	// input — only a hidden field carries one. The schema drops `calculate`
	// from every visible kind; this rule backstops the lenient path. `f()` is
	// an identity builder, so it can stand in that pre-schema shape.
	it("flags calculate on a visible input field", () => {
		const errors = runValidation(
			surveyDoc([
				f({ kind: "text", id: "score", label: "Score", calculate: "1 + 1" }),
			]),
		);
		expect(errors.some((e) => e.code === "CALCULATE_ON_VISIBLE_INPUT")).toBe(
			true,
		);
	});

	it("does not flag a calculate on a hidden field (its legitimate home)", () => {
		const errors = runValidation(
			surveyDoc([f({ kind: "hidden", id: "score", calculate: "1 + 1" })]),
		);
		expect(errors.some((e) => e.code === "CALCULATE_ON_VISIBLE_INPUT")).toBe(
			false,
		);
	});

	it("flags validate on label fields", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "label",
					id: "section",
					label: "Section header",
					validate: ". != ''",
				}),
			]),
		);
		expect(errors.some((e) => e.code === "VALIDATION_ON_NON_INPUT_KIND")).toBe(
			true,
		);
	});

	it("flags validate on group fields", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "group",
					id: "demographics",
					label: "Demographics",
					validate_msg: "should never appear",
					children: [f({ kind: "text", id: "name", label: "Name" })],
				}),
			]),
		);
		expect(errors.some((e) => e.code === "VALIDATION_ON_NON_INPUT_KIND")).toBe(
			true,
		);
	});

	it("allows validation on input field kinds", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "int",
					id: "age",
					label: "Age",
					validate: ". > 0 and . < 150",
					validate_msg: "Age must be between 1 and 149",
				}),
			]),
		);
		expect(errors.some((e) => e.code === "VALIDATION_ON_NON_INPUT_KIND")).toBe(
			false,
		);
	});

	// `count_bound` and `query_bound` repeats carry XPath expressions
	// the wire emitter writes into JavaRosa-parsed attributes (`jr:count`,
	// the query setvalue pair). JavaRosa rejects empty input outright, so
	// an empty repeat_count or ids_query produces a CCHQ build rejection
	// with a cryptic `ASTNodeAbstractExpr` error. The validator catches
	// the configuration error here so the SA gets an actionable message
	// before upload.

	it("flags count_bound repeat with empty repeat_count", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "repeat",
					id: "visits",
					label: "Visits",
					repeat_mode: "count_bound",
					repeat_count: "",
					children: [f({ kind: "text", id: "note", label: "Note" })],
				}),
			]),
		);
		const empty = errors.filter((e) => e.code === "EMPTY_REPEAT_COUNT");
		expect(empty).toHaveLength(1);
		expect(empty[0].message).toContain("visits");
		expect(empty[0].message).toContain("repeat_count");
	});

	it("flags query_bound repeat with empty ids_query", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "repeat",
					id: "open_cases",
					label: "Open cases",
					repeat_mode: "query_bound",
					data_source: { ids_query: "" },
					children: [f({ kind: "text", id: "note", label: "Note" })],
				}),
			]),
		);
		const empty = errors.filter((e) => e.code === "EMPTY_IDS_QUERY");
		expect(empty).toHaveLength(1);
		expect(empty[0].message).toContain("open_cases");
		expect(empty[0].message).toContain("ids_query");
	});

	it("does not flag count_bound repeat with valid repeat_count", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "repeat",
					id: "visits",
					label: "Visits",
					repeat_mode: "count_bound",
					repeat_count: "5",
					children: [f({ kind: "text", id: "note", label: "Note" })],
				}),
			]),
		);
		expect(errors.some((e) => e.code === "EMPTY_REPEAT_COUNT")).toBe(false);
	});

	it("does not flag query_bound repeat with valid ids_query", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "repeat",
					id: "open_cases",
					label: "Open cases",
					repeat_mode: "query_bound",
					data_source: {
						ids_query:
							"instance('casedb')/casedb/case[@case_type='visit']/@case_id",
					},
					children: [f({ kind: "text", id: "note", label: "Note" })],
				}),
			]),
		);
		expect(errors.some((e) => e.code === "EMPTY_IDS_QUERY")).toBe(false);
	});

	it("does not flag user_controlled repeats (no XPath field)", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "repeat",
					id: "members",
					label: "Members",
					repeat_mode: "user_controlled",
					children: [f({ kind: "text", id: "name", label: "Name" })],
				}),
			]),
		);
		expect(errors.some((e) => e.code === "EMPTY_REPEAT_COUNT")).toBe(false);
		expect(errors.some((e) => e.code === "EMPTY_IDS_QUERY")).toBe(false);
	});

	// Whitespace-only inputs hit JavaRosa's parser the same as empty
	// strings — the lexer consumes the whitespace and produces zero
	// tokens, so `verifyBaseExpr` rejects with the same "Bad node"
	// error. The rule uses `.trim().length === 0` to cover this; the
	// tests pin the contract so a future refactor that drops `trim()`
	// regresses visibly.

	it("flags count_bound repeat with whitespace-only repeat_count", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "repeat",
					id: "visits",
					label: "Visits",
					repeat_mode: "count_bound",
					repeat_count: "   ",
					children: [f({ kind: "text", id: "note", label: "Note" })],
				}),
			]),
		);
		expect(errors.some((e) => e.code === "EMPTY_REPEAT_COUNT")).toBe(true);
	});

	it("flags query_bound repeat with whitespace-only ids_query", () => {
		const errors = runValidation(
			surveyDoc([
				f({
					kind: "repeat",
					id: "open_cases",
					label: "Open cases",
					repeat_mode: "query_bound",
					data_source: { ids_query: "\n\t" },
					children: [f({ kind: "text", id: "note", label: "Note" })],
				}),
			]),
		);
		expect(errors.some((e) => e.code === "EMPTY_IDS_QUERY")).toBe(true);
	});
});

// ── Fix registry ───────────────────────────────────────────────────
//
// ── Post-submit validation ────────────────────────────────────────

describe("post_submit validation", () => {
	it("accepts valid destinations without errors", () => {
		for (const dest of ["app_home", "root", "module", "previous"] as const) {
			const doc = update(minDoc(), (d) => {
				d.forms[d.formOrder[d.moduleOrder[0]][0]].postSubmit = dest;
			});
			const errors = runValidation(doc);
			expect(
				errors.filter(
					(e) =>
						e.code.startsWith("POST_SUBMIT") ||
						e.code === "INVALID_POST_SUBMIT",
				),
			).toEqual([]);
		}
	});

	it("catches invalid destination with helpful message", () => {
		const doc = update(minDoc(), (d) => {
			const formUuid = d.formOrder[d.moduleOrder[0]][0];
			// Cast through unknown because "nowhere" isn't a valid PostSubmitDestination.
			(d.forms[formUuid] as unknown as { postSubmit: string }).postSubmit =
				"nowhere";
		});
		const errors = runValidation(doc);
		const err = errors.find((e) => e.code === "INVALID_POST_SUBMIT");
		expect(err).toBeDefined();
		expect(err?.message).toContain('"nowhere"');
		expect(err?.message).toContain("app_home");
		expect(err?.message).toContain("module");
		expect(err?.message).toContain("previous");
	});

	it("errors on parent_module since parent modules are not yet supported", () => {
		const doc = update(minDoc(), (d) => {
			d.forms[d.formOrder[d.moduleOrder[0]][0]].postSubmit = "parent_module";
		});
		const errors = runValidation(doc);
		const err = errors.find(
			(e) => e.code === "POST_SUBMIT_PARENT_MODULE_UNSUPPORTED",
		);
		expect(err).toBeDefined();
		expect(err?.message).toContain("has no parent module");
		expect(err?.message).toContain('"module"');
		expect(err?.message).toContain('"previous"');
	});

	it("catches module destination on case_list_only modules", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "View Only",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "F",
							type: "survey",
							postSubmit: "module",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		const errors = runValidation(doc);
		const err = errors.find(
			(e) => e.code === "POST_SUBMIT_MODULE_CASE_LIST_ONLY",
		);
		expect(err).toBeDefined();
		expect(err?.message).toContain("case-list-only");
		expect(err?.message).toContain('"previous"');
	});

	it("does not produce errors when post_submit is absent", () => {
		const doc = minDoc();
		const errors = runValidation(doc);
		expect(
			errors.filter(
				(e) =>
					e.code.startsWith("POST_SUBMIT") || e.code === "INVALID_POST_SUBMIT",
			),
		).toEqual([]);
	});
});

// ── Form link validation ──────────────────────────────────────────

describe("form_links validation", () => {
	it("catches empty form_links array", () => {
		const doc = update(
			surveyDoc([f({ kind: "text", id: "q", label: "Q" })]),
			(d) => {
				d.forms[d.formOrder[d.moduleOrder[0]][0]].formLinks = [];
			},
		);
		const errors = runValidation(doc);
		expect(errors.find((e) => e.code === "FORM_LINK_EMPTY")).toBeDefined();
	});

	it("catches non-existent target module", () => {
		const doc = update(
			surveyDoc([f({ kind: "text", id: "q", label: "Q" })]),
			(d) => {
				d.forms[d.formOrder[d.moduleOrder[0]][0]].formLinks = [
					{
						target: {
							type: "form",
							moduleUuid: asUuid("ghost-module"),
							formUuid: asUuid("ghost-form"),
						},
					},
				];
			},
		);
		const errors = runValidation(doc);
		const err = errors.find((e) => e.code === "FORM_LINK_TARGET_NOT_FOUND");
		expect(err).toBeDefined();
		expect(err?.message).toContain("ghost-module");
	});

	it("catches non-existent target form", () => {
		const doc = surveyDoc([f({ kind: "text", id: "q", label: "Q" })]);
		const moduleUuid = doc.moduleOrder[0];
		const doc2 = update(doc, (d) => {
			d.forms[d.formOrder[moduleUuid][0]].formLinks = [
				{
					target: {
						type: "form",
						moduleUuid,
						formUuid: asUuid("nonexistent-form"),
					},
				},
			];
		});
		const errors = runValidation(doc2);
		const err = errors.find((e) => e.code === "FORM_LINK_TARGET_NOT_FOUND");
		expect(err).toBeDefined();
		expect(err?.message).toContain("nonexistent-form");
	});

	it("catches self-referencing link", () => {
		const doc = surveyDoc([f({ kind: "text", id: "q", label: "Q" })]);
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const doc2 = update(doc, (d) => {
			d.forms[formUuid].formLinks = [
				{ target: { type: "form", moduleUuid, formUuid } },
			];
		});
		const errors = runValidation(doc2);
		expect(
			errors.find((e) => e.code === "FORM_LINK_SELF_REFERENCE"),
		).toBeDefined();
	});

	it("catches conditional links without post_submit fallback", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M0",
					forms: [
						{
							name: "F0",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
						{
							name: "F1",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const [f0Uuid, f1Uuid] = doc.formOrder[moduleUuid];
		const doc2 = update(doc, (d) => {
			d.forms[f0Uuid].formLinks = [
				{
					condition: xp("x = 1"),
					target: { type: "form", moduleUuid, formUuid: f1Uuid },
				},
			];
		});
		const errors = runValidation(doc2);
		expect(
			errors.find((e) => e.code === "FORM_LINK_NO_FALLBACK"),
		).toBeDefined();
	});

	it("accepts conditional links when post_submit fallback is set", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M0",
					forms: [
						{
							name: "F0",
							type: "survey",
							postSubmit: "module",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
						{
							name: "F1",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const [f0Uuid, f1Uuid] = doc.formOrder[moduleUuid];
		const doc2 = update(doc, (d) => {
			d.forms[f0Uuid].formLinks = [
				{
					condition: xp("x = 1"),
					target: { type: "form", moduleUuid, formUuid: f1Uuid },
				},
			];
		});
		const errors = runValidation(doc2);
		expect(
			errors.find((e) => e.code === "FORM_LINK_NO_FALLBACK"),
		).toBeUndefined();
	});

	it("detects circular form links at app level", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M0",
					forms: [
						{
							name: "F0",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
						{
							name: "F1",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const [f0Uuid, f1Uuid] = doc.formOrder[moduleUuid];
		const doc2 = update(doc, (d) => {
			d.forms[f0Uuid].formLinks = [
				{ target: { type: "form", moduleUuid, formUuid: f1Uuid } },
			];
			d.forms[f1Uuid].formLinks = [
				{ target: { type: "form", moduleUuid, formUuid: f0Uuid } },
			];
		});
		const errors = runValidation(doc2);
		expect(errors.find((e) => e.code === "FORM_LINK_CIRCULAR")).toBeDefined();
	});

	it("detects a self-loop form link (A → A)", () => {
		// Form-level FORM_LINK_SELF_REFERENCE fires too — but the cycle
		// detector also catches it as a 1-form cycle, and the assertion
		// here pins that behavior so a future change to the form-level
		// rule doesn't silently unwire app-level cycle coverage of
		// self-links.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M0",
					forms: [
						{
							name: "F0",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const [f0Uuid] = doc.formOrder[moduleUuid];
		const doc2 = update(doc, (d) => {
			d.forms[f0Uuid].formLinks = [
				{ target: { type: "form", moduleUuid, formUuid: f0Uuid } },
			];
		});
		const errors = runValidation(doc2);
		expect(errors.find((e) => e.code === "FORM_LINK_CIRCULAR")).toBeDefined();
	});

	it("detects a 3-chain cycle (A → B → C → A)", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M0",
					forms: [
						{
							name: "F0",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
						{
							name: "F1",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
						{
							name: "F2",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const [f0Uuid, f1Uuid, f2Uuid] = doc.formOrder[moduleUuid];
		const doc2 = update(doc, (d) => {
			d.forms[f0Uuid].formLinks = [
				{ target: { type: "form", moduleUuid, formUuid: f1Uuid } },
			];
			d.forms[f1Uuid].formLinks = [
				{ target: { type: "form", moduleUuid, formUuid: f2Uuid } },
			];
			d.forms[f2Uuid].formLinks = [
				{ target: { type: "form", moduleUuid, formUuid: f0Uuid } },
			];
		});
		const errors = runValidation(doc2);
		expect(errors.find((e) => e.code === "FORM_LINK_CIRCULAR")).toBeDefined();
	});

	it("accepts valid form links", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M0",
					forms: [
						{
							name: "F0",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
						{
							name: "F1",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const [f0Uuid, f1Uuid] = doc.formOrder[moduleUuid];
		const doc2 = update(doc, (d) => {
			d.forms[f0Uuid].formLinks = [
				{ target: { type: "form", moduleUuid, formUuid: f1Uuid } },
			];
		});
		const errors = runValidation(doc2);
		expect(errors.filter((e) => e.code.startsWith("FORM_LINK"))).toEqual([]);
	});

	it("accepts module target links", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M0",
					forms: [
						{
							name: "F0",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
				{
					name: "M1",
					forms: [
						{
							name: "F0",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const m0 = doc.moduleOrder[0];
		const m1 = doc.moduleOrder[1];
		const f0Uuid = doc.formOrder[m0][0];
		const doc2 = update(doc, (d) => {
			d.forms[f0Uuid].formLinks = [
				{ target: { type: "module", moduleUuid: m1 } },
			];
		});
		const errors = runValidation(doc2);
		expect(errors.filter((e) => e.code.startsWith("FORM_LINK"))).toEqual([]);
	});
});

// ── Not-yet-modeled feature rejection ───────────────────────────────

describe("FIXTURE_REFERENCE_NOT_MODELED", () => {
	/**
	 * Nova's wire layer only declares `<instance>` elements for the
	 * closed set the InstanceTracker / suite accumulator know about
	 * (casedb, commcaresession, and a few remote-request-side ids).
	 * Any `instance('<id>')` reference outside that set in a field's
	 * XPath surface would compile to a form whose `<instance>` block is
	 * missing the matching declaration, surfaced on device as "A part
	 * of your application is invalid." The validator rejects this at
	 * authoring time so the user sees the error in the editor.
	 */

	function surveyWithFieldCalculate(expr: string): BlueprintDoc {
		// A `calculate` lives on the computed (`hidden`) kind — visible inputs
		// like `text` don't carry one — so the instance-reference rule under
		// test is exercised on the kind that actually reaches this surface.
		return surveyDoc([f({ kind: "hidden", id: "q1", calculate: expr })]);
	}

	it("rejects instance('item-list:lookup') in a calculate", () => {
		const errors = runValidation(
			surveyWithFieldCalculate("instance('item-list:countries')/list/item/id"),
		);
		const fixture = errors.find(
			(e) => e.code === "FIXTURE_REFERENCE_NOT_MODELED",
		);
		expect(fixture).toBeDefined();
		expect(fixture?.message).toContain("item-list:countries");
		expect(fixture?.message).toContain("lookup-table");
	});

	it("rejects instance('commcare:reports') in a calculate", () => {
		const errors = runValidation(
			surveyWithFieldCalculate("instance('commcare:reports')/foo"),
		);
		expect(errors.some((e) => e.code === "FIXTURE_REFERENCE_NOT_MODELED")).toBe(
			true,
		);
	});

	it("rejects instance('commcare-reports:abc') in a calculate", () => {
		const errors = runValidation(
			surveyWithFieldCalculate("instance('commcare-reports:abc')/x"),
		);
		expect(errors.some((e) => e.code === "FIXTURE_REFERENCE_NOT_MODELED")).toBe(
			true,
		);
	});

	for (const surface of ["relevant", "validate", "default_value", "required"]) {
		it(`rejects an unmodeled fixture in a field's ${surface}`, () => {
			const doc = surveyDoc([
				f({
					kind: "text",
					id: "q1",
					label: "Q",
					[surface]: "instance('item-list:colors')/list/item/id",
				} as Parameters<typeof f>[0]),
			]);
			expect(
				runValidation(doc).some(
					(e) => e.code === "FIXTURE_REFERENCE_NOT_MODELED",
				),
			).toBe(true);
		});
	}

	it("allows instance('casedb') — Nova models case data", () => {
		const errors = runValidation(
			surveyWithFieldCalculate(
				"instance('casedb')/casedb/case[@case_type='x']/foo",
			),
		);
		expect(errors.some((e) => e.code === "FIXTURE_REFERENCE_NOT_MODELED")).toBe(
			false,
		);
	});

	it("allows instance('commcaresession') — Nova models session data", () => {
		const errors = runValidation(
			surveyWithFieldCalculate(
				"instance('commcaresession')/session/context/userid",
			),
		);
		expect(errors.some((e) => e.code === "FIXTURE_REFERENCE_NOT_MODELED")).toBe(
			false,
		);
	});

	it("allows fields with no XPath surface containing an instance ref", () => {
		const errors = runValidation(
			surveyDoc([f({ kind: "text", id: "q1", label: "Q" })]),
		);
		expect(errors.some((e) => e.code === "FIXTURE_REFERENCE_NOT_MODELED")).toBe(
			false,
		);
	});
});

describe("PRIMARY_CASE_FIELD_IN_REPEAT", () => {
	/**
	 * A primary case field (one whose `case_property_on` equals the
	 * module's case type) placed inside a repeat is structurally
	 * invalid. Vellum + CCHQ enforce the same invariant upstream; Nova
	 * mirrors at edit time so the error lands in the editor, not at
	 * compile time.
	 */

	function withPrimaryFieldInRepeat(
		repeat_mode: "user_controlled" | "count_bound" | "query_bound",
	) {
		// One primary-case field inside a repeat. Per-mode variants pin the
		// rule firing across every repeat shape.
		const repeatChildren = [
			f({
				kind: "text",
				id: "extra_property",
				label: "Extra primary property",
				case_property_on: "parent",
			}),
		];
		const repeatField =
			repeat_mode === "count_bound"
				? f({
						kind: "repeat",
						id: "items",
						label: "Items",
						repeat_mode,
						repeat_count: "3",
						children: repeatChildren,
					})
				: repeat_mode === "query_bound"
					? f({
							kind: "repeat",
							id: "items",
							label: "Items",
							repeat_mode,
							data_source: {
								ids_query:
									"instance('casedb')/casedb/case[@case_type='other']/@case_id",
							},
							children: repeatChildren,
						})
					: f({
							kind: "repeat",
							id: "items",
							label: "Items",
							repeat_mode,
							children: repeatChildren,
						});
		return buildDoc({
			appName: "T",
			modules: [
				{
					name: "Parents",
					caseType: "parent",
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
									label: "Parent name",
									case_property_on: "parent",
								}),
								repeatField,
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "parent",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
	}

	for (const mode of [
		"user_controlled",
		"count_bound",
		"query_bound",
	] as const) {
		it(`fires on a primary case field inside a ${mode} repeat`, () => {
			const doc = withPrimaryFieldInRepeat(mode);
			const errors = runValidation(doc);
			const offender = errors.find(
				(e) => e.code === "PRIMARY_CASE_FIELD_IN_REPEAT",
			);
			expect(offender).toBeDefined();
			expect(offender?.message).toContain("extra_property");
			expect(offender?.message).toContain("items");
			expect(offender?.message).toContain("parent");
		});
	}

	it("does not fire on a primary case field at the form root", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Parents",
					caseType: "parent",
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
									label: "Parent name",
									case_property_on: "parent",
								}),
								f({
									kind: "text",
									id: "extra_property",
									label: "Extra primary property",
									case_property_on: "parent",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "parent",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "extra_property", label: "Extra" },
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "PRIMARY_CASE_FIELD_IN_REPEAT")).toBe(
			false,
		);
	});

	it("does not fire on a survey form (case mappings are ignored there)", () => {
		// A survey form carries no case actions — deriveCaseConfig returns {}
		// for it, so a `case_property_on` annotation never becomes a case
		// property. Flagging a survey field would be a false positive.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Parents",
					caseType: "parent",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "items",
									label: "Items",
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "note",
											label: "Note",
											// Module's own case type, inside a repeat — would fire
											// the rule on a non-survey form, but survey ignores it.
											case_property_on: "parent",
										}),
									],
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{ name: "parent", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "PRIMARY_CASE_FIELD_IN_REPEAT")).toBe(
			false,
		);
	});

	it("does not fire on a cross-case-type field inside a repeat (subcase shape)", () => {
		// `case_property_on != mod.caseType` is the supported subcase-creation
		// shape (one new child case per iteration) — out of scope for this
		// rule. The splice algorithm in `xform/caseBlocks.ts::addCaseBlocks`
		// handles it; `CHILD_CASE_NO_NAME_FIELD` guards the bucket-must-have-a-
		// case_name invariant.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Parents",
					caseType: "parent",
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
									label: "Parent name",
									case_property_on: "parent",
								}),
								f({
									kind: "repeat",
									id: "children",
									label: "Children",
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "child_name",
											label: "Child name",
											case_property_on: "child",
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
					name: "parent",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "child_name", label: "Name" }],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "PRIMARY_CASE_FIELD_IN_REPEAT")).toBe(
			false,
		);
	});
});

describe("CHILD_CASE_NO_NAME_FIELD", () => {
	/**
	 * Every derived child-case bucket needs a field id'd `case_name` so
	 * the new case has a display name. The bucket key is
	 * `(case_type, repeat_ancestor)`, so a primary form authoring two
	 * repeats targeting the same child case type produces two buckets,
	 * each independently required to have its own `case_name` field.
	 */
	it("fires when a non-repeat child bucket has no `case_name` field", () => {
		// One root-level subcase whose only field is NOT `case_name` — the
		// bucket has no name source. The new derivation emits
		// `case_name_field: ""` and this rule reports against it.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Parents",
					caseType: "parent",
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
									label: "Parent name",
									case_property_on: "parent",
								}),
								f({
									kind: "text",
									id: "child_label",
									label: "Child label",
									case_property_on: "child",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "parent",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "child_label", label: "Label" }],
				},
			],
		});
		const errors = runValidation(doc);
		const offender = errors.find((e) => e.code === "CHILD_CASE_NO_NAME_FIELD");
		expect(offender).toBeDefined();
		expect(offender?.message).toContain("child");
	});

	/**
	 * The validator message + `repeatId` payload cite the bare repeat field id
	 * the author wrote (`kids`), NOT the wire-format XPath
	 * (`/data/family/kids/item`). Authoring-layer surfaces speak the authoring
	 * vocabulary; wire XPath leaks `/item` + the full data-tree path that the
	 * author has no reason to know about. Regression pin: the round-3 fix
	 * switched `DerivedChildCase.repeat_context` from bare id to XPath; the
	 * paired `repeat_ancestor_id` slot preserves the authoring-voice form.
	 */
	it("cites the bare repeat field id in the message + repeatId payload, not the wire XPath", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Families",
					caseType: "family",
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
									label: "Family name",
									case_property_on: "family",
								}),
								f({
									kind: "repeat",
									id: "kids",
									label: "Children",
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "kid_age",
											label: "Age",
											case_property_on: "child",
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
					name: "family",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "kid_age", label: "Age" }],
				},
			],
		});
		const errors = runValidation(doc);
		const offender = errors.find((e) => e.code === "CHILD_CASE_NO_NAME_FIELD");
		expect(offender).toBeDefined();
		expect(offender?.message).toContain('"kids"');
		expect(offender?.message).not.toMatch(/\/data\/kids/);
		expect(offender?.details?.repeatId).toBe("kids");
	});

	it("does not fire when the child bucket includes a `case_name` field", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Parents",
					caseType: "parent",
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
									label: "Parent name",
									case_property_on: "parent",
								}),
								f({
									kind: "group",
									id: "child_section",
									label: "Child",
									children: [
										f({
											kind: "text",
											id: "case_name",
											label: "Child name",
											case_property_on: "child",
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
					name: "parent",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CHILD_CASE_NO_NAME_FIELD")).toBe(
			false,
		);
	});

	it("does not fire on forms with no subcases", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Parents",
					caseType: "parent",
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
									label: "Parent name",
									case_property_on: "parent",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "parent",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CHILD_CASE_NO_NAME_FIELD")).toBe(
			false,
		);
	});
});

describe("CCHQ-only features stay unauthorable via the strict schema", () => {
	/**
	 * The plan called for explicit NOT_MODELED rules for usercase,
	 * parent_select (authoring), put_in_root, case_list_form, schedule.
	 * Each of those fields is not present on Nova's `formSchema` /
	 * `moduleSchema` — both schemas are declared `.strict()`, so Zod
	 * rejects unknown keys at the document-parse boundary, which runs
	 * before the validator. The tests below lock the contract: if any
	 * of those keys silently lands on a doc, the parser throws — no
	 * separate validator rule needed.
	 *
	 * If a future schema change exposes these fields to authoring,
	 * THESE TESTS START PASSING (the strict schema no longer rejects),
	 * which is the cue to add the matching authoring-layer rule. Do
	 * not weaken the strict schema without adding the matching
	 * rejection rule alongside.
	 */

	const expectStrictReject = async (
		schemaName: "moduleSchema" | "formSchema",
		extra: Record<string, unknown>,
	) => {
		const { moduleSchema, formSchema } = await import("@/lib/domain");
		const schema = schemaName === "moduleSchema" ? moduleSchema : formSchema;
		const base =
			schemaName === "moduleSchema"
				? {
						uuid: asUuid("00000000000000000000000000000001"),
						id: "m",
						name: "M",
					}
				: {
						uuid: asUuid("00000000000000000000000000000002"),
						id: "f",
						name: "F",
						type: "survey",
					};
		const result = schema.safeParse({ ...base, ...extra });
		expect(result.success).toBe(false);
	};

	it("module schema rejects put_in_root: true", async () => {
		await expectStrictReject("moduleSchema", { put_in_root: true });
	});
	it("module schema rejects case_list_form", async () => {
		await expectStrictReject("moduleSchema", {
			case_list_form: { form_id: "x" },
		});
	});
	it("module schema rejects schedule config", async () => {
		await expectStrictReject("moduleSchema", { schedule: { phases: [] } });
	});
	it("module schema rejects authored parent_select", async () => {
		// Nova DERIVES parent_select via case-type parent_type in the
		// expander; users cannot author it directly. The strict schema
		// enforces this — parent_select is not a Module field.
		await expectStrictReject("moduleSchema", {
			parent_select: { active: true },
		});
	});
	it("form schema rejects usercase actions", async () => {
		await expectStrictReject("formSchema", {
			usercase_update: { update: { x: "y" } },
		});
		await expectStrictReject("formSchema", {
			usercase_preload: { preload: { y: "z" } },
		});
	});
});

// ── Case-hashtag on case-create form ────────────────────────────────

describe("CASE_HASHTAG_ON_CREATE_FORM", () => {
	/**
	 * On a registration form, the case being created doesn't exist in
	 * `casedb` yet, so `#case/<X>` references can't resolve at form-init.
	 * The validator rejects them at authoring time so the user gets the
	 * error in the editor instead of at compile-time after they hit
	 * "Generate App". `#case/case_id` is the one exception — the
	 * form-context-aware expander rewrites it to `/data/case/@case_id`
	 * (populated by the case-management scaffolding's setvalue chain).
	 */

	/** Reusable registration-form fixture with one stringified XPath surface. */
	function registrationWithSurface(spec: {
		kind?: "calculate" | "relevant" | "validate" | "default_value" | "required";
		expr: string;
	}): BlueprintDoc {
		const surface = spec.kind ?? "calculate";
		// The case-name source is always a visible text input — a registration
		// form needs one. The scanned surface rides whichever kind actually
		// carries it: `calculate` only lives on the computed `hidden` kind, so
		// it gets its own hidden field; every other surface (relevant /
		// validate / default_value / required) is valid on the visible input
		// and is stamped there directly.
		const caseNameField: Parameters<typeof f>[0] = {
			kind: "text",
			id: "case_name",
			label: "Name",
			case_property_on: "patient",
		};
		const fields: Parameters<typeof f>[0][] = [caseNameField];
		if (surface === "calculate") {
			fields.push({ kind: "hidden", id: "computed", calculate: spec.expr });
		} else {
			(caseNameField as Record<string, unknown>)[surface] = spec.expr;
		}
		return buildDoc({
			appName: "T",
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
							fields,
						},
					],
				},
			],
			caseTypes: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		});
	}

	it("rejects #case/<other> on a registration form's calculate", () => {
		const doc = registrationWithSurface({
			kind: "calculate",
			expr: "#case/age + 1",
		});
		const errors = runValidation(doc);
		const offender = errors.find(
			(e) => e.code === "CASE_HASHTAG_ON_CREATE_FORM",
		);
		expect(offender).toBeDefined();
		expect(offender?.message).toContain("#case/age");
		expect(offender?.message).toContain("#form/<question_id>");
	});

	for (const surface of [
		"relevant",
		"validate",
		"default_value",
		"required",
	] as const) {
		it(`rejects #case/<other> in field.${surface}`, () => {
			const doc = registrationWithSurface({
				kind: surface,
				expr: "#case/total_visits",
			});
			const errors = runValidation(doc);
			expect(errors.some((e) => e.code === "CASE_HASHTAG_ON_CREATE_FORM")).toBe(
				true,
			);
		});
	}

	it("allows #case/case_id on a registration form (rewritten to /data/case/@case_id)", () => {
		const doc = registrationWithSurface({
			kind: "calculate",
			expr: "#case/case_id",
		});
		const errors = runValidation(doc);
		expect(
			errors.filter((e) => e.code === "CASE_HASHTAG_ON_CREATE_FORM"),
		).toEqual([]);
	});

	it("treats #case/case_id_x as an invalid reference (not a prefix match for case_id)", () => {
		// The Lezer parser matches on segment boundary — a segment named
		// `case_id_x` is NOT the same as `case_id`, so it must be flagged.
		const doc = registrationWithSurface({
			kind: "calculate",
			expr: "#case/case_id_x",
		});
		const errors = runValidation(doc);
		const offender = errors.find(
			(e) => e.code === "CASE_HASHTAG_ON_CREATE_FORM",
		);
		expect(offender?.message).toContain("#case/case_id_x");
	});

	it("does not flag #case/<X> on a followup form (case is loaded there)", () => {
		const doc = buildDoc({
			appName: "T",
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
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
						{
							name: "Followup",
							type: "followup",
							fields: [
								// A computed field carries `calculate`, so it's the
								// `hidden` kind (visible inputs don't carry one).
								f({
									kind: "hidden",
									id: "next_age",
									calculate: "#case/age + 1",
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
		const errors = runValidation(doc);
		expect(
			errors.filter((e) => e.code === "CASE_HASHTAG_ON_CREATE_FORM"),
		).toEqual([]);
	});

	it("rejects #case/<other> inside a label's inline hashtag", () => {
		// Labels lower to `<output value=...>` at emit; the inline
		// hashtag is XPath-evaluated the same way an expression surface is.
		const doc = registrationWithSurface({
			kind: "calculate",
			expr: "1 + 1",
		});
		// Add a label with a `#case/` reference on the same field.
		const docWithLabel = update(doc, (d) => {
			const field = Object.values(d.fields)[0] as Record<string, unknown>;
			field.label = "Age: #case/age";
		});
		const errors = runValidation(docWithLabel);
		expect(errors.some((e) => e.code === "CASE_HASHTAG_ON_CREATE_FORM")).toBe(
			true,
		);
	});
});

// ── Prose case-ref validation (deep validator) ──────────────────────

describe("prose case-ref validation", () => {
	/**
	 * Followup-form fixture over a "mother" case type, with one read-only
	 * field whose chosen prose surface carries the supplied text. A followup
	 * loads the case, so the per-type accept map exposes mother's full
	 * property set.
	 */
	function followupWithProse(spec: {
		surface: "label" | "validate_msg";
		text: string;
	}): BlueprintDoc {
		const field: Parameters<typeof f>[0] = {
			kind: "text",
			id: "note",
			label: "Note",
		};
		(field as Record<string, unknown>)[spec.surface] = spec.text;
		return buildDoc({
			appName: "T",
			modules: [
				{
					name: "M",
					caseType: "mother",
					caseListConfig: caseListConfig([
						{ field: "household_code", header: "Code" },
					]),
					forms: [{ name: "Visit", type: "followup", fields: [field] }],
				},
			],
			caseTypes: [
				{
					name: "mother",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "household_code", label: "Household code" },
					],
				},
			],
		});
	}

	it("flags a bad PROPERTY on a reachable type (#mother/typoprop)", () => {
		// mother IS reachable, so the emitter lowers this to `<output>` — but
		// `typoprop` doesn't exist on mother, so it resolves to empty at runtime.
		// A real authoring typo: flag it.
		const doc = followupWithProse({
			surface: "label",
			text: "Code: #mother/typoprop",
		});
		const errors = runValidation(doc);
		const offender = errors.find(
			(e) =>
				e.code === "INVALID_CASE_REF" && e.message.includes("#mother/typoprop"),
		);
		expect(offender).toBeDefined();
		expect(offender?.message).toContain("has no property");
		// Reported on the field's label surface.
		expect(offender?.location.field).toBe("label");
	});

	it("flags a bad property in a validate_msg too", () => {
		const doc = followupWithProse({
			surface: "validate_msg",
			text: "Must match #mother/typoprop",
		});
		const errors = runValidation(doc);
		expect(
			errors.some(
				(e) =>
					e.code === "INVALID_CASE_REF" &&
					e.message.includes("#mother/typoprop"),
			),
		).toBe(true);
	});

	it("accepts a valid per-type ref in a label (#mother/household_code)", () => {
		const doc = followupWithProse({
			surface: "label",
			text: "Code: #mother/household_code",
		});
		const errors = runValidation(doc);
		expect(errors.filter((e) => e.code === "INVALID_CASE_REF")).toEqual([]);
	});

	// The emitter (`xform/builder.ts::buildLabelNodes`) leaves an UNRESOLVED
	// prose hashtag as literal text with no error. The validator must match that
	// leniency: in prose, a namespace that isn't a reachable case type is
	// innocent — NOT a case ref to flag.
	for (const text of [
		"See #N/A here", // innocent prose token, not a case type
		"Priority: #priority/high", // not a case type this form knows
		"Typo: #mothre/code", // misspelled type name — left literal by the emitter
		"Child: #child/name", // child type, created fresh, never loaded
		"Hello #case/case_name", // transitional #case/ — the wire still resolves it
	]) {
		it(`leaves unresolved prose untouched: "${text}"`, () => {
			const doc = followupWithProse({ surface: "label", text });
			const errors = runValidation(doc);
			expect(errors.filter((e) => e.code === "INVALID_CASE_REF")).toEqual([]);
		});
	}

	it("flags ONLY the bad-property token among mixed prose", () => {
		// `#N/A` is innocent prose, `#case/case_name` resolves on the wire, but
		// `#mother/typoprop` is a reachable type with a bogus property.
		const doc = followupWithProse({
			surface: "label",
			text: "See #N/A and #case/case_name and #mother/typoprop",
		});
		const errors = runValidation(doc);
		const caseRefErrors = errors.filter((e) => e.code === "INVALID_CASE_REF");
		expect(caseRefErrors).toHaveLength(1);
		expect(caseRefErrors[0].message).toContain("#mother/typoprop");
	});
});

// ── Reserved case-type name (namespace collision) ───────────────────

describe("RESERVED_CASE_TYPE_NAME", () => {
	/** Registration-form fixture over a case type with the given name. */
	function appWithCaseType(name: string): BlueprintDoc {
		return buildDoc({
			appName: "T",
			modules: [
				{
					name: "M",
					caseType: name,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: name,
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name, properties: [{ name: "case_name", label: "Name" }] }],
		});
	}

	it("rejects a case type named 'user' with the collision message", () => {
		const errors = runValidation(appWithCaseType("user"));
		const offender = errors.find((e) => e.code === "RESERVED_CASE_TYPE_NAME");
		expect(offender).toBeDefined();
		expect(offender?.message).toContain("#user/");
		expect(offender?.message).toContain("reserved reference namespace");
		// Reported once even though "user" appears on the module AND the catalog.
		expect(
			errors.filter((e) => e.code === "RESERVED_CASE_TYPE_NAME"),
		).toHaveLength(1);
	});

	it("rejects 'case', 'form', and 'parent' too", () => {
		for (const name of ["case", "form", "parent"]) {
			const errors = runValidation(appWithCaseType(name));
			expect(errors.some((e) => e.code === "RESERVED_CASE_TYPE_NAME")).toBe(
				true,
			);
		}
	});

	it("is case-insensitive (rejects 'Parent')", () => {
		const errors = runValidation(appWithCaseType("Parent"));
		expect(errors.some((e) => e.code === "RESERVED_CASE_TYPE_NAME")).toBe(true);
	});

	it("leaves a project-specific case type alone", () => {
		const errors = runValidation(appWithCaseType("user_record"));
		expect(errors.some((e) => e.code === "RESERVED_CASE_TYPE_NAME")).toBe(
			false,
		);
	});
});

// ── Connect rules ──────────────────────────────────────────────────

describe("connect rules", () => {
	/* Build a minimal Connect-typed app fixture with one survey form and
	 * either an explicit per-form connect block or none at all. Survey
	 * is the simplest form type — no case-type plumbing required, so the
	 * fixture isolates the Connect rules from unrelated registration /
	 * close-form gates. */
	function connectDoc(spec: {
		connectType: "learn" | "deliver";
		formConnect?: BlueprintDoc["forms"][string]["connect"];
	}): BlueprintDoc {
		return buildDoc({
			appName: "Connect App",
			connectType: spec.connectType,
			modules: [
				{
					name: "Main",
					forms: [
						{
							name: "First Form",
							type: "survey",
							fields: [f({ kind: "text", id: "q1", label: "Q" })],
							...(spec.formConnect !== undefined && {
								connect: spec.formConnect,
							}),
						},
					],
				},
			],
		});
	}

	/* A connect block marks that a form PARTICIPATES in Connect; a form
	 * without one is auxiliary, which is a legal wire state — Connect's
	 * ingestion (commcare_connect/opportunity/app_xml.py::extract_modules /
	 * ::extract_deliver_unit / ::extract_task_unit) scans per form and
	 * silently skips blockless forms. What an app cannot survive is ZERO
	 * participation: learn progress and payment key on the ingested rows,
	 * so an app contributing none of its mode's blocks can never progress
	 * or pay. That floor is the app-scoped rule under test here. */

	it("flags a Connect app whose forms ALL lack blocks — zero participation — once, app-scoped", () => {
		const doc = connectDoc({ connectType: "deliver" });
		const errors = runValidation(doc);
		const noParticipation = errors.filter(
			(e) => e.code === "CONNECT_NO_PARTICIPATING_FORMS",
		);
		expect(noParticipation).toHaveLength(1);
		expect(noParticipation[0].scope).toBe("app");
		expect(noParticipation[0].message).toContain("at least one participating");
	});

	it("guidance text differs by connectType so the SA picks the right sub-config", () => {
		/* The error message tells the SA which sub-config family makes a
		 * form participate. For a learn app that's learn_module and/or
		 * assessment; for a deliver app deliver_unit and/or task. The two
		 * messages must be distinguishable on `connectType` so the SA's
		 * prompt doesn't have to fall back to inferring from the app's
		 * name. */
		const learnDoc = connectDoc({ connectType: "learn" });
		const deliverDoc = connectDoc({ connectType: "deliver" });
		const learnMsg = runValidation(learnDoc).find(
			(e) => e.code === "CONNECT_NO_PARTICIPATING_FORMS",
		)?.message;
		const deliverMsg = runValidation(deliverDoc).find(
			(e) => e.code === "CONNECT_NO_PARTICIPATING_FORMS",
		)?.message;
		expect(learnMsg).toContain("learn_module");
		expect(learnMsg).toContain("assessment");
		expect(deliverMsg).toContain("deliver_unit");
		expect(deliverMsg).toContain("task");
	});

	it("accepts a mixed app — one participating form, one auxiliary form — with zero Connect findings", () => {
		const doc = buildDoc({
			appName: "Connect App",
			connectType: "deliver",
			modules: [
				{
					name: "Main",
					forms: [
						{
							name: "Paid visit",
							type: "survey",
							fields: [f({ kind: "text", id: "q1", label: "Q" })],
							connect: { deliver_unit: { id: "visit", name: "Visit" } },
						},
						{
							name: "Reference sheet",
							type: "survey",
							fields: [f({ kind: "text", id: "q2", label: "Q" })],
						},
					],
				},
			],
		});
		const errors = runValidation(doc).filter((e) =>
			e.code.startsWith("CONNECT_"),
		);
		expect(errors).toEqual([]);
	});

	it("keeps an EMPTY Connect app clean — the floor binds only once forms exist", () => {
		/* A Connect build flips `connect_type` first, on the empty app
		 * (`updateApp`), then creates participating forms with their
		 * blocks. Firing the floor on the empty app would bounce that
		 * documented first move. */
		const doc = buildDoc({ appName: "Connect App", connectType: "learn" });
		expect(
			runValidation(doc).some(
				(e) => e.code === "CONNECT_NO_PARTICIPATING_FORMS",
			),
		).toBe(false);
	});

	it("a cross-mode stray block does not count as participation", () => {
		/* A learn app's form carrying only a deliver_unit contributes
		 * nothing Connect's learn ingestion reads — the app still has zero
		 * participation, and the stray block's own malformedness is the
		 * per-form CONNECT_MISSING_LEARN finding. */
		const doc = connectDoc({
			connectType: "learn",
			formConnect: { deliver_unit: { id: "stray", name: "Stray" } },
		});
		const errors = runValidation(doc);
		expect(
			errors.some((e) => e.code === "CONNECT_NO_PARTICIPATING_FORMS"),
		).toBe(true);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_LEARN")).toBe(true);
	});

	it("does not fire the per-form sub-config rules when the whole connect block is absent", () => {
		/* A blockless form is auxiliary, not malformed — CONNECT_MISSING_*
		 * adjudicate a block that IS present. */
		const doc = connectDoc({ connectType: "deliver" });
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_DELIVER")).toBe(
			false,
		);
		expect(errors.some((e) => e.code === "CONNECT_MISSING_LEARN")).toBe(false);
	});

	it("flags an explicit empty entity_id as CONNECT_EMPTY_XPATH", () => {
		/* `entity_id` undefined is fine — the wire layer substitutes
		 * the canonical default expression. An explicit empty string
		 * is a smell: it means an upstream caller deliberately wrote a
		 * blank, and CCHQ would reject the resulting
		 * `<bind nodeset=".../entity_id" calculate=""/>` with an XPath
		 * parse error. The validator surfaces the smell so callers
		 * either set a real expression or remove the field. */
		const doc = connectDoc({
			connectType: "deliver",
			formConnect: {
				deliver_unit: {
					id: "vendor",
					name: "Visit",
					entity_id: xp(""),
					entity_name: xp("#user/username"),
				},
			},
		});
		const errors = runValidation(doc);
		const empty = errors.filter((e) => e.code === "CONNECT_EMPTY_XPATH");
		expect(empty).toHaveLength(1);
		expect(empty[0].message).toContain("entity_id");
	});

	it("flags empty entity_name as CONNECT_EMPTY_XPATH", () => {
		const doc = connectDoc({
			connectType: "deliver",
			formConnect: {
				deliver_unit: {
					id: "vendor",
					name: "Visit",
					entity_id: xp("concat(#user/username, '-', today())"),
					entity_name: xp(""),
				},
			},
		});
		const errors = runValidation(doc);
		const empty = errors.filter((e) => e.code === "CONNECT_EMPTY_XPATH");
		expect(empty).toHaveLength(1);
		expect(empty[0].message).toContain("entity_name");
	});

	it("flags empty assessment user_score as CONNECT_EMPTY_XPATH", () => {
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				assessment: { id: "quiz", user_score: xp("") },
			},
		});
		const errors = runValidation(doc);
		const empty = errors.filter((e) => e.code === "CONNECT_EMPTY_XPATH");
		expect(empty).toHaveLength(1);
		expect(empty[0].message).toContain("user_score");
	});

	it("does not flag a fully populated deliver_unit", () => {
		/* Sanity check: the rule fires only on empties. A fully
		 * populated deliver_unit should pass cleanly without spurious
		 * CONNECT_EMPTY_XPATH (or any other CONNECT_*) errors. */
		const doc = connectDoc({
			connectType: "deliver",
			formConnect: {
				deliver_unit: {
					id: "vendor",
					name: "Visit",
					entity_id: xp("concat(#user/username, '-', today())"),
					entity_name: xp("#user/username"),
				},
			},
		});
		const errors = runValidation(doc).filter((e) =>
			e.code.startsWith("CONNECT_"),
		);
		expect(errors).toEqual([]);
	});

	// ── Connect id must be a valid XML element name ──────────────────
	//
	// A connect id becomes an XML element name in the emitted XForm
	// (`<lmId vellum:role=...>`) and an `id=` attribute. CommCare reads it
	// as a slug. An id with a space, a leading digit, or other illegal
	// characters produces malformed XML. We reject such ids at validate
	// time so the user fixes them — never silently sanitize. Auto-derived
	// ids run through `toSnakeId` and are always legal, so the rule only
	// ever fires on a hand-typed / SA-supplied bad id.

	it("flags a connect id containing a space", () => {
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: {
					id: "2024 Intake",
					name: "Intake",
					description: "x",
					time_estimate: 5,
				},
			},
		});
		const errors = runValidation(doc).filter(
			(e) => e.code === "CONNECT_ID_INVALID_FORMAT",
		);
		expect(errors).toHaveLength(1);
		// Message cites the offending id and the owning form.
		expect(errors[0].message).toContain("2024 Intake");
		expect(errors[0].message).toContain("First Form");
	});

	it("flags a connect id starting with a digit", () => {
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: {
					id: "1st_module",
					name: "Intake",
					description: "x",
					time_estimate: 5,
				},
			},
		});
		const errors = runValidation(doc).filter(
			(e) => e.code === "CONNECT_ID_INVALID_FORMAT",
		);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("1st_module");
	});

	it("does not flag a valid connect id", () => {
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: {
					id: "intake_2024",
					name: "Intake",
					description: "x",
					time_estimate: 5,
				},
			},
		});
		const errors = runValidation(doc).filter(
			(e) => e.code === "CONNECT_ID_INVALID_FORMAT",
		);
		expect(errors).toEqual([]);
	});

	it("reports an id-less connect block as CONNECT_ID_MISSING, not a format error", () => {
		// Every source path leaves the id set (tool autofill, UI seed/restore)
		// and nothing downstream supplies a default — the emit resolver THROWS
		// on a missing id. So an id-less block in a stored doc is its own
		// finding here, the backstop that turns the would-be export 500 into
		// an actionable message. The format rule still skips it (there is no
		// id value to judge).
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: { name: "Intake", description: "x", time_estimate: 5 },
			},
		});
		const errors = runValidation(doc);
		expect(
			errors.filter((e) => e.code === "CONNECT_ID_INVALID_FORMAT"),
		).toEqual([]);
		const missing = errors.filter((e) => e.code === "CONNECT_ID_MISSING");
		expect(missing).toHaveLength(1);
		expect(missing[0].message).toContain("learn-module");
		expect(missing[0].message).toContain("First Form");
	});

	it("keeps two id-less blocks on one form as distinct CONNECT_ID_MISSING findings", () => {
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: { name: "Intake", description: "x", time_estimate: 5 },
				assessment: { user_score: xp("100") },
			},
		});
		const missing = runValidation(doc).filter(
			(e) => e.code === "CONNECT_ID_MISSING",
		);
		expect(missing).toHaveLength(2);
		// The identity discriminator is the sub-config kind — the gate must
		// never collapse the two into one finding.
		expect(new Set(missing.map((e) => errorIdentity(e))).size).toBe(2);
	});

	it("does not flag an id-less CROSS-MODE stray (it never emits, so its id breaks nothing)", () => {
		// Mirrors the emit resolver: only mode-matching kinds ship, so a stray
		// deliver_unit on a learn app needs no id. The learn arm still needs
		// its block — give it a valid one so the only candidate finding is the
		// stray's.
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: {
					id: "intake",
					name: "Intake",
					description: "x",
					time_estimate: 5,
				},
				deliver_unit: { name: "Stray" },
			},
		});
		expect(
			runValidation(doc).filter((e) => e.code === "CONNECT_ID_MISSING"),
		).toEqual([]);
	});

	it("surfaces the id-less block at the export boundary as a finding, never the emitter throw", () => {
		// The zero-tolerance boundary run is what every export entry point
		// consults BEFORE expansion — it must report the state the emit
		// resolver would otherwise throw on, so a stored id-less doc gets an
		// actionable rejection instead of a 500.
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: { name: "Intake", description: "x", time_estimate: 5 },
			},
		});
		const findings = evaluateBoundary(doc, new Map());
		expect(findings.some((e) => e.code === "CONNECT_ID_MISSING")).toBe(true);
	});

	it("flags bad ids on assessment, deliver_unit, and task too", () => {
		// All four connect kinds emit their id as an element name, so the
		// rule covers every kind, not just learn_module.
		const learnDoc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: {
					id: "ok_module",
					name: "M",
					description: "x",
					time_estimate: 5,
				},
				assessment: { id: "bad id", user_score: xp("100") },
			},
		});
		const deliverDoc = connectDoc({
			connectType: "deliver",
			formConnect: {
				deliver_unit: { id: "9unit", name: "Visit" },
				task: { id: "task!", name: "T", description: "x" },
			},
		});
		expect(
			runValidation(learnDoc).filter(
				(e) => e.code === "CONNECT_ID_INVALID_FORMAT",
			),
		).toHaveLength(1);
		expect(
			runValidation(deliverDoc).filter(
				(e) => e.code === "CONNECT_ID_INVALID_FORMAT",
			),
		).toHaveLength(2);
	});

	// ── Connect id must fit Connect's slug column (≤50) ──────────────
	//
	// A connect id is written into a Connect DB slug column (varchar(50)
	// for the tightest of them). An auto-derived id is capped at
	// derivation time, so this rule fires ONLY on a hand-typed / SA-
	// supplied id that's too long — we reject it so the user shortens
	// their own input rather than silently truncating what they chose.

	it("flags a hand-typed connect id longer than 50 chars", () => {
		const longId = "a".repeat(55); // valid chars, but over the 50 limit
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: {
					id: longId,
					name: "Intake",
					description: "x",
					time_estimate: 5,
				},
			},
		});
		const errors = runValidation(doc).filter(
			(e) => e.code === "CONNECT_ID_TOO_LONG",
		);
		expect(errors).toHaveLength(1);
		// Message cites the id, the owning form, and the limit.
		expect(errors[0].message).toContain("First Form");
		expect(errors[0].message).toContain("50");
	});

	it("does not flag a connect id at exactly 50 chars", () => {
		const doc = connectDoc({
			connectType: "learn",
			formConnect: {
				learn_module: {
					id: "a".repeat(50),
					name: "Intake",
					description: "x",
					time_estimate: 5,
				},
			},
		});
		const errors = runValidation(doc).filter(
			(e) => e.code === "CONNECT_ID_TOO_LONG",
		);
		expect(errors).toEqual([]);
	});

	it("flags over-length ids on assessment, deliver_unit, and task too", () => {
		const longId = "z".repeat(60);
		const learnDoc = connectDoc({
			connectType: "learn",
			formConnect: {
				assessment: { id: longId, user_score: xp("100") },
			},
		});
		const deliverDoc = connectDoc({
			connectType: "deliver",
			formConnect: {
				deliver_unit: { id: longId, name: "Visit" },
				task: { id: `${longId}_task`, name: "T", description: "x" },
			},
		});
		expect(
			runValidation(learnDoc).filter((e) => e.code === "CONNECT_ID_TOO_LONG"),
		).toHaveLength(1);
		expect(
			runValidation(deliverDoc).filter((e) => e.code === "CONNECT_ID_TOO_LONG"),
		).toHaveLength(2);
	});

	// ── Connect ids must be unique across the app ────────────────────
	//
	// Uniqueness is enforced at the source (field + tool guards) and as the
	// final gate here: a connect id keys the per-kind DB slug AND the XForm
	// element name, so two blocks sharing one collide. App-scope rule (spans
	// forms), the surface that gives the user a fixable error.

	it("flags a connect id duplicated across two forms, citing both sites", () => {
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Module A",
					forms: [
						{
							name: "Lesson A",
							type: "survey",
							connect: {
								learn_module: {
									id: "shared_slug",
									name: "A",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
				{
					name: "Module B",
					forms: [
						{
							name: "Lesson B",
							type: "survey",
							connect: {
								learn_module: {
									id: "shared_slug",
									name: "B",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
			],
		});
		const dups = runValidation(doc).filter(
			(e) => e.code === "CONNECT_ID_DUPLICATE",
		);
		expect(dups).toHaveLength(1);
		expect(dups[0].message).toContain("shared_slug");
		// Cites both sites so the user knows which to rename.
		expect(dups[0].message).toContain("Lesson A");
		expect(dups[0].message).toContain("Lesson B");
	});

	it("does not flag distinct connect ids across forms", () => {
		const doc = buildDoc({
			connectType: "learn",
			modules: [
				{
					name: "Module A",
					forms: [
						{
							name: "Lesson A",
							type: "survey",
							connect: {
								learn_module: {
									id: "lesson_a",
									name: "A",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
				{
					name: "Module B",
					forms: [
						{
							name: "Lesson B",
							type: "survey",
							connect: {
								learn_module: {
									id: "lesson_b",
									name: "B",
									description: "x",
									time_estimate: 5,
								},
							},
						},
					],
				},
			],
		});
		expect(
			runValidation(doc).filter((e) => e.code === "CONNECT_ID_DUPLICATE"),
		).toEqual([]);
	});
});
