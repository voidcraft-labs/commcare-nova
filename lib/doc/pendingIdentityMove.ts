/**
 * A builder edit that moves a held identity waits for the person before it
 * commits: the dispatch (or the undo, the redo, or a conflict's replay) plans
 * its moves, the gate admits the planned batch, and the batch is set aside
 * here until the identity-move dialog makes it or cancels it. The session
 * store holds it (`lib/session/store.ts`, never persisted); the doc package
 * reaches it through a `PendingIdentityMoveSlot`, so the commands and the
 * history step stay pure of React and of the session store's shape.
 */

import type { IdentityMove } from "@/lib/doc/identityMoves";
import type { Mutation } from "@/lib/doc/types";

/** Where the waiting batch came from: an edit, a history step, or the replay
 *  of an edit a publish overtook. */
export type IdentityMoveOrigin = "edit" | "undo" | "redo" | "conflict";

export interface PendingIdentityMove {
	/** The planned batch the gate admitted, with the holds its moves need. */
	readonly batch: readonly Mutation[];
	/** Every identity the batch moves, as the dialog states them. */
	readonly moves: readonly IdentityMove[];
	readonly origin: IdentityMoveOrigin;
}

/** Read and write access to the one waiting batch. */
export interface PendingIdentityMoveSlot {
	readonly read: () => PendingIdentityMove | null;
	readonly set: (pending: PendingIdentityMove) => void;
	readonly clear: () => void;
}
