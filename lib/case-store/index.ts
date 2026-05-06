// lib/case-store/index.ts
//
// Public barrel for the case-store package. External consumers
// import from `@/lib/case-store`; the implementation
// (`PostgresCaseStore`), connection layer, sample-data generator
// surface, and testcontainers harness stay package-private (reach
// via subpath in tests). See `lib/case-store/CLAUDE.md` for the
// full surface description.
//
// Targeted re-exports (not `export *`) because `./store` and
// `./errors` expose helpers (`findCaseTypeOrThrow`,
// `buildCaseTypeMap`) consumed inside the package only.
// `export type` is used for type-only re-exports so consumers
// honoring `verbatimModuleSyntax` don't pull a runtime import for
// a type-only reference.

// Typed user-domain errors.
export type { CasePropertyFailure } from "./errors";
export {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	SchemaNotSyncedError,
} from "./errors";
// JSONB value types — consumed by callers reading `CaseRow.properties`.
export type {
	JsonObject,
	JsonPrimitive,
	JsonValue,
} from "./sql/database";
export type {
	ApplySchemaChangeArgs,
	CaseInsert,
	CaseRow,
	CaseStore,
	CaseUpdate,
	GenerateSampleDataArgs,
	MigrationReport,
	QueryArgs,
	ResetSampleDataArgs,
	SchemaChangeKind,
	SortKey,
} from "./store";
export { withOwnerContext } from "./withOwnerContext";
