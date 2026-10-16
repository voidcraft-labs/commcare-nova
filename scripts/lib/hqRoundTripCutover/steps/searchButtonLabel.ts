/**
 * Step `search-button-label`: the search button's text leaves the model.
 * CommCare HQ's Case List save keeps no label of its own, so every search
 * button now reads `CASE_SEARCH_BUTTON_LABEL` in every language, and
 * `caseSearchConfig` refuses the key. Two deletions, each made wherever its
 * own key is found and neither conditioned on the other:
 *
 *   - `searchButtonLabel` on every menu's `caseSearchConfig` that holds one;
 *   - every `module/<uuid>/search-button` translation entry of every
 *     language, whichever menu it names. An entry can stand on a menu with no
 *     stored label, and a label on a menu with no entry.
 *
 * One `search-button-text-changed` line per menu with a search, labelled or
 * not, naming the menu with its former text in the app's default language in
 * `detail.from`: the default language's translation where one is stored, else
 * the stored label, else "Search", the text an unlabelled button read.
 * The text changed only for a document that predates the cutover, which is
 * one that holds no `appSettings`: step `app-settings` writes that slot on
 * every app, and nothing else does. So the cutover's own output gets no
 * second line.
 */

import { asUuid, makeTranslationUnitId } from "@/lib/domain";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { writableRecord } from "./caseLists";
import { isRecord, rawText } from "./relativePaths";

/** The text an unlabelled search button read before the cutover. */
const FORMER_DEFAULT_LABEL = "Search";

/**
 * The segments of a stored translation unit id (`tu1:` then each segment as
 * its length, a colon and its text), or `undefined` for a key of another
 * shape.
 */
function unitSegments(unitId: string): string[] | undefined {
	const prefix = "tu1:";
	if (!unitId.startsWith(prefix)) return undefined;
	const segments: string[] = [];
	let at = prefix.length;
	while (at < unitId.length) {
		const colon = unitId.indexOf(":", at);
		if (colon === -1) return undefined;
		const length = Number(unitId.slice(at, colon));
		const start = colon + 1;
		if (!Number.isSafeInteger(length) || length < 0) return undefined;
		if (start + length > unitId.length) return undefined;
		segments.push(unitId.slice(start, start + length));
		at = start + length;
	}
	return segments;
}

/** Whether a stored translation key is some menu's search button text. */
function isSearchButtonUnit(unitId: string): boolean {
	const segments = unitSegments(unitId);
	return (
		segments !== undefined &&
		segments.length === 3 &&
		segments[0] === "module" &&
		segments[2] === "search-button"
	);
}

/**
 * Whether the stored menu has a search, as `effectiveCaseSearchConfig`
 * reads one: an ordinary stored config, or Search questions with no config.
 * The owner-only config (`searchActionEnabled`) offers no search.
 */
function rawMenuHasSearch(module: JsonRecord): boolean {
	const config = module.caseSearchConfig;
	if (isRecord(config)) return !("searchActionEnabled" in config);
	const list = module.caseListConfig;
	return (
		isRecord(list) &&
		Array.isArray(list.searchInputs) &&
		list.searchInputs.length > 0
	);
}

/** The menu's search button text in the default language, before the step. */
function formerText(
	document: RawDocument,
	moduleUuid: string,
	label: string | undefined,
): string {
	const source = label ?? FORMER_DEFAULT_LABEL;
	const localization = document.localization;
	if (!isRecord(localization)) return source;
	const language = rawText(localization.defaultLanguage);
	if (language === rawText(localization.sourceLanguage)) return source;
	const translations = localization.translations;
	const entries = isRecord(translations) ? translations[language] : undefined;
	const entry = isRecord(entries)
		? entries[makeTranslationUnitId("module", moduleUuid, "search-button")]
		: undefined;
	return isRecord(entry) && typeof entry.value === "string"
		? entry.value
		: source;
}

/** Delete every search button entry of every language. */
function removeSearchButtonUnits(document: RawDocument): void {
	if (!isRecord(document.localization)) return;
	const translations = document.localization.translations;
	if (!isRecord(translations)) return;
	for (const entries of Object.values(translations)) {
		if (!isRecord(entries)) continue;
		const writable = entries as Record<string, Json>;
		for (const unitId of Object.keys(writable)) {
			if (isSearchButtonUnit(unitId)) delete writable[unitId];
		}
	}
}

export const searchButtonLabelStep: CutoverStep = {
	id: "search-button-label",
	apply(document) {
		const changes: DocumentChange[] = [];
		const predatesCutover = document.appSettings === undefined;
		for (const moduleUuid of document.moduleOrder) {
			const module = document.modules[moduleUuid];
			if (module === undefined) continue;
			const config = module.caseSearchConfig;
			const stored =
				isRecord(config) && typeof config.searchButtonLabel === "string"
					? config.searchButtonLabel
					: undefined;
			if (predatesCutover && rawMenuHasSearch(module)) {
				changes.push({
					reason: "search-button-text-changed",
					entity: {
						type: "module",
						uuid: asUuid(moduleUuid),
						nameAtMigration: rawText(module.name),
					},
					detail: { from: formerText(document, moduleUuid, stored) },
				});
			}
			if (isRecord(config) && "searchButtonLabel" in config) {
				delete writableRecord(config).searchButtonLabel;
			}
		}
		removeSearchButtonUnits(document);
		return changes;
	},
};
