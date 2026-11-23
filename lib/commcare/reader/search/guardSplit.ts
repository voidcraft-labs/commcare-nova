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
import { generatedWordingId } from "@/lib/domain/generatedWording";
import {
	editableLanguageEntries,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { effectiveCaseSearchConfig } from "@/lib/domain/modules";
import { SEARCH_RUNTIME_VALIDATION_MESSAGES } from "@/lib/domain/searchRuntimeValidationMessages";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import { moduleExpressionContexts } from "../../expressionContext";
import { generatedSearchChecks } from "../../generatedSearchWording";
import { commCareLocalization } from "../../localization";
import { identityLookupWireNaming } from "../../lookup/naming";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
} from "../../suite/case-search/xpathQuery";
import { withCandidate } from "../candidate";
import { translationEntryFor } from "../translations";

/**
 * The longest text after a space that every text ends with, leaving each a text before it, of
 * those where neither the text nor any text before it has a character up to U+0020 at the end
 * that meets the space (an app string Nova's gate admits, `localeFile.ts::localeFileValueIssue`);
 * where no split is clean so, the longest of all, whose two sides the reader then holds as every
 * app string is (`heldText.ts::holdText`). Every text Nova's emitter joins has a clean split, so
 * the choice reads a Nova-born document's texts back as it holds them.
 */
export function sharedGuardText(texts: readonly string[]): string | undefined {
	const [first] = texts;
	if (first === undefined) return undefined;
	let longest: string | undefined;
	for (
		let at = first.indexOf(" ", 1);
		at !== -1;
		at = first.indexOf(" ", at + 1)
	) {
		const suffix = first.slice(at + 1);
		if (suffix === "") continue;
		if (
			!texts.every(
				(one) => one.length > suffix.length + 1 && one.endsWith(` ${suffix}`),
			)
		)
			continue;
		longest ??= suffix;
		const clean =
			suffix.charCodeAt(0) > 0x20 &&
			texts.every(
				(one) => one.charCodeAt(one.length - suffix.length - 2) > 0x20,
			);
		if (clean) return suffix;
	}
	return longest;
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
	const translated = [
		...Object.values(localization.translations),
		localization.generatedSourceWording,
	].some((entries) =>
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
		const loc = draft.localization;
		if (!loc) return;
		const byUnit = new Map<TranslationUnitId, Map<LanguageTag, string>>();
		for (const { language, unit, value } of changes) {
			const byLanguage = byUnit.get(unit) ?? new Map<LanguageTag, string>();
			byLanguage.set(language, value);
			byUnit.set(unit, byLanguage);
		}
		for (const [id, values] of byUnit) {
			const current = units.get(id);
			if (!current || typeof current.source !== "string") continue;
			let base = current.source;
			const sourceText = values.get(source);
			if (sourceText !== undefined && current.owner.kind === "search-input") {
				const owner = current.owner;
				const input = draft.modules[
					owner.moduleUuid
				]?.caseListConfig?.searchInputs.find(
					(one) => one.uuid === owner.searchInputUuid,
				);
				if (!input || input.kind === "hidden" || !input.validation) continue;
				base = sourceText;
				input.validation.message = base;
				for (const [language, code] of Object.entries(loc.wireCodes)) {
					if (language !== source && !values.has(language))
						values.set(language, wire.text(code, id));
				}
			}
			for (const [language, value] of values) {
				if (language === source && current.owner.kind === "search-input")
					continue;
				const entry = translationEntryFor("text", base, value, source);
				const targets = editableLanguageEntries(
					loc,
					language,
					entry !== undefined,
				);
				if (!targets) continue;
				if (!entry) delete targets[id];
				else targets[id] = entry;
			}
		}
		if (!Object.keys(loc.generatedSourceWording ?? {}).length)
			delete loc.generatedSourceWording;
	});
}

/**
 * The reader's canonical choice for wording absent from the wire: a hidden
 * column output, a disabled search output, or a translation of
 * one of Nova's search guard sentences that no Search field of the app carries, and none. The
 * catalog of those sentences is every app's that has a Search field
 * (`translationUnits.ts`, `SEARCH_RUNTIME_VALIDATION_MESSAGES`), while an export prints only the
 * guard each field's own values need (`xpathQuery.ts::buildRuntimeCsqlPromptValidations`); the
 * date range and search value sentences Preview alone shows are in no export at all. So no export
 * holds such a translation, and the reader returns none.
 */
export function unprintedSearchWording(
	doc: BlueprintDoc,
): ReadonlySet<TranslationUnitId> {
	const held = new Set(
		SEARCH_RUNTIME_VALIDATION_MESSAGES.map((row) =>
			makeTranslationUnitId("system", "search-validation", row.key),
		),
	);

	const required = makeTranslationUnitId(
		"system",
		"search-required",
		"default",
	);
	held.add(required);
	for (const unit of snapshotTranslationUnits(doc).values())
		if (unit.generated?.dormant) held.add(unit.id);
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (!module?.caseListConfig || !effectiveCaseSearchConfig(module)) continue;
		const checks = generatedSearchChecks(doc, moduleUuid);
		for (const check of checks.values()) {
			for (const id of typeof check.source === "string"
				? [check.source]
				: check.source)
				held.delete(id);
		}
		for (const input of module.caseListConfig.searchInputs) {
			if (input.kind === "hidden") continue;
			if (input.required && input.required.message === undefined)
				held.delete(required);
			if (!checks.has(input.uuid))
				held.add(generatedWordingId(input.uuid, "promptValidation"));
		}
	}
	return held;
}

export function unprintedGuardTranslationsAbsent(
	doc: BlueprintDoc,
): BlueprintDoc {
	const localization = doc.localization;
	if (!localization) return doc;
	const translations = localization.translations;
	const inventory = snapshotTranslationUnits(doc);
	const hasGuard = [
		...Object.values(translations),
		localization.generatedSourceWording,
	].some((entries) =>
		Object.keys(entries ?? {}).some((id) => {
			const unit = inventory.get(id);
			return (
				unit?.role === "search-runtime-validation-message" ||
				unit?.generated?.role === "promptValidation" ||
				unit?.generated?.dormant === true
			);
		}),
	);
	if (!hasGuard) return doc;
	const unprintedUnits = unprintedSearchWording(doc);
	const unprinted = [
		...Object.entries(translations),
		[localization.sourceLanguage, localization.generatedSourceWording] as const,
	].flatMap(([language, entries]) =>
		Object.keys(entries ?? {}).flatMap((unit) =>
			unprintedUnits.has(unit as TranslationUnitId)
				? [[language as LanguageTag, unit as TranslationUnitId] as const]
				: [],
		),
	);
	if (unprinted.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		const loc = draft.localization;
		if (!loc) return;
		for (const [language, unit] of unprinted) {
			const entries =
				language === loc.sourceLanguage
					? loc.generatedSourceWording
					: loc.translations[language];
			if (entries) delete entries[unit];
		}
		if (!Object.keys(loc.generatedSourceWording ?? {}).length)
			delete loc.generatedSourceWording;
	});
}
