import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { StreamingLookupTable } from "@/lib/lookup/archiveRows";
import {
	type LookupFixtureBudget,
	type LookupFixtureMeasure,
	lookupFixtureBudget,
	MAX_LOOKUP_FIXTURE_BYTES,
	MAX_LOOKUP_FIXTURE_CELLS,
} from "./fixtures";
import { type LookupTableWireNaming, lookupWireNaming } from "./naming";
import { streamWorkerFixtureRow } from "./streamFixture";

function fixtureTags(naming: LookupTableWireNaming) {
	const prefix = `<fixture id="${naming.fixtureId}">`;
	const list = naming.listElementName;
	return {
		marker: `${prefix}<${list}/></fixture>`,
		start: `${prefix}<${list}>`,
		end: `</${list}></fixture>`,
	};
}

/** Charge the XML that the archive will stream. Counts stop at the first
 * breached runtime limit so rejecting an oversized value stays bounded. */
export async function measureStreamedLookupFixtures(
	planned: LookupFixtureBudget,
	tables: readonly StreamingLookupTable[],
) {
	const measures = new Map(
		planned.fixtures.map((item) => [item.tableId, item]),
	);
	let bytes = planned.totalBytes;
	let cells = planned.totalCells;
	for (const table of tables) {
		const naming = lookupWireNaming([table.definition]).tableFor(
			table.definition.id,
		);
		const { start, end } = fixtureTags(naming);
		const previous = measures.get(naming.tableId);
		const measured = {
			tableId: naming.tableId,
			tag: naming.tag,
			rowCount: table.count,
			bytes: Buffer.byteLength(start + end),
			cellCount: 0,
		};
		measures.set(naming.tableId, measured);
		bytes += measured.bytes - (previous?.bytes ?? 0);
		cells -= previous?.cellCount ?? 0;
		const onCell = () => {
			cells++;
			measured.cellCount++;
		};
		for await (const { row, read } of table.reader.rows()) {
			for await (const chunk of streamWorkerFixtureRow(
				naming,
				row,
				read,
				onCell,
			)) {
				bytes += chunk.byteLength;
				measured.bytes += chunk.byteLength;
				if (
					cells > MAX_LOOKUP_FIXTURE_CELLS ||
					bytes > MAX_LOOKUP_FIXTURE_BYTES
				)
					return {
						budget: lookupFixtureBudget([...measures.values()]),
						incomplete: true,
					};
			}
		}
	}
	return {
		budget: lookupFixtureBudget([...measures.values()]),
		incomplete: false,
	};
}

/** Row counts already belong to the locked snapshot, including streamed
 * placeholders whose XML the compiler has deliberately left empty. */
export function plannedLookupFixtureBudget(
	inline: LookupFixtureBudget,
	rowsByTable: ReadonlyMap<LookupTableId, { rowCount: number }>,
) {
	const fixtures: LookupFixtureMeasure[] = inline.fixtures.map((item) => ({
		...item,
		rowCount: rowsByTable.get(item.tableId)?.rowCount ?? item.rowCount,
	}));
	return lookupFixtureBudget(fixtures);
}

/** The compiler validates each structural fixture, including its sole list
 * element. Only its certified empty body marker is replaced with worker rows. */
export function suiteWithStreamedRows(
	suite: string,
	tables: readonly StreamingLookupTable[],
) {
	return {
		path: "suite.xml",
		async *open() {
			let cursor = 0;
			const parts = tables
				.map((table) => {
					const naming = lookupWireNaming([table.definition]).tableFor(
						table.definition.id,
					);
					const { marker, start: open, end: close } = fixtureTags(naming);
					const start = suite.indexOf(marker);
					if (start < 0 || suite.indexOf(marker, start + 1) !== -1)
						throw new Error(
							"A streamed fixture needs one compiled suite marker.",
						);
					return {
						start,
						end: start + marker.length,
						table,
						naming,
						open,
						close,
					};
				})
				.sort((a, b) => a.start - b.start);
			for (const { start, end, table, naming, open, close } of parts) {
				yield Buffer.from(suite.slice(cursor, start) + open);
				for await (const { row, read } of table.reader.rows())
					yield* streamWorkerFixtureRow(naming, row, read);
				yield Buffer.from(close);
				cursor = end;
			}
			yield Buffer.from(suite.slice(cursor));
		},
	};
}
