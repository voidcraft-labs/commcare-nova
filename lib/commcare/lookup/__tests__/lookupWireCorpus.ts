/** Typed persistence inputs for both emitted lookup carriers and native HQ proof. */
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { validateLookupRowValues } from "@/lib/lookup/coercion";
import {
	createLookupTableInputSchema,
	parseLookupRevision,
} from "@/lib/lookup/schema";
import type {
	LookupColumn,
	LookupDataType,
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";

export function wireUuid(label: string): string {
	const id = testUuid(label);
	return `${id.slice(0, 14)}7${id.slice(15)}`;
}

export function wireTable(
	tag: string,
	specs: readonly { name: string; type: LookupDataType }[],
): LookupTableDefinition {
	const columns: LookupColumn[] = specs.map(({ name, type }) => ({
		id: lookupColumnIdSchema.parse(wireUuid(`lookup-${tag}-${name}`)),
		wireName: name,
		label: name,
		dataType: type,
	}));
	const input = createLookupTableInputSchema.parse({
		name: tag,
		tag,
		columns: columns.map(({ id: _id, ...column }) => column),
	});
	return {
		id: lookupTableIdSchema.parse(wireUuid(`lookup-${tag}`)),
		name: input.name,
		tag: input.tag,
		definitionRevision: parseLookupRevision("1"),
		columns,
	};
}
export function wireRow(
	table: LookupTableDefinition,
	key: string,
	cells: Record<string, string | number>,
): LookupFixtureRow {
	const values = Object.fromEntries(
		Object.entries(cells).map(([name, value]) => {
			const column = table.columns.find((column) => column.wireName === name);
			if (!column) throw new Error(`Unknown fixture column ${name}`);
			return [column.id, value];
		}),
	);
	const checked = validateLookupRowValues(table.columns, values);
	if (!checked.success) throw new Error(JSON.stringify(checked));
	return {
		id: lookupRowIdSchema.parse(wireUuid(`lookup-${table.tag}-${key}`)),
		values: checked.values,
	};
}
export function lookupWireCorpus() {
	const wide = wireTable("records", [
		{ name: "code", type: "text" },
		{ name: "text", type: "text" },
		{ name: "qty", type: "int" },
		{ name: "ratio", type: "decimal" },
		{ name: "day", type: "date" },
		{ name: "time", type: "time" },
		{ name: "instant", type: "datetime" },
	]);
	const narrow = wireTable("empty", [{ name: "code", type: "text" }]);
	const expected = [
		[
			"a",
			"A <雪> & café",
			"-12",
			"0.0000001",
			"2026-09-06",
			"13:45:00Z",
			"2026-09-06T13:45:00.000Z",
		],
		["b", "", "0", "1000000000000000000000", "", "", ""],
		["c", "00123", "2147483647", "-2.5", "", "", ""],
		["d", "=SUM(1,2)", "", "", "", "", ""],
		["e", "line one\r\nline two", "", "", "", "", ""],
		["f", "_x0041_", "", "", "", "", ""],
	];
	const rows = [
		wireRow(wide, "a", {
			code: "a",
			text: "A <雪> & café",
			qty: -12,
			ratio: 1e-7,
			day: "2026-09-06",
			time: "13:45:00Z",
			instant: "2026-09-06T13:45:00.000Z",
		}),
		wireRow(wide, "b", { code: "b", qty: 0, ratio: 1e21 }),
		wireRow(wide, "c", {
			code: "c",
			text: "00123",
			qty: 2147483647,
			ratio: -2.5,
		}),
		wireRow(wide, "d", { code: "d", text: "=SUM(1,2)" }),
		wireRow(wide, "e", { code: "e", text: "line one\r\nline two" }),
		wireRow(wide, "f", { code: "f", text: "_x0041_" }),
	];
	return {
		definitions: [wide, narrow],
		rowsByTable: new Map([
			[wide.id, rows],
			[narrow.id, []],
		]),
		expected: [
			{ tag: "empty", columns: ["code"], rows: [] },
			{
				tag: "records",
				columns: ["code", "text", "qty", "ratio", "day", "time", "instant"],
				rows: expected,
			},
		],
	};
}
