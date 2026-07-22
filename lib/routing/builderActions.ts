/**
 * Composite builder actions that combine URL state with doc mutations
 * and imperative DOM side effects.
 *
 * Each action is a small React hook that reads `useLocation()`,
 * dispatches through the doc store via `useBlueprintMutations()` (or
 * directly via the doc's temporal), and triggers DOM side effects via
 * the scroll registry + flash helpers in `domQueries.ts`.
 */

"use client";

import { useContext, useMemo } from "react";
import { flushSync } from "react-dom";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { useReconcilerContext } from "@/lib/collab/context";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import {
	describeIntroducedErrors,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { flattenFieldRefs } from "@/lib/doc/navigation";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid, type BlueprintDoc } from "@/lib/doc/types";
import { findFieldElement, flashUndoHighlight } from "@/lib/routing/domQueries";
import { useLocation, useSelect } from "@/lib/routing/hooks";
import { useActiveFieldId, useSetFocusHint } from "@/lib/session/hooks";

/**
 * Undo / redo with scroll + flash affordance. Both actions are no-ops
 * when the respective temporal side is empty.
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
 *   selection, not where the change took effect. The doc's temporal
 *   middleware carries no location metadata to do better; the state is
 *   restored correctly regardless. The `!flashEl` bail fires only when the
 *   selected field itself has no DOM node (e.g. a redo that removed it).
 */
/**
 * Collaborative undo/redo gate — the pure decision the hook runs before it
 * mutates.
 *
 * A remote frame folds the past AND future undo stacks (`rebaseHistory`), so a
 * recorded undo/redo target carries peers' committed changes and could
 * reintroduce a validator finding against the current merged doc. The gate must
 * verdict the EXACT delta the reconciler will PUT after `temporal.undo()`:
 * `dispatchHumanBatch` computes `diff(localBase(), displayed-after-undo)`, and
 * after the undo `displayed === rebasedTarget`, so the PUT batch is
 * `diff(localBase, rebasedTarget)`. The gate verdicts that same batch against
 * `localBase` (the confirmed⊕sentPending base the server re-applies onto), so a
 * gate pass guarantees the PUT can't 409 on a finding the gate didn't see — the
 * clean Elm-message refusal, never a surprise conflict-reload.
 *
 * `localBase` is the reconciler's `localBase()`; it equals `displayed` when
 * there is no reconciler (replay) or no un-acked pending. On a finding it
 * returns `{ ok: false, message }` (the caller refuses — no `temporal.undo`, no
 * PUT); on a pass, `{ ok: true }` and the caller restores + lets autosave emit
 * the one PUT.
 *
 * Pure of React + the store so it is exercised as a state model. `targetState`
 * is the recorded temporal state (`pastStates[last]` / `futureStates[last]`).
 */
export function undoRedoGateVerdict(
	displayed: BlueprintDoc,
	targetState: Partial<BlueprintDoc>,
	localBase: BlueprintDoc,
): { ok: true } | { ok: false; message: string } {
	// The recorded state carries the full doc data; merge it over the current
	// displayed doc so derived slots (fieldParent/refIndex) and any unrecorded
	// key stay coherent — this is the doc the store lands on after the restore.
	const rebasedTarget = { ...displayed, ...targetState } as BlueprintDoc;
	// The delta the reconciler will PUT: from the confirmed⊕pending base to the
	// undo target — NOT `diff(displayed, target)`, which is a different batch
	// whenever `sentPending` is non-empty and would let the gate approve a
	// transition whose real PUT it never verdicted.
	const batch = diffDocsToMutations(
		toPersistableDoc(localBase) as BlueprintDoc,
		toPersistableDoc(rebasedTarget) as BlueprintDoc,
	);
	const verdict = mutationCommitVerdict(
		localBase,
		batch,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (verdict.ok) return { ok: true };
	return { ok: false, message: describeIntroducedErrors(verdict.introduced) };
}

export function useUndoRedo(): { undo: () => void; redo: () => void } {
	const docStore = useContext(BlueprintDocContext);
	const reconcilerCtx = useReconcilerContext();
	const { scrollTo } = useScrollIntoView();
	const loc = useLocation();
	const activeFieldId = useActiveFieldId();
	const setFocusHint = useSetFocusHint();
	const projectToast = useProjectToast();

	return useMemo(() => {
		function run(action: "undo" | "redo"): void {
			if (!docStore) return;
			const temporal = docStore.temporal.getState();
			const stack =
				action === "undo" ? temporal.pastStates : temporal.futureStates;
			if (stack.length === 0) return;

			/* Collaborative undo/redo GATE-BEFORE-MUTATING (see `undoRedoGateVerdict`).
			 * Peek the state undo/redo would restore and run the commit verdict on the
			 * SAME delta the reconciler will PUT — `diff(localBase(), rebasedTarget)` —
			 * so a gate pass can't 409-surprise; on a finding REFUSE (apply nothing —
			 * no `temporal.undo/redo`, no PUT) and show the reason. On a pass, restore
			 * WITHOUT a suppression bracket so `useAutoSave`'s leading edge fires
			 * exactly one PUT of that diff. `localBase()` falls back to the displayed
			 * doc with no reconciler (replay) or no un-acked pending. */
			const displayed = docStore.getState();
			const localBase = reconcilerCtx?.reconciler.localBase() ?? displayed;
			const target = stack[stack.length - 1] as Partial<BlueprintDoc>;
			const verdict = undoRedoGateVerdict(displayed, target, localBase);
			if (!verdict.ok) {
				projectToast(
					"warning",
					action === "undo" ? "Can't undo" : "Can't redo",
					verdict.message,
				);
				return;
			}

			/* flushSync so the restored entities commit to the DOM before
			 * we query it for the scroll/flash target. `temporal.undo/redo` fires
			 * the store subscriber synchronously, so `useAutoSave`'s leading edge
			 * emits the single PUT — the undo handler itself never PUTs. */
			flushSync(() => {
				if (action === "undo") temporal.undo();
				else temporal.redo();
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
		reconcilerCtx,
		scrollTo,
		loc,
		activeFieldId,
		setFocusHint,
		projectToast,
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
	const loc = useLocation();
	const docApi = useBlueprintDocApi();
	const select = useSelect();
	const { removeField } = useBlueprintMutations();

	return useMemo(
		() => () => {
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
			select(neighbor ? neighbor.uuid : undefined);
		},
		[loc, docApi, select, removeField],
	);
}
