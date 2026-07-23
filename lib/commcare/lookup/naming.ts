/**
 * Identity-to-wire-name resolution for lookup carriers.
 *
 * Carriers store immutable `LookupTableId` / `LookupColumnId` UUIDs; the wire
 * speaks the CURRENT tag and column wire names. This module derives one
 * immutable resolver from the exact rows-free definitions the boundary
 * validated, so every emitter prints the same generation the validator saw.
 * The validator proves every referenced identity resolves before emission
 * runs, so an unknown id here is a compiler bug, never an authoring state.
 *
 * The wire vocabulary is CCHQ's lookup-table ("item list") convention: the
 * fixture id is `item-list:<tag>` (`ItemListsProvider.id`), the instance
 * source is `jr://fixture/item-list:<tag>` (`generic_fixture_instances`), and
 * the body nests `<{tag}_list>` around one `<{tag}>` element per row.
 */

import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupColumn, LookupTableDefinition } from "@/lib/lookup/types";

/** CCHQ's fixture-id scheme prefix for lookup tables. */
export const LOOKUP_FIXTURE_ID_PREFIX = "item-list:";

/** Build the `item-list:<tag>` wire instance id for a lookup table tag. */
export function lookupFixtureInstanceId(tag: string): string {
	return `${LOOKUP_FIXTURE_ID_PREFIX}${tag}`;
}

/**
 * Build the `jr://fixture/...` instance source for a lookup fixture id. The
 * runtime resolves the delivered fixture by the substring after the last `/`,
 * so the source must end with the exact fixture id.
 */
export function lookupFixtureInstanceSrc(instanceId: string): string {
	return `jr://fixture/${instanceId}`;
}

/** One table's resolved wire vocabulary. */
export interface LookupTableWireNaming {
	readonly tableId: LookupTableId;
	readonly tag: string;
	/** `item-list:<tag>` — the fixture id and the `instance('...')` id. */
	readonly instanceId: string;
	/** `<{tag}_list>` — the fixture's single body element. */
	readonly listElementName: string;
	/** `<{tag}>` — one element per row. */
	readonly rowElementName: string;
	/** Columns in authored `(order_key, column UUID)` order. */
	readonly columns: readonly LookupColumn[];
	/** Resolve a column id to its current wire name; unknown ids throw. */
	readonly wireNameFor: (columnId: LookupColumnId) => string;
}

/** Immutable tableId → wire vocabulary resolver for one emission run. */
export interface LookupWireNaming {
	/** Tables in the snapshot's order. */
	readonly tables: readonly LookupTableWireNaming[];
	/** Resolve a table id; unknown ids throw. */
	readonly tableFor: (tableId: LookupTableId) => LookupTableWireNaming;
	readonly maybeTableFor: (
		tableId: LookupTableId,
	) => LookupTableWireNaming | undefined;
}

function tableNaming(definition: LookupTableDefinition): LookupTableWireNaming {
	const byColumnId = new Map(
		definition.columns.map((column) => [column.id, column.wireName]),
	);
	return {
		tableId: definition.id,
		tag: definition.tag,
		instanceId: lookupFixtureInstanceId(definition.tag),
		listElementName: `${definition.tag}_list`,
		rowElementName: definition.tag,
		columns: definition.columns,
		wireNameFor: (columnId) => {
			const wireName = byColumnId.get(columnId);
			if (wireName === undefined) {
				throw new Error(
					`lookupWireNaming: column '${columnId}' is not part of table '${definition.id}' in the validated definitions snapshot. Validation must reject a dangling column reference before emission.`,
				);
			}
			return wireName;
		},
	};
}

/**
 * Permissive placeholder naming for validator dry-runs. The operation rules
 * run the real emitters to stay coupled to the portability vocabulary; those
 * runs discard their output, and structural validation separately owns
 * dangling identities, so every id resolves to inert placeholder vocabulary
 * here rather than throwing.
 */
export function inertLookupWireNaming(): LookupWireNaming {
	const tableFor = (tableId: LookupTableId): LookupTableWireNaming => ({
		tableId,
		tag: "nova_lookup",
		instanceId: lookupFixtureInstanceId("nova_lookup"),
		listElementName: "nova_lookup_list",
		rowElementName: "nova_lookup",
		columns: [],
		wireNameFor: () => "nova_lookup_column",
	});
	return {
		tables: [],
		tableFor,
		maybeTableFor: (tableId) => tableFor(tableId),
	};
}

/**
 * Derive the resolver from the exact validated definitions. Accepts both the
 * boundary's `lookupSnapshot.definitions` and a validator context's
 * `definitions` — they are the same array object on the compile path.
 */
export function lookupWireNaming(
	definitions: readonly LookupTableDefinition[],
): LookupWireNaming {
	const tables = definitions.map(tableNaming);
	const byTableId = new Map(tables.map((table) => [table.tableId, table]));
	return {
		tables,
		tableFor: (tableId) => {
			const table = byTableId.get(tableId);
			if (table === undefined) {
				throw new Error(
					`lookupWireNaming: table '${tableId}' is not part of the validated definitions snapshot. Validation must reject a dangling table reference before emission.`,
				);
			}
			return table;
		},
		maybeTableFor: (tableId) => byTableId.get(tableId),
	};
}
