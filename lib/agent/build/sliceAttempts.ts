/**
 * Slice execution attempts — the mutable execution-control rows behind the
 * executor's one-live-worker rule (§13.3).
 *
 * An attempt's input identities (design/plan digests, slice, base target,
 * brief digest) are immutable; only `status` moves, plus the once-set
 * `change_set_id` binding. The partial unique index permits one `running`
 * attempt per `(design_session_id, build_plan_id, slice_id)`, so a resumed
 * process RECOVERS the existing attempt rather than starting a second
 * overlay merely because a response was lost. The current exact session
 * holder transactionally adopts an open change set left by prior
 * infrastructure, so a process/run replacement resumes the same attempt.
 * A terminal attempt never
 * reopens under a later user turn; deterministic exhaustion is a planning or
 * compiler defect, not a dice roll for the user to repeat.
 */

import { sql } from "kysely";
import type {
	SliceAttemptBudgetClaimResult,
	SliceAttemptBudgetCounter,
	SliceAttemptBudgetSpent,
} from "@/lib/agent/build/budgets";
import type { ExecutorToolOutcomeKind } from "@/lib/agent/build/executorLoop";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
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
	/** Original attempt start; recovery derives the same absolute deadline. */
	readonly startedAt: Date;
	readonly budgetSpent: SliceAttemptBudgetSpent;
	readonly finalizationCheckpoint: {
		readonly validationRequested: boolean;
		readonly eligible: boolean;
	};
	/** Append-only provenance for every run holder that recovered or executed
	 * this attempt. Registered before any model work, so missing summaries fail
	 * the release-cost gate closed. */
	readonly executionRunIds: readonly string[];
	readonly diagnostics: {
		readonly wireInvalid: number;
		readonly stageRejected: number;
		readonly validatorRepair: number;
		readonly outcomeEvidenceState: SliceAttemptOutcomeEvidenceState;
	};
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
	model_steps_used: number;
	staged_requests_used: number;
	commit_attempts_used: number;
	blocker_reports_used: number;
	validation_requested: boolean;
	finalization_eligible: boolean;
	execution_run_ids: string[];
	wire_invalid_count: number;
	stage_rejected_count: number;
	validator_repair_count: number;
	outcome_evidence_state: string;
	created_at: Date | string;
	status: string;
	failure_code: string | null;
}

export type SliceAttemptOutcomeEvidenceState =
	| "legacy-missing"
	| "unstarted"
	| "collecting"
	| "complete"
	| "incomplete";

function parseOutcomeEvidenceState(
	value: string,
	attemptId: string,
): SliceAttemptOutcomeEvidenceState {
	if (
		value === "legacy-missing" ||
		value === "unstarted" ||
		value === "collecting" ||
		value === "complete" ||
		value === "incomplete"
	) {
		return value;
	}
	throw new Error(
		`Persisted slice attempt ${attemptId} has invalid outcome evidence state ${value}.`,
	);
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

function parseExecutionRunIds(value: unknown, attemptId: string): string[] {
	if (
		!Array.isArray(value) ||
		value.some((runId) => typeof runId !== "string" || runId.length === 0) ||
		new Set(value).size !== value.length
	) {
		throw new Error(
			`Persisted slice attempt ${attemptId} has invalid execution-run provenance.`,
		);
	}
	return [...value];
}

function rowToAttempt(row: AttemptRow): SliceAttempt {
	const startedAt =
		row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
	if (Number.isNaN(startedAt.getTime())) {
		throw new Error(
			`Persisted slice attempt ${row.id} has an invalid start time.`,
		);
	}
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
		startedAt,
		budgetSpent: {
			modelSteps: row.model_steps_used,
			stagedRequests: row.staged_requests_used,
			commitAttempts: row.commit_attempts_used,
			blockerReports: row.blocker_reports_used,
		},
		finalizationCheckpoint: {
			validationRequested: row.validation_requested,
			eligible: row.finalization_eligible,
		},
		executionRunIds: parseExecutionRunIds(row.execution_run_ids, row.id),
		diagnostics: {
			wireInvalid: row.wire_invalid_count,
			stageRejected: row.stage_rejected_count,
			validatorRepair: row.validator_repair_count,
			outcomeEvidenceState: parseOutcomeEvidenceState(
				row.outcome_evidence_state,
				row.id,
			),
		},
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
	"model_steps_used",
	"staged_requests_used",
	"commit_attempts_used",
	"blocker_reports_used",
	"validation_requested",
	"finalization_eligible",
	"execution_run_ids",
	"wire_invalid_count",
	"stage_rejected_count",
	"validator_repair_count",
	"outcome_evidence_state",
	"created_at",
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

async function adoptOpenChangeSetOwner(
	tx: Parameters<Parameters<typeof withAppTx>[0]>[0],
	attempt: SliceAttempt,
	bound: BoundChangeSetRow,
	authority: SliceAttemptAuthority,
): Promise<void> {
	if (
		bound.owner_user_id === authority.actorUserId &&
		bound.owner_run_id === authority.runId
	) {
		return;
	}
	const adopted = await tx
		.updateTable("design_change_sets")
		.set({
			owner_user_id: authority.actorUserId,
			owner_run_id: authority.runId,
			updated_at: new Date(),
		})
		.where("id", "=", bound.id)
		.where("attempt_id", "=", attempt.id)
		.where("status", "=", "open")
		.where("owner_user_id", "=", bound.owner_user_id)
		.where("owner_run_id", "=", bound.owner_run_id)
		.executeTakeFirst();
	if (!updatedExactlyOne(adopted)) {
		throw new SliceAttemptStateError(
			`Slice attempt ${attempt.id}'s open change set changed during infrastructure recovery.`,
		);
	}
}

async function recordAttemptExecutionRun(
	tx: Parameters<Parameters<typeof withAppTx>[0]>[0],
	attempt: SliceAttempt,
	runId: string,
): Promise<SliceAttempt> {
	if (attempt.executionRunIds.includes(runId)) return attempt;
	const executionRunIds = [...attempt.executionRunIds, runId];
	const updated = await tx
		.updateTable("design_slice_attempts")
		.set({
			execution_run_ids: JSON.stringify(executionRunIds),
			updated_at: new Date(),
		})
		.where("id", "=", attempt.id)
		.where("design_session_id", "=", attempt.designSessionId)
		.where("status", "=", "running")
		.executeTakeFirst();
	if (!updatedExactlyOne(updated)) {
		throw new SliceAttemptStateError(
			`Slice attempt ${attempt.id} changed while recording its execution run.`,
		);
	}
	return { ...attempt, executionRunIds };
}

/**
 * Begin one attempt, or RECOVER the running one. Exact immutable inputs keep
 * the attempt and its private overlay; when infrastructure replaced the run,
 * the current authorized session holder adopts that open set in this same
 * transaction. Artifact drift supersedes the running attempt and its open
 * set before a fresh attempt begins. The one-running partial unique index
 * closes the race between continuations.
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
			let attempt = rowToAttempt(running as AttemptRow);
			const bound = await lockBoundChangeSet(tx, attempt);
			if (sameAttemptInputs(attempt, args) && bound === null) {
				attempt = await recordAttemptExecutionRun(tx, attempt, args.runId);
				return { attempt, recovered: true };
			}
			if (sameAttemptInputs(attempt, args) && bound?.status === "open") {
				await adoptOpenChangeSetOwner(tx, attempt, bound, args);
				attempt = await recordAttemptExecutionRun(tx, attempt, args.runId);
				return { attempt, recovered: true };
			}
			await supersedeRunningAttempt(tx, attempt, "artifact-superseded", bound);
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
				model_steps_used: 0,
				staged_requests_used: 0,
				commit_attempts_used: 0,
				blocker_reports_used: 0,
				validation_requested: false,
				finalization_eligible: false,
				execution_run_ids: JSON.stringify([args.runId]),
				wire_invalid_count: 0,
				stage_rejected_count: 0,
				validator_repair_count: 0,
				outcome_evidence_state: "unstarted",
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

/** Count semantic rebase retries already spent by this exact slice lineage.
 * Superseded attempts are durable execution history, so a replacement process
 * resumes the same retry budget instead of resetting it in memory. */
export async function countSliceRebaseAttempts(args: {
	readonly designSessionId: string;
	readonly buildPlanId: string;
	readonly sliceId: string;
}): Promise<number> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("design_slice_attempts")
		.select("id")
		.where("design_session_id", "=", args.designSessionId)
		.where("build_plan_id", "=", args.buildPlanId)
		.where("slice_id", "=", args.sliceId)
		.where("status", "=", "superseded")
		.where("failure_code", "in", ["rebase-conflict", "read-set-stale"])
		.execute();
	return rows.length;
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

const BUDGET_COUNTER_COLUMNS: Readonly<
	Record<SliceAttemptBudgetCounter, string>
> = {
	modelSteps: "model_steps_used",
	stagedRequests: "staged_requests_used",
	commitAttempts: "commit_attempts_used",
	blockerReports: "blocker_reports_used",
};

/** Claim one unit before starting the corresponding external or canonical
 * operation. `claimKey` names the exact model call or batch operation, so a
 * recovered process can replay that work without consuming a second unit.
 * The attempt row lock, counter advance, and append-only claim row are one
 * transaction. */
export async function claimSliceAttemptBudget(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
		readonly counter: SliceAttemptBudgetCounter;
		readonly limit: number;
		readonly claimKey: string;
	},
): Promise<SliceAttemptBudgetClaimResult> {
	if (!Number.isSafeInteger(args.limit) || args.limit < 0) {
		throw new Error(
			"A slice-attempt budget limit must be a nonnegative integer.",
		);
	}
	if (args.claimKey.trim().length === 0) {
		throw new Error("A slice-attempt budget claim requires a stable key.");
	}
	return await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const column = BUDGET_COUNTER_COLUMNS[args.counter];
		const locked = await sql<{ status: string; used: number }>`
			SELECT status, ${sql.ref(column)} AS used
			FROM design_slice_attempts
			WHERE id = ${args.attemptId}
				AND design_session_id = ${args.designSessionId}
			FOR UPDATE
		`.execute(tx);
		const current = locked.rows[0];
		if (current === undefined || current.status !== "running") {
			throw new SliceAttemptStateError(
				"The slice attempt is no longer running, so it cannot spend more budget.",
			);
		}
		const existing = await tx
			.selectFrom("design_slice_attempt_budget_claims")
			.select("counter")
			.where("attempt_id", "=", args.attemptId)
			.where("claim_key", "=", args.claimKey)
			.executeTakeFirst();
		if (existing !== undefined) {
			if (existing.counter !== args.counter) {
				throw new SliceAttemptStateError(
					`Budget claim ${args.claimKey} was already bound to ${existing.counter}, not ${args.counter}.`,
				);
			}
			return "replayed";
		}
		if (!Number.isSafeInteger(current.used) || current.used < 0) {
			throw new SliceAttemptStateError(
				`The slice attempt carries an invalid ${args.counter} budget count.`,
			);
		}
		if (current.used >= args.limit) return "exhausted";
		const updated = await tx
			.updateTable("design_slice_attempts")
			.set({
				[column]: sql`${sql.ref(column)} + 1`,
				...(args.counter === "modelSteps"
					? { finalization_eligible: false }
					: {}),
				updated_at: new Date(),
			})
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "=", "running")
			.executeTakeFirst();
		if (!updatedExactlyOne(updated)) {
			throw new SliceAttemptStateError(
				"The slice attempt is no longer running, so it cannot spend more budget.",
			);
		}
		await tx
			.insertInto("design_slice_attempt_budget_claims")
			.values({
				attempt_id: args.attemptId,
				claim_key: args.claimKey,
				counter: args.counter,
			})
			.execute();
		return "claimed";
	});
}

/** Persist the executor's only step-boundary commit authority. Recovery may
 * consume this checkpoint without another model call, but still re-runs the
 * complete private diagnostics and canonical commit gate. */
export async function checkpointSliceAttemptFinalization(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
		readonly validationRequested: boolean;
		readonly eligible: boolean;
	},
): Promise<void> {
	if (args.eligible && !args.validationRequested) {
		throw new Error("Finalization eligibility requires a validation request.");
	}
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const updated = await tx
			.updateTable("design_slice_attempts")
			.set({
				validation_requested: args.validationRequested,
				finalization_eligible: args.eligible,
				updated_at: new Date(),
			})
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "=", "running")
			.executeTakeFirst();
		if (!updatedExactlyOne(updated)) {
			throw new SliceAttemptStateError(
				"The slice attempt is no longer running, so its finalization checkpoint cannot advance.",
			);
		}
	});
}

type AuthoritativeDiagnosticOutcome = Extract<
	ExecutorToolOutcomeKind,
	"wire-invalid" | "stage-rejected" | "validator-repair"
>;

/** Start one process's evidence window. A prior unclosed window means a process
 * died after it could have observed an outcome, so the attempt latches
 * `incomplete` permanently instead of ever claiming zero from absence. */
export async function beginSliceAttemptOutcomeCollection(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const updated = await tx
			.updateTable("design_slice_attempts")
			.set({
				outcome_evidence_state: sql<string>`CASE outcome_evidence_state
					WHEN 'unstarted' THEN 'collecting'
					WHEN 'complete' THEN 'collecting'
					WHEN 'collecting' THEN 'incomplete'
					ELSE outcome_evidence_state
				END`,
				updated_at: new Date(),
			})
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "=", "running")
			.executeTakeFirst();
		if (!updatedExactlyOne(updated)) {
			throw new SliceAttemptStateError(
				"The slice attempt is no longer running, so it cannot start outcome collection.",
			);
		}
	});
}

/** Persist a release-gate diagnostic before the executor can answer the model
 * or advance. Operational events may mirror it, but only this row is authority. */
export async function recordSliceAttemptDiagnostic(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
		readonly outcome: AuthoritativeDiagnosticOutcome;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const increment =
			args.outcome === "wire-invalid"
				? { wire_invalid_count: sql<number>`wire_invalid_count + 1` }
				: args.outcome === "stage-rejected"
					? { stage_rejected_count: sql<number>`stage_rejected_count + 1` }
					: { validator_repair_count: sql<number>`validator_repair_count + 1` };
		const updated = await tx
			.updateTable("design_slice_attempts")
			.set({ ...increment, updated_at: new Date() })
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "=", "running")
			.where("outcome_evidence_state", "in", ["collecting", "incomplete"])
			.executeTakeFirst();
		if (!updatedExactlyOne(updated)) {
			throw new SliceAttemptStateError(
				"The slice attempt could not durably record its executor outcome.",
			);
		}
	});
}

/** Seal a process's evidence window after the executor returns or throws in a
 * controlled process. An already-incomplete attempt never becomes complete. */
export async function finishSliceAttemptOutcomeCollection(
	args: SliceAttemptAuthority & {
		readonly designSessionId: string;
		readonly attemptId: string;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
		const updated = await tx
			.updateTable("design_slice_attempts")
			.set({
				outcome_evidence_state: sql<string>`CASE
					WHEN outcome_evidence_state = 'collecting' THEN 'complete'
					ELSE outcome_evidence_state
				END`,
				updated_at: new Date(),
			})
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "in", ["running", "committed"])
			.executeTakeFirst();
		if (!updatedExactlyOne(updated)) {
			throw new SliceAttemptStateError(
				"The slice attempt could not seal its executor outcome evidence.",
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
