import { describe, expect, it } from "vitest";
import { q } from "../../__tests__/testHelpers";
import { TriggerDag } from "../../preview/engine/triggerDag";
import type { AppBlueprint, CaseType, Question } from "../../schemas/blueprint";
import {
	FUNCTION_REGISTRY,
	findCaseInsensitiveMatch,
} from "../commcare/validate/functionRegistry";
import { validateBlueprintDeep } from "../commcare/validate/index";
import { runValidation } from "../commcare/validate/runner";
import { validateXPath } from "../commcare/validate/xpathValidator";

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

describe("TriggerDag.reportCycles", () => {
	it("returns empty for acyclic graph", () => {
		const dag = new TriggerDag();
		const questions = [
			q({ id: "a", type: "int", label: "A" }),
			q({ id: "b", type: "int", label: "B", calculate: "/data/a + 1" }),
		];
		const cycles = dag.reportCycles(questions);
		expect(cycles).toEqual([]);
	});

	it("detects A→B→A cycle", () => {
		const dag = new TriggerDag();
		const questions = [
			q({ id: "a", type: "int", label: "A", calculate: "/data/b + 1" }),
			q({ id: "b", type: "int", label: "B", calculate: "/data/a + 1" }),
		];
		const cycles = dag.reportCycles(questions);
		expect(cycles.length).toBeGreaterThan(0);
	});

	it("handles diamond dependency (no cycle)", () => {
		const dag = new TriggerDag();
		const questions = [
			q({ id: "a", type: "int", label: "A" }),
			q({ id: "b", type: "int", label: "B", calculate: "/data/a + 1" }),
			q({ id: "c", type: "int", label: "C", calculate: "/data/a + 2" }),
			q({
				id: "d",
				type: "int",
				label: "D",
				calculate: "/data/b + /data/c",
			}),
		];
		const cycles = dag.reportCycles(questions);
		expect(cycles).toEqual([]);
	});
});

// ── Orchestrator Integration ────────────────────────────────────────

describe("validateBlueprintDeep", () => {
	const makeBlueprint = (
		questions: Question[],
		caseTypes: CaseType[] | null = null,
	): AppBlueprint => ({
		app_name: "Test",
		modules: [
			{
				uuid: "module-1-uuid",
				name: "Mod",
				case_type: caseTypes ? "patient" : undefined,
				forms: [
					{
						uuid: "form-1-uuid",
						name: "Form",
						type: "registration" as const,
						questions,
					},
				],
			},
		],
		case_types: caseTypes,
	});

	it("returns no errors for valid blueprint", () => {
		const bp = makeBlueprint(
			[
				q({
					id: "case_name",
					type: "text",
					label: "Name",
					case_property_on: "patient",
				}),
				q({
					id: "age",
					type: "int",
					label: "Age",
					relevant: "/data/case_name != ''",
				}),
			],
			[{ name: "patient", properties: [{ name: "case_name", label: "Name" }] }],
		);
		const errors = validateBlueprintDeep(bp);
		expect(errors).toEqual([]);
	});

	it("catches unknown function in XPath", () => {
		const bp = makeBlueprint([
			q({ id: "name", type: "text", label: "Name" }),
			q({ id: "val", type: "hidden", calculate: "foobar(1)" }),
		]);
		const errors = validateBlueprintDeep(bp);
		expect(errors.some((e) => e.includes("Unknown function"))).toBe(true);
	});

	it("catches wrong arity", () => {
		const bp = makeBlueprint([
			q({ id: "name", type: "text", label: "Name" }),
			q({ id: "val", type: "hidden", calculate: "round(3.14, 2)" }),
		]);
		const errors = validateBlueprintDeep(bp);
		expect(errors.some((e) => e.includes("round()"))).toBe(true);
	});

	it("catches circular dependencies", () => {
		const bp = makeBlueprint([
			q({ id: "a", type: "hidden", calculate: "/data/b + 1" }),
			q({ id: "b", type: "hidden", calculate: "/data/a + 1" }),
		]);
		const errors = validateBlueprintDeep(bp);
		expect(errors.some((e) => e.includes("circular dependency"))).toBe(true);
	});

	it("catches unknown case property in #case/ ref", () => {
		const bp = makeBlueprint(
			[
				q({
					id: "case_name",
					type: "text",
					label: "Name",
					case_property_on: "patient",
				}),
				q({ id: "val", type: "hidden", calculate: "#case/nonexistent + 1" }),
			],
			[{ name: "patient", properties: [{ name: "case_name", label: "Name" }] }],
		);
		const errors = validateBlueprintDeep(bp);
		expect(errors.some((e) => e.includes("Unknown case property"))).toBe(true);
	});
});

// ── Full Integration (runValidation calls deep) ────────────────────

describe("runValidation with deep validation", () => {
	it("catches both rule-based and deep XPath errors", () => {
		const bp: AppBlueprint = {
			app_name: "Test",
			modules: [
				{
					uuid: "module-2-uuid",
					name: "Mod",
					case_type: "patient",
					forms: [
						{
							uuid: "form-1-uuid",
							name: "Reg",
							type: "registration",
							questions: [
								q({
									id: "case_name",
									type: "text",
									label: "Name",
									case_property_on: "patient",
								}),
								q({ id: "calc", type: "hidden", calculate: "foobar(1)" }),
							],
						},
					],
				},
			],
			case_types: [
				{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
			],
		};

		const errors = runValidation(bp);
		expect(errors.some((e) => e.code === "UNKNOWN_FUNCTION")).toBe(true);
	});
});
