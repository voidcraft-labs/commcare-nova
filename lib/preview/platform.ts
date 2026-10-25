// lib/preview/platform.ts
//
// Which platform Preview plays, and the one table of what each platform does.
//
// An app declares Web Apps, Android or both (`lib/domain/platforms.ts`), and
// Preview plays one declared platform at a time: the one the author chose in
// the identity menu when the app still declares it, else Web Apps when the
// app declares Web Apps, else Android (`effectivePreviewPlatform`). Preview,
// App Tests and `evaluate_form` all call it, so the three never disagree.
//
// `PREVIEW_PLATFORM_RULES` is the one place a behavior that differs by
// platform is chosen. Every Preview surface reads one field of
// `previewPlatformRules(platform)`; no other module under `lib/preview`,
// `components/preview`, `lib/preview/app-tests` or the authoring evaluator
// compares a platform value. The two helpers that hold a per-platform choice
// a field cannot are `platformUnavailableSentence` here and
// `engine/previewDevice.ts::serverPreviewDevice`.
//
// Each field cites the CommCare reader it plays, read at the pins
// `proof/pins.json` names. Three Android values no source reading settles
// (the label rendering, a tile cell's vertical alignment, and what a phone
// does with a form for a case it lacks) are held by the Android reader tests
// that read `targeted-preview-android-renders` off a device, each asserting
// what the device does.
//
// Client-safe: the browser, the App Test runtime and the authoring evaluator
// all import it.

import { CASE_SEARCH_BUTTON_LABEL } from "@/lib/domain/modules";
import {
	inPlatform,
	PLATFORM_LABELS,
	type Platform,
	platformDeclarationPhrase,
} from "@/lib/domain/platforms";

/** The platform Preview plays for an app declaring `declared`, given the
 *  author's choice. A choice the app no longer declares derives away with no
 *  store write, so narrowing an app while previewing plays the platform it
 *  still runs on. `declared` is `declaredPlatforms(doc)`, which is never
 *  empty. */
export function effectivePreviewPlatform(
	declared: readonly Platform[],
	chosen: Platform | undefined,
): Platform {
	if (chosen !== undefined && declared.includes(chosen)) return chosen;
	return declared.includes("web-apps") ? "web-apps" : "android";
}

export interface PreviewPlatformRules {
	/** Where the app opens. Web Apps has no home inside an app
	 *  (`formplayer/app.js` `apps:currentApp` → `selectApp`); Android opens
	 *  its home screen (`activities/HomeButtons.java::buildButtonData`,
	 *  `StandardHomeActivity::enterRootModule`). */
	readonly appHome: "root-menu" | "device-home";
	/** Where `app_home` lands after a submission. Formplayer
	 *  `FormSubmissionHelper.java::doEndOfFormNav` → `CommCareSession.java::finishExecuteAndPop`
	 *  false → client `apps:currentApp`; Android `HomeScreenBaseActivity.java`
	 *  → `AndroidSessionWrapper::terminateSession` → `reset()`. */
	readonly postSubmitAppHome: "root-menu" | "device-home";
	/** A form link whose target the worker's menu hides. Formplayer
	 *  `services/MenuSessionFactory.java::rebuildSessionFromFrame` walks the
	 *  frame through the menus it would show and stops where one is missing;
	 *  Core reads the frame's commands as they stand. */
	readonly afterSubmitHiddenTarget: "landing" | "opens";
	/** Formplayer `MenuSessionRunnerService` alone reads `respect-relevancy`;
	 *  commcare-android holds no reader of `Endpoint.isRespectRelevancy`. */
	readonly entryPointDisplayConditions: "kept-unless-ignored" | "ignored";
	/** HQ's claim frame (`endpoints.py::EndpointsHelper._add_claim_frame`);
	 *  Core `session/CommCareSession.java::syncState` keeps only the last
	 *  command, so Android never reaches the claim's `<post>`. */
	readonly entryPointClaims: "posted" | "none";
	/** A case the worker's device does not hold. Web Apps claims it; Core
	 *  `CommCareSession.java::getFirstMissingDatum` checks only the key, so
	 *  Android opens the form with blank preloads. */
	readonly entryPointCaseNotHeld: "claimed" | "opens-blank";
	/** Submitting a form opened for a case the phone lacks. Core
	 *  `xml/CaseXmlParser.java::loadCase` throws for an update or close of a
	 *  missing case, and Android quarantines the form, sends nothing and posts
	 *  "Problem with your App" (`FormSubmissionHelper.java::handleExceptionFromFormProcessing`;
	 *  `proof/android/test_navigation.py` reads it off a device). Preview saves
	 *  nothing for a form that changes such a case (`unheldCaseSubmit.ts`). */
	readonly entryPointUnheldCaseSubmit: "submits" | "not-processed";
	/** Choosing a case in a module with a case list and no forms. Formplayer
	 *  `MenuSessionRunnerService.java::advanceSessionWithSelections` →
	 *  "Redirecting after sync" → `apps:currentApp`; Android
	 *  `HomeScreenBaseActivity.java::handleNoFormFromSessionNav` →
	 *  `terminateSession` → `refreshUI`. */
	readonly formlessCaseListSelection: "back-to-root-menu" | "device-home";
	/** Android follows every claim with a sync (manifest
	 *  `case-search/the-generated-search-round-trip-remote-request-query-results`). */
	readonly claimThenSync: boolean;
	/** commcare-android holds no reader of `Detail.getGroup`, `DetailGroup`
	 *  or `header-rows`. */
	readonly tileGrouping: "grouped" | "flat";
	/** No reader of `Style.getShowBorder` or `getShowShading` in
	 *  commcare-android. */
	readonly tileBorderShading: boolean;
	/** `views/EntityViewTile.java::computeGravity` matches `center`, `top`
	 *  and `bottom`, and Nova writes `start`, `center` and `end`, so only a
	 *  middle cell reaches its gravity there; a text view with no vertical
	 *  gravity draws at the top, so `top` and `bottom` both draw there
	 *  (`proof/android/test_case_lists.py` reads each cell's gravity). */
	readonly tileVerticalAlign: "as-authored" | "middle-only";
	/** Android's markdown arm is on the case detail only
	 *  (`views/EntityDetailView.java`, `FORM_MARKDOWN`). */
	readonly linkColumnInList: "link" | "raw-text";
	/** A search's title, description and field hints (manifest
	 *  `case-search/title-label-lang-non-empty`, `description-lang-markdown`,
	 *  `hint-lang`, which Android ignores). */
	readonly searchScreenText: boolean;
	/** A Search field's required condition and checks (manifest
	 *  `case-search/required-test-text`, `validations-0-test-text`). */
	readonly searchFieldChecks: boolean;
	/** A hidden Search field with a starting value (manifest
	 *  `case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset`). */
	readonly hiddenSearchFieldWithDefault: "hidden" | "editable";
	/** A barcode Search field (manifest `case-search/appearance-barcode-scan`:
	 *  a plain text box in Web Apps). */
	readonly barcodeSearchField: "text" | "scan-or-text";
	/** A search with no results. Android
	 *  `activities/QueryRequestActivity.java::processSuccess` shows a toast and
	 *  stays on the search. */
	readonly zeroSearchResults: "results" | "stay-on-search";
	/** Skip to results (manifest
	 *  `case-search/workflow-skip-to-default-results-auto-launch-true-default-search`;
	 *  Android never reads `auto_launch`). */
	readonly skipToResults: boolean;
	/** `here()`'s value. Formplayer `util/FormplayerHereFunctionHandler.java::eval`
	 *  gives two numbers; Android `utils/AndroidHereFunctionHandler.java::toGeoPointData`
	 *  four, Core `GeoPointData.java::fillArray` flooring altitude and accuracy
	 *  to two decimals. An app that declares Web Apps cannot hold `here()` in
	 *  a case list, so nothing reads the Web Apps arm. */
	readonly hereValue: "lat-lon" | "lat-lon-alt-acc";
	/** How a form is paged. Web Apps draws every question of the form
	 *  (`form_entry/form_ui.js`); Core `form/api/FormEntryController.java::getQuestionPrompts`
	 *  makes a field-list group one screen and any other index one screen of
	 *  one question, and Nova writes `appearance="field-list"` on every
	 *  section and labeled group (`lib/commcare/xform/builder.ts::buildContainer`). */
	readonly formScreens: "one-screen" | "field-list-or-question";
	/** When calculations re-run. Formplayer rebuilds the form session per
	 *  request (`application/FormController.java`, `FormSubmissionHelper.java`
	 *  → `session/FormSession.java` → Core `model/FormDef.java::initialize(false, …)`
	 *  → `initAllTriggerables`); Android re-evaluates what an answer reaches. */
	readonly recalculation: "every-request" | "on-change";
	/** The epoch a day number counts from. Core
	 *  `model/utils/DateUtils.java::EPOCH_TIME` is computed at class load in
	 *  the JVM's zone, `Etc/UTC` for Formplayer (manifest
	 *  `expressions-and-data/int`), and in the device's zone on Android. */
	readonly dayNumberEpoch: "utc" | "device-zone";
	/** Web Apps `form_entry/question.html` (`help-text-trigger`, a modal);
	 *  Android `views/widgets/QuestionWidget.java::addHelpPlaceholder`,
	 *  `::showHelpWithDialog`. */
	readonly help: "label-icon" | "info-button";
	/** Web Apps renders help media inside the help text's own block; Core
	 *  `form/api/FormEntryPrompt.java::hasHelp` is true for help media alone. */
	readonly helpMediaWithoutText: "hidden" | "shown";
	/** Web Apps `question.html` renders the hint through `markdown.render`;
	 *  Android `QuestionWidget::addHintText` as plain text. */
	readonly hint: "markdown" | "plain";
	/** Label markdown. Web Apps `cloudcare/js/markdown.js::render`
	 *  (`breaks: true`, markdown-it `html: false`, so raw HTML shows as
	 *  written); Android `CommCareApplication.java::getMarkwonInstance`, with
	 *  no HTML or image plugin: a single newline joins with a space, an image
	 *  shows its alt text, and a raw tag is dropped with its text kept
	 *  (`proof/android/test_form_reads.py` reads a label off a device). */
	readonly labelMarkdown: {
		readonly singleNewline: "break" | "space";
		readonly html: "literal" | "dropped";
		readonly images: "shown" | "alt-text";
	};
	/** Android `views/QuestionsView.java::deriveGroupText`: one header line
	 *  per screen, the enclosing groups joined with ` > `. */
	readonly groupLabel: "card" | "screen-header";
	/** Android `activities/FormEntryActivityUIController.java::createRepeatDialog`. */
	readonly repeatAdd: "buttons" | "prompt";
	/** Choice images, audio and video (manifest `questions/choice-image`,
	 *  `choice-audio-video`; Android `views/media/MediaLayout.java`). */
	readonly choiceMedia: boolean;
	/** Web Apps `form_entry/entries.js::GeoPointEntry`; Android
	 *  `views/widgets/GeoPointWidget.java`, `activities/GeoPointActivity.java`. */
	readonly locationQuestion: "map" | "record-location";
	/** Web Apps `entries.js::getEntry` (a barcode question falls through to
	 *  `FreeTextEntry`); manifest `questions/barcode-barcode`. */
	readonly barcodeQuestion: "text" | "scan-or-text";
	/** Web Apps `entries.js::FileEntry`, `entry_file.html`; Android
	 *  `views/widgets/ImageWidget.java`, `CommCareAudioWidget.java`,
	 *  `VideoWidget.java`. */
	readonly capture: "attach" | "device";
	/** Android's last screen reads `form.entry.finish.button`. */
	readonly submitLabel: "submit" | "finish";
	/** Manifest `application-and-settings/logo-refs-hq-logo-web-apps`
	 *  (Android ignores it). */
	readonly logo: boolean;
}

/** The one table. Both members are frozen, and the `satisfies` makes a field
 *  missing on either platform a type error. */
export const PREVIEW_PLATFORM_RULES = {
	"web-apps": Object.freeze({
		appHome: "root-menu",
		postSubmitAppHome: "root-menu",
		afterSubmitHiddenTarget: "landing",
		entryPointDisplayConditions: "kept-unless-ignored",
		entryPointClaims: "posted",
		entryPointCaseNotHeld: "claimed",
		entryPointUnheldCaseSubmit: "submits",
		formlessCaseListSelection: "back-to-root-menu",
		claimThenSync: false,
		tileGrouping: "grouped",
		tileBorderShading: true,
		tileVerticalAlign: "as-authored",
		linkColumnInList: "link",
		searchScreenText: true,
		searchFieldChecks: true,
		hiddenSearchFieldWithDefault: "hidden",
		barcodeSearchField: "text",
		zeroSearchResults: "results",
		skipToResults: true,
		hereValue: "lat-lon",
		formScreens: "one-screen",
		recalculation: "every-request",
		dayNumberEpoch: "utc",
		help: "label-icon",
		helpMediaWithoutText: "hidden",
		hint: "markdown",
		labelMarkdown: Object.freeze({
			singleNewline: "break",
			html: "literal",
			images: "shown",
		}),
		groupLabel: "card",
		repeatAdd: "buttons",
		choiceMedia: false,
		locationQuestion: "map",
		barcodeQuestion: "text",
		capture: "attach",
		submitLabel: "submit",
		logo: true,
	}),
	android: Object.freeze({
		appHome: "device-home",
		postSubmitAppHome: "device-home",
		afterSubmitHiddenTarget: "opens",
		entryPointDisplayConditions: "ignored",
		entryPointClaims: "none",
		entryPointCaseNotHeld: "opens-blank",
		entryPointUnheldCaseSubmit: "not-processed",
		formlessCaseListSelection: "device-home",
		claimThenSync: true,
		tileGrouping: "flat",
		tileBorderShading: false,
		tileVerticalAlign: "middle-only",
		linkColumnInList: "raw-text",
		searchScreenText: false,
		searchFieldChecks: false,
		hiddenSearchFieldWithDefault: "editable",
		barcodeSearchField: "scan-or-text",
		zeroSearchResults: "stay-on-search",
		skipToResults: false,
		hereValue: "lat-lon-alt-acc",
		formScreens: "field-list-or-question",
		recalculation: "on-change",
		dayNumberEpoch: "device-zone",
		help: "info-button",
		helpMediaWithoutText: "shown",
		hint: "plain",
		labelMarkdown: Object.freeze({
			singleNewline: "space",
			html: "dropped",
			images: "alt-text",
		}),
		groupLabel: "screen-header",
		repeatAdd: "prompt",
		choiceMedia: true,
		locationQuestion: "record-location",
		barcodeQuestion: "scan-or-text",
		capture: "device",
		submitLabel: "finish",
		logo: false,
	}),
} as const satisfies Readonly<Record<Platform, PreviewPlatformRules>>;

/** The rules of one platform. */
export function previewPlatformRules(platform: Platform): PreviewPlatformRules {
	return PREVIEW_PLATFORM_RULES[platform];
}

/** The search screen's heading and description. Web Apps shows the
 *  authored title and description; Android shows neither, and its heading is
 *  the search action's label (`searchScreenText`). */
export function searchScreenHeading(
	rules: Pick<PreviewPlatformRules, "searchScreenText">,
	authored: { readonly title: string; readonly subtitle: string | undefined },
): { readonly title: string; readonly subtitle: string | undefined } {
	return rules.searchScreenText
		? authored
		: { title: CASE_SEARCH_BUTTON_LABEL, subtitle: undefined };
}

function otherPlatform(platform: Platform): Platform {
	return platform === "web-apps" ? "android" : "web-apps";
}

/** The refusal for a platform the app does not declare, naming the one it
 *  runs on: "This app runs only on Android, so a session can't run in Web
 *  Apps. Leave platform out to use Android." */
export function platformUnavailableSentence(
	platform: Platform,
	subject: "a session" | "the form",
): string {
	const other = otherPlatform(platform);
	return `This app runs ${platformDeclarationPhrase([other])}, so ${subject} can't run ${inPlatform(platform)}. Leave platform out to use ${PLATFORM_LABELS[other]}.`;
}

// ── Session context values ────────────────────────────────────────────────

/** Web Apps' `deviceid`: Formplayer
 *  `session/FormplayerInstanceInitializer.java::getDeviceId`. */
export const WEB_APPS_DEVICE_ID = "Formplayer";

/** Web Apps' `appversion`: Formplayer
 *  `FormplayerInstanceInitializer.java::getVersionString` over the platform
 *  `session/FormSession.java` builds from Core
 *  `src/cli/java/org/commcare/util/engine/CommCareConfigEngine.java`
 *  (`MAJOR_VERSION` 2, `MINOR_VERSION` 64). The lane holds it to Formplayer's
 *  own submission. */
export const WEB_APPS_APPVERSION = "Formplayer Version: 2.64";

/** Android's `deviceid` is this and a UUID minted at install
 *  (`utils/DeviceIdentifier.java::getDeviceIdentifier`). */
export const ANDROID_DEVICE_ID_PREFIX = "commcare_";

/** The pin's `versionName` (`app/AndroidManifest.xml`, `2.65`) split into
 *  three numbers, as `AppUtils.java::getCurrentVersionString` prints it. */
export const ANDROID_VERSION_NAME = "2.65.0";

/** Android's `appversion`: `AppUtils.java::getCurrentVersionString` over the
 *  template `version.id.long`
 *  (`CommCare Android, version "${0}"(${1}). App v${5}. CommCare Version ${2}. Build ${3}, built on: ${4}`),
 *  `${0}` and `${2}` the version name, the rest empty: Preview has no build
 *  and no published profile. */
export function androidAppVersion(): string {
	return `CommCare Android, version "${ANDROID_VERSION_NAME}"(). App v. CommCare Version ${ANDROID_VERSION_NAME}. Build , built on: `;
}
