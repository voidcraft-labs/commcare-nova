import { describe, expect, it } from "vitest";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupRevision, LookupTableDefinition } from "@/lib/lookup/types";
import {
	inertLookupWireNaming,
	lookupFixtureInstanceId,
	lookupFixtureInstanceSrc,
	lookupWireNaming,
} from "../naming";

const TABLE = "018f0000-0000-7000-8000-0000000000a1" as LookupTableId;
const VALUE_COL = "018f0000-0000-7000-8000-0000000000b1" as LookupColumnId;
const LABEL_COL = "018f0000-0000-7000-8000-0000000000b2" as LookupColumnId;
const UNKNOWN_TABLE = "018f0000-0000-7000-8000-0000000000ff" as LookupTableId;
const UNKNOWN_COLUMN = "018f0000-0000-7000-8000-0000000000fe" as LookupColumnId;

const definitions: readonly LookupTableDefinition[] = [
	{
		id: TABLE,
		name: "Statuses",
		tag: "statuses",
		definitionRevision: "6" as LookupRevision,
		columns: [
			{ id: VALUE_COL, wireName: "value", label: "Value", dataType: "text" },
			{ id: LABEL_COL, wireName: "label", label: "Label", dataType: "text" },
		],
	},
];

describe("lookupFixtureInstanceId / lookupFixtureInstanceSrc", () => {
	it("builds the item-list fixture id from a table tag", () => {
		expect(lookupFixtureInstanceId("statuses")).toBe("item-list:statuses");
	});

	it("builds the jr fixture src from an instance id", () => {
		expect(lookupFixtureInstanceSrc("item-list:statuses")).toBe(
			"jr://fixture/item-list:statuses",
		);
	});
});

describe("lookupWireNaming", () => {
	it("resolves a table's full wire vocabulary from its definition", () => {
		const naming = lookupWireNaming(definitions);
		expect(naming.tables).toHaveLength(1);

		const table = naming.tableFor(TABLE);
		expect(table.tag).toBe("statuses");
		expect(table.instanceId).toBe("item-list:statuses");
		expect(table.listElementName).toBe("statuses_list");
		expect(table.rowElementName).toBe("statuses");
		expect(table.wireNameFor(VALUE_COL)).toBe("value");
		expect(table.wireNameFor(LABEL_COL)).toBe("label");
	});

	it("throws for an unknown table id", () => {
		const naming = lookupWireNaming(definitions);
		expect(() => naming.tableFor(UNKNOWN_TABLE)).toThrow(
			/not part of the validated definitions snapshot/,
		);
	});

	it("throws for an unknown column id", () => {
		const naming = lookupWireNaming(definitions);
		expect(() => naming.tableFor(TABLE).wireNameFor(UNKNOWN_COLUMN)).toThrow(
			/is not part of table/,
		);
	});

	it("returns undefined from maybeTableFor for an unknown table, the resolved table otherwise", () => {
		const naming = lookupWireNaming(definitions);
		expect(naming.maybeTableFor(UNKNOWN_TABLE)).toBeUndefined();
		expect(naming.maybeTableFor(TABLE)).toBe(naming.tableFor(TABLE));
	});
});

describe("inertLookupWireNaming", () => {
	it("resolves any id to inert placeholder vocabulary without throwing", () => {
		const naming = inertLookupWireNaming();
		expect(naming.tables).toHaveLength(0);

		const table = naming.tableFor(UNKNOWN_TABLE);
		expect(table.tag).toBe("nova_lookup");
		expect(table.instanceId).toBe("item-list:nova_lookup");
		expect(table.listElementName).toBe("nova_lookup_list");
		expect(table.rowElementName).toBe("nova_lookup");
		expect(table.wireNameFor(UNKNOWN_COLUMN)).toBe("nova_lookup_column");
		expect(naming.maybeTableFor(UNKNOWN_TABLE)?.tag).toBe("nova_lookup");
	});
});
