import { describe, expect, it } from "vitest";
import { el } from "@/lib/commcare/elementBuilders";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupCellValue,
	LookupFixtureRow,
	LookupRevision,
	LookupRowId,
	LookupRowValues,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import {
	buildLookupFixtures,
	type CompiledLookupFixture,
	type CompiledLookupFixtureSet,
	lookupFixtureBudgetExcess,
	MAX_LOOKUP_FIXTURE_BYTES,
	MAX_LOOKUP_FIXTURE_CELLS,
	MAX_LOOKUP_FIXTURE_ROWS,
} from "../fixtures";
import { lookupFixtureInstanceId, lookupWireNaming } from "../naming";

const CODE_COL = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;
const NAME_COL = "018f0000-0000-7000-8000-0000000000c2" as LookupColumnId;
const QTY_COL = "018f0000-0000-7000-8000-0000000000c3" as LookupColumnId;

function tableId(tag: string): LookupTableId {
	return `018f0000-0000-7000-8000-table${tag}` as LookupTableId;
}

function vals(entries: Record<string, LookupCellValue>): LookupRowValues {
	return entries as LookupRowValues;
}

let rowSeq = 0;
function row(values: LookupRowValues): LookupFixtureRow {
	rowSeq += 1;
	return { id: `018f0000-0000-7000-8000-row${rowSeq}` as LookupRowId, values };
}

function demoTable(): LookupTableDefinition {
	return {
		id: tableId("demo"),
		name: "Demo",
		tag: "demo",
		definitionRevision: "1" as LookupRevision,
		columns: [
			{ id: CODE_COL, wireName: "code", label: "Code", dataType: "text" },
			{ id: NAME_COL, wireName: "name", label: "Name", dataType: "text" },
			{ id: QTY_COL, wireName: "qty", label: "Qty", dataType: "int" },
		],
	};
}

function oneTextColumnTable(tag: string): LookupTableDefinition {
	return {
		id: tableId(tag),
		name: tag,
		tag,
		definitionRevision: "1" as LookupRevision,
		columns: [{ id: CODE_COL, wireName: "v", label: "V", dataType: "text" }],
	};
}

describe("buildLookupFixtures serialization", () => {
	it("serializes a fixture block byte-for-byte in authored column order", () => {
		const table = demoTable();
		const rows: LookupFixtureRow[] = [
			row(vals({ [CODE_COL]: "a", [NAME_COL]: "Alpha", [QTY_COL]: 1 })),
			// Empty text code, absent name key, present qty: both blank spellings
			// collapse to one empty element per column.
			row(vals({ [CODE_COL]: "", [QTY_COL]: 2 })),
		];

		const set = buildLookupFixtures(
			lookupWireNaming([table]),
			new Map([[table.id, rows]]),
		);

		expect(set.fixtures[0].xml).toBe(
			'<fixture id="item-list:demo"><demo_list>' +
				"<demo><code>a</code><name>Alpha</name><qty>1</qty></demo>" +
				"<demo><code/><name/><qty>2</qty></demo>" +
				"</demo_list></fixture>",
		);
	});

	it("reports bytes as the exact UTF-8 length of the serialized xml", () => {
		const table = demoTable();
		const set = buildLookupFixtures(
			lookupWireNaming([table]),
			new Map([[table.id, [row(vals({ [CODE_COL]: "a" }))]]]),
		);
		const fixture = set.fixtures[0];
		expect(fixture.bytes).toBe(Buffer.byteLength(fixture.xml, "utf8"));
	});

	it("inflates bytes through entity escaping without altering code-point count", () => {
		const table = oneTextColumnTable("esc");
		const naming = lookupWireNaming([table]);
		const special = "a<b&cé";
		const control = "axbxcx"; // same code-point count, no special chars

		const escaped = buildLookupFixtures(
			naming,
			new Map([[table.id, [row(vals({ [CODE_COL]: special }))]]]),
		).fixtures[0];
		const plain = buildLookupFixtures(
			naming,
			new Map([[table.id, [row(vals({ [CODE_COL]: control }))]]]),
		).fixtures[0];

		expect(escaped.xml).toContain("&lt;");
		expect(escaped.xml).toContain("&amp;");
		expect(escaped.xml).toContain("&#xe9;");
		expect(escaped.bytes).toBe(Buffer.byteLength(escaped.xml, "utf8"));
		// Identical code-point count, so the extra bytes are purely escaping.
		expect([...special]).toHaveLength([...control].length);
		expect(escaped.bytes).toBeGreaterThan(plain.bytes);
	});

	it("sorts fixtures by tag regardless of the input definition order", () => {
		const zebra = oneTextColumnTable("zebra");
		const alpha = oneTextColumnTable("alpha");
		const set = buildLookupFixtures(
			lookupWireNaming([zebra, alpha]),
			new Map([
				[zebra.id, []],
				[alpha.id, []],
			]),
		);
		expect(set.fixtures.map((fixture) => fixture.tag)).toEqual([
			"alpha",
			"zebra",
		]);
	});

	it("counts cells as rowCount * columnCount, including a row with no stored values", () => {
		const table = demoTable();
		const rows: LookupFixtureRow[] = [
			row(vals({ [CODE_COL]: "a", [NAME_COL]: "Alpha", [QTY_COL]: 1 })),
			row(vals({})), // zero stored values still contributes columnCount cells
		];
		const set = buildLookupFixtures(
			lookupWireNaming([table]),
			new Map([[table.id, rows]]),
		);
		expect(set.fixtures[0].rowCount).toBe(2);
		expect(set.fixtures[0].cellCount).toBe(6);
		expect(set.totalRows).toBe(2);
		expect(set.totalCells).toBe(6);
	});

	it("throws when the rows map is missing a table entry", () => {
		const table = demoTable();
		expect(() =>
			buildLookupFixtures(lookupWireNaming([table]), new Map()),
		).toThrow(/has no rows entry/);
	});
});

function fakeFixture(spec: {
	tag: string;
	rowCount?: number;
	cellCount?: number;
	bytes?: number;
}): CompiledLookupFixture {
	const instanceId = lookupFixtureInstanceId(spec.tag);
	return {
		tableId: tableId(spec.tag),
		tag: spec.tag,
		instanceId,
		element: el("fixture", { id: instanceId }),
		xml: "",
		bytes: spec.bytes ?? 0,
		rowCount: spec.rowCount ?? 0,
		cellCount: spec.cellCount ?? 0,
	};
}

function fakeSet(
	fixtures: readonly CompiledLookupFixture[],
): CompiledLookupFixtureSet {
	return {
		fixtures,
		totalRows: fixtures.reduce((sum, f) => sum + f.rowCount, 0),
		totalCells: fixtures.reduce((sum, f) => sum + f.cellCount, 0),
		totalBytes: fixtures.reduce((sum, f) => sum + f.bytes, 0),
	};
}

describe("lookup fixture aggregate caps", () => {
	it("pins the three published limits", () => {
		expect(MAX_LOOKUP_FIXTURE_ROWS).toBe(10_000);
		expect(MAX_LOOKUP_FIXTURE_CELLS).toBe(100_000);
		expect(MAX_LOOKUP_FIXTURE_BYTES).toBe(16 * 1024 * 1024);
	});
});

describe("lookupFixtureBudgetExcess", () => {
	it.each([
		["rows", (n: number) => fakeSet([fakeFixture({ tag: "t", rowCount: n })])],
		[
			"cells",
			(n: number) => fakeSet([fakeFixture({ tag: "t", cellCount: n })]),
		],
		["bytes", (n: number) => fakeSet([fakeFixture({ tag: "t", bytes: n })])],
	] as const)(
		"passes at exactly the %s cap and fails one above",
		(axis, make) => {
			const cap =
				axis === "rows"
					? MAX_LOOKUP_FIXTURE_ROWS
					: axis === "cells"
						? MAX_LOOKUP_FIXTURE_CELLS
						: MAX_LOOKUP_FIXTURE_BYTES;

			expect(lookupFixtureBudgetExcess(make(cap - 1))).toBeNull();
			expect(lookupFixtureBudgetExcess(make(cap))).toBeNull();

			const excess = lookupFixtureBudgetExcess(make(cap + 1));
			expect(excess).not.toBeNull();
			expect(excess).toHaveLength(1);
			expect(excess?.[0]).toMatchObject({
				axis,
				actual: cap + 1,
				allowed: cap,
			});
		},
	);

	it("reports the largest contributors first, capped at three", () => {
		const set = fakeSet([
			fakeFixture({ tag: "a", rowCount: 5000 }),
			fakeFixture({ tag: "b", rowCount: 3000 }),
			fakeFixture({ tag: "c", rowCount: 2000 }),
			fakeFixture({ tag: "d", rowCount: 1000 }),
		]);
		const excess = lookupFixtureBudgetExcess(set);
		expect(excess).not.toBeNull();
		const rowsAxis = excess?.[0];
		expect(rowsAxis?.axis).toBe("rows");
		expect(rowsAxis?.actual).toBe(11_000);
		expect(rowsAxis?.largestTables).toEqual([
			{ tag: "a", amount: 5000 },
			{ tag: "b", amount: 3000 },
			{ tag: "c", amount: 2000 },
		]);
	});

	it("breaches an aggregate cap that no single under-limit table crosses alone", () => {
		// Each table holds 4,000 rows — under the 5,000 per-table storage cap —
		// yet three together breach the 10,000 aggregate row cap.
		const set = fakeSet([
			fakeFixture({ tag: "a", rowCount: 4000 }),
			fakeFixture({ tag: "b", rowCount: 4000 }),
			fakeFixture({ tag: "c", rowCount: 4000 }),
		]);
		const excess = lookupFixtureBudgetExcess(set);
		expect(excess).not.toBeNull();
		expect(excess).toHaveLength(1);
		expect(excess?.[0]).toMatchObject({ axis: "rows", actual: 12_000 });
	});

	it("returns one entry per breached axis, in rows/cells/bytes order", () => {
		const set = fakeSet([
			fakeFixture({
				tag: "t",
				rowCount: MAX_LOOKUP_FIXTURE_ROWS + 1,
				cellCount: MAX_LOOKUP_FIXTURE_CELLS + 1,
				bytes: MAX_LOOKUP_FIXTURE_BYTES + 1,
			}),
		]);
		const excess = lookupFixtureBudgetExcess(set);
		expect(excess?.map((entry) => entry.axis)).toEqual([
			"rows",
			"cells",
			"bytes",
		]);
	});
});
