import "server-only";
import { appOverview } from "@/lib/agent/appOverview";
import { authoringExecutionPolicy } from "@/lib/agent/authoring/executionPolicy";
import { runSharedToolCall } from "@/lib/agent/authoring/sharedToolCall";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { emptyGenesisBase } from "@/lib/agent/change-set/baseLoader";
import { commitDesignChangeSet } from "@/lib/agent/change-set/commit";
import { canonicalJsonDigest } from "@/lib/agent/change-set/digest";
import {
	materializeAppFromGenesis,
	readMaterializedGenesisReceipt,
} from "@/lib/agent/change-set/materializeGenesis";
import {
	abandonChangeSet,
	beginAppEditChangeSet,
	beginGenesisChangeSet,
	loadChangeSet,
	lookupStageRequest,
	resumeOpenChangeSet,
} from "@/lib/agent/change-set/store";
import {
	parseWorkRevision,
	workRevision,
} from "@/lib/agent/change-set/workRevision";
import {
	ChangeSetMutationWorkspace,
	type ChangeSetWorkspaceHost,
} from "@/lib/agent/change-set/workspace";
import { readToolLookupDefinitions } from "@/lib/agent/lookupContext";
import { PlanConflictError } from "@/lib/agent/planning/plan";
import {
	type PlanningAuthority,
	readAppPlan,
} from "@/lib/agent/planning/store";
import {
	SHARED_TOOL_REGISTRY,
	type SharedToolRegistryEntry,
} from "@/lib/agent/sharedToolRegistry";
import { savedDataReview, sharedToolPayload } from "@/lib/agent/toolResults";
import type { MutatingToolResult } from "@/lib/agent/tools/common";
import type {
	ToolInvocationContext,
	WorkspaceSnapshot,
} from "@/lib/agent/workspace/types";
import { withSchemaContext } from "@/lib/case-store";
import type { AppMaterializationReceipt } from "@/lib/db/appGenesis";
import { loadApp } from "@/lib/db/apps";
import {
	bindAuthoringRequestInTransaction,
	completeAuthoringRequestInTransaction,
} from "@/lib/db/authoringSessions";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { migrationOutcomeSchema } from "@/lib/db/migrationOutcome";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { projectRoleFor } from "@/lib/db/projectMembership";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { readAuthorizedLookupCatalog } from "@/lib/lookup/agentService";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import type { ArchitectToolCall } from "./architectLoop";
import { sharedToolAvailable } from "./authoringTools";

export class AuthoringSession {
	appId: string | null = null;
	building = false;
	private workspace: ChangeSetMutationWorkspace | null = null;
	private ordinal = 0;
	constructor(
		readonly authority: PlanningAuthority,
		readonly proposedAppId: string,
		private readonly onMaterialized: (
			receipt: AppMaterializationReceipt,
		) => void,
	) {}
	get holder() {
		return {
			source: "chat" as const,
			mode: "build" as const,
			runId: this.authority.runId,
			nonce: this.authority.holderNonce,
		};
	}
	async authorize() {
		const target = await withAppTx((tx) =>
			assertDesignSessionRunAuthorityInTransaction(tx, {
				designSessionId: this.authority.sessionId,
				actorUserId: this.authority.actorUserId,
				expectedProjectId: this.authority.projectId,
				holder: this.holder,
			}),
		);
		this.appId = target.appId;
		return target;
	}
	async initialize() {
		await this.authorize();
		const db = await getAppDb();
		const open = await db
			.selectFrom("authoring_workspaces")
			.select("id")
			.where("design_session_id", "=", this.authority.sessionId)
			.where("status", "=", "open")
			.executeTakeFirst();
		this.building = this.appId !== null || open !== undefined;
	}
	private get host(): ChangeSetWorkspaceHost {
		return {
			actorUserId: this.authority.actorUserId,
			runId: this.authority.runId,
			chatRunHolder: this.holder,
			lookupDefinitions: async (ids) => {
				await this.authorize();
				const role = await projectRoleFor(
					this.authority.actorUserId,
					this.authority.projectId,
				);
				if (!role) throw new Error("Project access is unavailable.");
				return readToolLookupDefinitions(
					{
						projectId: this.authority.projectId,
						actorId: this.authority.actorUserId,
						role,
					},
					ids,
				);
			},
			lookupCatalog: () =>
				readAuthorizedLookupCatalog({
					designSessionId: this.authority.sessionId,
					projectId: this.authority.projectId,
					actorId: this.authority.actorUserId,
					runId: this.authority.runId,
					chatRunHolder: this.holder,
					requestId: "catalog",
				}),
			conversionImpact: async (args) =>
				this.appId
					? (await withSchemaContext()).conversionImpact({
							...args,
							appId: this.appId,
						})
					: { totalWithValue: 0, uncastable: 0, alreadyHeld: 0, samples: [] },
		};
	}
	async ensureWorkspace() {
		await this.authorize();
		if (this.workspace) return this.workspace;
		const resumed = await resumeOpenChangeSet({
			designSessionId: this.authority.sessionId,
			projectId: this.authority.projectId,
			actorUserId: this.authority.actorUserId,
			runId: this.authority.runId,
			holderNonce: this.authority.holderNonce,
		});
		let current = resumed;
		if (!current) {
			const plan = await readAppPlan(this.authority);
			if (!plan) throw new Error("Write the plan before building.");
			const common = {
				lineage: {
					designSessionId: this.authority.sessionId,
					planRevision: plan.revision,
				},
				ownerUserId: this.authority.actorUserId,
				ownerRunId: this.authority.runId,
				holderNonce: this.authority.holderNonce,
			};
			current = this.appId
				? await beginAppEditChangeSet({
						...common,
						appId: this.appId,
						expectedProjectId: this.authority.projectId,
					})
				: await beginGenesisChangeSet({
						...common,
						proposedAppId: this.proposedAppId,
						projectId: this.authority.projectId,
						baseSnapshotDigest: emptyGenesisBase(this.proposedAppId).digest,
					});
		}
		this.workspace = await ChangeSetMutationWorkspace.open(
			this.host,
			current.id,
		);
		this.building = true;
		return this.workspace;
	}
	async snapshot(canonical = false): Promise<WorkspaceSnapshot> {
		await this.authorize();
		if (!canonical && this.building) {
			if (this.workspace) return this.workspace.currentSnapshot();
			const open = await (await getAppDb())
				.selectFrom("authoring_workspaces")
				.select("id")
				.where("design_session_id", "=", this.authority.sessionId)
				.where("status", "=", "open")
				.executeTakeFirst();
			if (open) return (await this.ensureWorkspace()).currentSnapshot();
		}
		const app = this.appId ? await loadApp(this.appId) : null;
		return {
			mode: "canonical",
			doc: app
				? hydratePersistedBlueprint(app.blueprint)
				: emptyGenesisBase(this.proposedAppId).doc,
			revision: app?.mutation_seq ?? 0,
			canonicalSeq: app?.mutation_seq ?? null,
			projectId: this.authority.projectId,
		};
	}
	async overview(canonical = false) {
		const snapshot = await this.snapshot(canonical);
		return {
			appId: this.appId,
			savedRevision: snapshot.canonicalSeq,
			app: appOverview(snapshot.doc),
			...(!canonical &&
				this.workspace && {
					unsavedChanges: this.workspace.current().nextOrdinal,
				}),
		};
	}
	async getWork() {
		const overview = await this.overview();
		const current = this.workspace?.current();
		const canonical = this.appId ? await loadApp(this.appId) : null;
		return {
			...overview,
			workId: this.authority.sessionId,
			revision: current ? workRevision(current.id, current.revision) : null,
			pendingChanges: current?.nextOrdinal ?? 0,
			savedRevision: canonical?.mutation_seq ?? null,
			stale:
				current?.kind === "app-edit" &&
				current.baseSeq !== canonical?.mutation_seq,
			diagnostics: this.workspace ? await this.workspace.inspect() : null,
		};
	}
	private async bindRequest(
		requestId: string,
		operation: string,
		input: unknown,
		candidateId: string,
	) {
		return withAppTx(async (tx) => {
			await assertDesignSessionRunAuthorityInTransaction(tx, {
				designSessionId: this.authority.sessionId,
				actorUserId: this.authority.actorUserId,
				expectedProjectId: this.authority.projectId,
				holder: this.holder,
			});
			return bindAuthoringRequestInTransaction(tx, {
				owner: { designSessionId: this.authority.sessionId },
				requestId,
				operation,
				inputDigest: canonicalJsonDigest(input),
				candidateId,
			});
		});
	}
	private async completeRequest(requestId: string, result: unknown) {
		await withAppTx(async (tx) => {
			await assertDesignSessionRunAuthorityInTransaction(tx, {
				designSessionId: this.authority.sessionId,
				actorUserId: this.authority.actorUserId,
				expectedProjectId: this.authority.projectId,
				holder: this.holder,
			});
			await completeAuthoringRequestInTransaction(tx, {
				owner: { designSessionId: this.authority.sessionId },
				requestId,
				result,
			});
		});
	}
	async discardWork(requestId: string, expectedRevision: string) {
		await this.authorize();
		const expected = parseWorkRevision(expectedRevision);
		const bound = await this.bindRequest(
			requestId,
			"discardWork",
			{ expectedRevision },
			expected.candidateId,
		);
		if (bound.result_json !== null) return bound.result_json;
		const current = await loadChangeSet(expected.candidateId);
		if (
			!current ||
			current.designSessionId !== this.authority.sessionId ||
			current.revision !== expected.revision
		)
			throw new Error("Pending work changed. Read it again before discarding.");
		if (current.status !== "abandoned") {
			await abandonChangeSet({
				changeSetId: current.id,
				expectedRevision: expected.revision,
				actorUserId: this.authority.actorUserId,
				runId: this.authority.runId,
				chatRunHolder: this.holder,
			});
		}
		if (this.workspace?.current().id === current.id) this.workspace = null;
		const result = {
			discarded: true,
			workId: this.authority.sessionId,
			revision: null,
			appId: this.appId,
		};
		await this.completeRequest(requestId, result);
		return result;
	}
	private async context(
		call: ArchitectToolCall,
		canonical: boolean,
	): Promise<ToolInvocationContext> {
		const snapshot = await this.snapshot(canonical);
		return {
			appId: this.appId,
			projectId: this.authority.projectId,
			userId: this.authority.actorUserId,
			runId: this.authority.runId,
			chatRunHolder: this.holder,
			authoringSessionId: this.authority.sessionId,
			snapshot,
			invocation: {
				requestId: call.toolCallId,
				toolName: call.toolName,
				invocationOrdinal: this.ordinal++,
			},
			lookupDefinitions: this.host.lookupDefinitions,
			lookupCatalog: this.host.lookupCatalog,
			conversionImpact: this.host.conversionImpact,
			applyBatch: async () => {
				throw new Error(
					"This operation cannot write to the app from a read context.",
				);
			},
			applyStages: async () => {
				throw new Error(
					"This operation cannot write to the app from a read context.",
				);
			},
			adoptAuthoritativeSnapshot: () => {
				throw new Error(
					"This operation cannot replace the app from a read context.",
				);
			},
		};
	}
	async shared(call: ArchitectToolCall, role: "architect" | "peer") {
		await this.authorize();
		const entry: SharedToolRegistryEntry | undefined =
			SHARED_TOOL_REGISTRY.find((entry) => entry.saName === call.toolName);
		if (
			!entry ||
			!sharedToolAvailable(entry, {
				role,
				building: this.building,
				hasApp: this.appId !== null,
			})
		)
			return { error: "This operation is unavailable in the current phase." };
		const execution = authoringExecutionPolicy(entry.policy, {
			hasApp: this.appId !== null,
			hasPendingChanges:
				entry.policy.staging === "forbidden" &&
				entry.policy.effect !== "read-blueprint" &&
				(await this.hasUnsavedWork()),
		});
		if (execution.kind === "refused") return { error: execution.error };
		if (execution.kind === "stage") return this.stageShared(call);
		if (execution.clearEmptyCandidate) await this.discardEmptyWorkspace();
		const ctx = await this.context(
			call,
			role === "peer" || execution.kind === "canonical",
		);
		// This shared service commits its own app/organization transaction. No
		// private overlay survives across it, and the next read reloads the app.
		if (entry.policy.effect === "mixed-transaction")
			ctx.adoptAuthoritativeSnapshot = () => {};
		const result = await runSharedToolCall(
			entry,
			authoringToolSchema(call.toolName, entry.tool.inputSchema).authored.parse(
				call.input,
			),
			ctx,
		);
		return result.kind === "read" ? result.data : sharedToolPayload(result);
	}
	private async workspaceForRequest(call: ArchitectToolCall) {
		const db = await getAppDb();
		const request = await db
			.selectFrom("authoring_session_requests")
			.select(["candidate_id"])
			.where("design_session_id", "=", this.authority.sessionId)
			.where("request_id", "=", call.toolCallId)
			.executeTakeFirst();
		// Accepted pre-cutover calls already have durable candidate receipts.
		// Locating that exact effect preserves recovery without an old input parser.
		const historical = !request
			? await db
					.selectFrom("authoring_requests as request")
					.innerJoin(
						"authoring_workspaces as workspace",
						"workspace.id",
						"request.change_set_id",
					)
					.select("workspace.id")
					.where("workspace.design_session_id", "=", this.authority.sessionId)
					.where("request.request_id", "=", call.toolCallId)
					.executeTakeFirst()
			: undefined;
		const priorCandidateId = request?.candidate_id ?? historical?.id;
		if (priorCandidateId) {
			const prior = await loadChangeSet(priorCandidateId);
			if (
				prior?.status === "open" &&
				prior.ownerRunId !== this.authority.runId
			) {
				await resumeOpenChangeSet({
					designSessionId: this.authority.sessionId,
					projectId: this.authority.projectId,
					actorUserId: this.authority.actorUserId,
					runId: this.authority.runId,
					holderNonce: this.authority.holderNonce,
				});
			}
		}
		const workspace = priorCandidateId
			? await ChangeSetMutationWorkspace.open(this.host, priorCandidateId)
			: await this.ensureWorkspace();
		const bound = await this.bindRequest(
			call.toolCallId,
			call.toolName,
			call.input,
			workspace.current().id,
		);
		return { workspace, bound };
	}
	private async stageShared(call: ArchitectToolCall) {
		const { workspace, bound } = await this.workspaceForRequest(call);
		if (bound.result_json !== null) return bound.result_json;
		const staged = await workspace.stageDispatch({
			toolName: call.toolName,
			requestId: call.toolCallId,
			input: call.input,
		});
		const result = {
			...((sharedToolPayload(staged.result) ?? {}) as object),
			saved: false,
			workId: this.authority.sessionId,
			revision: workRevision(
				workspace.current().id,
				staged.receipt?.workspaceRevision ?? workspace.current().revision,
			),
			...(staged.receipt?.diagnostics && {
				diagnostics: staged.receipt.diagnostics,
			}),
		};
		if (this.workspace?.current().id === workspace.current().id)
			this.workspace = workspace;
		await this.completeRequest(call.toolCallId, result);
		return result;
	}
	async write<R>(
		call: ArchitectToolCall,
		execute: (ctx: ToolInvocationContext) => Promise<MutatingToolResult<R>>,
	) {
		await this.authorize();
		if (!this.building)
			throw new PlanConflictError("Start building before changing the app.");
		const { workspace, bound } = await this.workspaceForRequest(call);
		if (bound.result_json !== null) return bound.result_json;
		const result = await workspace.invoke({
			toolName: call.toolName,
			requestId: call.toolCallId,
			input: call.input,
			execute,
		});
		const receipt = await lookupStageRequest(
			workspace.current().id,
			call.toolCallId,
		);
		const payload = {
			...(sharedToolPayload(result) as object),
			saved: false,
			workId: this.authority.sessionId,
			revision: workRevision(
				workspace.current().id,
				receipt?.resultingRevision ?? workspace.current().revision,
			),
		};
		if (this.workspace?.current().id === workspace.current().id)
			this.workspace = workspace;
		await this.completeRequest(call.toolCallId, payload);
		return payload;
	}
	async discardEmptyWorkspace() {
		await this.authorize();
		if (!this.workspace) {
			const open = await (await getAppDb())
				.selectFrom("authoring_workspaces")
				.select("next_ordinal")
				.where("design_session_id", "=", this.authority.sessionId)
				.where("status", "=", "open")
				.executeTakeFirst();
			if (
				!open ||
				safePersistedSequence(open.next_ordinal, "workspace ordinal") > 0
			)
				return;
			// Cleanup happens after review, when the existing workspace can be
			// adopted by a replacement run through the normal authority checks.
			await this.ensureWorkspace();
		}
		if (!this.workspace || this.workspace.current().nextOrdinal > 0) return;
		await abandonChangeSet({
			changeSetId: this.workspace.current().id,
			actorUserId: this.authority.actorUserId,
			runId: this.authority.runId,
			chatRunHolder: this.holder,
		});
		this.workspace = null;
	}
	async hasUnsavedWork() {
		if (!this.building) return false;
		// Inspect durable pending work without reopening a write workspace. A peer
		// can review a saved app while its plan is locked for that very review.
		await this.authorize();
		const open = await (await getAppDb())
			.selectFrom("authoring_workspaces")
			.select("next_ordinal")
			.where("design_session_id", "=", this.authority.sessionId)
			.where("status", "=", "open")
			.executeTakeFirst();
		return (
			open !== undefined &&
			safePersistedSequence(open.next_ordinal, "workspace ordinal") > 0
		);
	}
	async saveWork(requestId: string, expectedRevision: string) {
		await this.authorize();
		const expected = parseWorkRevision(expectedRevision);
		const bound = await this.bindRequest(
			requestId,
			"saveWork",
			{ expectedRevision },
			expected.candidateId,
		);
		if (bound.result_json !== null) {
			const candidate = await loadChangeSet(expected.candidateId);
			if (candidate?.kind === "genesis") {
				const birth = await readMaterializedGenesisReceipt({
					changeSetId: expected.candidateId,
					actorUserId: this.authority.actorUserId,
				});
				if (birth) this.onMaterialized(birth);
			}
			return bound.result_json;
		}
		const result = await this.saveCandidate(requestId, expected);
		await this.completeRequest(requestId, result);
		return result;
	}
	private async saveCandidate(
		requestId: string,
		expected: { candidateId: string; revision: number },
	) {
		await this.authorize();
		const db = await getAppDb();
		const prior = await db
			.selectFrom("authoring_checkpoints")
			.select(["app_id", "seq", "change_set_id", "migration_report"])
			.where("design_session_id", "=", this.authority.sessionId)
			.where("request_id", "=", requestId)
			.executeTakeFirst();
		if (prior) {
			const candidate = await loadChangeSet(prior.change_set_id);
			if (
				candidate?.id !== expected.candidateId ||
				candidate.revision !== expected.revision
			)
				throw new Error("Pending work changed. Read it again before saving.");
			const migration =
				prior.migration_report === null
					? undefined
					: migrationOutcomeSchema.parse(prior.migration_report);
			this.appId = prior.app_id;
			if (safePersistedSequence(prior.seq, "checkpoint sequence") === 1) {
				const birth = await readMaterializedGenesisReceipt({
					changeSetId: prior.change_set_id,
					actorUserId: this.authority.actorUserId,
				});
				if (birth) this.onMaterialized(birth);
			}
			return {
				saved: true,
				appId: prior.app_id,
				revision: null,
				savedRevision: safePersistedSequence(prior.seq, "checkpoint sequence"),
				...(migration &&
					migration.parked > 0 && { dataReview: savedDataReview(migration) }),
			};
		}
		const workspace = await this.ensureWorkspace();
		const current = workspace.current();
		if (
			current.id !== expected.candidateId ||
			current.revision !== expected.revision
		)
			throw new Error("Pending work changed. Read it again before saving.");
		if (!current.nextOrdinal) return { saved: false, changes: 0 };
		const diagnostics = await workspace.inspect();
		if (!diagnostics.canCommit)
			return {
				saved: false,
				findings: diagnostics.allFindings,
			};
		if (current.kind === "genesis") {
			const result = await materializeAppFromGenesis({
				changeSetId: current.id,
				requestId,
				expectedRevision: current.revision,
				actorUserId: this.authority.actorUserId,
				runId: this.authority.runId,
				holderNonce: this.authority.holderNonce,
				expectedProjectId: this.authority.projectId,
			});
			if (result.kind !== "materialized") return { saved: false, ...result };
			this.appId = result.receipt.appId;
			this.workspace = null;
			this.onMaterialized(result.receipt);
			return {
				saved: true,
				appId: this.appId,
				revision: null,
				savedRevision: 1,
			};
		}
		const result = await commitDesignChangeSet({
			changeSetId: current.id,
			requestId,
			expectedRevision: current.revision,
			actorUserId: this.authority.actorUserId,
			runId: this.authority.runId,
			chatRunHolder: this.holder,
			kind: "chat",
		});
		if (result.kind !== "committed") return { saved: false, ...result };
		this.workspace = null;
		return {
			saved: true,
			appId: result.receipt.appId,
			revision: null,
			savedRevision: result.receipt.seq,
			...(result.migration &&
				result.migration.parked > 0 && {
					dataReview: savedDataReview(result.migration),
				}),
		};
	}
}
