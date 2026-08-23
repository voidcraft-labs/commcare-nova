"use client";

import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { PreviewMenuSource } from "../menuProjection";

const EMPTY_CASE_TYPES: PreviewMenuSource["caseTypes"] = [];

/** The stable document slices needed to project the running menu tree. */
export function usePreviewMenuSource(): PreviewMenuSource {
	return useBlueprintDocShallow((state) => ({
		modules: state.modules,
		moduleOrder: state.moduleOrder,
		caseTypes: state.caseTypes ?? EMPTY_CASE_TYPES,
	}));
}
