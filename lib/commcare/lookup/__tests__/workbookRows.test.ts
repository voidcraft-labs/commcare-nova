/**
 * The workbook a table travels to CommCare HQ in, where HQ's reader nests a
 * heading `a: b` under `a` (`util/workbook_json/excel.py::
 * IteratorJSONReader.set_field_value`) beside the row's own keys
 * (`fixtures/upload/workbook.py::iter_rows`). It would catch a column with
 * value details whose name is one of those keys reaching HQ, where its details
 * land among the row's fields, details, owners or UID.
 */

import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type { LookupColumn } from "@/lib/lookup/types";
import type { LookupTableWireNaming } from "../naming";
import { lookupWorkbookDataHeader, lookupWorkbookShape } from "../workbookRows";

const id = (n: number) =>
	`01890f45-0000-7000-8000-${String(n).padStart(12, "0")}`;

function table(columns: readonly LookupColumn[]): LookupTableWireNaming {
	return {
		tableId: lookupTableIdSchema.parse(id(1)),
		tag: "clinics",
		xformInstanceId: "clinics",
		fixtureId: "item-list:clinics",
		listElementName: "clinics_list",
		rowElementName: "clinics",
		columns,
		wireNameFor: () => "",
		memberNameFor: () => "",
	};
}

function column(n: number, wireName: string, details: boolean): LookupColumn {
	return {
		id: lookupColumnIdSchema.parse(id(10 + n)),
		wireName,
		label: wireName,
		dataType: "text",
		...(details && {
			repeated: true,
			properties: [
				{
					id: lookupMemberIdSchema.parse(id(20 + n)),
					wireName: "lang",
					label: "Language",
				},
			],
		}),
	} as LookupColumn;
}

describe("a column named like a key of HQ's workbook row", () => {
	it.each(["field", "property", "user", "group", "location", "UID"])(
		"holds back “%s” with value details, naming the column",
		(name) => {
			const shape = lookupWorkbookShape(
				table([column(1, name, true), column(2, "other", false)]),
			);
			expect(shape.issue).toContain(`“${name}”`);
		},
	);

	it("sends the same name without details, and any other name with them", () => {
		const scalar = table([column(1, "location", false)]);
		expect(lookupWorkbookShape(scalar).issue).toBeUndefined();
		expect(
			lookupWorkbookDataHeader(scalar, lookupWorkbookShape(scalar)),
		).toEqual(["UID", "Delete(Y/N)", "field: location"]);
		expect(
			lookupWorkbookShape(table([column(1, "name", true)])).issue,
		).toBeUndefined();
	});
});
