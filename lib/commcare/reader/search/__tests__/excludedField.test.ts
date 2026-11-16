/**
 * Contract: a visible prompt with `exclude: true` that no `_xpath_query` row reads comes in as an
 * advanced field whose condition is `match-all`, the gate admits it, and its re-emission writes
 * the prompt excluded with no row, which is the source. The failure it catches: a field no filter
 * reads refused, or given a row it never had.
 */
import { describe, expect, it } from "vitest";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { SearchInputDef } from "@/lib/domain";
import { matchAll } from "@/lib/domain/expression/builders";
import { plainColumn } from "@/lib/domain/modules";
import { expandDoc } from "../../../expander";
import { runValidation } from "../../../validator/runner";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import { codes, listOf, readLists } from "../../caseList/__tests__/listReading";

describe("an excluded Search field no row reads", () => {
	it("reads as an advanced field with no condition, admitted, and writes back with no row", async () => {
		const input: SearchInputDef = {
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			kind: "advanced",
			type: "text",
			predicate: matchAll(),
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [input],
			search: {},
		});
		const emitted = expandDoc(doc);
		const stored = (
			emitted.modules[0] as unknown as {
				search_config: {
					properties: Record<string, unknown>[];
					default_properties: unknown[];
				};
			}
		).search_config;
		expect(stored.properties[0]?.exclude).toBe(true);
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const read = listOf(reading).searchInputs[0];
		expect(read).toMatchObject({ kind: "advanced", predicate: matchAll() });
		const document = reading.ctx.doc;
		if (document === undefined)
			throw new Error("The reading bound no document.");
		expect(runValidation(document, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const again = expandDoc(document).modules[0] as unknown as {
			search_config: { default_properties: unknown[] };
		};
		expect(again.search_config.default_properties).toEqual(
			stored.default_properties,
		);
	});
});
