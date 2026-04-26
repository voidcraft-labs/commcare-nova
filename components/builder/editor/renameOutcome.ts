/**
 * renameOutcome — pure classification of a field-rename attempt.
 *
 * `FieldHeader`'s id input flows through `useCommitField`, which calls
 * a validate callback before saving. The header's callback dispatches
 * the rename mutation and then picks the right UI response:
 *
 *   - empty id → noop.
 *   - reducer reported a sibling-id conflict → render the error popover
 *     with a context-rich message and shake the input.
 *   - reducer accepted → clear any stale notice and let `useCommitField`
 *     fire its checkmark.
 */

/** Discriminated outcome shape returned to the header. */
export type RenameOutcome =
	| { kind: "noop" }
	| { kind: "conflict"; message: string }
	| { kind: "success" };

interface ClassifyArgs {
	/** The id the user typed and wants to commit. */
	newId: string;
	/** True when the doc-store rename mutation reported a sibling-id collision. */
	hasConflict: boolean;
}

/**
 * Decide what should happen given a freshly-attempted rename.
 *
 * Trim+empty + same-as-current cases are filtered upstream by
 * `useCommitField` (the commit hook short-circuits empty/no-op
 * commits), so this classifier handles only the post-validate paths.
 */
export function classifyRenameOutcome(args: ClassifyArgs): RenameOutcome {
	if (!args.newId) return { kind: "noop" };
	if (args.hasConflict) {
		return {
			kind: "conflict",
			// The message embeds the conflicting id verbatim so the user
			// sees exactly which value collided — important when the
			// input wrapper is small enough that the live value isn't
			// also visible while the popover is open.
			message: `A sibling field already has the ID "${args.newId}"`,
		};
	}
	return { kind: "success" };
}
