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
 * Map an event-log `stage` tag to the `GenerationStage` enum. Stages
 * that carry no narrate-worthy phase (`edit:*`, `rename:*`,
 * `module:remove:N`) return null. The `schema` / `scaffold` / `fix:…`
 * rows exist for HISTORICAL buffers only — runs persisted by the
 * retired generation tools and validate-fix loop still replay; live
 * builds open with `app` (updateApp) and build through
 * `module:create` (createModule).
 * Build-vs-edit is NOT this function's job — `derivePhase` keys that on
 * `runStartedWithData`, so an edit-mode createModule resolving to
 * `Modules` only drives the status text, never the layout.
 */
export function stageTagToGenerationStage(
	stage: string,
): GenerationStage | null {
	if (stage === "app") return GenerationStage.Structure;
	if (stage === "schema") return GenerationStage.DataModel;
	if (stage === "scaffold") return GenerationStage.Structure;
	if (stage === "module:create") return GenerationStage.Modules;
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
 * Latest classified error on the buffer, or null. Persists until
 * either a newer error arrives (supersedes) or the run ends and the
 * buffer clears. An older design cleared on any newer non-error
 * conversation event — that flashed the signal panel's error bezel off
 * as soon as the agent produced its next token of text or reasoning,
 * which is essentially always. Errors are sticky within a run.
 */
export function deriveAgentError(events: readonly Event[]): GenerationError {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind !== "conversation") continue;
		if (e.payload.type !== "error") continue;
		return {
			message: e.payload.error.message,
			severity: e.payload.error.fatal ? "failed" : "recovering",
		};
	}
	return null;
}

/**
 * Latest `validation-attempt` conversation event in the buffer —
 * HISTORICAL replays only. Live runs never emit the event (the
 * validate-fix loop is retired); a replayed buffer of a run logged
 * before that retirement still carries them, and this derivation lets
 * `deriveStatusMessage` compose the "Fixing N errors, attempt M"
 * status those runs showed. Returns null on every live buffer.
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
 * Whether the run is reading document attachments right now — true between the
 * `attachment-prep` `start` and `done` annotations (latest-wins). This is the
 * pre-Opus `resolveAttachments` window (resolving asset refs to their stored
 * extracts, lazily extracting any document without one), which can block the
 * first model token for several seconds; the signal grid shows a "reading
 * documents" status during it. Returns false once `done` lands (or the buffer
 * clears at run end), so it never bleeds into the generation stages that follow.
 */
export function deriveAttachmentPrep(events: readonly Event[]): boolean {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind !== "conversation") continue;
		if (e.payload.type !== "attachment-prep") continue;
		return e.payload.phase === "start";
	}
	return false;
}

/**
 * Whether the active run is a post-build edit. True iff a run is in
 * progress (buffer non-empty — see `BuilderSessionState.events`) AND
 * the run OPENED on a doc that already had data (`runStartedWithData`,
 * captured by `beginRun`). Initial builds and edits share every stage
 * tag now (both build through `createModule` / `addFields`), so the
 * run-start capture is the discriminator — a build's own mutations
 * populating the doc mid-run can't flip the derivation. The
 * empty-buffer check catches the between-runs window, matching the
 * semantics of the pre-refactor `agentActive` latch without
 * maintaining a separate flag.
 */
export function derivePostBuildEdit(
	events: readonly Event[],
	runStartedWithData: boolean,
): boolean {
	if (!runStartedWithData) return false;
	return events.length > 0;
}

/**
 * Status message shown in the signal panel bezel. Errors win over
 * stage labels; the `Fix` stage (historical replays only) composes
 * "Fixing N errors, attempt M" when a `validation-attempt` event is
 * available, and falls back to the generic `STAGE_LABELS[Fix]`
 * otherwise.
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
