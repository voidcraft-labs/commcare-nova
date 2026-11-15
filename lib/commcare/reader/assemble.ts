/**
 * The last stage of a reading: the claims that waited for every form, the
 * declarations the content runs on, the document where no finding stands,
 * the generated translation keys, the close, and the draft a birth applies.
 * And the reader's canonical choices: where two documents print one source, the
 * one a reading returns. The reader does not run Nova's gate: `lib/doc`'s
 * commit verdicts import `lib/commcare`, so acceptance runs it over the draft.
 */

import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { holdsUserRepeat } from "@/lib/doc/groupFieldLists";
import { applyHoldPlacements } from "@/lib/doc/mutations/placements";
import { planDeclarationChoices } from "@/lib/doc/platformDeclaration";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseCreateNameFields,
	type Field,
	type LanguageTag,
	type LocalizedValue,
	type Media,
	makeTranslationUnitId,
	operationCaseType,
	ownCaseOperationId,
	type SelectOption,
	type TranslationUnitId,
	translationSourceFingerprintsEqual,
	type Uuid,
} from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import { PLATFORM_FEATURES } from "@/lib/domain/platforms";
import type { PlatformFeatureUse } from "@/lib/domain/platformUses";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import {
	type ProseTemplate,
	proseTemplateIsEmpty,
	proseText,
} from "@/lib/domain/prose";
import {
	snapshotTranslationUnits,
	type TranslationUnit,
} from "@/lib/domain/translationUnits";
import type { Finding, HqPlace } from "@/lib/publish/hqFindings";
import { syntheticModuleUuid } from "../emissionPlan";
import { appPlacements, placedBasic, planBasicSubcases } from "../placement";
import { placementsToHold } from "../placementHolds";
import { applicationReading, type HeldTranslationKey } from "./appShell";
import { withCandidate } from "./candidate";
import {
	columnsOfAMenuThatListsNoCasesOffTheDetail,
	columnsOffAScreenLast,
} from "./caseList/details";
import {
	implicitOrderRuleIsAbsent,
	rulesOnTheColumnsTheyLandOn,
} from "./caseList/order";
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
	repositionGeneratedKey,
} from "./generatedTranslationKeys";
import {
	heldText,
	holdText,
	hqDeviceText,
	recordTextRewrite,
} from "./heldText";
import { pointerToken, sameJson } from "./jsonCursor";
import { resourcedDocument, sourceLanguageAsRead } from "./languages";
import {
	defaultPostSubmitAbsent,
	searchLinkGuardsAreCarriedValues,
} from "./menus/afterSubmit";
import { registrationFormLast } from "./menus/registration";
import { appPlace, placeOrder } from "./place";
import { menuAndFormIdsAsRead, provisionalDocument } from "./provisional";
import { joinedGuardsSplitAsRead } from "./search/guardSplit";
import { exactSearchModeIsAbsent } from "./search/prompts";
import { derivedConditionsAreSimpleFields } from "./search/rows";
import {
	defaultSearchTitleIsAbsent,
	emptySearchSettingsBesideFieldsAreAbsent,
} from "./search/settings";
import { requiredMessagesAsRead } from "./search/systemSentences";
import {
	deferredFormNames,
	namesRead,
	recordNameRewrite,
	refuseFormNameReadAsInstance,
	settleDeferredFormNames,
} from "./structure";
import type { TranslationSink } from "./translations";
import { translationEntryFor } from "./translations";
import type { AppStringTable, ReadDraft, ReadFacts } from "./types";
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
	/** `auto_gps_capture` on any other app: kept at the project space's value. */
	autoGpsOther: account(
		`${A}/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app`,
		AUTO_GPS,
	),
	generatedNoEffect: account(
		`${A}/translations-generated-key-with-no-effect`,
		TRANSLATIONS,
	),
	generatedOverOneText: take(
		`${A}/translations-generated-key-over-one-text`,
		TRANSLATIONS,
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
	readonly apply: (doc: BlueprintDoc) => BlueprintDoc;
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
	for (const [language, entries] of Object.entries(localization.translations))
		for (const unit of Object.keys(entries) as TranslationUnitId[]) {
			const current = units.get(unit);
			visit(
				language as LanguageTag,
				unit,
				current === undefined
					? undefined
					: { fingerprint: current.sourceFingerprint, source: current.source },
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
		/** A form's text blank in one language beside another language's text, and the text a
		 *  worker reads there in its place: the export writes every language's filled text, so the
		 *  reader returns the second (`xform/prose.ts::blankItextFilled`). It runs before every
		 *  other translation row, which then reads the filled values. */
		id: "blank-itext-takes-the-filled-text",
		kind: "one-wire",
		apply: blankItextFilled,
	},
	{
		/** A translation equal to its source text, and none: the reader returns none. */
		id: "translation-equal-to-source-is-absent",
		kind: "one-wire",
		apply: (doc) => {
			const equal: [LanguageTag, TranslationUnitId][] = [];
			eachEntry(doc, (language, unit, current) => {
				const entry = doc.localization?.translations[language]?.[unit];
				if (current !== undefined && sameJson(entry?.value, current.source))
					equal.push([language, unit]);
			});
			return withCandidate(doc, (draft) => {
				for (const [language, unit] of equal)
					delete draft.localization?.translations[language]?.[unit];
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
				const entry = doc.localization?.translations[language]?.[unit];
				if (
					now !== undefined &&
					entry !== undefined &&
					translationSourceFingerprintsEqual(
						entry.sourceFingerprint,
						now.fingerprint,
					)
				)
					current.push([language, unit, now.fingerprint]);
			});
			return withCandidate(doc, (draft) => {
				if (source === undefined) return;
				for (const [language, unit, fingerprint] of current) {
					const entry = draft.localization?.translations[language]?.[unit];
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
		/** A translation entry whose source fingerprint is not the current source's, and none: the
		 *  reader returns none, since Nova writes the source text for it. */
		id: "out-of-date-translation-is-absent",
		kind: "one-wire",
		apply: (doc) => {
			const stale: [LanguageTag, TranslationUnitId][] = [];
			eachEntry(doc, (language, unit, now) => {
				const entry = doc.localization?.translations[language]?.[unit];
				if (
					now === undefined ||
					entry === undefined ||
					!translationSourceFingerprintsEqual(
						entry.sourceFingerprint,
						now.fingerprint,
					)
				)
					stale.push([language, unit]);
			});
			return withCandidate(doc, (draft) => {
				for (const [language, unit] of stale)
					delete draft.localization?.translations[language]?.[unit];
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
		apply: (doc) => {
			const source = sourceLanguageAsRead(doc);
			return source === undefined ? doc : resourcedDocument(doc, source);
		},
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
		/** A column of a menu that lists no cases, shown on Details or not: such a menu is written
		 *  the empty pair, whose detail holds no column, so the reader returns each column off the
		 *  detail (`caseList/details.ts::columnsOfAMenuThatListsNoCasesOffTheDetail`). */
		id: "columns-of-a-menu-that-lists-no-cases-are-off-the-detail",
		kind: "not-carried",
		apply: columnsOfAMenuThatListsNoCasesOffTheDetail,
	},
	{
		/** A column off the detail or off the list, anywhere in that screen's order, and the same
		 *  column after the screen's own columns: neither detail holds a place for a column it does
		 *  not show, so the reader returns each such column last, in the other screen's order. */
		id: "columns-off-a-screen-last-in-its-order",
		kind: "one-wire",
		apply: columnsOffAScreenLast,
	},
	{
		/** A document's catalog as authored, and the catalog the reader derives from the same
		 *  document: the emitter reads a property's type through `effectiveCaseTypes`, and a label
		 *  and a property nothing reads reach no export, so the reader returns the derived one. */
		id: "case-catalog-is-as-read",
		kind: "one-wire",
		apply: (doc) => {
			const caseTypes = catalogAsRead(doc);
			return withCandidate(doc, (draft) => {
				draft.caseTypes = caseTypes as typeof draft.caseTypes;
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
		 *  CommCare HQ only when a person adds it there, so the reader returns none. */
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
		/** A worker field the logic reads by name that no worker property names, and the same read
		 *  beside a worker property of that slug, labelled with it: both print one source, and the
		 *  reader returns the second, minting the property as a re-read of the app does
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

/** `doc` with every unit the sink holds written as a translation entry, in each language other
 *  than the source that holds one, against the unit's current source. */
function withTranslations(
	doc: BlueprintDoc,
	sink: TranslationSink,
): BlueprintDoc {
	const localization = doc.localization;
	if (localization === undefined) return doc;
	const units = snapshotTranslationUnits(doc);
	const source = localization.sourceLanguage;
	return withCandidate(doc, (draft) => {
		const translations = draft.localization?.translations;
		if (translations === undefined) return;
		for (const { unit, byLanguage } of sink.units()) {
			const current = units.get(unit);
			if (current === undefined) continue;
			for (const [language, value] of byLanguage) {
				if (language === source) continue;
				const targets = translations[language];
				if (targets === undefined) continue;
				const entry = translationEntryFor(
					current.valueKind,
					current.source,
					value,
					source,
				);
				if (entry === undefined) delete targets[unit];
				else targets[unit] = entry;
			}
		}
	});
}

/** The slot a unit's source text lives in, among the slots whose text a generated string can be
 *  made from in the source language: an app's, a menu's or a form's name, a case list menu
 *  item's or registration's label, a column's header, and a Search field's label or hint.
 *  Undefined for a unit of any other role, whose source-language override stays not yet held. */
function sourceTextSlot(
	doc: BlueprintDoc,
	unit: TranslationUnitId,
): ((draft: BlueprintDoc, value: string) => void) | undefined {
	const found = snapshotTranslationUnits(doc).get(unit);
	const owner = found?.owner;
	if (found?.role === "app-name")
		return (draft, value) => {
			draft.appName = value;
		};
	if (found?.role === "module-name" && owner?.kind === "module")
		return (draft, value) => {
			draft.modules[owner.moduleUuid].name = value;
		};
	if (found?.role === "form-name" && owner?.kind === "form")
		return (draft, value) => {
			draft.forms[owner.formUuid].name = value;
		};
	if (
		found?.role === "case-list-menu-item-label" &&
		owner?.kind === "module" &&
		doc.modules[owner.moduleUuid]?.caseListMenuItem !== undefined
	)
		return (draft, value) => {
			const item = draft.modules[owner.moduleUuid].caseListMenuItem;
			if (item !== undefined) item.label = value;
		};
	if (
		found?.role === "case-list-registration-label" &&
		owner?.kind === "module" &&
		doc.modules[owner.moduleUuid]?.caseListRegistrationForm !== undefined
	)
		return (draft, value) => {
			const registration =
				draft.modules[owner.moduleUuid].caseListRegistrationForm;
			if (registration !== undefined) registration.label = value;
		};
	if (found?.role === "case-list-header" && owner?.kind === "case-list-column")
		return (draft, value) => {
			const column = draft.modules[
				owner.moduleUuid
			].caseListConfig?.columns.find((one) => one.uuid === owner.columnUuid);
			if (column !== undefined) column.header = value;
		};
	if (
		(found?.role === "search-input-label" ||
			found?.role === "search-input-hint") &&
		owner?.kind === "search-input"
	) {
		const slot = found.role === "search-input-label" ? "label" : "hint";
		return (draft, value) => {
			const input = draft.modules[
				owner.moduleUuid
			].caseListConfig?.searchInputs?.find(
				(one) => one.uuid === owner.searchInputUuid,
			);
			if (input !== undefined) (input as Record<string, unknown>)[slot] = value;
		};
	}
	return undefined;
}

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

/**
 * Decides every generated translation key in the reading that meets it (16.5): each stands under
 * a finding where what it names did not read whole, and every other is classified against the
 * strings Nova's build makes of `doc` and claimed by its verdict. A fold writes the value as its
 * unit's text in that language, once per unit, and is counted. Returns whether a key folded.
 */
function decideGeneratedKeys(
	ctx: ReadContext,
	doc: BlueprintDoc,
	sourceFolds: Map<TranslationUnitId, string>,
	foldedKeys: Set<string>,
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
	const table = ctx.input.appStrings(doc);
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
	/* The fold rule reads the stored value of every id a unit feeds: every key whose menu and
	 * form read, the covered ones among them. */
	const classified: HeldGeneratedKey[] = [];
	for (const held of reading.generatedKeys) {
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
	classifyGeneratedTranslationKeys(
		classified,
		withDeferredNames(ctx, table, classified),
	).forEach((verdict, index) => {
		const one = classified[index];
		if (one !== undefined)
			verdicts.set(`${one.language}\u0000${one.key}`, verdict);
	});
	const languages = reading.languages;
	const units = snapshotTranslationUnits(doc);
	const folded = new Set<string>();
	/* Where each folded unit's first key is stored, for a record of the change a worker meets. */
	const foldSites = new Map<
		TranslationUnitId,
		{ readonly entry: string; readonly path: string }
	>();
	const foldValues = new Map<
		TranslationUnitId,
		Map<LanguageTag, LocalizedValue>
	>();
	let folds = 0;
	for (const { held } of left) {
		const verdict = verdicts.get(`${held.language}\u0000${held.key}`) ?? {
			kind: "not-yet",
		};
		const tag = languages.tagOf.get(held.language);
		const unit = verdict.kind === "fold" ? units.get(verdict.unit) : undefined;
		const source =
			tag !== undefined && tag === doc.localization?.sourceLanguage;
		const foldable =
			verdict.kind === "fold" &&
			tag !== undefined &&
			unit !== undefined &&
			(!(source || doc.localization === undefined) ||
				sourceTextSlot(doc, verdict.unit) !== undefined);
		if (verdict.kind === "inert") {
			held.json.account(held.key, CLAIMS.generatedNoEffect);
			continue;
		}
		// A value whose rest after a carriage return defines another app string never reaches here:
		// `appShell.ts::readTranslations` refuses it at its key, whatever the key names.
		// A fold over a text Nova's gate admits no spelling of (one a device shows none of, a
		// character XML cannot hold, `heldText.ts::holdText`) is no text Nova can hold. Every other
		// fold is held as every app string is: a text unit's in `keepShownText`, and a choice's
		// label, whose value is prose, here, as a device shows it (`holdText`).
		const kept = verdict.kind === "fold" ? holdText(verdict.value) : undefined;
		if (
			verdict.kind !== "fold" ||
			!foldable ||
			tag === undefined ||
			unit === undefined ||
			kept === undefined
		) {
			held.json.refuse(held.key, CLAIMS.generatedAnythingElse, {
				name: held.key,
			});
			continue;
		}
		held.json.take(held.key, CLAIMS.generatedOverOneText, (value) => value)
			.value;
		folds += 1;
		foldedKeys.add(`${held.language}\u0000${held.key}`);
		if (!foldSites.has(verdict.unit))
			foldSites.set(verdict.unit, {
				entry: CLAIMS.generatedOverOneText.entry,
				path: `${held.json.pointer}/${pointerToken(held.key)}`,
			});
		const once = `${verdict.unit}\u0000${tag}`;
		if (folded.has(once)) continue;
		folded.add(once);
		// A choice's label is held here as a device shows it: the two characters `\n` a line
		// break, the text before a carriage return, and no space at either end. Where a worker then
		// reads another text (a space dropped at its start, a line break at either end) the reading
		// records it at the key, as `keepShownText` does for a text unit.
		if (
			unit.valueKind === "prose" &&
			hqDeviceText(verdict.value) !== hqDeviceText(kept)
		)
			recordTextRewrite(
				ctx,
				{
					entry: CLAIMS.generatedOverOneText.entry,
					path: `${held.json.pointer}/${pointerToken(held.key)}`,
				},
				"list-settings-respelled",
				true,
			);
		const value = unit.valueKind === "prose" ? proseText(kept) : verdict.value;
		const byTag = foldValues.get(verdict.unit) ?? new Map();
		byTag.set(tag, value);
		foldValues.set(verdict.unit, byTag);
		/* A fold in another language reaches the sink through `keepShownText`, with every other
		 * language of its unit. */
		if (source || doc.localization === undefined)
			sourceFolds.set(verdict.unit, verdict.value);
	}
	const wireNames = keepShownText(
		ctx,
		doc,
		units,
		foldValues,
		sourceFolds,
		foldSites,
	);
	for (const { unit, before, after } of wireNames) {
		const owner = units.get(unit)?.owner;
		if (owner?.kind !== "form" || before === after) continue;
		const form = ctx.draft.modules
			.flatMap((module) => module.forms)
			.find((one) => one.uuid === owner.formUuid);
		if (form !== undefined) refuseFormNameReadAsInstance(ctx, form, after);
	}
	ctx.facts.foldedTranslationKeys += folds;
	return folds > 0;
}

/**
 * The table the verdicts read: Nova's strings for the document as read, with each deferred form
 * name (`structure.ts::scanFormName`) at the text its map holds in the first language. The
 * document holds the app translation's wording there so that Nova's gate admits it and the table
 * can be made; the key over it is judged against the name Nova would otherwise print, as every
 * other key is.
 */
function withDeferredNames(
	ctx: ReadContext,
	table: AppStringTable,
	classified: readonly HeldGeneratedKey[],
): AppStringTable {
	const deferred = deferredFormNames(ctx);
	if (deferred.length === 0) return table;
	const languages: Record<string, Record<string, string>> = {
		...table.languages,
	};
	for (const one of deferred) {
		const key = classified.find(
			(held) => held.language === one.language && held.key === one.key,
		);
		const strings = languages[one.language];
		if (key === undefined || strings === undefined) continue;
		if (!Object.hasOwn(strings, key.id)) continue;
		languages[one.language] = { ...strings, [key.id]: one.stored };
	}
	return { ...table, languages };
}

/** A value that holds nothing: the empty text, or a template of no parts. */
function blankValue(value: LocalizedValue): boolean {
	return typeof value === "string"
		? value === ""
		: proseTemplateIsEmpty(value as ProseTemplate);
}

/**
 * After the folds of a reading, every language of each unit a generated key folded is given the
 * text CommCare HQ's build shows in it. HQ's build gives a language its own string, the app
 * translations' override where one is set and else the unit's own text there (for a name,
 * `clean_trans(name, [lang] + langs)`); a language whose own string is blank shows the
 * `default` locale's, the first build language's own string that is not blank
 * (`app_strings.py`: `AppStringsBase.create_custom_app_strings` drops a blank,
 * `create_default_app_strings` merges every language's strings, overrides included, a blank
 * never replacing a text; `SelectKnownAppStrings.app_strings_parts` lays the language's
 * `translations` over its strings). A language's own text is the one the structure stage read
 * for a menu's or form's name (`structure.ts::namesRead`), and for any other unit the text
 * Nova printed for that language before the folds. So a fold in one language changes no other
 * language's text but where HQ's build changes it too: the source language's fold never becomes
 * the text of a language that held its own. Every text is then held as every app string is
 * (`heldText.ts::heldText`, by its unit's role), and where a worker would read another text in
 * some language the reading records it under `text-spaces-dropped`, at a name's map
 * (`structure.ts::recordNameRewrite`) or else at the first key folded over the text.
 *
 * Returns, for every folded text unit, the text Nova writes in the app's first language before
 * and after the folds: a form's name there is the one `formWireName` writes into its source.
 */
function keepShownText(
	ctx: ReadContext,
	doc: BlueprintDoc,
	units: ReadonlyMap<TranslationUnitId, TranslationUnit>,
	folds: ReadonlyMap<
		TranslationUnitId,
		ReadonlyMap<LanguageTag, LocalizedValue>
	>,
	sourceFolds: Map<TranslationUnitId, string>,
	foldSites: ReadonlyMap<
		TranslationUnitId,
		{ readonly entry: string; readonly path: string }
	>,
): readonly { unit: TranslationUnitId; before: string; after: string }[] {
	const localization = doc.localization;
	const languages = applicationReading(ctx)?.languages;
	const wireNames: {
		unit: TranslationUnitId;
		before: string;
		after: string;
	}[] = [];
	if (localization === undefined || languages === undefined) {
		for (const [unit, stored] of sourceFolds) {
			// Held as every app string is (`heldText.ts::holdText`, which the fold has already
			// asked): a device's text, recorded where a worker then reads another.
			const value = holdText(stored) ?? stored;
			sourceFolds.set(unit, value);
			if (hqDeviceText(stored) !== hqDeviceText(value)) {
				const name = namesRead(ctx).get(unit);
				const site = foldSites.get(unit);
				if (name !== undefined) recordNameRewrite(ctx, name, true);
				else if (site !== undefined)
					recordTextRewrite(ctx, site, "list-settings-respelled", true);
			}
			const current = units.get(unit)?.source;
			if (typeof current === "string")
				wireNames.push({ unit, before: current, after: value });
		}
		return wireNames;
	}
	const sourceTag = localization.sourceLanguage;
	const coded = languages.codes.flatMap((code) => {
		const tag = languages.tagOf.get(code);
		return tag === undefined ? [] : [{ code, tag }];
	});
	const firstTag =
		languages.first === undefined
			? undefined
			: languages.tagOf.get(languages.first);
	const sunk = new Map(
		ctx.translations.units().map((one) => [one.unit, one.byLanguage]),
	);
	const names = namesRead(ctx);
	for (const [unitId, byTag] of folds) {
		const unit = units.get(unitId);
		if (unit === undefined) continue;
		const held = sunk.get(unitId);
		/* What Nova prints in a language for a source and the sink's value there. */
		const printed = (
			source: LocalizedValue,
			value: LocalizedValue | undefined,
		): LocalizedValue =>
			value !== undefined &&
			translationEntryFor(unit.valueKind, source, value, sourceTag) !==
				undefined
				? value
				: source;
		const before = (tag: LanguageTag): LocalizedValue =>
			tag === sourceTag ? unit.source : printed(unit.source, held?.get(tag));
		const firstBefore = firstTag === undefined ? undefined : before(firstTag);
		const name = names.get(unitId);
		const text = (one: { code: string; tag: LanguageTag }): LocalizedValue =>
			byTag.get(one.tag) ?? name?.own.get(one.code) ?? before(one.tag);
		const firstShown = coded.map(text).find((value) => !blankValue(value));
		const hqShown = (one: {
			code: string;
			tag: LanguageTag;
		}): LocalizedValue => {
			const value = text(one);
			return blankValue(value) ? (firstShown ?? value) : value;
		};
		const sourceOne = coded.find((one) => one.tag === sourceTag);
		/* A text is held as every app string is (`heldText.ts::heldText`): never with a space at
		 * either end, and never blank beside a source that is not where its role requires text. */
		const shownByCode = new Map<string, string>();
		for (const one of coded) {
			const value = hqShown(one);
			if (typeof value === "string") shownByCode.set(one.code, value);
		}
		const heldTexts =
			sourceOne === undefined || shownByCode.size !== coded.length
				? undefined
				: heldText(
						shownByCode,
						coded.map((one) => one.code),
						sourceOne.code,
						unit.role,
					);
		if (heldTexts?.workersSeeAnother) {
			const site = foldSites.get(unitId);
			if (name !== undefined) recordNameRewrite(ctx, name, true);
			else if (site !== undefined)
				recordTextRewrite(ctx, site, "list-settings-respelled", true);
		}
		const shown = (one: { code: string; tag: LanguageTag }): LocalizedValue =>
			heldTexts === undefined
				? hqShown(one)
				: (heldTexts.translations.get(one.code) ?? heldTexts.source);
		if (sourceOne !== undefined) {
			const value = shown(sourceOne);
			if (
				typeof value === "string" &&
				!sameJson(value, unit.source) &&
				sourceTextSlot(doc, unitId) !== undefined
			)
				sourceFolds.set(unitId, value);
		}
		const others = new Map<LanguageTag, LocalizedValue>();
		for (const one of coded)
			if (one.tag !== sourceTag) others.set(one.tag, shown(one));
		ctx.translations.set(unitId, unit.valueKind, others);
		if (firstTag === undefined) continue;
		const source = sourceFolds.get(unitId) ?? unit.source;
		const after =
			firstTag === sourceTag ? source : printed(source, others.get(firstTag));
		if (typeof firstBefore === "string" && typeof after === "string")
			wireNames.push({ unit: unitId, before: firstBefore, after });
	}
	return wireNames;
}

// ── The declaration ──────────────────────────────────────────────────────

/** Where a platform use stands in HQ's app. */
function placeOfUse(ctx: ReadContext, use: PlatformFeatureUse): HqPlace {
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
	const owner = use.owner;
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
	const choices = planDeclarationChoices(doc, {
		webAppsOnInHq: ctx.facts.webAppsOnInHq,
	});
	if (choices.kind === "choices") return choices;
	for (const { use, platform } of choices.blocking) {
		const label = PLATFORM_FEATURES[use.feature].label;
		const name = `“${label}”, which ${platform === "web-apps" ? "Web Apps" : "Android"} can't run`;
		const split =
			choices.splitRefused !== undefined &&
			use.owner.kind === "field" &&
			use.owner.fieldUuid === choices.splitRefused;
		ctx.accounting.circumstance(
			"no-platform-runs-everything",
			placeOfUse(ctx, use),
			{
				name,
				...(split ? { reason: "split-refused" as const } : {}),
			},
		);
	}
	return choices;
}

// ── Assembly ─────────────────────────────────────────────────────────────

/** The document parsed whole, or the defect D8 where it does not parse. */
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
							caseRegionPaths: [...form.xform.caseRegionPaths],
							blankTranslations: formBlankTranslations(form.xform),
						},
					],
		),
	);
}

/** `doc` with each source-language fold written into its unit's own slot. */
function withSourceFolds(
	doc: BlueprintDoc,
	folds: ReadonlyMap<TranslationUnitId, string>,
): BlueprintDoc {
	if (folds.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const [unit, value] of folds)
			sourceTextSlot(doc, unit)?.(draft as BlueprintDoc, value);
	});
}

/**
 * Stage 11: the claims that waited for every form, the declaration's verdict, the document where
 * no finding stands, the generated translation keys, the close, and the draft.
 */
export function assembleDocument(ctx: ReadContext): void {
	// 1. The claims that waited for every form.
	if (ctx.draft.connectType !== null)
		ctx.app.derived("auto_gps_capture", CLAIMS.autoGpsConnect);
	else ctx.app.account("auto_gps_capture", CLAIMS.autoGpsOther);

	// 2. The declaration, over the document as it stands, in every reading.
	const working = ctx.doc ?? provisionalDocument(ctx);
	const declaration = judgeDeclaration(ctx, working);

	// 3. The document, where no finding stands yet.
	let whole =
		ctx.accounting.findings().length === 0
			? withTranslations(working, ctx.translations)
			: undefined;
	if (whole !== undefined && !parsesWhole(ctx, whole)) whole = undefined;

	// 4. The generated translation keys, in every reading.
	const sourceFolds = new Map<TranslationUnitId, string>();
	const foldedKeys = new Set<string>();
	const folded = decideGeneratedKeys(
		ctx,
		whole ?? working,
		sourceFolds,
		foldedKeys,
	);
	settleDeferredFormNames(ctx, foldedKeys);
	if (folded && whole !== undefined) {
		whole = withTranslations(
			withSourceFolds(working, sourceFolds),
			ctx.translations,
		);
		if (!parsesWhole(ctx, whole)) whole = undefined;
	}
	ctx.facts.forms.push(...formFacts(ctx));

	// 5. The close.
	const closed = ctx.close();
	if (closed.findings.length > 0 || whole === undefined) return;

	// 6. The draft.
	const doc = whole;
	const facts: ReadFacts = {
		...ctx.facts,
		mediaReferences: [...ctx.facts.mediaReferences],
		pendingMedia: [...ctx.facts.pendingMedia],
		unreadTables: [...ctx.facts.unreadTables],
		forms: [...ctx.facts.forms],
		sameStateRewrites: [...ctx.facts.sameStateRewrites],
		entryFactsRefused: [...ctx.facts.entryFactsRefused],
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
		batch: diffDocsToMutations(emptyBlueprintDoc(ctx.input.appId), doc),
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
			entries: ctx.resolver.entries(),
		},
		declaration,
		facts,
	};
	ctx.assembled = draft;
}
