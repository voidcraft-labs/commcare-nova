// lib/case-store/form-bridge/writeThrough.ts
//
// I/O wrapper that applies a form's derived case-store operations
// against a `CaseStore`. The pure derivation lives in
// `./deriveFromForm.ts`; this file calls into it and routes the
// resulting ops through `CaseStore.insert` / `update` / `close`.
// Threads the registration form's generated primary id into child
// cases' `parent_case_id` slot.
//
// `CaseStore` is a parameter — the form-bridge does NOT call
// `withOwnerContext` itself. The caller constructs the bound store
// once per request and passes it down. Tests inject a per-test
// store from the case-store contract harness.
//
// See `lib/case-store/CLAUDE.md` § "Form-bridge — completed-form
// to CaseStore operations" for the per-form-type ordering and
// atomicity contract (registration is atomic via
// `insertWithChildren`; followup / close are not atomic across the
// update + per-child inserts).

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
 * Arguments to `writeFormCompletionThrough`. `caseStore` must be
 * tenant-bound (constructed via `withOwnerContext` on the caller
 * side); the form-bridge relies on the bound store's structural
 * tenant scoping.
 */
export interface WriteFormCompletionArgs {
	readonly caseStore: CaseStore;
	readonly appId: string;
	readonly blueprint: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly formType: FormType;
	readonly moduleCaseType?: string;
	readonly completedForm: CompletedForm;
}

/**
 * Result of one form completion write-through. `kind` mirrors
 * `DerivedFormOps.kind` so consumers can redirect or re-query
 * without re-deriving. `caseId` is the generated id for
 * registration, the bound id for followup / close, absent for
 * survey. `childCaseIds` carries the generated ids of any inserted
 * child cases.
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
 * supplied `CaseStore`.
 *
 * - `registration` → `insertWithChildren` (atomic primary + children)
 * - `followup`     → `update` + per-child `insert`
 * - `close`        → `update` + per-child `insert` + `close`
 * - `survey`       → no operations
 *
 * Returns the form-type discriminator, the primary case id (when
 * relevant), and the generated child case ids — everything the
 * caller needs to navigate after the write.
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
			// Survey forms own no case rows; structural no-op.
			return { kind: "survey" };

		case "registration": {
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
				// Followup's children carry `parentCaseId` from the
				// derivation side (the bound caseId is known
				// pure-time); the fallback is unused for followup.
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
			// Close last so `closed_on` lands after the property
			// update + child inserts. `CaseStore.close` is idempotent
			// on row state — re-closing preserves the original
			// closure timestamp.
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

/**
 * Apply registration writes atomically via `insertWithChildren`.
 * Sets `status: "open"` explicitly on every row — the schema does
 * not default the column and the heuristic generator follows the
 * same convention.
 *
 * `case_name` and "no explicit `parentCaseId` on registration
 * children" are typed throws here. The non-empty guarantee on a
 * defined `caseName` lives upstream at `walkFormFields`'s
 * empty-string short-circuit (the invariants documented on
 * `PrimaryRegistrationOp.caseName` and `ChildInsertOp.caseName`);
 * the guards here check `=== undefined` and trust the contract.
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

	// Children omit `parent_case_id` — the case-store threads the
	// primary's generated id during the atomic write.
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
 * Apply the primary case's property updates for followup / close.
 * Short-circuits when the patch carries NEITHER a `properties`
 * write NOR a `caseName` change — close forms whose only action is
 * the closure, or followup forms whose every leaf field is
 * read-only, carry no scalar writes. Calling `CaseStore.update`
 * with an empty patch would bump `modified_on` and run the JSON
 * Schema validator for no benefit.
 *
 * No empty-`caseName` guard here — `PrimaryUpdateOp.caseName`'s
 * non-empty invariant is structural at the walk site.
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
 * Insert each child case in encounter order. The child's
 * `parent_case_id` comes from the op's explicit `parentCaseId`
 * (followup / close — the bound case id is known at derivation
 * time) or from `fallbackParentCaseId` (registration — the
 * freshly-generated primary id). Returns generated ids in input
 * order so the caller can update navigation if a child becomes
 * the new focus.
 *
 * The `=== undefined` guard mirrors `applyRegistration` and trusts
 * the non-empty `caseName` invariant from the walk.
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
