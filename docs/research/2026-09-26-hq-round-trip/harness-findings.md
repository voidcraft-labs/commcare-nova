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
    holds the default language); Android's language picker shows no current
    language. *Documents:* every document (the trace's `/locale`).

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
    loosens GPS accuracy, skips media checks and overrides workers'
    preferences. *Documents:* every document.

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
    `FormEntryInstanceState.getDefaultFormTitle`). Defect 14's fix for the
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
    search rows). *Harm:* on Android the worker sees HQ's error instead of a
    message about the answer. *Documents:* 40, the quote family among them.

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

56. **A Connect block named like one of Connect's own keys fails Connect's
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
    succeed. Run for a task whose id is `task`
    (`proof/connect/test_receiver.py`, with the accepted case: the same form
    with a task named `follow_up`); the other four names rest on the same
    expression, read at source and not run. HQ's own form designer names
    the wrapper by the question's id as well, so an app made there with
    such an id fails alike. *Fix:* the validator refuses the five names as
    a Connect id, each only in the app type whose receiver reads it.
    *Documents:* `connect-deliver-default`, `connect-deliver-custom` (the
    task of both is `task`).

57. **A deliver form that also holds a task loses its own visit while the
    task is assigned.** Nova lets one form hold a deliver unit and a task
    (`lib/domain/forms.ts`). Connect's receiver reads the deliver unit
    first and rejects the visit while the worker has an assigned task of
    the app ("Worker has an incomplete assigned task.",
    `processor.py::process_deliver_unit`, `_has_blocking_pending_task`),
    and only then completes the task from the same submission
    (`process_deliver_form`). *Harm:* the delivery made in the submission
    that completes a task is always rejected and unpaid; the next one is
    approved. Run in Connect (`proof/connect/test_receiver.py`).
    *Documents:* `targeted-connect-deliver-rename`, `connect-deliver-default`.

## Equivalences only another runtime reads

These differences are no harm: every runtime that reads them reads both
spellings alike. Their readers are runtimes the lane does not run (Android,
Web Apps' client), or were when the entry was written, so no spelling rule's
test can prove them alike, and
the register holds them, each entry marked with its `equivalence`. Connect's
are now run by the Connect proof (`proof/connect`), which holds finding 55's
two spellings to the same rows in Connect. Beside the
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
    (`proof/connect/test_receiver.py`).
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
