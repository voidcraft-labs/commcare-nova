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
	platformBehavior,
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
	/** Formplayer records activity at entry and submission. Android ignores
	 * the activity keys (proof/formplayer/test_form_activity.py). */
	readonly recentFormActivity: boolean;
	/** Reopening an incomplete Android form from Home carries its existing
	 * entry and answers into the new run (proof/android/test_case_blocks.py).
	 * Web Apps restores its own current session instead. */
	readonly resumeDraftAcrossRuns: boolean;
	/** Core's extended text is the default. Android's help dialog and
	 * eligible choice widgets ask for their Markdown form first
	 * (proof/android/test_form_reads.py). */
	readonly questionProseForms: "extended-first" | "markdown-first";
	/** The companion-app action on a case list (case-list-android-lookup). */
	readonly caseListDeviceLookup: boolean;
	/** The native several-case datum, including the bounded flat close. */
	readonly severalCaseSelection: boolean;
	/** Core Selection.attachChoice; Formplayer PromptToJson.parseQuestionAnswer;
	 * Android FormHierarchyBuilder.getQuestionDisplayText and instance restore. */
	readonly unavailableInlineChoice: "display" | "summary-or-restore";
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
	/** What runs when a form pushes several frames. Core's session runs every
	 *  frame, the last pushed first, and Android keeps it
	 *  (`session/CommCareSession.java::finishAndPop`,
	 *  `models/AndroidSessionWrapper.java::terminateSession`); Formplayer
	 *  rebuilds its session from the frame on top and drops the rest
	 *  (`services/MenuSessionFactory.java::rebuildSessionFromFrame` →
	 *  `session/MenuSession.java::resetSession`). */
	readonly afterSubmitFrames: "stack" | "top";
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
	 *  missing case; Android processes the form as it saves it, so the save
	 *  fails and the phone quarantines the form, sends nothing and posts
	 *  "Form Record Quarantined" (`FormEntryActivity.java::savingComplete`,
	 *  `FormRecordProcessor.java::quarantineRecord`;
	 *  `proof/android/test_navigation.py` reads it off a device). Preview saves
	 *  nothing for a form that changes such a case (`unheldCaseSubmit.ts`). */
	readonly entryPointUnheldCaseSubmit: "submits" | "not-processed";
	/** Where choosing a case from a case list menu entry lands. Web Apps:
	 *  Formplayer `session/MenuSession.java::getNextScreen` steps a view
	 *  command back (`isViewCommand` → `stepBack`) and asks for the next
	 *  screen again, so the screen before the choice shows; Android:
	 *  `HomeScreenBaseActivity.java::handleNoFormFromSessionNav` →
	 *  `terminateSession`. */
	readonly caseListMenuItemSelection: "step-back" | "device-home";
	/** The button on a case list menu entry's case detail. Android shows Done in
	 *  view mode (`EntityDetailActivity.java`, `select.detail.bypass`), whose
	 *  result leaves the list showing; Web Apps shows Continue. */
	readonly caseListMenuItemDetail: "continue" | "done";
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
	/** Formplayer reads a form's Web Apps behavior texts by presence
	 *  (`FormSession.setAutoSubmitFlag`, `setSuppressAutosyncFlag`,
	 *  `setSkipValidation`, `setVolatilityIndicators`): a form submits as soon
	 *  as it opens, skips its sync, or rechecks only changed answers. CommCare
	 *  Android reads none of these texts. */
	readonly webAppsFormPragmas: boolean;
	/** Formplayer's case-list field exposes the link target. CommCare Android
	 *  shows the stored media path as plain text. */
	readonly caseListIconActions: boolean;
	/** Android's markdown arm is on the case detail only
	 *  (`views/EntityDetailView.java`, `FORM_MARKDOWN`). */
	readonly linkColumnInList: "link" | "raw-text";
	/** A Details tile's layout. Web Apps draws the long detail's own grid
	 *  (`formplayer` `EntityDetailResponse` carries each field's style, and
	 *  `case-layout.js` reads its grid area); Android draws a long detail's
	 *  fields as ordinary labeled rows (`views/EntityDetailView.java`). */
	readonly detailTile: "laid-out" | "rows";
	/** The signed standalone Search page can supply its submitted text to
	 *  Details in Formplayer (`proof/editors/test_search_result_detail.py`). */
	readonly searchResultDetailText: boolean;
	/** A Search Only field placed on a custom tile. Web Apps hides a field
	 *  whose header width is zero; Android draws every placed cell of its
	 *  list tile unless the cell's coordinate is negative
	 *  (`EntityViewTile.java`). */
	readonly searchOnlyTileCell: "hidden" | "drawn";
	/** A search's title, description and field hints (manifest
	 *  `case-search/title-label-lang-non-empty`, `description-lang-markdown`,
	 *  `hint-lang`, which Android ignores). */
	readonly searchScreenText: boolean;
	readonly searchAddressPicker: boolean;
	readonly searchFieldGroups: boolean;
	/** The pinned case tile above the search screen. Formplayer sets it on
	 *  every response, a search's included
	 *  (`MenuSessionRunnerService.getNextMenu`, `setPersistentCaseTile`);
	 *  Android's search (`QueryRequestUiController`, `http_request_layout.xml`)
	 *  holds no `universal_frame_tile`, where
	 *  `BreadcrumbBarHelper.addUniversalFrameTile` places it, so its search
	 *  draws none (`lib/preview/pinnedCaseTile.ts`). */
	readonly searchScreenCaseTile: boolean;
	/** The tile of the case a case's details show, where no case the session
	 *  holds pins one. Android's details screen asks for it when the frame
	 *  names none (`BreadcrumbBarHelper.loadTile` falling back to
	 *  `EntityDetailActivity.requestEntityContext`), drawn with the persistent
	 *  detail of the datum being chosen (`EntityDetailUtils.populateDetailIntent`,
	 *  `DETAIL_PERSISTENT_ID`); Formplayer's details answer carries no tile
	 *  (`MenuController.getDetails`), so Web Apps draws none
	 *  (`lib/preview/pinnedCaseTile.ts`). */
	readonly caseDetailsCaseTile: boolean;
	/** A Search field's required condition and checks (manifest
	 *  `case-search/required-test-text`, `validations-0-test-text`). */
	readonly searchFieldChecks: boolean;
	/** A hidden Search field: a hidden value or a field Web Apps does not
	 *  draw (manifest `case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset`,
	 *  `hidden-exclude-without-a-default-value-on-a-prompt-with-no`,
	 *  `hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or`,
	 *  `hidden-on-a-prompt-that-carries-an-itemset-input-type-or`). Web Apps
	 *  hides the prompt's row whole (`query.js`, `d-none`); Android reads no
	 *  `hidden` and draws it as any field, where the worker can change it. */
	readonly hiddenSearchField: "hidden" | "editable";
	/** "Include results where … is blank" under a Search field that allows it
	 *  (manifest `case-search/allow-blank-value`): Web Apps draws the box from
	 *  Formplayer's `allow_blank_value` (`query/item.html`); Android reads no
	 *  such setting and shows the field alone. */
	readonly searchForBlank: boolean;
	/** HQ's Web Apps model indexes labels by value; Android enumerates Core's itemset rows. */
	readonly searchChoiceOrder: "values" | "rows";
	/** A date-range Search field's starting value. Web Apps' range picker
	 *  reads it by the client's strict Moment formats and shows each end in the
	 *  browser's calendar (`cloudcare/js/utils.js`, `menus/views/query.js`;
	 *  `searchRangeAnswer.ts::webSearchRangeDraft`), refusing the screen where
	 *  it cannot; Android's prompt shows the stored text
	 *  (`androidStartingRangeLabel`). */
	readonly searchRangeStartingValue: "date-picker" | "text";
	/** A day the worker picks for a date-range end. Android's Material range
	 *  picker supplies UTC midnight, which its callback prints in the worker's
	 *  zone (`androidSelectedRangeDay`); Web Apps' picker gives the calendar
	 *  day itself. */
	readonly searchRangeChosenDay: "calendar-day" | "utc-midnight";
	/** A barcode Search field (manifest `case-search/appearance-barcode-scan`:
	 *  a plain text box in Web Apps). */
	readonly barcodeSearchField: "text" | "scan-or-text";
	/** A search with no results. Android
	 *  `activities/QueryRequestActivity.java::processSuccess` shows a toast and
	 *  stays on the search. */
	readonly zeroSearchResults: "results" | "stay-on-search";
	/** Whether the Search screen offers Clear, which empties its fields. Web
	 *  Apps draws it on every query screen (`cloudcare/partials/query/list.html`,
	 *  `#query-clear-button`, `menus/views/query.js::QueryListView.clearAction`);
	 *  Android's search screen holds its prompts, its search button and its
	 *  error line alone (`activities/QueryRequestUiController.kt`, layout
	 *  `http_request_layout.xml`), and `QueryRequestActivity` clears no field. */
	readonly searchClear: boolean;
	/** The narrowest window, in CSS pixels, at which Clear also runs the
	 *  search where the menu asks for it (`caseSearchConfig.searchOnClear`),
	 *  or `undefined` where Clear never searches. Web Apps'
	 *  `menus/views/query.js::clearAction` searches only while the screen is
	 *  not small (`utils.js::smallScreenIsEnabled`, `SMALL_SCREEN_WIDTH_PX`
	 *  992); Android has no Clear. */
	readonly searchOnClearMinWidth: number | undefined;
	/** Whether the case list's Search action launches on its own: search first
	 *  and skip to results. Core's cli `EntityScreen.evaluateAutoLaunch`, which
	 *  Formplayer runs; commcare-android holds no reader of `auto_launch`, so it
	 *  opens the worker's list first, with the Search action. */
	readonly searchActionAutoLaunch: boolean;
	/** The answers a search history gives back runs with
	 *  (`searchStanding.ts::PreviewSearchReplay`). Web Apps answers the query
	 *  an address records with the answers the worker last gave that query
	 *  (`formplayer/utils/utils.js::CloudcareUrl.fromJson` over
	 *  `Utils.getCurrentQueryInputs`); Android's session keeps the query a
	 *  step ran (`CommCareSession.setQueryDatum`). */
	readonly searchReplay: "latest-answers" | "own-answers";
	/** What a history entry Back or Forward returns to shows its screen with
	 *  (`lib/routing/previewSelectionsHistory.ts`). Web Apps'
	 *  address holds the session's selections
	 *  (`formplayer/utils/utils.js::CloudcareUrl`), and a popped address is
	 *  routed again (`formplayer/router.js::listMenus`) to Formplayer, which
	 *  replays them (`MenuSessionRunnerService.advanceSessionWithSelections`):
	 *  `address`. Android has no address; its Back is the device's step back
	 *  (`CommCareSession.stepBack`), so an entry shows the session as it
	 *  stands: `session`. */
	readonly poppedEntrySelections: "address" | "session";
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
	 *  section and every group holding `fieldList`
	 *  (`lib/commcare/xform/builder.ts::buildContainer`). */
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
	/** HQ submits OK for info questions. Android reads a checkbox on an interactive message. */
	readonly messageConfirmation: "automatic" | "checkbox";
	/** Label markdown. Both runtimes format the label Core hands them with
	 *  its values already substituted (`FormEntryCaption.getSpecialFormQuestionText`
	 *  → `FormDef.fillTemplateString`), so a value's own formatting shows.
	 *  Web Apps `cloudcare/js/markdown.js::render` (`breaks: true`, markdown-it
	 *  `html: false`, so raw HTML shows as written, and no linkify, so a bare
	 *  address is text); Android `CommCareApplication.java::getMarkwonInstance`,
	 *  with no HTML, image or linkify plugin: a single newline joins with a
	 *  space, an image shows its alt text, and a raw tag is dropped with its
	 *  text kept (`proof/android/test_form_reads.py` reads a label off a
	 *  device). Under `images: "shown"` Preview draws a picture whose address
	 *  is inside the label and describes one at any other address, so label
	 *  text never makes the builder's page request anything
	 *  (`lib/markdown.tsx::labelMarkdownOptions`). */
	readonly readsCaseImageDescriptions: boolean;
	readonly caseLocationDetail: "text" | "show-address";
	readonly labelMarkdown: {
		readonly singleNewline: "break" | "space";
		readonly html: "literal" | "dropped";
		readonly images: "shown" | "alt-text";
	};
	/** A choice holding `plainLabel`, whose `<item>` writes no markdown form.
	 *  Web Apps `form_entry/entry_select.html` binds every choice through
	 *  `renderMarkdown`, so it still shows formatted; Android formats a
	 *  choice only when Core `form/api/FormEntryPrompt.java::getSelectItemMarkdownText`
	 *  finds its markdown form, else draws `getSelectChoiceText` as written
	 *  (`views/widgets/SelectOneWidget.java`, `QuestionWidget.java`). */
	readonly plainChoice: "markdown" | "literal";
	/** A help text shown as typed (its question holds `plainHelp`, or its form
	 *  `plainText`), whose itext writes no markdown form. Web Apps formats a
	 *  help text's default text always (`form_entry/form_ui.js::Question.prototype.fromJS`,
	 *  `help`; Formplayer `PromptToJson.java::parseQuestion` sends
	 *  `getHelpText()`); Android formats it only where its markdown form exists,
	 *  else draws `getHelpText()` as written
	 *  (`views/widgets/QuestionWidget.java::createHelpLayout`). */
	readonly plainHelp: "markdown" | "literal";
	/** Android `views/QuestionsView.java::deriveGroupText`: one header line
	 *  per screen, the enclosing groups joined with ` > `. */
	readonly groupLabel: "card" | "screen-header";
	/** A text, password or barcode question that asks for address search.
	 *  Web Apps builds its geocoder entry (`form_entry/entries.js::getEntry`,
	 *  `AddressEntry`), under the project space's gates; Android reads the
	 *  question as ordinary text (`WidgetFactory.buildBasicWidget`). */
	readonly addressQuestion: "search" | "text";
	/** A text or number question under a compact group. Android draws a
	 *  compact widget, its label's one line beside the answer box and no
	 *  media, hint or help (`QuestionWidget`, `WidgetFactory.buildBasicWidget`,
	 *  `lib/preview/androidCompact.ts`); Web Apps reads no compact setting. */
	readonly compactGroup: "ignored" | "beside-label";
	/** A hint placed in the entry box or hidden. Web Apps reads
	 *  `hint-as-placeholder` (`form_entry/entries.js::EntrySingleAnswer`, the
	 *  placeholder; `form_ui.js::Question`, the hint's line); Android's
	 *  `views/widgets/QuestionWidget.java::addHintText` reads no appearance, so
	 *  the hint stays below the question. */
	readonly hintPlacement: "as-authored" | "below-question";
	/** How a search box matches what the worker types. Web Apps
	 *  `form_entry/entries.js::ComboboxEntry` (the trimmed text, a whole-word
	 *  or close-spelling match); Android `views/widgets/ComboboxWidget.java`
	 *  over Core's `StandardFilterRule`, `MultiWordFilterRule` and
	 *  `FuzzyMatchFilterRule`, whose `views/Combobox.java` puts the cursor
	 *  back on an edit that leaves no choice matching. */
	readonly choiceSearch: "combobox" | "filter-rule";
	/** A date question with no answer. Web Apps' `form_entry/entries.js::DateEntry`
	 *  can be emptied and shows nothing until a day is chosen; Android's
	 *  `views/widgets/DateWidget.java` builds its picker on the answer or the
	 *  device's day, which it saves as the worker leaves, and has no clear
	 *  (only `gregorian-with-clear` and the Ethiopian and Nepali widgets can be
	 *  empty, `workerCalendar.ts::androidCalendarCanBeEmpty`). */
	readonly datePicker: "clearable" | "shows-a-day";
	/** Android commits an unchanged visible text starting answer when the worker
	 *  leaves its single-question screen (`proof/android/test_form_behavior_pragmas.py`). */
	readonly commitStartingTextOnScreenExit: boolean;
	/** Which calendars a date question draws. Web Apps builds
	 *  `EthiopianDateEntry` for `ethiopian` alone (`form_entry/entries.js::getEntry`);
	 *  Android's `views/widgets/WidgetFactory.java` builds the Ethiopian,
	 *  Nepali and Gregorian-with-clear widgets, the Ethiopian one only for an
	 *  appearance of that word alone. */
	readonly alternateCalendar: "ethiopian" | "authored";
	/** A time question's clock. Web Apps reads `12-hour`
	 *  (`form_entry/entries.js::DateTimeEntryBase`, `TIME_12_HOUR`) and is a
	 *  24-hour clock otherwise; Android's `views/widgets/TimeWidget.java`
	 *  follows the phone's settings, which Preview draws as a 12-hour clock. */
	readonly timeClock: "as-authored" | "device";
	/** A group's collapse and border. Web Apps `form_entry/form_ui.js::Group`
	 *  (`collapsible`, `groupBorder`); Android draws a group as its screen's
	 *  header line (`views/QuestionsView.java::deriveGroupText`). */
	readonly groupFrame: "as-authored" | "plain";
	/** Questions and repeat entries sharing a row. Web Apps
	 *  `form_entry/form_ui.js` (`PER_ROW_PATTERN`, `PER_ROW_REPEAT_PATTERN`);
	 *  commcare-android reads neither appearance. */
	readonly questionsPerRow: boolean;
	/** A question's text alignment. Web Apps
	 *  `cloudcare/partials/form_entry/question.html` (`text-align-center`,
	 *  `text-align-right`); commcare-android reads neither. */
	readonly questionAlignment: boolean;
	/** A short or medium entry box. Web Apps `form_entry/form_ui.js::Question`
	 *  (`SHORT`, `MEDIUM`); Android keeps the box's width and reads `short`
	 *  only for the keyboard action (`keyboardAction`). */
	readonly inputWidth: boolean;
	/** A password with a number keypad. Web Apps builds a `PhoneEntry` for the
	 *  numeric appearance, a plain text box (`form_entry/entries.js::getEntry`;
	 *  `FreeTextEntry` alone masks a secret); Android's
	 *  `views/widgets/StringNumberWidget.java` keeps the answer masked. */
	readonly secretKeypad: "visible" | "masked";
	/** Nova's "Sign on Web Apps" setting, offered only beside another display
	 *  setting (`lib/domain/questionDisplay.ts::canOfferDisplaySetting`). Web
	 *  Apps builds a `SignatureEntry` where the appearance holds `signature`
	 *  (`form_entry/entries.js::getEntry`); Android's
	 *  `views/widgets/WidgetFactory.java` builds a `SignatureWidget` only for
	 *  an appearance of that word alone. */
	readonly combinedSignature: boolean;
	/** A label shown as a colored banner above the screen. Android
	 *  `activities/components/FormNavigationUI.java::updateFloatingLabels`;
	 *  Web Apps draws the label in its place (`form_entry/entries.js::InfoEntry`). */
	readonly questionBanner: boolean;
	/** A label's text selection. Android's `views/widgets/TriggerWidget.java`
	 *  makes the text selectable for `selectable` alone and not otherwise;
	 *  Web Apps leaves selection to the browser. */
	readonly labelTextSelection: "browser" | "by-setting";
	/** The keyboard's Next or Done action on an entry box. Android
	 *  `views/widgets/StringWidget.java`, `IntegerWidget.java`, `DecimalWidget.java`
	 *  (`setImeOptions`), marked by `views/QuestionsView.java`; Web Apps sets
	 *  none. */
	readonly keyboardAction: boolean;
	/** Questions that share their answers over a channel. Web Apps
	 *  `form_entry/entries.js::getEntry` reads `broadcast-*` and `receive-*`;
	 *  commcare-android reads neither, so each question keeps its own answer. */
	readonly questionChannels: boolean;
	/** Android `activities/FormEntryActivityUIController.java::createRepeatDialog`. */
	readonly repeatAdd: "buttons" | "prompt";
	/** Choice images, audio and video (manifest `questions/choice-image`,
	 *  `choice-audio-video`; Android `views/media/MediaLayout.java`). */
	readonly choiceMedia: boolean;
	/** A label's inline video (`label_media.videoInline`, its `video-inline`
	 *  form). Android plays it inside the question, in the label's media pane
	 *  ahead of a QR code and the label image
	 *  (`views/media/MediaLayout.java::setAVT`, `setupInlineVideoView`);
	 *  Formplayer sends no such form (`api/json/PromptToJson.java`), so Web
	 *  Apps shows none. Neither shows one on a question shown compact. */
	readonly labelInlineVideo: "played" | "ignored";
	/** A label's QR code (`qr_code`, its `qrcode` form). Android draws it in
	 *  the label's media pane in place of the label image
	 *  (`views/media/MediaLayout.java::setAVT`, `setupQRView`); Formplayer
	 *  sends no such form (`api/json/PromptToJson.java`), so Web Apps draws
	 *  none. Neither draws one on a question shown compact. */
	readonly labelQrCode: "drawn" | "ignored";
	/** A label's spoken text (`spoken_text`, its `tts` form). Android shows a
	 *  speaker button that reads it aloud where the label has no audio
	 *  (`MediaLayout.java::buildComprehensiveLayout`, `showTtsButton`);
	 *  Formplayer sends no such form, so Web Apps shows none. */
	readonly labelSpeech: "button" | "ignored";
	/** Web Apps `form_entry/entries.js::GeoPointEntry`; Android
	 *  `views/widgets/GeoPointWidget.java`, `activities/GeoPointActivity.java`. */
	readonly locationQuestion: "map" | "record-location";
	/** Web Apps `entries.js::getEntry` (a barcode question falls through to
	 *  `FreeTextEntry`); manifest `questions/barcode-barcode`. */
	readonly barcodeQuestion: "text" | "scan-or-text";
	/** Android WidgetFactory opens an intent in place of the input. Web Apps
	 *  keeps the ordinary auxiliary input and cannot open the owner. */
	readonly androidAppAnswers: boolean;
	/** A Text question with a number keypad. Web Apps `form_entry/entries.js::PhoneEntry` stores an
	 *  answer only where it matches its pattern; Android `views/widgets/StringNumberWidget.java` limits
	 *  the keys and stores what its key listener leaves in the box: a + or - only as its first
	 *  character, and one period. */
	readonly numberKeypad: "pattern" | "keys";
	/** Web Apps `entries.js::FileEntry`, `entry_file.html`; Android
	 *  `views/widgets/ImageWidget.java`, `CommCareAudioWidget.java`,
	 *  `VideoWidget.java`. */
	readonly capture: "attach" | "device";
	/** Android's last screen reads `form.entry.finish.button`. */
	readonly submitLabel: "submit" | "finish";
	/** A case list's own empty-list text and Continue label, the detail's
	 *  `no_items_text` and `select_text`. Formplayer sends both
	 *  (`beans/menus/EntityListResponse.java`, `setNoItemsText`,
	 *  `setSelectText`) and Web Apps draws the empty text on an empty list and
	 *  the select text on its several-case Continue only
	 *  (`cloudcare/js/formplayer/menus/views.js`,
	 *  `partials/case_list/multi_select_continue_button.html`);
	 *  commcare-android holds no reader of `Detail.getNoItemsText` or
	 *  `getSelectText`, so its list keeps its own wording. */
	readonly caseListDetailWording: boolean;
	/** A form that requests the device location when it opens. Android
	 *  registers the `pollsensor` action (`engine/extensions/PollSensorExtensionParser.java`,
	 *  `android/javarosa/PollSensorAction.java`) and sends the fix it gets;
	 *  Formplayer registers no reader of it, so Web Apps sends the form with
	 *  no location. */
	readonly automaticLocation: boolean;
	/** Manifest `application-and-settings/logo-refs-hq-logo-web-apps`
	 *  (Android ignores it). */
	readonly logo: boolean;
	/** A case list action's icon and spoken label, the Register button's:
	 *  Android draws both (`views/EntityActionViewUtils.java::setupActionImage`,
	 *  `setupActionAudio`); Web Apps draws the action's text alone
	 *  (`cloudcare/partials/case_list/list.html`, `action.text`). */
	readonly caseListActionMedia: "shown" | "text-only";
	/**
	 * How the list's filter box splits what a worker types, what closeness does to the order,
	 * and what an emptied box does.
	 *
	 * Both runtimes run Core's `util/EntitySortUtil.java::sortEntities`
	 * (`lib/preview/listFilterMatch.ts`) and differ around it. Formplayer splits
	 * on single spaces (`util/screen/EntityScreenHelper.java::filterEntities`,
	 * `searchText.split(" ")`), takes the filter's matches, which fuzzy search
	 * puts closest first (`util/EntitySortUtil.java::sortEntities`), and sorts
	 * them again by the list's own order with a stable sort (`sortEntities`,
	 * `cases/entity/EntitySorter.compare` answering 0 on a tie), so closeness
	 * orders only the rows the list's order ties; and it skips an empty text. Android
	 * splits on runs of whitespace (`adapters/EntityListAdapter.java::filterByString`,
	 * `split("\\s+")`), shows the matches as the filter returns them, stably
	 * re-sorted by ascending score under fuzzy search
	 * (`adapters/EntityStringFilterer.java::buildMatchList`), and runs every
	 * change once the worker has typed, an emptied box included, which is one
	 * empty term (`adapters/EntityStringFilterer.java`, `isFilterEmpty`).
	 */
	readonly listFilter: {
		readonly terms: "single-spaces" | "whitespace-runs";
		readonly fuzzyOrder: "closest-among-ties" | "closest-first";
		readonly emptyText: "skipped" | "runs-once-edited";
	};
	/**
	 * Whether a required question carries the asterisk. Web Apps marks every one
	 * (`form_entry/question.html`, the `required` class); Android only where the
	 * profile's `cc-label-required-questions-with-asterisk` is `yes`
	 * (`QuestionWidget.java::setTextFromPrompt`).
	 */
	readonly requiredMark: "always" | "by-setting";
	/**
	 * The case list's Sort by: what it lists, what a pick does, and what lets
	 * it go (`lib/preview/caseListSortMenu.ts`). Both order by the one field
	 * picked (commcare-core `EntitySorter`, `caseListOrder.ts` rule 11), and a
	 * pick of the field already picked turns it around.
	 *
	 * Android lists every field of the short detail whose header is not blank
	 * (`activities/EntitySelectActivity.java::getSortOptionsList`), sorts the
	 * list it holds again with a stable sort, so the order before the pick
	 * breaks its ties, and starts from the list's own sort: picking the list's
	 * one sort field first turns it around (`SortableEntityAdapter.sort`). A
	 * filter keeps the pick (`getSortOptionsList` runs the filter again).
	 *
	 * Web Apps lists the list's sort fields (Formplayer's `sortIndices`,
	 * `Detail.getOrderedFieldIndicesForSorting`): in a case tile list every one
	 * in its Sort By (`menus/views.js::CaseTileListView`), in a list of columns
	 * each shown one as a header to click (`table_container.html`,
	 * `columnSortable`). Formplayer sorts the list afresh by the pick alone
	 * (`EntityScreenHelper.sortEntities`); a pick names no direction until it
	 * is picked again (`router.js`, `menu:sort`); new filter text lets it go
	 * (`utils.js::CloudcareUrl.setSearch`), and a page change keeps it.
	 */
	readonly sortMenu: {
		readonly lists: "sort-fields" | "named-fields";
		readonly firstPickOfOnlyRule: "reverses" | "keeps";
		readonly ties: "earlier-order" | "none";
		readonly filterText: "lets-go" | "keeps";
		readonly marks: "pick-only" | "list-order-and-pick";
	};
	/**
	 * What a case list keeps of its page, its filter text and its Sort by
	 * pick when the worker comes back to it (`caseListReturn.ts`). Back from
	 * the list's own case details keeps all three on both platforms, and a
	 * forward step onto the list (a form's submission landing there, a menu,
	 * a crumb, Home) starts it afresh on both: Web Apps' `CloudcareUrl`
	 * clears `page`, `search` and `sortIndex` on `onSubmit`, `spliceSelections`
	 * and `clearExceptApp`, and Android opens a new `EntitySelectActivity`.
	 *
	 * `back` is a step back onto the list from a screen past it (a form left
	 * unfinished, a form menu). Web Apps keeps all three (`address`): its Back
	 * is the browser's, and the list's address carries its `page`, `search`
	 * and `sortIndex` (`utils.js::CloudcareUrl`, `toJson`), which the router
	 * sends again (`router.js::listMenus`). Android shows a new list
	 * (`new-list`): choosing a case finishes the list
	 * (`EntitySelectActivity.returnWithResult`), so a step back
	 * (`CommCareSession.stepBack`) opens another, on the list's own order at
	 * its top, and with the filter text the list held when it last opened a
	 * case's details: the list saves its text to the session's current step
	 * as it stops (`EntitySelectActivity.onStop` →
	 * `CommCareActivity.saveLastQueryString`), which only the details screen
	 * covering it does on the step the step back returns to, and a new list
	 * reads it back (`restoreLastQueryString`, `EntitySelectSearchUI`).
	 *
	 * `search` is a search run again. Web Apps keeps the pick and lets the
	 * page and the filter text go (`keeps-sort`,
	 * `utils.js::CloudcareUrl.setQueryData`, which leaves `sortIndex`);
	 * Android shows the results in a new list (`new-list`): the search's
	 * `QueryRequestActivity` returns to the session's next step, which starts
	 * another `EntitySelectActivity`
	 * (`HomeScreenBaseActivity.launchQueryMaker`, `launchEntitySelect`).
	 */
	readonly caseListReturn: {
		readonly back: "address" | "new-list";
		readonly search: "keeps-sort" | "new-list";
	};
	/** A menu or form badge's evaluated text. Web Apps shows the text
	 *  Formplayer returns as the command's `badgeText` whole, in list and grid
	 *  styles (`menus/views.js`); Android's `MenuAdapter.updateBadgeView`
	 *  hides an empty or exactly `0` badge and shortens one longer than three
	 *  UTF-16 units (`shortened`): `999+` where `Integer.parseInt` reads it,
	 *  else its first three units and `..`. */
	readonly menuBadge: "whole" | "shortened";
	/** A grid tile's spoken label. Web Apps draws a grid with its own
	 *  template, which has no audio control (`menus/views.js` chooses the grid
	 *  template before the audio one); Android plays it when the worker holds
	 *  the tile (`MenuGrid.onItemLongClick` prepares and starts a
	 *  `MediaPlayer`) and, returning false, leaves the tap that opens the
	 *  tile to the release. A list row offers its audio on both. */
	readonly gridMenuAudio: "none" | "hold";
	/**
	 * The case list's map. Web Apps offers it only where the project's
	 * CASE_LIST_MAP switch is on and the list has an address, and marks each
	 * case at the first address column's value alone
	 * (`cloudcare/js/formplayer/menus/views.js`, `mapAvailable` and
	 * `addressIndex`). Android offers it whenever the list has an address,
	 * marks each case at its first address that parses, and draws the
	 * boundary and point layers with their colors
	 * (`gis/EntityMapUtils.kt::getEntityLocation`, `getEntityBoundary`,
	 * `getEntityPoints`).
	 */
	readonly caseMap: "switched-first-address" | "address-and-layers";
}

/** The one table. Both members are frozen, and the `satisfies` makes a field
 *  missing on either platform a type error. */
export const PREVIEW_PLATFORM_RULES = {
	"web-apps": Object.freeze({
		recentFormActivity: true,
		resumeDraftAcrossRuns: false,
		questionProseForms: "extended-first",
		caseListDeviceLookup:
			platformBehavior("case-list-android-lookup", "web-apps").reading ===
			"runs",
		severalCaseSelection:
			platformBehavior("several-cases", "web-apps").reading === "runs",
		unavailableInlineChoice: "display",
		appHome: "root-menu",
		postSubmitAppHome: "root-menu",
		afterSubmitHiddenTarget: "landing",
		afterSubmitFrames: "top",
		entryPointDisplayConditions: "kept-unless-ignored",
		entryPointClaims: "posted",
		entryPointCaseNotHeld: "claimed",
		entryPointUnheldCaseSubmit: "submits",
		caseListMenuItemSelection: "step-back",
		caseListMenuItemDetail: "continue",
		claimThenSync: false,
		tileGrouping: "grouped",
		tileBorderShading: true,
		tileVerticalAlign: "as-authored",
		webAppsFormPragmas: true,
		caseListIconActions: true,
		linkColumnInList: "link",
		detailTile: "laid-out",
		searchResultDetailText:
			platformBehavior("search-result-detail-text", "web-apps").reading ===
			"runs",
		searchOnlyTileCell: "hidden",
		searchScreenText: true,
		searchAddressPicker: true,
		searchFieldGroups: true,
		searchScreenCaseTile: true,
		caseDetailsCaseTile: false,
		searchFieldChecks: true,
		hiddenSearchField: "hidden",
		searchForBlank: true,
		searchChoiceOrder: "values",
		searchRangeStartingValue: "date-picker",
		searchRangeChosenDay: "calendar-day",
		barcodeSearchField: "text",
		zeroSearchResults: "results",
		searchClear: true,
		searchOnClearMinWidth: 992,
		searchActionAutoLaunch: true,
		searchReplay: "latest-answers",
		poppedEntrySelections: "address",
		hereValue: "lat-lon",
		formScreens: "one-screen",
		recalculation: "every-request",
		dayNumberEpoch: "utc",
		help: "label-icon",
		helpMediaWithoutText: "hidden",
		hint: "markdown",
		readsCaseImageDescriptions: true,
		caseLocationDetail: "text",
		messageConfirmation: "automatic",
		labelMarkdown: Object.freeze({
			singleNewline: "break",
			html: "literal",
			images: "shown",
		}),
		plainChoice: "markdown",
		plainHelp: "markdown",
		groupLabel: "card",
		addressQuestion: "search",
		compactGroup: "ignored",
		hintPlacement: "as-authored",
		choiceSearch: "combobox",
		datePicker: "clearable",
		commitStartingTextOnScreenExit: false,
		alternateCalendar: "ethiopian",
		timeClock: "as-authored",
		groupFrame: "as-authored",
		questionsPerRow: true,
		questionAlignment: true,
		inputWidth: true,
		secretKeypad: "visible",
		combinedSignature: true,
		questionBanner: false,
		labelTextSelection: "browser",
		keyboardAction: false,
		questionChannels: true,
		repeatAdd: "buttons",
		choiceMedia: false,
		labelInlineVideo: "ignored",
		labelQrCode: "ignored",
		labelSpeech: "ignored",
		locationQuestion: "map",
		barcodeQuestion: "text",
		androidAppAnswers: false,
		numberKeypad: "pattern",
		capture: "attach",
		submitLabel: "submit",
		caseListDetailWording: true,
		automaticLocation: false,
		logo: true,
		caseListActionMedia: "text-only",
		listFilter: Object.freeze({
			terms: "single-spaces",
			fuzzyOrder: "closest-among-ties",
			emptyText: "skipped",
		}),
		requiredMark: "always",
		sortMenu: Object.freeze({
			lists: "sort-fields",
			firstPickOfOnlyRule: "keeps",
			ties: "none",
			filterText: "lets-go",
			marks: "pick-only",
		}),
		caseListReturn: Object.freeze({ back: "address", search: "keeps-sort" }),
		menuBadge: "whole",
		gridMenuAudio: "none",
		caseMap: "switched-first-address",
	}),
	android: Object.freeze({
		recentFormActivity: false,
		resumeDraftAcrossRuns: true,
		questionProseForms: "markdown-first",
		caseListDeviceLookup:
			platformBehavior("case-list-android-lookup", "android").reading ===
			"runs",
		severalCaseSelection:
			platformBehavior("several-cases", "android").reading === "runs",
		unavailableInlineChoice: "summary-or-restore",
		appHome: "device-home",
		postSubmitAppHome: "device-home",
		afterSubmitHiddenTarget: "opens",
		afterSubmitFrames: "stack",
		entryPointDisplayConditions: "ignored",
		entryPointClaims: "none",
		entryPointCaseNotHeld: "opens-blank",
		entryPointUnheldCaseSubmit: "not-processed",
		caseListMenuItemSelection: "device-home",
		caseListMenuItemDetail: "done",
		claimThenSync: true,
		tileGrouping: "flat",
		tileBorderShading: false,
		tileVerticalAlign: "middle-only",
		webAppsFormPragmas: false,
		caseListIconActions: false,
		linkColumnInList: "raw-text",
		detailTile: "rows",
		searchResultDetailText:
			platformBehavior("search-result-detail-text", "android").reading ===
			"runs",
		searchOnlyTileCell: "drawn",
		searchScreenText: false,
		searchAddressPicker: false,
		searchFieldGroups: false,
		searchScreenCaseTile: false,
		caseDetailsCaseTile: true,
		searchFieldChecks: false,
		hiddenSearchField: "editable",
		searchForBlank: false,
		searchChoiceOrder: "rows",
		searchRangeStartingValue: "text",
		searchRangeChosenDay: "utc-midnight",
		barcodeSearchField: "scan-or-text",
		zeroSearchResults: "stay-on-search",
		searchClear: false,
		searchOnClearMinWidth: undefined,
		searchActionAutoLaunch: false,
		searchReplay: "own-answers",
		poppedEntrySelections: "session",
		hereValue: "lat-lon-alt-acc",
		formScreens: "field-list-or-question",
		recalculation: "on-change",
		dayNumberEpoch: "device-zone",
		help: "info-button",
		helpMediaWithoutText: "shown",
		hint: "plain",
		readsCaseImageDescriptions: false,
		caseLocationDetail: "show-address",
		messageConfirmation: "checkbox",
		labelMarkdown: Object.freeze({
			singleNewline: "space",
			html: "dropped",
			images: "alt-text",
		}),
		plainChoice: "literal",
		plainHelp: "literal",
		groupLabel: "screen-header",
		addressQuestion: "text",
		compactGroup: "beside-label",
		hintPlacement: "below-question",
		choiceSearch: "filter-rule",
		datePicker: "shows-a-day",
		commitStartingTextOnScreenExit: true,
		alternateCalendar: "authored",
		timeClock: "device",
		groupFrame: "plain",
		questionsPerRow: false,
		questionAlignment: false,
		inputWidth: false,
		secretKeypad: "masked",
		combinedSignature: false,
		questionBanner: true,
		labelTextSelection: "by-setting",
		keyboardAction: true,
		questionChannels: false,
		repeatAdd: "prompt",
		choiceMedia: true,
		labelInlineVideo: "played",
		labelQrCode: "drawn",
		labelSpeech: "button",
		locationQuestion: "record-location",
		barcodeQuestion: "scan-or-text",
		androidAppAnswers: true,
		numberKeypad: "keys",
		capture: "device",
		submitLabel: "finish",
		caseListDetailWording: false,
		automaticLocation: true,
		logo: false,
		caseListActionMedia: "shown",
		listFilter: Object.freeze({
			terms: "whitespace-runs",
			fuzzyOrder: "closest-first",
			emptyText: "runs-once-edited",
		}),
		requiredMark: "by-setting",
		sortMenu: Object.freeze({
			lists: "named-fields",
			firstPickOfOnlyRule: "reverses",
			ties: "earlier-order",
			filterText: "keeps",
			marks: "list-order-and-pick",
		}),
		caseListReturn: Object.freeze({ back: "new-list", search: "new-list" }),
		menuBadge: "shortened",
		gridMenuAudio: "hold",
		caseMap: "address-and-layers",
	}),
} as const satisfies Readonly<Record<Platform, PreviewPlatformRules>>;

/** The rules of one platform. */
export function previewPlatformRules(platform: Platform): PreviewPlatformRules {
	return PREVIEW_PLATFORM_RULES[platform];
}

/** The search screen's heading and description. Web Apps shows the
 *  authored title and description, and no heading for a search with no title
 *  (`title: null`); Android shows neither, and its heading is the search
 *  action's label (`searchScreenText`). */
export function searchScreenHeading(
	rules: Pick<PreviewPlatformRules, "searchScreenText">,
	authored: {
		readonly title: string | null;
		readonly subtitle: string | undefined;
	},
): { readonly title: string | null; readonly subtitle: string | undefined } {
	return rules.searchScreenText
		? authored
		: { title: CASE_SEARCH_BUTTON_LABEL, subtitle: undefined };
}

/** Whether Preview draws the mark on a required question.
 *
 *  Under `by-setting` the mark shows exactly where the reached project space
 *  holds `cc-label-required-questions-with-asterisk` as `yes`. With no facts
 *  (`null`) it answers by Nova's own value, `no`
 *  (`lib/commcare/appProfileSettings.ts`), which is also the phone's default
 *  (`HiddenPreferences.java::shouldLabelRequiredQuestionsWithAsterisk`). */
export function requiredMarkShown(
	rule: PreviewPlatformRules["requiredMark"],
	/** The reached project space's setting, or null where Preview holds no facts. */
	settingOn: boolean | null,
): boolean {
	return rule === "always" || settingOn === true;
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
