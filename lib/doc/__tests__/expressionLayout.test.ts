/**
 * The printer's layout: one line when the print fits `LAYOUT_WIDTH`, else
 * every argument list and predicate opened over indented lines, with `and`
 * and `or` starting a line inside them. Layout adds whitespace only, so the
 * laid-out text parses back to the stored tree. The plausible failures: a
 * short expression broken, a long one left on one line, quoted text or a
 * grouping disturbed, and a laid-out print that reads back as another tree.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	f,
	parseFixtureExpression,
} from "@/lib/__tests__/docHelpers";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import { LAYOUT_WIDTH } from "@/lib/domain/expression/print";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";

const CALC = testUuid("layout-calc");
const doc = buildDoc({
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "status", label: "Status" },
				{ name: "first_name", label: "First name" },
				{ name: "last_name", label: "Last name" },
			],
		},
	],
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [f({ uuid: CALC, id: "calc", kind: "hidden" })],
				},
			],
		},
	],
});
const SLOT: ExpressionSlotRef = {
	entity: "field",
	uuid: CALC,
	slot: "calculate",
};

function laidOut(source: string): string {
	const expression = parseFixtureExpression(doc, SLOT, source);
	const text = projectFormExpression(doc, SLOT, expression, "unavailable", {
		layout: true,
	}).text;
	const back = parseFormExpressionForSlot(doc, SLOT, text, "unavailable");
	expect(back.ok && back.expression, text).toEqual(expression);
	return text;
}

describe("the printer's layout", () => {
	it("keeps a print that fits on one line", () => {
		const text = "if(#patient/status = 'active', 'Yes', 'No')";
		expect(text.length).toBeLessThanOrEqual(LAYOUT_WIDTH);
		expect(laidOut(text)).toBe(text);
	});

	it("opens every argument list of a long print over indented lines", () => {
		expect(
			laidOut(
				"if(#patient/status='active',concat(#patient/first_name,' ',#patient/last_name),'Closed')",
			),
		).toBe(
			"if(\n" +
				"    #patient/status = 'active',\n" +
				"    concat(\n" +
				"        #patient/first_name,\n" +
				"        ' ',\n" +
				"        #patient/last_name\n" +
				"    ),\n" +
				"    'Closed'\n" +
				")",
		);
	});

	it("leaves a call with no arguments, quoted text and a meaningful grouping as they are", () => {
		const text = laidOut(
			"if(today() > date(#patient/status), concat(#patient/first_name, ' (', #patient/last_name, ')'), (1 + 2) * 3)",
		);
		expect(text).toContain("today()");
		expect(text).toContain("' ('");
		expect(text).toContain("(1 + 2) * 3");
	});

	it("opens a predicate over lines and starts each and on its own line inside it", () => {
		expect(
			laidOut(
				"count(instance('casedb')/casedb/case[@case_type = 'patient' and @status = 'open' and first_name = 'x'])",
			),
		).toBe(
			"count(\n" +
				"    instance('casedb')/casedb/case[\n" +
				"        @case_type = 'patient'\n" +
				"        and @status = 'open'\n" +
				"        and first_name = 'x'\n" +
				"    ]\n" +
				")",
		);
	});

	it("keeps and on one line at the top", () => {
		const text = laidOut(
			"#patient/status = 'active' and #patient/first_name = 'yes' and #patient/last_name = 'no'",
		);
		expect(text).not.toContain("\n");
	});
});
