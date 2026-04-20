import { describe, expect, it } from "vitest";
import {
	alwaysCondition,
	applicationShell,
	CASE_PROPERTY_REGEX,
	CASE_TYPE_REGEX,
	detailColumn,
	detailPair,
	emptyFormActions,
	escapeRegex,
	escapeXml,
	expandHashtags,
	extractHashtags,
	formShell,
	hasHashtags,
	ifCondition,
	isReservedProperty,
	moduleShell,
	neverCondition,
	RESERVED_CASE_PROPERTIES,
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
	XFORM_PATH_REGEX,
	XML_ELEMENT_NAME_REGEX,
} from "..";

describe("RESERVED_CASE_PROPERTIES", () => {
	it("contains all known reserved words", () => {
		const expected = [
			"case_id",
			"case_name",
			"case_type",
			"name",
			"owner_id",
			"closed",
			"status",
			"type",
			"date",
			"index",
			"parent",
			"external-id",
			"xform_id",
			"xform_ids",
		];
		for (const word of expected) {
			expect(RESERVED_CASE_PROPERTIES.has(word), `missing: ${word}`).toBe(true);
		}
	});

	it("does not contain common user property names", () => {
		expect(RESERVED_CASE_PROPERTIES.has("age")).toBe(false);
		expect(RESERVED_CASE_PROPERTIES.has("full_name")).toBe(false);
	});
});

describe("escapeXml", () => {
	it("escapes XML special characters (single quotes left as-is for double-quoted attrs)", () => {
		expect(escapeXml("a & b < c > d \" e ' f")).toBe(
			"a &amp; b &lt; c &gt; d &quot; e ' f",
		);
	});

	it("handles empty string", () => {
		expect(escapeXml("")).toBe("");
	});
});

describe("escapeRegex", () => {
	it("escapes regex metacharacters", () => {
		expect(escapeRegex("foo.bar+baz")).toBe("foo\\.bar\\+baz");
	});
});

describe("validation regex patterns", () => {
	it("CASE_PROPERTY_REGEX accepts valid names", () => {
		expect(CASE_PROPERTY_REGEX.test("age")).toBe(true);
		expect(CASE_PROPERTY_REGEX.test("full_name")).toBe(true);
		expect(CASE_PROPERTY_REGEX.test("visit-count")).toBe(true);
	});

	it("CASE_PROPERTY_REGEX rejects invalid names", () => {
		expect(CASE_PROPERTY_REGEX.test("123")).toBe(false);
		expect(CASE_PROPERTY_REGEX.test("_underscore")).toBe(false);
		expect(CASE_PROPERTY_REGEX.test("")).toBe(false);
	});

	it("CASE_TYPE_REGEX accepts valid types", () => {
		expect(CASE_TYPE_REGEX.test("patient")).toBe(true);
		expect(CASE_TYPE_REGEX.test("case-type")).toBe(true);
	});

	it("CASE_TYPE_REGEX rejects types starting with digit", () => {
		expect(CASE_TYPE_REGEX.test("1case")).toBe(false);
	});

	it("XML_ELEMENT_NAME_REGEX accepts valid element names", () => {
		expect(XML_ELEMENT_NAME_REGEX.test("age")).toBe(true);
		expect(XML_ELEMENT_NAME_REGEX.test("_private")).toBe(true);
	});

	it("XML_ELEMENT_NAME_REGEX rejects hyphens (invalid in XML elements)", () => {
		expect(XML_ELEMENT_NAME_REGEX.test("visit-count")).toBe(false);
	});

	it("XFORM_PATH_REGEX accepts valid paths", () => {
		expect(XFORM_PATH_REGEX.test("/data/name")).toBe(true);
		expect(XFORM_PATH_REGEX.test("/data/group/question")).toBe(true);
	});

	it("XFORM_PATH_REGEX rejects invalid paths", () => {
		expect(XFORM_PATH_REGEX.test("/name")).toBe(false);
		expect(XFORM_PATH_REGEX.test("data/name")).toBe(false);
	});
});

describe("hashtag expansion", () => {
	it("expandHashtags replaces #case/ with full XPath", () => {
		const result = expandHashtags("#case/total_visits + 1");
		expect(result).toContain("instance('casedb')");
		expect(result).toContain("/total_visits");
		expect(result).not.toContain("#case/");
	});

	it("expandHashtags replaces #user/ with full XPath", () => {
		const result = expandHashtags("#user/role");
		expect(result).toContain("instance('casedb')");
		expect(result).toContain("/role");
		expect(result).not.toContain("#user/");
	});

	it("expandHashtags replaces #form/ with /data/ path", () => {
		expect(expandHashtags("#form/age")).toBe("/data/age");
		expect(expandHashtags("#form/age > 18")).toBe("/data/age > 18");
	});

	it("expandHashtags handles nested #form/ paths", () => {
		expect(expandHashtags("#form/group/question")).toBe("/data/group/question");
		expect(expandHashtags("#form/a/b/c")).toBe("/data/a/b/c");
	});

	it("expandHashtags handles mixed #form/ and #case/ in same expression", () => {
		const result = expandHashtags(
			"if(#form/confirmed = 'yes', #case/name, '')",
		);
		expect(result).toContain("/data/confirmed");
		expect(result).toContain("instance('casedb')");
		expect(result).not.toContain("#form/");
		expect(result).not.toContain("#case/");
	});

	it("expandHashtags leaves plain /data/ paths untouched", () => {
		expect(expandHashtags("/data/age > 18")).toBe("/data/age > 18");
	});

	it("hasHashtags detects presence", () => {
		expect(hasHashtags("#case/name")).toBe(true);
		expect(hasHashtags("#user/role")).toBe(true);
		expect(hasHashtags("#form/age")).toBe(true);
		expect(hasHashtags("plain text")).toBe(false);
		expect(hasHashtags("/data/age")).toBe(false);
	});

	it("extractHashtags collects unique references", () => {
		const result = extractHashtags(["#case/a + #case/b", "#user/c + #case/a"]);
		expect(result).toContain("#case/a");
		expect(result).toContain("#case/b");
		expect(result).toContain("#user/c");
		expect(result).toHaveLength(3);
	});

	it("extractHashtags does not include #form/ refs (not in transforms map)", () => {
		const result = extractHashtags(["#form/age + #case/name"]);
		expect(result).toContain("#case/name");
		expect(result).not.toContain("#form/age");
		expect(result).toHaveLength(1);
	});
});

describe("validation functions", () => {
	it("validateCaseType passes valid types", () => {
		expect(validateCaseType("patient")).toBe("patient");
	});

	it("validateCaseType throws on invalid", () => {
		expect(() => validateCaseType("123")).toThrow();
	});

	it("validateXFormPath passes valid paths", () => {
		expect(validateXFormPath("/data/name")).toBe("/data/name");
	});

	it("validateXFormPath throws on invalid", () => {
		expect(() => validateXFormPath("/name")).toThrow();
	});

	it("validatePropertyName passes valid names", () => {
		expect(validatePropertyName("age")).toBe("age");
	});

	it("validatePropertyName throws on invalid", () => {
		expect(() => validatePropertyName("123")).toThrow();
	});

	it("isReservedProperty returns correct results", () => {
		expect(isReservedProperty("name")).toBe(true);
		expect(isReservedProperty("age")).toBe(false);
	});
});

describe("shell factories", () => {
	it("neverCondition produces correct shape", () => {
		const c = neverCondition();
		expect(c.type).toBe("never");
		expect(c.doc_type).toBe("FormActionCondition");
	});

	it("alwaysCondition produces correct shape", () => {
		const c = alwaysCondition();
		expect(c.type).toBe("always");
	});

	it("ifCondition produces correct shape", () => {
		const c = ifCondition("/data/q", "yes");
		expect(c.type).toBe("if");
		expect(c.question).toBe("/data/q");
		expect(c.answer).toBe("yes");
		expect(c.operator).toBe("=");
	});

	it("emptyFormActions has all required fields", () => {
		const a = emptyFormActions();
		expect(a.doc_type).toBe("FormActions");
		expect(a.open_case.condition.type).toBe("never");
		expect(a.subcases).toEqual([]);
	});

	it("detailPair builds short and long details", () => {
		const cols = [detailColumn("age", "Age")];
		const dp = detailPair(cols);
		expect(dp.doc_type).toBe("DetailPair");
		expect(dp.short.columns).toHaveLength(1);
		expect(dp.short.columns[0].field).toBe("age");
		expect(dp.long.columns).toHaveLength(0);
	});

	it("applicationShell produces correct structure", () => {
		const app = applicationShell("Test", [], {});
		expect(app.doc_type).toBe("Application");
		expect(app.name).toBe("Test");
		expect(app.langs).toEqual(["en"]);
	});

	it("formShell produces correct structure", () => {
		const f = formShell(
			"id1",
			"My Form",
			"urn:x",
			"none",
			emptyFormActions(),
			{},
		);
		expect(f.doc_type).toBe("Form");
		expect(f.name.en).toBe("My Form");
		expect(f.xmlns).toBe("urn:x");
	});

	it("moduleShell produces correct structure", () => {
		const m = moduleShell("id1", "My Module", "patient", [], detailPair([]));
		expect(m.doc_type).toBe("Module");
		expect(m.case_type).toBe("patient");
	});
});
