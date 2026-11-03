// lib/domain/caseClaim.ts
//
// The search claim's case: what a worker's claim of a searched case is
// stored as. HQ's claim is an open case of its own type owned by the worker,
// with one extension index to the case it claims
// (`corehq/ex-submodules/casexml/apps/case/cleanup.py::claim_case`). A
// client-safe leaf: the case store and Preview read these names.

import type { CaseType } from "./blueprint";

/** HQ's claim case type (`case_search/models.py::CLAIM_CASE_TYPE`), already
 *  reserved for authors (`forms.ts::RESERVED_CASE_OPERATION_TYPES`). */
export const CASE_CLAIM_CASE_TYPE = "commcare-case-claim";

/** The claim's one index (`casexml/apps/case/const.py`, the extension default:
 *  `DEFAULT_CASE_INDEX_IDENTIFIERS[CASE_INDEX_EXTENSION]`). */
export const CASE_CLAIM_HOST_INDEX = "host";

/** Storable, not authorable, as the worker's own case is: no properties. It
 *  stays out of `effectiveCaseTypes` and `materializableCaseTypes`. */
export function caseClaimCaseType(): CaseType {
	return { name: CASE_CLAIM_CASE_TYPE, properties: [] };
}
