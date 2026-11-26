import { v5 as uuidv5 } from "uuid";
import {
	asUuid,
	type BlueprintDoc,
	type Module,
	makeTranslationUnitId,
	translationUnitIdSchema,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import { isExpression } from "@/lib/domain/expression/types";
import { rewriteExpressionSlotValues } from "@/lib/domain/referenceSlots";
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
	const binding = (kind: string, old: Uuid, next: Uuid) => {
		remap.set(old, next);
		prefixes.set(
			makeTranslationUnitId(kind, old),
			makeTranslationUnitId(kind, next),
		);
	};
	binding("module", source.uuid, route.uuid);
	if (source.caseListConfig) {
		const config = structuredClone(source.caseListConfig);
		delete config.selection;
		for (const column of config.columns) {
			const next = asUuid(uuidv5(`column/${column.uuid}`, route.uuid));
			binding("column", column.uuid, next);
			column.uuid = next;
		}
		for (const input of config.searchInputs) {
			const next = asUuid(uuidv5(`search/${input.uuid}`, route.uuid));
			binding("search-input", input.uuid, next);
			input.uuid = next;
		}
		config.listColumnOrder = config.listColumnOrder.map(
			(uuid) => remap.get(uuid) ?? uuid,
		);
		config.detailColumnOrder = config.detailColumnOrder.map(
			(uuid) => remap.get(uuid) ?? uuid,
		);
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
	const units = translationUnitsById({
		...doc,
		modules: { ...doc.modules, [route.uuid]: route },
		moduleOrder: [...doc.moduleOrder, route.uuid],
		formOrder: { ...doc.formOrder, [route.uuid]: [] },
	});
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
				if (units.has(unitId))
					mutations.push({
						kind: "setTranslation",
						language,
						unitId,
						entry: structuredClone(entry),
					});
			}
		}
	}
	return mutations;
}
