/**
 * The change-set runtime's typed error taxonomy.
 *
 * Two families, split by what a caller may do next:
 *
 *   - **Stage rejections** (`ChangeSetStagingRejectedError`) — the request
 *     was refused BEFORE a step appended: malformed input, an invalid
 *     target/anchor/identity against the private overlay, a policy fence, an
 *     unrecorded required read set. These are the executor's ordinary
 *     `{ error }` results; a protocol-level rejection may persist a small
 *     idempotent rejection receipt but never advances the workspace.
 *     (A validator FINDING is deliberately not a rejection: the private
 *     candidate may carry findings, so the step appends and diagnostics
 *     report them.)
 *
 *   - **Terminal protocol errors** — a stale workspace revision, a request-id
 *     collision, lost scope/ownership, or persisted-state corruption. These
 *     latch the run or demand rehydration; retrying the same call cannot
 *     succeed.
 *
 * Every code here is a stable observability code (the plan's §21.4 safe
 * failure taxonomy); messages are person-to-person and carry no payload
 * content.
 */

/** Why a staging request was refused before any step appended. */
export type ChangeSetStageErrorCode =
	| "WIRE_CANONICALITY_INVALID"
	| "IDENTITY_COLLISION"
	| "SEQUENCE_ANCHOR_INVALID"
	| "TARGET_INVALID"
	| "RENAME_PLAN_INVALID"
	| "REDUCER_FAILURE"
	| "TOOL_INPUT_INVALID"
	| "TOOL_NOT_ALLOWED"
	| "EXCLUSIVE_NOT_ALONE"
	| "EXCLUSIVE_SET_CLOSED"
	| "READ_SET_UNRECORDED"
	| "HANDLE_RESOLUTION_FAILED";

/**
 * A staging request refused before its step appended. `code` is durable on
 * the rejection receipt so an idempotent retry replays the same refusal.
 */
export class ChangeSetStagingRejectedError extends Error {
	readonly name = "ChangeSetStagingRejectedError";
	constructor(
		readonly code: ChangeSetStageErrorCode,
		message: string,
	) {
		super(message);
	}
}

/** The caller presented a workspace revision the durable row has advanced
 *  past — rehydrate and re-derive the request; never silently retry. */
export class ChangeSetWorkspaceRevisionStaleError extends Error {
	readonly name = "ChangeSetWorkspaceRevisionStaleError";
	readonly code = "WORKSPACE_REVISION_STALE" as const;
	constructor(
		readonly expected: number,
		readonly current: number,
	) {
		super(
			`This staging request read workspace revision ${expected}, but the change set is now at revision ${current}. Inspect the change set and re-derive the request from its current state.`,
		);
	}
}

/** A request id was reused with different content — a protocol defect that
 *  latches the run, exactly like a canonical batch-id collision. */
export class ChangeSetRequestIdCollisionError extends Error {
	readonly name = "ChangeSetRequestIdCollisionError";
	readonly code = "WORKSPACE_REQUEST_ID_COLLISION" as const;
	constructor() {
		super("This private tool call reused a request id for different content.");
	}
}

/**
 * The change set is no longer this caller's to use: closed lifecycle
 * (committed/abandoned/superseded when open was required), another owner,
 * a moved Project, or a lost design/plan digest match. Terminal for the run.
 */
export class ChangeSetScopeLostError extends Error {
	readonly name = "ChangeSetScopeLostError";
	readonly code = "CHANGE_SET_SCOPE_LOST" as const;
}

/**
 * Durable change-set state failed its own integrity proof — a base digest
 * that no longer replays, a committed row without its slice receipt, a
 * receipt that fails strict parsing. Never retryable; surfaces to operators.
 */
export class ChangeSetIntegrityError extends Error {
	readonly name = "ChangeSetIntegrityError";
	readonly code = "ARTIFACT_DIGEST_MISMATCH" as const;
}
