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
	readDesignReviews,
	readDesignRevisionsForSession,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";

export const DESIGN_LOOP_TOOL_NAMES = [
	"submitContract",
	"requestReview",
	"submitRevision",
	"submitPlan",
] as const;
export type DesignLoopToolName = (typeof DESIGN_LOOP_TOOL_NAMES)[number];

/** Loop steps per POST. Sized so a legitimate extended-depth design (a
 *  question round, contract, review, revision, second review, revision,
 *  plan, with talk between and one repair each) fits with headroom, and a
 *  pathological loop cannot run away. The executor's `budgets.ts` is the
 *  precedent: a deterministic cap, enforced structurally, never prompt
 *  hope. */
export const DESIGN_LOOP_STEP_BUDGET = 40;

/** Consecutive schema rejections of one submission kind before the run
 *  fails honestly with the diagnostics. Two is deliberate: the first
 *  rejection carries the exact refinement messages, so a second identical
 *  failure means the loop is not converging. */
export const DESIGN_SUBMISSION_REPAIR_BUDGET = 2;

/** Consecutive illegal-sequence calls (any tool) before the run fails.
 *  Persistent illegality means the model has lost the protocol; the state
 *  message on the retried turn restores it. */
export const DESIGN_SEQUENCE_ERROR_BUDGET = 3;

/** A budget the gates enforce was exhausted: thrown from the agent's
 *  `prepareStep` so the turn ends as a retriable design-session error with
 *  every committed artifact intact. */
export class DesignLoopBudgetError extends Error {
	readonly name = "DesignLoopBudgetError";
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

export async function loadDesignAncestry(
	designSessionId: string,
	currentPackageDigest: string,
): Promise<DesignAncestry> {
	const revisions = await readDesignRevisionsForSession(designSessionId);
	const reviewsByRevisionId = new Map<string, readonly DesignReviewRecord[]>();
	for (const revision of revisions) {
		reviewsByRevisionId.set(revision.id, await readDesignReviews(revision.id));
	}
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
						"The current draft has a persisted review whose findings are not yet dispositioned. A fresh draft would orphan them; submit the revision with submitRevision instead.",
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
						: "The design is accepted and nothing from the user has arrived since. Submit the build plan with submitPlan.",
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
						? "No draft exists to review. Submit the Design Contract with submitContract first."
						: "The newest revision is already accepted, so there is nothing awaiting review.",
			};
		}
		if (headReviews.length > 0) {
			return {
				legal: false,
				refusal:
					"This draft already has its persisted review. Disposition its findings with submitRevision.",
			};
		}
		if (openCycleReviews >= 2) {
			return {
				legal: false,
				refusal:
					"This design cycle has used both of its review rounds. Submit the revision with submitRevision; the server will accept it.",
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
						? "No draft exists to revise. Submit the Design Contract with submitContract first."
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

	const submitPlan: GateVerdict = (() => {
		if (head === null || head.lifecycle !== "accepted") {
			return {
				legal: false,
				refusal:
					head === null
						? "No design exists to plan. Submit the Design Contract with submitContract first."
						: headReviews.length === 0
							? "The current draft is not reviewed yet. Request the independent review with requestReview."
							: "The current draft's review findings are not dispositioned yet. Submit the revision with submitRevision.",
			};
		}
		if (newerUserContent) {
			return {
				legal: false,
				refusal:
					"Newer user content has reopened design work, so the historical accepted revision cannot be planned for this source package. Submit a fresh Design Contract with submitContract.",
			};
		}
		if (blockingQuestions.length > 0) {
			return {
				legal: false,
				refusal:
					"The accepted design carries blocking open questions, and an accepted revision is immutable, so it can never become plannable after the fact. Ask the user with askQuestions; their answers reopen design work as a fresh reviewed cycle.",
			};
		}
		if (activePlan !== null) {
			return {
				legal: false,
				refusal:
					"A build plan already exists for the accepted design. The design phase is complete.",
			};
		}
		return { legal: true };
	})();

	const verdicts = {
		submitContract,
		requestReview,
		submitRevision,
		submitPlan,
	};
	return {
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
	for (const name of [
		"submitPlan",
		"submitRevision",
		"requestReview",
		"submitContract",
	] as const) {
		if (verdicts[name].legal) {
			return `The expected next step is ${name}. Asking the user a question with askQuestions is always available.`;
		}
	}
	return "No submit tool is legal right now; ask the user with askQuestions if something is genuinely unclear.";
}

/**
 * Per-turn repair accounting. Consecutive schema rejections of one
 * submission kind, and consecutive illegal-sequence calls across kinds,
 * both latch a fatal budget error that `prepareStep` throws: ending the
 * turn as a retriable design-session error instead of an unbounded
 * refinement loop.
 */
export class DesignRepairTracker {
	private rejectionsByKind = new Map<DesignLoopToolName, number>();
	private sequenceErrors = 0;
	private fatal: DesignLoopBudgetError | undefined;

	noteSchemaRejection(kind: DesignLoopToolName): void {
		const count = (this.rejectionsByKind.get(kind) ?? 0) + 1;
		this.rejectionsByKind.set(kind, count);
		if (count >= DESIGN_SUBMISSION_REPAIR_BUDGET) {
			this.fatal = new DesignLoopBudgetError(
				`The ${kind} submission was rejected ${count} times in a row by Nova's own design schemas. The turn ends here so nothing degrades further; the validation messages are in the run diagnostics, and sending the message again retries from the committed artifacts.`,
			);
		}
	}

	noteSequenceError(): void {
		this.sequenceErrors += 1;
		if (this.sequenceErrors >= DESIGN_SEQUENCE_ERROR_BUDGET) {
			this.fatal = new DesignLoopBudgetError(
				`The design agent made ${this.sequenceErrors} out-of-order tool calls in a row. The turn ends here; the committed artifacts are intact, and sending the message again resumes from them.`,
			);
		}
	}

	noteAccepted(kind: DesignLoopToolName): void {
		this.rejectionsByKind.set(kind, 0);
		this.sequenceErrors = 0;
	}

	fatalError(): DesignLoopBudgetError | undefined {
		return this.fatal;
	}
}
