/** What a worker sees after the named locale is loaded over the default
 * locale. Editable values and raw emitters keep their original spelling. */
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	localizeTranslationUnit,
	snapshotTranslationUnits,
	type TranslationUnit,
	type TranslationUnitId,
} from "@/lib/domain";
import { defaultTableText } from "./appStringKeys";
import { presentedSearchWording } from "./generatedSearchWording";
import { readLocaleValueAsCore } from "./localeFile";

type Output = { readonly text: string; readonly override: boolean };

function workerOutput(
	doc: BlueprintDoc,
	raw: TranslationUnit,
	row: LocalizedTranslationUnit,
): Output | undefined {
	if (!row.generated || row.generated.dormant) return undefined;
	const unit = presentedSearchWording(doc, row);
	if (typeof unit.effective !== "string") return undefined;
	let text: string | undefined;
	if (unit.effective !== "") {
		text = readLocaleValueAsCore("wording", unit.effective);
		return text === undefined
			? undefined
			: {
					text,
					override: !!unit.explicit && unit.effective !== unit.defaultText,
				};
	}
	// HQ drops zero-length values from named files. Its default merge takes
	// the first written language with nonblank text after dumps/loads.
	const languages = effectiveAppLocalization(doc.localization).languageOrder;
	for (const language of languages) {
		if (language === row.language) continue;
		const other = presentedSearchWording(
			doc,
			localizeTranslationUnit(doc, language, raw),
		);
		if (typeof other.effective !== "string") continue;
		const value = defaultTableText(other.effective);
		if (value === "") continue;
		text = readLocaleValueAsCore("wording", value);
		if (text !== undefined) return { text, override: true };
	}
	// An image description with no wording in any locale is still a real
	// suite reference. HQ emits its blank in the default file; the Web Apps
	// image uses the resolved value verbatim as its accessible text.
	if (unit.owner.kind === "case-list-column" && !unit.generated?.base) {
		const blank = readLocaleValueAsCore("wording", "");
		if (blank !== undefined) return { text: blank, override: true };
	}
	return undefined;
}

export function workerWording(
	doc: BlueprintDoc,
	language: LanguageTag,
	id: TranslationUnitId,
	overrideOnly = false,
): string | undefined {
	const unit = snapshotTranslationUnits(doc).get(id);
	const output =
		unit &&
		workerOutput(doc, unit, localizeTranslationUnit(doc, language, unit));
	return output && (!overrideOnly || output.override) ? output.text : undefined;
}

interface WorkerValues {
	readonly values: ReadonlyMap<TranslationUnitId, LocalizedValue>;
	readonly overrides: ReadonlyMap<TranslationUnitId, string>;
}
const bySnapshot = new WeakMap<BlueprintDoc, Map<LanguageTag, WorkerValues>>();
function workerValues(doc: BlueprintDoc, language: LanguageTag): WorkerValues {
	const byLanguage =
		bySnapshot.get(doc) ?? new Map<LanguageTag, WorkerValues>();
	const cached = byLanguage.get(language);
	if (cached) return cached;
	const values = new Map<TranslationUnitId, LocalizedValue>(),
		overrides = new Map<TranslationUnitId, string>();
	for (const unit of snapshotTranslationUnits(doc).values()) {
		if (unit.generated?.dormant) continue;
		const row = localizeTranslationUnit(doc, language, unit);
		const output = workerOutput(doc, unit, row);
		values.set(row.id, output?.text ?? row.effective);
		if (output?.override) overrides.set(row.id, output.text);
	}
	const result = { values, overrides };
	byLanguage.set(language, result);
	bySnapshot.set(doc, byLanguage);
	return result;
}

/** A prose-backed column still renders its ordinary expression when unedited. */
export function workerOutputOverrides(
	doc: BlueprintDoc,
	language: LanguageTag,
) {
	return workerValues(doc, language).overrides;
}
export function workerLocalizedValues(
	doc: BlueprintDoc,
	language: LanguageTag,
) {
	return workerValues(doc, language).values;
}
