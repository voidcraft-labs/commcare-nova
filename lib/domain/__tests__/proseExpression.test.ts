import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { dateCoerce, formField, term } from "../expression/builders";
import type { Expression } from "../expression/types";
import {
	CATALOG_PROSE_VALUE_MESSAGE,
	catalogProseTemplateSchema,
	PROSE_VALUE_IS_REFERENCE_MESSAGE,
	type ProseReferencePart,
	proseTemplateSchema,
} from "../prose";
import {
	canonicalProseAtom,
	proseAtomExpression,
	proseReferenceExpression,
	proseReferenceOf,
} from "../proseExpression";

const QUESTION = testUuid("prose-expression-question");
const PROPERTY = testUuid("prose-expression-property");

const REFERENCES: readonly ProseReferencePart[] = [
	{ kind: "field-ref", uuid: QUESTION },
	{ kind: "case-ref", caseType: "household", property: "village" },
	{ kind: "user-property-ref", userPropertyUuid: PROPERTY },
	{ kind: "user-ref", property: "commcare_project" },
];

const FORMATTED_DATE: Expression = {
	kind: "format-date",
	date: dateCoerce(term(formField(QUESTION))),
	pattern: "%e %b %Y",
};

describe("one canonical form for a prose atom", () => {
	it("reads every reference part back from its own lowering", () => {
		for (const part of REFERENCES)
			expect(proseReferenceOf(proseReferenceExpression(part))).toEqual(part);
	});

	it("reads a question spelled as an absolute path as its reference", () => {
		const absolute: Expression = {
			kind: "term",
			term: { kind: "field", uuid: QUESTION, spelling: "absolute" },
		};
		expect(canonicalProseAtom(absolute)).toEqual({
			kind: "field-ref",
			uuid: QUESTION,
		});
	});

	it("keeps a relative read, a session copy and a formula as values", () => {
		const relative: Expression = {
			kind: "term",
			term: { kind: "field", uuid: QUESTION, spelling: "relative" },
		};
		const sessionCopy: Expression = {
			kind: "term",
			term: { kind: "session-user-property", userPropertyUuid: PROPERTY },
		};
		for (const expression of [relative, sessionCopy, FORMATTED_DATE]) {
			expect(proseReferenceOf(expression)).toBeUndefined();
			expect(canonicalProseAtom(expression)).toEqual({
				kind: "value",
				expression,
			});
		}
	});

	it("evaluates a value's own expression and a reference's lowering", () => {
		expect(
			proseAtomExpression({ kind: "value", expression: FORMATTED_DATE }),
		).toBe(FORMATTED_DATE);
		expect(
			proseAtomExpression({
				kind: "case-ref",
				caseType: "household",
				property: "village",
			}),
		).toEqual(
			term({ kind: "form-case", caseType: "household", property: "village" }),
		);
	});
});

describe("where a calculated value is admitted", () => {
	it("admits a value in a question's text", () => {
		expect(
			proseTemplateSchema.safeParse({
				parts: [
					{ kind: "text", text: "Visit on " },
					{ kind: "value", expression: FORMATTED_DATE },
				],
			}).success,
		).toBe(true);
	});

	it("refuses a value that only reads one reference, at the part", () => {
		for (const part of REFERENCES) {
			const parsed = proseTemplateSchema.safeParse({
				parts: [{ kind: "value", expression: proseReferenceExpression(part) }],
			});
			expect(parsed.success).toBe(false);
			expect(parsed.error?.issues).toEqual([
				expect.objectContaining({
					path: ["parts", 0, "expression"],
					message: PROSE_VALUE_IS_REFERENCE_MESSAGE,
				}),
			]);
		}
	});

	it("refuses any value in a case property's text", () => {
		const parsed = catalogProseTemplateSchema.safeParse({
			parts: [{ kind: "value", expression: FORMATTED_DATE }],
		});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues).toEqual([
			expect.objectContaining({
				path: ["parts", 0],
				message: CATALOG_PROSE_VALUE_MESSAGE,
			}),
		]);
		expect(
			catalogProseTemplateSchema.safeParse({
				parts: [{ kind: "text", text: "Village" }],
			}).success,
		).toBe(true);
	});
});
