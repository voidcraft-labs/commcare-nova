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
	expandCaseToWire,
	expandFlatHashtags,
	extractHashtags,
	formShell,
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
			"owner_id",
			"closed",
			"status",
			"type",
			"date",
			"index",
			"parent",
			"xform_id",
			"xform_ids",
		];
		for (const word of expected) {
			expect(RESERVED_CASE_PROPERTIES.has(word), `missing: ${word}`).toBe(true);
		}
	});

	it.each(["name", "external-id", "date-opened"])(
		"does not retain the domain-rejected spelling %s as a live reserved lookup",
		(word) => {
			expect(RESERVED_CASE_PROPERTIES.has(word)).toBe(false);
		},
	);

	it("does not contain common user property names", () => {
		expect(RESERVED_CASE_PROPERTIES.has("age")).toBe(false);
		expect(RESERVED_CASE_PROPERTIES.has("full_name")).toBe(false);
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
		expect(XFORM_PATH_REGEX.test("/data/group/age")).toBe(true);
	});

	it("XFORM_PATH_REGEX rejects invalid paths", () => {
		expect(XFORM_PATH_REGEX.test("/name")).toBe(false);
		expect(XFORM_PATH_REGEX.test("data/name")).toBe(false);
	});
});

describe("hashtag expansion", () => {
	it("projects an own-case typed ref to the exact private wire selector", () => {
		expect(expandCaseToWire(0, "edd")).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/edd",
		);
	});

	it("projects an ancestor typed ref through index/parent", () => {
		const result = expandCaseToWire(1, "edd");
		// One index-walk to the parent case, property read off it, no literal
		// `parent` child element.
		expect(result.split("/index/parent").length - 1).toBe(1);
		expect(result).not.toContain("/parent/edd"); // not a literal child step
		expect(result.endsWith("]/edd")).toBe(true);
	});

	it("projects a grandparent typed ref via two index/parent hops", () => {
		const result = expandCaseToWire(2, "address");
		expect(result.split("/index/parent").length - 1).toBe(2);
		expect(result.endsWith("]/address")).toBe(true);
	});

	it("keeps a property named grandparent as a property", () => {
		const result = expandCaseToWire(0, "grandparent");
		expect(result).not.toContain("/index/parent");
		expect(result.endsWith("]/grandparent")).toBe(true);
	});

	it("expands #user/ with the flat authored resolver", () => {
		const result = expandFlatHashtags("#user/role");
		expect(result).toContain("instance('casedb')");
		expect(result).toContain("/role");
		expect(result).not.toContain("#user/");
	});

	it("expands #form/ with the flat authored resolver", () => {
		expect(expandFlatHashtags("#form/age")).toBe("/data/age");
		expect(expandFlatHashtags("#form/age > 18")).toBe("/data/age > 18");
	});

	it("expands nested #form/ paths", () => {
		expect(expandFlatHashtags("#form/group/age")).toBe("/data/group/age");
		expect(expandFlatHashtags("#form/a/b/c")).toBe("/data/a/b/c");
	});

	it("expands mixed #form/ and #user/ refs", () => {
		const result = expandFlatHashtags(
			"if(#form/confirmed = 'yes', #user/username, '')",
		);
		expect(result).toContain("/data/confirmed");
		expect(result).toContain("instance('casedb')");
		expect(result).not.toContain("#form/");
		expect(result).not.toContain("#user/");
	});

	it("leaves plain /data/ paths untouched", () => {
		expect(expandFlatHashtags("/data/age > 18")).toBe("/data/age > 18");
	});

	it("extractHashtags collects unique references", () => {
		const result = extractHashtags([
			"#patient/a + #patient/b",
			"#user/c + #patient/a",
		]);
		expect(result).toContain("#patient/a");
		expect(result).toContain("#patient/b");
		expect(result).toContain("#user/c");
		expect(result).toHaveLength(3);
	});

	it("extractHashtags does not include #form/ refs (not in transforms map)", () => {
		const result = extractHashtags(["#form/age + #patient/name"]);
		expect(result).toContain("#patient/name");
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
		expect(isReservedProperty("case_id")).toBe(true);
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
			"default",
			null,
			[],
		);
		expect(f.doc_type).toBe("Form");
		expect(f.post_form_workflow).toBe("default");
		expect(f.post_form_workflow_fallback).toBeNull();
		expect(f.form_links).toEqual([]);
		expect(f.name.en).toBe("My Form");
		expect(f.xmlns).toBe("urn:x");
	});

	it("moduleShell produces correct structure", () => {
		const m = moduleShell("id1", "My Module", "patient", [], detailPair([]));
		expect(m.doc_type).toBe("Module");
		expect(m.case_type).toBe("patient");
	});
});
