/**
 * `ChangeSetMutationWorkspace` — the private, durable staging host behind
 * the shared tool-facing contract (`lib/agent/workspace/types.ts`).
 *
 * Same discipline as the canonical workspace — synchronous ordinal
 * allocation, strictly serialized bodies, one immutable snapshot per
 * invocation, one workspace write per invocation, stale revisions are loud
 * protocol errors — over DURABLE state: the current document is the exact
 * base plus admitted steps, the revision is the change-set row's persisted
 * monotonic revision, and every accepted write commits its receipt, step,
 * handle bindings, and revision advance through the store's one stage
 * transaction before the invocation returns.
 *
 * What the change-set host does that the canonical host never does:
 *
 *   - accepts a private candidate WITH gating findings — they become
 *     diagnostics on the receipt, and the step still appends;
 *   - resolves change-set handles structurally BEFORE the original tool
 *     schema re-parses the resolved input;
 *   - records intent ids and external read sets with each durable step;
 *   - replays a stored receipt for a repeated request id without re-running
 *     the tool body (the receipt, not the prose, is the replay contract).
 *
 * What it can never do: call the canonical commit kernel, emit app mutation
 * events or SSE, or let staged state reach any canonical, read, stream, or
 * peer surface. Committing is `commit.ts`'s separate server-owned operation.
 */

import type { DesignId } from "@/lib/agent/design/ids";
import type {
	ConversionImpactFn,
	ToolInvocationContext,
	ToolWorkspace,
	WorkspaceMutationOutcome,
	WorkspaceSnapshot,
} from "@/lib/agent/workspace/types";
import type { ChatRunHolderCapability } from "@/lib/db/apps";
import {
	describeCommitFindings,
	evaluatePreparedMutationCandidate,
	type PreparedMutationCandidate,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
	unionLookupReferenceTargetSets,
} from "@/lib/doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	type AdmittedMutationStageSlice,
	admitMutationBatch,
	admitMutationStages,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { asWalkableDoc, walkAuthoredAssetRefs } from "@/lib/domain/mediaRefs";
import {
	type ChangeSetDiagnostics,
	computeChangeSetDiagnostics,
	summarizeDiagnostics,
} from "./diagnostics";
import { canonicalJsonDigest, stagingInputDigest } from "./digest";
import {
	ChangeSetIntegrityError,
	ChangeSetRequestIdCollisionError,
	ChangeSetScopeLostError,
	type ChangeSetStageErrorCode,
	ChangeSetStagingRejectedError,
} from "./errors";
import { HandleTable, resolveHandleRefs } from "./handles";
import {
	evaluateReadSetCurrency,
	externalContextDigest,
	lookupSnapshotDependencies,
	mediaAssetDependencies,
	normalizeReadSet,
} from "./readSets";
import { changeSetToolEntry } from "./registry";
import { rehydrateChangeSet } from "./runtime";
import type { ExternalReadDependency, StageRequestReceipt } from "./schemas";
import {
	loadChangeSet,
	lookupStageRequest,
	type StageHandleAllocation,
	stageChangeSetRequest,
} from "./store";
import {
	batchExclusiveKind,
	type ChangeSetStep,
	type DesignChangeSet,
} from "./types";

export interface ChangeSetExecutionCheckpoint {
	readonly intentCoverage: readonly {
		readonly intentId: DesignId;
		readonly stepCount: number;
	}[];
	readonly handles: readonly {
		readonly handle: string;
		readonly uuid: string;
		readonly entityKind: string;
	}[];
}

/** The Project data readers + services a change-set workspace runs over. */
export interface ChangeSetWorkspaceHost {
	readonly actorUserId: string;
	readonly runId: string;
	readonly chatRunHolder?: ChatRunHolderCapability;
	readonly lookupDefinitions?: ToolInvocationContext["lookupDefinitions"];
	readonly lookupCatalog?: ToolInvocationContext["lookupCatalog"];
	readonly conversionImpact: ConversionImpactFn;
}

/** One dispatched request's envelope: the tool result plus the durable
 *  receipt (when the invocation wrote), and whether it was a replay. */
export interface StageDispatchResult<T> {
	readonly replayed: boolean;
	readonly result: T;
	readonly receipt?: StageRequestReceipt;
}

interface DispatchArgs<T> {
	readonly toolName: string;
	readonly requestId?: string;
	/** The caller's exact request — required at runtime (it keys the durable
	 * idempotency digest); optional in the type only so the shared
	 * `ToolWorkspace` contract remains satisfied. */
	readonly input?: unknown;
	readonly intentIds?: readonly DesignId[];
	readonly deadlineAt?: number;
	execute(ctx: ToolInvocationContext, resolvedInput?: unknown): Promise<T>;
}

export class ChangeSetMutationWorkspace implements ToolWorkspace {
	readonly mode = "change-set" as const;

	private changeSet: DesignChangeSet;
	private steps: ChangeSetStep[];
	private overlayDoc: BlueprintDoc;
	private handleTable: HandleTable;
	private accumulatedReadSet: ExternalReadDependency[];
	private lastSummaryFingerprints: readonly string[] = [];
	private readonly host: ChangeSetWorkspaceHost;

	private nextInvocationOrdinal = 0;
	private lastStartedOrdinal = -1;
	private chain: Promise<void> = Promise.resolve();

	private constructor(args: {
		host: ChangeSetWorkspaceHost;
		changeSet: DesignChangeSet;
		steps: ChangeSetStep[];
		overlayDoc: BlueprintDoc;
		handleTable: HandleTable;
		accumulatedReadSet: ExternalReadDependency[];
	}) {
		this.host = args.host;
		this.changeSet = args.changeSet;
		this.steps = args.steps;
		this.overlayDoc = args.overlayDoc;
		this.handleTable = args.handleTable;
		this.accumulatedReadSet = args.accumulatedReadSet;
	}

	/** Open (or reopen after process death) one change set's workspace by
	 *  rehydrating its exact durable state. */
	static async open(
		host: ChangeSetWorkspaceHost,
		changeSetId: string,
	): Promise<ChangeSetMutationWorkspace> {
		const changeSet = await loadChangeSet(changeSetId);
		if (changeSet === undefined) {
			throw new ChangeSetScopeLostError("This change set no longer exists.");
		}
		const rehydrated = await rehydrateChangeSet(changeSet);
		return new ChangeSetMutationWorkspace({
			host,
			changeSet,
			steps: [...rehydrated.steps],
			overlayDoc: rehydrated.overlay.doc,
			handleTable: new HandleTable(rehydrated.handles),
			accumulatedReadSet: [...rehydrated.accumulatedReadSet],
		});
	}

	currentSnapshot(): WorkspaceSnapshot {
		return {
			doc: this.overlayDoc,
			revision: this.changeSet.revision,
			canonicalSeq: this.changeSet.baseSeq,
			projectId: this.changeSet.baseProjectId,
			externalContextDigest: externalContextDigest(this.accumulatedReadSet),
		};
	}

	/** Bounded identity and ownership state a recovered compiler cannot infer
	 * from the Blueprint alone. Both projections come from the durable step and
	 * handle ledgers rehydrated at open; no transcript is authoritative here. */
	currentExecutionCheckpoint(): ChangeSetExecutionCheckpoint {
		const coverage = new Map<DesignId, number>();
		for (const step of this.steps) {
			for (const intentId of step.intentIds) {
				coverage.set(intentId, (coverage.get(intentId) ?? 0) + 1);
			}
		}
		return {
			intentCoverage: [...coverage.entries()]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([intentId, stepCount]) => ({ intentId, stepCount })),
			handles: this.handleTable.entries().map(([handle, binding]) => ({
				handle,
				uuid: binding.uuid,
				entityKind: binding.entityKind,
			})),
		};
	}

	/** The change set's authority row as this workspace last observed it. */
	current(): DesignChangeSet {
		return this.changeSet;
	}

	/**
	 * The `ToolWorkspace` contract: run one serialized invocation and return
	 * the tool's result. The change-set contract EXTENDS the shared one —
	 * `input` is required (it keys the durable idempotency digest) and
	 * `execute` also receives the handle-resolved input.
	 */
	async invoke<T>(args: DispatchArgs<T>): Promise<T> {
		return (await this.dispatchEngine(args)).result;
	}

	/**
	 * Dispatch one REGISTERED change-set tool: registry policy, handle
	 * declaration + resolution, the second parse through the original tool
	 * schema, then the serialized body. The primary executor-surface entry;
	 * returns the full envelope with the durable receipt.
	 */
	async stageDispatch(args: {
		readonly toolName: string;
		readonly requestId: string;
		readonly input: unknown;
		readonly intentIds?: readonly DesignId[];
		/** Absolute executor deadline. Direct/non-executor callers omit it. */
		readonly deadlineAt?: number;
	}): Promise<StageDispatchResult<unknown>> {
		const entry = changeSetToolEntry(args.toolName);
		if (entry === undefined) {
			throw new ChangeSetStagingRejectedError(
				"STAGING_FORBIDDEN",
				`Tool ${args.toolName} is not available in a change set. External-effect and lifecycle tools run only on canonical surfaces.`,
			);
		}
		return this.dispatchEngine({
			toolName: args.toolName,
			requestId: args.requestId,
			input: args.input,
			...(args.intentIds !== undefined && { intentIds: args.intentIds }),
			...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			execute: async (ctx, resolvedInput) => {
				const parsed = entry.tool.inputSchema.safeParse(resolvedInput);
				if (!parsed.success) {
					throw new ChangeSetStagingRejectedError(
						"STAGING_FORBIDDEN",
						`The ${args.toolName} input was invalid: ${parsed.error.issues
							.map(
								(issue) =>
									`${issue.path.join(".") || "(root)"}: ${issue.message}`,
							)
							.join("; ")}`,
					);
				}
				return entry.tool.execute(parsed.data, ctx);
			},
		});
	}

	/**
	 * Full diagnostics over the CURRENT rehydrated candidate — what
	 * `inspectChangeSet` projects and what commit preconditions consult.
	 */
	async inspect(): Promise<ChangeSetDiagnostics> {
		const lookupContext = await this.lookupContextFor(
			this.overlayDoc,
			this.overlayDoc,
		);
		const readSetStatus = await evaluateReadSetCurrency({
			appId: this.changeSet.appId,
			dependencies: this.accumulatedReadSet,
		});
		return computeChangeSetDiagnostics({
			changeSet: this.changeSet,
			overlaySnapshot: toPersistableDoc(this.overlayDoc),
			overlay: this.overlayDoc,
			lookupContext,
			steps: this.steps,
			readSetStatus,
			previousFingerprints: this.lastSummaryFingerprints,
		});
	}

	// ── The serialized engine ────────────────────────────────────────

	private dispatchEngine<T>(
		args: DispatchArgs<T>,
	): Promise<StageDispatchResult<T>> {
		const invocationOrdinal = this.nextInvocationOrdinal++;
		const requestId = args.requestId ?? crypto.randomUUID();

		const run = async (): Promise<StageDispatchResult<T>> => {
			if (invocationOrdinal !== this.lastStartedOrdinal + 1) {
				throw new Error(
					`[change-set workspace] invocation ${invocationOrdinal} (${args.toolName}) started out of order after ${this.lastStartedOrdinal}.`,
				);
			}
			this.lastStartedOrdinal = invocationOrdinal;
			if (args.input === undefined) {
				throw new Error(
					`[change-set workspace] ${args.toolName} supplied no input; the durable idempotency digest requires the caller's exact request.`,
				);
			}

			/* Durable idempotent replay BEFORE any work. The digest compares
			 * the caller's ACTUAL input at the STORED expected revision, so a
			 * retry after the revision advanced still replays its original
			 * receipt; divergence latches as a collision. */
			const stored = await lookupStageRequest(this.changeSet.id, requestId);
			if (stored !== undefined) {
				const replayDigest = stagingInputDigest({
					toolName: args.toolName,
					expectedWorkspaceRevision: stored.expectedRevision,
					projectedInput: {
						input: args.input,
						intentIds: args.intentIds ?? [],
					},
				});
				if (
					stored.toolName !== args.toolName ||
					stored.inputDigest !== replayDigest
				) {
					throw new ChangeSetRequestIdCollisionError();
				}
				return {
					replayed: true,
					result: this.replayedResult(stored.receipt) as T,
					receipt: stored.receipt,
				};
			}

			const expectedRevision = this.changeSet.revision;
			const inputDigest = stagingInputDigest({
				toolName: args.toolName,
				expectedWorkspaceRevision: expectedRevision,
				projectedInput: { input: args.input, intentIds: args.intentIds ?? [] },
			});

			/* Handle declaration + structural resolution, against a SCRATCH
			 * table: bindings become shared workspace state only when the
			 * staged request commits them durably. Allocation happens here —
			 * outside the durable transaction — so a transaction retry reuses
			 * the same minted UUIDs. */
			const entry = changeSetToolEntry(args.toolName);
			const scratch = this.handleTable.clone();
			const allocations: StageHandleAllocation[] = [];
			let resolvedInput: unknown;
			try {
				if (entry?.declaredHandles !== undefined) {
					for (const declaration of entry.declaredHandles(args.input)) {
						const existing = scratch.lookup(declaration.handle);
						if (
							declaration.referenceIfBound === true &&
							existing?.entityKind === declaration.entityKind
						) {
							continue;
						}
						const uuid = scratch.declare(
							declaration.handle,
							declaration.entityKind,
						);
						allocations.push({
							handle: declaration.handle,
							uuid,
							entityKind: declaration.entityKind,
						});
					}
				}
				resolvedInput = resolveHandleRefs(args.input, scratch).resolved;
			} catch (error) {
				if (!(error instanceof ChangeSetStagingRejectedError)) throw error;
				const receipt = await this.persistRejection({
					toolName: args.toolName,
					requestId,
					inputDigest,
					expectedRevision,
					code: error.code,
					message: error.message,
					...(args.deadlineAt !== undefined && {
						deadlineAt: args.deadlineAt,
					}),
				});
				return {
					replayed: false,
					result: { error: error.message } as T,
					receipt,
				};
			}

			const invocationState: InvocationWriteState = {
				writesUsed: 0,
				lookupCaptures: [],
				receipt: undefined,
			};
			const ctx = this.buildInvocationContext({
				toolName: args.toolName,
				requestId,
				invocationOrdinal,
				expectedRevision,
				inputDigest,
				allocations,
				scratch,
				state: invocationState,
				intentIds: args.intentIds ?? [],
				...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			});
			const result = await args.execute(ctx, resolvedInput);
			return {
				replayed: false,
				result,
				...(invocationState.receipt !== undefined && {
					receipt: invocationState.receipt,
				}),
			};
		};

		const next = this.chain.then(run);
		this.chain = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	private buildInvocationContext(args: {
		toolName: string;
		requestId: string;
		invocationOrdinal: number;
		expectedRevision: number;
		inputDigest: string;
		allocations: readonly StageHandleAllocation[];
		scratch: HandleTable;
		state: InvocationWriteState;
		intentIds: readonly DesignId[];
		deadlineAt?: number;
	}): ToolInvocationContext {
		const snapshot = this.currentSnapshot();
		const { state } = args;

		const consumeWriteBudget = (operation: string): void => {
			if (state.writesUsed > 0) {
				throw new Error(
					`[change-set workspace] ${args.toolName} attempted a second workspace mutation (${operation}); one invocation may perform at most one.`,
				);
			}
			state.writesUsed += 1;
			if (snapshot.revision !== this.changeSet.revision) {
				throw new Error(
					`[change-set workspace] ${args.toolName} presented a stale workspace revision (read ${snapshot.revision}, current ${this.changeSet.revision}).`,
				);
			}
		};

		const hostLookupDefinitions = this.host.lookupDefinitions;
		const hostLookupCatalog = this.host.lookupCatalog;

		const stage = async (staged: {
			readonly mutations: AdmittedMutationBatch;
			readonly slices: readonly AdmittedMutationStageSlice[];
			readonly policyOrganizationRevision?: string;
			readonly intentIds?: readonly DesignId[];
			readonly readSet?: readonly ExternalReadDependency[];
		}): Promise<WorkspaceMutationOutcome> => {
			const outcome = await this.applyStagedBatch({
				toolName: args.toolName,
				requestId: args.requestId,
				inputDigest: args.inputDigest,
				expectedRevision: args.expectedRevision,
				allocations: args.allocations,
				scratch: args.scratch,
				lookupCaptures: state.lookupCaptures,
				...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
				...staged,
			});
			if (outcome.kind === "staged") {
				state.receipt = outcome.receipt;
				return {
					ok: true,
					newDoc: this.overlayDoc,
					mutations: outcome.mutations,
					staged: outcome.receipt,
				};
			}
			if (outcome.kind === "rejected-receipt") {
				state.receipt = outcome.receipt;
			}
			return { ok: false, error: outcome.message };
		};

		return {
			appId: this.changeSet.appId,
			projectId: this.changeSet.baseProjectId,
			userId: this.host.actorUserId,
			runId: this.host.runId,
			...(this.host.chatRunHolder !== undefined && {
				chatRunHolder: this.host.chatRunHolder,
			}),
			snapshot,
			invocation: {
				requestId: args.requestId,
				invocationOrdinal: args.invocationOrdinal,
				toolName: args.toolName,
			},
			...(hostLookupDefinitions !== undefined && {
				lookupDefinitions: async (tableIds) => {
					const result = await hostLookupDefinitions(tableIds);
					state.lookupCaptures.push(...lookupSnapshotDependencies(result));
					return result;
				},
			}),
			...(hostLookupCatalog !== undefined && {
				lookupCatalog: async () => {
					const result = await hostLookupCatalog();
					state.lookupCaptures.push(...lookupSnapshotDependencies(result));
					return result;
				},
			}),
			conversionImpact: (impactArgs) => this.host.conversionImpact(impactArgs),
			applyBatch: async ({
				mutations,
				stage: stageTag,
				policy,
				intentIds,
				readSet,
			}) => {
				consumeWriteBudget("applyBatch");
				let admitted: AdmittedMutationBatch;
				try {
					admitted = admitMutationBatch(mutations);
				} catch (error) {
					if (!(error instanceof MutationWireCanonicalityError)) throw error;
					state.receipt = await this.persistRejection({
						toolName: args.toolName,
						requestId: args.requestId,
						inputDigest: args.inputDigest,
						expectedRevision: args.expectedRevision,
						code: "WIRE_CANONICALITY_INVALID",
						message: error.message,
						...(args.deadlineAt !== undefined && {
							deadlineAt: args.deadlineAt,
						}),
					});
					return { ok: false, error: error.message };
				}
				return stage({
					mutations: admitted,
					slices:
						stageTag === undefined || admitted.length === 0
							? []
							: [{ stage: stageTag, start: 0, end: admitted.length }],
					...(policy?.expectedOrganizationRevision !== undefined && {
						policyOrganizationRevision: String(
							policy.expectedOrganizationRevision,
						),
					}),
					intentIds: args.intentIds.length > 0 ? args.intentIds : intentIds,
					...(readSet !== undefined && { readSet }),
				});
			},
			applyStages: async ({ stages, intentIds, readSet }) => {
				consumeWriteBudget("applyStages");
				let admitted: ReturnType<typeof admitMutationStages>;
				try {
					admitted = admitMutationStages(stages);
				} catch (error) {
					if (!(error instanceof MutationWireCanonicalityError)) throw error;
					state.receipt = await this.persistRejection({
						toolName: args.toolName,
						requestId: args.requestId,
						inputDigest: args.inputDigest,
						expectedRevision: args.expectedRevision,
						code: "WIRE_CANONICALITY_INVALID",
						message: error.message,
						...(args.deadlineAt !== undefined && {
							deadlineAt: args.deadlineAt,
						}),
					});
					return { ok: false, error: error.message };
				}
				return stage({
					mutations: admitted.batch,
					slices: admitted.slices,
					intentIds: args.intentIds.length > 0 ? args.intentIds : intentIds,
					...(readSet !== undefined && { readSet }),
				});
			},
			adoptAuthoritativeSnapshot: () => {
				throw new Error(
					`[change-set workspace] ${args.toolName} attempted adoptAuthoritativeSnapshot, which has no meaning for a private overlay — the change set's replayed state is always current, and no external service can prove a fresher private candidate.`,
				);
			},
		};
	}

	// ── Staging internals ────────────────────────────────────────────

	/**
	 * Replace every piece of in-memory state with the durable truth — after a
	 * store-level replay convergence proved another continuation landed state
	 * this instance never saw. The introduced/resolved delta baseline resets;
	 * the next receipt's fingerprints re-seed it.
	 */
	private async resyncFromDurable(): Promise<void> {
		const changeSet = await loadChangeSet(this.changeSet.id);
		if (changeSet === undefined) {
			throw new ChangeSetScopeLostError("This change set no longer exists.");
		}
		const rehydrated = await rehydrateChangeSet(changeSet);
		this.changeSet = changeSet;
		this.steps = [...rehydrated.steps];
		this.overlayDoc = rehydrated.overlay.doc;
		this.handleTable = new HandleTable(rehydrated.handles);
		this.accumulatedReadSet = [...rehydrated.accumulatedReadSet];
		this.lastSummaryFingerprints = [];
	}

	private replayedResult(receipt: StageRequestReceipt): unknown {
		if (receipt.disposition === "rejected") {
			return { error: receipt.error?.message ?? "This request was rejected." };
		}
		/* The receipt IS the replay contract: identical handles, mutation
		 * digest, diagnostics, and workspace revision, with the minted
		 * identities recoverable from the receipt's handle map and the step's
		 * exact mutations (an identity minted without a handle rides inside
		 * its add mutation). A staged receipt whose step is missing is
		 * receipt/step divergence — corruption, never a silent empty batch. */
		const step = this.steps.find(
			(entry) => entry.requestId === receipt.requestId,
		);
		if (step === undefined) {
			throw new ChangeSetIntegrityError(
				`Change set ${this.changeSet.id} holds a staged receipt for request ${receipt.requestId} but no matching step.`,
			);
		}
		return {
			kind: "mutate",
			mutations: step.mutations,
			result: { receipt },
		};
	}

	private async persistRejection(args: {
		readonly toolName: string;
		readonly requestId: string;
		readonly inputDigest: string;
		readonly expectedRevision: number;
		readonly code: ChangeSetStageErrorCode;
		readonly message: string;
		readonly deadlineAt?: number;
	}): Promise<StageRequestReceipt> {
		const { receipt } = await stageChangeSetRequest({
			changeSetId: this.changeSet.id,
			requestId: args.requestId,
			toolName: args.toolName,
			inputDigest: args.inputDigest,
			expectedRevision: args.expectedRevision,
			actorUserId: this.host.actorUserId,
			runId: this.host.runId,
			...(this.host.chatRunHolder !== undefined && {
				chatRunHolder: this.host.chatRunHolder,
			}),
			...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			outcome: { kind: "reject", code: args.code, message: args.message },
		});
		return receipt;
	}

	private async lookupContextFor(
		prevDoc: BlueprintDoc,
		nextDoc: BlueprintDoc,
	): Promise<LookupValidationContext> {
		const targets = unionLookupReferenceTargetSets(
			extractLookupReferenceTargets(prevDoc),
			extractLookupReferenceTargets(nextDoc),
		);
		if (targets.tableIds.length === 0) return LOOKUP_CONTEXT_UNAVAILABLE;
		if (this.host.lookupDefinitions === undefined) {
			return LOOKUP_CONTEXT_UNAVAILABLE;
		}
		const snapshot = await this.host.lookupDefinitions(targets.tableIds);
		return {
			kind: "available",
			projectId: snapshot.projectId,
			projectRevision: snapshot.projectRevision,
			definitions: snapshot.definitions,
		};
	}

	private async applyStagedBatch(args: {
		readonly toolName: string;
		readonly requestId: string;
		readonly inputDigest: string;
		readonly expectedRevision: number;
		readonly allocations: readonly StageHandleAllocation[];
		readonly scratch: HandleTable;
		readonly lookupCaptures: readonly ExternalReadDependency[];
		readonly deadlineAt?: number;
		readonly mutations: AdmittedMutationBatch;
		readonly slices: readonly AdmittedMutationStageSlice[];
		readonly policyOrganizationRevision?: string;
		readonly intentIds?: readonly DesignId[];
		readonly readSet?: readonly ExternalReadDependency[];
	}): Promise<
		| {
				kind: "staged";
				receipt: StageRequestReceipt;
				mutations: AdmittedMutationBatch;
		  }
		| {
				kind: "rejected-receipt";
				receipt: StageRequestReceipt;
				message: string;
		  }
		| { kind: "plain-error"; message: string }
	> {
		const reject = async (
			code: ChangeSetStageErrorCode,
			message: string,
		): Promise<{
			kind: "rejected-receipt";
			receipt: StageRequestReceipt;
			message: string;
		}> => ({
			kind: "rejected-receipt",
			receipt: await this.persistRejection({
				toolName: args.toolName,
				requestId: args.requestId,
				inputDigest: args.inputDigest,
				expectedRevision: args.expectedRevision,
				code,
				message,
				...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			}),
			message,
		});

		/* The batch-exclusive fence — person-readable rejections here; the
		 * store repeats both checks as loud integrity backstops under its
		 * lock. */
		const exclusive = batchExclusiveKind(args.mutations);
		if (this.changeSet.exclusiveKind !== null) {
			return reject(
				"EXCLUSIVE_SET_CLOSED",
				`This change set already holds its batch-exclusive ${this.changeSet.exclusiveKind} step, which must commit alone. Commit or discard it before staging anything else.`,
			);
		}
		if (exclusive !== null && this.steps.length > 0) {
			return reject(
				"EXCLUSIVE_NOT_ALONE",
				`A ${exclusive} batch is batch-exclusive and must own its change set alone, but this change set already holds ${this.steps.length} staged step(s). Open a dedicated change set for it.`,
			);
		}
		if (args.mutations.length === 0) {
			return {
				kind: "plain-error",
				message: "This change did not contain any edits.",
			};
		}

		/* Prepare against the private overlay: admission failures reject
		 * BEFORE the step appends; validator findings do not. */
		let prepared: PreparedMutationCandidate;
		try {
			prepared = prepareMutationCandidate(this.overlayDoc, args.mutations);
		} catch (error) {
			return reject(
				"REDUCER_FAILURE",
				`This change could not be applied to the private candidate: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const admissionCode: ChangeSetStageErrorCode | undefined =
			prepared.identityAdmissionIssue !== undefined
				? "IDENTITY_COLLISION"
				: prepared.sequenceAdmissionIssue !== undefined
					? "SEQUENCE_ANCHOR_INVALID"
					: prepared.targetAdmissionIssue === true
						? "TARGET_INVALID"
						: prepared.renamePlanIssue !== undefined
							? "RENAME_PLAN_INVALID"
							: undefined;
		if (admissionCode !== undefined) {
			const verdict = evaluatePreparedMutationCandidate(
				prepared,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			return reject(
				admissionCode,
				verdict.ok
					? "This change was rejected before staging."
					: describeCommitFindings(verdict.findings),
			);
		}

		/* Read-set capture: lookup reads recorded by the wrapped readers AND
		 * by this step's own diagnostics resolution, the organization fence
		 * from the write policy, media identities from the authored-asset-ref
		 * delta, plus any explicit entries. */
		const captured: ExternalReadDependency[] = [
			...args.lookupCaptures,
			...(args.readSet ?? []),
		];
		if (args.policyOrganizationRevision !== undefined) {
			captured.push({
				kind: "organization",
				projectId: this.changeSet.baseProjectId,
				revision: args.policyOrganizationRevision,
			});
		}
		const prevAssets = new Set(
			[...walkAuthoredAssetRefs(asWalkableDoc(this.overlayDoc))].map(
				(ref) => ref.assetId,
			),
		);
		const newAssets = [
			...new Set(
				[...walkAuthoredAssetRefs(asWalkableDoc(prepared.nextDoc))]
					.map((ref) => ref.assetId)
					.filter((assetId) => !prevAssets.has(assetId)),
			),
		];
		captured.push(
			...(await mediaAssetDependencies(
				this.changeSet.baseProjectId,
				newAssets,
			)),
		);

		const lookupContext = await this.lookupContextFor(
			this.overlayDoc,
			prepared.nextDoc,
		);
		if (lookupContext.kind === "available") {
			captured.push(
				...lookupSnapshotDependencies({
					projectId: lookupContext.projectId,
					projectRevision: lookupContext.projectRevision,
					definitions: lookupContext.definitions,
				}),
			);
		}

		/* The required-read-set fence: a tool whose reviewed policy declares
		 * external read sets stages only when the matching dependencies were
		 * actually captured — an organization-derived result without its
		 * fenced revision, or a lookup-referencing candidate with no Project
		 * definitions reader, must not become a silently unfenced step. */
		const policy = changeSetToolEntry(args.toolName)?.policy;
		if (policy !== undefined) {
			const capturedKinds = new Set(captured.map((entry) => entry.kind));
			if (
				policy.readSets.includes("organization") &&
				!capturedKinds.has("organization")
			) {
				return reject(
					"READ_SET_UNRECORDED",
					`${args.toolName} derives its result from the app's organization state, but this staged write carried no organization revision to fence. Pass the exact revision the result was derived from and retry.`,
				);
			}
			const declaresLookups =
				policy.readSets.includes("lookup-definition") ||
				policy.readSets.includes("lookup-column");
			const candidateLookupTargets = unionLookupReferenceTargetSets(
				extractLookupReferenceTargets(this.overlayDoc),
				extractLookupReferenceTargets(prepared.nextDoc),
			);
			if (
				declaresLookups &&
				candidateLookupTargets.tableIds.length > 0 &&
				lookupContext.kind !== "available"
			) {
				return reject(
					"READ_SET_UNRECORDED",
					`${args.toolName} references Project data tables, but this workspace has no Project data reader to record their current definitions. Retry on a surface that supplies one.`,
				);
			}
		}

		const stepReadSet = normalizeReadSet(captured);
		const nextAccumulated = normalizeReadSet([
			...this.accumulatedReadSet,
			...captured,
		]);
		const nextSnapshot = toPersistableDoc(prepared.nextDoc);
		const nextSteps: ChangeSetStep[] = [
			...this.steps,
			{
				ordinal: this.changeSet.nextOrdinal,
				requestId: args.requestId,
				toolName: args.toolName,
				mutations: args.mutations,
				mutationDigest: canonicalJsonDigest(args.mutations),
				intentIds: args.intentIds ?? [],
				readSet: stepReadSet,
				stages: args.slices.map((slice, index) => ({
					stageOrdinal: index,
					stageName: slice.stage,
					mutationStart: slice.start,
					mutationCount: slice.end - slice.start,
				})),
			},
		];
		const readSetStatus = await evaluateReadSetCurrency({
			appId: this.changeSet.appId,
			dependencies: nextAccumulated,
		});
		const diagnostics = computeChangeSetDiagnostics({
			changeSet: {
				kind: this.changeSet.kind,
				revision: this.changeSet.revision + 1,
				exclusiveKind: exclusive,
			},
			overlaySnapshot: nextSnapshot,
			overlay: prepared.nextDoc,
			lookupContext,
			steps: nextSteps,
			readSetStatus,
			previousFingerprints: this.lastSummaryFingerprints,
		});
		const summary = summarizeDiagnostics(diagnostics);

		const { replayed, receipt } = await stageChangeSetRequest({
			changeSetId: this.changeSet.id,
			requestId: args.requestId,
			toolName: args.toolName,
			inputDigest: args.inputDigest,
			expectedRevision: args.expectedRevision,
			actorUserId: this.host.actorUserId,
			runId: this.host.runId,
			...(this.host.chatRunHolder !== undefined && {
				chatRunHolder: this.host.chatRunHolder,
			}),
			...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			outcome: {
				kind: "stage",
				mutations: args.mutations,
				stageSlices: args.slices,
				handles: args.allocations,
				intentIds: args.intentIds ?? [],
				readSet: stepReadSet,
				exclusiveKind: exclusive,
				diagnostics: summary,
			},
		});
		if (replayed) {
			/* A concurrent continuation of this run landed the SAME request
			 * durably between this invocation's ledger pre-check and the stage
			 * transaction. The durable step — possibly carrying the winner's
			 * differently minted identities — is the truth; nothing locally
			 * prepared (scratch handle bindings, the local candidate) may
			 * shadow it. Resync wholesale and answer from the stored step. */
			await this.resyncFromDurable();
			const durableStep = this.steps.find(
				(entry) => entry.requestId === args.requestId,
			);
			if (durableStep === undefined) {
				throw new ChangeSetIntegrityError(
					`Change set ${this.changeSet.id} replayed request ${args.requestId} without its stored step.`,
				);
			}
			return { kind: "staged", receipt, mutations: durableStep.mutations };
		}

		/* Durable truth advanced — adopt the staged state in memory so the
		 * next invocation builds on it. */
		this.overlayDoc = prepared.nextDoc;
		this.steps = nextSteps;
		this.handleTable = args.scratch;
		this.accumulatedReadSet = nextAccumulated;
		this.lastSummaryFingerprints = summary.findingFingerprints;
		this.changeSet = {
			...this.changeSet,
			revision: this.changeSet.revision + 1,
			nextOrdinal: this.changeSet.nextOrdinal + 1,
			...(exclusive !== null && { exclusiveKind: exclusive }),
		};
		return { kind: "staged", receipt, mutations: args.mutations };
	}
}

interface InvocationWriteState {
	writesUsed: number;
	lookupCaptures: ExternalReadDependency[];
	receipt: StageRequestReceipt | undefined;
}
