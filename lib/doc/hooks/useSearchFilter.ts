/**
 * Search-filter hook for the AppTree sidebar.
 *
 * Walks the blueprint entity maps directly — no assembled tree data —
 * and produces the sets + match-index map that the row components use to
 * decide what to render, where to highlight, and which sections to
 * force-expand.
 *
 * The selector switches between live entity data (when the user is
 * typing) and a stable `SEARCH_IDLE` reference (when the query is
 * empty). The stable sentinel lets `useBlueprintDocShallow` skip the
 * subscription entirely during normal editing — without it, every
 * blueprint mutation would invalidate six entity-map keys and force
 * AppTree to re-render.
 *
 * Lives in `lib/doc/hooks/` because — though currently only AppTree
 * consumes it — the hook is a narrow doc-store subscription, not a
 * presentation component. Colocation keeps the "components import
 * hooks, never the raw store" boundary trivially enforceable.
 */

"use client";

import { useMemo } from "react";
import { type FieldPath, fpath } from "@/lib/doc/fieldPath";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Field, Form, Module, Uuid } from "@/lib/domain";
import type { MatchIndices } from "@/lib/filterTree";

/**
 * Locate the substring-match range for a fuzzy filter. Returns a
 * single `[start, end]` pair — the search is a plain case-insensitive
 * `indexOf`, so there is at most one hit per text. `undefined` means
 * no match. Private to this module: only the search walk below ever
 * produces `MatchIndices`; the row renderers consume them pre-computed
 * via the `matchMap` on `SearchResult`.
 */
function findMatchIndices(
	text: string,
	query: string,
): MatchIndices | undefined {
	const lower = text.toLowerCase();
	const idx = lower.indexOf(query);
	if (idx === -1) return undefined;
	return [[idx, idx + query.length]];
}

/**
 * Output of `useSearchFilter`. Every field is pre-computed once per
 * query so the row components can hit O(1) lookups during render.
 */
export interface SearchResult {
	/** Field-path → highlight ranges for matched labels / names. */
	matchMap: Map<string, MatchIndices>;
	/** Collapse-keys that must stay expanded so matches are visible. */
	forceExpand: Set<string>;
	/** Module indices that either match themselves or contain a match. */
	visibleModuleIndices: Set<number>;
	/** Form UUIDs that either match themselves or contain a match. */
	visibleFormIds: Set<string>;
	/** Field UUIDs whose label OR id matched the query. */
	visibleFieldUuids: Set<string>;
}

/**
 * Shape returned by the search entity selector. Named so the
 * `SEARCH_IDLE` sentinel and the live selector can share one contract.
 */
interface SearchEntityData {
	moduleOrder: Uuid[];
	formOrder: Record<Uuid, Uuid[]>;
	fieldOrder: Record<Uuid, Uuid[]>;
	modules: Record<Uuid, Module>;
	forms: Record<Uuid, Form>;
	fields: Record<Uuid, Field>;
}

/**
 * Stable empty data for when search is inactive — same reference every
 * call. Prevents `useBlueprintDocShallow` from firing on entity-map
 * changes when the user is not searching. Without this, every entity
 * edit triggers the search subscription (six keys changed) and AppTree
 * re-renders needlessly.
 *
 * Exported so tests can assert reference stability of the idle path.
 */
export const SEARCH_IDLE: SearchEntityData = {
	moduleOrder: [],
	formOrder: {} as Record<Uuid, Uuid[]>,
	fieldOrder: {} as Record<Uuid, Uuid[]>,
	modules: {} as Record<Uuid, Module>,
	forms: {} as Record<Uuid, Form>,
	fields: {} as Record<Uuid, Field>,
};

/**
 * Compute search-filter results directly from the normalized entity
 * maps. Returns `null` when the query is empty so callers can cheaply
 * branch between "no filter" and "filter in effect".
 */
export function useSearchFilter(query: string): SearchResult | null {
	const isSearching = query.trim().length > 0;

	const { moduleOrder, formOrder, fieldOrder, modules, forms, fields } =
		useBlueprintDocShallow((s) =>
			isSearching
				? {
						moduleOrder: s.moduleOrder,
						formOrder: s.formOrder,
						fieldOrder: s.fieldOrder,
						modules: s.modules,
						forms: s.forms,
						fields: s.fields,
					}
				: SEARCH_IDLE,
		);

	return useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return null;

		const matchMap = new Map<string, MatchIndices>();
		const forceExpand = new Set<string>();
		const visibleModuleIndices = new Set<number>();
		const visibleFormIds = new Set<string>();
		const visibleFieldUuids = new Set<string>();

		for (let mIdx = 0; mIdx < moduleOrder.length; mIdx++) {
			const moduleId = moduleOrder[mIdx];
			const mod = modules[moduleId];
			if (!mod) continue;

			/* Check module name */
			const moduleKey = `m${mIdx}`;
			const modIndices = findMatchIndices(mod.name, q);
			if (modIndices) matchMap.set(moduleKey, modIndices);

			const formIds = formOrder[moduleId] ?? [];
			let moduleHasMatch = !!modIndices;

			for (let fIdx = 0; fIdx < formIds.length; fIdx++) {
				const formId = formIds[fIdx];
				const form = forms[formId];
				if (!form) continue;

				const formKey = `f${mIdx}_${fIdx}`;
				const formIndices = findMatchIndices(form.name, q);
				if (formIndices) matchMap.set(formKey, formIndices);

				/* Check fields recursively */
				let formHasMatch = !!formIndices;
				const checkFields = (parentId: Uuid, parentPath?: FieldPath) => {
					const uuids = fieldOrder[parentId] ?? [];
					for (const uuid of uuids) {
						const field = fields[uuid];
						if (!field) continue;
						const fieldPath = fpath(field.id, parentPath);

						// `label` is absent on the `hidden` kind — guard before reading.
						const fieldLabel = "label" in field ? field.label : "";
						const labelIndices = findMatchIndices(fieldLabel, q);
						const idIndices = findMatchIndices(field.id, q);

						if (labelIndices) matchMap.set(fieldPath, labelIndices);
						if (idIndices) matchMap.set(`${fieldPath}__id`, idIndices);

						if (labelIndices || idIndices) {
							visibleFieldUuids.add(uuid);
							formHasMatch = true;
							/* Force-expand parent groups */
							if (parentPath) forceExpand.add(parentPath);
						}

						/* Recurse into children */
						checkFields(uuid, fieldPath);
					}
				};
				checkFields(formId);

				if (formHasMatch) {
					visibleFormIds.add(formId);
					forceExpand.add(formKey);
					moduleHasMatch = true;
				}
			}

			if (moduleHasMatch) {
				visibleModuleIndices.add(mIdx);
				forceExpand.add(moduleKey);
			}
		}

		return {
			matchMap,
			forceExpand,
			visibleModuleIndices,
			visibleFormIds,
			visibleFieldUuids,
		};
	}, [query, moduleOrder, formOrder, fieldOrder, modules, forms, fields]);
}
