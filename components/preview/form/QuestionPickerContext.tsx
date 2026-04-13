/**
 * QuestionPickerContext — shared menu handle for InsertionPoints.
 *
 * Instead of N+1 independent `Menu.Root` + `QuestionTypePickerPopup` instances
 * (one per InsertionPoint per form), a single shared `Menu.Root` at the root
 * `FormRenderer` level serves all InsertionPoints via Base UI's detached
 * trigger pattern (`Menu.createHandle()`).
 *
 * Each InsertionPoint renders a lightweight `Menu.Trigger` with a typed
 * payload (`atIndex`, `parentPath`) that the shared popup reads to determine
 * where to insert the new question.
 *
 * The `subscribeClose` pub/sub lets InsertionPoints reset their hover state
 * when the shared menu closes — necessary because the InsertionPoint no
 * longer owns the `Menu.Root` and can't observe `onOpenChange` directly.
 */
"use client";

import type { Menu } from "@base-ui/react/menu";
import { createContext, useContext } from "react";
import type { Uuid } from "@/lib/doc/types";

/** Payload sent from each InsertionPoint's `Menu.Trigger` to the shared popup.
 *  Identifies the insertion location in the form's question tree. */
export interface QuestionPickerPayload {
	/** Insertion index within the parent's children array. */
	atIndex: number;
	/** UUID of the parent container (form for root-level, group/repeat uuid for nested). */
	parentUuid: Uuid;
}

/** The Base UI handle type, parameterized with our payload. */
export type QuestionPickerHandle = Menu.Handle<QuestionPickerPayload>;

interface QuestionPickerContextValue {
	/** Shared menu handle connecting all InsertionPoint triggers to a single popup. */
	handle: QuestionPickerHandle;
	/** Subscribe to menu close events so InsertionPoints can reset hover state.
	 *  Returns an unsubscribe function. */
	subscribeClose: (listener: () => void) => () => void;
}

export const QuestionPickerContext =
	createContext<QuestionPickerContextValue | null>(null);

/** Read the shared question picker handle from context.
 *  Returns `null` outside the provider (non-edit mode, non-root scenarios). */
export function useQuestionPicker(): QuestionPickerContextValue | null {
	return useContext(QuestionPickerContext);
}
