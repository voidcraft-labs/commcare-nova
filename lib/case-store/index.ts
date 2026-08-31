// lib/case-store/index.ts
//
// Public barrel for the case-store package. External consumers
// import from `@/lib/case-store`; the implementation
// (`PostgresCaseStore`), connection layer, sample-data generator
// surface, and testcontainers harness stay package-private (reach
// via subpath in tests).
//
// Targeted re-exports (not `export *`) so consumer-facing surface
// stays narrow. `export type` is used for type-only re-exports so
// consumers honoring `verbatimModuleSyntax` don't pull a runtime
// import for a type-only reference. `buildCaseTypeMap` is exposed
// for callers that hold a `BlueprintDoc` and need to convert it
// to the schema-map shape the case-store methods accept.

export type {
	CaseOperationTargetDescriptor,
	CaseOperationTargetRequest,
	CaseOperationTargetVerdict,
	ResolvedCaseOperationTypeSequenceVerdict,
	ResolvedCaseOperationTypeStep,
	ResolvedCaseOperationTypeTarget,
} from "./caseOperationTargets";
export {
	caseOperationTargetDescriptorSchema,
	caseOperationTargetRequestSchema,
	validateCaseOperationTargetDescriptor,
	validateResolvedCaseOperationTypeSequence,
} from "./caseOperationTargets";
export type {
	CasePropertyRenameStoragePreflight,
	CasePropertyRenameStoragePreflightByRename,
	CasePropertyRenameStoragePreflightConflict,
	CasePropertyRenameStoragePreflightEntry,
} from "./casePropertyRenamePreflight";
export { readCasePropertyRenameStoragePreflightInTransaction } from "./casePropertyRenamePreflight";

// Typed user-domain errors.
export type { CasePropertyFailure, SubmissionRejection } from "./errors";
export {
	AutomationHostAmbiguityError,
	CaptureSubmissionRejectedError,
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	ParkedValueNotFoundError,
	SchemaChangePhaseBError,
	SchemaNotSyncedError,
	SubmissionRejectedError,
} from "./errors";
export { withProjectContext, withSchemaContext } from "./projectContext";
export type { LookupTableSchemas } from "./sql/compileLookup";
export type {
	FormFieldBindingValue,
	TermBindings,
	TermBindingValue,
} from "./sql/compileTerm";
// JSONB value types — consumed by callers reading `CaseRow.properties`.
export type {
	JsonObject,
	JsonPrimitive,
	JsonValue,
} from "./sql/database";
export type {
	ApplyCasePropertyRenameArgs,
	ApplyCaseTypeSchemaRetirementArgs,
	ApplySchemaChangeArgs,
	CalculatedColumn,
	CalculatedValue,
	CaseGroup,
	CaseIndexRow,
	CaseInsert,
	CasePropertyRenameEntry,
	CasePropertyRenameReport,
	CaseRow,
	CaseRowWithCalculated,
	CaseStore,
	CaseUpdate,
	CaseUpdateArgs,
	ConversionImpact,
	CountArgs,
	DeviceCaseDatabase,
	GenerateSampleDataArgs,
	GroupedQueryArgs,
	GroupedQueryResult,
	MigrationReport,
	ParkedValueEntry,
	ParkedValueStanding,
	PreparedCasePropertyRenamePhaseB,
	PreparedCaseTypeSchemaRetirementPhaseB,
	PreparedSchemaChangePhaseB,
	QueryArgs,
	ResetSampleDataArgs,
	RestoreScope,
	SchemaCaseStore,
	SchemaChangeKind,
	SortKey,
	TransactionalSchemaCaseStore,
} from "./store";
export {
	buildCaseTypeMap,
	CasePropertyRenameStorageConflictError,
} from "./store";
export type {
	ApplySubmissionArgs,
	CaseOperationProgram,
	CreatedChildCaseReceipt,
	EnvelopeCaseOperation,
	OperationEffectRecord,
	OperationIterationBindings,
	OperationScopeIterations,
	OrdinarySubmissionAction,
	SubmissionCaseSeed,
	SubmissionEnvelopeResult,
	SubmissionReceiptClaim,
	SubmissionReceiptIdentity,
	SubmissionReceiptVerdict,
} from "./submission";
export {
	adjudicateSubmissionReceipt,
	parseSubmissionEnvelopeResult,
} from "./submission";
