import { describe, expect, it } from "vitest";
import { f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { blueprintDocSchema } from "@/lib/domain";
import {
	count,
	datetimeCoerce,
	type Expression,
	eq,
	gt,
	literal,
	now,
	prop,
	term,
} from "@/lib/domain/expression";
import { admittedCaseListDoc, findings } from "./caseListRuleFixture";

function candidate(filter: Expression) {
	const base = admittedCaseListDoc({
		fields: [
			f({
				kind: "text",
				id: "nickname",
				label: "Nickname",
				caseWrite: { caseType: "patient", property: "nickname" },
			}),
		],
	});
	const id = base.moduleOrder[0];
	const module = base.modules[id];
	if (!module.caseListConfig) throw new Error("Missing admitted config");
	const doc = {
		...base,
		modules: {
			...base.modules,
			[id]: {
				...module,
				caseListConfig: { ...module.caseListConfig, searchInputs: [], filter },
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}
describe("case-list filter type admission", () => {
	it("admits bounded current type counts as a whole ordinary list filter", () => {
		const restoredRows: Extract<Expression, { kind: "cases" }> = {
			kind: "cases",
			source: "casedb",
			where: [
				eq(
					{ kind: "case-row-type" },
					{ kind: "case-type", caseType: "patient" },
				),
			],
		};
		const restored = count(restoredRows);
		expect(findings(candidate(gt(restored, literal(0))))).toEqual([]);
		const filteredRestored = count({
			...restoredRows,
			where: [
				...restoredRows.where,
				eq(prop("patient", "nickname"), literal("Alice")),
			],
		});
		expect(findings(candidate(gt(restored, literal(1))))).toEqual([]);
		expect(findings(candidate(gt(restored, literal(2))))).toEqual([]);
		expect(findings(candidate(gt(restored, literal(2.5))))).toMatchObject([
			{
				code: "CASE_LIST_FILTER_TYPE_ERROR",
				details: { checkReason: "device-list-restored-type-presence" },
			},
		]);
		expect(findings(candidate(gt(filteredRestored, literal(0))))).toMatchObject(
			[{ code: "CASE_LIST_FILTER_TYPE_ERROR" }],
		);
	});

	it.each(["nickname", "case_name"])(
		"accepts equality using the effective %s property",
		(property) =>
			expect(
				findings(candidate(eq(prop("patient", property), literal("Alice")))),
			).toEqual([]),
	);
	it.each([
		{
			name: "unordered text",
			predicate: gt(prop("patient", "nickname"), literal("M")),
			message: "ordered",
		},
		{
			name: "unknown property",
			predicate: eq(prop("patient", "ghost"), literal("x")),
			message: "Unknown property 'ghost'",
		},
		{
			name: "standard datetime mismatch",
			predicate: eq(prop("patient", "date_opened"), literal("not-a-date")),
			message: "Type mismatch",
		},
	])("$name", ({ predicate, message }) => {
		const errors = findings(candidate(predicate));
		expect(errors.map((error) => error.code)).toEqual([
			"CASE_LIST_FILTER_TYPE_ERROR",
		]);
		expect(errors[0].message).toContain(message);
	});
});

describe("a case-list filter that compares a system date with a moment", () => {
	it.each([
		{
			predicate: eq(
				prop("patient", "date_opened"),
				datetimeCoerce(term(literal("2026-01-01"))),
			),
			comparison: "equality",
			systemDate: "date_opened",
			line: "checks whether the case was opened at an exact moment. On a device CommCare keeps only the day a case was opened, so the two never match. You can wrap both sides in date() to compare days.",
		},
		{
			predicate: gt(prop("patient", "last_modified"), now()),
			comparison: "ordering",
			systemDate: "last_modified",
			line: "compares when the case was last changed with a moment. On a device CommCare keeps only the day a case was last changed, so it can't tell. You can wrap both sides in date() to compare days.",
		},
	])(
		"names the $systemDate $comparison",
		({ predicate, comparison, systemDate, line }) => {
			const errors = findings(candidate(predicate));
			expect(errors).toMatchObject([
				{
					code: "CASE_LIST_FILTER_TYPE_ERROR",
					details: {
						checkCode: "incompatible-values",
						checkReason: "day-only-on-device",
						comparison,
						systemDate,
					},
				},
			]);
			expect(userFacingError(errors[0])).toMatch(
				/^The Cases available setting in /,
			);
			expect(userFacingError(errors[0])).toContain(line);
		},
	);
});
