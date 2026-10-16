// The order plan's options answer for every document, a refused one
// included: the validator reads the plan of a document it then refuses.
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type Column,
	calculatedColumn,
	caseListOrderPlan,
	type Module,
	plainColumn,
} from "@/lib/domain";
import { dateAdd, literal, prop, term, today } from "@/lib/domain/predicate";
import { caseListOrderOptions } from "../orderPlanOptions";

function moduleWith(columns: Column[]): { doc: BlueprintDoc; mod: Module } {
	const order = columns.map((column) => column.uuid);
	const doc = buildDoc({
		appName: "T",
		modules: [
			{
				name: "Clients",
				caseType: "patient",
				caseListConfig: {
					searchInputs: [],
					columns,
					listColumnOrder: order,
					detailColumnOrder: order,
				},
				forms: [],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "dob", label: "Date of birth", data_type: "date" },
				],
			},
		],
	});
	const mod = Object.values(doc.modules)[0];
	return { doc, mod };
}

describe("caseListOrderOptions", () => {
	// A calendar-relative date-add has no on-device spelling, and
	// `CASE_LIST_DATE_ADD_NOT_ON_DEVICE` refuses it.
	const months = (count: number) =>
		dateAdd(today(), "months", term(literal(count)));

	it("gives an expression the on-device emitter refuses a join text, equal only for an equal expression", () => {
		const first = calculatedColumn(testUuid("a"), "Due", months(1), {
			sort: { direction: "asc", priority: 0 },
		});
		const same = calculatedColumn(testUuid("b"), "Due again", months(1));
		const other = calculatedColumn(testUuid("c"), "Later", months(2));
		const { doc, mod } = moduleWith([
			plainColumn(testUuid("name"), "case_name", "Name"),
			first,
			same,
			other,
		]);
		const options = caseListOrderOptions(mod, doc, true);
		expect(options.expressionText(first)).toBe(options.expressionText(same));
		expect(options.expressionText(first)).not.toBe(
			options.expressionText(other),
		);
		const config = mod.caseListConfig;
		if (config === undefined) throw new Error("fixture has a case list");
		const plan = caseListOrderPlan(config, [], options);
		expect(plan.fields.map((field) => field.joinText)).toEqual([
			"case_name",
			options.expressionText(first),
			options.expressionText(same),
			options.expressionText(other),
		]);
		expect(plan.authored).toHaveLength(1);
	});

	it("prints an expression the emitter has a spelling for as its XPath", () => {
		const column = calculatedColumn(
			testUuid("dob"),
			"Born",
			term(prop("patient", "dob")),
		);
		const { doc, mod } = moduleWith([column]);
		expect(caseListOrderOptions(mod, doc, true).expressionText(column)).toBe(
			"dob",
		);
	});
});
