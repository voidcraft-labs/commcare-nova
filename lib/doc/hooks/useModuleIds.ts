/**
 * Hooks over the module and form order arrays.
 *
 * Each hook follows the two-tier subscription pattern: shallow-select the
 * source slices from the store, then memoize the derived array. The
 * memoized result is reference-stable when the underlying data hasn't changed
 * (Immer structural sharing keeps unchanged maps/arrays stable).
 */

"use client";

import { useMemo } from "react";
import type { Uuid } from "@/lib/doc/types";
import type { Form, FormType, Module } from "@/lib/domain";
import { isCaseFirstModule } from "@/lib/domain";
import { useBlueprintDoc, useBlueprintDocShallow } from "./useBlueprintDoc";

/** The raw moduleOrder array — reference-stable via Immer. */
export function useModuleIds(): Uuid[] {
	return useBlueprintDoc((s) => s.moduleOrder);
}

/** Modules in moduleOrder sequence. Memoized. */
export function useOrderedModules(): Module[] {
	const { moduleOrder, modules } = useBlueprintDocShallow((s) => ({
		moduleOrder: s.moduleOrder,
		modules: s.modules,
	}));
	return useMemo(
		() =>
			moduleOrder
				.map((uuid) => modules[uuid])
				.filter((m): m is Module => m !== undefined),
		[moduleOrder, modules],
	);
}

/** Form uuids for a given module, in order. Reference-stable via Immer. */
export function useFormIds(moduleUuid: Uuid): Uuid[] | undefined {
	return useBlueprintDoc((s) => s.formOrder[moduleUuid]);
}

/** Forms for a given module in order. Memoized; empty array for unknown modules. */
export function useOrderedForms(moduleUuid: Uuid): Form[] {
	const { order, forms } = useBlueprintDocShallow((s) => ({
		order: s.formOrder[moduleUuid],
		forms: s.forms,
	}));
	return useMemo(
		() =>
			(order ?? [])
				.map((uuid) => forms[uuid])
				.filter((f): f is Form => f !== undefined),
		[order, forms],
	);
}

/**
 * Whether a module's running-app navigation is case-first (the case list is
 * the module's landing, then a form menu) vs forms-first. See
 * `isCaseFirstModule` — true iff the module has a case type and every form
 * is case-loading (followup/close). `undefined` uuid → false.
 */
export function useIsCaseFirstModule(moduleUuid: Uuid | undefined): boolean {
	const { order, forms, caseType } = useBlueprintDocShallow((s) => ({
		order: moduleUuid ? s.formOrder[moduleUuid] : undefined,
		forms: s.forms,
		caseType: moduleUuid ? s.modules[moduleUuid]?.caseType : undefined,
	}));
	return useMemo(() => {
		const types = (order ?? [])
			.map((uuid) => forms[uuid]?.type)
			.filter((t): t is FormType => t !== undefined);
		return isCaseFirstModule(types, caseType !== undefined);
	}, [order, forms, caseType]);
}

/**
 * The set of module uuids whose navigation is case-first — for surfaces
 * (e.g. the app home) that branch per module without a hook call each.
 * Recomputed only when the module/form maps change.
 */
export function useCaseFirstModuleUuids(): Set<Uuid> {
	const { moduleOrder, modules, formOrder, forms } = useBlueprintDocShallow(
		(s) => ({
			moduleOrder: s.moduleOrder,
			modules: s.modules,
			formOrder: s.formOrder,
			forms: s.forms,
		}),
	);
	return useMemo(() => {
		const caseFirst = new Set<Uuid>();
		for (const moduleUuid of moduleOrder) {
			const types = (formOrder[moduleUuid] ?? [])
				.map((uuid) => forms[uuid]?.type)
				.filter((t): t is FormType => t !== undefined);
			if (
				isCaseFirstModule(types, modules[moduleUuid]?.caseType !== undefined)
			) {
				caseFirst.add(moduleUuid);
			}
		}
		return caseFirst;
	}, [moduleOrder, modules, formOrder, forms]);
}
