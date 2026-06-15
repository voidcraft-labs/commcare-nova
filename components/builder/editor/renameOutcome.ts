/**
 * renameOutcome — pure classification of a field-rename attempt.
 *
 * `FieldIdentitySection`'s id input flows through `useCommitField`, which calls
 * a validate callback before saving. The header's callback runs the
 * shared identifier verdict (`lib/doc/identifierVerdicts.ts` — the same
 * rules the SA tools enforce) and hands it here, then picks the right
 * UI response:
 *
 *   - empty id → noop, nothing dispatched.
 *   - verdict rejected (XML-illegal name, reserved `__nova_` prefix,
 *     over-long case-property name, sibling-id conflict) → render the
 *     error popover with the verdict's message and shake the input;
 *     nothing dispatched.
 *   - verdict ok → dispatch the rename and let `useCommitField` fire
 *     its checkmark.
 */

import type { FieldIdVerdict } from "@/lib/doc/identifierVerdicts";

/** Discriminated outcome shape returned to the header. */
export type RenameOutcome =
	| { kind: "noop" }
	| { kind: "rejected"; message: string }
	| { kind: "success" };

interface ClassifyArgs {
	/** The id the user typed and wants to commit. */
	newId: string;
	/** The shared identifier verdict for renaming the field to `newId`. */
	verdict: FieldIdVerdict;
}

/**
 * Decide what should happen given a freshly-attempted rename.
 *
 * Trim+empty + same-as-current cases are filtered upstream by
 * `useCommitField` (the commit hook short-circuits empty/no-op
 * commits), but the noop branch hardens against a stray empty value so
 * it never surfaces a confusing rejection popover.
 */
export function classifyRenameOutcome(args: ClassifyArgs): RenameOutcome {
	if (!args.newId) return { kind: "noop" };
	if (!args.verdict.ok) {
		// The verdict's CONCISE `userMessage` (not the SA-facing verbose
		// `message`) — this is the builder surface. It embeds the offending
		// id verbatim so the user sees exactly which value was rejected,
		// important when the input wrapper is small enough that the live
		// value isn't also visible while the popover is open.
		return { kind: "rejected", message: args.verdict.userMessage };
	}
	return { kind: "success" };
}
