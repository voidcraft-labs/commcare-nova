# The proof harness's findings

What the proof lane (plan step 1) found that the research did not: the defects
in Nova its checks show, numbered on from the research's thirty, the research
claims they proved wrong, and the differences only another runtime reads, which
no test the lane runs can prove equivalent. Every difference the lane reports is
held by a register entry (`proof/known-defects.json`), whose `defect` is the
research's number or one of these; an entry holding a difference every reader
reads alike says so, and why, in its `equivalence`.

The sources are the lane's whole-corpus runs (316 documents, two
configurations each) after the register round's phase A, sorted at source by
four classifiers and four checkers, and the run of the targeted documents
(`proof/targeted/`), each built to show one symptom with fixed values. Every
fact was read in, or executed against, the pins the research uses:
commcare-hq `f57e85e02913`, formplayer `24383ac71bfb`, commcare-core
`8e9ba8d908e9`, commcare-android `fd79cac4a0f1`, Vellum `01215f251c57`,
commcare-connect `4a200c9d9`. Citations use `file::symbol`; documents are the
corpus ids that show the symptom.

---

## New defects

### Building and installing

31. **A form of empty groups is admitted, and HQ will not build it.**
    `lib/commcare/validator/rules/form.ts::emptyForm` counts any root field
    other than a section as content, so a form whose only fields are groups or
    repeats with no question inside them passes Nova's gate. HQ's build refuses
    it as a blank form: `helpers/validators.py::FormBaseValidator.validate_for_build`
    asks for one question that is not a group
    (`any(not q.get('is_group') for q in questions)`). The research's inventory
    names the refusal (`inventory/forms-and-case-writes.md`, "blank source, or
    no non-group question") but no defect holds Nova's side of it.
    *Harm:* HQ can never build or release the app. Nova publishes it; the
    project space then shows a build error. *Documents:*
    `expander-empty-container-expansion-emits-an-empty-group-86a5cfc1-0`.

32. **Searches from a local `.ccz` fail as soon as they find a case.** Every
    runtime URL in Nova's local archive that names the app carries the literal
    placeholder `__APP_ID__`: `lib/commcare/runtimeTarget.ts::runtimeUrls`
    falls back to it when the target holds no app id, and the download target
    holds none (`lib/deployment/runtimeTarget.ts::downloadRuntimeTarget`
    returns the attachment target, a server and a domain). HQ routes
    `phone/search/<app_id>/` to `ota/views.py::app_aware_search`; for any
    non-empty result `case_search/utils.py::get_unconfigured_endpoint_results`
    looks up related cases (`get_and_tag_related_cases`), and unless the search
    includes all related cases it reads the app's search details through
    `get_app_context_by_case_type`, where
    `app_manager/dbaccessors.py::get_app_cached(domain, '__APP_ID__')` raises
    `Http404`. The after-submit `phone/case_fixture/__APP_ID__/` URL carries
    the same placeholder, which `ota/views.py::case_fixture` reads only for a
    data registry, so it does no harm. *Harm:* on a device that installed the
    local archive, every case search that matches a case fails. *Documents:*
    `case-list-inline`, `endpoint-inline`, `search-registration-link` and the
    other documents whose trace sends a search (23 in all).

33. **Case names and external ids are trimmed on one export path only.**
    Nova's local archive binds `case_name`, `external_id` and a renamed case's
    name through a trim and a guard (nonblank, at most 255 characters,
    `lib/commcare/xform/caseBlocks.ts::addCaseBlocks`, `caseOps.ts`); HQ's
    build of the same writes, which Nova sends as basic form actions, binds the
    raw answer (`xform.py::XFormCaseBlock.add_create_block`, `add_case_updates`).
    HQ's case processing stores what it receives
    (`casexml/apps/case/xml/parser.py`), while Core trims on the device
    (`commcare-core xml/CaseXmlParser.java::createCase`, `nextText().trim()`).
    *Harm:* HQ stores `"  proof  "` from HQ's build and `"proof"` from the
    local archive, so exports, reports and case search see different names by
    the path a worker installed, and a name over 255 characters reaches a
    device from HQ's build, where Core's case processing refuses the form
    (`xml/CaseXmlParserUtil.java::checkForMaxLength`). *Documents:* 105,
    among them `case-capture-registration`, `case-capture-followup`,
    `navigation-base`.

34. **A Connect app's local `.ccz` captures no location.** Nova turns on
    `auto_gps_capture` for a Connect app only in the HQ upload
    (`lib/commcare/expander.ts`, `lib/commcare/hqShells.ts`), so HQ's build
    adds `cc:location` to the form's meta (`xform.py::XForm._add_meta_2`), and
    Nova's local archive adds none (`lib/commcare/xform/metaBlock.ts` names the
    gap). *Harm:* a delivery submitted from the local archive carries no
    location to Connect's checks
    (`commcare_connect/form_receiver/processor.py::clean_form_submission`).
    In an opportunity with GPS verification on, Connect flags every such
    delivery "GPS data is missing"; that verification is off unless the
    opportunity turns it on (`opportunity/models.py::OpportunityVerificationFlags.gps`,
    `default=False`). In every opportunity that checks distances, such a
    delivery escapes the check that flags a visit within the set distance of
    another, both as the visit checked and as the other visit. *Documents:* `connect-deliver-default`, `connect-learn-custom` and the
    other Connect documents, `targeted-invalid-connect-ids`.
    *Run in Connect* (`proof/connect/test_receiver.py`, Connect's receiver at
    the lane's pin over HQ's own payloads): with GPS verification on, the
    local archive's delivery is flagged "GPS data is missing" and left
    pending where it would have been approved, and so is HQ's build's while
    the device has no fix; with a fix, only HQ's build carries it. With the
    distance check at 100 m, HQ's build's second visit four metres from the
    first is flagged and the local archive's is not, on either side of the
    comparison. All of that holds only for a submission HQ receives under the
    app's id. Nova's local archive names no submission URL (its profile holds
    no `PostURL`, where HQ's build's names the receiver under the app's id),
    and a submission received with no app named is forwarded with a null app
    id, which Connect's receiver refuses (400, `app_id`: "This field may not
    be null.") and keeps nothing of. So from the local archive as Nova writes
    it, no learn module, delivery or task reaches Connect at all. Which URL a
    device posts to for a profile that names none is CommCare Android's to
    say (`sync/FormSubmissionHelper.java`, `R.string.PostURL`), and is not
    run here.

### Case lists
    *In the lane* (`connect@local.ccz`, proof 3, on every Connect document
    with a deliver unit): HQ's own receiver and Connect repeater forward
    Core's delivery from HQ's build, with a device's fix written into its
    location node, and the local archive's posted under the app's id, to one
    opportunity that verifies GPS. Connect holds the build's visit with its
    location and flags the local archive's "GPS data is missing"
    (`/runs/*/state/visits/*/location`, `/runs/*/state/visits/*/flags/gps`).
    Formplayer's own delivery on HQ's build carries no location either (no
    browser gave it one) and is flagged the same.

35. **A hidden select column holds different text on each path.** HQ's build
    writes a hidden column as `invisible` over the raw property
    (`lib/commcare/hqJson/caseList.ts::projectColumnForShortDetail`), while the
    local archive keeps its label expression
    (`lib/commcare/suite/case-list/columns.ts`). A list's search matches every
    field, hidden ones included (`commcare-core util/EntitySortUtil.java::sortEntities`).
    *Harm:* a search for an option's label finds the case on the local install
    and not on HQ's build, and one for its value the other way round.
    *Documents:* `expander-expanddoc-hq-json-projection-sort-elements-keeps-67fa0ac7-0`.

36. **A hidden sort column is offered for sorting on the local install.** HQ
    writes no header for a sort-only column
    (`detail_screen.py::Invisible.header`); Nova's local suite keeps the
    authored header text at width 0
    (`lib/commcare/suite/case-list/columns.ts::buildHeaderBlock`). Android's
    Sort menu lists every field whose header is not empty
    (`commcare-android activities/EntitySelectActivity.java::getSortOptionsList`).
    *Harm:* on Android the local install offers to sort by a column no one
    sees. *Documents:* `tile`, `case-list-browse` and 21 others.

37. **New cases reach a device's storage in opposite orders.** At the form
    root, Nova's local form writes its own case block before its subcase
    blocks (`lib/commcare/xform/caseBlocks.ts::addCaseBlocks`); HQ's build
    appends it after them (`xform.py::XForm._create_casexml`). Core applies
    blocks in document order (`core/process/XmlFormRecordProcessor.process`).
    *Harm:* where a form creates both its own case and a child case of the
    listed type, an unsorted list, or a sort tie, shows them in a different
    order on the two installs; HQ's stored cases are the same. *Documents:*
    `case-extension-registration`, `nested-menu-registration-children`.

38. **An image-map column is sized only on HQ's build.** HQ writes a header
    and template width of 13% for it (`detail_screen.py::EnumImage.template_width`);
    Nova's local suite writes none
    (`lib/commcare/suite/case-list/columns.ts`). *Harm:* cosmetic; Android
    lays the column out from the hint (`views/EntityView.java`). *Documents:*
    `media-rich` and 12 others.

### Profile and settings

39. **The local profile names no current language.** HQ's profile writes
    `cur_locale` as the app's first build language
    (`templates/app_manager/profile.xml`, `force="false"`); Nova's local
    profile writes none (`lib/commcare/compiler.ts::generateProfile`), so
    Android starts it in the `default` locale (`CommCareApp.java`).
    *Harm:* every text a worker reads is the same (the default locale file
    holds the default language). Run on Android (`proof/android`),
    `Localization.getCurrentLocale` is `default` on the local install and the
    first language's code on HQ's build, and the language picker
    (`ChangeLocaleUtil.getLocaleNames`) offers the same languages on both and
    marks none as current on either. *Documents:* every document (the
    trace's `/locale`).

40. **The app settings page writes HQ's defaults into a profile Nova leaves
    empty, and HQ's build then forces them.** A save of HQ's settings page
    that changes nothing stores every setting's page value
    (`settings/bootstrap5/commcare_settings.js::valueToSave`,
    `views/settings.py::edit_commcare_profile`), and
    `models/applications.py::Application.create_profile` writes each with the
    settings file's `force`. Three change what devices read:
    `cc-fuzzy-search-enabled` becomes `yes` where absence reads `no` on
    Android and Web Apps (`MainConfigurablePreferences.isFuzzySearchEnabled`,
    `FormplayerPropertyManager.isFuzzySearchEnabled`);
    `cc-gps-auto-capture-accuracy` becomes `5` where absence reads 10 metres
    (`HiddenPreferences.getGpsAutoCaptureAccuracy`, `GeoUtils.AUTO_CAPTURE_GOOD_ACCURACY`);
    and `cc-content-valid` becomes `yes`, so Android skips its own media
    check (`CommCareApp.areMMResourcesValidated`). Two more,
    `cc-autoup-freq` and `cc-enable-tts`, keep the values devices read when
    they are absent, but are now forced at every update over a worker's own
    choice (Core's `ProfileInstaller` calls `Profile.initializeProperties`
    with forcing on at every upgrade). Ten more are written at exactly the
    value their readers take when they are absent and none is a worker's
    preference, so devices read them alike (`cc-autosync-freq`,
    `cc-days-form-retain`, `cc-inflation-target-density`,
    `cc-label-required-questions-with-asterisk`, `cc-login-duration-seconds`,
    `cc-maps-default-layer`, `cc-resize-images`, `logenabled`,
    `unsent-number-limit`, `unsent-time-limit`: Android's
    `HiddenPreferences.getLoginDuration`, `getResizeMethod`,
    `isSmartInflationEnabled`, `shouldLabelRequiredQuestionsWithAsterisk`,
    `getLogsEnabled` and `getMapsDefaultLayer`,
    `PendingCalcs.getPendingSyncStatus`,
    `PurgeStaleArchivedFormsTask.getArchivedFormsValidityInDays`,
    `SyncDetailCalculations.unsentFormNumberLimitExceeded` and
    `unsentFormTimeLimitExceeded`; Formplayer's
    `RestoreFactory.getSyncFreqency`); only Android and Formplayer read
    them, so no spelling rule can prove it, and they are held with this
    finding, which removes them too, each entry marked as an equivalence. The research plans the fix (the
    inventory's application settings rows: every setting written explicitly)
    but catalogs no defect.
    *Harm:* the first harmless settings save turns case list search fuzzy,
    halves the accuracy GPS auto-capture waits for (it polls until a fix
    within 5 metres where it stopped at 10,
    `PollSensorController.onLocationResult`), skips media checks and
    overrides workers' preferences. Run on Android (`proof/android`), each of the three readers
    gives the changed value on the saved app's build, each of the ten gives
    the same value on both, and a device whose worker turned text to speech
    on and chose daily updates reads both back at the profile's values once
    it updates to the saved app. *Documents:* every document.

41. **The empty-list text goes blank in an app without English.** Nova writes
    no `no_items_text`, so HQ's model default holds `en` alone
    (`models/case_list.py::Detail.no_items_text`). Under
    `USH_EMPTY_CASE_LIST_TEXT` the module settings page shows the page
    language's text only (`xforms_extras.py::input_trans`), and its save
    writes `no_items_text[lang] = ''` for a language with none
    (`views/modules.py::edit_module_attr`). *Harm:* in an app with no `en`,
    the default app strings' `m<i>_no_items_text` becomes blank
    (`app_strings.py::create_default_app_strings`), and Web Apps shows no
    message on an empty case list. In an app with `en`, a language whose
    file loses the key reads the default file's text, which still holds the
    message (Core's `Localizer.getLocaleData`), so the lane compares each
    language as Core reads it and shows the blank only where every language
    reads it. *Documents:* `endpoint-case-list`, `search-browse`,
    `expander-markdown-itext-for-all-field-kinds-emits-b4c21f40-0`,
    `expander-nested-container-expansion-preserves-both-ad2488f6-0`; the save
    writes the empty text on `localization-optional` and the other
    multilingual documents as well.

### HQ's editors

42. **The Case List save aligns every custom-tile cell Nova leaves
    unaligned.** Nova writes a cell's horizontal alignment only where the
    author set one (`lib/commcare/hqJson/caseList.ts`); HQ's Case List page
    defaults it to `left` (`details/bootstrap5/column.js`), and the saved
    app's build carries `horz-align="left"` into the cell's style
    (`suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail`).
    An absent alignment reads as none (`commcare-core util/GridStyle.getHorzAlign`).
    *Harm:* on Android an image cell moves from the centre of its cell to its
    start (`views/EntityViewTile.setScaleType`: `FIT_START` for `left`, the
    image view's default `FIT_CENTER` otherwise); text cells change only in
    right-to-left languages (`EntityViewTile.computeGravity`, Web Apps'
    `getValidFieldAlignment`). The same save writes a vertical alignment of
    `start` into every cell (`vertical_align`, `@vert-align`), which Android
    reads as none (`computeGravity` has no case for it) and Web Apps reads
    absence as; only those two runtimes read it, so no spelling rule can
    prove it, and it is held with this finding, marked as an equivalence
    (correction 4). The research's
    tile bullet (defect 14) names font size and placement only, and its fix
    leaves this. *Documents:* `fuzz-suite-20260930-3`, `-5`, `-7`,
    `targeted-custom-tile`.

43. **A question named `instance` or `bind` stops HQ's form builder from
    opening its form.** Nova admits both names
    (`lib/commcare/constants.ts::XML_ELEMENT_NAME_REGEX`), as does Vellum's own
    id rule. Vellum's parser looks instances and binds up by bare element name
    in the whole form: `src/parser.js::_getInstances` (`xml.find("instance")`)
    throws "multiple unnamed instance elements found in the form!" on a data
    node named `instance`, and `parseXForm` (`head.find('bind')`) hands a data
    node named `bind` to `parseBindElement`, which fails with a `TypeError`.
    A node named `itext` opens. *Harm:* the form cannot be edited in
    HQ at all; HQ builds it and Core runs it unchanged. *Documents:* 20 fuzz
    documents, `targeted-reserved-node-names`.

44. **Duplicate option values are admitted, and HQ's form builder marks them
    an error.** Nova admits two options of one select with the same value, on
    purpose (`lib/commcare/__tests__/expander.test.ts`, issue 10); Vellum
    reports "This choice value has been used in the same question"
    (`src/mugs/types/select.js`), and every save then warns "Form has
    validation errors" (`src/core.js::validateForSave`). *Harm:* the form
    shows an error in HQ's form builder, and the two options submit the same
    value, so no export can tell which was chosen. *Documents:*
    `expander-select-option-itext-ids-index-keyed-issue-10-608c801a-0`,
    `-bf790763-0`.

45. **A Vellum save turns reads of a case's id, owner or status into blanks.**
    Nova writes a read of an attribute-backed case property with the shadow
    `#case/<property>` beside the real `…/@status`
    (`lib/commcare/hashtags/formContext.ts::vellumShorthandInContext`). Vellum
    reads the form's own `<vellum:hashtags>` only while HQ's data sources are
    not ready (`src/parser.js::parseXForm`), so on HQ's page every `#case/`
    shadow resolves to a child element of the case
    (`src/xpath.js::hashtagToXPath`, `src/datasources.js`), which the case
    database does not have. *Harm:* after one save the form submits blank
    values for every such read, and every expression over them reads blank.
    This contradicts the research's list of emissions saves keep (correction
    1 below). *Documents:* `standard-case-reads`.

46. **A Vellum save renames the form in HQ's editing language.** `<h:title>`
    carries Nova's form name (`lib/commcare/xform/builder.ts`); Vellum writes
    the name HQ gives it in the editing language
    (`views/formdesigner.py::_get_vellum_core_context`, `formName`;
    `src/writer.js`). *Harm:* where the app's first language is not the one
    Nova's name is in, the saved form's title changes language ("Register"
    becomes "Registrar"), which Android shows as the form's header fallback
    and a saved form's default name (`FormEntryActivity.getHeaderString`,
    `FormEntryInstanceState.getDefaultFormTitle`). Run on Android
    (`proof/android`), a form opened from home keeps its header either way
    (home hands form entry the menu's text, and the title is read only where
    it hands none), and the record of a completed save is named "Register"
    before the save in HQ and "Registrar" after. Defect 14's fix for the
    data node's name assumes the title is right. *Documents:*
    `localization-bilingual`, `localization-escaped`, `localization-stale`.

47. **HQ's form builder warns about reads of case properties no form writes.**
    A `#case/<property>` shadow for a property HQ's case schema does not list
    (`app_schemas/casedb_schema.py`, the properties some form writes) is an
    unknown question to Vellum (`src/logic.js::_addReferences`), and every
    save asks "Form has reference errors." (`src/core.js::validateForSave`).
    *Harm:* editor noise on every save; the build is unchanged. *Documents:*
    `expander-form-hashtag-expansion-emits-the-editor-1daa5537-0`.

### Search and publish

48. **Nova's refusal of a mixed-quote search answer is a CSQL function HQ does
    not have.** When a free-text search answer holds both quote marks, Nova's
    CSQL sends `search-value-mixes-quote-marks()`
    (`lib/commcare/predicate/termEmitter.ts::CSQL_UNREPRESENTABLE_RUNTIME_STRING`),
    a fail-closed value by design. Web Apps blocks the answer first
    (`MenuSessionRunnerService.doQuery`); Android reads no prompt errors and
    sends it, and HQ answers "'search-value-mixes-quote-marks' is not a valid
    standalone function" (`case_search/filter_dsl.py::build_filter_from_ast`).
    HQ's reader refuses the name as an unknown function (the inventory's case
    search rows). *Harm:* on Android the worker sees no message about the
    answer. Run on Android (`proof/android`), the search screen holds no error
    for the prompt, sends `_xpath_query=search-value-mixes-quote-marks()`,
    and for a refusal shows its own "Client-side error (code 400) received
    from network request." (`QueryRequestActivity.processClientError`, which
    never reads the server's message), so the worker reads neither a message
    about the answer nor HQ's. *Documents:* 40, the quote family among them.

49. **Under `CAUTIOUS_MULTIMEDIA`, every first publish with media warns that
    media is missing.** Nova imports the app before it uploads its media
    (`lib/deployment/service.ts::publishAppToHq`, `importApp` then
    `uploadMediaBytes`), with Nova's content hashes as media ids
    (`lib/commcare/multimedia/bundle.ts::buildMultimediaMap`). HQ's import
    looks the ids up (`hqmedia/models.py::ApplicationMediaMixin.get_media_objects`),
    re-raises the missing one under that flag, and answers "Copying the
    application succeeded, but the application is missing multimedia
    file(s)." (`models/applications.py::_import_app`,
    `views/app_import_api.py`), which Nova passes on. *Harm:* a false warning
    on publish; the upload that follows maps every file. *Documents:* the 36
    whose first publish carries media.

### HQ's editors, continued

50. **A follow-up form that opens one child case draws HQ's registration
    alert.** HQ counts a form with one child case outside a repeat a
    registration form (`models/forms.py::Form.is_registration_form`) and maps
    a case name only from the form's own case
    (`form_action_diff.py::get_case_mappings`), so Vellum's save alerts "This
    registration form is missing a case name." (`src/caseManagement.js`,
    pre-save validation). HQ shows the same alert for a form of that shape its
    own editors make. *Harm:* an alert on every save; the save goes through.
    *Documents:* `nested-menu-previous`.

### Found in the register round

51. **The two installs keep a list's sort keys on different columns, so a
    fuzzy search matches different fields.** HQ's build gives an unsorted
    list a sort on its first column
    (`suite_xml/sections/details.py::get_default_sort_elements`) and attaches
    a sort to the first column with its field
    (`app_manager/util.py::get_sort_and_sort_only_columns`); Nova's local
    archive writes no sort for an unsorted list and keeps a sort on the
    column it was authored on (`lib/commcare/suite/case-list/sortKeys.ts`).
    Core orders the rows alike either way (an entity with no sort key sorts
    by the text its field shows, `cases/entity/EntitySorter.getCmp`, and an
    unsorted list by its first column with a header,
    `SortableEntityAdapter.determineFieldsForSortingInOrder`), but a fuzzy
    list search matches a field's text against its sort key alone
    (`util/EntitySortUtil.sortEntities`, `Entity.getSortFieldPieces`, which
    gives none where a field has no key). *Harm:* with fuzzy search on (a
    worker's preference on Android, `MainConfigurablePreferences.isFuzzySearchEnabled`,
    and the setting defect 40 turns on), a misspelled search finds a case by
    its first column on HQ's install and not on the local one, and by a
    hidden sort column the other way round. This narrows defect 10's
    unsorted variant, whose order differs only where correction 10 says.
    *Documents:* every document with an unsorted list (`case-operation-query`
    and 162 others); `targeted-shared-property-sort`.

52. **A validation message that shows an answer reaches the worker
    unfilled.** Nova writes a field's validation message on its bind alone
    (`jr:constraintMsg="jr:itext('…')"`, `lib/commcare/xform/builder.ts`).
    Core reads that message as an expression and fills none of its
    `<output>`s (`FormEntryPrompt.getConstraintText` falls back to
    `Constraint.getConstraintMessage`), while a message read from the
    control's `<alert>`, which Vellum's save adds
    (`src/writer.js::createAlert`), is localized with each output filled
    (`localizeText`, `FormDef.fillTemplateString`); the spelling rule for
    the alert (`proof/rules/vellum_alert.py`) leaves such a message.
    *Harm:* where the message names an answer, the worker reads `${0}` in
    its place on Nova's export, and the value after a save in HQ.
    *Documents:* `expander-form-hashtag-expansion-declares-the-casedb-02e7ce76-0`.
    *Fixed (#712):* Nova now writes the control's `<alert>` beside the bind
    for a plain message, and composes a message that shows an answer as the
    constraint expression itself (`lib/commcare/xform/constraintMessage.ts`),
    so the worker reads the value on Nova's export too. The register holds no
    entry for this finding.

53. **HQ reports an exception for every search Nova's zero-input sentinel
    sends.** Nova's HQ JSON gives a search with no inputs a default filter
    `_xpath_query` of `match-all()`
    (`lib/commcare/hqJson/caseList.ts::ZERO_INPUT_SEARCH_SENTINEL`), which
    Nova's local archive does not send. HQ returns the same cases (the filter
    matches every case), but it calls `_require_case_search_advanced` for any
    `_xpath_query` (`case_search/utils.py::CaseSearchQueryBuilder._apply_filter`),
    which, without `CASE_SEARCH_ADVANCED`, reports "Advanced case search
    feature attempted" (`notify_exception`). *Harm:* an error report on HQ's
    side for every such search from an install of HQ's build; the worker
    sees the same results. *Documents:* `search-automatic`.

### Found by running the other readers

Findings 58 to 64 were found by running the readers the lane had only cited:
Formplayer's application, Connect's receiver, HQ's Web Apps client and
commcare-android. Numbers 56 and 57 belong to two findings made while step 2
was planned, which its first pull request records.

### Found by running Formplayer

The lane ran Core alone until the Formplayer runner (`proof/formplayer`,
Formplayer `24383ac71bfb` with the Core it vendors, `8e9ba8d908e9`). What
Formplayer's own application does over HQ's builds of Nova's exports:

58. **Formplayer stops where a form link's target is hidden; Core's session
    goes on.** HQ builds a form link as a stack frame naming the target's
    commands (`suite_xml/post_process/workflow.py`). After a submission
    Core's session holds that frame as it stands: for a hidden form it needs
    nothing more and its entry opens the form
    (`CommCareSession.getNeededData`), and for a hidden menu it asks for a
    command inside it. Formplayer rebuilds the session by walking the frame
    through the screens it would show
    (`services/MenuSessionFactory.java::rebuildSessionFromFrame`, which
    matches a step only against `MenuScreen.getMenuDisplayables`), so it
    answers with the menu that holds the hidden form, listing its shown
    forms alone, and with the app's first screen for a hidden menu. Nova
    admits such a link: it refuses only a display condition no worker could
    meet (`DISPLAY_CONDITION_ALWAYS_FALSE`), and a link's target may be
    hidden for the worker who submits. *Harm:* none found in Web Apps, where
    the worker lands on a screen they may use; a runtime that reads the
    frame as Core's session does opens a form its menu hides, which is
    Android's to observe. The two runtimes differ, so proof 3's Core
    sessions do not stand for Web Apps here. *Documents:*
    `targeted-form-link-hidden-target`.

59. **Nova's local archive names no server, so nothing submitted from it
    names its app.** The local `.ccz` profile holds no `PostURL`
    (`lib/commcare/compiler.ts::generateProfile`); HQ's build's names HQ's
    receiver under the app's id. Formplayer reads a form's submission URL
    from that property (`session/MenuSession.java`,
    `FormSession.getPostUrl`), so on the local archive its menus, lists and
    form entry run and its submit answers `status: error` (a null URL) and
    sends nothing (`proof/formplayer/test_local_archive.py`). A submission
    of the local archive received with no app named gets a null app id from
    HQ's own receiver functions (`get_app_and_build_ids`), HQ's Connect
    repeater still forwards it, and Connect answers 400 (`{"app_id": ["This
    field may not be null."]}`) and writes nothing, for a learn form and a
    delivery alike (`proof/connect/test_receiver.py`). Where a device posts
    for a profile with no `PostURL` is commcare-android's
    (`sync/FormSubmissionHelper.java`, its default `R.string.PostURL`), read
    and not run. *Harm:* none in Web Apps, which installs only what HQ
    builds. For a Connect app installed from the local archive, no
    submission reaches Connect as that app's, so finding 34's harm is met
    only by a submission that does name the app. The lane now walks the
    local archive on Formplayer over HQ's own state on every document
    (`formplayer@local.ccz`, proof 3), where each form's submission shows as
    refused. For a Connect document the lane also posts each of Core's
    submissions of the local archive to HQ's own receiver view with no app
    named, the most a submission of it can name: HQ's receiver takes the
    form, its Connect repeater forwards it with a null app id, Connect
    answers 400, and HQ marks the forward rejected and does not send it
    again (`connect@local.ccz`, `/runs/*/posts/*/answer`). HQ's build's
    profile sends a device to the receiver under the build's own id, from
    which HQ reads the app and the build. commcare-android's own default
    for a profile with no `PostURL` is a fixed address of its own
    (`app/res/values/strings.xml`, `PostURL`), which names no project space
    of the app's; cited, not run. *Documents:* any local archive.

What the same runs show of earlier findings, each on Formplayer itself
(`proof/formplayer/test_*.py`): finding 40's `cc-autosync-freq` reads alike
absent and `freq-never` (no restore asked after eight days, where
`freq-daily` asks for one) and its `cc-fuzzy-search-enabled` changes a
list's search as stated; finding 42's vertical alignment reaches the client
(`EntityListResponse.styles[].verticalAlign` is null for Nova's export and
`start` for the saved app), so that equivalence rests on Web Apps' client
alone; finding 48's mixed-quote answer never reaches HQ (Formplayer answers
the search screen again with the validation's message); and finding 54's
description is `""` for Nova's export and a non-breaking space for the saved
app in what Formplayer hands Web Apps (`QueryResponseBean.description`).

### Found by running Connect's receiver

The Connect proof (`proof/connect`) runs Connect's own sync and form receiver,
at the Connect pin, over the payload HQ's own repeater sends of a submission
Core made on HQ's build or Nova's local archive of a Nova export. Every
Connect document's unit now runs the same chain on every state it serves
(`proof/README.md`, "Connect in the unit"): HQ's own receiver view takes
each of Core's and Formplayer's submissions whole, HQ's own Connect repeater
posts it over a real connection to Connect's own server, and what Connect
then holds is judged (`connect@…` in proofs 3 and 4). Two things that chain
shows of HQ and Connect themselves, neither Nova's: HQ forwards every form
of a project space that has a Connect repeater, so a form with no Connect
block reaches Connect too and is answered 400 (it holds nothing of
Connect's); and HQ retries a forward Connect failed (a 500) and gives up
on one Connect refused (a 400, "payload rejected"), so a delivery Connect
refuses is not sent again when the cause is put right.

60. **A Connect block named like one of Connect's own keys fails Connect's
    receiver.** Nova names a Connect block's wrapper node by the block's id
    (`lib/commcare/connectSlugs.ts`), and admits any element name as an id
    (`lib/domain/forms.ts::connectIdSchema`). HQ's Connect repeater forwards
    each block at its path (`repeater_generators.py::
    ConnectFormRepeaterPayloadGenerator`), and Connect's receiver looks for
    `module` and `assessment` in a learn form, and `deliver`, `task` and
    `work_area_update` in a deliver form, at every depth, reading each
    match's `@xmlns` (`commcare-connect form_receiver/processor.py::
    _get_matching_blocks`). A block whose id is one of those names is
    wrapped in a node of that name with no namespace, so the receiver raises
    `KeyError('@xmlns')`, answers 500 and rolls the whole submission back.
    *Harm:* Connect keeps nothing of any submission of that form (a
    delivery's visit and pay included), from HQ's build and the local
    archive alike, and HQ's repeater retries a record that can never
    succeed. Run in Connect for each of the five names
    (`proof/connect/test_receiver.py`), with the accepted case: the same
    forms with blocks named otherwise. HQ's own form designer names the
    wrapper by the question's id as well, so an app made there with such an
    id fails alike. In the lane (`connect@A`,
    `/runs/*/refused/500/KeyError`) each such form's submission, Core's and
    Formplayer's, fails in Connect and HQ's repeat record is left failed.
    *Fix:* the validator refuses the five names as a Connect
    id, each in the app type whose receiver reads it.
    *Documents:* `connect-deliver-default`, `connect-deliver-custom` (the
    task of both is `task`), `targeted-connect-learn-key-names`,
    `targeted-connect-deliver-key-names`.

61. **A deliver form that also holds a task loses its own visit while the
    task is assigned.** Nova lets one form hold a deliver unit and a task
    (`lib/domain/forms.ts`). Connect's receiver reads the deliver unit
    first and rejects the visit while the worker has an assigned task of
    the app ("Worker has an incomplete assigned task.",
    `processor.py::process_deliver_unit`, `_has_blocking_pending_task`),
    and only then completes the task from the same submission
    (`process_deliver_form`). *Harm:* the delivery made in the submission
    that completes a task is always rejected and unpaid; the next one is
    approved. Run in Connect (`proof/connect/test_receiver.py`), and in the
    lane on every document with such a form (`connect@A`,
    `/runs/*/visit-rejected-for-the-task-its-form-completes`: the rows hold
    a visit rejected for the pending task and that task completed by the
    same form).
    *Documents:* `targeted-connect-deliver-rename`; `connect-deliver-default`
    and `connect-deliver-custom` hold such a form too, whose submission
    Connect fails before it reads either (finding 60).

What the same chain shows of defect 15 (Connect ids Vellum rejects, whose
fix renames them): Connect keys an opportunity's rows by each block's id, so a
rename under an opportunity that holds the old id breaks it. On the two
documents whose edit renames their Connect ids (`targeted-connect-deliver-rename`,
`targeted-connect-learn-rename`), with the opportunity made from A's release
and B-edit's submissions forwarded to it (`connect@B-edit@…`, proof 4):
Connect refuses every delivery of the renamed deliver unit (400, "Payment unit
is not configured for the deliver unit", `/runs/*/refused/400/…`), and HQ
does not send a refused forward again; the receiver makes a second learn
module of the renamed one (`/runs/*/catalog/learnModules/added`), so a
learner who finishes the course stands at half; and the renamed task
completes no task the worker was assigned. Each is reported with the ids that
moved (`/ids/deliver/moved`, `/ids/task/moved`, `/ids/module/moved`).
`proof/connect/test_receiver.py` runs what a manager can do after it (asking
for the units again and paying for the new one restores deliveries; nothing
restores the learner or the assigned task).

### Found by running the Web Apps client

The Web Apps driver (`proof/webapps`) runs HQ's own client, at the HQ pin, in
the lane's Chromium against Formplayer over a build HQ released of a Nova
export, for a mobile worker, with HQ's own compiled stylesheets. What it shows
that no build comparison and no session of Core's or Formplayer's could:

62. **The App Settings save takes Incomplete Forms off Web Apps' home
    screen.** The client reads `cc-show-incomplete` from the app HQ stores,
    never from the build (`cloudcare/utils.py::format_app_doc` hands it the
    stored `profile`; `formplayer/apps/controller.js::listApps` hides the
    tile only when every listed app's property is `no`). Nova stores no such
    property, so the tile shows. HQ's App Settings page, saved without a
    change, stores every setting at its page value (finding 40), and its
    value for this one is `no`. HQ's build writes the property either way
    (defect 7), so no file of the build differs, and the lane held the
    stored property only inside finding 40's stored-profile entry, with no
    reader of its own. *Harm:* after a save that changes nothing, a worker
    in Web Apps no longer has the Incomplete Forms screen.
    *Documents:* every document; observed on `targeted-survey-menu`.

What the same runs show of earlier findings, each on the client
(`proof/webapps/test_*.py`):

- **Finding 42 and defect 14's tile part.** For a cell with no alignment the
  client writes `start` both ways; after the Case List save it writes `left`
  and `start`. So the vertical alignment is the same either way, as the
  register's equivalence says, and the horizontal one differs only where
  `left` and `start` do. The font size the same save writes, `medium`, is not
  what an absent one reads as: HQ's stylesheet gives a tile's cell 12px, and
  `medium` is the browser's 16px, so the save makes a tile's text a third
  larger. With no stylesheet on the page both computed to 16px, which is why
  the page loads HQ's own.
- **Finding 54.** The client shows no description element for `""` or for
  the non-breaking space, on a search opened from a list, on one the menu
  opens and on an inline one, and shows a description that has text. The
  equivalence holds on its one reader.
- **Defect 21.** The Case List save's `auto_launch` reaches a worker as the
  register says: the menu that opens the case list for Nova's export opens
  the search screen for the saved app.
- **Finding 41.** In an app written in Spanish alone the worker reads HQ's
  English default, "List is empty.", on an empty list; after the module
  settings save under `USH_EMPTY_CASE_LIST_TEXT` the client shows a message
  box that holds only a non-breaking space. The client does not fall back to
  its own text for a blank one.
- **Defect 16.** A list search in Web Apps for the value of a column Nova
  left out finds no case, and a search for a shown value finds the case.
- **Finding 58.** End to end, with the form opened and submitted by clicks:
  a link to a shown form opens it, a link to a hidden form leaves the worker
  on the menu that holds it, listing its shown form alone, and a link to a
  hidden menu leaves them on the app's first screen; HQ receives one
  submission each time and the client shows HQ's message for it.
- **The logo.** The path Nova sends as `logo_refs.hq_logo_web_apps` is the
  image on the app's tile, resolved by the client through the app's media
  map to HQ's own multimedia URL, where HQ serves the bytes Nova uploaded.
- **A sort-only column.** Formplayer hands the client the column with an
  empty header and a width hint of 0, and the client shows no header and no
  cell for it. The plan's sentence for finding 38, that nothing but Android
  reads a column's width hint, does not hold for a hint of 0.

### Found by running commcare-android

The Android reader (`proof/android`) runs commcare-android's own application,
installers, activities and views, at the Android pin beside the Core pin,
under Robolectric, over the archives a lane run recorded: Nova's local
exports and HQ's builds of A, B, B-edit and every editor save. It runs
outside the lane's image (`proof/android/README.md`).

63. **HQ's build installs on Android only with its media.** The lane hands
    Core HQ's build as HQ's index download arranges it
    (`hqmedia/views.py::iter_index_files`: the suite, the profile, the app
    strings and the forms), and Core admits that. Android's install of the
    same archive fails (`AppInstallStatus.UnknownFailure`): its media
    installer goes to the network for each file the media suite names. HQ's
    download with multimedia (`iter_app_files`) installs, and so does Nova's
    local `.ccz`, which carries its media. *Harm:* none to a worker, who
    installs from HQ or from a file that holds the media. It bounds the
    lane: Core's admission of an index-only archive does not stand for a
    device's install, so each built state's record keeps the archive a
    device installs (`state.archive`,
    `proof/observe/build.py::device_archive`), which
    `proof/checks/test_device_archive.py` holds to HQ's own download.
    *Documents:* every document whose build names media.

The same runs corrected four earlier findings, each amended where it stands
above: finding 39 (the language picker is the same on both installs and marks
no current language on either), finding 40 (the GPS change tightens
auto-capture, from 10 metres to 5), finding 46 (the header a worker sees from
home does not change; a completed save's name does) and finding 48 (Android
shows its own "Client-side error (code 400)", never HQ's message). They also
showed that `targeted-shared-property-sort` gives no fuzzy-search difference
on Android, since both of its columns hold the same text, while
`case-operation-query` gives finding 51's; and that a local archive offers
that document's hidden sort column in the Sort menu, as finding 36 says of
others.

### Found by the Android stage

The lane now has CommCare Android's own code read every archive a device
installs of every document: Nova's local exports and HQ's builds of A, B,
B-edit and every editor save, each walked from the first menu through every
list, search, claim and form, installed twice, and updated with forms left
incomplete (`proof/README.md`, "The Android stage"). Proofs 1, 3 and 4 judge
what it read. What that showed that the reader's own tests had not:

67. **An incomplete form in a menu with grouped tiles cannot be reopened
    where its case has no parent.** A menu whose list groups its tiles gives
    every form that loads a case a second datum, the ids of the case's
    parents joined by spaces
    (`suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums`,
    `<datum id="case_id_parent_ids" function="join(' ', distinct-values(…/index/parent))"/>`),
    and Nova writes the same datum on both export paths
    (`lib/commcare/session.ts::deriveSessionDatums`). Android keeps an
    incomplete form's session as one line of words
    (`SessionDescriptorUtil.createSessionDescriptor`: each step's type, id
    and value, joined by spaces) and reads it back by splitting on the
    spaces (`loadSessionFromDescriptor`). For a case with no parent the
    datum's value is empty, so the line ends at the datum's id
    (`COMMAND_ID m0-f0 CASE_ID case_id visit-2 CASE_ID case_id_parent_ids`),
    and home raises `ArrayIndexOutOfBoundsException` reading it
    (`HomeScreenBaseActivity.onActivityResultSessionSafe`,
    `AndroidSessionWrapper.loadFromStateDescription`). *Harm:* a worker who
    leaves such a form incomplete cannot open it again; the app stops when
    they pick it from the incomplete forms. It is HQ's own shape and
    Android's own reader, the same on HQ's build and on Nova's local
    archive, so no export path avoids it; Nova could leave the datum out
    only by giving up what HQ's build reads it for. *Documents:*
    `tile-grouped-one`, `tile-grouped-two`, `tile-grouped-search`
    (`android@B` and `android@local.ccz`, proof 1,
    `/update/reopened/*/session`).

What the stage shows of earlier defects and findings, each as a worker's
device meets it, on the documents the register names:

- **Defect 1 (ids and xmlns).** After a republish, a form a worker left
  incomplete on the earlier build does not open: "No XForm definition
  defined for this form with namespace …" (`android@B`,
  `/update/reopened/*`). Every document with a form shows it.
- **Defect 9 (the local app's id).** The two local exports of one app
  install side by side as two apps where HQ's second build is refused as a
  duplicate (`/installs/*`), and a device on the first export finds no
  update in the second (`UpToDate`, `/update`).
- **Defect 7.** The Saved and Incomplete buttons are on the local install's
  home screen and hidden on HQ's.
- **Defects 14 and 15, where HQ's build does not parse.** Android refuses to
  install HQ's build of `targeted-close-condition-unparsable` ("Encountered a
  problem with display condition for node [/data/case/close]") and of
  `targeted-invalid-question-ids` ("Question bound to non-existent node:
  [/data/Meta]"), and installs Nova's local archive of each (`/install`).
- **Defect 13 (guard blocks).** After a Vellum save the device does not save
  the form: "Error Saving your Form: The case_id attribute of a <case>
  wasn't set", and the worker stays in the form
  (`/walks/*/screens/…:FormEntryActivity!Error Saving your Form`). Defect
  25's rewritten query repeat stops the form earlier: "Error Occurred:
  Attempting to select element 2 of a list with only 1 elements."
- **Defect 4 and finding 34 (location capture).** A form of HQ's build with
  `auto_gps_capture` asks the device for the location permission as it
  opens; B's form (defect 4) and the local archive's (finding 34) ask for
  nothing.
- **Defect 10.** A list with a label column or no sort shows its cases in
  another order on the local install, so the first case a worker sees is
  another one (`/list/order`, `/list/chose`), and a Sort choice orders them
  otherwise (`/list/sorted/*`, the path finding 51's sort keys change too).
- **Defect 12.** After the Case List save a custom tile's list is plain rows
  (`/list/rowClass`), and a single-date prompt is a text box whose answer
  is sent as typed.
- **Defect 14 (search settings and tiles).** The Case List save renames the
  list's search action ("Search" to "Search All Cases") and adds a cell to
  every tile.
- **Defect 20, findings 32, 36, 38, 39, 40, 42, 46, 48, 51 and 53** show as
  their entries say: the session a form-entry sync refuses, the local search
  address, the hidden sort column in the Sort menu, the image-map column's
  width, the current language, the profile the App Settings save leaves and
  the worker's own settings an update then replaces, a tile cell's
  alignment, the renamed form's saved name, the mixed-quote search a device
  sends and the "Client-side error (code 400)" it shows, what a misspelled
  search finds with fuzzy search on, and the `match-all()` filter only HQ's
  build sends.

Two things the first whole-corpus run showed of the reader itself, fixed
there and recorded so they are not taken for the app's: Gradle resolves
commcare-android's unit-test classpath to another Guava than the app ships,
and Core calls a method only the shipped one has, so every session that
pushed a search step raised `NoSuchMethodError` on the reader alone
(`proof/android/README.md`, "The app's libraries come first"); and Android
names a form's answer file by the form's file name and the second it was
opened in, so two menus' first forms opened within one second share a file,
which no worker's hands do and the reader no longer does.

### Found by serving every state

The lane now serves each state of every document to Formplayer and to the
Web Apps client, with HQ's own views answering Formplayer (`proof/README.md`,
"Served states"). What that showed that the readers' own tests had not:

65. **Nova's local archive leaves out the texts HQ's build carries for a
    list and a form.** HQ's build gives every case list a text for an empty
    list and, where the app's version supports it, one for its select
    button (`suite_xml/sections/details.py::add_no_items_text_to_detail`,
    `add_select_text_to_detail`), and gives every form a submit label in
    its app strings (`app_strings.py`, `id_strings.form_submit_label_locale`).
    Nova's local `.ccz` writes none of the three. Formplayer reads each from
    the installed app (`beans/menus/EntityListResponse.java::
    getNoItemsTextLocaleString`, `getSelectTextLocaleString`, and a form's
    `translations`), so on HQ's build it hands the client "List is empty.",
    "Continue" and "Submit", and on the local archive nothing. *Harm:* none
    in Web Apps, which installs only what HQ builds; what Android shows for
    a list and a form with none of them is Android's to observe. It is a
    difference between the two export paths that Core's sessions did not
    read. *Documents:* every document with a case list or a form
    (`formplayer@local.ccz`, proof 3).

66. **Nova's local form writes a case's updated properties in another
    order than HQ's build.** HQ's build writes the properties of an
    `<update>` sorted by name (`xform.py::XFormCaseBlock.add_case_updates`,
    `sorted(update_mapping.items())`); Nova's local form writes them in the
    order its own case blocks are assembled
    (`lib/commcare/xform/caseBlocks.ts`), so a form's instance, as
    Formplayer hands it back, lists the same properties with the same
    values in a different order on the two paths. *Harm:* none found: HQ's
    case processing and Core's apply each property of an update by its
    name, and no update names a property twice. It is a difference between
    the two export paths that Core's sessions did not show. *Documents:*
    `workforce-case-operation-sequence`, `case-operation-sequence`
    (`formplayer@local.ccz`, proof 3).

What the same runs show of earlier defects and findings, each on HQ's own
views, Formplayer and the client, on the documents the register names:

- **Defect 6 (CSQL) and defect 12 (related lookups).** HQ's own search view
  answers Formplayer 400 for the search each document sends: "09:00:00 is
  not a correctly formatted date or datetime" (`targeted-search-hq-compile`)
  and "You cannot query related cases here" (`search-parent`), and the
  worker is shown HQ's message in place of a list (`formplayer@A`,
  `/hq/app_aware_remote_search/400`). The lane held both only as HQ's
  compiler refusing a string; they are now a worker's screen.
- **Finding 32.** On the local archive, Formplayer's search reaches HQ at
  the address the archive names and HQ answers 404; the worker is shown an
  error page's text (`formplayer@local.ccz`).
- **Finding 59.** Every form of every local archive is refused at submit
  ("Cannot invoke String.length() because this.input is null": the null
  submission address), on every document.
- **Finding 62.** The Incomplete Forms tile leaves the home screen after
  the App Settings save on every document, not only the one its test read.
- **Finding 54.** Formplayer hands the client a non-breaking space for the
  description after the Case List save, and the client's screens on the
  two states do not differ: the equivalence is what the lane itself shows.
- **Defect 13 (guard blocks).** After a Vellum save Formplayer refuses the
  form's submission ("The case_id attribute of a <case> wasn't set"), so a
  worker in Web Apps cannot submit the form at all; Core's sessions showed
  it as HQ's case processing refusing an empty id.
- **A case claim.** HQ's own claim view makes a claim case for every case a
  search's result claims, whoever owns it, and answers 201, so Formplayer
  syncs after every claim. The harness's earlier answer for a claim (204,
  "a case the worker already holds") was not what HQ answers.

### Found of the lane itself

64. **No app the lane built was one Web Apps lists.** HQ sets a new app's
    `cloudcare_enabled` from the project space's `CLOUDCARE` privilege when
    Nova's upload lands (`models/applications.py::_create_app_from_doc`), and
    Web Apps lists only an app that has it
    (`cloudcare/utils.py::get_web_apps_available_to_user`). The lane's
    configurations granted a privilege only where a document's content
    needed it, and Nova sends no `cloudcare_enabled`, so every app of the
    corpus was stored with it false. *Harm:* none to a worker; it bounded
    the lane: the stored app the checks compared was never the one a project
    space with Web Apps holds. *Closed:* every app Nova sends is one a worker
    opens in Web Apps, so the privilege derivation now gives `CLOUDCARE` to
    every configuration (`proof/checks/configurations.py::_needs_cloudcare`),
    and `proof/webapps/test_session.py` takes it away to show what it
    decides. With Web Apps on, HQ's Case List page shows its search workflow
    selector wherever a project space searches, so defect 21 (a list-first
    menu turned search-first by the Case List save) shows on every document
    with such a menu, where it showed on `targeted-list-first-web-apps`
    alone.
    *Documents:* every document.

## Equivalences only another runtime reads

These differences are no harm: every runtime that reads them reads both
spellings alike. One of their readers is a runtime no test of the lane runs
(Android), or was when the entry was written, so no spelling rule's test can
prove them alike, and the register holds them, each entry marked with its
`equivalence`. Finding 55 is no longer one of them: every reader of its
spelling is run, so it is a spelling rule. Beside the
findings below, the entries of findings 40 (ten profile settings written at the
value their readers take when they are absent) and 42 (a vertical alignment of
`start`) are marked the same way.

54. **The Case List save writes an empty search description.** HQ's Case
    List page saves the search's description for the page language as the
    text it holds, empty for an app that has none
    (`views/modules.py::_gather_and_update_search_properties`), and HQ's
    build of the saved app then writes a `<description>` for the search
    (`suite_xml/post_process/remote_requests.py::RemoteRequestFactory`,
    whenever the description is not `{}`). HQ's app strings give the
    description's locale the same blank text either way
    (`app_strings.py`), which HQ writes as a non-breaking space
    (commcare-translations `commcare_translations.py::dumps`), so Core reads
    `"\u00a0"` with the description and `""` without one
    (`util/screen/QueryScreen.getDescriptionLocaleString`), as Core's
    sessions over the two builds of `search-browse` read them.
    Formplayer hands that to Web Apps (`QueryResponseBean`), which trims it
    to nothing and shows no description either way
    (`formplayer/menus/views/query.js` and `views.js`, `templateContext`),
    and Android does not read it. *Harm:* none a worker sees.
    *Documents:* `case-list-browse` and 72 others.

55. **A Vellum save writes an empty work area id into a Connect deliver
    unit.** Nova's Connect deliver unit has no `work_area_id`; Vellum's save
    writes one, empty (`src/commcareConnect.js`). Connect reads it by its
    truth value (`commcare-connect form_receiver/processor.py::process_deliver_unit`,
    `if work_area_case_id := …`), so the empty id reads as none. Core's
    submission differs, and only Connect reads it. *Harm:* none: HQ forwards
    the empty id as an empty string, and Connect's receiver leaves the same
    rows for the saved form's delivery as for Nova's
    (`proof/connect/test_receiver.py`). Every reader of the element is now
    run on both spellings by one test
    (`proof/rules/test_connect_work_area_empty.py`: HQ's build, Core's
    sessions and HQ's case processing, Formplayer's walk, HQ's own receiver
    and Connect repeater, and Connect's receiver, with an id that names a
    work area as the case Connect reads otherwise), so the spelling is the
    rule `connect-work-area-empty` and the register holds no entry for it.
    The lane shows the same on each Vellum save of a deliver form
    (`connect@vellum@…` reports nothing).
    *Documents:* `connect-deliver-custom`, `connect-deliver-default`,
    `expander-expanddoc-hq-json-projection-sort-elements-85a51a04-0`.

## Research claims the harness corrected

1. **`#case/<property>` shadows do not save equivalently** (README, "Nova's
   exports stay inside HQ's editable envelope", the shadows for properties HQ
   does not list). For an attribute-backed property (`case_id`, `owner_id`,
   `status`, `case_type`) one save blanks the read: defect 45.
2. **The app settings save stores a GPS accuracy of `5`, not 10**
   (`inventory/application-and-settings.md`, row 27). The settings file's
   default is the number 10, the page's choices are strings
   (`commcare_settings.js` matches with `===`), and Knockout's select binding
   writes its first option, `5`, when none matches: defect 40.
3. **Defect 10 has two more variants.** Besides the select and ID-mapping
   columns and the unsorted list: an interval column with text, which HQ
   sorts by its displayed text, and an image-map column, which HQ sorts by
   mapping position (`detail_screen.py::EnumImage`). Where two columns share
   a property, HQ attaches the sort to the first of them
   (`app_manager/util.py::get_sort_and_sort_only_columns`), which orders the
   rows alike unless that column is one of these or a label column; what it
   moves is the sort key a fuzzy search reads (finding 51).
4. **Defect 14's tile rewrite also aligns cells.** Its fix (a position for
   every column, a size for every cell) leaves the alignment the save writes:
   defect 42. The vertical alignment it writes (`start`) renders as absence
   does on both runtimes, but only those runtimes read it, so no spelling
   rule can prove it, and defect 42 holds it.
5. **A question named `meta` or `Meta` breaks HQ's build, not only its form
   builder** (defect 15, which names `meta` in any case among the ids Vellum
   refuses). HQ's build removes a data node of either name in the form's own
   namespace as a stray meta block
   (`xform.py::XForm.already_has_meta`, called by `_add_meta_2`) and keeps its
   bind and control, so Core refuses to install the build ("Question bound to
   non-existent node: [/data/Meta]"), and HQ's form settings page warns "This
   form has a meta block already!". *Document:* `targeted-invalid-question-ids`.
6. **A close condition the Case Management tab cannot set makes the saved app
   unbuildable** (defect 14, close conditions). The tab offers only selects,
   hidden values and labels (`partials/forms/case_config_ko_templates.html`,
   `getQuestions('select select1', …)`; `case_config_utils.js::getQuestions`),
   so its save clears a text question's condition, and HQ's build of the saved
   app fails `validate_app` with a path error. *Document:*
   `targeted-close-conditions`.
7. **A query repeat under a group that becomes relevant later does not stay
   empty after a Vellum save** (defect 25), for a query that reads no form
   answer. Core runs a load-time `setvalue` whatever its target's relevance
   (`core/model/actions/SetValueAction.processAction`), and it runs the
   form's load-time setvalues before it evaluates the form's conditions
   (`core/model/FormDef.initialize`, before `initAllTriggerables`), where a
   group whose condition nothing has evaluated yet reads as relevant
   (`XFormParser` leaves a non-constant `relevant` true until then). So the
   repeat's setvalues read its ids, and the trace of
   `targeted-query-repeat-places` after the save submits both rows. The
   repeat stays empty only where an earlier load-time setvalue has already
   left the group not relevant, the REFUSED class
   `model-iteration-under-late-relevance`
   (`lib/commcare/surface/entries/questions.json`). A repeat under a group
   that is never relevant gets no row in the submission either way, since
   Core leaves an irrelevant group out of it.
8. **HQ's empty-list text is not inert without English**
   (`inventory/menus-and-case-lists.md`, rows 139 and 140): defect 41.
9. **The wrapper containers of defect 13 also draw Vellum's "Add at least one
   property to update, or deselect the Update action."** on every Save to Case
   block that creates and updates a case inside `__nova_operations` or
   `__nova_subcases`: `src/saveToCase.js` clears `updateProperty` after the
   parse, and `core.js::_populateTree` re-checks only blocks the tree accepts,
   none under a hidden value. The research's fix (groups for the containers)
   removes it.

10. **A list with no sort is not left in case-database order on a device**
    (defect 10, "Nova's `.ccz` and Preview also leave a case list with no
    sort in case-database order"). Web Apps and Android sort it by its first
    column with a header, by the text that column shows (commcare-core
    `util/screen/EntityScreenHelper.sortEntities`;
    `cases/entity/SortableEntityAdapter.determineFieldsForSortingInOrder`,
    which Android's list runs whenever it loads its rows at once,
    `interfaces/AndroidSortableEntityAdapter`), and HQ's default sort of its
    first column (`suite_xml/sections/details.py::get_default_sort_elements`)
    reads that same text for a plain or label column. The two paths order an
    unsorted list differently only where HQ sorts that column by something
    else: a date column, which it sorts by the raw date
    (`detail_screen.py::Date`), or an image-map column, by mapping position
    (`detail_screen.py::EnumImage`). *Documents:*
    `expander-expanddoc-hq-json-projection-column-kinds-emits-35546711-0`
    (a date column); `targeted-label-sort` sorts its label columns, which an
    unsorted list would not show.

11. **HQ's Case List page keeps a date pattern its menu does not offer**
    (`inventory/menus-and-case-lists.md`, row 2′, which refused every
    pattern outside HQ's five as not HQ-editable). The page's select adds an
    unknown value as an option and selects it
    (`hqwebapp/js/ui_elements/bootstrap5/ui-element-select.js::Select.val`),
    and the column saves it (`details/bootstrap5/column.js`, `date_format`
    from `date_extra.val()`). What fails is a pattern Core cannot format:
    `DateUtils.format` raises on an escape it does not read. Row 2′ now
    refuses only that, and an empty pattern, which shows no date.

## What HQ does itself

An ID-mapping cell reads with a leading space for every entry but the first:
HQ joins every entry's text with a space
(`suite_xml/xml_models.py::XPathEnum.build`, `replace(join(' ', …))`), and
Nova's local archive writes the same, so the two paths agree and no check
reports it.
