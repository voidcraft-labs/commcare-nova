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
 * empty). The stable sentinel plus the selector's structural equality
 * keep the subscription quiet during normal editing, while permitting a
 * freshly projected localized-value map during an active search.
 *
 * Lives in `lib/doc/hooks/` because — though currently only AppTree
 * consumes it — the hook is a narrow doc-store subscription, not a
 * presentation component. Colocation keeps the "components import
 * hooks, never the raw store" boundary trivially enforceable.
 */

"use client";

import { useContext, useMemo } from "react";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { useBlueprintDocEq } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	collectLocalizedTranslationUnits,
	effectiveAppLocalization,
	type Field,
	type Form,
	type LocalizedValue,
	type Module,
	makeTranslationUnitId,
	resolveAppLanguage,
	type TranslationUnitId,
	type UserProperty,
	type Uuid,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import type { XPathPrintableDoc } from "@/lib/domain/xpath/print";
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
	/** Entity UUID (or `${fieldUuid}__id`) → matched text ranges. */
	matchMap: Map<string, MatchIndices>;
	/** Entity UUIDs that must stay expanded so matches are visible. */
	forceExpand: Set<Uuid>;
	/** Module UUIDs that either match themselves or contain a match. */
	visibleModuleUuids: Set<Uuid>;
	/** Form UUIDs that either match themselves or contain a match. */
	visibleFormUuids: Set<Uuid>;
	/** Fields that match or are ancestors of a matching field. */
	visibleFieldUuids: Set<Uuid>;
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
	/* The two families label projection needs beyond the maps above. A match
	 * index is an offset into the label the row RENDERS, so the walk has to
	 * spell a label exactly as `FieldRow` does or the highlight lands on the
	 * wrong characters. */
	fieldParent: Record<Uuid, Uuid>;
	userProperties: Record<Uuid, UserProperty> | undefined;
	localizedValues: ReadonlyMap<TranslationUnitId, LocalizedValue>;
}

const EMPTY_LOCALIZED_VALUES: ReadonlyMap<TranslationUnitId, LocalizedValue> =
	new Map();

/**
 * Stable empty data for when search is inactive — same reference every
 * call. Prevents the doc subscription from firing on entity-map changes
 * when the user is not searching. Without this, every entity edit triggers
 * the search subscription and AppTree re-renders needlessly.
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
	fieldParent: {} as Record<Uuid, Uuid>,
	userProperties: undefined,
	localizedValues: EMPTY_LOCALIZED_VALUES,
};

function sameLocalizedValues(
	left: ReadonlyMap<TranslationUnitId, LocalizedValue>,
	right: ReadonlyMap<TranslationUnitId, LocalizedValue>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [id, value] of left) {
		if (JSON.stringify(value) !== JSON.stringify(right.get(id))) return false;
	}
	return true;
}

function sameSearchEntityData(
	left: SearchEntityData,
	right: SearchEntityData,
): boolean {
	return (
		left.moduleOrder === right.moduleOrder &&
		left.formOrder === right.formOrder &&
		left.fieldOrder === right.fieldOrder &&
		left.modules === right.modules &&
		left.forms === right.forms &&
		left.fields === right.fields &&
		left.fieldParent === right.fieldParent &&
		left.userProperties === right.userProperties &&
		sameLocalizedValues(left.localizedValues, right.localizedValues)
	);
}

/**
 * Compute search-filter results directly from the normalized entity
 * maps. Returns `null` when the query is empty so callers can cheaply
 * branch between "no filter" and "filter in effect".
 */
export function useSearchFilter(query: string): SearchResult | null {
	const isSearching = query.trim().length > 0;
	const requestedLanguage = useContext(BlueprintAuthoringLanguageContext);

	const {
		moduleOrder,
		formOrder,
		fieldOrder,
		modules,
		forms,
		fields,
		fieldParent,
		userProperties,
		localizedValues,
	} = useBlueprintDocEq(
		(s) =>
			isSearching
				? (() => {
						const localization = effectiveAppLocalization(s.localization);
						const language =
							requestedLanguage === null
								? localization.sourceLanguage
								: resolveAppLanguage(s.localization, requestedLanguage);
						return {
							moduleOrder: s.moduleOrder,
							formOrder: s.formOrder,
							fieldOrder: s.fieldOrder,
							modules: s.modules,
							forms: s.forms,
							fields: s.fields,
							fieldParent: s.fieldParent,
							userProperties: s.userProperties,
							localizedValues: new Map(
								collectLocalizedTranslationUnits(s, language).map((unit) => [
									unit.id,
									unit.effective,
								]),
							),
						};
					})()
				: SEARCH_IDLE,
		sameSearchEntityData,
	);

	return useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return null;

		const matchMap = new Map<string, MatchIndices>();
		const forceExpand = new Set<Uuid>();
		const visibleModuleUuids = new Set<Uuid>();
		const visibleFormUuids = new Set<Uuid>();
		const visibleFieldUuids = new Set<Uuid>();
		const printDoc: XPathPrintableDoc = {
			fields,
			forms,
			fieldOrder,
			fieldParent,
			userProperties,
		};

		// Every retained key is an authored identity. Reorder and reparent can
		// change positions without transferring collapse/highlight state to a
		// different entity.
		for (const moduleId of moduleOrder) {
			const mod = modules[moduleId];
			if (!mod) continue;

			/* Check module name */
			const localizedModuleName = localizedValues.get(
				makeTranslationUnitId("module", moduleId, "name"),
			);
			const moduleName =
				typeof localizedModuleName === "string"
					? localizedModuleName
					: mod.name;
			const modIndices = findMatchIndices(moduleName, q);
			if (modIndices) matchMap.set(moduleId, modIndices);

			const formIds = [...(formOrder[moduleId] ?? [])];
			let moduleHasMatch = !!modIndices;

			for (const formId of formIds) {
				const form = forms[formId];
				if (!form) continue;

				const localizedFormName = localizedValues.get(
					makeTranslationUnitId("form", formId, "name"),
				);
				const formName =
					typeof localizedFormName === "string" ? localizedFormName : form.name;
				const formIndices = findMatchIndices(formName, q);
				if (formIndices) matchMap.set(formId, formIndices);

				/* Check fields recursively */
				let formHasMatch = !!formIndices;
				const checkField = (uuid: Uuid): boolean => {
					const field = fields[uuid];
					if (!field) return false;

					// `label` is absent on the `hidden` kind and optional on
					// `group` (empty/absent label = transparent group), so the
					// `in` narrowing isn't enough — coerce `undefined` to "".
					const localizedFieldLabel = localizedValues.get(
						makeTranslationUnitId("field", field.uuid, "label"),
					);
					const fieldLabel =
						"label" in field && field.label
							? projectProseTemplate(
									typeof localizedFieldLabel === "object" &&
										localizedFieldLabel !== null
										? localizedFieldLabel
										: field.label,
									printDoc,
								).text
							: "";
					const labelIndices = findMatchIndices(fieldLabel, q);
					const idIndices = findMatchIndices(field.id, q);
					if (labelIndices) matchMap.set(uuid, labelIndices);
					if (idIndices) matchMap.set(`${uuid}__id`, idIndices);

					let descendantHasMatch = false;
					for (const childUuid of fieldOrder[uuid] ?? []) {
						descendantHasMatch = checkField(childUuid) || descendantHasMatch;
					}
					const fieldHasMatch =
						labelIndices !== undefined ||
						idIndices !== undefined ||
						descendantHasMatch;
					if (fieldHasMatch) visibleFieldUuids.add(uuid);
					if (descendantHasMatch) forceExpand.add(uuid);
					return fieldHasMatch;
				};
				for (const fieldUuid of fieldOrder[formId] ?? []) {
					formHasMatch = checkField(fieldUuid) || formHasMatch;
				}

				if (formHasMatch) {
					visibleFormUuids.add(formId);
					forceExpand.add(formId);
					moduleHasMatch = true;
				}
			}

			if (moduleHasMatch) {
				visibleModuleUuids.add(moduleId);
				forceExpand.add(moduleId);
			}
		}

		// A matching submenu is rendered inside its root module's list. Retain and
		// expand that ancestor without treating menu parentage as case parentage.
		for (const moduleUuid of [...visibleModuleUuids]) {
			const parentModuleUuid = modules[moduleUuid]?.parentModuleUuid;
			if (parentModuleUuid !== undefined) {
				visibleModuleUuids.add(parentModuleUuid);
				forceExpand.add(parentModuleUuid);
			}
		}

		return {
			matchMap,
			forceExpand,
			visibleModuleUuids,
			visibleFormUuids,
			visibleFieldUuids,
		};
	}, [
		query,
		moduleOrder,
		formOrder,
		fieldOrder,
		modules,
		forms,
		fields,
		fieldParent,
		userProperties,
		localizedValues,
	]);
}
