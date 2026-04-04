import { describe, expect, it } from "vitest";
import { formatXPath, prettyPrintXPath } from "../xpath-format";

describe("formatXPath", () => {
	it("normalizes spacing around operators", () => {
		expect(formatXPath("a+b")).toBe("a + b");
		expect(formatXPath("a   =   b")).toBe("a = b");
	});

	it("normalizes spacing after commas", () => {
		expect(formatXPath("concat('a','b','c')")).toBe("concat('a', 'b', 'c')");
	});

	it("returns empty/whitespace unchanged", () => {
		expect(formatXPath("")).toBe("");
		expect(formatXPath("   ")).toBe("   ");
	});

	it("returns parse errors unchanged", () => {
		expect(formatXPath("(((")).toBe("(((");
	});
});

describe("prettyPrintXPath", () => {
	it("returns short expressions on one line", () => {
		const expr = "if(#case/status = 'active', 'Yes', 'No')";
		expect(prettyPrintXPath(expr)).toBe(expr);
	});

	it("expands long if() across multiple lines", () => {
		const expr =
			"if(#case/status = 'active', concat(#case/first_name, ' ', #case/last_name), 'Closed')";
		expect(prettyPrintXPath(expr)).toBe(
			"if(\n" +
				"    #case/status = 'active',\n" +
				"    concat(\n" +
				"        #case/first_name,\n" +
				"        ' ',\n" +
				"        #case/last_name\n" +
				"    ),\n" +
				"    'Closed'\n" +
				")",
		);
	});

	it("does not expand empty function calls", () => {
		const expr =
			"if(today() > date(#case/some_really_long_property_name), concat(#case/first_name, ' ', #case/last_name), 'N/A')";
		const result = prettyPrintXPath(expr);
		expect(result).toContain("today()");
		expect(result).not.toContain("today(\n");
	});

	it("does not expand grouping parens", () => {
		const expr =
			"(#case/age + #case/bonus_years) * #case/multiplier_for_some_really_long_calculation_property > #case/threshold_value";
		const result = prettyPrintXPath(expr);
		expect(result).toContain("(#case/age + #case/bonus_years)");
	});

	it("preserves string literals containing parens", () => {
		const expr =
			"if(#case/status = 'active (current)', concat(#case/first_name, ' (', #case/last_name, ')'), 'Inactive (closed)')";
		const result = prettyPrintXPath(expr);
		expect(result).toContain("'active (current)'");
		expect(result).toContain("' ('");
		expect(result).toContain("'Inactive (closed)'");
	});

	it("handles deeply nested calls", () => {
		const expr =
			"if(#case/a = 'x', if(#case/b = 'y', concat(#case/c, ' ', #case/d, ' ', #case/e), 'fallback_b'), 'fallback_a')";
		const result = prettyPrintXPath(expr);
		// 3 levels deep: outer if → inner if → concat
		expect(result).toContain("            #case/c");
	});

	it("stays on one line when under threshold", () => {
		const expr = "concat('a', 'b')";
		expect(prettyPrintXPath(expr)).toBe("concat('a', 'b')");
	});

	it("expands predicates with newlines after [ and before ]", () => {
		const expr =
			"instance('casedb')/casedb/case[@case_type = 'mother' and @status = 'open'][last()]/case_name";
		const result = prettyPrintXPath(expr);
		expect(result).toBe(
			"instance(\n" +
				"    'casedb'\n" +
				")/casedb/case[\n" +
				"    @case_type = 'mother'\n" +
				"    and @status = 'open'\n" +
				"][\n" +
				"    last()\n" +
				"]/case_name",
		);
	});

	it("breaks and/or onto new lines inside predicates", () => {
		const expr =
			"instance('casedb')/casedb/case[@case_type = 'household' and @status = 'open' and @owner_id = #user/id]";
		const result = prettyPrintXPath(expr);
		// Each and should start a new line at the same indent level
		expect(result).toContain(
			"'household'\n    and @status = 'open'\n    and @owner_id",
		);
	});

	it("does not break and/or at top level", () => {
		const expr =
			"#case/status = 'active' and #case/enrolled = 'yes' and #case/age > 18 and #case/consent = 'yes'";
		const result = prettyPrintXPath(expr);
		// No predicates or function calls — and stays inline
		expect(result).not.toContain("\n");
	});
});
