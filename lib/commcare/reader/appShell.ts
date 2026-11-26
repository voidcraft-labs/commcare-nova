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
import { ownRecordValue, recordFromEntries } from "@/lib/domain/records";
import { requiredAndroidAppsFromProfile } from "../androidAppDependencies";
import {
	hqCatalogMayHold,
	isRuntimeUiStringKey,
	translationKeyOwner,
} from "../appStringKeys";
import type { NovaOwnedDerivedProfilePropertyKey } from "../derivedProfile";
import { sourceMenuLayouts } from "../hq/menuLayout";
import { isLocaleFileKey } from "../localeFile";
import { type SourceTable, tableOf } from "../sourceKeys";
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
	["51-hq-persistent-menu", ["persistent_menu"]],
	["52-hq-show-breadcrumbs", ["show_breadcrumbs"]],
	["35-hq-practice-mobile-worker-id", ["practice_mobile_worker_id"]],
	["36-hq-custom-base-url", ["custom_base_url"]],
	["43-hq-secure-submissions", ["secure_submissions"]],
	["non-empty-custom-assertions-app", ["custom_assertions"]],
	/* The media map is read through the reading's media index, never here. */
	["multimedia-map", ["multimedia_map"]],
];

const ACCOUNTED_CLAIMS = defineClaims(
	"appShell.accounted",
	recordFromEntries(
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
	/** The app's own class, read at the app's root: an `Application`, which every document is. */
	application: take(`${A}/doc-type-application`, "schema:Application"),
	name: take(`${A}/name`, key("name")),
	attachments: take(`${A}/attachments-form-unique-id-xml`, key("_attachments")),
	/** `custom_suite.xml` among the attachments: the custom suite HQ's settings page shows and no
	 *  build writes. */
	customSuite: account(`${A}/42-hq-custom-suite`, key("_attachments")),
	orphanAttachments: drop(
		`${A}/attachments-entry-for-a-form-no-longer-in-the-app`,
		key("_attachments"),
	),
	caseSharing: take(`${A}/39-hq-case-sharing`, key("case_sharing")),
	firstMenuLayout: take(`${A}/46-hq-use-grid-menus`, key("use_grid_menus")),
	formMenuLayout: take(
		`${A}/47-hq-grid-form-menus-none-all-some`,
		key("grid_form_menus"),
	),
	invalidFirstMenuLayout: refuse(
		`${A}/menu-layout-outside-editor-choices`,
		key("use_grid_menus"),
	),
	invalidFormMenuLayout: refuse(
		`${A}/menu-layout-outside-editor-choices`,
		key("grid_form_menus"),
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
	/** A language's `app.display.name`, the runtime UI string its key is (`ui-string:`), recorded
	 *  at the key, as a key of another runtime UI string is (`UI_STRING_CLAIMS`); every other claim
	 *  of a key of a language's strings names `translations` and is recorded there: the key is
	 *  data, a language's code or a string Nova's app writes, a value of the map's own entry. */
	appDisplayName: take(
		`${A}/translations-app-display-name`,
		"ui-string:app.display.name",
	),
	/** The value is read into nothing: Nova derives its label from the language's identity. */
	languageName: derived(
		`${A}/translations-lang-code-language-display-names-equal-to-the-label`,
		TRANSLATIONS,
	),
	languageNameOther: account(
		`${A}/translations-lang-code-any-other-value-or-absent-where-hq-s`,
		TRANSLATIONS,
	),
	/** A language's `homescreen.title` equal to its `app.display.name`, both the app name's
	 *  translation: Nova writes it from that translation. */
	homescreenTitle: derived(`${A}/translations-homescreen-title`, TRANSLATIONS),
	/** A runtime's UI key some language holds, which HQ's build fills from its own catalog in an
	 *  app language that holds no text for it (`readCatalogFills`). */
	hqCatalogKey: account(
		`${A}/translations-catalog-key-hq-fills-with-its-own-text-in-a`,
		TRANSLATIONS,
	),
	unread: account(`${A}/translations-key-no-runtime-reads`, TRANSLATIONS),
	/** A key of an app language's strings that is no locale record under its own name
	 *  (`localeFile.ts::isLocaleFileKey`), which HQ's build writes stripped and on one line, so
	 *  it sets another string or none. */
	notItsOwn: refuse(
		`${A}/translations-key-that-is-no-locale-record-under-its-own-name`,
		TRANSLATIONS,
	),
});

interface SurfaceItem {
	readonly declared?: boolean;
	readonly values?: readonly unknown[];
	readonly default?: unknown;
	/** The runtimes that read a `ui-string:` item as one of their own UI strings. */
	readonly readBy?: readonly string[];
}
const ITEMS: SourceTable<SurfaceItem> = tableOf(
	(surface as { readonly items: Readonly<Record<string, SurfaceItem>> }).items,
);

function surfaceItem(id: string): SurfaceItem | undefined {
	return ITEMS.get(id);
}

const UI_STRING = "ui-string:";

/** Each `ui-string:` item a runtime reads, by the id or by a `<prefix>.*` it reads ids under,
 *  but `app.display.name`, whose key is the app name's translation. */
const RUNTIME_UI_STRING_ITEMS: readonly string[] = [...ITEMS.keys()].filter(
	(id) =>
		id.startsWith(UI_STRING) &&
		id !== "ui-string:app.display.name" &&
		(ITEMS.get(id)?.readBy?.length ?? 0) > 0,
);

/** A language's key a runtime reads as one of its own UI strings, kept as the project space holds
 *  it, by the `ui-string:` item the key overrides: the claim names that item and is recorded at
 *  the key, where the item's value sits. */
const UI_STRING_CLAIMS: Readonly<Record<string, Claim<"account">>> =
	defineClaims(
		"appShell.uiStrings",
		recordFromEntries(
			RUNTIME_UI_STRING_ITEMS.map((id) => [
				id,
				account(
					`${A}/translations-key-in-a-runtime-s-ui-string-catalog-core-android`,
					id,
				),
			]),
		),
	);

/** The `ui-string:` item a runtime reads a language's key through: the key's own item, else the
 *  longest `<prefix>.*` whose prefix the key starts with (`appStringKeys.ts::isRuntimeUiStringKey`
 *  is the same family by the same rule). */
function uiStringClaim(name: string): Claim<"account"> | undefined {
	const own = UI_STRING_CLAIMS[`${UI_STRING}${name}`];
	if (own !== undefined) return own;
	let longest: string | undefined;
	for (const id of RUNTIME_UI_STRING_ITEMS) {
		if (!id.endsWith(".*")) continue;
		const prefix = id.slice(UI_STRING.length, -1);
		if (name.startsWith(prefix) && (longest?.length ?? 0) < id.length)
			longest = id;
	}
	return longest === undefined ? undefined : UI_STRING_CLAIMS[longest];
}

const PROFILE = key("profile");
/** The custom property Nova derives from the document's Search. */
const INDEX_CASE_SEARCH_RESULTS: NovaOwnedDerivedProfilePropertyKey =
	"cc-index-case-search-results";

const OUTSIDE_CHOICES = `${A}/profile-properties-or-features-dependencies-value-outside-its`;

/** Each profile setting's `setting:` key: every `properties` and `features` key HQ's settings name. */
const SETTING_KEYS: readonly string[] = [...ITEMS.keys()].filter(
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
const OUTSIDE_CHOICES_CLAIMS = recordFromEntries<Claim<"refuse">>([]);
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
	recordFromEntries(
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
	duplicateAndroidApp: refuse(
		`${A}/repeated-android-app-dependency`,
		"setting:features.dependencies",
	),
	androidApps: take(
		`${A}/31-features-dependencies`,
		"setting:features.dependencies",
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

/** A root key naming one of `Application`'s members that is no stored key: the surface lists it
 *  under `schema:Application.<name>` and does not declare it. */
function namesReadOnlyApplicationMember(name: string): boolean {
	const item = surfaceItem(key(name));
	return item !== undefined && item.declared !== true;
}

/**
 * The refusal of a root key that is both one of `Application`'s read-only members and an `hq`
 * setting HQ's settings list (`setting:hq.<name>`) whose one entry refuses it and names no key of
 * the app's schema: that entry is the setting on an `Application`, so the key is refused under it
 * rather than under the entry for any read-only member. `profile_url` is one: a RemoteApp's
 * setting (`commcare-app-settings.yml`), which `Application` holds as a read-only property, so
 * jsonobject refuses the key (`WrappingAttributeError`).
 */
const ROOT_SETTING_REFUSALS = recordFromEntries<Claim<"refuse">>([]);
for (const id of ITEMS.keys()) {
	const prefix = "setting:hq.";
	if (!id.startsWith(prefix)) continue;
	const name = id.slice(prefix.length);
	if (!namesReadOnlyApplicationMember(name)) continue;
	const entries = inventoryIndex().naming(id);
	const [entry] = entries;
	if (
		entries.length === 1 &&
		entry !== undefined &&
		claimPermits("refuse", entry.standing) &&
		!entry.surfaceKeys.some((surfaceKey) => surfaceKey.startsWith("schema:"))
	)
		ROOT_SETTING_REFUSALS[name] = refuse(entry.id, id);
}
defineClaims("appShell.rootSetting", ROOT_SETTING_REFUSALS);

/** `add_ons`, the map of the editor features CommCare HQ's pages show, and each add-on the
 *  surface names, under the entry that names its `add-on:` item. */
const ADD_ON_CLAIMS = defineClaims("appShell.addOns", {
	/** The map, and each key of it that turns nothing on or that names no add-on HQ reads. */
	map: account(`${A}/add-ons`, key("add_ons")),
	...recordFromEntries<Claim<"account">>(
		[...ITEMS.keys()].flatMap((id) => {
			if (!id.startsWith("add-on:")) return [];
			const [entry, ...others] = inventoryIndex().naming(id);
			return entry !== undefined &&
				others.length === 0 &&
				claimPermits("account", entry.standing)
				? [[id, account(entry.id, id)] as const]
				: [];
		}),
	),
});

/** Python's truth of a stored value, which CommCare HQ's pages test an add-on by
 *  (`add_ons.py::show`, `app.add_ons.get(slug)`). */
function turnedOn(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (isJsonObject(value)) return Object.keys(value).length > 0;
	return value !== false && value !== null && value !== 0 && value !== "";
}

/**
 * `add_ons`, key by key: an add-on turned on, under the entry that names it; a key that turns
 * nothing on, or names no add-on HQ's pages read (`add_ons.py::_ADD_ONS` no longer lists it), under
 * the map's entry, recorded at the map.
 */
function readAddOns(ctx: ReadContext): void {
	const map = ctx.app.object(
		"add_ons",
		"Application.add_ons",
		ADD_ON_CLAIMS.map,
	);
	for (const slug of keysOf(map)) {
		const named = `add-on:${slug}`;
		const claim = ownRecordValue<Claim<"account">>(ADD_ON_CLAIMS, named);
		map.account(
			slug,
			claim !== undefined && turnedOn(map.peek(slug))
				? claim
				: ADD_ON_CLAIMS.map,
		);
	}
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
	// The class is a fact about the spec and each key of it the entry names.
	ctx.accounting.findingAt(
		CLAIMS.buildSpecBelowFloor,
		place,
		"/build_spec",
		detail,
	);
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
 * Each slot the uploader did not write is also refused at `logo_refs`, where
 * the value its entry names sits, beside that claim.
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
		ctx.app.refusePart("logo_refs", slot, CLAIMS.logoNotFromUploader, {
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
				mediaKind: "image",
				place,
				pointer: `/logo_refs/${pointerToken(WEB_APPS_LOGO)}`,
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
				pointer: `/logo_refs/${pointerToken(WEB_APPS_LOGO)}`,
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

/** The attachment CommCare HQ keeps an app's custom suite in (`Application.set_custom_suite`). */
const CUSTOM_SUITE = "custom_suite.xml";

/** `_attachments`: each form's source, admitted where a form of this read names one, and a
 *  custom suite beside them under its own entry. */
function readAttachments(
	ctx: ReadContext,
): Admitted<Readonly<Record<string, unknown>>> | undefined {
	if (!ctx.app.used("_attachments")) return undefined;
	const value = ctx.app.peek("_attachments");
	if (!isJsonObject(value)) return undefined;
	if (Object.hasOwn(value, CUSTOM_SUITE))
		ctx.app.accountPart("_attachments", CUSTOM_SUITE, CLAIMS.customSuite);
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

/** A key as the surface spells it in an item's name: each character outside the printable ASCII
 *  range, and `%`, percent-encoded as UTF-8, as the surface's extraction quotes it. */
function surfaceKeyName(text: string): string {
	let out = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (code >= 33 && code <= 126 && character !== "%") {
			out += character;
			continue;
		}
		for (const byte of new TextEncoder().encode(character))
			out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** Each `profile-property:` item one allowing or refusing entry names, by the item: a property a
 *  profile holds that HQ's settings do not list is read under that entry. */
const PROFILE_PROPERTY_CLAIMS = defineClaims(
	"appShell.profileProperty",
	recordFromEntries(
		[...ITEMS.keys()].flatMap((id) => {
			if (!id.startsWith("profile-property:")) return [];
			const [entry, ...others] = inventoryIndex().naming(id);
			return entry !== undefined &&
				others.length === 0 &&
				claimPermits("account", entry.standing)
				? [[id, account(entry.id, id)]]
				: [];
		}),
	),
);

/** The claim of a profile property HQ's settings do not list, where the surface names it. */
function profilePropertyClaim(name: string): Claim<"account"> | undefined {
	const id = `profile-property:${surfaceKeyName(name)}`;
	return PROFILE_PROPERTY_CLAIMS[id];
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
		if (
			kind === "properties" &&
			ctx.facts.webAppsOnInHq &&
			bag.peek("cc-show-incomplete") === undefined
		) {
			// Web Apps' app list counts an absent key as enabled. HQ's built profile,
			// and the app's own settings page, both count it as disabled.
			ctx.facts.sameStateRewrites.push({
				entry: PROFILE_CLAIMS.showIncomplete.entry,
				path: "/profile/properties/cc-show-incomplete",
				register: "incomplete-forms-tile-hidden",
			});
		}
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
			if (setting === "setting:features.dependencies") {
				if (Array.isArray(value) && new Set(value).size !== value.length) {
					bag.refuse(name, PROFILE_CLAIMS.duplicateAndroidApp, { name });
					continue;
				}
				if (
					outside !== undefined &&
					requiredAndroidAppsFromProfile(value) === undefined
				) {
					bag.refuse(name, outside, { name });
					continue;
				}
				const apps = bag.take(
					name,
					PROFILE_CLAIMS.androidApps,
					requiredAndroidAppsFromProfile,
				).value;
				if (apps?.length)
					ctx.writeDraft(() => {
						ctx.draft.appSettings.requiredAndroidApps = apps;
					});
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
			 * So is a value of a setting whose entries' classes all leave it.
			 * A property HQ's settings do not list is the profile property
			 * the surface names for it, where one entry names that. */
			if (item === undefined)
				bag.account(
					name,
					(kind === "properties" ? profilePropertyClaim(name) : undefined) ??
						PROFILE_CLAIMS.notInTheSettings,
				);
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

/** What `name` is among an app language's strings; `codes` is the app's codes as a set, built
 *  once for every key. */
function translationKeyKind(
	name: string,
	codes: ReadonlySet<string>,
): TranslationKeyKind {
	if (codes.has(name)) return "language-name";
	if (name === "app.display.name") return "app-display-name";
	if (name === "homescreen.title") return "homescreen-title";
	if (translationKeyOwner(name, codes) === "generated") return "generated";
	if (isRuntimeUiStringKey(name)) return "runtime-ui-string";
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
	/* Each language's two strings HQ's build writes from the app's name, as stored. */
	const nameStrings = new Map<
		string,
		{ json: JsonCursor; display?: unknown; title?: unknown }
	>();
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
			// HQ's build writes a key stripped and on one line (`commcare_translations.py::dumps`), so a
			// key that is no locale record under its own name (` home.start`, a key holding `=`, `#`
			// or a line break) sets another string there, or none, which no document holds and a
			// publish never carries (`appStringKeys.ts::translationKeyOwner`, `not-its-own`). It is
			// refused at its key, naming the key as CommCare HQ holds it.
			if (!isLocaleFileKey(key)) {
				if (refusedLanguage !== undefined)
					ctx.accounting.cover({ json: strings, key }, refusedLanguage);
				else strings.refuse(key, TRANSLATION_CLAIMS.notItsOwn, { name: key });
				continue;
			}
			const kind = translationKeyKind(key, codes);
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
				case "app-display-name":
				case "homescreen-title": {
					const pair = nameStrings.get(language) ?? { json: strings };
					if (kind === "app-display-name") pair.display = value;
					else pair.title = value;
					nameStrings.set(language, pair);
					continue;
				}
				case "runtime-ui-string": {
					const claim = uiStringClaim(key);
					if (claim !== undefined) strings.account(key, claim);
					continue;
				}
				case "unread":
					strings.account(key, TRANSLATION_CLAIMS.unread);
					continue;
			}
		}
	}
	readCatalogFills(ctx, languages);
	/* A language other than the source holding both strings with one text other than `name` is
	 * what Nova writes for the app name's translation there (`expander.ts::appLevelValues`), so it
	 * reads as that translation. Every other stored one is that string's own wording, the generated
	 * key's (`generatedWording.ts::appNameWordingKeys`), which Nova writes back as stored. */
	for (const [language, pair] of nameStrings) {
		const { json: strings, display, title } = pair;
		if (
			language !== languages.source &&
			appliedDisplayName(display) &&
			title === display &&
			display !== appName
		) {
			const translated = strings.take(
				"app.display.name",
				TRANSLATION_CLAIMS.appDisplayName,
				(v) => v as string,
			).value;
			strings.derived("homescreen.title", TRANSLATION_CLAIMS.homescreenTitle);
			appNames.set(language, translated);
			continue;
		}
		for (const [key, value] of [
			["app.display.name", display],
			["homescreen.title", title],
		] as const)
			if (value !== undefined)
				held.push({ language, key, value, json: strings });
	}
	const translated = new Map(
		[...holdAppName(ctx, languages, name, appNames)].flatMap(([code, text]) => {
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
 * Each runtime UI key a language's `translations` holds that HQ's build fills, in an app language
 * that holds no text for it, from its own catalog for that language: HQ's build puts the catalog's
 * text of every key any language's map holds into each language's strings, then that language's
 * own non-empty texts over it (`app_strings.py::SelectKnownAppStrings.app_strings_parts`,
 * `get_app_translation_keys`, `non_empty_only`). What a worker reads there is the project space's,
 * kept as it holds it, one record a language and key at `translations`, whose value leaves the key
 * out. A language the reading refused is covered by its own finding.
 */
function readCatalogFills(ctx: ReadContext, languages: HqLanguages): void {
	const stored = ctx.app.peek("translations");
	if (!isJsonObject(stored)) return;
	const maps = Object.values(stored).filter(isJsonObject);
	const codes = new Set(languages.codes);
	const keys = new Set(
		maps
			.flatMap((strings) => Object.keys(strings))
			.filter((key) => translationKeyKind(key, codes) === "runtime-ui-string"),
	);
	for (const code of languages.codes) {
		if (languages.refused.has(code)) continue;
		const own = stored[code];
		for (const key of [...keys].sort()) {
			if (isJsonObject(own) && own[key]) continue;
			if (!hqCatalogMayHold(key, code)) continue;
			ctx.app.accountPart(
				"translations",
				`${code}/${key}`,
				TRANSLATION_CLAIMS.hqCatalogKey,
			);
		}
	}
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
		const own = code !== source && appNames.has(code);
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
		if (own)
			recordTextRewrite(
				ctx,
				{
					entry: TRANSLATION_CLAIMS.homescreenTitle.entry,
					path: `/translations/${pointerToken(code)}/homescreen.title`,
				},
				"names-respelled",
				false,
			);
	}
	return held.translations;
}

/** The root's undeclared keys: CommCare HQ's dynamic keys, a setting refused on an `Application`
 *  by its own entry, a read-only member's name, or any other. */
function readUndeclared(ctx: ReadContext): void {
	for (const name of ctx.app.undeclared()) {
		const setting = ROOT_SETTING_REFUSALS[name];
		if (DYNAMIC_KEYS.has(name)) ctx.app.account(name, CLAIMS.dynamicKey);
		else if (setting !== undefined) ctx.app.refuse(name, setting, { name });
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

/** A value a claim admitted, read where nothing more is made of it than the claim. */
function consumed(admitted: Admitted<unknown>): void {
	admitted.value;
}

/**
 * Stage 1: the application's own keys, its languages and the floor.
 * `modules` is the structure stage's, and `auto_gps_capture` the assembly's,
 * which knows whether a form holds a Connect block.
 */
export function readApplication(ctx: ReadContext): void {
	const app = ctx.app;
	consumed(app.takeClass(CLAIMS.application));
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
	const sharing = app.take(
		"case_sharing",
		CLAIMS.caseSharing,
		(value) => value === true,
	);
	if (sharing.value)
		ctx.writeDraft(() => {
			ctx.draft.appSettings.caseSharing = true;
		});
	const cloudcare = app.take(
		"cloudcare_enabled",
		CLAIMS.cloudcareEnabled,
		(value) => value === true,
	);
	ctx.facts.webAppsOnInHq = cloudcare.value;
	const generatedKeys = readTranslations(ctx, languages, name);
	const { firstMenuLayout, formMenuLayout } = sourceMenuLayouts({
		use_grid_menus: app.peek("use_grid_menus"),
		grid_form_menus: app.peek("grid_form_menus"),
	});
	if (firstMenuLayout === "unreadable")
		app.refuse("use_grid_menus", CLAIMS.invalidFirstMenuLayout);
	else {
		const layout = app.take(
			"use_grid_menus",
			CLAIMS.firstMenuLayout,
			() => firstMenuLayout,
		).value;
		if (layout === "grid")
			ctx.writeDraft(() => {
				ctx.draft.appSettings.firstMenuLayout = layout;
			});
	}
	if (formMenuLayout === "unreadable")
		app.refuse("grid_form_menus", CLAIMS.invalidFormMenuLayout);
	else {
		const layout = app.take(
			"grid_form_menus",
			CLAIMS.formMenuLayout,
			() => formMenuLayout,
		).value;
		if (layout !== "list")
			ctx.writeDraft(() => {
				ctx.draft.appSettings.formMenuLayout = layout;
			});
	}
	readProfile(ctx);
	readBuildSpec(ctx);
	readLogos(ctx);
	for (const [name, claim] of Object.entries(ACCOUNTED_CLAIMS))
		app.account(name, claim);
	readAddOns(ctx);
	readByValue(ctx);
	readUndeclared(ctx);
	READINGS.set(ctx, { languages, attachments, generatedKeys });
}
