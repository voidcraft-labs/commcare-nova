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
