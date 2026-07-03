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
import { bySortKey, sameSequenceByIdentity } from "@/lib/doc/order/compare";
import type { Uuid } from "@/lib/doc/types";
import type { Form, FormType, Module } from "@/lib/domain";
import { isCaseFirstModule } from "@/lib/domain";
import {
	useBlueprintDoc,
	useBlueprintDocEq,
	useBlueprintDocShallow,
} from "./useBlueprintDoc";

/**
 * Module uuids in DISPLAY order (`sort-by-(order, uuid)`, not `moduleOrder`
 * array position — a reorder leaves the array untouched and only changes a
 * module's `order`). Reference-stable when the sorted uuid sequence is
 * unchanged.
 */
export function useModuleIds(): Uuid[] {
	return useBlueprintDocEq(
		(s) =>
			[...s.moduleOrder].sort((a, b) =>
				bySortKey(s.modules[a] ?? {}, s.modules[b] ?? {}),
			),
		sameSequenceByIdentity,
	);
}

/** Modules in DISPLAY sequence. Reference-stable when the sequence (by entity
 *  reference) is unchanged. */
export function useOrderedModules(): Module[] {
	return useBlueprintDocEq(
		(s) =>
			[...s.moduleOrder]
				.map((uuid) => s.modules[uuid])
				.filter((m): m is Module => m !== undefined)
				.sort(bySortKey),
		sameSequenceByIdentity,
	);
}

/** Form uuids for a given module, in DISPLAY order. Reference-stable when the
 *  uuid sequence is unchanged; `undefined` for an unknown module. */
export function useFormIds(moduleUuid: Uuid): Uuid[] | undefined {
	return useBlueprintDocEq(
		(s) => {
			const order = s.formOrder[moduleUuid];
			return order === undefined
				? undefined
				: [...order].sort((a, b) =>
						bySortKey(s.forms[a] ?? {}, s.forms[b] ?? {}),
					);
		},
		(a, b) =>
			a === b ||
			(a !== undefined && b !== undefined && sameSequenceByIdentity(a, b)),
	);
}

/** Forms for a given module in DISPLAY sequence. Reference-stable when the
 *  sequence (by entity reference) is unchanged; empty array for unknown
 *  modules. */
export function useOrderedForms(moduleUuid: Uuid): Form[] {
	return useBlueprintDocEq(
		(s) =>
			(s.formOrder[moduleUuid] ?? [])
				.map((uuid) => s.forms[uuid])
				.filter((f): f is Form => f !== undefined)
				.sort(bySortKey),
		sameSequenceByIdentity,
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
 * Whether a module is a bare case list — CommCare's "case list menu item": a
 * `caseListOnly` viewer with a case type and no forms. Such a module has no
 * form menu in any mode, so it lands on its case list everywhere (tree row,
 * home tile, breadcrumb, module-URL redirect). `caseListOnly` is the
 * gate-maintained truth — it holds iff the module has a case type and zero
 * forms — so a one-flag read suffices. `undefined` uuid → false. Sibling to
 * `useIsCaseFirstModule`; both answer "does entering this module land on the
 * case list rather than a form menu?" (case-first only in the running app;
 * a bare case list in every mode).
 */
export function useIsBareCaseListModule(moduleUuid: Uuid | undefined): boolean {
	return useBlueprintDoc((s) =>
		moduleUuid ? s.modules[moduleUuid]?.caseListOnly === true : false,
	);
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
