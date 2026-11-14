/**
 * The slices of the document the projection of which screen lists what
 * reads (`lib/domain/menuScreens.ts::MenuScreenSource`), shallow-selected
 * and memoized, so a builder surface that words where a menu's forms show
 * re-renders only when a module, form or case type changes.
 */

"use client";

import { useMemo } from "react";
import type { MenuScreenSource } from "@/lib/domain";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export function useMenuScreenSource(): MenuScreenSource {
	const { modules, moduleOrder, forms, formOrder, caseTypes } =
		useBlueprintDocShallow((doc) => ({
			modules: doc.modules,
			moduleOrder: doc.moduleOrder,
			forms: doc.forms,
			formOrder: doc.formOrder,
			caseTypes: doc.caseTypes,
		}));
	return useMemo(
		() => ({ modules, moduleOrder, forms, formOrder, caseTypes }),
		[modules, moduleOrder, forms, formOrder, caseTypes],
	);
}
