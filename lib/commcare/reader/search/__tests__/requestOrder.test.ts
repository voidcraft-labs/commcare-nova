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

it("refuses an order naming a property Nova reserves, and reads the record's own state by its @ key", async () => {
	const saved = await readLists(patients([], { search: {} }), {
		edit: (app) => {
			(
				app.modules[0].search_config.default_properties as {
					property: string;
					defaultValue: string;
				}[]
			).push({ property: "commcare_sort", defaultValue: "'-status:exact'" });
		},
	});
	expect(closedCodes(saved)).toEqual([
		"case-search/a-server-order-naming-a-property-nova-reserves",
	]);
	const dedicated = await readLists(patients([], { search: {} }), {
		edit: (app) => {
			app.modules[0].search_config.custom_sort_properties = [
				{
					doc_type: "CaseSearchCustomSortProperty",
					property_name: "owner_id",
					sort_type: "exact",
					direction: "ascending",
				},
			];
		},
	});
	expect(closedCodes(dedicated)).toEqual([
		"case-search/a-server-order-naming-a-property-nova-reserves",
	]);
	const state = await readLists(
		patients([], {
			search: {
				requestOrder: [
					{ property: "status", comparison: "text", direction: "descending" },
					{
						property: "date_opened",
						comparison: "date",
						direction: "ascending",
					},
				],
			},
		}),
	);
	expect(closedCodes(state), JSON.stringify(state.findings)).toEqual([]);
	expect(
		(
			state.app.modules[0].search_config.custom_sort_properties as {
				property_name: string;
			}[]
		).map((row) => row.property_name),
	).toEqual(["@status", "date_opened"]);
	const search = searchOf(state);
	expect(
		search !== undefined && "requestOrder" in search && search.requestOrder,
	).toEqual([
		{ property: "status", comparison: "text", direction: "descending" },
		{ property: "date_opened", comparison: "date", direction: "ascending" },
	]);
});

it("keeps a default filter's order text as it arrived, defaults left implicit", async () => {
	const reading = await readLists(patients([], { search: {} }), {
		edit: (app) => {
			// HQ's editor saves the order as the menu's one default filter.
			app.modules[0].search_config.default_properties = [
				{ property: "commcare_sort", defaultValue: "'name,-date_opened:date'" },
			];
		},
	});
	expect(closedCodes(reading), JSON.stringify(reading.findings)).toEqual([]);
	expect(listOf(reading).searchFilters).toMatchObject([
		{
			kind: "order",
			order: [
				{
					property: "case_name",
					recordName: true,
					comparison: "text",
					direction: "ascending",
					implicitComparison: true,
					implicitDirection: true,
				},
				{
					property: "date_opened",
					comparison: "date",
					direction: "descending",
				},
			],
		},
	]);
});

// HQ reads `@case_type` as the record's own type (`requestOrder.ts`'s
// attribute keys), so an order on it names no property the catalog gains.
it("adds no catalog property for an order on the record's own type", async () => {
	const reading = await readLists(patients([], { search: {} }), {
		edit: (app) => {
			app.modules[0].search_config.default_properties = [
				{ property: "commcare_sort", defaultValue: "'+@case_type:exact'" },
			];
			app.modules[0].search_config.custom_sort_properties = [
				{
					doc_type: "CaseSearchCustomSortProperty",
					property_name: "@case_type",
					sort_type: "exact",
					direction: "ascending",
				},
			];
		},
	});
	expect(closedCodes(reading), JSON.stringify(reading.findings)).toEqual([]);
	expect(
		reading.ctx.doc?.caseTypes?.flatMap((type) =>
			type.properties.map((property) => property.name),
		),
	).not.toContain("case_type");
});

// HQ builds `-` for `descending` and `+` for any other direction
// (`remote_requests.py`), so a dedicated row with no direction saved, as an
// app saved outside HQ's editor can hold, orders ascending.
it.each([null, ""])(
	"reads a dedicated sort row whose direction is %j as ascending",
	async (direction) => {
		const reading = await readLists(patients([], { search: {} }), {
			edit: (app) => {
				app.modules[0].search_config.custom_sort_properties = [
					{
						doc_type: "CaseSearchCustomSortProperty",
						property_name: "date_opened",
						sort_type: "date",
						direction,
					},
				];
			},
		});
		expect(closedCodes(reading), JSON.stringify(reading.findings)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			requestOrder: [
				{ property: "date_opened", comparison: "date", direction: "ascending" },
			],
		});
	},
);
