// lib/case-store/errors.ts
//
// Typed user-domain errors. These shapes carry `instanceof`
// discrimination so API routes and Server Actions can map them to
// typed result arms; every other throw across `lib/case-store/**`
// is an internal-invariant violation that reuses the helpers from
// `lib/domain/predicate/errors.ts`.
//
// `CaseNotFoundError` collapses three causes into one shape (row
// never created, row removed out of band, row outside the bound
// owner's tenant). The message acknowledges the equivalence rather
// than confirming the case is in another tenant — keeps tenant
// boundaries structural rather than message-leaked.
//
// Voice mirrors the `compilerBugMessage` shape: third-person
// impersonal header, indented diagnostic body, narrative paragraph,
// `Hint:` line. Backticks wrap code identifiers; single quotes wrap
// user-supplied values.
//
// `readonly name = "<ClassName>"` keeps the literal class-name
// stable across bundler transforms — subclasses of `Error` lose
// `name` to `"Error"` in some minified builds, so a structured-log
// filter on `err.name === "CaseNotFoundError"` would break without
// the field initializer. Same pattern Better Auth and Vercel's AI
// SDK use.

const INDENT = "    ";

/**
 * Thrown by an automation-scoped `CaseStore.count` when its target population
 * contains an open case with more than one distinct extension host. CommCare
 * HQ resolves `host/...` through the first live extension index without an
 * ordering contract, so returning Nova's defensive deterministic choice would
 * present an authoritative count HQ is not guaranteed to reproduce.
 *
 * The count and ambiguity preflight come from one PostgreSQL statement and
 * therefore one statement snapshot. The error carries only an aggregate, not
 * case or host identities, so callers cannot turn the refusal into a relation
 * discovery surface.
 */
export class AutomationHostAmbiguityError extends Error {
	/** Stable error name for log filters and instanceof-style checks. */
	readonly name = "AutomationHostAmbiguityError";
	/** Number of open, otherwise-visible target cases with ambiguous hosts. */
	readonly ambiguousOpenCaseCount: number;

	constructor(ambiguousOpenCaseCount: number) {
		super(
			[
				"Automation match count has ambiguous extension hosts.",
				``,
				`${INDENT}ambiguous_open_case_count: ${ambiguousOpenCaseCount}`,
				``,
				"CommCare HQ reads `host/...` from the first live extension index but",
				"does not define that index order. Nova therefore cannot report one of",
				"the possible host projections as an authoritative Preview count.",
			].join("\n"),
		);
		this.ambiguousOpenCaseCount = ambiguousOpenCaseCount;
	}
}

/**
 * Thrown by `CaseStore.update` when the patched `(case_id,
 * app_id)` pair has no matching row visible to the bound owner.
 *
 * `close` and `traverse` deliberately do NOT throw this error.
 * `close`'s "ensure this case is closed" semantic admits a silent
 * no-op for already-closed-or-missing cases. `traverse` is a graph
 * walk that returns a list, so an empty result for a missing
 * anchor is the right answer.
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
				"tenant, the three are equivalent so the tenant boundary stays",
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

/**
 * Thrown when a review-surface operation names a kept entry the
 * bound `CaseStore` cannot reach. Mirrors {@link CaseNotFoundError}'s
 * posture: "never existed", "already restored/deleted", and "outside
 * the bound Project" are deliberately indistinguishable so the tenant
 * boundary stays structural rather than message-leaked.
 */
export class ParkedValueNotFoundError extends Error {
	/** Stable error name for log filters and instanceof-style checks. */
	readonly name = "ParkedValueNotFoundError";
	/** The kept entry's id the operation tried to reach. */
	readonly parkedValueId: string;

	constructor(parkedValueId: string) {
		super(
			[
				`Review entry '${parkedValueId}' not found.`,
				``,
				`${INDENT}parked_value_id: '${parkedValueId}'`,
				``,
				"The bound `CaseStore` owner cannot reach this entry. It may never",
				"have existed, may already be restored or deleted (entries die with",
				"their case row), or may sit outside the bound owner's tenant, the",
				"three are equivalent so the tenant boundary stays structural rather",
				"than message-leaked.",
				``,
				"Hint: the review surface re-lists on resolve to pick up the latest",
				"visible entry set.",
			].join("\n"),
		);
		this.parkedValueId = parkedValueId;
	}
}

/**
 * One field-level validation failure. `path` is the JSONB pointer
 * AJV emits (e.g. `/age`, or the empty string for the document
 * root); `message` is the AJV-reported reason. Form layers render
 * the pair as inline error text against the matching field input.
 */
export interface CasePropertyFailure {
	/** JSONB pointer to the offending property; empty string = document root. */
	readonly path: string;
	/** Human-readable failure reason from AJV. */
	readonly message: string;
	/**
	 * Set ONLY for an `additionalProperties` failure — the name of the
	 * property the schema row does not declare. This is the structural
	 * "schema drift" signal the point-of-use heal keys on
	 * (`withSchemaHeal`): a write carrying a property the case type's
	 * stale row lacks. Absent for every other failure kind
	 * (type / format / enum / pattern), which the heal treats as genuine
	 * invalid data and surfaces without re-materializing.
	 */
	readonly additionalProperty?: string;
}

/**
 * Thrown when `CaseStore.insert` or `CaseStore.update` receives a
 * `properties` payload that fails validation against the case
 * type's JSON Schema. The structured per-field failure list
 * surfaces as a public field so API routes catch and re-emit it
 * as the HTTP 400 response body.
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
				"`case_type_schemas` for this `(app_id, case_type)` pair.",
				"`applySchemaChange` regenerates that row on every blueprint mutation",
				"that affects the case type's property set, but a sync that never",
				"lands (e.g. a swallowed drain-end materialize on a chat edit arm)",
				"leaves the row STALE, built from an older catalog. A write carrying a",
				"property added after the last sync then fails here with",
				"`additionalProperties` even though the value is valid against the",
				"current blueprint. The running-app layer treats that as recoverable:",
				"`withSchemaHeal` re-materializes from the persisted blueprint and",
				"retries once before this error surfaces.",
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

/**
 * Thrown when a "look up this case type" lookup at the case-store
 * boundary returns nothing. Two production throw sites today:
 *
 *   - `PostgresCaseStore.applySchemaChange` — throws when the
 *     supplied `caseTypeSchemas` map carries no entry for the
 *     requested case-type name (the schema-map lookup is the
 *     case-store's authoritative case-type resolution path).
 *   - `caseDataBindingHelpers.resolveCaseTypeOrThrow` — the
 *     running-app preview layer's seed-sample-cases helper
 *     resolves a `CaseType` definition out of the supplied
 *     `BlueprintDoc` snapshot before forwarding it to
 *     `CaseStore.generateSampleData`; throws when
 *     `blueprint.caseTypes` carries no entry with the matching
 *     name.
 *
 * Reachable from user-driven actions when the doc-store state
 * mutates between the action's mount and the user's click. Server
 * Actions map to a `missing-case-type` arm and re-resolve against
 * fresh state.
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

/**
 * Thrown when a write path (`insert` / `update` /
 * `generateSampleData`) reaches the JSON Schema validator and finds
 * no row in `case_type_schemas` for the `(appId, caseType)` pair.
 *
 * `applySchemaChange` is the only producer of `case_type_schemas`
 * rows; reaching this error means the blueprint mutator skipped the
 * sync step. Server Actions map to a `schema-not-synced` arm.
 */
/**
 * `applySchemaChange`'s Phase B (post-commit index DDL) failed AFTER
 * Phase A committed its schema write + row migrations. The wrapper preserves
 * the COMMITTED Phase-A `MigrationReport` so the initiating surface can report
 * parked values accurately while durable pending state drives later index
 * convergence. `cause` carries the underlying fault, one level deep, exactly
 * where `isTransientDbError` looks, so transient classification keeps working
 * through the wrap.
 *
 * The report shape lives on the interface side; the slot is typed
 * structurally here to keep `errors.ts` a leaf.
 */
export class SchemaChangePhaseBError extends Error {
	/** Stable error name for log filters and instanceof-style checks. */
	readonly name = "SchemaChangePhaseBError";
	/** The case type whose Phase A committed — harvesting callers attribute the report's parks to it. */
	readonly caseType: string;
	/** The COMMITTED Phase-A report — parked ids and all. */
	readonly report: {
		readonly migrated: number;
		readonly reshaped: number;
		readonly retyped: number;
		readonly restored: number;
		readonly skipped: number;
		readonly parkedIds: string[];
		readonly failureReasons: string[];
	};

	constructor(args: {
		appId: string;
		caseType: string;
		report: SchemaChangePhaseBError["report"];
		cause: unknown;
	}) {
		super(
			[
				`Index DDL (Phase B) failed for case type '${args.caseType}' after its schema write + row migrations committed.`,
				``,
				`${INDENT}app_id:    '${args.appId}'`,
				`${INDENT}case_type: '${args.caseType}'`,
				``,
				"Phase A is durable: the schema row and every row rewrite (including",
				"parked values) are committed, and its pending marker remains.",
				"The next per-app or deployment-wide convergence drain re-derives",
				"the latest desired indexes and retries Phase B idempotently.",
				"Callers must not compensate or un-park committed Phase-A data.",
			].join("\n"),
			{ cause: args.cause },
		);
		this.caseType = args.caseType;
		this.report = args.report;
	}
}

/** Expected atomic rejection from the form-entry/capture admission gate. */
export class CaptureSubmissionRejectedError extends Error {
	readonly name = "CaptureSubmissionRejectedError";
}

/**
 * Why the submission envelope refused an advanced case operation. Every
 * arm is a pre-DML rejection: the transaction rolls back whole, so no
 * partial effect is observable. The arms mirror the wire's atomic
 * failure modes — a blank/overlong authored key or text value, a
 * runtime target the tenant-bound snapshot cannot authorize, a resolved
 * sequence the rolling type proof rejects, and a retype whose retained
 * document the destination schema cannot hold (the `wirePortable`
 * runtime enforcement).
 */
export type SubmissionRejection =
	| {
			readonly kind: "selection";
			readonly reason:
				| "empty"
				| "too-many"
				| "duplicate"
				| "not-found-or-out-of-scope"
				| "case-type-mismatch"
				| "program-selection-mismatch"
				| "authored-key-create-not-supported"
				| "session-link-not-supported";
			readonly caseId?: string;
			readonly maximum?: number;
			readonly expectedCaseType?: string;
			readonly actualCaseType?: string;
	  }
	| {
			readonly kind: "authored-key";
			readonly operationUuid: string;
			readonly reason: "blank" | "too-long";
			readonly maxKeyLength: number;
	  }
	| {
			readonly kind: "text-value";
			readonly operationUuid: string;
			readonly facet: "name" | "rename" | "owner" | "external_id";
			readonly reason: "blank" | "too-long";
	  }
	| {
			readonly kind: "target";
			readonly operationUuid: string;
			readonly slot: "target" | `link:${string}`;
			readonly reason: "not-found-or-out-of-scope" | "case-type-mismatch";
	  }
	| {
			readonly kind: "sequence";
			readonly operationUuid: string;
			readonly slot: "target" | `link:${string}`;
			readonly reason:
				| "case-link-target-is-self"
				| "rolling-case-type-mismatch"
				| "authored-key-identity-is-type-stable";
	  }
	| {
			readonly kind: "retype-not-portable";
			readonly operationUuid: string;
			readonly caseId: string;
			readonly toCaseType: string;
			readonly failures: ReadonlyArray<CasePropertyFailure>;
	  };

/**
 * Thrown by `CaseStore.applySubmission` when the advanced-operation
 * program violates its runtime contract. Always pre-effect for the
 * rejected fact and always whole-envelope: the transaction rolls back,
 * so the ordinary form action and every other operation land not at
 * all. The structured `rejection` is the typed result arm's payload;
 * the message names the facts for logs.
 */
export class SubmissionRejectedError extends Error {
	/** Stable error name for log filters and instanceof-style checks. */
	readonly name = "SubmissionRejectedError";
	readonly rejection: SubmissionRejection;

	constructor(rejection: SubmissionRejection) {
		const detail: string[] = [`${INDENT}kind: '${rejection.kind}'`];
		if (rejection.kind !== "retype-not-portable") {
			detail.push(`${INDENT}reason: '${rejection.reason}'`);
		}
		if ("operationUuid" in rejection) {
			detail.push(`${INDENT}operation: '${rejection.operationUuid}'`);
		}
		if (rejection.kind === "selection") {
			if (rejection.caseId !== undefined) {
				detail.push(`${INDENT}case: '${rejection.caseId}'`);
			}
			if (rejection.maximum !== undefined) {
				detail.push(`${INDENT}maximum: '${rejection.maximum}'`);
			}
		}
		super(
			[
				`Submission rejected: the form's case-effect program failed its runtime contract.`,
				``,
				...detail,
				``,
				"Nothing was written, the envelope applies a whole submission in one",
				"transaction, and every operation contract check runs before its",
				"effect. The running-app layer maps this error to a typed submission",
				"failure so the worker sees one atomic rejection, mirroring how Core",
				"and HQ fail the same submission's XML transaction.",
			].join("\n"),
		);
		this.rejection = rejection;
	}
}

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
