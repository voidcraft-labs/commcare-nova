import { describe, expect, it } from "vitest";
import {
	isReservedProperty,
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare/identifierValidation";

describe("wire identifier admission", () => {
	it("preserves valid case types and property names without normalization", () => {
		for (const name of ["patient", "Case_Type2", "case-type"]) {
			expect(validateCaseType(name)).toBe(name);
		}
		for (const name of ["age", "_private", "Full_Name2"]) {
			expect(validatePropertyName(name)).toBe(name);
		}
	});

	it.each([
		"",
		"1case",
		" patient",
		"patient\n",
		"a/b",
		"case' or true()",
		"café",
	])("refuses unsupported case type %j before XPath interpolation", (name) => {
		expect(() => validateCaseType(name)).toThrow(
			`Invalid case type: "${name}"`,
		);
	});

	it.each([
		"",
		"1property",
		" property",
		"property\n",
		"a/b",
		"visit-count",
		"p:q",
	])(
		"refuses property %j outside Nova's emitted element-name vocabulary",
		(name) => {
			expect(() => validatePropertyName(name)).toThrow(
				`Invalid property name: "${name}"`,
			);
		},
	);

	it("distinguishes reserved properties from ordinary and legacy spellings", () => {
		for (const name of [
			"case_id",
			"case_name",
			"owner_id",
			"closed",
			"status",
			"index",
			"parent",
			"xform_id",
		]) {
			expect(isReservedProperty(name), name).toBe(true);
		}
		for (const name of [
			"age",
			"full_name",
			"Case_id",
			"name",
			"external-id",
			"date-opened",
		]) {
			expect(isReservedProperty(name), name).toBe(false);
		}
	});

	it("accepts only exact, non-root answer-element paths", () => {
		for (const path of ["/data/name", "/data/group/age2", "/data/_private"]) {
			expect(validateXFormPath(path)).toBe(path);
		}
		for (const path of [
			"",
			"/name",
			"data/name",
			"/database/name",
			"/data",
			"/data/",
			"/data//name",
			"/data/name/",
			"/data/9name",
			"/data/name/123",
			"/data/@id",
			"/data/x[1]",
			"/data/name\n",
		]) {
			expect(() => validateXFormPath(path), path).toThrow(/Invalid XForm path/);
		}
	});
});
