/**
 * Named hook: whether any field under `containerUuid`, at any depth, is a
 * repeat the worker grows by hand (`groupFieldLists.ts::holdsUserRepeat`).
 * A group holding one can't be shown on one screen, so the group's **Show on
 * one screen** switch reads this to say why it is off.
 *
 * The selector returns a boolean, so an edit re-renders the caller only when
 * the answer flips.
 */

"use client";

import { holdsUserRepeat } from "../groupFieldLists";
import type { Uuid } from "../types";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useHoldsUserRepeat(containerUuid: Uuid): boolean {
	return useBlueprintDoc((doc) => holdsUserRepeat(doc, containerUuid));
}
