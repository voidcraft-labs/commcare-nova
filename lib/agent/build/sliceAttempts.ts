/**
 * Slice execution attempts — the mutable execution-control rows behind the
 * executor's one-live-worker rule (§13.3).
 *
 * An attempt's input identities (design/plan digests, slice, base target,
 * brief digest) are immutable; only `status` moves, plus the once-set
 * `change_set_id` binding. The partial unique index permits one `running`
 * attempt per `(design_session_id, build_plan_id, slice_id)`, so a resumed
 * process RECOVERS the existing attempt rather than starting a second
 * overlay merely because a response was lost — and a recovered attempt whose
 * brief no longer matches the accepted artifacts is superseded, never
 * silently adapted.
 */

import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

export type SliceAttemptStatus =
	| "running"
	| "committed"
	| "superseded"
	| "design-issue"
	| "failed";

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
		value === "design-issue" ||
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

/**
 * Begin one attempt, or RECOVER the running one. A running attempt whose
 * design/plan/brief digests still match is the resumed worker's own row; a
 * running attempt derived under superseded artifacts is marked `superseded`
 * and a fresh attempt begins. The one-running partial unique index closes
 * the race between two continuations.
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
			if (sameAttemptInputs(attempt, args)) {
				return { attempt, recovered: true };
			}
			await tx
				.updateTable("design_slice_attempts")
				.set({
					status: "superseded",
					failure_code: "artifact-superseded",
					updated_at: new Date(),
				})
				.where("id", "=", attempt.id)
				.where("status", "=", "running")
				.executeTakeFirstOrThrow();
		}
		const prior = await tx
			.selectFrom("design_slice_attempts")
			.select((eb) => eb.fn.max("attempt").as("max_attempt"))
			.where("design_session_id", "=", args.designSessionId)
			.where("build_plan_id", "=", args.buildPlanId)
			.where("slice_id", "=", args.sliceId)
			.executeTakeFirst();
		const attemptNumber = Number(prior?.max_attempt ?? 0) + 1;
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
		readonly to: Exclude<SliceAttemptStatus, "running">;
		readonly failureCode?: string;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await assertAttemptAuthority(tx, args.designSessionId, args);
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
		if (Number(result.numUpdatedRows) === 1) return;
		const existing = await tx
			.selectFrom("design_slice_attempts")
			.select(["status", "failure_code"])
			.where("id", "=", args.attemptId)
			.where("design_session_id", "=", args.designSessionId)
			.executeTakeFirst();
		if (
			existing?.status === args.to &&
			existing.failure_code === (args.failureCode ?? null)
		) {
			return;
		}
		throw new SliceAttemptStateError(
			"The slice attempt was already terminated by another transition.",
		);
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

/** Persisted across-attempt escalation count for one exact planned slice. */
export async function countDesignIssueAttempts(args: {
	readonly designSessionId: string;
	readonly buildPlanId: string;
	readonly sliceId: string;
}): Promise<number> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_slice_attempts")
		.select((eb) => eb.fn.countAll<string>().as("count"))
		.where("design_session_id", "=", args.designSessionId)
		.where("build_plan_id", "=", args.buildPlanId)
		.where("slice_id", "=", args.sliceId)
		.where("status", "=", "design-issue")
		.executeTakeFirst();
	return Number(row?.count ?? 0);
}
