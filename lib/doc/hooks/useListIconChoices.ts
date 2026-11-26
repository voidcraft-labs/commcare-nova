"use client";

import { useMemo } from "react";
import type { Column, Uuid } from "@/lib/domain";
import { type ListIconChoice, listIconChoices } from "../entryPointProjection";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** The forms a tap on this column's icon may submit, recomputed when the
 * document changes, since a form anywhere in the app can become or stop
 * being one. */
export function useListIconChoices(
	moduleUuid: Uuid,
	column: Column,
): readonly ListIconChoice[] {
	const doc = useBlueprintDoc((state) => state);
	return useMemo(
		() => listIconChoices(doc, moduleUuid, column),
		[doc, moduleUuid, column],
	);
}
