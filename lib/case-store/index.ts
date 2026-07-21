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

// Typed user-domain errors.
export type { CasePropertyFailure } from "./errors";
export {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	ParkedValueNotFoundError,
	SchemaChangePhaseBError,
	SchemaNotSyncedError,
} from "./errors";
export { withProjectContext, withSchemaContext } from "./projectContext";
// Cross-tenant case re-tenant — the case-store half of moving an app between
// Projects. The db-injectable `*On` twin stays package-private (harness only).
export { retenantAppCases } from "./retenant";
export type { TermBindings, TermBindingValue } from "./sql/compileTerm";
// JSONB value types — consumed by callers reading `CaseRow.properties`.
export type {
	JsonObject,
	JsonPrimitive,
	JsonValue,
} from "./sql/database";
export type {
	ApplySchemaChangeArgs,
	CalculatedColumn,
	CalculatedValue,
	CaseInsert,
	CaseRow,
	CaseRowWithCalculated,
	CaseStore,
	CaseUpdate,
	ConversionImpact,
	CountArgs,
	GenerateSampleDataArgs,
	MigrationReport,
	ParkedValueEntry,
	ParkedValueStanding,
	QueryArgs,
	ResetSampleDataArgs,
	SchemaCaseStore,
	SchemaChangeKind,
	SortKey,
} from "./store";
export { buildCaseTypeMap } from "./store";
