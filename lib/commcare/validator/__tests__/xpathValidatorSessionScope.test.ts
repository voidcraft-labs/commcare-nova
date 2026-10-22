import { describe, expect, it } from "vitest";
import {
	formFixture,
	ids,
	requireContext,
} from "@/lib/domain/expression/__tests__/formFixture";
import type { Expression } from "@/lib/domain/expression/types";
import {
	formLogicFindings,
	SESSION_FORM_READ_MESSAGE,
} from "../formLogicFindings";

describe("form-link evaluation after the form closes", () => {
	const doc = formFixture();
	const ctx = requireContext(doc, {
		entity: "form",
		uuid: ids.form,
		slot: "form_link_condition",
		member: { linkUuid: ids.link },
	});
	it.each([undefined, "absolute", "current"] as const)(
		"refuses a question reference regardless of spelling %s",
		(spelling) => {
			const expr: Expression = {
				kind: "term",
				term: {
					kind: "field",
					uuid: ids.text,
					...(spelling === undefined ? {} : { spelling }),
				},
			};
			expect(formLogicFindings(expr, ctx)).toEqual([
				expect.objectContaining({
					code: "INVALID_REF",
					message: SESSION_FORM_READ_MESSAGE,
				}),
			]);
		},
	);
	it("accepts the source entry's selected case and ordinary worker information", () => {
		for (const expr of [
			{
				kind: "term",
				term: {
					kind: "session-datum",
					datum: { kind: "selected-case", module: ids.module },
				},
			},
			{ kind: "term", term: { kind: "session-user", field: "username" } },
		] satisfies Expression[])
			expect(formLogicFindings(expr, ctx)).toEqual([]);
	});
	it("refuses an identity its entry does not supply", () => {
		expect(
			formLogicFindings(
				{
					kind: "term",
					term: { kind: "session-datum", datum: { kind: "new-case" } },
				},
				ctx,
			),
		).toEqual([
			expect.objectContaining({
				code: "SESSION_DATUM_NOT_SUPPLIED",
				checkCode: "datum-not-supplied",
				details: expect.objectContaining({
					carrier: "form-link",
					reason: "new-case",
				}),
			}),
		]);
	});
});
