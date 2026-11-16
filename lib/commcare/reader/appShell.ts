/**
 * The application walker: every key of an HQ app's root object, claimed
 * against the manifest entry that covers it at the value it holds. It reads
 * the app's name, languages, Web Apps switch, profile settings and Web Apps
 * logo into the draft, holds each form's source for the forms stage, holds
 * the translation keys HQ's build generates for the assembly, and judges the
 * app's CommCare version against Nova's floor.
 */

import { makeTranslationUnitId } from "@/lib/domain";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { isRuntimeUiStringKey, translationKeyOwner } from "../appStringKeys";
import type { NovaOwnedDerivedProfilePropertyKey } from "../derivedProfile";
import { inventoryIndex } from "../surface/inventory";
import surface from "../surface/surface.json";
import { compareToVersionFloor } from "../versionFloor";
import type { Admitted } from "./accounting";
import {
	account,
	type Claim,
	claimPermits,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "./claims";
import type { ReadContext } from "./context";
import {
	heldText,
	keyDefinedAfterLineEnd,
	LINE_END_DEFINES_KEY,
	recordTextRewrite,
	refuseUnheldText,
	unheldText,
} from "./heldText";
import {
	isJsonObject,
	type JsonCursor,
	pointerToken,
	sameJson,
} from "./jsonCursor";
import {
	type HqLanguages,
	manifestFindingOf,
	readLanguages,
} from "./languages";
import { appPlace, appSettingsPlace } from "./place";

const A = "application-and-settings";
const key = (name: string) => `schema:Application.${name}`;

/** Keys accounted under one entry whatever they hold: kept at CommCare HQ, inert, or refused. */
type AccountedKeys = readonly [entry: string, keys: readonly string[]];
const ACCOUNTED: readonly AccountedKeys[] = [
	["id", ["_id"]],
	["rev-domain-copy-of-version", ["_rev", "domain", "copy_of", "version"]],
	[
		"short-odk-url-short-odk-media-url",
		["short_odk_url", "short_odk_media_url"],
	],
	[
		"built-with-build-signed-built-on-build-comment-comment-from-last",
		[
			"built_with",
			"build_signed",
			"built_on",
			"build_comment",
			"comment_from",
			"last_released",
			"build_broken",
			"build_broken_reason",
			"is_auto_generated",
			"is_released",
		],
	],
	[
		"date-created-created-from-template-last-modified-has-submissions",
		[
			"date_created",
			"created_from_template",
			"last_modified",
			"has_submissions",
		],
	],
	["copy-history-family-id", ["copy_history", "family_id"]],
	["external-blobs", ["external_blobs"]],
	["archived-media", ["archived_media"]],
	[
		"amplifies-workers-amplifies-project-minimum-use-threshold",
		[
			"amplifies_workers",
			"amplifies_project",
			"minimum_use_threshold",
			"experienced_threshold",
		],
	],
	["recipients", ["recipients"]],
	[
		"admin-password-admin-password-charset",
		["admin_password", "admin_password_charset"],
	],
	[
		"cached-properties-description-deployment-date-phone-model-user",
		[
			"cached_properties",
			"description",
			"deployment_date",
			"phone_model",
			"user_type",
			"attribution_notes",
		],
	],
	["vellum-case-management", ["vellum_case_management"]],
	["comment-app", ["comment"]],
	["smart-lang-display", ["smart_lang_display"]],
	["39-hq-case-sharing", ["case_sharing"]],
	["46-hq-use-grid-menus", ["use_grid_menus"]],
	["47-hq-grid-form-menus-none-all-some", ["grid_form_menus"]],
	["51-hq-persistent-menu", ["persistent_menu"]],
	["52-hq-show-breadcrumbs", ["show_breadcrumbs"]],
	["35-hq-practice-mobile-worker-id", ["practice_mobile_worker_id"]],
	["36-hq-custom-base-url", ["custom_base_url"]],
	["43-hq-secure-submissions", ["secure_submissions"]],
	["non-empty-custom-assertions-app", ["custom_assertions"]],
	/* The media map is read through the reading's media index, never here. */
	["multimedia-map", ["multimedia_map"]],
	["add-ons", ["add_ons"]],
];

const ACCOUNTED_CLAIMS = defineClaims(
	"appShell.accounted",
	Object.fromEntries(
		ACCOUNTED.flatMap(([entry, keys]) =>
			keys.map((name) => [name, account(`${A}/${entry}`, key(name))]),
		),
	),
);

/** A setting HQ reads as one of two classes of value, the first at HQ's default. */
const BY_VALUE = defineClaims("appShell.byValue", {
	applicationVersion2: account(
		`${A}/33-hq-application-version-2-0`,
		key("application_version"),
	),
	applicationVersion1: account(
		`${A}/33p-hq-application-version-1-0`,
		key("application_version"),
	),
	customSuiteOff: account(
		`${A}/41-hq-use-custom-suite-false`,
		key("use_custom_suite"),
	),
	customSuiteOn: account(
		`${A}/41p-hq-use-custom-suite-true`,
		key("use_custom_suite"),
	),
	selectKnown: account(
		`${A}/44-hq-translation-strategy-select-known`,
		key("translation_strategy"),
	),
	notSelectKnown: account(
		`${A}/44p-hq-translation-strategy-select-known`,
		key("translation_strategy"),
	),
	flavorNone: account(
		`${A}/48-hq-target-commcare-flavor-none`,
		key("target_commcare_flavor"),
	),
	flavorOther: account(
		`${A}/48p-hq-target-commcare-flavor-commcare-commcare-lts`,
		key("target_commcare_flavor"),
	),
	ucr2: account(
		`${A}/49-hq-mobile-ucr-restore-version-2-0`,
		key("mobile_ucr_restore_version"),
	),
	ucrOlder: account(
		`${A}/49p-hq-mobile-ucr-restore-version-1-0-1-5`,
		key("mobile_ucr_restore_version"),
	),
	buildProfilesEmpty: account(
		`${A}/build-profiles-each-profile-s-name-langs-practice-mobile-worker`,
		key("build_profiles"),
	),
	buildProfilesNonEmpty: account(
		`${A}/build-profiles-non-empty`,
		key("build_profiles"),
	),
	/* Nova writes `project_default` and reads the flat fixture, so both held values are derived. */
	fixtureProjectDefault: derived(
		`${A}/50-hq-location-fixture-restore-project-default`,
		key("location_fixture_restore"),
	),
	fixtureFlat: derived(
		`${A}/50p-hq-location-fixture-restore-both-fixtures-only-flat-fixture`,
		key("location_fixture_restore"),
	),
	fixtureHierarchicalOnly: refuse(
		`${A}/50pp-hq-location-fixture-restore-only-hierarchical-fixture`,
		key("location_fixture_restore"),
	),
});

const CLAIMS = defineClaims("appShell", {
	/** Nova writes `Application` for every app, so the value reaches no slot. */
	docType: derived(`${A}/doc-type-application`, key("doc_type")),
	name: take(`${A}/name`, key("name")),
	attachments: take(`${A}/attachments-form-unique-id-xml`, key("_attachments")),
	orphanAttachments: drop(
		`${A}/attachments-entry-for-a-form-no-longer-in-the-app`,
		key("_attachments"),
	),
	cloudcareEnabled: take(
		`${A}/40-hq-cloudcare-enabled`,
		key("cloudcare_enabled"),
	),
	buildSpecAtFloor: account(
		`${A}/34-hq-build-spec-at-or-above-nova-s-floor-2-57`,
		key("build_spec"),
	),
	buildSpecBelowFloor: refuse(
		`${A}/34p-hq-build-spec-below-nova-s-floor`,
		key("build_spec"),
	),
	logoWebApps: take(`${A}/logo-refs-hq-logo-web-apps`, key("logo_refs")),
	logoAndroid: account(
		`${A}/logo-refs-hq-logo-android-home-login-demo`,
		key("logo_refs"),
	),
	logoNotFromUploader: refuse(
		`${A}/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`,
		key("logo_refs"),
	),
	dynamicKey: account(
		`${A}/dynamic-keys-anonymous-cloudcare-enabled-anonymous-cloudcare`,
		key("<undeclared>"),
	),
	readOnlyKey: refuse(
		`${A}/an-unknown-top-level-key-naming-an-application-read-only`,
		key("<undeclared>"),
	),
	otherUnknownKey: account(
		`${A}/any-other-unknown-top-level-key-that-names-no-application`,
		key("<undeclared>"),
	),
	/** A `name` the profile shows otherwise than the app strings do (`holdAppName`). */
	nameShownTwoWays: refuse(
		`${A}/app-name-holding-backslash-n-a-backslash-before-hash-or-a-carriage-return`,
		null,
	),
});

const TRANSLATIONS = key("translations");
const TRANSLATION_CLAIMS = defineClaims("appShell.translations", {
	/** The language map itself, read into language names and the app name's translations. */
	container: take(`${A}/translations-app-display-name`, TRANSLATIONS),
	appDisplayName: take(`${A}/translations-app-display-name`, TRANSLATIONS),
	/** The value is read into nothing: Nova derives its label from the language's identity. */
	languageName: derived(
		`${A}/translations-lang-code-language-display-names-equal-to-the-label`,
		TRANSLATIONS,
	),
	languageNameOther: account(
		`${A}/translations-lang-code-any-other-value-or-absent-where-hq-s`,
		TRANSLATIONS,
	),
	homescreenTitle: account(`${A}/translations-homescreen-title`, TRANSLATIONS),
	runtimeUiString: account(
		`${A}/translations-key-in-a-runtime-s-ui-string-catalog-core-android`,
		TRANSLATIONS,
	),
	unread: account(`${A}/translations-key-no-runtime-reads`, TRANSLATIONS),
});

interface SurfaceItem {
	readonly declared?: boolean;
	readonly values?: readonly unknown[];
	readonly default?: unknown;
}
const ITEMS = (
	surface as { readonly items: Readonly<Record<string, SurfaceItem>> }
).items;

function surfaceItem(id: string): SurfaceItem | undefined {
	return Object.hasOwn(ITEMS, id) ? ITEMS[id] : undefined;
}

const PROFILE = key("profile");
/** The custom property Nova derives from the document's Search. */
const INDEX_CASE_SEARCH_RESULTS: NovaOwnedDerivedProfilePropertyKey =
	"cc-index-case-search-results";

const OUTSIDE_CHOICES = `${A}/profile-properties-or-features-dependencies-value-outside-its`;

/** Each profile setting's `setting:` key: every `properties` and `features` key HQ's settings name. */
const SETTING_KEYS: readonly string[] = Object.keys(ITEMS).filter(
	(id) =>
		id.startsWith("setting:properties.") || id.startsWith("setting:features."),
);

/** A setting's entry that a key's value is accounted under, with the class of value it takes. */
interface SettingAccount {
	readonly claim: Claim<"account">;
	readonly valueClass: string | null;
}

/**
 * Each setting's claims, from the entries naming its key: a value outside its
 * choices under the one entry that refuses those, and any other value under
 * the entry that holds the key, or, where two do, the one whose class takes
 * the value. An entry Nova reads into the document (`cc-show-saved`,
 * `cc-show-incomplete`, the Web Apps logo) has a reader of its own.
 */
const SETTING_ACCOUNTS = new Map<string, readonly SettingAccount[]>();
const OUTSIDE_CHOICES_CLAIMS: Record<string, Claim<"refuse">> = {};
for (const setting of SETTING_KEYS) {
	const accounts: SettingAccount[] = [];
	for (const entry of inventoryIndex().naming(setting)) {
		if (entry.id === OUTSIDE_CHOICES)
			OUTSIDE_CHOICES_CLAIMS[setting] = refuse(entry.id, setting);
		else if (claimPermits("account", entry.standing))
			accounts.push({
				claim: account(entry.id, setting),
				valueClass: entry.valueClass,
			});
	}
	if (accounts.length > 0) SETTING_ACCOUNTS.set(setting, accounts);
}
defineClaims(
	"appShell.setting",
	Object.fromEntries(
		[...SETTING_ACCOUNTS].flatMap(([setting, accounts]) =>
			accounts.map(
				(one) => [`${setting}@${one.valueClass ?? "any"}`, one.claim] as const,
			),
		),
	),
);
defineClaims("appShell.outsideChoices", OUTSIDE_CHOICES_CLAIMS);

/** The entry a setting's value is accounted under: the one entry that names the key, else the one
 *  whose class is the value. */
function settingAccount(
	setting: string,
	value: unknown,
): Claim<"account"> | undefined {
	const accounts = SETTING_ACCOUNTS.get(setting) ?? [];
	if (accounts.length === 1) return accounts[0]?.claim;
	return accounts.find((one) => one.valueClass === String(value))?.claim;
}

const PROFILE_CLAIMS = defineClaims("appShell.profile", {
	/** `profile` and its `properties` and `features` bags, each walked key by key. */
	container: account(
		`${A}/any-other-profile-properties-features-key-not-in-the-yaml`,
		PROFILE,
	),
	senseOrReviewEntry: refuse(
		`${A}/profile-features-sense-true-or-profile-properties-cc-entry-mode`,
		PROFILE,
	),
	notInTheSettings: account(
		`${A}/any-other-profile-properties-features-key-not-in-the-yaml`,
		PROFILE,
	),
	/** Nova writes this property from the document's Search on every publish
	 *  (`derivedProfile.ts`), so the value reaches no slot. */
	indexCaseSearchResults: derived(
		`${A}/profile-custom-properties-cc-index-case-search-results-equal-to`,
		"profile-property:cc-index-case-search-results",
	),
	otherCustomProperty: refuse(
		`${A}/profile-custom-properties-any-other-entry-incl-formplayer-keys`,
		PROFILE,
	),
	showSaved: take(
		`${A}/20-properties-cc-show-saved`,
		"setting:properties.cc-show-saved",
	),
	showIncomplete: take(
		`${A}/21-properties-cc-show-incomplete`,
		"setting:properties.cc-show-incomplete",
	),
});

/** The names CommCare HQ stores at the root without declaring them, read by nothing at the pin. */
const DYNAMIC_KEYS: ReadonlySet<string> = new Set([
	"anonymous_cloudcare_enabled",
	"anonymous_cloudcare_hash",
	"linked_whitelist",
	"media_language_map",
	"mobile_ucr_sync_interval",
	"media_form_errors",
	"user_registration",
	"split_screen_dynamic_search",
]);

/** A root key naming one of `Application`'s read-only properties or methods: the surface lists it
 *  under `schema:Application.<name>` and does not declare it a stored key. */
function namesReadOnlyApplicationMember(name: string): boolean {
	const item = surfaceItem(key(name));
	return item !== undefined && item.declared !== true;
}

/** A translation key held for the assembly, which classifies it against Nova's own strings. */
export interface HeldTranslationKey {
	/** The language code whose strings hold it. */
	readonly language: string;
	readonly key: string;
	readonly value: unknown;
	/** The language's strings, the cursor its claim is made on. */
	readonly json: JsonCursor;
}

/** What the application stage leaves for later stages beside the draft. */
export interface ApplicationReading {
	readonly languages: HqLanguages;
	/** `_attachments`, admitted where a form of this read names an entry: the forms stage reads
	 *  each form's source from it. */
	readonly attachments: Admitted<Readonly<Record<string, unknown>>> | undefined;
	/** Each key of HQ's generated patterns in an app language's strings, in source order. */
	readonly generatedKeys: readonly HeldTranslationKey[];
}

const READINGS = new WeakMap<ReadContext, ApplicationReading>();

/** What the application stage left for this reading; undefined before it ran. */
export function applicationReading(
	ctx: ReadContext,
): ApplicationReading | undefined {
	return READINGS.get(ctx);
}

/** Each key the cursor's object holds, in its order. */
function keysOf(json: JsonCursor): readonly string[] {
	return json.undeclared();
}

/**
 * `build_spec.version` against Nova's floor, the comparison publish makes.
 * Below the floor, or a version the comparison cannot read, is a finding at
 * the app's settings with the version as HQ holds it.
 */
function readBuildSpec(ctx: ReadContext): void {
	if (!ctx.app.used("build_spec")) return;
	const spec = ctx.app.peek("build_spec");
	const version =
		isJsonObject(spec) && typeof spec.version === "string" ? spec.version : "";
	if (compareToVersionFloor(version) === "at-or-above") {
		ctx.app.account("build_spec", CLAIMS.buildSpecAtFloor);
		return;
	}
	const place = appSettingsPlace();
	const detail = { name: version };
	ctx.accounting.finding(CLAIMS.buildSpecBelowFloor, place, detail);
	ctx.accounting.cover(
		{ json: ctx.app, key: "build_spec" },
		manifestFindingOf(CLAIMS.buildSpecBelowFloor, place, detail),
	);
}

const WEB_APPS_LOGO = "hq_logo_web_apps";
const ANDROID_LOGOS: ReadonlySet<string> = new Set([
	"hq_logo_android_home",
	"hq_logo_android_login",
	"hq_logo_android_demo",
]);

/**
 * Whether a logo entry is one CommCare HQ's uploader wrote: an object whose
 * `path` is `jr://file/commcare/logo/data/<slot>` with at most an extension
 * after it (`hqmedia/views.py::ProcessLogoFileUploadView.form_path`), and
 * which holds an `m_id`, which the uploader always stores
 * (`ProcessLogoFileUploadView.process_upload`).
 */
function fromUploader(slot: string, ref: unknown): ref is { path: string } {
	if (!isJsonObject(ref)) return false;
	const { path, m_id: mediaId } = ref;
	if (typeof mediaId !== "string" || mediaId === "") return false;
	const prefix = `jr://file/commcare/logo/data/${slot}`;
	if (typeof path !== "string" || !path.startsWith(prefix)) return false;
	const rest = path.slice(prefix.length);
	return rest === "" || (rest.startsWith(".") && !rest.includes("/"));
}

/**
 * `logo_refs`, one use claimed once. The Web Apps slot is the app's logo; the
 * three Android slots are kept at CommCare HQ; a slot the uploader did not
 * write is a finding of its own, named by the slot. The uploader takes any
 * slot name (`hqmedia/urls.py`, `logo_name`), and a slot of another name it
 * wrote is read by no runtime (`const.py::ANDROID_LOGO_PROPERTY_MAPPING`
 * names the four HQ's build and Web Apps read), so it adds nothing here: a
 * `logo_refs` holding only such slots is left for the close. The one node is
 * claimed once: by the Web Apps logo, read or handed to project data, else
 * by the Android slots, else by the first slot the uploader did not write.
 */
function readLogos(ctx: ReadContext): void {
	if (!ctx.app.used("logo_refs")) return;
	const refs = ctx.app.peek("logo_refs");
	if (!isJsonObject(refs)) return;
	const refused: string[] = [];
	let webApps: { path: string } | undefined;
	let android = false;
	for (const [slot, ref] of Object.entries(refs)) {
		if (!fromUploader(slot, ref)) {
			refused.push(slot);
			continue;
		}
		if (slot === WEB_APPS_LOGO) webApps = ref;
		else if (ANDROID_LOGOS.has(slot)) android = true;
	}
	for (const slot of refused)
		ctx.accounting.finding(CLAIMS.logoNotFromUploader, ctx.app.place, {
			name: slot,
		});
	if (webApps !== undefined) {
		const place = appSettingsPlace();
		const path = webApps.path;
		const resolution = ctx.input.media.resolve(path);
		if (resolution.kind === "asset") {
			const read = ctx.app.take("logo_refs", CLAIMS.logoWebApps, () => path);
			ctx.facts.mediaReferences.push({
				path: read.value,
				assetId: resolution.assetId,
				mediaKind: resolution.mediaKind,
				place,
				slot: "app_logo",
			});
			ctx.writeDraft(() => {
				ctx.draft.logo = resolution.assetId;
			});
		} else {
			ctx.app.handOff("logo_refs", "media-reference", path);
			ctx.facts.pendingMedia.push({
				path,
				mediaKind: "image",
				resolution: resolution.kind,
				place,
				slot: "app_logo",
			});
		}
		return;
	}
	if (android) ctx.app.account("logo_refs", CLAIMS.logoAndroid);
	else if (refused.length > 0)
		ctx.app.refuse("logo_refs", CLAIMS.logoNotFromUploader, {
			name: refused[0],
		});
}

/** `_attachments`: each form's source, admitted where a form of this read names one. */
function readAttachments(
	ctx: ReadContext,
): Admitted<Readonly<Record<string, unknown>>> | undefined {
	if (!ctx.app.used("_attachments")) return undefined;
	const value = ctx.app.peek("_attachments");
	if (!isJsonObject(value)) return undefined;
	const named = ctx.input.source.modules.some((menu) =>
		menu.forms.some((form) => Object.hasOwn(value, `${form.readUniqueId}.xml`)),
	);
	if (!named) {
		ctx.app.drop("_attachments", CLAIMS.orphanAttachments);
		return undefined;
	}
	return ctx.app.take("_attachments", CLAIMS.attachments, () => value);
}

/** Whether a setting's value is one of its choices, or HQ's own default for it. */
function withinChoices(item: SurfaceItem, value: unknown): boolean {
	if (sameJson(value, item.default)) return true;
	const values = item.values ?? [];
	if (Array.isArray(value))
		return value.every((element) => values.includes(element));
	return values.includes(value);
}

/** `cc-show-saved` and `cc-show-incomplete`, by `appProfileSettings.ts`'s values read backwards. */
function yesNo(value: unknown): boolean | undefined {
	return value === "yes" ? true : value === "no" ? false : undefined;
}

/**
 * `profile`: its `properties` and `features`, key by key. `cc-show-saved`
 * and `cc-show-incomplete` are the app's own settings; a key HQ's settings
 * list is claimed under the entry that holds its value; a key none lists is
 * inert. In `custom_properties`, the one property Nova derives is read past,
 * and any other is a finding named by the property.
 */
function readProfile(ctx: ReadContext): void {
	const profile = ctx.app.object(
		"profile",
		"Application.profile",
		PROFILE_CLAIMS.container,
	);
	/* HQ's build writes a forced setting's own default where the profile
	 * holds no value and the device's default differs
	 * (`Application.create_profile`): both are `no`. */
	let showSaved = false;
	let showIncomplete = false;
	for (const kind of ["properties", "features"] as const) {
		const bag = profile.object(
			kind,
			`Application.profile.${kind}`,
			PROFILE_CLAIMS.container,
		);
		for (const name of keysOf(bag)) {
			const value = bag.peek(name);
			const setting = `setting:${kind}.${name}`;
			if (
				(kind === "features" && name === "sense" && value === "true") ||
				(kind === "properties" &&
					name === "cc-entry-mode" &&
					value === "cc-entry-review")
			) {
				bag.refuse(name, PROFILE_CLAIMS.senseOrReviewEntry, { name });
				continue;
			}
			const item = surfaceItem(setting);
			const outside = OUTSIDE_CHOICES_CLAIMS[setting];
			if (
				item?.values !== undefined &&
				outside !== undefined &&
				!withinChoices(item, value)
			) {
				bag.refuse(name, outside, { name });
				continue;
			}
			if (setting === "setting:properties.cc-show-saved") {
				const read = bag.take(name, PROFILE_CLAIMS.showSaved, yesNo).value;
				if (read !== undefined) showSaved = read;
				continue;
			}
			if (setting === "setting:properties.cc-show-incomplete") {
				const read = bag.take(name, PROFILE_CLAIMS.showIncomplete, yesNo).value;
				if (read !== undefined) showIncomplete = read;
				continue;
			}
			const claim = settingAccount(setting, value);
			if (claim !== undefined) {
				bag.account(name, claim);
				continue;
			}
			/* A key HQ's settings name only under an entry that holds it is
			 * left for the close: the Web Apps logo is read from `logo_refs`.
			 * So is a value of a setting whose entries' classes all leave it. */
			if (item === undefined)
				bag.account(name, PROFILE_CLAIMS.notInTheSettings);
		}
	}
	const custom = profile.object(
		"custom_properties",
		"Application.profile.custom_properties",
		PROFILE_CLAIMS.container,
	);
	for (const name of keysOf(custom)) {
		if (name === INDEX_CASE_SEARCH_RESULTS)
			custom.derived(name, PROFILE_CLAIMS.indexCaseSearchResults);
		else custom.refuse(name, PROFILE_CLAIMS.otherCustomProperty, { name });
	}
	ctx.writeDraft(() => {
		ctx.draft.appSettings.showSavedForms = showSaved;
		ctx.draft.appSettings.showIncompleteForms = showIncomplete;
	});
}

/** What a key of a language's strings is, in the order of the manifest's classes. */
type TranslationKeyKind =
	| "language-name"
	| "app-display-name"
	| "homescreen-title"
	| "runtime-ui-string"
	| "generated"
	| "unread";

function translationKeyKind(
	name: string,
	languages: HqLanguages,
): TranslationKeyKind {
	if (languages.codes.includes(name)) return "language-name";
	if (name === "app.display.name") return "app-display-name";
	if (name === "homescreen.title") return "homescreen-title";
	if (isRuntimeUiStringKey(name)) return "runtime-ui-string";
	if (translationKeyOwner(name, languages.codes) === "generated")
		return "generated";
	return "unread";
}

/** A stored `app.display.name` HQ's build applies: a non-empty string (`non_empty_only`). */
function appliedDisplayName(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

/**
 * `translations`, language by language. In an app language's strings: a
 * language's name, derived where it is Nova's label for the language;
 * `app.display.name`, the app name's translation; the home screen title; a
 * runtime's own UI text, kept; a key of HQ's generated patterns, held for
 * the assembly; any other, read by no runtime. A language the app does not
 * hold is read by nothing, and every key of a language the reading could not
 * name stands under that language's finding, a generated key once the
 * assembly meets it. A value of an app language's strings whose rest after a
 * carriage return defines an app string is refused at its key, whatever the
 * key is: HQ's build writes every non-empty value into the language's file.
 *
 * HQ's build writes `app.display.name` from `name` in every language and puts
 * a non-empty stored value over it (`app_strings.py::_create_custom_app_strings`,
 * `SelectKnownAppStrings.app_strings_parts`), so in the source language (Nova
 * writes `name` in it, and a reading takes a language whose value differs from
 * `name` as the source only where no language passes
 * `languages.ts::readingSourceCode`, which falls back to the first) a
 * value that is not `name` is the name every runtime shows there. It is read
 * as the app's name, and each other language that stores none takes `name`
 * as its translation, which is what it shows (`holdAppName` reads `name` for a
 * language `appNames` lacks): workers read the same words, and HQ's own `name`
 * becomes the override's wording at the first publish, a fold counted with the
 * generated keys'. `appNames` holds only the languages that store a name of
 * their own, so a rewrite is recorded only at a path CommCare HQ holds.
 */
function readTranslations(
	ctx: ReadContext,
	languages: HqLanguages,
	name: Admitted<string> | undefined,
): readonly HeldTranslationKey[] {
	const held: HeldTranslationKey[] = [];
	const codes = new Set(languages.codes);
	const appNames = new Map<string, string>();
	const appName = name?.value;
	let firstLanguageName: Admitted<string> | undefined;
	const byLanguage = ctx.app.map(
		"translations",
		"Application.translations",
		TRANSLATION_CLAIMS.container,
	);
	for (const [language, strings] of byLanguage) {
		if (!codes.has(language)) {
			strings.refuseWhole(TRANSLATION_CLAIMS.unread);
			continue;
		}
		const refusedLanguage = languages.refused.get(language);
		for (const key of keysOf(strings)) {
			const value = strings.peek(key);
			// HQ's build writes every non-empty value of an app language's strings into its file,
			// whatever the key names (`SelectKnownAppStrings.app_strings_parts`,
			// `non_empty_only(app.translations.get(lang))`), so a value whose rest after a carriage
			// return is a line that defines an app string sets that string's wording too
			// (`heldText.ts::keyDefinedAfterLineEnd`), whatever the key itself does.
			const lineEnd =
				typeof value === "string" ? keyDefinedAfterLineEnd(value) : undefined;
			if (lineEnd !== undefined) {
				strings.refuse(key, LINE_END_DEFINES_KEY, { name: lineEnd });
				continue;
			}
			const kind = translationKeyKind(key, languages);
			if (kind === "generated") {
				held.push({ language, key, value, json: strings });
				continue;
			}
			if (refusedLanguage !== undefined) {
				ctx.accounting.cover({ json: strings, key }, refusedLanguage);
				continue;
			}
			switch (kind) {
				case "language-name": {
					const refused = languages.refused.get(key);
					const identity = languages.identityOf.get(key);
					if (refused !== undefined)
						ctx.accounting.cover({ json: strings, key }, refused);
					else if (identity === undefined) continue;
					else if (value === resolvedLanguageDisplayLabel(identity))
						strings.derived(key, TRANSLATION_CLAIMS.languageName);
					else strings.account(key, TRANSLATION_CLAIMS.languageNameOther);
					continue;
				}
				case "app-display-name": {
					if (typeof value !== "string") continue;
					const read = strings.take(
						key,
						TRANSLATION_CLAIMS.appDisplayName,
						(v) => v as string,
					);
					const text = read.value;
					/* Blank, or in the source language equal to `name`, it is the string HQ's
					 * build writes from `name`. */
					if (!appliedDisplayName(text)) continue;
					if (language !== languages.source) appNames.set(language, text);
					else if (text !== appName) firstLanguageName = read;
					continue;
				}
				case "homescreen-title":
					strings.account(key, TRANSLATION_CLAIMS.homescreenTitle);
					continue;
				case "runtime-ui-string":
					strings.account(key, TRANSLATION_CLAIMS.runtimeUiString);
					continue;
				case "unread":
					strings.account(key, TRANSLATION_CLAIMS.unread);
					continue;
			}
		}
	}
	if (firstLanguageName !== undefined) {
		const override = firstLanguageName;
		ctx.writeDraft(() => {
			ctx.draft.appName = override;
		});
		ctx.facts.foldedTranslationKeys += 1;
	}
	const translated = new Map(
		[
			...holdAppName(
				ctx,
				languages,
				name,
				appNames,
				firstLanguageName !== undefined,
			),
		].flatMap(([code, text]) => {
			const tag = languages.tagOf.get(code);
			return tag === undefined || languages.refused.has(code)
				? []
				: [[tag, text] as const];
		}),
	);
	if (translated.size > 0)
		ctx.translations.set(
			makeTranslationUnitId("app", "name"),
			"text",
			translated,
		);
	return held;
}

/**
 * The app's name as a reading holds it: each language shows the source's name (`name`, or the
 * source language's `app.display.name` read over it) or its own `app.display.name`, held as
 * every app string is (`heldText.ts::heldText`): no space at either end, and a language whose
 * name shows blank beside a source that does not takes the source's name. The source's text is
 * written into the draft, and each other language's translation is returned by code. A `name`
 * whose rest after a carriage return defines another app string is refused at the app under the
 * line-end entry; any other `name` holding the two characters `\n`, a backslash before `#` or a
 * carriage return, which the profile's `name` shows otherwise than the app strings do, under
 * `application-and-settings/app-name-holding-backslash-n-a-backslash-before-hash-or-a-carriage-return`;
 * and a name Nova's gate admits no spelling of under the entry that names why
 * (`heldText.ts::refuseUnheldText`), each one finding at the app, and the names are returned as
 * stored. Where
 * the first publish writes a stored value again, the reading records it, the source language's at
 * its `app.display.name` where that supplied the name (`fromDisplayName`) and at `name`
 * otherwise: under `text-spaces-dropped` where a worker then reads another name, else under
 * `names-respelled`. An `app.display.name` whose rest after a carriage return defines an app
 * string never reaches here: `readTranslations` refuses it at its key.
 */
function holdAppName(
	ctx: ReadContext,
	languages: HqLanguages,
	name: Admitted<string> | undefined,
	appNames: ReadonlyMap<string, string>,
	fromDisplayName: boolean,
): ReadonlyMap<string, string> {
	const source = languages.source;
	const sourceName = ctx.draft.appName?.value;
	if (source === undefined || name === undefined || sourceName === undefined)
		return appNames;
	const shown = new Map<string, string>();
	for (const code of languages.codes)
		shown.set(
			code,
			code === source ? sourceName : (appNames.get(code) ?? name.value),
		);
	// HQ's build also writes `name` as it stands into the profile's `name`, which Android's app
	// picker shows (`profile.xml`, Core's `ProfileParser`, `ApplicationRecord.setPropertiesFromProfile`):
	// a name whose two characters `\n` a device's app strings show as a line break, whose `\#`
	// they show as `#`, or whose text after a carriage return they do not show, the picker shows
	// whole, and Nova can print only one of the two.
	const lineEnd = keyDefinedAfterLineEnd(name.value);
	if (lineEnd !== undefined) {
		ctx.accounting.finding(LINE_END_DEFINES_KEY, appPlace(), {
			name: lineEnd,
		});
		return appNames;
	}
	if (
		name.value.includes("\\n") ||
		name.value.includes("\\#") ||
		name.value.includes("\r")
	) {
		ctx.accounting.finding(CLAIMS.nameShownTwoWays, appPlace(), {
			name: name.value,
		});
		return appNames;
	}
	const held = heldText(shown, languages.codes, source, "app-name");
	if (held === undefined) {
		refuseUnheldText(
			ctx,
			appPlace(),
			key("name"),
			unheldText(shown, languages.codes, source, "app-name"),
		);
		return appNames;
	}
	if (held.source !== sourceName)
		ctx.writeDraft(() => {
			ctx.draft.appName = ctx.accounting.unrecorded(held.source);
		});
	for (const code of languages.codes) {
		const before = shown.get(code);
		if (before === undefined || before === held.printed[code]) continue;
		const own = code === source ? fromDisplayName : appNames.has(code);
		recordTextRewrite(
			ctx,
			own
				? {
						entry: TRANSLATION_CLAIMS.appDisplayName.entry,
						path: `/translations/${pointerToken(code)}/app.display.name`,
					}
				: { entry: CLAIMS.name.entry, path: "/name" },
			"names-respelled",
			held.workersSeeAnother,
		);
	}
	return held.translations;
}

/** The root's undeclared keys: CommCare HQ's dynamic keys, a read-only member's name, or any other. */
function readUndeclared(ctx: ReadContext): void {
	for (const name of ctx.app.undeclared()) {
		if (DYNAMIC_KEYS.has(name)) ctx.app.account(name, CLAIMS.dynamicKey);
		else if (namesReadOnlyApplicationMember(name))
			ctx.app.refuse(name, CLAIMS.readOnlyKey, { name });
		else ctx.app.account(name, CLAIMS.otherUnknownKey);
	}
}

/** The keys whose entry a value class picks. */
function readByValue(ctx: ReadContext): void {
	const app = ctx.app;
	const pick = (name: string, claim: Claim<"account"> | undefined) => {
		if (claim !== undefined) app.account(name, claim);
	};
	const version = app.peek("application_version");
	pick(
		"application_version",
		version === "2.0"
			? BY_VALUE.applicationVersion2
			: version === "1.0"
				? BY_VALUE.applicationVersion1
				: undefined,
	);
	const customSuite = app.peek("use_custom_suite");
	pick(
		"use_custom_suite",
		customSuite === false
			? BY_VALUE.customSuiteOff
			: customSuite === true
				? BY_VALUE.customSuiteOn
				: undefined,
	);
	pick(
		"translation_strategy",
		app.peek("translation_strategy") === "select-known"
			? BY_VALUE.selectKnown
			: BY_VALUE.notSelectKnown,
	);
	pick(
		"target_commcare_flavor",
		app.peek("target_commcare_flavor") === "none"
			? BY_VALUE.flavorNone
			: BY_VALUE.flavorOther,
	);
	pick(
		"mobile_ucr_restore_version",
		app.peek("mobile_ucr_restore_version") === "2.0"
			? BY_VALUE.ucr2
			: BY_VALUE.ucrOlder,
	);
	const profiles = app.peek("build_profiles");
	pick(
		"build_profiles",
		isJsonObject(profiles) && Object.keys(profiles).length === 0
			? BY_VALUE.buildProfilesEmpty
			: BY_VALUE.buildProfilesNonEmpty,
	);
	const fixture = app.peek("location_fixture_restore");
	if (fixture === "project_default")
		app.derived("location_fixture_restore", BY_VALUE.fixtureProjectDefault);
	else if (fixture === "both_fixtures" || fixture === "only_flat_fixture")
		app.derived("location_fixture_restore", BY_VALUE.fixtureFlat);
	else if (fixture === "only_hierarchical_fixture")
		app.refuse("location_fixture_restore", BY_VALUE.fixtureHierarchicalOnly, {
			name: fixture,
		});
}

/**
 * Stage 1: the application's own keys, its languages and the floor.
 * `modules` is the structure stage's, and `auto_gps_capture` the assembly's,
 * which knows whether a form holds a Connect block.
 */
export function readApplication(ctx: ReadContext): void {
	const app = ctx.app;
	app.derived("doc_type", CLAIMS.docType);
	const rawName = app.peek("name");
	const name =
		typeof rawName === "string"
			? app.take("name", CLAIMS.name, () => rawName)
			: undefined;
	if (name !== undefined)
		ctx.writeDraft(() => {
			ctx.draft.appName = name;
		});
	const languages = readLanguages(ctx);
	const attachments = readAttachments(ctx);
	const cloudcare = app.take(
		"cloudcare_enabled",
		CLAIMS.cloudcareEnabled,
		(value) => value === true,
	);
	ctx.facts.webAppsOnInHq = cloudcare.value;
	const generatedKeys = readTranslations(ctx, languages, name);
	readProfile(ctx);
	readBuildSpec(ctx);
	readLogos(ctx);
	for (const [name, claim] of Object.entries(ACCOUNTED_CLAIMS))
		app.account(name, claim);
	readByValue(ctx);
	readUndeclared(ctx);
	READINGS.set(ctx, { languages, attachments, generatedKeys });
}
