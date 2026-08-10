/**
 * Durable private design-artifact authoring. The session/app authority row is
 * locked before this mutable workspace, while its operation ledger stays
 * append-only and is never row-locked.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import {
	type DesignArtifactWriteAuthority,
	readDesignRevision,
} from "@/lib/agent/design/artifactStore";
import {
	type DesignArtifactKind,
	type DesignArtifactWorkspaceLineage,
	type DesignArtifactWorkspaceOperation,
	designArtifactWorkspaceLineageSchema,
	designArtifactWorkspaceOperationSchema,
	designWorkspaceCandidateSummary,
	initialDesignWorkspaceCandidate,
	replayDesignWorkspace,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

export type DesignArtifactWorkspaceStatus = "open" | "finalized" | "superseded";

export class DesignArtifactWorkspaceError extends Error {
	readonly name = "DesignArtifactWorkspaceError";
	constructor(
		readonly code:
			| "lineage-invalid"
			| "not-found"
			| "stale-revision"
			| "not-open"
			| "idempotency-collision",
		message: string,
	) {
		super(message);
	}
}

export interface DesignArtifactWorkspaceRecord {
	readonly id: string;
	readonly designSessionId: string;
	readonly artifactKind: DesignArtifactKind;
	readonly lineageDigest: string;
	readonly lineage: DesignArtifactWorkspaceLineage;
	readonly revision: number;
	readonly status: DesignArtifactWorkspaceStatus;
	readonly finalizedArtifactId: string | null;
	readonly createdByRunId: string;
	readonly updatedByRunId: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly finalizedAt: Date | null;
}

export interface DesignArtifactWorkspaceState {
	readonly workspace: DesignArtifactWorkspaceRecord;
	readonly operations: readonly DesignArtifactWorkspaceOperation[];
	readonly candidate: Record<string, unknown>;
	readonly sourceContract: Record<string, unknown> | null;
}

type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;

async function authorizeWorkspace(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
	authority: DesignArtifactWriteAuthority,
) {
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

async function validateLineageInTransaction(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
	lineage: DesignArtifactWorkspaceLineage,
): Promise<void> {
	const sourcePackage = await tx
		.selectFrom("design_source_packages")
		.select("id")
		.where("design_session_id", "=", designSessionId)
		.where("package_digest", "=", lineage.sourcePackageDigest)
		.executeTakeFirst();
	if (sourcePackage === undefined) {
		throw new DesignArtifactWorkspaceError(
			"lineage-invalid",
			"The workspace source package is not the exact persisted package for this design session.",
		);
	}
	const base = lineage.baseRevision;
	let baseLifecycle: string | undefined;
	if (base !== undefined) {
		const row = await tx
			.selectFrom("design_revisions")
			.select(["id", "design_session_id", "artifact_digest", "lifecycle"])
			.where("id", "=", base.id)
			.executeTakeFirst();
		if (
			row === undefined ||
			row.design_session_id !== designSessionId ||
			row.artifact_digest !== base.digest
		) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"The workspace base revision is not the exact artifact in this design session.",
			);
		}
		baseLifecycle = row.lifecycle;
	}
	if (lineage.artifactKind === "revision" && baseLifecycle !== "draft") {
		throw new DesignArtifactWorkspaceError(
			"lineage-invalid",
			"A revision workspace must descend from the reviewed draft.",
		);
	}
	if (lineage.artifactKind === "plan" && baseLifecycle !== "accepted") {
		throw new DesignArtifactWorkspaceError(
			"lineage-invalid",
			"A plan workspace must descend from the accepted revision.",
		);
	}

	const reviewIds = new Set<string>();
	for (const review of lineage.reviewArtifacts) {
		if (reviewIds.has(review.id)) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"A review artifact may appear only once in workspace lineage.",
			);
		}
		reviewIds.add(review.id);
		const row = await tx
			.selectFrom("design_reviews")
			.select([
				"id",
				"design_session_id",
				"design_revision_id",
				"artifact_digest",
			])
			.where("id", "=", review.id)
			.executeTakeFirst();
		if (
			row === undefined ||
			row.design_session_id !== designSessionId ||
			row.design_revision_id !== base?.id ||
			row.artifact_digest !== review.digest
		) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"The workspace review lineage does not belong to its exact base draft.",
			);
		}
	}
}

async function ensureOpenWorkspaceInTransaction(args: {
	tx: Transaction<AppDatabase>;
	designSessionId: string;
	lineage: DesignArtifactWorkspaceLineage;
	authority: DesignArtifactWriteAuthority;
}): Promise<string> {
	const lineage = designArtifactWorkspaceLineageSchema.parse(args.lineage);
	const lineageDigest = canonicalJsonDigest(lineage);
	await validateLineageInTransaction(args.tx, args.designSessionId, lineage);

	const current = await args.tx
		.selectFrom("design_artifact_workspaces")
		.select(["id", "artifact_kind", "lineage_digest"])
		.where("design_session_id", "=", args.designSessionId)
		.where("status", "=", "open")
		.forUpdate()
		.execute();
	const exact = current.find(
		(row) =>
			row.artifact_kind === lineage.artifactKind &&
			row.lineage_digest === lineageDigest,
	);
	if (exact !== undefined && current.length === 1) return exact.id;

	if (current.length > 0) {
		await args.tx
			.updateTable("design_artifact_workspaces")
			.set({
				status: "superseded",
				updated_by_run_id: args.authority.runId,
				updated_at: new Date(),
			})
			.where("design_session_id", "=", args.designSessionId)
			.where("status", "=", "open")
			.execute();
	}

	const id = crypto.randomUUID();
	await args.tx
		.insertInto("design_artifact_workspaces")
		.values({
			id,
			design_session_id: args.designSessionId,
			artifact_kind: lineage.artifactKind,
			lineage_digest: lineageDigest,
			lineage: JSON.stringify(lineage),
			revision: 0,
			status: "open",
			finalized_artifact_id: null,
			created_by_run_id: args.authority.runId,
			updated_by_run_id: args.authority.runId,
			finalized_at: null,
		})
		.execute();
	return id;
}

function parseStatus(value: string): DesignArtifactWorkspaceStatus {
	if (value === "open" || value === "finalized" || value === "superseded") {
		return value;
	}
	throw new DesignArtifactWorkspaceError(
		"not-found",
		"A design artifact workspace has an unknown persisted status.",
	);
}

async function readWorkspaceRecord(
	db: Db,
	workspaceId: string,
): Promise<DesignArtifactWorkspaceRecord> {
	const row = await db
		.selectFrom("design_artifact_workspaces")
		.select([
			"id",
			"design_session_id",
			"artifact_kind",
			"lineage_digest",
			"revision",
			"status",
			"finalized_artifact_id",
			"created_by_run_id",
			"updated_by_run_id",
			"created_at",
			"updated_at",
			"finalized_at",
		])
		.select(
			sql<string>`${sql.ref("design_artifact_workspaces.lineage")}::text`.as(
				"lineage_text",
			),
		)
		.where("id", "=", workspaceId)
		.executeTakeFirst();
	if (row === undefined) {
		throw new DesignArtifactWorkspaceError(
			"not-found",
			"The design artifact workspace no longer exists.",
		);
	}
	const lineage = designArtifactWorkspaceLineageSchema.parse(
		parsePersistedJsonText(
			row.lineage_text,
			`design_artifact_workspaces.lineage for ${workspaceId}`,
		),
	);
	if (
		lineage.artifactKind !== row.artifact_kind ||
		canonicalJsonDigest(lineage) !== row.lineage_digest
	) {
		throw new DesignArtifactWorkspaceError(
			"lineage-invalid",
			"The stored workspace lineage disagrees with its relational identity.",
		);
	}
	return {
		id: row.id,
		designSessionId: row.design_session_id,
		artifactKind: lineage.artifactKind,
		lineageDigest: row.lineage_digest,
		lineage,
		revision: safePersistedSequence(
			row.revision,
			`design_artifact_workspaces.revision for ${workspaceId}`,
		),
		status: parseStatus(row.status),
		finalizedArtifactId: row.finalized_artifact_id,
		createdByRunId: row.created_by_run_id,
		updatedByRunId: row.updated_by_run_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		finalizedAt: row.finalized_at,
	};
}

async function readWorkspaceOperations(
	db: Db,
	workspaceId: string,
): Promise<DesignArtifactWorkspaceOperation[]> {
	const rows = await db
		.selectFrom("design_artifact_workspace_steps")
		.select(["revision"])
		.select(
			sql<string>`${sql.ref("design_artifact_workspace_steps.operation")}::text`.as(
				"operation_text",
			),
		)
		.where("workspace_id", "=", workspaceId)
		.orderBy("revision", "asc")
		.execute();
	return rows.map((row, index) => {
		const revision = safePersistedSequence(
			row.revision,
			`design_artifact_workspace_steps.revision for ${workspaceId}`,
		);
		if (revision !== index + 1) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"The design workspace operation ledger is not contiguous.",
			);
		}
		return designArtifactWorkspaceOperationSchema.parse(
			parsePersistedJsonText(
				row.operation_text,
				`design_artifact_workspace_steps.operation for ${workspaceId} revision ${String(row.revision)}`,
			),
		);
	});
}

async function loadWorkspaceState(args: {
	workspaceId: string;
	designSessionId: string;
	authority: DesignArtifactWriteAuthority;
}): Promise<DesignArtifactWorkspaceState> {
	const { workspace, operations } = await withAppTx(async (tx) => {
		await authorizeWorkspace(tx, args.designSessionId, args.authority);
		const workspace = await readWorkspaceRecord(tx, args.workspaceId);
		if (workspace.designSessionId !== args.designSessionId) {
			throw new DesignArtifactWorkspaceError(
				"not-found",
				"The design artifact workspace does not belong to this session.",
			);
		}
		const operations = await readWorkspaceOperations(tx, args.workspaceId);
		if (operations.length !== workspace.revision) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"The design workspace revision disagrees with its operation ledger.",
			);
		}
		return { workspace, operations };
	});
	let sourceContract: Record<string, unknown> | null = null;
	const base = workspace.lineage.baseRevision;
	if (base !== undefined) {
		const revision = await readDesignRevision(base.id);
		if (
			revision === null ||
			revision.designSessionId !== workspace.designSessionId ||
			revision.artifactDigest !== base.digest
		) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"The revision workspace base no longer verifies.",
			);
		}
		sourceContract = revision.envelope.payload as unknown as Record<
			string,
			unknown
		>;
	} else if (workspace.artifactKind !== "contract") {
		throw new DesignArtifactWorkspaceError(
			"lineage-invalid",
			"The design workspace lost its required base revision.",
		);
	}
	const candidate =
		operations.length === 0
			? initialDesignWorkspaceCandidate(
					workspace.artifactKind,
					sourceContract ?? undefined,
				)
			: replayDesignWorkspace({
					kind: workspace.artifactKind,
					...(sourceContract !== null && { baseContract: sourceContract }),
					operations,
				});
	return { workspace, operations, candidate, sourceContract };
}

export async function openDesignArtifactWorkspace(args: {
	designSessionId: string;
	lineage: DesignArtifactWorkspaceLineage;
	authority: DesignArtifactWriteAuthority;
}): Promise<DesignArtifactWorkspaceState> {
	const workspaceId = await withAppTx(async (tx) => {
		await authorizeWorkspace(tx, args.designSessionId, args.authority);
		return ensureOpenWorkspaceInTransaction({ tx, ...args });
	});
	return loadWorkspaceState({
		workspaceId,
		designSessionId: args.designSessionId,
		authority: args.authority,
	});
}

export async function loadDesignArtifactWorkspaceSummary(args: {
	designSessionId: string;
	lineage: DesignArtifactWorkspaceLineage;
	authority: DesignArtifactWriteAuthority;
}): Promise<{
	workspaceId: string;
	revision: number;
	stepCount: number;
	counts: Record<string, number>;
	missingRootFields: string[];
} | null> {
	const lineage = designArtifactWorkspaceLineageSchema.parse(args.lineage);
	const digest = canonicalJsonDigest(lineage);
	const workspaceId = await withAppTx(async (tx) => {
		await authorizeWorkspace(tx, args.designSessionId, args.authority);
		const row = await tx
			.selectFrom("design_artifact_workspaces")
			.select(["id"])
			.where("design_session_id", "=", args.designSessionId)
			.where("artifact_kind", "=", lineage.artifactKind)
			.where("lineage_digest", "=", digest)
			.where("status", "=", "open")
			.executeTakeFirst();
		return row?.id ?? null;
	});
	if (workspaceId === null) return null;
	const state = await loadWorkspaceState({
		workspaceId,
		designSessionId: args.designSessionId,
		authority: args.authority,
	});
	return {
		workspaceId,
		revision: state.workspace.revision,
		stepCount: state.operations.length,
		...designWorkspaceCandidateSummary(
			state.workspace.artifactKind,
			state.candidate,
		),
	};
}

export async function stageDesignArtifactWorkspace(args: {
	designSessionId: string;
	lineage: DesignArtifactWorkspaceLineage;
	authority: DesignArtifactWriteAuthority;
	toolCallId: string;
	expectedRevision: number;
	operation: DesignArtifactWorkspaceOperation;
}): Promise<{ state: DesignArtifactWorkspaceState; deduplicated: boolean }> {
	const operation = designArtifactWorkspaceOperationSchema.parse(
		args.operation,
	);
	if (operation.kind !== args.lineage.artifactKind) {
		throw new DesignArtifactWorkspaceError(
			"lineage-invalid",
			"The staged operation does not match the workspace artifact kind.",
		);
	}
	if (args.toolCallId.trim().length === 0) {
		throw new DesignArtifactWorkspaceError(
			"idempotency-collision",
			"A staged operation requires its provider tool-call identity.",
		);
	}
	// The provider call includes its optimistic revision fence. A replay is
	// idempotent only when that entire admitted input is byte-for-byte
	// equivalent after canonicalization, not merely when its mutation matches.
	const inputDigest = canonicalJsonDigest({
		expectedRevision: args.expectedRevision,
		operation,
	});
	const result = await withAppTx(async (tx) => {
		await authorizeWorkspace(tx, args.designSessionId, args.authority);
		const workspaceId = await ensureOpenWorkspaceInTransaction({ tx, ...args });
		const workspace = await tx
			.selectFrom("design_artifact_workspaces")
			.select(["revision", "status"])
			.where("id", "=", workspaceId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		const duplicate = await tx
			.selectFrom("design_artifact_workspace_steps")
			.select(["input_digest", "revision"])
			.where("workspace_id", "=", workspaceId)
			.where("tool_call_id", "=", args.toolCallId)
			.executeTakeFirst();
		if (duplicate !== undefined) {
			if (duplicate.input_digest !== inputDigest) {
				throw new DesignArtifactWorkspaceError(
					"idempotency-collision",
					"This tool-call identity was already used for different staged input.",
				);
			}
			return { workspaceId, deduplicated: true };
		}
		if (workspace.status !== "open") {
			throw new DesignArtifactWorkspaceError(
				"not-open",
				"This design workspace is no longer open.",
			);
		}
		const revision = safePersistedSequence(
			workspace.revision,
			`design_artifact_workspaces.revision for ${workspaceId}`,
		);
		if (revision !== args.expectedRevision) {
			throw new DesignArtifactWorkspaceError(
				"stale-revision",
				`The workspace is at revision ${revision}, not ${args.expectedRevision}. Inspect its current state before staging more work.`,
			);
		}
		const next = revision + 1;
		await tx
			.insertInto("design_artifact_workspace_steps")
			.values({
				workspace_id: workspaceId,
				revision: next,
				tool_call_id: args.toolCallId,
				input_digest: inputDigest,
				operation: JSON.stringify(operation),
				created_by_run_id: args.authority.runId,
			})
			.execute();
		await tx
			.updateTable("design_artifact_workspaces")
			.set({
				revision: next,
				updated_by_run_id: args.authority.runId,
				updated_at: new Date(),
			})
			.where("id", "=", workspaceId)
			.where("status", "=", "open")
			.where("revision", "=", revision)
			.executeTakeFirstOrThrow();
		return { workspaceId, deduplicated: false };
	});
	return {
		state: await loadWorkspaceState({
			workspaceId: result.workspaceId,
			designSessionId: args.designSessionId,
			authority: args.authority,
		}),
		deduplicated: result.deduplicated,
	};
}

export async function inspectDesignArtifactWorkspace(args: {
	designSessionId: string;
	lineage: DesignArtifactWorkspaceLineage;
	authority: DesignArtifactWriteAuthority;
	expectedRevision: number;
}): Promise<DesignArtifactWorkspaceState> {
	const state = await openDesignArtifactWorkspace(args);
	if (state.workspace.revision !== args.expectedRevision) {
		throw new DesignArtifactWorkspaceError(
			"stale-revision",
			`The workspace is at revision ${state.workspace.revision}, not ${args.expectedRevision}. Use the current revision in the next inspection.`,
		);
	}
	return state;
}
