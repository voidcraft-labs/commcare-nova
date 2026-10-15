/**
 * The lookup-table and place half of the drift check: the canonical value a
 * baseline stores for each, and the comparisons that read HQ's current state
 * against it.
 *
 * Like the app's, every baseline here is HQ's own read after Nova's push,
 * never what Nova sent, and no row values are stored: a table keeps digests
 * of its definition and of its rows in HQ's order, and a place keeps only
 * the fields a push writes.
 *
 * Pure: no I/O, no store. Every sentence a person reads about a part is in
 * `remoteChanges.ts`.
 */

import type { HqLocation } from "@/lib/commcare/hq/locations";
import type {
	HqFixtureRow,
	HqLookupTable,
} from "@/lib/commcare/hq/lookupTables";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { CanonicalLookupTable, CanonicalPlace } from "./types";

export type LookupChangePart =
	| { readonly kind: "deleted" }
	/** The tag HQ's table carries now. */
	| { readonly kind: "renamed"; readonly tag: string }
	| { readonly kind: "definition" }
	| { readonly kind: "rows" };

export type PlaceChangePart = {
	readonly kind:
		| "missing"
		| "name"
		| "site-code"
		| "level"
		| "parent"
		| "coordinates"
		| "information";
};

/**
 * The digest of "CommCare HQ no longer holds this", so an absence can be
 * confirmed like any other state.
 */
export const ABSENT_RESOURCE_DIGEST: string = canonicalJsonDigest({
	absent: true,
});

function definitionOf(table: HqLookupTable) {
	return {
		tag: table.tag,
		isGlobal: table.isGlobal,
		fields: table.fields.map((name) => ({
			name,
			properties: [...(table.fieldProperties[name] ?? [])],
		})),
		itemAttributes: [...table.itemAttributes],
	};
}

/** The digest of a table's definition alone, for the cases where its rows are not read. */
export function lookupDefinitionDigest(table: HqLookupTable): string {
	return canonicalJsonDigest(definitionOf(table));
}

/**
 * One row as the digest spells it: its field names sorted, each with its
 * value, or, for a multi-valued field, its ordered values each with its
 * properties as sorted pairs. The row's id
 * is left out: HQ keeps a row's id only while it keeps the table and the
 * row's content (`fixtures/upload/run_upload.py::Mutation.process`), so an
 * id says nothing about what the row holds.
 */
function spelledRow(row: HqFixtureRow): unknown {
	return Object.keys(row.fields)
		.sort()
		.map((name) => {
			const value = row.fields[name];
			if (typeof value === "string") return [name, value];
			/* A field that holds one value is spelled as that value whichever
			 * of HQ's two row shapes served it; only a multi-valued field
			 * carries its values' properties. */
			const [only] = value;
			if (value.length === 1 && only !== undefined) return [name, only.value];
			return [
				name,
				value.map((item) => [
					item.value,
					Object.keys(item.properties)
						.sort()
						.map((property) => [property, item.properties[property]]),
				]),
			];
		});
}

function rowsDigest(rows: readonly HqFixtureRow[]): string {
	return canonicalJsonDigest(rows.map(spelledRow));
}

/** A table's canonical value, from its definition and every one of its rows in HQ's order. */
export function canonicalLookupTable(
	table: HqLookupTable,
	rows: readonly HqFixtureRow[],
): CanonicalLookupTable {
	const definition = definitionOf(table);
	const content = {
		...definition,
		rowCount: rows.length,
		rowsDigest: rowsDigest(rows),
		definitionDigest: canonicalJsonDigest(definition),
	};
	return {
		remoteId: table.id,
		...content,
		digest: canonicalJsonDigest(content),
	};
}

/**
 * Where the mapped table is now, which needs no baseline. Null when a table
 * still holds Nova's tag: one under another id is a name clash the push plan
 * refuses, never a drift change.
 */
export function lookupIdentityChange(input: {
	readonly mappedRemoteId: string;
	/** Nova's tag for the table. */
	readonly tag: string;
	/** The whole list read. */
	readonly tables: readonly HqLookupTable[];
}):
	| { readonly kind: "deleted" }
	| { readonly kind: "renamed"; readonly tag: string }
	| null {
	if (input.tables.some((table) => table.tag === input.tag)) return null;
	const mapped = input.tables.find(
		(table) => table.id === input.mappedRemoteId,
	);
	return mapped === undefined
		? { kind: "deleted" }
		: { kind: "renamed", tag: mapped.tag };
}

/** Empty, or one `definition` part. `current` is the table that holds the tag and the mapped id. */
export function lookupDefinitionChange(
	baseline: CanonicalLookupTable,
	current: HqLookupTable,
): readonly LookupChangePart[] {
	return lookupDefinitionDigest(current) === baseline.definitionDigest
		? []
		: [{ kind: "definition" }];
}

/** Empty, or one `rows` part. Called only when the two functions above found nothing. */
export function lookupRowsChange(
	baseline: CanonicalLookupTable,
	rows: { readonly totalCount: number; readonly rows: readonly HqFixtureRow[] },
): readonly LookupChangePart[] {
	return rows.totalCount === baseline.rowCount &&
		rowsDigest(rows.rows) === baseline.rowsDigest
		? []
		: [{ kind: "rows" }];
}

function ownedDataOf(
	place: HqLocation,
	ownedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
	const owned: Record<string, unknown> = {};
	for (const key of ownedKeys) {
		if (Object.hasOwn(place.values, key)) owned[key] = place.values[key];
	}
	return owned;
}

/**
 * A place's canonical value: what a push writes, with `location_data`
 * restricted to the place-information slugs it modeled. Coordinates stay
 * HQ's strings, so two reads compare without a rounding model, and
 * `last_modified` is not kept: HQ's update saves on every call.
 */
export function canonicalPlace(
	place: HqLocation,
	ownedKeys: readonly string[],
): CanonicalPlace {
	const keys = [...new Set(ownedKeys)].sort();
	const content = {
		name: place.name,
		siteCode: place.siteCode,
		locationTypeCode: place.locationTypeCode,
		parentRemoteId: place.parentLocationId,
		latitude: place.latitude,
		longitude: place.longitude,
		ownedData: ownedDataOf(place, keys),
		ownedKeys: keys,
	};
	return {
		remoteId: place.locationId,
		...content,
		digest: canonicalJsonDigest(content),
	};
}

/**
 * One part per field that differs, the current read projected onto the
 * baseline's `ownedKeys`. `current` is null for a place the inventory read
 * does not list: archived or deleted, which no API-key read tells apart.
 */
export function placeChange(
	baseline: CanonicalPlace,
	current: HqLocation | null,
): readonly PlaceChangePart[] {
	if (current === null) return [{ kind: "missing" }];
	const now = canonicalPlace(current, baseline.ownedKeys);
	const parts: PlaceChangePart[] = [];
	if (now.name !== baseline.name) parts.push({ kind: "name" });
	if (now.siteCode !== baseline.siteCode) parts.push({ kind: "site-code" });
	if (now.locationTypeCode !== baseline.locationTypeCode) {
		parts.push({ kind: "level" });
	}
	if (now.parentRemoteId !== baseline.parentRemoteId) {
		parts.push({ kind: "parent" });
	}
	if (
		now.latitude !== baseline.latitude ||
		now.longitude !== baseline.longitude
	) {
		parts.push({ kind: "coordinates" });
	}
	if (
		canonicalJsonDigest(now.ownedData) !==
		canonicalJsonDigest(baseline.ownedData)
	) {
		parts.push({ kind: "information" });
	}
	return parts;
}
