import { describe, expect, it } from "vitest";
import {
	arith,
	dateAdd,
	eq,
	literal,
	now,
	prop,
	term,
	today,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildEditorTypeContext } from "../editorTypeContext";
import { workbenchExpressionAdmission } from "../workbenchAdmission";

const context = buildEditorTypeContext({
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "age", label: proseText("Age"), data_type: "int" },
				{ name: "score", label: proseText("Score"), data_type: "int" },
				{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
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
});
describe("whole-rule expression admission used by the workbench", () => {
	it.each(["case-search", "on-device-and-case-search"] as const)(
		"refuses a second case source in %s but permits a literal correction",
		(target) => {
			const source = eq(prop("patient", "age"), literal(1));
			expect(
				workbenchExpressionAdmission(
					source,
					["right"],
					term(prop("patient", "score")),
					target,
					context,
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
					target,
					context,
				),
			).toEqual({ admitted: true });
			expect(
				workbenchExpressionAdmission(
					source,
					["right"],
					term(prop("patient", "score")),
					"on-device",
					context,
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
				"case-search",
				context,
			).admitted,
		).toBe(false);
		expect(
			workbenchExpressionAdmission(
				source,
				["right", "left"],
				term(literal(3)),
				"case-search",
				context,
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
				"case-search",
				context,
			).admitted,
		).toBe(false);
		expect(
			workbenchExpressionAdmission(
				source,
				["right"],
				term(literal(2)),
				"case-search",
				context,
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
				"case-search",
				context,
			),
		).toEqual({ admitted: true });
		expect(
			workbenchExpressionAdmission(
				source,
				["right"],
				months,
				"on-device",
				context,
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
				"on-device",
				context,
			),
		).toEqual({ admitted: true });
		expect(
			workbenchExpressionAdmission(
				eq(prop("patient", "last_seen"), now()),
				["right"],
				dateAdd(now(), "days", term(literal(1))),
				"on-device",
				context,
			),
		).toEqual({
			admitted: false,
			reason: expect.stringContaining("time would be lost"),
		});
	});
});
