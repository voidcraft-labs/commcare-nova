/**
 * The rules of a lookup table CommCare HQ manages that need no store: the
 * bounds of one inline copy, a column's label, and what
 * `lib/lookup` reads of the canonical value `lib/deployment` stores for the
 * table's last refresh.
 *
 * Pure: nothing here reaches Postgres, CommCare HQ or the bucket, so the
 * findings of a reading and the writers in `managed.ts` judge one table the
 * same way.
 */

import { z } from "zod";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import {
	LOOKUP_MAX_CELL_BYTES,
	LOOKUP_MAX_CHANGE_BYTES,
	LOOKUP_MAX_COLUMN_LABEL_LENGTH,
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_ROWS,
} from "./constants";
import { formatLookupBytesOverCap } from "./format";
import type { NamedLookupRowContent } from "./rowContent";
import { utf8ByteLength } from "./schema";
import { lookupSourceFactsSchema } from "./source";
import type { LookupHqOrigin, LookupManifestHqOrigin } from "./types";

/** What Postgres measured of a table's candidate rows. */
export interface LookupRowsMeasure {
	readonly dataBytes: number;
	readonly largestRowBytes: number;
}

/** CommCare HQ's columns and rows of one table, as a copy takes them. */
export interface ManagedLookupContent {
	readonly attributes?: readonly string[];
	readonly fieldDetails?: Readonly<
		Record<
			string,
			{
				readonly repeated: boolean;
				readonly properties: readonly string[];
				readonly index: "off" | "indexed" | "unobserved";
			}
		>
	>;
	readonly rowDetails?: readonly (NamedLookupRowContent & {
		readonly remoteId: string;
		readonly sortKey?: number;
	})[];
	/** CommCare HQ's field names in its order; each passes `lookupWireNameSchema`. */
	readonly fields: readonly string[];
	/** Rows in CommCare HQ's order: field name to the cell's string. */
	readonly rows: readonly Readonly<Record<string, string>>[];
}

/** What lib/lookup reads of the stored state. */
export const managedCanonicalSchema = z.looseObject({
	source: lookupSourceFactsSchema.optional(),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
	fields: z.array(z.looseObject({ name: z.string() })),
});

function count(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * Each bound of one inline copy the content is past, as a phrase, in this
 * order; empty where one transaction can write the copy. Pure.
 *
 * None of these is a limit on a table. A copy past one of them is read in
 * pages into a staged generation by a Project data refresh
 * (`lib/deployment/managedInventory.ts`), which stores a large value outside
 * its row and holds any number of rows and columns. Rows, columns and cells
 * are counted here; a row's and the copy's stored size are Postgres's measure
 * (`managed.ts::measureLookupRows`), never a guess. A cell of a field the
 * definition does not name is not counted: no device receives it.
 */
export function lookupInlineCopyExcess(
	content: ManagedLookupContent,
	measured: LookupRowsMeasure,
): readonly string[] {
	const phrases: string[] = [];
	if (content.rows.length > LOOKUP_MAX_ROWS) {
		phrases.push(`${count(content.rows.length)} rows`);
	}
	if (content.fields.length > LOOKUP_MAX_COLUMNS) {
		phrases.push(`${count(content.fields.length)} columns`);
	}
	let largestCellBytes = 0;
	for (const row of content.rows) {
		for (const field of content.fields) {
			if (!Object.hasOwn(row, field)) continue;
			const bytes = utf8ByteLength(row[field]);
			if (bytes > largestCellBytes) largestCellBytes = bytes;
		}
	}
	if (largestCellBytes > LOOKUP_MAX_CELL_BYTES) {
		phrases.push(`a value of ${formatLookupBytesOverCap(largestCellBytes)}`);
	}
	if (measured.largestRowBytes > LOOKUP_MAX_ROW_BYTES) {
		phrases.push(
			`a row of ${formatLookupBytesOverCap(measured.largestRowBytes)}`,
		);
	}
	if (measured.dataBytes > LOOKUP_MAX_CHANGE_BYTES) {
		phrases.push(`${formatLookupBytesOverCap(measured.dataBytes)} of rows`);
	}
	return phrases;
}

/**
 * The sentence a writer of a managed copy refuses with when one inline copy
 * cannot carry the table. `phrases` are `lookupInlineCopyExcess`'s.
 */
export function managedLookupInlineCopyRefusal(
	tag: string,
	phrases: readonly string[],
): string {
	return `The lookup table ${tag} has ${phrases.join(" and ")} in CommCare HQ, more than Nova copies in one read, so nothing was written. Nova reads a table this size in pages when you refresh it from Project data.`;
}

/**
 * A column's label for a field of CommCare HQ's: the name's first 120
 * characters. The wire name carries the whole name; a label longer than 120
 * would fail `lookup_columns`' label check. PostgreSQL counts Unicode scalars.
 */
export function columnLabelFor(name: string): string {
	return [...name].slice(0, LOOKUP_MAX_COLUMN_LABEL_LENGTH).join("");
}

/** The origin columns of a stored table, as every reader selects them. */
export interface StoredLookupHqColumns {
	readonly hq_server: string | null;
	readonly hq_domain: string | null;
	readonly hq_remote_id: string | null;
	readonly hq_canonical: unknown;
	readonly hq_brought_in_at: Date | null;
	readonly hq_refreshed_at: Date | null;
	readonly hq_taken_over_at: Date | null;
	readonly hq_taken_over_by: string | null;
}

function partOfAnOrigin(): never {
	throw new Error(
		"A lookup table's CommCare HQ origin was stored only in part.",
	);
}

/**
 * A stored table's origin as the manifest carries it, or undefined for a
 * table made in Nova. It leaves out the day of the last refresh, which a
 * refresh that changed nothing stamps without advancing the Project
 * revision.
 */
export function lookupManifestHqOriginOf(
	table: StoredLookupHqColumns,
): LookupManifestHqOrigin | undefined {
	if (table.hq_server === null) return undefined;
	if (
		table.hq_domain === null ||
		table.hq_remote_id === null ||
		table.hq_brought_in_at === null ||
		table.hq_refreshed_at === null
	) {
		partOfAnOrigin();
	}
	const { source } = managedCanonicalSchema.parse(table.hq_canonical);
	return {
		...(source === undefined ? {} : { source }),
		server: table.hq_server,
		domain: table.hq_domain,
		remoteId: table.hq_remote_id,
		managedBy: table.hq_taken_over_at === null ? "commcare-hq" : "nova",
		broughtInAt: table.hq_brought_in_at.toISOString(),
		takenOverAt: table.hq_taken_over_at?.toISOString() ?? null,
		takenOverBy: table.hq_taken_over_by,
	};
}

/**
 * A stored table's origin, or undefined for a table made in Nova. While
 * CommCare HQ manages the table, `goneColumnIds` is every column whose wire
 * name is in no field of CommCare HQ's table at the last refresh. A table
 * Nova manages has none: its stored copy of CommCare HQ's table is not read
 * again while Nova manages it, so a column added or renamed in Nova would
 * otherwise read as gone from CommCare HQ though it was never there.
 */
export function lookupHqOriginOf(
	table: StoredLookupHqColumns,
	columns: readonly {
		readonly id: LookupColumnId;
		readonly wireName: string;
	}[],
): LookupHqOrigin | undefined {
	const origin = lookupManifestHqOriginOf(table);
	if (origin === undefined) return undefined;
	if (table.hq_refreshed_at === null) partOfAnOrigin();
	const goneColumnIds: LookupColumnId[] = [];
	if (origin.managedBy === "commcare-hq") {
		const canonical = managedCanonicalSchema.parse(table.hq_canonical);
		const fields = new Set(canonical.fields.map((field) => field.name));
		for (const column of columns) {
			if (!fields.has(column.wireName)) goneColumnIds.push(column.id);
		}
	}
	return {
		...origin,
		refreshedAt: table.hq_refreshed_at.toISOString(),
		goneColumnIds,
	};
}
