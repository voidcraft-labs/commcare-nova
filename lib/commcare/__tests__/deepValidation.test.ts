import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { buildDoc, type FieldSpec, f } from "../../__tests__/docHelpers";
import { buildFieldTree } from "../../preview/engine/fieldTree";
import { TriggerDag } from "../../preview/engine/triggerDag";
import { validateBlueprintDeep } from "../validator";
import {
	FUNCTION_REGISTRY,
	findCaseInsensitiveMatch,
} from "../validator/functionRegistry";
import { runValidation } from "../validator/runner";
import { validateXPath } from "../validator/xpathValidator";

// ── XPath Validator ─────────────────────────────────────────────────

describe("validateXPath", () => {
	describe("valid expressions", () => {
		it("returns no errors for simple expressions", () => {
			expect(validateXPath("true()")).toEqual([]);
			expect(validateXPath("/data/name != ''")).toEqual([]);
			expect(validateXPath("if(. = 'yes', 'Yes', 'No')")).toEqual([]);
			expect(validateXPath("#form/age > 18")).toEqual([]);
			expect(validateXPath("today()")).toEqual([]);
			expect(validateXPath("concat('Hello', ' ', 'World')")).toEqual([]);
		});

		it("returns no errors for complex real-world expressions", () => {
			expect(
				validateXPath("if(selected(#form/symptoms, 'fever'), 'high', 'low')"),
			).toEqual([]);
			expect(validateXPath("format-date(today(), '%Y-%m-%d')")).toEqual([]);
			expect(validateXPath("count(/data/visits) > 0")).toEqual([]);
			expect(validateXPath("#case/total_visits + 1")).toEqual([]);
		});

		it("returns no errors for variadic functions", () => {
			expect(validateXPath("concat()")).toEqual([]);
			expect(validateXPath("concat('a', 'b', 'c', 'd')")).toEqual([]);
			expect(validateXPath("coalesce(#form/a, #form/b, 'default')")).toEqual(
				[],
			);
			expect(validateXPath("min(1, 2, 3)")).toEqual([]);
		});
	});

	describe("syntax errors", () => {
		it("catches unbalanced parentheses", () => {
			const errors = validateXPath("if(true(, 'a', 'b')");
			expect(errors.some((e) => e.code === "XPATH_SYNTAX")).toBe(true);
		});

		it("catches trailing operators", () => {
			const errors = validateXPath("/data/age >");
			expect(errors.some((e) => e.code === "XPATH_SYNTAX")).toBe(true);
		});
	});

	describe("unknown functions", () => {
		it("catches unknown function names", () => {
			const errors = validateXPath("foobar(1)");
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("UNKNOWN_FUNCTION");
			expect(errors[0].message).toContain("foobar");
		});

		it("suggests correct casing for case-mismatched functions", () => {
			const errors = validateXPath("Today()");
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("UNKNOWN_FUNCTION");
			expect(errors[0].message).toContain("today()");
			expect(errors[0].message).toContain("case-sensitive");
		});

		it("suggests correct casing for IF", () => {
			const errors = validateXPath("IF(true(), 'a', 'b')");
			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain("if()");
		});
	});

	describe("wrong arity", () => {
		it("catches round with 2 args", () => {
			const errors = validateXPath("round(3.14, 2)");
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("WRONG_ARITY");
			expect(errors[0].message).toContain("round()");
		});

		it("catches if with 2 args", () => {
			const errors = validateXPath("if(true(), 'yes')");
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("WRONG_ARITY");
		});

		it("catches today with args", () => {
			const errors = validateXPath("today('2024')");
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("WRONG_ARITY");
		});

		it("catches cond with even number of args", () => {
			const errors = validateXPath("cond(true(), 'a', false(), 'b')");
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("WRONG_ARITY");
			expect(errors[0].message).toContain("odd");
		});

		it("allows cond with odd number of args >= 3", () => {
			expect(validateXPath("cond(true(), 'a', 'default')")).toEqual([]);
			expect(
				validateXPath("cond(true(), 'a', false(), 'b', 'default')"),
			).toEqual([]);
		});
	});

	describe("node reference validation", () => {
		const validPaths = new Set([
			"/data/name",
			"/data/age",
			"/data/group1",
			"/data/group1/child1",
		]);

		it("passes for valid references", () => {
			expect(validateXPath("/data/name != ''", validPaths)).toEqual([]);
			expect(validateXPath("/data/group1/child1", validPaths)).toEqual([]);
		});

		it("catches invalid references", () => {
			const errors = validateXPath("/data/nonexistent != ''", validPaths);
			expect(errors.some((e) => e.code === "INVALID_REF")).toBe(true);
		});
	});

	describe("case property reference validation", () => {
		const caseProps = new Set(["name", "age", "status"]);

		it("passes for valid case refs", () => {
			expect(validateXPath("#case/name", undefined, caseProps)).toEqual([]);
		});

		it("catches invalid case property refs", () => {
			const errors = validateXPath("#case/nonexistent", undefined, caseProps);
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("INVALID_CASE_REF");
		});
	});

	describe("bare reference validation", () => {
		// CommCare authors can write relative references like `name` (alone)
		// or `name = "x"` to refer to a sibling field — XPath parses these
		// as `child::name`. NameTests at value positions outside paths,
		// hashtags, attribute steps, axis steps, and predicate scopes must
		// resolve to a known reference (a leaf of validPaths or a case
		// property); otherwise contiguous-letter junk like `kldfnfkj`
		// passes the syntax check and saves silently.

		const validPaths = new Set([
			"/data/name",
			"/data/age",
			"/data/group1",
			"/data/group1/child1",
		]);
		const caseProps = new Set(["status", "owner"]);

		it("flags a bare unknown name when context is provided", () => {
			const errors = validateXPath("kldfnfkj", validPaths, caseProps);
			expect(errors.some((e) => e.code === "INVALID_REF")).toBe(true);
		});

		it("error message names the bad reference", () => {
			const errors = validateXPath("kldfnfkj", validPaths, caseProps);
			const refError = errors.find((e) => e.code === "INVALID_REF");
			expect(refError?.message).toContain("kldfnfkj");
		});

		it("flags bare names on both sides of an operator", () => {
			// Two unknown bare references in the same expression should each
			// surface their own error so the user sees what's wrong.
			const errors = validateXPath("foo and bar", validPaths, caseProps).filter(
				(e) => e.code === "INVALID_REF",
			);
			expect(errors).toHaveLength(2);
		});

		it("accepts a bare name that matches a validPath leaf", () => {
			// `name` as a relative reference resolves to the field at
			// `/data/name`. The leaf-segment match is the cheapest correct
			// approximation of "this name exists somewhere in the form".
			expect(validateXPath("name", validPaths, caseProps)).toEqual([]);
			expect(validateXPath("name = 'Alex'", validPaths, caseProps)).toEqual([]);
		});

		it("accepts a bare name that matches a case property", () => {
			// `status` lives on the case, not the form — same name, different
			// origin. Either source counts as a valid resolution.
			expect(validateXPath("status", validPaths, caseProps)).toEqual([]);
		});

		it("does not double-count NameTests already inside an absolute path", () => {
			// `/data/foo/bar` is validated by extractPathRefs as a single
			// path reference. The bare-name walk must skip NameTests that
			// live inside a Child node, otherwise users would see a duplicate
			// error per segment.
			const errors = validateXPath(
				"/data/nonexistent",
				validPaths,
				caseProps,
			).filter((e) => e.code === "INVALID_REF");
			expect(errors).toHaveLength(1);
		});

		it("does not flag NameTests that are part of a HashtagRef", () => {
			// `#case/nonexistent` is validated by the hashtag rule; its
			// `nonexistent` segment is a HashtagSegment, not a NameTest, so
			// it never reaches the bare-name walk — pin that contract.
			const errors = validateXPath(
				"#case/nonexistent",
				validPaths,
				caseProps,
			).filter((e) => e.code === "INVALID_REF");
			expect(errors).toHaveLength(0);
		});

		it("does not flag function names", () => {
			// `today` inside `today()` is a FunctionName, not a NameTest, so
			// the bare-name walk skips it. Function call validation has its
			// own UNKNOWN_FUNCTION error path.
			expect(validateXPath("today()", validPaths, caseProps)).toEqual([]);
		});

		it("does not flag XPath keywords", () => {
			// `and`, `or`, `not`, etc. parse as Keyword nodes, not NameTests.
			// `not()` is a function call.
			expect(validateXPath("name and status", validPaths, caseProps)).toEqual(
				[],
			);
			expect(validateXPath("name or status", validPaths, caseProps)).toEqual(
				[],
			);
			expect(validateXPath("not(name)", validPaths, caseProps)).toEqual([]);
		});

		it("does not run the check when no context is provided", () => {
			// Without `validPaths` or `caseProperties`, the validator can't
			// know what's a valid reference. It must fall back to "syntax
			// only" so that schema-tools / agent-prompt callers that don't
			// supply context don't reject every bare name. The user-facing
			// editor always provides context via useFormLintContext.
			expect(validateXPath("kldfnfkj")).toEqual([]);
			expect(validateXPath("foo and bar")).toEqual([]);
		});

		it("flags bare names in nested function arguments", () => {
			// `concat(foo, bar)` should flag both — even though they're
			// inside an Invoke, they're argument expressions, not part of
			// the function name itself.
			const errors = validateXPath(
				"concat(foo, bar)",
				validPaths,
				caseProps,
			).filter((e) => e.code === "INVALID_REF");
			expect(errors).toHaveLength(2);
		});

		// ── Non-value-position NameTests (must NOT flag) ─────────────────
		// XPath places NameTests in several positions where the name is not
		// a value-position reference: as an attribute name (`@foo`), as the
		// target of an explicit axis (`child::foo`), or inside a predicate
		// (`[bar > 0]`) where the resolution scope is the filtered node and
		// the form schema can't describe its children. These tests pin that
		// the walker stays out of those positions.

		it("does not flag attribute references (`@case_id`)", () => {
			const errors = validateXPath("@case_id", validPaths, caseProps);
			expect(errors).toEqual([]);
		});

		it("does not flag explicit-axis steps (`child::foo`)", () => {
			expect(validateXPath("child::foo", validPaths, caseProps)).toEqual([]);
			expect(validateXPath("attribute::status", validPaths, caseProps)).toEqual(
				[],
			);
		});

		it("does not flag predicate-internal references (`/data/foo[bar > 0]`)", () => {
			// `bar` is the predicate expression; relative to the filtered
			// step's context. Without a child schema for `/data/foo`, we
			// can't say if `bar` exists — skip rather than false-positive.
			expect(
				validateXPath("/data/foo[bar > 0]", new Set(["/data/foo"])),
			).toEqual([]);
		});

		it("does not flag the canonical case-search instance pattern", () => {
			// Real CommCare expression: case_id, case_type, status all live
			// inside `Filtered` predicates and as `@`-attributes. Flagging
			// any of them would block the most common case-search XPath
			// authors write.
			const errors = validateXPath(
				"instance('casedb')/casedb/case[@case_id = 'x']/case_name",
				new Set(["/data/some_form_field"]),
				new Set(["name"]),
			);
			expect(errors).toEqual([]);
		});

		it("does not flag chained attribute predicates", () => {
			// `[@case_type = 'mother'][@status = 'open']` — every
			// predicate-internal reference is an attribute and must not
			// surface as INVALID_REF.
			const errors = validateXPath(
				"instance('casedb')/casedb/case[@case_type = 'mother'][@status = 'open']/case_name",
				new Set(["/data/some_form_field"]),
				undefined,
			);
			expect(errors).toEqual([]);
		});

		it("flags a bare unknown reference outside any path or predicate", () => {
			// Regression pin alongside the must-not-flag cases: the walker
			// must still catch top-level junk after the predicate / axis /
			// attribute exemptions are in place.
			const errors = validateXPath(
				"1 + nonsense",
				new Set(["/data/foo"]),
				undefined,
			).filter((e) => e.code === "INVALID_REF");
			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain("nonsense");
		});

		it("does not flag an absolute path passed as a function argument", () => {
			// `count(/data/foo)` — Phase 2c already validates the path; the
			// walker must not double-flag the path's leaf name.
			expect(
				validateXPath("count(/data/foo)", new Set(["/data/foo"]), undefined),
			).toEqual([]);
		});
	});

	describe("type checking", () => {
		describe("catches provably-lossy coercions", () => {
			it("unary minus on non-numeric string literal", () => {
				const errors = validateXPath("-'hello'");
				expect(errors.some((e) => e.code === "TYPE_ERROR")).toBe(true);
			});

			it("arithmetic with non-numeric string literal", () => {
				expect(
					validateXPath("'text' * 2").some((e) => e.code === "TYPE_ERROR"),
				).toBe(true);
				expect(
					validateXPath("'text' + 5").some((e) => e.code === "TYPE_ERROR"),
				).toBe(true);
				expect(
					validateXPath("'text' - 1").some((e) => e.code === "TYPE_ERROR"),
				).toBe(true);
				expect(
					validateXPath("10 div 'abc'").some((e) => e.code === "TYPE_ERROR"),
				).toBe(true);
			});

			it("the original failing case: =- string literal", () => {
				const errors = validateXPath("/data/x =- 'here'");
				expect(errors.some((e) => e.code === "TYPE_ERROR")).toBe(true);
			});

			it("non-numeric string literal in numeric function param", () => {
				expect(
					validateXPath("round('foo')").some((e) => e.code === "TYPE_ERROR"),
				).toBe(true);
				expect(
					validateXPath("floor('bar')").some((e) => e.code === "TYPE_ERROR"),
				).toBe(true);
				expect(
					validateXPath("abs('baz')").some((e) => e.code === "TYPE_ERROR"),
				).toBe(true);
			});
		});

		describe("allows legitimate patterns", () => {
			it("today() + 1 (date arithmetic — today returns number)", () => {
				expect(validateXPath("today() + 1")).toEqual([]);
			});

			it("/data/age + 1 (nodeset in numeric context — unknowable)", () => {
				expect(validateXPath("/data/age + 1")).toEqual([]);
			});

			it("#case/visits + 1 (string ref in numeric context — unknowable)", () => {
				expect(validateXPath("#case/visits + 1")).toEqual([]);
			});

			it("'5' + 3 (numeric string literal — parseable)", () => {
				expect(validateXPath("'5' + 3")).toEqual([]);
			});

			it("5 = '5' (equality accepts any types)", () => {
				expect(validateXPath("5 = '5'")).toEqual([]);
			});

			it("if(true(), 'yes', 'no') (conditional with any-typed branches)", () => {
				expect(validateXPath("if(true(), 'yes', 'no')")).toEqual([]);
			});

			it("not(count(/data/items)) (number→boolean is valid coercion)", () => {
				expect(validateXPath("not(count(/data/items))")).toEqual([]);
			});

			it("boolean('yes') (explicit conversion function)", () => {
				expect(validateXPath("boolean('yes')")).toEqual([]);
			});

			it("number('42') (explicit conversion function)", () => {
				expect(validateXPath("number('42')")).toEqual([]);
			});

			it("selected(#form/symptoms, 'fever') (string params)", () => {
				expect(validateXPath("selected(#form/symptoms, 'fever')")).toEqual([]);
			});
		});
	});
});

// ── Function Registry ───────────────────────────────────────────────

describe("functionRegistry", () => {
	it("contains all expected CommCare functions", () => {
		const expected = [
			"if",
			"today",
			"now",
			"selected",
			"count-selected",
			"format-date",
			"uuid",
			"random",
			"round",
			"concat",
			"join",
			"regex",
			"cond",
			"coalesce",
			"distance",
			"id-compress",
			"encrypt-string",
		];
		for (const name of expected) {
			expect(FUNCTION_REGISTRY.has(name)).toBe(true);
		}
	});

	it("has correct arity for round (exactly 1)", () => {
		const spec = FUNCTION_REGISTRY.get("round");
		if (!spec) throw new Error("expected round in registry");
		expect(spec.minArgs).toBe(1);
		expect(spec.maxArgs).toBe(1);
	});

	it("has correct arity for if (exactly 3)", () => {
		const spec = FUNCTION_REGISTRY.get("if");
		if (!spec) throw new Error("expected if in registry");
		expect(spec.minArgs).toBe(3);
		expect(spec.maxArgs).toBe(3);
	});

	it("has correct arity for concat (0+)", () => {
		const spec = FUNCTION_REGISTRY.get("concat");
		if (!spec) throw new Error("expected concat in registry");
		expect(spec.minArgs).toBe(0);
		expect(spec.maxArgs).toBe(-1);
	});

	describe("findCaseInsensitiveMatch", () => {
		it("finds Today → today", () => {
			expect(findCaseInsensitiveMatch("Today")).toBe("today");
		});

		it("returns undefined for truly unknown functions", () => {
			expect(findCaseInsensitiveMatch("foobar")).toBeUndefined();
		});
	});
});

// ── TriggerDag Cycle Reporting ──────────────────────────────────────

/**
 * Small adapter: TriggerDag takes a `FieldTreeNode[]`. Tests construct a
 * throwaway doc so we can exercise the DAG without depending on the
 * runner. `buildFieldTree` is the same rose-tree builder the real
 * validator uses.
 */
function treeFromFields(fields: FieldSpec[]) {
	const doc = buildDoc({
		appName: "Test",
		modules: [{ name: "M", forms: [{ name: "F", type: "survey", fields }] }],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	return buildFieldTree(formUuid, doc.fields, doc.fieldOrder);
}

describe("TriggerDag.reportCycles", () => {
	it("returns empty for acyclic graph", () => {
		const dag = new TriggerDag();
		const cycles = dag.reportCycles(
			treeFromFields([
				f({ kind: "int", id: "a", label: "A" }),
				f({ kind: "int", id: "b", label: "B", calculate: "/data/a + 1" }),
			]),
		);
		expect(cycles).toEqual([]);
	});

	it("detects A→B→A cycle", () => {
		const dag = new TriggerDag();
		const cycles = dag.reportCycles(
			treeFromFields([
				f({ kind: "int", id: "a", label: "A", calculate: "/data/b + 1" }),
				f({ kind: "int", id: "b", label: "B", calculate: "/data/a + 1" }),
			]),
		);
		expect(cycles.length).toBeGreaterThan(0);
	});

	it("handles diamond dependency (no cycle)", () => {
		const dag = new TriggerDag();
		const cycles = dag.reportCycles(
			treeFromFields([
				f({ kind: "int", id: "a", label: "A" }),
				f({ kind: "int", id: "b", label: "B", calculate: "/data/a + 1" }),
				f({ kind: "int", id: "c", label: "C", calculate: "/data/a + 2" }),
				f({
					kind: "int",
					id: "d",
					label: "D",
					calculate: "/data/b + /data/c",
				}),
			]),
		);
		expect(cycles).toEqual([]);
	});
});

// ── Orchestrator Integration ────────────────────────────────────────

describe("validateBlueprintDeep", () => {
	const makeDoc = (fields: FieldSpec[], caseTypes: CaseType[] | null = null) =>
		buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: caseTypes ? "patient" : undefined,
					forms: [{ name: "Form", type: "registration", fields }],
				},
			],
			caseTypes,
		});

	it("returns no errors for valid blueprint", () => {
		const doc = makeDoc(
			[
				f({
					kind: "text",
					id: "case_name",
					label: "Name",
					case_property: "patient",
				}),
				f({
					kind: "int",
					id: "age",
					label: "Age",
					relevant: "/data/case_name != ''",
				}),
			],
			[{ name: "patient", properties: [{ name: "case_name", label: "Name" }] }],
		);
		expect(validateBlueprintDeep(doc)).toEqual([]);
	});

	it("catches unknown function in XPath", () => {
		const doc = makeDoc([
			f({ kind: "text", id: "name", label: "Name" }),
			f({ kind: "hidden", id: "val", calculate: "foobar(1)" }),
		]);
		expect(
			validateBlueprintDeep(doc).some((e) => e.includes("Unknown function")),
		).toBe(true);
	});

	it("catches wrong arity", () => {
		const doc = makeDoc([
			f({ kind: "text", id: "name", label: "Name" }),
			f({ kind: "hidden", id: "val", calculate: "round(3.14, 2)" }),
		]);
		expect(validateBlueprintDeep(doc).some((e) => e.includes("round()"))).toBe(
			true,
		);
	});

	it("catches circular dependencies", () => {
		const doc = makeDoc([
			f({ kind: "hidden", id: "a", calculate: "/data/b + 1" }),
			f({ kind: "hidden", id: "b", calculate: "/data/a + 1" }),
		]);
		expect(
			validateBlueprintDeep(doc).some((e) => e.includes("circular dependency")),
		).toBe(true);
	});

	it("catches unknown case property in #case/ ref", () => {
		const doc = makeDoc(
			[
				f({
					kind: "text",
					id: "case_name",
					label: "Name",
					case_property: "patient",
				}),
				f({ kind: "hidden", id: "val", calculate: "#case/nonexistent + 1" }),
			],
			[{ name: "patient", properties: [{ name: "case_name", label: "Name" }] }],
		);
		expect(
			validateBlueprintDeep(doc).some((e) =>
				e.includes("Unknown case property"),
			),
		).toBe(true);
	});
});

// ── Full Integration (runValidation calls deep) ────────────────────

describe("runValidation with deep validation", () => {
	it("catches both rule-based and deep XPath errors", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListColumns: [{ field: "case_name", header: "Name" }],
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property: "patient",
								}),
								f({ kind: "hidden", id: "calc", calculate: "foobar(1)" }),
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
		expect(errors.some((e) => e.code === "UNKNOWN_FUNCTION")).toBe(true);
	});
});
