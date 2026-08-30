/**
 * Durable private design-artifact authoring. The session/app authority row is
 * locked before this mutable workspace, while its operation ledger stays
 * append-only and is never row-locked.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import {
	type DesignArtifactWriteAuthority,
	isCumulativeDesignSourcePackageExtensionInTransaction,
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
import { designIdentityCollisions } from "@/lib/agent/design/graph";
import {
	type DesignIdentityHandleEntityKind,
	designIdentityHandleEntityKindSchema,
} from "@/lib/agent/design/ids";
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
			| "idempotency-collision"
			| "partial-invalid",
		message: string,
		readonly issueCount?: number,
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
	readonly handleBindings: readonly DesignIdentityHandleBinding[];
	readonly candidate: Record<string, unknown>;
	readonly sourceContract: Record<string, unknown> | null;
}

export interface DesignIdentityHandleBinding {
	readonly handle: string;
	readonly designId: string;
	readonly entityKind: DesignIdentityHandleEntityKind;
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
		.select(
			sql<string>`${sql.ref("design_artifact_workspaces.lineage")}::text`.as(
				"lineage_text",
			),
		)
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

	/* A proven cumulative answer extends the source package without invalidating
	 * accepted work in the same artifact phase. Rebind only when content-free
	 * projection digests prove every old unit is an unchanged prefix; stale or
	 * changed source falls through and supersedes the workspace. A
	 * phase/base/review change is real ancestry drift and also supersedes it. */
	const ancestryDigest = (value: DesignArtifactWorkspaceLineage): string =>
		canonicalJsonDigest({
			schemaVersion: value.schemaVersion,
			artifactKind: value.artifactKind,
			baseRevision: value.baseRevision,
			reviewArtifacts: value.reviewArtifacts,
		});
	let rebindable: (typeof current)[number] | undefined;
	for (const row of current) {
		const persisted = designArtifactWorkspaceLineageSchema.parse(
			parsePersistedJsonText(
				row.lineage_text,
				`design_artifact_workspaces.lineage for ${row.id}`,
			),
		);
		if (canonicalJsonDigest(persisted) !== row.lineage_digest) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"The open design workspace lineage no longer matches its digest.",
			);
		}
		if (ancestryDigest(persisted) !== ancestryDigest(lineage)) continue;
		if (
			await isCumulativeDesignSourcePackageExtensionInTransaction(args.tx, {
				designSessionId: args.designSessionId,
				previousPackageDigest: persisted.sourcePackageDigest,
				nextPackageDigest: lineage.sourcePackageDigest,
			})
		) {
			rebindable = row;
			break;
		}
	}
	if (rebindable !== undefined && current.length === 1) {
		await args.tx
			.updateTable("design_artifact_workspaces")
			.set({
				lineage_digest: lineageDigest,
				lineage: JSON.stringify(lineage),
				updated_by_run_id: args.authority.runId,
				updated_at: new Date(),
			})
			.where("id", "=", rebindable.id)
			.where("status", "=", "open")
			.executeTakeFirstOrThrow();
		return rebindable.id;
	}

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

async function selectHandleBindings(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
): Promise<DesignIdentityHandleBinding[]> {
	const rows = await tx
		.selectFrom("design_identity_handles")
		.select(["handle", "design_id", "entity_kind"])
		.where("design_session_id", "=", designSessionId)
		.orderBy("created_at", "asc")
		.orderBy("handle", "asc")
		.execute();
	return rows.map((binding) => ({
		handle: binding.handle,
		designId: binding.design_id,
		entityKind: designIdentityHandleEntityKindSchema.parse(binding.entity_kind),
	}));
}

/**
 * The session's durable identity-handle ledger, read-only. The reviewer call
 * loads this to render the contract in handle vocabulary and to resolve the
 * handles the reviewer emits — one load, both directions. Deliberately NOT
 * `openDesignArtifactWorkspace`: that call creates a workspace row when none
 * is open, and a review must never mutate workspace state to read symbols.
 */
export async function readDesignIdentityHandleBindings(args: {
	designSessionId: string;
	authority: DesignArtifactWriteAuthority;
}): Promise<readonly DesignIdentityHandleBinding[]> {
	return withAppTx(async (tx) => {
		await authorizeWorkspace(tx, args.designSessionId, args.authority);
		return selectHandleBindings(tx, args.designSessionId);
	});
}

async function loadWorkspaceState(args: {
	workspaceId: string;
	designSessionId: string;
	authority: DesignArtifactWriteAuthority;
}): Promise<DesignArtifactWorkspaceState> {
	const { workspace, operations, handleBindings } = await withAppTx(
		async (tx) => {
			await authorizeWorkspace(tx, args.designSessionId, args.authority);
			const workspace = await readWorkspaceRecord(tx, args.workspaceId);
			if (workspace.designSessionId !== args.designSessionId) {
				throw new DesignArtifactWorkspaceError(
					"not-found",
					"The design artifact workspace does not belong to this session.",
				);
			}
			const operations = await readWorkspaceOperations(tx, args.workspaceId);
			const handleBindings = await selectHandleBindings(
				tx,
				args.designSessionId,
			);
			if (operations.length !== workspace.revision) {
				throw new DesignArtifactWorkspaceError(
					"lineage-invalid",
					"The design workspace revision disagrees with its operation ledger.",
				);
			}
			return { workspace, operations, handleBindings };
		},
	);
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
	return { workspace, operations, handleBindings, candidate, sourceContract };
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
	handleBindings?: readonly DesignIdentityHandleBinding[];
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
	// Artifact kind and revision fencing are server-owned. A provider replay is
	// idempotent when its semantic operation and handle bindings are identical;
	// the current revision may have advanced because later calls already ran.
	const inputDigest = canonicalJsonDigest({
		operation,
		handleBindings: args.handleBindings ?? [],
	});
	let baseContract: Record<string, unknown> | undefined;
	if (operation.kind === "revision") {
		const base = args.lineage.baseRevision;
		const revision =
			base === undefined ? null : await readDesignRevision(base.id);
		if (
			base === undefined ||
			revision === null ||
			revision.designSessionId !== args.designSessionId ||
			revision.artifactDigest !== base.digest
		) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"The revision workspace base no longer verifies.",
			);
		}
		baseContract = revision.envelope.payload as unknown as Record<
			string,
			unknown
		>;
	}
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
			return { workspaceId, deduplicated: true, state: undefined };
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
				"This design update lost an ordering race. The workspace is intact; retry only this semantic call.",
			);
		}
		for (const binding of args.handleBindings ?? []) {
			const existing = await tx
				.selectFrom("design_identity_handles")
				.select(["handle", "design_id", "entity_kind"])
				.where("design_session_id", "=", args.designSessionId)
				.where((eb) =>
					eb.or([
						eb("handle", "=", binding.handle),
						eb("design_id", "=", binding.designId),
					]),
				)
				.executeTakeFirst();
			if (existing !== undefined) {
				const sameIdentity =
					existing.handle === binding.handle &&
					existing.design_id === binding.designId;
				/* A reference is satisfied by any binding of the same identity,
				 * and a declaration UPGRADES a row first seen as a reference —
				 * the deterministic mint made their identities equal already,
				 * so only the recorded kind moves. */
				if (sameIdentity && binding.entityKind === "referenced") continue;
				if (sameIdentity && existing.entity_kind === "referenced") {
					await tx
						.updateTable("design_identity_handles")
						.set({ entity_kind: binding.entityKind })
						.where("design_session_id", "=", args.designSessionId)
						.where("handle", "=", binding.handle)
						.execute();
					continue;
				}
				if (!sameIdentity || existing.entity_kind !== binding.entityKind) {
					throw new DesignArtifactWorkspaceError(
						"partial-invalid",
						`The design handle ${binding.handle} is already bound to another ${existing.entity_kind} identity.`,
						1,
					);
				}
				continue;
			}
			await tx
				.insertInto("design_identity_handles")
				.values({
					design_session_id: args.designSessionId,
					handle: binding.handle,
					design_id: binding.designId,
					entity_kind: binding.entityKind,
					workspace_id: workspaceId,
					tool_call_id: args.toolCallId,
					created_by_run_id: args.authority.runId,
				})
				.execute();
		}
		const priorOperations = await readWorkspaceOperations(tx, workspaceId);
		if (priorOperations.length !== revision) {
			throw new DesignArtifactWorkspaceError(
				"lineage-invalid",
				"The design workspace revision disagrees with its operation ledger.",
			);
		}
		const operations = [...priorOperations, operation];
		const candidate = replayDesignWorkspace({
			kind: operation.kind,
			...(baseContract !== undefined && { baseContract }),
			operations,
		});
		const collisions = designIdentityCollisions(candidate);
		if (collisions.length > 0) {
			const first = collisions[0];
			throw new DesignArtifactWorkspaceError(
				"partial-invalid",
				`The staged ${operation.kind} reuses ${collisions.length} design ${collisions.length === 1 ? "identity" : "identities"}. ${first?.path.join(".")} is already used at ${first?.priorPath.join(".")}. Give every declared actor, record, property, workflow, list, access rule, navigation item, module/form composition, composition section/item, requirement, decision, assumption, and question its own handle.`,
				collisions.length,
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
		/* Assemble the returned state HERE, from what this transaction already
		 * read and replayed: the accepted operations plus this one, the ledger
		 * after its binding writes, and the record after its revision bump. A
		 * post-commit reload would re-read and re-replay the whole operation
		 * ledger a second time on every accepted stage call. */
		const state: DesignArtifactWorkspaceState = {
			workspace: await readWorkspaceRecord(tx, workspaceId),
			operations,
			handleBindings: await selectHandleBindings(tx, args.designSessionId),
			candidate,
			sourceContract: baseContract ?? null,
		};
		return { workspaceId, deduplicated: false, state };
	});
	if (result.state !== undefined) {
		return { state: result.state, deduplicated: false };
	}
	/* Deduplicated replay: the stored ledger is the authority for what the
	 * original call staged, so read the state back in full. */
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
			"The design workspace changed during this server operation. Retry the operation; the saved semantic updates are intact.",
		);
	}
	return state;
}
