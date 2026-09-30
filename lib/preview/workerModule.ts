import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Uuid,
} from "@/lib/domain";
import {
	type LanguageTag,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { projectLocalizedModule } from "@/lib/domain/localizedBlueprintProjection";
import {
	localizeTranslationUnit,
	translationUnitsById,
} from "@/lib/domain/translationUnits";
import { type RuntimeMessage, runtimeMessage } from "./runtimeMessages";

/** Authored copy wins; platform defaults use the same catalog as form controls.
 * The canonical document stays untouched so translation fingerprints remain valid. */
export function projectWorkerModule(
	doc: BlueprintDoc,
	language: LanguageTag,
	uuid: Uuid,
) {
	const canonical = doc.modules[uuid];
	const projected = projectLocalizedModule(doc, language, uuid);
	if (!canonical || !projected) return projected;
	const units = translationUnitsById(doc);
	const fallback = (id: string, key: RuntimeMessage) => {
		const unit = units.get(id);
		const localized = unit && localizeTranslationUnit(doc, language, unit);
		return localized?.explicit &&
			!(
				localized.explicit.origin === "copied" &&
				localized.effective === unit?.source
			) &&
			(localized.status === "ready" || localized.status === "needs-review") &&
			typeof localized.effective === "string"
			? localized.effective
			: runtimeMessage(language, key);
	};
	const mod = structuredClone(projected);
	if (mod.caseListConfig)
		mod.caseListConfig.searchInputs = mod.caseListConfig.searchInputs.map(
			(input) => {
				const source = canonical.caseListConfig?.searchInputs.find(
					(item) => item.uuid === input.uuid,
				);
				return input.kind !== "hidden" &&
					input.required &&
					source?.kind !== "hidden" &&
					source?.required?.message === undefined
					? {
							...input,
							required: {
								...input.required,
								message: fallback(
									makeTranslationUnitId("system", "search-required", "default"),
									"searchRequired",
								),
							},
						}
					: input;
			},
		);
	const search = effectiveCaseSearchConfig(mod);
	const sourceSearch = effectiveCaseSearchConfig(canonical);
	if (search) {
		if (sourceSearch?.searchButtonLabel === undefined)
			search.searchButtonLabel = fallback(
				makeTranslationUnitId("module", uuid, "search-button"),
				"search",
			);
		if (sourceSearch?.searchScreenTitle === undefined)
			search.searchScreenTitle = fallback(
				makeTranslationUnitId("module", uuid, "search-title"),
				"search",
			);
		mod.caseSearchConfig = search;
	}
	return mod;
}
