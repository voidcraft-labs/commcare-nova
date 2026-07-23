/**
 * Deterministic suite-embedded lookup fixtures and the aggregate budgets.
 *
 * The local `.ccz` embeds each referenced table as a GLOBAL suite fixture:
 * `<fixture id="item-list:<tag>">` with no `user_id` attribute (Core's
 * `FixtureXmlParser` stores a user-id-less fixture as global), one
 * `<{tag}_list>` body element, one `<{tag}>` element per row in authored
 * `(order_key, row UUID)` order, and every defined column as a child element
 * in authored column order — a missing cell and a stored empty text cell both
 * emit one empty element, matching HQ's `ItemListsProvider` body shape so the
 * same compiled XPaths work whichever path later delivers the data.
 *
 * The aggregate budgets bound the compiled artifact, not storage: the
 * unindexed runtime materializes every fixture element as an object-heavy
 * `TreeElement`, so a byte cap alone would still admit a cell cardinality the
 * device cannot hold. Bytes are the exact UTF-8 length of each serialized
 * `<fixture>` block — wrappers, names, attributes, escaping, and blank
 * elements — before archive compression, measured on the same render the
 * suite serializer performs.
 */

import render from "dom-serializer";
import type { Element } from "domhandler";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupFixtureRow } from "@/lib/lookup/types";
import { el, RENDER_OPTS, text } from "../elementBuilders";
import { lookupFixtureCellText } from "./cellText";
import type { LookupTableWireNaming, LookupWireNaming } from "./naming";

/** Aggregate caps across every table one exported app references. */
export const MAX_LOOKUP_FIXTURE_ROWS = 10_000;
export const MAX_LOOKUP_FIXTURE_CELLS = 100_000;
export const MAX_LOOKUP_FIXTURE_BYTES = 16 * 1024 * 1024;

export interface CompiledLookupFixture {
	readonly tableId: LookupTableId;
	readonly tag: string;
	/** `item-list:<tag>` — fixture id, instance id, and src suffix. */
	readonly instanceId: string;
	/** The suite-embeddable `<fixture>` element. */
	readonly element: Element;
	/** Exact serialized block under the shared suite render options. */
	readonly xml: string;
	/** Exact UTF-8 bytes of `xml`. */
	readonly bytes: number;
	readonly rowCount: number;
	/** `rowCount * columnCount` — the wire emits every defined column. */
	readonly cellCount: number;
}

export interface CompiledLookupFixtureSet {
	/** Fixtures sorted by tag, matching HQ's per-restore table order. */
	readonly fixtures: readonly CompiledLookupFixture[];
	readonly totalRows: number;
	readonly totalCells: number;
	readonly totalBytes: number;
}

function buildFixtureElement(
	table: LookupTableWireNaming,
	rows: readonly LookupFixtureRow[],
): Element {
	const rowElements = rows.map((row) =>
		el(
			table.rowElementName,
			{},
			table.columns.map((column) => {
				const value = lookupFixtureCellText(
					column.dataType,
					row.values[column.id],
				);
				return el(column.wireName, {}, value === "" ? [] : [text(value)]);
			}),
		),
	);
	return el("fixture", { id: table.instanceId }, [
		el(table.listElementName, {}, rowElements),
	]);
}

/**
 * Build every referenced table's fixture block from one snapshot generation.
 * `rowsByTable` must carry an entry for every table in `naming` — both come
 * from the same `LookupFixtureDataSnapshot`, so a gap is a reader bug.
 */
export function buildLookupFixtures(
	naming: LookupWireNaming,
	rowsByTable: ReadonlyMap<LookupTableId, readonly LookupFixtureRow[]>,
): CompiledLookupFixtureSet {
	const fixtures = [...naming.tables]
		.sort((left, right) =>
			left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0,
		)
		.map((table): CompiledLookupFixture => {
			const rows = rowsByTable.get(table.tableId);
			if (rows === undefined) {
				throw new Error(
					`buildLookupFixtures: table '${table.tableId}' has no rows entry in the fixture snapshot. Definitions and rows must come from one snapshot read — this is a reader bug, not an authoring state.`,
				);
			}
			const element = buildFixtureElement(table, rows);
			const xml = render(element, RENDER_OPTS);
			return {
				tableId: table.tableId,
				tag: table.tag,
				instanceId: table.instanceId,
				element,
				xml,
				bytes: Buffer.byteLength(xml, "utf8"),
				rowCount: rows.length,
				cellCount: rows.length * table.columns.length,
			};
		});
	return {
		fixtures,
		totalRows: fixtures.reduce((sum, fixture) => sum + fixture.rowCount, 0),
		totalCells: fixtures.reduce((sum, fixture) => sum + fixture.cellCount, 0),
		totalBytes: fixtures.reduce((sum, fixture) => sum + fixture.bytes, 0),
	};
}

/**
 * Everything the CCZ compiler consumes for lookup wire emission: the
 * identity resolver and the pre-built fixture blocks, both derived from the
 * one validated snapshot at the export boundary. The compiler embeds the
 * exact elements the budget measured — a rebuild could not diverge, but
 * reusing the built set keeps measurement and emission one artifact.
 */
export interface PreparedLookupWire {
	readonly naming: LookupWireNaming;
	readonly fixtures: CompiledLookupFixtureSet;
}

export interface LookupFixtureBudgetAxis {
	readonly axis: "rows" | "cells" | "bytes";
	readonly actual: number;
	readonly allowed: number;
	/** Heaviest contributors on this axis, largest first, at most three. */
	readonly largestTables: readonly {
		readonly tag: string;
		readonly amount: number;
	}[];
}

/**
 * Return every breached aggregate axis, or `null` when the set fits. Each
 * axis reports its own largest contributors so the remediation names the
 * tables an author would actually shrink.
 */
export function lookupFixtureBudgetExcess(
	set: CompiledLookupFixtureSet,
): readonly LookupFixtureBudgetAxis[] | null {
	const axes: LookupFixtureBudgetAxis[] = [];
	const contributors = (
		amount: (fixture: CompiledLookupFixture) => number,
	): LookupFixtureBudgetAxis["largestTables"] =>
		[...set.fixtures]
			.sort((left, right) => amount(right) - amount(left))
			.slice(0, 3)
			.map((fixture) => ({ tag: fixture.tag, amount: amount(fixture) }));
	if (set.totalRows > MAX_LOOKUP_FIXTURE_ROWS) {
		axes.push({
			axis: "rows",
			actual: set.totalRows,
			allowed: MAX_LOOKUP_FIXTURE_ROWS,
			largestTables: contributors((fixture) => fixture.rowCount),
		});
	}
	if (set.totalCells > MAX_LOOKUP_FIXTURE_CELLS) {
		axes.push({
			axis: "cells",
			actual: set.totalCells,
			allowed: MAX_LOOKUP_FIXTURE_CELLS,
			largestTables: contributors((fixture) => fixture.cellCount),
		});
	}
	if (set.totalBytes > MAX_LOOKUP_FIXTURE_BYTES) {
		axes.push({
			axis: "bytes",
			actual: set.totalBytes,
			allowed: MAX_LOOKUP_FIXTURE_BYTES,
			largestTables: contributors((fixture) => fixture.bytes),
		});
	}
	return axes.length > 0 ? axes : null;
}
