/**
 * A reading reports every finding in one pass. The contract: two refused
 * expressions in one app make two claims, each at its own registration and
 * under its own entry, beside the expression held between them. The failure
 * this catches: a reading that stops at the first refusal, or folds two
 * refusals into one line.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { readExpressions } from "../index";
import { fieldNamed, readEnv, registration } from "./expressionReadFixture";

describe("every refusal of an app, in one reading", () => {
	it("claims each refused expression at its own registration", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "a", label: "A" }),
								f({ kind: "text", id: "b", label: "B" }),
								f({ kind: "text", id: "c", label: "C" }),
							],
						},
					],
				},
			],
		});
		const relevant = (id: string) =>
			({
				entity: "field",
				uuid: fieldNamed(doc, id),
				slot: "relevant",
			}) as const;
		const pending = [
			registration(doc, relevant("a"), "/data/b | /data/c"),
			registration(doc, relevant("b"), "/data/a = 'x'"),
			registration(doc, relevant("c"), "no-such-function(/data/a)"),
		];
		const reading = readExpressions(doc, pending, readEnv());
		const own = (source: number) =>
			reading.claims.find(
				(claim) =>
					claim.source === source && claim.key === pending[source]?.key,
			);
		expect(own(0)).toMatchObject({
			entryId: "expressions-and-data/union-a-b",
			detail: { reason: "parse:union" },
		});
		expect(own(1)).toMatchObject({ entryId: "questions/bind-relevant" });
		expect(own(2)).toMatchObject({
			entryId: "expressions-and-data/any-other-function-name",
			detail: { reason: "parse:unknown-function" },
		});
		expect(reading.bound[1]).toBeDefined();
		expect(reading.bound[0]).toBeUndefined();
		expect(reading.bound[2]).toBeUndefined();
	});
});
