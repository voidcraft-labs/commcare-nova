/**
 * Executable storage-occurrence dispatcher for the canonical-identity cutover.
 *
 * The manifest is the inventory; this file is the one implementation that
 * turns every entry into content digests and disposition postconditions.
 * Advisory/locked scans, repair rehearsal/application, and migration all call
 * this exact code, so adding a carrier to the manifest without teaching the
 * dispatcher how to project it is impossible.
 */

import { type Kysely, sql } from "kysely";
import {
	FROZEN_STORAGE_OCCURRENCES,
	type FrozenOccurrenceDisposition,
	type FrozenStorageOccurrence,
} from "./frozenOccurrenceManifest";
import { canonicalIdentityDigest } from "./frozenTransform";

type JsonRecord = Record<string, unknown>;

export interface FrozenStorageTableSnapshot {
	readonly exists: boolean;
	readonly rows: readonly unknown[];
}

export type FrozenStorageSnapshot = Readonly<
	Record<string, FrozenStorageTableSnapshot>
>;

export interface FrozenOccurrenceProjection {
	readonly id: string;
	readonly disposition: FrozenOccurrenceDisposition;
	readonly table: string;
	readonly path: string;
	readonly semantic: FrozenStorageOccurrence["semantic"];
	readonly rowCount: number;
	readonly bytes: number;
	readonly digest: string;
}

export interface FrozenOccurrencePlanEntry {
	readonly id: string;
	readonly disposition: FrozenOccurrenceDisposition;
	readonly sourceDigest: string;
	readonly resultDigest: string;
	readonly sourceRows: number;
	readonly resultRows: number;
	readonly sourceBytes: number;
	readonly resultBytes: number;
}

export interface FrozenOccurrencePlan {
	readonly entries: readonly FrozenOccurrencePlanEntry[];
	readonly sourceDigest: string;
	readonly resultDigest: string;
	readonly planDigest: string;
	readonly sourceBytes: number;
	readonly resultBytes: number;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Capture complete canonical JSONB projections without table-specific SQL. */
export async function captureFrozenStorageSnapshot<DB>(
	db: Kysely<DB>,
): Promise<FrozenStorageSnapshot> {
	const tableNames = [
		...new Set(FROZEN_STORAGE_OCCURRENCES.map((entry) => entry.table)),
	];
	const existing = await sql<{ table_name: string }>`
		SELECT c.relname AS table_name
		FROM pg_class AS c
		JOIN pg_namespace AS n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public'
		  AND c.relname = ANY(${sql.val(tableNames)})
		  AND c.relkind IN ('r', 'p')
		ORDER BY c.relname
	`.execute(db);
	const existingNames = new Set(existing.rows.map((row) => row.table_name));
	const snapshot: Record<string, FrozenStorageTableSnapshot> = {};
	for (const table of tableNames) {
		if (!existingNames.has(table)) {
			snapshot[table] = { exists: false, rows: [] };
			continue;
		}
		const rows = await sql<{ row_value: unknown }>`
			SELECT to_jsonb(source_row) AS row_value
			FROM ${sql.table(table)} AS source_row
			ORDER BY to_jsonb(source_row)::text
		`.execute(db);
		snapshot[table] = {
			exists: true,
			rows: rows.rows.map((row) => row.row_value),
		};
	}
	return snapshot;
}

function walkPath(value: unknown, segments: readonly string[]): unknown[] {
	if (segments.length === 0) return [value];
	const [segment, ...tail] = segments;
	if (segment === undefined) return [];
	if (segment === "<LookupColumnId>") {
		if (!isRecord(value)) return [];
		return Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([key, entry]) => walkPath({ key, value: entry }, tail));
	}
	const array = segment.endsWith("[]");
	const key = array ? segment.slice(0, -2) : segment;
	if (!isRecord(value)) return [];
	const child = value[key];
	if (!array) return walkPath(child, tail);
	if (!Array.isArray(child)) return [];
	return child.flatMap((entry) => walkPath(entry, tail));
}

function projectDeclaredPath(row: unknown, path: string): unknown {
	if (path === "*") return row;
	const alternatives = path.split("|");
	if (alternatives.length === 1) {
		return walkPath(row, alternatives[0]?.split(".") ?? []);
	}
	return Object.fromEntries(
		alternatives.map((alternative) => [
			alternative,
			walkPath(row, alternative.split(".")),
		]),
	);
}

function baselineSeqByApp(
	snapshot: FrozenStorageSnapshot,
): Map<string, bigint> {
	const result = new Map<string, bigint>();
	for (const value of snapshot.mutation_fold_baselines?.rows ?? []) {
		if (!isRecord(value) || typeof value.app_id !== "string") continue;
		if (typeof value.seq !== "string" && typeof value.seq !== "number")
			continue;
		const seq = BigInt(value.seq);
		const prior = result.get(value.app_id);
		if (prior === undefined || seq > prior) result.set(value.app_id, seq);
	}
	return result;
}

function acceptedRowsFor(
	occurrence: FrozenStorageOccurrence,
	snapshot: FrozenStorageSnapshot,
): readonly unknown[] {
	const rows = snapshot.accepted_mutations?.rows ?? [];
	const baselines = baselineSeqByApp(snapshot);
	if (occurrence.id === "accepted_mutations.before-new-horizon") {
		return rows.filter((value) => {
			if (!isRecord(value) || typeof value.app_id !== "string") return false;
			const baseline = baselines.get(value.app_id);
			return (
				baseline === undefined ||
				((typeof value.seq === "string" || typeof value.seq === "number") &&
					BigInt(value.seq) < baseline)
			);
		});
	}
	if (occurrence.id === "accepted_mutations.new-horizon-and-suffix") {
		return rows.filter((value) => {
			if (!isRecord(value) || typeof value.app_id !== "string") return false;
			const baseline = baselines.get(value.app_id);
			return (
				baseline !== undefined &&
				(typeof value.seq === "string" || typeof value.seq === "number") &&
				BigInt(value.seq) >= baseline
			);
		});
	}
	return rows;
}

function eventRowsFor(
	occurrence: FrozenStorageOccurrence,
	snapshot: FrozenStorageSnapshot,
): readonly unknown[] {
	const rows = snapshot.events?.rows ?? [];
	if (occurrence.id === "events.mutation") {
		return rows.flatMap((value) => {
			if (!isRecord(value)) return [];
			if (value.kind === "mutation") return [value.event];
			if (
				value.kind === "archived-mutation" &&
				isRecord(value.event) &&
				value.event.archived !== undefined
			) {
				return [value.event.archived];
			}
			return [];
		});
	}
	if (occurrence.id.startsWith("events.conversation.")) {
		return rows.filter(
			(value) => isRecord(value) && value.kind === "conversation",
		);
	}
	return rows;
}

function hasOperationalContent(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (Array.isArray(value)) return value.some(hasOperationalContent);
	if (isRecord(value)) return Object.values(value).some(hasOperationalContent);
	return true;
}

function rowsForOccurrence(
	occurrence: FrozenStorageOccurrence,
	snapshot: FrozenStorageSnapshot,
): readonly unknown[] {
	if (occurrence.table === "accepted_mutations") {
		return acceptedRowsFor(occurrence, snapshot);
	}
	if (occurrence.table === "events") {
		return eventRowsFor(occurrence, snapshot);
	}
	return snapshot[occurrence.table]?.rows ?? [];
}

function projectOccurrence(
	occurrence: FrozenStorageOccurrence,
	snapshot: FrozenStorageSnapshot,
): FrozenOccurrenceProjection {
	const rawRows = rowsForOccurrence(occurrence, snapshot);
	let projected = rawRows.map((row) =>
		occurrence.id === "events.mutation"
			? row
			: projectDeclaredPath(row, occurrence.path),
	);
	if (occurrence.disposition === "delete-operational") {
		projected = projected.filter(hasOperationalContent);
	}
	return {
		id: occurrence.id,
		disposition: occurrence.disposition,
		table: occurrence.table,
		path: occurrence.path,
		semantic: occurrence.semantic,
		rowCount: projected.length,
		bytes: jsonBytes(projected),
		digest: canonicalIdentityDigest(projected),
	};
}

/** Dispatch every manifest entry exactly once through its disposition. */
export function dispatchFrozenStorageOccurrences(
	snapshot: FrozenStorageSnapshot,
): readonly FrozenOccurrenceProjection[] {
	const handlers: Record<
		FrozenOccurrenceDisposition,
		(
			occurrence: FrozenStorageOccurrence,
			state: FrozenStorageSnapshot,
		) => FrozenOccurrenceProjection
	> = {
		"rewrite-current": projectOccurrence,
		"archive-exact": projectOccurrence,
		"opaque-pre-horizon": projectOccurrence,
		"delete-operational": projectOccurrence,
		"preserve-exact": projectOccurrence,
		DDL: projectOccurrence,
	};
	const projections = FROZEN_STORAGE_OCCURRENCES.map((occurrence) =>
		handlers[occurrence.disposition](occurrence, snapshot),
	);
	if (
		projections.length !== FROZEN_STORAGE_OCCURRENCES.length ||
		new Set(projections.map((entry) => entry.id)).size !== projections.length
	) {
		throw new Error(
			"Canonical identity occurrence dispatcher did not cover the manifest exactly once.",
		);
	}
	return projections;
}

export function compareFrozenStorageOccurrences(
	source: FrozenStorageSnapshot,
	result: FrozenStorageSnapshot,
): FrozenOccurrencePlan {
	const before = dispatchFrozenStorageOccurrences(source);
	const after = dispatchFrozenStorageOccurrences(result);
	const afterById = new Map(after.map((entry) => [entry.id, entry] as const));
	const entries = before.map((entry) => {
		const next = afterById.get(entry.id);
		if (next === undefined) {
			throw new Error(`Canonical identity occurrence ${entry.id} disappeared.`);
		}
		const isNewMigrationHorizon =
			entry.id === "accepted_mutations.new-horizon-and-suffix" &&
			entry.rowCount === 0 &&
			next.rowCount > 0;
		if (
			(entry.disposition === "preserve-exact" ||
				entry.disposition === "opaque-pre-horizon" ||
				entry.disposition === "archive-exact") &&
			!isNewMigrationHorizon &&
			entry.digest !== next.digest
		) {
			throw new Error(
				`Canonical identity occurrence ${entry.id} did not preserve exact content.`,
			);
		}
		if (entry.disposition === "delete-operational" && next.rowCount !== 0) {
			throw new Error(
				`Canonical identity occurrence ${entry.id} was not deleted/reset.`,
			);
		}
		return {
			id: entry.id,
			disposition: entry.disposition,
			sourceDigest: entry.digest,
			resultDigest: next.digest,
			sourceRows: entry.rowCount,
			resultRows: next.rowCount,
			sourceBytes: entry.bytes,
			resultBytes: next.bytes,
		};
	});
	return {
		entries,
		sourceDigest: canonicalIdentityDigest(before),
		resultDigest: canonicalIdentityDigest(after),
		planDigest: canonicalIdentityDigest(entries),
		sourceBytes: entries.reduce((total, entry) => total + entry.sourceBytes, 0),
		resultBytes: entries.reduce((total, entry) => total + entry.resultBytes, 0),
	};
}
