// lib/case-store/index.ts
//
// Public barrel for the case-store package — the runtime storage
// layer for case data. External consumers import from this barrel;
// internal helpers stay package-private.
//
// ## Public surface
//
//   - **`CaseStore` interface** (`./store`) — the single seam every
//     consumer of case data binds against. Nine methods: `query` /
//     `insert` / `insertWithChildren` / `update` / `close` /
//     `traverse` / `applySchemaChange` / `generateSampleData` /
//     `resetSampleData` plus the row-shape types. The interface is
//     one shape; `PostgresCaseStore` is the only implementation.
//   - **`withOwnerContext(userId)` factory** (`./withOwnerContext`)
//     — the single production constructor path. Construction binds
//     the owner id at the request boundary; every method internally
//     applies the bound owner's filter so `(app_id, owner_id)`
//     tenant scoping is structural rather than caller discipline.
//   - **Typed user-domain errors** (`./errors`) —
//     `CaseNotFoundError`, `CasePropertiesValidationError`,
//     `CaseTypeNotInBlueprintError`, `SchemaNotSyncedError`. API
//     routes and Server Actions catch them by `instanceof` and map
//     to typed result arms (HTTP 404 / 400 for the first two; the
//     latter two carry contextual `(appId, caseType)` for
//     missing-case-type / schema-not-synced action arms). Every
//     other throw across `lib/case-store/**` is an internal-invariant
//     violation that reuses the helpers from
//     `lib/domain/predicate/errors.ts`.
//   - **Form-bridge** (`./form-bridge/deriveFromForm`,
//     `./form-bridge/writeThrough`) — pure derivation +
//     `CaseStore`-bound write-through that a completed form's case-
//     store operations route through.
//
// ## What this barrel does NOT export
//
//   - `PostgresCaseStore` (`./postgres/store`) — the only
//     implementation. Production callers go through
//     `withOwnerContext`; tests construct directly via subpath
//     import alongside the per-test isolated Kysely fixture.
//   - The Postgres connection layer (`./postgres/connection`).
//     `withOwnerContext` is the only path that needs the singleton;
//     external callers don't reach for the connection directly.
//   - The Atlas-driven SQL compiler stack (`./sql/index`). External
//     callers don't compile predicates against the case-store
//     directly — they go through `CaseStore.query` / `traverse`.
//     The compiler stack's own barrel at `./sql/index.ts` exposes
//     the surface tests use.
//   - The sample-data generator surface (`./sample/generator`,
//     `./sample/heuristic`). `withOwnerContext` wires the default
//     `HeuristicCaseGenerator`; alternative generators are a test
//     concern that imports through the subpath.
//   - The testcontainers harness (`./sql/__tests__/`) — test infra,
//     never an application surface.
//
// ## Pattern
//
// Every sibling module already curates its export surface. The
// barrel uses targeted `export type` / `export` re-exports rather
// than `export *` because two modules (`./store` and `./errors`)
// expose helper functions internal to the package that should not
// flow out through the barrel:
//
//   - `./store` exports `findCaseTypeOrThrow` and `buildCaseTypeMap`,
//     which are consumed by the implementation under
//     `./postgres/store.ts` and `./sample/heuristic.ts`. The
//     interface contract + row + arg types belong on the public
//     surface; the helpers do not.
//
// `export type` is used for type-only re-exports so consumers
// honoring `verbatimModuleSyntax` don't pull a runtime import for
// a type-only reference.

// ---------------------------------------------------------------
// CaseStore interface + row / arg / result types
// ---------------------------------------------------------------

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

// ---------------------------------------------------------------
// JSONB value types — consumed by callers that read `CaseRow.properties`
// ---------------------------------------------------------------
//
// `JsonObject` / `JsonValue` / `JsonPrimitive` are the typed shapes
// the case-store reads / writes for the JSONB `properties` column.
// External consumers (the running-app view's binding helpers, the
// form-bridge wire shape) need the types to walk row.properties
// without reaching into the SQL package's private surface.

export type {
	JsonObject,
	JsonPrimitive,
	JsonValue,
} from "./sql/database";

// ---------------------------------------------------------------
// Construction factory
// ---------------------------------------------------------------

export { withOwnerContext } from "./withOwnerContext";

// ---------------------------------------------------------------
// Typed user-domain errors
// ---------------------------------------------------------------

export type { CasePropertyFailure } from "./errors";
export {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	SchemaNotSyncedError,
} from "./errors";

// ---------------------------------------------------------------
// Form-bridge — completed-form → CaseStore operations
// ---------------------------------------------------------------

export type {
	ChildInsertOp,
	CompletedForm,
	DerivedFormOps,
	DeriveFromFormArgs,
	PrimaryRegistrationOp,
	PrimaryUpdateOp,
} from "./form-bridge/deriveFromForm";
export { deriveFromForm } from "./form-bridge/deriveFromForm";
export type {
	WriteFormCompletionArgs,
	WriteFormCompletionResult,
} from "./form-bridge/writeThrough";
export { writeFormCompletionThrough } from "./form-bridge/writeThrough";
