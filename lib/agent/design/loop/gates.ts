/**
 * Design-loop gates: pure legality over the durable artifact record.
 *
 * The design agent drives; the SERVER gates. Which submit tool is legal is
 * decided here, from the session's persisted revisions, reviews, and plan,
 * never from the model's account of what happened. Every refusal names the
 * legal next action, person to person, because the refusal text IS the tool
 * result the model repairs from.
 *
 * The cycle model: `submitContract` OPENS a design cycle (a draft lineage
 * that runs to an accepted revision). It is legal again only when later
 * user content has genuinely reopened design work: an unreviewed draft
 * gone stale under newer input (supersede), or an accepted revision whose
 * blocking questions were answered (reopen). "Newer user content" is
 * detected as the current source-package digest differing from the digest
 * the head artifact bound: answered rounds seed claims and new messages add
 * blocks, and both move the digest deterministically.
 *
 * Rounds derive digest-INDEPENDENTLY, scoped to the open cycle: count the
 * persisted reviews attached to revisions above the session's newest
 * accepted revision. A crash and resume can never mint an extra round, a
 * question round between a review and its revision cannot either, and a
 * reopened cycle starts a fresh §7.3 budget: the budget is per reviewed
 * design, never a session-lifetime meter.
 */

import type {
	DesignBuildPlanRecord,
	DesignReviewRecord,
	DesignRevisionRecord,
} from "@/lib/agent/design/artifactStore";
import {
	readDesignReviewsForRevisions,
	readDesignRevisionsForSession,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import type { OpenQuestion } from "@/lib/agent/design/contract";

export const DESIGN_LOOP_TOOL_NAMES = [
	"submitContract",
	"requestReview",
	"submitRevision",
] as const;
export type DesignLoopToolName = (typeof DESIGN_LOOP_TOOL_NAMES)[number];

/** Loop steps per POST. Sized so a legitimate extended-depth design (a
 *  question round, contract, review, revision, second review, revision,
 *  plan, with talk between and one repair each) fits with headroom, and a
 *  pathological loop cannot run away. The executor's `budgets.ts` is the
 *  precedent: a deterministic cap, enforced structurally, never prompt
 *  hope. */
export const DESIGN_LOOP_STEP_BUDGET = 64;

/** Extra step headroom per context-generation rollover, capped. A rollover
 * happens only when a real deployment changed the pinned model, prompt, tool
 * digest, or context format — exactly the "correct the harness, then run this
 * phase again" case the repair fuses name — so the allowance is bounded by
 * deploy cadence and can never be minted by a user. Without it, steps a
 * harness defect consumed would permanently starve the session's retry: one
 * live session spent fifty steps in a since-fixed staging rut and then hit
 * the ceiling twenty productive stages into its clean post-fix rebuild. */
export const DESIGN_ROLLOVER_STEP_ALLOWANCE = 32;
export const DESIGN_ROLLOVER_ALLOWANCE_CAP = 2;

/** One server-authored terminal correction may cross the ordinary session
 * ceiling by exactly one provider step. The allowance is armed only after a
 * clean omission has already consumed the last ordinary step; users and model
 * output cannot mint it. */
export const DESIGN_TERMINAL_CORRECTION_STEP_ALLOWANCE = 1;

/** The session's step ceiling given its current context generation. */
export function designLoopStepBudget(generation: number): number {
	return (
		DESIGN_LOOP_STEP_BUDGET +
		Math.min(Math.max(generation, 0), DESIGN_ROLLOVER_ALLOWANCE_CAP) *
			DESIGN_ROLLOVER_STEP_ALLOWANCE
	);
}

/** Maximum finalization rejections of one submission kind. A third rejection
 * always stops the run. An exact repeat in the same validation stage stops
 * after two; reaching a later stage or changing the concrete diagnostics is
 * progress and retains the third attempt. */
export const DESIGN_SUBMISSION_REPAIR_BUDGET = 3;

/** Consecutive illegal-sequence calls (any tool) before the run fails.
 *  Persistent illegality means the model has lost the protocol; the state
 *  message on the retried turn restores it. */
export const DESIGN_SEQUENCE_ERROR_BUDGET = 3;

/** The two bounded workspace-staging tools. Their rejections are tracked
 *  separately from finalization because a stage rejection is normally
 *  correctable in the very next call. */
export type DesignStageToolName = "stageContract" | "stageRevision";

/** Consecutive stage rejections of one tool with an IDENTICAL diagnostic
 *  before the run fails. A changed diagnostic or an accepted stage is
 *  progress and resets the count. Three identical rejections mean the model
 *  cannot express what the server requires — a systemic contract defect, not
 *  a correctable slip — and every further call would repeat the rejection. */
export const DESIGN_STAGE_REPAIR_BUDGET = 3;

/** A budget the gates enforce was exhausted: thrown from the agent's
 *  `prepareStep` so the turn ends as a classified design defect with every
 *  committed artifact intact. */
export type DesignLoopBudgetCode =
	| "design-submission-nonconvergent"
	| "design-stage-nonconvergent"
	| "design-sequence-budget";

export class DesignLoopBudgetError extends Error {
	readonly name = "DesignLoopBudgetError";
	constructor(
		readonly code: DesignLoopBudgetCode,
		message: string,
	) {
		super(message);
	}
}

export type DesignSubmissionValidationStage =
	| "schema"
	| "construction"
	| "sensitivity";

export interface DesignSubmissionRejection {
	readonly stage: DesignSubmissionValidationStage;
	readonly fingerprints: readonly string[];
}

/** Everything gate evaluation needs, loaded once per tool call from the
 *  artifact store. The loader does the reads; `evaluateDesignGates` is
 *  pure. */
export interface DesignAncestry {
	/** Every revision of the session, ascending by revision number. */
	readonly revisions: readonly DesignRevisionRecord[];
	/** Reviews keyed by the revision they bind. */
	readonly reviewsByRevisionId: ReadonlyMap<
		string,
		readonly DesignReviewRecord[]
	>;
	/** The newest plan lowered from the newest accepted revision, if any. */
	readonly plan: DesignBuildPlanRecord | null;
	/** The digest of THIS turn's source package. */
	readonly currentPackageDigest: string;
}

/**
 * The runner's per-run ancestry loader: memoized, because the gate loader
 * reads (and digest-verifies) the session's whole revision/review/plan
 * ancestry and is consulted on every provider step, every tool call, and
 * every phase boundary — while the single-writer runner's own artifact
 * inserts are the only thing that can change it. `ancestryChanged` (called
 * by the tools and the plan writer right after each insert) drops the memo;
 * a rejected load also drops it so a transient read fault never sticks.
 */
export function createMemoizedAncestryLoader(
	designSessionId: string,
	currentPackageDigest: string,
): {
	loadAncestry: () => Promise<DesignAncestry>;
	ancestryChanged: () => void;
} {
	let cache: Promise<DesignAncestry> | null = null;
	return {
		loadAncestry: () => {
			cache ??= loadDesignAncestry(designSessionId, currentPackageDigest).catch(
				(error) => {
					cache = null;
					throw error;
				},
			);
			return cache;
		},
		ancestryChanged: () => {
			cache = null;
		},
	};
}

export async function loadDesignAncestry(
	designSessionId: string,
	currentPackageDigest: string,
): Promise<DesignAncestry> {
	const revisions = await readDesignRevisionsForSession(designSessionId);
	const reviewsByRevisionId = await readDesignReviewsForRevisions(
		revisions.map((revision) => revision.id),
	);
	const newestAccepted = [...revisions]
		.reverse()
		.find((revision) => revision.lifecycle === "accepted");
	const plan = newestAccepted
		? await readLatestDesignBuildPlanForRevision(newestAccepted.id)
		: null;
	return { revisions, reviewsByRevisionId, plan, currentPackageDigest };
}

export type GateVerdict =
	| { readonly legal: true }
	| { readonly legal: false; readonly refusal: string };

export interface DesignGateState {
	/** The exact source package this turn is allowed to author against. */
	readonly currentPackageDigest: string;
	readonly head: DesignRevisionRecord | null;
	readonly newestAccepted: DesignRevisionRecord | null;
	/** Reviews of the head draft specifically. */
	readonly headReviews: readonly DesignReviewRecord[];
	/** Persisted reviews along the OPEN cycle (revisions above the newest
	 *  accepted revision). */
	readonly openCycleReviews: number;
	readonly blockingQuestions: readonly string[];
	readonly plan: DesignBuildPlanRecord | null;
	/** True when this turn's newer source package deactivates a persisted plan.
	 * The replacement draft atomically retires that plan's open execution
	 * carriers when it is inserted. */
	readonly supersedesPlanExecution: boolean;
	readonly verdicts: Readonly<Record<DesignLoopToolName, GateVerdict>>;
	/** One sentence for tool results and the state message: what the server
	 *  expects next. */
	readonly expectedNext: string;
}

export function evaluateDesignGates(ancestry: DesignAncestry): DesignGateState {
	const { revisions, reviewsByRevisionId, plan } = ancestry;
	const head = revisions.at(-1) ?? null;
	const newestAccepted =
		[...revisions]
			.reverse()
			.find((revision) => revision.lifecycle === "accepted") ?? null;
	const openCycle =
		newestAccepted === null
			? revisions
			: revisions.slice(revisions.indexOf(newestAccepted) + 1);
	const openCycleReviews = openCycle.reduce(
		(sum, revision) =>
			sum + (reviewsByRevisionId.get(revision.id)?.length ?? 0),
		0,
	);
	const headReviews = head ? (reviewsByRevisionId.get(head.id) ?? []) : [];
	const blockingQuestions =
		head?.lifecycle === "accepted"
			? head.envelope.payload.openQuestions
					.filter((question) => question.blocking)
					.map((question) => question.question)
			: [];
	const newerUserContent =
		head !== null && head.sourcePackageDigest !== ancestry.currentPackageDigest;
	/* A plan is executable only while its accepted revision is still the head
	 * and that revision names THIS turn's source package. Later user content or
	 * a newer draft reopens design work; the historical plan remains durable
	 * provenance, but cannot short-circuit the loop or own new execution. */
	const activePlan =
		plan !== null &&
		newestAccepted !== null &&
		head?.id === newestAccepted.id &&
		newestAccepted.sourcePackageDigest === ancestry.currentPackageDigest
			? plan
			: null;

	const submitContract: GateVerdict = (() => {
		if (head === null) return { legal: true };
		if (head.lifecycle === "draft") {
			if (headReviews.length > 0) {
				return {
					legal: false,
					refusal:
						"The current draft has a persisted review whose findings are not yet dispositioned. A fresh draft would orphan them; update the affected design items and finding dispositions, then call finishDesign.",
				};
			}
			if (!newerUserContent) {
				return {
					legal: false,
					refusal:
						"A draft already exists and nothing from the user has arrived since it was written, so there is nothing to redesign from. Request its independent review with requestReview.",
				};
			}
			return { legal: true };
		}
		if (!newerUserContent) {
			return {
				legal: false,
				refusal:
					blockingQuestions.length > 0
						? "The accepted design carries blocking open questions and the user has not answered them yet. Ask them with askQuestions; the answers reopen design work."
						: "The design is accepted and its build plan is derived by the server; there is no model planning step.",
			};
		}
		return { legal: true };
	})();

	const requestReview: GateVerdict = (() => {
		if (head === null || head.lifecycle !== "draft") {
			return {
				legal: false,
				refusal:
					head === null
						? "No draft exists to review. Complete the semantic design and call finishDesign first."
						: "The newest revision is already accepted, so there is nothing awaiting review.",
			};
		}
		if (headReviews.length > 0) {
			return {
				legal: false,
				refusal:
					"This draft already has its persisted review. Update its affected design items and finding dispositions, then call finishDesign.",
			};
		}
		if (openCycleReviews >= 2) {
			return {
				legal: false,
				refusal:
					"This design cycle has used both of its review rounds. Complete the revision with finishDesign; the server will accept it.",
			};
		}
		return { legal: true };
	})();

	const submitRevision: GateVerdict = (() => {
		if (head === null || head.lifecycle !== "draft") {
			return {
				legal: false,
				refusal:
					head === null
						? "No draft exists to revise. Complete the semantic design and call finishDesign first."
						: "The newest revision is already accepted; there are no findings awaiting a disposition.",
			};
		}
		if (headReviews.length === 0) {
			return {
				legal: false,
				refusal:
					"This draft has no persisted review yet, so there are no findings to disposition. Request the independent review with requestReview.",
			};
		}
		return { legal: true };
	})();

	const verdicts = {
		submitContract,
		requestReview,
		submitRevision,
	};
	return {
		currentPackageDigest: ancestry.currentPackageDigest,
		head,
		newestAccepted,
		headReviews,
		openCycleReviews,
		blockingQuestions,
		plan: activePlan,
		supersedesPlanExecution:
			plan !== null && activePlan === null && newerUserContent,
		verdicts,
		expectedNext: deriveExpectedNext(verdicts, blockingQuestions, activePlan),
	};
}

function deriveExpectedNext(
	verdicts: Record<DesignLoopToolName, GateVerdict>,
	blockingQuestions: readonly string[],
	plan: DesignBuildPlanRecord | null,
): string {
	if (plan !== null) {
		return "The design phase is complete; the build continues from the persisted plan.";
	}
	if (blockingQuestions.length > 0) {
		return "Ask the user the accepted design's blocking open questions with askQuestions; the answers reopen design work.";
	}
	if (verdicts.submitRevision.legal) {
		return "Update the reviewed design and blocking finding dispositions with the native semantic calls, then call finishDesign. Several known updates may be emitted in one response. askQuestions remains available.";
	}
	if (verdicts.requestReview.legal) {
		return "The expected next step is requestReview. askQuestions remains available.";
	}
	if (verdicts.submitContract.legal) {
		return "Continue the implicit workspace with native semantic design calls, then call finishDesign. Several known updates may be emitted in one response. askQuestions remains available.";
	}
	return "No design finalizer is legal right now; ask the user with askQuestions if something is genuinely unclear.";
}

/**
 * Per-turn repair accounting. Finalization rejection fingerprints and
 * consecutive illegal-sequence calls both latch a fatal budget error that
 * `prepareStep` throws, ending the turn instead of spinning. Construction
 * decisions owned by the user are a separate forced-question state, not a
 * failed model repair.
 */
export class DesignRepairTracker {
	private rejectionsByKind = new Map<
		DesignLoopToolName,
		{
			count: number;
			stage: DesignSubmissionValidationStage;
			fingerprints: ReadonlySet<string>;
		}
	>();
	private stageRejectionsByKind = new Map<
		DesignStageToolName,
		{ fingerprint: string; count: number }
	>();
	private sequenceErrors = 0;
	private fatal: DesignLoopBudgetError | undefined;
	private pendingUserQuestions: readonly OpenQuestion[] = [];

	noteSubmissionRejection(
		kind: DesignLoopToolName,
		rejection: DesignSubmissionRejection,
	): void {
		const previous = this.rejectionsByKind.get(kind);
		const count = (previous?.count ?? 0) + 1;
		const fingerprints = new Set(rejection.fingerprints);
		this.rejectionsByKind.set(kind, {
			count,
			stage: rejection.stage,
			fingerprints,
		});
		const repeatedExactly =
			previous !== undefined &&
			previous.stage === rejection.stage &&
			previous.fingerprints.size === fingerprints.size &&
			[...fingerprints].every((value) => previous.fingerprints.has(value));
		if (count >= DESIGN_SUBMISSION_REPAIR_BUDGET || repeatedExactly) {
			this.fatal = new DesignLoopBudgetError(
				"design-submission-nonconvergent",
				`The ${kind} submission did not converge after ${count} finalization rejections. The committed artifacts are intact; inspect the run diagnostics and correct the harness before running this phase again.`,
			);
		}
	}

	/** A rejected `stageContract`/`stageRevision` call. Only CONSECUTIVE
	 * rejections with a byte-identical diagnostic latch the fatal error: a
	 * changed diagnostic means the model is moving through distinct problems,
	 * which the overall step budget already bounds. */
	noteStageRejection(kind: DesignStageToolName, fingerprint: string): void {
		const previous = this.stageRejectionsByKind.get(kind);
		const count =
			previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
		this.stageRejectionsByKind.set(kind, { fingerprint, count });
		if (count >= DESIGN_STAGE_REPAIR_BUDGET) {
			this.fatal = new DesignLoopBudgetError(
				"design-stage-nonconvergent",
				`The ${kind} staging call was rejected ${count} times in a row with the same diagnostic. The model cannot express what the server requires here, so another attempt would only repeat the rejection. The committed artifacts are intact; inspect the run diagnostics and correct the harness before running this phase again.`,
			);
		}
	}

	noteStageAccepted(kind: DesignStageToolName): void {
		this.stageRejectionsByKind.delete(kind);
	}

	requireUserQuestions(questions: readonly OpenQuestion[]): void {
		const byId = new Map<string, OpenQuestion>();
		for (const question of questions) {
			if (!question.question.trim()) continue;
			byId.set(question.id, {
				...question,
				question: question.question.trim(),
			});
		}
		this.pendingUserQuestions = [...byId.values()];
	}

	requiredUserQuestions(): readonly OpenQuestion[] {
		return this.pendingUserQuestions;
	}

	noteSequenceError(): void {
		this.sequenceErrors += 1;
		if (this.sequenceErrors >= DESIGN_SEQUENCE_ERROR_BUDGET) {
			this.fatal = new DesignLoopBudgetError(
				"design-sequence-budget",
				`The design agent made ${this.sequenceErrors} out-of-order tool calls in a row. The turn ends here with committed artifacts intact; inspect the harness before running the phase again.`,
			);
		}
	}

	/** A phase-legal call breaks a run of out-of-order calls without erasing
	 * the independent final-validation convergence history. */
	noteLegalCall(): void {
		this.sequenceErrors = 0;
	}

	noteAccepted(kind: DesignLoopToolName): void {
		this.rejectionsByKind.delete(kind);
		this.sequenceErrors = 0;
		this.pendingUserQuestions = [];
	}

	fatalError(): DesignLoopBudgetError | undefined {
		return this.fatal;
	}
}
