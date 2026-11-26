import { v5 as uuidv5 } from "uuid";
import {
	asUuid,
	type BlueprintDoc,
	type Module,
	makeTranslationUnitId,
	NAMED_TILE_SLOTS,
	translationUnitIdSchema,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import { isExpression } from "@/lib/domain/expression/types";
import { translationSourceFingerprintsEqual } from "@/lib/domain/localization";
import { rewriteExpressionSlotValues } from "@/lib/domain/referenceSlots";
import { wordingSourceUnit } from "./localizationWorkspace";
import type { Mutation } from "./types";

export function sharedChildUuid(parent: Uuid, source: Uuid): Uuid {
	return asUuid(uuidv5(`source-menu/${source}`, parent));
}

/** A child starts from its source's own controls. The new route has independent
 * columns, search fields and wording from birth. Its forms still belong to the source. */
export function initialSharedChild(
	doc: BlueprintDoc,
	source: Module,
	route: Module,
): Mutation[] {
	const remap = new Map<Uuid, Uuid>();
	const prefixes = new Map<string, string>();
	const binding = (kind: string, old: Uuid, next: Uuid) =>
		prefixes.set(
			makeTranslationUnitId(kind, old),
			makeTranslationUnitId(kind, next),
		);
	const mint = (kind: string, old: Uuid) => {
		const next = asUuid(uuidv5(`${kind}/${old}`, route.uuid));
		remap.set(old, next);
		return next;
	};
	const mapped = (uuid: Uuid) => remap.get(uuid) ?? uuid;

	binding("module", source.uuid, route.uuid);
	if (source.caseListConfig) {
		const config = structuredClone(source.caseListConfig);
		delete config.selection;
		for (const column of config.columns) {
			const old = column.uuid;
			column.uuid = mint("column", old);
			binding("column", old, column.uuid);
			if (column.kind === "calculated") {
				for (const item of column.texts ?? []) {
					const before = item.uuid;
					item.uuid = mint("calculation-text", before);
					prefixes.set(
						makeTranslationUnitId("column", old, "calculation-text", before),
						makeTranslationUnitId(
							"column",
							column.uuid,
							"calculation-text",
							item.uuid,
						),
					);
				}
			}
			if (column.kind === "image-map" || column.kind === "id-mapping") {
				for (const row of column.mapping) {
					if (row.uuid) row.uuid = mint("mapping-row", row.uuid);
				}
			}
		}
		for (const input of config.searchInputs) {
			const old = input.uuid;
			input.uuid = mint("search", old);
			binding("search-input", old, input.uuid);
		}
		for (const rule of config.calculatedSorts ?? []) {
			const old = rule.uuid;
			rule.uuid = mint("case-sort", old);
			binding("case-sort", old, rule.uuid);
		}
		for (const tab of config.detailTabs ?? []) {
			const old = tab.uuid;
			tab.uuid = mint("detail-tab", old);
			binding("detail-tab", old, tab.uuid);
			tab.startColumnUuid = mapped(tab.startColumnUuid);
			if (tab.orderFields) tab.orderFields = tab.orderFields.map(mapped);
		}
		for (const filter of config.searchFilters ?? [])
			filter.uuid = mint("search-filter", filter.uuid);
		config.listColumnOrder = config.listColumnOrder.map(mapped);
		config.detailColumnOrder = config.detailColumnOrder.map(mapped);
		if (config.detailTile)
			config.detailTile.cells = Object.fromEntries(
				Object.entries(config.detailTile.cells).map(([uuid, cell]) => [
					mapped(asUuid(uuid)),
					cell,
				]),
			);
		const slots = config.tile?.namedSlots;
		if (slots)
			for (const slot of NAMED_TILE_SLOTS) slots[slot] = mapped(slots[slot]);
		route.caseListConfig = config;
	}
	if (source.caseSearchConfig)
		route.caseSearchConfig = structuredClone(source.caseSearchConfig);
	if (source.parentCaseModuleUuid)
		route.parentCaseModuleUuid = source.parentCaseModuleUuid;
	if (source.displayCondition)
		route.displayCondition = structuredClone(source.displayCondition);
	if (source.hiddenFromMenu) route.hiddenFromMenu = true;
	if (source.formsInMenuAbove) route.formsInMenuAbove = true;
	if (source.icon) route.icon = source.icon;
	if (source.audioLabel) route.audioLabel = source.audioLabel;
	if (source.mediaByLanguage)
		route.mediaByLanguage = structuredClone(source.mediaByLanguage);
	if (source.mediaByFormerCode)
		route.mediaByFormerCode = structuredClone(source.mediaByFormerCode);
	if (source.badge) route.badge = structuredClone(source.badge);
	if (source.caseListRegistrationForm?.kind === "always")
		route.caseListRegistrationForm = structuredClone(
			source.caseListRegistrationForm,
		);
	rewriteExpressionSlotValues(
		{ fields: {}, forms: {}, modules: { [route.uuid]: route } },
		{ entity: "module", uuid: route.uuid },
		(value) => {
			if (!isExpression(value)) return value;
			return mapExpressionAst(value, {
				mapExpression: (expression) =>
					expression.kind === "case-text" && remap.has(expression.textUuid)
						? { ...expression, textUuid: mapped(expression.textUuid) }
						: undefined,
				mapTerm: (term) => {
					if (term.kind === "input") {
						const next = remap.get(term.searchInputUuid);
						if (next) return { ...term, searchInputUuid: next };
					}
					if (
						term.kind === "session-datum" &&
						term.datum.kind === "selected-case" &&
						term.datum.module === source.uuid
					)
						return { ...term, datum: { ...term.datum, module: route.uuid } };
					return term;
				},
			});
		},
	);
	const mutations: Mutation[] = [];
	const localizations = doc.localization?.translations;
	if (!localizations || !Object.keys(localizations).length) return mutations;
	// A legacy rule can derive its row identity from its predicate. Compute
	// its translated wording address after the copied predicate is rewritten.
	for (const [index, column] of (
		source.caseListConfig?.columns ?? []
	).entries()) {
		const copied = route.caseListConfig?.columns[index];
		if (
			(column.kind !== "image-map" && column.kind !== "id-mapping") ||
			copied?.kind !== column.kind
		)
			continue;
		const role = column.kind === "image-map" ? "image-description" : "mapping";
		for (const [position, row] of column.mapping.entries())
			prefixes.set(
				caseMappingTextUnit(column.uuid, row, role),
				caseMappingTextUnit(copied.uuid, copied.mapping[position], role),
			);
	}
	const copied = {
		...doc,
		modules: { ...doc.modules, [route.uuid]: route },
		moduleOrder: [...doc.moduleOrder, route.uuid],
		formOrder: { ...doc.formOrder, [route.uuid]: [] },
	};
	const units = translationUnitsById(copied);
	for (const language of doc.localization?.languageOrder ?? []) {
		for (const [unit, entry] of Object.entries(
			doc.localization?.translations?.[language] ?? {},
		)) {
			for (const [before, after] of prefixes) {
				if (!unit.startsWith(before)) continue;
				// A route cannot have an independent case-list menu item.
				if (
					unit.startsWith(
						makeTranslationUnitId(
							"module",
							source.uuid,
							"case-list-menu-item-label",
						),
					)
				)
					continue;
				const unitId = translationUnitIdSchema.parse(
					after + unit.slice(before.length),
				);
				const raw = units.get(unitId);
				if (!raw) continue;
				const { sourceFingerprint } = wordingSourceUnit(copied, raw);
				// Keep a former draft and its worker fallback as stored. The
				// copy can restore that history only on its inspected source
				// and before any translation of the new unit has been saved.
				const restoring =
					entry.workerFallback !== undefined ||
					!translationSourceFingerprintsEqual(
						entry.sourceFingerprint,
						sourceFingerprint,
					);
				mutations.push({
					kind: "setTranslation",
					language,
					unitId,
					entry: structuredClone(entry),
					...(restoring && {
						restoreAgainst: { sourceFingerprint, previous: null },
					}),
				});
				break;
			}
		}
	}
	return mutations;
}
