// lib/domain/xpath/walk.ts
//
// Structural operations over expression reference leaves. These are
// the AST-side replacements for what used to be string rewriting:
// form-local renames/moves need NOTHING here (identity leaves resolve
// at print), and a case-property rename — which remains a real cascade
// because peers co-own the name — is a leaf rename, never a re-parse.

import type { XPathExpression } from "./ast";

/** One case-property rename, in the leaf vocabulary. */
export interface XPathCasePropertyRename {
	caseType: string;
	oldName: string;
	newName: string;
}

/**
 * Rename case-property leaves in place (callers hand in Immer drafts).
 * Two leaf shapes participate:
 *
 *   - `case-ref` leaves self-encode their case type — renamed on an
 *     exact `(caseType, oldName)` match, wherever the carrier lives.
 *   - Transitional contextual `#case/<prop>` raw leaves follow the
 *     owning module's case type. The carrier-level decision ("does
 *     this carrier's module match the renamed type?") belongs to the
 *     caller — the rename cascade already derives it — and arrives as
 *     `contextualMatches`. Only the single-segment shape participates,
 *     matching the long-standing rewriter rule (multi-segment
 *     `#case/parent/...` was never property-rename territory).
 *
 * Returns the number of leaves renamed.
 */
export function renameCasePropertyInXPath(
	expr: XPathExpression,
	rename: XPathCasePropertyRename,
	opts: { contextualMatches: boolean },
): number {
	let changed = 0;
	for (const part of expr.parts) {
		if (
			part.kind === "case-ref" &&
			part.caseType === rename.caseType &&
			part.property === rename.oldName
		) {
			part.property = rename.newName;
			changed++;
			continue;
		}
		if (
			part.kind === "raw-ref" &&
			part.namespace === "case" &&
			opts.contextualMatches &&
			part.segments.length === 1 &&
			part.segments[0] === rename.oldName
		) {
			part.segments[0] = rename.newName;
			changed++;
		}
	}
	return changed;
}
