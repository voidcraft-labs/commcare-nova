/**
 * The design loop's server tools: submitContract, requestReview,
 * submitRevision, submitPlan. Each execute re-derives legality from the
 * durable artifact record (`gates.ts`), parses through the EXACT schema
 * factories, persists through `artifactStore`, and answers with a compact
 * acknowledgment naming what is legal next. An illegal call or a rejected
 * submission is a tool RESULT the model repairs from, never a thrown error.
 *
 * Registration and validation split deliberately: the REGISTERED input
 * schema is the strict wire projection alone (`strict: true` constrained
 * decoding needs the grammar), and the exact schemas run INSIDE execute.
 * They could not be registration-time schemas anyway: the graph proof runs
 * inside `appDesignContractSchema`'s parse, and the factories close over
 * session state (`designRevisionResultSchemaFor` over the parent draft's
 * persisted reviews, `buildPlanSchemaFor` over the accepted contract) that
 * does not exist when the agent mounts. The split is what makes a
 * refinement failure a repairable tool result instead of an SDK
 * invalid-input failure the loop never sees.
 *
 * Writers note: everything persisted here goes through `artifactStore`,
 * this package's own boundary. Streams, orchestration events, and session
 * flags stay with `lib/agent/build` (design CLAUDE.md invariant 6); the
 * callbacks in `DesignLoopToolDeps` are how that layer observes the loop.
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
	buildPlanDraftSchema,
	buildPlanSchemaFor,
	unsupportedBlockingActionMessages,
} from "@/lib/agent/design/buildPlan";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import {
	changesArchitecture,
	composePlan,
	contractEnvelope,
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
	designRevisionResultSchema,
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
	/** THIS turn's source package: already persisted by the loop runner. */
	readonly currentPkg: DesignSourcePackage;
	readonly catalogText: string;
	/** The structured-run context the independent reviewer call rides. */
	readonly ctx: StructuredModelRunContext;
	readonly signal: AbortSignal;
	readonly repair: DesignRepairTracker;
	/** Fresh durable state for every legality decision. */
	readonly loadAncestry: () => Promise<DesignAncestry>;
	/** Re-render a draft's own package from its persisted reference row;
	 *  null when the underlying sources no longer reproduce its digest. */
	readonly rebuildPackageForDigest: (
		digest: string,
	) => Promise<DesignSourcePackage | null>;
	/** Live reviewer-call activity (the pulse's chars feed). */
	readonly onReviewActivity?: (deltaChars: number) => void;
	/** The reviewer's display-safe reasoning summary, for the run event log. */
	readonly onReviewerReasoning?: (text: string) => void;
}

/** Wire-projection-only registration schema: the provider gets the strict
 *  grammar; execute runs the exact Zod parse. No `validate` slot, so the
 *  SDK hands the raw input through instead of aborting the step on a
 *  refinement the model should repair from. */
function strictWireOnly(schema: z.ZodType) {
	return jsonSchema<unknown>(strictWireJsonSchema(schema) as never);
}

/** The submission's failing paths and OUR refinement messages, person to
 *  person: the repair loop's whole input. Bounded so a deeply broken
 *  submission cannot flood the context. */
function renderZodIssues(error: ZodError): string {
	const shown = error.issues.slice(0, 25);
	const lines = shown.map(
		(issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`,
	);
	const more = error.issues.length - shown.length;
	return [
		"The submission failed Nova's design validation. Fix exactly what these name and resubmit:",
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
	if (verdict.legal) return null;
	deps.repair.noteSequenceError();
	return { error: verdict.refusal };
}

export function createDesignLoopTools(deps: DesignLoopToolDeps) {
	const submitContract = {
		description:
			"Submit the complete Design Contract. Opens a design cycle: legal at the session start, and again only when later user input has reopened design work. The server validates the whole design graph; a rejection names exactly what to fix.",
		inputSchema: strictWireOnly(appDesignContractSchema),
		strict: true,
		execute: async (input: unknown) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitContract");
			if (refusal) return refusal;
			const parsed = appDesignContractSchema.safeParse(
				stripNullProperties(input),
			);
			if (!parsed.success) {
				deps.repair.noteSchemaRejection("submitContract");
				return { error: renderZodIssues(parsed.error) };
			}
			const head = gates.head;
			const draft = await insertDesignRevision({
				envelope: contractEnvelope({
					designSessionId: deps.designSessionId,
					packageDigest: deps.currentPkg.packageDigest,
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
			});
			deps.repair.noteAccepted("submitContract");
			return {
				ok: true,
				revisionId: draft.id,
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
			if (draft === null) {
				return { error: "No draft exists to review." };
			}
			const pkg =
				draft.sourcePackageDigest === deps.currentPkg.packageDigest
					? deps.currentPkg
					: await deps.rebuildPackageForDigest(draft.sourcePackageDigest);
			if (pkg === null) {
				deps.repair.noteSequenceError();
				return {
					error:
						"The sources this draft was written from no longer reproduce exactly (an attachment changed or disappeared), so its review cannot be grounded honestly. Submit a fresh Design Contract from the current sources with submitContract.",
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
				/* The draft stays persisted and UNREVIEWED: nothing may label it
				 * reviewed. Bounded like a submission rejection so a reviewer that
				 * keeps failing ends the turn instead of burning silently. */
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
				/* Nothing to revise: the server itself re-issues the draft's exact
				 * content as the accepted revision (empty dispositions), exactly
				 * the transition the pipeline performed: a deterministic step
				 * never waits on a model re-emission. */
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
							? "The review raised no gated findings, so the server accepted the design. It carries blocking open questions; ask the user with askQuestions, and their answers reopen design work."
							: "The review raised no gated findings, so the server accepted the design. Submit the build plan with submitPlan.",
				};
			}
			return {
				ok: true,
				reviewId: review.id,
				summary: review.envelope.payload.summary,
				findings,
				accepted: false,
				message: `The review raised ${gated.length} finding(s) that need dispositions. Submit the revised contract plus one disposition per critical and important finding with submitRevision.`,
			};
		},
	};

	const submitRevision = {
		description:
			"Submit the revised Design Contract plus exactly one disposition per critical and important review finding. The server decides acceptance or a required second review round.",
		inputSchema: strictWireOnly(designRevisionResultSchema),
		strict: true,
		execute: async (input: unknown) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitRevision");
			if (refusal) return refusal;
			const head = gates.head;
			if (head === null) return { error: "No draft exists to revise." };
			const reviewPayloads = gates.headReviews.map(
				(review) => review.envelope.payload,
			);
			const parsed = designRevisionResultSchemaFor(reviewPayloads).safeParse(
				stripNullProperties(input),
			);
			if (!parsed.success) {
				deps.repair.noteSchemaRejection("submitRevision");
				return { error: renderZodIssues(parsed.error) };
			}
			const sensitivityViolations = validateSensitivityNotSilentlyLowered(
				head.envelope.payload,
				parsed.data,
			);
			if (sensitivityViolations.length > 0) {
				deps.repair.noteSchemaRejection("submitRevision");
				return {
					error: [
						"The revision quietly lowered declared sensitivity:",
						...sensitivityViolations.map((violation) => `- ${violation}`),
					].join("\n"),
				};
			}
			const dispositions = mapDispositionsToReviews(
				parsed.data,
				gates.headReviews,
			);
			const depth = head.envelope.complexity?.depth ?? "standard";
			const secondRoundWarranted =
				gates.openCycleReviews === 1 &&
				depth !== "compact" &&
				(depth === "extended" ||
					leavesCriticalFinding(parsed.data, reviewPayloads) ||
					changesArchitecture(head.envelope.payload, parsed.data.contract));
			const lifecycle = secondRoundWarranted ? "draft" : "accepted";
			const revision = await insertDesignRevision({
				envelope: contractEnvelope({
					designSessionId: deps.designSessionId,
					packageDigest: deps.currentPkg.packageDigest,
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
				dispositions,
			});
			deps.repair.noteAccepted("submitRevision");
			if (lifecycle === "draft") {
				return {
					ok: true,
					revisionId: revision.id,
					accepted: false,
					message:
						"The revision persisted, and its changes warrant a second independent look (a standing critical finding, an architecture change, or extended depth). Request it with requestReview.",
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
						? "The revision persisted as the accepted design. It carries blocking open questions; ask the user with askQuestions, and their answers reopen design work."
						: "The revision persisted as the accepted design. Submit the build plan with submitPlan.",
			};
		},
	};

	const submitPlan = {
		description:
			"Submit the build plan for the accepted design: build slices, external actions, and intent ownership. Legal only once the accepted design carries no blocking open questions.",
		inputSchema: strictWireOnly(buildPlanDraftSchema),
		strict: true,
		execute: async (input: unknown) => {
			const gates = await gatesFor(deps);
			const refusal = refuse(deps, gates, "submitPlan");
			if (refusal) return refusal;
			const accepted = gates.head;
			if (accepted === null) return { error: "No accepted design exists." };
			const draftParsed = buildPlanDraftSchema.safeParse(
				stripNullProperties(input),
			);
			if (!draftParsed.success) {
				deps.repair.noteSchemaRejection("submitPlan");
				return { error: renderZodIssues(draftParsed.error) };
			}
			const composed = composePlan(accepted, draftParsed.data);
			/* Blocking-action producer policy is deliberately outside the
			 * persisted schema so historical plans remain readable. Still compute
			 * it before returning structural refinements: one rejected submission
			 * must expose every independently visible repair, or a newly revealed
			 * policy message can consume the final repair attempt. */
			const unsupportedActions = unsupportedBlockingActionMessages(composed);
			const planParsed = buildPlanSchemaFor(
				accepted.envelope.payload,
			).safeParse(composed);
			if (!planParsed.success) {
				deps.repair.noteSchemaRejection("submitPlan");
				return {
					error: [
						renderZodIssues(planParsed.error),
						...unsupportedActions,
					].join("\n"),
				};
			}
			if (unsupportedActions.length > 0) {
				deps.repair.noteSchemaRejection("submitPlan");
				return { error: unsupportedActions.join("\n") };
			}
			const plan = await insertDesignBuildPlan({
				envelope: planEnvelope({
					accepted,
					packageDigest: deps.currentPkg.packageDigest,
					plan: planParsed.data,
					finishReason: null,
				}),
				authority: deps.authority,
			});
			deps.repair.noteAccepted("submitPlan");
			return {
				ok: true,
				planId: plan.id,
				message:
					"The build plan persisted; the design phase is complete. Tell the user briefly that the build is starting, then stop: the build continues automatically.",
			};
		},
	};

	return { submitContract, requestReview, submitRevision, submitPlan };
}
