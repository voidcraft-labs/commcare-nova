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

/** Resolve a name-keyed case property to its simultaneous destination. */
export type CasePropertyNameResolver = (
	caseType: string,
	property: string,
) => string | undefined;

/**
 * Apply a complete case-property name relation in one structural pass.
 *
 * The resolver always receives the leaf's batch-start value. This is what
 * makes chains and swaps simultaneous: a rewritten destination is never fed
 * back through the relation during the same pass.
 */
export function mapCasePropertiesInXPath(
	expr: XPathExpression,
	resolve: CasePropertyNameResolver,
): number {
	let changed = 0;
	for (const part of expr.parts) {
		if (part.kind !== "case-ref") continue;
		const destination = resolve(part.caseType, part.property);
		if (destination === undefined || destination === part.property) continue;
		part.property = destination;
		changed++;
	}
	return changed;
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
	return mapCasePropertiesInXPath(expr, (caseType, property) =>
		caseType === rename.caseType && property === rename.oldName
			? rename.newName
			: undefined,
	);
}
