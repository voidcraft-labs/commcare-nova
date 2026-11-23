/**
 * Contract: the request a completed search sends under each Search field that
 * CommCare HQ matches by its own key carries the values Core sends for that
 * key (`RemoteQuerySessionManager.getRawQueryParams` splits each answer on
 * `#,#`). A ticked "search for blank" is a blank value before the answer
 * (`query.js::encodeValue`), and checkboxes send each ticked choice. The
 * failure it catches: a blank the worker asked for dropped from the request,
 * or several checked choices sent as one joined value that matches nothing.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Module, SearchInputDef } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { completedSearchRequest } from "../completedSearchRequest";

function moduleWith(
	searchInputs: SearchInputDef[],
): Pick<Module, "caseListConfig" | "caseSearchConfig"> {
	return {
		caseListConfig: { columns: [], searchInputs },
	} as unknown as Pick<Module, "caseListConfig" | "caseSearchConfig">;
}

function sent(
	searchInputs: SearchInputDef[],
	answers: Record<string, string>,
): [string, readonly string[]][] {
	return (
		completedSearchRequest(
			moduleWith(searchInputs),
			new Map(Object.entries(answers)),
		).parameters ?? []
	).map((one) => [one.key, one.values]);
}

const village: SearchInputDef = {
	uuid: testUuid("village"),
	name: "village",
	label: "Village",
	kind: "simple",
	type: "text",
	property: "village",
	allowBlank: true,
};

describe("completedSearchRequest", () => {
	it("sends the blank before the answer where the box is ticked", () => {
		expect(
			sent([village], { village: "Kibera", "village:blank": "true" }),
		).toEqual([["village", ["", "Kibera"]]]);
	});

	it("sends a blank alone where the box is ticked with no answer", () => {
		expect(sent([village], { "village:blank": "true" })).toEqual([
			["village", [""]],
		]);
	});

	it("sends nothing for a field with neither an answer nor the box", () => {
		expect(sent([village], {})).toEqual([]);
	});

	it("sends no blank for a field that does not allow it", () => {
		const { allowBlank: _allowBlank, ...plain } = village as SearchInputDef & {
			allowBlank?: true;
		};
		expect(
			sent([plain as SearchInputDef], {
				village: "Kibera",
				"village:blank": "true",
			}),
		).toEqual([["village", ["Kibera"]]]);
	});

	it("sends each checked choice of a checkbox field", () => {
		const district: SearchInputDef = {
			uuid: testUuid("district"),
			name: "district",
			label: "District",
			kind: "simple",
			type: "checkboxes",
			property: "district",
			options: {
				kind: "lookup",
				tableId: testUuid("table") as unknown as LookupTableId,
				valueColumnId: testUuid("value") as unknown as LookupColumnId,
				labelColumnId: testUuid("label") as unknown as LookupColumnId,
			},
		};
		expect(sent([district], { district: "north#,#south" })).toEqual([
			["district", ["north", "south"]],
		]);
	});
});
