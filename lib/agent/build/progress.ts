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
	| "ready"
	| "needs-input"
	| "incomplete"
	| "failed";

/**
 * Fold a session + its orchestration head into the user-facing stage. The
 * head's granularity is per-phase (the design pipeline is internally
 * convergent), so mid-pipeline sub-stages surface only through the live
 * frames; a reconnect lands on the phase.
 */
export function deriveDesignBuildStage(
	session: Pick<
		DesignSessionDoc,
		"state" | "awaiting_input" | "last_error_type" | "app_id"
	>,
	head: OrchestrationHead | null,
): DesignBuildStage {
	if (session.awaiting_input) return "needs-input";
	if (session.state === "abandoned") return "failed";
	if (head === null) {
		/* No orchestration event yet, but the session records a failed run
		 * (a claim/pipeline death before the first transition): say the build
		 * stopped rather than showing active-work copy over a dead run. */
		return session.last_error_type === null ? "understanding" : "incomplete";
	}
	const state = head.state;
	/* A mid-flight head kind describes the last event of a run that may since
	 * have DIED: `last_error_type` is set by every failed/reaped settle and
	 * cleared by every fresh claim, so while it stands, active-work copy over
	 * that kind is a spinner over a dead run. The terminal kinds keep their
	 * own answer (a finished app is ready regardless of a later edit turn's
	 * error marker). */
	if (
		session.last_error_type !== null &&
		(state.kind === "designing" ||
			state.kind === "planning" ||
			state.kind === "executing-slice")
	) {
		return "incomplete";
	}
	switch (state.kind) {
		case "designing":
			return "designing";
		case "awaiting-user":
			return "needs-input";
		case "planning":
			return "planning";
		case "executing-slice":
			return session.app_id === null ? "building-first-workflow" : "building";
		case "finished":
			return "ready";
		case "failed":
			return state.recoverable ? "incomplete" : "failed";
	}
}

/** The versioned envelope every progress frame rides in (§15.4). */
export interface DesignProgressEnvelope<T> {
	readonly eventVersion: 1;
	readonly designSessionId: string;
	readonly orchestrationEventId: string;
	readonly orchestrationRevision: number;
	readonly data: T;
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
	readonly readModels: readonly string[];
	readonly assumptions: readonly string[];
	readonly blockingQuestions: readonly string[];
	readonly outOfScope: readonly string[];
	readonly reviewed: boolean;
	readonly findingCounts: {
		critical: number;
		important: number;
		advisory: number;
	};
}

export function deriveDesignOutline(
	contract: AppDesignContract,
	reviews: readonly DesignReview[],
): DesignOutlineProjection {
	const findings = reviews.flatMap((review) => review.findings);
	const count = (severity: "critical" | "important" | "advisory") =>
		findings.filter((finding) => finding.severity === severity).length;
	return {
		objective: contract.objective,
		actors: contract.actors.map((actor) => actor.name),
		tasks: contract.tasks.map((task) => task.name),
		records: contract.records.map((record) => record.name),
		readModels: contract.readModels.map((readModel) => readModel.name),
		assumptions: contract.assumptions.map((assumption) => assumption.statement),
		blockingQuestions: contract.openQuestions
			.filter((question) => question.blocking)
			.map((question) => question.question),
		outOfScope: contract.outOfScope,
		reviewed: reviews.length > 0,
		findingCounts: {
			critical: count("critical"),
			important: count("important"),
			advisory: count("advisory"),
		},
	};
}

/** The four design-pipeline phases a pulse can name — the orchestrator's
 *  live "a model call is streaming right now" signal. Each maps onto one
 *  §15.2 stage, which is what makes the pulse a truthful stage source: the
 *  SERVER names the phase whose call is delivering tokens; the client only
 *  displays the latest. */
export const DESIGN_PULSE_PHASES = [
	"author",
	"review",
	"revise",
	"plan",
] as const;
export type DesignPulsePhase = (typeof DESIGN_PULSE_PHASES)[number];

/** One live-activity pulse: the streaming phase and the cumulative character
 *  count (reasoning + output) its call has delivered so far. Volume, not
 *  content — no model prose ever rides a pulse. */
export interface DesignPulseProjection {
	readonly phase: DesignPulsePhase;
	readonly chars: number;
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
): (phase: DesignPulsePhase, deltaChars: number) => void {
	let activePhase: DesignPulsePhase | null = null;
	let totalChars = 0;
	let lastEmitAt = 0;
	return (phase, deltaChars) => {
		if (phase !== activePhase) {
			activePhase = phase;
			totalChars = 0;
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
			} satisfies DesignPulseProjection),
			transient: true,
		});
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
