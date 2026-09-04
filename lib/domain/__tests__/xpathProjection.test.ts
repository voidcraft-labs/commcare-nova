import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	isXPathExpression,
	type XPathExpression,
	xpathExpressionSchema,
} from "../xpath/ast";
import { printXPath, projectXPath, XPathProjectionError } from "../xpath/print";

describe("XPath expression shape guard", () => {
	it("accepts exactly the canonical schema", () => {
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
