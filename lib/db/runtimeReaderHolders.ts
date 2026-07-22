import type { RunHolderIdentity, RunLease } from "./runLiveness";

export type { RunHolderIdentity } from "./runLiveness";

export type RuntimeHolderLifecycle =
	| "live"
	| "paused"
	| "reapable-stale-build"
	| "reapable-stranded-edit"
	| "corrupt-present";

export type RuntimeHolderState =
	| { readonly kind: "absent" }
	| {
			readonly kind: "present";
			readonly identity: RunHolderIdentity;
			/** Valid persisted stamp, or null for null/malformed legacy state. */
			readonly storedVersion: number | null;
			/** Floor comparisons use zero for corrupt identity or stamp state. */
			readonly effectiveVersion: number;
			readonly lifecycle: RuntimeHolderLifecycle;
	  };

function validRuntimeReaderVersion(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= 2_147_483_647
		? value
		: null;
}

/** Exact equality used by holder diagnostics and expected-identity writers. */
export function sameRunHolderIdentity(
	left: RunHolderIdentity | null,
	right: RunHolderIdentity | null,
): boolean {
	if (left === null || right === null) return left === right;
	return left.mode === right.mode && left.runId === right.runId;
}

/**
 * Turn the authoritative liveness view plus database-owned stamp into the
 * fail-closed runtime census model. Reapable states deliberately win before
 * paused/live: a stale paused holder is still a canonical reaper target.
 */
export function runtimeHolderState(
	lease: RunLease,
	storedVersionInput: unknown,
): RuntimeHolderState {
	const identity = lease.holderIdentity;
	if (identity === null) return { kind: "absent" };

	const storedVersion = validRuntimeReaderVersion(storedVersionInput);
	const effectiveVersion =
		identity.runId === null || storedVersion === null ? 0 : storedVersion;
	const lifecycle: RuntimeHolderLifecycle = lease.reapableStaleBuild
		? "reapable-stale-build"
		: lease.reapableStrandedEdit
			? "reapable-stranded-edit"
			: identity.runId === null
				? "corrupt-present"
				: lease.paused
					? "paused"
					: lease.live
						? "live"
						: "corrupt-present";

	return {
		kind: "present",
		identity,
		storedVersion,
		effectiveVersion,
		lifecycle,
	};
}

/** Every present effective version below the target blocks a floor raise. */
export function runtimeHolderBlocksTarget(
	state: RuntimeHolderState,
	targetVersion: number,
): boolean {
	return state.kind === "present" && state.effectiveVersion < targetVersion;
}
