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
// call `withOwnerContext` itself. The caller (the running-app
// view's data-fetching layer) constructs the `CaseStore` via
// `withOwnerContext(session.user.id)` once per request and passes
// the bound store down — same shape the rest of the case-store
// consumers use. Keeping `withOwnerContext` out of this file means
// the form-bridge is testable against any `CaseStore` factory the
// test harness provides (the `setupPerTestDatabase` +
// `PostgresCaseStore` direct-construction shape used in the case-
// store contract harness).
//
// ## Operation ordering
//
// Each form type's order is fixed by the underlying semantic:
//
//   - **Registration**: `insertWithChildren` lands the primary +
//     every child in one Postgres transaction, threading the
//     primary's generated id as each child's `parent_case_id`.
//   - **Followup**: `update` the primary case (when there are
//     property writes), then `insert` each child case with
//     `parent_case_id` set to the bound `caseId`.
//   - **Close**: same as followup, plus a final `close` against the
//     primary case once updates and child inserts have landed.
//   - **Survey**: no operations — return early with the survey
//     marker.
//
// Atomicity differs by form type. Registration is atomic — the
// primary + every child write under one transaction, so a
// mid-batch failure rolls the whole submission back. Followup and
// close are NOT atomic across the primary update + child inserts +
// (close-only) the closure stamp; each `update` / `insert` /
// `close` opens its own transaction, so a mid-sequence failure
// leaves the case-store in a partial-write state. The running-app
// view re-queries after the write completes (continuous validation
// principle), so the user sees whatever landed.

import type { BlueprintDoc, FormType, Uuid } from "@/lib/domain";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
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
 * `kind` mirrors the `DerivedFormOps.kind` discriminator so
 * consumers can route a redirect or re-query without re-deriving.
 * The discriminator name aligns with every other case-store
 * discriminated-union surface (`LoadCasesResult`,
 * `LoadCaseDataResult`, `PopulateSampleCasesResult`,
 * `DerivedFormOps`) — one vocabulary for the same shape. `caseId`
 * carries the primary case the operations targeted: the generated
 * id for registration, the bound id for followup / close, and
 * absent for survey (no case to route to). `childCaseIds` lists
 * the generated ids of any child cases inserted during the same
 * write.
 */
export type WriteFormCompletionResult =
	| {
			readonly kind: "registration";
			readonly caseId: string;
			readonly childCaseIds: ReadonlyArray<string>;
	  }
	| {
			readonly kind: "followup";
			readonly caseId: string;
			readonly childCaseIds: ReadonlyArray<string>;
	  }
	| {
			readonly kind: "close";
			readonly caseId: string;
			readonly childCaseIds: ReadonlyArray<string>;
	  }
	| { readonly kind: "survey" };

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Apply a completed form's case-store operations through the
 * supplied `CaseStore`. Derives the operations via `deriveFromForm`
 * and routes each through the matching `CaseStore` method per the
 * form type:
 *
 *   - `registration` → `insertWithChildren` (atomic primary + children)
 *   - `followup`     → `update` (when there are property writes) + `insert` per child
 *   - `close`        → `update` (when there are property writes) + `insert` per child + `close`
 *   - `survey`       → no operations
 *
 * Returns the `kind` discriminator naming the form type, the
 * primary case id (when relevant), and the generated child case
 * ids. The result shape gives the caller everything it needs to
 * navigate the running-app view to the right destination after the
 * write without re-deriving.
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
			return { kind: "survey" };

		case "registration": {
			// Registration writes are atomic: the primary + every
			// child land in one Postgres transaction. The form-bridge
			// passes a `CaseInsert` shape per row through to
			// `insertWithChildren`; the case-store derives every
			// `case_indices` edge as part of the same atomic write.
			const { caseId, childCaseIds } = await applyRegistration({
				caseStore: args.caseStore,
				appId: args.appId,
				primary: ops.primary,
				children: ops.children,
			});
			return { kind: "registration", caseId, childCaseIds };
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
				kind: "followup",
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
			// closed-on stamp lands last. `CaseStore.close` is
			// idempotent on row state — calling close on an already-
			// closed case is a no-op (the WHERE clause excludes rows
			// whose `closed_on` is non-null), so a duplicate close
			// from a retry path or a re-issued submission preserves
			// the original closure timestamp without re-stamping
			// `modified_on`.
			await args.caseStore.close({
				appId: args.appId,
				caseId: ops.caseId,
			});
			return {
				kind: "close",
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
 * Apply a registration form's writes atomically: the primary case
 * + every child case land in one Postgres transaction via
 * `insertWithChildren`. Returns the primary's generated case id +
 * the children's generated case ids in input order. A failure on
 * any row (JSON Schema rejection, engine-side fault) rolls the
 * entire registration back, so a multi-case form's submission is
 * never partially landed.
 *
 * Sets `status: "open"` explicitly on every row. The schema does
 * not default the status column, and the heuristic generator
 * follows the same convention; setting it here keeps registration
 * writes' shape consistent with sample-data writes for any
 * downstream consumer that filters on `status`.
 *
 * `case_name` is required at the column layer (`cases.case_name`
 * carries a `length > 0` CHECK constraint). The form-bridge
 * surfaces the missing-name invariant with a typed throw so the
 * diagnostic points at the form-shape author wiring rather than a
 * downstream Postgres CHECK violation. The non-empty guarantee on
 * a defined `caseName` lives upstream at `walkFormFields`'s
 * empty-string short-circuit (per `PrimaryRegistrationOp.caseName`
 * / `ChildInsertOp.caseName`'s invariant); the guards here check
 * `=== undefined` and trust the non-empty contract.
 *
 * Children must NOT carry an explicit `parentCaseId`. The pure
 * derivation emits registration children without one (the bound
 * id isn't known until the primary inserts);
 * `insertWithChildren` threads the primary's generated id into
 * every child's `parent_case_id` slot, and a child carrying its
 * own would be ambiguous. The check below pins that contract.
 */
async function applyRegistration(args: {
	caseStore: CaseStore;
	appId: string;
	primary: PrimaryRegistrationOp;
	children: ReadonlyArray<ChildInsertOp>;
}): Promise<{ caseId: string; childCaseIds: ReadonlyArray<string> }> {
	if (args.primary.caseName === undefined) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.writeFormCompletionThrough.applyRegistration",
				invariant: `registration form for case type \`${args.primary.caseType}\` produced no \`case_name\` value`,
				detail:
					"Every registration form must declare a leaf field with `id: \"case_name\"` whose value lands the case's display name in `cases.case_name`. Reaching this throw means the blueprint authoring surface admitted a registration form without one. Hint: confirm the form's field tree includes a `case_name` leaf bound to `case_property_on: <module case type>`; the SA prompt and the blueprint validator both treat the field as required for registration forms.",
			}),
		);
	}

	// Project each child op into a `CaseInsert`. The non-empty
	// `caseName` invariant (`!== undefined`) matches the per-row
	// `applyChildInserts` shape. Every child omits
	// `parent_case_id` — the case-store will thread the primary's
	// id during the atomic write.
	const childRows: CaseInsert[] = args.children.map((child) => {
		if (child.caseName === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.writeFormCompletionThrough.applyRegistration",
					invariant: `child-case op for case type \`${child.caseType}\` produced no \`case_name\` value`,
					detail:
						'Every case row carries a top-level `case_name`. A form that creates a child case must include a leaf field with `id: "case_name"` bound to the destination case type via `case_property_on`. Reaching this throw means the form\'s field tree omits the name field for that child type. Hint: add a `case_name` leaf for every child case type the form constructs, the same way the primary case requires one.',
				}),
			);
		}
		if (child.parentCaseId !== undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.writeFormCompletionThrough.applyRegistration",
					invariant: `registration child for case type \`${child.caseType}\` carried an explicit \`parentCaseId\``,
					detail:
						"Registration form derivation emits children without `parentCaseId` because the bound parent id (the primary case's generated id) isn't known until the primary inserts. `insertWithChildren` threads that id into every child's `parent_case_id` slot at the case-store layer. Reaching this throw means the derivation supplied a `parentCaseId` for a registration child, which would conflict with the implicit threading.\n\nHint: `deriveFromForm`'s registration arm emits children with `parentCaseId: undefined`; if a derived shape changed, restore the omission and let the case-store thread the primary's id.",
				}),
			);
		}
		return {
			case_type: child.caseType,
			case_name: child.caseName,
			status: "open",
			properties: child.properties,
		};
	});

	const result = await args.caseStore.insertWithChildren({
		appId: args.appId,
		primary: {
			case_type: args.primary.caseType,
			case_name: args.primary.caseName,
			status: "open",
			properties: args.primary.properties,
		},
		children: childRows,
	});
	return {
		caseId: result.primaryCaseId,
		childCaseIds: result.childCaseIds,
	};
}

/**
 * Apply the primary case's property updates for a followup or close
 * form. Short-circuits when the derived patch carries NEITHER a
 * `properties` write NOR a `caseName` change — close forms whose
 * only action is the closure itself, or followup forms whose every
 * leaf field is read-only / preload-only, carry no scalar writes.
 * Calling `CaseStore.update` with an empty patch would still bump
 * `modified_on` and run the JSON Schema validator against the
 * merged document for no benefit; the short-circuit avoids the
 * round-trip.
 *
 * No empty-`caseName` guard runs here: per
 * `PrimaryUpdateOp.caseName`'s invariant, a defined `caseName` is
 * non-empty by structural construction at the derivation layer
 * (the `walkFormFields` empty-string short-circuit). The patch
 * passes the value straight through to `CaseStore.update`.
 */
async function applyPrimaryUpdate(args: {
	caseStore: CaseStore;
	appId: string;
	caseId: string;
	primary: PrimaryUpdateOp;
}): Promise<void> {
	const hasPropertyWrites = Object.keys(args.primary.properties).length > 0;
	const hasCaseNameWrite = args.primary.caseName !== undefined;
	if (!hasPropertyWrites && !hasCaseNameWrite) {
		return;
	}
	const patch: CaseUpdate = {
		...(hasPropertyWrites ? { properties: args.primary.properties } : {}),
		...(hasCaseNameWrite ? { case_name: args.primary.caseName } : {}),
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
 * children were applied — the caller can update navigation state
 * if a child case becomes the new focus.
 *
 * Each child carries a non-empty `caseName` for the same reason
 * the primary case does (the column is `text NOT NULL` with a
 * `length > 0` CHECK); the form-bridge surfaces the missing-name
 * invariant with a typed throw so the diagnostic points at the
 * form-shape author wiring. The non-empty guarantee on a defined
 * `caseName` lives upstream at `walkFormFields` (per
 * `ChildInsertOp.caseName`'s invariant); the guard here only
 * checks `=== undefined` and trusts the non-empty contract.
 */
async function applyChildInserts(args: {
	caseStore: CaseStore;
	appId: string;
	children: ReadonlyArray<ChildInsertOp>;
	fallbackParentCaseId: string;
}): Promise<ReadonlyArray<string>> {
	const ids: string[] = [];
	for (const child of args.children) {
		if (child.caseName === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.writeFormCompletionThrough.applyChildInserts",
					invariant: `child-case op for case type \`${child.caseType}\` produced no \`case_name\` value`,
					detail:
						'Every case row carries a top-level `case_name`. A form that creates a child case must include a leaf field with `id: "case_name"` bound to the destination case type via `case_property_on`. Reaching this throw means the form\'s field tree omits the name field for that child type. Hint: add a `case_name` leaf for every child case type the form constructs, the same way the primary case requires one.',
				}),
			);
		}
		const parentCaseId = child.parentCaseId ?? args.fallbackParentCaseId;
		const row: CaseInsert = {
			case_type: child.caseType,
			case_name: child.caseName,
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
