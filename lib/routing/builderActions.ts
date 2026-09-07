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
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import {
	BlueprintDocContext,
	BlueprintEditableContext,
} from "@/lib/doc/provider";
import { selectionAfterFieldDeletion } from "@/lib/routing/deletionSelection";
import { findFieldElement, flashUndoHighlight } from "@/lib/routing/domQueries";
import { runHistoryStep } from "@/lib/routing/historyStep";
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
 *   - With no selection (no selected field UUID) there's no row to animate.
 *
 * Cross-form limitation:
 *   The selected field URL carries "where the user is looking right now," not
 *   "where the undone mutation happened," and undo/redo never touches the
 *   URL, so `selectedUuid` always belongs to the currently-rendered form.
 *   An undo of a change in a DIFFERENT form therefore animates the CURRENT
 *   selection, not where the change took effect. A history entry carries no
 *   location metadata to do better; the document is restored correctly
 *   regardless. The `!flashEl` bail fires only when the selected field itself
 *   has no DOM node (e.g. a redo that removed it).
 */
export function useUndoRedo(): { undo: () => void; redo: () => void } {
	const docStore = useContext(BlueprintDocContext);
	const { scrollTo } = useScrollIntoView();
	const activeFieldId = useActiveFieldId();
	const setFocusHint = useSetFocusHint();
	const projectToast = useProjectToast();
	const canEdit = useContext(BlueprintEditableContext);
	const lookupCommitState = useLookupCommitState();

	return useMemo(() => {
		function run(action: "undo" | "redo"): void {
			if (!docStore) return;
			const state = docStore.getState();
			const loc = readBuilderLocation(state);
			const result = runHistoryStep(
				state,
				action,
				{ canEdit, lookupCommitState },
				flushSync,
			);
			if (result.kind === "refused") {
				projectToast(
					"warning",
					action === "undo" ? "Can't undo" : "Can't redo",
					result.message,
				);
			}
			if (result.kind !== "applied") return;

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
		canEdit,
		lookupCommitState,
	]);
}

/**
 * Delete the currently selected field and navigate to the adjacent
 * one (next if present, else previous, else clear the selection).
 *
 * No-op if no field is selected. The call sequence:
 *   1. Capture visual field order from the live doc.
 *   2. Dispatch `removeField` through `useBlueprintMutations` — keeps
 *      the delete path consistent with every other doc mutation in the
 *      codebase (uuid resolution, dev-mode warn-on-miss).
 *   3. Select the next surviving visible field, then the previous, then none.
 *      Descendants removed with a container are never selection targets.
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
			const before = docApi.getState();
			const loc = readBuilderLocation(before);
			if (loc.kind !== "form" || !loc.selectedUuid) return;
			/* The commit gate can reject the removal (e.g. deleting a form's
			 * only field on a complete app would take the form incomplete) —
			 * the hook shows the rejection toast and returns false. Keep the
			 * selection on the still-present field rather than deselecting a
			 * field the user is looking at. */
			if (!removeField(loc.selectedUuid).ok) return;
			select(
				selectionAfterFieldDeletion(
					before,
					docApi.getState(),
					loc.formUuid,
					loc.selectedUuid,
				),
				loc,
			);
		},
		[docApi, select, removeField],
	);
}
