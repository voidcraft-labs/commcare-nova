import { describe, expect, it } from "vitest";
import { asUuid, type CaseType } from "@/lib/domain";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
	xp,
} from "../../__tests__/docHelpers";
import { buildFieldTree } from "../../preview/engine/fieldTree";
import { TriggerDag } from "../../preview/engine/triggerDag";
import { type DeepValidationError, validateBlueprintDeep } from "../validator";
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

		it("lints a multi-segment #form ref clean when the nested path exists", () => {
			// A re-anchored ref (`#form/group1/child1` after a move into a
			// group) maps to `/data/group1/child1` — known, so no diagnostics.
			expect(validateXPath("#form/group1/child1 != ''", validPaths)).toEqual(
				[],
			);
		});

		it("flags a multi-segment #form ref whose nested path is unknown", () => {
			const errors = validateXPath("#form/group1/nope != ''", validPaths);
			expect(errors.some((e) => e.code === "INVALID_REF")).toBe(true);
		});

		it("catches invalid references", () => {
			const errors = validateXPath("/data/nonexistent != ''", validPaths);
			expect(errors.some((e) => e.code === "INVALID_REF")).toBe(true);
		});

		it("suggests the group-qualified path when only the bare id was used", () => {
			// `#form/child1` → `/data/child1` is unknown, but the field lives at
			// `/data/group1/child1`. The leaf (`child1`) matches, so the error
			// carries it as a suggestion — the dominant bare-id authoring bug.
			const errors = validateXPath("/data/child1 = 'x'", validPaths);
			const refError = errors.find((e) => e.code === "INVALID_REF");
			expect(refError?.suggestions).toEqual(["/data/group1/child1"]);
		});

		it("lists every cousin sharing the leaf id as a suggestion", () => {
			const cousins = new Set([
				"/data/group_a/first_name",
				"/data/group_b/first_name",
			]);
			const errors = validateXPath("/data/first_name", cousins);
			const refError = errors.find((e) => e.code === "INVALID_REF");
			expect(refError?.suggestions).toEqual([
				"/data/group_a/first_name",
				"/data/group_b/first_name",
			]);
		});

		it("omits suggestions for a genuine typo with no leaf match", () => {
			const errors = validateXPath("/data/zzz_typo", validPaths);
			const refError = errors.find((e) => e.code === "INVALID_REF");
			expect(refError?.suggestions).toBeUndefined();
		});
	});

	describe("case property reference validation", () => {
		// The per-type accept map: each reachable case-type name → its readable
		// property names. A `#<type>/<prop>` ref resolves to exactly one type.
		const caseTypeProps = new Map([
			["patient", new Set(["name", "age", "status"])],
		]);

		it("passes for a valid case ref", () => {
			expect(validateXPath("#patient/name", undefined, caseTypeProps)).toEqual(
				[],
			);
		});

		it("catches an unknown property on a reachable case type", () => {
			const errors = validateXPath(
				"#patient/nonexistent",
				undefined,
				caseTypeProps,
			);
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("INVALID_CASE_REF");
			expect(errors[0].message).toContain("has no property");
		});

		it("gives a registration-aware message for a narrowed-out property", () => {
			// On a registration form the own type is narrowed to case_id, so a
			// real property reads as "not available yet" — NOT "doesn't exist".
			const regAccept = new Map([["patient", new Set(["case_id"])]]);
			const errors = validateXPath("#patient/name", undefined, regAccept, true);
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("INVALID_CASE_REF");
			expect(errors[0].message).toContain("creates a case");
			expect(errors[0].message).not.toContain("has no property");
		});

		it("catches a reference to an unreachable case type", () => {
			const errors = validateXPath("#mother/name", undefined, caseTypeProps);
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("INVALID_CASE_REF");
			expect(errors[0].message).toContain("mother");
		});

		it("skips #form/, #user/, and the transitional #case/ namespaces", () => {
			// `#case/` is resolved by the wire (transitional), so the validator
			// must NOT reject it as an unknown case type — it would be stricter
			// than the emitter.
			for (const ref of ["#form/whatever", "#user/username", "#case/total"]) {
				expect(
					validateXPath(ref, undefined, caseTypeProps).filter(
						(e) => e.code === "INVALID_CASE_REF",
					),
				).toEqual([]);
			}
		});

		it("gives a survey-specific message when the accept map is empty", () => {
			// A survey form yields an empty accept map (it loads no case), so an
			// XPath case ref can't resolve there — the message says so rather than
			// the misleading "check spelling / reachable as an ancestor".
			const errors = validateXPath("#mother/age", undefined, new Map(), false);
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("INVALID_CASE_REF");
			expect(errors[0].message).toContain("survey");
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
		// Per-type accept map; relative bare refs match a property on ANY
		// reachable type (the bare ref carries no type), so a flat-across-types
		// known-name set is what `validateXPath` builds from this.
		const caseProps = new Map([["patient", new Set(["status", "owner"])]]);

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
			// `#patient/nonexistent` is validated by the hashtag rule; its
			// `nonexistent` segment is a HashtagSegment, not a NameTest, so
			// it never reaches the bare-name walk — pin that contract.
			const errors = validateXPath(
				"#patient/nonexistent",
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
				new Map([["patient", new Set(["name"])]]),
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
	return {
		tree: buildFieldTree(formUuid, doc.fields, doc.fieldOrder),
		doc,
	};
}

describe("TriggerDag.reportCycles", () => {
	// A field that carries `calculate` is a computed field, which in the
	// domain is the `hidden` kind (visible inputs don't carry `calculate`).
	// The leaf the others read (`a`) is a plain user input — a visible `int`.
	it("returns empty for acyclic graph", () => {
		const dag = new TriggerDag();
		const { tree, doc } = treeFromFields([
			f({ kind: "int", id: "a", label: "A" }),
			f({ kind: "hidden", id: "b", calculate: "/data/a + 1" }),
		]);
		expect(dag.reportCycles(tree, doc)).toEqual([]);
	});

	it("detects A→B→A cycle", () => {
		const dag = new TriggerDag();
		const { tree, doc } = treeFromFields([
			f({ kind: "hidden", id: "a", calculate: "/data/b + 1" }),
			f({ kind: "hidden", id: "b", calculate: "/data/a + 1" }),
		]);
		expect(dag.reportCycles(tree, doc).length).toBeGreaterThan(0);
	});

	it("handles diamond dependency (no cycle)", () => {
		const dag = new TriggerDag();
		const { tree, doc } = treeFromFields([
			f({ kind: "int", id: "a", label: "A" }),
			f({ kind: "hidden", id: "b", calculate: "/data/a + 1" }),
			f({ kind: "hidden", id: "c", calculate: "/data/a + 2" }),
			f({
				kind: "hidden",
				id: "d",
				calculate: "/data/b + /data/c",
			}),
		]);
		expect(dag.reportCycles(tree, doc)).toEqual([]);
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
					case_property_on: "patient",
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
		// Typed assertion — the discriminant + the underlying `XPathError.code`
		// travel structured, so the test reads the classification directly
		// instead of substring-matching a humanized message.
		expect(
			validateBlueprintDeep(doc).some(
				(e) => e.kind === "field-xpath" && e.error.code === "UNKNOWN_FUNCTION",
			),
		).toBe(true);
	});

	it("catches wrong arity", () => {
		const doc = makeDoc([
			f({ kind: "text", id: "name", label: "Name" }),
			f({ kind: "hidden", id: "val", calculate: "round(3.14, 2)" }),
		]);
		expect(
			validateBlueprintDeep(doc).some(
				(e) =>
					e.kind === "field-xpath" &&
					e.error.code === "WRONG_ARITY" &&
					e.error.message.includes("round"),
			),
		).toBe(true);
	});

	it("catches circular dependencies", () => {
		const doc = makeDoc([
			f({ kind: "hidden", id: "a", calculate: "/data/b + 1" }),
			f({ kind: "hidden", id: "b", calculate: "/data/a + 1" }),
		]);
		// The cycle is its own typed shape (carrying the loop as a list of
		// `/data/...` paths), not a string that has to win a regex race against
		// the form-label pattern.
		const cycleErr = validateBlueprintDeep(doc).find((e) => e.kind === "cycle");
		expect(cycleErr).toBeDefined();
		// The cycle path names both fields in the loop.
		if (cycleErr?.kind === "cycle") {
			expect(cycleErr.cycle).toContain("/data/a");
			expect(cycleErr.cycle).toContain("/data/b");
		}
	});

	it("catches unknown case property in a #<type>/ ref", () => {
		// `makeDoc`'s form is a registration form, so the own type narrows to
		// `case_id` only — `#patient/nonexistent` is rejected as INVALID_CASE_REF.
		const doc = makeDoc(
			[
				f({
					kind: "text",
					id: "case_name",
					label: "Name",
					case_property_on: "patient",
				}),
				f({ kind: "hidden", id: "val", calculate: "#patient/nonexistent + 1" }),
			],
			[{ name: "patient", properties: [{ name: "case_name", label: "Name" }] }],
		);
		expect(
			validateBlueprintDeep(doc).some(
				(e) => e.kind === "field-xpath" && e.error.code === "INVALID_CASE_REF",
			),
		).toBe(true);
	});

	it("catches a reference to an unreachable case type in a #<type>/ ref", () => {
		// `#mother/x` on a patient form names a type that isn't reachable.
		const doc = makeDoc(
			[
				f({
					kind: "text",
					id: "case_name",
					label: "Name",
					case_property_on: "patient",
				}),
				f({ kind: "hidden", id: "val", calculate: "#mother/code + 1" }),
			],
			[{ name: "patient", properties: [{ name: "case_name", label: "Name" }] }],
		);
		expect(
			validateBlueprintDeep(doc).some(
				(e) => e.kind === "field-xpath" && e.error.code === "INVALID_CASE_REF",
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

// ── Repeat-mode XPath deep validation ──────────────────────────────
//
// `repeat_count` (count_bound) and `data_source.ids_query` (query_bound)
// are XPath expressions the wire emitter writes into JavaRosa-parsed
// attributes. Empty values are caught by the field-rule layer
// (`EMPTY_REPEAT_COUNT` / `EMPTY_IDS_QUERY`); these tests pin that
// non-empty malformed expressions are caught by the deep XPath
// validator with the same `XPATH_SYNTAX` / `UNKNOWN_FUNCTION` /
// `INVALID_REF` codes the field-level XPath fields produce — so an SA
// editing a repeat field gets the same actionable error class as
// editing a calculate or relevant.

describe("runValidation deep XPath on repeat fields", () => {
	it("catches syntax errors in count_bound repeat_count", () => {
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
									kind: "repeat",
									id: "visits",
									label: "Visits",
									repeat_mode: "count_bound",
									repeat_count: "if(true(, 1, 2)",
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "XPATH_SYNTAX")).toBe(true);
	});

	it("catches unknown functions in count_bound repeat_count", () => {
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
									kind: "repeat",
									id: "visits",
									label: "Visits",
									repeat_mode: "count_bound",
									repeat_count: "noSuchFunction(5)",
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "UNKNOWN_FUNCTION")).toBe(true);
	});

	it("catches syntax errors in query_bound ids_query", () => {
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
									kind: "repeat",
									id: "open_cases",
									label: "Open cases",
									repeat_mode: "query_bound",
									data_source: { ids_query: "instance('casedb')//[bad" },
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "XPATH_SYNTAX")).toBe(true);
	});

	it("catches unknown functions in query_bound ids_query", () => {
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
									kind: "repeat",
									id: "open_cases",
									label: "Open cases",
									repeat_mode: "query_bound",
									data_source: { ids_query: "boguscall(#case/x)" },
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "UNKNOWN_FUNCTION")).toBe(true);
	});

	it("does not produce deep XPath errors for valid count_bound repeat_count", () => {
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
									kind: "hidden",
									id: "desired_count",
									calculate: "5",
								}),
								f({
									kind: "repeat",
									id: "visits",
									label: "Visits",
									repeat_mode: "count_bound",
									repeat_count: "#form/desired_count",
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		const xpathRelated = errors.filter(
			(e) =>
				(e.code === "XPATH_SYNTAX" ||
					e.code === "UNKNOWN_FUNCTION" ||
					e.code === "INVALID_REF") &&
				e.location.fieldId === "visits",
		);
		expect(xpathRelated).toEqual([]);
	});

	it("does not produce deep XPath errors for valid query_bound ids_query", () => {
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
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		const xpathRelated = errors.filter(
			(e) =>
				(e.code === "XPATH_SYNTAX" ||
					e.code === "UNKNOWN_FUNCTION" ||
					e.code === "INVALID_REF") &&
				e.location.fieldId === "open_cases",
		);
		expect(xpathRelated).toEqual([]);
	});

	it("whitespace-only repeat_count fires only the empty rule, not deep XPath", () => {
		// The empty-rule layer (`EMPTY_REPEAT_COUNT`) trims whitespace,
		// so it catches `"   "` cleanly. The deep validator's gate must
		// match — without trim symmetry, whitespace double-reports
		// (empty rule + a synthetic deep error from `validateXPath`'s
		// truthy-guarded parser). The deep filter checks the full set
		// of XPath error codes so a future change emitting a different
		// code on whitespace doesn't slip past.
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
									kind: "repeat",
									id: "visits",
									label: "Visits",
									repeat_mode: "count_bound",
									repeat_count: "   ",
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		const visitErrs = errors.filter((e) => e.location.fieldId === "visits");
		expect(visitErrs.some((e) => e.code === "EMPTY_REPEAT_COUNT")).toBe(true);
		const deepCodes: ReadonlySet<string> = new Set([
			"XPATH_SYNTAX",
			"UNKNOWN_FUNCTION",
			"INVALID_REF",
			"INVALID_CASE_REF",
			"WRONG_ARITY",
			"TYPE_ERROR",
			"CYCLE",
		]);
		expect(visitErrs.some((e) => deepCodes.has(e.code))).toBe(false);
	});

	it("whitespace-only ids_query fires only the empty rule, not deep XPath", () => {
		// Symmetric to the count_bound whitespace test above. Same
		// trim-symmetry contract on the query_bound side.
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
									kind: "repeat",
									id: "open_cases",
									label: "Open cases",
									repeat_mode: "query_bound",
									data_source: { ids_query: "\n\t " },
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		const caseErrs = errors.filter((e) => e.location.fieldId === "open_cases");
		expect(caseErrs.some((e) => e.code === "EMPTY_IDS_QUERY")).toBe(true);
		const deepCodes: ReadonlySet<string> = new Set([
			"XPATH_SYNTAX",
			"UNKNOWN_FUNCTION",
			"INVALID_REF",
			"INVALID_CASE_REF",
			"WRONG_ARITY",
			"TYPE_ERROR",
			"CYCLE",
		]);
		expect(caseErrs.some((e) => deepCodes.has(e.code))).toBe(false);
	});

	it("catches references to nonexistent paths in repeat_count", () => {
		// `validateXPath` resolves `#form/...` and `/data/...` references
		// against the form's path set. A reference to a field that
		// doesn't exist surfaces as INVALID_REF — same code class an
		// equivalent typo on a `calculate` would produce.
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
									kind: "repeat",
									id: "visits",
									label: "Visits",
									repeat_mode: "count_bound",
									repeat_count: "/data/nonexistent_field",
									children: [f({ kind: "text", id: "note", label: "Note" })],
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
				(e) => e.code === "INVALID_REF" && e.location.fieldId === "visits",
			),
		).toBe(true);
	});

	it("catches references to nonexistent paths in ids_query", () => {
		// Symmetric to the count_bound INVALID_REF case above. The SA
		// editing a query_bound repeat should get the same error class
		// as editing a count_bound one — same `validateXPath` path, same
		// `INVALID_REF` code, same humanization through
		// `FIELD_NAMES["ids_query"]`.
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
									kind: "repeat",
									id: "open_cases",
									label: "Open cases",
									repeat_mode: "query_bound",
									data_source: {
										ids_query: "/data/nonexistent_field",
									},
									children: [f({ kind: "text", id: "note", label: "Note" })],
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
				(e) => e.code === "INVALID_REF" && e.location.fieldId === "open_cases",
			),
		).toBe(true);
	});

	it("user_controlled repeats produce no deep XPath errors from the new branch", () => {
		// The discriminant guard `repeat_mode === "count_bound" |
		// "query_bound"` is load-bearing — `user_controlled` repeats
		// have no XPath field, so the new branch must skip them
		// cleanly. Without this assertion, a regression that drops the
		// discriminant check (and accidentally calls `validateXPath`
		// on something that doesn't exist) would slip past the other
		// tests.
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
									kind: "repeat",
									id: "members",
									label: "Members",
									repeat_mode: "user_controlled",
									children: [f({ kind: "text", id: "name", label: "Name" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		const memberErrs = errors.filter((e) => e.location.fieldId === "members");
		const deepCodes: ReadonlySet<string> = new Set([
			"XPATH_SYNTAX",
			"UNKNOWN_FUNCTION",
			"INVALID_REF",
			"INVALID_CASE_REF",
			"WRONG_ARITY",
			"TYPE_ERROR",
			"CYCLE",
		]);
		expect(memberErrs.some((e) => deepCodes.has(e.code))).toBe(false);
	});

	it("humanized error message names the user-facing field label", () => {
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
									kind: "repeat",
									id: "visits",
									label: "Visits",
									repeat_mode: "count_bound",
									repeat_count: "if(true(, 1, 2)",
									children: [f({ kind: "text", id: "note", label: "Note" })],
								}),
							],
						},
					],
				},
			],
		});
		const errors = runValidation(doc);
		const syntaxErr = errors.find(
			(e) => e.code === "XPATH_SYNTAX" && e.location.fieldId === "visits",
		);
		expect(syntaxErr).toBeDefined();
		expect(syntaxErr?.message).toContain("repeat count");
	});
});

describe("runValidation — bare-id reference suggestion (group-path DX)", () => {
	// The dominant authoring mistake (build WVbl8blwAsy6CCjBFaJ0: 29 of 30
	// edit calls were this): the SA references a field by its bare id when
	// the field lives inside a group, dropping the group from the path. The
	// humanized error must point at the real `#form/...` path so the SA fixes
	// it in one shot instead of guessing.
	it("suggests the group-qualified #form/ path in the message", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "Register Mother",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "consent_grp",
									label: "Consent",
									children: [
										f({
											kind: "single_select",
											id: "consent",
											label: "Consent given?",
											options: [
												{ value: "yes", label: "Yes" },
												{ value: "no", label: "No" },
											],
										}),
									],
								}),
								// Sibling at the form root references the bare id.
								f({
									kind: "label",
									id: "consent_stop",
									label: "Enrollment stopped.",
									relevant: "#form/consent = 'no'",
								}),
							],
						},
					],
				},
			],
		});
		const refErr = runValidation(doc).find(
			(e) => e.code === "INVALID_REF" && e.location.fieldId === "consent_stop",
		);
		expect(refErr).toBeDefined();
		expect(refErr?.message).toContain("`#form/consent_grp/consent`");
		expect(refErr?.message).toContain("did you mean");
	});
});

// ── Stored-reference classification (INVALID_REF.storedRef) ─────────

describe("INVALID_REF stored-reference classification", () => {
	const makeDoc = (fields: FieldSpec[]) =>
		buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					forms: [{ name: "Quiz form", type: "survey", fields }],
				},
			],
		});

	it("classifies a plain-text #form leaf as raw-text and renders the re-commit repair", () => {
		// `xp` parses with no resolution, so the leaf stays raw text — the
		// shape a migrated legacy expression holds when its reference never
		// re-resolved.
		const doc = makeDoc([
			f({ kind: "int", id: "score", label: "Score" }),
			f({ kind: "hidden", id: "total", calculate: xp("#form/old_score") }),
		]);
		const deepErr = validateBlueprintDeep(doc).find(
			(e): e is Extract<DeepValidationError, { kind: "field-xpath" }> =>
				e.kind === "field-xpath" && e.error.code === "INVALID_REF",
		);
		expect(deepErr?.error.storedRef).toBe("raw-text");

		const rendered = runValidation(doc).find((e) => e.code === "INVALID_REF");
		expect(rendered?.message).toContain('Field "total"');
		expect(rendered?.message).toContain("plain text");
		expect(rendered?.message).toContain("re-commit");
	});

	it("classifies a dangling identity leaf and never prints the bare uuid as a path", () => {
		const ghost = asUuid("dead0000-0000-4000-8000-000000000001");
		const doc = makeDoc([
			f({ kind: "int", id: "score", label: "Score" }),
			f({
				kind: "hidden",
				id: "total",
				calculate: { parts: [{ kind: "field-ref", uuid: ghost }] },
			}),
		]);
		const deepErr = validateBlueprintDeep(doc).find(
			(e): e is Extract<DeepValidationError, { kind: "field-xpath" }> =>
				e.kind === "field-xpath" && e.error.code === "INVALID_REF",
		);
		expect(deepErr?.error.storedRef).toBe("dangling-identity");

		const rendered = runValidation(doc).find((e) => e.code === "INVALID_REF");
		// The carrier + slot are the find-it handle; the uuid is not a path
		// a person can look up, so it must not appear in the prose.
		expect(rendered?.message).toContain('Field "total"');
		expect(rendered?.message).toContain("calculated value");
		expect(rendered?.message).toContain("no longer exists");
		expect(rendered?.message).not.toContain(ghost);
	});

	it("keeps the did-you-mean hint when a raw leaf is the bare-id-for-nested-field mistake", () => {
		// A fresh typo parses to the same raw-leaf shape (parsing is total),
		// so when the leaf id matches an existing nested field the nesting
		// hint stays the repair — re-committing identical text would change
		// nothing.
		const doc = makeDoc([
			f({
				kind: "group",
				id: "grp",
				label: "Group",
				children: [f({ kind: "int", id: "score", label: "Score" })],
			}),
			f({ kind: "hidden", id: "total", calculate: xp("#form/score") }),
		]);
		const rendered = runValidation(doc).find((e) => e.code === "INVALID_REF");
		expect(rendered?.message).toContain("`#form/grp/score`");
		expect(rendered?.message).toContain("did you mean");
		expect(rendered?.message).not.toContain("re-commit");
	});

	it("leaves an unresolved absolute path unclassified — the generic typo prose", () => {
		const doc = makeDoc([
			f({ kind: "int", id: "score", label: "Score" }),
			f({ kind: "hidden", id: "total", calculate: xp("/data/scroe + 1") }),
		]);
		const deepErr = validateBlueprintDeep(doc).find(
			(e): e is Extract<DeepValidationError, { kind: "field-xpath" }> =>
				e.kind === "field-xpath" && e.error.code === "INVALID_REF",
		);
		expect(deepErr?.error.storedRef).toBeUndefined();
		const rendered = runValidation(doc).find((e) => e.code === "INVALID_REF");
		expect(rendered?.message).toContain("Check for a typo");
	});
});
