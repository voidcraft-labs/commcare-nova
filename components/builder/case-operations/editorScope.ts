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
