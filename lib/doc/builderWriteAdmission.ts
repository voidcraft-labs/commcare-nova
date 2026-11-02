import type { LookupCommitState } from "./lookupCommitContext";

/** The refusal of a write while a change waits in the identity-move dialog. */
export const IDENTITY_MOVE_PENDING_MESSAGE =
	"A change is waiting in the open dialog. You can make it or cancel it, then go on.";

/** The outcome of {@link builderWriteAdmission}: admitted, or refused with the
 *  builder's concise person-to-person lines, ready for the error toast or an
 *  inline `CommitOutcome`. */
export type BuilderWriteAdmission =
	| { readonly ok: true }
	| { readonly ok: false; readonly messages: string[] };

/**
 * The admission every builder write runs BEFORE its commit verdict — the one
 * place the two conditions that make a verdict pointless are decided, so a
 * dispatch, a Connect-mode switch, and an undo or redo refuse in the same
 * voice for the same reasons.
 *
 * - View-only access: no user edit reaches the store. The visible affordances
 *   are already hidden for a viewer; this is the airtight backstop for any
 *   that aren't, so a stray dispatch explains itself instead of mutating a doc
 *   that can never persist.
 * - Lookup catalog `loading` / `error`: the Project's lookup-definition context
 *   is not the live one yet. The commit gate is absolute, so running the
 *   verdict now would refuse any doc that carries a lookup reference with the
 *   validator's "wait for lookup data to reconnect" finding; naming the real
 *   state is more honest than that, and an app without a lookup reference must
 *   not commit blind either — its edit may be the one that introduces the
 *   first reference.
 *
 * - A change waiting in the identity-move dialog
 *   (`pendingIdentityMove.ts`): a second batch would be planned over a
 *   document the first has not changed yet, so it waits until the person
 *   makes the first change or cancels it. The dialog's own commit
 *   (`commitStated`) does not pass `identityMovePending`.
 *
 * `unmanaged` (no catalog provider mounted) and `ready` both admit; the verdict
 * that follows runs under `lookupCommitState.lookupContext`. Pure of React so
 * it is exercised as a state model.
 */
export function builderWriteAdmission(args: {
	readonly canEdit: boolean;
	readonly lookupCommitState: LookupCommitState;
	readonly identityMovePending?: boolean;
}): BuilderWriteAdmission {
	if (!args.canEdit) {
		return {
			ok: false,
			messages: [
				"You have view-only access to this app. Ask a Project admin for edit access to make changes.",
			],
		};
	}
	if (args.identityMovePending === true) {
		return { ok: false, messages: [IDENTITY_MOVE_PENDING_MESSAGE] };
	}
	switch (args.lookupCommitState.kind) {
		case "loading":
			return {
				ok: false,
				messages: [
					"Project data is still loading. Wait for it to finish before editing this app.",
				],
			};
		case "error":
			return {
				ok: false,
				messages: [
					"Nova could not load this Project's data-table definitions. Try again before editing this app.",
				],
			};
		case "unmanaged":
		case "ready":
			return { ok: true };
	}
}
