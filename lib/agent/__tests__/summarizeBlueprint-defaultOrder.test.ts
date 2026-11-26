/**
 * `summarizeBlueprint` × Default order: every rule the list orders by is
 * listed, an independent calculation beside the column rules, in the order
 * of their shared priorities, each
 * with the handle the tools address it by. A calculation the summary left
 * out would have the SA describe the wrong first ordering and pick a
 * priority the calculation already holds. Documents are admitted by the real
 * gate.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { plainColumn } from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { summarizeBlueprint } from "../summarizeBlueprint";
import { expectAdmittedDoc } from "./admittedFixture";

const VILLAGE = testUuid("summary-village");
const VISITS = testUuid("summary-visits");
const AGE = testUuid("summary-age");

function orderedDoc() {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.columns = [
		...config.columns,
		plainColumn(VILLAGE, "village", "Village", {
			sort: { direction: "asc", priority: 1, comparator: "integer" },
		}),
	];
	config.listColumnOrder = config.columns.map((column) => column.uuid);
	config.detailColumnOrder = config.columns.map((column) => column.uuid);
	return expectAdmittedDoc(
		buildDoc({
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
						{ name: "visits", label: proseText("Visits"), data_type: "int" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...config,
						calculatedSorts: [
							{
								uuid: VISITS,
								expression: term(prop("patient", "visits")),
								direction: "desc",
								priority: 0,
								label: "Visit number",
								comparator: "text",
							},
							{
								uuid: AGE,
								expression: term(prop("patient", "age")),
								direction: "asc",
								priority: 2,
								blanks: "last",
							},
						],
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ id: "notes", kind: "text", label: proseText("Notes") }),
							],
						},
					],
				},
			],
		}),
	);
}

describe("the summary's default order", () => {
	it("lists each independent calculation beside the column rules, in the plan's order", () => {
		const summary = summarizeBlueprint(orderedDoc());
		const block = summary.slice(summary.indexOf("      default_order:"));
		expect(block.split("\n").slice(0, 4)).toEqual([
			"      default_order:",
			`        - ${VISITS}: calculation "Visit number" (descending, compare as text)`,
			`        - ${VILLAGE}: "Village" (ascending, compare as integer)`,
			`        - ${AGE}: unnamed calculation (ascending, blanks last)`,
		]);
	});
});
