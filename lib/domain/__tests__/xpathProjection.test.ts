import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { XPathExpression } from "../xpath/ast";
import { printXPath, projectXPath, XPathProjectionError } from "../xpath/print";

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
