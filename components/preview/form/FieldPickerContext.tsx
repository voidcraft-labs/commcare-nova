/**
 * FieldPickerContext — shared menu handle for InsertionPoints.
 *
 * Instead of N+1 independent `Menu.Root` + `FieldTypePickerPopup` instances
 * (one per InsertionPoint per form), a single shared `Menu.Root` at the root
 * `FormRenderer` level serves all InsertionPoints via Base UI's detached
 * trigger pattern (`Menu.createHandle()`).
 *
 * Each InsertionPoint renders a lightweight `Menu.Trigger` with a typed
 * payload (`atIndex`, `parentPath`) that the shared popup reads to determine
 * where to insert the new field.
 *
 * `activeTarget` is the payload the menu is CURRENTLY open for (null when
 * closed) — the popup reports it from inside `Menu.Popup`, whose mount is
 * exactly the menu's open lifetime, so it is correct for every open path
 * (click, pointerdown-and-drag-into-menu, keyboard) and every close path
 * (select, Escape, outside click, re-anchor). The anchor InsertionPoint pins
 * its line open while `activeTarget` matches it.
 */
"use client";

import type { Menu } from "@base-ui/react/menu";
import { createContext, useContext } from "react";
import type { Uuid } from "@/lib/doc/types";

/** Payload sent from each InsertionPoint's `Menu.Trigger` to the shared popup.
 *  Identifies the insertion location in the form's field tree. */
export interface FieldPickerPayload {
	/** Insertion index within the parent's children array. */
	atIndex: number;
	/** UUID of the parent container (form for root-level, group/repeat uuid for nested). */
	parentUuid: Uuid;
}

/** The Base UI handle type, parameterized with our payload. */
export type FieldPickerHandle = Menu.Handle<FieldPickerPayload>;

interface FieldPickerContextValue {
	/** Shared menu handle connecting all InsertionPoint triggers to a single popup. */
	handle: FieldPickerHandle;
	/** The insertion location the menu is open for right now; null when closed. */
	activeTarget: FieldPickerPayload | null;
}

export const FieldPickerContext = createContext<FieldPickerContextValue | null>(
	null,
);

/** Read the shared field picker handle from context.
 *  Returns `null` outside the provider (non-edit mode, non-root scenarios). */
export function useFieldPicker(): FieldPickerContextValue | null {
	return useContext(FieldPickerContext);
}
