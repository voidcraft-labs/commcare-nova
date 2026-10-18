import { describe, expect, it } from "vitest";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	formFixture,
	ids,
	requireContext,
} from "@/lib/domain/expression/__tests__/formFixture";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type {
	Expression,
	FieldExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { formLogicFindings } from "../formLogicFindings";
import { runValidation } from "../runner";

const field = (uuid: typeof ids.time): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});
const value = (text: string): Expression => ({
	kind: "term",
	term: { kind: "literal", value: text },
});
describe("time-of-day ordering at an authored slot", () => {
	it.each(["gt", "gte", "lt", "lte"] as const)(
		"refuses %s but retains equality",
		(kind) => {
			const ctx = requireContext(formFixture(), {
				entity: "field",
				uuid: ids.text,
				slot: "relevant",
			});
			expect(
				formLogicFindings(
					{ kind, left: field(ids.time), right: field(ids.time) },
					ctx,
				),
			).toEqual([
				expect.objectContaining({
					code: "XPATH_TIME_ORDERING",
					checkCode: "time-ordering",
					path: [],
				}),
			]);
			expect(
				checkExpression(
					{ kind: "eq", left: field(ids.time), right: value("12:00") },
					ctx,
				).errors,
			).toEqual([]);
		},
	);
	it.each(["relevant", "required", "validate", "default_value"] as const)(
		"keeps the owner of a %s finding",
		(slot) => {
			const ref: FieldExpressionSlotRef = {
				entity: "field",
				uuid: ids.text,
				slot,
			};
			const ctx = requireContext(formFixture(), ref);
			expect(
				formLogicFindings(
					{ kind: "gt", left: field(ids.time), right: field(ids.time) },
					ctx,
				),
			).toContainEqual(
				expect.objectContaining({ code: "XPATH_TIME_ORDERING", slot: ref }),
			);
		},
	);
	it("keeps date ordering and follows a nested time comparison", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.text,
			slot: "relevant",
		});
		expect(
			checkExpression(
				{ kind: "gt", left: field(ids.date), right: { kind: "today" } },
				ctx,
			).errors,
		).toEqual([]);
		expect(
			checkExpression(
				{
					kind: "not",
					clause: { kind: "gt", left: field(ids.time), right: field(ids.time) },
				},
				ctx,
			).errors,
		).toContainEqual(
			expect.objectContaining({
				code: "time-ordering",
				path: ["not", "clause"],
			}),
		);
	});
});

describe("time ordering findings through the complete validator", () => {
	it.each(["field", "form-link", "connect"] as const)(
		"keeps the %s carrier and its accepted equality neighbour",
		(carrier) => {
			const run = (kind: "gt" | "eq") => {
				const doc = formFixture();
				const comparison: Expression = {
					kind,
					left: {
						kind: "term",
						term: {
							kind: "form-case",
							caseType: "patient",
							property: "appointment",
						},
					},
					right: {
						kind: "term",
						term: {
							kind: "form-case",
							caseType: "patient",
							property: "appointment",
						},
					},
				};
				if (carrier === "field") doc.fields[ids.text].relevant = comparison;
				else if (carrier === "form-link") {
					const link = doc.forms[ids.form].formLinks?.[0];
					if (link === undefined)
						throw new Error("The link fixture is missing.");
					link.condition = comparison;
					doc.forms[ids.form].postSubmit = "app_home";
				} else {
					doc.connectType = "deliver";
					doc.forms[ids.form].connect = {
						deliver_unit: { id: "visit", name: "Visit", entity_id: comparison },
					};
				}
				return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			};
			const refused = run("gt");
			expect(refused).toHaveLength(1);
			expect(refused[0]).toMatchObject({
				code: "XPATH_TIME_ORDERING",
				location: { formUuid: ids.form },
				details: { checkCode: "time-ordering" },
			});
			expect(refused[0].location.field).toBe(
				carrier === "field"
					? "relevant"
					: carrier === "form-link"
						? "form_link_condition"
						: "deliver_entity_id",
			);
			expect(run("eq")).toEqual([]);
		},
	);
});
