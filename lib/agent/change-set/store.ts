/**
 * The change-set store — the durable protocol behind the private staging
 * workspace.
 *
 * One module owns every read and write of the change-set tables. The
 * correctness spine is the STAGE TRANSACTION: lock the authority carrier
 * first (an app-edit set's app row `FOR SHARE`; a genesis set's claimed
 * design-session row `FOR UPDATE` — the session is the run/credit authority
 * a pre-app build holds, so its holder is the ownership proof), lock the
 * change-set row second, prove owner/run/holder/Project/status, replay the
 * request ledger for an idempotent retry, then commit the request receipt,
 * step, stage ranges, handle bindings, and the revision advance as ONE
 * transaction. There is no durable in-progress state: a request either
 * committed everything it staged or nothing.
 *
 * Lock order (the plan's §11.13 staging rules): authority row (`apps`, or
 * `design_sessions` for a genesis set) → design_change_sets → membership
 * gate/member row. No path holds a change-set row while waiting for an
 * authority row, and the membership gate is only ever taken while already
 * holding the authority rows — membership writers never take change-set,
 * app, or session locks, so gate-after-row cannot cycle.
 *
 * The staging ledgers (requests/steps/stages/handles) are append-only at the
 * database privilege level; this row-locked authority table is what
 * serializes them.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import type { DesignId } from "@/lib/agent/design/ids";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { ChatRunHolderCapability } from "@/lib/db/apps";
import { loadAppInTransaction } from "@/lib/db/apps";
import {
	assertDesignSessionRunAuthorityInTransaction,
	lockSessionRow,
} from "@/lib/db/designSessions";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import {
	parsePersistedJsonText,
	parsePersistedMutationBatchText,
	safePersistedSequence,
} from "@/lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import {
	exactRunHolderMatches,
	updatedExactlyOne,
} from "@/lib/db/runHolderWrites";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import type {
	AdmittedMutationBatch,
	AdmittedMutationStageSlice,
} from "@/lib/doc/mutationAdmission";
import { encodeAdmittedMutationEnvelope } from "@/lib/doc/mutationAdmission";
import type { Uuid } from "@/lib/domain";
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
	type ChangeSetHandle,
	changeSetHandleSchema,
	type ExternalReadDependency,
	intentIdsSchema,
	readSetSchema,
	SHA256_HEX_PATTERN,
	type StagedEntityKind,
	type StageRequestReceipt,
	stagedEntityKindSchema,
	stageRequestReceiptSchema,
} from "./schemas";
import type {
	ChangeSetExclusiveKind,
	ChangeSetHandleBinding,
	ChangeSetKind,
	ChangeSetLineage,
	ChangeSetStatus,
	ChangeSetStep,
	ChangeSetStepStage,
	DesignChangeSet,
	StoredStageRequest,
} from "./types";
import { effectiveBatchExclusiveKind } from "./types";

// ── Row parsing ────────────────────────────────────────────────────

const CHANGE_SET_COLUMNS = [
	"id",
	"purpose",
	"design_session_id",
	"design_revision_id",
	"design_revision_digest",
	"build_plan_id",
	"build_plan_digest",
	"slice_id",
	"attempt_id",
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
		: K extends "revision" | "next_ordinal"
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
	const purpose = requireText(row.purpose, "design_change_sets.purpose");
	if (purpose !== "slice" && purpose !== "design-candidate") {
		throw new ChangeSetIntegrityError(
			`design_change_sets.purpose holds unknown value "${purpose}".`,
		);
	}
	const kind = requireText(row.kind, "design_change_sets.kind");
	if (!CHANGE_SET_KINDS.has(kind as ChangeSetKind)) {
		throw new ChangeSetIntegrityError(
			`design_change_sets.kind holds unknown value "${kind}".`,
		);
	}
	const status = requireText(row.status, "design_change_sets.status");
	if (!CHANGE_SET_STATUSES.has(status as ChangeSetStatus)) {
		throw new ChangeSetIntegrityError(
			`design_change_sets.status holds unknown value "${status}".`,
		);
	}
	if (
		row.exclusive_kind !== null &&
		!EXCLUSIVE_KINDS.has(row.exclusive_kind as ChangeSetExclusiveKind)
	) {
		throw new ChangeSetIntegrityError(
			`design_change_sets.exclusive_kind holds unknown value "${row.exclusive_kind}".`,
		);
	}
	const common = {
		id: requireText(row.id, "design_change_sets.id"),
		designSessionId: requireText(
			row.design_session_id,
			"design_change_sets.design_session_id",
		),
		kind: kind as ChangeSetKind,
		appId: row.app_id,
		proposedAppId: row.proposed_app_id,
		baseSeq:
			row.base_seq === null
				? null
				: safePersistedSequence(row.base_seq, "design_change_sets.base_seq"),
		baseProjectId: requireText(
			row.base_project_id,
			"design_change_sets.base_project_id",
		),
		baseSnapshotDigest: requireDigest(
			row.base_snapshot_digest,
			"design_change_sets.base_snapshot_digest",
		),
		revision: safePersistedSequence(
			row.revision,
			"design_change_sets.revision",
		),
		nextOrdinal: safePersistedSequence(
			row.next_ordinal,
			"design_change_sets.next_ordinal",
		),
		exclusiveKind: row.exclusive_kind as ChangeSetExclusiveKind | null,
		ownerUserId: requireText(
			row.owner_user_id,
			"design_change_sets.owner_user_id",
		),
		ownerRunId: requireText(
			row.owner_run_id,
			"design_change_sets.owner_run_id",
		),
		status: status as ChangeSetStatus,
		committedSeq:
			row.committed_seq === null
				? null
				: safePersistedSequence(
						row.committed_seq,
						"design_change_sets.committed_seq",
					),
		committedBatchId: row.committed_batch_id,
		committedSnapshotDigest: row.committed_snapshot_digest,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (purpose === "design-candidate") {
		if (
			row.design_revision_id !== null ||
			row.design_revision_digest !== null ||
			row.build_plan_id !== null ||
			row.build_plan_digest !== null ||
			row.slice_id !== null ||
			row.attempt_id !== null
		) {
			throw new ChangeSetIntegrityError(
				"A design-candidate change set cannot carry slice lineage.",
			);
		}
		return {
			...common,
			purpose,
			designRevisionId: null,
			designRevisionDigest: null,
			buildPlanId: null,
			buildPlanDigest: null,
			sliceId: null,
			attemptId: null,
		};
	}
	return {
		...common,
		purpose,
		designRevisionId: requireText(
			row.design_revision_id,
			"design_change_sets.design_revision_id",
		),
		designRevisionDigest: requireDigest(
			row.design_revision_digest,
			"design_change_sets.design_revision_digest",
		),
		buildPlanId: requireText(
			row.build_plan_id,
			"design_change_sets.build_plan_id",
		),
		buildPlanDigest: requireDigest(
			row.build_plan_digest,
			"design_change_sets.build_plan_digest",
		),
		sliceId: requireText(
			row.slice_id,
			"design_change_sets.slice_id",
		) as DesignId,
		attemptId: requireText(row.attempt_id, "design_change_sets.attempt_id"),
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
		.selectFrom("design_change_sets")
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
		.selectFrom("design_change_sets")
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
			.selectFrom("design_change_set_steps")
			.select(["ordinal", "request_id", "tool_name", "mutation_digest"])
			.select(
				sql<string>`${sql.ref("design_change_set_steps.mutations")}::text`.as(
					"mutations_text",
				),
			)
			.select(
				sql<string>`${sql.ref("design_change_set_steps.intent_ids")}::text`.as(
					"intent_ids_text",
				),
			)
			.select(
				sql<string>`${sql.ref("design_change_set_steps.read_set")}::text`.as(
					"read_set_text",
				),
			)
			.where("change_set_id", "=", changeSetId)
			.orderBy("ordinal", "asc")
			.execute(),
		db
			.selectFrom("design_change_set_step_stages")
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
			"design_change_set_step_stages.step_ordinal",
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
			"design_change_set_steps.ordinal",
		);
		if (ordinal !== expectedOrdinal) {
			throw new ChangeSetIntegrityError(
				`Change set ${changeSetId} steps are not contiguous: expected ordinal ${expectedOrdinal}, found ${ordinal}.`,
			);
		}
		expectedOrdinal += 1;
		const mutations = parsePersistedMutationBatchText(
			row.mutations_text,
			`design_change_set_steps.mutations for change set ${changeSetId}, ordinal ${ordinal}`,
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
			intentIds: intentIdsSchema.parse(
				parsePersistedJsonText(
					row.intent_ids_text,
					`design_change_set_steps.intent_ids for change set ${changeSetId}, ordinal ${ordinal}`,
				),
			),
			readSet: readSetSchema.parse(
				parsePersistedJsonText(
					row.read_set_text,
					`design_change_set_steps.read_set for change set ${changeSetId}, ordinal ${ordinal}`,
				),
			),
			stages: stagesByStep.get(ordinal) ?? [],
		};
	});
}

/** Load every handle binding of one change set. */
export async function loadHandleBindings(
	changeSetId: string,
	dbHandle?: Db,
): Promise<ChangeSetHandleBinding[]> {
	const db = dbHandle ?? (await getAppDb());
	const rows = await db
		.selectFrom("design_change_set_handles")
		.select(["handle", "uuid", "entity_kind", "binding_request_id"])
		.where("change_set_id", "=", changeSetId)
		.orderBy("handle", "asc")
		.execute();
	return rows.map((row) => ({
		handle: changeSetHandleSchema.parse(row.handle),
		uuid: row.uuid as Uuid,
		entityKind: stagedEntityKindSchema.parse(row.entity_kind),
		bindingRequestId: row.binding_request_id,
	}));
}

/** Look up one stored staging request — the idempotent-replay read. */
export async function lookupStageRequest(
	changeSetId: string,
	requestId: string,
	handle?: Db,
): Promise<StoredStageRequest | undefined> {
	const db = handle ?? (await getAppDb());
	const row = await db
		.selectFrom("design_change_set_requests")
		.select([
			"request_id",
			"tool_name",
			"input_digest",
			"expected_revision",
			"resulting_revision",
			"status",
		])
		.select(
			sql<string>`${sql.ref("design_change_set_requests.receipt")}::text`.as(
				"receipt_text",
			),
		)
		.where("change_set_id", "=", changeSetId)
		.where("request_id", "=", requestId)
		.executeTakeFirst();
	if (row === undefined) return undefined;
	if (row.status !== "staged" && row.status !== "rejected") {
		throw new ChangeSetIntegrityError(
			`design_change_set_requests.status holds unknown value "${row.status}".`,
		);
	}
	return {
		requestId: row.request_id,
		toolName: row.tool_name,
		inputDigest: row.input_digest,
		expectedRevision: safePersistedSequence(
			row.expected_revision,
			"design_change_set_requests.expected_revision",
		),
		resultingRevision: safePersistedSequence(
			row.resulting_revision,
			"design_change_set_requests.resulting_revision",
		),
		status: row.status,
		receipt: stageRequestReceiptSchema.parse(
			parsePersistedJsonText(
				row.receipt_text,
				`design_change_set_requests.receipt for change set ${changeSetId}, request ${requestId}`,
			),
		),
	};
}

// ── Authority verification ─────────────────────────────────────────

async function assertEditMembership(
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
		/** From the unlocked pre-read — which authority row to lock FIRST
		 * (`apps` for an app-edit set, `design_sessions` for genesis). The
		 * row's own immutable kind/app columns are re-proved after. */
		readonly appId: string | null;
		readonly designSessionId: string | null;
		readonly actorUserId: string;
		readonly runId: string;
		readonly chatRunHolder?: ChatRunHolderCapability;
	},
): Promise<DesignChangeSet> {
	if (args.appId !== null) {
		const app = await tx
			.selectFrom("apps")
			.select(LEASE_COLUMNS)
			.select(["id", "project_id", "deleted_at"])
			.where("id", "=", args.appId)
			.forShare()
			.executeTakeFirst();
		if (app === undefined || app.deleted_at !== null) {
			throw new ChangeSetScopeLostError(
				"This change set's app is no longer available.",
			);
		}
		if (args.chatRunHolder !== undefined) {
			const lease = runLeaseState(leaseView(app));
			if (!exactRunHolderMatches(lease.holderIdentity, args.chatRunHolder)) {
				throw new ChangeSetScopeLostError(
					"A newer request took over this app, so this change set's run no longer holds it.",
				);
			}
		}
		const changeSet = await lockChangeSetRow(tx, args.changeSetId);
		if (changeSet === undefined) {
			throw new ChangeSetScopeLostError("This change set no longer exists.");
		}
		if (changeSet.appId !== args.appId) {
			throw new ChangeSetIntegrityError(
				`Change set ${args.changeSetId} resolved to app ${args.appId} before its lock but names ${changeSet.appId ?? "no app"} under it.`,
			);
		}
		if (app.project_id !== changeSet.baseProjectId) {
			throw new ChangeSetScopeLostError(
				"This app moved to a different Project after the change set opened, so the change set can no longer be used.",
			);
		}
		await assertEditMembership(tx, args.actorUserId, app.project_id);
		verifyOpenOwnership(changeSet, args);
		return changeSet;
	}
	/* Genesis arm: the CLAIMED design-session row is the authority carrier —
	 * locked first, exactly as the app row leads an app-edit set. The
	 * session's live holder is the ownership proof (the run that claimed the
	 * session is the run staging into its genesis set); the change-set row's
	 * owner columns remain attribution, not authority. */
	if (args.designSessionId === null) {
		throw new ChangeSetIntegrityError(
			`Change set ${args.changeSetId} resolved to no app and no design session before its lock.`,
		);
	}
	const session = await lockSessionRow(tx, args.designSessionId);
	if (session === undefined || session.state !== "active") {
		throw new ChangeSetScopeLostError(
			"This design session is no longer active, so its genesis change set can no longer be used.",
		);
	}
	const sessionLease = designSessionLeaseState(session);
	if (
		args.chatRunHolder !== undefined &&
		!exactRunHolderMatches(sessionLease.holderIdentity, args.chatRunHolder)
	) {
		throw new ChangeSetScopeLostError(
			"A newer request took over this design, so this change set's run no longer holds it.",
		);
	}
	const changeSet = await lockChangeSetRow(tx, args.changeSetId);
	if (changeSet === undefined) {
		throw new ChangeSetScopeLostError("This change set no longer exists.");
	}
	if (changeSet.appId !== null) {
		throw new ChangeSetIntegrityError(
			`Change set ${args.changeSetId} resolved to no app before its lock but names app ${changeSet.appId} under it.`,
		);
	}
	if (changeSet.designSessionId !== args.designSessionId) {
		throw new ChangeSetIntegrityError(
			`Change set ${args.changeSetId} resolved to design session ${args.designSessionId} before its lock but names ${changeSet.designSessionId} under it.`,
		);
	}
	if (session.project_id !== changeSet.baseProjectId) {
		throw new ChangeSetScopeLostError(
			"This design session's Project no longer matches the change set's captured scope, so the change set can no longer be used.",
		);
	}
	await assertEditMembership(tx, args.actorUserId, changeSet.baseProjectId);
	verifyOpenOwnership(changeSet, args);
	return changeSet;
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
	/** Production slice execution supplies the exact delegated holder. The
	 * opener then binds the new set to its running attempt atomically. Direct
	 * store fixtures may omit this only to exercise the lower-level store. */
	readonly attemptAuthority?: {
		readonly holderNonce: string;
		readonly expectedProjectId: string;
	};
}

async function assertAuthorizedAttemptForBegin(
	tx: Transaction<AppDatabase>,
	args: BeginChangeSetCommonArgs,
	target:
		| {
				readonly kind: "genesis";
				readonly proposedAppId: string;
				readonly digest: string;
		  }
		| {
				readonly kind: "app";
				readonly appId: string;
				readonly seq: number;
				readonly digest: string;
		  },
): Promise<void> {
	const authority = args.attemptAuthority;
	if (authority === undefined) return;
	const carrier = await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId: args.lineage.designSessionId,
		actorUserId: args.ownerUserId,
		expectedProjectId: authority.expectedProjectId,
		holder: {
			mode: "build",
			runId: args.ownerRunId,
			nonce: authority.holderNonce,
		},
	});
	if (
		(target.kind === "genesis" && carrier.appId !== null) ||
		(target.kind === "app" && carrier.appId !== target.appId)
	) {
		throw new ChangeSetScopeLostError(
			"The design session no longer delegates to this change set's base target.",
		);
	}
	if (target.kind === "genesis") {
		const session = await tx
			.selectFrom("design_sessions")
			.select("proposed_app_id")
			.where("id", "=", args.lineage.designSessionId)
			.executeTakeFirst();
		if (session?.proposed_app_id !== target.proposedAppId) {
			throw new ChangeSetScopeLostError(
				"The design session no longer names this proposed app for genesis.",
			);
		}
	}
	const attempt = await tx
		.selectFrom("design_slice_attempts")
		.select([
			"design_revision_id",
			"design_revision_digest",
			"build_plan_id",
			"build_plan_digest",
			"slice_id",
			"base_kind",
			"base_app_id",
			"base_proposed_app_id",
			"base_seq",
			"base_snapshot_digest",
			"change_set_id",
			"status",
		])
		.where("id", "=", args.lineage.attemptId)
		.where("design_session_id", "=", args.lineage.designSessionId)
		.forUpdate()
		.executeTakeFirst();
	const baseMatches =
		target.kind === "genesis"
			? attempt?.base_kind === "empty-genesis" &&
				attempt.base_app_id === null &&
				attempt.base_proposed_app_id === target.proposedAppId &&
				attempt.base_seq === null &&
				attempt.base_snapshot_digest === target.digest
			: attempt?.base_kind === "app" &&
				attempt.base_app_id === target.appId &&
				attempt.base_proposed_app_id === null &&
				Number(attempt.base_seq) === target.seq &&
				attempt.base_snapshot_digest === target.digest;
	if (
		attempt === undefined ||
		attempt.status !== "running" ||
		attempt.change_set_id !== null ||
		attempt.design_revision_id !== args.lineage.designRevisionId ||
		attempt.design_revision_digest !== args.lineage.designRevisionDigest ||
		attempt.build_plan_id !== args.lineage.buildPlanId ||
		attempt.build_plan_digest !== args.lineage.buildPlanDigest ||
		attempt.slice_id !== args.lineage.sliceId ||
		!baseMatches
	) {
		throw new ChangeSetScopeLostError(
			"The slice attempt no longer authorizes a new change set over this exact base.",
		);
	}
}

async function bindAuthorizedAttemptAfterBegin(
	tx: Transaction<AppDatabase>,
	args: BeginChangeSetCommonArgs,
	changeSetId: string,
): Promise<void> {
	if (args.attemptAuthority === undefined) return;
	const result = await tx
		.updateTable("design_slice_attempts")
		.set({ change_set_id: changeSetId, updated_at: new Date() })
		.where("id", "=", args.lineage.attemptId)
		.where("design_session_id", "=", args.lineage.designSessionId)
		.where("status", "=", "running")
		.where("change_set_id", "is", null)
		.executeTakeFirst();
	if (!updatedExactlyOne(result)) {
		throw new ChangeSetScopeLostError(
			"The slice attempt stopped authorizing this change set before it could bind.",
		);
	}
}

/**
 * Open one app-edit change set against the app's exact current head. The
 * base sequence, Project, and canonical snapshot digest are recorded off one
 * strict authorized snapshot read under the app's share lock.
 */
export async function beginAppEditChangeSet(
	args: BeginChangeSetCommonArgs & {
		readonly appId: string;
		readonly expectedProjectId: string;
	},
): Promise<DesignChangeSet> {
	const id = crypto.randomUUID();
	return beginWithOpenAttemptFence(args.lineage.attemptId, () =>
		withAppTx(async (tx) => {
			const app = await loadAppInTransaction(tx, args.appId);
			if (app === null || app.deleted_at !== null) {
				throw new ChangeSetScopeLostError(
					"This app is no longer available, so no change set can open against it.",
				);
			}
			if (app.project_id !== args.expectedProjectId) {
				throw new ChangeSetScopeLostError(
					"This app moved to a different Project, so no change set can open against the captured scope.",
				);
			}
			const digest = canonicalJsonDigest(app.blueprint);
			await assertAuthorizedAttemptForBegin(tx, args, {
				kind: "app",
				appId: args.appId,
				seq: safePersistedSequence(app.mutation_seq, "apps.mutation_seq"),
				digest,
			});
			if (args.attemptAuthority === undefined) {
				await assertEditMembership(tx, args.ownerUserId, app.project_id);
			}
			await tx
				.insertInto("design_change_sets")
				.values({
					id,
					purpose: "slice",
					design_session_id: args.lineage.designSessionId,
					design_revision_id: args.lineage.designRevisionId,
					design_revision_digest: args.lineage.designRevisionDigest,
					build_plan_id: args.lineage.buildPlanId,
					build_plan_digest: args.lineage.buildPlanDigest,
					slice_id: args.lineage.sliceId,
					attempt_id: args.lineage.attemptId,
					kind: "app-edit",
					app_id: args.appId,
					proposed_app_id: null,
					base_seq: app.mutation_seq,
					base_project_id: app.project_id,
					base_snapshot_digest: digest,
					exclusive_kind: null,
					owner_user_id: args.ownerUserId,
					owner_run_id: args.ownerRunId,
					status: "open",
					committed_seq: null,
					committed_batch_id: null,
					committed_snapshot_digest: null,
				})
				.execute();
			await bindAuthorizedAttemptAfterBegin(tx, args, id);
			const created = await loadChangeSet(id, tx);
			if (created === undefined) {
				throw new ChangeSetIntegrityError(
					`Change set ${id} vanished inside its own creation transaction.`,
				);
			}
			return created;
		}),
	);
}

/**
 * Open one genesis change set over the canonical empty base. The caller
 * supplies the empty base's digest (`emptyGenesisBase(proposedAppId)`), so
 * rehydration proves the same identity the opener recorded.
 */
export async function beginGenesisChangeSet(
	args: BeginChangeSetCommonArgs & {
		readonly proposedAppId: string;
		readonly projectId: string;
		readonly baseSnapshotDigest: string;
	},
): Promise<DesignChangeSet> {
	const id = crypto.randomUUID();
	return beginWithOpenAttemptFence(args.lineage.attemptId, () =>
		withAppTx(async (tx) => {
			await assertAuthorizedAttemptForBegin(tx, args, {
				kind: "genesis",
				proposedAppId: args.proposedAppId,
				digest: args.baseSnapshotDigest,
			});
			if (args.attemptAuthority === undefined) {
				await assertEditMembership(tx, args.ownerUserId, args.projectId);
			}
			await tx
				.insertInto("design_change_sets")
				.values({
					id,
					purpose: "slice",
					design_session_id: args.lineage.designSessionId,
					design_revision_id: args.lineage.designRevisionId,
					design_revision_digest: args.lineage.designRevisionDigest,
					build_plan_id: args.lineage.buildPlanId,
					build_plan_digest: args.lineage.buildPlanDigest,
					slice_id: args.lineage.sliceId,
					attempt_id: args.lineage.attemptId,
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
			await bindAuthorizedAttemptAfterBegin(tx, args, id);
			const created = await loadChangeSet(id, tx);
			if (created === undefined) {
				throw new ChangeSetIntegrityError(
					`Change set ${id} vanished inside its own creation transaction.`,
				);
			}
			return created;
		}),
	);
}

/** Open the one private Blueprint candidate owned by a live design session.
 * The candidate is the design, so it deliberately carries no parallel
 * contract, plan, slice, or executor-attempt lineage. */
export async function beginDesignCandidateChangeSet(args: {
	readonly designSessionId: string;
	readonly proposedAppId: string;
	readonly projectId: string;
	readonly baseSnapshotDigest: string;
	readonly ownerUserId: string;
	readonly ownerRunId: string;
	readonly holderNonce: string;
}): Promise<DesignChangeSet> {
	const id = crypto.randomUUID();
	return withAppTx(async (tx) => {
		const carrier = await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.designSessionId,
			actorUserId: args.ownerUserId,
			expectedProjectId: args.projectId,
			holder: {
				mode: "build",
				runId: args.ownerRunId,
				nonce: args.holderNonce,
			},
		});
		if (carrier.appId !== null) {
			throw new ChangeSetScopeLostError(
				"This design session has already materialized an app.",
			);
		}
		const session = await tx
			.selectFrom("design_sessions")
			.select([
				"proposed_app_id",
				"active_candidate_change_set_id",
				"candidate_phase",
			])
			.where("id", "=", args.designSessionId)
			.executeTakeFirst();
		if (session?.proposed_app_id !== args.proposedAppId) {
			throw new ChangeSetScopeLostError(
				"The design session no longer names this proposed app.",
			);
		}
		const existing = await tx
			.selectFrom("design_change_sets")
			.select("id")
			.where("design_session_id", "=", args.designSessionId)
			.where("purpose", "=", "design-candidate")
			.where("status", "=", "open")
			.forUpdate()
			.executeTakeFirst();
		if (existing !== undefined) {
			if (session.active_candidate_change_set_id !== existing.id) {
				throw new ChangeSetIntegrityError(
					"The design session points at a different private app candidate.",
				);
			}
			if (session.candidate_phase === null) {
				throw new ChangeSetIntegrityError(
					"The private app candidate has no durable authoring phase.",
				);
			}
			const rebound = await tx
				.updateTable("design_change_sets")
				.set({
					owner_user_id: args.ownerUserId,
					owner_run_id: args.ownerRunId,
					updated_at: new Date(),
				})
				.where("id", "=", existing.id)
				.where("purpose", "=", "design-candidate")
				.where("status", "=", "open")
				.executeTakeFirst();
			if (!updatedExactlyOne(rebound)) {
				throw new ChangeSetScopeLostError(
					"The private app candidate changed while this run was resuming it.",
				);
			}
			const resumed = await loadChangeSet(existing.id, tx);
			if (
				resumed === undefined ||
				resumed.purpose !== "design-candidate" ||
				resumed.proposedAppId !== args.proposedAppId ||
				resumed.baseProjectId !== args.projectId ||
				resumed.baseSnapshotDigest !== args.baseSnapshotDigest
			) {
				throw new ChangeSetIntegrityError(
					"The durable private candidate no longer matches this design session's base.",
				);
			}
			return resumed;
		}
		await tx
			.insertInto("design_change_sets")
			.values({
				id,
				purpose: "design-candidate",
				design_session_id: args.designSessionId,
				design_revision_id: null,
				design_revision_digest: null,
				build_plan_id: null,
				build_plan_digest: null,
				slice_id: null,
				attempt_id: null,
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
		await tx
			.updateTable("design_sessions")
			.set({
				active_candidate_change_set_id: id,
				active_candidate_checkpoint_id: null,
				active_candidate_review_id: null,
				candidate_phase: "authoring",
				updated_at: new Date(),
			})
			.where("id", "=", args.designSessionId)
			.execute();
		const created = await loadChangeSet(id, tx);
		if (created === undefined) {
			throw new ChangeSetIntegrityError(
				`Design candidate ${id} vanished inside its creation transaction.`,
			);
		}
		return created;
	});
}

/**
 * Map the one-open-change-set-per-attempt partial unique violation to a
 * person-readable signal: the attempt already has an open change set to
 * REOPEN (`ChangeSetMutationWorkspace.open`), never a raw SQL error.
 */
async function beginWithOpenAttemptFence(
	attemptId: string,
	begin: () => Promise<DesignChangeSet>,
): Promise<DesignChangeSet> {
	try {
		return await begin();
	} catch (err) {
		if (
			isUniqueViolation(err) &&
			String((err as { constraint?: unknown }).constraint ?? "") ===
				"design_change_sets_open_attempt"
		) {
			throw new ChangeSetScopeLostError(
				`Slice attempt ${attemptId} already has an open change set. Reopen that change set and continue it instead of beginning another.`,
			);
		}
		throw err;
	}
}

// ── The stage transaction ──────────────────────────────────────────

export interface StageHandleAllocation {
	readonly handle: ChangeSetHandle;
	readonly uuid: Uuid;
	readonly entityKind: StagedEntityKind;
}

export type StageRequestOutcome =
	| {
			readonly kind: "stage";
			readonly mutations: AdmittedMutationBatch;
			readonly stageSlices: readonly AdmittedMutationStageSlice[];
			readonly handles: readonly StageHandleAllocation[];
			readonly intentIds: readonly DesignId[];
			readonly readSet: readonly ExternalReadDependency[];
			/** Non-null when this batch is batch-exclusive — the fence closes
			 * the set to any other step. */
			readonly exclusiveKind: ChangeSetExclusiveKind | null;
			readonly diagnostics: ChangeSetDiagnosticsSummary;
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
	/** Canonical digest of the caller's ACTUAL request (`stagingInputDigest`),
	 * computed before handle resolution. */
	readonly inputDigest: string;
	readonly expectedRevision: number;
	readonly actorUserId: string;
	readonly runId: string;
	readonly chatRunHolder?: ChatRunHolderCapability;
	/** Absolute executor deadline. The stage transaction cannot commit past it. */
	readonly deadlineAt?: number;
	readonly outcome: StageRequestOutcome;
}

export interface StageChangeSetRequestResult {
	readonly replayed: boolean;
	readonly receipt: StageRequestReceipt;
}

function isUniqueViolation(err: unknown): boolean {
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
	| "after-handle-insert"
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
	try {
		return await withAppTx(
			async (tx) => stageInTransaction(tx, args, preRead),
			args.deadlineAt === undefined
				? undefined
				: { deadlineAt: args.deadlineAt },
		);
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		/* A concurrent identical request raced past the in-transaction ledger
		 * read; the primary key caught it. Converge on the stored receipt when
		 * it matches, and latch otherwise. */
		const stored = await lookupStageRequest(args.changeSetId, args.requestId);
		if (stored === undefined) throw err;
		if (
			stored.toolName === args.toolName &&
			stored.inputDigest === args.inputDigest &&
			stored.expectedRevision === args.expectedRevision
		) {
			return { replayed: true, receipt: stored.receipt };
		}
		throw new ChangeSetRequestIdCollisionError();
	}
}

async function stageInTransaction(
	tx: Transaction<AppDatabase>,
	args: StageChangeSetRequestArgs,
	preRead: DesignChangeSet,
): Promise<StageChangeSetRequestResult> {
	const changeSet = await lockAndVerifyOpenChangeSet(tx, {
		changeSetId: args.changeSetId,
		appId: preRead.appId,
		designSessionId: preRead.appId === null ? preRead.designSessionId : null,
		actorUserId: args.actorUserId,
		runId: args.runId,
		...(args.chatRunHolder !== undefined && {
			chatRunHolder: args.chatRunHolder,
		}),
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
	if (changeSet.purpose === "design-candidate") {
		const session = await tx
			.selectFrom("design_sessions")
			.select(["active_candidate_change_set_id", "candidate_phase"])
			.where("id", "=", changeSet.designSessionId)
			.executeTakeFirst();
		if (
			session?.active_candidate_change_set_id !== changeSet.id ||
			(session.candidate_phase !== "authoring" &&
				session.candidate_phase !== "revising")
		) {
			throw new ChangeSetScopeLostError(
				"This private app candidate is not currently open for authoring.",
			);
		}
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
			handles: {},
			error: { code: outcome.code, message: outcome.message },
		} satisfies StageRequestReceipt);
		await tx
			.insertInto("design_change_set_requests")
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
	const effectiveExclusive = effectiveBatchExclusiveKind(
		changeSet.purpose,
		outcome.mutations,
	);
	if (outcome.exclusiveKind !== effectiveExclusive) {
		throw new ChangeSetIntegrityError(
			`Change set ${args.changeSetId} declared exclusive kind ${String(outcome.exclusiveKind)} for a batch whose effective kind is ${String(effectiveExclusive)}.`,
		);
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
		handles: Object.fromEntries(
			outcome.handles.map((entry) => [entry.handle, entry.uuid]),
		),
		mutationDigest,
		diagnostics: outcome.diagnostics,
	} satisfies StageRequestReceipt);

	await tx
		.insertInto("design_change_set_requests")
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
		.insertInto("design_change_set_steps")
		.values({
			change_set_id: args.changeSetId,
			ordinal,
			request_id: args.requestId,
			tool_name: args.toolName,
			mutations: encodeAdmittedMutationEnvelope(outcome.mutations).json,
			mutation_digest: mutationDigest,
			intent_ids: JSON.stringify(intentIdsSchema.parse(outcome.intentIds)),
			read_set: JSON.stringify(readSetSchema.parse(outcome.readSet)),
		})
		.execute();
	await faultBoundary("after-step-insert");
	if (outcome.stageSlices.length > 0) {
		await tx
			.insertInto("design_change_set_step_stages")
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
	if (outcome.handles.length > 0) {
		await tx
			.insertInto("design_change_set_handles")
			.values(
				outcome.handles.map((entry) => ({
					change_set_id: args.changeSetId,
					handle: entry.handle,
					uuid: entry.uuid,
					entity_kind: entry.entityKind,
					binding_request_id: args.requestId,
				})),
			)
			.execute();
	}
	await faultBoundary("after-handle-insert");
	const advance = await tx
		.updateTable("design_change_sets")
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
}): Promise<void> {
	await transitionOpenChangeSet(args, "abandoned");
}

/** Mark one open change set superseded — a newer contract/plan revision or
 *  attempt replaced it. Steps are retained for audit/retention policy. */
export async function supersedeChangeSet(args: {
	readonly changeSetId: string;
	readonly actorUserId: string;
	readonly runId: string;
}): Promise<void> {
	await transitionOpenChangeSet(args, "superseded");
}

async function transitionOpenChangeSet(
	args: {
		readonly changeSetId: string;
		readonly actorUserId: string;
		readonly runId: string;
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
			designSessionId: preRead.appId === null ? preRead.designSessionId : null,
			actorUserId: args.actorUserId,
			runId: args.runId,
		});
		const update = await tx
			.updateTable("design_change_sets")
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
