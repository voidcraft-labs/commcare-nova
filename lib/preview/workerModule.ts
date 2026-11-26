import { workerWording } from "@/lib/doc/localizationWorkspace";
import type { Column } from "@/lib/domain";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import {
	columnWordingRole,
	type GeneratedWordingRole,
	generatedWordingId,
} from "@/lib/domain/generatedWording";
import { menuWithInheritedCaseSettings } from "@/lib/domain/listedForms";
import {
	type LanguageTag,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { projectLocalizedModule } from "@/lib/domain/localizedBlueprintProjection";
import {
	localizeTranslationUnit,
	snapshotTranslationUnits,
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
	const projected = menuWithInheritedCaseSettings(
		doc,
		uuid,
		projectLocalizedModule(doc, language, uuid),
	);
	if (!canonical || !projected) return projected;
	const units = snapshotTranslationUnits(doc);
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
	const word = (owner: string, role: GeneratedWordingRole, original: string) =>
		workerWording(doc, language, generatedWordingId(owner, role), true) ??
		original;
	const mod = structuredClone(projected);
	mod.name = word(uuid, "menuTitle", mod.name);
	if (mod.caseListConfig)
		for (const input of mod.caseListConfig.searchInputs) {
			input.label = word(input.uuid, "promptLabel", input.label);
			if (input.kind === "hidden") continue;
			const source = canonical.caseListConfig?.searchInputs.find(
				(item) => item.uuid === input.uuid,
			);
			if (input.hint !== undefined)
				input.hint = word(input.uuid, "promptHint", input.hint);
			if (input.required) {
				const message =
					source?.kind !== "hidden" &&
					source?.required?.message === undefined &&
					source?.required?.noMessage !== true
						? fallback(
								makeTranslationUnitId("system", "search-required", "default"),
								"searchRequired",
							)
						: input.required.message;
				if (message !== undefined)
					input.required.message = word(input.uuid, "promptRequired", message);
			}
			if (input.validation?.message !== undefined)
				input.validation.message = word(
					input.uuid,
					"promptValidation",
					input.validation.message,
				);
		}
	const search = effectiveCaseSearchConfig(mod);
	const sourceSearch = effectiveCaseSearchConfig(canonical);
	if (search) {
		const title =
			sourceSearch?.searchScreenTitle === undefined
				? fallback(
						makeTranslationUnitId("module", uuid, "search-title"),
						"search",
					)
				: search.searchScreenTitle;
		if (typeof title === "string")
			search.searchScreenTitle = word(uuid, "searchTitle", title);
		if (search.searchScreenSubtitle !== undefined)
			search.searchScreenSubtitle = word(
				uuid,
				"searchDescription",
				search.searchScreenSubtitle,
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

/** A column is projected separately on each screen. Its number and its
 * neighboring columns never participate in the wording identity. */
export function projectWorkerColumn(
	column: Column,
	search: boolean,
	detail: boolean,
	values: ReadonlyMap<string, unknown>,
): Column {
	const role = columnWordingRole(search, detail);
	const wordOf = (base: string, fallback: string) => {
		const value = values.get(generatedWordingId(column.uuid, role, base));
		return typeof value === "string" ? value : fallback;
	};
	const word = (slot: string[], fallback: string) =>
		wordOf(makeTranslationUnitId("column", column.uuid, ...slot), fallback);
	const current = { ...column, header: word(["header"], column.header) };
	if (current.sort?.label !== undefined)
		current.sort = {
			...current.sort,
			label: word(["sort-label"], current.sort.label),
		};
	if (current.kind === "interval") current.text = word(["text"], current.text);
	if (current.kind === "id-mapping")
		current.mapping = current.mapping.map((row) => ({
			...row,
			label: wordOf(
				caseMappingTextUnit(column.uuid, row, "mapping"),
				row.label,
			),
		}));
	return current;
}
