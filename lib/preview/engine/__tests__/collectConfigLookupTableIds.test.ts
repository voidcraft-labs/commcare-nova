// The action-boundary sweep deciding which lookup tables a query
// payload's SQL-bound slots and scalar expressions reference — the
// gate for loading definitions (SQL compile) and fixture rows
// (scalar fold) per request.

import { describe, expect, it } from "vitest";
import type {
	CaseListConfig,
	LookupColumnId,
	LookupTableId,
} from "@/lib/domain";
import {
	eq,
	literal,
	prop,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { collectConfigLookupTableIds } from "../caseDataBindingHelpers";

const TABLE_A = "018f0000-0000-7000-8000-00000000000a" as LookupTableId;
const TABLE_B = "018f0000-0000-7000-8000-00000000000b" as LookupTableId;
const TABLE_C = "018f0000-0000-7000-8000-00000000000c" as LookupTableId;
const COL = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;

const lookupOf = (table: LookupTableId) =>
	tableLookup(table, COL, eq(term(tableColumn(table, COL)), literal("x")));

describe("collectConfigLookupTableIds", () => {
	it("collects from filter, calculated columns, advanced predicates, and extras", () => {
		const config = {
			columns: [
				{
					uuid: "018f0000-0000-7000-8000-00000000d001",
					kind: "calculated",
					label: "Calc",
					expression: lookupOf(TABLE_B),
					order: 1,
				},
			],
			filter: eq(lookupOf(TABLE_A), literal("v")),
			searchInputs: [
				{
					uuid: "018f0000-0000-7000-8000-00000000d002",
					kind: "advanced",
					name: "q",
					label: "Q",
					type: "text",
					order: 1,
					predicate: eq(lookupOf(TABLE_C), literal("w")),
				},
			],
		} as unknown as CaseListConfig;

		expect(collectConfigLookupTableIds(config, [lookupOf(TABLE_A)])).toEqual([
			TABLE_A,
			TABLE_B,
			TABLE_C,
		]);
	});

	it("returns empty for a carrier-free payload", () => {
		const config = {
			columns: [],
			filter: eq(prop("patient", "status"), literal("open")),
			searchInputs: [],
		} as unknown as CaseListConfig;
		expect(collectConfigLookupTableIds(config)).toEqual([]);
		expect(collectConfigLookupTableIds(undefined)).toEqual([]);
	});

	it("collects a lookup nested inside another lookup's where", () => {
		const nested = tableLookup(
			TABLE_A,
			COL,
			eq(term(tableColumn(TABLE_A, COL)), lookupOf(TABLE_B)),
		);
		const config = {
			columns: [],
			filter: eq(nested, literal("v")),
			searchInputs: [],
		} as unknown as CaseListConfig;
		expect(collectConfigLookupTableIds(config)).toEqual([TABLE_A, TABLE_B]);
	});
});
