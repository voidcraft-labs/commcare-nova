/**
 * Lifecycle derivations over the session events buffer.
 *
 * These pure functions are the single source of truth for every UI
 * lifecycle signal: generation stage, classified error, status message,
 * validation attempt context, postBuildEdit latch. Both live and replay
 * paths feed the same `Event[]` into these functions — if the buffer
 * matches, the rendered layout matches.
 *
 * Implementation note — each derivation walks the buffer every call,
 * but the buffer is only appended to (live) or replaced wholesale on
 * scrub (replay), so the cost is O(events). For realistic runs
 * (~1000 events) this is well under a millisecond. Callers cache via
 * `useMemo` where React re-renders demand it.
 */

import type { Event } from "@/lib/log/types";
import type { GenerationError } from "./types";
import { GenerationStage, STAGE_LABELS } from "./types";

/**
 * Map an event-log `stage` tag to the `GenerationStage` enum. Only tags
 * that belong to an initial-build phase resolve — edit-family tags
 * (`edit:*`, `rename:*`, `module:create`, `module:remove:N`) return
 * null so the phase derivation can distinguish post-build edits.
 */
export function stageTagToGenerationStage(
	stage: string,
): GenerationStage | null {
	if (stage === "schema") return GenerationStage.DataModel;
	if (stage === "scaffold") return GenerationStage.Structure;
	if (stage === "module:create") return null;
	if (stage.startsWith("module:remove:")) return null;
	if (stage.startsWith("module:")) return GenerationStage.Modules;
	if (stage.startsWith("form:")) return GenerationStage.Forms;
	if (stage.startsWith("fix")) return GenerationStage.Fix;
	return null;
}

/**
 * Latest generation stage in the buffer. Returns null when no mutation
 * events carry a recognized stage tag — the "SA is thinking /
 * askQuestions" window. `derivePhase` treats null-stage-while-active as
 * Idle (centered chat layout) — the phase only transitions to
 * Generating once the SA actually starts producing structural output.
 */
export function deriveAgentStage(
	events: readonly Event[],
): GenerationStage | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind !== "mutation" || !e.stage) continue;
		const resolved = stageTagToGenerationStage(e.stage);
		if (resolved !== null) return resolved;
	}
	return null;
}

/**
 * Latest classified error on the buffer, or null. Cleared by any newer
 * non-error conversation event — a successful fix attempt that produces
 * fresh assistant output naturally clears the "recovering" warning.
 * Mutation events are transparent: a fix-mutation landing after an
 * error doesn't clear the error surface on its own.
 */
export function deriveAgentError(events: readonly Event[]): GenerationError {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind !== "conversation") continue;
		if (e.payload.type !== "error") return null;
		return {
			message: e.payload.error.message,
			severity: e.payload.error.fatal ? "failed" : "recovering",
		};
	}
	return null;
}

/**
 * Latest `validation-attempt` conversation event in the buffer — carries
 * the attempt number and the count of errors the attempt was
 * responding to. Returns null when no validation pass has run in the
 * current run (the buffer is cleared by `beginRun`, so prior runs
 * never leak in).
 *
 * Used by `deriveStatusMessage` to compose "Fixing N errors, attempt
 * M" and by log readers / admin inspectors to reconstruct which errors
 * drove which fix batch.
 */
export function deriveValidationAttempt(
	events: readonly Event[],
): { attempt: number; errorCount: number } | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind !== "conversation") continue;
		if (e.payload.type !== "validation-attempt") continue;
		return {
			attempt: e.payload.attempt,
			errorCount: e.payload.errors.length,
		};
	}
	return null;
}

/**
 * Whether the active run is a post-build edit. True iff the run is
 * active, no `schema` or `scaffold` mutation has landed yet, AND the
 * doc already has data. The doc-has-data check catches the
 * askQuestions window (doc empty → still Idle, not edit), matching
 * the semantics of the pre-refactor latch.
 */
export function derivePostBuildEdit(
	events: readonly Event[],
	agentActive: boolean,
	docHasData: boolean,
): boolean {
	if (!agentActive) return false;
	for (const e of events) {
		if (e.kind !== "mutation" || !e.stage) continue;
		if (e.stage === "schema" || e.stage === "scaffold") return false;
	}
	return docHasData;
}

/**
 * Status message shown in the signal panel bezel. Errors win over
 * stage labels; `Fix` stage composes "Fixing N errors, attempt M"
 * when a `validation-attempt` event is available, and falls back to
 * the generic `STAGE_LABELS[Fix]` otherwise (e.g. the pre-first-attempt
 * window).
 */
export function deriveStatusMessage(
	stage: GenerationStage | null,
	error: GenerationError,
	validationAttempt: { attempt: number; errorCount: number } | null,
): string {
	if (error) return error.message;
	if (!stage) return "";
	if (stage === GenerationStage.Fix && validationAttempt) {
		const { attempt, errorCount } = validationAttempt;
		const plural = errorCount === 1 ? "error" : "errors";
		return `Fixing ${errorCount} ${plural}, attempt ${attempt}`;
	}
	return STAGE_LABELS[stage];
}
