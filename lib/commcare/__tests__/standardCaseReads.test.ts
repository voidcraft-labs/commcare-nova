import { expect, it } from "vitest";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { caseRowToFormPreload } from "@/lib/preview/engine/caseDataBindingClient";
import type { CaseRow } from "@/lib/preview/engine/caseDataBindingTypes";
import { FormEngine } from "@/lib/preview/engine/formEngine";
import { runValidation } from "../validator/runner";
import { standardCaseReadsFixture } from "./standardCaseReadsFixture";

it("admits and evaluates implicit metadata on the selected record and its parent", () => {
	const doc = standardCaseReadsFixture();
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const rows: CaseRow[] = ["visit", "household"].map((type) => ({
		case_id: `${type}-1`,
		app_id: "metadata-proof",
		case_type: type,
		case_name: `${type} name`,
		owner_id: `${type}-owner`,
		status: type === "visit" ? "open" : "closed",
		external_id: `${type}-external`,
		opened_on: new Date("2026-04-17T12:00:00.000Z"),
		modified_on: new Date("2026-04-18T12:00:00.000Z"),
		closed_on:
			type === "household" ? new Date("2026-04-18T12:00:00.000Z") : null,
		parent_case_id: type === "visit" ? "household-1" : null,
		properties: {},
	}));
	const records = new Map(
		rows.map((row) => [row.case_type, caseRowToFormPreload(row)]),
	);
	const engine = new FormEngine(
		{
			form: doc.forms[formUuid],
			formUuid,
			fields: doc.fields,
			fieldOrder: doc.fieldOrder,
			caseTypes: doc.caseTypes ?? [],
		},
		"visit",
		records,
		null,
		null,
		{ rows, indices: [] },
	);
	for (const [type, properties] of records)
		for (const [property, value] of properties) {
			if (property === "case_type") continue;
			expect(
				engine.getState(`/data/${type}_${property}`).value,
				`${type}.${property}`,
			).toBe(
				property === "date_opened" || property === "last_modified"
					? value.slice(0, 10)
					: value,
			);
		}
});
