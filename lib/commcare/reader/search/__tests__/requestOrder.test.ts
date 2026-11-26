import { expect, it } from "vitest";
import { literal, term } from "@/lib/domain/expression/builders";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	closedCodes,
	listOf,
	readLists,
	searchOf,
} from "../../caseList/__tests__/listReading";

it("keeps the order, comparison and editor placement of the server's sort and exclusion", async () => {
	const primary = [
		{ property: "notes", comparison: "number", direction: "descending" },
	] as const;
	const secondary = [
		{ property: "case_name", comparison: "text", direction: "ascending" },
	] as const;
	const input = patients([], {
		search: { requestOrder: [...secondary] },
		list: {
			searchFilters: [
				{ uuid: uuid(30), kind: "order", order: [...primary] },
				{
					uuid: uuid(31),
					target: { kind: "excluded-owners" },
					value: term(literal("owner-a owner-b")),
				},
			],
		},
	});
	const read = await readLists(input);
	expect(closedCodes(read), JSON.stringify(read.findings)).toEqual([]);
	expect(read.app.modules[0].search_config.default_properties).toEqual([
		{ property: "commcare_sort", defaultValue: "'-notes:numeric'" },
		{
			property: "commcare_blacklisted_owner_ids",
			defaultValue: "'owner-a owner-b'",
		},
	]);
	expect(read.app.modules[0].search_config.custom_sort_properties).toEqual([
		{
			doc_type: "CaseSearchCustomSortProperty",
			property_name: "case_name",
			sort_type: "exact",
			direction: "ascending",
		},
	]);
	expect(listOf(read).searchFilters).toMatchObject([
		{ kind: "order", order: primary },
		{ target: { kind: "excluded-owners" } },
	]);
	expect(searchOf(read)).toMatchObject({ requestOrder: secondary });
});

it("keeps separate lists of owners for assigned cases and online matches through an HQ settings edit", async () => {
	const input = patients([], {
		search: { excludedOwnerIds: term(literal("old-team")) },
		list: {
			searchFilters: [
				{
					uuid: uuid(29),
					target: { kind: "excluded-owners", placement: "search-setting" },
					value: term(literal("online-team")),
				},
			],
		},
	});
	const original = await readLists(input);
	expect(closedCodes(original), JSON.stringify(original.findings)).toEqual([]);
	expect(searchOf(original)?.excludedOwnerIds).toEqual(
		term(literal("old-team")),
	);
	expect(
		original.app.modules[0].search_config.blacklisted_owner_ids_expression,
	).toEqual("'online-team'");
	expect(listOf(original).searchFilters).toMatchObject([
		{
			target: { kind: "excluded-owners", placement: "search-setting" },
			value: term(literal("online-team")),
		},
	]);
	const edited = await readLists(input, {
		edit: (app) => {
			app.modules[0].search_config.blacklisted_owner_ids_expression =
				"'current-team'";
		},
	});
	expect(closedCodes(edited), JSON.stringify(edited.findings)).toEqual([]);
	expect(searchOf(edited)?.excludedOwnerIds).toEqual(term(literal("old-team")));
	expect(listOf(edited).searchFilters).toMatchObject([
		{
			uuid: listOf(original).searchFilters?.[0]?.uuid,
			value: term(literal("current-team")),
		},
	]);
});

it("keeps the assigned owner rule when a menu has a dormant online exclusion", async () => {
	const input = patients([], {
		search: {
			searchActionEnabled: false,
			excludedOwnerIds: term(literal("assigned")),
		},
	});
	const reading = await readLists(input, {
		edit: (app) => {
			app.modules[0].search_config.blacklisted_owner_ids_expression =
				"'dormant'";
		},
	});
	expect(closedCodes(reading), JSON.stringify(reading.findings)).toEqual([]);
	expect(searchOf(reading)).toEqual({
		searchActionEnabled: false,
		excludedOwnerIds: term(literal("assigned")),
	});
	expect(listOf(reading).searchFilters).toBeUndefined();
	expect(reading.ctx.facts.sameStateRewrites).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				entry: "case-search/owner-exclusion-in-a-dormant-search-setting",
			}),
		]),
	);
});
