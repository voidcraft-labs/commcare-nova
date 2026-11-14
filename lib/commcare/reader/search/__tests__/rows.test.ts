/**
 * Contract: each top-level conjunct of each `_xpath_query` row is placed where Nova's emission
 * writes it back from: a restated clause of the case list filter, an excluded Search field's
 * condition, or (where no slot holds it) a finding; a list filter clause the search does not
 * restate raises on a menu whose forms do not read the search; rows in another order read equal
 * and record the reorder. The failure it catches: a derivation read as an authored condition; a
 * filter that starts narrowing a search; Nova's own filter read back as a field's condition.
 */
import { describe, expect, it } from "vitest";
import type { SearchInputDef } from "@/lib/domain";
import {
	eq,
	input,
	literal,
	neq,
	prop,
	whenInput,
} from "@/lib/domain/expression/builders";
import { plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import { codes, listOf, readLists } from "../../caseList/__tests__/listReading";
import { derivedConditionsAreSimpleFields } from "../rows";

const notesIs = (value: string) => eq(prop("patient", "notes"), literal(value));

function rowsOf(
	app: Awaited<ReturnType<typeof readLists>>["app"],
): Record<string, unknown>[] {
	return app.modules[0]?.search_config.default_properties as Record<
		string,
		unknown
	>[];
}

describe("the rows of `_xpath_query`", () => {
	it("reads Nova's restated list filter clause back into the filter alone", async () => {
		const field: SearchInputDef = {
			uuid: uuid(9),
			name: "phone",
			label: "Phone",
			kind: "simple",
			type: "text",
			property: "phone",
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
			list: { filter: notesIs("open") },
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading).filter).toEqual(notesIs("open"));
	});

	it("reads an excluded field's condition back onto the field", async () => {
		const condition = whenInput(
			input(uuid(9)),
			neq(prop("patient", "phone"), input(uuid(9))),
		);
		const field: SearchInputDef = {
			uuid: uuid(9),
			name: "number",
			label: "Number",
			kind: "advanced",
			type: "text",
			predicate: condition,
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const read = listOf(reading).searchInputs[0];
		expect(read?.kind).toBe("advanced");
		expect(listOf(reading).filter).toBeUndefined();
	});

	it("reads an excluded field whose condition is a simple field's derivation as that simple field", async () => {
		const condition = whenInput(
			input(uuid(9)),
			eq(prop("patient", "phone"), input(uuid(9))),
		);
		const field: SearchInputDef = {
			uuid: uuid(9),
			name: "number",
			label: "Number",
			kind: "advanced",
			type: "text",
			predicate: condition,
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		// The reading mints its own identities; every other key is the canonical member's.
		const withoutUuid = (inputs: readonly SearchInputDef[] | undefined) =>
			(inputs ?? []).map(({ uuid: _uuid, ...rest }) => rest);
		const canonical = derivedConditionsAreSimpleFields(doc);
		expect(withoutUuid(listOf(reading).searchInputs)).toEqual(
			withoutUuid(
				Object.values(canonical.modules)[0]?.caseListConfig?.searchInputs,
			),
		);
		expect(listOf(reading).searchInputs[0]).toMatchObject({
			kind: "simple",
			property: "phone",
		});
	});

	it("raises a list filter clause the search does not restate, on a menu whose forms do not read it", async () => {
		const field: SearchInputDef = {
			uuid: uuid(9),
			name: "phone",
			label: "Phone",
			kind: "simple",
			type: "text",
			property: "phone",
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
			list: { filter: notesIs("open") },
		});
		const reading = await readLists(doc, {
			edit: (app) => {
				const config = app.modules[0]?.search_config;
				if (config !== undefined) config.default_properties = [];
			},
		});
		expect(codes(reading)).toContain(
			"case-search/case-list-filter-clause-the-search-does-not-restate",
		);
	});

	it("raises a conjunct that reads no field and restates no list clause", async () => {
		const field: SearchInputDef = {
			uuid: uuid(9),
			name: "phone",
			label: "Phone",
			kind: "simple",
			type: "text",
			property: "phone",
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
			list: { filter: notesIs("open") },
		});
		const reading = await readLists(doc, {
			edit: (app) => {
				const rows = rowsOf(app);
				const first = rows[0];
				// A row's value is an XPath whose value is the CSQL text, as Nova writes `"notes = 'open'"`.
				if (first !== undefined)
					rows.push({ ...first, defaultValue: `"notes = 'other'"` });
			},
		});
		expect(codes(reading)).toContain(
			"case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s",
		);
	});

	it("reads rows in another order as the same rows, and records the reorder", async () => {
		const condition = whenInput(
			input(uuid(9)),
			neq(prop("patient", "phone"), input(uuid(9))),
		);
		const field: SearchInputDef = {
			uuid: uuid(9),
			name: "number",
			label: "Number",
			kind: "advanced",
			type: "text",
			predicate: condition,
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
			list: { filter: notesIs("open") },
		});
		const reading = await readLists(doc, {
			edit: (app) => {
				rowsOf(app).reverse();
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading).filter).toEqual(notesIs("open"));
		expect(
			reading.ctx.facts.sameStateRewrites.map((one) => one.register),
		).toContain("search-filter-rows-recut");
	});
});
