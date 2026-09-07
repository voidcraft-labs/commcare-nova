import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { arith, literal, term } from "@/lib/domain/predicate";
import { reduceCaseTargetDraft } from "../caseTargetDraft";

const owner = {
	formUuid: testUuid("form"),
	operationUuid: testUuid("operation"),
};
describe("operation target draft ownership", () => {
	it("opens an empty local expression and preserves subsequent work when another surface begins it", () => {
		const initial = reduceCaseTargetDraft(null, { type: "begin", ...owner });
		expect(initial).toStrictEqual({ ...owner, expression: term(literal("")) });
		const expression = arith("+", term(literal(1)), term(literal(2)));
		const edited = reduceCaseTargetDraft(initial, {
			type: "update",
			...owner,
			expression,
		});
		expect(edited?.expression).toBe(expression);
		expect(reduceCaseTargetDraft(edited, { type: "begin", ...owner })).toBe(
			edited,
		);
		expect(
			reduceCaseTargetDraft(edited, { type: "clear", ...owner }),
		).toBeNull();
	});
	for (const replacement of [
		{ ...owner, formUuid: testUuid("other form") },
		{ ...owner, operationUuid: testUuid("other operation") },
	])
		it(`ignores stale updates and clears after switching ${replacement.formUuid === owner.formUuid ? "operation" : "form"}`, () => {
			const old = reduceCaseTargetDraft(null, { type: "begin", ...owner });
			const next = reduceCaseTargetDraft(old, {
				type: "begin",
				...replacement,
			});
			expect(next).toStrictEqual({
				...replacement,
				expression: term(literal("")),
			});
			expect(
				reduceCaseTargetDraft(next, {
					type: "update",
					...owner,
					expression: term(literal("late")),
				}),
			).toBe(next);
			expect(reduceCaseTargetDraft(next, { type: "clear", ...owner })).toBe(
				next,
			);
		});
	it("cannot create a draft by updating or clearing an absent owner", () => {
		expect(
			reduceCaseTargetDraft(null, {
				type: "update",
				...owner,
				expression: term(literal("late")),
			}),
		).toBeNull();
		expect(reduceCaseTargetDraft(null, { type: "clear", ...owner })).toBeNull();
	});
});
