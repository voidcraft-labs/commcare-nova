// lib/case-store/form-bridge/writeThrough.ts
//
// I/O wrapper that applies a form's derived case-store operations
// against a `CaseStore` instance. The pure derivation lives in
// `./deriveFromForm.ts`; this file accepts a `CaseStore`, a
// `BlueprintDoc`, and a completed-form snapshot, and applies the
// operations the form implies.
//
// ## What this file owns vs what `deriveFromForm` owns
//
//   - `deriveFromForm` (pure): walks the blueprint, reads runtime
//     values, emits a typed `DerivedFormOps` discriminated union.
//     No I/O, no `CaseStore` access.
//   - `writeFormCompletionThrough` (this file): accepts the
//     `CaseStore` instance plus the derivation inputs, calls
//     `deriveFromForm` to produce the ops, and applies them via
//     `CaseStore.insert` / `update` / `close`. Threads the
//     registration form's generated `case_id` to its child cases'
//     `parent_case_id` slot.
//
// ## Why this is the I/O seam
//
// The form-bridge accepts a `CaseStore` as a parameter; it does NOT
// call `withOwnerContext` itself. Plan 7's `caseDataBinding` (the
// running-app view's data-fetching layer) constructs the
// `CaseStore` via `withOwnerContext(session.user.id)` once per
// request and passes the bound store down — same shape the rest of
// the case-store consumers use. Keeping `withOwnerContext` out of
// this file means the form-bridge is testable against any
// `CaseStore` factory the test harness provides (the
// `setupPerTestDatabase` + `PostgresCaseStore` direct-construction
// shape used in the case-store contract harness).
//
// ## Operation ordering
//
// Each form type's order is fixed by the underlying semantic:
//
//   - **Registration**: `insert` the primary case first (so its
//     generated `case_id` is available), then `insert` each child
//     case with `parent_case_id` set to the primary's id.
//   - **Followup**: `update` the primary case (when there are
//     property writes), then `insert` each child case with
//     `parent_case_id` set to the bound `caseId`.
//   - **Close**: same as followup, plus a final `close` against the
//     primary case once updates and child inserts have landed.
//   - **Survey**: no operations — return early with the survey
//     marker.
//
// Operations are NOT atomic across the full form's writes — each
// `CaseStore.insert` opens its own transaction (Postgres rejects
// nested BEGINs), so a mid-loop failure in a multi-child registration
// form leaves the primary case present and the failed-child set
// absent. This matches the pattern Task 5's `generateSampleData`
// already established for batch inserts; the running-app view re-
// queries after the write completes (continuous validation
// principle), so the user sees whatever landed.

import type { BlueprintDoc, FormType, Uuid } from "@/lib/domain";
import type { CaseInsert, CaseStore, CaseUpdate } from "../store";
import {
	type ChildInsertOp,
	type CompletedForm,
	deriveFromForm,
	type PrimaryRegistrationOp,
	type PrimaryUpdateOp,
} from "./deriveFromForm";

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * Arguments to `writeFormCompletionThrough`. The shape mirrors
 * `DeriveFromFormArgs` plus the `CaseStore` and `appId` slots: the
 * derivation runs against the blueprint + completed form, and the
 * derived ops apply against the supplied store under the supplied
 * app id.
 *
 * `caseStore` must be tenant-bound (constructed via
 * `withOwnerContext` on the caller side). The form-bridge does not
 * resolve the owner — it relies on the bound store's structural
 * tenant scoping.
 */
export interface WriteFormCompletionArgs {
	/** The bound `CaseStore` instance (tenant-scoped at construction). */
	readonly caseStore: CaseStore;
	/** The owning app id — every write lands under this app. */
	readonly appId: string;
	/** The prospective blueprint state — case-type definitions live here. */
	readonly blueprint: BlueprintDoc;
	/** The form whose completion is being applied. */
	readonly formUuid: Uuid;
	/** The form type, read off `blueprint.forms[formUuid].type`. */
	readonly formType: FormType;
	/** The owning module's case type — same shape `deriveFromForm` accepts. */
	readonly moduleCaseType?: string;
	/** The runtime snapshot of values the user filled in. */
	readonly completedForm: CompletedForm;
}

/**
 * Result of one form completion write-through.
 *
 * `operation` mirrors the `DerivedFormOps.kind` discriminator so
 * consumers (Plan 7's `caseDataBinding`) can route a redirect or
 * re-query without re-deriving. `caseId` carries the primary case
 * the operations targeted: the generated id for registration, the
 * bound id for followup / close, and absent for survey (no case to
 * route to). `childCaseIds` lists the generated ids of any child
 * cases inserted during the same write.
 */
export type WriteFormCompletionResult =
	| {
			readonly operation: "registration";
			readonly caseId: string;
			readonly childCaseIds: ReadonlyArray<string>;
	  }
	| {
			readonly operation: "followup";
			readonly caseId: string;
			readonly childCaseIds: ReadonlyArray<string>;
	  }
	| {
			readonly operation: "close";
			readonly caseId: string;
			readonly childCaseIds: ReadonlyArray<string>;
	  }
	| { readonly operation: "survey" };

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Apply a completed form's case-store operations through the
 * supplied `CaseStore`. Derives the operations via `deriveFromForm`
 * and routes each through the matching `CaseStore` method per the
 * form type:
 *
 *   - `registration` → `insert` (primary) + `insert` per child
 *   - `followup`     → `update` (when there are property writes) + `insert` per child
 *   - `close`        → `update` (when there are property writes) + `insert` per child + `close`
 *   - `survey`       → no operations
 *
 * Returns the operation discriminator, the primary case id (when
 * relevant), and the generated child case ids. Plan 7's
 * `caseDataBinding` consumes the result to navigate the running-app
 * view to the right destination after the write.
 *
 * Throws when the form type implies a primary case write but the
 * derivation surfaces a missing required input (e.g. a registration
 * form without `moduleCaseType`); the underlying `CaseStore`
 * validation surfaces JSON Schema failures as descriptive throws.
 */
export async function writeFormCompletionThrough(
	args: WriteFormCompletionArgs,
): Promise<WriteFormCompletionResult> {
	const ops = deriveFromForm({
		blueprint: args.blueprint,
		formUuid: args.formUuid,
		formType: args.formType,
		moduleCaseType: args.moduleCaseType,
		completedForm: args.completedForm,
	});

	switch (ops.kind) {
		case "survey":
			// No-op against `cases`. Survey forms collect data for
			// out-of-band analytics; they own no case rows.
			return { operation: "survey" };

		case "registration": {
			const caseId = await applyPrimaryRegistration({
				caseStore: args.caseStore,
				appId: args.appId,
				primary: ops.primary,
			});
			const childCaseIds = await applyChildInserts({
				caseStore: args.caseStore,
				appId: args.appId,
				children: ops.children,
				// Registration's primary id is the parent for any
				// child case the form derives. The pure derivation
				// emits children without `parentCaseId`; we thread
				// the generated id here.
				fallbackParentCaseId: caseId,
			});
			return { operation: "registration", caseId, childCaseIds };
		}

		case "followup": {
			await applyPrimaryUpdate({
				caseStore: args.caseStore,
				appId: args.appId,
				caseId: ops.caseId,
				primary: ops.primary,
			});
			const childCaseIds = await applyChildInserts({
				caseStore: args.caseStore,
				appId: args.appId,
				children: ops.children,
				// Followup's children carry `parentCaseId` set on the
				// derivation side (the bound caseId is known at pure-
				// time); the fallback path is unused for followup.
				fallbackParentCaseId: ops.caseId,
			});
			return {
				operation: "followup",
				caseId: ops.caseId,
				childCaseIds,
			};
		}

		case "close": {
			await applyPrimaryUpdate({
				caseStore: args.caseStore,
				appId: args.appId,
				caseId: ops.caseId,
				primary: ops.primary,
			});
			const childCaseIds = await applyChildInserts({
				caseStore: args.caseStore,
				appId: args.appId,
				children: ops.children,
				fallbackParentCaseId: ops.caseId,
			});
			// Close after any property update + child inserts so the
			// closed-on stamp lands last. The store's `close` method
			// is idempotent under repeated calls (it always sets
			// `closed_on = now()`); ordering matters only for the
			// `modified_on` column, which `update` and `close` both
			// stamp.
			await args.caseStore.close({
				appId: args.appId,
				caseId: ops.caseId,
			});
			return {
				operation: "close",
				caseId: ops.caseId,
				childCaseIds,
			};
		}
	}
}

// ---------------------------------------------------------------
// Internals — per-form-type apply paths
// ---------------------------------------------------------------

/**
 * Insert the primary case for a registration form. Returns the
 * generated `case_id` (Postgres `uuidv7()` default) so the caller
 * can thread it as the parent for any child cases.
 *
 * Sets `status: "open"` explicitly. The schema does not default
 * the status column, and the heuristic generator follows the same
 * convention; setting it here keeps registration writes' shape
 * consistent with sample-data writes for any downstream consumer
 * that filters on `status`.
 */
async function applyPrimaryRegistration(args: {
	caseStore: CaseStore;
	appId: string;
	primary: PrimaryRegistrationOp;
}): Promise<string> {
	const row: CaseInsert = {
		case_type: args.primary.caseType,
		status: "open",
		properties: args.primary.properties,
	};
	const result = await args.caseStore.insert({
		appId: args.appId,
		row,
	});
	return result.caseId;
}

/**
 * Apply the primary case's property updates for a followup or close
 * form. Short-circuits when the derived `properties` patch is empty
 * — close forms whose only action is the closure itself, or
 * followup forms whose every leaf field is read-only / preload-
 * only, carry no property writes. Calling `CaseStore.update` with
 * an empty patch would still bump `modified_on` and run the JSON
 * Schema validator against the merged document for no benefit; the
 * short-circuit avoids the round-trip.
 */
async function applyPrimaryUpdate(args: {
	caseStore: CaseStore;
	appId: string;
	caseId: string;
	primary: PrimaryUpdateOp;
}): Promise<void> {
	if (Object.keys(args.primary.properties).length === 0) {
		return;
	}
	const patch: CaseUpdate = {
		properties: args.primary.properties,
	};
	await args.caseStore.update({
		appId: args.appId,
		caseId: args.caseId,
		patch,
	});
}

/**
 * Insert each derived child case in encounter order. The child's
 * `parent_case_id` resolves from one of two sources:
 *
 *   - When the child op carries an explicit `parentCaseId` (followup
 *     / close, where the bound case id is known at derivation time),
 *     use it directly.
 *   - Otherwise (registration), use the supplied `fallbackParentCaseId`
 *     — the freshly-generated id of the primary case the same write-
 *     through call inserted.
 *
 * Returns the generated child case ids in the same order the
 * children were applied. Caller-side consumers (Plan 7) use the
 * list to update navigation state if a child case becomes the new
 * focus.
 */
async function applyChildInserts(args: {
	caseStore: CaseStore;
	appId: string;
	children: ReadonlyArray<ChildInsertOp>;
	fallbackParentCaseId: string;
}): Promise<ReadonlyArray<string>> {
	const ids: string[] = [];
	for (const child of args.children) {
		const parentCaseId = child.parentCaseId ?? args.fallbackParentCaseId;
		const row: CaseInsert = {
			case_type: child.caseType,
			status: "open",
			parent_case_id: parentCaseId,
			properties: child.properties,
		};
		const result = await args.caseStore.insert({
			appId: args.appId,
			row,
		});
		ids.push(result.caseId);
	}
	return ids;
}
