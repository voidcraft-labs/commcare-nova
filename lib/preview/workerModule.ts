import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Module,
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
		if (sourceSearch?.searchScreenTitle === undefined)
			search.searchScreenTitle = fallback(
				makeTranslationUnitId("module", uuid, "search-title"),
				"search",
			);
		mod.caseSearchConfig = search;
	}
	return mod;
}

/** The advanced menu's list item has an unfiltered datum. A manual form
 * choice uses the target list's filter and exactly one selection. Both use
 * the short detail, including its standalone Search and Register actions. */
export type WorkerListPurpose = "form-selection" | "advanced-list-item";
export function workerListFor(
	module: Module | undefined,
	purpose?: WorkerListPurpose,
): Module | undefined {
	if (!module || !purpose) return module;
	const search = effectiveCaseSearchConfig(module);
	const standalone = search !== undefined && !search.formsReadSearch;
	return {
		...module,
		caseSearchConfig: standalone
			? search
			: purpose === "form-selection" &&
					module.caseSearchConfig?.excludedOwnerIds
				? {
						searchActionEnabled: false,
						excludedOwnerIds: module.caseSearchConfig.excludedOwnerIds,
					}
				: undefined,
		caseListConfig: module.caseListConfig && {
			...module.caseListConfig,
			searchInputs: standalone ? module.caseListConfig.searchInputs : [],
			...(purpose === "form-selection"
				? { selection: undefined }
				: { filter: undefined }),
		},
	};
}

/** The advanced case list item's own browse datum has no owner filter.
 * Its separate Search action still submits the owner's expression with
 * the remote query, as do the other screens that run that search. */
export function workerListExcludedOwners(
	module: Module | undefined,
	purpose: WorkerListPurpose | undefined,
	searchResults: boolean,
) {
	return purpose === "advanced-list-item" && !searchResults
		? undefined
		: module?.caseSearchConfig?.excludedOwnerIds;
}

/** The list read validates its configuration against its owning module.
 * Carry its real physical datum's configuration on both sides of that
 * check, including filters that a standalone menu item does not apply. */
export function workerListDocument(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	purpose?: WorkerListPurpose,
): BlueprintDoc {
	if (!purpose) return doc;
	const module = workerListFor(doc.modules[moduleUuid], purpose);
	return module
		? { ...doc, modules: { ...doc.modules, [moduleUuid]: module } }
		: doc;
}
