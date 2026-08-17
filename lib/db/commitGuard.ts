// The guarded-commit conflict primitives — the concurrent-delete guard and its
// rejection error.
//
// Extracted from `applyBlueprintChange.ts` (which imports `apps.ts`) so
// `apps.ts::commitGuardedBatch` can import them without forming an
// `apps.ts`↔`applyBlueprintChange.ts` cycle. Depends only on the doc/mutation
// vocabulary — nothing from `apps.ts`.

import { deepEqual } from "@/lib/doc/deepEqual";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
} from "@/lib/doc/mutationAdmission";

export { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";

/**
 * Thrown by the guarded commit when, against the freshly read blueprint, a
 * mutation targets a concurrently-removed entity ({@link mutationTargetsInvalid})
 * or the re-run validity verdict rejects the batch. Carries the
 * person-to-person findings as its message. The MCP/chat tool's catch returns
 * it in the standard `{ error }` envelope; the auto-save PUT maps it to a 409
 * the builder recovers from by reloading.
 */
export class BlueprintCommitRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlueprintCommitRejectedError";
	}
}

export class MutationBatchIdCollisionError extends Error {
	constructor() {
		super("This save reused a batch id for different content.");
		this.name = "MutationBatchIdCollisionError";
	}
}

export interface AppChangeFingerprint {
	readonly mutations: unknown;
	readonly actorUserId: string;
	readonly kind: string;
	readonly runId: string | null;
}

export function appChangeFingerprintMatches(
	stored: AppChangeFingerprint,
	proposed: {
		readonly mutations: AdmittedMutationBatch;
		readonly actorUserId: string;
		readonly kind: string;
		readonly runId?: string;
	},
): boolean {
	const storedMutations = admitMutationBatch(stored.mutations);
	return (
		deepEqual(storedMutations, proposed.mutations) &&
		stored.actorUserId === proposed.actorUserId &&
		stored.kind === proposed.kind &&
		stored.runId === (proposed.runId ?? null)
	);
}

/**
 * The chat run lost its exact app-holder capability before a guarded write or
 * terminal transition committed. This is terminal for that run: reloading and
 * retrying the same tool would spend more tokens under an authority that can
 * never land, and any cleanup must leave the replacement holder untouched.
 */
export class RunHolderLostError extends Error {
	constructor(readonly outcome: "superseded" | "released" = "superseded") {
		super(
			outcome === "superseded"
				? "A newer request took over this app. Refresh to get the latest state, then try again."
				: "This chat run was released. Refresh to get the latest state, then try again.",
		);
		this.name = "RunHolderLostError";
	}
}

/**
 * The app changed Project after the caller captured its authoritative scope.
 * This is retryable for request/auto-save clients after an authoritative reload,
 * but terminal for an already-running SA turn: continuing would charge work
 * whose every write is guaranteed to reject against the stale tenant scope.
 */
export class AppProjectChangedError extends Error {
	constructor() {
		super(
			"This app moved to a different Project while you were editing. Reload to get the latest state.",
		);
		this.name = "AppProjectChangedError";
	}
}

/**
 * Thrown by the guarded commit when the actor is no longer authorized to write
 * the app AT ALL — not a member of its current Project (`role === null`) or a
 * member whose role lacks `edit`.
 *
 * TERMINAL, unlike {@link BlueprintCommitRejectedError}: a conflict is
 * retryable (reload + rebuild + re-commit lands on the fresh state), but a
 * reload can't make the actor authorized — retrying re-denies. So the auto-save
 * PUT maps this to a 403 (not a 409-reload, which would re-PUT into the same
 * denial), and the chat SA's `wrapMutating` lets it PROPAGATE (fail the run)
 * rather than catching it to reload-and-continue. A concurrent Project move is
 * the separate {@link AppProjectChangedError}: a request client can reload its
 * authoritative scope, while an already-running SA turn must stop. Defined here
 * (not imported from `appAccess.ts`) to keep the
 * `apps.ts`↔`appAccess.ts` cycle broken.
 */
export class CommitReauthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommitReauthError";
	}
}

/**
 * A Project-move GOVERNANCE denial — the move transaction's in-lock membership
 * re-check refused (source role, destination role, or owner retention), each
 * arm carrying its own person-readable message.
 *
 * A subclass rather than a sibling so every existing `CommitReauthError`
 * consumer (the browser move action's `not_permitted` mapping, the auto-save
 * 403) keeps working unchanged, while surfaces that can say something better
 * than "App not found." (the MCP `move_app` tool) can catch this narrower
 * class and surface the message as an explicit permission denial.
 */
export class ProjectMoveDeniedError extends CommitReauthError {
	constructor(message: string) {
		super(message);
		this.name = "ProjectMoveDeniedError";
	}
}
