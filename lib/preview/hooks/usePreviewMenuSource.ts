"use client";

import { useMemo } from "react";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { BlueprintDoc } from "@/lib/domain";
import { pickBlueprintDoc } from "../engine/caseDataBindingClient";
import type { PreviewMenuSource } from "../menuProjection";

const EMPTY_CASE_TYPES: PreviewMenuSource["caseTypes"] = [];

/** The actual immutable document and its menu slices, used together for slot-aware navigation. */
export function usePreviewMenuSource(): PreviewMenuSource & {
	readonly doc: BlueprintDoc;
} {
	// Results and Details send this document to a Server Action. Store methods,
	// history flags and store-only indexes are not document fields; shallow selection also
	// keeps their updates from restarting an unchanged case-data request.
	const doc = useBlueprintDocShallow(pickBlueprintDoc);
	return useMemo(
		() => ({
			doc,
			modules: doc.modules,
			moduleOrder: doc.moduleOrder,
			caseTypes: doc.caseTypes ?? EMPTY_CASE_TYPES,
			forms: doc.forms,
			formOrder: doc.formOrder,
		}),
		[doc],
	);
}
