import { describe, expect, it } from "vitest";
import {
	expandCaseToWire,
	expandFlatHashtags,
	extractHashtags,
} from "@/lib/commcare/hashtags";
import { escapeRegex } from "@/lib/commcare/xml";

describe("reference projection preserves parsed token boundaries", () => {
	it("expands flat references without changing literals, typed case refs, or neighboring names", () => {
		expect(
			expandFlatHashtags(
				`concat('#form/a', #form/a, #form/ab, "#user/name", #user/role, #patient/age)`,
			),
		).toBe(
			`concat('#form/a', /data/a, /data/ab, "#user/name", instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/role, #patient/age)`,
		);
		expect(expandFlatHashtags("#form/group/a + /data/b")).toBe(
			"/data/group/a + /data/b",
		);
		expect(expandFlatHashtags("")).toBe("");
	});

	it("extracts each case reference once, excluding literal text, form answers and Search answers", () => {
		expect(
			extractHashtags([
				`concat('#patient/fake', #patient/a, #patient/ab, #form/a, #search/name)`,
				`#user/role = #patient/a`,
				`"#user/fake"`,
				"",
			]),
		).toEqual(["#patient/a", "#patient/ab", "#user/role"]);
	});

	it("emits complete parent selectors with a caller-owned starting case and an attribute ID leaf", () => {
		expect(expandCaseToWire(0, "grandparent", "/data/selected")).toBe(
			"instance('casedb')/casedb/case[@case_id = /data/selected]/grandparent",
		);
		expect(expandCaseToWire(1, "case_id", "/data/selected")).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = /data/selected]/index/parent]/@case_id",
		);
		expect(expandCaseToWire(2, "address", "/data/selected")).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = /data/selected]/index/parent]/index/parent]/address",
		);
		expect(expandCaseToWire(0, "", "/data/selected")).toBe(
			"instance('casedb')/casedb/case[@case_id = /data/selected]",
		);
	});

	it("makes enum values literal regex matches, including every regex metacharacter", () => {
		const value = String.raw`a.b+c*d?e^f$g{2}(h)|[i]\j`;
		const expression = new RegExp(`^${escapeRegex(value)}$`);
		expect(expression.test(value)).toBe(true);
		expect(expression.test(value.replace(".", "x"))).toBe(false);
		expect(expression.test(`${value}suffix`)).toBe(false);
	});
});
