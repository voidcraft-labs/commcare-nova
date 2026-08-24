/**
 * Hooks over the module and form order arrays.
 *
 * Each hook follows the two-tier subscription pattern: shallow-select the
 * source slices from the store, then memoize the derived array. The
 * memoized result is reference-stable when the underlying data hasn't changed
 * (Immer structural sharing keeps unchanged maps/arrays stable).
 */

"use client";

import { useContext, useMemo } from "react";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { sameSequenceByIdentity } from "@/lib/doc/sequenceEquality";
import type { Uuid } from "@/lib/doc/types";
import {
	childModuleUuids,
	type Form,
	type FormType,
	isCaseFirstModule,
	type Module,
	moduleIsBareCaseListDestination,
	moduleSiblingUuids,
	projectLocalizedForm,
	projectLocalizedModule,
	resolveAppLanguage,
} from "@/lib/domain";
import {
	useBlueprintDoc,
	useBlueprintDocEq,
	useBlueprintDocShallow,
} from "./useBlueprintDoc";

function sameEntitySequence<T>(
	left: readonly T[],
	right: readonly T[],
): boolean {
	return (
		sameSequenceByIdentity(left, right) ||
		(left.length === right.length &&
			left.every(
				(entity, index) =>
					JSON.stringify(entity) === JSON.stringify(right[index]),
			))
	);
}

/** Module UUIDs in `moduleOrder` sequence. Reference-stable while that sequence
 * is unchanged. */
export function useModuleIds(): Uuid[] {
	return useBlueprintDocEq((s) => [...s.moduleOrder], sameSequenceByIdentity);
}

export interface ModuleMenuHierarchy {
	readonly rootModuleUuids: readonly Uuid[];
	readonly childModuleUuidsByRoot: Readonly<Record<Uuid, readonly Uuid[]>>;
}

function sameModuleMenuHierarchy(
	left: ModuleMenuHierarchy,
	right: ModuleMenuHierarchy,
): boolean {
	if (!sameSequenceByIdentity(left.rootModuleUuids, right.rootModuleUuids)) {
		return false;
	}
	return left.rootModuleUuids.every((rootUuid) =>
		sameSequenceByIdentity(
			left.childModuleUuidsByRoot[rootUuid] ?? [],
			right.childModuleUuidsByRoot[rootUuid] ?? [],
		),
	);
}

/** Root groups and their one allowed child tier, derived from the canonical
 * domain hierarchy projection and stable across unrelated document edits. */
export function useModuleMenuHierarchy(): ModuleMenuHierarchy {
	return useBlueprintDocEq((doc) => {
		const rootModuleUuids = moduleSiblingUuids(doc, null);
		return {
			rootModuleUuids,
			childModuleUuidsByRoot: Object.fromEntries(
				rootModuleUuids.map((rootUuid) => [
					rootUuid,
					childModuleUuids(doc, rootUuid),
				]),
			) as Record<Uuid, readonly Uuid[]>,
		};
	}, sameModuleMenuHierarchy);
}

/** Modules in display sequence. Stable while their selected-language
 * projections and sequence are unchanged. */
export function useOrderedModules(): Module[] {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return useBlueprintDocEq((s) => {
		const snapshotLanguage =
			language === null ? null : resolveAppLanguage(s.localization, language);
		return [...s.moduleOrder]
			.map((uuid) =>
				snapshotLanguage === null
					? s.modules[uuid]
					: projectLocalizedModule(s, snapshotLanguage, uuid),
			)
			.filter((m): m is Module => m !== undefined);
	}, sameEntitySequence);
}

/** Form uuids for a given module, in DISPLAY order. Reference-stable when the
 *  uuid sequence is unchanged; `undefined` for an unknown module. */
export function useFormIds(moduleUuid: Uuid): Uuid[] | undefined {
	return useBlueprintDocEq(
		(s) => {
			const order = s.formOrder[moduleUuid];
			return order === undefined ? undefined : [...order];
		},
		(a, b) =>
			a === b ||
			(a !== undefined && b !== undefined && sameSequenceByIdentity(a, b)),
	);
}

/** Forms for a given module in display sequence. Stable while their
 * selected-language projections and sequence are unchanged; empty while no
 * module is selected or for an unknown module. */
export function useOrderedForms(moduleUuid: Uuid | undefined): Form[] {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return useBlueprintDocEq((s) => {
		const snapshotLanguage =
			language === null ? null : resolveAppLanguage(s.localization, language);
		return (moduleUuid === undefined ? [] : (s.formOrder[moduleUuid] ?? []))
			.map((uuid) =>
				snapshotLanguage === null
					? s.forms[uuid]
					: projectLocalizedForm(s, snapshotLanguage, uuid),
			)
			.filter((f): f is Form => f !== undefined);
	}, sameEntitySequence);
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
 * `caseListOnly` viewer with a case type, no forms, and no child menus. Such a
 * module has no menu screen in any mode, so it lands on its case list
 * everywhere (tree row, home tile, breadcrumb, module-URL redirect). A
 * case-list-only module that owns children instead lands on its module screen
 * so those destinations remain reachable. `undefined` uuid → false. Sibling to
 * `useIsCaseFirstModule`; both answer "does entering this module land on the
 * case list rather than a form menu?" (case-first only in the running app;
 * a bare case list in every mode).
 */
export function useIsBareCaseListModule(moduleUuid: Uuid | undefined): boolean {
	return useBlueprintDoc((doc) =>
		moduleUuid ? moduleIsBareCaseListDestination(doc, moduleUuid) : false,
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
