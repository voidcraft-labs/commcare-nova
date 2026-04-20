/**
 * Selection-dispatch hook for the AppTree.
 *
 * Produces the `handleSelect` callback every row component calls when
 * the user clicks a tree item. Centralizes two responsibilities:
 *
 *   1. URL navigation via `useNavigate` — selection state lives in the
 *      URL, so a click ultimately resolves to a history update.
 *   2. Pending-scroll priming for field selections. The scroll
 *      request must be posted BEFORE the URL change so the target row's
 *      `useFulfillPendingScroll` has a request waiting when its
 *      `isSelected` flips true. Reversing the order drops the scroll
 *      because the row would consume the request that is not yet there.
 *
 * Row components stay thin — they only know how to build a typed target
 * shape and hand it to the returned handler.
 */
"use client";
import { useCallback } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import type { Uuid } from "@/lib/doc/types";
import { useNavigate } from "@/lib/routing/hooks";

/**
 * Discriminated union of every tree-selection shape. Every row
 * component produces one of these; the handler dispatches on `kind`.
 */
type TreeSelectTarget =
	| { kind: "clear" }
	| { kind: "module"; moduleUuid: Uuid }
	| { kind: "form"; moduleUuid: Uuid; formUuid: Uuid }
	| { kind: "field"; moduleUuid: Uuid; formUuid: Uuid; fieldUuid: Uuid };

/** Callback passed down through the AppTree row components. */
export type TreeSelectHandler = (target: TreeSelectTarget) => void;

/** Build the tree-selection dispatcher. Stable across renders. */
export function useAppTreeSelection(): TreeSelectHandler {
	const navigate = useNavigate();
	const { setPending } = useScrollIntoView();

	return useCallback<TreeSelectHandler>(
		(target) => {
			switch (target.kind) {
				case "clear":
					return navigate.goHome();
				case "module":
					return navigate.openModule(target.moduleUuid);
				case "form":
					return navigate.openForm(target.moduleUuid, target.formUuid);
				case "field":
					setPending(target.fieldUuid, "instant", false);
					return navigate.openForm(
						target.moduleUuid,
						target.formUuid,
						target.fieldUuid,
					);
			}
		},
		[navigate, setPending],
	);
}
