import { describe, expect, it } from "vitest";
import {
	analyzeXPathCompatibility,
	analyzeXPathInstanceCompatibility,
} from "../compatibility";

function codes(source: string): string[] {
	return analyzeXPathCompatibility(source, "wire-form").map(
		(finding) => finding.code,
	);
}

describe("JavaRosa executable XPath compatibility", () => {
	it.each([
		"/data/x",
		"/data/x[p]/@id",
		"../x",
		"current()/../@id",
		"current()/../../id",
		"instance('casedb')/casedb/case[@case_type = 'person']/@case_id",
		"child::*",
		"attribute::id",
		"self::node()",
		"parent::node()",
		"current()/parent :: node()/@id",
		"foo.bar/baz.qux",
		"#form/group/value[. != '']",
	])("accepts Core-executable path syntax: %s", (source) => {
		expect(codes(source)).toEqual([]);
	});

	it.each([
		["left | right", "XPATH_UNSUPPORTED_UNION"],
		["//case", "XPATH_UNSUPPORTED_DESCENDANT"],
		["(case)[1]", "XPATH_UNSUPPORTED_FILTER"],
		["rows()[1]/row", "XPATH_UNSUPPORTED_FILTER"],
		["descendant::case", "XPATH_UNSUPPORTED_AXIS"],
		["child::node()", "XPATH_UNSUPPORTED_NODE_TEST"],
		["self::node(1)", "XPATH_UNSUPPORTED_NODE_TEST"],
		["parent::node('x')", "XPATH_UNSUPPORTED_NODE_TEST"],
		["child::ns:*", "XPATH_UNSUPPORTED_NODE_TEST"],
		["ns:*", "XPATH_UNSUPPORTED_NODE_TEST"],
		["@*", "XPATH_UNSUPPORTED_NODE_TEST"],
		["rows()/row", "XPATH_UNSUPPORTED_PATH"],
		["/data/..", "XPATH_UNSUPPORTED_PATH"],
		["a/../b", "XPATH_UNSUPPORTED_PATH"],
		["current()/foo/../bar", "XPATH_UNSUPPORTED_PATH"],
		["current()/../foo/../bar", "XPATH_UNSUPPORTED_PATH"],
		["current()/@id/../bar", "XPATH_UNSUPPORTED_PATH"],
		["child :: x/parent :: node()", "XPATH_UNSUPPORTED_PATH"],
		["$value", "XPATH_UNBOUND_VARIABLE"],
	] as const)("rejects non-executable syntax: %s", (source, code) => {
		expect(codes(source)).toContain(code);
	});

	it("returns safe findings without authored source text", () => {
		const secret = "private_user_value";
		const findings = analyzeXPathCompatibility(`$${secret}`, "preview-form");
		expect(JSON.stringify(findings)).not.toContain(secret);
		expect(findings).toEqual([
			expect.objectContaining({
				code: "XPATH_UNBOUND_VARIABLE",
				severity: "error",
				owner: "preview",
			}),
		]);
	});

	it("assigns unbound wire variables to JavaRosa", () => {
		expect(analyzeXPathCompatibility("$value", "wire-form")[0]?.owner).toBe(
			"java-rosa",
		);
	});

	it("admits random in a Preview-owned form carrier", () => {
		expect(analyzeXPathCompatibility("random()", "preview-form")).toEqual([]);
	});

	it("admits JavaRosa nodeset overloads in Preview-owned carriers", () => {
		expect(
			analyzeXPathCompatibility("concat(/data/items)", "preview-form"),
		).toEqual([]);
		expect(
			analyzeXPathCompatibility("concat(/data/items)", "wire-form"),
		).toEqual([]);
	});

	it("rejects carrier-invalid functions and signatures with safe findings", () => {
		expect(analyzeXPathCompatibility("here()", "wire-form")).toEqual([
			expect.objectContaining({
				code: "XPATH_FUNCTION_UNAVAILABLE",
				owner: "java-rosa",
			}),
		]);
		expect(analyzeXPathCompatibility("random(1)", "wire-form")).toEqual([
			expect.objectContaining({
				code: "XPATH_FUNCTION_SIGNATURE_UNAVAILABLE",
				owner: "java-rosa",
			}),
		]);
	});

	it("admits only document-declared literal secondary instances", () => {
		const allowed = new Set(["casedb", "commcaresession", "people"]);
		expect(
			analyzeXPathInstanceCompatibility(
				"instance('people')/people_list/people",
				"preview-form",
				allowed,
			),
		).toEqual([]);
		const secretId = "private_fixture_name";
		const findings = analyzeXPathInstanceCompatibility(
			`instance('${secretId}')/rows/row`,
			"preview-form",
			allowed,
		);
		expect(findings).toEqual([
			expect.objectContaining({
				code: "XPATH_INSTANCE_UNAVAILABLE",
				owner: "preview",
			}),
		]);
		expect(JSON.stringify(findings)).not.toContain(secretId);
	});

	it.each([
		"instance('casedb')/casedb/case/@case_id",
		"instance('item-list:people')/people_list/people[1]/name",
		"position(instance('casedb')/casedb/case)",
		"instance('casedb')/casedb/case[position() = 1 and @status = 'open']",
		"#person/case_name",
		"#user/role",
		"true()",
	])(
		"admits session expressions with a supplied evaluation context: %s",
		(source) => {
			expect(analyzeXPathCompatibility(source, "preview-session")).toEqual([]);
		},
	);

	it.each([
		".",
		"..",
		"@status",
		"answer",
		"child::answer",
		"self::node()",
		"parent::node()",
		"/data/answer",
		"#form/answer",
		"current()",
		"current()/answer",
		"count(answer)",
		"position()",
		"instance('casedb')/casedb/case[/data/answer = 'yes']",
		"instance('casedb')/casedb/case[#form/answer = 'yes']",
	])(
		"rejects session expressions that need the absent main context: %s",
		(source) => {
			expect(
				analyzeXPathCompatibility(source, "preview-session").map(
					(finding) => finding.code,
				),
			).toContain("XPATH_CARRIER_CONTEXT_UNAVAILABLE");
		},
	);
});
