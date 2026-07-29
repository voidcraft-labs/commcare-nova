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
 * Rename exact case-property leaves in place (callers hand in Immer drafts).
 *
 * Returns the number of leaves renamed.
 */
export function renameCasePropertyInXPath(
	expr: XPathExpression,
	rename: XPathCasePropertyRename,
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
		}
	}
	return changed;
}
