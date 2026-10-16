// The order plan's rules, held one by one over lists built for each. The
// options a domain module cannot compute are given here as the plan reads
// them: the plan compares expression texts for equality and reads nothing
// else of them, so any text that is equal exactly when two columns print
// alike serves.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	asMediaAssetId,
	type CaseListConfig,
	type CaseListOrderOptions,
	type CaseListOrderPlan,
	type CaseListOrderProperty,
	type Column,
	calculatedColumn,
	caseListOrderPlan,
	caseListOrdersByMapping,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	intervalColumn,
	linkColumn,
	phoneColumn,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";

const CATALOG: readonly CaseListOrderProperty[] = [
	{ name: "case_name", data_type: "text" },
	{ name: "age", data_type: "int" },
	{ name: "weight", data_type: "decimal" },
	{ name: "visit_date", data_type: "date" },
	{ name: "zone", data_type: "text" },
	{ name: "phone", data_type: "text" },
	{ name: "site", data_type: "text" },
	{
		name: "level",
		data_type: "single_select",
		options: [{ value: "2" }, { value: "10" }],
	},
];

/** The texts HQ JSON would write: `@<name>` for an attribute-backed column
 *  that is not a shown link, the column's own expression otherwise. */
function expressionText(column: Column): string {
	if (column.kind === "calculated") return JSON.stringify(column.expression);
	const attribute = ["case_id", "owner_id", "status"].includes(column.field);
	if (column.visibleInList === false || column.kind === "plain") {
		return attribute ? `@${column.field}` : `label(${column.field})`;
	}
	if (column.kind === "link") return `link(${column.field})`;
	if (column.kind === "interval") return `interval(${column.uuid})`;
	return attribute ? `@${column.field}` : column.field;
}

function options(
	overrides: Partial<CaseListOrderOptions> = {},
): CaseListOrderOptions {
	return {
		mediaOn: true,
		calculatedType: () => undefined,
		expressionText,
		...overrides,
	};
}

function list(
	columns: readonly Column[],
	tile?: CaseListConfig["tile"],
): CaseListConfig {
	const order = columns.map((column) => column.uuid);
	return {
		columns: [...columns],
		listColumnOrder: order,
		detailColumnOrder: [...order],
		searchInputs: [],
		...(tile !== undefined && { tile }),
	};
}

function plan(
	columns: readonly Column[],
	more: { tile?: CaseListConfig["tile"]; options?: CaseListOrderOptions } = {},
): CaseListOrderPlan {
	return caseListOrderPlan(
		list(columns, more.tile),
		CATALOG,
		more.options ?? options(),
	);
}

const id = (name: string): Uuid => testUuid(`order-plan-${name}`);
const asc = (priority = 0) => ({ direction: "asc" as const, priority });
const desc = (priority = 0) => ({ direction: "desc" as const, priority });
const HIDDEN = { visibleInList: false } as const;

/** Each field's position, key and rule order, the shape most cases read. */
function summary(result: CaseListOrderPlan) {
	return result.fields.map((field) => ({
		column: field.column.uuid,
		wire: field.wire,
		key: field.key?.kind,
		order: field.rule?.order,
	}));
}

const IMAGE = asMediaAssetId(testUuid("order-plan-image"));

describe("the key each column kind keeps as field 0 of an unsorted list", () => {
	it.each<[string, Column, string | undefined, "property" | "expression"]>([
		[
			"plain",
			plainColumn(id("c"), "case_name", "Name"),
			"property",
			"property",
		],
		[
			"plain over a select",
			plainColumn(id("c"), "level", "Level"),
			"option-label",
			"expression",
		],
		[
			"plain over case_id",
			plainColumn(id("c"), "case_id", "Record ID"),
			"property",
			"expression",
		],
		[
			"date",
			dateColumn(id("c"), "visit_date", "Visited", "%Y-%m-%d"),
			"property",
			"property",
		],
		["phone", phoneColumn(id("c"), "phone", "Phone"), "property", "property"],
		[
			"id-mapping",
			idMappingColumn(id("c"), "zone", "Zone", [idMappingEntry("2", "North")]),
			"mapping-position",
			"property",
		],
		[
			"image-map",
			imageMapColumn(id("c"), "zone", "Zone", [imageMapEntry("2", IMAGE)]),
			"mapping-position",
			"property",
		],
		[
			"interval",
			intervalColumn(
				id("c"),
				"visit_date",
				"Seen",
				30,
				"days",
				"always",
				"Late",
			),
			"interval-text",
			"expression",
		],
		[
			"link",
			linkColumn(id("c"), "site", "Site", "Open"),
			"link-text",
			"expression",
		],
		[
			"calculated",
			calculatedColumn(id("c"), "Copy", term(prop("household", "zone"))),
			"calculated",
			"expression",
		],
	])("%s", (_kind, column, key, wire) => {
		const result = plan([column]);
		expect(result.fields).toHaveLength(1);
		const [field] = result.fields;
		expect(field.wire).toBe(wire);
		expect(field.key?.kind).toBe(key);
		// The implicit rule on field 0 is HQ's own default element: not written,
		// ascending, blanks first, compared as text.
		expect(field.rule).toMatchObject({
			order: 1,
			direction: "asc",
			blanks: "first",
			implicit: true,
			written: false,
		});
		expect(field.comparator).toBe("text");
		expect(result.carriers).toEqual([]);
		expect(result.authored).toEqual([]);
	});

	it("keeps every rule 3 key with no rule on the fields after the first", () => {
		const result = plan([
			plainColumn(id("name"), "case_name", "Name"),
			dateColumn(id("date"), "visit_date", "Visited", "%Y-%m-%d"),
			idMappingColumn(id("map"), "zone", "Zone", [idMappingEntry("2", "N")]),
			plainColumn(id("level"), "level", "Level"),
			intervalColumn(
				id("seen"),
				"visit_date",
				"Seen",
				3,
				"days",
				"flag",
				"Late",
			),
			phoneColumn(id("phone"), "phone", "Phone"),
			linkColumn(id("site"), "site", "Site", "Open"),
		]);
		expect(summary(result).map(({ key, order }) => [key, order])).toEqual([
			["property", 1],
			["property", undefined],
			["mapping-position", undefined],
			["option-label", undefined],
			["interval-text", undefined],
			[undefined, undefined],
			[undefined, undefined],
		]);
	});
});

describe("hidden fields", () => {
	it("are fields of a list with no tile, property fields with no key of their own", () => {
		const result = plan([
			plainColumn(id("level"), "level", "Level", HIDDEN),
			intervalColumn(
				id("seen"),
				"visit_date",
				"Seen",
				3,
				"days",
				"flag",
				"Late",
				HIDDEN,
			),
			plainColumn(id("name"), "case_name", "Name"),
		]);
		expect(summary(result)).toEqual([
			{
				column: id("level"),
				wire: "property",
				key: undefined,
				order: undefined,
			},
			{
				column: id("seen"),
				wire: "property",
				key: undefined,
				order: undefined,
			},
			{ column: id("name"), wire: "property", key: "property", order: 1 },
		]);
		// The implicit rule sits on the first shown field, and a hidden field
		// before it makes HQ JSON write it, as HQ's default would otherwise
		// order by the hidden one.
		expect(result.fields[2].rule).toMatchObject({
			implicit: true,
			written: true,
			element: { kind: "property", property: "case_name" },
		});
	});

	it("put the implicit rule on the earlier hidden field that has the shown one's join text", () => {
		const result = plan([
			plainColumn(id("hidden-name"), "case_name", "Name", HIDDEN),
			plainColumn(id("name"), "case_name", "Name"),
		]);
		expect(result.fields[0].rule).toMatchObject({ order: 1, written: true });
		expect(result.fields[0].key).toEqual({
			kind: "property",
			property: "case_name",
		});
		expect(result.fields[1].rule).toBeUndefined();
	});

	it("order on field 0 when the list shows none", () => {
		const result = plan([plainColumn(id("a"), "case_name", "Name", HIDDEN)]);
		expect(result.fields[0].rule).toMatchObject({ order: 1, written: false });
	});

	it("order a hidden interval column by its raw date", () => {
		const result = plan([
			plainColumn(id("name"), "case_name", "Name"),
			intervalColumn(
				id("seen"),
				"visit_date",
				"Seen",
				3,
				"days",
				"flag",
				"Late",
				{
					...HIDDEN,
					sort: asc(),
				},
			),
		]);
		expect(result.fields[1]).toMatchObject({
			wire: "property",
			joinText: "visit_date",
			key: { kind: "property", property: "visit_date" },
			rule: { element: { kind: "property", property: "visit_date" } },
		});
	});
});

describe("authored rules", () => {
	it("number in priority order, compare by the property's type and place blanks by direction", () => {
		const result = plan([
			plainColumn(id("name"), "case_name", "Name", { sort: asc(1) }),
			plainColumn(id("age"), "age", "Age", { sort: desc(0) }),
			plainColumn(id("weight"), "weight", "Weight", { sort: asc(2) }),
		]);
		expect(
			result.fields.map((field) => [
				field.rule?.order,
				field.comparator,
				field.rule?.blanks,
			]),
		).toEqual([
			[2, "text", "first"],
			[1, "integer", "last"],
			[3, "decimal", "first"],
		]);
	});

	it("over a calculated column compare by the expression's resolved type, positionally", () => {
		const result = plan(
			[
				plainColumn(id("name"), "case_name", "Name"),
				calculatedColumn(
					id("calc"),
					"Age next",
					term(prop("household", "age")),
					{
						sort: asc(),
					},
				),
			],
			{ options: options({ calculatedType: () => "int" }) },
		);
		expect(result.fields[1]).toMatchObject({
			key: { kind: "calculated", column: id("calc") },
			comparator: "integer",
			rule: { element: { kind: "positional", position: 1 } },
		});
	});

	it("over a shown interval keep its shown text and stay positional", () => {
		const result = plan([
			intervalColumn(
				id("seen"),
				"visit_date",
				"Seen",
				3,
				"days",
				"always",
				"Late",
				{
					sort: desc(),
				},
			),
		]);
		expect(result.fields[0]).toMatchObject({
			key: { kind: "interval-text", column: id("seen") },
			comparator: "text",
			rule: {
				written: true,
				blanks: "last",
				element: { kind: "positional", position: 0 },
			},
		});
	});

	it("over a shown link join a field over its property", () => {
		const result = plan([
			plainColumn(id("site"), "site", "Site address"),
			linkColumn(id("link"), "site", "Site", "Open", { sort: asc() }),
		]);
		expect(result.fields[0].rule?.element).toEqual({
			kind: "property",
			property: "site",
		});
		expect(result.fields[0].key).toEqual({
			kind: "property",
			property: "site",
		});
		expect(result.fields[1].rule).toBeUndefined();
		expect(result.carriers).toEqual([]);
	});

	it("over a shown link with no field over its property ride a carrier", () => {
		const result = plan([
			plainColumn(id("name"), "case_name", "Name"),
			linkColumn(id("link"), "site", "Site", "Open", { sort: asc() }),
		]);
		expect(result.fields.every((field) => field.rule === undefined)).toBe(true);
		expect(result.carriers).toEqual([
			{
				property: "site",
				comparator: "text",
				rule: expect.objectContaining({
					order: 1,
					element: { kind: "property", property: "site" },
				}),
			},
		]);
		expect(result.authored).toEqual([
			expect.objectContaining({ column: id("link"), landsOn: "carrier" }),
		]);
	});

	it("over a shown link over case_id stay positional and keep the link text", () => {
		const result = plan([
			linkColumn(id("link"), "case_id", "Record", "Open", { sort: asc() }),
		]);
		expect(result.fields[0]).toMatchObject({
			wire: "expression",
			key: { kind: "link-text", column: id("link") },
			rule: { element: { kind: "positional", position: 0 } },
		});
	});
});

describe("the join to the first field with the element's text", () => {
	it("puts a hidden case_id rule on an earlier shown case_id field, which orders by the same id", () => {
		const result = plan([
			plainColumn(id("name"), "case_name", "Name"),
			plainColumn(id("record"), "case_id", "Record ID"),
			plainColumn(id("order"), "case_id", "Record order", {
				...HIDDEN,
				sort: asc(),
			}),
		]);
		expect(result.fields[2]).toMatchObject({ joinText: "@case_id" });
		expect(result.fields[1]).toMatchObject({
			wire: "expression",
			joinText: "@case_id",
			key: { kind: "property", property: "case_id" },
			rule: { order: 1, element: { kind: "positional", position: 2 } },
		});
		expect(result.fields[2].rule).toBeUndefined();
		expect(result.authored).toEqual([
			expect.objectContaining({ column: id("order"), landsOn: 1 }),
		]);
	});

	it("puts a plain status rule after an ID mapping over status on the mapping", () => {
		const result = plan([
			idMappingColumn(id("map"), "status", "State", [
				idMappingEntry("open", "Open"),
			]),
			plainColumn(id("status"), "status", "Status", { sort: asc() }),
		]);
		// Both read status as an attribute, so both are `@status` expressions.
		expect(result.fields[0]).toMatchObject({
			joinText: "@status",
			key: { kind: "mapping-position", column: id("map") },
			rule: { order: 1 },
		});
		expect(result.authored).toEqual([
			expect.objectContaining({
				column: id("status"),
				ownKey: { kind: "property", property: "status" },
				landsOn: 0,
			}),
		]);
	});

	it("puts a rule on the second of two equal calculations on the first", () => {
		const expression = term(prop("household", "zone"));
		const result = plan([
			calculatedColumn(id("first"), "Zone", expression),
			calculatedColumn(id("second"), "Zone again", expression, { sort: asc() }),
		]);
		expect(result.fields[0].rule?.element).toEqual({
			kind: "positional",
			position: 1,
		});
		expect(result.fields[1].rule).toBeUndefined();
	});

	it("keeps the later of two rules over one property name and numbers the rest densely", () => {
		const result = plan([
			plainColumn(id("phone"), "phone", "Phone", { sort: asc(0) }),
			plainColumn(id("name"), "case_name", "Name", { sort: asc(1) }),
			plainColumn(id("phone-2"), "phone", "Phone again", {
				...HIDDEN,
				sort: desc(2),
			}),
		]);
		expect(
			result.fields.map((field) => [field.rule?.order, field.rule?.direction]),
		).toEqual([
			[2, "desc"],
			[1, "asc"],
			[undefined, undefined],
		]);
		expect(result.authored.map((rule) => rule.landsOn)).toEqual([
			undefined,
			1,
			0,
		]);
	});
});

describe("a tile list", () => {
	const TILE = {};

	it("has no field for a column hidden from Results, and its rule rides a bare-name carrier", () => {
		const result = plan(
			[
				plainColumn(id("name"), "case_name", "Name"),
				plainColumn(id("rank"), "case_name", "Rank", {
					...HIDDEN,
					sort: asc(0),
				}),
				plainColumn(id("owner"), "owner_id", "Owner", {
					...HIDDEN,
					sort: desc(1),
				}),
				plainColumn(id("status"), "status", "Status", {
					...HIDDEN,
					sort: asc(2),
				}),
				plainColumn(id("unsorted"), "zone", "Zone", HIDDEN),
			],
			{ tile: TILE },
		);
		expect(result.fields.map((field) => field.column.uuid)).toEqual([
			id("name"),
		]);
		// The first rule's text is a field's, so it joins that field.
		expect(result.fields[0].rule).toMatchObject({ order: 1 });
		expect(
			result.carriers.map((carrier) => [carrier.property, carrier.rule.order]),
		).toEqual([
			["owner_id", 2],
			["status", 3],
		]);
	});

	it("gives a shown link over owner_id a carrier named owner_id", () => {
		const result = plan(
			[linkColumn(id("owner"), "owner_id", "Owner", "Owner", { sort: asc() })],
			{ tile: TILE },
		);
		expect(result.carriers.map((carrier) => carrier.property)).toEqual([
			"owner_id",
		]);
	});

	it("leaves out a hidden calculated rule and a hidden case_id rule, which have no element", () => {
		const result = plan(
			[
				plainColumn(id("name"), "case_name", "Name"),
				calculatedColumn(id("calc"), "Calc", term(prop("household", "zone")), {
					...HIDDEN,
					sort: asc(0),
				}),
				plainColumn(id("record"), "case_id", "Record", {
					...HIDDEN,
					sort: asc(1),
				}),
			],
			{ tile: TILE },
		);
		expect(result.authored).toEqual([]);
		expect(result.carriers).toEqual([]);
		// With no rule left the list takes the implicit rule.
		expect(result.fields[0].rule).toMatchObject({ implicit: true });
	});
});

describe("an image map's key", () => {
	const shown = (entries: number) =>
		imageMapColumn(
			id("map"),
			"zone",
			"Zone",
			entries === 0 ? [] : [imageMapEntry("2", IMAGE)],
		);

	it("is the mapping position for a map with no entries, with media off and on", () => {
		for (const mediaOn of [false, true]) {
			expect(
				plan([shown(0)], { options: options({ mediaOn }) }).fields[0].key,
			).toEqual({ kind: "mapping-position", column: id("map") });
		}
	});

	it("is the mapping position for a map with entries with media on alone", () => {
		expect(plan([shown(1)]).fields[0].key).toEqual({
			kind: "mapping-position",
			column: id("map"),
		});
		expect(
			plan([shown(1)], { options: options({ mediaOn: false }) }).fields[0].key,
		).toEqual({ kind: "property", property: "zone" });
	});
});

describe("whether the list orders by a mapping table", () => {
	const map = (slots: Parameters<typeof idMappingColumn>[4] = {}) =>
		idMappingColumn(
			id("map"),
			"zone",
			"Zone",
			[idMappingEntry("2", "North")],
			slots,
		);
	const name = plainColumn(id("name"), "case_name", "Name");

	it("does where the mapping carries a rule, its own or the implicit one", () => {
		expect(
			caseListOrdersByMapping(plan([name, map({ sort: asc() })]), id("map")),
		).toBe(true);
		expect(caseListOrdersByMapping(plan([map(), name]), id("map"))).toBe(true);
	});

	it("does not where the list orders by another column", () => {
		expect(caseListOrdersByMapping(plan([name, map()]), id("map"))).toBe(false);
	});

	it("does not where the mapping is hidden from Results", () => {
		expect(
			caseListOrdersByMapping(
				plan([name, map({ ...HIDDEN, sort: asc() })]),
				id("map"),
			),
		).toBe(false);
	});

	it("does not for an image map written without its images", () => {
		const image = imageMapColumn(
			id("map"),
			"zone",
			"Zone",
			[imageMapEntry("2", IMAGE)],
			{ sort: asc() },
		);
		expect(caseListOrdersByMapping(plan([image]), id("map"))).toBe(true);
		expect(
			caseListOrdersByMapping(
				plan([image], { options: options({ mediaOn: false }) }),
				id("map"),
			),
		).toBe(false);
	});
});
