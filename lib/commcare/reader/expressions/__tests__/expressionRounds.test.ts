/**
 * The rounds of the expression stage end, and end soon: each withdraws a
 * fold site and a slot holds finitely many. The failures this holds: an
 * app's own expressions, read back, taking more than four rounds; a loop
 * that reaches the round limit; a slot equal in one round left unchecked
 * after a later round.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import { EXPRESSION_ROUND_LIMIT, readExpressions } from "../index";
import { printSlot } from "../readExpression";
import { readEnv, registration } from "./expressionReadFixture";

describe("the expression stage's rounds", () => {
	it("reads Nova's own expressions back in a few rounds", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "age", label: "Age", data_type: "int" },
						{ name: "p", label: "P" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [],
						searchInputs: [],
						filter: "p = 'a' or p = 'b'",
					} as never,
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "q1", label: "Q1" }),
								f({
									kind: "int",
									id: "n",
									label: "N",
									relevant: "#form/q1 = 'yes'",
								}),
								f({
									kind: "hidden",
									id: "h",
									calculate: "concat(#form/q1, '-', #patient/p)",
								}),
								f({
									kind: "text",
									id: "q2",
									label: "Q2",
									relevant: "#form/n > 3 and #form/h != 'x'",
									validate: "string-length(.) < 20",
								}),
							],
						},
					],
				},
			],
		});
		const env = readEnv();
		const owners = [
			...Object.keys(doc.fields).map((uuid) => ({
				entity: "field" as const,
				uuid,
			})),
			...Object.keys(doc.forms).map((uuid) => ({
				entity: "form" as const,
				uuid,
			})),
			...Object.keys(doc.modules).map((uuid) => ({
				entity: "module" as const,
				uuid,
			})),
		];
		const pending = owners.flatMap((owner) =>
			expressionSlotValues(doc, owner as never).map(({ ref, expression }) =>
				registration(doc, ref, printSlot(doc, ref, expression, env)),
			),
		);
		expect(pending.length).toBeGreaterThan(3);
		const reading = readExpressions(doc, pending, env);
		expect(reading.rounds).toBeLessThanOrEqual(4);
		expect(reading.rounds).toBeLessThan(EXPRESSION_ROUND_LIMIT);
		expect(reading.circumstances).toEqual([]);
		expect(reading.bound.every((tree) => tree !== undefined)).toBe(true);
	});
});
