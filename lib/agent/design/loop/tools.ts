/**
 * Server-gated design tools. Contract, revision, and plan authoring is a
 * durable sequence of bounded identity-addressed stages; the submit tools are
 * small finalizers that compose, fully validate, and atomically persist one
 * immutable artifact.
 */

import { jsonSchema } from "ai";
import { type ZodError, z } from "zod";
import {
	type DesignArtifactWriteAuthority,
	insertDesignBuildPlan,
	insertDesignReview,
	insertDesignRevision,
} from "@/lib/agent/design/artifactStore";
import {
	type DesignArtifactKind,
	type DesignArtifactWorkspaceLineage,
	designWorkspaceBoundError,
	finalizeDesignWorkspaceInputSchema,
	inspectDesignWorkspaceCandidate,
	inspectDesignWorkspaceInputSchema,
	stageContractInputSchema,
	stagePlanInputSchema,
	stageRevisionInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	DesignArtifactWorkspaceError,
	inspectDesignArtifactWorkspace,
	stageDesignArtifactWorkspace,
} from "@/lib/agent/design/artifactWorkspaceStore";
import {
	buildPlanDraftSchema,
	buildPlanSchemaFor,
	newPlanAdmissionMessages,
} from "@/lib/agent/design/buildPlan";
import { DESIGN_EFFORT_TIME_ESTIMATES } from "@/lib/agent/design/complexity";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import {
	changesArchitecture,
	composePlan,
	contractEnvelope,
	criticalFindingCount,
	leavesCriticalFinding,
	mapDispositionsToReviews,
	planEnvelope,
	reviewEnvelope,
} from "@/lib/agent/design/loop/artifacts";
import {
	type DesignAncestry,
	type DesignGateState,
	type DesignLoopToolName,
	type DesignRepairTracker,
	evaluateDesignGates,
} from "@/lib/agent/design/loop/gates";
import { DESIGN_PROMPT_VERSIONS } from "@/lib/agent/design/prompts";
import {
	designRevisionResultSchemaFor,
	validateSensitivityNotSilentlyLowered,
} from "@/lib/agent/design/review";
import { runDesignReviewer } from "@/lib/agent/design/reviewer";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import type { StructuredModelRunContext } from "@/lib/agent/modelRunContext";
import {
	strictWireJsonSchema,
	stripNullProperties,
} from "@/lib/agent/strictStructuredOutput";

export interface DesignLoopToolDeps {
	readonly designSessionId: string;
	readonly runId: string;
	readonly authority: DesignArtifactWriteAuthority;
	readonly currentPkg: DesignSourcePackage;
	readonly catalogText: string;
	readonly ctx: StructuredModelRunContext;
	readonly signal: AbortSignal;
	readonly repair: DesignRepairTracker;
	readonly loadAncestry: () => Promise<DesignAncestry>;
	readonly rebuildPackageForDigest: (
		digest: string,
	) => Promise<DesignSourcePackage | null>;
	readonly onReviewActivity?: (deltaChars: number) => void;
	readonly onReviewerReasoning?: (text: string) => void;
}

function strictWireOnly(schema: z.ZodType) {
	return jsonSchema<unknown>(strictWireJsonSchema(schema) as never);
}

export function renderDesignValidationIssues(error: ZodError): string {
	const shown = error.issues.slice(0, 25);
	const lines = shown.map(
		(issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`,
	);
	const more = error.issues.length - shown.length;
	return [
		"The submission failed Nova's design validation. Correct these exact items, then finalize again:",
		...lines,
		...(more > 0 ? [`(and ${more} more issues of the same kinds)`] : []),
	].join("\n");
}

interface ToolError {
	readonly error: string;
}

async function gatesFor(deps: DesignLoopToolDeps): Promise<DesignGateState> {
	return evaluateDesignGates(await deps.loadAncestry());
}

function refuse(
	deps: DesignLoopToolDeps,
	gates: DesignGateState,
	name: DesignLoopToolName,
): ToolError | null {
	const verdict = gates.verdicts[name];
	if (verdict.legal) {
		deps.repair.noteLegalCall();
		return null;
	}
	deps.repair.noteSequenceError();
	return { error: verdict.refusal };
}

function gateNameForKind(kind: DesignArtifactKind): DesignLoopToolName {
	return kind === "contract"
		? "submitContract"
		: kind === "revision"
			? "submitRevision"
			: "submitPlan";
}

export function designWorkspaceLineageForGates(
	kind: DesignArtifactKind,
	gates: DesignGateState,
): DesignArtifactWorkspaceLineage {
	const base = gates.head;
	return {
		schemaVersion: 1,
		artifactKind: kind,
		sourcePackageDigest: gates.currentPackageDigest,
		...(base !== null && {
			baseRevision: { id: base.id, digest: base.artifactDigest },
		}),
		reviewArtifacts:
			kind === "revision"
				? gates.headReviews.map((review) => ({
						id: review.id,
						digest: review.artifactDigest,
					}))
				: [],
	};
}

function workspaceError(error: unknown): ToolError | null {
	return error instanceof DesignArtifactWorkspaceError
		? { error: error.message }
		: null;
}

function parseStage<T>(schema: z.ZodType<T>, input: unknown) {
	const parsed = schema.safeParse(stripNullProperties(input));
	return parsed.success
		? ({ ok: true, data: parsed.data } as const)
		: ({
				ok: false,
				error: renderDesignValidationIssues(parsed.error),
			} as const);
}

export function createDesignLoopTools(deps: DesignLoopToolDeps) {
	const stageContract = {
		description:
			"Stage a bounded part of the Design Contract. Set root fields and/or upsert or remove complete identity-addressed collection items. A new workspace starts at revision 0; use the returned revision for the next stage. Keep each call within 32 item changes and 48 KiB.",
		inputSchema: strictWireOnly(stageContractInputSchema),
		strict: true,
		execute: async (
			input: unknown,
			options: { readonly toolCallId: string },
		) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitContract");
			if (refusal) return refusal;
			const parsed = parseStage(stageContractInputSchema, input);
			if (!parsed.ok) return { error: parsed.error };
			const { expectedRevision, ...body } = parsed.data;
			const operation = { kind: "contract" as const, ...body };
			const bound = designWorkspaceBoundError({
				input: parsed.data,
				operation,
			});
			if (bound !== null) return { error: bound };
			try {
				const result = await stageDesignArtifactWorkspace({
					designSessionId: deps.designSessionId,
					lineage: designWorkspaceLineageForGates("contract", gates),
					authority: deps.authority,
					toolCallId: options.toolCallId,
					expectedRevision,
					operation,
				});
				return {
					ok: true,
					workspaceRevision: result.state.workspace.revision,
					deduplicated: result.deduplicated,
					message:
						"This part of the contract is saved. Continue staging related items, inspect the workspace when needed, and submitContract only after the complete graph is ready.",
				};
			} catch (error) {
				const handled = workspaceError(error);
				if (handled) return handled;
				throw error;
			}
		},
	};

	const stageRevision = {
		description:
			"Stage a bounded part of the reviewed revision. Upsert or remove complete contract items and finding dispositions by identity; unchanged parent content stays in place. Use the returned workspace revision for the next stage.",
		inputSchema: strictWireOnly(stageRevisionInputSchema),
		strict: true,
		execute: async (
			input: unknown,
			options: { readonly toolCallId: string },
		) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitRevision");
			if (refusal) return refusal;
			const parsed = parseStage(stageRevisionInputSchema, input);
			if (!parsed.ok) return { error: parsed.error };
			const { expectedRevision, ...body } = parsed.data;
			const operation = { kind: "revision" as const, ...body };
			const bound = designWorkspaceBoundError({
				input: parsed.data,
				operation,
			});
			if (bound !== null) return { error: bound };
			try {
				const result = await stageDesignArtifactWorkspace({
					designSessionId: deps.designSessionId,
					lineage: designWorkspaceLineageForGates("revision", gates),
					authority: deps.authority,
					toolCallId: options.toolCallId,
					expectedRevision,
					operation,
				});
				return {
					ok: true,
					workspaceRevision: result.state.workspace.revision,
					deduplicated: result.deduplicated,
					message:
						"This part of the revision is saved. Continue with the remaining corrections and dispositions, then submitRevision to validate the complete result.",
				};
			} catch (error) {
				const handled = workspaceError(error);
				if (handled) return handled;
				throw error;
			}
		},
	};

	const stagePlan = {
		description:
			"Stage bounded build-plan rows. Upsert or remove complete slices, external actions, or intent-ownership rows by identity. Use the returned workspace revision for the next stage.",
		inputSchema: strictWireOnly(stagePlanInputSchema),
		strict: true,
		execute: async (
			input: unknown,
			options: { readonly toolCallId: string },
		) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitPlan");
			if (refusal) return refusal;
			const parsed = parseStage(stagePlanInputSchema, input);
			if (!parsed.ok) return { error: parsed.error };
			const { expectedRevision, ...body } = parsed.data;
			const operation = { kind: "plan" as const, ...body };
			const bound = designWorkspaceBoundError({
				input: parsed.data,
				operation,
			});
			if (bound !== null) return { error: bound };
			try {
				const result = await stageDesignArtifactWorkspace({
					designSessionId: deps.designSessionId,
					lineage: designWorkspaceLineageForGates("plan", gates),
					authority: deps.authority,
					toolCallId: options.toolCallId,
					expectedRevision,
					operation,
				});
				return {
					ok: true,
					workspaceRevision: result.state.workspace.revision,
					deduplicated: result.deduplicated,
					message:
						"These plan rows are saved. Continue until ownership and slice coverage are complete, then submitPlan to validate the whole plan.",
				};
			} catch (error) {
				const handled = workspaceError(error);
				if (handled) return handled;
				throw error;
			}
		},
	};

	const inspectDesignWorkspace = {
		description:
			"Inspect the authoritative staged candidate. Request a compact summary, root metadata, or up to 20 exact items from one collection. Revision and plan workspaces can also inspect the immutable source contract with sourceRoot or sourceCollection. Use this after resume or compaction and whenever the current workspace revision is uncertain.",
		inputSchema: strictWireOnly(inspectDesignWorkspaceInputSchema),
		strict: true,
		execute: async (input: unknown) => {
			const parsed = parseStage(inspectDesignWorkspaceInputSchema, input);
			if (!parsed.ok) return { error: parsed.error };
			const gates = await gatesFor(deps);
			const refusal = refuse(
				deps,
				gates,
				gateNameForKind(parsed.data.artifactKind),
			);
			if (refusal) return refusal;
			try {
				const state = await inspectDesignArtifactWorkspace({
					designSessionId: deps.designSessionId,
					lineage: designWorkspaceLineageForGates(
						parsed.data.artifactKind,
						gates,
					),
					authority: deps.authority,
					expectedRevision: parsed.data.expectedRevision,
				});
				return {
					ok: true,
					workspaceRevision: state.workspace.revision,
					stepCount: state.operations.length,
					view: inspectDesignWorkspaceCandidate({
						kind: state.workspace.artifactKind,
						candidate: state.candidate,
						...(state.sourceContract !== null && {
							sourceContract: state.sourceContract,
						}),
						selection: parsed.data.selection,
					}),
				};
			} catch (error) {
				const handled = workspaceError(error);
				if (handled) return handled;
				throw error;
			}
		},
	};

	const submitContract = {
		description:
			"Finalize the staged complete Design Contract at the exact workspace revision. The server replays every saved stage, validates the whole graph, and atomically persists the immutable draft or leaves the workspace open with exact diagnostics.",
		inputSchema: strictWireOnly(finalizeDesignWorkspaceInputSchema),
		strict: true,
		execute: async (input: unknown) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitContract");
			if (refusal) return refusal;
			const parsedInput = parseStage(finalizeDesignWorkspaceInputSchema, input);
			if (!parsedInput.ok) return { error: parsedInput.error };
			let state: Awaited<ReturnType<typeof inspectDesignArtifactWorkspace>>;
			try {
				state = await inspectDesignArtifactWorkspace({
					designSessionId: deps.designSessionId,
					lineage: designWorkspaceLineageForGates("contract", gates),
					authority: deps.authority,
					expectedRevision: parsedInput.data.expectedRevision,
				});
			} catch (error) {
				const handled = workspaceError(error);
				if (handled) return handled;
				throw error;
			}
			const parsed = appDesignContractSchema.safeParse(state.candidate);
			if (!parsed.success) {
				deps.repair.noteSchemaRejection(
					"submitContract",
					parsed.error.issues.length,
				);
				return { error: renderDesignValidationIssues(parsed.error) };
			}
			const head = gates.head;
			const draft = await insertDesignRevision({
				envelope: contractEnvelope({
					designSessionId: deps.designSessionId,
					packageDigest: state.workspace.lineage.sourcePackageDigest,
					contract: parsed.data,
					revision: (head?.revision ?? 0) + 1,
					parentId: head?.id ?? null,
					inputDigests: head ? [head.artifactDigest] : [],
					promptVersion: DESIGN_PROMPT_VERSIONS.agent,
					finishReason: null,
				}),
				lifecycle: "draft",
				authority: deps.authority,
				supersedeUncommittedExecution: gates.supersedesPlanExecution,
				workspaceFinalization: {
					workspaceId: state.workspace.id,
					expectedRevision: state.workspace.revision,
					artifactKind: "contract",
				},
			});
			deps.repair.noteAccepted("submitContract");
			return {
				ok: true,
				revisionId: draft.id,
				effortLevel: draft.envelope.complexity?.depth,
				roughTimeEstimate:
					draft.envelope.complexity === undefined
						? undefined
						: DESIGN_EFFORT_TIME_ESTIMATES[draft.envelope.complexity.depth],
				message: `The draft persisted as revision ${draft.revision}. Request its independent review with requestReview.`,
			};
		},
	};

	const requestReview = {
		description:
			"Ask the server to run the independent fresh-context reviewer over the current draft. The persisted review's findings come back as the result; a clean review is accepted on the spot.",
		inputSchema: strictWireOnly(z.object({}).strict()),
		strict: true,
		execute: async () => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "requestReview");
			if (refusal) return refusal;
			const draft = gates.head;
			if (draft === null) return { error: "No draft exists to review." };
			const pkg =
				draft.sourcePackageDigest === deps.currentPkg.packageDigest
					? deps.currentPkg
					: await deps.rebuildPackageForDigest(draft.sourcePackageDigest);
			if (pkg === null) {
				deps.repair.noteSequenceError();
				return {
					error:
						"The sources for this draft no longer reproduce exactly. Stage and finalize a fresh Design Contract from the current sources.",
				};
			}
			const reviewed = await runDesignReviewer(
				deps.ctx,
				{
					pkg,
					contract: draft.envelope.payload,
					catalogText: deps.catalogText,
				},
				deps.signal,
				deps.onReviewActivity,
			);
			if (reviewed.kind === "not-produced") {
				deps.repair.noteSchemaRejection("requestReview");
				return {
					error: `The independent review did not come back usable this time (${reviewed.reason}). The draft stays unreviewed; request the review again.`,
				};
			}
			if (reviewed.reasoningText) {
				deps.onReviewerReasoning?.(reviewed.reasoningText);
			}
			const review = await insertDesignReview({
				envelope: reviewEnvelope({
					draft,
					review: reviewed.artifact,
					finishReason: reviewed.finishReason,
				}),
				designRevisionId: draft.id,
				authority: deps.authority,
			});
			deps.repair.noteAccepted("requestReview");
			const findings = review.envelope.payload.findings;
			const gated = findings.filter(
				(finding) =>
					finding.severity === "critical" || finding.severity === "important",
			);
			if (gated.length === 0) {
				const accepted = await insertDesignRevision({
					envelope: contractEnvelope({
						designSessionId: deps.designSessionId,
						packageDigest: draft.sourcePackageDigest,
						contract: draft.envelope.payload,
						revision: draft.revision + 1,
						parentId: draft.id,
						inputDigests: [draft.artifactDigest, review.artifactDigest],
						promptVersion: draft.envelope.promptVersion,
						finishReason: draft.envelope.producer.finishReason,
					}),
					lifecycle: "accepted",
					authority: deps.authority,
					dispositions: [],
				});
				const blocking = accepted.envelope.payload.openQuestions.filter(
					(question) => question.blocking,
				);
				return {
					ok: true,
					reviewId: review.id,
					summary: review.envelope.payload.summary,
					findings,
					accepted: true,
					acceptedRevisionId: accepted.id,
					message:
						blocking.length > 0
							? "The review raised no gated findings, so the server accepted the design. Ask the user its blocking open questions."
							: "The review raised no gated findings, so the server accepted the design. Stage the build plan with stagePlan.",
				};
			}
			return {
				ok: true,
				reviewId: review.id,
				summary: review.envelope.payload.summary,
				findings,
				accepted: false,
				message:
					"The review has findings that need dispositions. Stage only the required contract corrections and complete dispositions with stageRevision, then finalize with submitRevision.",
			};
		},
	};

	const submitRevision = {
		description:
			"Finalize the staged revision at the exact workspace revision. The server composes the reviewed parent, all saved item changes, and dispositions; then reruns every graph, closure, sensitivity, and cross-artifact proof atomically.",
		inputSchema: strictWireOnly(finalizeDesignWorkspaceInputSchema),
		strict: true,
		execute: async (input: unknown) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitRevision");
			if (refusal) return refusal;
			const head = gates.head;
			if (head === null) return { error: "No draft exists to revise." };
			const parsedInput = parseStage(finalizeDesignWorkspaceInputSchema, input);
			if (!parsedInput.ok) return { error: parsedInput.error };
			let state: Awaited<ReturnType<typeof inspectDesignArtifactWorkspace>>;
			try {
				state = await inspectDesignArtifactWorkspace({
					designSessionId: deps.designSessionId,
					lineage: designWorkspaceLineageForGates("revision", gates),
					authority: deps.authority,
					expectedRevision: parsedInput.data.expectedRevision,
				});
			} catch (error) {
				const handled = workspaceError(error);
				if (handled) return handled;
				throw error;
			}
			const { dispositions, ...contract } = state.candidate;
			const reviewPayloads = gates.headReviews.map(
				(review) => review.envelope.payload,
			);
			const parsed = designRevisionResultSchemaFor(reviewPayloads).safeParse({
				contract,
				dispositions,
			});
			if (!parsed.success) {
				deps.repair.noteSchemaRejection(
					"submitRevision",
					parsed.error.issues.length,
				);
				return { error: renderDesignValidationIssues(parsed.error) };
			}
			const sensitivityViolations = validateSensitivityNotSilentlyLowered(
				head.envelope.payload,
				parsed.data,
			);
			if (sensitivityViolations.length > 0) {
				deps.repair.noteSchemaRejection(
					"submitRevision",
					sensitivityViolations.length,
				);
				return {
					error: [
						"The revision quietly lowered declared sensitivity:",
						...sensitivityViolations.map((violation) => `- ${violation}`),
					].join("\n"),
				};
			}
			const mappedDispositions = mapDispositionsToReviews(
				parsed.data,
				gates.headReviews,
			);
			const criticalFindings = criticalFindingCount(reviewPayloads);
			const secondRoundWarranted =
				gates.openCycleReviews === 1 &&
				(leavesCriticalFinding(parsed.data, reviewPayloads) ||
					criticalFindings >= 2 ||
					(criticalFindings > 0 &&
						changesArchitecture(head.envelope.payload, parsed.data.contract)));
			const lifecycle = secondRoundWarranted ? "draft" : "accepted";
			const revision = await insertDesignRevision({
				envelope: contractEnvelope({
					designSessionId: deps.designSessionId,
					packageDigest: state.workspace.lineage.sourcePackageDigest,
					contract: parsed.data.contract,
					revision: head.revision + 1,
					parentId: head.id,
					inputDigests: [
						head.artifactDigest,
						...gates.headReviews.map((review) => review.artifactDigest),
					],
					promptVersion: DESIGN_PROMPT_VERSIONS.agent,
					finishReason: null,
				}),
				lifecycle,
				authority: deps.authority,
				dispositions: mappedDispositions,
				workspaceFinalization: {
					workspaceId: state.workspace.id,
					expectedRevision: state.workspace.revision,
					artifactKind: "revision",
				},
			});
			deps.repair.noteAccepted("submitRevision");
			if (lifecycle === "draft") {
				return {
					ok: true,
					revisionId: revision.id,
					accepted: false,
					message:
						"The revision persisted and warrants a second independent look. Request it with requestReview.",
				};
			}
			const blocking = revision.envelope.payload.openQuestions.filter(
				(question) => question.blocking,
			);
			return {
				ok: true,
				revisionId: revision.id,
				accepted: true,
				message:
					blocking.length > 0
						? "The accepted design carries blocking open questions. Ask the user before planning."
						: "The revision persisted as the accepted design. Stage its build plan with stagePlan.",
			};
		},
	};

	const submitPlan = {
		description:
			"Finalize the staged build plan at the exact workspace revision. The server stamps artifact identity, composes every saved row, and validates complete ownership, dependencies, construction strategy, and accepted-design coverage atomically.",
		inputSchema: strictWireOnly(finalizeDesignWorkspaceInputSchema),
		strict: true,
		execute: async (input: unknown) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitPlan");
			if (refusal) return refusal;
			const accepted = gates.head;
			if (accepted === null) return { error: "No accepted design exists." };
			const parsedInput = parseStage(finalizeDesignWorkspaceInputSchema, input);
			if (!parsedInput.ok) return { error: parsedInput.error };
			let state: Awaited<ReturnType<typeof inspectDesignArtifactWorkspace>>;
			try {
				state = await inspectDesignArtifactWorkspace({
					designSessionId: deps.designSessionId,
					lineage: designWorkspaceLineageForGates("plan", gates),
					authority: deps.authority,
					expectedRevision: parsedInput.data.expectedRevision,
				});
			} catch (error) {
				const handled = workspaceError(error);
				if (handled) return handled;
				throw error;
			}
			const draftParsed = buildPlanDraftSchema.safeParse(state.candidate);
			if (!draftParsed.success) {
				deps.repair.noteSchemaRejection(
					"submitPlan",
					draftParsed.error.issues.length,
				);
				return { error: renderDesignValidationIssues(draftParsed.error) };
			}
			const composed = composePlan(accepted, draftParsed.data);
			const admissionMessages = newPlanAdmissionMessages(composed);
			const planParsed = buildPlanSchemaFor(
				accepted.envelope.payload,
			).safeParse(composed);
			if (!planParsed.success || admissionMessages.length > 0) {
				const issueCount =
					(planParsed.success ? 0 : planParsed.error.issues.length) +
					admissionMessages.length;
				deps.repair.noteSchemaRejection("submitPlan", issueCount);
				return {
					error: [
						...(planParsed.success
							? []
							: [renderDesignValidationIssues(planParsed.error)]),
						...admissionMessages,
					].join("\n"),
				};
			}
			const plan = await insertDesignBuildPlan({
				envelope: planEnvelope({
					accepted,
					packageDigest: state.workspace.lineage.sourcePackageDigest,
					plan: planParsed.data,
					finishReason: null,
				}),
				authority: deps.authority,
				workspaceFinalization: {
					workspaceId: state.workspace.id,
					expectedRevision: state.workspace.revision,
					artifactKind: "plan",
				},
			});
			deps.repair.noteAccepted("submitPlan");
			return {
				ok: true,
				planId: plan.id,
				message:
					"The build plan persisted; the design phase is complete. Tell the user briefly that the build is starting, then stop.",
			};
		},
	};

	return {
		stageContract,
		stageRevision,
		stagePlan,
		inspectDesignWorkspace,
		submitContract,
		requestReview,
		submitRevision,
		submitPlan,
	};
}
