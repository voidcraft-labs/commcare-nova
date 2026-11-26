/**
 * The last stage of a reading: the claims that waited for every form, the
 * declarations the content runs on, the document where no finding stands,
 * the generated translation keys, the close, and the draft a birth applies.
 * And the reader's canonical choices: where two documents print one source, the
 * one a reading returns. The reader does not run Nova's gate: `lib/doc`'s
 * commit verdicts import `lib/commcare`, so acceptance runs it over the draft.
 */

import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { holdsUserRepeat } from "@/lib/doc/groupFieldLists";
import {
	extractLookupReferenceOccurrences,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { applyHoldPlacements } from "@/lib/doc/mutations/placements";
import {
	type DeclarationChoices,
	planDeclarationChoices,
} from "@/lib/doc/platformDeclaration";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseCreateNameFields,
	type Field,
	type LanguageTag,
	type LocalizedValue,
	type Media,
	type Module,
	makeTranslationUnitId,
	operationCaseType,
	ownCaseOperationId,
	type SelectOption,
	type TileCell,
	type TranslationEntry,
	type TranslationUnitId,
	translationSourceFingerprint,
	translationSourceFingerprintsEqual,
	type Uuid,
} from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { casePropertyShowsOptionLabels } from "@/lib/domain/caseListOrder";
import { columnPropertyCaseType } from "@/lib/domain/columnRelation";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import { formWireName } from "@/lib/domain/formWireName";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import {
	editableLanguageEntries,
	languageEntries,
} from "@/lib/domain/localization";
import { caseListColumnTextShows } from "@/lib/domain/modules";
import { PLATFORM_FEATURES } from "@/lib/domain/platforms";
import type { PlatformFeatureUse } from "@/lib/domain/platformUses";
import { isPortableName } from "@/lib/domain/portableName";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { type ProseTemplate, proseTemplateIsEmpty } from "@/lib/domain/prose";
import {
	NO_ENTRIES,
	ownRecordValue,
	recordFromEntries,
} from "@/lib/domain/records";
import {
	defaultWording,
	hasGeneratedWording,
	localizeTranslationUnit,
	snapshotTranslationUnits,
	type TranslationUnit,
	translationRoleRequiresNonblank,
} from "@/lib/domain/translationUnits";
import type { Finding, HqPlace } from "@/lib/publish/hqFindings";
import { syntheticModuleUuid } from "../emissionPlan";
import { expandAppShell } from "../expander";
import {
	effectiveWordingValue,
	presentedSearchWording,
	wordingSourceUnit,
} from "../generatedSearchWording";
import { outputLocaleRole } from "../localeFile";
import { appPlacements, placedBasic, planBasicSubcases } from "../placement";
import { placementsToHold } from "../placementHolds";
import { applicationReading, type HeldTranslationKey } from "./appShell";
import { withCandidate } from "./candidate";
import {
	calculatedAttributeColumnsArePlain,
	flagIntervalThresholdsAsRead,
} from "./caseList/columns";
import {
	columnsInListOrder,
	columnsJoinedAsRead,
	columnsOfAMenuThatListsNoCases,
	columnsOffAScreenLast,
	sortNamedHiddenColumnHeader,
} from "./caseList/details";
import { columnFieldWordsRead } from "./caseList/fieldWords";
import {
	implicitOrderRuleIsAbsent,
	orderPrioritiesAsRead,
	rulesOnTheColumnsTheyLandOn,
} from "./caseList/order";
import { withReadTexts } from "./caseList/readTexts";
import { tileColumnsShownNowhereAsRead } from "./caseList/tile";
import { catalogAsRead } from "./caseManagement/catalog";
import { caseManagementOperationsAsRead } from "./caseManagement/operationOrder";
import {
	keyedCreatesRead,
	updateBesideBareOwnAsOwnArm,
} from "./caseManagement/saveToCase";
import { account, defineClaims, derived, refuse, take } from "./claims";
import type { DraftForm, DraftModule, ReadContext } from "./context";
import { readerDefect } from "./defects";
import {
	classifyGeneratedTranslationKeys,
	type GeneratedKeyVerdict,
	generatedKeyOwner,
	type HeldGeneratedKey,
	type MediaKeyReading,
	repositionGeneratedKey,
} from "./generatedTranslationKeys";
import {
	holdText,
	hqDeviceText,
	recordTextRewrite,
	unheldRefusal,
	unheldText,
} from "./heldText";
import { readInstallationBindings } from "./installationBindings";
import { isJsonObject, pointerToken, sameJson } from "./jsonCursor";
import { resourcedDocument, sourceLanguageAsRead } from "./languages";
import {
	defaultPostSubmitAbsent,
	searchLinkGuardsAreCarriedValues,
} from "./menus/afterSubmit";
import { shownBlockMedia } from "./menus/navMedia";
import {
	parentFollowUpsReturnToTheList,
	registrationFormLast,
} from "./menus/registration";
import { appPlace, placeOrder } from "./place";
import { menuAndFormIdsAsRead, provisionalDocument } from "./provisional";
import {
	joinedGuardsSplitAsRead,
	unprintedGuardTranslationsAbsent,
} from "./search/guardSplit";
import {
	blankSearchFieldLabelsAreTheirNames,
	exactSearchModeIsAbsent,
} from "./search/prompts";
import {
	derivedConditionsAreSimpleFields,
	fieldConditionsOfAnotherFieldAreItsOwn,
	fieldConditionsOverOtherFieldsAreTheFilters,
	fieldConditionsReadingNoFieldAreTheFilters,
	filterConditionsOfAFieldAreItsOwn,
	searchesThatFindNothingAsRead,
	searchFieldPathsAreTyped,
} from "./search/rows";
import {
	defaultSearchTitleIsAbsent,
	emptySearchSettingsBesideFieldsAreAbsent,
} from "./search/settings";
import { requiredMessagesAsRead } from "./search/systemSentences";
import { namesRead } from "./structure";
import { ownWordingEntryFor, translationEntryFor } from "./translations";
import type { ReadDraft, ReadFacts } from "./types";
import {
	levelsAsRead,
	namedWorkerReadsAreProperties,
	worldPropertiesAsRead,
} from "./worldEntities";
import { connectDefaultsUnset } from "./xform/afterBinding";
import {
	blankItextFilled,
	blankOptionalTextAbsent,
	formBlankTranslations,
	messagesWithNoConditionAbsent,
} from "./xform/prose";

const A = "application-and-settings";
const TRANSLATIONS = "schema:Application.translations";
const AUTO_GPS = "schema:Application.auto_gps_capture";

const CLAIMS = defineClaims("assemble", {
	/** `auto_gps_capture` on a Connect app: Nova writes `true` from `connectType`. */
	autoGpsConnect: derived(`${A}/45-hq-auto-gps-capture`, AUTO_GPS),
	/** On an ordinary app the author chooses the app-wide setting. */
	autoGpsOther: take(
		`${A}/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app`,
		AUTO_GPS,
	),
	generatedNoEffect: account(
		`${A}/translations-generated-key-with-no-effect`,
		TRANSLATIONS,
	),
	generatedWording: take(`${A}/translations-generated-wording`, TRANSLATIONS),
	/** The app name's own wording on phones and in Web Apps, `app.display.name`: a runtime UI
	 *  string, recorded at its key as the app name's translation there is. */
	generatedDisplayName: take(
		`${A}/translations-generated-wording`,
		"ui-string:app.display.name",
	),
	generatedAnythingElse: refuse(
		`${A}/translations-generated-key-anything-else`,
		TRANSLATIONS,
	),
});

// ── The reader's canonical choices ───────────────────────────────────────

export interface ReaderCanonicalChoice {
	readonly id: string;
	/** `one-wire`: two documents print the same bytes. `not-carried`: content no export holds. */
	readonly kind: "one-wire" | "not-carried";
	readonly apply: (
		doc: BlueprintDoc,
		incumbentSource?: LanguageTag,
	) => BlueprintDoc;
}

type DraftFields = Record<Uuid, Record<string, unknown>>;

/** Each translation entry of a document, with the unit's current source fingerprint (undefined
 *  where no unit of the document has the id). */
function eachEntry(
	doc: BlueprintDoc,
	visit: (
		language: LanguageTag,
		unit: TranslationUnitId,
		current:
			| { readonly fingerprint: string; readonly source: LocalizedValue }
			| undefined,
	) => void,
): void {
	const localization = doc.localization;
	if (localization === undefined) return;
	const units = snapshotTranslationUnits(doc);
	for (const language of localization.languageOrder)
		for (const unit of Object.keys(
			languageEntries(localization, language) ?? NO_ENTRIES,
		) as TranslationUnitId[]) {
			const raw = units.get(unit);
			const current = raw && wordingSourceUnit(doc, raw);
			visit(
				language as LanguageTag,
				unit,
				current === undefined
					? undefined
					: {
							fingerprint: current.sourceFingerprint,
							source: current.generated
								? (presentedSearchWording(
										doc,
										localizeTranslationUnit(doc, language, current),
									).defaultText ?? current.source)
								: current.source,
						},
			);
		}
}

/** Whether a field's or an option's text is blank in every language: the source template and
 *  every translation of its unit. */
function blankEverywhere(
	doc: BlueprintDoc,
	template: ProseTemplate | undefined,
	unit: TranslationUnitId,
): boolean {
	if (!proseTemplateIsEmpty(template)) return false;
	for (const entries of Object.values(doc.localization?.translations ?? {})) {
		const entry = entries[unit];
		if (
			entry !== undefined &&
			!proseTemplateIsEmpty(entry.value as ProseTemplate)
		)
			return false;
	}
	return true;
}

/** The unit id of a field's label or help text, as the translation inventory names it. */
function fieldUnit(field: Uuid, slot: "label" | "help"): TranslationUnitId {
	return makeTranslationUnitId("field", field, slot);
}

/** Whether a slot's media writes a form of its itext entry: an image, an audio or a video. */
function carriesMedia(media: Media | undefined): boolean {
	return (
		media !== undefined &&
		(media.image !== undefined ||
			media.audio !== undefined ||
			media.video !== undefined)
	);
}

/** Whether a text's flag prints nothing: the text is blank in every language and its slot carries
 *  no media, so `addItext` writes no entry for it and no form of it, markdown or plain. A blank
 *  text with media is an entry whose markdown copy the flag decides. */
function flagPrintsNothing(
	doc: BlueprintDoc,
	template: ProseTemplate | undefined,
	media: Media | undefined,
	unit: TranslationUnitId,
): boolean {
	return !carriesMedia(media) && blankEverywhere(doc, template, unit);
}

export const READER_CANONICAL_CHOICES: readonly ReaderCanonicalChoice[] = [
	{
		/** A root of `fieldList` groups with no condition and no worker-added repeat, and a root of
		 *  sections, print one source; the reader returns sections. */
		id: "root-question-lists-are-sections",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				for (const formUuid of Object.keys(draft.forms) as Uuid[]) {
					const roots = draft.fieldOrder[formUuid] ?? [];
					const lists = roots.every((uuid) => {
						const field = doc.fields[uuid];
						return (
							field?.kind === "group" &&
							field.fieldList === true &&
							field.relevant === undefined &&
							!holdsUserRepeat(doc, uuid)
						);
					});
					if (roots.length === 0 || !lists) continue;
					for (const uuid of roots) {
						const group = doc.fields[uuid];
						if (group?.kind !== "group") continue;
						draft.fields[uuid] = {
							uuid,
							id: group.id,
							kind: "section",
							...(group.label === undefined ? {} : { label: group.label }),
							...(group.plainLabel === true ? { plainLabel: true } : {}),
						} as Field;
					}
				}
			}),
	},
	{
		/** HQ sees each language's effective worker text. A stale draft may
		 * carry a distinct fallback retained across a source-language change. */
		id: "out-of-date-translation-is-absent",
		kind: "one-wire",
		apply: (doc) => {
			/* An app holding no entry has none out of date. */
			const held = doc.localization;
			if (
				held === undefined ||
				(Object.keys(held.generatedSourceWording ?? {}).length === 0 &&
					Object.values(held.translations).every(
						(entries) => Object.keys(entries).length === 0,
					))
			)
				return doc;
			const units = snapshotTranslationUnits(doc);
			return withCandidate(doc, (draft) => {
				const loc = draft.localization;
				if (!loc) return;
				eachEntry(doc, (language, id, current) => {
					const raw = units.get(id);
					const unit = raw && wordingSourceUnit(doc, raw);
					const entries =
						language === loc.sourceLanguage
							? loc.generatedSourceWording
							: loc.translations[language];
					const entry = entries?.[id];
					if (!entry || !entries) return;
					if (!unit) {
						delete entries[id];
						return;
					}
					if (entry.workerFallback) {
						const effective = effectiveWordingValue(doc, language, unit);
						if (sameJson(effective, current?.source)) delete entries[id];
						else
							entries[id] = {
								value: structuredClone(effective),
								sourceFingerprint: unit.sourceFingerprint,
								origin: "human",
								review: "reviewed",
								translatedFrom: loc.sourceLanguage,
							};
					} else if (
						localizeTranslationUnit(doc, language, unit).status ===
						"out-of-date"
					)
						delete entries[id];
				});
			});
		},
	},
	{
		/** A form's text blank in one language beside another language's text, and the text a
		 *  worker reads there in its place: the export writes every language's filled text, so the
		 *  reader returns the second (`xform/prose.ts::blankItextFilled`). It runs before every
		 *  other translation row, which then reads the filled values. */
		id: "blank-itext-takes-the-filled-text",
		kind: "one-wire",
		apply: blankItextFilled,
	},
	{
		/** A translation equal to its source text, and none: the reader returns none. A generated
		 *  wording unit's own wording is no member: the emitter writes it under its key even where
		 *  it equals the text its base gives, and the reader takes it back as the unit's own
		 *  (`generatedTranslationKeys.ts`). Its blank wording is a member. */
		id: "translation-equal-to-source-is-absent",
		kind: "one-wire",
		apply: (doc) => {
			const equal: [LanguageTag, TranslationUnitId][] = [];
			const units = snapshotTranslationUnits(doc);
			eachEntry(doc, (language, unit, current) => {
				const entry = languageEntries(doc.localization, language)?.[unit];
				const generated = units.get(unit)?.generated;
				if (
					current !== undefined &&
					((sameJson(entry?.value, current.source) &&
						(generated === undefined || generated.dormant === true)) ||
						(entry?.value === "" && generated))
				)
					equal.push([language, unit]);
			});
			return withCandidate(doc, (draft) => {
				const loc = draft.localization;
				if (!loc) return;
				for (const [language, unit] of equal) {
					const entries =
						language === loc.sourceLanguage
							? loc.generatedSourceWording
							: loc.translations[language];
					if (entries) delete entries[unit];
				}
				if (!Object.keys(loc.generatedSourceWording ?? {}).length)
					delete loc.generatedSourceWording;
			});
		},
	},
	{
		/** `plainLabel` or `plainHelp` on a question's label or help text blank in every language
		 *  whose slot carries no media, and no flag: Nova writes no itext entry for such a text
		 *  (`xform/builder.ts::buildFieldParts`). An inline choice's label is no member: its item
		 *  always takes an entry, whose markdown copy the flag decides, blank or not. */
		id: "plain-flag-on-blank-text-is-absent",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				const fields = draft.fields as unknown as DraftFields;
				for (const [uuid, field] of Object.entries(doc.fields) as [
					Uuid,
					Field,
				][]) {
					const slots = field as unknown as Record<string, unknown>;
					const own = fields[uuid] as Record<string, unknown>;
					if (
						slots.plainLabel === true &&
						flagPrintsNothing(
							doc,
							slots.label as ProseTemplate | undefined,
							slots.label_media as Media | undefined,
							fieldUnit(uuid, "label"),
						)
					)
						delete own.plainLabel;
					if (
						slots.plainHelp === true &&
						flagPrintsNothing(
							doc,
							slots.help as ProseTemplate | undefined,
							slots.help_media as Media | undefined,
							fieldUnit(uuid, "help"),
						)
					)
						delete own.plainHelp;
				}
			}),
	},
	{
		/** `plainLabel` or `plainHelp` in a form holding `plainText`, and no flag: such a form
		 *  writes no markdown copy of any text. A question's flags and an inline choice's alike. */
		id: "plain-flag-under-plain-text-is-absent",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				const fields = draft.fields as unknown as DraftFields;
				const walk = (parent: Uuid) => {
					for (const uuid of doc.fieldOrder[parent] ?? []) {
						const own = fields[uuid];
						if (own !== undefined) {
							delete own.plainLabel;
							delete own.plainHelp;
							const source = own.optionsSource as
								| { kind?: string; options?: SelectOption[] }
								| undefined;
							if (source?.kind === "inline")
								for (const option of source.options ?? [])
									delete option.plainLabel;
						}
						walk(uuid);
					}
				};
				for (const [uuid, form] of Object.entries(doc.forms) as [
					Uuid,
					BlueprintDoc["forms"][Uuid],
				][])
					if (form.plainText === true) walk(uuid);
			}),
	},
	{
		/** A group, repeat or section whose label is a template with no parts in every language,
		 *  and one with no label: the reader returns no label. A label blank in the source and
		 *  held in another language prints that language's text, so it stays. */
		id: "blank-container-label-is-absent",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				const fields = draft.fields as unknown as DraftFields;
				for (const [uuid, field] of Object.entries(doc.fields) as [
					Uuid,
					Field,
				][]) {
					if (
						field.kind !== "group" &&
						field.kind !== "repeat" &&
						field.kind !== "section"
					)
						continue;
					const label = (field as { label?: ProseTemplate }).label;
					if (
						label !== undefined &&
						label.parts.length === 0 &&
						blankEverywhere(doc, label, fieldUnit(uuid, "label"))
					)
						delete (fields[uuid] as Record<string, unknown>).label;
				}
			}),
	},
	{
		/** A validation message of a question whose bind carries no constraint (no validation
		 *  condition and no check of a case name or an external id), and none: no runtime shows
		 *  such a message, so no export writes it, and the reader returns none. */
		id: "validation-message-with-no-condition-is-absent",
		kind: "not-carried",
		apply: messagesWithNoConditionAbsent,
	},
	{
		/** A current translation entry with any provenance, and the same value as a human-reviewed
		 *  translation of the current source: the reader returns the second. */
		id: "translation-provenance-is-read-as-reviewed",
		kind: "not-carried",
		apply: (doc) => {
			const source = doc.localization?.sourceLanguage;
			const current: [LanguageTag, TranslationUnitId, string][] = [];
			eachEntry(doc, (language, unit, now) => {
				const entry = languageEntries(doc.localization, language)?.[unit];
				const row = snapshotTranslationUnits(doc).get(unit);
				if (
					now !== undefined &&
					entry !== undefined &&
					(translationSourceFingerprintsEqual(
						entry.sourceFingerprint,
						now.fingerprint,
					) ||
						(row && hasGeneratedWording(row)))
				)
					current.push([language, unit, now.fingerprint]);
			});
			return withCandidate(doc, (draft) => {
				if (source === undefined) return;
				for (const [language, unit, fingerprint] of current) {
					const loc = draft.localization;
					const entry = (
						language === source
							? loc?.generatedSourceWording
							: loc?.translations[language]
					)?.[unit];
					if (entry === undefined) continue;
					entry.sourceFingerprint = fingerprint;
					entry.origin = "human";
					entry.review = "reviewed";
					entry.translatedFrom = source;
				}
			});
		},
	},
	{
		/** A generated output's own wording in any language, and the same wording fingerprinted
		 *  against the text its base gives there: an output's own wording (a person's, or an earlier
		 *  language's of its own) is never out of date, so no export carries the fingerprint, and
		 *  the reader returns the second (`caseList/readTexts.ts`,
		 *  `translations.ts::ownWordingEntryFor`). It reads the provenance the row before it settles. */
		id: "generated-wording-fingerprint-as-read",
		kind: "not-carried",
		apply: (doc) => {
			const localization = doc.localization;
			if (localization === undefined) return doc;
			const units = snapshotTranslationUnits(doc);
			const moved: [LanguageTag, TranslationUnitId, string][] = [];
			for (const language of localization.languageOrder)
				for (const [id, entry] of Object.entries(
					languageEntries(localization, language) ?? {},
				)) {
					const raw = units.get(id as TranslationUnitId);
					if (entry === undefined || raw === undefined || entry.workerFallback)
						continue;
					const unit = wordingSourceUnit(doc, raw);
					if (!hasGeneratedWording(unit)) continue;
					const own =
						language === localization.sourceLanguage ||
						entry.origin === "human" ||
						entry.translatedFrom === language;
					if (!own) continue;
					const fingerprint = translationSourceFingerprint(
						unit.valueKind,
						defaultWording(doc, language, unit),
					);
					if (entry.sourceFingerprint !== fingerprint)
						moved.push([language, id as TranslationUnitId, fingerprint]);
				}
			if (moved.length === 0) return doc;
			return withCandidate(doc, (draft) => {
				const loc = draft.localization;
				if (loc === undefined) return;
				for (const [language, id, fingerprint] of moved) {
					const entry = editableLanguageEntries(loc, language, false)?.[id];
					if (entry !== undefined) entry.sourceFingerprint = fingerprint;
				}
			});
		},
	},
	{
		/** A hint, a validation message, or a help text blank in every language, and none: the
		 *  emitter gives an unset text the template of no parts, so both print one source (no
		 *  entry, or a help text's media alone), and the reader returns none
		 *  (`xform/prose.ts::blankOptionalTextAbsent`). */
		id: "blank-optional-text-is-absent",
		kind: "one-wire",
		apply: blankOptionalTextAbsent,
	},
	{
		/** A Connect assessment's score or a deliver unit's entity id or name holding the default
		 *  an unset one takes, and unset: the emitter writes one calculate for both, and the reader
		 *  returns unset (`xform/afterBinding.ts::connectDefaultsUnset`). */
		id: "connect-defaults-are-unset",
		kind: "one-wire",
		apply: connectDefaultsUnset,
	},
	{
		/** A document whose source language is not the one a reading of its export takes, and the
		 *  same document sourced in that language, every unit's text in every language unchanged:
		 *  the reader returns the second (`languages.ts::resourcedDocument`). The language a
		 *  reading takes (`languages.ts::sourceLanguageAsRead`, over `readingSourceCode`) is the
		 *  first whose text is the source's at every place Nova's emitter writes a source text
		 *  apart from a translation (the app's name as `name` beside `app.display.name`, and Nova's
		 *  own sentences), so the two print one export: a document whose export tells its source,
		 *  as one whose app name a language before the source translates, keeps its own. */
		id: "source-language-is-as-read",
		kind: "one-wire",
		apply: (doc, incumbentSource) => {
			const source = sourceLanguageAsRead(doc, incumbentSource);
			return source === undefined ? doc : resourcedDocument(doc, source);
		},
	},
	{
		/** In a language other than the source, the app name's two strings as the export writes
		 *  them, held as a reading holds them: both alike and other than the app's name as the app
		 *  name's translation there, and every other as each string's own wording
		 *  (`appShell.ts::readTranslations`). A document holding a translation beside an own wording
		 *  of the same words, or a translation beside another own wording, prints one export with the
		 *  document the reader returns. It reads the source language the row before it settles. */
		id: "app-name-strings-as-read",
		kind: "one-wire",
		apply: (doc) => appNameStringsAsRead(doc),
	},
	{
		/** In a language other than the source, a Search guard's text joined after fields' own
		 *  validation messages, split where the reading splits the joined texts, and split anywhere
		 *  else that prints the same bytes: the reader returns the first
		 *  (`search/guardSplit.ts::joinedGuardsSplitAsRead`). It reads the source language the row
		 *  before it settles. */
		id: "joined-search-guards-split-as-read",
		kind: "one-wire",
		apply: joinedGuardsSplitAsRead,
	},
	{
		/** A translation of a search guard sentence no Search field of the app carries, and none: no
		 *  export holds it, and the reader returns none
		 *  (`search/guardSplit.ts::unprintedGuardTranslationsAbsent`). */
		id: "unprinted-search-guard-translations-are-absent",
		kind: "not-carried",
		apply: unprintedGuardTranslationsAbsent,
	},
	{
		/** A required Search field with no message of its own beside one whose own message is
		 *  Nova's sentence in the source language, and the two with the message swapped: both print
		 *  one text in every language, and the reader returns the document whose first such field,
		 *  in menu and field order, holds none (`search/systemSentences.ts::requiredMessagesAsRead`).
		 *  It reads the source language `source-language-is-as-read` settles. */
		id: "required-messages-as-read",
		kind: "one-wire",
		apply: requiredMessagesAsRead,
	},
	{
		/** A search titled "Search", Nova's default, and one with no title of its own: both print
		 *  the default title in every language, and the reader returns no title
		 *  (`search/settings.ts::defaultSearchTitleIsAbsent`). */
		id: "default-search-title-is-absent",
		kind: "one-wire",
		apply: defaultSearchTitleIsAbsent,
	},
	{
		/** A Search field whose label is blank, and the same field labelled with its name: a blank
		 *  label's translation unit takes the name as its source, so both print the name in every
		 *  language, and the reader returns the field labelled with its name
		 *  (`search/prompts.ts::blankSearchFieldLabelsAreTheirNames`). */
		id: "blank-search-field-labels-are-their-names",
		kind: "one-wire",
		apply: blankSearchFieldLabelsAreTheirNames,
	},
	{
		/** A menu with Search fields holding a settings object that sets nothing, and holding none:
		 *  both search with Nova's own settings and print one `search_config`, and the reader
		 *  returns none (`search/settings.ts::emptySearchSettingsBesideFieldsAreAbsent`). It reads
		 *  what `default-search-title-is-absent` leaves. */
		id: "empty-search-settings-beside-fields-are-absent",
		kind: "one-wire",
		apply: emptySearchSettingsBesideFieldsAreAbsent,
	},
	{
		/** A simple Search field naming as its mode the one its widget takes when it names none
		 *  (exact matching, for a text, date, barcode or choice widget), and the same field naming
		 *  no mode: every print reads the widget's default, so both print one source, and the
		 *  reader returns no mode (`search/prompts.ts::exactSearchModeIsAbsent`). */
		id: "exact-search-mode-is-absent",
		kind: "one-wire",
		apply: exactSearchModeIsAbsent,
	},
	{
		/** A registration a list offers after an empty search, anywhere among its menu's forms,
		 *  and last: the form is on no menu either way, so the reader returns it last. */
		id: "registration-form-last",
		kind: "one-wire",
		apply: registrationFormLast,
	},
	{
		/** A `required` condition on a question that names a case the form creates and is no
		 *  Hidden Value, and none: the emitter writes `required="true()"` on that bind whatever
		 *  the slot holds (`xform/builder.ts::buildFieldParts`), so the reader returns none. */
		id: "create-name-required-is-absent",
		kind: "one-wire",
		apply: (doc) => {
			const names: Uuid[] = [];
			for (const formUuid of Object.keys(doc.forms) as Uuid[])
				for (const uuid of caseCreateNameFields(doc, formUuid, {
					placedBasic: placedBasic(doc, formUuid),
				})) {
					const field = doc.fields[uuid];
					if (
						field !== undefined &&
						field.kind !== "hidden" &&
						"required" in field
					)
						names.push(uuid);
				}
			return withCandidate(doc, (draft) => {
				for (const uuid of names)
					delete (draft.fields[uuid] as { required?: unknown }).required;
			});
		},
	},
	{
		/** A form with no destinations storing its own default after-submit, and storing none:
		 *  both print one workflow word, and the reader returns none. */
		id: "default-post-submit-is-absent",
		kind: "one-wire",
		apply: defaultPostSubmitAbsent,
	},
	{
		/** A link into a menu whose forms read the search that carries no value and whose
		 *  condition ends with the held-case guards of the values automatic matching carries, and
		 *  the link that carries those values by hand: both print one link, and the reader
		 *  returns the one that carries them. */
		id: "search-link-guards-are-carried-values",
		kind: "one-wire",
		apply: searchLinkGuardsAreCarriedValues,
	},
	{
		/** An advanced Search field whose condition is a simple field's derivation, where the rows
		 *  come out in one order either way, and that simple field: both print one search, and
		 *  the reader returns the simple field. */
		id: "derived-search-conditions-are-simple-fields",
		kind: "one-wire",
		apply: derivedConditionsAreSimpleFields,
	},
	{
		/** A simple Search field whose path names the case type each step reaches, and the same
		 *  field whose steps name none where the catalog resolves each to that type: both derive one
		 *  search row, and the reader returns the typed path
		 *  (`search/rows.ts::searchFieldPathsAreTyped`). */
		id: "search-field-paths-are-typed",
		kind: "one-wire",
		apply: searchFieldPathsAreTyped,
	},
	{
		/** A search one of whose sources is never true, which sends HQ the one row `match-none()`,
		 *  and the same search whose excluded fields are advanced fields with no condition, the first
		 *  holding `match-none` where a field's condition sent it: both print one search, and the
		 *  reader returns the second (`search/rows.ts::searchesThatFindNothingAsRead`). */
		id: "searches-that-find-nothing-as-read",
		kind: "one-wire",
		apply: searchesThatFindNothingAsRead,
	},
	{
		/** A searched list filter's conjunct that reads Search fields and prints nothing in the
		 *  list's own filter, and the same conjunct as the condition of
		 *  the first field it reads where that field is an advanced one: both print one row and no
		 *  clause of the list's own filter, and the reader returns the field's
		 *  (`search/rows.ts::filterConditionsOfAFieldAreItsOwn`). */
		id: "search-filter-conditions-of-a-field-are-its-own",
		kind: "one-wire",
		apply: filterConditionsOfAFieldAreItsOwn,
	},
	{
		/** A conjunct of an advanced Search field's condition that reads Search fields, the first
		 *  of them another advanced field, and the same conjunct as that
		 *  field's condition's last, where the search's rows come out the same: both print one
		 *  export, and the reader returns the first field's
		 *  (`search/rows.ts::fieldConditionsOfAnotherFieldAreItsOwn`). */
		id: "search-field-conditions-of-another-field-are-its-own",
		kind: "one-wire",
		apply: fieldConditionsOfAnotherFieldAreItsOwn,
	},
	{
		/** A conjunct of an advanced Search field's condition that reads Search fields, the first
		 *  of them no advanced field, that prints nothing in the list's
		 *  own filter, and the same conjunct as the searched list filter's last clause, where the
		 *  search's rows come out the same: both print one row and no clause of the list's own
		 *  filter, and the reader returns the list filter's
		 *  (`search/rows.ts::fieldConditionsOverOtherFieldsAreTheFilters`). */
		id: "search-field-conditions-over-other-fields-are-the-filter-s",
		kind: "one-wire",
		apply: fieldConditionsOverOtherFieldsAreTheFilters,
	},
	{
		/** On a menu whose forms read the search, a conjunct of an advanced Search field's
		 *  condition that reads no Search field, and the same conjunct as the list filter's last
		 *  clause, where a device's list filter prints the same with it joined and the search's
		 *  rows come out the same: both print one export, and the reader returns the list
		 *  filter's (`search/rows.ts::fieldConditionsReadingNoFieldAreTheFilters`). */
		id: "search-field-conditions-reading-no-field-are-the-filter-s",
		kind: "one-wire",
		apply: fieldConditionsReadingNoFieldAreTheFilters,
	},
	{
		/** A tile cell no wire writes (on a list with no tile, or on a column hidden from Results
		 *  in a tile list, `modules.ts::tileCellFor`) prints nothing; the reader returns the
		 *  document without it. */
		id: "dormant-tile-cells",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				for (const module of Object.values(draft.modules)) {
					const config = module.caseListConfig;
					if (config === undefined) continue;
					for (const column of config.columns)
						if (config.tile === undefined || column.visibleInList === false)
							delete column.tile;
				}
			}),
	},
	{
		/** A tile cell's border or shading switched off, and none: HQ keeps an off switch as no
		 *  switch and both wires write neither (`suite/case-list/tileStyle.ts::storedTileCell`), so
		 *  the reader returns none, on the case list's cells and the case detail's alike. */
		id: "tile-switches-off-are-absent",
		kind: "one-wire",
		apply: (doc) => {
			const off = (cell: TileCell | undefined) =>
				cell !== undefined &&
				(cell.showBorder === false || cell.showShading === false);
			const holds = Object.values(doc.modules).some((module) => {
				const config = module.caseListConfig;
				return (
					config !== undefined &&
					(config.columns.some((column) => off(column.tile)) ||
						Object.values(config.detailTile?.cells ?? {}).some(off))
				);
			});
			if (!holds) return doc;
			const clear = (cell: TileCell | undefined) => {
				if (cell?.showBorder === false) delete cell.showBorder;
				if (cell?.showShading === false) delete cell.showShading;
			};
			return withCandidate(doc, (draft) => {
				for (const module of Object.values(draft.modules)) {
					const config = module.caseListConfig;
					if (config === undefined) continue;
					for (const column of config.columns) clear(column.tile);
					for (const cell of Object.values(config.detailTile?.cells ?? {}))
						clear(cell);
				}
			});
		},
	},
	{
		/** A menu's own tile kept above forms beside another menu's tile expanded there, and the
		 *  same with no switch stored: the wire switches this menu's persistence on beside every
		 *  such tile (`hqJson/caseList.ts`), so both print one export, and the document means the
		 *  same either way (`caseFormContext.ts::resolveCaseFormContext`); the reader reads the
		 *  switch as the source's setting and returns none (`caseList/details.ts::
		 *  persistHeldByExternalPullDown`). */
		id: "own-tile-persistence-beside-an-expanded-menu-tile-is-absent",
		kind: "one-wire",
		apply: (doc) => {
			const held = (module: Module | undefined) => {
				const config = module?.caseListConfig;
				const context = config?.contextAboveForm;
				if (
					config?.tile?.persistOnForms !== true ||
					context?.kind !== "menu-tile" ||
					context.expandDetails !== true
				)
					return false;
				const source = doc.modules[context.moduleUuid];
				return (
					source?.caseListConfig?.tile !== undefined &&
					source.caseType === module?.caseType
				);
			};
			const menus = Object.values(doc.modules).filter(held);
			if (menus.length === 0) return doc;
			return withCandidate(doc, (draft) => {
				for (const { uuid } of menus) {
					const tile = draft.modules[uuid]?.caseListConfig?.tile;
					if (tile !== undefined) delete tile.persistOnForms;
				}
			});
		},
	},
	{
		/** A list filter that simplifies to `match-all`, and none: `effectiveFilterForEmission` is
		 *  every print's one reading of a filter, and it gives none for such a filter, so both print
		 *  one source and the reader returns none. */
		id: "match-all-list-filter-is-absent",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				for (const module of Object.values(draft.modules)) {
					const config = module.caseListConfig;
					if (
						config?.filter !== undefined &&
						effectiveFilterForEmission(config.filter) === undefined
					)
						delete config.filter;
				}
			}),
	},
	{
		/** A list action opening a selected parent's follow-up, storing either return, prints
		 *  `case_list`; the reader returns `case-list`
		 *  (`menus/registration.ts::parentFollowUpsReturnToTheList`). */
		id: "parent-follow-ups-return-to-the-list",
		kind: "one-wire",
		apply: parentFollowUpsReturnToTheList,
	},
	{
		/** An order rule whose element is a property element, which HQ joins to another column,
		 *  prints the element that column's own rule prints; the reader returns each such rule on
		 *  the column it lands on (`caseList/order.ts::rulesOnTheColumnsTheyLandOn`). A positional
		 *  element names the column its rule is on, so that rule stays where it is. */
		id: "order-rules-on-the-columns-they-land-on",
		kind: "one-wire",
		apply: rulesOnTheColumnsTheyLandOn,
	},
	{
		/** A list whose one rule is the rule a list with no rule writes, and the list with no rule:
		 *  both print one sort element, and the reader returns no rule
		 *  (`caseList/order.ts::implicitOrderRuleIsAbsent`). */
		id: "implicit-order-rule-is-absent",
		kind: "one-wire",
		apply: implicitOrderRuleIsAbsent,
	},
	{
		/** A list whose rules hold numbers other than 0, 1, 2 in their order, and the list
		 *  numbered so: no export writes a rule's number, only the order of the rules, and the
		 *  reader numbers the rules it reads from 0 (`caseList/order.ts::orderPrioritiesAsRead`). */
		id: "order-priorities-as-read",
		kind: "one-wire",
		apply: orderPrioritiesAsRead,
	},
	{
		/** In a tile list a column hidden from Results and from Details, as authored, and as a
		 *  reading gives it: only its order rule reaches an export, so the reader returns a plain
		 *  such column with no header, last in the order of its rule, and none for one whose rule
		 *  is written nowhere (`caseList/tile.ts::tileColumnsShownNowhereAsRead`). */
		id: "tile-columns-shown-nowhere-are-as-read",
		kind: "not-carried",
		apply: tileColumnsShownNowhereAsRead,
	},
	{
		/** In a tile list a column hidden from Results with no order rule is no field, with or
		 *  without `notOnList`; the reader returns the one that holds it, which stays true if the
		 *  tile is turned off. */
		id: "unsorted-hidden-tile-columns-are-off-the-list",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				for (const module of Object.values(draft.modules)) {
					const config = module.caseListConfig;
					if (config?.tile === undefined) continue;
					for (const column of config.columns)
						if (
							column.visibleInList === false &&
							column.visibleInDetail !== false &&
							column.sort === undefined
						)
							column.notOnList = true;
				}
			}),
	},
	{
		/** The columns of a menu that lists no cases: such a menu is written the pair every new menu
		 *  holds in CommCare HQ, whatever its list holds, so the reader returns the one name column
		 *  on both screens that pair reads as
		 *  (`caseList/details.ts::columnsOfAMenuThatListsNoCases`). */
		id: "columns-of-a-menu-that-lists-no-cases-are-its-one-name-column",
		kind: "not-carried",
		apply: columnsOfAMenuThatListsNoCases,
	},
	{
		/** A column off the detail or off the list (one the short detail holds no field for, a
		 *  column hidden from Results in a tile list included), anywhere in that screen's order, and
		 *  the same column after the screen's own columns: neither detail holds a place for a column
		 *  it does not show, so the reader returns each such column last, in the other screen's
		 *  order, and on the list each column no screen shows after those Details shows
		 *  (`caseList/details.ts::columnsOffAScreenLast`). */
		id: "columns-off-a-screen-last-in-its-order",
		kind: "one-wire",
		apply: columnsOffAScreenLast,
	},
	{
		/** A calculated column that reads one of its case's attributes, and the plain column over
		 *  that attribute: both print `@<name>` with the `plain` format, and the reader returns the
		 *  plain one (`caseList/columns.ts::calculatedAttributeColumnsArePlain`). It runs before
		 *  `columns-joined-as-read`, which gives the column the identity a re-read gives it. */
		id: "calculated-attribute-columns-are-plain",
		kind: "one-wire",
		apply: calculatedAttributeColumnsArePlain,
	},
	{
		/** An interval column that shows its text only past its threshold, and the same column with
		 *  the threshold in another unit of as many days: both print the threshold as days alone,
		 *  and the reader returns the first unit in which those days are whole
		 *  (`caseList/columns.ts::flagIntervalThresholdsAsRead`). */
		id: "flag-interval-thresholds-as-read",
		kind: "one-wire",
		apply: flagIntervalThresholdsAsRead,
	},
	{
		/** A list whose short detail's fields join other columns of the long detail than their own,
		 *  and the list that join gives: neither detail prints a column's identity, so the reader
		 *  pairs them by print, a field hidden from Results by its property and its header, and returns the
		 *  joined list (`caseList/details.ts::columnsJoinedAsRead`). It reads the orders
		 *  `columns-off-a-screen-last-in-its-order` gives. */
		id: "columns-joined-as-read",
		kind: "one-wire",
		apply: columnsJoinedAsRead,
	},
	{
		/** A column hidden from Results and from Details whose own order rule names it in Sort by,
		 *  with any header, and with that name as its header: the name is written where its header
		 *  would stand and the header nowhere, so the reader returns the name as its header
		 *  (`caseList/details.ts::sortNamedHiddenColumnHeader`). It reads the columns
		 *  `columns-joined-as-read` gives. */
		id: "sort-named-hidden-column-header-is-its-name",
		kind: "not-carried",
		apply: sortNamedHiddenColumnHeader,
	},
	{
		/** A case list's `columns` array in any order, and in its list order: the array is a set,
		 *  read through the two order arrays by every projection, so both print one source, and the
		 *  reader returns the array in the order it joins the details, its list order
		 *  (`caseList/details.ts::columnsInListOrder`). It reads the list order
		 *  `columns-off-a-screen-last-in-its-order` gives. */
		id: "columns-in-list-order",
		kind: "one-wire",
		apply: columnsInListOrder,
	},
	{
		/** A document's catalog as authored, and the catalog the reader derives from the same
		 *  document: the emitter reads a property's type through `effectiveCaseTypes`, and a label
		 *  and a property nothing reads reach no export, so the reader returns the derived one. An
		 *  app with no case type holds no catalog, as a new app does (`emptyBlueprintDoc`), and an
		 *  empty one prints the same bytes, so the document a birth builds from the construction
		 *  batch is the one the reader returns. */
		id: "case-catalog-is-as-read",
		kind: "one-wire",
		apply: (doc) => {
			const caseTypes = catalogAsRead(doc);
			const emittedTypes = effectiveCaseTypes(doc);
			return withCandidate(doc, (draft) => {
				for (const mod of Object.values(draft.modules)) {
					for (const column of mod.caseListConfig?.columns ?? []) {
						if (column.kind !== "plain") continue;
						const owner = columnPropertyCaseType(
							column,
							mod.caseType,
							doc.caseTypes ?? [],
						);
						const readType = caseTypes
							.find((type) => type.name === owner)
							?.properties.find((p) => p.name === column.field)?.data_type;
						const emitted = emittedTypes
							.find((type) => type.name === owner)
							?.properties.find((p) => p.name === column.field);
						// A shown raw property keeps its value display when the catalog subsequently gains labels.
						if (
							caseListColumnTextShows(column) &&
							(readType === "single_select" || readType === "multi_select") &&
							(column.showChoice === "saved-value" ||
								!casePropertyShowsOptionLabels(emitted))
						)
							column.showChoice = "saved-value";
						else delete column.showChoice;
					}
				}
				draft.caseTypes =
					caseTypes.length === 0 ? null : (caseTypes as typeof draft.caseTypes);
			});
		},
	},
	{
		/** A save to the case above whose `parent` step names the type it reaches, and one whose
		 *  step names none: both resolve to the catalog's `parent_type` and print one update key
		 *  (`parent/<property>`), so the reader returns every step typed. */
		id: "write-via-steps-are-typed",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				for (const [formUuid, form] of Object.entries(draft.forms)) {
					const moduleUuid = moduleUuidOfForm(doc, formUuid as Uuid);
					const origin =
						moduleUuid === undefined
							? undefined
							: doc.modules[moduleUuid]?.caseType;
					if (origin === undefined) continue;
					for (const operation of form.caseOperations ?? []) {
						if (operation.action !== "own") continue;
						for (const write of operation.writes ?? []) {
							let at: string | undefined = origin;
							for (const step of write.via ?? []) {
								if (step.throughCaseType === undefined && at !== undefined) {
									const parent = doc.caseTypes?.find(
										(type) => type.name === at,
									)?.parent_type;
									if (step.identifier === "parent" && parent !== undefined)
										step.throughCaseType = parent;
								}
								at = step.throughCaseType;
							}
						}
					}
				}
			}),
	},
	{
		/** A case a form opens (a create, or a registration's own case) owned by the acting user,
		 *  and one with no owner: every placement gives an opened case with no owner the worker
		 *  (`xform/caseOps.ts` writes `/data/meta/userID`, `generatedNodes.ts::advancedOwnerNodeValue`
		 *  reads none as the acting user, and HQ's build sets a basic action's owner so), so both
		 *  print one source and the reader returns no owner. */
		id: "opened-case-owner-acting-user-is-absent",
		kind: "one-wire",
		apply: (doc) =>
			withCandidate(doc, (draft) => {
				for (const form of Object.values(draft.forms))
					for (const operation of form.caseOperations ?? []) {
						const opens =
							operation.action === "create" ||
							(operation.action === "own" && form.type === "registration");
						const held = operation as { owner?: { readonly kind: string } };
						if (opens && held.owner?.kind === "acting-user") delete held.owner;
					}
			}),
	},
	{
		/** An update of the session's case beside a follow-up's own arm that changes nothing, named
		 *  with the id a reading gives that bare own arm, and the form's own arm in a block of that
		 *  name: both print the block beside a basic block that writes nothing, and the reader
		 *  returns the own arm (`caseManagement/saveToCase.ts::updateBesideBareOwnAsOwnArm`). */
		id: "update-beside-a-bare-own-arm-is-the-own-arm",
		kind: "one-wire",
		apply: updateBesideBareOwnAsOwnArm,
	},
	{
		/** A case operation a slot of Case Management keeps (the own arm, a child case and the close
		 *  that shares its place, the worker's record) under any id, and under the id
		 *  `basicSlotOperationIdsAsRead` gives it: HQ's form actions name no operation, and the
		 *  emitter names no node by such an operation's id, so both print one source and the reader
		 *  returns the derived id. */
		id: "basic-slot-operation-ids-are-derived",
		kind: "one-wire",
		apply: basicSlotOperationIdsAsRead,
	},
	{
		/** A form's case operations in any order Case Management's lists and Save to Case's
		 *  blocks print alike, and an advanced action's operation under any id, and the same
		 *  in the order and under the ids a reading gives them: HQ's form actions keep their
		 *  own list order and name no operation, so both print one source and the reader
		 *  returns its own (`caseManagement/operationOrder.ts`). */
		id: "case-management-operations-in-reading-order",
		kind: "one-wire",
		apply: caseManagementOperationsAsRead,
	},
	{
		/** A document holding a placement its emission derives and one holding none: holding what
		 *  the emission derives changes no byte (`lib/commcare/__tests__/heldPlacementEmission.test.ts`), and a
		 *  reading holds every placement it reads, a query repeat's included, so the reader returns
		 *  the document holding every one `placementsToHold` gives. */
		id: "unheld-placements-are-held",
		kind: "one-wire",
		apply: (doc) => {
			const holds = [...placementsToHold(doc)];
			return withCandidate(doc, (draft) => {
				if (holds.length > 0)
					applyHoldPlacements(draft, { kind: "holdPlacements", holds });
			});
		},
	},
	{
		/** A menu's or a form's purpose note, and none: purpose notes are outside the wire
		 *  inventory, so the reader returns none. */
		id: "purpose-notes-are-absent",
		kind: "not-carried",
		apply: (doc) => {
			const noted = (record: Record<Uuid, { purpose?: string }>) =>
				Object.values(record).some((one) => one.purpose !== undefined);
			if (!noted(doc.modules) && !noted(doc.forms)) return doc;
			return withCandidate(doc, (draft) => {
				for (const module of Object.values(draft.modules))
					delete module.purpose;
				for (const form of Object.values(draft.forms)) delete form.purpose;
			});
		},
	},
	{
		/** An app's logo, and none: a publish writes no `logo_refs`, and a logo reaches an app on
		 *  CommCare HQ only when a person adds it there, so the reader returns none. The local
		 *  archive's profile names it under HQ's Web Apps banner key
		 *  (`multimedia/logoEntry.ts::buildLogoProfileProperty`), which no runtime that installs a
		 *  `.ccz` reads: Android reads only its login and home banners. */
		id: "app-logo-is-absent",
		kind: "not-carried",
		apply: (doc) =>
			doc.logo === undefined
				? doc
				: withCandidate(doc, (draft) => {
						delete draft.logo;
					}),
	},
	{
		/** A menu's and a form's id as authored, and the id a reading mints: no export carries
		 *  either, so the reader returns the slug of each one's name in reading order
		 *  (`provisional.ts::menuAndFormIdsAsRead`). It reads the names the source language row
		 *  settles and the form order `registration-form-last` gives. */
		id: "menu-and-form-ids-as-read",
		kind: "not-carried",
		apply: menuAndFormIdsAsRead,
	},
	{
		/** A worker field the logic reads by name that no worker property names, and the read of a
		 *  worker property of that slug, labelled with it: both print one source, and the reader
		 *  returns the second, minting the property as a re-read of the app does and reading each
		 *  read by name of its slug as the property, as the gate holds a declared slug's read
		 *  (`worldEntities.ts::namedWorkerReadsAreProperties`). */
		id: "worker-fields-read-by-name-are-properties",
		kind: "one-wire",
		apply: namedWorkerReadsAreProperties,
	},
	{
		/** A worker or location property as authored, and as a reading gives it: no export carries
		 *  either, only the slug a read prints, so the reader returns each property the logic reads
		 *  labelled with its slug, with no choices and no requirement, in the order of the slugs,
		 *  and none that nothing reads (`worldEntities.ts::worldPropertiesAsRead`). It runs after
		 *  `worker-fields-read-by-name-are-properties`. */
		id: "world-properties-as-read",
		kind: "not-carried",
		apply: worldPropertiesAsRead,
	},
	{
		/** The organization's levels as authored, and as a reading of CommCare HQ's list gives
		 *  them: the export carries no level, and the list says only each level's code, name,
		 *  parent, whether it shares cases and whether it views descendants, so the reader returns
		 *  levels that hold workers, reach all or none of their descendant cases, see their own
		 *  branch and stand parent before child (`worldEntities.ts::levelsAsRead`). */
		id: "organization-levels-as-read",
		kind: "not-carried",
		apply: levelsAsRead,
	},
];

/**
 * `doc` with each case operation a slot of Case Management keeps named as a reading names it:
 * `ownCaseOperationId` of its case type, in the order the reading meets the slots (the own arm,
 * then each child case in `subcases` order followed by the close that shares its place, then the
 * worker's record), free among the ids the form's other operations hold, which their blocks carry.
 */
function basicSlotOperationIdsAsRead(doc: BlueprintDoc): BlueprintDoc {
	const renames = new Map<Uuid, Map<Uuid, string>>();
	for (const [formUuid, { placements }] of appPlacements(doc)) {
		const operations = doc.forms[formUuid]?.caseOperations ?? [];
		const basic = (uuid: Uuid) =>
			placements.get(uuid)?.placement.kind === "basic";
		const ordered: CaseOperation[] = [];
		const own = operations.find(
			(one) => one.action === "own" && basic(one.uuid),
		);
		if (own !== undefined) ordered.push(own);
		for (const subcase of planBasicSubcases(doc, formUuid)) {
			const create = operations.find(
				(one) => one.uuid === subcase.operationUuid,
			);
			if (create === undefined || !basic(create.uuid)) continue;
			ordered.push(create);
			for (const close of operations)
				if (
					close.action === "close" &&
					placements.get(close.uuid)?.sharesWith === create.uuid
				)
					ordered.push(close);
		}
		const worker = operations.find((one) => {
			const placement = placements.get(one.uuid)?.placement;
			return placement?.kind === "basic" && placement.slot === "usercase";
		});
		if (worker !== undefined) ordered.push(worker);

		const named = new Set(ordered.map((one) => one.uuid));
		const taken = new Set(
			operations.filter((one) => !named.has(one.uuid)).map((one) => one.id),
		);
		const ids = new Map<Uuid, string>();
		for (const operation of ordered) {
			const caseType = operationCaseType(doc, formUuid, operation);
			if (caseType === undefined || caseType === "") continue;
			const id = ownCaseOperationId(caseType, taken);
			taken.add(id);
			if (id !== operation.id) ids.set(operation.uuid, id);
		}
		if (ids.size > 0) renames.set(formUuid, ids);
	}
	if (renames.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const [formUuid, ids] of renames)
			for (const operation of draft.forms[formUuid]?.caseOperations ?? []) {
				const id = ids.get(operation.uuid);
				if (id !== undefined) operation.id = id;
			}
	});
}

// ── Translations ─────────────────────────────────────────────────────────

// ── Generated translation keys ───────────────────────────────────────────

/** A key's place among the document's menus and forms: the position each stands at among those
 *  that got a draft, or undefined where the key names none of them. */
interface KeyTarget {
	readonly module: DraftModule | undefined;
	readonly form: DraftForm | undefined;
	readonly position:
		| { readonly menu: number; readonly form?: number }
		| undefined;
}

function keyTarget(
	ctx: ReadContext,
	doc: BlueprintDoc,
	key: string,
): KeyTarget {
	const owner = generatedKeyOwner(key);
	if (owner.kind === "app")
		return { module: undefined, form: undefined, position: undefined };
	const module = ctx.draft.modules.find((one) => one.index === owner.menu);
	const folded = ctx.draft.foldedMenus.find((one) => one.menu === module);
	const host = folded === undefined ? module?.uuid : folded.hostUuid;
	const menu = host === undefined ? -1 : doc.moduleOrder.indexOf(host);
	if (owner.kind === "menu")
		return {
			module,
			form: undefined,
			position: folded === undefined && menu >= 0 ? { menu } : undefined,
		};
	const form = module?.forms.find((one) => one.index === owner.form);
	const at =
		host === undefined || form === undefined
			? -1
			: (doc.formOrder[host] ?? []).indexOf(form.uuid);
	return {
		module,
		form,
		position: menu >= 0 && at >= 0 ? { menu, form: at } : undefined,
	};
}

/** Whether what a key names read: its menu and its form have drafts. A key naming a position
 *  HQ's app holds no menu or form at names nothing that failed to read, and keeps its own
 *  spelling, which no string of the table has. */
function readWhole(ctx: ReadContext, key: string, target: KeyTarget): boolean {
	const owner = generatedKeyOwner(key);
	if (owner.kind === "app") return true;
	const menu = ctx.input.source.modules[owner.menu];
	if (menu === undefined) return true;
	if (target.module === undefined) return false;
	if (owner.kind === "menu") return true;
	return menu.forms[owner.form] === undefined || target.form !== undefined;
}

/** The finding a key stands under where what it names did not read whole, else undefined. */
function coveringFinding(
	ctx: ReadContext,
	findings: readonly Finding[],
	held: HeldTranslationKey,
	target: KeyTarget,
): Finding | undefined {
	const languages = applicationReading(ctx)?.languages;
	const refused = languages?.refused.get(held.language);
	if (refused !== undefined) return refused;
	const owner = generatedKeyOwner(held.key);
	if (owner.kind === "app") return undefined;
	const sorted = [...findings].sort((a, b) => placeOrder(a.place, b.place));
	const atMenu = sorted.find(
		(finding) =>
			(finding.place.kind === "menu" ||
				finding.place.kind === "case-list" ||
				finding.place.kind === "case-detail" ||
				finding.place.kind === "search") &&
			finding.place.menu === owner.menu,
	);
	if (target.module === undefined || owner.kind === "menu") return atMenu;
	// A form of a menu that read: the finding at that form, which stands where the form got no
	// draft. A form position HQ's app holds no form at has none, and its key is classified.
	return sorted.find(
		(finding) =>
			finding.place.kind === "form" &&
			finding.place.menu === owner.menu &&
			finding.place.form === owner.form,
	);
}

/** The formats whose column HQ's build gives an `<alt_text>` read from the app strings
 *  (`detail_screen.py::EnumImage.alt_text`, which `ClickableIcon` extends). */
const ALT_TEXT_FORMATS: ReadonlySet<unknown> = new Set([
	"enum-image",
	"clickable-icon",
]);

/**
 * What CommCare HQ's build of the app as stored reads under `one`'s key where the key names a
 * string a media map or an image map writes (`generatedTranslationKeys.ts::MediaKeyReading`),
 * read from the source's menus by the key's own positions; undefined for any other key.
 *
 * - A menu's, a form's, a case list menu item's and a Register button's icon and audio
 *   (`id_strings.py::module_icon_locale`, `form_icon_locale`, `case_list_icon_locale`,
 *   `case_list_form_icon_locale` and their audio twins): the suite reads the key only where some
 *   language holds a path of its own (`NavMenuItemMediaMixin.uses_image`, `uses_audio`), and a
 *   language shows the path `menus/navMedia.ts::shownNavMedia` gives it.
 * - An image map's alt text (`id_strings.py::detail_column_alt_text_variable`): every image map
 *   and clickable icon column reads one per mapping key, and the reader holds no alt text but a
 *   blank one (`caseList/columns.ts::claimAltText`), so where the key's menu lists such a column
 *   the key is read; where it lists none, no screen reads it. Whether the key names one of that
 *   menu's mapping keys is not told apart, so an override of a key no column names, in a menu
 *   that holds an image map, is refused with the rest.
 * - The search again button's icon and audio (`case_search_again.m#.again.icon`,
 *   `case_search.m#.again.audio`) have no reader in HQ's build and no string it writes, so the
 *   table's rule (no string of this app) holds them inert.
 */
function mediaKeyReading(
	modules: unknown,
	langs: readonly string[],
	one: HeldGeneratedKey,
): MediaKeyReading | undefined {
	const owner = generatedKeyOwner(one.key);
	if (owner.kind === "app") return undefined;
	const menu = Array.isArray(modules) ? modules[owner.menu] : undefined;
	const block = (value: unknown) =>
		isJsonObject(value)
			? (value as Readonly<Record<string, unknown>>)
			: NO_ENTRIES;
	const shows = (
		holder: Readonly<Record<string, unknown>>,
		key: "media_image" | "media_audio",
	): MediaKeyReading => {
		const shown = shownBlockMedia((name) => holder[name], key, langs);
		// A map holding a value that is no path is the media reader's to refuse; the override
		// waits with it.
		if (shown === undefined) return { kind: "read" };
		if (Object.values(shown).every((path) => path === ""))
			return { kind: "unread" };
		return { kind: "shows", value: shown[one.language] ?? "" };
	};
	const mediaOf = (holder: unknown, prefix: string) => {
		if (one.key === `${prefix}.icon`)
			return shows(block(holder), "media_image");
		if (one.key === `${prefix}.audio`)
			return shows(block(holder), "media_audio");
		return undefined;
	};
	if (owner.kind === "form") {
		const forms = block(menu).forms;
		return mediaOf(
			Array.isArray(forms) ? forms[owner.form] : undefined,
			`forms.m${owner.menu}f${owner.form}`,
		);
	}
	const own =
		mediaOf(menu, `modules.m${owner.menu}`) ??
		mediaOf(block(menu).case_list, `case_lists.m${owner.menu}`) ??
		mediaOf(block(menu).case_list_form, `case_list_form.m${owner.menu}`);
	if (own !== undefined) return own;
	const segments = one.key.split(".");
	if (segments[0] !== `m${owner.menu}` || segments.at(-2) !== "alt_text")
		return undefined;
	const details = block(block(menu).case_details);
	const imageMaps = ["short", "long"].some((detail) => {
		const columns = block(details[detail]).columns;
		return (
			Array.isArray(columns) &&
			columns.some((column) => ALT_TEXT_FORMATS.has(block(column).format))
		);
	});
	return imageMaps ? { kind: "read" } : { kind: "unread" };
}

/**
 * `doc` under the declaration the reading proposes: the proposed choice's mutations (where the app
 * runs, and each date-and-time question split where the choice splits them) applied, which is the
 * document Nova's gate judges the reading as. A document that declares nothing runs on both
 * platforms, so content only one of them runs (a list choosing several cases, `here()` in a
 * calculated column, a read of the case list's search text) is one the gate refuses until the
 * declaration is written. Where no declaration runs the content, `doc` as it stands, which the
 * declaration's findings already hold.
 */
function underProposedDeclaration(
	doc: BlueprintDoc,
	declaration: DeclarationChoices,
): BlueprintDoc {
	if (declaration.kind !== "choices") return doc;
	const choice = declaration.choices[declaration.proposed];
	if (choice === undefined || choice.mutations.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		applyMutations(draft, choice.mutations);
		// The index is derived state the reader's documents never hold.
		delete draft.refIndex;
	});
}

/**
 * Decides every generated translation key in the reading that meets it: each stands under
 * a finding where what it names did not read whole, and every other is classified against the
 * strings Nova's build makes of `doc` under the declaration the reading proposes
 * (`underProposedDeclaration`), a media key against what CommCare HQ's build of the stored app
 * shows (`mediaKeyReading`), and claimed by its verdict. A wording is written as its unit's own text
 * in that language. Returns whether a key was a wording.
 */
function decideGeneratedKeys(
	ctx: ReadContext,
	doc: BlueprintDoc,
	declaration: DeclarationChoices,
): boolean {
	const reading = applicationReading(ctx);
	if (reading === undefined || reading.generatedKeys.length === 0) return false;
	const findings = ctx.accounting.findings();
	const left: { held: HeldTranslationKey; target: KeyTarget }[] = [];
	for (const held of reading.generatedKeys) {
		const target = keyTarget(ctx, doc, held.key);
		const finding = coveringFinding(ctx, findings, held, target);
		if (finding !== undefined) {
			ctx.accounting.cover({ json: held.json, key: held.key }, finding);
			continue;
		}
		left.push({ held, target });
	}
	if (left.length === 0) return false;
	const table = ctx.input.appStrings(
		underProposedDeclaration(doc, declaration),
		columnFieldWordsRead(ctx, doc),
	);
	if (table === null) {
		const first = [...findings].sort((a, b) => placeOrder(a.place, b.place))[0];
		if (first === undefined)
			throw new Error(
				"The reader read this app with no finding and built a document Nova's gate refuses, so the app's strings could not be built. A reading with no finding should be a document the gate admits. Run the gate over the reading's document to see which rule refuses it, then look at the reader stage that set that slot.",
			);
		for (const { held } of left)
			ctx.accounting.cover({ json: held.json, key: held.key }, first);
		return false;
	}
	const classified: HeldGeneratedKey[] = [];
	for (const { held } of left) {
		if (typeof held.value !== "string") continue;
		const target = keyTarget(ctx, doc, held.key);
		if (!readWhole(ctx, held.key, target)) continue;
		classified.push({
			language: held.language,
			key: held.key,
			id:
				target.position === undefined
					? held.key
					: repositionGeneratedKey(held.key, target.position),
			value: held.value,
		});
	}
	const verdicts = new Map<string, GeneratedKeyVerdict>();
	const langs = reading.languages.codes;
	classifyGeneratedTranslationKeys(classified, table, (one) =>
		mediaKeyReading(ctx.input.source.raw.modules, langs, one),
	).forEach((verdict, index) => {
		const one = classified[index];
		if (one !== undefined)
			verdicts.set(`${one.language}\u0000${one.key}`, verdict);
	});
	const languages = reading.languages;
	const units = snapshotTranslationUnits(doc);
	/* Each output's wordings, by language code, as held. */
	const worded = new Map<TranslationUnitId, Map<string, string>>();
	let hasWording = false;
	for (const { held } of left) {
		const verdict = verdicts.get(`${held.language}\u0000${held.key}`) ?? {
			kind: "not-yet",
		};
		const tag = languages.tagOf.get(held.language);
		const wordingUnit =
			verdict.kind === "wording" ? units.get(verdict.unit) : undefined;
		if (
			verdict.kind === "wording" &&
			tag !== undefined &&
			wordingUnit &&
			hqDeviceText(verdict.value) === "" &&
			translationRoleRequiresNonblank(outputLocaleRole(wordingUnit))
		) {
			// A wording a device shows as blank, for an output whose text must show something (a
			// name, a label): Nova holds none, so workers read the output's own text there after
			// the first publish.
			held.json.take(held.key, wordingClaim(held.key), () => "").value;
			recordTextRewrite(
				ctx,
				{
					entry: CLAIMS.generatedWording.entry,
					path: `${held.json.pointer}/${pointerToken(held.key)}`,
				},
				"list-settings-respelled",
				true,
			);
			continue;
		}
		if (verdict.kind === "wording" && tag !== undefined && wordingUnit) {
			const refusal = unheldRefusal(
				unheldText(
					new Map([[held.language, verdict.value]]),
					[held.language],
					held.language,
					outputLocaleRole(wordingUnit),
				),
			);
			if (refusal) {
				held.json.refuse(held.key, refusal.claim, { name: refusal.name });
				continue;
			}
			const kept = holdText(verdict.value);
			if (kept !== undefined) {
				const wording = held.json.take(
					held.key,
					wordingClaim(held.key),
					() => kept,
				).value;
				ctx.translations.set(verdict.unit, "text", new Map([[tag, wording]]));
				ctx.translations.own(verdict.unit, tag);
				const byCode = worded.get(verdict.unit) ?? new Map<string, string>();
				byCode.set(held.language, wording);
				worded.set(verdict.unit, byCode);
				if (hqDeviceText(verdict.value) !== hqDeviceText(kept))
					recordTextRewrite(
						ctx,
						{
							entry: CLAIMS.generatedWording.entry,
							path: `${held.json.pointer}/${pointerToken(held.key)}`,
						},
						"list-settings-respelled",
						true,
					);
				hasWording = true;
				continue;
			}
		}
		if (verdict.kind === "inert") {
			held.json.account(held.key, CLAIMS.generatedNoEffect);
			ctx.facts.unusedTranslationKeys.push(
				`${held.json.pointer}/${pointerToken(held.key)}`,
			);
			continue;
		}
		// A value whose rest after a carriage return defines another app string never reaches here:
		// `appShell.ts::readTranslations` refuses it at its key, whatever the key names.
		held.json.refuse(held.key, CLAIMS.generatedAnythingElse, {
			name: held.key,
		});
	}
	fillShownWordings(ctx, doc, units, worded);
	return hasWording;
}

/** The claim of a generated key read as its output's wording: `app.display.name` under the runtime
 *  UI string it is, every other under the map's data. */
function wordingClaim(key: string) {
	return key === "app.display.name"
		? CLAIMS.generatedDisplayName
		: CLAIMS.generatedWording;
}

/**
 * Every language of an output a wording overrides in some language, whose own text CommCare HQ
 * holds blank, given the text HQ's build shows there as the output's own wording. HQ's build
 * gives a language whose own string is blank the `default` locale's, the first build language's
 * own string that is not blank, overrides included (`app_strings.py`:
 * `AppStringsBase.create_custom_app_strings` drops a blank, `create_default_app_strings` merges
 * every language's strings, a blank never replacing a text). A language's own text is the one
 * the structure stage read for a menu's or form's name (`structure.ts::namesRead`), and for any
 * other base the text Nova prints there. So a wording in one language reaches a blank one as
 * HQ's build makes it, and the first publish, which writes the wording there, shows workers the
 * same.
 */
function fillShownWordings(
	ctx: ReadContext,
	doc: BlueprintDoc,
	units: ReadonlyMap<TranslationUnitId, TranslationUnit>,
	worded: ReadonlyMap<TranslationUnitId, ReadonlyMap<string, string>>,
): void {
	const languages = applicationReading(ctx)?.languages;
	const localization = doc.localization;
	if (languages === undefined || localization === undefined) return;
	const sourceTag = localization.sourceLanguage;
	const sunk = new Map(
		ctx.translations.units().map((one) => [one.unit, one.byLanguage]),
	);
	const names = namesRead(ctx);
	for (const [output, byCode] of worded) {
		const base = units.get(output)?.generated?.base;
		const baseUnit = base === undefined ? undefined : units.get(base);
		if (base === undefined || baseUnit === undefined) continue;
		if (typeof baseUnit.source !== "string") continue;
		const baseSource = baseUnit.source;
		/* What Nova prints of the base in a language. */
		const printed = (tag: LanguageTag): string => {
			const held = tag === sourceTag ? undefined : sunk.get(base)?.get(tag);
			return typeof held === "string" ? held : baseSource;
		};
		const own = (code: string, tag: LanguageTag): string =>
			byCode.get(code) ?? names.get(base)?.own.get(code) ?? printed(tag);
		const coded = languages.codes.flatMap((code) => {
			const tag = languages.tagOf.get(code);
			return tag === undefined ? [] : [{ code, tag }];
		});
		const first = coded
			.map(({ code, tag }) => own(code, tag))
			.find((text) => text !== "");
		if (first === undefined) continue;
		for (const { code, tag } of coded) {
			if (byCode.has(code) || own(code, tag) !== "") continue;
			if (printed(tag) === first) continue;
			ctx.translations.set(output, "text", new Map([[tag, first]]));
			ctx.translations.own(output, tag);
		}
	}
}

// ── The declaration ──────────────────────────────────────────────────────

/** Where a platform use stands in HQ's app. */
function placeOfUse(
	ctx: ReadContext,
	owner: PlatformFeatureUse["owner"],
): HqPlace {
	const menuOf = (uuid: Uuid) =>
		ctx.draft.modules.find((module) => module.uuid === uuid);
	const formOf = (uuid: Uuid) => {
		for (const module of ctx.draft.modules)
			for (const form of module.forms) if (form.uuid === uuid) return form;
		return undefined;
	};
	const fieldPlace = (formUuid: Uuid, fieldUuid: Uuid): HqPlace | undefined => {
		const xform = formOf(formUuid)?.xform;
		if (xform === undefined || xform === null) return undefined;
		const walk = (
			parent: Parameters<typeof xform.childrenOf>[0],
		): HqPlace | undefined => {
			for (const field of xform.childrenOf(parent)) {
				if (field.uuid === fieldUuid) return field.place;
				const inner = walk(field);
				if (inner !== undefined) return inner;
			}
			return undefined;
		};
		return walk(null);
	};
	const menuNamed = (uuid: Uuid, kind: "case-list" | "search"): HqPlace => {
		const module = menuOf(uuid);
		if (module === undefined) return appPlace();
		const name = module.place.kind === "menu" ? module.place.name : "";
		return { kind, menu: module.index, name };
	};
	switch (owner.kind) {
		case "app":
			return appPlace();
		case "module":
			return menuOf(owner.moduleUuid)?.place ?? appPlace();
		case "form":
			return formOf(owner.formUuid)?.place ?? appPlace();
		case "field":
		case "option":
			return (
				fieldPlace(owner.formUuid, owner.fieldUuid) ??
				formOf(owner.formUuid)?.place ??
				appPlace()
			);
		case "column":
			return menuNamed(owner.moduleUuid, "case-list");
		case "search-input":
			return menuNamed(owner.moduleUuid, "search");
		case "entry-point":
			return owner.target.kind === "form"
				? (formOf(owner.target.formUuid)?.place ?? appPlace())
				: (menuOf(owner.target.moduleUuid)?.place ?? appPlace());
	}
}

/** The declarations the content runs on, over `doc`; where none runs, one finding per use some
 *  platform cannot run, at the use. */
function judgeDeclaration(
	ctx: ReadContext,
	doc: BlueprintDoc,
): ReturnType<typeof planDeclarationChoices> {
	const androidNames: { name: string; place: HqPlace }[] = [];
	const lookup = ctx.input.lookup.definitions;
	if (lookup.size > 0) {
		const seen = new Set<string>();
		for (const use of extractLookupReferenceOccurrences(
			doc,
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		)) {
			const table = lookup.get(use.tableId);
			if (table === undefined) continue;
			const column = table.columns.find((column) => column.id === use.columnId);
			for (const name of column === undefined
				? [table.tag]
				: [table.tag, column.wireName]) {
				if (isPortableName(name) || !isPortableName(name, ["web-apps"]))
					continue;
				const key = JSON.stringify([use.carrierUuid, use.registrySlot, name]);
				if (seen.has(key)) continue;
				seen.add(key);
				const { fieldUuid, formUuid, moduleUuid } = use.location;
				const owner: PlatformFeatureUse["owner"] =
					fieldUuid && formUuid && moduleUuid
						? { kind: "field", fieldUuid, formUuid, moduleUuid }
						: formUuid && moduleUuid
							? { kind: "form", formUuid, moduleUuid }
							: moduleUuid
								? { kind: "module", moduleUuid }
								: { kind: "app" };
				androidNames.push({ name, place: placeOfUse(ctx, owner) });
			}
		}
	}
	const choices = planDeclarationChoices(doc, {
		webAppsOnInHq: ctx.facts.webAppsOnInHq,
		...(androidNames.length > 0 && {
			unavailableDataPlatforms: new Set(["android"] as const),
		}),
	});
	if (choices.kind === "choices") return choices;
	for (const { name, place } of androidNames) {
		ctx.accounting.circumstance("no-platform-runs-everything", place, {
			name: `The data name “${name}”, which Android can't read`,
		});
	}
	for (const { use, platform } of choices.blocking) {
		const label = PLATFORM_FEATURES[use.feature].label;
		const name = `“${label}”, which ${platform === "web-apps" ? "Web Apps" : "Android"} can't run`;
		const split =
			choices.splitRefused !== undefined &&
			use.owner.kind === "field" &&
			use.owner.fieldUuid === choices.splitRefused;
		ctx.accounting.circumstance(
			"no-platform-runs-everything",
			placeOfUse(ctx, use.owner),
			{
				name,
				...(split ? { reason: "split-refused" as const } : {}),
			},
		);
	}
	return choices;
}

// ── Assembly ─────────────────────────────────────────────────────────────

/** The document parsed whole, or the defect `assembly` where it does not parse. */
function parsesWhole(ctx: ReadContext, doc: BlueprintDoc): boolean {
	const parsed = blueprintDocSchema.safeParse(toPersistableDoc(doc));
	if (parsed.success) return true;
	const issue = parsed.error.issues[0];
	ctx.accounting.defect(
		appPlace(),
		"schema:Application.modules",
		readerDefect.assembly(appPlace(), {
			path: issue?.path ?? [],
			code: issue?.code ?? "custom",
		}),
	);
	return false;
}

/** The facts of each form a reading read. */
function formFacts(ctx: ReadContext): ReadFacts["forms"] {
	return ctx.draft.modules.flatMap((module) =>
		module.forms.flatMap((form) =>
			form.xform === null
				? []
				: [
						{
							xmlns: form.xmlns,
							generated: [...form.xform.generated],
							inertAppearances: [...form.xform.inertAppearances],
							respelledAppearances: [...form.xform.respelledAppearances],
							caseRegionPaths: [...form.xform.caseRegionPaths],
							...formBlankTranslations(form.xform),
						},
					],
		),
	);
}

/** `doc` with the app name's two strings in each language other than the source held as a
 *  reading of its export holds them (`app-name-strings-as-read`). */
function appNameStringsAsRead(doc: BlueprintDoc): BlueprintDoc {
	const localization = doc.localization;
	if (localization === undefined) return doc;
	const written = expandAppShell(doc).translations;
	const name = makeTranslationUnitId("app", "name");
	const display = generatedWordingId("app", "appDisplayName");
	const title = generatedWordingId("app", "homescreenTitle");
	const units = [name, display, title] as const;
	const source = localization.sourceLanguage;
	const held = new Map<
		LanguageTag,
		ReadonlyMap<TranslationUnitId, TranslationEntry | undefined>
	>();
	for (const tag of localization.languageOrder) {
		if (tag === source) continue;
		const strings = ownRecordValue(
			written,
			ownRecordValue(localization.wireCodes, tag) ?? tag,
		);
		const shown = ownRecordValue(strings, "app.display.name");
		const home = ownRecordValue(strings, "homescreen.title");
		const own = (value: string | undefined) =>
			value === undefined || value === ""
				? undefined
				: ownWordingEntryFor("text", doc.appName, value, source);
		held.set(
			tag,
			shown !== undefined &&
				shown !== "" &&
				shown === home &&
				shown !== doc.appName
				? new Map([
						[name, translationEntryFor("text", doc.appName, shown, source)],
						[display, undefined],
						[title, undefined],
					])
				: new Map([
						[name, undefined],
						[display, own(shown)],
						[title, own(home)],
					]),
		);
	}
	const storedValue = (tag: LanguageTag, unit: TranslationUnitId) =>
		ownRecordValue(ownRecordValue(localization.translations, tag), unit)?.value;
	if (
		[...held].every(([tag, entries]) =>
			units.every((unit) =>
				sameJson(storedValue(tag, unit), entries.get(unit)?.value),
			),
		)
	)
		return doc;
	return withCandidate(doc, (draft) => {
		const loc = draft.localization;
		if (!loc) return;
		for (const [tag, entries] of held) {
			const into = recordFromEntries(
				Object.entries(ownRecordValue(loc.translations, tag) ?? NO_ENTRIES),
			);
			for (const unit of units) {
				const entry = entries.get(unit);
				if (entry === undefined) delete into[unit];
				else if (!sameJson(into[unit]?.value, entry.value)) into[unit] = entry;
			}
			loc.translations[tag] = into;
		}
	});
}

/**
 * Stage 11: the claims that waited for every form, the declaration's verdict, the document where
 * no finding stands, the generated translation keys, the close, and the draft.
 */
/** The manifest entry a form's `<h:title>` is claimed under (`xform/claims.ts`, `X.title`). */
const TITLE_ENTRY = "questions/h-title-and-data-name-whatever-their-text";

/**
 * A form's title as Core reads it (`XFormParser.parseTitle`): the text with every character up to
 * U+0020 taken from both ends, as Java's `String.trim` takes them, and none where nothing is left,
 * since Core's parse drops a text node of whitespace alone.
 */
function coreTitle(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	let start = 0;
	let end = text.length;
	while (start < end && text.charCodeAt(start) <= 0x20) start++;
	while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
	return start === end ? undefined : text.slice(start, end);
}

/**
 * Records under `form-titles-written` each form whose `<h:title>` Core reads as other text than
 * the name Nova writes there (`formWireName`): CommCare HQ's new form holds a blank title, and a
 * rename through Bulk App Translations leaves the old one, while Nova writes the form's name as a
 * save in HQ's form builder does. CommCare Android shows the title at the top of a saved form a
 * worker opens again with no menu's title to hand it (`FormEntryActivity.getHeaderString`), so the
 * first publish changes what a worker reads there. The record names the form's source in the
 * stored app. Nova's own export writes the name there, so its read back records nothing.
 */
function recordTitleRewrites(ctx: ReadContext, doc: BlueprintDoc): void {
	for (const module of ctx.draft.modules) {
		for (const form of module.forms) {
			if (form.xform === null || doc.forms[form.uuid] === undefined) continue;
			if (
				coreTitle(form.xform.parsed.title) ===
				coreTitle(formWireName(doc, form.uuid))
			)
				continue;
			const readId =
				ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
			ctx.facts.sameStateRewrites.push({
				entry: TITLE_ENTRY,
				path: `/_attachments/${pointerToken(`${readId ?? form.xmlns}.xml`)}`,
				register: "form-titles-written",
				removedInputs: [["title", coreTitle(form.xform.parsed.title) ?? ""]],
			});
		}
	}
}

export function assembleDocument(ctx: ReadContext): void {
	const steps = assembleDocumentSteps(ctx);
	while (!steps.next().done);
}

/** `assembleDocument`, stopping between its parts until it is resumed. */
export function* assembleDocumentSteps(
	ctx: ReadContext,
): Generator<void, void, void> {
	// 1. The claims that waited for every form.
	if (ctx.draft.connectType !== null)
		ctx.app.derived("auto_gps_capture", CLAIMS.autoGpsConnect);
	else {
		const capture = ctx.app.take(
			"auto_gps_capture",
			CLAIMS.autoGpsOther,
			(value) => value === true,
		).value;
		if (capture) {
			ctx.writeDraft(() => {
				ctx.draft.appSettings.captureLocation = true;
			});
			if (ctx.doc !== undefined)
				ctx.doc = withCandidate(ctx.doc, (draft) => {
					draft.appSettings.captureLocation = true;
				});
		}
	}

	// 2. The declaration, over the document as it stands, in every reading.
	const working = ctx.doc ?? provisionalDocument(ctx);
	const declaration = judgeDeclaration(ctx, working);
	yield;

	// 3. The document, where no finding stands yet.
	let whole =
		ctx.accounting.findings().length === 0
			? withReadTexts(working, ctx.translations)
			: undefined;
	if (whole !== undefined && !parsesWhole(ctx, whole)) whole = undefined;
	yield;

	// 4. The generated translation keys, in every reading.
	const worded = decideGeneratedKeys(ctx, whole ?? working, declaration);
	if (worded && whole !== undefined) {
		whole = withReadTexts(working, ctx.translations);
		if (!parsesWhole(ctx, whole)) whole = undefined;
	}
	ctx.facts.forms.push(...formFacts(ctx));
	yield;

	// 5. The close.
	const closed = ctx.close();
	if (closed.findings.length > 0 || whole === undefined) return;
	yield;

	// 6. The draft.
	const doc = whole;
	recordTitleRewrites(ctx, doc);
	const facts: ReadFacts = {
		...ctx.facts,
		mediaReferences: [...ctx.facts.mediaReferences],
		unheldMedia: [...ctx.facts.unheldMedia],
		pendingMedia: [...ctx.facts.pendingMedia],
		unreadTables: [...ctx.facts.unreadTables],
		forms: [...ctx.facts.forms],
		sameStateRewrites: [...ctx.facts.sameStateRewrites],
		formLinkOwners: ctx.facts.formLinkOwners,
		detailColumnOwners: ctx.facts.detailColumnOwners,
		entryFactsRefused: [...ctx.facts.entryFactsRefused],
		childCasesUnread: [...ctx.facts.childCasesUnread],
		rewrites: [...ctx.facts.rewrites],
	};
	const folds = new Map(
		ctx.draft.foldedMenus.map((one) => [one.menu, one.formUuid] as const),
	);
	/* A folded registration form now stands among its host's forms, and HQ holds it in the hidden
	 * menu it was folded from: its menu's id is that menu's. */
	const heldIn = new Map(
		ctx.draft.foldedMenus.map(
			(one) => [one.formUuid, one.menu.uniqueId] as const,
		),
	);
	const draft: ReadDraft = {
		doc,
		identities: {
			modules: ctx.draft.modules.map((module) => {
				const formUuid = folds.get(module);
				return {
					uuid:
						formUuid === undefined
							? module.uuid
							: syntheticModuleUuid(formUuid),
					uniqueId: module.uniqueId,
				};
			}),
			forms: ctx.draft.modules.flatMap((module) =>
				module.forms.map((form) => ({
					uuid: form.uuid,
					xmlns: form.xmlns,
					moduleUniqueId: heldIn.get(form.uuid) ?? module.uniqueId,
				})),
			),
			keyedCreates: keyedCreatesRead(ctx, doc),
			...(ctx.input.source.buildProfiles.length > 0 && {
				installationProfiles: readInstallationBindings(ctx),
			}),
			columnFieldWords: columnFieldWordsRead(ctx, doc),
			entries: ctx.identities.entries(),
		},
		declaration,
		facts,
	};
	ctx.assembled = draft;
}
