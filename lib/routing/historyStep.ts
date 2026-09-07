import { builderWriteAdmission } from "@/lib/doc/builderWriteAdmission";
import {
	describeCommitFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import type { LookupCommitState } from "@/lib/doc/lookupCommitContext";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDocState } from "@/lib/doc/store";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/**
 * Collaborative undo/redo gate — the pure decision the hook runs before it
 * mutates.
 *
 * An undo is an ordinary edit: it applies the recorded step's inverse through
 * the same write path everything else uses, so it is gated the same way. A
 * peer's committed change can make that inverse reintroduce a validator finding
 * — restoring a field a peer's rename now collides with, say — so the gate runs
 * the batch against the doc on screen and refuses with the finding rather than
 * letting the PUT 409 into a conflict reload.
 *
 * `lookupContext` is the Project's lookup-definition context the builder
 * holds (`useLookupCommitState`). The gate is absolute: on a doc that carries
 * a lookup-backed select, an unavailable context refuses EVERY step, including
 * one that never touched the lookup, so the caller supplies the same context
 * every other builder write runs under — after `builderWriteAdmission` has
 * already refused a viewer and a catalog that is loading or failed.
 *
 * Pure of React + the store so it is exercised as a state model.
 */
function undoRedoGateVerdict(
	displayed: BlueprintDoc,
	batch: readonly Mutation[],
	lookupContext: LookupValidationContext,
): { ok: true } | { ok: false; message: string } {
	const verdict = mutationCommitVerdict(displayed, batch, lookupContext);
	if (verdict.ok) return { ok: true };
	return { ok: false, message: describeCommitFindings(verdict.findings) };
}

export type HistoryStepResult =
	| { kind: "empty" }
	| { kind: "refused"; message: string }
	| { kind: "applied" };

/** Execute history under the same admission and current-document verdict as
 * other edits. The browser supplies flushSync so restored nodes exist before
 * its scroll and highlight effects; ordinary state consumers commit directly. */
export function runHistoryStep(
	state: BlueprintDocState,
	action: "undo" | "redo",
	access: { canEdit: boolean; lookupCommitState: LookupCommitState },
	commit: (apply: () => void) => void = (apply) => apply(),
): HistoryStepResult {
	const batch = action === "undo" ? state.undoBatch() : state.redoBatch();
	if (batch === undefined) return { kind: "empty" };
	const admission = builderWriteAdmission(access);
	if (!admission.ok)
		return { kind: "refused", message: admission.messages.join(" ") };
	const verdict = undoRedoGateVerdict(
		state,
		batch,
		access.lookupCommitState.lookupContext,
	);
	if (!verdict.ok) return { kind: "refused", message: verdict.message };
	commit(() => {
		if (action === "undo") state.undo();
		else state.redo();
	});
	return { kind: "applied" };
}
