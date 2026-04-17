/**
 * Composite builder actions that combine URL state with doc mutations
 * and imperative DOM side effects.
 *
 * Before Phase 2, these lived as methods on `BuilderEngine`. In the new
 * architecture, each is a small React hook that reads `useLocation()`,
 * dispatches through the doc store via `useBlueprintMutations()` (or
 * directly via the doc's temporal), and triggers DOM side effects
 * through surviving engine utilities (scroll, flash).
 */

"use client";

import { useContext, useMemo } from "react";
import { flushSync } from "react-dom";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { useAssembledForm } from "@/lib/doc/hooks/useAssembledForm";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
import { findFieldElement, flashUndoHighlight } from "@/lib/routing/domQueries";
import { useLocation, useSelect } from "@/lib/routing/hooks";
import { flattenQuestionRefs } from "@/lib/services/questionPath";
import { useActiveFieldId, useSetFocusHint } from "@/lib/session/hooks";

/**
 * Undo / redo with scroll + flash affordance. Both actions are no-ops
 * when the respective temporal side is empty.
 *
 * Scroll target:
 *   - If the current URL has a `sel=` uuid, scroll to that question's
 *     field (or the question card itself when no activeFieldId is set).
 *   - Otherwise no scroll — the user wasn't focused on a specific row.
 *
 * Cross-form undo limitation (see spec Section 4 "undo flash" table):
 *   The URL's `sel=` carries "where the user is looking right now," not
 *   "where the undone mutation happened." When the undone mutation was
 *   in a different form, the restored selected uuid has no DOM element
 *   in the current viewport — we bail on scroll/flash rather than trying
 *   to navigate across forms mid-undo. The state is still restored
 *   correctly; only the animated affordance is suppressed.
 *
 *   This is an accepted trade-off until the doc's temporal middleware
 *   carries location metadata alongside each patch (planned for Phase 3
 *   or Phase 4, depending on temporal-store scope).
 */
export function useUndoRedo(): { undo: () => void; redo: () => void } {
	const docStore = useContext(BlueprintDocContext);
	const { scrollTo } = useScrollIntoView();
	const loc = useLocation();
	const activeFieldId = useActiveFieldId();
	const setFocusHint = useSetFocusHint();

	return useMemo(() => {
		function run(action: "undo" | "redo"): void {
			if (!docStore) return;
			const temporal = docStore.temporal.getState();
			const canDo =
				action === "undo"
					? temporal.pastStates.length > 0
					: temporal.futureStates.length > 0;
			if (!canDo) return;

			/* flushSync so the restored entities commit to the DOM before
			 * we query it for the scroll/flash target. */
			flushSync(() => {
				if (action === "undo") temporal.undo();
				else temporal.redo();
			});

			const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;
			if (!selectedUuid) return;

			if (activeFieldId) {
				setFocusHint(activeFieldId);
			}

			/* Resolve the flash/scroll target from the live DOM. If neither
			 * the field element nor the question card exists, the undone
			 * mutation targeted a different form and the current viewport
			 * has nothing to animate — bail gracefully. See the block
			 * comment above for the cross-form undo limitation. */
			const targetEl = findFieldElement(selectedUuid, activeFieldId);
			const flashEl =
				targetEl ??
				(document.querySelector(
					`[data-question-uuid="${selectedUuid}"]`,
				) as HTMLElement | null);
			if (!flashEl) return;

			scrollTo(selectedUuid, targetEl ?? undefined, "instant");
			flashUndoHighlight(flashEl);
		}

		return {
			undo: () => run("undo"),
			redo: () => run("redo"),
		};
	}, [docStore, scrollTo, loc, activeFieldId, setFocusHint]);
}

/**
 * Delete the currently selected question and navigate to the adjacent
 * one (next if present, else previous, else clear the selection).
 *
 * No-op if no question is selected. The call sequence:
 *   1. Resolve the neighbor via `flattenQuestionRefs` on the assembled form.
 *   2. Dispatch `removeField` through `useBlueprintMutations` — keeps
 *      the delete path consistent with every other doc mutation in the
 *      codebase (uuid resolution, dev-mode warn-on-miss).
 *   3. Replace the URL's `sel=` with the neighbor's uuid (or drop it).
 */
export function useDeleteSelectedQuestion(): () => void {
	const loc = useLocation();
	/* `useAssembledForm` accepts `undefined` and short-circuits cheaply —
	 * no need to coerce through `as Uuid`. When the user is off-form, the
	 * hook never subscribes to any entity map, so doc mutations don't
	 * re-render this hook's consumer. */
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const form = useAssembledForm(formUuid);
	const select = useSelect();
	const { removeField } = useBlueprintMutations();

	return useMemo(
		() => () => {
			if (loc.kind !== "form" || !loc.selectedUuid || !form) return;
			/* `flattenQuestionRefs` skips hidden questions. If the selected
			 * uuid is hidden, or stale (race with LocationRecoveryEffect),
			 * `findIndex` returns -1 — guard against that so `refs[-1 + 1]`
			 * doesn't silently promote `refs[0]` to "neighbor" and jump the
			 * selection to the top of the form. Drop selection instead. */
			const refs = flattenQuestionRefs(form.questions);
			const idx = refs.findIndex((r) => r.uuid === loc.selectedUuid);
			const neighbor = idx < 0 ? undefined : (refs[idx + 1] ?? refs[idx - 1]);
			removeField(asUuid(loc.selectedUuid));
			select(neighbor ? asUuid(neighbor.uuid) : undefined);
		},
		[loc, form, select, removeField],
	);
}
