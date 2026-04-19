// lib/domain/caseTypes.ts
//
// Shared utilities for reasoning about CaseType records. Lives in
// lib/domain/ because the rules are part of the domain contract
// (which case types a module can write to), not UI policy.

import type { CaseType } from "./blueprint";

/**
 * Returns the case type names a module can write to: its own primary
 * case type plus any child types that declare the module's type as
 * their `parent_type`. Used by both the inspect panel's case-property
 * dropdown and any other UI that needs to reason about writable
 * destinations for a question.
 *
 * A module with no configured `caseType` has nothing to write to —
 * the result is always an empty array in that case.
 */
export function getModuleCaseTypes(
	caseType: string | undefined,
	caseTypes: CaseType[],
): string[] {
	if (!caseType) return [];
	const result = [caseType];
	for (const ct of caseTypes) {
		if (ct.parent_type === caseType) result.push(ct.name);
	}
	return result;
}
