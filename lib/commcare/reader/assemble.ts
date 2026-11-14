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
	caseCreateNameFields,
	type Field,
	type LanguageTag,
	type LocalizedValue,
	type Media,
	makeTranslationUnitId,
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
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import type { Finding, HqPlace } from "@/lib/publish/hqFindings";
import { syntheticModuleUuid } from "../emissionPlan";
import { placedBasic } from "../placement";
import { placementsToHold } from "../placementHolds";
import { applicationReading, type HeldTranslationKey } from "./appShell";
import { withCandidate } from "./candidate";
import { rulesOnTheColumnsTheyLandOn } from "./caseList/order";
import { catalogAsRead } from "./caseManagement/catalog";
import { keyedCreatesRead } from "./caseManagement/saveToCase";
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
	defaultPostSubmitAbsent,
	searchLinkGuardsAreCarriedValues,
} from "./menus/afterSubmit";
import { registrationFormLast } from "./menus/registration";
import { appPlace, placeOrder } from "./place";
import { provisionalDocument } from "./provisional";
import { derivedConditionsAreSimpleFields } from "./search/rows";
import type { TranslationSink } from "./translations";
import { translationEntryFor } from "./translations";
import type { ReadDraft, ReadFacts } from "./types";
import { formBlankTranslations } from "./xform/prose";

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

/** Two stored values alike, as JSON. */
function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
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

/** The unit id of an inline choice's label, as the translation inventory names it. */
function optionUnit(field: Uuid, option: Uuid): TranslationUnitId {
	return makeTranslationUnitId("field", field, "option", option);
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
		/** A translation equal to its source text, and none: the reader returns none. */
		id: "translation-equal-to-source-is-absent",
		kind: "one-wire",
		apply: (doc) => {
			const equal: [LanguageTag, TranslationUnitId][] = [];
			eachEntry(doc, (language, unit, current) => {
				const entry = doc.localization?.translations[language]?.[unit];
				if (current !== undefined && sameValue(entry?.value, current.source))
					equal.push([language, unit]);
			});
			return withCandidate(doc, (draft) => {
				for (const [language, unit] of equal)
					delete draft.localization?.translations[language]?.[unit];
			});
		},
	},
	{
		/** `plainLabel` or `plainHelp` on a text blank in every language whose slot carries no
		 *  media, and no flag: Nova writes no itext entry for such a text. A question's label and
		 *  help text and an inline choice's label alike. */
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
					const source = slots.optionsSource as
						| { kind?: string; options?: readonly SelectOption[] }
						| undefined;
					if (source?.kind !== "inline") continue;
					const options = (own.optionsSource as { options: SelectOption[] })
						.options;
					source.options?.forEach((option, index) => {
						const held = options[index];
						if (
							held !== undefined &&
							option.plainLabel === true &&
							flagPrintsNothing(
								doc,
								option.label,
								option.media,
								optionUnit(uuid, option.uuid),
							)
						)
							delete held.plainLabel;
					});
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
		/** An order rule HQ joins to another column prints the element that column's own rule
		 *  prints; the reader returns each rule on the column it lands on (`caseList/order.ts`). */
		id: "order-rules-on-the-columns-they-land-on",
		kind: "one-wire",
		apply: rulesOnTheColumnsTheyLandOn,
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
];

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
	classifyGeneratedTranslationKeys(classified, table).forEach(
		(verdict, index) => {
			const one = classified[index];
			if (one !== undefined)
				verdicts.set(`${one.language}\u0000${one.key}`, verdict);
		},
	);
	const languages = reading.languages;
	const units = snapshotTranslationUnits(doc);
	const folded = new Set<string>();
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
		if (
			verdict.kind !== "fold" ||
			!foldable ||
			tag === undefined ||
			unit === undefined
		) {
			held.json.refuse(held.key, CLAIMS.generatedAnythingElse, {
				name: held.key,
			});
			continue;
		}
		held.json.take(held.key, CLAIMS.generatedOverOneText, (value) => value)
			.value;
		folds += 1;
		const once = `${verdict.unit}\u0000${tag}`;
		if (folded.has(once)) continue;
		folded.add(once);
		if (source || doc.localization === undefined)
			sourceFolds.set(verdict.unit, verdict.value);
		else
			ctx.translations.set(
				verdict.unit,
				unit.valueKind,
				new Map([
					[
						tag,
						unit.valueKind === "prose"
							? proseText(verdict.value)
							: verdict.value,
					],
				]),
			);
	}
	ctx.facts.foldedTranslationKeys += folds;
	return folds > 0;
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
	const folded = decideGeneratedKeys(ctx, whole ?? working, sourceFolds);
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
