/**
 * A Nova row as CommCare HQ's JSON row resource stores it. The plausible
 * failures: a value the workbook would trim sent trimmed, an empty list of
 * occurrences sent as one empty value (which the fixture serves as a child
 * the row does not have), a property the occurrence does not hold sent as
 * empty, and a field or detail named `__proto__` lost to the prototype.
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
import { lookupJsonDefinition, lookupJsonRowContent } from "../jsonRows";
import { lookupWireNaming } from "../naming";
import { wireTable, wireUuid } from "./lookupWireCorpus";

const NAME = lookupColumnIdSchema.parse(wireUuid("json-name"));
const ALIAS = lookupColumnIdSchema.parse(wireUuid("json-alias"));
const LANG = lookupMemberIdSchema.parse(wireUuid("json-lang"));
const CODE = lookupMemberIdSchema.parse(wireUuid("json-code"));

const definition: LookupTableDefinition = {
	...wireTable("types", [{ name: "name", type: "text" }]),
	columns: [
		{ id: NAME, wireName: "name", label: "Name", dataType: "text" },
		{
			id: ALIAS,
			wireName: "__proto__",
			label: "Alias",
			dataType: "text",
			repeated: true,
			properties: [{ id: LANG, wireName: "lang", label: "Language" }],
		},
	],
	attributes: [{ id: CODE, wireName: "code", label: "Code" }],
};
const naming = lookupWireNaming([definition]).tableFor(definition.id);

function row(partial: Partial<LookupFixtureRow>): LookupFixtureRow {
	return {
		id: lookupRowIdSchema.parse(wireUuid("json-row")),
		values: {},
		...partial,
	};
}

describe("a lookup table in CommCare HQ's JSON shape", () => {
	it("names every field with its properties and the row details", () => {
		expect(lookupJsonDefinition(naming)).toEqual({
			tag: "types",
			fields: [
				{ name: "name", properties: [] },
				{ name: "__proto__", properties: ["lang"] },
			],
			itemAttributes: ["code"],
		});
	});

	it("keeps each value exactly, an empty occurrence list empty and a missing property absent", () => {
		const content = lookupJsonRowContent(
			naming,
			row({
				values: { [NAME]: "  Clinic  " },
				attributes: { [CODE]: " 007 " },
				occurrences: {
					[ALIAS]: [
						{ text: "", properties: { [LANG]: "en" } },
						{ text: "dispensaire", properties: {} },
					],
				},
			}),
		);
		expect(Object.keys(content.fields)).toEqual(["name", "__proto__"]);
		expect(content.fields.name).toEqual([
			{ value: "  Clinic  ", properties: {} },
		]);
		expect(
			Object.getOwnPropertyDescriptor(content.fields, "__proto__")?.value,
		).toEqual([
			{ value: "", properties: { lang: "en" } },
			{ value: "dispensaire", properties: {} },
		]);
		expect(content.itemAttributes).toEqual({ code: " 007 " });

		const none = lookupJsonRowContent(
			naming,
			row({ attributes: { [CODE]: "1" }, occurrences: { [ALIAS]: [] } }),
		);
		expect(
			Object.getOwnPropertyDescriptor(none.fields, "__proto__")?.value,
		).toEqual([]);
	});

	it("refuses a row missing a declared detail", () => {
		expect(() => lookupJsonRowContent(naming, row({}))).toThrow(/code/);
	});
});
