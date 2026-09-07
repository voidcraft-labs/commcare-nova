import { isTag } from "domhandler";
import { textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { el } from "@/lib/commcare/elementBuilders";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	buildLookupFixtures,
	type CompiledLookupFixture,
	type CompiledLookupFixtureSet,
	lookupFixtureBudgetExcess,
	MAX_LOOKUP_FIXTURE_BYTES,
	MAX_LOOKUP_FIXTURE_CELLS,
	MAX_LOOKUP_FIXTURE_ROWS,
} from "../fixtures";
import { lookupFixtureId, lookupWireNaming } from "../naming";
import {
	lookupWireCorpus,
	wireRow,
	wireTable,
	wireUuid,
} from "./lookupWireCorpus";

describe("lookup fixture serialization", () => {
	it("preserves admitted typed values, absent cells, shape and order in independent XML decoding", () => {
		const corpus = lookupWireCorpus();
		const before = structuredClone(corpus);
		const set = buildLookupFixtures(
			lookupWireNaming(corpus.definitions),
			corpus.rowsByTable,
		);
		expect(set.fixtures.map((fixture) => fixture.tag)).toEqual([
			"empty",
			"records",
		]);
		for (const [index, fixture] of set.fixtures.entries()) {
			const expected = corpus.expected[index];
			new SaxesParser({ xmlns: true }).write(fixture.xml).close();
			const roots = parseDocument(fixture.xml, {
				xmlMode: true,
			}).children.filter(isTag);
			expect(roots).toHaveLength(1);
			expect(roots[0].name).toBe("fixture");
			expect(roots[0].attribs).toEqual({ id: `item-list:${expected.tag}` });
			const bodies = roots[0].children.filter(isTag);
			expect(bodies).toHaveLength(1);
			expect(bodies[0].name).toBe(`${expected.tag}_list`);
			const rows = bodies[0].children.filter(isTag);
			expect(rows.map((row) => row.name)).toEqual(
				expected.rows.map(() => expected.tag),
			);
			for (const row of rows)
				expect(row.children.filter(isTag).map((cell) => cell.name)).toEqual(
					expected.columns,
				);
			expect(
				rows.map((row) => row.children.filter(isTag).map(textContent)),
			).toEqual(expected.rows);
			expect(fixture.rowCount).toBe(rows.length);
			expect(fixture.cellCount).toBe(
				rows.reduce((sum, row) => sum + row.children.filter(isTag).length, 0),
			);
			expect(fixture.bytes).toBe(Buffer.byteLength(fixture.xml));
		}
		expect(set.totalRows).toBe(6);
		expect(set.totalCells).toBe(42);
		expect(set.totalBytes).toBe(
			set.fixtures.reduce(
				(sum, fixture) => sum + Buffer.byteLength(fixture.xml),
				0,
			),
		);
		expect(corpus).toEqual(before);
	});
	it("includes every defined cell when the stored row has no values", () => {
		const table = wireTable("blank", [
			{ name: "one", type: "text" },
			{ name: "two", type: "decimal" },
		]);
		const result = buildLookupFixtures(
			lookupWireNaming([table]),
			new Map([[table.id, [wireRow(table, "empty", {})]]]),
		);
		expect(result.fixtures[0].xml).toBe(
			'<fixture id="item-list:blank"><blank_list><blank><one/><two/></blank></blank_list></fixture>',
		);
		expect(result.totalCells).toBe(2);
	});
	it("refuses a snapshot missing its rows", () => {
		const table = wireTable("blank", [{ name: "value", type: "text" }]);
		expect(() =>
			buildLookupFixtures(lookupWireNaming([table]), new Map()),
		).toThrow(/no rows entry/);
	});
});

// Synthetic measured summaries exercise only the pure budget decision. The
// serialization test above and export boundary suite own measuring actual data.
function fakeFixture(spec: {
	tag: string;
	rowCount?: number;
	cellCount?: number;
	bytes?: number;
}): CompiledLookupFixture {
	const fixtureId = lookupFixtureId(spec.tag);
	return {
		tableId: lookupTableIdSchema.parse(wireUuid(spec.tag)),
		tag: spec.tag,
		fixtureId,
		element: el("fixture", { id: fixtureId }),
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
