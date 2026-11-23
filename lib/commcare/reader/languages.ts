/**
 * An HQ app's languages: `langs`, in order, each code held verbatim as its
 * language's wire code and named by an identity of Nova's language registry.
 * HQ's first language is the default every runtime starts in
 * (`models/applications.py::Application.default_language`). The source
 * language, whose text the document's own slots hold, is the first language
 * a reading of the app with that language as its source prints back
 * (`readingSourceCode`): the first whose text is the source's at every place
 * Nova's emitter writes a source text apart from a translation, and the first
 * language where nothing in the app tells the languages apart.
 */

import type { Draft } from "immer";
import {
	type AppLanguageIdentity,
	type AppLocalization,
	type BlueprintDoc,
	effectiveAppLocalization,
	effectiveCaseSearchConfig,
	isEnglishOnlyLocalization,
	type LanguageTag,
	type LocalizedValue,
	languageTag,
	languageWireCodeSchema,
	makeTranslationUnitId,
	parseLanguageTag,
	type TranslationEntry,
	translationSourceFingerprint,
} from "@/lib/domain";
import {
	identityIssues,
	regionChoices,
	scriptChoices,
} from "@/lib/domain/languageRegistry";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { recordFromEntries } from "@/lib/domain/records";
import {
	snapshotTranslationUnits,
	storedTranslationValue,
	type TranslationUnit,
} from "@/lib/domain/translationUnits";
import {
	cutFindingName,
	type FindingDetail,
	type HqPlace,
	type ManifestFinding,
	type Subject,
	shownPlace,
} from "@/lib/publish/hqFindings";
import { expandAppShell } from "../expander";
import { projectCaseListForHq } from "../hqJson/caseList";
import { HqXPath, hqXPathText } from "../hqJson/xpath";
import {
	languagesOfWireBase,
	lawfulLanguageIdentities,
	mintLanguageWireCode,
} from "../languageWire";
import { identityLookupWireNaming } from "../lookup/naming";
import { inventoryIndex } from "../surface/inventory";
import { withCandidate } from "./candidate";
import { type Claim, defineClaims, refuse, take } from "./claims";
import type { ReadContext } from "./context";
import { keyDefinedAfterLineEnd } from "./heldText";
import { isJsonObject, sameJson } from "./jsonCursor";
import { languagesPlace } from "./place";
import { systemSentenceHolders } from "./search/systemSentences";
import type { ReaderKnownLanguageCodes } from "./types";

const AREA = "application-and-settings";
const LANGS = "schema:Application.langs";

const CLAIMS = defineClaims("languages", {
	/** The list, claimed once: its order, and its first code the default. */
	langs: take(`${AREA}/langs-order-langs-0-default`, LANGS),
	emptyCode: refuse(`${AREA}/langs-containing-an-empty-code`, LANGS),
	outsideGrammarOrRepeated: refuse(
		`${AREA}/a-non-empty-langs-code-outside-that-grammar-or-repeated`,
		LANGS,
	),
	cannotName: refuse(
		`${AREA}/langs-code-nova-s-language-registry-cannot-name`,
		LANGS,
	),
});

/** What a reading made of `langs`. */
export interface HqLanguages {
	/** The codes in HQ's order. */
	readonly codes: readonly string[];
	/** Each code the reading named, to its language's tag. */
	readonly tagOf: ReadonlyMap<string, LanguageTag>;
	/** Each code the reading named, to its identity. */
	readonly identityOf: ReadonlyMap<string, AppLanguageIdentity>;
	/** Each code that got a finding, to that finding: what a key under the code stands under. */
	readonly refused: ReadonlyMap<string, ManifestFinding>;
	/** The first code, HQ's default language; undefined where `langs` is empty. */
	readonly first: string | undefined;
	/** The code whose text the document's own slots hold, the source language
	 *  (`readingSourceCode` over the codes the reading named); undefined where it named none. */
	readonly source: string | undefined;
}

/** A two-letter suffix as the region it spells, where the language offers it. */
function regionOf(
	language: string,
	script: string | undefined,
	letters: string,
): string | undefined {
	if (letters.length !== 2) return undefined;
	const region = letters.toUpperCase();
	return regionChoices(language, script).some(
		(choice) => choice.region === region,
	)
		? region
		: undefined;
}

/** A four-letter suffix as the script it spells, where the language is written in it. */
function scriptOf(language: string, letters: string): string | undefined {
	if (letters.length !== 4) return undefined;
	const script = `${letters.slice(0, 1).toUpperCase()}${letters.slice(1)}`;
	return scriptChoices(language).some((choice) => choice.script === script)
		? script
		: undefined;
}

/**
 * The identity an HQ language code names, or undefined where Nova's registry
 * names none. The code splits at its first hyphen into a base and a suffix.
 * The base gives the language: the one Nova itself writes the code for
 * (`languageWire.ts::mintLanguageWireCode`, asked of every identity the
 * base names), else the base's own language, a Set 1 alias's, or a
 * macrolanguage's predominant member. The suffix is lower case, since HQ's grammar
 * admits nothing else, so it is read by its length and its letters: two
 * letters a region the language offers, four a script it is written in, six
 * a script then a region offered in that script, the spelling
 * `languageWire.ts::mintLanguageWireCode` writes for an identity holding
 * both; any other suffix adds nothing.
 *
 * A code with no suffix is the spelling `mintLanguageWireCode` writes for
 * any identity while no other language holds it, so it can stand for a
 * script, a region or a macrolanguage's member the code does not spell.
 * There `displayName`, the name the app holds for the code in its first
 * language's strings, chooses: the one identity Nova writes the code for (or,
 * where it writes it for none, the one the base names) whose name Nova gives
 * is that name. Nova writes every language's name there on each publish, and
 * writes a code with no suffix for at most one identity of each name, so an
 * app Nova published reads back to the identities it held. Where no
 * identity's name is that one, the code names the language alone.
 */
export function languageIdentityForHqCode(
	code: string,
	displayName?: string,
): AppLanguageIdentity | undefined {
	const hyphen = code.indexOf("-");
	const base = hyphen < 0 ? code : code.slice(0, hyphen);
	const suffix = hyphen < 0 ? "" : code.slice(hyphen + 1);
	const languages = languagesOfWireBase(base);
	const candidates = languages.flatMap(lawfulLanguageIdentities);
	/* The identities Nova itself writes this code for while no other language
	 * holds it: the production minter, asked of each. */
	const spelled = candidates.filter(
		(identity) => mintLanguageWireCode(new Set(), identity) === code,
	);
	if (hyphen < 0 && displayName !== undefined) {
		const named = (spelled.length > 0 ? spelled : candidates).filter(
			(identity) => resolvedLanguageDisplayLabel(identity) === displayName,
		);
		if (named.length === 1) return named[0];
	}
	const language = spelled[0]?.language ?? languages[0];
	if (language === undefined) return undefined;
	let script: string | undefined;
	let region: string | undefined;
	if (suffix.length === 2) region = regionOf(language, undefined, suffix);
	else if (suffix.length === 4) script = scriptOf(language, suffix);
	else if (suffix.length === 6) {
		const written = scriptOf(language, suffix.slice(0, 4));
		const writtenRegion =
			written === undefined
				? undefined
				: regionOf(language, written, suffix.slice(4));
		if (writtenRegion !== undefined) {
			script = written;
			region = writtenRegion;
		}
	}
	const identity: AppLanguageIdentity = {
		language,
		...(script === undefined ? {} : { script }),
		...(region === undefined ? {} : { region }),
	};
	return identityIssues(identity).length === 0 ? identity : undefined;
}

/**
 * The finding a refusing claim makes, as the accounting makes it, for a node
 * a stage covers by it (`Accounting.cover`): a key under a language code that
 * got a finding, a value whose finding stands at another place.
 */
export function manifestFindingOf(
	claim: Claim,
	place: HqPlace,
	detail: FindingDetail,
): ManifestFinding {
	const entry = inventoryIndex().entry(claim.entry);
	if (
		entry === undefined ||
		entry.subject === null ||
		(entry.standing !== "not-yet" &&
			entry.standing !== "never" &&
			entry.standing !== "fix-in-hq")
	)
		throw new Error(
			`The reader's claim on ${claim.entry} names no entry that makes a finding. Its claims are held to the manifest by claimsBindManifest.test.ts; run it to see which entry moved.`,
		);
	return {
		code: entry.id,
		standing: entry.standing,
		...(entry.standing === "fix-in-hq" && entry.cause !== null
			? { cause: entry.cause }
			: {}),
		place: shownPlace(place),
		subject: entry.subject as Subject,
		detail: {
			...(detail.name === undefined
				? {}
				: { name: cutFindingName(detail.name) }),
		},
	};
}

/** The name the app holds for `code` in its first language's strings, where it holds one. */
function displayNameOf(
	ctx: ReadContext,
	first: string,
	code: string,
): string | undefined {
	const translations = ctx.app.peek("translations");
	if (!isJsonObject(translations)) return undefined;
	const strings = translations[first];
	if (!isJsonObject(strings)) return undefined;
	const name = strings[code];
	return typeof name === "string" ? name : undefined;
}

/**
 * Reads `langs` in order. The list is one use, claimed once; each code's
 * finding is raised at the languages place with the code as its name: an
 * empty code, a code outside HQ's grammar or one the list holds twice, and a
 * code Nova's registry cannot name or that names a language an earlier code
 * already named. A code the held document stores (`ReaderInput.knownLanguageCodes`)
 * names the language it stores the code for. The draft's localization holds every code the reading
 * named, the first named the default language and the source the one
 * `readingSourceCode` gives among them.
 */
export function readLanguages(ctx: ReadContext): HqLanguages {
	const place = languagesPlace();
	const raw = ctx.app.peek("langs");
	const tagOf = new Map<string, LanguageTag>();
	const identityOf = new Map<string, AppLanguageIdentity>();
	const refused = new Map<string, ManifestFinding>();
	if (!Array.isArray(raw) || !raw.every((code) => typeof code === "string")) {
		return {
			codes: [],
			tagOf,
			identityOf,
			refused,
			first: undefined,
			source: undefined,
		};
	}
	if (raw.length === 0) {
		/* HQ's pages never leave an app with no language, and HQ falls back
		 * to `en` for one (`Application.default_language`). Nova does not
		 * guess a language into the document. */
		ctx.accounting.circumstance("unrecognized", place, { name: LANGS });
		return {
			codes: [],
			tagOf,
			identityOf,
			refused,
			first: undefined,
			source: undefined,
		};
	}
	const codes = ctx.app.take("langs", CLAIMS.langs, (value) =>
		(value as string[]).slice(),
	).value;
	const first = codes[0];
	const seen = new Set<string>();
	// A code's refusal is a class of the app's list of codes, so it stands there too.
	const raise = (claim: Claim, code: string, name: string | undefined) => {
		const detail: FindingDetail = name === undefined ? {} : { name };
		ctx.accounting.findingAt(claim, place, "/langs", detail);
		if (!refused.has(code))
			refused.set(code, manifestFindingOf(claim, place, detail));
	};
	for (const code of codes) {
		if (code === "") {
			raise(CLAIMS.emptyCode, code, undefined);
			continue;
		}
		if (!languageWireCodeSchema.safeParse(code).success || seen.has(code)) {
			seen.add(code);
			raise(CLAIMS.outsideGrammarOrRepeated, code, code);
			continue;
		}
		seen.add(code);
		const known = ctx.input.knownLanguageCodes?.get(code);
		const identity =
			known !== undefined
				? parseLanguageTag(known)
				: languageIdentityForHqCode(
						code,
						first === undefined ? undefined : displayNameOf(ctx, first, code),
					);
		const tag = identity === undefined ? undefined : languageTag(identity);
		if (
			identity === undefined ||
			tag === undefined ||
			[...tagOf.values()].includes(tag)
		) {
			raise(CLAIMS.cannotName, code, code);
			continue;
		}
		tagOf.set(code, tag);
		identityOf.set(code, identity);
	}
	const held = codes.flatMap((code) => {
		const tag = tagOf.get(code);
		return tag === undefined || refused.has(code) ? [] : [[tag, code] as const];
	});
	const order = held.map(([tag]) => tag);
	const [defaultLanguage] = order;
	/* The name, the strings and the stored menus are read here only for what tells the source:
	 * the app shell and the search stages claim them. */
	const sourceCode = readingSourceCode(
		{
			name: ctx.app.peek("name"),
			translations: ctx.app.peek("translations"),
			modules: ctx.app.peek("modules"),
		},
		held.map(([, code]) => code),
	);
	const source = held.find(([, code]) => code === sourceCode)?.[0];
	if (defaultLanguage !== undefined && source !== undefined) {
		const localization: AppLocalization = {
			sourceLanguage: source,
			defaultLanguage,
			languageOrder: order,
			translations: recordFromEntries(
				order
					.filter((tag) => tag !== source)
					.map((tag) => [tag, recordFromEntries<TranslationEntry>([])]),
			),
			wireCodes: recordFromEntries(held),
		};
		/* English alone, coded `en`, is the absent root: the one spelling a
		 * document holds for it. */
		ctx.writeDraft(() => {
			ctx.draft.localization = isEnglishOnlyLocalization(localization)
				? undefined
				: localization;
		});
	}
	return {
		codes,
		tagOf,
		identityOf,
		refused,
		first,
		source: source === undefined ? undefined : sourceCode,
	};
}

/** The language each CommCare HQ code of `doc` names, for `ReaderInput.knownLanguageCodes` on a
 *  re-read of an app Nova holds: its stored wire codes, inverted. An English-only document holds
 *  `en` for English. */
export function knownLanguageCodesOf(
	doc: BlueprintDoc,
): ReaderKnownLanguageCodes {
	const { wireCodes } = effectiveAppLocalization(doc.localization);
	return new Map(
		Object.entries(wireCodes).map(([tag, code]) => [code, tag as LanguageTag]),
	);
}

// ── The source language ─────────────────────────────────────────────────

/** What of an app tells which of its languages is the source, as HQ stores it. */
export interface SourceEvidence {
	/** `Application.name`. */
	readonly name: unknown;
	/** `Application.translations`: each language's strings. */
	readonly translations: unknown;
	/** `Application.modules`, whose Search settings print Nova's own sentences. */
	readonly modules: unknown;
}

/**
 * Whether `code`'s stored strings let it be the source at the app's name.
 * Nova writes the name in the source language as `name`, and
 * `app.display.name` (with `homescreen.title`) only in a language whose name
 * differs from it (`expander.ts::appLevelValues`), so a language holding a
 * non-empty `app.display.name` other than `name` is not the source of any
 * document that prints the app. HQ's build ignores an empty one
 * (`app_strings.py::SelectKnownAppStrings.app_strings_parts`, `non_empty_only`), and one
 * equal to `name` is what every language that holds no other shows, so
 * neither tells one language from another. Nor does one whose rest after a
 * carriage return defines another app string (`heldText.ts::keyDefinedAfterLineEnd`):
 * Nova prints no carriage return, so no document's export holds it, and the
 * reading refuses it at its key whichever language is the source
 * (`appShell.ts::readTranslations`), so reading it here would only move the
 * source and refuse what the source's text keeps out elsewhere.
 */
function namesTheAppAsSource(evidence: SourceEvidence, code: string): boolean {
	const strings = isJsonObject(evidence.translations)
		? evidence.translations[code]
		: undefined;
	const shown = isJsonObject(strings) ? strings["app.display.name"] : undefined;
	return (
		typeof shown !== "string" ||
		shown === "" ||
		shown === evidence.name ||
		keyDefinedAfterLineEnd(shown) !== undefined
	);
}

/**
 * The code of the language a reading takes as its source: the first of
 * `codes`, in the app's order, that a reading with it as the source prints
 * back at every place Nova's emitter writes the source's text apart from a
 * translation. There are two such places, and the reader's `CLAUDE.md` lists
 * them with the places that only look like one:
 *
 * - the app's name, which Nova writes as `name` in the source language and as
 *   `app.display.name` only in a language whose name differs
 *   (`namesTheAppAsSource`);
 * - Nova's own sentences (a Search field's runtime guard, the required
 *   message of a Search field with none of its own), whose text in the
 *   source language is always the sentence, since a system unit's source is
 *   Nova's and no document holds another (`systemSentenceHolders`).
 *
 * Every other text the emitter writes, it writes from one projection of each
 * language's text (`localization.ts::commCareLocalization`), the same bytes
 * whichever language holds it as the source, so comparing these two places is
 * the whole test and no candidate is read whole. A language earlier than a
 * document's own source passes only where its text at both places is the
 * source's, so the document sourced in either prints one export. Where
 * nothing in the app tells the languages apart every code passes and the
 * source is the first, HQ's default language. It is the first too where none
 * passes: no language holds Nova's sentence for every Search field that prints
 * it where a field's own required message prints as the sentence in another
 * language than the source, and a reading then holds what the first language
 * reads.
 */
export function readingSourceCode(
	evidence: SourceEvidence,
	codes: readonly string[],
): string | undefined {
	const holders = [...systemSentenceHolders(evidence.modules, codes).values()];
	return (
		codes.find(
			(code) =>
				namesTheAppAsSource(evidence, code) &&
				holders.every((held) => held.has(code)),
		) ?? codes[0]
	);
}

// ── The source language of a document Nova made ─────────────────────────

/** `value` with every HQ XPath printed as its text, as the stored app holds it. */
function printed(value: unknown): unknown {
	if (value instanceof HqXPath) return hqXPathText(value);
	if (Array.isArray(value)) return value.map(printed);
	if (isJsonObject(value))
		return recordFromEntries(
			Object.entries(value).map(([key, one]) => [key, printed(one)]),
		);
	return value;
}

/**
 * The language a reading of `doc`'s export takes as its source: the rule the
 * languages stage applies to a stored app (`readingSourceCode`), over the
 * name and strings Nova's production emitter writes for `doc`
 * (`expander.ts::expandAppShell`, which writes them as the whole export
 * does) and the search settings its projection writes
 * (`hqJson/caseList.ts::projectCaseListForHq`), so the two read one set of
 * values. Undefined for a document with no localization, which is English
 * alone.
 */
export function sourceLanguageAsRead(
	doc: BlueprintDoc,
): LanguageTag | undefined {
	const localization = doc.localization;
	if (localization === undefined) return undefined;
	const order = localization.languageOrder;
	const shell = expandAppShell(doc);
	const modules = doc.moduleOrder.flatMap((uuid) => {
		const module = doc.modules[uuid];
		if (
			module?.caseListConfig === undefined ||
			effectiveCaseSearchConfig(module) === undefined
		)
			return [];
		const { searchConfig } = projectCaseListForHq(
			module,
			doc,
			undefined,
			identityLookupWireNaming(),
		);
		return [{ search_config: printed(searchConfig) }];
	});
	const code = readingSourceCode(
		{ name: shell.name, translations: shell.translations, modules },
		order.map((tag) => localization.wireCodes[tag] ?? tag),
	);
	return order.find((tag) => localization.wireCodes[tag] === code) ?? order[0];
}

type SlotWriter = (draft: Draft<BlueprintDoc>, value: LocalizedValue) => void;

/** Where a unit's source text lives in the document, as a writer of that slot; undefined for a
 *  unit whose source is Nova's own sentence (a system unit), which no document holds. */
function sourceSlotWriter(unit: TranslationUnit): SlotWriter | undefined {
	const owner = unit.owner;
	const text = (value: LocalizedValue) => value as string;
	switch (unit.role) {
		case "app-name":
			return (draft, value) => {
				draft.appName = text(value);
			};
		case "module-name":
			return owner.kind === "module"
				? (draft, value) => {
						const module = draft.modules[owner.moduleUuid];
						if (module !== undefined) module.name = text(value);
					}
				: undefined;
		case "case-list-menu-item-label":
			return owner.kind === "module"
				? (draft, value) => {
						const item = draft.modules[owner.moduleUuid]?.caseListMenuItem;
						if (item !== undefined) item.label = text(value);
					}
				: undefined;
		case "case-list-registration-label":
			return owner.kind === "module"
				? (draft, value) => {
						const registration =
							draft.modules[owner.moduleUuid]?.caseListRegistrationForm;
						if (registration !== undefined) registration.label = text(value);
					}
				: undefined;
		case "form-name":
			return owner.kind === "form"
				? (draft, value) => {
						const form = draft.forms[owner.formUuid];
						if (form !== undefined) form.name = text(value);
					}
				: undefined;
		case "field-label":
		case "field-hint":
		case "field-help":
		case "field-first-add-label":
		case "field-add-label":
		case "field-validation-message": {
			const slot = {
				"field-label": "label",
				"field-hint": "hint",
				"field-help": "help",
				"field-validation-message": "validate_msg",
				"field-first-add-label": "addFirstLabel",
				"field-add-label": "addLabel",
			}[unit.role];
			return owner.kind === "field"
				? (draft, value) => {
						const field = draft.fields[owner.fieldUuid] as
							| Record<string, unknown>
							| undefined;
						if (field !== undefined) field[slot] = value;
					}
				: undefined;
		}
		case "select-option-label":
			return owner.kind === "select-option"
				? (draft, value) => {
						const field = draft.fields[owner.fieldUuid];
						if (
							field === undefined ||
							!("optionsSource" in field) ||
							field.optionsSource.kind !== "inline"
						)
							return;
						const option = field.optionsSource.options.find(
							(one) => one.uuid === owner.optionUuid,
						);
						if (option !== undefined)
							option.label = value as typeof option.label;
					}
				: undefined;
		case "case-list-header":
		case "case-list-interval-text":
		case "case-list-mapping-label":
			return owner.kind === "case-list-column"
				? (draft, value) => {
						const column = draft.modules[
							owner.moduleUuid
						]?.caseListConfig?.columns.find(
							(one) => one.uuid === owner.columnUuid,
						);
						if (column === undefined) return;
						if (unit.role === "case-list-header") column.header = text(value);
						else if (
							unit.role === "case-list-interval-text" &&
							column.kind === "interval"
						)
							column.text = text(value);
						else if (column.kind === "id-mapping") {
							const mapping = column.mapping.find(
								(one) => one.value === unit.context.optionValue,
							);
							if (mapping !== undefined) mapping.label = text(value);
						}
					}
				: undefined;
		case "case-list-sort-label":
			return owner.kind === "case-list-column"
				? (draft, value) => {
						const column = draft.modules[
							owner.moduleUuid
						]?.caseListConfig?.columns.find(
							(one) => one.uuid === owner.columnUuid,
						);
						if (column?.sort !== undefined) column.sort.label = text(value);
					}
				: undefined;
		case "case-property-option-label":
			return owner.kind === "case-property-option"
				? (draft, value) => {
						const options = draft.caseTypes
							?.find((type) => type.name === owner.caseType)
							?.properties.find((one) => one.name === owner.property)?.options;
						const option = options?.filter((one) => one.value === owner.value)[
							owner.occurrence
						];
						if (option !== undefined)
							option.label = value as typeof option.label;
					}
				: undefined;
		case "search-input-label":
		case "search-input-hint":
		case "search-input-required-message":
		case "search-input-validation-message":
			return owner.kind === "search-input"
				? (draft, value) => {
						const input = draft.modules[
							owner.moduleUuid
						]?.caseListConfig?.searchInputs.find(
							(one) => one.uuid === owner.searchInputUuid,
						);
						if (input === undefined) return;
						if (unit.role === "search-input-label") input.label = text(value);
						else if (input.kind === "hidden") return;
						else if (unit.role === "search-input-hint")
							input.hint = text(value);
						else if (
							unit.role === "search-input-required-message" &&
							input.required !== undefined
						)
							input.required.message = text(value);
						else if (
							unit.role === "search-input-validation-message" &&
							input.validation !== undefined
						)
							input.validation.message = text(value);
					}
				: undefined;
		case "search-screen-title":
		case "search-screen-subtitle":
			return owner.kind === "module"
				? (draft, value) => {
						const module = draft.modules[owner.moduleUuid];
						if (module === undefined) return;
						module.caseSearchConfig = {
							...module.caseSearchConfig,
							...(unit.role === "search-screen-title"
								? { searchScreenTitle: text(value) }
								: { searchScreenSubtitle: text(value) }),
						};
					}
				: undefined;
		default:
			return undefined;
	}
}

/** The unit of the message every required Search field with none of its own prints. */
const REQUIRED_DEFAULT = makeTranslationUnitId(
	"system",
	"search-required",
	"default",
);

/**
 * `doc` with `target` as its source language, every text in every language
 * the same: each unit's slot holds the text `target` read, and each other
 * language a translation where its text differs from that, reviewed and from
 * `target`. A system unit's source stays Nova's sentence, so `target` keeps
 * only the text it reads where that is the sentence, which the reading's rule
 * (`readingSourceCode`) gives for every system unit the app prints, but where
 * no language holds every one and the rule falls back to the first language,
 * whose text for the required message of a Search field with none of its own
 * may be a translation. Each such field then holds the texts it prints as a
 * message of its own, as a reading of them does. The default language and the
 * order are kept.
 */
export function resourcedDocument(
	doc: BlueprintDoc,
	target: LanguageTag,
): BlueprintDoc {
	const localization = doc.localization;
	if (
		localization === undefined ||
		localization.sourceLanguage === target ||
		!localization.languageOrder.includes(target)
	)
		return doc;
	const order = localization.languageOrder;
	const texts = [...snapshotTranslationUnits(doc).values()].map((unit) => ({
		unit,
		byLanguage: order.map(
			(language) =>
				[language, storedTranslationValue(doc, language, unit)] as const,
		),
	}));
	const requiredDefault = texts.find(
		({ unit }) => unit.id === REQUIRED_DEFAULT,
	);
	const requiredDefaultRead = requiredDefault?.byLanguage.find(
		([language]) => language === target,
	)?.[1];
	const requiredDefaultMoves =
		requiredDefault !== undefined &&
		requiredDefaultRead !== undefined &&
		!sameJson(requiredDefaultRead, requiredDefault.unit.source);
	return withCandidate(doc, (draft) => {
		const translations = recordFromEntries(
			order
				.filter((tag) => tag !== target)
				.map((tag) => [tag, recordFromEntries<TranslationEntry>([])]),
		);
		for (const { unit, byLanguage } of texts) {
			if (requiredDefaultMoves && unit.id === REQUIRED_DEFAULT) continue;
			const write = sourceSlotWriter(unit);
			const read = byLanguage.find(([language]) => language === target)?.[1];
			const next =
				write === undefined || read === undefined ? unit.source : read;
			if (write !== undefined && !sameJson(next, unit.source))
				write(draft, next);
			const sourceFingerprint = translationSourceFingerprint(
				unit.valueKind,
				next,
			);
			for (const [language, value] of byLanguage) {
				const into = translations[language];
				if (into === undefined || sameJson(value, next)) continue;
				into[unit.id] = {
					value,
					sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: target,
				};
			}
		}
		if (requiredDefaultMoves && requiredDefault !== undefined) {
			const message = requiredDefaultRead as string;
			const sourceFingerprint = translationSourceFingerprint("text", message);
			for (const moduleUuid of draft.moduleOrder)
				for (const input of draft.modules[moduleUuid]?.caseListConfig
					?.searchInputs ?? []) {
					if (
						input.kind === "hidden" ||
						input.required === undefined ||
						input.required.message !== undefined
					)
						continue;
					input.required.message = message;
					const unit = makeTranslationUnitId(
						"search-input",
						input.uuid,
						"required-message",
					);
					for (const [language, value] of requiredDefault.byLanguage) {
						const into = translations[language];
						if (into === undefined || sameJson(value, message)) continue;
						into[unit] = {
							value,
							sourceFingerprint,
							origin: "human",
							review: "reviewed",
							translatedFrom: target,
						};
					}
				}
		}
		if (draft.localization !== undefined) {
			draft.localization.sourceLanguage = target;
			draft.localization.translations = translations as Draft<
				AppLocalization["translations"]
			>;
		}
	});
}
