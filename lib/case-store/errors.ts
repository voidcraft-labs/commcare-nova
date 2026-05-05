// lib/case-store/errors.ts
//
// Typed user-domain errors for the case-store layer.
//
// ## Why a dedicated module
//
// Two `CaseStore` failure shapes flow back through the API surface
// to the user: "the case you asked about doesn't exist" and "the
// payload you submitted doesn't match the case-type's schema".
// Every other throw across `lib/case-store/**` is an internal
// invariant violation — the AST / blueprint / connection layer
// reached a state an upstream gate was supposed to reject — and
// reuses the formatters at `lib/domain/predicate/errors.ts`
// (`compilerBugMessage` / `unhandledKindMessage` /
// `typeCheckerBypassMessage`). The two user-domain shapes need
// `instanceof` discrimination so API routes can map them to HTTP
// status codes; that discrimination is what this module provides.
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
// CaseNotFoundError — `update` / `close` / `traverse` against a
// case the bound owner cannot see
// ---------------------------------------------------------------

/**
 * Thrown when a `CaseStore` operation references a `(case_id,
 * app_id)` pair the bound owner cannot reach. Three causes are
 * equivalent from the caller's perspective:
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
