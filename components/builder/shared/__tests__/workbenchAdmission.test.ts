import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import {
	and,
	arith,
	dateAdd,
	eq,
	literal,
	matchNone,
	now,
	prop,
	term,
	today,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { editorExpressionContext } from "../editorTypeContext";
import { workbenchExpressionAdmission } from "../workbenchAdmission";

function context(
	target: "case-search" | "on-device-and-case-search" | "on-device",
) {
	return editorExpressionContext(
		expressionEditorFixture(
			target === "case-search"
				? "search-predicate"
				: target === "on-device-and-case-search"
					? "search-case-filter"
					: "case-filter",
			{
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "age", label: proseText("Age"), data_type: "int" },
							{ name: "score", label: proseText("Score"), data_type: "int" },
							{
								name: "dob",
								label: proseText("Date of birth"),
								data_type: "date",
							},
							{
								name: "last_seen",
								label: proseText("Last seen"),
								data_type: "datetime",
							},
						],
					},
				],
				currentCaseType: "patient",
				knownInputs: [],
			},
		).context,
	);
}
describe("whole-rule expression admission used by the workbench", () => {
	it("checks condition menu candidates at the root and inside a group", () => {
		const first = eq(prop("patient", "age"), literal(1));
		const sibling = eq(prop("patient", "score"), literal(2));
		const replacement = eq(prop("patient", "age"), literal(3));
		const slot = context("on-device");
		expect(workbenchExpressionAdmission(first, [], replacement, slot)).toEqual({
			admitted: true,
		});
		expect(workbenchExpressionAdmission(first, [], matchNone(), slot)).toEqual({
			admitted: true,
		});
		expect(
			workbenchExpressionAdmission(
				and(first, sibling),
				["and", 0],
				replacement,
				slot,
			),
		).toEqual({ admitted: true });
		expect(
			workbenchExpressionAdmission(first, [], term(literal(3)), slot).admitted,
		).toBe(false);
	});
	it.each(["case-search", "on-device-and-case-search"] as const)(
		"refuses a second case source in %s but permits a literal correction",
		(target) => {
			const source = eq(prop("patient", "age"), literal(1));
			expect(
				workbenchExpressionAdmission(
					source,
					["right"],
					term(prop("patient", "score")),
					context(target),
				),
			).toEqual({
				admitted: false,
				reason: expect.stringContaining("already uses case information"),
			});
			expect(
				workbenchExpressionAdmission(
					source,
					["right"],
					term(literal(2)),
					context(target),
				),
			).toEqual({ admitted: true });
			expect(
				workbenchExpressionAdmission(
					source,
					["right"],
					term(prop("patient", "score")),
					context("on-device"),
				),
			).toEqual({ admitted: true });
		},
	);
	it("checks enclosing comparison when the edited source is buried in math", () => {
		const source = eq(
			prop("patient", "age"),
			arith("+", term(literal(1)), term(literal(2))),
		);
		expect(
			workbenchExpressionAdmission(
				source,
				["right", "left"],
				term(prop("patient", "score")),
				context("case-search"),
			).admitted,
		).toBe(false);
		expect(
			workbenchExpressionAdmission(
				source,
				["right", "left"],
				term(literal(3)),
				context("case-search"),
			),
		).toEqual({ admitted: true });
	});
	it("offers correction of historical unsupported sources without re-admitting them", () => {
		const source = eq(prop("patient", "age"), prop("patient", "score"));
		expect(
			workbenchExpressionAdmission(
				source,
				["right"],
				term(prop("patient", "score")),
				context("case-search"),
			).admitted,
		).toBe(false);
		expect(
			workbenchExpressionAdmission(
				source,
				["right"],
				term(literal(2)),
				context("case-search"),
			),
		).toEqual({ admitted: true });
	});
	it("preserves target-specific calendar arithmetic and refuses datetime loss", () => {
		const source = eq(prop("patient", "dob"), today());
		const months = dateAdd(today(), "months", term(literal(1)));
		expect(
			workbenchExpressionAdmission(
				source,
				["right"],
				months,
				context("case-search"),
			),
		).toEqual({ admitted: true });
		expect(
			workbenchExpressionAdmission(
				source,
				["right"],
				months,
				context("on-device"),
			),
		).toEqual({
			admitted: false,
			reason: expect.stringContaining("Month and year"),
		});
		expect(
			workbenchExpressionAdmission(
				source,
				["right"],
				dateAdd(today(), "days", term(literal(1))),
				context("on-device"),
			),
		).toEqual({ admitted: true });
		expect(
			workbenchExpressionAdmission(
				eq(prop("patient", "last_seen"), now()),
				["right"],
				dateAdd(now(), "days", term(literal(1))),
				context("on-device"),
			),
		).toEqual({
			admitted: false,
			reason: expect.stringContaining("time would be lost"),
		});
	});
});
