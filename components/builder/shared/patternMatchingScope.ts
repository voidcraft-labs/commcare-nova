// components/builder/shared/patternMatchingScope.ts
//
// Where a pattern match may be authored, and the sentence every surface
// shows where it may not. A leaf on purpose: `editorSchemas.ts` imports
// every predicate card, and a card imports the verb menu, whose verb table
// is built when its module evaluates. Keeping these two here means the
// table never reads a `const` from a module that is still mid-evaluation
// in that cycle (a production bundle throws "Cannot access before
// initialization" for exactly that; development tooling hides it).

import type { PredicateEditContext } from "./editorSchemas";

/** Whether a pattern match can run in this slot: only where the device's
 *  Pattern engine evaluates the rule. */
export function patternMatchingInScope(ctx: PredicateEditContext): boolean {
	return ctx.patternMatching === true;
}

/** Why a pattern match is withheld everywhere else. Shared by the verb
 *  menu's disabled state and the add-condition menu so both surfaces say
 *  the same thing. */
export const PATTERN_MATCH_UNAVAILABLE_REASON =
	"Only available in a Search field's required condition or check, which run on the device";
