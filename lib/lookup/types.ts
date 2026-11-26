import type { OrdinaryAuthoringAuthority } from "@/lib/db/authoringAuthority";
import type {
	LookupColumnId,
	LookupMemberId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import type { LOOKUP_DATA_TYPES } from "./constants";
import type { NamedLookupRowContent } from "./rowContent";
import type { LookupSourceFacts } from "./source";

export type {
	LookupColumnId,
	LookupMemberId,
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

/**
 * A request's authorized scope: enough for a read. A write never trusts
 * `role`: every lookup writer reads the member's role again on its own
 * transaction (`writerTransaction.ts::authorizeLookupWriteInTransaction`).
 */
export interface LookupScope {
	projectId: string;
	actorId: string;
	/** Persisted Better Auth role string as the request read it; may be comma-joined. */
	role: string;
}

/** App or private-session authority for shared SA/MCP Project-data writers. The
 * transaction re-resolves the owner, Project, and current membership; `role` is
 * deliberately absent because a caller snapshot cannot authorize a write. */
export type LookupAgentWriteScope = {
	projectId: string;
	actorId: string;
	runId: string;
	requestId: string;
	chatRunHolder?: {
		source: "chat";
		mode: "build" | "edit";
		runId: string;
		nonce: string;
	};
} & (
	| { appId: string; designSessionId?: never; ordinaryAuthoring?: never }
	| { designSessionId: string; appId?: never; ordinaryAuthoring?: never }
	| {
			ordinaryAuthoring: OrdinaryAuthoringAuthority;
			appId?: never;
			designSessionId?: never;
	  }
);

/** A row attribute or a property of a repeated column. Its ID is local to the
 * Project table. Names and ordering can change without retargeting readers. */
export interface LookupMember {
	id: LookupMemberId;
	wireName: string;
	label: string;
}

export interface LookupOccurrence {
	text: string;
	properties: Partial<Record<LookupMemberId, string>>;
}

/** Field absence, an explicit empty list, and one empty value stay distinct. */
export interface LookupRowContent {
	attributes?: Partial<Record<LookupMemberId, string>>;
	occurrences?: Partial<Record<LookupColumnId, LookupOccurrence[]>>;
}

export interface LookupColumn {
	/** Absence is one scalar per row. A repeated column always stores text. */
	repeated?: true;
	properties?: readonly LookupMember[];
	/** Absence is an authored nonindexed field. A source can omit index facts. */
	index?: "indexed" | "unobserved";
	id: LookupColumnId;
	wireName: string;
	label: string;
	dataType: LookupDataType;
}

/** Persistence-only ordering slots. Browser clients submit indices and agent
 * clients submit UUID anchors; neither surface ever submits these keys. */
export interface StoredLookupColumn extends LookupColumn {
	orderKey: string;
}

export interface LookupRow extends LookupRowContent {
	sourceIndex?: number;
	fragmented?: true;
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

/**
 * Where a table came from in CommCare HQ and who manages it now, as the
 * manifest carries it: only what a write that advances the Project revision
 * changes. A manifest's bytes at one revision never change, and a refresh
 * that found CommCare HQ's table as it was stamps its day and advances
 * nothing, so the day is read from the table, never from the manifest.
 */
export interface LookupManifestHqOrigin {
	readonly source?: LookupSourceFacts;
	/** One of CommCare HQ's servers, by the name the deployment ledger uses. */
	readonly server: string;
	readonly domain: string;
	readonly remoteId: string;
	readonly managedBy: "commcare-hq" | "nova";
	readonly broughtInAt: string;
	readonly takenOverAt: string | null;
	readonly takenOverBy: string | null;
}

/** Where a table came from in CommCare HQ, who manages it now, and when Nova's copy was last refreshed. */
export interface LookupHqOrigin extends LookupManifestHqOrigin {
	readonly refreshedAt: string;
	/**
	 * Columns CommCare HQ's table no longer has, kept because an app still
	 * reads them. Only a refresh keeps one, so a table Nova manages has none.
	 */
	readonly goneColumnIds: readonly LookupColumnId[];
}

export interface LookupTableManifestEntry extends LookupTableRevisions {
	workerAccess?: "assigned";
	id: LookupTableId;
	name: string;
	tag: string;
	columnCount: number;
	rowCount: number | null;
	dataBytes: number | null;
	/** Present exactly when the table came from CommCare HQ. */
	hq?: LookupManifestHqOrigin;
}

export interface LookupManifest {
	projectId: string;
	projectRevision: LookupRevision;
	tables: LookupTableManifestEntry[];
}

export interface LookupTableSnapshot extends LookupTableRevisions {
	workerAccess?: "assigned";
	rowOffset?: number;
	rowsUnavailable?: true;
	missingRowId?: LookupRowId;
	matchingRowCount?: number;
	nextRowCursor?: string;
	previousRowCursor?: string;
	attributes?: readonly LookupMember[];
	projectId: string;
	projectRevision: LookupRevision;
	id: LookupTableId;
	name: string;
	tag: string;
	columns: LookupColumn[];
	columnCount: number;
	rows: LookupRow[];
	rowCount: number | null;
	dataBytes: number | null;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
	/** Present exactly when the table came from CommCare HQ. */
	hq?: LookupHqOrigin;
}

/** Rows-free table definition used by validation and compilation contexts. */
export interface LookupTableDefinition {
	workerAccess?: "assigned";
	attributes?: readonly LookupMember[];
	id: LookupTableId;
	name: string;
	tag: string;
	/** Present on authoritative authoring catalogs; optional on the narrow
	 * compiler fixtures that need definitions only. */
	columnCount?: number;
	rowCount?: number;
	dataBytes?: number;
	definitionRevision: LookupRevision;
	rowsRevision?: LookupRevision;
	tableRevision?: LookupRevision;
	columns: readonly LookupColumn[];
	/** Present exactly when the table came from CommCare HQ. */
	hq?: LookupHqOrigin;
}

/** Exact requested definitions and Project clock from one database snapshot. */
export interface LookupDefinitionsSnapshot {
	projectId: string;
	projectRevision: LookupRevision;
	definitions: readonly LookupTableDefinition[];
}

/** One emission-ready row: stable identity plus the stored UUID-keyed cells. */
export interface LookupFixtureRow extends LookupRowContent {
	id: LookupRowId;
	values: LookupRowValues;
}

/**
 * Definitions plus complete ordered rows from the same database snapshot.
 * Every present definition has a `rowsByTable` entry; a missing or foreign
 * requested id is absent from both axes.
 */
export interface LookupFixtureDataSnapshot extends LookupDefinitionsSnapshot {
	/** Complete global tables prepared by the paged archive reader, outside an inline snapshot. */
	streamedTables?: ReadonlyMap<LookupTableId, { rowCount: number }>;
	rowsByTable: ReadonlyMap<LookupTableId, readonly LookupFixtureRow[]>;
}

/** Exact storage accounting produced by Postgres `jsonb::text`. */
export interface LookupStorageMeasurement {
	rowValueBytes: readonly number[];
	dataBytes: number;
}

export type LookupMemberDraft = Pick<LookupMember, "label" | "wireName">;

export type LookupMemberEdit = LookupMemberDraft & { id?: LookupMemberId };

export interface LookupColumnDraft {
	repeated?: true;
	properties?: LookupMemberDraft[];
	indexed?: boolean;
	wireName: string;
	label: string;
	dataType: LookupDataType;
}

export interface CreateLookupTableInput {
	attributes?: LookupMemberDraft[];
	name: string;
	tag: string;
	columns: LookupColumnDraft[];
}

/** Stable request-local identity used while one atomic authoring batch mints
 * the durable UUIDv7 resource. It is never persisted. */
export type LookupAuthoringKey = string;

export interface LookupAuthoringCellByColumnId {
	columnId: LookupColumnId;
	value: LookupCellValue;
}

export interface LookupAuthoringCellByColumnKey {
	columnKey: LookupAuthoringKey;
	value: LookupCellValue;
}

export type LookupAuthoringCell =
	| LookupAuthoringCellByColumnId
	| LookupAuthoringCellByColumnKey;

export interface LookupAuthoringColumnDraft extends LookupColumnDraft {
	key: LookupAuthoringKey;
}

export interface LookupAuthoringRowDraft {
	content?: NamedLookupRowContent;
	key: LookupAuthoringKey;
	cells: LookupAuthoringCell[];
}

export interface LookupAuthoringCreateTable {
	attributes?: LookupMemberDraft[];
	key: LookupAuthoringKey;
	name: string;
	tag: string;
	columns: LookupAuthoringColumnDraft[];
	rows: LookupAuthoringRowDraft[];
}

export type LookupAuthoringColumnOperation =
	| {
			kind: "add";
			key: LookupAuthoringKey;
			column: LookupColumnDraft;
			afterColumnId?: LookupColumnId | null;
			afterColumnKey?: LookupAuthoringKey;
	  }
	| {
			kind: "update";
			columnId: LookupColumnId;
			repeated?: boolean;
			properties?: LookupMemberEdit[];
			indexed?: boolean;
			label?: string;
			wireName?: string;
	  }
	| {
			kind: "move";
			columnId?: LookupColumnId;
			columnKey?: LookupAuthoringKey;
			afterColumnId?: LookupColumnId | null;
			afterColumnKey?: LookupAuthoringKey;
	  }
	| {
			kind: "remove";
			columnId: LookupColumnId;
	  }
	| {
			kind: "retype";
			columnId: LookupColumnId;
			dataType: LookupDataType;
	  };

export type LookupRowPatch = import("zod").infer<
	typeof import("./schema").lookupRowPatchSchema
>;

export type LookupAuthoringRowOperation =
	| {
			kind: "assign";
			rowId: LookupRowId;
			assignments: import("./assignmentVocabulary").RowAssignee[];
	  }
	| { kind: "patch"; rowId: LookupRowId; changes: LookupRowPatch[] }
	| {
			kind: "add";
			assignments?: import("./assignmentVocabulary").RowAssignee[];
			key: LookupAuthoringKey;
			cells: LookupAuthoringCell[];
			content?: NamedLookupRowContent;
			afterRowId?: LookupRowId | null;
			afterRowKey?: LookupAuthoringKey;
	  }
	| {
			kind: "update";
			rowId: LookupRowId;
			content?: NamedLookupRowContent;
			cells: LookupAuthoringCell[];
	  }
	| {
			kind: "move";
			rowId?: LookupRowId;
			rowKey?: LookupAuthoringKey;
			afterRowId?: LookupRowId | null;
			afterRowKey?: LookupAuthoringKey;
	  }
	| { kind: "remove"; rowId: LookupRowId };

export interface LookupReaderReview {
	projectRevision: LookupRevision;
	readerAppIds: readonly string[];
}

export interface LookupAuthoringExistingTable {
	workerAccess?: "all" | "assigned";
	reviewed?: LookupReaderReview;
	attributes?: LookupMemberEdit[];
	tableId: LookupTableId;
	expectedTableRevision: LookupRevision;
	name?: string;
	tag?: string;
	delete?: boolean;
	columnOperations?: LookupAuthoringColumnOperation[];
	rowOperations?: LookupAuthoringRowOperation[];
	/** Whole-row replacement is mutually exclusive with `rowOperations`. */
	replaceRows?: LookupAuthoringRowDraft[];
}

export interface LookupAuthoringBatchInput {
	operationId?: string;
	createTables?: LookupAuthoringCreateTable[];
	updateTables?: LookupAuthoringExistingTable[];
}

export interface LookupAuthoringIdentityReceipt {
	key: LookupAuthoringKey;
	id: string;
}

export interface LookupAuthoringTableReceipt {
	key?: LookupAuthoringKey;
	tableId: LookupTableId;
	deleted: boolean;
	columnIds: readonly {
		key: LookupAuthoringKey;
		id: LookupColumnId;
	}[];
	rowIds: readonly { key: LookupAuthoringKey; id: LookupRowId }[];
	revisions?: LookupTableRevisions;
}

export interface LookupAuthoringBatchReceipt {
	projectRevision: LookupRevision;
	tables: readonly LookupAuthoringTableReceipt[];
}

export interface LookupRowsPageInput {
	rowId?: LookupRowId;
	attributeIds?: LookupMemberId[];
	tableId: LookupTableId;
	query?: string;
	columnIds?: LookupColumnId[];
	cursor?: string;
}

export type LookupRowPart =
	| { kind: "number"; columnId: LookupColumnId; value: number }
	| { kind: "occurrences"; columnId: LookupColumnId; count: number }
	| ({
			offset: number;
			byteOffset: number;
			totalBytes: number;
			valueDigest: string;
			text: string;
	  } & (
			| { kind: "cell"; columnId: LookupColumnId }
			| { kind: "attribute"; attributeId: LookupMemberId }
			| { kind: "occurrence"; columnId: LookupColumnId; index: number }
			| {
					kind: "property";
					columnId: LookupColumnId;
					index: number;
					propertyId: LookupMemberId;
			  }
	  ));

export interface LookupRowsPage {
	table: LookupTableManifestEntry & {
		definitionInCatalog?: true;
		columns: readonly LookupColumn[];
		attributes?: readonly LookupMember[];
	};
	/** Exact model-facing row projection shared by the SA/MCP tool and the
	 * reviewed-design inspector. The page byte budget measures this shape. */
	rows: readonly (LookupRowContent & {
		parts?: LookupRowPart[];
		id: LookupRowId;
		cells: readonly {
			columnId: LookupColumnId;
			value: LookupCellValue;
		}[];
	})[];
	nextCursor?: string;
	complete: boolean;
}

export interface LookupExpectedTableRevisionInput {
	operationId?: string;
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
	reviewed?: LookupReaderReview;
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
	content?: LookupRowContent;
	toIndex: number;
	values: LookupRowValues;
}

export interface LookupRowMutationInput
	extends LookupExpectedTableRevisionInput {
	rowId: LookupRowId;
}

export type UpdateLookupRowInput = LookupRowMutationInput &
	(
		| { values: LookupRowValues; content?: LookupRowContent }
		| { changes: LookupRowPatch[] }
	);

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
	| "accepted_design"
	| "referenced"
	| "last_column"
	| "incompatible_values"
	/** The table is managed in CommCare HQ, so Nova refuses every edit of it. */
	| "managed_in_hq"
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

/**
 * Why a schema-governance change was refused. Three codes beyond the ordinary
 * lookup set, each of which the confirmation surface can explain concretely:
 * apps still reference the resource, a table would be left with no columns, or
 * stored cells do not already satisfy the requested type.
 */
export type LookupGovernanceErrorCode =
	| LookupActionErrorCode
	| "referenced"
	| "accepted_design"
	| "last_column"
	| "incompatible_values";

export interface LookupGovernanceFailure
	extends LookupFailure<LookupGovernanceErrorCode> {
	/** Present on `referenced` — the apps that blocked the change, named, in
	 *  the same shape the pre-flight read returns so the author sees the same
	 *  words before and after. */
	blockingApps?: readonly LookupReferencingAppSummary[];
	/** Present on `incompatible_values` — the rows whose stored cells the
	 *  requested type would not accept. */
	incompatibleRowIds?: readonly LookupRowId[];
}

/** One app that references a lookup resource. Mirrors `lib/db`'s row shape;
 *  restated here so the client wire has no `lib/db` import. */
export interface LookupReferencingAppSummary {
	readonly appId: string;
	readonly appName: string;
	/** The app is in the trash. It still holds its edges and still blocks the
	 *  change, so a confirmation naming it must say where it is — a blocker the
	 *  author cannot find reads as a phantom. */
	readonly deleted: boolean;
}

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
