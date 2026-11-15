/**
 * Menus and forms at the level of their own keys. Each menu and form of a
 * document type Nova does not hold is one finding at it, covering all it
 * holds; each the reading keeps gets its identity before anything under it
 * is minted, then its own record: its name in every language, its id, and
 * the keys no other stage reads. The keys of a menu's case list, search,
 * navigation and case management, and of a form's case actions and
 * navigation, are the menus and case readers'. The project space's levels
 * go onto the draft here, so they are in scope when expressions bind.
 */

import {
	type LanguageTag,
	type LocalizedValue,
	makeTranslationUnitId,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { generatedAppStringPattern } from "../appStringKeys";
import { instanceScanRead } from "../hqInstanceScan";
import type { Admitted } from "./accounting";
import { applicationReading } from "./appShell";
import {
	account,
	type Claim,
	type ClaimUse,
	defineClaims,
	refuse,
	take,
} from "./claims";
import type { DraftForm, DraftModule, ReadContext } from "./context";
import { generatedKeyOwner } from "./generatedTranslationKeys";
import { heldText, recordTextRewrite } from "./heldText";
import { cleanTrans, shownText } from "./hqText";
import { externalKey } from "./identity";
import { isJsonObject, type JsonCursor } from "./jsonCursor";
import { formPlace, menuPlace, whereText } from "./place";
import { levelsFromHq } from "./worldEntities";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

const MENU_CLASSES = ["Module", "AdvancedModule"] as const;
type MenuClass = (typeof MENU_CLASSES)[number];
const FORM_CLASSES = ["Form", "AdvancedForm"] as const;
type FormClass = (typeof FORM_CLASSES)[number];

/** One claim per class: `<name>@<class>`, its key the class's own spelling of the field. */
function perClass<U extends ClaimUse, const N extends string, C extends string>(
	name: N,
	classes: readonly C[],
	make: (entry: string, key: string) => Claim<U>,
	entry: string,
	field: string,
): Record<`${N}@${C}`, Claim<U>> {
	return Object.fromEntries(
		classes.map((cls) => [
			`${name}@${cls}`,
			make(entry, `schema:${cls}.${field}`),
		]),
	) as Record<`${N}@${C}`, Claim<U>>;
}

const MENU = defineClaims("structure.menu", {
	...perClass(
		"uniqueId",
		MENU_CLASSES,
		account,
		`${M}/modulebase-unique-id`,
		"unique_id",
	),
	...perClass(
		"uniqueIdMissing",
		MENU_CLASSES,
		refuse,
		`${M}/module-unique-id-missing`,
		"unique_id",
	),
	...perClass("name", MENU_CLASSES, take, `${M}/modulebase-name`, "name"),
	...perClass("forms", MENU_CLASSES, take, `${M}/module-forms`, "forms"),
	...perClass(
		"comment",
		MENU_CLASSES,
		account,
		`${M}/comment-module`,
		"comment",
	),
	...perClass(
		"otherUndeclared",
		MENU_CLASSES,
		refuse,
		`${M}/any-other-undeclared-key`,
		"<undeclared>",
	),
	"refDetails@Module": account(
		`${M}/module-ref-details`,
		"schema:Module.ref_details",
	),
	"referralList@Module": account(
		`${M}/module-referral-list`,
		"schema:Module.referral_list",
	),
	"displaySeparately@Module": account(
		`${M}/module-display-separately`,
		"schema:Module.<undeclared>",
	),
	"displayStyle@AdvancedModule": account(
		`${M}/display-style-on-an-advanced-or-shadow-module`,
		"schema:AdvancedModule.<undeclared>",
	),
	advanced: take(`${M}/advancedmodule`, "schema:AdvancedModule"),
});

/** A menu of a document type Nova does not hold: one finding, covering the whole menu. */
const MENU_TYPE = defineClaims("structure.menuType", {
	mirrorVersion1: refuse(
		`${M}/shadowmodule-version-1-or-key-absent-model-default-1`,
		"schema:ShadowModule.shadow_module_version",
	),
	mirrorWithNoSource: refuse(
		`${M}/shadowmodule-with-no-source-module-id-or-one-naming-no-module`,
		"schema:ShadowModule.source_module_id",
	),
	childMirror: refuse(
		`${M}/shadowmodule-v2-under-a-v2-shadow-menu-mirroring-a-non-shadow`,
		"schema:ShadowModule.root_module_id",
	),
	mirror: refuse(
		`${M}/shadowmodule-shadow-module-version-2`,
		"schema:ShadowModule",
	),
	report: refuse(
		`${M}/reportmodule-mobile-ucr-and-all-of-report-configs`,
		"schema:ReportModule",
	),
	unknown: refuse(`${M}/unknown-module-doc-type`, "schema:ModuleBase"),
});

const FORM = defineClaims("structure.form", {
	...perClass("formType", FORM_CLASSES, take, `${F}/form-type`, "form_type"),
	...perClass("uniqueId", FORM_CLASSES, account, `${F}/unique-id`, "unique_id"),
	...perClass(
		"xmlns",
		FORM_CLASSES,
		take,
		`${F}/xmlns-form-json-and-xform-data-node`,
		"xmlns",
	),
	...perClass(
		"sharedXmlns",
		FORM_CLASSES,
		refuse,
		`${F}/two-non-shadow-forms-sharing-an-xmlns`,
		"xmlns",
	),
	...perClass("name", FORM_CLASSES, take, `${F}/name-lang`, "name"),
	...perClass(
		"nameReadAsInstance",
		FORM_CLASSES,
		refuse,
		`${F}/form-name-read-as-an-instance`,
		"name",
	),
	...perClass("version", FORM_CLASSES, account, `${F}/version`, "version"),
	...perClass(
		"validationCache",
		FORM_CLASSES,
		account,
		`${F}/validation-cache`,
		"validation_cache",
	),
	...perClass("comment", FORM_CLASSES, account, `${F}/comment`, "comment"),
	...perClass(
		"submitNotificationLabel",
		FORM_CLASSES,
		account,
		`${F}/submit-notification-label`,
		"submit_notification_label",
	),
	...perClass(
		"showCountFalse",
		FORM_CLASSES,
		account,
		`${F}/show-count-false`,
		"show_count",
	),
	...perClass(
		"showCountTrue",
		FORM_CLASSES,
		account,
		`${F}/show-count-true`,
		"show_count",
	),
	...perClass(
		"submitLabelDefault",
		FORM_CLASSES,
		account,
		`${F}/submit-label-default`,
		"submit_label",
	),
	...perClass(
		"submitLabelOther",
		FORM_CLASSES,
		account,
		`${F}/submit-label-non-default`,
		"submit_label",
	),
	...perClass(
		"releaseNotesForm",
		FORM_CLASSES,
		account,
		`${F}/is-release-notes-form-true-with-or-without-enable-release-notes`,
		"is_release_notes_form",
	),
	...perClass(
		"releaseNotesFormEnabled",
		FORM_CLASSES,
		account,
		`${F}/is-release-notes-form-true-with-or-without-enable-release-notes`,
		"enable_release_notes",
	),
	...perClass(
		"notReleaseNotesForm",
		FORM_CLASSES,
		account,
		`${F}/is-release-notes-form-false-with-enable-release-notes-either-way`,
		"is_release_notes_form",
	),
	...perClass(
		"notReleaseNotesFormEnabled",
		FORM_CLASSES,
		account,
		`${F}/is-release-notes-form-false-with-enable-release-notes-either-way`,
		"enable_release_notes",
	),
	...perClass(
		"scheduleFormId",
		FORM_CLASSES,
		account,
		`${F}/schedule-form-id-set`,
		"schedule_form_id",
	),
	...perClass(
		"customInstances",
		FORM_CLASSES,
		account,
		`${F}/custom-instances-non-empty`,
		"custom_instances",
	),
	...perClass(
		"autoGpsCapture",
		FORM_CLASSES,
		account,
		`${F}/auto-gps-capture-form`,
		"auto_gps_capture",
	),
	...perClass(
		"caseReferences",
		FORM_CLASSES,
		account,
		`${F}/case-references-data-load`,
		"case_references_data",
	),
	caseReferencesLoad: account(
		`${F}/case-references-data-load`,
		"schema:CaseReferences.load",
	),
	...perClass(
		"putInRoot",
		FORM_CLASSES,
		account,
		`${F}/put-in-root-on-a-form-dynamic-key`,
		"<undeclared>",
	),
	...perClass(
		"noVellum",
		FORM_CLASSES,
		account,
		`${F}/no-vellum-removed-field-dynamic-key`,
		"<undeclared>",
	),
	...perClass(
		"otherUndeclared",
		FORM_CLASSES,
		refuse,
		`${F}/any-other-undeclared-key`,
		"<undeclared>",
	),
	advanced: take(`${F}/advancedform`, "schema:AdvancedForm"),
});

const FORM_TYPE = defineClaims("structure.formType", {
	shadow: refuse(`${F}/shadowform`, "schema:ShadowForm"),
	unknown: refuse(`${F}/unknown-form-doc-type`, "schema:FormBase.doc_type"),
	/** HQ could not read the form's source when it was last saved: its `xmlns` is null or empty. */
	blankSource: refuse(
		`${F}/blank-source-or-no-non-group-question`,
		"schema:Application._attachments",
	),
});

const MODULES = defineClaims("structure", {
	modules: take(
		"application-and-settings/modules",
		"schema:Application.modules",
	),
});

/** The menu classes the manifest holds, which a menu's `doc_type` chooses. */
const MODULE_DOC_TYPES: ReadonlySet<string> = new Set([
	"Module",
	"AdvancedModule",
	"ShadowModule",
	"ReportModule",
]);
const FORM_DOC_TYPES: ReadonlySet<string> = new Set([
	"Form",
	"AdvancedForm",
	"ShadowForm",
]);

function docTypeOf(value: Readonly<Record<string, unknown>>): string {
	return typeof value.doc_type === "string" ? value.doc_type : "";
}

function moduleClassOf(value: Readonly<Record<string, unknown>>): string {
	const docType = docTypeOf(value);
	return MODULE_DOC_TYPES.has(docType) ? docType : "ModuleBase";
}

function formClassOf(value: Readonly<Record<string, unknown>>): string {
	const docType = docTypeOf(value);
	return FORM_DOC_TYPES.has(docType) ? docType : "FormBase";
}

/** A `{ lang: text }` map's text in `language`, or empty where it holds none. */
function textIn(map: unknown, language: string | undefined): string {
	if (language === undefined || !isJsonObject(map)) return "";
	const text = map[language];
	return typeof text === "string" ? text : "";
}

/**
 * Which mirror entry a mirror menu stands under, the first that applies: a
 * version other than 2; no source, or a source naming no menu; a version 2
 * mirror under a version 2 mirror menu, mirroring a child of that menu's
 * source that is no mirror; any other version 2 mirror.
 */
function mirrorClaim(
	menu: Readonly<Record<string, unknown>>,
	menus: readonly Readonly<Record<string, unknown>>[],
): Claim<"refuse"> {
	const version = menu.shadow_module_version ?? 1;
	if (version !== 2) return MENU_TYPE.mirrorVersion1;
	const byId = (id: unknown) =>
		typeof id === "string" && id !== ""
			? menus.find((other) => other.unique_id === id)
			: undefined;
	const source = byId(menu.source_module_id);
	if (source === undefined) return MENU_TYPE.mirrorWithNoSource;
	const root = byId(menu.root_module_id);
	if (
		root !== undefined &&
		docTypeOf(root) === "ShadowModule" &&
		(root.shadow_module_version ?? 1) === 2 &&
		docTypeOf(source) !== "ShadowModule" &&
		typeof root.source_module_id === "string" &&
		source.root_module_id === root.source_module_id
	)
		return MENU_TYPE.childMirror;
	return MENU_TYPE.mirror;
}

/**
 * Reads a value a claim admitted that reaches no slot of its own: the
 * document holds it through another (a menu's or form's class, held as its
 * kind), so reading it is all the claim asks.
 */
function read(admitted: Admitted<unknown>): unknown {
	return admitted.value;
}

const CASE_REFERENCES = new WeakMap<DraftForm, JsonCursor>();

/** A form's `case_references_data`, whose `save` the case management reader claims. */
export function caseReferencesOf(form: DraftForm): JsonCursor | undefined {
	return CASE_REFERENCES.get(form);
}

/** A menu's or form's name map as a reading holds it (`nameAsRead`). */
export interface NameAsRead {
	/** The text CommCare HQ's build shows in the source language, as Nova holds it
	 *  (`heldName`): the name's own slot. */
	readonly source: string;
	/** By language code, the text HQ's build shows in each other language where Nova holds one
	 *  that differs from the source: the name's translations. */
	readonly translations: ReadonlyMap<string, string>;
	/** By language code, the text that language's own app strings hold for the name,
	 *  `clean_trans(name, [code] + langs)`, blank where its file leaves the string to the
	 *  `default` locale. A generated translation key folded over the name reads it
	 *  (`assemble.ts::keepShownText`). */
	readonly own: ReadonlyMap<string, string>;
	/** Whether Nova's print of the reading (`localization.ts::textMap`: every language's
	 *  translation, else the source) differs from the stored map, which the first publish then
	 *  rewrites. */
	readonly respelled: boolean;
	/** Whether a worker would read another name in some language after the first publish
	 *  (`heldName`). */
	readonly workersSeeAnother: boolean;
}

/** What Nova prints for a name read as `source` and `translations`: every language's text. */
function printedName(
	codes: readonly string[],
	source: string | undefined,
	read: Pick<NameAsRead, "source" | "translations">,
): Record<string, string> {
	return Object.fromEntries(
		codes.map((code) => [
			code,
			code === source
				? read.source
				: (read.translations.get(code) ?? read.source),
		]),
	);
}

/** Whether a stored map is, key for key and value for value, the map Nova prints. */
function spelledAsPrinted(
	stored: Readonly<Record<string, unknown>>,
	printed: Readonly<Record<string, string>>,
): boolean {
	const keys = Object.keys(stored);
	return (
		keys.length === Object.keys(printed).length &&
		keys.every(
			(code) => Object.hasOwn(printed, code) && stored[code] === printed[code],
		)
	);
}

/**
 * What Nova holds of a name that shows `shown` in each language of `codes`
 * (the build's languages, in order) with `source` the source language, or
 * undefined where Nova's gate admits no spelling of one of those texts: the
 * one holding of every app string (`heldText.ts::heldText`) for a name, whose
 * translation is never blank in Nova (`translationUnits.ts`), so a language
 * whose name shows blank beside a source that does not prints the source's
 * name, and a space at a name's start is dropped; `workersSeeAnother` is
 * whether that changes what a worker reads in some language.
 */
export function heldName(
	shown: ReadonlyMap<string, string>,
	codes: readonly string[],
	source: string,
):
	| Pick<NameAsRead, "source" | "translations" | "workersSeeAnother">
	| undefined {
	// A menu's and a form's name hold one content policy: text in every language.
	const held = heldText(shown, codes, source, "module-name");
	return held === undefined
		? undefined
		: {
				source: held.source,
				translations: held.translations,
				workersSeeAnother: held.workersSeeAnother,
			};
}

/**
 * A menu's or form's stored `name` map read, for an app whose languages are
 * `codes` (`app.langs`, in order) and whose source language is `source`, or
 * undefined where the reader cannot know what HQ's build shows from it (a map
 * that is no JSON object, or a value HQ would print and JSON does not fix,
 * `hqText.ts`), or Nova's gate admits no spelling of it (`heldName`).
 *
 * Each language reads as the text HQ's build shows there
 * (`hqText.ts::shownText`, over `app_strings.py` and
 * `xforms_extras.py::_trans`), held as `heldName` holds it: the source
 * language's in the slot, each other language's a translation where it
 * differs. Every map Nova's emitter writes prints back exactly. Any other map
 * (one that lacks a language, holds `null`, a blank beside text, a language
 * the app no longer lists, or a space at a name's end) is respelled by the
 * first publish, every language showing what HQ's build showed, except where
 * `workersSeeAnother`: a name that shows blank in a language beside a source
 * that does not, or begins with a space.
 */
export function nameAsRead(
	stored: unknown,
	codes: readonly string[],
	source: string | undefined,
): NameAsRead | undefined {
	const map = stored === undefined ? {} : stored;
	if (!isJsonObject(map)) return undefined;
	const own = new Map<string, string>();
	for (const code of codes) {
		const text = cleanTrans(map, [code, ...codes]);
		if (!text.ok) return undefined;
		own.set(code, text.text);
	}
	if (source === undefined)
		return {
			source: "",
			translations: new Map(),
			own,
			respelled: false,
			workersSeeAnother: false,
		};
	const shown = new Map<string, string>();
	for (const code of codes) {
		// `create_default_app_strings` skips a language spelled `default`.
		if (code === "default" && code !== source) continue;
		const text = shownText(map, code, codes);
		if (!text.ok) return undefined;
		shown.set(code, text.text);
	}
	const held = heldName(shown, codes, source);
	if (held === undefined) return undefined;
	return {
		...held,
		own,
		respelled: !spelledAsPrinted(map, printedName(codes, source, held)),
	};
}

/** What the structure stage read of one menu's or form's name: each language's own text
 *  (`NameAsRead.own`), and where its map is stored, so a later fold can record a change. */
export interface NameRead {
	readonly own: ReadonlyMap<string, string>;
	readonly entry: string;
	readonly path: string;
}

const NAMES_READ = new WeakMap<ReadContext, Map<TranslationUnitId, NameRead>>();

/** Each menu and form name a reading read, by unit. */
export function namesRead(
	ctx: ReadContext,
): ReadonlyMap<TranslationUnitId, NameRead> {
	return NAMES_READ.get(ctx) ?? new Map();
}

/**
 * Records that the first publish rewrites a name's stored map: under
 * `text-spaces-dropped` where a worker then reads another name in some
 * language, else under `names-respelled` (`heldText.ts::recordTextRewrite`).
 */
export function recordNameRewrite(
	ctx: ReadContext,
	name: Pick<NameRead, "entry" | "path">,
	workersSeeAnother: boolean,
): void {
	recordTextRewrite(ctx, name, "names-respelled", workersSeeAnother);
}

/**
 * A localized name, read by `nameAsRead`: its source text into the slot, each
 * other language's translation into the sink, and a record of the first
 * publish's rewrite of the stored map (`recordNameRewrite`). A map the reader
 * cannot know or Nova cannot hold is left unclaimed, so the close reports it
 * as `unrecognized`. Returns the reading, undefined where the map was left.
 */
function readName(
	ctx: ReadContext,
	unit: TranslationUnitId,
	json: JsonCursor,
	claim: Claim<"take">,
): NameAsRead | undefined {
	const languages = applicationReading(ctx)?.languages;
	const read = nameAsRead(
		json.peek("name"),
		languages?.codes ?? [],
		languages?.source,
	);
	if (read === undefined) return undefined;
	json.take("name", claim, (value) => value).value;
	const translated = new Map<LanguageTag, LocalizedValue>();
	for (const [code, text] of read.translations) {
		const tag = languages?.tagOf.get(code);
		if (tag !== undefined && !languages?.refused.has(code))
			translated.set(tag, text);
	}
	if (translated.size > 0) ctx.translations.set(unit, "text", translated);
	const name = {
		own: read.own,
		entry: claim.entry,
		path: `${json.pointer}/name`,
	};
	const held = NAMES_READ.get(ctx) ?? new Map();
	held.set(unit, name);
	NAMES_READ.set(ctx, held);
	if (read.respelled || read.workersSeeAnother)
		recordNameRewrite(ctx, name, read.workersSeeAnother);
	return read;
}

/**
 * The text `formWireName` writes into a form's source for a name read as
 * `read`: its text in the app's first language, which is the source's where
 * that language holds no translation.
 */
function wireNameOf(ctx: ReadContext, read: NameAsRead): string {
	const languages = applicationReading(ctx)?.languages;
	const first = languages?.first;
	return first === undefined || first === languages?.source
		? read.source
		: (read.translations.get(first) ?? read.source);
}

/**
 * Raises `form-name-read-as-an-instance` at a form whose name, as
 * `formWireName` writes it into the form's source, CommCare HQ's build reads
 * as an instance read, which Nova's gate refuses (`FORM_TEXT_READ_AS_INSTANCE`).
 */
export function refuseFormNameReadAsInstance(
	ctx: ReadContext,
	form: DraftForm,
	wireName: string,
): void {
	const instance = instanceScanRead(wireName);
	if (instance !== undefined)
		ctx.accounting.finding(
			FORM[`nameReadAsInstance@${form.docType}`] as Claim,
			form.place,
			{ name: instance },
		);
}

/** A form whose first-language name reads as an instance and that an app translation in that
 *  language words otherwise: the scan waits for the generated key's verdict. */
export interface DeferredFormName {
	readonly form: DraftForm;
	/** The first-language name as the form's map holds it, which the scan reads. */
	readonly stored: string;
	/** The language and key of the app translation over it. */
	readonly language: string;
	readonly key: string;
}

const DEFERRED_FORM_NAMES = new WeakMap<ReadContext, DeferredFormName[]>();

/** The forms whose instance scan waits for a generated key's verdict, in reading order. */
export function deferredFormNames(
	ctx: ReadContext,
): readonly DeferredFormName[] {
	return DEFERRED_FORM_NAMES.get(ctx) ?? [];
}

/**
 * Scans the name a form's source would hold once every generated key over it is decided. A key
 * that folded wrote its own wording there, so a deferred form whose key `folded` names is clear;
 * every other is scanned on its stored name. Runs once, after the keys' verdicts.
 */
export function settleDeferredFormNames(
	ctx: ReadContext,
	folded: ReadonlySet<string>,
): void {
	for (const one of deferredFormNames(ctx))
		if (!folded.has(`${one.language}\u0000${one.key}`))
			refuseFormNameReadAsInstance(ctx, one.form, one.stored);
}

/**
 * The app translation that words a form's name in the app's first language
 * (the generated key `forms.m#f#` at the form's position, a non-blank text),
 * which HQ's build lays over the name there
 * (`app_strings.py::SelectKnownAppStrings.app_strings_parts`).
 */
function firstLanguageNameOverride(
	ctx: ReadContext,
	form: DraftForm,
): { readonly key: string; readonly value: string } | undefined {
	const reading = applicationReading(ctx);
	const first = reading?.languages.first;
	if (reading === undefined || first === undefined) return undefined;
	for (const held of reading.generatedKeys) {
		if (held.language !== first || typeof held.value !== "string") continue;
		if (held.value === "") continue;
		if (generatedAppStringPattern(held.key) !== "forms.m#f#") continue;
		const owner = generatedKeyOwner(held.key);
		if (
			owner.kind === "form" &&
			owner.menu === form.menu &&
			owner.form === form.index
		)
			return { key: held.key, value: held.value };
	}
	return undefined;
}

/**
 * Scans a form's name for an instance read, as `formWireName` writes it after
 * the generated keys are decided. Where an app translation words the name in
 * the first language without one, the wording is written there now, so the
 * strings Nova's build makes of the reading can be made, and the scan waits
 * for that key's verdict (`settleDeferredFormNames`): it folds and the source
 * holds the wording, or it does not and the stored name is scanned.
 */
function scanFormName(
	ctx: ReadContext,
	draft: DraftForm,
	unit: TranslationUnitId,
	read: NameAsRead,
): string {
	const wireName = wireNameOf(ctx, read);
	if (instanceScanRead(wireName) === undefined) return read.source;
	const override = firstLanguageNameOverride(ctx, draft);
	const languages = applicationReading(ctx)?.languages;
	if (
		override === undefined ||
		languages?.first === undefined ||
		instanceScanRead(override.value) !== undefined
	) {
		refuseFormNameReadAsInstance(ctx, draft, wireName);
		return read.source;
	}
	const deferred = DEFERRED_FORM_NAMES.get(ctx) ?? [];
	deferred.push({
		form: draft,
		stored: wireName,
		language: languages.first,
		key: override.key,
	});
	DEFERRED_FORM_NAMES.set(ctx, deferred);
	if (languages.first === languages.source) return override.value;
	const tag = languages.tagOf.get(languages.first);
	if (tag !== undefined)
		ctx.translations.set(unit, "text", new Map([[tag, override.value]]));
	return read.source;
}

/** A menu's own keys: its name, id, forms list, comment and the dynamic keys HQ leaves on it. */
function readMenuKeys(
	ctx: ReadContext,
	draft: DraftModule,
	cls: MenuClass,
): void {
	const { json } = draft;
	json.account("unique_id", MENU[`uniqueId@${cls}`] as Claim<"account">);
	const name =
		readName(
			ctx,
			makeTranslationUnitId("module", draft.uuid, "name"),
			json,
			MENU[`name@${cls}`] as Claim<"take">,
		)?.source ?? "";
	ctx.writeDraft(() => {
		Object.assign(draft.module, { uuid: draft.uuid, name });
	});
	json.account("comment", MENU[`comment@${cls}`] as Claim<"account">);
	if (cls === "Module") {
		json.account("ref_details", MENU["refDetails@Module"] as Claim<"account">);
		json.account(
			"referral_list",
			MENU["referralList@Module"] as Claim<"account">,
		);
	}
	for (const key of json.undeclared()) {
		if (cls === "Module" && key === "display_separately")
			json.account(key, MENU["displaySeparately@Module"] as Claim<"account">);
		else if (cls === "AdvancedModule" && key === "display_style")
			json.account(
				key,
				MENU["displayStyle@AdvancedModule"] as Claim<"account">,
			);
		else
			json.refuse(key, MENU[`otherUndeclared@${cls}`] as Claim<"refuse">, {
				name: key,
			});
	}
}

/** Whether every language's submit label is HQ's own (`FormBase.get_submit_label`) or blank. */
function submitLabelIsDefault(value: unknown): boolean {
	return (
		isJsonObject(value) &&
		Object.values(value).every((text) => text === "Submit" || text === "")
	);
}

/** A form's own keys: its name, id, type and the settings no other stage reads. */
function readFormKeys(
	ctx: ReadContext,
	draft: DraftForm,
	cls: FormClass,
): void {
	const { json } = draft;
	const claim = <U extends ClaimUse>(name: string) =>
		FORM[`${name}@${cls}` as keyof typeof FORM] as Claim<U>;
	json.account("unique_id", claim<"account">("uniqueId"));
	read(json.take("form_type", claim<"take">("formType"), (value) => value));
	const unit = makeTranslationUnitId("form", draft.uuid, "name");
	const names = readName(ctx, unit, json, claim<"take">("name"));
	/* The text `formWireName` writes into the form's source is the name in the
	 * app's first language, not the source language's: CommCare HQ's build
	 * reads `instance('…')` there as an instance read and Nova's gate refuses
	 * it. */
	const name = names === undefined ? "" : scanFormName(ctx, draft, unit, names);
	ctx.writeDraft(() => {
		Object.assign(draft.form, { uuid: draft.uuid, name });
	});
	json.account("version", claim("version"));
	json.account("validation_cache", claim("validationCache"));
	json.account("comment", claim("comment"));
	json.account("submit_notification_label", claim("submitNotificationLabel"));
	json.account(
		"show_count",
		json.peek("show_count") === true
			? claim("showCountTrue")
			: claim("showCountFalse"),
	);
	json.account(
		"submit_label",
		submitLabelIsDefault(json.peek("submit_label"))
			? claim("submitLabelDefault")
			: claim("submitLabelOther"),
	);
	const releaseNotes = json.peek("is_release_notes_form") === true;
	json.account(
		"is_release_notes_form",
		releaseNotes ? claim("releaseNotesForm") : claim("notReleaseNotesForm"),
	);
	json.account(
		"enable_release_notes",
		releaseNotes
			? claim("releaseNotesFormEnabled")
			: claim("notReleaseNotesFormEnabled"),
	);
	json.account("schedule_form_id", claim("scheduleFormId"));
	json.account("custom_instances", claim("customInstances"));
	json.account("auto_gps_capture", claim("autoGpsCapture"));
	const references = json.object(
		"case_references_data",
		"CaseReferences",
		claim<"account">("caseReferences"),
	);
	references.account("load", FORM.caseReferencesLoad);
	CASE_REFERENCES.set(draft, references);
	for (const key of json.undeclared()) {
		if (key === "put_in_root") json.account(key, claim("putInRoot"));
		else if (key === "no_vellum") json.account(key, claim("noVellum"));
		else json.refuse(key, claim("otherUndeclared"), { name: key });
	}
}

interface MenuCandidate {
	readonly index: number;
	readonly json: JsonCursor;
	readonly cls: MenuClass;
	readonly place: HqPlace;
	readonly name: string;
	uniqueId: string | undefined;
	readonly forms: FormCandidate[];
}

interface FormCandidate {
	readonly index: number;
	readonly json: JsonCursor;
	readonly cls: FormClass;
	readonly place: Extract<HqPlace, { kind: "form" }>;
	xmlns: string | undefined;
}

/**
 * Stage 2. Reads `modules` in HQ's order beside the aligned read, gives each
 * menu and form of a type Nova does not hold its one finding, settles
 * identity before any mint (a menu with no id, a form whose `xmlns` is
 * blank, two forms of one `xmlns`), mints each menu and form in HQ's order,
 * and reads each one's own keys into its draft.
 */
export function readStructure(ctx: ReadContext): void {
	const { input } = ctx;
	ctx.writeDraft(() => {
		ctx.draft.levels = levelsFromHq(
			input.organization.levels,
			ctx.resolver,
		).levels;
	});
	const first = applicationReading(ctx)?.languages.first;
	const rawMenus = ctx.app.peek("modules");
	const menus = Array.isArray(rawMenus) ? rawMenus.filter(isJsonObject) : [];
	const cursors = ctx.app.list(
		"modules",
		moduleClassOf,
		MODULES.modules,
		(index, value) =>
			menuPlace(index, isJsonObject(value) ? textIn(value.name, first) : ""),
	);
	if (cursors.length !== input.source.modules.length)
		throw new Error(
			`The reader was given a source of ${input.source.modules.length} menus whose app holds ${cursors.length} menu objects. Pass the source and its raw app from the same read.`,
		);

	const candidates: MenuCandidate[] = [];
	cursors.forEach((json, index) => {
		const menu = menus[index];
		const place = json.place;
		const name = place.kind === "menu" ? place.name : "";
		switch (json.cls) {
			case "ShadowModule":
				json.refuseWhole(mirrorClaim(menu, menus));
				return;
			case "ReportModule":
				json.refuseWhole(MENU_TYPE.report);
				return;
			case "Module":
			case "AdvancedModule":
				break;
			default:
				json.refuseWhole(MENU_TYPE.unknown, { name: docTypeOf(menu) });
				return;
		}
		const cls = json.cls as MenuClass;
		if (cls === "AdvancedModule") read(json.takeClass(MENU.advanced));
		const uniqueId = json.peek("unique_id");
		if (typeof uniqueId !== "string" || uniqueId === "") {
			json.refuseWhole(MENU[`uniqueIdMissing@${cls}`] as Claim<"refuse">);
			return;
		}
		const forms: FormCandidate[] = [];
		const formCursors = json.list(
			"forms",
			formClassOf,
			MENU[`forms@${cls}`] as Claim<"take">,
			(formIndex, value) =>
				formPlace(
					index,
					formIndex,
					name,
					isJsonObject(value) ? textIn(value.name, first) : "",
				),
		);
		formCursors.forEach((form, formIndex) => {
			switch (form.cls) {
				case "ShadowForm":
					form.refuseWhole(FORM_TYPE.shadow);
					return;
				case "Form":
				case "AdvancedForm":
					break;
				default:
					form.refuseWhole(FORM_TYPE.unknown, {
						name: String(form.peek("doc_type") ?? ""),
					});
					return;
			}
			const formCls = form.cls as FormClass;
			if (formCls === "AdvancedForm") read(form.takeClass(FORM.advanced));
			const xmlns = form.peek("xmlns");
			if (typeof xmlns !== "string" || xmlns === "") {
				form.refuseWhole(FORM_TYPE.blankSource);
				return;
			}
			forms.push({
				index: formIndex,
				json: form,
				cls: formCls,
				place: form.place as Extract<HqPlace, { kind: "form" }>,
				xmlns,
			});
		});
		candidates.push({ index, json, cls, place, name, uniqueId, forms });
	});

	/* Two forms of one `xmlns`: each is refused, and neither is minted. */
	const formsByXmlns = new Map<string, FormCandidate[]>();
	for (const menu of candidates)
		for (const form of menu.forms) {
			if (form.xmlns === undefined) continue;
			const holders = formsByXmlns.get(form.xmlns) ?? [];
			holders.push(form);
			formsByXmlns.set(form.xmlns, holders);
		}
	for (const holders of formsByXmlns.values()) {
		if (holders.length < 2) continue;
		for (const form of holders) {
			form.json.refuseWhole(FORM[`sharedXmlns@${form.cls}`] as Claim<"refuse">);
			form.xmlns = undefined;
		}
	}

	/* Identity, in HQ's order: each menu, then its forms. */
	for (const menu of candidates) {
		const uniqueId = menu.uniqueId;
		if (uniqueId === undefined) continue;
		const uuid: Uuid | undefined = ctx.accounting.identity(
			ctx.resolver.claim(externalKey.module(uniqueId), whereText(menu.place)),
			menu.place,
			`schema:${menu.cls}.unique_id`,
		);
		if (uuid === undefined) continue;
		const draft: DraftModule = {
			index: menu.index,
			uniqueId,
			uuid,
			docType: menu.cls,
			json: menu.json,
			place: menu.place,
			module: {},
			forms: [],
		};
		ctx.writeDraft(() => {
			ctx.draft.modules.push(draft);
		});
		readMenuKeys(ctx, draft, menu.cls);
		for (const form of menu.forms) {
			const xmlns = form.xmlns;
			if (xmlns === undefined) continue;
			const formUuid = ctx.accounting.identity(
				ctx.resolver.claim(externalKey.form(xmlns), whereText(form.place)),
				form.place,
				`schema:${form.cls}.xmlns`,
			);
			if (formUuid === undefined) continue;
			const admitted = form.json.take(
				"xmlns",
				FORM[`xmlns@${form.cls}`] as Claim<"take">,
				() => xmlns,
			);
			const formDraft: DraftForm = {
				menu: menu.index,
				index: form.index,
				xmlns: admitted.value,
				uuid: formUuid,
				docType: form.cls,
				json: form.json,
				place: form.place,
				form: {},
				xform: null,
				operationIdPaths: new Map(),
			};
			ctx.writeDraft(() => {
				draft.forms.push(formDraft);
			});
			readFormKeys(ctx, formDraft, form.cls);
		}
	}
}
