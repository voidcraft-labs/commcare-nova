import { expect, it } from "vitest";
import { requestOrderText } from "@/lib/commcare/suite/case-search/requestOrder";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { effectiveCaseTypes } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression/builders";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
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

it("reads repeated direction signs by their first sign and records the exact source rewrite", async () => {
	const original = "'++notes:numeric,-+-phone:exact,name'";
	const reading = await readLists(patients([], { search: {} }), {
		edit: (app) => {
			app.modules[0].search_config.default_properties = [
				{ property: "commcare_sort", defaultValue: original },
			];
		},
	});
	expect(closedCodes(reading), JSON.stringify(reading.findings)).toEqual([]);
	const filter = listOf(reading).searchFilters?.[0];
	expect(filter).toMatchObject({ kind: "order" });
	if (filter === undefined || !("order" in filter))
		throw new Error("Missing Search order");
	expect(requestOrderText(filter.order)).toBe(
		"+notes:numeric,-phone:exact,name",
	);
	expect(filter.order.map((term) => term.direction)).toEqual([
		"ascending",
		"descending",
		"ascending",
	]);
	expect(reading.ctx.facts.sameStateRewrites).toContainEqual(
		expect.objectContaining({
			path: "/modules/0/search_config/default_properties/0/defaultValue",
			register: "search-order-direction-signs-respelled",
		}),
	);
	const canonical = await readLists(
		patients([], {
			search: {},
			list: { searchFilters: [filter] },
		}),
	);
	expect(closedCodes(canonical)).toEqual([]);
	expect(canonical.app.modules[0].search_config.default_properties).toEqual([
		{
			property: "commcare_sort",
			defaultValue: "'+notes:numeric,-phone:exact,name'",
		},
	]);
	expect(
		canonical.ctx.facts.sameStateRewrites.map((row) => row.register),
	).not.toContain("search-order-direction-signs-respelled");
});

it("discards an unused suffix without moving a sort term or filter", async () => {
	const reading = await readLists(patients([], { search: {} }), {
		edit: (app) => {
			app.modules[0].search_config.default_properties = [
				{
					property: "commcare_sort",
					defaultValue: "'-date_opened:date:old,+notes:exact:obsolete'",
				},
				{ property: "commcare_sort", defaultValue: "'name'" },
			];
		},
	});
	expect(closedCodes(reading)).toEqual([]);
	const searchFilters = listOf(reading).searchFilters;
	expect(
		searchFilters?.map(
			(filter) => "order" in filter && requestOrderText(filter.order),
		),
	).toEqual(["-date_opened:date,+notes:exact", "name"]);
	expect(reading.ctx.facts.sameStateRewrites).toContainEqual(
		expect.objectContaining({
			register: "search-order-unused-suffix-removed",
			path: "/modules/0/search_config/default_properties/0/defaultValue",
		}),
	);
	const canonical = await readLists(
		patients([], { search: {}, list: { searchFilters } }),
	);
	expect(closedCodes(canonical)).toEqual([]);
	expect(canonical.app.modules[0].search_config.default_properties).toEqual([
		{
			property: "commcare_sort",
			defaultValue: "'-date_opened:date,+notes:exact'",
		},
		{ property: "commcare_sort", defaultValue: "'name'" },
	]);
	expect(
		canonical.ctx.facts.sameStateRewrites.map((row) => row.register),
	).not.toContain("search-order-unused-suffix-removed");
});

it.each([
	[
		"'-date_opened:date,+priority::obsolete'",
		"case-search/default-properties-entry-keyed-commcare-sort-x-commcare-custom",
	],
	...["date-opened", "external-id", "p".repeat(256)].map((key) => [
		`'+${key}:exact:obsolete'`,
		"case-search/default-properties-entry-keyed-commcare-sort-x-commcare-custom",
	]),
	[
		"'+priority:unknown:obsolete'",
		"case-search/default-properties-entry-keyed-commcare-sort-x-commcare-custom",
	],
	[
		"'+status:exact:obsolete'",
		"case-search/a-server-order-naming-a-property-nova-reserves",
	],
	[
		"'+location_id:exact:obsolete'",
		"case-search/a-server-order-naming-a-property-only-devices-hold",
	],
	[
		"'++priority:exact:obsolete'",
		"case-search/default-properties-entry-keyed-commcare-sort-x-commcare-custom",
	],
	[
		"'++priority:unknown'",
		"case-search/default-order-with-an-unmapped-comparison",
	],
	[
		"'--status:exact'",
		"case-search/a-server-order-naming-a-property-nova-reserves",
	],
	[
		"'+-location_id:exact'",
		"case-search/a-server-order-naming-a-property-only-devices-hold",
	],
])(
	"keeps the refusal for %s with unsupported sort terms",
	async (defaultValue, finding) => {
		const reading = await readLists(patients([], { search: {} }), {
			edit: (app) => {
				app.modules[0].search_config.default_properties = [
					{ property: "commcare_sort", defaultValue },
				];
			},
		});
		expect(closedCodes(reading)).toEqual([finding]);
		expect(
			reading.ctx.facts.sameStateRewrites.map((row) => row.register),
		).not.toContain("search-order-direction-signs-respelled");
	},
);

it.each([
	"later reset",
	"dedicated order",
	"external endpoint",
	"commcare_sort",
	"x_commcare_endpoint_id",
	"x_commcare_data_registry",
	"phonetic",
] as const)(
	"keeps the existing finding for an unsupported order with %s",
	async (control) => {
		const reading = await readLists(patients([], { search: {} }), {
			edit: (app) => {
				const config = app.modules[0].search_config;
				config.default_properties = [
					{
						property: "commcare_sort",
						defaultValue:
							control === "phonetic"
								? "'+priority:phonetic'"
								: "'++priority:unknown'",
					},
				];
				switch (control) {
					case "later reset":
						config.default_properties.push({
							property: "commcare_sort",
							defaultValue: "'+priority::ignored'",
						});
						break;
					case "dedicated order":
						config.custom_sort_properties = [
							{
								doc_type: "CaseSearchCustomSortProperty",
								property_name: "priority",
								sort_type: "exact",
								direction: "ascending",
							},
						];
						break;
					case "commcare_sort":
					case "x_commcare_endpoint_id":
					case "x_commcare_data_registry":
						config.properties = [
							{
								doc_type: "CaseSearchProperty",
								name: control,
								label: { en: "Order" },
							},
						];
						break;
					case "external endpoint":
						config.case_search_endpoint_id = 9;
						config.properties = [
							{
								doc_type: "CaseSearchProperty",
								name: "priority",
								label: { en: "Priority" },
							},
						];
						break;
				}
			},
		});
		const findings = closedCodes(reading);
		expect(findings).toContain(
			control === "external endpoint"
				? "unrecognized:schema:DefaultCaseSearchProperty.property"
				: "case-search/default-properties-entry-keyed-commcare-sort-x-commcare-custom",
		);
		expect(findings).not.toContain(
			"case-search/default-order-with-an-unmapped-comparison",
		);
	},
);

it.each([
	"priority",
	"endpoint_id",
	"data_registry",
	"x_commcare_endpoint_id_extra",
	'"x_commcare_data_registry"',
])("still identifies the invalid lone order beside prompt %s", async (name) => {
	const reading = await readLists(patients([], { search: {} }), {
		edit: (app) => {
			const config = app.modules[0].search_config;
			config.default_properties = [
				{ property: "commcare_sort", defaultValue: "'++priority:unknown'" },
			];
			config.properties = [
				{ doc_type: "CaseSearchProperty", name, label: { en: "Priority" } },
			];
		},
	});
	expect(closedCodes(reading)).toContain(
		"case-search/default-order-with-an-unmapped-comparison",
	);
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

it("keeps an order bound to the requested record type that declares its property", async () => {
	const order = [
		{ property: "priority", comparison: "number", direction: "descending" },
	] as const;
	const input = patients([], {
		search: { requestOrder: [...order] },
		list: {
			searchFilters: [
				{ uuid: uuid(33), kind: "request-record-type", caseType: "visit" },
			],
		},
	});
	input.caseTypes = [
		...effectiveCaseTypes(input),
		{
			name: "visit",
			properties: [
				{ name: "priority", label: proseText("Priority"), data_type: "int" },
			],
		},
	];
	const reading = await readLists(input);
	expect(closedCodes(reading), JSON.stringify(reading.findings)).toEqual([]);
	expect(searchOf(reading)).toMatchObject({ requestOrder: order });
	const catalog = reading.ctx.doc?.caseTypes;
	expect(
		catalog
			?.find((type) => type.name === "patient")
			?.properties.map((property) => property.name),
	).not.toContain("priority");
	expect(
		catalog?.find((type) => type.name === "visit")?.properties,
	).toMatchObject([{ name: "priority", data_type: "int" }]);
});

const deviceOnlyOrderCode =
	"case-search/a-server-order-naming-a-property-only-devices-hold";

it.each(["default filter", "dedicated setting"] as const)(
	"refuses a device-only property and keeps an indexed worker property in the %s",
	async (carrier) => {
		const useDefault = carrier === "default filter";
		const readOrder = (property: string) =>
			readLists(patients([], { search: {} }), {
				edit: (app) => {
					const config = app.modules[0].search_config;
					if (useDefault) {
						config.default_properties = [
							{
								property: "commcare_sort",
								defaultValue: `'+${property}:exact'`,
							},
						];
					} else {
						config.custom_sort_properties = [
							{
								doc_type: "CaseSearchCustomSortProperty",
								property_name: property,
								sort_type: "exact",
								direction: "ascending",
							},
						];
					}
				},
			});
		const location = await readOrder("location_id");
		expect(closedCodes(location), JSON.stringify(location.findings)).toEqual([
			deviceOnlyOrderCode,
		]);
		const worker = await readOrder("hq_user_id");
		expect(closedCodes(worker), JSON.stringify(worker.findings)).toEqual([]);
		const order = [
			{ property: "hq_user_id", comparison: "text", direction: "ascending" },
		];
		if (useDefault) {
			expect(listOf(worker).searchFilters).toMatchObject([
				{ kind: "order", order },
			]);
		} else {
			expect(searchOf(worker)).toMatchObject({ requestOrder: order });
		}

		const authoredFindings = (property: string) => {
			const term = {
				property,
				comparison: "text",
				direction: "ascending",
			} as const;
			const columns = [plainColumn(uuid(1), "hq_user_id", "Linked worker")];
			const doc = useDefault
				? patients(columns, {
						search: {},
						list: {
							searchFilters: [{ uuid: uuid(34), kind: "order", order: [term] }],
						},
					})
				: patients(columns, { search: { requestOrder: [term] } });
			const caseTypes = [
				...(doc.caseTypes ?? []).filter((type) => type.name !== "patient"),
				{
					name: "patient",
					properties: [
						{
							name: "hq_user_id",
							label: proseText("Linked worker"),
							data_type: "text" as const,
						},
						{
							name: "location_id",
							label: proseText("Location"),
							data_type: "text" as const,
						},
					],
				},
			];
			return runValidation({ ...doc, caseTypes }, LOOKUP_CONTEXT_UNAVAILABLE);
		};
		expect(authoredFindings("location_id")).toEqual([
			expect.objectContaining({
				code: "CASE_SEARCH_FILTER_INVALID",
				details: { reason: "order-device-only", property: "location_id" },
			}),
		]);
		expect(authoredFindings("hq_user_id")).toEqual([]);
	},
);
