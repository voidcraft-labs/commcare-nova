/**
 * What the reader of CommCare HQ's apps takes and gives: its input, the
 * draft a clean reading gives, the account a reading with a finding gives, and
 * the facts later readers of a reading take from it.
 */

import type { DeclarationChoices } from "@/lib/doc/platformDeclaration";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	CaseType,
	LanguageTag,
	LookupColumnId,
	LookupTableId,
	MediaKind,
	Uuid,
	WireStringSource,
} from "@/lib/domain";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import type { Finding, HqPlace } from "@/lib/publish/hqFindings";
import type { HqAlignedModule } from "../hq/appReading";
import type { HqAppSource } from "../hq/appSource";
import type { HqLocationType } from "../hq/locations";
import type { ColumnFieldWordRow } from "../wireIdentity";
import type { WorkKind } from "../workMeter";
import type { GeneratedNodePurpose } from "../xform/generatedNodes";
import type { ClaimLog } from "./accounting";
import type { ReaderDefectWhy } from "./defects";
import type { ExpressionReading, RecordDialectJudge } from "./expressions";
import type { HeldExpansions } from "./heldExpansions";
import type { IdentityMapEntry, IdentityResolver } from "./identity";

export interface ReaderInput {
	/** The app's id, derived from the reading's id. */
	readonly appId: string;
	/** The project space the source was read from, for a capture's link. */
	readonly target: { readonly origin: string; readonly domain: string };
	/** The source as served, with `raw` and each form's attachment. */
	readonly source: HqAppSource;
	/** The aligned menus, each form's real id and HQ's own question summary. */
	readonly modules: readonly HqAlignedModule[];
	/** `mintingResolver(appId)` for a reading; `matchingResolver` for a re-read
	 *  that must give a known document's identities back. It holds nothing: what a
	 *  reading claims is the reading's own (`context.ts`, `ReadContext.identities`). */
	readonly resolver: IdentityResolver;
	readonly lookup: ReaderLookupCatalog;
	readonly organization: ReaderOrganization;
	readonly media: ReaderMediaIndex;
	/** The local app strings Nova's build gives a document, each case list column named by the
	 *  word `columnWords` says its source keeps it under (the reading's
	 *  `ReadMenuAndFormIdentities.columnFieldWords`), or `null` where Nova's gate refuses the
	 *  document, which Nova's build cannot write. The reader asks it of its document under the
	 *  declaration it proposes (`assemble.ts::underProposedDeclaration`), the document the gate
	 *  judges the reading as. Pure. */
	readonly appStrings: (
		doc: BlueprintDoc,
		columnWords: readonly ColumnFieldWordRow[],
	) => AppStringTable | null;
	/** Whether the record dialect prints a tree and reads it back. Pure. */
	readonly recordDialect: RecordDialectJudge;
	/** Whether the source project space applies "save only if changed", as the probe of it
	 *  answered; absent where the source holds no `update_mode: "edit"` and no probe was made. */
	readonly saveOnlyEditedApplied?: boolean;
	/** What Nova already holds about this app's case types that no export carries: the case type
	 *  each index of a type reaches, consulted only where the app itself fixes none (no child
	 *  link, no parent selection, no open action's index), and the type its catalog declares for
	 *  each property, which every property the reading holds takes unless a question that writes
	 *  it gives values that type cannot hold. Absent for an app Nova has never held. */
	readonly knownCaseTypes?: ReaderKnownCaseTypes;
	/** What Nova already holds about this app's languages that no export carries: the language
	 *  each CommCare HQ code it published names, from the held document's `localization.wireCodes`
	 *  (`languages.ts::knownLanguageCodesOf`). A code it holds is read as that language whatever
	 *  the app names it, since the code is the language's identity on CommCare HQ; any other code
	 *  is read by `languageIdentityForHqCode`. Absent for an app Nova has never held. */
	readonly knownLanguageCodes?: ReaderKnownLanguageCodes;
}

/** The language each CommCare HQ code of an app Nova holds names, by the code. */
export interface ReaderKnownLanguageCodes {
	readonly tagByCode: ReadonlyMap<string, LanguageTag>;
	readonly sourceCode: string | undefined;
	readonly rtlProjectLanguages?: Readonly<Record<LanguageTag, true>>;
}

/** The case types the indices of the app's document reach and the types its catalog declares,
 *  as Nova holds them (`caseManagement/knownCaseTypes.ts::knownCaseTypesOf`). */
export interface ReaderKnownCaseTypes {
	/** The type a case of `caseType` reaches through its index `identifier`: for `parent`, the
	 *  catalog's parent and the relationship it holds; for any other identifier, the type every
	 *  typed step of the document through that identifier from `caseType` agrees on. Undefined
	 *  where Nova holds none, or where those steps disagree. */
	targetOf(caseType: string, identifier: string): KnownIndexTarget | undefined;
	/** The `data_type` the document's catalog declares for `property` of `caseType`: the type
	 *  every print of a read of it lowers by (a sort's comparator, `datetime-coerce`,
	 *  `format-date`, a comparison of dates and times), which no print tells a reading.
	 *  Undefined where the catalog declares none. */
	declaredTypeOf(
		caseType: string,
		property: string,
	): CasePropertyDataType | undefined;
}

export interface KnownIndexTarget {
	readonly caseType: string;
	/** The catalog's relationship, for its parent alone. */
	readonly relationship?: CaseType["relationship"];
}

export interface ReaderOptions {
	/** `counts`, the default, keeps claim counts by entry. `full` also keeps every claim. */
	readonly claims?: "counts" | "full";
	/**
	 * Told which part of the reading runs next: a stage's index in `STAGES`,
	 * then `close`. A caller that catches a throw names where it came from with
	 * the last one it was told, never with the thrown message, which can quote
	 * the app.
	 */
	readonly onStage?: (at: number | "close") => void;
	/**
	 * Nova's emissions the readings of one request share
	 * (`heldExpansions.ts`): a reading that emits a document another reading
	 * of the request emitted under the same inputs is answered with that
	 * emission. Absent, every emission is made afresh.
	 */
	readonly heldExpansions?: HeldExpansions;
	/**
	 * The request's signal: once it aborts, the reading stops at its next
	 * charge of the work meter or its next part, and the stop
	 * (`workMeter.ts::WorkCancelled`) is thrown to the caller.
	 */
	readonly signal?: AbortSignal;
	/** The reading's work limit in place of `work.ts::readWorkLimit` of the source's size: for a
	 *  test that reads an app to its limit. */
	readonly workLimit?: number;
}

/** The tables of the source project space the app may read, with the ids project data gives them. */
export interface ReaderLookupCatalog {
	table(tag: string): ReaderLookupTable | undefined;
	/** What `FormParseScope.lookup` and the checker read. */
	readonly definitions: LookupDefinitionIndex;
}
export interface ReaderLookupTable {
	readonly tableId: LookupTableId;
	/** A column by the field name HQ holds. */
	column(fieldName: string): LookupColumnId | undefined;
}

/** HQ's levels as project data read them; the slugs an app reads are learned from the app. */
export interface ReaderOrganization {
	readonly levelCodes: readonly string[];
	readonly levels: readonly HqLocationType[];
}

export type ReaderMediaResolution =
	/** `multimedia_map` holds the path and the reading has an asset for its file. */
	| {
			readonly kind: "asset";
			readonly assetId: string;
			readonly mediaKind: MediaKind;
	  }
	/** `multimedia_map` holds no entry for the path. */
	| { readonly kind: "no-entry" }
	/** The entry names no file Nova can ask for, or HQ serves none. */
	| { readonly kind: "unreadable" };
export interface ReaderMediaIndex {
	resolve(path: string): ReaderMediaResolution;
}

/** The local app strings of a document, by language code, with each string's source. */
export interface AppStringTable {
	readonly languages: Readonly<
		Record<string, Readonly<Record<string, string>>>
	>;
	/** A string's source where it comes from a translation unit or several. */
	readonly units: Readonly<Record<string, WireStringSource>>;
}

export type ReadOutcome =
	| {
			readonly kind: "read";
			readonly draft: ReadDraft;
			readonly work: ReadWork;
			readonly claims: ClaimLog;
			readonly defects: readonly ReaderDefect[];
	  }
	| {
			readonly kind: "account";
			readonly findings: readonly Finding[];
			readonly work: ReadWork;
			readonly claims: ClaimLog;
			readonly defects: readonly ReaderDefect[];
			/** What `ReadFacts.unreadTables` held when the reading closed. */
			readonly unreadTables: readonly UnreadTable[];
			/** Whether any slot reads the `locations` instance. */
			readonly readsLocations: boolean;
	  };

/** What the reader minted for the menus and forms the document holds. */
export interface ReadMenuAndFormIdentities {
	/** Every menu of HQ's app the document holds, a folded hidden menu under its synthetic UUID. */
	readonly modules: readonly {
		readonly uuid: Uuid;
		readonly uniqueId: string;
	}[];
	readonly forms: readonly {
		readonly uuid: Uuid;
		readonly xmlns: string;
		readonly moduleUniqueId: string;
	}[];
	/** Every create the document holds whose id is keyed by an answer, read from a Save to Case
	 *  block, with the prefix its id stands under in the source. The reading mints its own app,
	 *  form and operation identities, so `authoredCaseIdPrefix` of the document gives another
	 *  prefix; the reader compared each block printed under this one
	 *  (`ExpandOptions.keyedCaseIdPrefixes`, by `operationUuid`), and an export printed without
	 *  it files a key a worker enters again under a new case. `caseType` is the type the
	 *  operation creates in the source, which the prefix was derived with. */
	readonly keyedCreates: readonly {
		readonly operationUuid: Uuid;
		readonly formUuid: Uuid;
		readonly caseType: string;
		readonly prefix: string;
	}[];
	/** Every case list column the document holds whose source column over the case's name, its
	 *  opening date or its external id stores the property under one of the two words CommCare
	 *  HQ names it by (`suite/wire.ts::columnFieldWordOf`), with that word, by screen: the word
	 *  HQ's build names the column's app strings by. A column the source holds on both screens
	 *  has a row for each. */
	readonly columnFieldWords: readonly ColumnFieldWordRow[];
}

export interface ReadDraft {
	/** The document, before the gate. Acceptance runs the gate and export readiness over it. */
	readonly doc: BlueprintDoc;
	readonly identities: ReadMenuAndFormIdentities & {
		readonly entries: readonly IdentityMapEntry[];
	};
	readonly declaration: DeclarationChoices;
	readonly facts: ReadFacts;
}

/** Something the reader itself got wrong. Logged at error by the caller; never stored or shown. */
export interface ReaderDefect {
	readonly place: HqPlace;
	/** The surface key of the `unrecognized` finding it stands behind. */
	readonly name: string;
	/** What went wrong, for a developer: text only `defects.ts::readerDefect` builds, from closed
	 *  slots, so it holds no word of an app. */
	readonly why: ReaderDefectWhy;
}

/** Work done, a function of the input alone: JSON values and XML nodes visited, texts read with
 *  `readFormSyntax`, expected trees built for a generated node, and the work meter's units
 *  (`workMeter.ts`), by the door that charged them, beside the reading's limit
 *  (`work.ts::readWorkLimit`). */
export interface ReadWork {
	readonly nodes: number;
	readonly syntaxReads: number;
	readonly rebuilds: number;
	readonly units: number;
	readonly byKind: Readonly<Record<WorkKind, number>>;
	readonly limit: number;
}

export interface ReadFacts {
	/** HQ's `cloudcare_enabled`. */
	readonly webAppsOnInHq: boolean;
	/** Every media slot the draft holds whose path resolved to an asset. */
	readonly mediaReferences: readonly ReadMediaReference[];
	/** Each mapped itext reference on a slot that holds no media in Nova. HQ may require the file at install. */
	readonly unheldMedia: readonly (Omit<PendingMedia, "resolution"> & {
		readonly role: "hint" | "constraintMsg" | "label";
		readonly languageCode: string;
	})[];
	/** Every media reference handed off: no file for its path. */
	readonly pendingMedia: readonly PendingMedia[];
	/** Every itemset over a table the catalog does not hold, handed off, each tag an
	 *  expression reads that the catalog lacks, and each tag a form declares that the catalog
	 *  lacks and nothing reads (`declaredOnly`), at the place `{ kind: "lookup-table", tag }`. */
	readonly unreadTables: readonly UnreadTable[];
	/** The JSON Pointer over CommCare HQ's stored app (`/translations/<code>/<key>`) of each
	 *  generated translation key `assembleDocument` folded into the text it sets, and of a
	 *  first-language `app.display.name` the application walker read as the app's name. The key
	 *  names that text's place (`firstPublishPlaces.ts::placesOfGeneratedKey`). */
	readonly foldedTranslationKeys: readonly string[];
	readonly forms: readonly ReadFormFacts[];

	/** Each same-state rule applied: the entry, a JSON Pointer, and the id of the first-publish
	 *  register's row the rule falls under. */
	readonly sameStateRewrites: readonly SameStateRewrite[];
	/** The forms `compareEntryFacts` found differing. */
	readonly entryFactsRefused: readonly Uuid[];
	/**
	 * The `xmlns` of each form whose child cases the reading dropped as no change of a case: a
	 * form of a menu that selects several cases, or loads its case from a registry, that opens
	 * none, into whose source HQ's build writes no child case. HQ's entry still gives each child
	 * outside a repeat a `uuid()` datum, which nothing reads where the reading holds the form, so
	 * a comparison of the entry facts leaves those child cases out.
	 */
	readonly childCasesUnread: readonly string[];

	/** The expression stage's report, passed through: the rewrites it applied, each at its slot. */
	readonly rewrites: readonly ReadRewrite[];
	/** `ExpressionReading.rounds`, for the reading's log. */
	readonly expressionRounds: number;
}

/**
 * The first-publish register's rows a same-state reading of a menu, a case
 * list, a search or a form's case management is recorded under: each names a
 * rewrite of the stored app the first publish makes, with the paths it may
 * change.
 */
export const SAME_STATE_REGISTERS = [
	"case-settings-respelled",
	"search-filter-rows-recut",
	"sort-rule-kept-as-hidden-column",
	"list-settings-respelled",
	"search-filter-joined-to-list",
	"search-restates-list-filter",
	"link-held-case-guards-added",
] as const;

/**
 * The register's rows a reading records under that are no same-state rule of
 * a comparison: an app whose missing incomplete-forms setting still shows the shared
 * Web Apps tile (`appShell.ts::readProfile`), a date and time a Save to Case value wrote in Nova's earlier
 * spelling, a registration label read as the words CommCare HQ's build
 * writes for one with no text, a menu's or form's name map read as the
 * text HQ's build shows in each language where Nova prints another map
 * (`structure.ts::nameAsRead`), an app string of any surface where a worker
 * then reads another text in some language (one that shows blank beside a
 * source that does not where its role requires text, or begins with a space,
 * `heldText.ts::heldText`), a menu's, form's or case list item's media
 * map read as the file HQ's build shows in each language where Nova prints
 * another map (`menus/navMedia.ts::shownNavMedia`), a form's text whose
 * source spells, in a text node, a character Nova writes as a literal output
 * (`xform/prose.ts::recordTextOutputs`), a Hidden Value whose starting
 * value no runtime reads before its calculation replaces it, held as the
 * calculation alone (`xform/afterBinding.ts`), and a sort element whose
 * display names an `invisible` column in Android's Sort by under a header
 * blank in every language, an entry the first publish drops
 * (`caseList/order.ts::readSortElements`), a form whose `<h:title>` holds
 * other text than the name Nova writes there (`assemble.ts::recordTitleRewrites`),
 * and a form declaring a fixture no expression reads that the project space may
 * not serve, a declaration Nova does not write (`provisional.ts::claimDeclarations`).
 */
export const FIRST_PUBLISH_READING_RECORDS = [
	"incomplete-forms-tile-hidden",
	"date-and-time-saved-as-hq-stores-it",
	"registration-label-fixed",
	"names-respelled",
	"text-spaces-dropped",
	"media-maps-respelled",
	"form-text-characters-written-as-outputs",
	"hidden-value-defaults-dropped",
	"sort-by-entry-with-a-blank-name-dropped",
	"form-titles-written",
	"unread-fixture-declarations-dropped",
] as const;

export type SameStateRegister =
	| (typeof SAME_STATE_REGISTERS)[number]
	| (typeof FIRST_PUBLISH_READING_RECORDS)[number];

/** One rewrite a reading allowed: the entry claimed, the JSON Pointer of the
 *  stored value Nova writes back differently, and the register's row. */
/** A rewrite of `emissionRewrites.ts` the first publish applies at one slot of the source. */
export interface ReadRewrite {
	readonly id: ExpressionReading["rewrites"][number]["id"];
	readonly place: HqPlace;
	/** The surface key of the slot. */
	readonly key: string;
	/** The JSON Pointer over CommCare HQ's stored app of the value the slot was read from, where a
	 *  key of the app's JSON holds it (a column's `field`, a list's `filter`, a Search field's
	 *  `default_value`); absent for a slot of a form's XForm, whose place names its node. */
	readonly pointer?: string;
}

export interface SameStateRewrite {
	readonly entry: string;
	readonly path: string;
	readonly register: SameStateRegister;
}

export interface UnreadTable {
	readonly tag: string;
	readonly place: HqPlace;
	/** A table a form declares (`jr://fixture/item-list:<tag>`) and no expression of it reads:
	 *  nothing of the table comes in, and Core still loads it when the form opens. */
	readonly declaredOnly?: true;
}

export interface ReadFormFacts {
	readonly xmlns: string;
	/** Every generated node folded, by purpose, owner, path and the name the source gave it. */
	readonly generated: readonly ReadGeneratedNode[];
	/** The data path of every control, leaf or container, whose `appearance` was accounted under
	 *  an entry of standing `inert`, in body order. */
	readonly inertAppearances: readonly string[];
	/** The data path of every case region container and every Save to Case block. */
	readonly caseRegionPaths: readonly string[];
	/** The itext values blank in a language other than the first whose first-language text is not
	 *  blank, each read as no translation. */
	readonly blankTranslations: number;
}

export interface ReadGeneratedNode {
	readonly purpose: GeneratedNodePurpose;
	/** One key by one rule. For a question's node, the owner question's data path. For an
	 *  operation's node, the data path of the `nova_operations` scope it stands in, a `#`, and the
	 *  operation's id. */
	readonly owner: string;
	/** The node's absolute data path. */
	readonly path: string;
	readonly name: string;
}

export interface ReadMediaReference {
	readonly path: string;
	readonly assetId: string;
	/** The kind the slot naming the path plays (the itext form, `image` for a logo or an icon),
	 *  never the kind of the file the path resolves to: project data's media rules hold the
	 *  file's class to it (`projectData/media.ts::planHqMedia`), so a sound slot naming a file
	 *  HQ files as a video is that slot's finding before any file is fetched. */
	readonly mediaKind: MediaKind;
	readonly place: HqPlace;
	/** The JSON Pointer over CommCare HQ's stored app of the map or the value that names the path,
	 *  where a key of the app's JSON does (a menu's `media_image`, a case list column's enum
	 *  item's `value`, a `logo_refs` slot); absent for a form's itext, whose place names its node. */
	readonly pointer?: string;
	/** A `lib/domain/mediaRefs.ts::MediaRefLocation` kind: `field_media_bundle`, `option_media`,
	 *  `app_logo`, and the menu and list kinds the menu and list readers pass. */
	readonly slot: string;
}

/** A reference whose path the index gives no asset for: handed off, with its node in the log. */
export interface PendingMedia {
	readonly path: string;
	readonly mediaKind: MediaKind;
	readonly resolution: "no-entry" | "unreadable";
	readonly place: HqPlace;
	/** As `ReadMediaReference.pointer`. */
	readonly pointer?: string;
	/** As `ReadMediaReference.slot`, or `unheld_itext` for a slot Nova holds no media for. */
	readonly slot: string;
}
