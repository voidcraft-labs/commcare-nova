// lib/preview/engine/caseDataBindingTypes.ts
//
// Discriminated-union result shapes for the running-app view's
// data binding. Split from the Server Action module so client
// consumers can import the types without pulling in the
// `"use server"` boundary (Next.js's compiler rejects type-only
// imports across that boundary in some build modes).
//
// Empty / missing arms are NOT errors — they're normal render
// branches per the always-in-valid-state principle. Errors are
// reserved for genuine failures.
//
// `unauthenticated` exists for the narrow "session expired
// mid-render" case. The page redirects anonymous sessions to `/`
// before client code runs; the action returns this arm as a typed
// result rather than throwing so the consumer can surface a
// re-auth nudge.

import type {
	CalculatedValue,
	CaseGroup,
	CaseIndexRow,
	CasePropertyFailure,
	CaseRow,
	CaseRowWithCalculated,
	ConversionImpact,
	CreatedChildCaseReceipt,
	JsonObject,
	JsonValue,
	ParkedValueEntry,
	ParkedValueStanding,
	SubmissionRejection,
} from "@/lib/case-store";
import type { CasePropertyDataType } from "@/lib/domain";

// `CaseRow` re-exported as a barrel surface so consumers have one
// import path for the binding's types. `CaseRowWithCalculated`
// rides the same surface for the running case list and filter-count
// preview paths. `CalculatedValue`, `JsonValue`, and `JsonObject`
// ride the same surface so client-bundle-bound
// consumers + the server-only helpers can type-import them from
// this leaf without touching the case-store barrel — the barrel
// value-exports `withOwnerContext`, which pulls the Postgres
// connection module + every transitive dep into any graph that
// imports from it.
export type {
	CalculatedValue,
	CaseGroup,
	CasePropertyFailure,
	CaseRow,
	CaseRowWithCalculated,
	CreatedChildCaseReceipt,
	JsonObject,
	JsonValue,
};

/**
 * Ordered case set selected by a containing menu. One id is the ordinary
 * parent-first flow; several ids scope a related child list to the union of
 * their direct non-extension children. Server readers validate the whole set
 * against this app, Project, and `caseType` before returning any child.
 */
export interface ParentCaseSelection {
	readonly caseType: string;
	readonly caseIds: readonly string[];
}

/** Why the effective query can return zero rows. Derived at the server query
 * composition boundary after blank inputs and empty owner-id expressions have
 * been removed, so the running app never guesses from client-side syntax. */
export type CaseQueryConstraintSource =
	| "unconstrained"
	| "worker-search"
	| "authored-rules";

/** What the client can truthfully say about a settled query result. */
export type CaseQueryConstraintContext = CaseQueryConstraintSource;

/**
 * Result of loading case rows for a case type, optionally as a bounded window.
 * The success arms carry the effective query's constraint source alongside
 * their data so empty-state copy describes the query that actually reached the
 * case store, not merely the presence of an authored expression or a raw
 * submitted string. The `rows` arm carries `CaseRowWithCalculated` so calc-arm
 * columns surface their
 * SQL-projected values on `row.calculated[uuid]` — `evaluateColumnValue`
 * reads the slot directly. Callers without a `caseListConfig` (raw-
 * row consumers) get an empty `calculated: {}` map per row.
 */
export type LoadCasesResult =
	| {
			kind: "rows";
			rows: ReadonlyArray<CaseRowWithCalculated>;
			/** Full ROW population matching the authored + worker query, in
			 * both the ordinary and the grouped shape. Present for bounded
			 * running-list reads; absent for current unpaged helper callers. */
			totalCount?: number;
			/** Effective bounded ROW window returned by the server. The server
			 * may clamp an offset past the final page after concurrent
			 * deletion. Absent for a grouped read, which has no row window —
			 * see `grouped` below. */
			pageOffset?: number;
			pageSize?: number;
			/**
			 * Present exactly when the case list is grouped.
			 *
			 * `rows` above stays the flat page in clustered order, so every
			 * consumer that reads rows keeps working; this adds the clustering
			 * the tile renderer draws from.
			 *
			 * Its window is a SEPARATE slot rather than an alternate reading of
			 * `pageOffset` / `pageSize` because its unit is different: a
			 * grouped list pages by group, so the numbers here count groups
			 * while `totalCount` still counts cases. **A grouped page is
			 * therefore unbounded in rows** — a window of N groups returns
			 * however many cases those groups hold, which is the platform's
			 * own behaviour
			 * (`formplayer/.../beans/menus/EntityListResponse::getEntitiesForCurrentPage`
			 * counts group boundaries), not something to engineer around.
			 */
			grouped?: {
				groups: ReadonlyArray<CaseGroup>;
				pageOffset: number;
				pageSize: number;
				totalGroupCount: number;
			};
			constraintSource: CaseQueryConstraintSource;
			/**
			 * Cases matching the authored query that this worker's device would
			 * NOT hold — the ghosted reveal's number.
			 *
			 * Present only on a persona preview whose restore actually excluded
			 * something, so the reveal appears exactly when there is something
			 * to reveal. It is authoring-only inspection, never a blend of the
			 * two preview modes: the list itself stays honest about what the
			 * device holds, and this says how much the author is not seeing.
			 */
			outsideRestoreCount?: number;
	  }
	| {
			kind: "empty";
			/** When a worker Search and authored availability are both active,
			 * this count isolates the authored-only population. Zero proves that
			 * clearing Search cannot reveal a case; a positive value proves that
			 * Search itself narrowed the authored population to zero. */
			authoredMatchingCount?: number;
			constraintSource: CaseQueryConstraintSource;
			/** Same reveal as the `rows` arm — an empty restore over a populated
			 * tenant is exactly when an author most needs to be told why. */
			outsideRestoreCount?: number;
	  }
	/** A safe, deterministic Search-value rejection. Unlike `error`, retrying
	 * unchanged input cannot help, so consumers show the cause beside Search
	 * and never offer a transport-style retry button. */
	| {
			kind: "invalid-search";
			message: string;
			/** Whether the worker can repair a submitted prompt or the authored
			 * Search/session expression itself needs an editor. */
			repair: "inputs" | "settings";
	  }
	| PreviewPersonaUnavailableResult
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/** A selected persona was removed (or the selection is otherwise stale).
 * Never silently falls back to the signed-in member: that would render one
 * worker while the chrome still names another, and writes could land under
 * the wrong owner. */
export type PreviewPersonaUnavailableResult = {
	kind: "persona-unavailable";
	message: string;
};

/**
 * Unfiltered case count for the builder-owned case-data manager. This is
 * deliberately a separate action from `LoadCasesResult`: the manager needs
 * the full population size, while list surfaces may be filtered, paginated,
 * or carrying calculated projections.
 */
export type LoadCaseCountResult =
	| { kind: "count"; count: number }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

export type LoadPersonaOwnedCaseCountResult =
	| LoadCaseCountResult
	| PreviewPersonaUnavailableResult;

/**
 * Result of `conversionImpactAction` — the consent preview for a
 * failable kind conversion. The `impact` arm IS the store's
 * `ConversionImpact` (counts computed with the migration's own cast
 * over the migration's own population, held cases included), so the
 * dialog's numbers are the migration's numbers for the same data and
 * a field added to the preview reaches the dialog by construction.
 */
export type ConversionImpactResult =
	| ({ kind: "impact" } & ConversionImpact)
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * One kept value as it crosses the Server Action wire —
 * `ParkedValueEntry` (see `lib/case-store`) with its timestamps as
 * ISO strings so the payload stays plain JSON. The `standing`
 * verdict is computed server-side against the property's CURRENT
 * declaration; the client renders it, never re-derives it.
 */
export interface ParkedValueEntryWire
	extends Omit<ParkedValueEntry, "createdAt" | "dismissedAt"> {
	createdAt: string;
	dismissedAt: string | null;
}

// The wire's transition tokens and the entry's standing union
// re-exported beside the entry so the review screen types its
// grouping and per-row story off this leaf module.
export type { CasePropertyDataType, ParkedValueStanding };

/**
 * Result of listing a case type's kept values. One arm serves
 * every reader — the review screen renders the full entries; the
 * discovery surfaces (the Case data badge + popover section) derive
 * their active count and property names from the same list, so one
 * invalidation channel refreshes both.
 */
export type LoadParkedValuesResult =
	| { kind: "entries"; entries: ParkedValueEntryWire[] }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/** Result of the review surface's explicit restore. `kept` counts entries that stayed parked (blocked, vanished, dismissed, or foreign) — the client re-lists to show why. `displaced` counts occupying values the put back archived under Dismissed instead of destroying. */
export type RestoreParkedValuesResult =
	| { kind: "restored"; restored: number; kept: number; displaced: number }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/** Result of toggling the soft archive on kept entries. */
export type SetParkedValuesDismissedResult =
	| { kind: "toggled"; count: number }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of the Replace path (write a replacement value to the case,
 * archive the entry). `invalid-value` carries the schema's per-field
 * failures for inline rendering; `not-found` means the entry vanished
 * (a teammate restored/dismissed it, or its case row was replaced) —
 * the client re-lists.
 */
export type ReplaceParkedValueResult =
	| { kind: "replaced" }
	| { kind: "invalid-value"; failures: readonly CasePropertyFailure[] }
	| { kind: "not-found" }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of loading the Filters-section live-preview rows + count.
 * The Filters-section preview pairs a limited row sample (top ~10
 * rows passing the filter) with the full matching count so the
 * author sees both "what passes" and "how many pass" without
 * paying for a full row fetch.
 *
 * `totalCount` is the row population
 * matching the predicate (NOT the row sample's `rows.length`).
 * The renderer uses both numbers to surface "Showing N of M cases
 * that pass this filter".
 *
 * The success path collapses to a single `rows` arm (with possibly
 * empty `rows` array). A separate `empty` arm would tightly couple
 * `rows.length === 0` with `totalCount === 0`, which fails under
 * the rare race where a row matching the filter is deleted between
 * the row sample read and the count read — the row query returns
 * empty but the count returns the pre-delete value. The collapsed
 * shape keeps the count value honest and lets the renderer decide
 * how to format the rows-empty case from the same arm.
 *
 * The `paused` arm is NOT part of this shape because the Server Action
 * never returns it — the
 * client component renders the paused state locally when its
 * `filterValid` prop is `false` and never fires the action.
 */
export type LoadFilterPreviewResult =
	| {
			kind: "rows";
			rows: ReadonlyArray<CaseRowWithCalculated>;
			totalCount: number;
	  }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	/**
	 * The Server Action's input failed `caseListConfigSchema`
	 * validation at the trust boundary. Same shape as
	 * The action is the wire boundary; an unparseable config arriving
	 * over the wire surfaces as a typed arm rather than letting
	 * the downstream `compilePredicate` invariant message leak
	 * through the catchall `error` arm.
	 */
	| { kind: "invalid-config"; message: string }
	/**
	 * The Server Action's input failed `blueprintDocSchema`
	 * validation. Same trust-boundary argument as `invalid-config`.
	 */
	| { kind: "invalid-blueprint"; message: string }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of loading a single case by id (the case-loading form
 * path for followup / close, and the URL-backed Details path).
 * `missing` covers absent-id AND cross-tenant — equivalent under
 * the case-store contract.
 *
 * The row always uses the case-store's projected shape. Raw form
 * loads receive `calculated: {}`; Details can supply the live case-list
 * configuration and catalog so calculated display values are projected
 * for an off-page/deep-linked row without applying the Results filter,
 * sort, or page window.
 *
 * `ancestors` is the bound case's parent chain, nearest-first
 * (parent, grandparent, …), walked server-side through the case
 * store's `parent` index edges. The form engine resolves
 * `#<ancestor_type>/<prop>` references against it — the preview
 * counterpart of the wire's `…/index/parent × depth …` casedb
 * walk. Empty for a root case.
 */
export type LoadCaseDataResult =
	| {
			kind: "row";
			row: CaseRowWithCalculated;
			ancestors: ReadonlyArray<CaseRow>;
	  }
	| { kind: "missing" }
	| PreviewPersonaUnavailableResult
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of seeding sample cases. `inserted` surfaces the actual
 * count for the user-facing confirmation. Three failure arms
 * covering preconditions / validation, all carrying `caseType` so
 * the UI can name the affected type without re-deriving from URL
 * state:
 *
 * - `missing-case-type` — blueprint snapshot omits the case type.
 *   Consumer re-resolves against fresh state and retries.
 * - `schema-not-synced` — the blueprint mutator skipped
 *   `applySchemaChange` for the case type. Consumer retries after
 *   the sync lands.
 * - `validation-failure` — AJV rejected a generated row's
 *   properties payload during bulk-insert. The consumer renders
 *   the per-field `failures` list.
 */
export type PopulateSampleCasesResult =
	| { kind: "ok"; inserted: number }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	| {
			kind: "validation-failure";
			caseType: string;
			failures: ReadonlyArray<CasePropertyFailure>;
	  }
	| PreviewPersonaUnavailableResult
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * One submission's worth of case-store mutations, derived from a
 * completed form. The form engine emits this directly — the
 * authoring layer has no `XForm`-style serialization step between
 * the engine's tree and the case-store. `kind` mirrors `FormType`
 * so the type checker forces consumers to reason about every arm.
 *
 * Per-arm shape:
 * - `registration` — `primary` is the new case the form creates;
 *   `children` are additional cases bucketed by explicit `caseWrite`
 *   destination and repeat identity.
 *   Children carry NO `parentCaseId`; the case-store's submission
 *   envelope threads the primary's generated id at write time.
 * - `followup` — `caseIds` is the ordered selected set the form acts on;
 *   `patch.properties` is the JSONB delta. Multi-case admission forbids the
 *   primary patch; ordinary children expand once per selected parent in the
 *   atomic envelope.
 * - `close` — same shape as `followup`, plus the bound case's atomic
 *   lifecycle transition (`closed_on` + built-in `status = "closed"`)
 *   after the updates land.
 * - `survey` — structural no-op; the form owns no case rows.
 *
 * All three case-bearing arms land through `CaseStore.applySubmission`
 * in ONE Postgres transaction — primary write, every child, and the
 * close transition together or not at all.
 *
 * `caseName` and `externalId` are separate from `properties` because the
 * case-store routes them to dedicated row columns. The JSONB document carries
 * only user-defined properties. The walker keys off the explicit
 * `caseWrite.property`, not the editable form-field id.
 */
/** One collected answer for the operation program — plain JSON for the
 *  Server Action wire (a Map would flip the call to multipart and trip
 *  the edge WAF). Multi-select answers carry the real token array. */
export interface SubmissionAnswerEntry {
	readonly fieldUuid: string;
	readonly value: string | readonly string[];
}

/**
 * Per-scope operation answer bindings, COMPLETE per iteration: each
 * repeat iteration's entry list carries the root answers, every
 * enclosing repeat's answers resolved for that concrete instance, and
 * the iteration's own answers — the executor binds each expression
 * with exactly its iteration's list. Repeat iterations flatten
 * parent-major in live instance order (the executor's expansion
 * order); a repeat with zero live iterations still appears with an
 * empty list so the server can hand the executor its required scope
 * entry. The server is the structural authority — it consumes ONLY
 * these answer values and iteration counts, deriving everything else
 * from the committed doc.
 */
export interface SubmissionOperationAnswers {
	readonly root: ReadonlyArray<SubmissionAnswerEntry>;
	readonly repeats: ReadonlyArray<{
		readonly repeat: string;
		readonly iterations: ReadonlyArray<ReadonlyArray<SubmissionAnswerEntry>>;
	}>;
}

/** One concrete capture answer carried by the submitted form instance. */
export interface SubmissionAttachmentReference {
	readonly attachmentName: string;
	readonly fieldUuid: string;
	readonly instancePath: string;
}

/**
 * Raw submitted values for the one field a close form's committed close
 * condition reads. `values` follows the main instance's relevant node order:
 * zero values is an empty nodeset, one is the ordinary scalar case, and more
 * than one is preserved so the server can reject the same scalar-coercion
 * ambiguity JavaRosa rejects rather than choosing an iteration.
 *
 * This is answer data, never condition authority. The committed form chooses
 * the field, operator, and comparison value server-side.
 */
export interface SubmissionCloseConditionAnswers {
	readonly fieldUuid: string;
	readonly values: ReadonlyArray<string>;
}

/**
 * Stable identity of one authored ordinary child bucket. `caseType` plus the
 * nearest repeat UUID (or root when absent) identifies the committed bucket;
 * `repeatInstanceKey` distinguishes concrete submitted iterations without
 * turning their rendered path into authority. The server validates every
 * member against the committed case-write inventory before projecting a seed.
 */
export interface SubmissionOrdinaryChildBucket {
	readonly caseType: string;
	readonly repeatUuid?: string;
	readonly repeatInstanceKey?: string;
}

/**
 * The final submission protocol every arm carries.
 *
 * `entryKey` names this form entry's attachment scope
 * (`EngineController.entryKey`), while `attachmentRefs` is the exact surviving
 * RELEVANT answer projection, including an explicit empty list. The server
 * validates this identity/projection at the Server Action boundary before it
 * derives a receipt, operation program, or capture intent.
 *
 * Neither value is authority: the server matches references against the
 * acting member's own staged rows in the app's Project, so a forged projection
 * can neither prepare nor preserve another member's attachment.
 *
 * The slots are plain JSON by necessity as well as by taste. A `File` or a
 * `Map` argument makes React encode the Server Action as
 * `multipart/form-data`, whose part headers the edge WAF reads as header
 * injection — which is also why the bytes never travel this way at all.
 */
interface SubmissionProtocol {
	readonly formUuid: string;
	readonly entryKey: string;
	readonly attachmentRefs: ReadonlyArray<SubmissionAttachmentReference>;
	readonly closeConditionAnswers?: SubmissionCloseConditionAnswers;
	/** Aligned 1:1 with a case-bearing arm's `children`. FormEngine always
	 * supplies it; optional in the untrusted wire type so a stale or forged
	 * client can reach the server's explicit reload-and-submit rejection. */
	readonly ordinaryChildBuckets?: ReadonlyArray<SubmissionOrdinaryChildBucket>;
	readonly operationAnswers?: SubmissionOperationAnswers;
	/**
	 * Answers saved to the worker's own record, if the form has any.
	 *
	 * On the protocol rather than inside an arm because that is where the wire
	 * puts it: `usercase_update` is independent of the primary case action, so
	 * a survey form carries one just as a followup does.
	 *
	 * Not authority. The server writes it to the ACTING worker's record —
	 * addressed by the store's own bound owner — so this names values, never a
	 * record.
	 */
	readonly usercase?: JsonObject;
}

export type SubmissionMutation = SubmissionProtocol &
	(
		| {
				kind: "registration";
				primary: {
					caseType: string;
					caseName?: string;
					externalId?: string;
					properties: JsonObject;
				};
				children: ReadonlyArray<{
					caseType: string;
					caseName?: string;
					externalId?: string;
					properties: JsonObject;
				}>;
		  }
		| {
				kind: "followup";
				caseIds: ReadonlyArray<string>;
				patch: {
					caseName?: string;
					externalId?: string;
					properties: JsonObject;
				};
				children: ReadonlyArray<{
					caseType: string;
					caseName?: string;
					externalId?: string;
					properties: JsonObject;
				}>;
		  }
		| {
				kind: "close";
				caseIds: ReadonlyArray<string>;
				patch: {
					caseName?: string;
					externalId?: string;
					properties: JsonObject;
				};
				children: ReadonlyArray<{
					caseType: string;
					caseName?: string;
					externalId?: string;
					properties: JsonObject;
				}>;
		  }
		| {
				/** A survey touches no case ORDINARILY, but its case operations and
				 * capture intent still execute through the same final protocol. */
				kind: "survey";
		  }
	);

/**
 * Open-tab compatibility shape for a FormScreen that was loaded before
 * several-case selection shipped. The old client names its one followup/close
 * target as `caseId`; the Server Action preserves that exact object for
 * durable receipt hashing, then normalizes it to canonical `caseIds` before
 * deriving any program or storage effect.
 *
 * This is deliberately a wire-boundary type, not an engine mutation. New
 * callers only produce `SubmissionMutation`, and no downstream runtime is
 * allowed to recover a representative scalar from a several-case selection.
 */
export type LegacySingleCaseSubmissionMutation = SubmissionProtocol &
	(
		| (Omit<Extract<SubmissionMutation, { kind: "followup" }>, "caseIds"> & {
				readonly caseId: string;
		  })
		| (Omit<Extract<SubmissionMutation, { kind: "close" }>, "caseIds"> & {
				readonly caseId: string;
		  })
	);

export type SubmissionWireMutation =
	| SubmissionMutation
	| LegacySingleCaseSubmissionMutation;

/**
 * Result of submitting a `SubmissionMutation` through the
 * case-store. The success arms mirror `SubmissionMutation` so a
 * caller can branch on the same discriminator across pre- and
 * post-write code. Failure arms follow the `populateSampleCasesAction`
 * typed-error shape — the case-store's domain errors map 1:1.
 */
export type SubmissionResult =
	| {
			kind: "registration";
			caseId: string;
			/** Flat compatibility alias for a pre-deploy FormScreen. */
			childCaseIds?: ReadonlyArray<string>;
			/** Absent only when replaying a historical flat child-id receipt whose
			 * authored-child/parent mapping cannot be reconstructed safely. */
			createdChildren?: ReadonlyArray<CreatedChildCaseReceipt>;
			caseDatabasePatch?: {
				readonly rows: readonly CaseRow[];
				readonly indices: readonly CaseIndexRow[];
				readonly propertyTypes?: Readonly<
					Record<string, Readonly<Record<string, CasePropertyDataType>>>
				>;
			};
	  }
	| {
			kind: "followup";
			caseIds: ReadonlyArray<string>;
			/** Present only for a singleton result. A true batch has no scalar
			 * representative, so Nova never fabricates one. */
			caseId?: string;
			/** Flat compatibility alias for a pre-deploy FormScreen. */
			childCaseIds?: ReadonlyArray<string>;
			/** Absent only for a historical flat child-id receipt. */
			createdChildren?: ReadonlyArray<CreatedChildCaseReceipt>;
			caseDatabasePatch?: {
				readonly rows: readonly CaseRow[];
				readonly indices: readonly CaseIndexRow[];
				readonly propertyTypes?: Readonly<
					Record<string, Readonly<Record<string, CasePropertyDataType>>>
				>;
			};
	  }
	| {
			kind: "close";
			caseIds: ReadonlyArray<string>;
			/** Present only for a singleton result. A true batch has no scalar
			 * representative, so Nova never fabricates one. */
			caseId?: string;
			/** Flat compatibility alias for a pre-deploy FormScreen. */
			childCaseIds?: ReadonlyArray<string>;
			/** Absent only for a historical flat child-id receipt. */
			createdChildren?: ReadonlyArray<CreatedChildCaseReceipt>;
			caseDatabasePatch?: {
				readonly rows: readonly CaseRow[];
				readonly indices: readonly CaseIndexRow[];
				readonly propertyTypes?: Readonly<
					Record<string, Readonly<Record<string, CasePropertyDataType>>>
				>;
			};
	  }
	| {
			kind: "survey";
			caseDatabasePatch?: {
				readonly rows: readonly CaseRow[];
				readonly indices: readonly CaseIndexRow[];
				readonly propertyTypes?: Readonly<
					Record<string, Readonly<Record<string, CasePropertyDataType>>>
				>;
			};
	  }
	| PreviewPersonaUnavailableResult
	| { kind: "unauthenticated" }
	| {
			kind: "blueprint-changed";
			message: string;
	  }
	| { kind: "case-not-found"; caseId: string }
	| {
			kind: "case-properties-validation";
			caseType: string;
			failures: ReadonlyArray<CasePropertyFailure>;
	  }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	/** The atomic envelope rejected the whole submission — a typed,
	 *  device-parity failure (blank authored key, unreachable target,
	 *  rolling type mismatch, non-portable retype, blank text facet).
	 *  Nothing was written. */
	| { kind: "submission-rejected"; rejection: SubmissionRejection }
	| { kind: "error"; message: string };
