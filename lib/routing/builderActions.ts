/**
 * Composite builder actions that combine URL state with doc mutations
 * and imperative DOM side effects.
 *
 * Each action is a small React hook that reads `useLocation()`, dispatches
 * through the doc store via `useBlueprintMutations()` (or the store's own undo
 * history), and triggers DOM side effects via the scroll registry + flash
 * helpers in `domQueries.ts`.
 */

"use client";

import { useContext, useMemo } from "react";
import { flushSync } from "react-dom";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import {
	describeCommitFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { flattenFieldRefs } from "@/lib/doc/navigation";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc } from "@/lib/doc/types";
import { findFieldElement, flashUndoHighlight } from "@/lib/routing/domQueries";
import { readBuilderLocation, useSelect } from "@/lib/routing/hooks";
import { useActiveFieldId, useSetFocusHint } from "@/lib/session/hooks";

/**
 * Undo / redo with scroll + flash affordance. Both actions are no-ops when the
 * respective history is empty.
 *
 * Affordance target:
 *   - The CANVAS scrolls to bring the currently-selected field's ROW
 *     (`[data-field-uuid]`) into view — always the row, never a
 *     sub-element. The edited property's editor lives in the rail (a
 *     separate scroll container), so feeding it to the canvas scroll
 *     routine would compute a bogus offset and jump the canvas.
 *   - The flash lands on the edited property's editor in the rail when
 *     `activeFieldId` resolves one (`findFieldElement`), else on the field
 *     row. `activeFieldId` also seeds the focus hint for that rail editor.
 *   - With no selection (no `sel=` uuid) there's no row to animate.
 *
 * Cross-form limitation:
 *   The URL's `sel=` carries "where the user is looking right now," not
 *   "where the undone mutation happened," and undo/redo never touches the
 *   URL — so `selectedUuid` always belongs to the currently-rendered form.
 *   An undo of a change in a DIFFERENT form therefore animates the CURRENT
 *   selection, not where the change took effect. A history entry carries no
 *   location metadata to do better; the document is restored correctly
 *   regardless. The `!flashEl` bail fires only when the selected field itself
 *   has no DOM node (e.g. a redo that removed it).
 */
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
 * every other builder write runs under.
 *
 * Pure of React + the store so it is exercised as a state model.
 */
export function undoRedoGateVerdict(
	displayed: BlueprintDoc,
	batch: readonly Mutation[],
	lookupContext: LookupValidationContext,
): { ok: true } | { ok: false; message: string } {
	const verdict = mutationCommitVerdict(displayed, batch, lookupContext);
	if (verdict.ok) return { ok: true };
	return { ok: false, message: describeCommitFindings(verdict.findings) };
}

export function useUndoRedo(): { undo: () => void; redo: () => void } {
	const docStore = useContext(BlueprintDocContext);
	const { scrollTo } = useScrollIntoView();
	const activeFieldId = useActiveFieldId();
	const setFocusHint = useSetFocusHint();
	const projectToast = useProjectToast();
	const { lookupContext } = useLookupCommitState();

	return useMemo(() => {
		function run(action: "undo" | "redo"): void {
			if (!docStore) return;
			const state = docStore.getState();
			const loc = readBuilderLocation(state);
			const batch = action === "undo" ? state.undoBatch() : state.redoBatch();
			if (batch === undefined) return;

			/* GATE BEFORE MUTATING. A peer's committed change can make the recorded
			 * step's batch reintroduce a finding, so refuse with the reason rather
			 * than applying it and letting the PUT 409 into a conflict reload. */
			const verdict = undoRedoGateVerdict(state, batch, lookupContext);
			if (!verdict.ok) {
				projectToast(
					"warning",
					action === "undo" ? "Can't undo" : "Can't redo",
					verdict.message,
				);
				return;
			}

			/* flushSync so the restored entities commit to the DOM before we query
			 * it for the scroll/flash target. The apply goes through the ordinary
			 * write path, so it queues for persistence like any other edit and
			 * `useAutoSave`'s leading edge emits the single PUT. */
			flushSync(() => {
				if (action === "undo") state.undo();
				else state.redo();
			});

			const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;
			if (!selectedUuid) return;

			if (activeFieldId) {
				setFocusHint(activeFieldId);
			}

			/* Resolve the flash target from the live DOM. The edited
			 * property's editor lives in the rail inspector now; flash it
			 * there, falling back to the canvas field card. If neither exists
			 * the selected field has no DOM node (e.g. a redo that removed it),
			 * so there's nothing to animate — bail gracefully. See the block
			 * comment above for the cross-form caveat. */
			const railFieldEl = findFieldElement(selectedUuid, activeFieldId);
			const flashEl =
				railFieldEl ??
				(document.querySelector(
					`[data-field-uuid="${selectedUuid}"]`,
				) as HTMLElement | null);
			if (!flashEl) return;

			/* Scroll the CANVAS to the field row (no override). The rail
			 * property is in a different scroll container, so feeding it to
			 * the canvas scroll routine would compute a bogus offset and
			 * jump the canvas; the field row is the right thing to bring
			 * into view. */
			scrollTo(selectedUuid, undefined, "instant");
			flashUndoHighlight(flashEl);
		}

		return {
			undo: () => run("undo"),
			redo: () => run("redo"),
		};
	}, [
		docStore,
		scrollTo,
		activeFieldId,
		setFocusHint,
		projectToast,
		lookupContext,
	]);
}

/**
 * Delete the currently selected field and navigate to the adjacent
 * one (next if present, else previous, else clear the selection).
 *
 * No-op if no field is selected. The call sequence:
 *   1. Resolve the neighbor via `flattenFieldRefs` on the live doc.
 *   2. Dispatch `removeField` through `useBlueprintMutations` — keeps
 *      the delete path consistent with every other doc mutation in the
 *      codebase (uuid resolution, dev-mode warn-on-miss).
 *   3. Replace the URL's `sel=` with the neighbor's uuid (or drop it).
 *
 * Neighbor resolution reads the doc imperatively at call time via
 * `useBlueprintDocApi()` — the handler only fires on user action, and
 * a subscription slice would force a re-render on every unrelated doc
 * mutation for a value we only need in the delete callback.
 */
export function useDeleteSelectedField(): () => void {
	const docApi = useBlueprintDocApi();
	const select = useSelect();
	const { removeField } = useBlueprintMutations();

	return useMemo(
		() => () => {
			const loc = readBuilderLocation(docApi.getState());
			if (loc.kind !== "form" || !loc.selectedUuid) return;
			/* `flattenFieldRefs` skips hidden fields. If the selected uuid is
			 * hidden, or stale (race with LocationRecoveryEffect), `findIndex`
			 * returns -1 — guard against that so `refs[-1 + 1]` doesn't
			 * silently promote `refs[0]` to "neighbor" and jump the selection
			 * to the top of the form. Drop selection instead. */
			const refs = flattenFieldRefs(docApi.getState(), loc.formUuid);
			const idx = refs.findIndex((r) => r.uuid === loc.selectedUuid);
			const neighbor = idx < 0 ? undefined : (refs[idx + 1] ?? refs[idx - 1]);
			/* The commit gate can reject the removal (e.g. deleting a form's
			 * only field on a complete app would take the form incomplete) —
			 * the hook shows the rejection toast and returns false. Keep the
			 * selection on the still-present field rather than deselecting a
			 * field the user is looking at. */
			if (!removeField(asUuid(loc.selectedUuid)).ok) return;
			select(neighbor ? neighbor.uuid : undefined, loc);
		},
		[docApi, select, removeField],
	);
}
