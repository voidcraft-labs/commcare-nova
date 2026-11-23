import { workerWording } from "@/lib/doc/localizationWorkspace";
import type { Column } from "@/lib/domain";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Uuid,
} from "@/lib/domain";
import {
	columnWordingRole,
	type GeneratedWordingRole,
	generatedWordingId,
} from "@/lib/domain/generatedWording";
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
	const projected = projectLocalizedModule(doc, language, uuid);
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
					source?.kind !== "hidden" && source?.required?.message === undefined
						? fallback(
								makeTranslationUnitId("system", "search-required", "default"),
								"searchRequired",
							)
						: input.required.message;
				if (message !== undefined)
					input.required.message = word(input.uuid, "promptRequired", message);
			}
			if (input.validation)
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

/** A column is projected separately on each screen. Its number and its
 * neighboring columns never participate in the wording identity. */
export function projectWorkerColumn(
	column: Column,
	search: boolean,
	detail: boolean,
	values: ReadonlyMap<string, unknown>,
): Column {
	const role = columnWordingRole(search, detail);
	const word = (slot: string[], fallback: string) => {
		const value = values.get(
			generatedWordingId(
				column.uuid,
				role,
				makeTranslationUnitId("column", column.uuid, ...slot),
			),
		);
		return typeof value === "string" ? value : fallback;
	};
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
			label: word(["mapping", row.value], row.label),
		}));
	return current;
}
