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
	CasePropertyFailure,
	CaseRow,
	JsonObject,
} from "@/lib/case-store";

// `CaseRow` re-exported as a barrel surface so consumers have one
// import path for the binding's types.
export type { CaseRow };

/** Result of loading every case row for a case type. */
export type LoadCasesResult =
	| { kind: "rows"; rows: ReadonlyArray<CaseRow> }
	| { kind: "empty" }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of loading a single case by id (the case-loading form
 * path for followup / close). `missing` covers absent-id AND
 * cross-tenant — equivalent under the case-store contract.
 */
export type LoadCaseDataResult =
	| { kind: "row"; row: CaseRow }
	| { kind: "missing" }
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
 *   `children` are additional cases bucketed by `case_property_on`.
 *   Children carry NO `parentCaseId`; the case-store threads the
 *   primary's generated id at write time via `insertWithChildren`.
 * - `followup` — `caseId` is the bound case the form updates;
 *   `patch.properties` is the JSONB delta. Children carry
 *   `parentCaseId` set to the bound caseId at derivation time.
 * - `close` — same shape as `followup`, plus a closure stamp on
 *   the bound case after the updates land.
 * - `survey` — structural no-op; the form owns no case rows.
 *
 * `case_name` is a regular property keyed inside `properties` — it
 * routes to the `cases.case_name` column at the case-store boundary
 * but the mutation shape does not separate it from the JSONB document.
 */
export type SubmissionMutation =
	| {
			kind: "registration";
			primary: { caseType: string; properties: JsonObject };
			children: ReadonlyArray<{ caseType: string; properties: JsonObject }>;
	  }
	| {
			kind: "followup";
			caseId: string;
			patch: { properties: JsonObject };
			children: ReadonlyArray<{
				caseType: string;
				properties: JsonObject;
				parentCaseId: string;
			}>;
	  }
	| {
			kind: "close";
			caseId: string;
			patch: { properties: JsonObject };
			children: ReadonlyArray<{
				caseType: string;
				properties: JsonObject;
				parentCaseId: string;
			}>;
	  }
	| { kind: "survey" };

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
			childCaseIds: ReadonlyArray<string>;
	  }
	| { kind: "followup"; caseId: string; childCaseIds: ReadonlyArray<string> }
	| { kind: "close"; caseId: string; childCaseIds: ReadonlyArray<string> }
	| { kind: "survey" }
	| { kind: "unauthenticated" }
	| { kind: "case-not-found"; caseId: string }
	| {
			kind: "case-properties-validation";
			caseType: string;
			failures: ReadonlyArray<CasePropertyFailure>;
	  }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	| { kind: "error"; message: string };
