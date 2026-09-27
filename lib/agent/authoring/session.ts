import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { appOverview } from "@/lib/agent/appOverview";
import { emptyGenesisBase } from "@/lib/agent/change-set/baseLoader";
import { commitDesignChangeSet } from "@/lib/agent/change-set/commit";
import { canonicalJsonDigest } from "@/lib/agent/change-set/digest";
import { materializeSessionGenesis } from "@/lib/agent/change-set/materializeGenesis";
import {
	beginSessionChangeSet,
	loadChangeSet,
} from "@/lib/agent/change-set/store";
import {
	parseWorkRevision,
	workRevision,
} from "@/lib/agent/change-set/workRevision";
import {
	ChangeSetMutationWorkspace,
	type ChangeSetWorkspaceHost,
} from "@/lib/agent/change-set/workspace";
import {
	readToolLookupCatalog,
	readToolLookupDefinitions,
} from "@/lib/agent/lookupContext";
import {
	SHARED_TOOL_REGISTRY,
	type SharedToolRegistryEntry,
} from "@/lib/agent/sharedToolRegistry";
import { savedDataReview } from "@/lib/agent/toolResults";
import type {
	AuthoritativeCheckpoint,
	MutatingToolResult,
	ReadToolResult,
} from "@/lib/agent/tools/common";
import type {
	ToolInvocationContext,
	WorkspaceSnapshot,
} from "@/lib/agent/workspace/types";
import { withSchemaContext } from "@/lib/case-store";
import { type ChatRunHolderCapability, loadApp } from "@/lib/db/apps";
import {
	AuthoringAuthorityError,
	type AuthoringSession,
	assertAuthoringSessionAuthorityInTransaction,
	bindAuthoringRequestInTransaction,
	completeAuthoringRequestInTransaction,
} from "@/lib/db/authoringSessions";
import {
	assertProjectCapabilityInTransaction,
	lockAppRow,
} from "@/lib/db/canonicalCommitKernel";
import { CommitReauthError } from "@/lib/db/commitGuard";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { projectRoleFor } from "@/lib/db/projectMembership";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { AuthoringInputError } from "./errors";
import { authoringExecutionPolicy } from "./executionPolicy";
import { runSharedToolCall } from "./sharedToolCall";
import { authoringToolSchema } from "./toolSchema";

const checkpointSchema = z.strictObject({
	seq: z.number().int().nonnegative(),
	batchId: z.string().min(1),
});
const toolReceiptSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("read"),
		data: z.unknown(),
		authoritativeCheckpoint: checkpointSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("mutate"),
		mutations: z.array(z.unknown()),
		result: z.unknown(),
		authoritativeCheckpoint: checkpointSchema.optional(),
	}),
]);
function readToolReceipt(
	value: unknown,
): ReadToolResult<unknown> | MutatingToolResult<unknown> {
	const receipt = toolReceiptSchema.parse(value);
	return receipt.kind === "read"
		? {
				kind: "read",
				data: receipt.data,
				...(receipt.authoritativeCheckpoint && {
					authoritativeCheckpoint: receipt.authoritativeCheckpoint,
				}),
			}
		: {
				kind: "mutate",
				mutations: admitMutationBatch(receipt.mutations),
				result: receipt.result,
				...(receipt.authoritativeCheckpoint && {
					authoritativeCheckpoint: receipt.authoritativeCheckpoint,
				}),
			};
}

export type AuthoringHost =
	| { kind: "mcp" }
	| { kind: "chat"; threadId: string; holder?: ChatRunHolderCapability };
export interface WorkArgs {
	actorUserId: string;
	workId: string;
	host: AuthoringHost;
}

function authorityArgs(args: WorkArgs, allowIdleChat = false) {
	return {
		sessionId: args.workId,
		actorUserId: args.actorUserId,
		origin: args.host.kind,
		...(args.host.kind === "chat" && {
			threadId: args.host.threadId,
			chatRunHolder: args.host.holder,
		}),
		allowIdleChat,
	};
}
function authorize(args: WorkArgs, allowIdleChat = false) {
	return withAppTx((tx) =>
		assertAuthoringSessionAuthorityInTransaction(
			tx,
			authorityArgs(args, allowIdleChat),
		),
	);
}

/** Beginning work reserves identity only. Reads never manufacture a candidate. */
export async function beginWork(args: {
	actorUserId: string;
	projectId: string;
	target: { appId: string } | { name: string };
	requestId: string;
	host: AuthoringHost;
}) {
	const digest = canonicalJsonDigest({
		target: args.target,
		projectId: args.projectId,
		origin: args.host.kind,
		threadId: args.host.kind === "chat" ? args.host.threadId : null,
	});
	// Begin retries acquire the same app → session → membership locks as every
	// later operation. Insertion races restart after releasing the transaction.
	class BeginRace extends Error {}
	const create = async (): Promise<string> =>
		withAppTx(async (tx) => {
			let query = tx
				.selectFrom("authoring_sessions")
				.selectAll()
				.where("actor_user_id", "=", args.actorUserId)
				.where("origin", "=", args.host.kind);
			query =
				args.host.kind === "chat"
					? query.where("thread_id", "=", args.host.threadId)
					: query.where("begin_request_id", "=", args.requestId);
			const existing = await query.executeTakeFirst();
			if (existing) {
				if (
					(args.host.kind === "mcp" &&
						existing.begin_input_digest !== digest) ||
					existing.project_id !== args.projectId ||
					("appId" in args.target && existing.app_id !== args.target.appId)
				)
					throw new AuthoringInputError(
						"This request identity already belongs to different work.",
					);
				await assertAuthoringSessionAuthorityInTransaction(
					tx,
					authorityArgs({
						actorUserId: args.actorUserId,
						workId: existing.id,
						host: args.host,
					}),
				);
				return existing.id;
			}
			const app =
				"appId" in args.target ? await lockAppRow(tx, args.target.appId) : null;
			if (
				"appId" in args.target &&
				(!app || app.deleted_at !== null || app.project_id !== args.projectId)
			)
				throw new AuthoringAuthorityError();
			if (args.host.kind === "chat" && !app)
				throw new AuthoringAuthorityError(
					"Chat authoring needs an existing app.",
				);
			await assertProjectCapabilityInTransaction(
				tx,
				args.actorUserId,
				args.projectId,
				"edit",
				"You no longer have edit access to this Project.",
			);
			const id = randomUUID();
			const inserted = await tx
				.insertInto("authoring_sessions")
				.values({
					id,
					actor_user_id: args.actorUserId,
					project_id: args.projectId,
					origin: args.host.kind,
					thread_id: args.host.kind === "chat" ? args.host.threadId : null,
					app_id: app?.id ?? null,
					proposed_app_id: app ? null : randomUUID(),
					app_name:
						"name" in args.target ? args.target.name : (app?.app_name ?? ""),
					active_candidate_id: null,
					begin_request_id: args.requestId,
					begin_input_digest: digest,
				})
				.onConflict((oc) => oc.doNothing())
				.returning("id")
				.executeTakeFirst();
			if (!inserted) throw new BeginRace();
			await assertAuthoringSessionAuthorityInTransaction(
				tx,
				authorityArgs({
					actorUserId: args.actorUserId,
					workId: id,
					host: args.host,
				}),
			);
			return id;
		});
	let workId: string;
	try {
		workId = await create();
	} catch (error) {
		if (!(error instanceof BeginRace)) throw error;
		workId = await create();
	}
	return {
		workId,
		projectId: args.projectId,
		appId: "appId" in args.target ? args.target.appId : null,
	};
}

async function workspaceHost(
	args: WorkArgs,
	session: AuthoringSession,
): Promise<ChangeSetWorkspaceHost> {
	const scope = async () => {
		await authorize(args, true);
		const role = await projectRoleFor(args.actorUserId, session.projectId);
		if (!role) throw new AuthoringAuthorityError();
		return { projectId: session.projectId, actorId: args.actorUserId, role };
	};
	return {
		actorUserId: args.actorUserId,
		authoringSessionId: args.workId,
		ordinaryAuthoring:
			args.host.kind === "chat"
				? {
						sessionId: args.workId,
						origin: "chat",
						threadId: args.host.threadId,
					}
				: { sessionId: args.workId, origin: "mcp" },
		authoringOrigin: args.host.kind,
		authoringThreadId:
			args.host.kind === "chat" ? args.host.threadId : undefined,
		allowIdleAuthoringRead: true,
		runId:
			args.host.kind === "chat"
				? (args.host.holder?.runId ?? args.workId)
				: args.workId,
		chatRunHolder: args.host.kind === "chat" ? args.host.holder : undefined,
		lookupDefinitions: async (ids) =>
			readToolLookupDefinitions(await scope(), ids),
		lookupCatalog: async () => readToolLookupCatalog(await scope()),
		conversionImpact: async (input) =>
			session.appId
				? (await withSchemaContext()).conversionImpact({
						...input,
						appId: session.appId,
					})
				: { totalWithValue: 0, uncastable: 0, alreadyHeld: 0, samples: [] },
	};
}

async function openCandidate(
	args: WorkArgs,
	session: AuthoringSession,
	candidateId: string,
) {
	const candidate = await loadChangeSet(candidateId);
	if (!candidate || candidate.authoringSessionId !== session.id)
		throw new AuthoringAuthorityError();
	return ChangeSetMutationWorkspace.open(
		await workspaceHost(args, session),
		candidateId,
	);
}

async function ensureCandidate(
	args: WorkArgs & { requestId: string; toolName: string; input: unknown },
	session: AuthoringSession,
) {
	const candidate = await beginSessionChangeSet({
		authoringSessionId: args.workId,
		actorUserId: args.actorUserId,
		projectId: session.projectId,
		request: {
			requestId: args.requestId,
			operation: args.toolName,
			inputDigest: canonicalJsonDigest(args.input),
		},
		chatRunHolder: args.host.kind === "chat" ? args.host.holder : undefined,
	});
	const workspace = await openCandidate(args, session, candidate.id);
	if (candidate.kind === "genesis" && candidate.nextOrdinal === 0) {
		await workspace.stageDispatch({
			toolName: "updateApp",
			requestId: `initial-name:${candidate.id}`,
			input: { name: session.appName },
		});
	}
	return workspace;
}

export async function getWorkSnapshot(
	args: WorkArgs,
): Promise<WorkspaceSnapshot> {
	const session = await authorize(args, true);
	if (session.activeCandidateId)
		return (
			await openCandidate(args, session, session.activeCandidateId)
		).currentSnapshot();
	const app = session.appId ? await loadApp(session.appId) : null;
	const doc = app
		? hydratePersistedBlueprint(app.blueprint)
		: emptyGenesisBase(session.proposedAppId ?? "").doc;
	if (!app) doc.appName = session.appName;
	return {
		mode: "canonical",
		doc,
		revision: app?.mutation_seq ?? 0,
		canonicalSeq: app?.mutation_seq ?? null,
		projectId: session.projectId,
	};
}

export async function getWork(args: WorkArgs) {
	const session = await authorize(args, true);
	const workspace = session.activeCandidateId
		? await openCandidate(args, session, session.activeCandidateId)
		: null;
	const snapshot =
		workspace?.currentSnapshot() ?? (await getWorkSnapshot(args));
	const canonical = session.appId ? await loadApp(session.appId) : null;
	const candidate = workspace?.current();
	return {
		workId: session.id,
		appId: session.appId,
		projectId: session.projectId,
		revision: candidate ? workRevision(candidate.id, candidate.revision) : null,
		pendingChanges: candidate?.nextOrdinal ?? 0,
		stale:
			candidate?.kind === "app-edit" &&
			candidate.baseSeq !== canonical?.mutation_seq,
		savedRevision: canonical?.mutation_seq ?? null,
		app: appOverview(snapshot.doc),
		diagnostics: workspace ? await workspace.inspect() : null,
	};
}

export async function listWork(args: {
	actorUserId: string;
	host: AuthoringHost;
	appId?: string;
	projectId?: string;
	limit?: number;
	offset?: number;
}) {
	const db = await getAppDb();
	let query = db
		.selectFrom("authoring_sessions")
		.select("id")
		.where("actor_user_id", "=", args.actorUserId)
		.where("origin", "=", args.host.kind);
	if (args.host.kind === "chat")
		query = query.where("thread_id", "=", args.host.threadId);
	if (args.appId) query = query.where("app_id", "=", args.appId);
	if (args.projectId) query = query.where("project_id", "=", args.projectId);
	const rows = await query
		.orderBy(sql`active_candidate_id IS NULL`, "asc")
		.orderBy("updated_at", "desc")
		.limit(Math.max(1, Math.min(100, args.limit ?? 25)))
		.offset(Math.max(0, args.offset ?? 0))
		.execute();
	const work = [];
	for (const row of rows) {
		try {
			work.push(await getWork({ ...args, workId: row.id }));
		} catch (error) {
			if (
				!(error instanceof AuthoringAuthorityError) &&
				!(error instanceof CommitReauthError)
			)
				throw error;
		}
	}
	return { work };
}

/** Bind requests before execution to prevent a retry from entering a later
 * candidate. A lost completion response recovers through that candidate's
 * transactional stage/checkpoint receipt. */
async function bindRequest(
	args: WorkArgs & {
		requestId: string;
		operation: string;
		input: unknown;
		candidateId: string | null;
	},
) {
	return withAppTx(async (tx) => {
		await assertAuthoringSessionAuthorityInTransaction(tx, authorityArgs(args));
		return bindAuthoringRequestInTransaction(tx, {
			owner: { ordinarySessionId: args.workId },
			requestId: args.requestId,
			operation: args.operation,
			inputDigest: canonicalJsonDigest(args.input),
			candidateId: args.candidateId,
		});
	});
}
async function completeRequest(
	args: WorkArgs & { requestId: string },
	result: unknown,
) {
	return withAppTx(async (tx) => {
		await assertAuthoringSessionAuthorityInTransaction(tx, authorityArgs(args));
		await completeAuthoringRequestInTransaction(tx, {
			owner: { ordinarySessionId: args.workId },
			requestId: args.requestId,
			result,
		});
		const stored = await tx
			.selectFrom("authoring_session_requests")
			.select("result_json")
			.where("ordinary_session_id", "=", args.workId)
			.where("request_id", "=", args.requestId)
			.executeTakeFirstOrThrow();
		return stored.result_json;
	});
}

export async function executeWorkTool(
	args: WorkArgs & { requestId?: string; toolName: string; input: unknown },
): Promise<ReadToolResult<unknown> | MutatingToolResult<unknown>> {
	const session = await authorize(args);
	const entry: SharedToolRegistryEntry | undefined = SHARED_TOOL_REGISTRY.find(
		(item) => item.saName === args.toolName,
	);
	if (!entry)
		throw new AuthoringInputError("This authoring operation is unavailable.");
	await withAppTx(async (tx) => {
		await assertAuthoringSessionAuthorityInTransaction(tx, authorityArgs(args));
		await assertProjectCapabilityInTransaction(
			tx,
			args.actorUserId,
			session.projectId,
			entry.requires,
			"Your Project role cannot perform this operation.",
		);
	});
	const priorRequest = args.requestId
		? await (await getAppDb())
				.selectFrom("authoring_session_requests")
				.selectAll()
				.where("ordinary_session_id", "=", args.workId)
				.where("request_id", "=", args.requestId)
				.executeTakeFirst()
		: undefined;
	if (priorRequest) {
		if (
			priorRequest.operation !== args.toolName ||
			priorRequest.input_digest !== canonicalJsonDigest(args.input)
		)
			throw new AuthoringInputError(
				"This request identity was already used with different input.",
			);
		if (priorRequest.result_json !== null)
			return readToolReceipt(priorRequest.result_json);
	}
	if (priorRequest && args.requestId && entry.tool.recover) {
		const context = await workToolContext(args, session, entry, true);
		const recovered = await entry.tool.recover(context.ctx);
		if (recovered) {
			const checkpoint = context.checkpoint();
			return readToolReceipt(
				await completeRequest(
					{ ...args, requestId: args.requestId },
					checkpoint
						? { ...recovered, authoritativeCheckpoint: checkpoint }
						: recovered,
				),
			);
		}
	}
	const work = await getWork(args);
	const policy = authoringExecutionPolicy(entry.policy, {
		hasApp: session.appId !== null,
		hasPendingChanges: work.pendingChanges > 0,
	});
	if (policy.kind === "refused") throw new AuthoringInputError(policy.error);
	if (policy.kind === "stage") {
		if (!args.requestId)
			throw new AuthoringInputError(
				"Changing private work requires a stable request identity.",
			);
		const workspace = priorRequest?.candidate_id
			? await openCandidate(args, session, priorRequest.candidate_id)
			: await ensureCandidate({ ...args, requestId: args.requestId }, session);
		const bound = await bindRequest({
			...args,
			requestId: args.requestId,
			operation: args.toolName,
			input: args.input,
			candidateId: workspace.current().id,
		});
		if (bound.result_json !== null) return readToolReceipt(bound.result_json);
		const selected =
			bound.candidate_id === workspace.current().id
				? workspace
				: await openCandidate(args, session, bound.candidate_id ?? "");
		const staged = await selected.stageDispatch({
			toolName: args.toolName,
			requestId: args.requestId,
			input: args.input,
		});
		const outcome = staged.result as MutatingToolResult<unknown>;
		const result = {
			...outcome,
			result: {
				...(outcome.result as object),
				saved: false,
				workId: args.workId,
				revision: workRevision(
					selected.current().id,
					staged.receipt?.workspaceRevision ?? selected.current().revision,
				) as string | null,
				...(staged.receipt?.diagnostics && {
					diagnostics: staged.receipt.diagnostics,
				}),
			},
		};
		const requestId = args.requestId;
		const completed = await withAppTx(async (tx) => {
			const fresh = await assertAuthoringSessionAuthorityInTransaction(
				tx,
				authorityArgs(args),
			);
			const candidate = await tx
				.selectFrom("authoring_workspaces")
				.select(["status", "next_ordinal"])
				.where("id", "=", selected.current().id)
				.forUpdate()
				.executeTakeFirstOrThrow();
			// A no-op has a durable answer, but must not leave invisible work
			// pinned to an old base across another editor's later save.
			if (
				candidate.status === "open" &&
				safePersistedSequence(candidate.next_ordinal, "workspace ordinal") ===
					0 &&
				fresh.activeCandidateId === selected.current().id
			) {
				await tx
					.updateTable("authoring_workspaces")
					.set({ status: "abandoned", updated_at: new Date() })
					.where("id", "=", selected.current().id)
					.execute();
				await tx
					.updateTable("authoring_sessions")
					.set({ active_candidate_id: null, updated_at: new Date() })
					.where("id", "=", args.workId)
					.execute();
				result.result.revision = null;
			}
			await completeAuthoringRequestInTransaction(tx, {
				owner: { ordinarySessionId: args.workId },
				requestId,
				result,
			});
			const stored = await tx
				.selectFrom("authoring_session_requests")
				.select("result_json")
				.where("ordinary_session_id", "=", args.workId)
				.where("request_id", "=", requestId)
				.executeTakeFirstOrThrow();
			return stored.result_json;
		});
		return readToolReceipt(completed);
	}
	const external = policy.kind === "canonical";
	if (external) {
		if (!args.requestId)
			throw new AuthoringInputError(
				"Changing saved data requires a stable request identity.",
			);
		const bound = await bindRequest({
			...args,
			requestId: args.requestId,
			operation: args.toolName,
			input: args.input,
			candidateId: null,
		});
		if (bound.result_json !== null) return readToolReceipt(bound.result_json);
	}
	if (policy.clearEmptyCandidate && work.revision)
		await discardWork({
			...args,
			requestId: `empty-before:${args.requestId ?? randomUUID()}`,
			expectedRevision: work.revision,
		});
	const context = await workToolContext(args, session, entry, external);
	const result = await runSharedToolCall(
		entry,
		authoringToolSchema(args.toolName, entry.tool.inputSchema).authored.parse(
			args.input,
		),
		context.ctx,
	);
	const checkpoint = context.checkpoint();
	const projected = checkpoint
		? { ...result, authoritativeCheckpoint: checkpoint }
		: result;
	if (external && args.requestId)
		return readToolReceipt(
			await completeRequest({ ...args, requestId: args.requestId }, projected),
		);
	return projected;
}

/** The namespaced identity belongs to this work, even when a downstream
 * service's own durable receipt table keys only on the app. */
export function externalWorkRequestId(workId: string, requestId: string) {
	return `work:${workId}:${canonicalJsonDigest(requestId)}`;
}

async function workToolContext(
	args: WorkArgs & { requestId?: string; toolName: string },
	session: AuthoringSession,
	entry: SharedToolRegistryEntry,
	external: boolean,
) {
	let checkpoint: AuthoritativeCheckpoint | undefined;
	const host = await workspaceHost(args, session);
	const snapshot =
		external && session.appId
			? await canonicalSnapshot(session)
			: await getWorkSnapshot(args);
	const ctx: ToolInvocationContext = {
		appId: session.appId,
		projectId: session.projectId,
		userId: args.actorUserId,
		runId: host.runId,
		chatRunHolder: host.chatRunHolder,
		ordinaryAuthoring: host.ordinaryAuthoring,
		snapshot,
		invocation: {
			requestId: external
				? externalWorkRequestId(args.workId, args.requestId ?? randomUUID())
				: (args.requestId ?? randomUUID()),
			toolName: args.toolName,
			invocationOrdinal: 0,
		},
		lookupDefinitions: host.lookupDefinitions,
		lookupCatalog: host.lookupCatalog,
		conversionImpact: host.conversionImpact,
		applyBatch: async () => {
			throw new AuthoringInputError(
				"This operation cannot change the app outside its private work.",
			);
		},
		applyStages: async () => {
			throw new AuthoringInputError(
				"This operation cannot change the app outside its private work.",
			);
		},
		adoptAuthoritativeSnapshot: (adopted) => {
			if (entry.policy.effect !== "mixed-transaction")
				throw new AuthoringInputError("This read cannot replace the app.");
			if (adopted.canonicalSeq !== undefined && adopted.batchId !== undefined)
				checkpoint = { seq: adopted.canonicalSeq, batchId: adopted.batchId };
		},
	};
	return { ctx, checkpoint: () => checkpoint };
}

async function canonicalSnapshot(
	session: AuthoringSession,
): Promise<WorkspaceSnapshot> {
	const app = session.appId ? await loadApp(session.appId) : null;
	if (!app) throw new AuthoringAuthorityError();
	return {
		mode: "canonical",
		doc: hydratePersistedBlueprint(app.blueprint),
		revision: app.mutation_seq,
		canonicalSeq: app.mutation_seq,
		projectId: session.projectId,
	};
}

export async function saveWork(
	args: WorkArgs & { requestId: string; expectedRevision: string },
) {
	const session = await authorize(args);
	const expected = parseWorkRevision(args.expectedRevision);
	const workspace = await openCandidate(args, session, expected.candidateId);
	const bound = await bindRequest({
		...args,
		operation: "saveWork",
		input: { expectedRevision: args.expectedRevision },
		candidateId: expected.candidateId,
	});
	if (bound.result_json !== null)
		return bound.result_json as Record<string, unknown>;
	const current = workspace.current();
	if (current.revision !== expected.revision)
		throw new AuthoringInputError(
			"Pending work changed. Read it again before saving.",
		);
	const host = await workspaceHost(args, session);
	const common = {
		changeSetId: current.id,
		requestId: args.requestId,
		expectedRevision: expected.revision,
		actorUserId: args.actorUserId,
		runId: host.runId,
		chatRunHolder: host.chatRunHolder,
	};
	const result =
		current.kind === "genesis"
			? await materializeSessionGenesis({
					...common,
					expectedProjectId: session.projectId,
				})
			: await commitDesignChangeSet({ ...common, kind: args.host.kind });
	let response: Record<string, unknown>;
	if (result.kind === "materialized")
		response = {
			success: true,
			saved: true,
			workId: args.workId,
			appId: result.receipt.appId,
			revision: null,
			savedRevision: 1,
			batchId: `genesis:${result.receipt.appId}`,
		};
	else if (result.kind === "committed")
		response = {
			success: true,
			saved: true,
			workId: args.workId,
			appId: result.receipt.appId,
			revision: null,
			savedRevision: result.receipt.seq,
			batchId: result.receipt.batchId,
			...(result.migration && result.migration.parked > 0
				? { dataReview: savedDataReview(result.migration) }
				: {}),
		};
	else response = { success: false, saved: false, ...result };
	const completed = await completeRequest(args, response);
	if (completed === null)
		throw new Error("A saved authoring response is missing its receipt.");
	return completed;
}

export async function discardWork(
	args: WorkArgs & { requestId: string; expectedRevision: string },
) {
	const expected = parseWorkRevision(args.expectedRevision);
	return withAppTx(async (tx) => {
		const session = await assertAuthoringSessionAuthorityInTransaction(tx, {
			...authorityArgs(args, true),
			requireIdleChat: args.host.kind === "chat" && !args.host.holder,
		});
		const digest = canonicalJsonDigest({
			expectedRevision: args.expectedRevision,
		});
		const prior = await tx
			.selectFrom("authoring_session_requests")
			.selectAll()
			.where("ordinary_session_id", "=", args.workId)
			.where("request_id", "=", args.requestId)
			.executeTakeFirst();
		if (prior) {
			if (prior.operation !== "discardWork" || prior.input_digest !== digest)
				throw new AuthoringInputError(
					"This request identity was already used with different input.",
				);
			if (prior.result_json !== null)
				return prior.result_json as Record<string, unknown>;
		}
		const candidate = await tx
			.selectFrom("authoring_workspaces")
			.select(["revision", "status", "authoring_session_id"])
			.where("id", "=", expected.candidateId)
			.forUpdate()
			.executeTakeFirst();
		if (
			!candidate ||
			candidate.authoring_session_id !== args.workId ||
			candidate.status !== "open" ||
			session.activeCandidateId !== expected.candidateId ||
			safePersistedSequence(candidate.revision, "workspace revision") !==
				expected.revision
		)
			throw new AuthoringInputError(
				"Pending work changed. Read it again before discarding.",
			);
		await tx
			.updateTable("authoring_workspaces")
			.set({ status: "abandoned", updated_at: new Date() })
			.where("id", "=", expected.candidateId)
			.execute();
		await tx
			.updateTable("authoring_sessions")
			.set({ active_candidate_id: null, updated_at: new Date() })
			.where("id", "=", args.workId)
			.execute();
		const result = {
			success: true,
			discarded: true,
			workId: args.workId,
			appId: session.appId,
		};
		await tx
			.insertInto("authoring_session_requests")
			.values({
				ordinary_session_id: args.workId,
				design_session_id: null,
				request_id: args.requestId,
				operation: "discardWork",
				input_digest: digest,
				candidate_id: expected.candidateId,
				result_json: JSON.stringify(result),
			})
			.execute();
		return result;
	});
}
