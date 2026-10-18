import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	formFixture,
	ids,
	requireContext,
} from "@/lib/domain/expression/__tests__/formFixture";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import { checkFormLogicSlot, formLogicFindings } from "../formLogicFindings";

describe("stored expression profile admission", () => {
	const ctx = requireContext(formFixture(), {
		entity: "field",
		uuid: ids.hidden,
		slot: "calculate",
	});
	it.each([true, null, `both ' and "`])(
		"refuses an unspellable form literal %s",
		(value) => {
			expect(
				checkExpression({ kind: "term", term: { kind: "literal", value } }, ctx)
					.errors,
			).toContainEqual(
				expect.objectContaining({
					code: "arm-unavailable",
					reason: "literal-not-spellable",
				}),
			);
		},
	);
	it.each(["here", "choice-name"] as const)(
		"presents the held %s arm through the shared checker",
		(kind) => {
			const expression = (
				kind === "here"
					? { kind }
					: {
							kind,
							value: { kind: "term", term: { kind: "literal", value: "yes" } },
							field: ids.choice,
						}
			) as Expression;
			expect(formLogicFindings(expression, ctx)).toContainEqual(
				expect.objectContaining({
					code: "XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
					checkCode: "arm-unavailable",
					reason: kind,
				}),
			);
		},
	);
	it("checks function arity without storing source syntax", () => {
		expect(
			checkExpression({ kind: "call", fn: "round", args: [] }, ctx).errors,
		).toContainEqual(
			expect.objectContaining({
				code: "arm-unavailable",
				reason: "function-arity",
			}),
		);
	});
	it("refuses a removed static choice default and accepts its current value", () => {
		const defaults = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.choice,
			slot: "default_value",
		});
		expect(
			formLogicFindings(
				{ kind: "term", term: { kind: "literal", value: "missing" } },
				defaults,
			),
		).toContainEqual(
			expect.objectContaining({ code: "SELECT_DEFAULT_NOT_AN_OPTION" }),
		);
		expect(
			checkExpression(
				{ kind: "term", term: { kind: "literal", value: "yes" } },
				defaults,
			).errors,
		).toEqual([]);
	});
	it("names a removed choice without claiming its question disappeared", () => {
		const doc = formFixture();
		const field = doc.fields[ids.choice];
		if (field.kind !== "single_select" || field.optionsSource.kind !== "inline")
			throw new Error("The choice fixture is missing.");
		field.optionsSource.options[0].uuid = testUuid("replacement-choice");
		const findings = checkFormLogicSlot(
			doc,
			{
				entity: "field",
				uuid: ids.hidden,
				slot: "calculate",
			},
			{
				kind: "term",
				term: { kind: "choice", field: ids.choice, options: [ids.option] },
			},
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			code: "INVALID_REF",
			details: {
				storedRef: "dangling-identity",
				identity: "choice",
				choiceFieldName: "choice",
			},
		});
		expect(findings[0].message).toContain(
			'uses a choice that "choice" no longer has',
		);
		expect(userFacingError(findings[0])).toContain(
			'uses a choice that "choice" no longer has',
		);
		expect(findings[0].message).not.toContain(ids.option);
	});
});
