import type { DesignSessionDoc } from "@/lib/db/designSessions";
import {
	type DesignSessionLeaseRow,
	designSessionLeaseState,
} from "@/lib/db/runLiveness";
import type { DesignBuildStage } from "@/lib/generation/designProgressWire";
import type {
	BuildOrchestratorState,
	OrchestrationHead,
} from "./orchestratorState";

export type { DesignBuildStage } from "@/lib/generation/designProgressWire";
export type StageFoldSession = DesignSessionLeaseRow &
	Pick<DesignSessionDoc, "last_error_type" | "app_id">;

export function authoringStage(
	state: BuildOrchestratorState,
): DesignBuildStage {
	switch (state.kind) {
		case "planning":
		case "building":
		case "reviewing-plan":
		case "reviewing-app":
			return state.kind;
		case "awaiting-input":
			return "needs-input";
		case "finished":
			return "ready";
		case "failed":
			return state.recoverable ? "incomplete" : "failed";
	}
}
export function deriveDesignBuildStage(
	session: StageFoldSession,
	head: OrchestrationHead | null,
): DesignBuildStage {
	if (head?.state.kind === "finished") return "ready";
	if (session.state === "abandoned" || session.state === "retired")
		return "failed";
	if (session.awaiting_input) return "needs-input";
	if (
		session.last_error_type !== null ||
		designSessionLeaseState(session).reapableStaleRun
	)
		return "incomplete";
	return head ? authoringStage(head.state) : "planning";
}
export function deriveInterruptedMaterializedBuildStage(
	session: StageFoldSession,
	head: OrchestrationHead | null,
): DesignBuildStage {
	return head?.state.kind === "finished" || head?.state.kind === "failed"
		? deriveDesignBuildStage(session, head)
		: "incomplete";
}
