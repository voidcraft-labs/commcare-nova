// scripts/__tests__/legacyFindingRepairs.test.ts
//
// Coverage for the legacy-finding repair core behind
// `scan-legacy-findings.ts` / `repair-legacy-findings.ts`:
//
//   1. Judgment-table totality — every gating-class validation code has
//      a recorded REPAIRABLE/PROPOSED/NEEDS-OWNER/RULE-RETIRING
//      judgment, and a repair module exists exactly for the
//      mechanical + proposed rows.
//   2. Per-class fixtures — a legacy-shaped doc carrying each
//      repairable finding goes in, the repaired doc comes out with
//      zero findings of that class and zero introduced findings
//      (the same `diffIntroduced`/`errorIdentity` oracle the commit
//      gate diffs with).
//   3. The strictly-decreasing oracle — `repairOutcomeVerdict` accepts
//      only strictly-fewer-findings-with-no-new-identities outcomes.
//   4. Idempotence — repairing a repaired doc plans nothing and
//      changes nothing.
//   5. The legacy string-shaped load — `toLegacyBlueprintView` promotes a
//      pre-AST blueprint to the boundary view, so a resolvable legacy
//      close-condition id never reads as a dangling finding.
//
// The core is pure (BlueprintDoc in → report + repaired doc out) and
// never touches the database — the validator/gate imports carry only
// type-level references to `lib/db` — so no import-boundary stub is
// needed; only the CLI wrappers read the app-state tables.

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import {
	asUuid,
	type BlueprintDoc,
	type Form,
	plainColumn,
} from "@/lib/domain";
import {
	evaluateLegacyFindings,
	gatingValidationCodes,
	guardedLegacyEvaluation,
	guardedRepairApp,
	REPAIR_JUDGMENTS,
	renderAppRepairReport,
	repairApp,
	repairableCodes,
	repairOutcomeVerdict,
	rewriteCaseMismatchedFunctionNames,
	rewriteRoundExtraArguments,
	sanitizeIdentifier,
	toLegacyBlueprintView,
} from "../lib/legacyFindingRepairs";

// ── Shared fixtures ──────────────────────────────────────────────────

/** Valid registration baseline: one patient module writing two
 *  properties — zero findings on its own. */
function minDoc(extraFields: Parameters<typeof f>[0][] = []): BlueprintDoc {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
					{ field: "village", header: "Village" },
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
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
							...extraFields,
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

function codes(findings: readonly ValidationError[]): string[] {
	return findings.map((finding) => finding.code);
}

/** Repair the doc and assert the class clears with no introductions. */
function expectRepaired(
	doc: BlueprintDoc,
	code: string,
	options: { applyProposed?: boolean } = {},
) {
	const outcome = repairApp(doc, {
		applyProposed: options.applyProposed ?? false,
	});
	expect(codes(outcome.before)).toContain(code);
	expect(codes(outcome.after)).not.toContain(code);
	expect(outcome.verdict.ok).toBe(true);
	expect(outcome.verdict.introduced).toEqual([]);
	expect(outcome.changed).toBe(true);
	return outcome;
}

// ── 1. Judgment-table totality ───────────────────────────────────────

describe("REPAIR_JUDGMENTS — total over the gating classes", () => {
	it("records a judgment for every gating-class code, and nothing else", () => {
		const gating = gatingValidationCodes();
		for (const code of gating) {
			expect(
				REPAIR_JUDGMENTS[code],
				`missing judgment for ${code}`,
			).toBeDefined();
		}
		for (const key of Object.keys(REPAIR_JUDGMENTS)) {
			expect(gating, `judgment for non-gating code ${key}`).toContain(key);
		}
	});

	it("implements a repair module exactly for the mechanical + proposed rows", () => {
		const implemented = new Set(repairableCodes());
		for (const code of gatingValidationCodes()) {
			const judgment = REPAIR_JUDGMENTS[code];
			if (!judgment) continue;
			const shouldHaveModule =
				judgment.kind === "mechanical" || judgment.kind === "proposed";
			expect(
				implemented.has(code),
				`${code}: judged ${judgment.kind} but module ${implemented.has(code) ? "exists" : "missing"}`,
			).toBe(shouldHaveModule);
		}
	});
});

// ── 2. Per-class fixture repairs ─────────────────────────────────────

describe("XPath text repairs", () => {
	it("UNQUOTED_STRING_LITERAL: quotes the bare word", () => {
		const doc = minDoc([
			f({
				kind: "text",
				id: "status",
				label: "Status",
				default_value: "approved",
			}),
		]);
		const outcome = expectRepaired(doc, "UNQUOTED_STRING_LITERAL");
		const repaired = Object.values(outcome.doc.fields).find(
			(field) => field.id === "status",
		);
		expect(repaired).toBeDefined();
		// The slot re-entered through the live parse boundary as the quoted
		// literal.
		expect(
			JSON.stringify(
				(repaired as unknown as Record<string, unknown>).default_value,
			),
		).toContain("'approved'");
	});

	it("UNKNOWN_FUNCTION: case-corrects the registry match", () => {
		const doc = minDoc([
			f({
				kind: "text",
				id: "gated",
				label: "Gated",
				relevant: "Today() > '2026-01-01'",
			}),
		]);
		expectRepaired(doc, "UNKNOWN_FUNCTION");
	});

	it("UNKNOWN_FUNCTION: a genuinely unknown function lands in `unplanned` and the rendered report", () => {
		// The class is judged mechanical, but this instance has no
		// case-insensitive registry match — the repairable-class-without-a-
		// plan shape. It must surface per instance in the report, or the
		// repair → re-scan choreography stalls on an invisible finding.
		const doc = minDoc([
			f({
				kind: "text",
				id: "gated",
				label: "Gated",
				relevant: "frobnicate(1) > 0",
			}),
		]);
		const outcome = repairApp(doc, { applyProposed: false });
		expect(codes(outcome.before)).toContain("UNKNOWN_FUNCTION");
		expect(codes(outcome.after)).toContain("UNKNOWN_FUNCTION");
		expect(outcome.applied).toEqual([]);
		expect(outcome.verdict.ok).toBe(true);
		expect(outcome.unplanned).toHaveLength(1);
		expect(outcome.unplanned[0].finding.code).toBe("UNKNOWN_FUNCTION");

		const report = renderAppRepairReport(outcome, {
			applyLabel: "WOULD REPAIR",
		});
		const rendered = report.lines.join("\n");
		expect(rendered).toContain(
			"NEEDS OWNER (no repair for this shape) UNKNOWN_FUNCTION",
		);
		expect(rendered).toContain("resolve it by hand");
		expect(report.needsOwnerCount).toBe(1);
	});

	it("WRONG_ARITY: drops round()'s extra argument", () => {
		const doc = minDoc([
			f({
				kind: "text",
				id: "gated",
				label: "Gated",
				relevant: "round(2.4, 2) = 2",
			}),
		]);
		expectRepaired(doc, "WRONG_ARITY");
	});

	it("rewriters are structural, not regex", () => {
		expect(
			rewriteCaseMismatchedFunctionNames("Today() + CONCAT('a','b')"),
		).toBe("today() + concat('a','b')");
		expect(rewriteCaseMismatchedFunctionNames("today()")).toBeUndefined();
		// Nested parens survive the round() rewrite — span-based, not split.
		expect(rewriteRoundExtraArguments("round(round(1.5, 2), 2)")).toBe(
			"round(round(1.5))",
		);
		expect(rewriteRoundExtraArguments("round(1.5)")).toBeUndefined();
	});
});

describe("identifier repairs", () => {
	it("INVALID_FIELD_ID: sanitizes to a legal element name", () => {
		const doc = minDoc([f({ kind: "text", id: "bad id!", label: "Bad" })]);
		const outcome = expectRepaired(doc, "INVALID_FIELD_ID");
		expect(
			Object.values(outcome.doc.fields).some((field) => field.id === "bad_id_"),
		).toBe(true);
	});

	it("RESERVED_FIELD_ID_PREFIX: drops the reserved prefix", () => {
		const doc = minDoc([
			f({ kind: "text", id: "__nova_count_x", label: "Count" }),
		]);
		const outcome = expectRepaired(doc, "RESERVED_FIELD_ID_PREFIX");
		expect(
			Object.values(outcome.doc.fields).some((field) => field.id === "count_x"),
		).toBe(true);
	});

	it("CASE_PROPERTY_BAD_FORMAT: renames the writing field letter-first", () => {
		const doc = minDoc([
			f({
				kind: "text",
				id: "_temp",
				label: "Temp",
				case_property_on: "patient",
			}),
		]);
		expectRepaired(doc, "CASE_PROPERTY_BAD_FORMAT");
	});

	it("CASE_PROPERTY_TOO_LONG: truncates to the cap", () => {
		const doc = minDoc([
			f({
				kind: "text",
				id: `p${"x".repeat(300)}`,
				label: "Long",
				case_property_on: "patient",
			}),
		]);
		expectRepaired(doc, "CASE_PROPERTY_TOO_LONG");
	});

	it("RESERVED_CASE_PROPERTY: renames to the rule's own suggestion", () => {
		const doc = minDoc([
			f({
				kind: "date",
				id: "date",
				label: "Date",
				case_property_on: "patient",
			}),
		]);
		const outcome = expectRepaired(doc, "RESERVED_CASE_PROPERTY");
		expect(
			Object.values(outcome.doc.fields).some(
				(field) => field.id === "date_value",
			),
		).toBe(true);
	});

	it("DUPLICATE_FIELD_ID: suffix-renames the later non-case-bound sibling", () => {
		const doc = minDoc([
			f({ kind: "text", id: "notes", label: "Notes" }),
			f({ kind: "text", id: "notes", label: "More notes" }),
		]);
		const outcome = expectRepaired(doc, "DUPLICATE_FIELD_ID");
		expect(
			Object.values(outcome.doc.fields).some((field) => field.id === "notes_2"),
		).toBe(true);
	});

	it("DUPLICATE_FIELD_ID: case-bound twins are reported, not separated", () => {
		// Renaming either twin would cascade the shared case property — an
		// ambiguous data model only the owner can split.
		const doc = minDoc([
			f({ kind: "int", id: "age", label: "Age", case_property_on: "patient" }),
			f({
				kind: "int",
				id: "age",
				label: "Age again",
				case_property_on: "patient",
			}),
		]);
		const outcome = repairApp(doc, { applyProposed: false });
		expect(codes(outcome.before)).toContain("DUPLICATE_FIELD_ID");
		expect(codes(outcome.after)).toContain("DUPLICATE_FIELD_ID");
		expect(outcome.verdict.ok).toBe(true);
		// Mechanical class, no plan for this shape → the unplanned bucket,
		// never a silent skip.
		expect(outcome.unplanned.map((entry) => entry.finding.code)).toContain(
			"DUPLICATE_FIELD_ID",
		);
	});

	it("sanitizeIdentifier is deterministic and letter-first", () => {
		expect(sanitizeIdentifier("bad id!")).toBe("bad_id_");
		expect(sanitizeIdentifier("_temp")).toBe("q__temp");
		expect(sanitizeIdentifier("2nd_visit")).toBe("q_2nd_visit");
		expect(sanitizeIdentifier("__nova_count_x")).toBe("count_x");
		expect(sanitizeIdentifier("")).toBe("field");
	});
});

describe("debris-clearing repairs", () => {
	it("MEDIA_CASE_PROPERTY: clears case_property_on on the media field", () => {
		const doc = minDoc([
			f({
				kind: "image",
				id: "photo",
				label: "Photo",
				case_property_on: "patient",
			}),
		]);
		const outcome = expectRepaired(doc, "MEDIA_CASE_PROPERTY");
		const photo = Object.values(outcome.doc.fields).find(
			(field) => field.id === "photo",
		) as unknown as Record<string, unknown>;
		expect(photo.case_property_on).toBeUndefined();
	});

	it("VALIDATION_ON_NON_INPUT_KIND: clears validation on a non-input kind", () => {
		const doc = minDoc([
			f({ kind: "label", id: "note", label: "Note", validate_msg: "msg" }),
		]);
		expectRepaired(doc, "VALIDATION_ON_NON_INPUT_KIND");
	});

	it("REQUIRED_ON_HIDDEN: clears required on the hidden field", () => {
		const doc = minDoc([
			f({
				kind: "hidden",
				id: "score",
				calculate: "1 + 1",
				required: "true()",
			}),
		]);
		expectRepaired(doc, "REQUIRED_ON_HIDDEN");
	});

	it("INVALID_POST_SUBMIT: clears the unrecognized destination", () => {
		const doc = minDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		(doc.forms[formUuid] as { postSubmit?: unknown }).postSubmit = "bogus";
		expectRepaired(doc, "INVALID_POST_SUBMIT");
	});
});

describe("close-condition repairs", () => {
	/** minDoc plus a close form holding a two-option select. */
	function closeFormDoc(closeCondition?: Form["closeCondition"]): BlueprintDoc {
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
							name: "Reg",
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
							name: "Close out",
							type: "close",
							fields: [
								f({
									kind: "single_select",
									id: "outcome",
									label: "Outcome",
									options: [
										{ value: "done", label: "Done" },
										{ value: "moved", label: "Moved" },
									],
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
		if (closeCondition) {
			const closeFormUuid = doc.formOrder[doc.moduleOrder[0]][1];
			doc.forms[closeFormUuid].closeCondition = closeCondition;
		}
		return doc;
	}

	it("CLOSE_CONDITION_WRONG_TYPE: drops the dead config on a non-close form", () => {
		const doc = minDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const village = Object.values(doc.fields).find(
			(field) => field.id === "village",
		);
		doc.forms[formUuid].closeCondition = {
			field: village?.uuid ?? asUuid("missing"),
			answer: "x",
		};
		const outcome = expectRepaired(doc, "CLOSE_CONDITION_WRONG_TYPE");
		expect(doc.forms[formUuid].closeCondition).toBeDefined();
		expect(outcome.doc.forms[formUuid].closeCondition).toBeUndefined();
	});

	it("CLOSE_CONDITION_INCOMPLETE: drops the half-written condition", () => {
		const doc = closeFormDoc();
		const closeFormUuid = doc.formOrder[doc.moduleOrder[0]][1];
		const outcomeField = Object.values(doc.fields).find(
			(field) => field.id === "outcome",
		);
		doc.forms[closeFormUuid].closeCondition = {
			field: outcomeField?.uuid ?? asUuid("missing"),
			answer: "",
		};
		expectRepaired(doc, "CLOSE_CONDITION_INCOMPLETE");
	});

	it("CLOSE_CONDITION_FIELD_NOT_FOUND: needs the owner — never auto-dropped", () => {
		const doc = closeFormDoc({ field: asUuid("ghost"), answer: "done" });
		const outcome = repairApp(doc, { applyProposed: false });
		expect(codes(outcome.before)).toContain("CLOSE_CONDITION_FIELD_NOT_FOUND");
		expect(codes(outcome.after)).toContain("CLOSE_CONDITION_FIELD_NOT_FOUND");
		expect(outcome.applied).toEqual([]);
		expect(outcome.verdict.ok).toBe(true);
	});
});

describe("Connect repairs", () => {
	function learnDoc(): BlueprintDoc {
		return buildDoc({
			appName: "Learn",
			connectType: "learn",
			modules: [
				{
					name: "Lessons",
					forms: [
						{
							name: "Intro",
							type: "survey",
							fields: [
								f({ kind: "label", id: "intro_text", label: "Welcome" }),
							],
							connect: {
								// No id — CONNECT_ID_MISSING; the autofill derivation
								// fills it from the module name.
								learn_module: {
									name: "Intro",
									description: "Welcome",
									time_estimate: 1,
								},
								assessment: { id: "dup" },
							},
						},
						{
							name: "Quiz",
							type: "survey",
							fields: [f({ kind: "label", id: "quiz_text", label: "Quiz" })],
							connect: {
								learn_module: {
									id: "bad id!",
									name: "Quiz",
									description: "Quiz",
									time_estimate: 1,
								},
								assessment: { id: "dup" },
							},
						},
					],
				},
			],
		});
	}

	it("CONNECT_ID_MISSING / INVALID_FORMAT / DUPLICATE: re-derives by the autofill rule", () => {
		const doc = learnDoc();
		const outcome = repairApp(doc, { applyProposed: false });
		for (const code of [
			"CONNECT_ID_MISSING",
			"CONNECT_ID_INVALID_FORMAT",
			"CONNECT_ID_DUPLICATE",
		]) {
			expect(codes(outcome.before)).toContain(code);
			expect(codes(outcome.after)).not.toContain(code);
		}
		expect(outcome.verdict.ok).toBe(true);
		// First occurrence keeps "dup"; the later assessment re-derived.
		const [intro, quiz] = doc.formOrder[doc.moduleOrder[0]].map(
			(uuid) => outcome.doc.forms[uuid],
		);
		expect(intro.connect?.assessment?.id).toBe("dup");
		expect(quiz.connect?.assessment?.id).toBe("lessons_quiz");
		expect(intro.connect?.learn_module?.id).toBe("lessons");
	});

	it("CONNECT_ID_TOO_LONG: re-derives within the slug cap", () => {
		const doc = learnDoc();
		const introUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const intro = doc.forms[introUuid];
		intro.connect = {
			...intro.connect,
			learn_module: {
				...(intro.connect?.learn_module ?? {
					name: "Intro",
					description: "Welcome",
					time_estimate: 1,
				}),
				id: "x".repeat(60),
			},
		};
		const outcome = repairApp(doc, { applyProposed: false });
		expect(codes(outcome.before)).toContain("CONNECT_ID_TOO_LONG");
		expect(codes(outcome.after)).not.toContain("CONNECT_ID_TOO_LONG");
		expect(outcome.verdict.ok).toBe(true);
	});

	it("CONNECT_EMPTY_XPATH + CONNECT_UNQUOTED_XPATH: clears the empty slot, quotes the bare word", () => {
		const doc = buildDoc({
			appName: "Deliver",
			connectType: "deliver",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
							connect: {
								deliver_unit: {
									id: "visits",
									name: "Visit unit",
									// Strings here convert to the expression AST during
									// doc assembly — the post-migration stored shape.
									entity_id: "",
									entity_name: "household",
								} as never,
							},
						},
					],
				},
			],
		});
		const outcome = repairApp(doc, { applyProposed: false });
		for (const code of ["CONNECT_EMPTY_XPATH", "CONNECT_UNQUOTED_XPATH"]) {
			expect(codes(outcome.before)).toContain(code);
			expect(codes(outcome.after)).not.toContain(code);
		}
		expect(outcome.verdict.ok).toBe(true);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const unit = outcome.doc.forms[formUuid].connect?.deliver_unit as unknown as
			| Record<string, unknown>
			| undefined;
		expect(unit?.entity_id).toBeUndefined();
		expect(JSON.stringify(unit?.entity_name)).toContain("'household'");
	});
});

describe("case-list repairs", () => {
	it("CASE_LIST_DUPLICATE_SORT_PRIORITY: preserves Results-order precedence when storage order disagrees", () => {
		const doc = minDoc();
		const moduleUuid = doc.moduleOrder[0];
		doc.modules[moduleUuid].caseListConfig = {
			columns: [
				plainColumn(asUuid("col-a"), "case_name", "Name", {
					sort: { direction: "asc", priority: 1 },
					listOrder: "b",
				}),
				plainColumn(asUuid("col-b"), "village", "Village", {
					sort: { direction: "desc", priority: 1 },
					listOrder: "a",
				}),
			],
			searchInputs: [],
		};
		const outcome = expectRepaired(doc, "CASE_LIST_DUPLICATE_SORT_PRIORITY");
		const columns = outcome.doc.modules[moduleUuid].caseListConfig?.columns;
		// Storage is [a, b], but Results displays [b, a]. The repaired priorities
		// therefore map back to those UUIDs as [1, 0], preserving the runtime and
		// wire precedence that existed before repair.
		expect(columns?.map((column) => column.sort?.priority)).toEqual([1, 0]);
		// Direction and storage order stay untouched — only the colliding ranks move.
		expect(columns?.map((column) => column.uuid)).toEqual([
			asUuid("col-a"),
			asUuid("col-b"),
		]);
		expect(columns?.map((column) => column.sort?.direction)).toEqual([
			"asc",
			"desc",
		]);
	});

	it("MISSING_CASE_LIST_COLUMNS: withheld as PROPOSED by default", () => {
		const doc = minDoc();
		doc.modules[doc.moduleOrder[0]].caseListConfig = undefined;
		const outcome = repairApp(doc, { applyProposed: false });
		expect(codes(outcome.before)).toContain("MISSING_CASE_LIST_COLUMNS");
		expect(codes(outcome.after)).toContain("MISSING_CASE_LIST_COLUMNS");
		expect(outcome.applied).toEqual([]);
		expect(outcome.proposed).toHaveLength(1);
		expect(outcome.proposed[0].description).toContain("case_name");
		expect(outcome.verdict.ok).toBe(true);
	});

	it("MISSING_CASE_LIST_COLUMNS: seeds the case_name column under --apply-proposed", () => {
		const doc = minDoc();
		doc.modules[doc.moduleOrder[0]].caseListConfig = undefined;
		const outcome = expectRepaired(doc, "MISSING_CASE_LIST_COLUMNS", {
			applyProposed: true,
		});
		const columns =
			outcome.doc.modules[doc.moduleOrder[0]].caseListConfig?.columns;
		expect(columns).toHaveLength(1);
		expect(columns?.[0]).toMatchObject({
			kind: "plain",
			field: "case_name",
			header: "Name",
		});
	});

	it("MISSING_CASE_LIST_COLUMNS: seeds a formless case-list viewer", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					forms: [],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});

		const outcome = expectRepaired(doc, "MISSING_CASE_LIST_COLUMNS", {
			applyProposed: true,
		});
		expect(
			outcome.doc.modules[doc.moduleOrder[0]].caseListConfig?.columns,
		).toEqual([
			expect.objectContaining({
				kind: "plain",
				field: "case_name",
				header: "Name",
			}),
		]);
	});

	it("MISSING_CASE_LIST_COLUMNS: restores case_name when all definitions are Details-only", () => {
		const doc = minDoc();
		const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
		if (!config) throw new Error("fixture must have case-list config");
		config.columns = config.columns.map((column) => ({
			...column,
			visibleInList: false,
		}));

		const outcome = expectRepaired(doc, "MISSING_CASE_LIST_COLUMNS", {
			applyProposed: true,
		});
		const columns =
			outcome.doc.modules[doc.moduleOrder[0]].caseListConfig?.columns;
		expect(columns).toHaveLength(2);
		expect(
			columns?.find(
				(column) =>
					column.kind !== "calculated" && column.field === "case_name",
			),
		).toMatchObject({ visibleInList: true });
		expect(
			columns?.find(
				(column) => column.kind !== "calculated" && column.field === "village",
			),
		).toMatchObject({
			visibleInList: false,
		});
	});
});

// ── 3. The strictly-decreasing oracle ────────────────────────────────

describe("repairOutcomeVerdict", () => {
	const e1 = validationError("EMPTY_FORM", "form", "form one is empty", {
		formUuid: asUuid("form-1"),
	});
	const e2 = validationError("EMPTY_FORM", "form", "form two is empty", {
		formUuid: asUuid("form-2"),
	});

	it("accepts a no-repair outcome trivially", () => {
		expect(repairOutcomeVerdict([e1], [e1], 0).ok).toBe(true);
	});

	it("accepts strictly fewer findings with no new identities", () => {
		expect(repairOutcomeVerdict([e1, e2], [e1], 1).ok).toBe(true);
	});

	it("rejects repairs that cleared nothing", () => {
		expect(repairOutcomeVerdict([e1], [e1], 1).ok).toBe(false);
	});

	it("rejects any introduced identity, even at a lower count", () => {
		const verdict = repairOutcomeVerdict(
			[e1, e2],
			[
				validationError("EMPTY_FORM", "form", "a third form went empty", {
					formUuid: asUuid("form-3"),
				}),
			],
			1,
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.introduced).toHaveLength(1);
	});
});

// ── 4. Idempotence ───────────────────────────────────────────────────

describe("idempotence — a repaired doc re-repairs to itself", () => {
	it("second run plans nothing and changes nothing", () => {
		const doc = minDoc([
			f({ kind: "text", id: "bad id!", label: "Bad" }),
			f({
				kind: "text",
				id: "status",
				label: "Status",
				default_value: "approved",
			}),
			f({
				kind: "hidden",
				id: "score",
				calculate: "1 + 1",
				required: "true()",
			}),
		]);
		const first = repairApp(doc, { applyProposed: true });
		expect(first.changed).toBe(true);
		expect(first.verdict.ok).toBe(true);
		expect(first.after).toEqual([]);

		const second = repairApp(first.doc, { applyProposed: true });
		expect(second.changed).toBe(false);
		expect(second.applied).toEqual([]);
		expect(second.doc).toBe(first.doc);
		expect(second.after).toEqual(first.after);
	});
});

// ── 5. The legacy string-shaped load ─────────────────────────────────

describe("toLegacyBlueprintView — reads pre-AST blueprints the migration's way", () => {
	it("converts string slots and resolvable close refs before evaluating", () => {
		const doc = buildDoc({
			appName: "Legacy",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
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
									case_property_on: "patient",
								}),
							],
						},
						{
							name: "Close out",
							type: "close",
							fields: [
								f({
									kind: "single_select",
									id: "outcome",
									label: "Outcome",
									options: [
										{ value: "done", label: "Done" },
										{ value: "moved", label: "Moved" },
									],
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

		// Reshape to the pre-AST persisted form: expression slots as raw
		// strings, the close ref as a semantic field id, no derived maps.
		const raw = structuredClone(doc) as unknown as Record<string, unknown>;
		delete raw.fieldParent;
		const closeFormUuid = doc.formOrder[doc.moduleOrder[0]][1];
		const forms = raw.forms as Record<string, Record<string, unknown>>;
		forms[closeFormUuid].closeCondition = { field: "outcome", answer: "done" };
		const nameField = Object.values(doc.fields).find(
			(field) => field.id === "case_name",
		);
		const fields = raw.fields as Record<string, Record<string, unknown>>;
		if (!nameField) throw new Error("fixture missing case_name");
		fields[nameField.uuid].relevant = "1 = 1";

		const { doc: view, conversion } = toLegacyBlueprintView(raw);
		expect(conversion.converted).toBeGreaterThan(0);
		expect(conversion.closeRefsConverted).toBe(1);
		expect(conversion.failures).toEqual([]);
		expect(conversion.unresolvedCloseRefs).toEqual([]);

		// The resolvable legacy close ref reads as the field's uuid — never
		// a dangling CLOSE_CONDITION_FIELD_NOT_FOUND finding.
		const { findings } = evaluateLegacyFindings(view);
		expect(codes(findings)).not.toContain("CLOSE_CONDITION_FIELD_NOT_FOUND");
		const outcomeField = Object.values(view.fields).find(
			(field) => field.id === "outcome",
		);
		expect(view.forms[closeFormUuid].closeCondition?.field).toBe(
			outcomeField?.uuid,
		);
	});

	it("never mutates the stored input", () => {
		const doc = minDoc();
		const raw = structuredClone(doc) as unknown as Record<string, unknown>;
		delete raw.fieldParent;
		const before = structuredClone(raw);
		toLegacyBlueprintView(raw);
		expect(raw).toEqual(before);
	});

	it("treats an empty app's birth findings as by-design, not legacy debris", () => {
		const empty = buildDoc({ appName: "" });
		const { findings, birth } = evaluateLegacyFindings(empty);
		expect(findings).toEqual([]);
		expect(codes(birth).sort()).toEqual(["EMPTY_APP_NAME", "NO_MODULES"]);
	});
});

// ── Per-app fault isolation ──────────────────────────────────────────

describe("guarded per-app entry points — one broken doc never takes down the run", () => {
	/** A structurally broken stored doc: `moduleOrder` names a module that
	 *  doesn't exist, so the validator's module walk dereferences
	 *  `undefined` and throws. */
	function brokenStoredDoc(): Record<string, unknown> {
		const doc = minDoc();
		doc.moduleOrder.push(asUuid("ghost-module"));
		const raw = structuredClone(doc) as unknown as Record<string, unknown>;
		delete raw.fieldParent;
		return raw;
	}

	it("the broken fixture genuinely throws when evaluated unguarded", () => {
		const { doc } = toLegacyBlueprintView(brokenStoredDoc());
		expect(() => evaluateLegacyFindings(doc)).toThrow();
	});

	it("guardedLegacyEvaluation returns the error arm instead of throwing", () => {
		const result = guardedLegacyEvaluation(brokenStoredDoc());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});

	it("guardedRepairApp returns the error arm instead of throwing", () => {
		const result = guardedRepairApp(brokenStoredDoc(), {
			applyProposed: false,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});

	it("a healthy doc passes through both guards unchanged", () => {
		const doc = minDoc([f({ kind: "text", id: "bad id!", label: "Bad" })]);
		const raw = structuredClone(doc) as unknown as Record<string, unknown>;
		delete raw.fieldParent;

		const scan = guardedLegacyEvaluation(raw);
		expect(scan.ok).toBe(true);
		if (scan.ok) {
			expect(codes(scan.value.evaluation.findings)).toContain(
				"INVALID_FIELD_ID",
			);
		}

		const repair = guardedRepairApp(raw, { applyProposed: false });
		expect(repair.ok).toBe(true);
		if (repair.ok) {
			expect(repair.value.outcome?.verdict.ok).toBe(true);
			expect(repair.value.outcome?.after).toEqual([]);
		}
	});
});
