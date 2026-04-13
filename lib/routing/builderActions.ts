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
import { useBuilderEngine, useBuilderStore } from "@/hooks/useBuilder";
import { useAssembledForm } from "@/lib/doc/hooks/useAssembledForm";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { useLocation, useSelect } from "@/lib/routing/hooks";
import { flattenQuestionRefs } from "@/lib/services/questionPath";

/**
 * Undo / redo with scroll + flash affordance. Both actions are no-ops
 * when the respective temporal side is empty.
 *
 * Scroll target:
 *   - If the current URL has a `sel=` uuid, scroll to that question's
 *     field (or the question card itself when no activeFieldId is set).
 *   - Otherwise no scroll — the user wasn't focused on a specific row.
 */
export function useUndoRedo(): { undo: () => void; redo: () => void } {
	const docStore = useContext(BlueprintDocContext);
	const engine = useBuilderEngine();
	const loc = useLocation();
	const activeFieldId = useBuilderStore((s) => s.activeFieldId);

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
				engine.setFocusHint(activeFieldId);
			}

			const targetEl = engine.findFieldElement(selectedUuid, activeFieldId);
			engine.scrollToQuestion(selectedUuid, targetEl ?? undefined, "instant");
			const flashEl =
				targetEl ??
				(document.querySelector(
					`[data-question-uuid="${selectedUuid}"]`,
				) as HTMLElement | null);
			if (flashEl) engine.flashUndoHighlight(flashEl);
		}

		return {
			undo: () => run("undo"),
			redo: () => run("redo"),
		};
	}, [docStore, engine, loc, activeFieldId]);
}

/**
 * Delete the currently selected question and navigate to the adjacent
 * one (next if present, else previous, else clear the selection).
 *
 * No-op if no question is selected. The call sequence:
 *   1. Resolve the neighbor via `flattenQuestionRefs` on the assembled form.
 *   2. Dispatch `removeQuestion` directly through the doc store.
 *   3. Replace the URL's `sel=` with the neighbor's uuid (or drop it).
 */
export function useDeleteSelectedQuestion(): () => void {
	const docStore = useContext(BlueprintDocContext);
	const loc = useLocation();
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const form = useAssembledForm(formUuid as Uuid);
	const select = useSelect();

	return useMemo(
		() => () => {
			if (!docStore || loc.kind !== "form" || !loc.selectedUuid || !form)
				return;
			const refs = flattenQuestionRefs(form.questions);
			const idx = refs.findIndex((r) => r.uuid === loc.selectedUuid);
			const neighbor = refs[idx + 1] ?? refs[idx - 1];
			docStore
				.getState()
				.apply({ kind: "removeQuestion", uuid: asUuid(loc.selectedUuid) });
			select(neighbor ? asUuid(neighbor.uuid) : undefined);
		},
		[docStore, loc, form, select],
	);
}
