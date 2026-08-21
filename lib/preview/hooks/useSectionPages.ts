/**
 * useSectionPages — the running form's pages, reactive to their visibility.
 *
 * The page list is DERIVED from the engine (the root sections of the form's
 * field tree plus, per page, whether anything on it is currently visible),
 * so it is read through the controller rather than stored. Subscribing to
 * the whole runtime store would re-render the pager on every keystroke;
 * instead the selector reduces the derivation to one string key (uuid and
 * visibility per page), and the array is rebuilt only when that key
 * changes: a page appears, disappears, moves, is re-ided (its /data path
 * is part of the key, so a rename re-renders the pager onto the live
 * paths), or flips between having something to show and not.
 */
"use client";
import { useMemo } from "react";
import { useStore } from "zustand";
import type { RuntimeStoreState } from "@/lib/preview/engine/engineController";
import type { SectionPage } from "@/lib/preview/engine/formEngine";
import { useEngineController } from "./useEngineController";

function pagesKey(pages: ReadonlyArray<SectionPage>): string {
	return pages
		.map(
			(page) => `${page.uuid}:${page.path}:${page.hasVisibleQuestions ? 1 : 0}`,
		)
		.join("|");
}

export function useSectionPages(): ReadonlyArray<SectionPage> {
	const controller = useEngineController();
	const key = useStore(controller.store, (_state: RuntimeStoreState) =>
		pagesKey(controller.sectionPages()),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the derivation's identity; the controller is the source it reads.
	return useMemo(() => controller.sectionPages(), [controller, key]);
}
