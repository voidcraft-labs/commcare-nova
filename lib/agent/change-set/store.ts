// Durable private mutations. Lock order: app/session, plan, workspace, request ledger.
import { type Kysely, sql, type Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { ChatRunHolderCapability } from "@/lib/db/apps";
import { loadAppInTransaction } from "@/lib/db/apps";
import { lockPlanForBuild } from "@/lib/db/authoringPlanGuard";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import {
	parsePersistedJsonText,
	parsePersistedMutationBatchText,
	safePersistedSequence,
} from "@/lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { updatedExactlyOne } from "@/lib/db/runHolderWrites";
import type {
	AdmittedMutationBatch,
	AdmittedMutationStageSlice,
} from "@/lib/doc/mutationAdmission";
import { encodeAdmittedMutationEnvelope } from "@/lib/doc/mutationAdmission";
import { canonicalJsonDigest } from "./digest";
import {
	ChangeSetIntegrityError,
	ChangeSetRequestIdCollisionError,
	ChangeSetScopeLostError,
	type ChangeSetStageErrorCode,
	ChangeSetWorkspaceRevisionStaleError,
} from "./errors";
import {
	type ChangeSetDiagnosticsSummary,
	type MutationReplayResult,
	SHA256_HEX_PATTERN,
	type StageRequestReceipt,
	stageRequestReceiptSchema,
} from "./schemas";
import type {
	ChangeSetExclusiveKind,
	ChangeSetKind,
	ChangeSetLineage,
	ChangeSetStatus,
	ChangeSetStep,
	ChangeSetStepStage,
	DesignChangeSet,
	StoredStageRequest,
} from "./types";

// ── Row parsing ────────────────────────────────────────────────────

const CHANGE_SET_COLUMNS = [
	"id",
	"design_session_id",
	"plan_revision",
	"kind",
	"app_id",
	"proposed_app_id",
	"base_seq",
	"base_project_id",
	"base_snapshot_digest",
	"revision",
	"next_ordinal",
	"exclusive_kind",
	"owner_user_id",
	"owner_run_id",
	"status",
	"committed_seq",
	"committed_batch_id",
	"committed_snapshot_digest",
	"created_at",
	"updated_at",
] as const;

type ChangeSetRow = {
	[K in (typeof CHANGE_SET_COLUMNS)[number]]: K extends
		| "base_seq"
		| "committed_seq"
		? string | number | null
		: K extends "revision" | "next_ordinal" | "plan_revision"
			? string | number
			: K extends "created_at" | "updated_at"
				? Date
				: string | null;
};

const CHANGE_SET_KINDS = new Set<ChangeSetKind>(["genesis", "app-edit"]);
const CHANGE_SET_STATUSES = new Set<ChangeSetStatus>([
	"open",
	"committed",
	"abandoned",
	"superseded",
]);
const EXCLUSIVE_KINDS = new Set<ChangeSetExclusiveKind>([
	"renameCaseProperties",
	"retireCaseType",
]);

function requireText(value: string | null, context: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ChangeSetIntegrityError(`${context} is missing or blank.`);
	}
	return value;
}

function requireDigest(value: string | null, context: string): string {
	const text = requireText(value, context);
	if (!SHA256_HEX_PATTERN.test(text)) {
		throw new ChangeSetIntegrityError(`${context} is not a sha-256 digest.`);
	}
	return text;
}

function parseChangeSetRow(row: ChangeSetRow): DesignChangeSet {
	const kind = requireText(row.kind, "authoring_workspaces.kind");
	if (!CHANGE_SET_KINDS.has(kind as ChangeSetKind)) {
		throw new ChangeSetIntegrityError(
			`authoring_workspaces.kind holds unknown value "${kind}".`,
		);
	}
	const status = requireText(row.status, "authoring_workspaces.status");
	if (!CHANGE_SET_STATUSES.has(status as ChangeSetStatus)) {
		throw new ChangeSetIntegrityError(
			`authoring_workspaces.status holds unknown value "${status}".`,
		);
	}
	if (
		row.exclusive_kind !== null &&
		!EXCLUSIVE_KINDS.has(row.exclusive_kind as ChangeSetExclusiveKind)
	) {
		throw new ChangeSetIntegrityError(
			`authoring_workspaces.exclusive_kind holds unknown value "${row.exclusive_kind}".`,
		);
	}
	return {
		id: requireText(row.id, "authoring_workspaces.id"),
		designSessionId: requireText(
			row.design_session_id,
			"authoring_workspaces.design_session_id",
		),
		planRevision: safePersistedSequence(
			row.plan_revision,
			"authoring_workspaces.plan_revision",
		),
		kind: kind as ChangeSetKind,
		appId: row.app_id,
		proposedAppId: row.proposed_app_id,
		baseSeq:
			row.base_seq === null
				? null
				: safePersistedSequence(row.base_seq, "authoring_workspaces.base_seq"),
		baseProjectId: requireText(
			row.base_project_id,
			"authoring_workspaces.base_project_id",
		),
		baseSnapshotDigest: requireDigest(
			row.base_snapshot_digest,
			"authoring_workspaces.base_snapshot_digest",
		),
		revision: safePersistedSequence(
			row.revision,
			"authoring_workspaces.revision",
		),
		nextOrdinal: safePersistedSequence(
			row.next_ordinal,
			"authoring_workspaces.next_ordinal",
		),
		exclusiveKind: row.exclusive_kind as ChangeSetExclusiveKind | null,
		ownerUserId: requireText(
			row.owner_user_id,
			"authoring_workspaces.owner_user_id",
		),
		ownerRunId: requireText(
			row.owner_run_id,
			"authoring_workspaces.owner_run_id",
		),
		status: status as ChangeSetStatus,
		committedSeq:
			row.committed_seq === null
				? null
				: safePersistedSequence(
						row.committed_seq,
						"authoring_workspaces.committed_seq",
					),
		committedBatchId: row.committed_batch_id,
		committedSnapshotDigest: row.committed_snapshot_digest,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ── Reads ──────────────────────────────────────────────────────────

type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;

export async function loadChangeSet(
	id: string,
	handle?: Db,
): Promise<DesignChangeSet | undefined> {
	const db = handle ?? (await getAppDb());
	const row = await db
		.selectFrom("authoring_workspaces")
		.select(CHANGE_SET_COLUMNS)
		.where("id", "=", id)
		.executeTakeFirst();
	return row === undefined
		? undefined
		: parseChangeSetRow(row as unknown as ChangeSetRow);
}

export async function lockChangeSetRow(
	tx: Transaction<AppDatabase>,
	id: string,
): Promise<DesignChangeSet | undefined> {
	const row = await tx
		.selectFrom("authoring_workspaces")
		.select(CHANGE_SET_COLUMNS)
		.where("id", "=", id)
		.forUpdate()
		.executeTakeFirst();
	return row === undefined
		? undefined
		: parseChangeSetRow(row as unknown as ChangeSetRow);
}

/** Load the exact admitted steps (with stage ranges) in ordinal order. */
export async function loadChangeSetSteps(
	changeSetId: string,
	handle?: Db,
): Promise<ChangeSetStep[]> {
	const db = handle ?? (await getAppDb());
	const [stepRows, stageRows] = await Promise.all([
		db
			.selectFrom("authoring_steps")
			.select(["ordinal", "request_id", "tool_name", "mutation_digest"])
			.select(
				sql<string>`${sql.ref("authoring_steps.mutations")}::text`.as(
					"mutations_text",
				),
			)
			.where("change_set_id", "=", changeSetId)
			.orderBy("ordinal", "asc")
			.execute(),
		db
			.selectFrom("authoring_step_stages")
			.select([
				"step_ordinal",
				"stage_ordinal",
				"stage_name",
				"mutation_start",
				"mutation_count",
			])
			.where("change_set_id", "=", changeSetId)
			.orderBy("step_ordinal", "asc")
			.orderBy("stage_ordinal", "asc")
			.execute(),
	]);
	const stagesByStep = new Map<number, ChangeSetStepStage[]>();
	for (const row of stageRows) {
		const stepOrdinal = safePersistedSequence(
			row.step_ordinal,
			"authoring_step_stages.step_ordinal",
		);
		const entry: ChangeSetStepStage = {
			stageOrdinal: row.stage_ordinal,
			stageName: row.stage_name,
			mutationStart: row.mutation_start,
			mutationCount: row.mutation_count,
		};
		const list = stagesByStep.get(stepOrdinal) ?? [];
		list.push(entry);
		stagesByStep.set(stepOrdinal, list);
	}
	let expectedOrdinal = 0;
	return stepRows.map((row) => {
		const ordinal = safePersistedSequence(
			row.ordinal,
			"authoring_steps.ordinal",
		);
		if (ordinal !== expectedOrdinal) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSetId} steps are not contiguous: expected ordinal ${expectedOrdinal}, found ${ordinal}.`,
			);
		}
		expectedOrdinal += 1;
		const mutations = parsePersistedMutationBatchText(
			row.mutations_text,
			`authoring_steps.mutations for change set ${changeSetId}, ordinal ${ordinal}`,
		);
		const mutationDigest = canonicalJsonDigest(mutations);
		if (mutationDigest !== row.mutation_digest) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSetId} step ${ordinal} no longer matches its recorded mutation digest.`,
			);
		}
		return {
			ordinal,
			requestId: row.request_id,
			toolName: row.tool_name,
			mutations,
			mutationDigest,
			stages: stagesByStep.get(ordinal) ?? [],
		};
	});
}

/** Read an idempotent request receipt. */
export async function lookupStageRequest(
	changeSetId: string,
	requestId: string,
	handle?: Db,
): Promise<StoredStageRequest | undefined> {
	const db = handle ?? (await getAppDb());
	const row = await db
		.selectFrom("authoring_requests")
		.select([
			"request_id",
			"tool_name",
			"input_digest",
			"expected_revision",
			"resulting_revision",
			"status",
		])
		.select(
			sql<string>`${sql.ref("authoring_requests.receipt")}::text`.as(
				"receipt_text",
			),
		)
		.where("change_set_id", "=", changeSetId)
		.where("request_id", "=", requestId)
		.executeTakeFirst();
	if (row === undefined) return undefined;
	if (
		row.status !== "staged" &&
		row.status !== "noop" &&
		row.status !== "rejected"
	) {
		throw new ChangeSetIntegrityError(
			`authoring_requests.status holds unknown value "${row.status}".`,
		);
	}
	return {
		requestId: row.request_id,
		toolName: row.tool_name,
		inputDigest: row.input_digest,
		expectedRevision: safePersistedSequence(
			row.expected_revision,
			"authoring_requests.expected_revision",
		),
		resultingRevision: safePersistedSequence(
			row.resulting_revision,
			"authoring_requests.resulting_revision",
		),
		status: row.status,
		receipt: stageRequestReceiptSchema.parse(
			parsePersistedJsonText(
				row.receipt_text,
				`authoring_requests.receipt for change set ${changeSetId}, request ${requestId}`,
			),
		),
	};
}

// ── Authority verification ─────────────────────────────────────────

async function _assertEditMembership(
	tx: Transaction<AppDatabase>,
	actorUserId: string,
	projectId: string,
): Promise<void> {
	const role = await projectRoleForInTransaction(tx, actorUserId, projectId);
	if (role === null || !roleAllowsApp(role, "edit")) {
		throw new ChangeSetScopeLostError(
			"You no longer have edit access to this change set's Project.",
		);
	}
}

/**
 * Lock and verify the authority carrier plus the change-set row for one
 * staging/lifecycle write, in the canonical order (app row first). Returns
 * the locked, parsed change set.
 */
async function lockAndVerifyOpenChangeSet(
	tx: Transaction<AppDatabase>,
	args: {
		readonly changeSetId: string;
		readonly appId: string | null;
		readonly designSessionId: string;
		readonly projectId: string;
		readonly actorUserId: string;
		readonly runId: string;
		readonly chatRunHolder: ChatRunHolderCapability;
	},
): Promise<DesignChangeSet> {
	if (
		args.chatRunHolder.mode !== "build" ||
		args.chatRunHolder.runId !== args.runId
	)
		throw new ChangeSetScopeLostError(
			"This workspace no longer belongs to the active build.",
		);
	const authority = await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId: args.designSessionId,
		actorUserId: args.actorUserId,
		expectedProjectId: args.projectId,
		holder: args.chatRunHolder,
	});
	const planRevision = await lockPlanForBuild(tx, args.designSessionId);
	const workspace = await lockChangeSetRow(tx, args.changeSetId);
	if (!workspace)
		throw new ChangeSetScopeLostError("This workspace is unavailable.");
	if (
		workspace.appId !== args.appId ||
		authority.appId !== args.appId ||
		workspace.designSessionId !== args.designSessionId ||
		workspace.baseProjectId !== args.projectId ||
		workspace.planRevision !== planRevision
	)
		throw new ChangeSetScopeLostError(
			"The workspace no longer matches this app, Project and plan.",
		);
	verifyOpenOwnership(workspace, args);
	return workspace;
}

function verifyOpenOwnership(
	changeSet: DesignChangeSet,
	args: { readonly actorUserId: string; readonly runId: string },
): void {
	if (changeSet.status !== "open") {
		throw new ChangeSetScopeLostError(
			changeSet.status === "committed"
				? "This change set has already committed."
				: `This change set is ${changeSet.status} and can no longer be used.`,
		);
	}
	if (
		changeSet.ownerUserId !== args.actorUserId ||
		changeSet.ownerRunId !== args.runId
	) {
		throw new ChangeSetScopeLostError(
			"This change set belongs to a different run.",
		);
	}
}

// ── Creation ───────────────────────────────────────────────────────

export interface BeginChangeSetCommonArgs {
	readonly lineage: ChangeSetLineage;
	readonly ownerUserId: string;
	readonly ownerRunId: string;
	readonly holderNonce: string;
}

async function authorizeBegin(
	tx: Transaction<AppDatabase>,
	args: BeginChangeSetCommonArgs,
	projectId: string,
) {
	const authority = await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId: args.lineage.designSessionId,
		actorUserId: args.ownerUserId,
		expectedProjectId: projectId,
		holder: { mode: "build", runId: args.ownerRunId, nonce: args.holderNonce },
	});
	await lockPlanForBuild(
		tx,
		args.lineage.designSessionId,
		args.lineage.planRevision,
	);
	const existing = await tx
		.selectFrom("authoring_workspaces")
		.select("id")
		.where("design_session_id", "=", args.lineage.designSessionId)
		.where("status", "=", "open")
		.executeTakeFirst();
	if (existing)
		throw new ChangeSetScopeLostError(
			`Workspace ${existing.id} is still open. Resume it before starting another checkpoint.`,
		);
	return authority;
}

export async function beginAppEditChangeSet(
	args: BeginChangeSetCommonArgs & {
		readonly appId: string;
		readonly expectedProjectId: string;
	},
): Promise<DesignChangeSet> {
	return withAppTx(async (tx) => {
		const authority = await authorizeBegin(tx, args, args.expectedProjectId);
		if (authority.appId !== args.appId)
			throw new ChangeSetScopeLostError("This session belongs to another app.");
		const app = await loadAppInTransaction(tx, args.appId);
		if (
			!app ||
			app.deleted_at !== null ||
			app.project_id !== args.expectedProjectId
		)
			throw new ChangeSetScopeLostError(
				"This app is unavailable in the current Project.",
			);
		const id = crypto.randomUUID();
		await tx
			.insertInto("authoring_workspaces")
			.values({
				id,
				design_session_id: args.lineage.designSessionId,
				plan_revision: args.lineage.planRevision,
				kind: "app-edit",
				app_id: args.appId,
				proposed_app_id: null,
				base_seq: app.mutation_seq,
				base_project_id: app.project_id,
				base_snapshot_digest: canonicalJsonDigest(app.blueprint),
				exclusive_kind: null,
				owner_user_id: args.ownerUserId,
				owner_run_id: args.ownerRunId,
				status: "open",
				committed_seq: null,
				committed_batch_id: null,
				committed_snapshot_digest: null,
			})
			.execute();
		const created = await loadChangeSet(id, tx);
		if (!created)
			throw new ChangeSetIntegrityError("The new workspace is missing.");
		return created;
	});
}

export async function beginGenesisChangeSet(
	args: BeginChangeSetCommonArgs & {
		readonly proposedAppId: string;
		readonly projectId: string;
		readonly baseSnapshotDigest: string;
	},
): Promise<DesignChangeSet> {
	return withAppTx(async (tx) => {
		const authority = await authorizeBegin(tx, args, args.projectId);
		const session = await tx
			.selectFrom("design_sessions")
			.select("proposed_app_id")
			.where("id", "=", args.lineage.designSessionId)
			.executeTakeFirstOrThrow();
		if (
			authority.appId !== null ||
			session.proposed_app_id !== args.proposedAppId
		)
			throw new ChangeSetScopeLostError(
				"This session no longer authorizes creation of that app.",
			);
		const id = crypto.randomUUID();
		await tx
			.insertInto("authoring_workspaces")
			.values({
				id,
				design_session_id: args.lineage.designSessionId,
				plan_revision: args.lineage.planRevision,
				kind: "genesis",
				app_id: null,
				proposed_app_id: args.proposedAppId,
				base_seq: null,
				base_project_id: args.projectId,
				base_snapshot_digest: args.baseSnapshotDigest,
				exclusive_kind: null,
				owner_user_id: args.ownerUserId,
				owner_run_id: args.ownerRunId,
				status: "open",
				committed_seq: null,
				committed_batch_id: null,
				committed_snapshot_digest: null,
			})
			.execute();
		const created = await loadChangeSet(id, tx);
		if (!created)
			throw new ChangeSetIntegrityError("The new workspace is missing.");
		return created;
	});
}

/** The current lease holder may adopt the session's unfinished private work. */
export async function resumeOpenChangeSet(args: {
	readonly designSessionId: string;
	readonly projectId: string;
	readonly actorUserId: string;
	readonly runId: string;
	readonly holderNonce: string;
}): Promise<DesignChangeSet | null> {
	return withAppTx(async (tx) => {
		const authority = await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.designSessionId,
			actorUserId: args.actorUserId,
			expectedProjectId: args.projectId,
			holder: { mode: "build", runId: args.runId, nonce: args.holderNonce },
		});
		const planRevision = await lockPlanForBuild(tx, args.designSessionId);
		const row = await tx
			.selectFrom("authoring_workspaces")
			.select(CHANGE_SET_COLUMNS)
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "=", "open")
			.forUpdate()
			.executeTakeFirst();
		if (!row) return null;
		const workspace = parseChangeSetRow(row as ChangeSetRow);
		if (
			workspace.baseProjectId !== args.projectId ||
			workspace.appId !== authority.appId ||
			workspace.planRevision !== planRevision
		)
			throw new ChangeSetScopeLostError(
				"The unfinished workspace no longer matches this session's app and plan.",
			);
		await tx
			.updateTable("authoring_workspaces")
			.set({
				owner_user_id: args.actorUserId,
				owner_run_id: args.runId,
				updated_at: new Date(),
			})
			.where("id", "=", workspace.id)
			.execute();
		return {
			...workspace,
			ownerUserId: args.actorUserId,
			ownerRunId: args.runId,
		};
	});
}

// ── The stage transaction ──────────────────────────────────────────

export type StageRequestOutcome =
	| {
			readonly kind: "stage";
			readonly mutations: AdmittedMutationBatch;
			readonly stageSlices: readonly AdmittedMutationStageSlice[];
			/** Complete set of local binding UUIDs still represented by the
			 * post-step candidate. The workspace uses this to prune its verified
			 * projection; the durable handle ledger itself remains append-only. */
			/** Non-null when this batch is batch-exclusive — the fence closes
			 * the set to any other step. */
			readonly exclusiveKind: ChangeSetExclusiveKind | null;
			readonly diagnostics: ChangeSetDiagnosticsSummary;
			readonly replayResult: MutationReplayResult;
	  }
	| {
			readonly kind: "noop";
			readonly replayResult: MutationReplayResult;
	  }
	| {
			readonly kind: "reject";
			readonly code: ChangeSetStageErrorCode;
			readonly message: string;
	  };

export interface StageChangeSetRequestArgs {
	readonly changeSetId: string;
	readonly requestId: string;
	readonly toolName: string;
	/** Canonical digest of the caller's ACTUAL request (`workspaceCallInputDigest`),
	 * computed before handle resolution. */
	readonly inputDigest: string;
	readonly expectedRevision: number;
	readonly actorUserId: string;
	readonly runId: string;
	readonly chatRunHolder: ChatRunHolderCapability;
	/** Absolute executor deadline. The stage transaction cannot commit past it. */
	readonly deadlineAt?: number;
	readonly outcome: StageRequestOutcome;
}

export interface StageChangeSetRequestResult {
	readonly replayed: boolean;
	readonly receipt: StageRequestReceipt;
}

function _isUniqueViolation(err: unknown): boolean {
	return (err as { code?: unknown })?.code === "23505";
}

/** The stage transaction's statement boundaries, in execution order — the
 *  fault-injection seam's vocabulary. */
export type StageTransactionBoundary =
	| "after-authority-lock"
	| "after-ledger-read"
	| "after-request-insert"
	| "after-step-insert"
	| "after-stage-insert"
	| "after-advance";

type StageTransactionFaultHook = (
	boundary: StageTransactionBoundary,
) => void | Promise<void>;
let stageTransactionFaultHook: StageTransactionFaultHook | null = null;

/**
 * Deterministic fault-injection seam for the §20.5 statement-boundary
 * matrix. Production never installs it; a throwing hook aborts the stage
 * transaction at the named boundary, and the suite proves nothing partial
 * persisted.
 */
export function __setStageTransactionFaultHookForTests(
	hook: StageTransactionFaultHook | null,
): void {
	stageTransactionFaultHook = hook;
}

async function faultBoundary(
	boundary: StageTransactionBoundary,
): Promise<void> {
	await stageTransactionFaultHook?.(boundary);
}

/**
 * The one durable staging write. Idempotent by `(changeSetId, requestId)`:
 * a replay whose tool name, input digest, and expected revision match the
 * stored request returns the stored receipt unchanged; any divergence is a
 * terminal collision. A fresh request commits its receipt, step, stage
 * ranges, handle bindings, and the revision advance in ONE transaction.
 */
export async function stageChangeSetRequest(
	args: StageChangeSetRequestArgs,
): Promise<StageChangeSetRequestResult> {
	/* Resolve the authority target WITHOUT a row lock, so the transaction can
	 * take the app row first (never change-set-first). Kind/app columns are
	 * immutable, and the locked re-read below re-proves them. */
	const preRead = await loadChangeSet(args.changeSetId);
	if (preRead === undefined) {
		throw new ChangeSetScopeLostError("This change set no longer exists.");
	}
	return withAppTx(
		(tx) => stageInTransaction(tx, args, preRead),
		args.deadlineAt === undefined ? undefined : { deadlineAt: args.deadlineAt },
	);
}

async function stageInTransaction(
	tx: Transaction<AppDatabase>,
	args: StageChangeSetRequestArgs,
	preRead: DesignChangeSet,
): Promise<StageChangeSetRequestResult> {
	const changeSet = await lockAndVerifyOpenChangeSet(tx, {
		changeSetId: args.changeSetId,
		appId: preRead.appId,
		designSessionId: preRead.designSessionId,
		projectId: preRead.baseProjectId,
		actorUserId: args.actorUserId,
		runId: args.runId,
		chatRunHolder: args.chatRunHolder,
	});
	await faultBoundary("after-authority-lock");

	/* Idempotent replay — the ledger read under the change-set lock observes
	 * every prior committed request. */
	const stored = await lookupStageRequest(args.changeSetId, args.requestId, tx);
	await faultBoundary("after-ledger-read");
	if (stored !== undefined) {
		if (
			stored.toolName === args.toolName &&
			stored.inputDigest === args.inputDigest &&
			stored.expectedRevision === args.expectedRevision
		) {
			return { replayed: true, receipt: stored.receipt };
		}
		throw new ChangeSetRequestIdCollisionError();
	}

	if (args.expectedRevision !== changeSet.revision) {
		throw new ChangeSetWorkspaceRevisionStaleError(
			args.expectedRevision,
			changeSet.revision,
		);
	}

	const outcome = args.outcome;
	if (outcome.kind === "reject") {
		const receipt = stageRequestReceiptSchema.parse({
			requestId: args.requestId,
			disposition: "rejected",
			workspaceRevision: changeSet.revision,
			error: { code: outcome.code, message: outcome.message },
		} satisfies StageRequestReceipt);
		await tx
			.insertInto("authoring_requests")
			.values({
				change_set_id: args.changeSetId,
				request_id: args.requestId,
				tool_name: args.toolName,
				input_digest: args.inputDigest,
				expected_revision: changeSet.revision,
				resulting_revision: changeSet.revision,
				status: "rejected",
				rejection_code: outcome.code,
				receipt: JSON.stringify(receipt),
			})
			.execute();
		return { replayed: false, receipt };
	}
	if (outcome.kind === "noop") {
		const receipt = stageRequestReceiptSchema.parse({
			requestId: args.requestId,
			disposition: "noop",
			workspaceRevision: changeSet.revision,
			replayResult: outcome.replayResult,
		} satisfies StageRequestReceipt);
		await tx
			.insertInto("authoring_requests")
			.values({
				change_set_id: args.changeSetId,
				request_id: args.requestId,
				tool_name: args.toolName,
				input_digest: args.inputDigest,
				expected_revision: changeSet.revision,
				resulting_revision: changeSet.revision,
				status: "noop",
				rejection_code: null,
				receipt: JSON.stringify(receipt),
			})
			.execute();
		await faultBoundary("after-request-insert");
		await faultBoundary("after-advance");
		return { replayed: false, receipt };
	}

	/* The batch-exclusive fence, authoritative under the lock: an exclusive
	 * batch must be the set's only step, and a set holding one admits no
	 * more. The workspace rejects both earlier with person-readable
	 * messages; reaching here means a protocol defect, so throw loudly. */
	if (changeSet.exclusiveKind !== null) {
		throw new ChangeSetIntegrityError(
			`Change set ${args.changeSetId} already holds a batch-exclusive ${changeSet.exclusiveKind} step; nothing further may stage.`,
		);
	}
	if (outcome.exclusiveKind !== null && changeSet.nextOrdinal > 0) {
		throw new ChangeSetIntegrityError(
			`Change set ${args.changeSetId} has ${changeSet.nextOrdinal} staged step(s); a batch-exclusive ${outcome.exclusiveKind} batch must own its change set alone.`,
		);
	}
	if (outcome.mutations.length === 0) {
		throw new ChangeSetIntegrityError(
			"A staged step requires at least one admitted mutation.",
		);
	}

	const ordinal = changeSet.nextOrdinal;
	const resultingRevision = changeSet.revision + 1;
	const mutationDigest = canonicalJsonDigest(outcome.mutations);
	const receipt = stageRequestReceiptSchema.parse({
		requestId: args.requestId,
		disposition: "staged",
		workspaceRevision: resultingRevision,
		ordinal,
		mutationDigest,
		diagnostics: outcome.diagnostics,
		replayResult: outcome.replayResult,
	} satisfies StageRequestReceipt);

	await tx
		.insertInto("authoring_requests")
		.values({
			change_set_id: args.changeSetId,
			request_id: args.requestId,
			tool_name: args.toolName,
			input_digest: args.inputDigest,
			expected_revision: changeSet.revision,
			resulting_revision: resultingRevision,
			status: "staged",
			rejection_code: null,
			receipt: JSON.stringify(receipt),
		})
		.execute();
	await faultBoundary("after-request-insert");
	await tx
		.insertInto("authoring_steps")
		.values({
			change_set_id: args.changeSetId,
			ordinal,
			request_id: args.requestId,
			tool_name: args.toolName,
			mutations: encodeAdmittedMutationEnvelope(outcome.mutations).json,
			mutation_digest: mutationDigest,
		})
		.execute();
	await faultBoundary("after-step-insert");
	if (outcome.stageSlices.length > 0) {
		await tx
			.insertInto("authoring_step_stages")
			.values(
				outcome.stageSlices.map((slice, index) => ({
					change_set_id: args.changeSetId,
					step_ordinal: ordinal,
					stage_ordinal: index,
					stage_name: slice.stage,
					mutation_start: slice.start,
					mutation_count: slice.end - slice.start,
				})),
			)
			.execute();
	}
	await faultBoundary("after-stage-insert");
	const advance = await tx
		.updateTable("authoring_workspaces")
		.set({
			revision: resultingRevision,
			next_ordinal: ordinal + 1,
			updated_at: new Date(),
			...(outcome.exclusiveKind !== null && {
				exclusive_kind: outcome.exclusiveKind,
			}),
		})
		.where("id", "=", args.changeSetId)
		.where("revision", "=", changeSet.revision)
		.where("status", "=", "open")
		.executeTakeFirst();
	if (!updatedExactlyOne(advance)) {
		throw new ChangeSetIntegrityError(
			`Change set ${args.changeSetId} advanced underneath its own locked stage transaction.`,
		);
	}
	await faultBoundary("after-advance");
	return { replayed: false, receipt };
}

// ── Lifecycle ──────────────────────────────────────────────────────

/**
 * Mark one open change set abandoned (exact owner only). No canonical state
 * changes; retained steps follow the retention policy.
 */
export async function abandonChangeSet(args: {
	readonly changeSetId: string;
	readonly actorUserId: string;
	readonly runId: string;
	readonly chatRunHolder: ChatRunHolderCapability;
}): Promise<void> {
	await transitionOpenChangeSet(args, "abandoned");
}

/** Mark one open change set superseded — a newer contract/plan revision or
 *  attempt replaced it. Steps are retained for audit/retention policy. */
export async function supersedeChangeSet(args: {
	readonly changeSetId: string;
	readonly actorUserId: string;
	readonly runId: string;
	readonly chatRunHolder: ChatRunHolderCapability;
}): Promise<void> {
	await transitionOpenChangeSet(args, "superseded");
}

async function transitionOpenChangeSet(
	args: {
		readonly changeSetId: string;
		readonly actorUserId: string;
		readonly runId: string;
		readonly chatRunHolder: ChatRunHolderCapability;
	},
	to: "abandoned" | "superseded",
): Promise<void> {
	const preRead = await loadChangeSet(args.changeSetId);
	if (preRead === undefined) {
		throw new ChangeSetScopeLostError("This change set no longer exists.");
	}
	await withAppTx(async (tx) => {
		const changeSet = await lockAndVerifyOpenChangeSet(tx, {
			changeSetId: args.changeSetId,
			appId: preRead.appId,
			designSessionId: preRead.designSessionId,
			projectId: preRead.baseProjectId,
			actorUserId: args.actorUserId,
			runId: args.runId,
			chatRunHolder: args.chatRunHolder,
		});
		const update = await tx
			.updateTable("authoring_workspaces")
			.set({ status: to, updated_at: new Date() })
			.where("id", "=", args.changeSetId)
			.where("revision", "=", changeSet.revision)
			.where("status", "=", "open")
			.executeTakeFirst();
		if (!updatedExactlyOne(update)) {
			throw new ChangeSetIntegrityError(
				`Change set ${args.changeSetId} advanced underneath its own locked ${to} transition.`,
			);
		}
	});
}
