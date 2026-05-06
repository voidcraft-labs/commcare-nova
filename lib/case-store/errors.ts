// lib/case-store/errors.ts
//
// Typed user-domain errors for the case-store layer.
//
// ## Why a dedicated module
//
// Four `CaseStore` failure shapes flow back through the API
// surface to the user: a case the request points at doesn't exist,
// the payload submitted fails the schema, the blueprint snapshot
// the request carries doesn't declare the case type, and the
// schema row for the case type hasn't been synced yet. Every other
// throw across `lib/case-store/**` is an internal invariant
// violation — the AST / blueprint / connection layer reached a
// state an upstream gate was supposed to reject — and reuses the
// formatters at `lib/domain/predicate/errors.ts`
// (`compilerBugMessage` / `unhandledKindMessage` /
// `typeCheckerBypassMessage`). The four user-domain shapes need
// `instanceof` discrimination so API routes (and Server Actions)
// can map them to typed result arms; that discrimination is what
// this module provides.
//
// ## API-route catch-and-translate pattern
//
// API routes wrap their `CaseStore` calls in try/catch:
//
//   - `CaseNotFoundError` → 404. The body carries no detail beyond
//     the case id; the message acknowledges tenant boundaries
//     exist as an equivalence statement, not a confirmation that
//     the case is in another tenant. Three causes are equivalent
//     from the caller's perspective: the row was never created,
//     the row was closed and removed out of band, or the row sits
//     outside the bound owner's tenant. Surfacing the three as
//     equivalent keeps tenant boundaries structural rather than
//     message-leaked.
//   - `CasePropertiesValidationError` → 400. The structured
//     `failures` array surfaces — the user-actionable per-field
//     diagnostic the form layer (or whatever submitted the
//     payload) renders as inline error text. The `(appId,
//     caseType)` pair stays in the message for server-side logs
//     but does NOT surface in the response body — the wrapper
//     jargon (`case_type_schemas[<app>, <type>].schema`) is
//     internal vocabulary, not user vocabulary.
//   - `CaseTypeNotInBlueprintError` — the supplied blueprint
//     snapshot carries no case type with the requested name.
//     Reachable from user-driven actions (e.g. populating sample
//     cases) when the doc-store state mutates between the action's
//     mount and the user's click. Server Actions catch and emit a
//     typed `missing-case-type` result arm so the running-app view
//     re-resolves against fresh state instead of surfacing a 500
//     with `compilerBugMessage` jargon.
//   - `SchemaNotSyncedError` — the case type has no row in
//     `case_type_schemas` yet. Reachable from any write path
//     (`insert` / `update` / `generateSampleData`) when the
//     blueprint mutator skipped the `applySchemaChange` ordering
//     contract. Server Actions catch and emit a typed
//     `schema-not-synced` result arm so the consumer can surface
//     the structural fix (run `applySchemaChange` first) rather
//     than rendering the internal-invariant body.
//   - Anything else → propagates to the framework's 500 handler
//     with full server-side logging. The Elm-style helpers in
//     `lib/domain/predicate/errors.ts` produce verbose
//     diagnostics specifically because invariant violations are
//     debugged from logs, not from the response body.
//
// ## Voice
//
// Mirrors the `compilerBugMessage` / `typeCheckerBypassMessage`
// shape from the predicate package: third-person impersonal
// header, indented diagnostic body, narrative paragraph, a
// `Hint:` line stating the actionable next step. Backticks wrap
// code identifiers; single quotes wrap user-supplied values.
//
// ## Why `readonly name = "<ClassName>"`
//
// The class declaration writes `name` to the class prototype with
// the literal class-name string. Subclasses of `Error` lose their
// `name` to `"Error"` across some bundler boundaries (the
// inherited `name` field on `Error.prototype` shadows the
// subclass's name in minified or tree-shaken builds), so an
// `instanceof CaseNotFoundError` check would still work but a
// `err.name === "CaseNotFoundError"` check (e.g., a structured
// log filter) would break silently. Pinning `name` on the
// instance via the `readonly name = ...` field initializer keeps
// the literal stable across every transform. The pattern matches
// Better Auth's typed errors and Vercel's AI SDK's typed errors.

const INDENT = "    ";

// ---------------------------------------------------------------
// CaseNotFoundError — `update` against a case the bound owner
// cannot see
// ---------------------------------------------------------------

/**
 * Thrown by `CaseStore.update` when the patched `(case_id,
 * app_id)` pair has no matching row visible to the bound owner.
 * Three causes are equivalent from the caller's perspective:
 *
 *   - the row was never created
 *   - the row was closed and removed out of band
 *   - the row sits outside the bound owner's tenant
 *
 * The error surfaces all three as equivalent so the tenant
 * boundary stays structural — the message does not confirm
 * "another tenant has this case", which would leak the existence
 * of cases outside the bound owner's scope.
 *
 * `close` and `traverse` deliberately do NOT throw this error.
 * `close`'s "ensure this case is closed" semantic admits a silent
 * no-op for already-closed-or-missing cases (idempotent
 * teardown). `traverse` is a graph walk that returns a list, so
 * an empty result for a missing anchor is the right answer
 * (composable with downstream walks). Both shapes are
 * deliberate.
 *
 * API routes catch and map to HTTP 404 with no body detail beyond
 * the case id.
 */
export class CaseNotFoundError extends Error {
	/** Stable error name for log filters and instanceof-style checks. */
	readonly name = "CaseNotFoundError";
	/** The case id the operation tried to reach. */
	readonly caseId: string;

	constructor(caseId: string) {
		super(
			[
				`Case '${caseId}' not found.`,
				``,
				`${INDENT}case_id: '${caseId}'`,
				``,
				"The bound `CaseStore` owner cannot reach this case. Three causes are",
				"equivalent from the caller's perspective: the row may not exist, may",
				"have been closed and removed, or may sit outside the bound owner's",
				"tenant — the three are equivalent so the tenant boundary stays",
				"structural rather than message-leaked.",
				``,
				"Hint: API routes map this error to HTTP 404 with no body detail beyond",
				"the case id; the case-list view re-queries on resolve to pick up",
				"the latest visible row set.",
			].join("\n"),
		);
		this.caseId = caseId;
	}
}

// ---------------------------------------------------------------
// CasePropertiesValidationError — write-time JSON Schema mismatch
// ---------------------------------------------------------------

/**
 * One field-level validation failure. The `path` is the JSONB
 * pointer the AJV validator emits (e.g. `/age`, or the empty
 * string for the document root); the `message` is the AJV-
 * reported reason (`"must be integer"`, `"must match pattern"`,
 * etc.). The pair is what the form layer (or whatever produced
 * the payload) renders as inline error text against the
 * matching field input.
 */
export interface CasePropertyFailure {
	/** JSONB pointer to the offending property; empty string = document root. */
	readonly path: string;
	/** Human-readable failure reason from AJV. */
	readonly message: string;
}

/**
 * Thrown when `CaseStore.insert` or `CaseStore.update` receives a
 * `properties` payload that fails validation against the case
 * type's JSON Schema (the row in `case_type_schemas`). Carries
 * the structured per-field failure list as a public field so API
 * routes catch and re-emit it as an HTTP 400 response body.
 *
 * The `(appId, caseType)` pair stays in the message for server-
 * side logs but does NOT surface in the response body — the
 * wrapper jargon (`case_type_schemas[<app>, <type>].schema`) is
 * internal vocabulary, not user-facing vocabulary. The user-
 * actionable surface is the per-field `failures` array.
 */
export class CasePropertiesValidationError extends Error {
	/** Stable error name for log filters and instanceof-style checks. */
	readonly name = "CasePropertiesValidationError";
	/** The owning app — first half of the schema row's primary key. */
	readonly appId: string;
	/** The case type whose schema rejected the payload. */
	readonly caseType: string;
	/** Per-field failure detail. Surfaces in the API response body. */
	readonly failures: ReadonlyArray<CasePropertyFailure>;

	constructor(
		appId: string,
		caseType: string,
		failures: ReadonlyArray<CasePropertyFailure>,
	) {
		const failureLines = failures.map(
			(f) => `${INDENT}- ${f.path || "<root>"}: ${f.message}`,
		);
		super(
			[
				`Properties payload failed validation for case type '${caseType}'.`,
				``,
				`${INDENT}app_id:    '${appId}'`,
				`${INDENT}case_type: '${caseType}'`,
				``,
				`Field-level failures:`,
				``,
				...failureLines,
				``,
				"The payload was validated against the JSON Schema row in",
				"`case_type_schemas` for this `(app_id, case_type)` pair. The schema",
				"is regenerated by `applySchemaChange` on every blueprint mutation that",
				"affects the case type's property set, so a stale schema is not the",
				"failure mode here.",
				``,
				"Hint: API routes map this error to HTTP 400 with the structured",
				"`failures` array in the response body; clients render each entry",
				"against the matching field input.",
			].join("\n"),
		);
		this.appId = appId;
		this.caseType = caseType;
		this.failures = failures;
	}
}

// ---------------------------------------------------------------
// CaseTypeNotInBlueprintError — the supplied blueprint omits the
// requested case type
// ---------------------------------------------------------------

/**
 * Thrown by helpers that resolve a case type from a caller-supplied
 * blueprint snapshot when the snapshot carries no matching entry.
 * Surfaces from `findCaseTypeOrThrow`, which is invoked by
 * `applySchemaChange` (schema regen reads the prospective `CaseType`)
 * and by `HeuristicCaseGenerator.generate` (sample-data row
 * construction reads the property declarations).
 *
 * The throw is reachable from user-driven actions (the
 * "Generate sample data" affordance against the running-app view's
 * empty case-type) when the doc-store state mutates between the
 * action's mount and the user's click. Three causes are equivalent
 * from the caller's perspective:
 *
 *   - the case type was deleted in the editor between mount and
 *     click
 *   - the supplied blueprint snapshot is stale relative to the
 *     authoritative state
 *   - the case type was never declared in the first place
 *
 * Surfacing the three as equivalent keeps the typed shape narrow:
 * Server Actions map to a `missing-case-type` arm and re-resolve
 * against fresh state rather than rendering the
 * `compilerBugMessage` body with internal vocabulary.
 */
export class CaseTypeNotInBlueprintError extends Error {
	/** Stable error name for log filters and instanceof-style checks. */
	readonly name = "CaseTypeNotInBlueprintError";
	/** The owning app — paired with `caseType` for log scanning. */
	readonly appId: string;
	/** The case type the caller asked for. */
	readonly caseType: string;

	constructor(appId: string, caseType: string) {
		super(
			[
				`Case type '${caseType}' not found in the supplied blueprint.`,
				``,
				`${INDENT}app_id:    '${appId}'`,
				`${INDENT}case_type: '${caseType}'`,
				``,
				"The supplied blueprint snapshot carries no `caseTypes` entry with this",
				"name. Three causes are equivalent from the caller's perspective: the",
				"case type was deleted in the editor between mount and click, the",
				"snapshot is stale relative to the authoritative state, or the case",
				"type was never declared. Surfacing the three as equivalent keeps the",
				"typed shape narrow.",
				``,
				"Hint: Server Actions map this error to a `missing-case-type` result",
				"arm so the running-app view re-resolves against fresh blueprint",
				"state; clients re-fetch the doc and retry.",
			].join("\n"),
		);
		this.appId = appId;
		this.caseType = caseType;
	}
}

// ---------------------------------------------------------------
// SchemaNotSyncedError — the case type has no schema row yet
// ---------------------------------------------------------------

/**
 * Thrown when a write path (`insert` / `update` /
 * `generateSampleData`) reaches the JSON Schema validator and finds
 * no row in `case_type_schemas` for the `(appId, caseType)` pair.
 *
 * `applySchemaChange` is the only producer of `case_type_schemas`
 * rows. The spec § "Write-time validation" pins the ordering: every
 * blueprint mutation that touches a case type's property set runs
 * `applySchemaChange` before any data write reaches the case type,
 * so reaching this error means the blueprint mutator skipped the
 * sync step.
 *
 * The throw is reachable from user-driven actions (the
 * "Generate sample data" affordance) on a freshly-declared case
 * type whose schema sync hasn't run yet. Server Actions catch and
 * emit a typed `schema-not-synced` result arm so the consumer can
 * either retry after the sync lands or surface the structural fix
 * to the user without rendering internal vocabulary.
 */
export class SchemaNotSyncedError extends Error {
	/** Stable error name for log filters and instanceof-style checks. */
	readonly name = "SchemaNotSyncedError";
	/** The owning app — first half of the missing schema row's primary key. */
	readonly appId: string;
	/** The case type whose schema row is missing. */
	readonly caseType: string;

	constructor(appId: string, caseType: string) {
		super(
			[
				`No JSON Schema row found for case type '${caseType}'.`,
				``,
				`${INDENT}app_id:    '${appId}'`,
				`${INDENT}case_type: '${caseType}'`,
				``,
				"The case-store's write paths validate the candidate `properties`",
				"payload against the JSON Schema row in `case_type_schemas` for this",
				"`(app_id, case_type)` pair. `applySchemaChange` is the only producer",
				"of those rows; reaching this error means the blueprint mutator",
				"skipped the schema-sync ordering contract for the case type before",
				"the write hit `cases`.",
				``,
				"Hint: the blueprint mutator should call `applySchemaChange` before",
				"any write to a case type. Server Actions map this error to a",
				"`schema-not-synced` result arm so the consumer can either retry",
				"after the sync lands or surface the structural fix to the user.",
			].join("\n"),
		);
		this.appId = appId;
		this.caseType = caseType;
	}
}
