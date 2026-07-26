import type { LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupColumn,
	LookupFailure,
	LookupRevision,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { countLookupCsvRows, inspectLookupCsv } from "./lookupCsvClient";

/** The browser File surface this model needs; kept narrow for unit tests. */
export interface LookupCsvFile {
	readonly name: string;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * One complete, internally consistent file decision.
 *
 * No member is stored in an independent React state cell. That prevents an
 * older `arrayBuffer()` settle from pairing its bytes with a newer file name,
 * row count, schema, or optimistic revision.
 */
export interface LookupCsvSelection {
	readonly generation: number;
	readonly projectId: string;
	readonly tableId: LookupTableId;
	readonly file: LookupCsvFile;
	readonly fileName: string;
	readonly bytes: Uint8Array;
	readonly rowCount: number;
	readonly schema: readonly LookupColumn[];
	readonly schemaFingerprint: string;
	readonly definitionRevision: LookupRevision;
	readonly tableRevision: LookupRevision;
	readonly replacedRowCount: number;
}

export type LookupCsvSelectionResult =
	| { readonly ok: true; readonly selection: LookupCsvSelection }
	| { readonly ok: false; readonly failure: LookupFailure<string> };

export function lookupSchemaFingerprint(
	columns: readonly LookupColumn[],
): string {
	return JSON.stringify(
		columns.map((column) => [
			column.id,
			column.wireName,
			column.label,
			column.dataType,
		]),
	);
}

/** Choose the newest exact-context table between the rendered hook value and
 * a direct post-conflict review read.
 *
 * The direct read keeps the file dialog mounted if the parent hook cannot
 * refresh, but it is legal only for the same current Project and table. Once
 * realtime delivers a newer rendered generation, that generation wins. */
export function currentLookupCsvTable(
	rendered: LookupTableSnapshot,
	reviewed: LookupTableSnapshot | null,
	currentProjectId: string | undefined,
): LookupTableSnapshot {
	return reviewed !== null &&
		reviewed.projectId === currentProjectId &&
		reviewed.id === rendered.id &&
		BigInt(reviewed.tableRevision) >= BigInt(rendered.tableRevision)
		? reviewed
		: rendered;
}

/** Validate bytes and freeze every context value they were checked against. */
export function buildLookupCsvSelection(args: {
	readonly generation: number;
	readonly projectId: string;
	readonly table: LookupTableSnapshot;
	readonly file: LookupCsvFile;
	readonly bytes: Uint8Array;
}): LookupCsvSelectionResult {
	const failure = inspectLookupCsv(args.bytes, args.table.columns);
	if (failure !== null) return { ok: false, failure };
	const rowCount = countLookupCsvRows(args.bytes);
	if (rowCount === null) {
		return {
			ok: false,
			failure: {
				success: false,
				code: "invalid_csv",
				message: "That file could not be read as CSV.",
			},
		};
	}
	return {
		ok: true,
		selection: {
			generation: args.generation,
			projectId: args.projectId,
			tableId: args.table.id,
			file: args.file,
			fileName: args.file.name,
			bytes: new Uint8Array(args.bytes),
			rowCount,
			schema: args.table.columns.map((column) => ({ ...column })),
			schemaFingerprint: lookupSchemaFingerprint(args.table.columns),
			definitionRevision: args.table.definitionRevision,
			tableRevision: args.table.tableRevision,
			replacedRowCount: args.table.rowCount,
		},
	};
}

/** True only for the exact Project, table, definition, and row generation. */
export function lookupCsvSelectionIsCurrent(
	selection: LookupCsvSelection,
	projectId: string | undefined,
	table: LookupTableSnapshot,
): boolean {
	return (
		projectId !== undefined &&
		selection.projectId === projectId &&
		selection.tableId === table.id &&
		selection.definitionRevision === table.definitionRevision &&
		selection.tableRevision === table.tableRevision &&
		selection.schemaFingerprint === lookupSchemaFingerprint(table.columns)
	);
}

/** Last-started file read wins. */
export function shouldCommitLookupCsvRead(
	requestGeneration: number,
	currentGeneration: number,
): boolean {
	return requestGeneration === currentGeneration;
}
