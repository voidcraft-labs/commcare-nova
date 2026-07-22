import type {
	LookupColumnId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import type { LOOKUP_DATA_TYPES } from "./constants";

export type {
	LookupColumnId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";

declare const lookupRevisionBrand: unique symbol;

/** Canonical nonnegative signed-int64 decimal, always serialized as text. */
export type LookupRevision = string & {
	readonly [lookupRevisionBrand]: true;
};

export type LookupDataType = (typeof LOOKUP_DATA_TYPES)[number];
export type LookupCellValue = string | number;
export type LookupRowValues = Record<LookupColumnId, LookupCellValue>;

/** Freshly-authorized scope; attribution is deliberately not an access gate. */
export interface LookupScope {
	projectId: string;
	actorId: string;
	/** Persisted Better Auth role string; may be comma-joined. */
	role: string;
}

export interface LookupColumn {
	id: LookupColumnId;
	wireName: string;
	label: string;
	dataType: LookupDataType;
}

/** Persistence-only ordering slots. Clients submit indices, never these keys. */
export interface StoredLookupColumn extends LookupColumn {
	orderKey: string;
}

export interface LookupRow {
	id: LookupRowId;
	values: LookupRowValues;
	/** Exact Postgres `octet_length(values::text)`, not a JS estimate. */
	valueBytes: number;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface StoredLookupRow extends LookupRow {
	orderKey: string;
}

export interface LookupTableRevisions {
	definitionRevision: LookupRevision;
	rowsRevision: LookupRevision;
	tableRevision: LookupRevision;
}

export interface LookupTableManifestEntry extends LookupTableRevisions {
	id: LookupTableId;
	name: string;
	tag: string;
	columnCount: number;
	rowCount: number;
	dataBytes: number;
}

export interface LookupManifest {
	projectId: string;
	projectRevision: LookupRevision;
	tables: LookupTableManifestEntry[];
}

export interface LookupTableSnapshot extends LookupTableRevisions {
	projectId: string;
	projectRevision: LookupRevision;
	id: LookupTableId;
	name: string;
	tag: string;
	columns: LookupColumn[];
	columnCount: number;
	rows: LookupRow[];
	rowCount: number;
	dataBytes: number;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
}

/** Rows-free table definition used by validation and compilation contexts. */
export interface LookupTableDefinition {
	id: LookupTableId;
	name: string;
	tag: string;
	definitionRevision: LookupRevision;
	columns: readonly LookupColumn[];
}

/** Exact requested definitions and Project clock from one database snapshot. */
export interface LookupDefinitionsSnapshot {
	projectId: string;
	projectRevision: LookupRevision;
	definitions: readonly LookupTableDefinition[];
}

/** Exact storage accounting produced by Postgres `jsonb::text`. */
export interface LookupStorageMeasurement {
	rowValueBytes: readonly number[];
	dataBytes: number;
}

export interface LookupColumnDraft {
	wireName: string;
	label: string;
	dataType: LookupDataType;
}

export interface CreateLookupTableInput {
	name: string;
	tag: string;
	columns: LookupColumnDraft[];
}

export interface LookupExpectedTableRevisionInput {
	tableId: LookupTableId;
	expectedTableRevision: LookupRevision;
}

export interface UpdateLookupTableNameInput
	extends LookupExpectedTableRevisionInput {
	name: string;
}

export interface UpdateLookupTableTagInput
	extends LookupExpectedTableRevisionInput {
	tag: string;
}

export interface AddLookupColumnInput extends LookupExpectedTableRevisionInput {
	column: LookupColumnDraft;
}

export interface LookupColumnMutationInput
	extends LookupExpectedTableRevisionInput {
	columnId: LookupColumnId;
}

export interface UpdateLookupColumnLabelInput
	extends LookupColumnMutationInput {
	label: string;
}

export interface UpdateLookupColumnWireNameInput
	extends LookupColumnMutationInput {
	wireName: string;
}

export interface MoveLookupColumnInput extends LookupColumnMutationInput {
	toIndex: number;
}

export interface CreateLookupRowInput extends LookupExpectedTableRevisionInput {
	toIndex: number;
	values: LookupRowValues;
}

export interface LookupRowMutationInput
	extends LookupExpectedTableRevisionInput {
	rowId: LookupRowId;
}

export interface UpdateLookupRowInput extends LookupRowMutationInput {
	values: LookupRowValues;
}

export type DeleteLookupRowInput = LookupRowMutationInput;

export interface MoveLookupRowInput extends LookupRowMutationInput {
	toIndex: number;
}

export interface ReplaceLookupRowsInput
	extends LookupExpectedTableRevisionInput {
	rows: LookupRowValues[];
}

export interface LookupMutationReceipt extends LookupTableRevisions {
	projectRevision: LookupRevision;
}

export interface LookupCreatedColumnReceipt extends LookupMutationReceipt {
	columnId: LookupColumnId;
}

export interface LookupCreatedRowReceipt extends LookupMutationReceipt {
	rowId: LookupRowId;
}

export type LookupCreatedResourceReceipt =
	| LookupCreatedColumnReceipt
	| LookupCreatedRowReceipt;

export type LookupActionErrorCode =
	| "unauthenticated"
	| "invalid_input"
	| "not_found"
	| "conflict"
	| "tag_taken"
	| "row_limit"
	| "storage_limit"
	| "internal_error";

export type LookupImportErrorCode = LookupActionErrorCode | "invalid_csv";

export interface LookupValidationDetail {
	code: string;
	message: string;
	/** One-based CSV record number, including the header when applicable. */
	row?: number;
	/** Exact authored wire name when a detail belongs to one column. */
	column?: string;
}

export interface LookupFailure<Code extends string = LookupActionErrorCode> {
	success: false;
	code: Code;
	message: string;
	details?: LookupValidationDetail[];
	totalDetailCount?: number;
	/** Present on optimistic-revision drift. */
	currentRevisions?: LookupTableRevisions;
}

export type LookupResult<Value, Code extends string = LookupActionErrorCode> =
	| { success: true; value: Value }
	| LookupFailure<Code>;

/** Parsed before any transaction; keys intentionally remain wire names. */
export interface LookupCsvWireRow {
	sourceRow: number;
	values: Record<string, string>;
}

export interface LookupCsvDocument {
	headers: string[];
	rows: LookupCsvWireRow[];
}

/** UUID-keyed values ready for `replaceLookupRows`, plus the source document. */
export interface ValidatedLookupCsv {
	document: LookupCsvDocument;
	rows: LookupRowValues[];
}
