/**
 * Slice execution attempts — the mutable execution-control rows behind the
 * executor's one-live-worker rule (§13.3).
 *
 * An attempt's input identities (design/plan digests, slice, base target,
 * brief digest) are immutable; only `status` moves, plus the once-set
 * `change_set_id` binding. The partial unique index permits one `running`
 * attempt per `(design_session_id, build_plan_id, slice_id)`, so a resumed
 * process RECOVERS the existing attempt rather than starting a second
 * overlay merely because a response was lost. A terminal attempt never
 * reopens under a later user turn; deterministic exhaustion is a planning or
 * compiler defect, not a dice roll for the user to repeat.
 */

import {
	assertDesignSessionRunAuthorityInTransaction,
	setDesignSessionActiveArtifactsInTransaction,
} from "@/lib/db/designSessions";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { updatedExactlyOne } from "@/lib/db/runHolderWrites";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

export type SliceAttemptStatus =
	| "running"
	| "committed"
	| "superseded"
	| "failed";

export class TerminalSliceAttemptError extends Error {
	readonly name = "TerminalSliceAttemptError";
}

export type SliceAttemptBaseTarget =
	| {
			readonly kind: "empty-genesis";
			readonly proposedAppId: string;
			readonly digest: string;
	  }
	| {
			readonly kind: "app";
			readonly appId: string;
			readonly seq: number;
			readonly digest: string;
	  };

export interface SliceAttempt {
	readonly id: string;
	readonly designSessionId: string;
	readonly designRevisionId: string;
	readonly designRevisionDigest: string;
	readonly buildPlanId: string;
	readonly buildPlanDigest: string;
	readonly sliceId: string;
	readonly attempt: number;
	readonly baseTarget: SliceAttemptBaseTarget;
	readonly changeSetId: string | null;
	readonly executorModel: string;
	readonly promptVersion: string;
	readonly briefDigest: string;
	readonly status: SliceAttemptStatus;
	readonly failureCode: string | null;
}

interface AttemptRow {
	id: string;
	design_session_id: string;
	design_revision_id: string;
	design_revision_digest: string;
	build_plan_id: string;
	build_plan_digest: string;
	slice_id: string;
	attempt: number;
	base_kind: string;
	base_app_id: string | null;
	base_proposed_app_id: string | null;
	base_seq: string | number | null;
	base_snapshot_digest: string;
	change_set_id: string | null;
	executor_model: string;
	prompt_version: string;
	brief_digest: string;
	status: string;
	failure_code: string | null;
}

function parseStatus(value: string): SliceAttemptStatus {
	if (
		value === "running" ||
		value === "committed" ||
		value === "superseded" ||
		value === "failed"
	) {
		return value;
	}
	throw new Error(`Persisted slice-attempt status "${value}" is invalid.`);
}

function rowToAttempt(row: AttemptRow): SliceAttempt {
	const baseTarget: SliceAttemptBaseTarget =
		row.base_kind === "empty-genesis"
			? {
					kind: "empty-genesis",
					proposedAppId: row.base_proposed_app_id ?? "",
					digest: row.base_snapshot_digest,
				}
			: {
					kind: "app",
					appId: row.base_app_id ?? "",
					seq: safePersistedSequence(
						row.base_seq ?? 0,
						`design_slice_attempts.base_seq for attempt ${row.id}`,
					),
					digest: row.base_snapshot_digest,
				};
	if (
		(baseTarget.kind === "empty-genesis" && baseTarget.proposedAppId === "") ||
		(baseTarget.kind === "app" && baseTarget.appId === "")
	) {
		throw new Error(
			`Persisted slice attempt ${row.id} carries an incomplete ${row.base_kind} base target.`,
		);
	}
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		designRevisionId: row.design_revision_id,
		designRevisionDigest: row.design_revision_digest,
		buildPlanId: row.build_plan_id,
		buildPlanDigest: row.build_plan_digest,
		sliceId: row.slice_id,
		attempt: row.attempt,
		baseTarget,
		changeSetId: row.change_set_id,
		executorModel: row.executor_model,
		promptVersion: row.prompt_version,
		briefDigest: row.brief_digest,
		status: parseStatus(row.status),
		failureCode: row.failure_code,
	};
}

const ATTEMPT_COLUMNS = [
	"id",
	"design_session_id",
	"design_revision_id",
	"design_revision_digest",
	"build_plan_id",
	"build_plan_digest",
	"slice_id",
	"attempt",
	"base_kind",
	"base_app_id",
	"base_proposed_app_id",
	"base_seq",
	"base_snapshot_digest",
	"change_set_id",
	"executor_model",
	"prompt_version",
	"brief_digest",
	"status",
	"failure_code",
] as const;

export interface CreateSliceAttemptArgs {
	readonly designSessionId: string;
	readonly designRevisionId: string;
	readonly designRevisionDigest: string;
	readonly buildPlanId: string;
	readonly buildPlanDigest: string;
	readonly sliceId: string;
	readonly baseTarget: SliceAttemptBaseTarget;
	readonly executorModel: string;
	readonly promptVersion: string;
	readonly briefDigest: string;
}

/** Exact delegated design-run capability required by every mutable attempt
 * transition. The session/app authority carrier is locked and reauthorized
 * in the same transaction as the attempt write. */
export interface SliceAttemptAuthority {
	readonly actorUserId: string;
	readonly runId: string;
	readonly holderNonce: string;
	readonly expectedProjectId: string;
}

export class SliceAttemptStateError extends Error {
	readonly name = "SliceAttemptStateError";
}

function sameBaseTarget(
	left: SliceAttemptBaseTarget,
	right: SliceAttemptBaseTarget,
): boolean {
	if (left.kind !== right.kind) return false;
	return left.kind === "empty-genesis" && right.kind === "empty-genesis"
		? left.proposedAppId === right.proposedAppId && left.digest === right.digest
		: left.kind === "app" && right.kind === "app"
			? left.appId === right.appId &&
				left.seq === right.seq &&
				left.digest === right.digest
			: false;
}

function sameAttemptInputs(
	attempt: SliceAttempt,
	args: CreateSliceAttemptArgs,
): boolean {
	return (
		attempt.designRevisionId === args.designRevisionId &&
		attempt.designRevisionDigest === args.designRevisionDigest &&
		attempt.buildPlanId === args.buildPlanId &&
		attempt.buildPlanDigest === args.buildPlanDigest &&
		attempt.sliceId === args.sliceId &&
		sameBaseTarget(attempt.baseTarget, args.baseTarget) &&
		attempt.executorModel === args.executorModel &&
		attempt.promptVersion === args.promptVersion &&
		attempt.briefDigest === args.briefDigest
	);
}

async function assertAttemptAuthority(
	tx: Parameters<Parameters<typeof withAppTx>[0]>[0],
	designSessionId: string,
	authority: SliceAttemptAuthority,
): Promise<void> {
	await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId,
		actorUserId: authority.actorUserId,
		expectedProjectId: authority.expectedProjectId,
		holder: {
			mode: "build",
			runId: authority.runId,
			nonce: authority.holderNonce,
		},
	});
}

interface BoundChangeSetRow {
	id: string;
	attempt_id: string;
	design_session_id: string;
	owner_user_id: string;
	owner_run_id: string;
	status: string;
}

async function lockBoundChangeSet(
	tx: Parameters<Parameters<typeof withAppTx>[0]>[0],
	attempt: SliceAttempt,
): Promise<BoundChangeSetRow | null> {
	if (attempt.changeSetId === null) return null;
	const row = await tx
		.selectFrom("design_change_sets")
		.select([
			"id",
			"attempt_id",
			"design_session_id",
			"owner_user_id",
			"owner_run_id",
			"status",
		])
		.where("id", "=", attempt.changeSetId)
		.forUpdate()
		.executeTakeFirst();
	if (row === undefined) {
		throw new SliceAttemptStateError(
			`Slice attempt ${attempt.id} is bound to a missing change set.`,
		);
	}
	if (
		row.attempt_id !== attempt.id ||
		row.design_session_id !== attempt.designSessionId
	) {
		throw new SliceAttemptStateError(
			`Slice attempt ${attempt.id} is bound to a change set from different lineage.`,
		);
	}
	return row;
}

async function supersedeRunningAttempt(
	tx: Parameters<Parameters<typeof withAppTx>[0]>[0],
	attempt: SliceAttempt,
	failureCode: string,
	lockedBound?: BoundChangeSetRow | null,
): Promise<void> {
	const bound =
		lockedBound === undefined
			? await lockBoundChangeSet(tx, attempt)
			: lockedBound;
	if (bound?.status === "committed") {
		throw new SliceAttemptStateError(
			`Slice attempt ${attempt.id} is still running after its change set committed.`,
		);
	}
	if (bound?.status === "open") {
		const changeSetUpdate = await tx
			.updateTable("design_change_sets")
			.set({ status: "superseded", updated_at: new Date() })
			.where("id", "=", bound.id)
			.where("attempt_id", "=", attempt.id)
			.where("status", "=", "open")
			.executeTakeFirst();
		if (!updatedExactlyOne(changeSetUpdate)) {
			throw new SliceAttemptStateError(
				`Slice attempt ${attempt.id}'s change set changed during supersession.`,
			);
		}
	} else if (
		bound !== null &&
		bound.status !== "superseded" &&
		bound.status !== "abandoned"
	) {
		throw new SliceAttemptStateError(
			`Slice attempt ${attempt.id} has unknown change-set status "${bound.status}".`,
		);
	}
	const attemptUpdate = await tx
		.updateTable("design_slice_attempts")
		.set({
			status: "superseded",
			failure_code: failureCode,
			updated_at: new Date(),
		})
		.where("id", "=", attempt.id)
		.where("design_session_id", "=", attempt.designSessionId)
		.where("status", "=", "running")
		.executeTakeFirst();
	if (!updatedExactlyOne(attemptUpdate)) {
		throw new SliceAttemptStateError(
			`Slice attempt ${attempt.id} changed during supersession.`,
		);
	}
}

/**
 * Begin one attempt, or RECOVER the running one. Matching immutable inputs
 * are not enough once a change set is bound: its actor/run owner must also
 * match the current delegated holder. Holder or artifact drift supersedes
 * the running attempt and its open set before a fresh attempt begins. The
 * one-running partial unique index closes the race between continuations.
 */
export async function beginOrRecoverSliceAttempt(
	args: CreateSliceAttemptArgs & SliceAttemptAuthority,
): Promise<{ attempt: SliceAttempt; recovered: boolean }> {
	return await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const running = await tx
			.selectFrom("design_slice_attempts")
			.select([...ATTEMPT_COLUMNS])
			.where("design_session_id", "=", args.designSessionId)
			.where("build_plan_id", "=", args.buildPlanId)
			.where("slice_id", "=", args.sliceId)
			.where("status", "=", "running")
			.forUpdate()
			.executeTakeFirst();
		if (running !== undefined) {
			const attempt = rowToAttempt(running as AttemptRow);
			const bound = await lockBoundChangeSet(tx, attempt);
			if (
				sameAttemptInputs(attempt, args) &&
				(bound === null ||
					(bound.status === "open" &&
						bound.owner_user_id === args.actorUserId &&
						bound.owner_run_id === args.runId))
			) {
				return { attempt, recovered: true };
			}
			await supersedeRunningAttempt(
				tx,
				attempt,
				sameAttemptInputs(attempt, args)
					? "holder-superseded"
					: "artifact-superseded",
				bound,
			);
		}

		const latest = await tx
			.selectFrom("design_slice_attempts")
			.select([
				"attempt",
				"status",
				"failure_code",
				"executor_model",
				"prompt_version",
				"brief_digest",
			])
			.where("design_session_id", "=", args.designSessionId)
			.where("build_plan_id", "=", args.buildPlanId)
			.where("slice_id", "=", args.sliceId)
			.orderBy("attempt", "desc")
			.executeTakeFirst();
		const compilerInputsChanged =
			latest !== undefined &&
			(latest.executor_model !== args.executorModel ||
				latest.prompt_version !== args.promptVersion ||
				latest.brief_digest !== args.briefDigest);
		if (
			latest?.status === "committed" ||
			(latest?.status === "failed" && !compilerInputsChanged)
		) {
			throw new TerminalSliceAttemptError(
				`Slice ${args.sliceId} already ended as ${latest.status}; unchanged compiler inputs cannot rerun it.`,
			);
		}
		const attemptNumber = Number(latest?.attempt ?? 0) + 1;
		const id = crypto.randomUUID();
		const created = await tx
			.insertInto("design_slice_attempts")
			.values({
				id,
				design_session_id: args.designSessionId,
				design_revision_id: args.designRevisionId,
				design_revision_digest: args.designRevisionDigest,
				build_plan_id: args.buildPlanId,
				build_plan_digest: args.buildPlanDigest,
				slice_id: args.sliceId,
				attempt: attemptNumber,
				base_kind: args.baseTarget.kind,
				base_app_id:
					args.baseTarget.kind === "app" ? args.baseTarget.appId : null,
				base_proposed_app_id:
					args.baseTarget.kind === "empty-genesis"
						? args.baseTarget.proposedAppId
						: null,
				base_seq: args.baseTarget.kind === "app" ? args.baseTarget.seq : null,
				base_snapshot_digest: args.baseTarget.digest,
				change_set_id: null,
				executor_model: args.executorModel,
				prompt_version: args.promptVersion,
				brief_digest: args.briefDigest,
				status: "running",
				failure_code: null,
			})
			.returning([...ATTEMPT_COLUMNS])
			.executeTakeFirstOrThrow();
		return { attempt: rowToAttempt(created as AttemptRow), recovered: false };
	});
}

/**
 * End a running attempt and its bound private change set together. The
 * current delegated holder, not the change set's historical owner columns,
 * authorizes this control transition. Exact replay is idempotent.
 */
export async function supersedeSliceAttempt(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
		readonly failureCode: string;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const row = await tx
			.selectFrom("design_slice_attempts")
			.select([...ATTEMPT_COLUMNS])
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) {
			throw new SliceAttemptStateError(
				`Slice attempt ${args.attemptId} no longer exists.`,
			);
		}
		const attempt = rowToAttempt(row as AttemptRow);
		if (
			attempt.status === "superseded" &&
			attempt.failureCode === args.failureCode
		) {
			return;
		}
		if (attempt.status !== "running") {
			throw new SliceAttemptStateError(
				`Slice attempt ${args.attemptId} was already terminated by another transition.`,
			);
		}
		await supersedeRunningAttempt(tx, attempt, args.failureCode);
	});
}

/** Install one accepted replacement plan and supersede the running root
 * attempt in the same authority-locked transaction. The replacement artifact
 * itself is immutable and may already exist; neither the active pointer nor
 * the old execution control can advance alone. */
export async function activateReplacementPlan(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
		readonly failureCode: string;
		readonly activeDesignRevisionId: string;
		readonly activeBuildPlanId: string;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const row = await tx
			.selectFrom("design_slice_attempts")
			.select([...ATTEMPT_COLUMNS])
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) {
			throw new SliceAttemptStateError(
				`Slice attempt ${args.attemptId} no longer exists.`,
			);
		}
		const attempt = rowToAttempt(row as AttemptRow);
		if (
			attempt.status === "superseded" &&
			attempt.failureCode === args.failureCode
		) {
			const active = await tx
				.selectFrom("design_sessions")
				.select(["active_design_revision_id", "active_build_plan_id"])
				.where("id", "=", args.designSessionId)
				.executeTakeFirstOrThrow();
			if (
				active.active_design_revision_id === args.activeDesignRevisionId &&
				active.active_build_plan_id === args.activeBuildPlanId
			) {
				return;
			}
			throw new SliceAttemptStateError(
				"The replacement-plan transition was already consumed by another active artifact selection.",
			);
		}
		if (attempt.status !== "running") {
			throw new SliceAttemptStateError(
				`Slice attempt ${args.attemptId} was already terminated by another transition.`,
			);
		}
		await setDesignSessionActiveArtifactsInTransaction(tx, {
			designSessionId: args.designSessionId,
			actorUserId: args.actorUserId,
			runId: args.runId,
			holderNonce: args.holderNonce,
			expectedProjectId: args.expectedProjectId,
			activeDesignRevisionId: args.activeDesignRevisionId,
			activeBuildPlanId: args.activeBuildPlanId,
		});
		await supersedeRunningAttempt(tx, attempt, args.failureCode);
	});
}

/** Bind the attempt's change set — set exactly once, right after the set
 *  opens (or reopens) under this attempt. */
export async function bindSliceAttemptChangeSet(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
		readonly changeSetId: string;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const result = await tx
			.updateTable("design_slice_attempts")
			.set({ change_set_id: args.changeSetId, updated_at: new Date() })
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "=", "running")
			.where((eb) =>
				eb.or([
					eb("change_set_id", "is", null),
					eb("change_set_id", "=", args.changeSetId),
				]),
			)
			.executeTakeFirst();
		if (Number(result.numUpdatedRows) !== 1) {
			throw new SliceAttemptStateError(
				"The slice attempt is no longer running or is bound to another change set.",
			);
		}
	});
}

/** Move a RUNNING attempt to a terminal status. An exact terminal replay is
 * idempotent; a different prior terminal transition is a state error. The
 * canonical sidecar marks `committed` inside its own guarded transaction. */
export async function markSliceAttempt(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
		readonly to: "failed";
		readonly failureCode?: string;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const row = await tx
			.selectFrom("design_slice_attempts")
			.select([...ATTEMPT_COLUMNS])
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) {
			throw new SliceAttemptStateError(
				`Slice attempt ${args.attemptId} no longer exists.`,
			);
		}
		const attempt = rowToAttempt(row as AttemptRow);
		if (
			attempt.status === args.to &&
			attempt.failureCode === (args.failureCode ?? null)
		) {
			return;
		}
		if (attempt.status !== "running") {
			throw new SliceAttemptStateError(
				"The slice attempt was already terminated by another transition.",
			);
		}
		const bound = await lockBoundChangeSet(tx, attempt);
		if (bound?.status === "open") {
			const closed = await tx
				.updateTable("design_change_sets")
				.set({ status: "abandoned", updated_at: new Date() })
				.where("id", "=", bound.id)
				.where("attempt_id", "=", attempt.id)
				.where("status", "=", "open")
				.executeTakeFirst();
			if (!updatedExactlyOne(closed)) {
				throw new SliceAttemptStateError(
					`Slice attempt ${attempt.id}'s change set changed during failure.`,
				);
			}
		} else if (bound?.status === "committed") {
			throw new SliceAttemptStateError(
				`Slice attempt ${attempt.id} cannot fail after its change set committed.`,
			);
		}
		const result = await tx
			.updateTable("design_slice_attempts")
			.set({
				status: args.to,
				failure_code: args.failureCode ?? null,
				updated_at: new Date(),
			})
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "=", "running")
			.executeTakeFirst();
		if (!updatedExactlyOne(result)) {
			throw new SliceAttemptStateError(
				"The slice attempt changed during its failure transition.",
			);
		}
	});
}

/** The session's currently running attempt, if any — crash-resume's entry. */
export async function loadRunningSliceAttempt(
	designSessionId: string,
): Promise<SliceAttempt | null> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_slice_attempts")
		.select([...ATTEMPT_COLUMNS])
		.where("design_session_id", "=", designSessionId)
		.where("status", "=", "running")
		.executeTakeFirst();
	return row === undefined ? null : rowToAttempt(row as AttemptRow);
}
