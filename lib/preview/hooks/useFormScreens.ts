/**
 * useFormScreens: the running form's screens, reactive to their visibility.
 *
 * The screen list is DERIVED from the engine (the platform's screens of the
 * form's field tree plus, per screen, whether anything on it is currently
 * visible), so it is read through the controller rather than stored.
 * Subscribing to the whole runtime store would re-render the pager on every
 * keystroke; instead the selector reduces the derivation to one string key
 * (kind, uuid, path and visibility per screen), and the array is rebuilt only
 * when that key changes: a screen appears, disappears, moves, is re-ided (its
 * /data path is part of the key, so a rename re-renders the pager onto the
 * live paths), or flips between having something to show and not.
 *
 * `useFormScreens` is the platform's page model (`FormEngine.formScreens`);
 * `useSectionScreens` is the form's root sections alone, which the section
 * pager reads; `useRepeatPromptPoints` is where Android's repeat prompt
 * opens between the screens of a form without sections.
 */
"use client";
import { useMemo } from "react";
import { useStore } from "zustand";
import type {
	EngineController,
	RuntimeStoreState,
} from "@/lib/preview/engine/engineController";
import type {
	FormScreenPage,
	RepeatPromptPoint,
} from "@/lib/preview/engine/formEngine";
import { useEngineController } from "./useEngineController";

function screensKey(pages: ReadonlyArray<FormScreenPage>): string {
	return pages
		.map(
			(page) =>
				`${page.kind}:${page.uuid}:${page.path}:${page.hasVisibleQuestions ? 1 : 0}:${page.needsEntry ? 1 : 0}`,
		)
		.join("|");
}

function useScreens(
	read: (controller: EngineController) => ReadonlyArray<FormScreenPage>,
): ReadonlyArray<FormScreenPage> {
	const controller = useEngineController();
	const key = useStore(controller.store, (_state: RuntimeStoreState) =>
		screensKey(read(controller)),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the derivation's identity; the controller is the source it reads.
	return useMemo(() => read(controller), [controller, key]);
}

const formScreensOf = (controller: EngineController) =>
	controller.formScreens();
const sectionScreensOf = (controller: EngineController) =>
	controller.sectionScreens();

/** The running form's screens on the platform Preview plays. */
export function useFormScreens(): ReadonlyArray<FormScreenPage> {
	return useScreens(formScreensOf);
}

/** The running form's root sections as screens. */
export function useSectionScreens(): ReadonlyArray<FormScreenPage> {
	return useScreens(sectionScreensOf);
}

function promptsKey(points: ReadonlyArray<RepeatPromptPoint>): string {
	return points
		.map(
			(point) =>
				`${point.repeatUuid}:${point.repeatPath}:${point.entryCount}:${point.afterScreen}:${point.visible ? 1 : 0}`,
		)
		.join("|");
}

/** Android's repeat prompts in the running form without sections. */
export function useRepeatPromptPoints(): ReadonlyArray<RepeatPromptPoint> {
	const controller = useEngineController();
	const key = useStore(controller.store, (_state: RuntimeStoreState) =>
		promptsKey(controller.repeatPromptPoints()),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the derivation's identity; the controller is the source it reads.
	return useMemo(() => controller.repeatPromptPoints(), [controller, key]);
}
