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
		const expr = "if(#patient/status = 'active', 'Yes', 'No')";
		expect(prettyPrintXPath(expr)).toBe(expr);
	});

	it("expands long if() across multiple lines", () => {
		const expr =
			"if(#patient/status = 'active', concat(#patient/first_name, ' ', #patient/last_name), 'Closed')";
		expect(prettyPrintXPath(expr)).toBe(
			"if(\n" +
				"    #patient/status = 'active',\n" +
				"    concat(\n" +
				"        #patient/first_name,\n" +
				"        ' ',\n" +
				"        #patient/last_name\n" +
				"    ),\n" +
				"    'Closed'\n" +
				")",
		);
	});

	it("does not expand empty function calls", () => {
		const expr =
			"if(today() > date(#patient/some_really_long_property_name), concat(#patient/first_name, ' ', #patient/last_name), 'N/A')";
		const result = prettyPrintXPath(expr);
		expect(result).toContain("today()");
		expect(result).not.toContain("today(\n");
	});

	it("does not expand grouping parens", () => {
		const expr =
			"(#patient/age + #patient/bonus_years) * #patient/multiplier_for_some_really_long_calculation_property > #patient/threshold_value";
		const result = prettyPrintXPath(expr);
		expect(result).toContain("(#patient/age + #patient/bonus_years)");
	});

	it("preserves string literals containing parens", () => {
		const expr =
			"if(#patient/status = 'active (current)', concat(#patient/first_name, ' (', #patient/last_name, ')'), 'Inactive (closed)')";
		const result = prettyPrintXPath(expr);
		expect(result).toContain("'active (current)'");
		expect(result).toContain("' ('");
		expect(result).toContain("'Inactive (closed)'");
	});

	it("handles deeply nested calls", () => {
		const expr =
			"if(#patient/a = 'x', if(#patient/b = 'y', concat(#patient/c, ' ', #patient/d, ' ', #patient/e), 'fallback_b'), 'fallback_a')";
		const result = prettyPrintXPath(expr);
		// 3 levels deep: outer if → inner if → concat
		expect(result).toContain("            #patient/c");
	});

	it("stays on one line when under threshold", () => {
		const expr = "concat('a', 'b')";
		expect(prettyPrintXPath(expr)).toBe("concat('a', 'b')");
	});

	it("expands predicates with newlines after [ and before ]", () => {
		const expr =
			"instance('casedb')/casedb/case[@case_type = 'mother' and @status = 'open'][position() = 2]/case_name";
		const result = prettyPrintXPath(expr);
		expect(result).toBe(
			"instance(\n" +
				"    'casedb'\n" +
				")/casedb/case[\n" +
				"    @case_type = 'mother'\n" +
				"    and @status = 'open'\n" +
				"][\n" +
				"    position() = 2\n" +
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
			"#patient/status = 'active' and #patient/enrolled = 'yes' and #patient/age > 18 and #patient/consent = 'yes'";
		const result = prettyPrintXPath(expr);
		// No predicates or function calls — and stays inline
		expect(result).not.toContain("\n");
	});
});
