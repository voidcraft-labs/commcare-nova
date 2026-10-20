# The proof harness's findings

What the proof lane (plan step 1) found that the research did not: the defects
in Nova its checks show, numbered on from the research's thirty, the research
claims they proved wrong, and the differences every reader reads alike, each
proven so by tests that run those readers. Every difference the lane reports
is held by a register entry (`proof/known-defects.json`), whose `defect` is
the research's number or one of these, or erased by a spelling rule
(`proof/rules`); the register holds no entry for an equivalence. A defect's
fix moves its entries to the fixed-defect register
(`proof/fixed-defects.json`), held on the control that keeps its bytes from
before the fix. What HQ's editors, CommCare's runtimes or Connect report of
an app Nova never touched is left out by a member of the closed set
`proof/checks/hq_own_reports.py::HQ_OWN_REPORTS`, each proven on an app made
in HQ's own pages, and recorded under "What HQ does itself".

Findings 31 to 55 and corrections 1 to 11 came from the lane's whole-corpus
runs (316 documents, two configurations each) after the register round's
phase A, sorted at source by four classifiers and four checkers, and the run
of the targeted documents (`proof/targeted/`), each built to show one symptom
with fixed values. Every fact of theirs was read in, or executed against, the
pins the research uses: commcare-hq `f57e85e02913`, formplayer
`24383ac71bfb`, commcare-core `8e9ba8d908e9`, commcare-android
`fd79cac4a0f1`, Vellum `01215f251c57`, commcare-connect `4a200c9d9`.
`proof/pins.json` named those commits of HQ, Core, Android and Connect until
#716 moved it.

Everything added since was read in, or executed against, the commits
`proof/pins.json` names now, most of it by running a reader's own code:
findings 58 to 69 and 72 to 74 ("Found by running the other readers" on),
corrections 12 to 15, the readers' runs behind the equivalences, and what a
later run added to an earlier finding. #716 moved `proof/pins.json` to them
before any of that was written, and Formplayer's pin joined it with the
first run of Formplayer. Those commits are commcare-hq `d6c6e16d8ae1`, commcare-core
`8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect
`046c7fd78081` and formplayer `24383ac71bfb`, with the Vellum HQ vendors at
its pin, still `01215f251c57` (`proof/hq/test_boot.py`). Core, Formplayer
and Vellum are where the research read them; HQ, Android and Connect moved.
Findings 56, 57, 70 and 71, found while step 2 was planned ("Found while
planning step 2"), were executed at those same commits, which
`proof/pins.json` still named.
Finding 75, found while step 3 was planned ("Found while planning step 3"),
was executed at the same commits, which `proof/pins.json` names still.

Citations use `file::symbol`; documents are the corpus ids that show the
symptom.

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
    value their readers take when they are absent (`cc-autosync-freq`,
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
    `RestoreFactory.getSyncFreqency`), all but `cc-maps-default-layer`
    forced. These ten were held as equivalences, and they are not on every
    device (see the correction below): Android's settings screen lets a
    worker change none of them, so a device holds another value of one only
    from an earlier profile of the app, and such a device keeps that value
    where the next profile names none and loses it where the next profile
    forces the default. The research plans the fix (the
    inventory's application settings rows: every setting written explicitly)
    but catalogs no defect.
    *Harm:* the first harmless settings save turns case list search fuzzy,
    halves the accuracy GPS auto-capture waits for (it polls until a fix
    within 5 metres where it stopped at 10,
    `PollSensorController.onLocationResult`), skips media checks and
    overrides workers' preferences. Run on Android (`proof/android`), each of the three readers
    gives the changed value on the saved app's build, and a device whose
    worker turned text to speech on and chose daily updates reads both back
    at the profile's values once it updates to the saved app. Each of the
    ten gives the same value on both profiles on a device that installs
    either, or updates to either from Nova's own; on a device an earlier
    profile gave another value (a login that lasts 100 seconds, logging off,
    a daily sync, forms kept seven days, one unsent form allowed), an update
    to the profile that names none keeps it and an update to the saved
    app's resets every one (`proof/android/predicates.py::
    test_a_default_forced_over_a_value_an_earlier_profile_gave_replaces_it`).
    Only a setting a person saved in HQ and Nova's next publish dropped
    (defect 4) leaves a device in that state, so the ten are that defect's
    second half: the device kept the person's value, HQ's page showed the
    default, and the next save of that page, changing nothing, takes the
    person's value off every device. *Documents:* every document.

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
    `start` into every cell (`vertical_align`, `@vert-align`), which every
    reader lays out as it lays out none: Formplayer hands the client `start`
    where it handed nothing, the client computes `align-self: start` for
    both, and Android's tile has no case for it. Each of those readers is
    run on both spellings, so it is the spelling rule
    `tile-vertical-align-start` and no entry (correction 4, and
    "Equivalences, each proven by running its readers", below). The research's
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
    A node named `itext` opens. A question named `parsererror` stops it the
    same way, found while step 2 was planned: Vellum loads a form through
    jQuery's `parseXML` (`src/xml.js::parseXML`), which takes any element of
    that name for the browser's own parse failure and throws "Invalid XML",
    and Vellum shows "Parsing Error. Please check that your form is valid
    XML." (`src/core.js`) and saves nothing. *Harm:* the form cannot be
    edited in HQ at all; HQ builds it and Core runs it unchanged.
    *Documents:* 20 fuzz documents, `targeted-reserved-node-names`;
    `targeted-parsererror-node-name` (proof 4 on Vellum's load).

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
    and 162 others); `targeted-shared-property-sort`, whose second menu
    holds a shown image map and a hidden column over one property, the
    hidden one carrying the list's order rule: HQ's build keys the image
    map by its mapping position and the local archive keys the hidden
    field by the stored value, so a misspelled value finds its case on the
    local install and nothing on HQ's (Android,
    `/walks/*/steps/*/list/searches/fuzzyOn/*`). Its first menu, a shown
    and a hidden column over one property that hold the same text, shows
    no such difference.

52. **A validation message that shows an answer reaches the worker
    unfilled.** Nova writes a field's validation message on its bind alone
    (`jr:constraintMsg="jr:itext('…')"`, `lib/commcare/xform/builder.ts`).
    Core reads that message as an expression and fills none of its
    `<output>`s (`FormEntryPrompt.getConstraintText` falls back to
    `Constraint.getConstraintMessage`), while a message read from the
    control's `<alert>`, which Vellum's save adds
    (`src/writer.js::createAlert`), is localized with each output filled
    (`localizeText`, `FormDef.fillTemplateString`); the spelling rule the
    lane then held for the alert (`vellum_alert`, retired once Nova wrote
    the alert itself) left such a message.
    *Harm:* where the message names an answer, the worker reads `${0}` in
    its place on Nova's export, and the value after a save in HQ.
    *Documents:* `expander-form-hashtag-expansion-declares-the-casedb-02e7ce76-0`.
    *Fixed (#712):* Nova now writes the control's `<alert>` beside the bind
    for a plain message, and composes a message that shows an answer as the
    constraint expression itself (`lib/commcare/xform/constraintMessage.ts`),
    so the worker reads the value on Nova's export too. Its two classes are
    entries of the fixed-defect register (`proof/fixed-defects.json`,
    `d52-output-in-validation-form-alert` and
    `d52-output-in-validation-source-alert`), held on the control
    `expander-form-hashtag-expansion-declares-the-casedb-02e7ce76-0`, which
    keeps the form from before the fix.

53. **The two export paths send a search with no inputs differently.**
    Nova's HQ JSON gives a search with no inputs a default filter
    `_xpath_query` of `match-all()`
    (`lib/commcare/hqJson/caseList.ts::ZERO_INPUT_SEARCH_SENTINEL`), which
    Nova's local archive does not send. HQ returns the same cases (the filter
    matches every case), and it notes the filter as a use of Advanced Case
    Search where the project space lacks it, at most once per project space
    per day ("What HQ does itself"). *Harm:* a search from an install of
    HQ's build carries a filter one from the local archive does not; the
    worker sees the same results. *Documents:* `search-automatic`.

### Found by running the other readers

Findings 58 to 64 were found by running the readers the lane had only cited:
Formplayer's application, Connect's receiver, HQ's Web Apps client and
commcare-android. Numbers 56 and 57 belong to two findings made while step 2
was planned ("Found while planning step 2").

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
    for a profile with no `PostURL` is a fixed address of its own, which
    names no project space of the app's: the Android reader reads the
    address a device would post to by Android's own reader
    (`FormSubmissionHelper.getFormPostURL`), and on the local archive it is
    `https://staging.commcarehq.org/receiver/submit/pf` where HQ's build
    gives the project space's receiver under the app's id
    (`android@local.ccz`, proof 3,
    `/profile/readers/FormSubmissionHelper.getFormPostURL`). *Documents:*
    any local archive.

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
under Robolectric, beside HQ's live unit in every proof shard, over each
state the shard serves: Nova's local exports and HQ's builds of A, B, B-edit
and every editor save, its network answered by HQ's own views in that
state's fork (`proof/android/README.md`). The first thing it showed, finding
63, is HQ's own download arrangement ("What HQ does itself").

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

### Found by Android in the unit

The lane now has CommCare Android's own code read every archive a device
installs of every document: Nova's local exports and HQ's builds of A, B,
B-edit and every editor save, each walked from the first menu through every
list, search, claim and form, installed twice, and updated with forms left
incomplete (`proof/README.md`, "Android in the unit"). Proofs 1, 3 and 4 judge
what it read. What that showed that the reader's own tests had not was
finding 67, which is CommCare's own reading of grouped tiles ("What HQ does
itself").

What the device shows of earlier defects and findings, each as a worker's
device meets it, on the documents the register names:

- **Defect 1 (ids and xmlns).** After a republish, a form a worker left
  incomplete on the earlier build does not open: "No XForm definition
  defined for this form with namespace …" (`android@B`,
  `/update/reopened/*`). Every document with a form shows it.
- **Defect 9 (the local app's id).** The two local exports of one app
  install side by side as two apps where HQ's second build is refused as a
  duplicate (`/installs/*`), and a device on the first export finds no
  update in the second (`UpToDate`, `/update`).
- **Defect 7.** The Incomplete button is on the local install's home
  screen and hidden on HQ's. The Saved button is hidden on both: HQ's
  profile sets `cc-show-saved` to `no`, and Nova's local profile names no
  `checkoff` feature, without which Android hides Saved whatever the
  setting (`StandardHomeActivityUIController.getHiddenButtons`). The lane
  once read Saved as shown on the local install: the project's test
  application hands every caller of `getCurrentApp` a new app around the
  seated one, whose platform holds no profile, so the feature was never
  read; the reader now gives the device the app it seated
  (`proof/android/src/nova/proof/android/ProofApplication.java`).
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
- **A form the device refuses leaves no mark.** Each time a device does not
  save a form (defect 13's, and defect 25's), it holds the cases it held as
  the form opened, and keeps the form's record aside (`limbo`): Android
  applies a form's case blocks in one transaction
  (`FormRecord.updateAndProcessRecord`). The reader reports any refused form
  that left a case changed (`…/form/saved/applied-though-refused`), and no
  run has.
- **Defect 4 and finding 34 (location capture).** A form of HQ's build with
  `auto_gps_capture` asks the device for the location permission as it
  opens; B's form (defect 4) and the local archive's (finding 34) ask for
  nothing. Allowed, as a worker allows it, the permission lets the
  device's GPS give HQ's build's form its fix, which `PollSensorAction`
  writes into the saved form's meta (`deviceGave`, `metaLocation`); B's
  and the local archive's saved forms hold no location.
- **Defect 12 (single-date prompt), typed.** After the Case List save the
  single-date prompt is a text box on Android; a worker who types into it
  sends what they typed inside the search's CSQL
  (`visit_date = date-add("proof", 'days', 7)`), where before the save the
  device offered no box and sent `match-all()`. Where the input is a
  datetime (`navigation-search-datetime-add`), HQ's search view refuses
  what was typed (400, "Invalid datetime value. Must be a number or a ISO
  8601 string."), and the device shows the worker HQ's error and stays on
  the search screen (`…/query/typed/afterServerAnswers/*`,
  `…/query/withAnswer/afterServerAnswers/*`).
- **Defect 10.** A list with a label column or no sort shows its cases in
  another order on the local install, so the first case a worker sees is
  another one (`/list/order`, `/list/chose`), and a Sort choice orders them
  otherwise (`/list/sorted/*`, the path finding 51's sort keys change too).
  Defect 10's Sort orders are held apart from finding 51's by entries that
  pin their values on `targeted-label-sort` (a register entry pinning its
  values owns the differences it matches, `proof/checks/registers.py::reconcile`).
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

### Found by running what the lane had left to citations

The lane's README listed, under "What the lane does not observe", harm it
called out of reach of every system it ran and two inputs it said no Nova
document could hold. Each was run (`proof/views`, two targeted documents, a
test of Nova's planner and gate). What that showed beyond the research's own
statements:

68. **Nova's gate admits a read of the session's supply point, which no
    session of a Nova app holds.** A hidden value may read
    `instance('commcaresession')/session/data/supply_point_id`
    (`proof/targeted/__tests__/unproducedInputs.test.ts`; step 1 had left
    the row "20, CommTrack" out as an input Nova cannot produce). The
    manifest holds that read as refused, and nothing in Nova refuses it.
    *Harm:* the form does not open: Core raises "Logic references
    instance(commcaresession)/session/data/supply_point_id which is not a
    valid question or value" as the form loads, on Nova's local archive and
    on HQ's build alike, and a device shows "Error Occurred" where the form
    should be. Under CommTrack, HQ gives a form whose stored source holds
    that path a datum from the worker's `commtrack-supply-point` user data
    and an assertion that it is there
    (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`, a
    substring test on the stored text). Nova's export spells the path's
    apostrophes `&apos;`, so the source Nova uploads does not hold HQ's
    text and HQ's build of it holds no datum; a save in HQ's form builder
    writes them plainly, and from then HQ's build holds the datum and the
    assertion, and a worker with no supply point is refused the form
    ("This form requires access to the user's location, but none was
    found."; on a device, "Unrecoverable Error" at home). So whether HQ
    supplies the datum the form needs turns on how its source is spelled.
    *Documents:* `targeted-supply-point-read` (the manifest check; proof 4
    after the Vellum save, in HQ's build, Core's sessions and on Android).
    The harness itself respelled sources where it aligned B to A, which
    this document was the first to show (an aligned B held the datum B's
    own build did not); it now keeps B's own bytes
    (`proof/observe/alignment.py::renamespace_xform`).

69. **A device and Web Apps read an app's location fixture choice
    differently.** HQ's restore hands a worker the flat location fixture by
    the app's `location_fixture_restore` only where the restore names the
    app (`locations/fixtures.py::should_sync_flat_fixture`,
    `ota/views.py::restore`). A device restores at the address its
    profile names, which names the app; Formplayer restores at the address
    that names none (`RestoreFactory.getUserRestoreUrl`), so for Web Apps
    HQ asks the project space, whatever the app says. Nova writes
    `both_fixtures` (defect 14), which HQ's settings page does not offer.
    *Harm:* in a project space whose flat fixture is off, a Nova app that
    reads places has them on Android and none in Web Apps, where the form
    that reads them moves no case; with the setting on, both have them.
    The research's `project_default` fix makes the two alike. *Documents:*
    `location-direct` (`proof/views/test_location_fixture.py`, HQ's own
    restore view asked as a device asks it and as Formplayer asks it).

What the same runs confirmed as the research states it: an add-on a person
turned on in HQ is gone from HQ's module page after Nova's next publish
(defect 4, `proof/views/test_add_ons.py`); HQ's Case List page holds the
control for an inline search, a multi-select list and an excluded search
input only under `CASE_SEARCH_ADVANCED`, though HQ stores each without it
(defect 12, `test_case_list_offers.py`); HQ answers Nova's lookup push with
its "Upgrade Required" page and HTTP status 200 where the plan lacks lookup
tables, and writes nothing (defect 5, `test_lookup_upload.py`); HQ's form
builder warns "Unknown question" on a read of a property only a Save to
Case block writes, and not on the same read of a property an ordinary field
writes (defect 3, `targeted-save-to-case-read`); and no document can hold a
basic child case of its own menu's case type, since a write of the menu's
own type is the menu's own case (`unproducedInputs.test.ts`).

### Found by holding every walk to its end

Proofs 3 and 4 compare two states' walks of an app, so a run that ended
early on both sides alike passed every comparison with the rest of it unseen.
The stops check (`proof/checks/stops.py`) reads each walk on its own:
Formplayer's walk of every state ends where the app ends it, or at a stop
`proof/walk-stops.json` holds by name (`proof/README.md`, "Walk stops"). Most
of the stops it holds are the refusal a numbered defect already is (5, 6, 12,
13, 14, 15 and 20). Three are not, and each ends a form no check had seen
past. Numbers 70 and 71 belong to two findings made while step 2 was
planned ("Found while planning step 2").

72. **Nova admits a choice question whose default is none of its options,
    and Web Apps cannot open the form.** A single or multiple choice field
    may carry a default value that no option of it holds: the fuzz
    generator draws the options and the default apart, so
    `fuzz-xform-20260930-1`'s question offers `no`, `yes` and `c` with the
    default `'a'`. Nothing in Nova refuses it, HQ's import and build take
    it, and Nova writes the default as it writes any other
    (`<setvalue event="xforms-ready" ... value="'a'"/>`, or `jr-insert`
    where a repeat holds the question). *Harm:* Formplayer writes every
    question's answer into the form it hands the client, and for a stored
    choice it has Core find the option (formplayer
    `api/json/PromptToJson.java::parseQuestionAnswer`, commcare-core
    `core/model/data/helper/Selection.java::attachChoice`), which raises
    "value a could not be loaded into question ... Check to see if value a
    is a valid option". Formplayer answers the form's opening with that
    error on the five documents below, and Web Apps shows it and stays on
    the menu, so no worker there opens the form. On
    `fuzz-xform-20260930-10`, where a repeat a worker adds to holds such a
    question, Formplayer answers the request that adds the repetition with
    it, and the client shows the error and goes on without the repetition.
    Core's own session of the same forms (the lane's Core runner) and
    CommCare Android answer the question and finish the form, on a phone
    and a tablet, so the harm is Web Apps' alone. It is the same on Nova's
    export and on HQ's build of it (A, B and B-edit alike), which is why no
    comparison showed it, and Formplayer reads the form whoever wrote it,
    so an app built in HQ with the same default does the same. It is
    Nova's to refuse at authoring where the default is a literal and the
    options are the field's own; a default an expression computes is not
    decidable there. *Documents:* `fuzz-suite-20260930-5`,
    `fuzz-suite-20260930-8`, `fuzz-xform-20260930-0`,
    `fuzz-xform-20260930-1`, `fuzz-xform-20260930-7`; each formerly held the stop
    Formplayer, `notification:value-could-not-be-loaded-into-question`.
    **Fixed at the authoring boundary:** `SELECT_DEFAULT_NOT_AN_OPTION`
    refuses a static choice default outside its options. The corpus maps
    each drawn select default to its first drawn option, without another
    draw; the five stops are removed. No retained control is needed for a
    reader's refusal of an invalid answer. The validator and generator's
    focused tests hold the refusal and mapping.

73. **A date question filled from a case property that holds text opens on
    no reader.** A field that writes a case property is filled from the case
    as a follow-up form opens (`<setvalue event="xforms-ready"
    ref="/data/start_date" value="instance('casedb')/casedb/case[...]/
    start_date"/>`), and a date field is bound `xsd:date`. Where the case
    holds text that is no date, Core refuses the cast as the form loads
    (`core/model/actions/SetValueAction.java::processAction`: "Invalid data
    type in setvalue event targetting |/data/start_date| ... Invalid cast of
    data [10] to type Date"). *Harm:* the form opens nowhere for that case:
    Core's session ends before the form (`form-did-not-open`), Formplayer
    answers the form's opening with the error and Web Apps stays on the
    menu, and CommCare Android does not load the form, on a phone and a
    tablet. It is the same on Nova's export and on HQ's build of it, and
    Core refuses such a setvalue whoever wrote the form, so an app built in
    HQ that loads a case property into a date question does the same on the
    same case: it is no difference of Nova's emission.
    The document shows it because its case type declares the two
    properties with no data type, so the lane's case holds the text values
    it gives an untyped property (`proof/observe/casedata.py`, "10" here).
    What is Nova's to settle at authoring is the catalog: a property a date
    field writes and reads back could be held to the date type, and the
    lane's cases would then hold dates. What no authoring rule reaches is
    the case a project space already holds, written by another app, an
    import or HQ's API. *Documents:*
    `expander-output-references-in-labels-lowers-several-typed-e72b42c4-0`;
    it formerly held the stop Formplayer,
    `notification:invalid-data-type-in-setvalue-event-targetting`.
    **Fixed in the corpus:** each emitted document now carries the
    materializable effective catalog, so its writer-derived date
    properties receive date values. Python reads those types directly and
    never infers them from the fields. The stop is removed, with no
    retained control; `test_the_case_database_seeds_each_property_from_the_effective_catalog`
    holds the seeding boundary.
    **Fixed at authoring:** a Hidden Value that saves to a case property
    joins writer agreement, so no writer of Nova's puts text in a property a
    typed question reads back (`HIDDEN_VALUE_WRITER_TYPE_MISMATCH`). A case
    a project space already holds, written by another app, an import or
    HQ's API, is still beyond any authoring rule.
    **Preview refuses it too:** every setvalue Preview performs (a case
    preload, a starting value, a repeat insert's starting value) goes
    through Core's cast for the question's bind type
    (`lib/preview/engine/answerCast.ts::castAnswerText`), so a typed
    preload whose case text does not cast stops the form there too, with
    the case, the property and the value named and a way back to another
    record, and a refused repeat insert adds no row.

74. **Web Apps submits its own placeholder for a date and time question in
    a repetition added last, and the form can then never be submitted.**
    HQ's client draws no widget for a date and time: the question reads
    "Sorry, web entry cannot support this type of question."
    (`form_entry/entries.js::getEntry`, `UnsupportedEntry`), and as the
    client draws it the entry sets the question's answer to the text "Not
    Supported by Web Entry". Formplayer's next answer to any request puts
    the form's own value back (`form_ui.js`, `Container.fromJS`), so a
    question on the form as it opens is harmless once a worker answers
    anything. A question the client first draws in the last answer before
    Submit keeps the text: a worker who adds a repetition that holds a date
    and time question, and has nothing after it to answer, submits "Not
    Supported by Web Entry" as that question's answer
    (`web_form_session.js::submitForm`). A form whose only questions are
    date and time questions does the same with no repeat: nothing a worker
    answers sends a request, so the client holds the text for each and
    submits it. *Harm:* Formplayer refuses the
    submission (`validation-error`, the question an `illegal-argument`),
    and by the client's code the question then keeps the error and no later
    answer clears it, so every later Submit goes without it as not
    prevalidated and is refused too: the worker loses what they entered.
    Core's own session submits the same form, and a device has a widget for
    the question. It is the same on Nova's export and on HQ's build of it,
    and the client does it to any form that holds such a question in a
    repeat, so it is HQ's client's and not Nova's emission. Whether Nova
    refuses a date and time field at authoring is a product choice, since a
    device runs it; what Nova can say at authoring is that Web Apps has no
    widget for it. The lane's Formplayer walk now submits what the client
    holds (`proof/formplayer/walk.py::UNSUPPORTED`,
    `proof/webapps/observe.py::submitted_alike` holds the two alike).
    *Documents:* `targeted-datetime-ordering`, whose survey form asks two
    date and time questions and nothing else (finding 56), which holds the
    stop Formplayer, `submit-refused:validation-error`; and
    `fuzz-xform-20260930-0`, whose "Form 1-0" opens with both selects already
    answered and leaves that placeholder at its required `/data/itext`
    datetime question. R5 run 39129168950 at `5447da59` shows the same
    refusal in all four baseline states after the walk stopped resending
    unchanged answers; the earlier R3/R4 request had masked it. Pull request
    5 adds that second finding-74 stop, whose fix remains step 4's.
    `fuzz-xform-20260930-10` held it too, in a repetition added last, until
    step 2 drew the repeat that follows it over the open cases (finding 71),
    so the walk answers its rows after the repetition and Formplayer's next
    answer replaces the held text.

The same check found that Formplayer's walk had never pressed the Add of a
repeat a worker adds to, so no repetition, nor the case it creates, was ever
submitted to Formplayer or shown by the client. The walk now adds one
(`proof/formplayer/walk.py::addable`), which is what showed defect 23's
dropped attachment in Formplayer's submissions on the two repeat documents
(two register entries) and what showed finding 74. It also found two things
of HQ's own that hold on any app and are no defect of Nova's: on Web Apps a
list with grouped tiles draws each group as one tile whose click takes the
group's first case (`menus/views.js::CaseTileGroupedListView`), so a worker
there opens no other case of the group (the four `tile-grouped-*`
documents, whose visits hold no parent index and so make one group); and
App Preview's one-question form cannot show a repeat a worker adds to, nor
a form with no question, which its "Use one question per screen" setting
answers (38 documents; the lane's replay switches it off there, as a person
does).

### Found while planning step 2

Step 2's plan ran its fixes and its new targeted documents through the lane
before writing them, and four things it ran were defects no check had yet
shown. Each has a targeted document with its register entries and its
control.

56. **An ordering comparison on a date and time never orders by instant on
    a device.** Nova's type checker admits an ordering over a date and time
    (`lib/domain/predicate/typeChecker.ts::ORDERED_TYPES`), Nova writes the
    comparison bare (`lib/commcare/predicate/caseListFilterEmitter.ts`,
    with its operands from
    `lib/commcare/expression/onDeviceEmitter.ts::emitOnDeviceExpression`),
    and Preview orders it by instant. Core compares by what it holds,
    executed against Core in three device time zones with the same results:

    | Operand at run time | Examples | Result |
    |---|---|---|
    | A date and time held as text | a custom datetime case property, a literal, a lookup column, a worker property, a search input | not a number to `FunctionUtils.toNumeric`, so every ordering is false, in both directions |
    | A typed date | `now()`, a datetime answer in a form | ordered by calendar day only: two values an hour apart are not `<`, and are both `<=` and `>=` |
    | `date(...)` of text | a coerced case property or literal | a date with a clock, so by day as the row above; and `date()` of text that is no date raises, where the bare comparison is a quiet false |
    | `date_opened`, `last_modified` | Core holds them as dates | by day, as documented |

    Core's parse of a date and time that carries an offset
    (`DateUtils.parseTimeAndStore`) converts the clock to the reader's zone
    and keeps the written date, so `date(<text>)` is a whole day off
    wherever the reader's local date for that instant differs from the
    written one: no one wrapper is right for every operand. HQ's case
    search is right: its range query compares instants
    (`date_opened > '2026-01-01T10:00:00.000Z'`). *Harm:* a comparison of
    two moments that Preview finds true is false on a device, or compares
    days where the author compared moments. Defect 6 covers a time of day
    only.
    *Documents:* `targeted-datetime-ordering` (intent, `/values/*/value` on
    the local export and on A: two answers an hour apart in a survey form,
    and two case properties held as text in a follow-up form);
    `targeted-datetime-operands` (intent: a Hidden Value copying a
    date-and-time property ordered against `now()` under a fixed clock,
    `/values/*/value` on the local export and on A, and two case list
    filters, one ordering the property against a literal and one ordering
    two such properties, `/caseList/rows/*/caseId` on the local export;
    manifest: the local archive's suite holds a REFUSED `time-operand` use
    under `XPathCmpExpr` and `LT`).
    *Fixed (#783):* Nova lowers each operand of an ordering over two dates
    and times by its type to zone-free integer microseconds
    (`lib/commcare/xpath/wire/instant.ts`), in the form, in its Vellum
    shadow and in the suite, so a device orders by instant in every zone,
    as Preview does; a date against a date stays bare, and a date meets a
    date and time only through an explicit coercion, entering as its UTC
    midnight. The checker refuses, in a slot a device evaluates, a
    comparison with an operand that has no instant on a device: a
    `casedb` `date_opened` or `last_modified` against a moment
    (`day-only-on-device`) and a value whose clock is lost (`clock-lost`).
    The `expression` native family holds it in four device zones and three
    Formplayer setups. Its seven entries are in the fixed-defect register,
    held on the controls `targeted-datetime-ordering` and
    `targeted-datetime-operands`.

57. **A case list column over `case_id` is blank on HQ's build.** Nova
    writes a shown column over `case_id` as a property column
    (`field: "case_id"`, `lib/commcare/hqJson/caseList.ts::projectColumnToDetail`),
    which HQ's build reads as a child element of the case:
    `detail_screen.py::CASE_PROPERTY_MAP` turns `owner_id` and `status`
    into attribute reads and has no entry for `case_id`, and the case
    database holds the id only as an attribute. Nova's local suite reads
    `@case_id` and shows it. A hidden sort column over `case_id`,
    `owner_id` or `status` is written with the attribute spelling in a
    property field (`projectColumnForShortDetail`), which HQ's Case List
    page refuses to save ("There is an error in your property name",
    `helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field`,
    and the page's `details/utils.js::isValidPropertyName`, neither of
    which takes `@`). *Harm:* on an install from HQ the column shows
    nothing, its search matches nothing there, and a person cannot save
    the app's Case List page in HQ. *Documents:* `targeted-case-id-column`
    (the manifest; proof 3 on Core's trace, Formplayer and Android; proof
    4 on the Case List save).

70. **A question named `case`, `registration` or `script` draws HQ's form
    builder's warning, and `case` in a form that saves a case stops HQ's
    build.** Vellum adds "The ID '<id>' may cause problems with form
    parsing. It is recommended to pick a different Question ID." to each
    such question, in any letter case (`src/mugs/baseSpecs.js`,
    `RESERVED_NAMES`), on its first save and its second. A root question
    named `case` in a form with case actions is taken for the form's own
    case block (`xform.py::XForm.case_node`), so HQ's build raises "You
    cannot use the Case Management UI if you already have a case block in
    your form." (`XForm._create_casexml`), and `validate_app`, the form
    settings page and the Case Management page say the same. *Harm:* a
    warning on every save of the form; with `case`, nothing can be built
    or installed from HQ for the app. *Documents:*
    `targeted-reserved-question-names` (the bar; proof 4 on the Case
    Management, form settings and Vellum saves).

71. **A read of the form's root is admitted, and HQ's form builder calls it
    an unknown question.** Nova's gate holds every absolute path of form
    logic to the form's fields
    (`lib/commcare/validator/xpathValidator.ts::validateXPath`), reading
    them from `lib/preview/xpath/dependencies.ts::extractPathRefs`, which
    collects only paths that start `/data/`, so the root alone (`/data`)
    is never looked at. Both fuzz generators draw it
    (`lib/commcare/__tests__/xformDocArbitrary.ts`: `count(/data)` as a
    counted repeat's count, `/data` as a repeat's ids query).

    | Shape | HQ's form builder | Every other check and reader |
    |---|---|---|
    | A Hidden Value whose calculate is `count(/data)` | "Unknown question: #form" on the question, on its first save and its second (`src/logic.js`, `logic-bad-path-warning`) | nothing: HQ builds it, and Core, Formplayer, the Web Apps client and Android run it |
    | A counted repeat whose count is `count(/data)` | the same, on the hidden node Nova writes to hold the count | nothing |
    | A repeat over a list of ids whose query is `/data` | nothing | nothing of its own |

    *Harm:* a warning on every save of the form, and a read no author
    means: the root is the whole form, never a question, a number of rows
    or a list of ids. It was found when step 2's rules for question names,
    run over the whole corpus, let HQ's form builder open three fuzz forms
    it could not open while each also held a question named `instance`.
    *Documents:* `targeted-form-root-read` (proof 4 on Vellum's two
    saves).

### Found while planning step 3

Step 3's plan ran its new targeted documents through the lane without the
served readers before writing them (run 39061011794), and then with every
reader (run 39078199859), and one thing it ran was a defect no check had yet
shown. It has a targeted document with its register entries and its control.

75. **A case list filter or a search that asks for a date and time equal to
    a value finds nothing on CommCare, and Preview finds the cases.** Nova
    writes every search comparison as `<property> <op> <value>` whatever
    the property's type
    (`lib/commcare/predicate/csqlEmitter.ts::emitComparisonSegments`), and a
    literal as written
    (`lib/commcare/predicate/termEmitter.ts::emitCsqlLiteralSegment`). HQ's
    receiver rewrites every date-and-time-shaped string of a submission
    before saving it (`form_processor/parsers/form.py::_create_new_xform`,
    `form_processor/utils/xform.py::adjust_datetimes`) as the UTC instant
    with six fraction digits (`dimagi/utils/parsing.py::json_format_datetime`:
    `2026-01-02T04:30:00.000000Z`), whichever writer submitted it (Nova's
    form, HQ's case API, HQ's case importer), so the case, its search index
    entry and a device's restore all hold that spelling. HQ's search
    compares a custom property with `=` as text
    (`case_search/xpath_functions/comparison.py::property_comparison_query`,
    `es/case_search.py::case_property_query`, an exact term on
    `case_properties.value.exact`), and `!=` is its `NOT`; an ordering
    parses the value and compares instants (`case_property_range_query`).
    Executed against HQ at the pin during planning, with cases saved
    through HQ's receiver in twelve spellings of one instant:
    `= '2026-01-02T09:30:00.000+05'` finds none of them,
    `= '2026-01-02T04:30:00.000000Z'` finds all twelve, and every ordering
    finds by instant. HQ's `now()` and `datetime()` print `isoformat()`
    (`value_functions.py::now`, `::datetime_`) and a value Core prints
    carries the device's offset, so nothing Nova sends equals the stored
    text. On a system date HQ sends a date-and-time value as a raw term
    (`_create_system_datetime_query`), which Elasticsearch parses against
    the index's date formats (`corehq/pillows/core.py::DATE_FORMATS_STRING`),
    each of which with a time requires seconds, so the minute-precision
    value the builder's picker writes makes the search fail: executed with
    every reader during planning, HQ answers
    `date_opened = '2026-01-02T09:30'` with a 500 (`ESError`, Elasticsearch's
    `RequestError(400)`, "failed to parse date field [2026-01-02T09:30]"),
    Formplayer answers with its internal-server-error notification, the
    Web Apps client shows HQ's error alert, and Android "Server-side error
    (code 500)". The device's case list filter compares two strings by text
    too (commcare-core `XPathEqExpr.java::testEquality`). Preview compiles
    the same filter in Postgres, which casts the property to `timestamptz`
    (`lib/case-store/sql/dataTypeTokens.ts::POSTGRES_CAST_FOR_DATA_TYPE`)
    and compares instants. *Harm:* a worker's list or search for visits at
    a given time shows none on the device or on HQ while Preview shows
    them; `!=` shows every case; on a system date the search fails.
    *Documents:* `targeted-datetime-equality` (intent,
    `/caseList/rows/*/caseId` on the local export: "Visits" filters `seen`
    equal to a date and time and Core lists none of the one case Nova's
    meaning lists; "Other visits" filters it not equal and Core lists
    every case; with every reader, "Opened visits" searches `date_opened`
    equal to a minute-precision date and time, HQ answers 500, Formplayer's
    walk stops (`proof/walk-stops.json`), and proofs 3 and 4 hold
    Formplayer's answer at
    `/hq/app_aware_remote_search/500/corehq.apps.es.exceptions.ESError` and
    `/runs/*/steps/*/response/exception`).
    *Device half fixed (#783):* `=`, `!=`, `in` and `switch` between two
    dates and times lower to an equality of integer microseconds
    (`lib/commcare/xpath/wire/instant.ts`), exact at that resolution, so
    the device lists the cases Preview lists. Its two entries are in the
    fixed-defect register, held on the control `targeted-datetime-equality`.

    *Fixed (#<PR 10>):* a search's `=`, `!=` and `in` on a date and time
    are a closed instant range (`(p >= v and p <= v)`,
    `lib/commcare/csql/emitter.ts`), which HQ's range query reads in every
    spelling, and a date-and-time literal is held to milliseconds
    (`datetime-literal-precision`), the resolution HQ's index keeps. The
    `csql` native family's `datetime-equality` scenario holds it: HQ's case
    search over cases its receiver saved returns the expected ids, as
    Postgres does. Its four search entries are in the fixed-defect
    register and its walk stop is held on the control
    `targeted-datetime-equality`, which keeps the search from before the
    fix.

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

## Equivalences, each proven by running its readers

These differences are no harm: every reader of the spelling reads both
spellings alike, and tests run each of those readers on both. Each is a
spelling rule (`proof/rules`), named with the tests that prove it, and the
register holds no entry for it. A rule's own test builds both spellings in
HQ, runs Core over both, serves both to Formplayer with HQ's own views and
shows both to the Web Apps client in Chromium; commcare-android's own code
installs both in `proof/android/predicates.py`; and where Connect reads the
spelling, HQ's own repeater forwards both to it.

Three were once held as register entries marked `equivalence`, on the
ground that one of their readers was Android, which no test in the image
could run. Android now runs, and what it showed sorted them:

- finding 54 (below) and finding 42's vertical `start` are rules
  (`search-description-empty`, `tile-vertical-align-start`): Formplayer
  hands the client another value for each, and the client, a device and
  Core read both spellings alike;
- finding 55 (below) is the rule `connect-work-area-empty`;
- finding 40's ten profile settings are not equivalences. A device that
  never held another value reads the two profiles alike; a device an
  earlier profile gave another value reads them apart. They are entries of
  finding 40, as a defect.

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
    and Android does not read it. *Harm:* none a worker sees. Every reader
    is run on both spellings: `proof/rules/test_search_description_empty.py`
    builds both in HQ over a search a menu opens and an inline one, runs
    Core's sessions through the search, serves both to Formplayer (whose
    answers differ only in the description, `""` against a non-breaking
    space) and shows both to the client in Chromium (no description
    element for either, the same screens throughout, and a description that
    holds text shown); a device's install, search screen and walks are the
    same with the element and without (`proof/android/predicates.py::
    test_a_search_description_changes_nothing_a_device_shows`). So the
    spelling is the rule `search-description-empty`, and its seven entries
    left the register. *Documents:* `case-list-browse` and 72 others.

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
    A device opens, walks and saves the form with the empty node as without
    it, and holds the same cases after (`proof/android/predicates.py::
    test_an_empty_work_area_id_changes_nothing_a_device_shows_or_saves`).
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
   defect 42. The vertical alignment it writes (`start`) is laid out as
   absence is by every reader, each run on both spellings, so it is the
   spelling rule `tile-vertical-align-start`.
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

12. **Ten of finding 40's settings are not equivalences on every device.**
    This document held them as differences every reader reads alike. A
    device that an earlier profile of the app gave another value keeps it
    where the next profile names none and loses it where the next profile
    forces the default (run on Android, `proof/android/predicates.py`), so
    they are entries of finding 40 as a defect.
13. **`both_fixtures` is not inert in Web Apps because HQ's saves keep it;
    it is unread there** (README, defect 14). The research says HQ's
    restore gives the flat fixture to an app whose value is `both_fixtures`
    without reading the project space's setting. That holds for a restore
    that names the app, which a device's does; Formplayer's names none
    (finding 69).
14. **"Nova cannot produce" a form that reads the session's supply point**
    (the lane's own step 1 decision, not the research's). Nova's gate
    admits the read (finding 68).
15. **HQ's upload does not stop at 32 characters by refusing a longer tag.**
    The research says HQ's upload reads a 32-character sheet name, which it
    does. A 33-character tag is not refused: the upload checks no length,
    its column holds 32 characters, and the view fails with a database
    error HQ answers as a 500. So removing Nova's 31-character cap needs a
    cap of 32 in its place, held by Nova.

## What HQ does itself

HQ's lookup table upload API answers a successful upload with its message
split one character a line (`fixtures/upload/definitions.py::
FixtureUploadResult.get_display_message` splits its text on a pattern that
matches the empty string), and names its "Upgrade Required" fallback a 402
in its own comment while answering 200
(`accounting/decorators.py::requires_privilege_with_fallback`).
`fixtures/const.py::LOOKUP_TABLE_TAG_MAX_LENGTH` is 31, which HQ's own table
page enforces and its upload does not.

HQ's lookup upload removes a table's description, which no workbook can
carry: the reader builds each table without one
(`fixtures/upload/workbook.py::_FixtureWorkbook.iter_tables`), and the
description is part of the key the upload matches a held table by
(`fixtures/upload/run_upload.py::table_key`), so an upload over a described
table deletes it and makes it again under a new id with no description. HQ's
own download of a described table, uploaded back unchanged, does the same,
with `replace` and without. The table's indexed flags are in that key too,
and no API-key read returns either.

An ID-mapping cell reads with a leading space for every entry but the first:
HQ joins every entry's text with a space
(`suite_xml/xml_models.py::XPathEnum.build`, `replace(join(' ', …))`), and
Nova's local archive writes the same, so the two paths agree and no check
reports it.

HQ's case search notes a search filter (`_xpath_query`) as a use
of Advanced Case Search where the project space lacks it: HQ's search calls
`_require_case_search_advanced` for every such filter
(`case_search/utils.py::CaseSearchQueryBuilder._apply_filter`), which
reports "Advanced case search feature attempted" (`notify_exception`) at
most once per project space per day, since its answer is cached a day by
project space (`_require_case_search_advanced`, `quickcache` with a
24-hour timeout). Finding 53's filter meets it.

50. **A follow-up form that opens one child case draws HQ's registration
    alert.** HQ counts a form with one child case outside a repeat a
    registration form (`models/forms.py::Form.is_registration_form`) and maps
    a case name only from the form's own case
    (`form_action_diff.py::get_case_mappings`), so Vellum's save alerts "This
    registration form is missing a case name." (`src/caseManagement.js`,
    pre-save validation). HQ shows the same alert for a form of that shape its
    own editors make, and nothing Nova can spell removes it: proof 4 leaves
    it out where HQ counts the form so (`proof/checks/hq_own_reports.py`,
    `registration_alert_child_case`, proven on a form made in HQ's own
    pages by `proof/editors/test_hq_own_registration_alert.py`). *Harm:* an
    alert on every save; the save goes through. *Documents:*
    `nested-menu-previous`.

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
    It is HQ's own download arrangement and Android's own installer, and
    Nova's export takes no part in it, so no register entry ever named it.
    *Documents:* every document whose build names media.

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
    CommCare's own reader, the same on HQ's build and on Nova's local
    archive, so no export path avoids it; Nova could leave the datum out
    only by giving up what HQ's build reads it for. The reader that fails
    is commcare-core's `SessionDescriptorUtil.loadSessionFromDescriptor`,
    as commcare-android's `AndroidSessionWrapper.loadFromStateDescription`
    calls it, and an app made in HQ's own pages with grouped tiles stops
    the same way: proof 1 leaves the reopen out where the stored session
    ends at that datum's id and home raised so
    (`proof/checks/hq_own_reports.py`, `android_grouped_tile_reopen`,
    proven by `proof/android/test_hq_own_grouped_tile_reopen.py`, which
    fails at a commcare-core pin that reads such a session). *Documents:*
    `tile-grouped-one`, `tile-grouped-two`, `tile-grouped-search`
    (`android@B` and `android@local.ccz`, proof 1,
    `/update/reopened/*/session`).

What Connect does with a renamed block (defect 15's Connect ids, whose fix
renames them): Connect keys an opportunity's rows by each block's id
(commcare-connect `form_receiver/processor.py::get_or_create_learn_module`,
`get_or_create_deliver_unit`, `process_task_modules`), so a rename under an
opportunity that holds the old id breaks it, whoever renamed the block. On the two
documents whose edit renames their Connect ids (`targeted-connect-deliver-rename`,
`targeted-connect-learn-rename`), with the opportunity made from A's release
and B-edit's submissions forwarded to it (`connect@B-edit@…`, proof 4):
Connect refuses every delivery of the renamed deliver unit (400, "Payment unit
is not configured for the deliver unit", `/runs/*/refused/400/…`), and HQ
does not send a refused forward again; the receiver makes a second learn
module of the renamed one (`/runs/*/catalog/learnModules/added`), so a
learner who finishes the course stands at half; and the renamed task
completes no task the worker was assigned. Each is reported with the ids that
moved (`/ids/deliver/moved`, `/ids/task/moved`, `/ids/module/moved`), and the
Connect judge leaves each out where the edit renamed that block
(`proof/checks/hq_own_reports.py`, `connect_block_renamed`), since an app
whose block is renamed in HQ's own form builder meets the same
(`proof/connect/test_hq_own_rename.py`). What Nova owns is the order of a
rename and the manager's payment unit for the new id.
`proof/connect/test_receiver.py` runs what a manager can do after it (asking
for the units again and paying for the new one restores deliveries; nothing
restores the learner or the assigned task).
