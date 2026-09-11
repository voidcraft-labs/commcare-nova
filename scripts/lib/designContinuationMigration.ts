/** One-time data conversion. No runtime reader imports this module. */
import type { UIMessage } from "ai";
import { sql } from "kysely";
import { z } from "zod";
import { designTurnProvenanceId } from "@/lib/agent/build/designLoopRunner";
import { readDesignRevision } from "@/lib/agent/design/artifactStore";
import {
	type DesignArtifactWorkspaceOperation,
	designArtifactWorkspaceLineageSchema,
	initialDesignWorkspaceCandidate,
	normalizeStoredDesignArtifactWorkspaceOperation,
	prepareDesignArtifactWorkspaceOperationForStorage,
	replayDesignWorkspace,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	canonicalMenuOrder,
	type DesignMenu,
	type DesignMenuPlacement,
} from "@/lib/agent/design/modulePlacement";
import {
	durableModelValueDigest,
	rehydrateModelMessage,
} from "@/lib/agent/modelMessagePersistence";
import { lockActorGenerationGate } from "@/lib/db/actorGenerationGate";
import { assertProjectCapabilityInTransaction } from "@/lib/db/canonicalCommitKernel";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

const MIGRATION = "design-placement-turns-20260911";

/** Reproduce the pre-migration array semantics only in the conversion script.
 * Original operation bytes stay intact. Appended ordinary placement operations
 * make the new replay reproduce the same intended menu tree and sibling order. */
export function planWorkspacePlacementMigration(args: {
	kind: "contract" | "revision";
	baseContract?: Record<string, unknown>;
	operations: readonly DesignArtifactWorkspaceOperation[];
}): DesignArtifactWorkspaceOperation[] {
	const candidate = initialDesignWorkspaceCandidate(
		args.kind,
		args.baseContract,
	);
	const apply = (
		collection: string,
		upserts: readonly unknown[],
		removeIds: readonly string[],
	) => {
		const identity = collection === "dispositions" ? "findingId" : "id";
		const items = (
			(candidate[collection] ?? []) as Record<string, unknown>[]
		).filter((item) => !removeIds.includes(String(item[identity])));
		for (const item of upserts as Record<string, unknown>[]) {
			const index = items.findIndex(
				(prior) => prior[identity] === item[identity],
			);
			if (index < 0) items.push(item);
			else items[index] = item;
		}
		candidate[collection] = items;
	};
	for (const operation of args.operations) {
		if (operation.root !== undefined) Object.assign(candidate, operation.root);
		for (const collection of operation.collections)
			apply(collection.collection, collection.upserts, collection.removeIds);
		if (operation.placements !== undefined) {
			// A prior migration or current placement is already explicit intent.
			const projected = replayDesignWorkspace({
				kind: "contract",
				baseContract: candidate,
				operations: [
					{
						kind: "contract",
						collections: [],
						placements: operation.placements,
					},
				],
			});
			Object.assign(candidate, projected);
		}
		if (operation.kind === "revision" && operation.dispositions !== undefined)
			apply(
				"dispositions",
				operation.dispositions.upserts,
				operation.dispositions.removeIds,
			);
	}
	const normalized = replayDesignWorkspace({
		kind: "contract",
		baseContract: candidate,
		operations: [],
	});
	const targetMenus = canonicalMenuOrder(
		(normalized.moduleCompositions ?? []) as DesignMenu[],
	);
	const target = { ...normalized, moduleCompositions: targetMenus };
	const current = replayDesignWorkspace(args);
	if (canonicalJsonDigest(current) === canonicalJsonDigest(target)) return [];
	const preceding = new Map<string | undefined, string>();
	const placements: DesignMenuPlacement[] = targetMenus.map((menu) => {
		const placement = {
			moduleId: menu.id,
			parentModuleId: menu.parentModuleCompositionId,
			afterModuleId: preceding.get(menu.parentModuleCompositionId),
		};
		preceding.set(menu.parentModuleCompositionId, menu.id);
		return placement;
	});
	const operations: DesignArtifactWorkspaceOperation[] = [];
	for (let offset = 0; offset < placements.length; offset += 32) {
		operations.push(
			normalizeStoredDesignArtifactWorkspaceOperation({
				storageVersion: 2,
				operation: {
					kind: args.kind,
					collections: [],
					placements: placements.slice(offset, offset + 32),
				},
			}),
		);
	}
	const projected = replayDesignWorkspace({
		...args,
		operations: [...args.operations, ...operations],
	});
	if (canonicalJsonDigest(projected) !== canonicalJsonDigest(target))
		throw new Error(
			"Placement migration did not preserve the saved workspace meaning.",
		);
	return operations;
}

type Step = {
	context_id: string;
	step_key: string;
	event_digest: string;
	request_digest: string | null;
	created_at: Date;
	created_by_run_id: string;
	completedResponseDigest?: string;
};
type Item = {
	context_id: string;
	append_key: string;
	item_digest: string;
	message: unknown;
	created_at: Date;
	ordinal: string | number | bigint;
};

export function inferDesignStepTurn(
	step: Step,
	items: readonly Item[],
	threads: readonly UIMessage[][],
): string | null {
	const canonicalTurn = (turn: string): string => {
		for (const transcript of threads) {
			const index = transcript.findIndex((message) => message.id === turn);
			if (index >= 0)
				return designTurnProvenanceId(transcript.slice(0, index + 1), turn);
		}
		return turn;
	};
	const responses = new Set<string>();
	for (const item of items) {
		if (
			item.context_id !== step.context_id ||
			step.completedResponseDigest === undefined ||
			!item.append_key.endsWith(`:${step.completedResponseDigest}`)
		)
			continue;
		const suffix = `:${step.step_key}:`;
		const index = item.append_key.lastIndexOf(suffix);
		if (index < 0) continue;
		const prefix = item.append_key.slice(0, index);
		if (prefix.startsWith("design-wait:"))
			responses.add(canonicalTurn(prefix.slice("design-wait:".length)));
		if (prefix.startsWith("design-response:")) {
			const turnAndPhase = prefix.slice("design-response:".length);
			const phaseIndex = turnAndPhase.lastIndexOf(":");
			if (
				["author", "review", "revision", "awaiting-input"].includes(
					turnAndPhase.slice(phaseIndex + 1),
				)
			)
				responses.add(canonicalTurn(turnAndPhase.slice(0, phaseIndex)));
		}
	}
	if (responses.size === 1) return [...responses][0] ?? null;
	if (responses.size > 1)
		throw new Error(
			`Conflicting turn receipts for ${step.context_id}/${step.step_key}`,
		);
	const preceding = items
		.filter(
			(item) =>
				item.context_id === step.context_id &&
				item.created_at <= step.created_at &&
				(item.append_key.startsWith("ui-turn:") ||
					item.append_key.startsWith("seed-through:") ||
					item.append_key.startsWith("answer:")),
		)
		.sort((a, b) => Number(b.ordinal) - Number(a.ordinal));
	const latest = preceding[0];
	if (latest === undefined) return null;
	if (latest.append_key.startsWith("ui-turn:"))
		return canonicalTurn(latest.append_key.slice("ui-turn:".length));
	if (latest.append_key.startsWith("seed-through:")) {
		const id = latest.append_key.slice("seed-through:".length);
		// A seed ending in an assistant may contain question rounds. Refuse an
		// ambiguous historical snapshot rather than guessing from a later answer.
		if (
			threads.some((messages) =>
				messages.some(
					(message) => message.id === id && message.role === "user",
				),
			)
		)
			return id;
		return null;
	}
	const message = rehydrateModelMessage(latest.message);
	if (message.role !== "tool" || !Array.isArray(message.content)) return null;
	const result = message.content.findLast(
		(part) => part.type === "tool-result" && part.toolName === "askQuestions",
	);
	if (result?.type !== "tool-result" || result.output.type !== "json")
		return null;
	for (const transcript of threads)
		for (const ui of transcript)
			for (const part of ui.parts) {
				if (
					ui.role === "assistant" &&
					part.type === "tool-askQuestions" &&
					part.state === "output-available" &&
					part.toolCallId === result.toolCallId &&
					canonicalJsonDigest(part.output) ===
						canonicalJsonDigest(result.output.value)
				)
					return `${ui.id}:answer:${canonicalJsonDigest({ toolCallId: part.toolCallId, output: part.output })}`;
			}
	return null;
}

export async function scanDesignContinuationMigration() {
	const db = await getAppDb();
	return db
		.selectFrom("design_sessions")
		.select([
			"id",
			"owner_user_id",
			"project_id",
			"updated_at",
			"run_id",
			"res_run_id",
			"continuation_recovery",
		])
		.where((eb) =>
			eb.or([
				eb.exists(
					eb
						.selectFrom("design_model_contexts as context")
						.innerJoin(
							"design_model_steps as step",
							"step.context_id",
							"context.id",
						)
						.select("context.id")
						.whereRef("context.design_session_id", "=", "design_sessions.id")
						.where("context.context_kind", "=", "design")
						.where("step.event_kind", "=", "started")
						.where("step.turn_provenance_id", "is", null),
				),
				eb.and([
					sql<boolean>`continuation_recovery->>'migration' IS DISTINCT FROM ${MIGRATION}`,
					eb.exists(
						eb
							.selectFrom("design_artifact_workspaces as workspace")
							.select("workspace.id")
							.where("workspace.status", "=", "open")
							.whereRef(
								"workspace.design_session_id",
								"=",
								"design_sessions.id",
							),
					),
					eb.not(
						eb.exists(
							eb
								.selectFrom("design_model_contexts as context")
								.innerJoin(
									"design_model_steps as step",
									"step.context_id",
									"context.id",
								)
								.select("context.id")
								.whereRef(
									"context.design_session_id",
									"=",
									"design_sessions.id",
								)
								.where("context.context_kind", "=", "design")
								.where("step.event_kind", "=", "started"),
						),
					),
				]),
			]),
		)
		.orderBy("updated_at")
		.execute();
}

export async function migrateDesignContinuation(args: {
	designSessionId: string;
	actorUserId: string;
	expectedUpdatedAt: string;
	execute: boolean;
	turnAssignments?: Readonly<Record<string, string>>;
}) {
	const expected = new Date(
		z.iso.datetime({ offset: true }).parse(args.expectedUpdatedAt),
	).toISOString();
	// Immutable artifact reads verify their original seals before use. The
	// transaction below rechecks every mutable workspace and session fact.
	const db = await getAppDb();
	const sourceRows = await db
		.selectFrom("design_artifact_workspaces")
		.select(["lineage"])
		.where("design_session_id", "=", args.designSessionId)
		.where("status", "=", "open")
		.execute();
	const bases = new Map<string, Record<string, unknown>>();
	for (const row of sourceRows) {
		const lineage = designArtifactWorkspaceLineageSchema.parse(row.lineage);
		if (lineage.baseRevision !== undefined) {
			const revision = await readDesignRevision(lineage.baseRevision.id);
			if (
				revision === null ||
				revision.designSessionId !== args.designSessionId ||
				revision.artifactDigest !== lineage.baseRevision.digest
			)
				throw new Error("Workspace base revision no longer verifies.");
			bases.set(lineage.baseRevision.id, revision.envelope.payload);
		}
	}
	return withAppTx(async (tx) => {
		await lockActorGenerationGate(tx, args.actorUserId);
		const mapping = await tx
			.selectFrom("design_sessions")
			.select("app_id")
			.where("id", "=", args.designSessionId)
			.executeTakeFirstOrThrow();
		const app =
			mapping.app_id === null
				? null
				: await tx
						.selectFrom("apps")
						.select([
							"id",
							"project_id",
							"run_id",
							"run_holder_nonce",
							"res_run_id",
							"lock_run_id",
						])
						.where("id", "=", mapping.app_id)
						.forUpdate()
						.executeTakeFirstOrThrow();
		if (
			app !== null &&
			(app.run_id !== null ||
				app.run_holder_nonce !== null ||
				app.res_run_id !== null ||
				app.lock_run_id !== null)
		)
			throw new Error(
				"The materialized app must have no run holder or reservation before migration.",
			);
		const session = await tx
			.selectFrom("design_sessions")
			.selectAll()
			.where("id", "=", args.designSessionId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		if (
			session.app_id !== mapping.app_id ||
			(app !== null && app.project_id !== session.project_id)
		)
			throw new Error("The design scope changed during migration.");
		if (session.owner_user_id !== args.actorUserId)
			throw new Error("Migration must name the design owner.");
		await assertProjectCapabilityInTransaction(
			tx,
			args.actorUserId,
			session.project_id,
			"edit",
			"The design owner no longer has Project edit access.",
		);
		if (
			session.run_id !== null ||
			session.run_holder_nonce !== null ||
			session.res_run_id !== null
		)
			throw new Error(
				"The design must have no run holder or reservation before migration.",
			);
		if (session.updated_at.toISOString() !== expected) {
			const receipt = session.continuation_recovery;
			if (
				receipt?.migration === MIGRATION &&
				receipt.expectedUpdatedAt === expected &&
				receipt.completedAt === session.updated_at.toISOString()
			)
				return {
					deduplicated: true,
					steps: 0,
					workspaces: 0,
					unresolved: [] as string[],
				};
			throw new Error("The design changed after inspection. Scan it again.");
		}
		const contexts = await tx
			.selectFrom("design_model_contexts")
			.select("id")
			.where("design_session_id", "=", session.id)
			.where("context_kind", "=", "design")
			.execute();
		const contextIds = contexts.map((context) => context.id);
		const steps =
			contextIds.length === 0
				? []
				: await tx
						.selectFrom("design_model_steps")
						.selectAll()
						.where("context_id", "in", contextIds)
						.where("event_kind", "=", "started")
						.where("turn_provenance_id", "is", null)
						.execute();
		if (
			steps.length === 0 &&
			session.continuation_recovery?.migration === MIGRATION
		)
			return {
				deduplicated: true,
				steps: 0,
				workspaces: 0,
				unresolved: [] as string[],
			};
		if (steps.length === 0 && contextIds.length > 0) {
			const modernStart = await tx
				.selectFrom("design_model_steps")
				.select("step_key")
				.where("context_id", "in", contextIds)
				.where("event_kind", "=", "started")
				.where("turn_provenance_id", "is not", null)
				.executeTakeFirst();
			if (modernStart !== undefined)
				return {
					deduplicated: true,
					steps: 0,
					workspaces: 0,
					unresolved: [] as string[],
				};
		}
		const items =
			contextIds.length === 0
				? []
				: await tx
						.selectFrom("design_model_context_items")
						.selectAll()
						.where("context_id", "in", contextIds)
						.execute();
		for (const item of items)
			if (canonicalJsonDigest(item.message) !== item.item_digest)
				throw new Error("Model context item no longer matches its digest.");
		const completed =
			contextIds.length === 0
				? []
				: await tx
						.selectFrom("design_model_steps")
						.selectAll()
						.where("context_id", "in", contextIds)
						.where("event_kind", "=", "completed")
						.execute();
		for (const event of completed) {
			if (
				canonicalJsonDigest({
					stepKey: event.step_key,
					eventKind: "completed",
					responseDigest: event.response_digest,
					...(event.usage !== null ? { usage: event.usage } : {}),
				}) !== event.event_digest
			)
				throw new Error("Completed model step no longer matches its digest.");
		}
		const threads = (
			await tx
				.selectFrom("threads")
				.select("messages")
				.where("design_session_id", "=", session.id)
				.execute()
		).map((thread) => thread.messages as UIMessage[]);
		const unresolved: string[] = [];
		const assignments = steps.flatMap((step) => {
			if (
				canonicalJsonDigest({
					stepKey: step.step_key,
					eventKind: "started",
					requestDigest: step.request_digest,
				}) !== step.event_digest
			)
				throw new Error("Model step no longer matches its digest.");
			const key = `${step.context_id}/${step.step_key}`;
			const completion = completed.find(
				(event) =>
					event.context_id === step.context_id &&
					event.step_key === step.step_key,
			);
			if (completion !== undefined) {
				const responseItems = items
					.filter(
						(item) =>
							item.context_id === step.context_id &&
							item.append_key.includes(`:${step.step_key}:`) &&
							item.append_key.endsWith(`:${completion.response_digest}`),
					)
					.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
				if (
					responseItems.length > 0 &&
					durableModelValueDigest(
						responseItems.map((item) => rehydrateModelMessage(item.message)),
					) !== completion.response_digest
				)
					throw new Error(
						"Completed response bytes no longer match their digest.",
					);
			}
			const inferred = inferDesignStepTurn(
				{
					...step,
					completedResponseDigest: completion?.response_digest ?? undefined,
				},
				items,
				threads,
			);
			const explicit = args.turnAssignments?.[key];
			if (explicit !== undefined && inferred !== null && explicit !== inferred)
				throw new Error(
					`Explicit assignment conflicts with durable evidence for ${key}`,
				);
			const turn = inferred ?? explicit;
			if (turn === undefined) {
				unresolved.push(key);
				return [];
			}
			z.string().min(1).max(1000).parse(turn);
			return [{ step, turn }];
		});
		const workspaces = await tx
			.selectFrom("design_artifact_workspaces")
			.selectAll()
			.where("design_session_id", "=", session.id)
			.where("status", "=", "open")
			.forUpdate()
			.execute();
		const updates = [];
		for (const workspace of workspaces) {
			const lineage = designArtifactWorkspaceLineageSchema.parse(
				workspace.lineage,
			);
			if (canonicalJsonDigest(lineage) !== workspace.lineage_digest)
				throw new Error("Workspace lineage no longer matches its digest.");
			const rows = await tx
				.selectFrom("design_artifact_workspace_steps")
				.selectAll()
				.where("workspace_id", "=", workspace.id)
				.orderBy("revision")
				.execute();
			if (rows.length !== Number(workspace.revision))
				throw new Error(
					"Workspace operation ledger disagrees with its revision.",
				);
			const baseContract =
				lineage.baseRevision === undefined
					? undefined
					: bases.get(lineage.baseRevision.id);
			if (lineage.baseRevision !== undefined && baseContract === undefined)
				throw new Error("Workspace base changed after inspection.");
			const operations = planWorkspacePlacementMigration({
				kind: lineage.artifactKind,
				baseContract,
				operations: rows.map((row) =>
					normalizeStoredDesignArtifactWorkspaceOperation(row.operation),
				),
			});
			if (operations.length > 0) updates.push({ workspace, operations });
		}
		const summary = {
			deduplicated: false,
			steps: assignments.length,
			workspaces: updates.length,
			unresolved,
		};
		if (!args.execute) return summary;
		if (unresolved.length > 0)
			throw new Error(
				`Unresolved historical turn provenance: ${unresolved.join(", ")}. Supply inspected exact assignments before executing.`,
			);
		for (const { step, turn } of assignments)
			await sql`UPDATE design_model_steps SET turn_provenance_id = ${turn}, turn_provenance_digest = ${canonicalJsonDigest({ contextId: step.context_id, stepKey: step.step_key, turnProvenanceId: turn, eventDigest: step.event_digest })} WHERE context_id = ${step.context_id} AND step_key = ${step.step_key} AND event_kind = 'started'`.execute(
				tx,
			);
		for (const { workspace, operations } of updates) {
			for (const [index, operation] of operations.entries())
				await tx
					.insertInto("design_artifact_workspace_steps")
					.values({
						workspace_id: workspace.id,
						revision: Number(workspace.revision) + index + 1,
						tool_call_id: `${MIGRATION}:${workspace.revision}:${index}`,
						input_digest: canonicalJsonDigest({
							operation,
							handleBindings: [],
						}),
						operation: JSON.stringify(
							prepareDesignArtifactWorkspaceOperationForStorage(operation),
						),
						created_by_run_id: MIGRATION,
					})
					.execute();
			await tx
				.updateTable("design_artifact_workspaces")
				.set({
					revision: Number(workspace.revision) + operations.length,
					updated_by_run_id: MIGRATION,
					updated_at: new Date(),
				})
				.where("id", "=", workspace.id)
				.execute();
		}
		{
			const completedAt = new Date();
			await tx
				.updateTable("design_sessions")
				.set({
					updated_at: completedAt,
					continuation_recovery: JSON.stringify({
						migration: MIGRATION,
						expectedUpdatedAt: expected,
						completedAt: completedAt.toISOString(),
						steps: assignments.length,
						workspaces: updates.length,
						actorUserId: args.actorUserId,
					}),
				})
				.where("id", "=", session.id)
				.execute();
		}
		return summary;
	});
}
