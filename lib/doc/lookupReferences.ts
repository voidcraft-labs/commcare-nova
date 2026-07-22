/**
 * Structural lookup-reference extraction.
 *
 * Lookup rows live outside `BlueprintDoc`, but future domain carriers will
 * store stable lookup table/column identities in the doc. This module is the
 * client-safe seam between those structural carriers, validation, and the
 * normalized reference-edge writer. S02 deliberately registers no production
 * carrier: S05 adds the first extractor together with the schema it walks.
 *
 * Extractors are explicit immutable values. Tests inject a synthetic registry;
 * production validation imports the frozen empty registry below. There is no
 * mutable global registration API, so test order, module evaluation order, and
 * long-lived server instances cannot change what a document means.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupDataType,
	LookupRevision,
	LookupTableDefinition,
} from "@/lib/lookup/types";

/** External lookup definitions available to one pure validation run. */
export type LookupValidationContext =
	| {
			readonly kind: "available";
			readonly projectId: string;
			readonly projectRevision: LookupRevision;
			readonly definitions: readonly LookupTableDefinition[];
	  }
	| { readonly kind: "unavailable" };

/** The explicit context for a client/test that has no definition snapshot. */
export const LOOKUP_CONTEXT_UNAVAILABLE: LookupValidationContext =
	Object.freeze({
		kind: "unavailable",
	});

export type LookupReferenceValidationScope =
	| "app"
	| "module"
	| "form"
	| "field";

/**
 * Validator provenance copied at extraction time. Names are display-only;
 * UUIDs plus `field` are the stable anchors used by validator locations.
 */
export interface LookupReferenceValidationLocation {
	readonly scope: LookupReferenceValidationScope;
	readonly moduleUuid?: Uuid;
	readonly moduleName?: string;
	readonly formUuid?: Uuid;
	readonly formName?: string;
	readonly fieldUuid?: Uuid;
	readonly fieldId?: string;
	readonly field?: string;
}

export type LookupReferencePathSegment = string | number;

/**
 * Canonical, typed JSON-pointer-like path for a nested reference inside one
 * registry slot. Key and index segments have different prefixes so `"0"` and
 * `0` cannot alias; RFC 6901 escaping keeps separators unambiguous.
 */
export function canonicalLookupReferenceSubpath(
	segments: readonly LookupReferencePathSegment[],
): string {
	if (segments.length === 0) return "";
	return segments
		.map((segment) => {
			if (typeof segment === "number") {
				if (!Number.isSafeInteger(segment) || segment < 0) {
					throw new Error(
						"Lookup reference path indices must be nonnegative safe integers.",
					);
				}
				return `/i:${segment}`;
			}
			return `/k:${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`;
		})
		.join("");
}

/** One exact structural occurrence in a future lookup-bearing carrier. */
export interface LookupReferenceOccurrence {
	readonly carrierUuid: Uuid;
	/** Stable registry-owned slot id, never an array position or display name. */
	readonly registrySlot: string;
	/** Canonical path below the registry slot; empty string means the slot root. */
	readonly subpath: string;
	readonly tableId: LookupTableId;
	readonly columnId?: LookupColumnId;
	/**
	 * Extractor-owned type contract for a column-bearing occurrence. Absent means
	 * the carrier accepts every lookup data type; a supplied set is nonempty.
	 */
	readonly acceptedColumnTypes?: readonly LookupDataType[];
	readonly location: LookupReferenceValidationLocation;
}

/** Candidate shape returned by one registry entry before slot/path stamping. */
export interface ExtractedLookupReference {
	readonly carrierUuid: Uuid;
	readonly subpath: readonly LookupReferencePathSegment[];
	readonly tableId: LookupTableId;
	readonly columnId?: LookupColumnId;
	readonly acceptedColumnTypes?: readonly LookupDataType[];
	readonly location: LookupReferenceValidationLocation;
}

/** One immutable structural carrier walker. */
export interface LookupReferenceExtractor {
	readonly registrySlot: string;
	readonly extract: (doc: BlueprintDoc) => readonly ExtractedLookupReference[];
}

export type LookupReferenceExtractorRegistry =
	readonly LookupReferenceExtractor[];

/**
 * S02 production registry: intentionally and immutably empty. S05 replaces
 * this value with a new frozen array when the first carrier schema lands.
 */
export const PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS: LookupReferenceExtractorRegistry =
	Object.freeze([]);

const LOOKUP_DATA_TYPE_ORDER: Readonly<Record<LookupDataType, number>> = {
	text: 0,
	int: 1,
	decimal: 2,
	date: 3,
	time: 4,
	datetime: 5,
};

function normalizeAcceptedColumnTypes(
	types: readonly LookupDataType[] | undefined,
): readonly LookupDataType[] | undefined {
	if (types === undefined) return undefined;
	const normalized = [...new Set(types)].sort(
		(a, b) => LOOKUP_DATA_TYPE_ORDER[a] - LOOKUP_DATA_TYPE_ORDER[b],
	);
	return Object.freeze(normalized);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareOccurrences(
	a: LookupReferenceOccurrence,
	b: LookupReferenceOccurrence,
): number {
	return (
		compareStrings(a.registrySlot, b.registrySlot) ||
		compareStrings(a.carrierUuid, b.carrierUuid) ||
		compareStrings(a.subpath, b.subpath) ||
		compareStrings(a.tableId, b.tableId) ||
		compareStrings(a.columnId ?? "", b.columnId ?? "")
	);
}

/** Extract deterministic occurrences through an explicit immutable registry. */
export function extractLookupReferenceOccurrences(
	doc: BlueprintDoc,
	registry: LookupReferenceExtractorRegistry,
): readonly LookupReferenceOccurrence[] {
	const seenSlots = new Set<string>();
	const occurrences: LookupReferenceOccurrence[] = [];

	for (const extractor of registry) {
		if (extractor.registrySlot.length === 0) {
			throw new Error("Lookup reference registry slots must not be empty.");
		}
		if (seenSlots.has(extractor.registrySlot)) {
			throw new Error(
				`Duplicate lookup reference registry slot: ${extractor.registrySlot}`,
			);
		}
		seenSlots.add(extractor.registrySlot);

		for (const extracted of extractor.extract(doc)) {
			if (
				extracted.acceptedColumnTypes !== undefined &&
				extracted.columnId === undefined
			) {
				throw new Error(
					`Lookup reference extractor ${extractor.registrySlot} declared accepted column types without a column target.`,
				);
			}
			if (extracted.acceptedColumnTypes?.length === 0) {
				throw new Error(
					`Lookup reference extractor ${extractor.registrySlot} supplied an empty accepted column type set; omit it to accept every type.`,
				);
			}
			occurrences.push({
				carrierUuid: extracted.carrierUuid,
				registrySlot: extractor.registrySlot,
				subpath: canonicalLookupReferenceSubpath(extracted.subpath),
				tableId: extracted.tableId,
				...(extracted.columnId !== undefined && {
					columnId: extracted.columnId,
				}),
				...(extracted.acceptedColumnTypes !== undefined && {
					acceptedColumnTypes: normalizeAcceptedColumnTypes(
						extracted.acceptedColumnTypes,
					),
				}),
				location: extracted.location,
			});
		}
	}

	return Object.freeze(occurrences.sort(compareOccurrences));
}

export interface LookupColumnReferenceTarget {
	readonly tableId: LookupTableId;
	readonly columnId: LookupColumnId;
}

/** Exact normalized app-to-resource edge set. */
export interface LookupReferenceTargetSet {
	readonly tableIds: readonly LookupTableId[];
	readonly columnTargets: readonly LookupColumnReferenceTarget[];
}

const EMPTY_LOOKUP_TABLE_IDS: readonly LookupTableId[] = Object.freeze([]);
const EMPTY_LOOKUP_COLUMN_TARGETS: readonly LookupColumnReferenceTarget[] =
	Object.freeze([]);

export const EMPTY_LOOKUP_REFERENCE_TARGETS: LookupReferenceTargetSet =
	Object.freeze({
		tableIds: EMPTY_LOOKUP_TABLE_IDS,
		columnTargets: EMPTY_LOOKUP_COLUMN_TARGETS,
	});

export interface LookupReferenceTargetSetInput {
	readonly tableIds?: Iterable<LookupTableId>;
	readonly columnTargets?: Iterable<LookupColumnReferenceTarget>;
}

/**
 * Sort and deduplicate exact targets. A column target always contributes its
 * parent table target, matching the database FK/materialization contract.
 */
export function normalizeLookupReferenceTargetSet(
	input: LookupReferenceTargetSetInput,
): LookupReferenceTargetSet {
	const tableIds = new Set(input.tableIds ?? []);
	const columnsByKey = new Map<string, LookupColumnReferenceTarget>();

	for (const target of input.columnTargets ?? []) {
		tableIds.add(target.tableId);
		columnsByKey.set(`${target.tableId}\0${target.columnId}`, {
			tableId: target.tableId,
			columnId: target.columnId,
		});
	}

	if (tableIds.size === 0 && columnsByKey.size === 0) {
		return EMPTY_LOOKUP_REFERENCE_TARGETS;
	}

	const normalizedTableIds = Object.freeze([...tableIds].sort(compareStrings));
	const normalizedColumnTargets = Object.freeze(
		[...columnsByKey.values()].sort(
			(a, b) =>
				compareStrings(a.tableId, b.tableId) ||
				compareStrings(a.columnId, b.columnId),
		),
	);

	return Object.freeze({
		tableIds: normalizedTableIds,
		columnTargets: normalizedColumnTargets,
	});
}

/** Project structural occurrences to the exact persisted target sets. */
export function lookupReferenceTargetsFromOccurrences(
	occurrences: readonly LookupReferenceOccurrence[],
): LookupReferenceTargetSet {
	return normalizeLookupReferenceTargetSet({
		tableIds: occurrences.map((occurrence) => occurrence.tableId),
		columnTargets: occurrences.flatMap((occurrence) =>
			occurrence.columnId === undefined
				? []
				: [
						{
							tableId: occurrence.tableId,
							columnId: occurrence.columnId,
						},
					],
		),
	});
}

/**
 * Extract the complete normalized target set for one doc. Production callers
 * omit the registry and therefore use the immutable empty S02 registry;
 * synthetic tests/races pass their registry explicitly.
 */
export function extractLookupReferenceTargets(
	doc: BlueprintDoc,
	registry: LookupReferenceExtractorRegistry = PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
): LookupReferenceTargetSet {
	return lookupReferenceTargetsFromOccurrences(
		extractLookupReferenceOccurrences(doc, registry),
	);
}

/** Normalized set union used by seeded races and future carrier partitions. */
export function unionLookupReferenceTargetSets(
	...sets: readonly LookupReferenceTargetSet[]
): LookupReferenceTargetSet {
	return normalizeLookupReferenceTargetSet({
		tableIds: sets.flatMap((set) => [...set.tableIds]),
		columnTargets: sets.flatMap((set) => [...set.columnTargets]),
	});
}
