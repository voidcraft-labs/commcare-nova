/**
 * Nova's own sentences a search prints in every language: the runtime guard of
 * a Search field's values, joined after the field's own validation message
 * (`system/search-validation/<key>`), and the message of a required field with
 * none of its own (`system/search-required/default`). A system unit's source
 * text is Nova's sentence, and a document holds no other text for it in its
 * source language, so the language a reading takes as its source is one whose
 * text for every such unit the app prints is Nova's sentence: one of the two
 * places `languages.ts::readingSourceCode` reads the source at. Recognition
 * here is a proposal: the menu's projection, compared with the stored search
 * when the menu settles, holds every text read.
 */
import type {
	BlueprintDoc,
	LanguageTag,
	SearchInputDef,
	TranslationUnitId,
	Uuid,
} from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	effectiveCaseSearchConfig,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
} from "@/lib/domain/modules";
import { recordFromEntries } from "@/lib/domain/records";
import {
	SEARCH_RUNTIME_VALIDATION_MESSAGES,
	type SearchRuntimeValidationMessage,
} from "@/lib/domain/searchRuntimeValidationMessages";
import { commCareLocalization } from "../../localization";
import { withCandidate } from "../candidate";
import { isJsonObject, objectMembers } from "../jsonCursor";
import { readFormSyntax } from "../syntaxRead";
import { translationEntryFor } from "../translations";

/** A prompt's stored validation, apart from the runtime guard Nova's emitter conjoins: the
 *  guard is the catalog's entry whose source sentence told it. */
export type ValidationReading =
	| { readonly kind: "whole" }
	| { readonly kind: "guard"; readonly guard: SearchRuntimeValidationMessage }
	| {
			readonly kind: "split";
			readonly rule: string;
			readonly guard: SearchRuntimeValidationMessage;
	  };

/**
 * Nova's emitter writes a prompt's one validation as the authored rule and
 * message, then the runtime guard of the search's own values and its message
 * (`searchPrompts.ts::buildValidation`), each language joining its own two
 * texts. The guard's message is Nova's own sentence in the source language and
 * any text in a translation, so the messages are read in the order given and
 * the first that tells decides: one that is one of the guard's messages is the
 * guard alone; one that ends with a guard message after a space is an authored
 * rule followed by the guard, the guard being the last conjunct of the stored
 * test's top-level `and`.
 */
export function withoutRuntimeGuard(
	test: unknown,
	messages: readonly string[],
): ValidationReading {
	if (typeof test !== "string") return { kind: "whole" };
	for (const message of messages) {
		const reading = guardReading(test, message);
		if (reading.kind !== "whole") return reading;
	}
	return { kind: "whole" };
}

/** What one language's message says of the stored test. */
function guardReading(test: string, message: string): ValidationReading {
	const whole = SEARCH_RUNTIME_VALIDATION_MESSAGES.find(
		(one) => one.message === message,
	);
	if (whole !== undefined) return { kind: "guard", guard: whole };
	const guard = SEARCH_RUNTIME_VALIDATION_MESSAGES.filter((one) =>
		message.endsWith(` ${one.message}`),
	).sort((a, b) => b.message.length - a.message.length)[0];
	if (guard === undefined) return { kind: "whole" };
	const read = readFormSyntax(test);
	const node = read.ok ? read.node : undefined;
	if (node?.kind !== "binary" || node.op !== "and") return { kind: "whole" };
	return {
		kind: "split",
		rule: test.slice(node.left.from, node.left.to),
		guard,
	};
}

/** A `{code: text}` map's strings. */
function texts(value: unknown): Readonly<Record<string, string>> {
	const out = recordFromEntries<string>([]);
	if (!isJsonObject(value)) return out;
	for (const [code, text] of Object.entries(value))
		if (typeof text === "string") out[code] = text;
	return out;
}

/** Every Search prompt of the app's stored menus, in menu and prompt order. */
export function storedPrompts(
	modules: unknown,
): readonly Readonly<Record<string, unknown>>[] {
	if (!Array.isArray(modules)) return [];
	return modules.flatMap((module) => {
		const config = isJsonObject(module) ? module.search_config : undefined;
		return isJsonObject(config) ? (objectMembers(config.properties) ?? []) : [];
	});
}

/**
 * Each of Nova's sentences the app's searches print, with the codes whose text
 * for it is Nova's sentence, keyed `<group>/<key>`. A guard is printed by every
 * prompt whose first validation reads with it (`withoutRuntimeGuard` over the
 * texts in `codes` order), and a language holds its sentence where every such
 * prompt's text there is the sentence or ends with it after a space. The
 * required message is printed by every required prompt whose text in some
 * language is the sentence, and a language holds it where every such prompt's
 * text there is the sentence: a prompt with a message of its own may hold the
 * sentence in one language, and never stands for the language whose text is
 * Nova's for the prompts that hold none.
 */
export function systemSentenceHolders(
	modules: unknown,
	codes: readonly string[],
): ReadonlyMap<string, ReadonlySet<string>> {
	const holders = new Map<string, Set<string>>();
	const narrow = (unit: string, holds: (code: string) => boolean) => {
		const known = holders.get(unit);
		const now = (known === undefined ? codes : [...known]).filter(holds);
		holders.set(unit, new Set(now));
	};
	for (const prompt of storedPrompts(modules)) {
		const first = Array.isArray(prompt.validations)
			? prompt.validations[0]
			: undefined;
		if (isJsonObject(first)) {
			const byCode = texts(first.text);
			const reading = withoutRuntimeGuard(
				first.test,
				codes.map((code) => byCode[code] ?? ""),
			);
			if (reading.kind !== "whole") {
				const sentence = reading.guard.message;
				narrow(`search-validation/${reading.guard.key}`, (code) => {
					const text = byCode[code] ?? "";
					return text === sentence || text.endsWith(` ${sentence}`);
				});
			}
		}
		if (isJsonObject(prompt.required)) {
			const byCode = texts(prompt.required.text);
			if (
				codes.some(
					(code) => byCode[code] === SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
				)
			)
				narrow(
					"search-required/default",
					(code) => byCode[code] === SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
				);
		}
	}
	return holders;
}

const REQUIRED_DEFAULT = makeTranslationUnitId(
	"system",
	"search-required",
	"default",
);

/** A Search field's required message unit. */
function requiredMessageUnit(uuid: Uuid): TranslationUnitId {
	return makeTranslationUnitId("search-input", uuid, "required-message");
}

/**
 * The reader's canonical choice `required-messages-as-read`: where a Search field's own required
 * message is Nova's sentence in the source language, a field holding no message of its own and a
 * field whose own message is that sentence print the same text in every language that holds the
 * same words, so the document's required messages are put where the reading puts them
 * (`prompts.ts::requiredDefaultTexts`). Nova's message is the texts of the first required field,
 * in menu and field order, whose source text is Nova's sentence; a required field whose text is
 * those texts in every language holds no message, and every other required field holds its texts
 * as its own message. A document where no field's own message is Nova's sentence in the source
 * language is returned as it is. It reads the source language the row `source-language-is-as-read`
 * settles.
 */
export function requiredMessagesAsRead(doc: BlueprintDoc): BlueprintDoc {
	const fields: { moduleUuid: Uuid; input: SearchInputDef }[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined || effectiveCaseSearchConfig(mod) === undefined)
			continue;
		for (const input of mod.caseListConfig?.searchInputs ?? [])
			if (input.kind !== "hidden" && input.required !== undefined)
				fields.push({ moduleUuid, input });
	}
	const ownSentence = fields.some(
		({ input }) =>
			input.kind !== "hidden" &&
			input.required?.message === SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	);
	if (!ownSentence) return doc;
	const localization = doc.localization;
	const source = (localization?.sourceLanguage ?? "eng") as LanguageTag;
	const languages = Object.entries(localization?.wireCodes ?? { eng: "en" });
	const wire = commCareLocalization(doc);
	const textsOf = (input: SearchInputDef) => {
		const unit =
			input.kind !== "hidden" && input.required?.message !== undefined
				? requiredMessageUnit(input.uuid)
				: REQUIRED_DEFAULT;
		return new Map(
			languages.map(
				([language, code]) =>
					[language as LanguageTag, wire.text(code, unit)] as const,
			),
		);
	};
	const texts = fields.map(({ input }) => textsOf(input));
	const nova = texts.find(
		(one) => one.get(source) === SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	);
	if (nova === undefined) return doc;
	const holdsNova = (one: ReadonlyMap<LanguageTag, string>) =>
		[...nova].every(([language, text]) => one.get(language) === text);
	return withCandidate(doc, (draft) => {
		const translations = draft.localization?.translations;
		const write = (
			language: LanguageTag,
			unit: TranslationUnitId,
			sourceText: string,
			text: string | undefined,
		) => {
			const targets = translations?.[language];
			if (targets === undefined) return;
			const entry =
				text === undefined
					? undefined
					: translationEntryFor("text", sourceText, text, source);
			if (entry === undefined) delete targets[unit];
			else targets[unit] = entry;
		};
		fields.forEach(({ moduleUuid, input }, index) => {
			const own = draft.modules[moduleUuid]?.caseListConfig?.searchInputs.find(
				(one) => one.uuid === input.uuid,
			);
			const held = texts[index];
			if (own === undefined || own.kind === "hidden" || held === undefined)
				return;
			const required = own.required;
			if (required === undefined) return;
			const unit = requiredMessageUnit(input.uuid);
			if (holdsNova(held)) {
				delete required.message;
				for (const [language] of languages)
					write(language as LanguageTag, unit, "", undefined);
				return;
			}
			const message = held.get(source) ?? "";
			required.message = message;
			for (const [language, text] of held)
				if (language !== source) write(language, unit, message, text);
		});
		for (const [language, text] of nova)
			if (language !== source)
				write(
					language,
					REQUIRED_DEFAULT,
					SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
					text,
				);
	});
}
