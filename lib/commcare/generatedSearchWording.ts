/** Search checks are a derived output. Its inputs can depend on a rule
 * elsewhere in the menu. The same generator supplies exact defaults to
 * editors, Preview, app strings and the installation archive. */
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedTranslationUnit,
	localizeTranslationUnit,
	snapshotTranslationUnits,
	storedTranslationValue,
	type TranslationUnit,
	translationSourceFingerprint,
	type Uuid,
} from "@/lib/domain";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import {
	identityLookupWireNaming,
	type LookupWireNaming,
} from "./lookup/naming";
import { composeModuleXPathQueryEmission } from "./suite/case-search/moduleXPathQuery";
import {
	promptCheckText,
	type SearchPromptText,
} from "./suite/case-search/searchPrompts";
import { buildRuntimeCsqlPromptValidations } from "./suite/case-search/xpathQuery";

const cache = new WeakMap<
	BlueprintDoc,
	Map<Uuid, ReadonlyMap<Uuid, SearchPromptText>>
>();
export function generatedSearchChecks(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	lookupNaming?: LookupWireNaming,
): ReadonlyMap<Uuid, SearchPromptText> {
	const menus = cache.get(doc) ?? new Map();
	const cached = !lookupNaming && menus.get(moduleUuid);
	if (cached) return cached;
	const values = new Map<Uuid, SearchPromptText>();
	const inputs = doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
	if (inputs.length) {
		const runtime = buildRuntimeCsqlPromptValidations(
			composeModuleXPathQueryEmission(doc, moduleUuid, {
				lookupNaming: lookupNaming ?? identityLookupWireNaming(),
			}),
		);
		for (const input of inputs) {
			const text = promptCheckText(input, runtime.get(input.name));
			if (text) values.set(input.uuid, text);
		}
	}
	if (!lookupNaming) {
		menus.set(moduleUuid, values);
		cache.set(doc, menus);
	}
	return values;
}

/** The native query compiler chooses which guard shares a field's one
 * message. Use those exact wording owners to resolve its default in a locale. */
function checkDefault(
	doc: BlueprintDoc,
	unit: TranslationUnit,
	language: LanguageTag,
): string {
	if (unit.owner.kind !== "search-input") return "";
	const check = generatedSearchChecks(doc, unit.owner.moduleUuid).get(
		unit.owner.searchInputUuid,
	);
	if (!check) return "";
	const units = snapshotTranslationUnits(doc);
	const ids = typeof check.source === "string" ? [check.source] : check.source;
	return ids
		.map((id) => {
			const input = units.get(id);
			return input
				? localizeTranslationUnit(doc, language, input).effective
				: "";
		})
		.join(" ");
}

/** The source against which an author or translator read a unit. Every
 * ordinary unit already has this fingerprint. One generated check can only
 * be resolved after the query compiler has identified its component parts. */
export function wordingSourceUnit(
	doc: BlueprintDoc,
	unit: TranslationUnit,
): TranslationUnit {
	if (unit.generated?.role !== "promptValidation") return unit;
	const source = doc.localization?.generatedSourceWording?.[unit.id];
	const original = source?.workerFallback?.value ?? source?.value;
	if (original !== undefined && original !== "") return unit;
	const value = checkDefault(
		doc,
		unit,
		effectiveAppLocalization(doc.localization).sourceLanguage,
	);
	return {
		...unit,
		sourceFingerprint: translationSourceFingerprint("text", value),
	};
}

export function presentedSearchWording(
	doc: BlueprintDoc,
	unit: LocalizedTranslationUnit,
): LocalizedTranslationUnit {
	if (unit.generated?.role !== "promptValidation") return unit;
	const raw = snapshotTranslationUnits(doc).get(unit.id);
	if (!raw) return unit;
	const row = localizeTranslationUnit(
		doc,
		unit.language,
		wordingSourceUnit(doc, raw),
	);
	const defaultText = checkDefault(doc, raw, unit.language);
	return {
		...row,
		source:
			row.source ||
			checkDefault(
				doc,
				raw,
				effectiveAppLocalization(doc.localization).sourceLanguage,
			),
		defaultText,
		effective: row.effective || defaultText,
	};
}

/** A generated search check can be the joined wording of several sources. */
export function effectiveWordingValue(
	doc: BlueprintDoc,
	language: LanguageTag,
	unit: TranslationUnit,
) {
	return unit.generated?.role === "promptValidation"
		? presentedSearchWording(doc, localizeTranslationUnit(doc, language, unit))
				.effective
		: storedTranslationValue(doc, language, unit);
}

export function workerPromptCheck(
	doc: BlueprintDoc,
	module: Uuid,
	input: Uuid,
	language: LanguageTag,
): string | undefined {
	const unit = snapshotTranslationUnits(doc).get(
		generatedWordingId(input, "promptValidation"),
	);
	if (!unit) return undefined;
	const row = presentedSearchWording(
		doc,
		localizeTranslationUnit(doc, language, unit),
	);
	if (row.owner.kind !== "search-input" || row.owner.moduleUuid !== module)
		return undefined;
	return typeof row.effective === "string" && row.effective !== ""
		? row.effective
		: undefined;
}
