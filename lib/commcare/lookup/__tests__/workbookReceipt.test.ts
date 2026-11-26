/**
 * The row CommCare HQ holds once Nova's copy of a table is in place
 * (`workbookReceipt.ts::intendedHqRow`), which a publish compares with what
 * HQ answers. HQ's row tells three states of a field apart that its restore
 * writes as two (`fixturegenerators.py::ItemListsProvider.to_xml`): a field
 * the row does not hold (no key; one empty element), a field it holds no value
 * of (an empty list; no element) and an empty value (one empty value; one
 * empty element). The plausible failure: the receipt read off the worker
 * fixture alone, which gives the absent field one empty value, so a table
 * brought in from HQ with such a row never matches HQ's own answer and a
 * publish takes HQ's unchanged table for a changed one.
 */
import { describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupRowIdSchema,
} from "@/lib/domain/lookupIds";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { lookupWireNaming } from "../naming";
import { intendedHqRow } from "../workbookReceipt";
import { wireTable, wireUuid } from "./lookupWireCorpus";

const ID = lookupColumnIdSchema.parse(wireUuid("receipt-id"));
const NOTE = lookupColumnIdSchema.parse(wireUuid("receipt-note"));
const LANG = lookupMemberIdSchema.parse(wireUuid("receipt-lang"));
const CODE = lookupMemberIdSchema.parse(wireUuid("receipt-code"));

const definition: LookupTableDefinition = {
	...wireTable("crops", [{ name: "id", type: "text" }]),
	columns: [
		{ id: ID, wireName: "id", label: "Id", dataType: "text" },
		{
			id: NOTE,
			wireName: "note",
			label: "Note",
			dataType: "text",
			repeated: true,
			properties: [{ id: LANG, wireName: "lang", label: "Language" }],
		},
	],
	attributes: [{ id: CODE, wireName: "code", label: "Code" }],
};
const naming = lookupWireNaming([definition]).tableFor(definition.id);

function row(occurrences?: LookupFixtureRow["occurrences"]): LookupFixtureRow {
	return {
		id: lookupRowIdSchema.parse(wireUuid("receipt-row")),
		values: { [ID]: "" },
		attributes: { [CODE]: "c-1" },
		...(occurrences === undefined ? {} : { occurrences }),
	};
}

describe("the row CommCare HQ holds of Nova's copy", () => {
	it("keeps a field the row does not hold, one of no value and an empty value apart", () => {
		expect(intendedHqRow(naming, row()).fields).toEqual({
			id: [{ value: "", properties: {} }],
		});
		expect(intendedHqRow(naming, row({ [NOTE]: [] })).fields).toEqual({
			id: [{ value: "", properties: {} }],
			note: [],
		});
		expect(
			intendedHqRow(
				naming,
				row({ [NOTE]: [{ text: "", properties: { [LANG]: "en" } }] }),
			).fields,
		).toEqual({
			id: [{ value: "", properties: {} }],
			note: [{ value: "", properties: { lang: "en" } }],
		});
	});

	it("keeps the row's attributes", () => {
		expect(intendedHqRow(naming, row()).itemAttributes).toEqual({
			code: "c-1",
		});
	});
});
