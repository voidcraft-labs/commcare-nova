import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutations } from "@/lib/doc/mutations";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { buildDoc, f } from "../../__tests__/docHelpers";
import { FIX_REGISTRY } from "../validator/fixes";
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
				caseListColumns: [{ field: "case_name", header: "Name" }],
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

	it("catches duplicate module names", () => {
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
		expect(
			runValidation(doc).some((e) => e.code === "DUPLICATE_MODULE_NAME"),
		).toBe(true);
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
			mod.caseListColumns = undefined;
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
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
});

// ── Fix registry ───────────────────────────────────────────────────
//
// Fixes now emit Mutation[] — we apply via the production reducer and
// assert on the post-mutation doc to verify the fix moved the needle.

describe("fix registry", () => {
	it("fixes invalid field ID", () => {
		const doc = surveyDoc([f({ kind: "text", id: "123-bad", label: "Q" })]);
		const errors = runValidation(doc);
		const err = errors.find((e) => e.code === "INVALID_FIELD_ID");
		if (!err) throw new Error("expected INVALID_FIELD_ID error");
		const fix = FIX_REGISTRY.get("INVALID_FIELD_ID");
		if (!fix) throw new Error("expected INVALID_FIELD_ID fix");
		const muts = fix(err, doc);
		expect(muts.length).toBeGreaterThan(0);
		// Brace-wrap the recipe body so it returns void — `applyMutations`
		// returns `MutationResult[]`, and Immer's `ValidRecipeReturnType`
		// admits only `void | undefined | Draft<T>`. Immer mutates the
		// draft in place; the caller gets the immutable next doc.
		const next = produce(doc, (draft) => {
			applyMutations(draft, muts);
		});
		// The field should now carry the sanitized id.
		const fieldUuid =
			next.fieldOrder[next.formOrder[next.moduleOrder[0]][0]][0];
		expect(next.fields[fieldUuid].id).toBe("q_123_bad");
	});

	it("fixes NO_CASE_TYPE by deriving from module name", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Patient Records",
					forms: [
						{
							name: "F",
							type: "registration",
							fields: [f({ kind: "text", id: "case_name", label: "N" })],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		const err = errors.find((e) => e.code === "NO_CASE_TYPE");
		if (!err) throw new Error("expected NO_CASE_TYPE error");
		const fix = FIX_REGISTRY.get("NO_CASE_TYPE");
		if (!fix) throw new Error("expected NO_CASE_TYPE fix");
		const muts = fix(err, doc);
		const next = produce(doc, (draft) => {
			applyMutations(draft, muts);
		});
		expect(next.modules[next.moduleOrder[0]].caseType).toBe("patient_records");
	});

	it("fixes SELECT_NO_OPTIONS by adding defaults", () => {
		const doc = surveyDoc([f({ kind: "single_select", id: "q", label: "Q" })]);
		const errors = runValidation(doc);
		const err = errors.find((e) => e.code === "SELECT_NO_OPTIONS");
		if (!err) throw new Error("expected SELECT_NO_OPTIONS error");
		const fix = FIX_REGISTRY.get("SELECT_NO_OPTIONS");
		if (!fix) throw new Error("expected SELECT_NO_OPTIONS fix");
		const muts = fix(err, doc);
		const next = produce(doc, (draft) => {
			applyMutations(draft, muts);
		});
		const fieldUuid =
			next.fieldOrder[next.formOrder[next.moduleOrder[0]][0]][0];
		const field = next.fields[fieldUuid];
		if (field.kind !== "single_select")
			throw new Error("expected single_select");
		expect(field.options).toHaveLength(2);
	});
});

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
		expect(err?.message).toContain("doesn't have a parent module");
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
					caseListColumns: [{ field: "case_name", header: "Name" }],
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
					condition: "x = 1",
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
					condition: "x = 1",
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

	it("flags a Connect-typed app whose form has no connect block", () => {
		/* When `connect_type` lands on the app but a form has no
		 * per-form `connect`, CCHQ still accepts the upload — it has
		 * no concept of "Connect form" — but Connect's
		 * `extract_deliver_unit` / `extract_learn_module` find zero
		 * markers in the CCZ and the opportunity is unusable. Validator
		 * must catch this before upload-prep so the SA / caller can
		 * attach the missing block via `update_form`. */
		const doc = connectDoc({ connectType: "deliver" });
		const errors = runValidation(doc);
		const missingBlock = errors.filter(
			(e) => e.code === "CONNECT_FORM_MISSING_BLOCK",
		);
		expect(missingBlock).toHaveLength(1);
		expect(missingBlock[0].message).toContain("Connect deliver app");
		expect(missingBlock[0].message).toContain("First Form");
	});

	it("guidance text differs by connectType so the SA picks the right sub-config", () => {
		/* The error message tells the SA which sub-config to add. For a
		 * learn app the SA may pick learn_module, assessment, or both; for
		 * a deliver app it's deliver_unit and/or task. The two messages
		 * must be distinguishable on `connectType` so the SA's prompt
		 * doesn't have to fall back to inferring from the app's name. */
		const learnDoc = connectDoc({ connectType: "learn" });
		const deliverDoc = connectDoc({ connectType: "deliver" });
		const learnMsg = runValidation(learnDoc).find(
			(e) => e.code === "CONNECT_FORM_MISSING_BLOCK",
		)?.message;
		const deliverMsg = runValidation(deliverDoc).find(
			(e) => e.code === "CONNECT_FORM_MISSING_BLOCK",
		)?.message;
		expect(learnMsg).toContain("learn_module");
		expect(learnMsg).toContain("assessment");
		expect(deliverMsg).toContain("deliver_unit");
		expect(deliverMsg).toContain("task");
	});

	it("does not double-fire CONNECT_MISSING_DELIVER when the whole connect block is absent", () => {
		/* When `form.connect` is absent we only emit the higher-level
		 * `CONNECT_FORM_MISSING_BLOCK` error and skip downstream sub-
		 * config checks. Otherwise the SA would see two errors for the
		 * same root cause, both of which dissolve once it adds the
		 * missing block. */
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
					entity_id: "",
					entity_name: "#user/username",
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
					entity_id: "concat(#user/username, '-', today())",
					entity_name: "",
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
				assessment: { id: "quiz", user_score: "" },
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
		 * CONNECT_EMPTY_XPATH or CONNECT_FORM_MISSING_BLOCK errors. */
		const doc = connectDoc({
			connectType: "deliver",
			formConnect: {
				deliver_unit: {
					id: "vendor",
					name: "Visit",
					entity_id: "concat(#user/username, '-', today())",
					entity_name: "#user/username",
				},
			},
		});
		const errors = runValidation(doc).filter((e) =>
			e.code.startsWith("CONNECT_"),
		);
		expect(errors).toEqual([]);
	});
});
