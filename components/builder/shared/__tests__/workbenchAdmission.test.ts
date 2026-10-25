import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import {
	and,
	arith,
	concat,
	dateAdd,
	eq,
	literal,
	match,
	matchNone,
	now,
	prop,
	term,
	today,
} from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { editorExpressionContext } from "../editorTypeContext";
import { replaceRuleNodeAtPath } from "../ruleNavigation";
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
							{ name: "note", label: proseText("Note"), data_type: "text" },
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
	it("judges a match subject stored as a bare case property at its own slot", () => {
		// Every subject choice the editor offers is judged at the subject's path
		// while the card renders, so that path must address the stored property.
		const source = match(prop("patient", "note"), "A", "starts-with");
		const slot = context("on-device");
		expect(
			workbenchExpressionAdmission(
				source,
				["property"],
				term(prop("patient", "note")),
				slot,
			),
		).toEqual({ admitted: true });
		expect(
			workbenchExpressionAdmission(
				source,
				["property"],
				concat(term(literal("x")), term(prop("patient", "note"))),
				slot,
			),
		).toEqual({ admitted: true });
		expect(
			workbenchExpressionAdmission(
				source,
				["property"],
				term(prop("patient", "age")),
				slot,
			).admitted,
		).toBe(false);
	});
	it("writes a match subject's case property bare and a calculated subject as its expression", () => {
		const source = match(prop("patient", "note"), "A", "starts-with");
		expect(
			replaceRuleNodeAtPath(source, ["property"], {
				family: "expression",
				value: term(prop("patient", "case_name")),
			}),
		).toEqual(match(prop("patient", "case_name"), "A", "starts-with"));
		const calculated = concat(
			term(literal("x")),
			term(prop("patient", "note")),
		);
		expect(
			replaceRuleNodeAtPath(source, ["property"], {
				family: "expression",
				value: calculated,
			}),
		).toEqual(match(calculated, "A", "starts-with"));
	});
});

describe("a declared platform's refusal reaches the menu", () => {
	const HERE: Expression = { kind: "here" };
	const vocabulary = {
		caseTypes: [],
		currentCaseType: "patient",
		knownInputs: [],
	};

	it("carries the platform for where you are now in a calculated column of an app that runs in Web Apps", () => {
		const fixture = expressionEditorFixture("calculated-column", vocabulary);
		const admission = workbenchExpressionAdmission(
			term(literal("")),
			[],
			HERE,
			fixture.context.expressionContext,
		);
		expect(admission.admitted).toBe(false);
		expect(admission.admitted ? undefined : admission.platform).toEqual({
			feature: "case-list-here",
			platform: "web-apps",
		});
	});

	it("carries no platform for where you are now in a form slot, which its profile refuses", () => {
		const fixture = expressionEditorFixture("operation-write", vocabulary);
		const admission = workbenchExpressionAdmission(
			term(literal("")),
			[],
			HERE,
			fixture.context.expressionContext,
		);
		expect(admission.admitted).toBe(false);
		expect(admission.admitted ? undefined : admission.platform).toBeUndefined();
	});
});
