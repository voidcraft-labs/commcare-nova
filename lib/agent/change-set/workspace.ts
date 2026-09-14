/** Private mutation workspace. Each serialized invocation prepares authored
 * input, appends its canonical mutations, and saves the exact result with the
 * workspace revision in one transaction. Retrying a request returns its receipt.
 * Candidates may have validation findings while they are being built; only the
 * separate checkpoint commit can publish a complete valid app.
 */

import { ZodError } from "zod";
import { AuthoringInputError } from "@/lib/agent/authoring/errors";
import { prepareAuthoringInput } from "@/lib/agent/authoring/input";
import { projectAuthoringReadInContext } from "@/lib/agent/authoring/output";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import type {
	ConversionImpactFn,
	ToolInvocationContext,
	ToolWorkspace,
	WorkspaceMutationOutcome,
	WorkspaceSnapshot,
} from "@/lib/agent/workspace/types";
import type { ChatRunHolderCapability } from "@/lib/db/apps";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import {
	describeCommitFindings,
	evaluatePreparedMutationCandidate,
	exportReadinessFindings,
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
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	builtinAssetRows,
	partitionAssetRefs,
} from "@/lib/media/builtinIconAssets";
import {
	type ChangeSetDiagnostics,
	computeChangeSetDiagnostics,
	evaluateOverlayFindings,
	summarizeDiagnostics,
} from "./diagnostics";
import { canonicalJsonDigest, workspaceCallInputDigest } from "./digest";
import {
	ChangeSetIntegrityError,
	ChangeSetRequestIdCollisionError,
	ChangeSetScopeLostError,
	type ChangeSetStageErrorCode,
	ChangeSetStagingRejectedError,
} from "./errors";
import { changeSetToolEntry } from "./registry";
import { rehydrateChangeSet } from "./runtime";
import {
	type MutationReplayResult,
	mutationReplayResultSchema,
	type StageRequestReceipt,
} from "./schemas";
import {
	loadChangeSet,
	lookupStageRequest,
	stageChangeSetRequest,
} from "./store";
import {
	batchExclusiveKind,
	type ChangeSetStep,
	type DesignChangeSet,
} from "./types";

/** The Project data readers + services a change-set workspace runs over. */
export interface ChangeSetWorkspaceHost {
	readonly actorUserId: string;
	readonly runId: string;
	readonly chatRunHolder: ChatRunHolderCapability;
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

async function genesisFinalizationFindings(args: {
	readonly changeSet: Pick<DesignChangeSet, "kind" | "baseProjectId">;
	readonly overlay: BlueprintDoc;
	readonly lookupContext: LookupValidationContext;
}): Promise<ReturnType<typeof exportReadinessFindings>> {
	if (args.changeSet.kind !== "genesis") return [];
	const { realIds, builtinSlugs } = partitionAssetRefs([
		...collectAssetRefs(args.overlay),
	]);
	const realRows =
		realIds.length === 0
			? []
			: await loadAssetsByIds(realIds, args.changeSet.baseProjectId);
	const rows = [...realRows, ...builtinAssetRows(builtinSlugs)];
	return exportReadinessFindings(
		args.overlay,
		args.lookupContext,
		new Map(rows.map((row) => [row.id as string, row])),
	);
}

interface DispatchArgs<T> {
	readonly toolName: string;
	readonly requestId?: string;
	/** The caller's exact request — required at runtime (it keys the durable
	 * idempotency digest); optional in the type only so the shared
	 * `ToolWorkspace` contract remains satisfied. */
	readonly input?: unknown;
	readonly deadlineAt?: number;
	readonly prepare?: StagedInputPreparation;
	execute(ctx: ToolInvocationContext, resolvedInput?: unknown): Promise<T>;
}

export interface PreparedStagedInput {
	readonly input: unknown;
}

/** Runs once inside the serialized invocation, after durable replay lookup.
 * Preparation may bind authored values and accepted construction facts, but
 * shared tools remain the only mutation owners. */
export type StagedInputPreparation = (
	ctx: ToolInvocationContext,
	input: unknown,
) => Promise<PreparedStagedInput>;

export class ChangeSetMutationWorkspace implements ToolWorkspace {
	readonly mode = "change-set" as const;

	private changeSet: DesignChangeSet;
	private steps: ChangeSetStep[];
	private overlayDoc: BlueprintDoc;
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
	}) {
		this.host = args.host;
		this.changeSet = args.changeSet;
		this.steps = args.steps;
		this.overlayDoc = args.overlayDoc;
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
		});
	}

	currentSnapshot(): WorkspaceSnapshot {
		return {
			mode: this.mode,
			doc: this.overlayDoc,
			revision: this.changeSet.revision,
			canonicalSeq: this.changeSet.baseSeq,
			projectId: this.changeSet.baseProjectId,
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
		/** Absolute executor deadline. Direct/non-executor callers omit it. */
		readonly deadlineAt?: number;
		readonly prepare?: StagedInputPreparation;
	}): Promise<
		StageDispatchResult<
			Awaited<
				ReturnType<
					import("@/lib/agent/sharedToolRegistry").SharedToolRegistryEntry["tool"]["execute"]
				>
			>
		>
	> {
		const entry = changeSetToolEntry(args.toolName);
		if (entry === undefined) {
			throw new ChangeSetStagingRejectedError(
				"TOOL_NOT_ALLOWED",
				`Tool ${args.toolName} is not available in a change set. External-effect and lifecycle tools run only on canonical surfaces.`,
			);
		}
		return this.dispatchEngine({
			toolName: args.toolName,
			requestId: args.requestId,
			input: args.input,
			...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			prepare:
				args.prepare ??
				(async (ctx, input) => {
					try {
						return {
							input: await prepareAuthoringInput({
								toolName: args.toolName,
								schema: entry.tool.inputSchema,
								input: authoringToolSchema(
									args.toolName,
									entry.tool.inputSchema,
								).authored.parse(input),
								ctx,
							}),
						};
					} catch (error) {
						if (
							error instanceof AuthoringInputError ||
							error instanceof ZodError
						)
							throw new ChangeSetStagingRejectedError(
								"TOOL_INPUT_INVALID",
								error instanceof ZodError
									? error.issues
											.map(
												(issue) =>
													`${issue.path.join(".") || "input"}: ${issue.message}`,
											)
											.join("; ")
									: error.message,
							);
						throw error;
					}
				}),
			execute: async (ctx, resolvedInput) => {
				const parsed = entry.tool.inputSchema.safeParse(resolvedInput);
				if (!parsed.success) {
					throw new ChangeSetStagingRejectedError(
						"TOOL_INPUT_INVALID",
						`The ${args.toolName} input was invalid: ${parsed.error.issues
							.map(
								(issue) =>
									`${issue.path.join(".") || "(root)"}: ${issue.message}`,
							)
							.join("; ")}`,
					);
				}
				const result = await entry.tool.execute(parsed.data, ctx);
				return result.kind === "read"
					? {
							...result,
							data: await projectAuthoringReadInContext(
								args.toolName,
								result.data,
								ctx,
							),
						}
					: result;
			},
		});
	}

	/**
	 * Full diagnostics over the CURRENT rehydrated candidate. The executor's
	 * server-owned workflow finalizer and commit preconditions consult this.
	 */
	async inspect(): Promise<ChangeSetDiagnostics> {
		return (await this.inspectState()).diagnostics;
	}

	/** The same authorized, rows-free lookup snapshot informs diagnostics and
	 * readable repair context. It is never a second catalog or a new write. */
	async inspectState() {
		const snapshot = this.currentSnapshot();
		const changeSet = this.changeSet;
		const steps = [...this.steps];
		const lookupContext = await this.lookupContextFor(
			snapshot.doc,
			snapshot.doc,
		);
		const findings = evaluateOverlayFindings(snapshot.doc, lookupContext);
		const finalizationFindings =
			findings.length === 0
				? await genesisFinalizationFindings({
						changeSet,
						overlay: snapshot.doc,
						lookupContext,
					})
				: [];
		const diagnostics = computeChangeSetDiagnostics({
			changeSet,
			overlaySnapshot: toPersistableDoc(snapshot.doc),
			overlay: snapshot.doc,
			findings,
			finalizationFindings,
			steps,
			previousFingerprints: this.lastSummaryFingerprints,
		});
		return { snapshot, lookupContext, diagnostics };
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
				const replayDigest = workspaceCallInputDigest({
					toolName: args.toolName,
					expectedWorkspaceRevision: stored.expectedRevision,
					projectedInput: { input: args.input },
				});
				if (
					stored.toolName !== args.toolName ||
					stored.inputDigest !== replayDigest
				) {
					throw new ChangeSetRequestIdCollisionError();
				}
				// A different continuation may have committed after this workspace
				// opened. Its receipt can only be replayed against durable state that
				// includes the winning step and the winner's allocated identities.
				if (stored.resultingRevision > this.changeSet.revision) {
					await this.resyncFromDurable();
				}
				return {
					replayed: true,
					result: this.replayedResult(stored.receipt) as T,
					receipt: stored.receipt,
				};
			}

			const expectedRevision = this.changeSet.revision;
			const inputDigest = workspaceCallInputDigest({
				toolName: args.toolName,
				expectedWorkspaceRevision: expectedRevision,
				projectedInput: { input: args.input },
			});

			let resolvedInput: unknown = args.input;
			const invocationState: InvocationWriteState = {
				writesUsed: 0,
				receipt: undefined,
				pending: undefined,
			};
			const ctx = this.buildInvocationContext({
				toolName: args.toolName,
				requestId,
				invocationOrdinal,
				expectedRevision,
				inputDigest,
				state: invocationState,
				...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			});
			if (args.prepare !== undefined) {
				const prepared = await args.prepare(ctx, args.input);
				resolvedInput = prepared.input;
			}
			const result = await args.execute(ctx, resolvedInput);
			if (invocationState.pending !== undefined) {
				const envelope = mutationReplayResult(result);
				if (typeof envelope.result.error !== "string") {
					invocationState.receipt = await invocationState.pending(envelope);
				}
			} else if (
				invocationState.receipt === undefined &&
				isSuccessfulMutationNoop(result)
			) {
				invocationState.receipt = await this.persistMutationNoop({
					toolName: args.toolName,
					requestId,
					inputDigest,
					expectedRevision,
					replayResult: mutationReplayResult(result),
					...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
				});
			}
			return {
				replayed: false,
				result:
					invocationState.receipt === undefined
						? result
						: (this.replayedResult(invocationState.receipt) as T),
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
		state: InvocationWriteState;
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
		}): Promise<WorkspaceMutationOutcome> => {
			const outcome = await this.applyStagedBatch({
				toolName: args.toolName,
				requestId: args.requestId,
				inputDigest: args.inputDigest,
				expectedRevision: args.expectedRevision,
				...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
				...staged,
			});
			if (outcome.kind === "prepared") {
				state.pending = outcome.persist;
				return { ok: true, newDoc: outcome.doc, mutations: staged.mutations };
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
			chatRunHolder: this.host.chatRunHolder,
			authoringSessionId: this.changeSet.designSessionId,
			snapshot,
			invocation: {
				requestId: args.requestId,
				invocationOrdinal: args.invocationOrdinal,
				toolName: args.toolName,
			},
			...(hostLookupDefinitions !== undefined && {
				lookupDefinitions: hostLookupDefinitions,
			}),
			...(hostLookupCatalog !== undefined && {
				lookupCatalog: hostLookupCatalog,
			}),
			conversionImpact: (impactArgs) => this.host.conversionImpact(impactArgs),
			applyBatch: async ({ mutations, stage: stageTag }) => {
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
				});
			},
			applyStages: async ({ stages }) => {
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
		this.lastSummaryFingerprints = [];
	}

	private replayedResult(receipt: StageRequestReceipt): unknown {
		if (receipt.disposition === "rejected") {
			return {
				kind: "mutate",
				mutations: [],
				result: {
					error: receipt.error?.message ?? "This request was rejected.",
				},
			};
		}
		if (receipt.replayResult === undefined) {
			throw new ChangeSetIntegrityError(
				`Workspace request ${receipt.requestId} has no recorded answer.`,
			);
		}
		if (receipt.disposition === "noop") return receipt.replayResult;
		const step = this.steps.find(
			(entry) => entry.requestId === receipt.requestId,
		);
		if (step === undefined) {
			throw new ChangeSetIntegrityError(
				`Workspace request ${receipt.requestId} has no matching mutation step.`,
			);
		}
		return { ...receipt.replayResult, mutations: step.mutations };
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
			chatRunHolder: this.host.chatRunHolder,
			...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			outcome: { kind: "reject", code: args.code, message: args.message },
		});
		return receipt;
	}

	private async persistMutationNoop(args: {
		readonly toolName: string;
		readonly requestId: string;
		readonly inputDigest: string;
		readonly expectedRevision: number;
		readonly deadlineAt?: number;
		readonly replayResult: MutationReplayResult;
	}): Promise<StageRequestReceipt> {
		const { receipt } = await stageChangeSetRequest({
			changeSetId: this.changeSet.id,
			requestId: args.requestId,
			toolName: args.toolName,
			inputDigest: args.inputDigest,
			expectedRevision: args.expectedRevision,
			actorUserId: this.host.actorUserId,
			runId: this.host.runId,
			chatRunHolder: this.host.chatRunHolder,
			...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
			outcome: {
				kind: "noop",
				replayResult: args.replayResult,
			},
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
		readonly deadlineAt?: number;
		readonly mutations: AdmittedMutationBatch;
		readonly slices: readonly AdmittedMutationStageSlice[];
	}): Promise<
		| {
				kind: "prepared";
				doc: BlueprintDoc;
				persist: (result: MutationReplayResult) => Promise<StageRequestReceipt>;
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
				"The pending change affects saved records and must be saved on its own. Save it before making another change.",
			);
		}
		if (exclusive !== null && this.steps.length > 0) {
			return reject(
				"EXCLUSIVE_NOT_ALONE",
				"This change affects saved records and must be saved on its own. Save the pending changes, then retry this change and save it separately.",
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

		// Resolve what the candidate references now. The canonical commit repeats
		// these checks under resource locks; past reads are not save conditions.
		const lookupContext = await this.lookupContextFor(
			this.overlayDoc,
			prepared.nextDoc,
		);

		const nextSnapshot = toPersistableDoc(prepared.nextDoc);
		const nextSteps: ChangeSetStep[] = [
			...this.steps,
			{
				ordinal: this.changeSet.nextOrdinal,
				requestId: args.requestId,
				toolName: args.toolName,
				mutations: args.mutations,
				mutationDigest: canonicalJsonDigest(args.mutations),
				stages: args.slices.map((slice, index) => ({
					stageOrdinal: index,
					stageName: slice.stage,
					mutationStart: slice.start,
					mutationCount: slice.end - slice.start,
				})),
			},
		];
		const findings = evaluateOverlayFindings(prepared.nextDoc, lookupContext);
		const finalizationFindings =
			findings.length === 0
				? await genesisFinalizationFindings({
						changeSet: this.changeSet,
						overlay: prepared.nextDoc,
						lookupContext,
					})
				: [];
		const diagnostics = computeChangeSetDiagnostics({
			changeSet: {
				kind: this.changeSet.kind,
				revision: this.changeSet.revision + 1,
				exclusiveKind: exclusive,
			},
			overlaySnapshot: nextSnapshot,
			overlay: prepared.nextDoc,
			findings,
			finalizationFindings,
			steps: nextSteps,
			previousFingerprints: this.lastSummaryFingerprints,
		});
		const summary = summarizeDiagnostics(diagnostics);
		return {
			kind: "prepared",
			doc: prepared.nextDoc,
			persist: async (replayResult) => {
				const { replayed, receipt } = await stageChangeSetRequest({
					changeSetId: this.changeSet.id,
					requestId: args.requestId,
					toolName: args.toolName,
					inputDigest: args.inputDigest,
					expectedRevision: args.expectedRevision,
					actorUserId: this.host.actorUserId,
					runId: this.host.runId,
					chatRunHolder: this.host.chatRunHolder,
					...(args.deadlineAt !== undefined && { deadlineAt: args.deadlineAt }),
					outcome: {
						kind: "stage",
						mutations: args.mutations,
						stageSlices: args.slices,
						exclusiveKind: exclusive,
						diagnostics: summary,
						replayResult,
					},
				});
				if (replayed) {
					await this.resyncFromDurable();
					return receipt;
				}

				/* Durable truth advanced — adopt the staged state in memory so the
				 * next invocation builds on it. */
				this.overlayDoc = prepared.nextDoc;
				this.steps = nextSteps;
				this.lastSummaryFingerprints = summary.findingFingerprints;
				this.changeSet = {
					...this.changeSet,
					revision: this.changeSet.revision + 1,
					nextOrdinal: this.changeSet.nextOrdinal + 1,
					...(exclusive !== null && { exclusiveKind: exclusive }),
				};
				return receipt;
			},
		};
	}
}

interface InvocationWriteState {
	writesUsed: number;
	receipt: StageRequestReceipt | undefined;
	pending:
		| ((result: MutationReplayResult) => Promise<StageRequestReceipt>)
		| undefined;
}

function isSuccessfulMutationNoop(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as {
		kind?: unknown;
		mutations?: unknown;
		result?: unknown;
	};
	if (candidate.kind !== "mutate" || !Array.isArray(candidate.mutations)) {
		return false;
	}
	if (candidate.mutations.length !== 0) return false;
	return !(
		candidate.result !== null &&
		typeof candidate.result === "object" &&
		typeof (candidate.result as { error?: unknown }).error === "string"
	);
}

/** JSON is the durable/model boundary. Omit optional undefined properties once. */
function mutationReplayResult(value: unknown): MutationReplayResult {
	if (value === null || typeof value !== "object" || !("mutations" in value)) {
		throw new ChangeSetIntegrityError(
			"A private mutation returned no tool-result envelope.",
		);
	}
	return mutationReplayResultSchema.parse(
		JSON.parse(JSON.stringify({ ...value, mutations: [] })),
	);
}
