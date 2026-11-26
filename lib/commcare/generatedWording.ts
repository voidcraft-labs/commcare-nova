/** The generated app-string keys for a document's stable wording identities.
 * Both directions use the same current menu/form placement, including a
 * registration form moved into a hidden wire menu. */

import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	effectiveCaseSearchConfig,
	localizeTranslationUnit,
	makeTranslationUnitId,
	projectedModulePreorder,
	snapshotTranslationUnits,
	type TranslationUnitId,
} from "@/lib/domain";
import {
	type GeneratedWordingRole,
	generatedWordingId,
} from "@/lib/domain/generatedWording";
import { menuWithInheritedCaseSettings } from "@/lib/domain/listedForms";
import { searchInputRequestKey } from "@/lib/domain/modules";
import { ownRecordValue, recordFromEntries } from "@/lib/domain/records";
import type { EmissionPlan } from "./emissionPlan";
import type { ExpandOptions } from "./expander";
import {
	generatedSearchChecks,
	presentedSearchWording,
} from "./generatedSearchWording";
import {
	emptyCaseListTextLocaleId,
	selectTextLocaleId,
} from "./suite/case-list/detailTexts";
import { buildLongDetail } from "./suite/case-list/longDetail";
import { buildShortDetail } from "./suite/case-list/shortDetail";
import { moduleUsesInlineSearch } from "./suite/case-search/inlineSearch";
import {
	groupedSearchWire,
	searchGroupLocaleId,
} from "./suite/case-search/searchGroups";
import { formSubmitLabelLocaleId } from "./suite/formStrings";

/** The two keys CommCare HQ's build writes from the app's name, each with its own wording unit:
 *  every emission writes them, whatever else its projection derives. */
export function appNameWordingKeys(
	authored: BlueprintDoc,
): Map<string, TranslationUnitId> {
	const units = snapshotTranslationUnits(authored);
	const keys = new Map<string, TranslationUnitId>();
	for (const [key, role] of [
		["app.display.name", "appDisplayName"],
		["homescreen.title", "homescreenTitle"],
	] as const) {
		const unit = generatedWordingId("app", role);
		if (units.has(unit)) keys.set(key, unit);
	}
	return keys;
}

/** Only the generator's exact spelling is registered. A prefix match against
 * HQ's broader catalog does not establish that a worker can see an output. */
export function generatedWordingKeys(
	authored: BlueprintDoc,
	plan: EmissionPlan,
	projection?: ExpandOptions,
): Map<string, TranslationUnitId> {
	const keys = new Map<string, TranslationUnitId>();
	const units = snapshotTranslationUnits(authored);
	const register = (key: string, owner: string, role: GeneratedWordingRole) => {
		const unit = generatedWordingId(owner, role);
		const held = units.get(unit);
		if (held && !held.generated?.dormant) keys.set(key, unit);
	};

	register("cchq.case", "app", "caseTitle");
	for (const [key, unit] of appNameWordingKeys(authored)) keys.set(key, unit);
	// The archive and reader are already walking every detail. For an HQ
	// import file, only derive details (and search checks) whose
	// overrides actually need a wire key.
	const detailModules = new Set<string>(),
		searchModules = new Set<string>();
	if (projection && authored.localization) {
		const loc = authored.localization;
		for (const entries of [
			loc.generatedSourceWording,
			...Object.values(loc.translations),
		]) {
			for (const id of Object.keys(entries ?? {})) {
				const unit = units.get(id);
				if (!unit?.generated) continue;
				if (
					unit.owner.kind === "case-list-column" ||
					(unit.owner.kind === "module" &&
						(unit.generated.role === "caseDetailTabTitle" ||
							unit.generated.role === "searchDetailTabTitle" ||
							unit.generated.role === "lookupResultHeading"))
				)
					detailModules.add(unit.owner.moduleUuid);
				if (
					unit.generated.role === "promptValidation" &&
					unit.owner.kind === "search-input"
				)
					searchModules.add(unit.owner.moduleUuid);
			}
		}
	}
	const doc = plan.doc;
	for (const [m, moduleUuid] of projectedModulePreorder(doc).entries()) {
		const mod = menuWithInheritedCaseSettings(doc, moduleUuid);
		if (!mod) throw new Error("The menu or its source is missing.");
		const menu = `m${m}`;
		const hidden = plan.synthetic.get(moduleUuid);
		if (hidden)
			register(`modules.${menu}`, hidden.formUuid, "registrationMenuTitle");
		if (
			projection &&
			detailModules.has(moduleUuid) &&
			!hidden &&
			mod.caseType &&
			mod.caseListConfig
		) {
			const args = {
				module: mod,
				moduleIndex: m,
				doc,
				assets: projection.assets,
				lookupNaming: projection.lookupNaming,
				columnFieldWord: projection.identity?.columnFieldWord,
			};
			const targets =
				effectiveCaseSearchConfig(mod) && !moduleUsesInlineSearch(mod)
					? (["case", "search"] as const)
					: (["case"] as const);
			for (const target of targets)
				for (const build of [buildShortDetail, buildLongDetail]) {
					for (const [key, id] of Object.entries(
						build({ ...args, target }).wordingUnits,
					))
						keys.set(key, id);
				}
		}
		if (!hidden) {
			register(`modules.${menu}`, moduleUuid, "menuTitle");
			register(`modules.${menu}.badge`, moduleUuid, "menuBadgeText");
			register(`case_list_form.${menu}`, moduleUuid, "registerButton");
			register(`case_lists.${menu}`, moduleUuid, "caseListEntry");
			register(selectTextLocaleId(m), moduleUuid, "selectCase");
			register(emptyCaseListTextLocaleId(m), moduleUuid, "emptyList");
			register(`case_search.${menu}`, moduleUuid, "searchButton");
			register(`case_search.${menu}.inputs`, moduleUuid, "searchTitle");
			register(
				`case_search.${menu}.description`,
				moduleUuid,
				"searchDescription",
			);
			const list = mod.caseListConfig;
			if (list?.searchInputGroups && effectiveCaseSearchConfig(mod))
				for (const group of groupedSearchWire(
					list.searchInputs,
					list.searchInputGroups,
				))
					register(
						searchGroupLocaleId(menu, group.key),
						group.uuid,
						"searchGroupHeading",
					);
			const searchChecks =
				projection &&
				searchModules.has(moduleUuid) &&
				effectiveCaseSearchConfig(mod)
					? generatedSearchChecks(authored, moduleUuid, projection.lookupNaming)
					: undefined;
			for (const input of mod.caseListConfig?.searchInputs ?? []) {
				const prefix = `search_property.${menu}.${searchInputRequestKey(input)}`;
				register(prefix, input.uuid, "promptLabel");
				register(`${prefix}.hint`, input.uuid, "promptHint");
				register(`${prefix}.required.text`, input.uuid, "promptRequired");
				if (!projection || searchChecks?.has(input.uuid))
					register(
						`${prefix}.validation.0.text`,
						input.uuid,
						"promptValidation",
					);
			}
		}
		for (const [f, formUuid] of orderedFormUuids(doc, moduleUuid).entries()) {
			register(`forms.${menu}f${f}`, formUuid, "formTitle");
			// Listed routes reuse the source form's locale under their own command IDs.
			if (!hidden)
				register(`forms.${menu}f${f}.badge`, formUuid, "formBadgeText");
			register(formSubmitLabelLocaleId(m, f), formUuid, "submitButton");
		}
	}
	return keys;
}

const prefix = makeTranslationUnitId("generated");
export function hasOutputOverrides(doc: BlueprintDoc): boolean {
	const loc = doc.localization;
	return (
		!!loc &&
		[loc.generatedSourceWording, ...Object.values(loc.translations)].some(
			(entries) =>
				entries && Object.keys(entries).some((id) => id.startsWith(prefix)),
		)
	);
}

export function generatedWordingOverrides(
	doc: BlueprintDoc,
	keys: ReadonlyMap<string, TranslationUnitId>,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
	const localization = effectiveAppLocalization(doc.localization);
	const units = snapshotTranslationUnits(doc);
	const byCode = recordFromEntries<Readonly<Record<string, string>>>([]);
	for (const tag of localization.languageOrder) {
		const values = recordFromEntries<string>([]);
		const entries =
			tag === localization.sourceLanguage
				? localization.generatedSourceWording
				: localization.translations[tag];
		if (entries)
			for (const [key, id] of keys) {
				const entry = ownRecordValue(entries, id);
				if (!entry) continue;
				const unit = units.get(id);
				if (!unit?.generated || unit.generated.dormant) continue;
				const localized = presentedSearchWording(
					doc,
					localizeTranslationUnit(doc, tag, unit),
				);
				// The unit's own wording is written even where it equals the text its base gives, so a
				// reading takes it back as the unit's (`reader/generatedTranslationKeys.ts`).
				if (
					typeof localized.effective === "string" &&
					(localized.status !== "out-of-date" || !!entry.workerFallback) &&
					localized.effective !== ""
				)
					values[key] = localized.effective;
			}
		byCode[localization.wireCodes[tag]] = values;
	}
	return byCode;
}
