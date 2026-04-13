/**
 * Hooks over the module and form order arrays.
 *
 * Each hook follows the two-tier subscription pattern: shallow-select the
 * source slices from the store, then memoize the derived array. The
 * memoized result is reference-stable when the underlying data hasn't changed
 * (Immer structural sharing keeps unchanged maps/arrays stable).
 */

import { useMemo } from "react";
import type { FormEntity, ModuleEntity, Uuid } from "@/lib/doc/types";
import { useBlueprintDoc, useBlueprintDocShallow } from "./useBlueprintDoc";

/** The raw moduleOrder array — reference-stable via Immer. */
export function useModuleIds(): Uuid[] {
	return useBlueprintDoc((s) => s.moduleOrder);
}

/** Modules in moduleOrder sequence. Memoized. */
export function useOrderedModules(): ModuleEntity[] {
	const { moduleOrder, modules } = useBlueprintDocShallow((s) => ({
		moduleOrder: s.moduleOrder,
		modules: s.modules,
	}));
	return useMemo(
		() =>
			moduleOrder
				.map((uuid) => modules[uuid])
				.filter((m): m is ModuleEntity => m !== undefined),
		[moduleOrder, modules],
	);
}

/** Form uuids for a given module, in order. Reference-stable via Immer. */
export function useFormIds(moduleUuid: Uuid): Uuid[] | undefined {
	return useBlueprintDoc((s) => s.formOrder[moduleUuid]);
}

/** Forms for a given module in order. Memoized; empty array for unknown modules. */
export function useOrderedForms(moduleUuid: Uuid): FormEntity[] {
	const { order, forms } = useBlueprintDocShallow((s) => ({
		order: s.formOrder[moduleUuid],
		forms: s.forms,
	}));
	return useMemo(
		() =>
			(order ?? [])
				.map((uuid) => forms[uuid])
				.filter((f): f is FormEntity => f !== undefined),
		[order, forms],
	);
}
