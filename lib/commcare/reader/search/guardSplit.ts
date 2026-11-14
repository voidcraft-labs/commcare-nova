/**
 * Where a Search field's own validation message ends and the runtime guard's
 * begins, in a language whose stored text joins the two. Nova's emitter writes
 * the field's message, a space and the guard's message (`searchPrompts.ts::buildValidation`),
 * so the stored bytes are the join alone: where the guard's text in a language
 * is no text a field holds alone, the reading chooses the split
 * (`readGuardText`), and `joinedGuardsSplitAsRead` is the reader's canonical
 * choice that puts a Nova-born document's two texts where that reading does.
 */
import type {
	BlueprintDoc,
	LanguageTag,
	SearchInputDef,
	TranslationUnitId,
} from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { effectiveCaseSearchConfig } from "@/lib/domain/modules";
import { SEARCH_RUNTIME_VALIDATION_MESSAGES } from "@/lib/domain/searchRuntimeValidationMessages";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import { moduleExpressionContexts } from "../../expressionContext";
import { commCareLocalization } from "../../localization";
import { identityLookupWireNaming } from "../../lookup/naming";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
} from "../../suite/case-search/xpathQuery";
import { withCandidate } from "../candidate";
import { translationEntryFor } from "../translations";

/** The longest text after a space that every text ends with, leaving each a text before it. */
export function sharedGuardText(texts: readonly string[]): string | undefined {
	const [first, ...rest] = texts;
	if (first === undefined) return undefined;
	for (
		let at = first.indexOf(" ", 1);
		at !== -1;
		at = first.indexOf(" ", at + 1)
	) {
		const suffix = first.slice(at + 1);
		if (suffix === "") continue;
		if (
			rest.every(
				(one) => one.length > suffix.length + 1 && one.endsWith(` ${suffix}`),
			)
		)
			return suffix;
	}
	return undefined;
}

/**
 * A guard's text in one language other than the source: the text of a field that holds the guard
 * alone, where one does; else Nova's sentence, untranslated, where every text that joins it ends
 * with that sentence after a space; else the longest text after a space that every joined text
 * ends with and that leaves each field a message of its own (`sharedGuardText`).
 */
export function readGuardText(
	sentence: string,
	alone: string | undefined,
	joined: readonly string[],
): string | undefined {
	if (alone !== undefined) return alone;
	if (joined.every((one) => one.endsWith(` ${sentence}`))) return sentence;
	return sharedGuardText(joined);
}

/** The Search fields of the app that carry a runtime guard, by the guard's key, in menu and
 *  field order: the reading reads each guard's text over every field of the app. */
function guardCarriers(
	doc: BlueprintDoc,
): ReadonlyMap<string, readonly SearchInputDef[]> {
	const out = new Map<string, SearchInputDef[]>();
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		const config = mod?.caseListConfig;
		if (
			mod === undefined ||
			config === undefined ||
			effectiveCaseSearchConfig(mod) === undefined
		)
			continue;
		// Which field a guard joins reads no table's name, so every table is named by its id.
		const naming = identityLookupWireNaming();
		const guards = buildRuntimeCsqlPromptValidations(
			composeXPathQueryEmission(
				config,
				mod.caseType,
				moduleExpressionContexts(doc, moduleUuid, naming),
				naming,
			),
		);
		for (const input of config.searchInputs) {
			const guard = guards.get(input.name);
			if (guard === undefined) continue;
			out.set(guard.messageKey, [...(out.get(guard.messageKey) ?? []), input]);
		}
	}
	return out;
}

/**
 * The reader's canonical choice `joined-search-guards-split-as-read`: in a language other than the
 * source where a guard's text is joined after Search fields' own validation messages and no field
 * holds it alone, the document whose guard and messages split the joined texts where
 * `readGuardText` splits them prints the same bytes, and the reader returns it. Only a document
 * that translates a guard can differ, so any other is returned as it is.
 */
export function joinedGuardsSplitAsRead(doc: BlueprintDoc): BlueprintDoc {
	const localization = doc.localization;
	if (localization === undefined) return doc;
	const guardUnits = new Map(
		SEARCH_RUNTIME_VALIDATION_MESSAGES.map((entry) => [
			makeTranslationUnitId("system", "search-validation", entry.key),
			entry,
		]),
	);
	const translated = Object.values(localization.translations).some((entries) =>
		Object.keys(entries ?? {}).some((unit) =>
			guardUnits.has(unit as TranslationUnitId),
		),
	);
	if (!translated) return doc;
	const units = snapshotTranslationUnits(doc);
	const wire = commCareLocalization(doc);
	const source = localization.sourceLanguage;
	const changes: {
		language: LanguageTag;
		unit: TranslationUnitId;
		value: string;
	}[] = [];
	for (const [key, carriers] of guardCarriers(doc)) {
		const guardUnit = makeTranslationUnitId("system", "search-validation", key);
		const sentence = units.get(guardUnit)?.source;
		if (typeof sentence !== "string") continue;
		const messageUnits = carriers.flatMap((input) =>
			input.kind !== "hidden" && input.validation !== undefined
				? [
						makeTranslationUnitId(
							"search-input",
							input.uuid,
							"validation-message",
						),
					]
				: [],
		);
		const someAlone = messageUnits.length < carriers.length;
		for (const [language, code] of Object.entries(localization.wireCodes)) {
			if (language === source) continue;
			const guard = wire.text(code, guardUnit);
			const joined = messageUnits.map((unit) => ({
				unit,
				text: `${wire.text(code, unit)} ${guard}`,
			}));
			const read = readGuardText(
				sentence,
				someAlone ? guard : undefined,
				joined.map(({ text }) => text),
			);
			if (read === undefined || read === guard) continue;
			const tag = language as LanguageTag;
			changes.push({ language: tag, unit: guardUnit, value: read });
			for (const { unit, text } of joined)
				changes.push({
					language: tag,
					unit,
					value: text.slice(0, text.length - read.length - 1),
				});
		}
	}
	if (changes.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		const translations = draft.localization?.translations;
		if (translations === undefined) return;
		for (const { language, unit, value } of changes) {
			const current = units.get(unit);
			const targets = translations[language];
			if (current === undefined || targets === undefined) continue;
			const entry = translationEntryFor(
				current.valueKind,
				current.source,
				value,
				source,
			);
			if (entry === undefined) delete targets[unit];
			else targets[unit] = entry;
		}
	});
}
