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
import surface from "../surface/surface.json";
import { compareToVersionFloor } from "../versionFloor";
import type { Admitted } from "./accounting";
import {
	account,
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "./claims";
import type { ReadContext } from "./context";
import { isJsonObject, type JsonCursor, sameJson } from "./jsonCursor";
import {
	type HqLanguages,
	manifestFindingOf,
	readLanguages,
} from "./languages";
import { appSettingsPlace } from "./place";

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

const PROFILE = key("profile");

/** Each `setting:` key of a profile setting, by the entry that holds it at a value in its choices. */
const SETTING_ENTRIES: Readonly<Record<string, string>> = {
	"setting:properties.cc-autoup-freq": "1-properties-cc-autoup-freq",
	"setting:properties.purge-freq": "3-properties-purge-freq",
	"setting:properties.cc-days-form-retain": "4-properties-cc-days-form-retain",
	"setting:properties.logenabled": "5-properties-logenabled",
	"setting:properties.log_prop_weekly":
		"6-properties-log-prop-weekly-within-its-choices",
	"setting:properties.log_prop_daily":
		"7-properties-log-prop-daily-within-its-choices",
	"setting:properties.user_reg_server": "12-properties-user-reg-server",
	"setting:properties.cc-autosync-freq": "13-properties-cc-autosync-freq",
	"setting:properties.restore-tolerance": "14-properties-restore-tolerance",
	"setting:properties.loose_media": "16-properties-loose-media",
	"setting:properties.cc-content-valid": "17-properties-cc-content-valid",
	"setting:properties.unsent-number-limit": "18-properties-unsent-number-limit",
	"setting:properties.unsent-time-limit": "19-properties-unsent-time-limit",
	"setting:properties.cc-resize-images": "22-properties-cc-resize-images",
	"setting:properties.cc-fuzzy-search-enabled":
		"23-properties-cc-fuzzy-search-enabled",
	"setting:properties.cc-log-entity-detail-enabled":
		"24-properties-cc-log-entity-detail-enabled",
	"setting:properties.cc-login-duration-seconds":
		"25-properties-cc-login-duration-seconds",
	"setting:properties.cc-inflation-target-density":
		"26-properties-cc-inflation-target-density",
	"setting:properties.cc-gps-auto-capture-accuracy":
		"27-properties-cc-gps-auto-capture-accuracy",
	"setting:properties.cc-maps-default-layer":
		"28-properties-cc-maps-default-layer",
	"setting:properties.cc-enable-tts": "29-properties-cc-enable-tts",
	"setting:properties.cc-label-required-questions-with-asterisk":
		"30-properties-cc-label-required-questions-with-asterisk",
	"setting:properties.logo_android_home":
		"logo-refs-hq-logo-android-home-login-demo",
	"setting:properties.logo_android_login":
		"logo-refs-hq-logo-android-home-login-demo",
	"setting:properties.logo_android_demo":
		"logo-refs-hq-logo-android-home-login-demo",
	"setting:features.users": "15-features-users",
	"setting:features.dependencies": "31-features-dependencies",
	"setting:features.credentials": "32-features-credentials",
};

/** The settings whose value outside their choices is refused under one entry. */
const OUTSIDE_CHOICES_KEYS: readonly string[] = [
	"setting:properties.cc-autoup-freq",
	"setting:properties.unsent-number-limit",
	"setting:properties.cc-content-valid",
	"setting:properties.cc-autosync-freq",
	"setting:properties.unsent-time-limit",
	"setting:properties.cc-days-form-retain",
	"setting:properties.cc-show-saved",
	"setting:properties.cc-show-incomplete",
	"setting:properties.cc-resize-images",
	"setting:properties.cc-fuzzy-search-enabled",
	"setting:properties.cc-gps-auto-capture-accuracy",
	"setting:properties.lazy-load-video-files",
	"setting:properties.cc-login-duration-seconds",
	"setting:properties.cc-inflation-target-density",
	"setting:properties.cc-maps-default-layer",
	"setting:properties.cc-enable-tts",
	"setting:properties.cc-label-required-questions-with-asterisk",
	"setting:properties.logenabled",
	"setting:properties.log_prop_weekly",
	"setting:properties.log_prop_daily",
	"setting:features.dependencies",
];

const SETTING_CLAIMS = defineClaims(
	"appShell.setting",
	Object.fromEntries(
		Object.entries(SETTING_ENTRIES).map(([setting, entry]) => [
			setting,
			account(`${A}/${entry}`, setting),
		]),
	),
);
const OUTSIDE_CHOICES_CLAIMS = defineClaims(
	"appShell.outsideChoices",
	Object.fromEntries(
		OUTSIDE_CHOICES_KEYS.map((setting) => [
			setting,
			refuse(
				`${A}/profile-properties-or-features-dependencies-value-outside-its`,
				setting,
			),
		]),
	),
);

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
	showSaved: take(
		`${A}/20-properties-cc-show-saved`,
		"setting:properties.cc-show-saved",
	),
	showIncomplete: take(
		`${A}/21-properties-cc-show-incomplete`,
		"setting:properties.cc-show-incomplete",
	),
	lazyLoadVideoOn: account(
		`${A}/2-properties-lazy-load-video-files-true`,
		"setting:properties.lazy-load-video-files",
	),
	lazyLoadVideoOff: account(
		`${A}/2p-properties-lazy-load-video-files-false`,
		"setting:properties.lazy-load-video-files",
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
	/** The `profile` object, whose `custom_properties` the case search reader claims. */
	readonly profile: JsonCursor;
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
 * write, or any other slot, is a finding of its own, named by the slot.
 */
function readLogos(ctx: ReadContext): void {
	if (!ctx.app.used("logo_refs")) return;
	const refs = ctx.app.peek("logo_refs");
	if (!isJsonObject(refs)) return;
	const refused: string[] = [];
	let webApps: { path: string } | undefined;
	let android = false;
	for (const [slot, ref] of Object.entries(refs)) {
		const known = slot === WEB_APPS_LOGO || ANDROID_LOGOS.has(slot);
		if (!known || !fromUploader(slot, ref)) {
			refused.push(slot);
			continue;
		}
		if (slot === WEB_APPS_LOGO) webApps = ref;
		else android = true;
	}
	for (const slot of refused)
		ctx.accounting.finding(CLAIMS.logoNotFromUploader, ctx.app.place, {
			name: slot,
		});
	let claimed = false;
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
			claimed = true;
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
	}
	if (!claimed && android) {
		ctx.app.account("logo_refs", CLAIMS.logoAndroid);
		claimed = true;
	}
	if (!claimed && webApps === undefined && refused.length > 0)
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
 * inert. `custom_properties` is the case search reader's.
 */
function readProfile(ctx: ReadContext): JsonCursor {
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
			if (setting === "setting:properties.lazy-load-video-files") {
				bag.account(
					name,
					value === "true"
						? PROFILE_CLAIMS.lazyLoadVideoOn
						: PROFILE_CLAIMS.lazyLoadVideoOff,
				);
				continue;
			}
			const claim = SETTING_CLAIMS[setting];
			if (claim !== undefined) {
				bag.account(name, claim);
				continue;
			}
			/* A key HQ's settings name only under an entry that holds it is
			 * left for the close: the Web Apps logo is read from `logo_refs`. */
			if (item === undefined)
				bag.account(name, PROFILE_CLAIMS.notInTheSettings);
		}
	}
	ctx.writeDraft(() => {
		ctx.draft.appSettings.showSavedForms = showSaved;
		ctx.draft.appSettings.showIncompleteForms = showIncomplete;
	});
	return profile;
}

/**
 * `translations`, language by language. In an app language's strings: a
 * language's name, derived where it is Nova's label for the language;
 * `app.display.name`, the app name's translation; the home screen title; a
 * runtime's own UI text, kept; a key of HQ's generated patterns, held for
 * the assembly; any other, read by no runtime. A language the app does not
 * hold is read by nothing.
 */
function readTranslations(
	ctx: ReadContext,
	languages: HqLanguages,
	appName: string | undefined,
): readonly HeldTranslationKey[] {
	const held: HeldTranslationKey[] = [];
	const codes = new Set(languages.codes);
	const appNames = new Map<string, string>();
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
		for (const name of keysOf(strings)) {
			const value = strings.peek(name);
			if (codes.has(name)) {
				const refused = languages.refused.get(name);
				const identity = languages.identityOf.get(name);
				if (refused !== undefined || identity === undefined) {
					if (refused !== undefined)
						ctx.accounting.cover({ json: strings, key: name }, refused);
					continue;
				}
				if (value === resolvedLanguageDisplayLabel(identity))
					strings.derived(name, TRANSLATION_CLAIMS.languageName);
				else strings.account(name, TRANSLATION_CLAIMS.languageNameOther);
				continue;
			}
			if (name === "app.display.name") {
				/* In the first language the app's name is `name` itself, which
				 * Nova writes for every runtime; a different value there is one
				 * Nova cannot hold, and the close reports it. */
				if (language === languages.first && value !== appName) continue;
				const read = strings.take(
					name,
					TRANSLATION_CLAIMS.appDisplayName,
					(v) => (typeof v === "string" ? v : undefined),
				).value;
				if (read !== undefined && language !== languages.first)
					appNames.set(language, read);
				continue;
			}
			if (name === "homescreen.title") {
				strings.account(name, TRANSLATION_CLAIMS.homescreenTitle);
				continue;
			}
			if (isRuntimeUiStringKey(name)) {
				strings.account(name, TRANSLATION_CLAIMS.runtimeUiString);
				continue;
			}
			if (translationKeyOwner(name, languages.codes) === "generated") {
				held.push({ language, key: name, value, json: strings });
				continue;
			}
			strings.account(name, TRANSLATION_CLAIMS.unread);
		}
	}
	const translated = new Map(
		[...appNames].flatMap(([code, text]) => {
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
	const generatedKeys = readTranslations(
		ctx,
		languages,
		typeof rawName === "string" ? rawName : undefined,
	);
	const profile = readProfile(ctx);
	readBuildSpec(ctx);
	readLogos(ctx);
	for (const [name, claim] of Object.entries(ACCOUNTED_CLAIMS))
		app.account(name, claim);
	readByValue(ctx);
	readUndeclared(ctx);
	READINGS.set(ctx, { languages, attachments, profile, generatedKeys });
}
