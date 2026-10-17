/**
 * The order plan of the list Results shows, from the doc store's module and
 * document, over the live list the screen renders. The quick filter reads it
 * for the fields a row is matched by: a device's search matches every field's
 * text, hidden fields and carriers included (commcare-core
 * `util/EntitySortUtil.sortEntities`).
 */

"use client";

import { useMemo } from "react";
import {
	useBlueprintDoc,
	useBlueprintDocApi,
} from "@/lib/doc/hooks/useBlueprintDoc";
import type { CaseListConfig, CaseListOrderPlan } from "@/lib/domain";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import { previewCaseListOrderPlan } from "@/lib/preview/engine/caseListOrder";

export function useCaseListOrderPlan(
	moduleUuid: string | undefined,
	config: CaseListConfig | undefined,
): CaseListOrderPlan | undefined {
	const api = useBlueprintDocApi();
	const mod = useBlueprintDoc((s) =>
		moduleUuid === undefined ? undefined : s.modules[moduleUuid],
	);
	// The plan reads the case-type catalog for data types and options, so a
	// catalog edit derives a new plan.
	const caseTypes = useBlueprintDoc((s) => s.caseTypes);
	return useMemo(() => {
		if (mod === undefined || config === undefined) return undefined;
		const doc = { ...pickBlueprintDoc(api.getState()), caseTypes };
		return previewCaseListOrderPlan(mod, doc, config);
	}, [api, mod, caseTypes, config]);
}
