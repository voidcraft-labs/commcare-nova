/**
 * The secondary-instance reads parse to their typed arms, print back to text
 * that parses to the same tree, and refuse the shapes that have no arm with
 * the sentence the person reads.
 */

import { describe, expect, it } from "vitest";
import {
	INSTANCE_READS,
	instanceReadFixture,
} from "@/lib/commcare/__tests__/instanceReadFixture";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { proseText, type Uuid } from "@/lib/domain";
import {
	instanceReadsDoc,
	reads,
} from "@/lib/domain/expression/__tests__/instanceReadsFixture";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { expressionSchema } from "@/lib/domain/expression/types";
import { parseFormExpression } from "../expressionAst";

const { doc, table } = instanceReadFixture();
/* A second case type declaring `district`, so a read of it in a query with no
 * row type names no single declaring type. */
doc.caseTypes = [
	...(doc.caseTypes ?? []),
	{
		name: "household",
		properties: [{ name: "district", label: proseText("District") }],
	},
];
const lookup = new Map([[table.id, table]]);

function slotIn(formUuid: Uuid, id: string): ExpressionSlotRef {
	const field = Object.values(doc.fields).find(
		(field) => field.id === id && doc.fieldParent[field.uuid] === formUuid,
	);
	if (field === undefined) throw new Error(`No field ${id}`);
	return { entity: "field", uuid: field.uuid, slot: "calculate" };
}
const VISIT = slotIn(INSTANCE_READS.visitForm, "region_label");
const BATCH = slotIn(INSTANCE_READS.batchForm, "chosen");
const CHECK_IN = slotIn(INSTANCE_READS.searchForm, "found");

function parse(source: string, slot: ExpressionSlotRef) {
	const parsed = parseFormExpression(source, { doc, slot, lookup });
	if (!parsed.ok || parsed.expression === undefined)
		throw new Error(
			`${source}: ${parsed.ok ? "empty" : parsed.issues.map((issue) => issue.message).join("\n")}`,
		);
	return parsed.expression;
}

function roundTrip(source: string, slot: ExpressionSlotRef, printed: string) {
	const first = parse(source, slot);
	expect(expressionSchema.safeParse(first).success, source).toBe(true);
	const text = projectFormExpression(doc, slot, first, lookup);
	expect(text.unresolved, source).toEqual([]);
	expect(text.text).toBe(printed);
	expect(parse(text.text, slot)).toEqual(first);
	return first;
}

function refusal(source: string, slot: ExpressionSlotRef) {
	const parsed = parseFormExpression(source, { doc, slot, lookup });
	if (parsed.ok) throw new Error(`${source} parsed`);
	return parsed.issues.map((issue) => [issue.code, issue.message]);
}

describe("secondary-instance reads in form logic", () => {
	it("round-trip a data table read by either instance id", () => {
		for (const [source, printed] of [
			[
				"instance('regions')/regions_list/regions[value = 'north'][1]/label",
				"instance('regions')/regions_list/regions[value = 'north'][1]/label",
			],
			[
				"instance('item-list:regions')/regions_list/regions[value = 'north'][1]/label",
				"instance('regions')/regions_list/regions[value = 'north'][1]/label",
			],
			[
				"count(instance('regions')/regions_list/regions)",
				"count(instance('regions')/regions_list/regions)",
			],
			[
				"join(' ', instance('regions')/regions_list/regions[value != 'south']/label)",
				"join(' ', instance('regions')/regions_list/regions[value != 'south']/label)",
			],
		])
			roundTrip(source, VISIT, printed);
		expect(
			roundTrip(
				"instance('regions')/regions_list/regions[value = 'north'][1]/label",
				VISIT,
				"instance('regions')/regions_list/regions[value = 'north'][1]/label",
			),
		).toMatchObject({ kind: "table-lookup", tableId: table.id });
	});

	it("round-trip a read of places, a level code and a lineage attribute", () => {
		for (const source of [
			"instance('locations')/locations/location[@type = 'clinic']/name",
			"instance('locations')/locations/location/@district_id",
			"count(instance('locations')/locations/location[@type = 'district'])",
		])
			roundTrip(source, VISIT, source);
	});

	it("round-trip a question's own text and a choice's label", () => {
		expect(
			roundTrip("jr:itext('color-label')", VISIT, "jr:itext('color-label')"),
		).toEqual({
			kind: "itext",
			unit: { field: INSTANCE_READS.color, role: "field-label" },
		});
		expect(
			roundTrip(
				"jr:choice-name(#form/color, '#form/color')",
				VISIT,
				"jr:choice-name(#form/color, '#form/color')",
			),
		).toMatchObject({ kind: "choice-name", field: INSTANCE_READS.color });
	});

	it("round-trip the cases chosen in a several-case module", () => {
		expect(
			roundTrip(
				"count(instance('selected_cases')/results/value)",
				BATCH,
				"count(instance('selected_cases')/results/value)",
			),
		).toEqual({
			kind: "count",
			via: { kind: "selected-cases", module: INSTANCE_READS.batchModule },
		});
	});

	it("round-trip what the search found, typed as the searched case type", () => {
		const excluded =
			"instance('results:inline')/results/case[not(commcare_is_related_case = true())]";
		roundTrip(`count(${excluded})`, CHECK_IN, `count(${excluded})`);
		expect(
			roundTrip(
				`${excluded}[district = 'north']/case_name`,
				CHECK_IN,
				`${excluded}[district = 'north']/case_name`,
			),
		).toMatchObject({
			kind: "project",
			of: {
				kind: "cases",
				source: "search-results",
				where: [
					{
						kind: "eq",
						left: { term: { property: "district", caseType: "patient" } },
					},
				],
			},
		});
		/* The same read of every case on the device names no row type, and two
		 * case types declare `district`. */
		expect(
			refusal(
				"instance('casedb')/casedb/case[district = 'north']/case_name",
				CHECK_IN,
			).map(([code]) => code),
		).toEqual(["case-query-untyped"]);
	});

	it("refuses search results without the related-case exclusion, and the remote search's instance", () => {
		expect(
			refusal("count(instance('results:inline')/results/case)", CHECK_IN),
		).toEqual([
			[
				"search-results-unexcluded",
				"Search results also hold cases CommCare adds to show related details. You can read the cases the search found with instance('results:inline')/results/case[not(commcare_is_related_case = true())].",
			],
		]);
		expect(
			refusal("count(instance('results')/results/case)", CHECK_IN),
		).toEqual([
			[
				"search-results-remote",
				"This form opens after the worker leaves the search, so its results are gone by then. You can read the case the worker chose with #patient/ instead.",
			],
		]);
	});

	it("round-trip a Search answer in Core's shape, and refuse any other path", () => {
		const searchDoc = instanceReadsDoc();
		const slot: ExpressionSlotRef = {
			entity: "field",
			uuid: reads.registerProbe,
			slot: "calculate",
		};
		const parseIn = (source: string) =>
			parseFormExpression(source, { doc: searchDoc, slot, lookup });
		/* What the XForm printer writes for a Search answer
		 * (`noMatchesEmission.test.ts` pins those bytes). */
		const wire =
			"instance('search-input:results:inline')/input/field[@name = 'district']";
		const read = parseIn(wire);
		expect(read).toMatchObject({
			ok: true,
			expression: {
				kind: "term",
				term: { kind: "input", searchInputUuid: reads.district },
			},
		});
		if (!read.ok || read.expression === undefined) return;
		const text = projectFormExpression(
			searchDoc,
			slot,
			read.expression,
			lookup,
		);
		expect(text.unresolved).toEqual([]);
		const reparsed = parseIn(text.text);
		expect(reparsed.ok && reparsed.expression).toEqual(read.expression);
		for (const source of [
			"instance('search-input:results:inline')/results/inputs/district",
			"instance('search-input:results:inline')/input/field[@name = 'county']",
			"instance('search-input:results:inline')/input/field[@key = 'district']",
			"instance('search-input:results:inline')/input/field",
		]) {
			const refused = parseIn(source);
			expect(
				refused.ok ? [] : refused.issues.map((issue) => issue.code),
				source,
			).toEqual(["unknown-search-input"]);
		}
	});
});
