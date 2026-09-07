/**
 * Durable progress projection — the truthful, non-percentage stages and the
 * safe design-outline card (§15.2–§15.4).
 *
 * Stage is DERIVED from durable artifacts and orchestration events, never
 * from a client-only state machine or model prose. Every progress frame is a
 * projection of a durable row wrapped in the versioned envelope; reconnect
 * re-derives the latest projection, so the client never needs a transient
 * frame to recover.
 */

import type { BuildPlan } from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import type { DesignReview } from "@/lib/agent/design/review";
import type { DesignSessionDoc } from "@/lib/db/designSessions";
import {
	type DesignSessionLeaseRow,
	designSessionLeaseState,
} from "@/lib/db/runLiveness";
import { isTerminalOrchestrationKind } from "./orchestrationKinds";
import type { OrchestrationHead } from "./orchestratorState";

export type DesignBuildStage =
	| "understanding"
	| "designing"
	| "reviewing-design"
	| "revising-design"
	| "planning"
	| "building-first-workflow"
	| "building"
	| "reviewing-implementation"
	| "translating"
	| "ready"
	| "needs-input"
	| "incomplete"
	| "failed";

/** The session facts the stage fold reads: the full lease row (the sanctioned
 * liveness derivation consumes it whole) plus the failure marker. */
export type StageFoldSession = DesignSessionLeaseRow &
	Pick<DesignSessionDoc, "last_error_type" | "app_id">;

/**
 * Fold a session + its orchestration head into the user-facing stage. The
 * head's granularity is per-phase (the design pipeline is internally
 * convergent), so mid-pipeline sub-stages surface only through the live
 * frames; a reconnect lands on the phase.
 */
export function deriveDesignBuildStage(
	session: StageFoldSession,
	head: OrchestrationHead | null,
): DesignBuildStage {
	if (session.awaiting_input) return "needs-input";
	if (session.state === "abandoned") return "failed";
	/* Dead-run evidence has two durable forms: `last_error_type` (set by every
	 * failed/reaped settle, cleared by every fresh claim) and a still-present
	 * holder whose lease lapsed — a process death no failure flush recorded.
	 * The reaper that stamps the error type fires only from a later claim's
	 * admission scan, so without the lapse arm a killed run wears active-work
	 * copy (and hides the resume control) until some unrelated claim happens
	 * by. Report-only, like the thread loaders' dead-marker stamp: the row is
	 * never written here, and the resume claim retires the evidence. */
	const deadRun =
		session.last_error_type !== null ||
		designSessionLeaseState(session).reapableStaleRun;
	if (head === null) {
		/* No orchestration event yet, but the session records a dead run (a
		 * claim/pipeline death before the first transition): say the build
		 * stopped rather than showing active-work copy over it. */
		return deadRun ? "incomplete" : "understanding";
	}
	const state = head.state;
	/* A mid-flight head kind describes the last event of a run that may since
	 * have DIED: while dead-run evidence stands, active-work copy over that
	 * kind is a spinner over a dead run. The terminal kinds keep their own
	 * answer (a finished app is ready regardless of a later edit turn's error
	 * marker). */
	if (
		deadRun &&
		(state.kind === "designing" ||
			state.kind === "planning" ||
			state.kind === "executing-slice" ||
			state.kind === "translating")
	) {
		return "incomplete";
	}
	switch (state.kind) {
		case "designing":
			return "designing";
		case "awaiting-user":
		case "awaiting-user-questions":
			return "needs-input";
		case "planning":
			return "planning";
		case "executing-slice":
			return session.app_id === null ? "building-first-workflow" : "building";
		case "translating":
			return "translating";
		case "finished":
			return "ready";
		case "accepted-partial":
			/* Historical reader compatibility only. A partial plan is never
			 * authoritative completion, even if its materialized prefix is valid. */
			return "incomplete";
		case "failed":
			return state.recoverable ? "incomplete" : "failed";
	}
}

/** Cold-load projection for an `error` app still bound to its reviewed initial
 * build. A nonterminal orchestration head plus a settled error row is durable
 * evidence of infrastructure interruption even when the failure happened
 * before an orchestration error event could be appended. */
export function deriveInterruptedMaterializedBuildStage(
	session: StageFoldSession,
	head: OrchestrationHead | null,
): DesignBuildStage {
	if (head !== null && isTerminalOrchestrationKind(head.state.kind)) {
		return deriveDesignBuildStage(session, head);
	}
	return "incomplete";
}

/** The versioned envelope every progress frame rides in (§15.4). */
export interface DesignProgressEnvelope<T> {
	readonly eventVersion: 1;
	readonly designSessionId: string;
	readonly orchestrationEventId: string;
	readonly orchestrationRevision: number;
	readonly data: T;
}

export interface BuildLocalizationProjection {
	readonly languageTag: string;
	readonly languageName: string;
	readonly batch: number;
	readonly batchCount: number;
}

export function progressEnvelope<T>(
	designSessionId: string,
	head: OrchestrationHead | null,
	data: T,
): DesignProgressEnvelope<T> {
	return {
		eventVersion: 1,
		designSessionId,
		orchestrationEventId: head?.eventId ?? "",
		orchestrationRevision: head?.revision ?? 0,
		data,
	};
}

/** The safe outline card (§15.3) — a projection, never the raw contract: no
 *  source excerpts, no attachment bodies, no reasoning, no private steps,
 *  no implementation UUIDs. */
export interface DesignOutlineProjection {
	readonly objective: string;
	readonly actors: readonly string[];
	readonly tasks: readonly string[];
	readonly records: readonly string[];
	readonly lists: readonly string[];
	readonly assumptions: readonly string[];
	readonly blockingQuestions: readonly string[];
	readonly outOfScope: readonly string[];
	readonly reviewed: boolean;
}

export function deriveDesignOutline(
	contract: AppDesignContract,
	reviews: readonly DesignReview[],
): DesignOutlineProjection {
	return {
		objective: contract.charter.objective,
		actors: contract.actors.map((actor) => actor.name),
		tasks: contract.workflows.map((workflow) => workflow.name),
		records: contract.records.map((record) => record.name),
		lists: contract.lists.map((list) => list.name),
		assumptions: contract.assumptions.map((assumption) => assumption.statement),
		blockingQuestions: contract.openQuestions
			.filter((question) => question.blocking)
			.map((question) => question.question),
		outOfScope: contract.charter.excludedWorkflows,
		reviewed: reviews.length > 0,
	};
}

/** The design phases a pulse can name: the live "a model call is
 *  streaming right now" signal. `design` is the loop itself (reasoning,
 *  talk, a contract submission streaming); `review` is the independent
 *  reviewer's one-shot call (the loop's one silent stretch); `revise` and
 *  `plan` are the loop streaming those submissions' arguments. Each maps
 *  onto one §15.2 stage, which is what makes the pulse a truthful stage
 *  source: the SERVER names the phase whose call is delivering tokens; the
 *  client only displays the latest. */
export const DESIGN_PULSE_PHASES = [
	"design",
	"review",
	"revise",
	"plan",
] as const;
export type DesignPulsePhase = (typeof DESIGN_PULSE_PHASES)[number];

/** One live-activity pulse: the streaming phase, the cumulative character
 *  count (reasoning + output) it has delivered so far, and optionally the
 *  sub-step label the key-order narrator derived from a submission's
 *  streaming arguments. Volume and a canned label, not content; no model
 *  prose ever rides a pulse. */
export interface DesignPulseProjection {
	readonly phase: DesignPulsePhase;
	readonly chars: number;
	readonly step?: string;
}

/** Minimum spacing between two live-activity pulses. Tighter buys nothing
 *  (the panel shows a phase, not a token counter); looser re-opens dead
 *  air. Pulses ride the ordinary chunk path — logged for reconnect replay
 *  like every other transient frame — so the spacing also bounds their
 *  chunk-log volume. */
export const DESIGN_PULSE_INTERVAL_MS = 2_000;

/**
 * Throttled `data-design-pulse` frames: while a design-phase model call
 * streams, the frame names the phase whose call is delivering tokens and
 * the cumulative characters (reasoning + output) it has produced. This is
 * what keeps the progress region truthful through the minutes a single
 * xhigh call reasons with no other observable output — the phase comes
 * from the server's own control flow, never a client inference, and no
 * model prose rides the frame. A phase change resets the count and emits
 * immediately, so every phase announces itself the moment it starts
 * streaming.
 */
export function createDesignPulseEmitter(
	writer: {
		write(chunk: { type: string; data: unknown; transient?: boolean }): void;
	},
	designSessionId: string,
	head: () => OrchestrationHead | null,
): (phase: DesignPulsePhase, deltaChars: number, step?: string) => void {
	let activePhase: DesignPulsePhase | null = null;
	let activeStep: string | undefined;
	let totalChars = 0;
	let lastEmitAt = 0;
	return (phase, deltaChars, step) => {
		if (phase !== activePhase) {
			activePhase = phase;
			activeStep = undefined;
			totalChars = 0;
			lastEmitAt = 0;
		}
		/* A new sub-step is a discrete narration change: announce it the
		 * moment it starts, like a phase change; only same-step volume is
		 * throttled. */
		if (step !== undefined && step !== activeStep) {
			activeStep = step;
			lastEmitAt = 0;
		}
		totalChars += deltaChars;
		const now = Date.now();
		if (now - lastEmitAt < DESIGN_PULSE_INTERVAL_MS) return;
		lastEmitAt = now;
		writer.write({
			type: "data-design-pulse",
			data: progressEnvelope(designSessionId, head(), {
				phase,
				chars: totalChars,
				...(activeStep !== undefined && { step: activeStep }),
			} satisfies DesignPulseProjection),
			transient: true,
		});
	};
}

/* ------------------------------------------------------------------ */
/* Submission step narration                                           */
/* ------------------------------------------------------------------ */

export interface SubmissionStepNarrator {
	/** Feed one input-delta's text; returns the current sub-step label. */
	feed(deltaText: string): string | undefined;
}

/**
 * Advisory narration from complete top-level JSON keys. Track string escaping
 * and container depth across deltas so nested keys and quoted source text
 * cannot announce a later step. This is a bounded key recognizer, not JSON
 * validation; the actual submission schema still owns acceptance.
 */
export function createSubmissionStepNarrator(
	labels: ReadonlyArray<readonly [string, string]>,
): SubmissionStepNarrator {
	const byKey = new Map(labels);
	// Each UTF-16 code unit can be spelled as six ASCII characters (\\uXXXX).
	const maxKeyBytes = Math.max(0, ...labels.map(([key]) => key.length)) * 6 + 2;
	let depth = 0;
	let inString = false;
	let escaped = false;
	let keyToken: string | undefined;
	let pendingKey: string | undefined;
	let current: string | undefined;
	return {
		feed(deltaText) {
			for (const char of deltaText) {
				if (inString) {
					if (keyToken !== undefined) {
						keyToken += char;
						if (keyToken.length > maxKeyBytes) keyToken = undefined;
					}
					if (escaped) {
						escaped = false;
						continue;
					}
					if (char === "\\") {
						escaped = true;
						continue;
					}
					if (char !== '"') continue;
					inString = false;
					if (keyToken !== undefined) {
						try {
							const decoded: unknown = JSON.parse(keyToken);
							pendingKey = typeof decoded === "string" ? decoded : undefined;
						} catch {
							pendingKey = undefined;
						}
					}
					continue;
				}
				if (/\s/.test(char)) continue;
				if (char === ":" && depth === 1 && pendingKey !== undefined) {
					current = byKey.get(pendingKey) ?? current;
				}
				pendingKey = undefined;
				if (char === '"') {
					inString = true;
					keyToken = depth === 1 ? '"' : undefined;
				} else if (char === "{" || char === "[") depth += 1;
				else if (char === "}" || char === "]") depth -= 1;
			}
			return current;
		},
	};
}

/** The plan summary frame's payload — counts and names only. */
export interface BuildPlanSummaryProjection {
	readonly sliceCount: number;
	readonly sliceNames: readonly string[];
	readonly externalActionCount: number;
}

export function deriveBuildPlanSummary(
	plan: BuildPlan,
): BuildPlanSummaryProjection {
	return {
		sliceCount: plan.slices.length,
		sliceNames: plan.slices.map((slice) => slice.name),
		externalActionCount: plan.externalActions.length,
	};
}
