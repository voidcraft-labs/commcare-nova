// components/builder/case-operations/editorScope.ts
//
// The two scope decisions every expression / predicate slot inside a
// case operation mounts with. Both exist because the commit gate is
// narrower than the editor's default, and an editor that offers what the
// gate refuses is the whole valid-by-construction contract broken.
//
// They live here, not inline in the canvas, because the canvas and the
// link rows must agree and the invariant test drives them directly.

import type { CaseDataScope } from "@/components/builder/shared/editorSchemas";
import type { OperationValueScope } from "@/components/builder/shared/expressionEditorSchemas";
import {
	type SlotConstraint,
	storageAssignmentConstraint,
} from "@/lib/domain/predicate";

/**
 * What an operation slot may read against a case row.
 *
 * `rules/caseOperations.ts::validateCaseSnapshotUse` refuses a case
 * property, a relationship count, and a presence test in ANY operation
 * slot unless the module selects a case before opening its forms — and
 * that refusal is spelled with exactly the walks `expressionReadsCaseData`
 * performs, which is the `"global"` scope's own admission oracle. So a
 * module holding a registration form (not case-first) gets `"global"`:
 * fixed values, session / worker information, and this submission's own
 * form answers, which is precisely the accept-set.
 *
 * `"selected-case"` is deliberately NOT the middle answer here. It admits
 * the chosen case's own properties, and the gate admits none.
 */
export function operationCaseDataScope(caseFirst: boolean): CaseDataScope {
	return caseFirst ? "per-case" : "global";
}

/**
 * The constraint the three TEXT FACET slots mount with — an operation's
 * case name, its rename, and its explicit owner.
 *
 * `nonEmpty` is the load-bearing part. `rules/caseOperations.ts::validateTextExpression`
 * refuses a blank literal in each of these ("has a blank rename"),
 * because CommCare needs a real value: a case cannot be created
 * nameless and a blank owner is not the same statement as no owner.
 * Without the flag the value picker's "A value" choice seeds
 * `literal("")` and the gate refuses it the instant it is picked.
 *
 */
export function caseOperationTextConstraint(): SlotConstraint {
	return { ...storageAssignmentConstraint(["text"]), nonEmpty: true };
}

/**
 * A runtime case target is also required authored text. The incomplete empty
 * literal used to open its editor remains local UI state; it cannot enter the
 * document, because neither Nova nor CommCare can act on a blank case id.
 */
export function caseOperationRuntimeTargetConstraint(): SlotConstraint {
	return { ...storageAssignmentConstraint(["text"]), nonEmpty: true };
}

/**
 * The operation scope a RUNTIME TARGET slot mounts with — the
 * operation's own "which case to change" expression and a link's
 * "work out the id of the case at the other end".
 *
 * Empty `creates` is the load-bearing part: `caseOperations.ts`
 * refuses an `id-of` anywhere inside a runtime target tree
 * (`CASE_OPERATION_TARGET_INVALID` — an already-known create should be
 * targeted directly so type, order, and repeat correlation stay
 * explicit), and link targets route through the same check. An empty
 * create list is what makes `id-of` unauthorable while leaving the two
 * owner sentinels (`acting-user`, `unowned`) — which the gate does
 * admit there — exactly as available as they were.
 */
export const RUNTIME_TARGET_OPERATION_SCOPE: OperationValueScope = {
	creates: [],
};
