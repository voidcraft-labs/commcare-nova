import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	isXPathExpression,
	type XPathExpression,
	xpathExpressionSchema,
} from "../xpath/ast";
import {
	printXPath,
	projectXPath,
	XPathProjectionError,
	xpathPrintContext,
} from "../xpath/print";

describe("XPath expression shape guard", () => {
	it("accepts a canonical mixed text and identity expression", () => {
		const expression = xpathExpressionSchema.parse({
			parts: [
				{ kind: "text", text: "count(" },
				{ kind: "field-ref", uuid: testUuid("guard-field") },
				{ kind: "text", text: ")" },
			],
		});
		expect(isXPathExpression(expression)).toBe(true);
	});

	it.each([
		["unknown part kind", { parts: [{ kind: "bogus" }] }],
		["missing leaf field", { parts: [{ kind: "text" }] }],
		[
			"extra leaf field",
			{ parts: [{ kind: "text", text: "1", unexpected: true }] },
		],
		["extra expression field", { parts: [], unexpected: true }],
	])("rejects %s", (_description, value) => {
		expect(isXPathExpression(value)).toBe(false);
	});
});

describe("XPath identity projection", () => {
	it("projects the same identities through current paths and preserves literal source", () => {
		const form = testUuid("projection-form");
		const field = testUuid("projection-field");
		const group = testUuid("projection-group");
		const doc = {
			forms: { [form]: {} },
			fields: { [field]: { id: "age" }, [group]: { id: "details" } },
			fieldOrder: { [form]: [group], [group]: [field] },
		};
		const expression = xpathExpressionSchema.parse({
			parts: [
				{ kind: "text", text: "concat('literal #form/age', " },
				{ kind: "field-ref", uuid: field },
				{ kind: "text", text: ", " },
				{ kind: "path-ref", uuid: field },
				{ kind: "text", text: ")" },
			],
		});
		const original = structuredClone(expression);
		expect(printXPath(expression, xpathPrintContext(doc))).toBe(
			"concat('literal #form/age', #form/details/age, /data/details/age)",
		);
		doc.fields[field].id = "years";
		expect(printXPath(expression, xpathPrintContext(doc))).toBe(
			"concat('literal #form/age', #form/details/years, /data/details/years)",
		);
		expect(expression).toEqual(original);
	});

	it("returns repair state and never prints a missing worker-property UUID", () => {
		const missing = testUuid("missing-xpath-worker-property");
		const expression: XPathExpression = {
			parts: [
				{ kind: "user-property-ref", userPropertyUuid: missing },
				{ kind: "text", text: " = 'north'" },
			],
		};
		const context = {
			fieldPathSegments: () => undefined,
			userPropertySlug: () => undefined,
			searchInputName: () => undefined,
		};

		const projected = projectXPath(expression, context);
		expect(projected).toEqual({
			ok: false,
			text: "#user/[reference needs repair] = 'north'",
			unresolved: [{ kind: "user-property-ref", identity: missing }],
		});
		expect(projected.text).not.toContain(missing);
		expect(() => printXPath(expression, context)).toThrow(XPathProjectionError);
	});
});
