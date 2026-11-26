import type { Uuid } from "@/lib/domain/uuid";
// lib/preview/engine/caseListOrder.ts
//
// Preview's copy of a case list's order plan
// (`lib/domain/caseListOrder.ts::caseListOrderPlan`), the one statement of a
// list's fields and order that the HQ JSON and the local suite read too.
// Preview reads it in two places: the Results list's quick filter in the
// browser, which matches every field's text, and the case store's order on
// the server (`caseDataBindingHelpers.ts::buildCaseStoreSortKeys`).
//
// The plan is built with media on: Preview draws an image map's images and
// has no export to leave media out of, and the `mediaOn: true` plan is the
// plan of every production export. It passes no lookup naming, so join texts
// print under `identityLookupWireNaming()`, as the validator's do.

import { caseListOrderOptions } from "@/lib/commcare/suite/case-list/orderPlanOptions";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type CaseListOrderPlan,
	type CaseProperty,
	type Column,
	caseListOrderPlan,
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
	effectiveCaseTypes,
	type LanguageTag,
	type LocalizedValue,
	type Module,
	makeTranslationUnitId,
	printProseTemplate,
	resolveTranslationUnitValue,
	type TranslationUnitId,
} from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import type { CaseListSortChoice } from "../caseListSortMenu";
import type { CaseStoreOrder } from "./caseDataBindingHelpers";

/**
 * The plan of `mod`'s list over the module's effective case type catalog,
 * with `caseListConfig` in place of the stored list where a caller holds a
 * live one.
 */
export function previewCaseListOrderPlan(
	mod: Module,
	doc: BlueprintDoc,
	caseListConfig: CaseListConfig,
): CaseListOrderPlan {
	const caseProperties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	return caseListOrderPlan(
		caseListConfig,
		caseProperties,
		caseListOrderOptions({ ...mod, caseListConfig }, doc, true),
	);
}

/**
 * The text a sort key reads in the language Preview shows: an option's
 * label, from its option's translation unit, and an interval column's text,
 * from the column's `text` unit, as the suite's locale variables read them.
 * A unit the committed document does not hold (a live column not yet
 * committed) reads its stored text.
 */
export interface CaseListOrderLocale {
	calculationText(
		column: Extract<Column, { kind: "calculated" }>,
		piece: { uuid: Uuid; label: string },
	): string;
	mappingLabel(
		column: Extract<Column, { kind: "id-mapping" }>,
		index: number,
	): string;
	/** `caseType` is the type whose catalog holds the property, the list's own
	 *  where absent. */
	optionLabel(property: CaseProperty, index: number, caseType?: string): string;
	intervalText(column: Extract<Column, { kind: "interval" }>): string;
}

export function previewCaseListOrderLocale(
	doc: BlueprintDoc,
	caseType: string,
	language: LanguageTag,
): CaseListOrderLocale {
	const textOf = (value: LocalizedValue): string =>
		typeof value === "string" ? value : printProseTemplate(value, doc);
	const translated = (id: TranslationUnitId, stored: LocalizedValue) => {
		try {
			return textOf(resolveTranslationUnitValue(doc, language, id));
		} catch {
			return textOf(stored);
		}
	};
	return {
		calculationText: (column, piece) =>
			translated(
				makeTranslationUnitId(
					"column",
					column.uuid,
					"calculation-text",
					piece.uuid,
				),
				piece.label,
			),
		mappingLabel: (column, index) => {
			const row = column.mapping[index];
			return row
				? translated(
						caseMappingTextUnit(column.uuid, row, "mapping"),
						row.label,
					)
				: "";
		},
		optionLabel: (property, index, optionType = caseType) => {
			const options = property.options ?? [];
			const option = options[index];
			if (option === undefined) return "";
			return translated(
				casePropertyOptionTranslationUnitId(
					optionType,
					property.name,
					option.value,
					casePropertyOptionOccurrence(options, index),
				),
				option.label,
			);
		},
		intervalText: (column) =>
			translated(
				makeTranslationUnitId("column", column.uuid, "text"),
				column.text,
			),
	};
}

/**
 * The order a case store read of `mod`'s list takes: the plan over the live
 * `caseListConfig`, the case type's catalog, and the text its sort keys read
 * in `language`. The Results list's server read and the app test runtime
 * both read their cases in this order, the Results list with the worker's
 * picks in its Sort by (`choice`) first.
 */
export function previewCaseStoreOrder(
	mod: Module & { readonly caseType: string },
	doc: BlueprintDoc,
	caseListConfig: CaseListConfig,
	language: LanguageTag,
	choice?: CaseListSortChoice,
): CaseStoreOrder {
	const caseTypes = effectiveCaseTypes(doc);
	return {
		plan: previewCaseListOrderPlan(mod, doc, caseListConfig),
		caseProperties:
			caseTypes.find((type) => type.name === mod.caseType)?.properties ?? [],
		caseTypes,
		locale: previewCaseListOrderLocale(doc, mod.caseType, language),
		...(choice !== undefined && { choice }),
	};
}
