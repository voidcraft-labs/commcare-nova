# Step 2, part 11: The pull-request stack, contracts and docs

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part owns no defect and no finding, so it carries no Today / Fix block of its own. It orders the work the other parts plan into one stack, gives the checklist every model addition follows, and lists every contract sentence, public docs page and sibling plan this step rewrites. Where a pull request is named by number elsewhere in this plan, the number is the one in the table below. Every cutover step id, notice reason and blocker code in this part is the one part 10, The transform steps, in order, Changes that write nothing and still get a line, and the scan's blocker table register; that registry is the one list, and this part's table only says which pull request adds which.

The stack is cut over the proof lane as its own pull request merges it onto `main` at `7b153dc3` or later (part 09, the opening). Counts are of that lane's `proof/known-defects.json`, by id, from part 09, The entry accounting: 885 entries, of which step 2 moves 669 to `proof/fixed-defects.json`, deletes 12 and leaves 204 to later steps. `proof/rules/__init__.py::RULES` holds 36 spelling rules there.

## The stack

One `gh stack` chain of sixteen pull requests, merged together for one deploy. Each row's "Green alone" is in addition to the repo's ordinary checks at that pull request's own head: typecheck, lint, Vitest with Postgres, the production build, the pull request lane in CI, the Playwright smoke and the Python infra tests. Before it is marked ready, each row also runs its reader slice on a proof machine, which is exactly the document and control of every served-reader entry it moves, registers, re-files or deletes and of every held walk stop it moves, removes or adds, plus its witnesses, the targeted documents of a fix with no entry and the document of a judge change no entry names, and with them the reader package tests the pull request itself adds or changes (part 09, Where the lane runs, states the rule once), and, where it changes an emitter, adds a corpus document or changes a gate entry, the sensitivity check whole and fresh; the whole lane with every reader runs once, at row 16's head, before the merge (part 09, Where the lane runs). "Register" counts entries by id: "moves" are entries that leave `proof/known-defects.json` for `proof/fixed-defects.json`, "adds" are entries the pull request registers live, and "deletes" are entries that leave a register for neither: with a judge change or an allowance, in pull request 3 because the entry beside it comes to hold the one difference the two pinned, and in pull request 13, from the fixed register, because the lane's oracle grants a control a privilege under which it stops showing them (part 09, What step 2 moves and deletes).

The files each pull request touches are under Files, by pull request, below the table: the list an implementer holds a diff against. For pull requests 1, 2, 3 and 5 the Contains cell gives the headline, and each of those four opens its list there with the whole.

| # | Title | Contains | Files | Register | Rules | Cutover steps, notice reasons and blockers | Green alone |
|---|---|---|---|---|---|---|---|
| 1 | Lane mechanics | The lane's own mechanics: `proof/fixed-defects.json` with its loader, gate, queue and fingerprint; a held walk stop that names a control; the name argument (`--as`) on control retention; `targeted-hq-side-state` split, and `targeted-shared-property-sort` given its second menu; targeted documents, entries and controls for findings 43 (`parsererror`), 56, 57, 70 and 71; `HQ_OWN_REPORTS` with its three members; the build recreated under a stored part. No emitter change. In full under Files, by pull request, below | Below | Writes finding 52's 2 straight into the fixed register on `expander-form-hashtag-expansion-declares-the-casedb-02e7ce76-0`. Adds 29 live: finding 56's 2, finding 57's 17, finding 70's 6, finding 71's 2 and finding 43's 2 (part 09, The entries step 2 adds). Re-documents defect 5's seven `d5-table-content-*` entries on `targeted-hq-side-lookup`, their control `targeted-hq-side-state` unchanged (part 02, Defect 5: the lookup push, Lane; part 09, Corpus changes). Walk stops: adds `targeted-datetime-ordering`'s, Formplayer's `submit-refused:validation-error`, with the document (part 09, The held walk stops). Deletes 9 with their members: finding 50's 2, finding 67's 2 and defect 15's 5 Connect rename entries, with the controls `nested-menu-previous`, `tile-grouped-one` and `targeted-connect-learn-rename` | `vellum_alert` retires | none | Proof 4 shows no `alert` difference on any corpus document; the gate holds finding 52's two fixed entries on their control and every control directory is named; no product change |
| 2 | Cutover skeleton, the notice and the ledger tables | The fold-horizon DDL and writer with an empty step list; the notice, in the builder, on the home line and over MCP; the Job `commcare-nova-hq-round-trip-cutover` with its runbook and its frozen pre-step fixtures; every additive ledger table and column, in three migrations; the three pre-horizon readers, `RUNTIME_VERSION` 15 and the frozen fold. In full under Files, by pull request, below | Below | none | none | The transform runs zero steps: a horizon over an unchanged document. Document reason `unsaved-assistant-work-discarded`; deployment reason `deep-links-need-republish`. Blockers `target-parse`, `target-gate`, `target-export-readiness`, `case-schema-change` | Writer Postgres tests over the frozen fixtures with zero steps; deployment store Postgres tests; the infra tests with the Job; nothing shows in the product |
| 3 | Identity and the publish sequence | Defect 1 and findings 32, 49 and 59; `localization.wireCodes`; the shell create then the in-place update, with the `target-app` preflight edge, the read after the shell create and the second read after a table or place push, all through `readHqAppSource`; downloads by project space; no `multimedia_map`; the manual-import guide and the ZIP; the proof capture's two-import first publish with its layout marker and the marker's reader; the spelling rule `runtime_url_app_id`; nineteen classes registered live, with nine controls. `MODEL_CONTEXT_VERSION` does not move. In full under Files, by pull request, below | Below | Moves 31: defect 1's 8, finding 32's 20, finding 59's 3; two of them leave by the new rule. Deletes 1: one of defect 20's two entries that each pin a drawn `xmlns`; the other is pinned to the one derived `xmlns`, and their control `targeted-supply-point-read` is retained again in place (part 01, A1; part 09, What step 2 moves and deletes). Adds 19 live on `formplayer@local.ccz`, on the nine `-after-59` controls: fourteen leave with their owner's fix (six in pull request 5, two of them deleted there, one in 6, six in 9 and one in 11), and defect 24's 5 stay live, step 5's (part 09, The entries step 2 adds, which gives each entry with its control and its pull request) | `runtime_url_app_id` is added | Step `language-wire-codes` (no reason: no deployed code moves). The Job's deployment reads write `app_deployment_identities` (the cutover's one `ApplicationResource` read writes nothing else), and a deployment whose HQ app they find gone takes `remote_missing_at` with the folded `remote_app_missing` failure; deployment reasons `menu-id-changes-once`, `form-ids-change-once`, `ids-change-once-unreadable`, `hq-app-deleted`, `hq-app-not-nova-made`; no-write document reason `ccz-needs-project-space`. Blocker `app-mapping-without-pushed-revision` | Proof 1 holds no defect 1 entry; Formplayer's submission from the local archive shows no class at its `path`; its reader slice is seventeen documents in two runs, each beside every control its entries name: sixteen under Formplayer and Android, `search-hidden-link` (the second document the submit-label entry shows on) and `fuzz-suite-20260930-8` (the witness of the judge change to `merged_text_ids`, which no entry names) among them, and `targeted-supply-point-read` with the control A1 retains again under Web Apps and Android (part 01, A5, Lane); `proof/corpus/__tests__/publish.postgres.test.ts` runs the real `publishAppToHq` three times and asserts the three send the same menu id, form id and `xmlns` in every import body (part 01, A3. The publish sequence, Nova tests) |
| 4 | Drift and baselines | Work item B: the comparator, the `target-app`, `project-data` and `organization` comparisons, `hq_changed`, the bound discard, the shell's exemption (while a baseline's origin is `create` the app comparison reads only `modules`), the capture's confirmed discard for `hqSide` documents, `StepOutcome`'s `stopped`, the retained reads under `proof/hq-reads/`, written by `proof/hq/test_retained_reads.py`, which publishes five documents | Below | none: defect 5's seven table entries on `targeted-hq-side-lookup` stay live and still show | none | The Job's baseline reads, outside the per-app transform; deployment reasons `next-publish-overwrites-hq-edits`, `next-publish-asks-before-overwriting` | Comparator tests over the retained reads; the lane regenerates and byte-compares `proof/hq-reads/` |
| 5 | App-level emission | Defects 2, 4, 7, 8, 9; findings 34, 39, 40, 62, 65; `BlueprintDoc.appSettings` with `setAppSettings` and `apps.app_settings`; the overlay module `lib/commcare/targetOverlay.ts`; one local archive per configuration in the corpus; the judge, manifest and surface changes these need; two controls retained and one removed; `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission"` (`update_app`). In full under Files, by pull request, below | Below | Moves 126: defect 2's 1, defect 4's 10, defect 7's 6, defect 8's 2, defect 9's 5, finding 34's 8 (7 of the base and the one pull request 3 added), finding 39's 2, finding 40's 82, finding 62's 2, finding 65's 8 (5 of the base and the 3 pull request 3 added). Three of them move under a judge change that leaves each showing on its control: defect 9's Android update entry and finding 40's two worker-setting entries (part 09, What step 2 moves and deletes). Deletes 4 with the form-version judge change, which no control shows afterwards: defect 9's 2 of the base and the two pull request 3 added. Adds 3 live: defect 15's pinned proof 1 entries on `targeted-invalid-question-ids-after-9` (moved in 10). Adds none for the new edit kind, which changes no register outcome (part 09, How the harness keeps publishing as Nova publishes, Mutation kinds). Walk stops: adds the control entry of `targeted-invalid-question-ids-after-9` (part 09, The held walk stops) | `profile_required_minimal` retires; `profile_unread_properties` widens to `app.json` | Step `app-settings` (`android-form-lists-setting-stored`). No-write document reasons `validation-now-enforced`, `local-archive-changes`; deployment reasons `setting-changes-at-next-publish`, `settings-unknown-unreadable`, `worker-settings-reset-at-next-publish` | The intent check holds the local versions to the document sequence; no `/profile/properties/<key>` difference on any document; each configuration's A matches its own local archive; proof 5 reports no form's data `version` outside an edit's footprint |
| 6 | XForm, first part | Leaf `constraint` attributes removed; no `#case/` shadow (findings 45 and 47); the datetime leaf; relative defaults, their four placements held on Core by one new `ContainerRuntimeTest` test over the container fixture's `init-add` form; the registration case-id read, its three users held on Core on both paths, a default and a calculation by a second new `ContainerRuntimeTest` test over the fixture's `registration` form and an extension child's parent index by two new `CaseCaptureRuntimeTest` tests; Vellum's fill for blank translations, the leaf-label rule and `SELECT_OPTION_LABEL_EMPTY`; finding 55; the ref-less repeat group; finding 46 with the data node name, and proof 2's version clause reading a form's bytes, which leaves none of the lone version's six paths (the form's, the suite's and the trace's, and Formplayer's three); the emission test that closes work item H, with `proof/README.md`'s two rows for the clause (part 09, Work item H); the control `container-query-conditional-after-13`, retained from this pull request's corpus for defect 25's new classes; targeted document `targeted-blank-labels`; `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission.6"` (the authoring guide's prose) | Below | Moves 69: defect 13's 45 (13 leaf constraint, 8 shadows, 5 datetime, 4 defaults and case-id read, 15 translations), finding 45's 5, finding 47's 4, finding 46's 6, defect 14's 7 data node name entries (6 of the base and the submit message pull request 3 added), work item H's 2. Adds 62 live of defect 25's on `container-query-conditional-after-13` (step 5's) | `connect_work_area_empty` retires | Step `option-labels` (`option-label-filled`) | `d41-empty-list-text-app-no-items-text` still shows on `localization-optional`; defect 25's two entries and defect 27's three stand at their paths |
| 7 | XForm, second part | Containers as groups; the rename, with the validator code `RESERVED_FIELD_ID_PREFIX` and its rule retired; `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`; guards as update-only Save to Case blocks; conditions in `nova_condition_` groups; reads between blocks through `current()`; the root keyed create inside its one-row repeat; six new controls, each retained from this pull request's corpus under `<document id>-after-13`: `case-capture-multiple-after-13`, `case-extension-multiple-after-13`, `case-extension-multiple-repeat-after-13`, `case-extension-query-after-13`, `case-extension-registration-after-13`, `case-extension-repeat-after-13`; `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission.7"` (`operationIdInputSchema`) | Below | Moves 158: guard blocks 80, reserved names 25, wrapper containers 6, wrapper conditions 32, the root create id 14, and the datetime leaves' Formplayer entry, which shows until the guards and wrapper conditions are fixed. Re-paths defect 23's 70 entries from this run's evidence, Formplayer's two among them, and points them, defect 23's manifest entry on those documents and defect 24's 15, at the `-after-13` controls | none | No document step; deployment reason `data-paths-move-once` | Every later-step entry still shows on its document, defects 23 and 24 on their `-after-13` controls and the rest on the controls they name today; `names.py` still reads `__nova_` names on the old controls |
| 8 | Defect 3 | `lib/commcare/xform/caseSaveReferences.ts`; `save_differing_from_vellum` returns False for the derived map; the intent check reads `case_type` as a standard property, which HQ learns from every Save to Case create's list; the control `case-capture-multiple-after-3`, retained from this pull request's corpus (`--as`) for the two intent classes an attachment under a Save to Case block keeps showing; `proof/README.md`'s "Intent checks" gains that `case_type` is a standard property | Below | Moves 3: defect 3's. Adds 2 live of defect 23's on `case-capture-multiple-after-3`, `d23-attachment-form-case-updates-attachment-under-save-to-case` and `d23-attachment-data-dictionary-attachment-under-save-to-case` (step 5's; part 04, Defect 3) | none | none | Defect 3's proof 4 class shows on no document; its two intent classes show on `case-capture-multiple` alone, held there by defect 23's two new entries; the manifest check reports no `save-differing-from-vellum` use |
| 9 | Case writes through basic actions | Finding 33 (`nova_trimmed_<question>`), finding 37, finding 66 (update properties in name order), `update_case` `always`, close conditions moved to Save to Case, `external_id` as an update row; `case-extension-query-after-13`, `case-extension-repeat-after-13` and `expander-form-links-emission-forwards-literal-condition-47c96355-0` retained again in place; `proof/targeted/documents/echo.ts::answerHeld` takes a session for the nine documents whose expectation answers a question in a write-free follow-up form (part 09, Corpus changes); `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission.9"` (the `close_condition` descriptions) | Below | Moves 78: defect 14's 52 (non-writing follow-up 21, close conditions 29 and the 2 pull request 3 added), finding 33's 19 (17 of the base and the two submitted case names pull request 3 added), finding 37's 6 (3 of the base, the two submitted block orders pull request 3 added, and `d24-inert-subcase-formplayer-local-ccz-item-id-order`, the repeat item's position on `case-capture-query`, which the lane files under defect 24), finding 66's 1. Re-files `d14-non-writing-followup-soft-assert-casedb-base-get-case-from-case-update` under defect 26 as `d26-a-link-names-no-case-soft-assert-casedb-base-get-case-from-case-update` and adds its proof 3 twin `d26-a-link-names-no-case-soft-assert-proof3-casedb-base-get-case-from-case-update`; both stay live, step 5's (part 06, 1; part 09, The entries that remain). Adds 6 live of defect 24's on the two `-after-13` controls (step 5's). Walk stops: `targeted-close-condition-unparsable`'s moves to its control | `case_block_position`, `update_never_beside_actions` retire | No document step. No-write document reasons `follow-up-now-touches-case`, `linked-follow-up-now-writes-case`, `close-moves-to-save-to-case`, `case-name-now-checked` | The lane passes without both rules; defect 24's five trace and three Formplayer entries stand at their paths, and the five pull request 3 added on Formplayer's submissions stand on their `-after-59` controls |
| 10 | Identifiers and form content | Defect 15 with its Connect forwarding; findings 31, 43, 44, 60, 61, 68, 70, 71 (a read of the form's root, refused under `INVALID_REF`, and in a catalog property's `required` and `validation` under `CASE_PROPERTY_REFERENCE_INVALID`); case operation ids, link identifiers, the Connect id minter; `CONNECT_DELIVER_FORM_HOLDS_TASK`; the rename allowance `connect_block_renamed` widened to the renamed task's `task-completed-nothing`, which shows once the task has a form of its own (part 09, Connect's own reading of a renamed block); `SESSION_DATUM_NOT_SUPPLIED`; `CASE_PROPERTY_NAME_STOPS_FORM_BUILDER` (finding 43); `SELECT_OPTION_VALUE_DUPLICATE` and `CASE_PROPERTY_OPTION_VALUE_DUPLICATE` (finding 44); `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission.10"` (the operation, link, entry-point and Connect id inputs) | Below | Moves 68: defect 15's 16 (13 of the base and the 3 proof 1 entries pull request 5 added), finding 68's 30 (filed under defect 20; part 09's re-homing rule, fourth case; pull request 3 deleted the thirty-first), finding 31's 1, finding 43's 5 and the 2 pull request 1 added, finding 44's 4, finding 60's 1, finding 61's 1, finding 70's 6, finding 71's 2 (both findings' added in pull request 1). Walk stops: `targeted-invalid-question-ids`'s and `targeted-supply-point-read`'s move to their controls, and `fuzz-xform-20260930-10`'s is removed, since finding 71's draw puts rows after the repetition that holds its date and time question (part 09, The held walk stops). Re-documents `d14-logos-media-unmatched-logo-refs` on `expander-form-hashtag-expansion-keeps-an-unresolvable-f5cf70e7-0`, where the removal of the two duplicate-option documents moves `setAppLogo` | none | Steps `question-ids` (`question-renamed`), `case-operation-ids` (`case-operation-renamed`), `connect-ids` (`connect-block-renamed`), `connect-task-forms` (`connect-task-moved-to-own-form`), `entry-point-ids` (`entry-point-renamed`), `option-values` (`option-value-split`), `empty-forms` (`empty-form-label-added`), `unsupplied-session-reads` (`session-read-removed`). Blockers `unresolved-relative-path`, `link-identifier-reserved`, `reserved-property-write`, `form-root-read` | `targeted-invalid-connect-ids` stays a Connect app; `index.json` ids diffed: eight documents leave (part 09, Corpus changes) |
| 11 | Case lists | Defects 10 and 16 (hidden columns); findings 35, 36, 38, 41, 42, 51, 54, 57; finding 67's builder, tool and docs copy; tiles; sort spellings; the straight apostrophe in a date pattern; `lib/domain/caseListOrder.ts::caseListOrderPlan`; `CASE_LIST_SORT_PROPERTY_AMBIGUOUS`; `CASE_TILE_HIDDEN_CALCULATED_SORT` (a hidden order rule on a calculated column or a column over `case_id` in a custom-tile list); `CASE_LIST_DATE_PATTERN_APOSTROPHE`; `CASE_LIST_ID_MAPPING_KEY_CHARACTERS` (an ID-mapping value holding `&`, `<`, `>`, `"` or `'`); the oracle's `HQJSON_BAD_SORT_ELEMENT` and `HQJSON_BAD_DETAIL_FIELD`; `lib/domain/modules.ts::caseListColumnIsEmitted` replaced by `caseListColumnRuns` and `caseListColumnTextShows`; targeted documents `targeted-attribute-columns`, `targeted-hidden-calculated-column` and `targeted-tile-hidden-order`; the control `targeted-custom-tile-explicit-cells`, retained from this pull request's corpus with the `CASE_LIST_TILE` configuration; `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission.11"` (the case-list-config schemas and `update_module`, which holds the same column arms, the date pattern description, `set_case_list_tile`, the `grouping` description) | Below | Moves 91: defect 10's 6, defect 16's 1, findings 35 (2), 36 (6), 38 (6), 41 (5), 42 (9), 51 (6: 5 of the base and the sort keys pull request 3 added), defect 14's 33 tile entries (the tile clause's 18, tile cells' 15), and finding 57's 17 that pull request 1 added. Adds 13 live of defect 12's on `targeted-custom-tile-explicit-cells` (moved in 13): the ten classes defect 14's and finding 42's entries held under `CASE_LIST_TILE`, and the three vertical-alignment classes the retired rule erased there | `sort_display_empty`, `sort_type_plain`, `sort_blanks_default`, `sort_calculation_pair`, `search_title_empty`, `search_description_empty`, `tile_vertical_align_start` retire | Steps `id-mapping-keys` (`id-mapping-entry-removed`), `date-patterns` (`date-pattern-apostrophe-replaced`), `tile-hidden-calculated-sort` (`tile-order-rule-removed`), `sort-property-ownership` (`order-rule-removed-same-property`, `order-rule-moved-to-first-column`), `tile-cells` (`tile-cell-defaults-set`). No-write document reasons `case-list-order-changes`, `case-list-search-matches-hidden-fields`, `hidden-order-column-not-in-sort-menu`, `record-id-column-now-shows` | The test `keeps the positional calc join aligned for an off-Results sort carrier` of `lib/commcare/__tests__/expander.test.ts`'s `sort_elements` block, whose first document is `expander-expanddoc-hq-json-projection-sort-elements-keeps-67fa0ac7-0`, keeps its title and its document count, so the document keeps its id; the lane passes with 25 rules |
| 12 | Menus, navigation and search settings | `postSubmit: firstMenu` and `parentMenu` with `POST_SUBMIT_NOT_OFFERED`; `hiddenFromMenu` with `HIDDEN_MENU_NOT_A_DESTINATION` and `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU`; finding 58's link copy; the search button label removed; lookup prompt sort; reserved input names (`CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER`, `CASE_LIST_SEARCH_INPUT_NAME_RESERVED`); survey menus; the codes `DISPLAY_CONDITION_ALWAYS_FALSE`, `POST_SUBMIT_MODULE_CASE_LIST_ONLY` and `SEARCH_FIRST_NO_PREVIOUS_WORKFLOW` retired; four of block 10's equivalent spellings (`no_vellum` and `custom_variables` omitted, a calculated column's format written `plain`, the one `name` column on an empty short list; part 06, 10. The equivalent spellings); finding 53's local sentinel; targeted document `targeted-hidden-from-menu`, and `targeted-search-button-label` deleted with its maker; `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission.12"` (`post_submit`, `hiddenFromMenu`, the search inputs and their `sortColumnId`, `set_case_search_display`, the `add_form_links` and `update_form_link` descriptions, the `displayCondition` description, the entry-point `ignoreDisplayConditions` descriptions with `add_entry_point`'s own, and `FORM_ENTRY_DESCRIPTION`) | Below | Moves 26: defect 14's 21 (multi-select destinations 3, search button label 7, lookup prompt sort 3, reserved input names 7, survey menus 1) and finding 53's 5 | none | Steps `search-button-label` (`search-button-text-changed`), `reserved-search-inputs` (`search-input-renamed`, `search-input-removed`), `hidden-from-menu` (`hidden-from-menu-set`), `post-submit` (`after-submit-destination-moved`). No-write document reasons `lookup-choices-order-changes`, `survey-menu-takes-case-type`. Blocker `hidden-menu-is-a-destination` | `targeted-form-links-hidden-and-fallback` stays admitted, and defect 26's entries on it stay live |
| 13 | Publish gates | Defect 12's probes; `lib/commcare/planPrivileges.ts::requiredPlanPrivileges` and `hq_confirmation_needed`, with `NovaPublishVerdict.planPrivileges` over D and D′ and the lane oracle's `user_case` arm over link and datum `xpath`; the version floor (`hq_app_version_below_floor`); the flat fixture with finding 69's copy; Data Forwarding and the Connect forwarder (C8), with the lane's `privilege/data_forwarding` rule in place of its seam; finding 64's equality-test exclusion (C7); logos, with the oracle's `checkLogoRefs` and its code `HQJSON_BAD_LOGO_REF` removed; `withdraw_deployment_confirmation`; `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission.13"` (`set_app_logo`'s description) | Below | Moves 50: defect 12's 35 and the 13 pull request 11 added, defect 14's 2 logo entries. Deletes 6 from the fixed register, the `d14-android-proof4-case-management-*` entries pull request 9 moved on `expander-form-links-emission-emits-hq-form-links-with-3555b968-0`, and removes that control: the oracle's `user_case` arm now grants it `USERCASE`, and it stops showing them (part 09, What step 2 moves and deletes). Registers none for the soft assertion that `expander-form-links-emission-emits-hq-form-links-with-3555b968-0` shows in proof 3 and proof 4 once it runs with `USERCASE`: pull request 9's two entries of defect 26 hold it (part 09, The entries that remain). Walk stops: the seven related-lookups stops leave their documents, two to their controls (`targeted-search-related-lookups`, `expander-expanddoc-hq-json-projection-search-config-lifts-16e452f3-0`) and five removed (`function-arguments`, `prompt-guards`, `search-parent` and the two `expander-expanddoc-hq-json-projection-case-search-` documents, `-4d53ba11-0` and `-cd8e0ffa-0`) | none | No document step; deployment reasons `next-publish-asks-more`, `commcare-version-below-floor`, `logo-upload-in-hq` | Defect 14's and finding 42's tile entries are fixed and defect 12's thirteen new entries hold on their own control, so removing `targeted-custom-tile`'s `CASE_LIST_TILE` configuration strands nothing; `NovaPublishVerdict.planPrivileges` equals the lane's oracle on every corpus document |
| 14 | Lookup, CSQL, media and the model clean-up | Defects 5, 6, 11 (first half), 16; correction 15 (the 32-character cap pinned); finding 48; the Hidden Value with neither a calculate nor a default; the code `XPATH_TIME_ORDERING` added, and `HIDDEN_NO_VALUE`, `FIXTURE_REFERENCE_NOT_MODELED` and `LOOKUP_TAG_TOO_LONG_FOR_HQ` retired; targeted document `targeted-time-ordering` deleted, since no admitted document can order a time; the gate refuses a time ordering and, on a system date, `is-blank` and the null literal, while its rule for a date against a system date does not change, and the witness is authored as a date turned into a date and time (part 08, Defect 6, "The witness"); the judge's `time_operand` reads the three system dates, without which the witness's comparison on the local suite is an undecided use, and its protected-message reader takes a message that holds all four `__nova_mode;<medium>` forms or none, the same in every translation, because a retained control keeps the four; `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission.14"` (`attach_field_media`'s slots, the authoring guide's File and Hidden Value lines, the search input description), the value the stack deploys | Below | Moves 24: defect 5's 9, defect 6's 12, finding 48's 3. Walk stops: `targeted-lookup-reserved-tags`'s and `targeted-search-hq-compile`'s move to their controls | none | Steps `media-slots` (`media-slot-removed`), `hidden-inert-default` (`hidden-value-saves-blank`), `time-ordering` (`time-comparison-never-true`, `search-term-matches-nothing`; it migrates no search input, since no stored input can hold a time range, and it sets no flag). The Project-level lookup tag rename as a Job step (`lookup-tag-renamed`); deployment reason `lookup-table-content-unsupported`. Blockers `lookup-tag-unparsable`, `lookup-tag-rename-collision` | `targeted-search-hq-compile` takes its last edit and stays as a passing document. The one billed schema check of the stack is asked for at this head. Its smoke job in CI installs WebKit and runs `e2e/tests/browser/media-play.spec.ts` in both browser projects, and its author runs the Android decode probe (`python3 -m unittest proof.android.decode.probe -v`) on an Apple-silicon Mac with the emulator's arm64 images of API 23, 29 and 35 before it is marked ready, because no proof machine and no CI runner boots them (part 08, Defect 11, first half, "Lane") |
| 15 | Contracts and public docs | Every row of "Contract sentences" below not already moved; `content/docs`; `proof/checks/test_registers.py::test_every_live_defect_is_a_later_steps` over the new `proof/checks/registers.py::OPEN_DEFECTS`; `proof/timings.json` refreshed in both profiles, `no-readers` from this head's fresh run without the readers and `readers` from the whole lane's run at the stack's top, committed here before the maintenance image is built (part 09, The lane's cost) | Below | none | none | none | The docs build; `proof/known-defects.json` holds the 282 entries of defects 20, 21, 23 to 28 and 30 and finding 56, and nothing of a step 2 defect or finding; `proof/checks/registers.py::OPEN_DEFECTS`, which this pull request adds (part 09, How the exit is checked without a third HQ state), names 56 as the only key from 31 up |
| 16 | Removal of the cutover tooling | The two scripts; `scripts/lib/hqRoundTripCutover/` with its tests and `fixtures/pre-step/`; the `biome.json` line that leaves the committed fold out of lint (`!!scripts/lib/hqRoundTripCutover/prestep/*.generated.mjs`, which pull request 2 adds and which names a directory this pull request removes); the `esbuild` line in `Dockerfile` stage `maintenance-build`; the Job `commcare-nova-hq-round-trip-cutover` in `config/deployment-jobs.json`; its arm in `scripts/rollout/deploy-cloud-run.py::_effective_execution_args`; their cases in `scripts/infra/tests/` and `scripts/infra/__tests__/containerArtifacts.test.ts`; the Job's paragraph in `docs/architecture/deployment.md` and its line in `scripts/README.md`; the runbook `docs/plans/hq-round-trip/2-cutover-runbook.md`; the lane's `cutover` group (its cases in `proof/hq/test_retained_reads.py` and `proof/hq-reads/cutover/`); and this plan, which is `docs/plans/hq-round-trip/2-emission-and-publish.md` with its part files under `docs/plans/hq-round-trip/2-emission-and-publish/` | Below | none | none | none | Infra tests without the Job; `git diff --stat <15>..<16> -- lib app` prints nothing; the whole lane with every reader at this head, before the merge |

Totals the stack reaches: 724 entries move to `proof/fixed-defects.json` (31 + 126 + 69 + 158 + 3 + 78 + 68 + 91 + 26 + 50 + 24): 669 of the base register and 55 the stack itself registered. 14 are deleted from the live register: 12 of the base register (finding 50's 2, finding 67's 2 and defect 15's 5 Connect rename entries in pull request 1, with their allowances; one of finding 68's two `xmlns` entries in pull request 3, where the other comes to hold its difference; defect 9's 2 form-version entries in pull request 5, with their judge change) and the two pull request 3 registered for defect 9's form version (pull request 5). 2 are written straight into the fixed register (finding 52's). The stack registers 135 live entries: 55 of them move, 2 are deleted, and 78 stay live (finding 56's 2, defect 25's 62, defect 24's 11, defect 23's 2, defect 26's 1). One entry is re-filed from defect 14 to defect 26 in pull request 9 and stays live. Pull request 13 deletes 6 of the moved entries from the fixed register, with their control. At the exit `proof/fixed-defects.json` holds 720 and `proof/known-defects.json` holds 282: the 204 later-step entries of the base, the re-filed one among them, and those 78. 12 spelling rules retire, 1 is added (pull request 3) and 25 stand at the exit, one of them widened. `proof/controls/` goes from 85 directories to 105, every one named. `proof/walk-stops.json` goes from 33 held stops to 29: 20 stay on their documents, 7 move to a control, 6 are removed and 2 are added, one on a document in pull request 1 and one on a control in pull request 5, so 21 are on a document and 8 on a control at the exit (part 09, The held walk stops).

## Files, by pull request

This is the list an implementer holds a pull request's diff against, and no summary. Under each pull request it names every file the parts' Files, Nova tests and Lane sections give that pull request, by name or by the directory that holds it. Every path is written from the repository root, one to a line, in up to six lists: Nova source, Nova tests named outright, the lane, scripts and the cutover, CI and config, and docs. A file is named outright where the pull request creates, deletes or moves it and where it is a test the fix turns, and its line says "new", "deleted" or "moved"; a directory stands for the files under it that the parts name. A line carries at most a few words on what changes in the file. What the change is for is in the row's Contains cell and in the part. Pull requests 1, 2, 3 and 5 contain more than a table cell reads well, so each of those four opens here with its Contains in full, one item to a line.

Five kinds of file are given once, here, and are named under a pull request only where the edit is that pull request's own subject. A source file stands for its tests in the `__tests__` directory beside it. A pull request that moves, adds or deletes an entry edits `proof/known-defects.json` and `proof/fixed-defects.json`, and its Register cell says what. A pull request that adds or deletes a control directory or a corpus document edits `proof/timings.json` (What every pull request of the stack does, below). A docs page under `content/docs/` and a `CLAUDE.md` file are given, each with its pull request, by Contract sentences step 2 rewrites and Public docs that change, below, and by the Files of the fix that changes them; the lane's own two, `proof/README.md` and `proof/CLAUDE.md`, are listed under every pull request that edits them. Of the cutover modules under `scripts/lib/hqRoundTripCutover/` and the notice modules under `lib/notices/`, a list names the module or the directory and what the pull request adds there, and part 10, Scripts and their layout, gives the pull request that creates each module.

### Pull request 1: Lane mechanics

**Contains, in full**

- `proof/fixed-defects.json` with its loader, gate, queue and fingerprint.
- A held walk stop that names a control (`proof/walk-stops.json`'s `control` key), so a stop moves to its control with its fix, with the stops check and the queue reading every control the list names and the gate carrying a `control` entry through a selection.
- The gate, told a slice's documents, holding the fixed entries and the `control` stop entries of the controls the run ran, with those stop entries counted beside the document entries in its walk-stops section, which already counts by entry on the lane (part 09, The fixed-defect register and The held walk stops).
- The test that every control directory is named by one of the two registers.
- The name argument (`--as`) on control retention.
- `targeted-hq-side-state` split so its lookup table is `targeted-hq-side-lookup`.
- `targeted-shared-property-sort` given its second menu, with its control retained again in place (part 07, Finding 51).
- Targeted documents, entries and controls for findings 56 (`targeted-datetime-ordering`), 57 (`targeted-case-id-column`), 70 (`targeted-reserved-question-names`), 71 (`targeted-form-root-read`) and finding 43's `parsererror` (`targeted-parsererror-node-name`).
- `proof/checks/hq_own_reports.py::HQ_OWN_REPORTS` with its three members, `registration_alert_child_case` (finding 50), `android_grouped_tile_reopen` (finding 67) and `connect_block_renamed` (defect 15's Connect forwarding), each with its proof over an app HQ's own editors made (part 09).
- Findings 63 and 50 recorded under "What HQ does itself".
- The report of finding 67, on commcare-core, which holds the reader commcare-android calls, drafted and filed only with the person's yes (part 07, Finding 67).
- A build recreated under a stored part asks HQ what the build first observed asked (`proof/observe/unit.py::_build`), with its test that needs no reader (part 09, A build recreated under a stored part).
- `proof/timings.json` loses `control:nested-menu-previous` from both profiles, and `control:tile-grouped-one` and `control:targeted-connect-learn-rename` from the `readers` profile, the only one that holds them; the new groups are measured in.
- No emitter change.

**The lane**

- `proof/checks/registers.py`
- `proof/checks/cases.py`
- `proof/checks/controls.py`
- `proof/checks/stops.py`
- `proof/checks/test_stops.py`
- `proof/checks/proof4.py`
- `proof/checks/android.py`
- `proof/checks/connect.py`
- `proof/checks/hq_own_reports.py` (new)
- `proof/checks/test_hq_own_reports.py` (new)
- `proof/checks/test_registers.py` (the fixed register's cases; the control directory test)
- `proof/checks/test_controls.py` (`--as`)
- `proof/fixed-defects.json` (new)
- `proof/known-defects.json`
- `proof/store/queue.py`
- `proof/store/test_queue.py`
- `proof/store/fingerprints.py`
- `proof/store/conftest.py`
- `proof/store/test_keys.py`
- `proof/lane/gate.py`
- `proof/lane/test_gate.py`
- `proof/lane/test_forkserver.py` (a nested run's limit with the readers)
- `proof/walk-stops.json`
- `proof/observe/unit.py` (`_build` asks the identities in every build)
- `proof/checks/test_record_determinism.py` (the new stored-part test)
- `proof/editors/test_hq_own_registration_alert.py` (new)
- `proof/android/test_hq_own_grouped_tile_reopen.py` (new)
- `proof/connect/test_hq_own_rename.py` (new)
- `proof/rules/vellum_alert.py` (deleted)
- `proof/rules/test_vellum_alert.py` (deleted)
- `proof/rules/__init__.py` (the rule's import and `RULES` line leave)
- `proof/targeted/documents/datetimeOrdering.ts` (new)
- `proof/targeted/documents/caseIdColumn.ts` (new)
- `proof/targeted/documents/hqSideLookup.ts` (new)
- `proof/targeted/documents/hqSideState.ts` (loses its lookup table)
- `proof/targeted/documents/formShapes.ts` (findings 43, 70 and 71's documents)
- `proof/targeted/documents/sortKeys.ts` (`sharedPropertySort`'s second menu)
- `proof/targeted/index.ts`
- `proof/controls/` (the controls retained and deleted)
- `proof/timings.json` (three control groups leave; the new ones enter)

**Docs**

- `proof/CLAUDE.md`
- `proof/README.md`
- `docs/architecture/contracts.md` (the strict register's sentence)
- `CLAUDE.md` (the strict register's sentence)
- `docs/research/2026-09-26-hq-round-trip/harness-findings.md`

### Pull request 2: Cutover skeleton, the notice and the ledger tables

**Contains, in full**

- The fold-horizon DDL and writer with an empty step list.
- The notice tables, store, builder chip and dialog, the Publishing card's note, home line, `get_app.notices`, `dismiss_app_notice`.
- The Job `commcare-nova-hq-round-trip-cutover`, its `esbuild` line in `Dockerfile` stage `maintenance-build` (`--outfile=hq-round-trip-cutover.cjs`), its arm in `scripts/rollout/deploy-cloud-run.py::_effective_execution_args`, their tests (`scripts/infra/tests/`, `scripts/infra/__tests__/containerArtifacts.test.ts`), the runbook `docs/plans/hq-round-trip/2-cutover-runbook.md` (completed as steps land), and the frozen fixtures under `scripts/lib/hqRoundTripCutover/__tests__/fixtures/pre-step/`.
- Every additive ledger table and column (`app_deployment_identities`, `app_deployment_confirmations`, `app_deployment_baselines`, `project_space_resource_baselines`, `app_deployment_resources.remote_missing_at` with its backfill, `app_deployments.offered_logo_content_hash`, `app_deployments.target_empty_case_list_text`; the confirmation kind `connect-forwarder`).
- `app_deployment_baselines` has no form-id column, because no publish reads form ids back (part 02, The ledger schema).
- The notice tables include the key-reader rows the execute run writes for each member whose HQ key it used.
- These are three migrations (`<timestamp>_hq_round_trip_fold_horizon.ts`, `<timestamp>_app_migration_notices.ts`, `<timestamp>_hq_round_trip_deployment_ledger.ts`); the stack's fourth and last, `<timestamp>_app_settings.ts`, is pull request 5's.
- The three pre-horizon readers over `greatestFoldBaselineSeq` and the stream route's reload, `abandonPreAppDesignSessionInTransaction`, `RUNTIME_VERSION` 15, the frozen fold `prestepFold.generated.mjs` with its entry, build script and inputs test, the legacy bodies under `proof/hq-reads/cutover/<document>/legacy/`, and the two contract sentences of `docs/architecture/contracts.md` (part 10, Block: the cutover).

**Nova source**

- `lib/case-store/migrations/` (the three new migrations)
- `lib/agent/change-set/baseLoader.ts`
- `lib/agent/build/orchestrator.ts`
- `lib/agent/change-set/materializeGenesis.ts`
- `app/api/apps/[id]/stream/route.ts`
- `lib/db/designSessions.ts`
- `lib/db/appTests.ts`
- `lib/db/apps.ts` (`commitAppProjectMoveInTransaction`)
- `lib/log/types.ts`
- `lib/db/pg.ts`
- `lib/db/privilegeConvergence.ts`
- `lib/notices/` (new: reasons, store and renderers)
- `lib/deployment/store.ts`
- `lib/deployment/types.ts`
- `components/builder/notices/AppNoticeChip.tsx` (new)
- `components/builder/notices/AppNoticeDialog.tsx` (new)
- `components/builder/notices/appNoticeModel.ts` (new)
- `components/builder/BuilderHeader.tsx`
- `components/builder/BuilderProvider.tsx`
- `components/builder/app-setup/PublishingSection.tsx`
- `components/builder/app-setup/publishingSectionModel.ts`
- `components/notices/KeyReaderNotice.tsx` (new)
- `app/(app)/(site)/page.tsx`
- `app/(app)/build/[id]/[[...path]]/page.tsx`
- `lib/mcp/tools/getApp.ts`
- `lib/mcp/tools/dismissAppNotice.ts` (new)
- `lib/mcp/server.ts`

**Nova tests named outright**

- `lib/db/__tests__/projectMove.postgres.test.ts`
- `lib/mcp/__tests__/appNotices.postgres.test.ts` (new)
- `e2e/tests/app/app-notices.spec.ts` (new)

**The lane**

- `proof/hq-reads/cutover/` (new: the legacy upload bodies)

**Scripts and the cutover**

- `scripts/build-hq-round-trip-prestep-fold.mjs` (new; pull request 3 deletes it)
- `scripts/scan-hq-round-trip-cutover.ts` (new)
- `scripts/migrate-hq-round-trip-cutover.ts` (new)
- `scripts/lib/hqRoundTripCutover/` (new: the skeleton and the frozen fixtures)
- `scripts/rollout/deploy-cloud-run.py`
- `scripts/infra/` (the Job's tests)

**CI and config**

- `biome.json`
- `Dockerfile`
- `config/deployment-jobs.json`

**Docs**

- `docs/architecture/contracts.md` (its two contract sentences)
- `scripts/README.md`
- `docs/plans/hq-round-trip/2-cutover-runbook.md` (new)
- `docs/architecture/deployment.md`

### Pull request 3: Identity and the publish sequence

**Contains, in full**

- Defect 1.
- `localization.wireCodes`: `addLanguage` and `relabelSourceLanguage` carry a required `wireCode` that every producer mints through the planner `lib/doc/languageMutations.ts`, and the reducer stores it.
- The shell create then the in-place update.
- `lib/commcare/hq/appSource.ts::readHqAppSource` (new here, replacing `readHqAppSourceProfile`; its version field is `buildSpecVersion` and its size bound 64 MiB; later pull requests extend its type) and `lib/commcare/versionFloor.ts` (new here, the constant alone).
- The `target-app` preflight edge, the read after the shell create and the second read after a table or place push, all through `readHqAppSource`.
- The `remote_missing_at` selectors.
- The proof capture's two-import first publish, its layout marker, the marker's reader and `proof/checks/corpus.py::Export.content`, with every lane reader of state A's app, workbook and media turned to `content`, and the controls retained earlier replayed in their legacy layout.
- Downloads by project space and a `.ccz` made for one project space (findings 32 and 59).
- No `multimedia_map` (finding 49), with the oracle's check of it and its two codes, `HQJSON_BAD_MULTIMEDIA_MAP_KEY` and `HQJSON_BAD_MULTIMEDIA_MAP_MEDIA_TYPE`, removed.
- The manual-import guide and the ZIP.
- The frozen fold's one-line entry, its build script (`scripts/build-hq-round-trip-prestep-fold.mjs`) and its inputs test deleted, with the committed fold, its declaration, its inputs list and its digest test kept (part 10, The matching algorithm, "The fold is the pre-step one, frozen").
- The spelling rule `runtime_url_app_id` with its proof, which reads the release's id and the working app's id as one in a runtime URL.
- The nineteen classes Formplayer's record shows once the local archive's submit reaches HQ, one of them only because its two imports leave state A at HQ app version 2, registered live, with nine controls retained from this pull request's corpus in its two-import layout (`--as`): `targeted-custom-tile-after-59`, `targeted-hq-side-state-after-59`, `targeted-close-conditions-after-59`, `targeted-form-link-hidden-target-after-59`, `targeted-connect-deliver-rename-after-59`, `case-extension-registration-after-59`, `case-extension-repeat-after-59`, `case-extension-query-after-59` and `case-capture-repeat-after-59` (part 01, A5).
- The judge's map of the text ids HQ's build merges, read from questions' own labels alone, which reads the one class the working walk shows on `fuzz-suite-20260930-8` and registers nothing (part 01, A5).
- `MODEL_CONTEXT_VERSION` does not move (item 13 of the checklist below).

**Nova source**

- `lib/commcare/wireIdentity.ts` (new)
- `lib/commcare/ids.ts` (deleted)
- `lib/commcare/index.ts`
- `lib/commcare/languageWire.ts`
- `lib/commcare/localization.ts`
- `lib/commcare/expander.ts` (`expandAppShell` and `APP_SHELL_KEYS`, both new)
- `lib/commcare/hqShells.ts`
- `lib/commcare/types.ts`
- `lib/commcare/compiler.ts`
- `lib/commcare/client.ts` (`importApp` waits out a `Retry-After`)
- `lib/commcare/targetProfile.ts`
- `lib/commcare/runtimeTarget.ts`
- `lib/commcare/versionFloor.ts` (new: the constant alone)
- `lib/commcare/hq/appSource.ts`
- `lib/commcare/hq/http.ts`
- `lib/commcare/hq/readJson.ts`
- `lib/commcare/hq/readCollection.ts` (`CommCareApiError.cause`)
- `lib/commcare/multimedia/bundle.ts` (loses `buildMultimediaMap`)
- `lib/commcare/multimedia/hqJsonExportArchive.ts` (always writes the ZIP)
- `lib/commcare/multimedia/assetWirePath.ts` (a comment)
- `lib/commcare/validator/hqJsonOracle.ts`
- `lib/commcare/validator/errors.ts`
- `lib/doc/types.ts`
- `lib/doc/languageMutations.ts` (new: the `wireCode` planner)
- `lib/doc/mutations/app.ts`
- `lib/doc/diffDocsToMutations.ts`
- `lib/doc/mutationTargetAdmission.ts`
- `lib/domain/localization.ts` (the `wireCodes` schema)
- `components/builder/app-setup/LanguagesSection.tsx` (mints through the planner)
- `lib/agent/tools/localization.ts` (mints through the planner)
- `lib/agent/translation/translateLanguage.ts` (mints through the planner)
- `lib/deployment/service.ts`
- `lib/deployment/resources.ts`
- `lib/deployment/importApplication.ts`
- `lib/deployment/preflight.ts`
- `lib/deployment/store.ts`
- `lib/deployment/types.ts`
- `lib/deployment/index.ts`
- `lib/deployment/workers.ts`
- `lib/deployment/entryPointLinks.ts`
- `lib/deployment/entryPointManifest.ts`
- `lib/deployment/runtimeTarget.ts`
- `lib/deployment/attachmentTarget.ts`
- `lib/deployment/actions.ts`
- `lib/deployment/downloadTarget.ts` (new)
- `lib/deployment/attachmentSpace.ts` (deleted)
- `lib/export/localArchive.ts`
- `lib/publish/manualImportGuide.ts` (new)
- `app/api/compile/`
- `components/builder/PublishDialog.tsx`
- `components/builder/PublishPanel.tsx`
- `components/builder/DeploymentStatus.tsx`
- `components/builder/DeploymentWorkers.tsx`
- `components/builder/app-setup/publishingSectionModel.ts`
- `lib/mcp/tools/compileApp.ts`
- `lib/mcp/tools/deploymentProjection.ts`
- `lib/mcp/tools/uploadAppToHq.ts`
- `lib/notices/` (six reasons and their renderers)

**Nova tests named outright**

- `lib/commcare/__tests__/` (the emission tests; 31 `compileCcz` callers; localization roots)
- `lib/commcare/__tests__/runtimeTargetFixture.ts` (new: `TEST_RUNTIME_TARGET`)
- `lib/commcare/locations/__tests__/` (one `compileCcz` caller)
- `lib/commcare/suite/case-search/__tests__/` (two `compileCcz` callers)
- `lib/commcare/validator/__tests__/localization.test.ts`
- `lib/doc/__tests__/` (language mutations and localization roots; part 01, A2, Files)
- `lib/preview/engine/__tests__/` (language mutations and localization roots)
- `lib/db/__tests__/blueprintRows.test.ts`
- `lib/case-store/migrations/__tests__/authoringCutover.postgres.test.ts`
- `lib/deployment/__tests__/publishSequence.postgres.test.ts` (new)
- `lib/deployment/__tests__/resources.test.ts` (new)
- `lib/deployment/__tests__/downloadTargetsAction.postgres.test.ts` (new)
- `lib/mcp/__tests__/` (the deployment tools' Postgres tests)
- `e2e/lib/` (the clients that add a language or write a root)
- `e2e/tests/browser/publishing.spec.ts`

**The lane**

- `proof/corpus/publish.ts`
- `proof/corpus/targetPeer.ts`
- `proof/corpus/entryWriter.ts`
- `proof/corpus/writePublishCaptures.ts`
- `proof/corpus/emitCorpus.ts` (the layout comment; `import-file.zip`)
- `proof/corpus/inputs.ts` (the `content.` and `privileges.content.` roles)
- `proof/corpus/footprint.ts`
- `proof/corpus/entropy.mts`
- `proof/corpus/editKinds.ts` (mints through the planner)
- `proof/corpus/workforce.ts` (mints through the planner)
- `proof/corpus/__tests__/emitCorpus.test.ts`
- `proof/corpus/__tests__/entropy.test.ts`
- `proof/corpus/__tests__/publish.postgres.test.ts`
- `proof/corpus/__tests__/writePublishCaptures.test.ts`
- `proof/corpus/__tests__/footprint.test.ts` (a `compileCcz` caller; a localization root)
- `proof/hq/operations.py` (`with_runtime_app_id`, `api_request`, `seed_api_user`, `seed_api_key`, `publish_capture`)
- `proof/hq/seams.py` (`api_rate_limits`, new)
- `proof/hq/test_publish.py`
- `proof/hq/test_publish_capture.py`
- `proof/hq/test_import_file.py` (new)
- `proof/hq/conftest.py` (`DOCUMENTS`, the package's key)
- `proof/hq/test_retained_reads.py` (new: the `publish` and `cutover` groups)
- `proof/hq/test_branches.py` (`_create`; `DATABASE_CLOCK` and its case)
- `proof/hq-reads/publish/` (new)
- `proof/hq-reads/cutover/` (HQ's retained answers)
- `proof/store/queue.py` (`PACKAGE_DATA`)
- `proof/rules/runtime_url_app_id.py` (new)
- `proof/rules/test_runtime_url_app_id.py` (new: three tests)
- `proof/rules/__init__.py` (`RULES`; `ARTIFACT_READERS`)
- `proof/rules/conftest.py` (`published`, `restore`)
- `proof/checks/android.py` (the rule's device addresses)
- `proof/checks/served.py` (`TRACE_DATA_MAPS`, `_text_references`, `merged_text_ids`)
- `proof/checks/proof3.py` (the rule's addresses)
- `proof/checks/test_served.py`
- `proof/checks/wireLanguages.ts`
- `proof/checks/test_connect_unit.py` (its line for the local archive)
- `proof/checks/test_record_determinism.py` (the media tests; the role parameters)
- `proof/checks/corpus.py` (`_captured`, `Captured`, `Export.content`, `Document.import_file`)
- `proof/checks/configurations.py` (`PRIVILEGE_CAPTURES`)
- `proof/checks/manifest_usage.py`
- `proof/checks/test_proof3_behavior.py` (reads `export.content`)
- `proof/checks/test_alignment.py` (reads `export.content`)
- `proof/checks/test_corpus.py` (the marker reader's case; both imports' roles)
- `proof/checks/proof5.py` (a docstring)
- `proof/checks/test_proof5_locality.py` (a docstring)
- `proof/observe/publish.py` (`create`, `update`)
- `proof/observe/unit.py` (`create_a`, `input_files`)
- `proof/observe/sessions.py` (the archive takes A's id)
- `proof/observe/served.py` (the archive takes A's id)
- `proof/observe/connect.py` (the archive takes A's id)
- `proof/observe/manifest.py` (`uploads_of`)
- `proof/formplayer/apps.py` (`published`)
- `proof/formplayer/observe.py` (`marked`)
- `proof/formplayer/test_local_archive.py`
- `proof/webapps/hq.py` (`project`)
- `proof/connect/conftest.py` (reads `export.content`)
- `proof/connect/test_receiver.py`
- `proof/views/test_lookup_upload.py` (reads `export.content`)
- `proof/android/predicates.py` (the rule's device test)
- `proof/android/hq.py`
- `proof/native/producers/` (the 17 producers' target)
- `proof/native/producers/runtimeTarget.ts` (new)
- `proof/native/core/LocalizationRuntimeTest.java`
- `proof/native/steps/media_emission.py`
- `proof/native/test_media_emission.py`
- `proof/targeted/documents/hqSideState.ts`
- `proof/targeted/documents/emptyListNoEnglish.ts`
- `proof/controls/` (ten controls in the two-import layout)
- `proof/timings.json`

**Scripts and the cutover**

- `scripts/lib/hqRoundTripCutover/matching.ts` (new)
- `scripts/lib/hqRoundTripCutover/hqRead.ts` (new)
- `scripts/lib/hqRoundTripCutover/legacyLanguageWireCodes.ts` (new)
- `scripts/lib/hqRoundTripCutover/steps/languageWireCodes.ts` (new)
- `scripts/lib/hqRoundTripCutover/transform.ts` (registers the step)
- `scripts/lib/hqRoundTripCutover/behavior.ts` (`ccz-needs-project-space`)
- `scripts/lib/hqRoundTripCutover/notice.ts` (the five deployment lines)
- `scripts/lib/hqRoundTripCutover/prestep/prestepFold.entry.ts` (deleted, with the inputs test)
- `scripts/build-hq-round-trip-prestep-fold.mjs` (deleted)
- `scripts/lib/languageIdentityRepair.ts` (mints through the planner)
- `scripts/__tests__/selectOptionValueRepair.test.ts` (a localization root)
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests and fixture expectations)

**CI and config**

- `biome.json` (the planner's entry)
- `.github/workflows/proof-audit.yml`

**Docs**

- `proof/README.md`
- `proof/CLAUDE.md` (the determinism rule; a new rule; a device's network)

### Pull request 4: Drift and baselines

**Nova source**

- `lib/deployment/hqSourceBaseline.ts` (new)
- `lib/deployment/hqResourceBaseline.ts` (new)
- `lib/deployment/remoteChanges.ts` (new)
- `lib/deployment/preflight.ts`
- `lib/deployment/service.ts`
- `lib/deployment/store.ts`
- `lib/deployment/types.ts`
- `lib/deployment/importApplication.ts`
- `lib/deployment/lookupResourcePlan.ts`
- `lib/deployment/locationResourcePlan.ts`
- `lib/deployment/index.ts`
- `lib/commcare/appOwnership.ts` (new; pull request 5 deletes it)
- `lib/commcare/surface/schemaDefaults.ts` (new)
- `lib/commcare/hq/lookupTables.ts` (`readHqLookupTableRows`, new)
- `lib/commcare/hq/locations.ts`
- `components/builder/PublishDialog.tsx`
- `components/builder/publishOutcome.ts`
- `app/api/commcare/upload/route.ts`
- `lib/mcp/tools/uploadAppToHq.ts`
- `lib/mcp/errors.ts`
- `lib/notices/` (two reasons and their renderers)

**Nova tests named outright**

- `lib/commcare/__tests__/hqLookupTables.test.ts`
- `lib/commcare/__tests__/hqLocations.test.ts`
- `e2e/tests/browser/publishing.spec.ts`
- `e2e/lib/publishing-client.tsx`
- `e2e/lib/publishing-boundary.ts`
- `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`

**The lane**

- `proof/corpus/publish.ts`
- `proof/corpus/writePublishCaptures.ts` (the ownership file)
- `proof/corpus/targetPeer.ts`
- `proof/corpus/__tests__/publish.postgres.test.ts`
- `proof/hq/test_retained_reads.py` (its drift groups)
- `proof/hq/operations.py` (`CapturedResourcesNotHeld`; the `api_request` reads)
- `proof/hq/test_publish.py` (the cached-verdict case)
- `proof/hq/conftest.py`
- `proof/editors/test_retained_reads.py` (new)
- `proof/editors/conftest.py` (`DOCUMENTS`, new, the package's key)
- `proof/editors/test_vellum.py`
- `proof/formplayer/test_preview_install.py` (new)
- `proof/formplayer/conftest.py`
- `proof/observe/publish.py`
- `proof/store/queue.py` (`PACKAGE_DATA`)
- `proof/hq-reads/` (new under it: drift answers, `lookup-upload/`, `places/`)

**Scripts and the cutover**

- `scripts/lib/hqRoundTripCutover/writer.ts` (the baseline reads and writes)
- `scripts/lib/hqRoundTripCutover/notice.ts` (the two deployment lines)
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests)

**Docs**

- `proof/README.md`

### Pull request 5: App-level emission

**Contains, in full**

- Defects 2, 4, 7, 8, 9.
- Findings 34, 39, 40, 62, 65.
- `BlueprintDoc.appSettings` with `setAppSettings` and `apps.app_settings`, and its edit-kind generator.
- The overlay module `lib/commcare/targetOverlay.ts` (it absorbs `targetProfile.ts` and replaces `appOwnership.ts`: the overlay's `ownership` replaces pull request 4's `appOwnershipOf`, and the drift comparison narrows `translations` from whole to the owned-key predicate).
- Finding 40's fifteen constants seeded on HQ only where the target holds no value.
- Finding 65's texts, the publish's read of the empty-list text flag into `app_deployments.target_empty_case_list_text`, and one local archive per configuration in the corpus.
- The bare `pollsensor` of a GPS question with its surface entry `questions/hq-generated-pollsensor` and the reader that takes `questions/authored-orx-pollsensor` out of `KNOWN_GAPS` (part 04, Finding 34).
- The proof 3 and proof 1 judge changes for the form version and the Android update, whose record names each archive's `uniqueid` and `version`, and `settings_replaced`'s, which reads the state's own next build.
- The manifest's reading of a target's value carried back (`manifest_usage.py`) and the footprint that reaches the app's record when the needed add-ons differ.
- The four lane tests that hold the former bytes, rewritten (part 04, Defect 4).
- Proof 5's version clause (`proof/checks/proof5.py` compares a local form without its data node's `version`, which is the sequence from this pull request).
- `intent.py::profile_settings` and `::local_archive_versions`.
- `manifest_value_classes.py::save_differing_from_vellum` as the comparison with Vellum's computation, which no form of the corpus reaches, `::setting_outside_choices`, the reader of the manifest's `outside-choices` class (out of `KNOWN_GAPS`), and `::android_verified_path_without_entry`'s decision for an app that stores `cc-content-valid` `no`.
- The surface key family `profile-feature:` (`proof/surface/families/profile.py`, with `surface.json` regenerated) and the entry `application-and-settings/profile-feature-checkoff` for the local profile's `checkoff` feature (part 04, Defect 7, Files).
- As the pull request's first commit, before any judge or emitter change, the control `connect-location-capture` retained from `targeted-invalid-connect-ids` (`--as`), which `d34-connect-location-trace-meta-location` takes as its `control`.
- `d34-connect-location-capture-formplayer-local-ccz-data-meta-location` re-documented on `targeted-connect-deliver-rename` (part 04, Finding 34).
- At its head, the control `targeted-invalid-question-ids-after-9` retained from `targeted-invalid-question-ids` (`--as`) for defect 15's three pinned proof 1 entries, the four form-version entries deleted with the proof 3 judge change, the two pull request 3 registers among them, and `proof/controls/targeted-hq-side-state-after-59/` removed with the one of them that names it (part 04, Defect 9).
- Targeted documents `targeted-attribute-display-condition` and `targeted-gps-question`.
- `MODEL_CONTEXT_VERSION` to `"v3-hq-round-trip-emission"` (`update_app`).

**Nova source**

- `lib/domain/blueprint.ts`
- `lib/domain/index.ts`
- `lib/domain/kinds.ts`
- `lib/domain/fields/` (each kind's `carriesValidation`)
- `lib/doc/types.ts`
- `lib/doc/scaffolds.ts`
- `lib/doc/mutations/app.ts`
- `lib/doc/mutations/index.ts`
- `lib/doc/store.ts`
- `lib/doc/diffDocsToMutations.ts`
- `lib/doc/mutationTargetAdmission.ts`
- `lib/doc/mutationSequenceAdmission.ts`
- `lib/doc/mutationIdentityAdmission.ts`
- `lib/doc/incrementalValidationScope.ts`
- `lib/doc/referenceIndex.ts`
- `lib/doc/hooks/useBlueprintMutations.ts`
- `lib/doc/hooks/useAppSettings.ts` (new)
- `lib/case-store/migrations/` (new `<timestamp>_app_settings.ts`)
- `lib/db/pg.ts`
- `lib/db/blueprintRows.ts`
- `lib/db/canonicalCommitKernel.ts`
- `lib/db/persistedJson.ts`
- `lib/db/runtimeDatabaseProbe.ts`
- `lib/db/mediaDeletion.ts`
- `lib/db/appGenesis.ts`
- `lib/db/apps.ts`
- `lib/doc/hooks/useAutoSave.ts`
- `lib/commcare/targetOverlay.ts` (new)
- `lib/commcare/targetProfile.ts` (deleted)
- `lib/commcare/appOwnership.ts` (deleted)
- `lib/commcare/appStringKeys.ts` (new)
- `lib/commcare/addOns.ts` (new)
- `lib/commcare/appProfileSettings.ts` (new)
- `lib/commcare/expander.ts` (`APP_SHELL_KEYS` loses `add_ons`)
- `lib/commcare/hqShells.ts`
- `lib/commcare/types.ts`
- `lib/commcare/constants.ts`
- `lib/commcare/client.ts` (`readEmptyCaseListText`)
- `lib/commcare/hq/appSource.ts`
- `lib/commcare/compiler.ts`
- `lib/commcare/suite/displayConditions.ts`
- `lib/commcare/suite/case-list/` (the short detail writer)
- `lib/commcare/suite/case-list/detailTexts.ts` (new)
- `lib/commcare/suite/case-list/columns.ts` (the image-map field's `<alt_text>`)
- `lib/commcare/suite/formStrings.ts` (new)
- `lib/commcare/xform/metaBlock.ts`
- `lib/commcare/xform/formVersion.ts` (new)
- `lib/commcare/xform/builder.ts`
- `lib/commcare/validator/rules/field.ts`
- `lib/commcare/validator/suiteOracle.ts`
- `lib/deployment/importApplication.ts`
- `lib/deployment/service.ts`
- `lib/deployment/hqSourceBaseline.ts`
- `lib/deployment/preflight.ts`
- `lib/deployment/store.ts`
- `lib/deployment/types.ts`
- `lib/deployment/runtimeTarget.ts`
- `lib/deployment/downloadTarget.ts`
- `lib/export/localArchive.ts`
- `lib/agent/tools/updateApp.ts`
- `lib/agent/tools/shared/toolCallSummary.ts`
- `lib/chat/toolSummary.ts`
- `lib/agent/appOverview.ts`
- `lib/agent/summarizeBlueprint.ts`
- `lib/models.ts`
- `components/builder/detail/appSettings/AppSavedFormsSection.tsx` (new)
- `components/builder/detail/appSettings/AppSettingsPanel.tsx`
- `lib/notices/` (six reasons and their renderers)
- `lib/commcare/surface/entries/application-and-settings.json`
- `lib/commcare/surface/entries/questions.json`
- `lib/commcare/surface/surface.json`

**Nova tests named outright**

- `lib/domain/__tests__/fieldRegistry.test.ts`
- `lib/__tests__/docHelpers.ts`
- `lib/doc/__tests__/mutations-app.test.ts`
- `lib/doc/__tests__/mutationAdmission.test.ts`
- `lib/doc/__tests__/diffDocsToMutations.fuzz.test.ts`
- `lib/commcare/__tests__/` (these files' tests)
- `lib/agent/__tests__/summarizeBlueprint-settings.test.ts` (new)
- `lib/db/__tests__/commitGuardedBatch.postgres.test.ts`
- `e2e/tests/app/app-settings.spec.ts` (new)
- `lib/deployment/__tests__/publishSequence.postgres.test.ts` (the exact-key expectation)

**The lane**

- `proof/surface/families/profile.py`
- `proof/surface/families/strings.py`
- `proof/surface/families/authored.py`
- `proof/surface/__init__.py`
- `proof/surface/test_strings_and_profile.py`
- `proof/checks/proof2.py`
- `proof/checks/proof3.py`
- `proof/checks/proof5.py`
- `proof/checks/test_proof5_locality.py`
- `proof/checks/served.py`
- `proof/checks/android.py`
- `proof/checks/intent.py`
- `proof/checks/manifest_usage.py`
- `proof/checks/manifest_value_classes.py`
- `proof/checks/test_manifest_value_classes.py`
- `proof/checks/test_hq_side.py`
- `proof/checks/test_intent.py`
- `proof/checks/test_proof2_build.py`
- `proof/checks/test_proof3_behavior.py`
- `proof/checks/test_android.py`
- `proof/checks/test_manifest.py`
- `proof/checks/test_served.py`
- `proof/checks/controls.py`
- `proof/checks/corpus.py` (an archive for each configuration)
- `proof/android/observe.py`
- `proof/android/predicates.py`
- `proof/android/src/nova/proof/android/Location.java` (new)
- `proof/android/src/nova/proof/android/Reader.java`
- `proof/corpus/editKinds.ts`
- `proof/corpus/footprint.ts`
- `proof/corpus/entryWriter.ts`
- `proof/corpus/publish.ts`
- `proof/corpus/targetPeer.ts`
- `proof/corpus/documents.ts` (`HqSideSaves`)
- `proof/corpus/inputs.ts`
- `proof/corpus/entropy.mts` (prose only)
- `proof/corpus/__tests__/entropy.test.ts` (holds the `uniqueid` draw)
- `proof/corpus/__tests__/emitCorpus.test.ts` (holds the `uniqueid` draw)
- `proof/corpus/__tests__/writePublishCaptures.test.ts` (holds the `uniqueid` draw)
- `proof/corpus/__tests__/publish.postgres.test.ts` (holds the `uniqueid` draw; the overlaid keys)
- `proof/observe/served.py`
- `proof/observe/sessions.py`
- `proof/observe/proof4.py`
- `proof/observe/intent.py`
- `proof/observe/hqside.py`
- `proof/observe/unit.py`
- `proof/store/guard.py`
- `proof/formplayer/observe.py`
- `proof/formplayer/test_settings.py` (rewritten)
- `proof/formplayer/test_validation.py`
- `proof/webapps/test_app_list.py`
- `proof/connect/conftest.py`
- `proof/connect/test_receiver.py`
- `proof/hq/test_empty_list_flag_read.py` (new)
- `proof/targeted/documents/attributeDisplayCondition.ts` (new)
- `proof/targeted/documents/gpsQuestion.ts` (new)
- `proof/targeted/documents/hqSideState.ts`
- `proof/targeted/documents/hqSideLookup.ts`
- `proof/targeted/documents/formShapes.ts`
- `proof/targeted/index.ts`
- `proof/hq-reads/navigation-base/` (the read after the Add-ons save)
- `proof/views/test_add_ons.py`
- `proof/views/test_case_list_offers.py`
- `proof/rules/test_add_ons.py`
- `proof/rules/test_stored_position_keys.py` (new)
- `proof/rules/profile_required_minimal.py` (deleted)
- `proof/rules/test_profile_required_minimal.py` (deleted)
- `proof/rules/profile_unread_properties.py`
- `proof/rules/test_profile_unread_properties.py`
- `proof/rules/__init__.py`
- `proof/walk-stops.json`
- `proof/controls/connect-location-capture/` (new)
- `proof/controls/targeted-invalid-question-ids-after-9/` (new)
- `proof/controls/targeted-hq-side-state-after-59/` (removed)
- `proof/timings.json`

**Scripts and the cutover**

- `scripts/lib/loadPersistedBlueprint.ts` (a root carrier loader; checklist item 5)
- `scripts/inspect-app.ts` (a root carrier loader)
- `scripts/lib/persistedLookupReferenceScan.ts` (a root carrier loader)
- `scripts/lib/repairAuthoringBaselines.ts` (a root carrier loader)
- `scripts/test-schema.ts`
- `scripts/lib/hqRoundTripCutover/steps/appSettings.ts` (new)
- `scripts/lib/hqRoundTripCutover/transform.ts` (registers the step)
- `scripts/lib/hqRoundTripCutover/behavior.ts`
- `scripts/lib/hqRoundTripCutover/notice.ts`
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests and fixture expectations)

**CI and config**

- `.github/workflows/proof-audit.yml`

**Docs**

- `proof/android/README.md`
- `proof/README.md`
- `proof/CLAUDE.md` (the determinism rule)

### Pull request 6: XForm, first part

**Nova source**

- `lib/commcare/xform/caseOps.ts`
- `lib/commcare/xform/caseBlocks.ts`
- `lib/commcare/xform/builder.ts`
- `lib/commcare/xform/constraintCollections.ts`
- `lib/commcare/xform/dataRootAttributes.ts`
- `lib/commcare/xform/datetimeCaseValue.ts`
- `lib/commcare/xform/formPath.ts` (takes `relativeXPath` and `originalContextPath`)
- `lib/commcare/session.ts` (`newCaseIdDatumId`)
- `lib/commcare/localization.ts`
- `lib/commcare/formActions.ts` (a comment)
- `lib/commcare/xpath/selfSteps.ts` (new)
- `lib/commcare/hashtags.ts`
- `lib/commcare/hashtags/formContext.ts`
- `lib/domain/translationFill.ts` (new)
- `lib/domain/translationUnits.ts`
- `lib/domain/formWireName.ts` (new)
- `lib/domain/localizedBlueprintProjection.ts` (the `filled` option)
- `lib/commcare/validator/errors.ts`
- `lib/commcare/validator/gate.ts`
- `lib/commcare/validator/rules/field.ts` (`SELECT_OPTION_LABEL_EMPTY`)
- `lib/doc/userFacingErrors.ts` (its message)
- `lib/doc/hooks/useLocalization.ts` (`useFilledField`)
- `components/builder/app-setup/LanguagesSection.tsx` (the Missing badge)
- `lib/preview/engine/engineInput.ts`
- `lib/preview/engine/formEngine.ts`
- `lib/preview/hooks/useVisibleFieldOrder.ts`
- `components/preview/form/virtual/rows/FieldRow.tsx`
- `components/preview/form/virtual/rows/GroupBracket.tsx`
- `components/preview/form/virtual/rows/SectionHeaderRow.tsx`
- `lib/agent/authoring/reference.ts`
- `lib/agent/tools/localization.ts`
- `lib/models.ts`
- `lib/notices/` (`option-label-filled`)
- `lib/commcare/surface/entries/questions.json`

**Nova tests named outright**

- `lib/commcare/__tests__/` (the emission tests and fixtures)
- `lib/commcare/__tests__/editableEnvelope.test.ts` (new)
- `lib/commcare/__tests__/defaultValueEmission.test.ts` (new)
- `lib/commcare/__tests__/containerWireFixture.ts` (`init-add` gains three Hidden Values; `registration` gains two)
- `lib/commcare/xpath/__tests__/nativeXPathCorpus.ts` (the `attribute axis` row)
- `lib/domain/__tests__/localization.test.ts`
- `e2e/tests/app/localization.spec.ts`
- `lib/agent/translation/__tests__/translateLanguage.postgres.test.ts`
- `lib/commcare/validator/__tests__/selectOptionLabel.test.ts` (new)

**The lane**

- `proof/checks/compare/versions.py`
- `proof/checks/compare/build_files.py`
- `proof/checks/proof4.py`
- `proof/checks/manifest_value_classes.py` (`_form_reads` resolves `current()`)
- `proof/checks/test_manifest_value_classes.py`
- `proof/checks/test_form_content.py` (new)
- `proof/checks/test_proof2_build.py`
- `proof/checks/test_proof4_editability.py`
- `proof/android/conftest.py` (new: `DOCUMENTS`)
- `proof/android/test_form_reads.py` (new)
- `proof/android/observe.py`
- `proof/android/predicates.py`
- `proof/android/src/nova/proof/android/Answers.java`
- `proof/android/src/nova/proof/android/Screens.java`
- `proof/android/src/nova/proof/android/Updates.java`
- `proof/store/queue.py` (`PACKAGE_DATA`)
- `proof/lane/blocks.py` (`CORPUS_PACKAGES`)
- `proof/connect/conftest.py`
- `proof/connect/test_receiver.py` (the work area test)
- `proof/native/core/CaseOperationRuntimeTest.java` (the datetime writes)
- `proof/native/core/ContainerRuntimeTest.java` (two new tests; an empty `casedb` in its environment)
- `proof/native/core/CaseCaptureRuntimeTest.java` (two new tests: the extension child's parent index; three session datums)
- `proof/native/steps/case_emission.py` (the extension registration form also written whole)
- `proof/rules/` (the retired rules' modules and tests)
- `proof/rules/test_vellum_hashtags.py` (works from `standard-case-reads`)
- `proof/controls/` (the new control)
- `proof/targeted/documents/blankLabels.ts` (new)
- `proof/timings.json` (the new document's and control's groups)

**Scripts and the cutover**

- `scripts/lib/hqRoundTripCutover/steps/optionLabels.ts` (new)
- `scripts/lib/hqRoundTripCutover/transform.ts` (registers the step)
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests and fixture expectations)

**Docs**

- `proof/android/README.md`
- `proof/README.md` (work item H's rows; the `container` family row; the Case emission prose)

### Pull request 7: XForm, second part

**Nova source**

- `lib/commcare/xform/` (the emitters that read `generatedNodes.ts`)
- `lib/commcare/xform/generatedNodes.ts` (new)
- `lib/commcare/constants.ts`
- `lib/commcare/formActions.ts`
- `lib/commcare/identifierValidation.ts` (`isReservedXFormNodeName` deleted)
- `lib/commcare/validator/errors.ts`
- `lib/commcare/validator/gate.ts`
- `lib/commcare/validator/rules/field.ts`
- `lib/commcare/validator/rules/caseOperations.ts` (`reservedFieldIdPrefix` deleted)
- `lib/doc/identifierVerdicts.ts`
- `lib/doc/userFacingErrors.ts`
- `lib/doc/caseOperationOrder.ts`
- `lib/preview/engine/formEngine.ts` (the count node's name)
- `components/builder/editor/FieldIdentitySection.tsx`
- `components/builder/editor/renameOutcome.ts`
- `lib/agent/tools/case-operations/shared.ts`
- `lib/agent/tools/editField.ts`
- `lib/agent/tools/shared/fieldAssembly.ts`
- `lib/models.ts`
- `lib/notices/` (`data-paths-move-once`)
- `lib/commcare/surface/entries/questions.json`
- `lib/commcare/surface/entries/forms-and-case-writes.json`

**Nova tests named outright**

- `lib/commcare/__tests__/` (the emission tests and fixtures)
- `lib/commcare/__tests__/generatedNodes.test.ts` (new)
- `lib/commcare/validator/__tests__/caseOperations.test.ts`
- `lib/agent/tools/__tests__/` (tests of the removed rule and old names)
- `lib/mcp/__tests__/compileApp.postgres.test.ts`

**The lane**

- `proof/checks/compare/names.py`
- `proof/checks/compare/trace.py`
- `proof/checks/manifest_value_classes.py` (with its test)
- `proof/checks/test_manifest_value_classes.py`
- `proof/checks/test_compare.py`
- `proof/checks/proof3.py`
- `proof/checks/differences.py`
- `proof/native/core/CaseOperationRuntimeTest.java`
- `proof/native/core/CaseCaptureRuntimeTest.java`
- `proof/native/test_case_emission.py`
- `proof/formplayer/test_case_blocks.py` (new)
- `proof/formplayer/conftest.py` (`DOCUMENTS`)
- `proof/webapps/test_generated_groups.py` (new)
- `proof/webapps/conftest.py` (`DOCUMENTS`)
- `proof/android/test_case_blocks.py` (new)
- `proof/android/conftest.py` (`DOCUMENTS`)
- `proof/views/test_exports.py` (reads the new name)
- `proof/controls/` (the controls this pull request retains)
- `proof/timings.json`

**Scripts and the cutover**

- `scripts/lib/hqRoundTripCutover/notice.ts` (the deployment line)
- `scripts/lib/hqRoundTripCutover/report.ts` (the scan's two counts)
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests)

**Docs**

- `proof/README.md`

### Pull request 8: Defect 3

**Nova source**

- `lib/commcare/xform/caseSaveReferences.ts` (new)
- `lib/commcare/xform/builder.ts`
- `lib/commcare/xform/index.ts`
- `lib/commcare/types.ts`
- `lib/commcare/hqShells.ts`
- `lib/commcare/expander.ts`
- `lib/commcare/validator/hqJsonOracle.ts`

**Nova tests named outright**

- `lib/commcare/__tests__/caseSaveReferences.test.ts` (new)
- `lib/commcare/__tests__/compilerEvidence.ts` (runs `checkCaseReferences`)

**The lane**

- `proof/checks/intent.py`
- `proof/checks/test_intent.py`
- `proof/controls/case-capture-multiple-after-3/` (new)
- `proof/timings.json`

**Docs**

- `proof/README.md`
- `content/docs/publishing.mdx`

### Pull request 9: Case writes through basic actions

**Nova source**

- `lib/commcare/xform/caseBlocks.ts`
- `lib/commcare/xform/caseOps.ts`
- `lib/commcare/xform/generatedNodes.ts` (`trimmed`)
- `lib/commcare/xform/builder.ts` (`buildFieldParts`: `nova_trimmed_<question>`)
- `lib/commcare/formActions.ts`
- `lib/commcare/validator/hqJsonOracle.ts` (refuses `open_case.external_id`)
- `lib/commcare/surface/entries/forms-and-case-writes.json`
- `lib/domain/caseScalarTextGuard.ts` (new)
- `lib/domain/closeCondition.ts` (new)
- `lib/domain/index.ts`
- `lib/case-store/postgres/submissionEnvelope.ts`
- `lib/preview/engine/formEngine.ts`
- `components/builder/detail/formSettings/CloseConditionSection.tsx`
- `lib/agent/planningSchemas.ts` (`closeConditionInputSchema`)
- `lib/agent/tools/updateForm.ts`
- `lib/models.ts`
- `lib/notices/` (the reasons and their renderers)

**Nova tests named outright**

- `lib/commcare/__tests__/caseBlocks.test.ts`
- `lib/commcare/__tests__/multiSelectEmission.test.ts`
- `lib/commcare/__tests__/extensionCaseEmission.test.ts`
- `lib/commcare/__tests__/repeatContextSubcase.test.ts`
- `lib/commcare/__tests__/hqJsonOracle.test.ts`
- `lib/case-store/__tests__/followupTouch.postgres.test.ts` (new)

**The lane**

- `proof/targeted/documents/closeConditions.ts`
- `proof/targeted/documents/echo.ts`
- `proof/targeted/documents/searchApps.ts` (`answerHeld` takes a command and a case id)
- `proof/targeted/documents/multiSelectDestinations.ts` (`answerHeld` takes a command and a case id)
- `proof/targeted/documents/stableWitnesses.ts` (`answerHeld` takes a command and a case id)
- `proof/targeted/documents/noMatchesReturnIdentity.ts` (`answerHeld` takes a command and a case id)
- `proof/rules/case_block_position.py` (deleted, with its test)
- `proof/rules/update_never_beside_actions.py` (deleted, with its test)
- `proof/rules/__init__.py` (two rules leave `RULES`)
- `proof/rules/conftest.py` (`DOCUMENTS` loses two documents)
- `proof/formplayer/test_case_name_guard.py` (new)
- `proof/webapps/test_case_name_guard.py` (new)
- `proof/webapps/conftest.py` (`DOCUMENTS` gains `navigation-base`)
- `proof/android/test_case_name_guard.py` (new)
- `proof/android/conftest.py` (`DOCUMENTS` gains `navigation-base`)
- `proof/native/core/CaseOperationRuntimeTest.java` (new cases: hidden, blank and over-long names)
- `proof/native/test_case_emission.py` (new assertions: child order)
- `proof/controls/`
- `proof/walk-stops.json`

**Scripts and the cutover**

- `scripts/test-schema.ts` (registers `updateForm`)
- `scripts/lib/hqRoundTripCutover/behavior.ts` (the four selection functions)
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests)

**Docs**

- `proof/README.md`

### Pull request 10: Identifiers and form content

**Nova source**

- `lib/domain/questionId.ts` (new)
- `lib/domain/entryPoints.ts`
- `lib/domain/forms.ts` (`connectDeliverFormHoldsTask`)
- `lib/domain/selectOptionValue.ts`
- `lib/doc/identifierVerdicts.ts`
- `lib/doc/userFacingErrors.ts`
- `lib/doc/connectConfig.ts`
- `lib/commcare/validator/rules/sourceCaseWrites.ts` (new)
- `lib/commcare/validator/rules/sessionData.ts` (new)
- `lib/commcare/validator/rules/form.ts`
- `lib/commcare/validator/rules/field.ts`
- `lib/commcare/validator/rules/app.ts`
- `lib/commcare/validator/rules/caseOperations.ts`
- `lib/commcare/validator/errors.ts`
- `lib/commcare/validator/gate.ts`
- `lib/commcare/validator/runner.ts`
- `lib/commcare/validator/xpathValidator.ts`
- `lib/commcare/xform/sourceCaseWrites.ts` (new)
- `lib/commcare/xform/caseOps.ts` (calls the new predicates)
- `lib/commcare/expander.ts` (calls the new predicates)
- `lib/commcare/connectSlugs.ts`
- `lib/commcare/identifierValidation.ts`
- `lib/commcare/xpath/expressionAst.ts` (`hasExplicitPathContext`)
- `lib/preview/xpath/dependencies.ts` (`formRootReadPositions`)
- `components/builder/detail/formSettings/LearnConfig.tsx`
- `components/builder/detail/formSettings/DeliverConfig.tsx`
- `components/builder/detail/appSettings/ConnectEnableDialog.tsx`
- `components/builder/detail/appSettings/connectDraft.ts`
- `components/builder/app-setup/DeepLinksSection.tsx`
- `components/builder/app-setup/PublishingSection.tsx`
- `components/builder/app-setup/publishingSectionModel.ts`
- `components/builder/app-setup/usePublishingRecords.ts` (new)
- `components/builder/editor/fields/optionsDraftModel.ts`
- `lib/agent/planningSchemas.ts`
- `lib/agent/toolSchemaGenerator.ts` (the question id description)
- `lib/agent/tools/case-operations/shared.ts`
- `lib/agent/tools/entry-points.ts`
- `lib/agent/tools/shared/connectIds.ts`
- `lib/models.ts`
- `lib/notices/` (the reasons and their renderers)

**Nova tests named outright**

- `lib/commcare/__tests__/xformDocArbitrary.ts` (the generators map their draws)
- `lib/commcare/__tests__/connectWireFixtures.ts` (named uuids; part 09, Corpus changes)
- `lib/commcare/__tests__/expander.test.ts` (two refusal tests; a Label in the empty-group form)
- `lib/commcare/__tests__/connectSlugs.test.ts`
- `lib/commcare/__tests__/connectDefaults.test.ts`

**The lane**

- `proof/native/producers/emit-connect-evidence.ts`
- `proof/native/steps/form_emission.py`
- `proof/native/test_connect_emission.py`
- `proof/native/core/ConnectRuntimeTest.java`
- `proof/checks/hq_own_reports.py` (the widened member)
- `proof/checks/test_hq_own_reports.py` (its case)
- `proof/checks/connect.py` (the widened member)
- `proof/checks/test_connect_unit.py` (its two tests over the task's form)
- `proof/connect/test_hq_own_rename.py`
- `proof/connect/conftest.py`
- `proof/connect/test_receiver.py`
- `proof/connect/test_forwarding.py`
- `proof/hq/test_endpoint_ids.py` (new)
- `proof/hq/entryPointIdVerdicts.ts` (new)
- `proof/formplayer/test_observe.py`
- `proof/formplayer/apps.py` (`form_written`)
- `proof/targeted/` (documents rewritten and removed)
- `proof/walk-stops.json`
- `proof/timings.json` (eight documents' groups leave)

**Scripts and the cutover**

- `scripts/test-schema.ts` (registers `configureConnect`, `addEntryPoint`, `updateEntryPoint`)
- `scripts/lib/hqRoundTripCutover/steps/` (the eight steps)
- `scripts/lib/hqRoundTripCutover/steps/relativePaths.ts` (new: the id steps' shared module)
- `scripts/lib/hqRoundTripCutover/transform.ts` (registers the eight steps)
- `scripts/lib/hqRoundTripCutover/report.ts`
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests and fixture expectations)

**Docs**

- `docs/plans/hq-round-trip/2-cutover-runbook.md` (the renamed Connect blocks of step 1(d))
- `proof/README.md`

### Pull request 11: Case lists

**Nova source**

- `lib/domain/caseListOrder.ts` (new)
- `lib/domain/modules.ts`
- `lib/domain/standardCaseProperties.ts` (`ATTRIBUTE_BACKED_COLUMN_PROPERTIES`)
- `lib/domain/translationUnits.ts`
- `lib/domain/mediaRefs.ts`
- `lib/domain/casePropertyTypes.ts` (a comment)
- `lib/commcare/hqJson/caseList.ts`
- `lib/commcare/suite/case-list/` (the list emitters)
- `lib/commcare/suite/case-search/searchSession.ts`
- `lib/commcare/suite/case-search/relatedCaseProjection.ts`
- `lib/commcare/compiler.ts`
- `lib/commcare/expander.ts` (finding 41's text; finding 54's languages)
- `lib/commcare/hqShells.ts` (`caseSearchConfigShell`, `moduleShell`)
- `lib/commcare/types.ts`
- `lib/commcare/lookup/naming.ts`
- `lib/commcare/surface/entries/menus-and-case-lists.json`
- `lib/doc/userFacingErrors.ts`
- `lib/commcare/validator/rules/case-list/idMappingKeyCharacters.ts` (new)
- `lib/commcare/validator/rules/case-list/caseTileHiddenCalculatedSort.ts` (new)
- `lib/commcare/validator/rules/case-list/dateColumnPattern.ts` (new)
- `lib/commcare/validator/rules/case-list/sortPropertyOwnership.ts` (new)
- `lib/commcare/validator/rules/case-list/shared.ts`
- `lib/commcare/validator/rules/case-list/caseTileLayout.ts` (its header comment)
- `lib/commcare/validator/rules/module.ts` (registers the four rules)
- `lib/commcare/validator/errors.ts`
- `lib/commcare/validator/gate.ts`
- `lib/commcare/validator/hqJsonOracle.ts` (refuses the former spellings)
- `lib/preview/engine/caseDataBindingHelpers.ts`
- `lib/preview/engine/caseListOrder.ts` (new)
- `lib/preview/engine/caseDataBinding.ts`
- `lib/preview/hooks/useCaseDataBinding.ts`
- `lib/preview/caseTileRendering.ts`
- `components/preview/shared/listFilter.tsx`
- `lib/case-store/store.ts` (`SortKey`)
- `lib/case-store/postgres/store.ts` (the comparator; the blanks term)
- `lib/case-store/sql/compileIntervalText.ts` (new)
- `lib/case-store/sql/compileExpression.ts`
- `lib/case-store/sql/index.ts`
- `components/builder/case-list-config/`
- `components/builder/shared/datePatternDraft.ts`
- `components/builder/shared/primitives/CustomDatePatternInput.tsx`
- `lib/agent/tools/case-list-config/`
- `lib/agent/tools/updateModule.ts` (`case_list_columns`)
- `lib/agent/summarizeBlueprint.ts` (a comment)
- `lib/models.ts`
- `lib/notices/` (the reasons and their renderers)

**Nova tests named outright**

- `lib/domain/__tests__/translationUnits.test.ts` (new)
- `lib/commcare/suite/case-search/__tests__/caseSearch.integration.test.ts`
- `lib/commcare/__tests__/expander.test.ts` (eleven tests take new assertions)
- `lib/commcare/__tests__/hqJsonOracle.test.ts` (the attribute-backed sort case)
- `lib/commcare/__tests__/suiteDocArbitrary.ts` (`lowerToDoc`)
- `lib/commcare/__tests__/localizationWireFixture.ts` (`localization-bilingual`'s order rule)
- `lib/commcare/__tests__/caseListOrderParity.test.ts` (new)
- `lib/commcare/__tests__/hiddenCalculatedInstances.test.ts` (new)
- `lib/commcare/__tests__/casePropertyWire.test.ts`
- `lib/commcare/__tests__/caseListEmissionFixture.ts`
- `lib/commcare/__tests__/searchEmission.test.ts`
- `lib/commcare/__tests__/tileEmissionParity.test.ts`
- `lib/preview/__tests__/caseTile.test.ts`
- `e2e/tests/browser/case-workspace-surface.spec.ts`
- `e2e/tests/browser/preview-cases-audit.spec.ts`

**The lane**

- `proof/native/core/CaseListRuntimeTest.java`
- `proof/native/core/TileSuiteRuntimeTest.java`
- `proof/targeted/documents/` (new and rewritten documents)
- `proof/targeted/index.ts`
- `proof/rules/` (five retired rules' modules and tests)
- `proof/rules/__init__.py`
- `proof/rules/conftest.py`
- `proof/controls/`
- `proof/hq/test_fuzzy_sort_keys.py` (new)
- `proof/hq/test_date_pattern_characters.py` (new)
- `proof/editors/test_mapping_keys.py` (new)
- `proof/android/test_case_lists.py` (new)
- `proof/native/core/CaseListOrderRuntimeTest.java` (new)
- `proof/native/core/resources/case-list-order/orders.json` (new)
- `proof/native/families.py` (the new class's line)
- `proof/webapps/test_search.py`
- `proof/webapps/test_tiles.py`
- `proof/webapps/test_empty_list.py` (rewritten)
- `proof/formplayer/test_search.py`
- `proof/webapps/conftest.py` (`DOCUMENTS`)
- `proof/android/conftest.py` (`DOCUMENTS`)
- `proof/android/observe.py` (`app` takes `searches`)
- `proof/android/predicates.py` (finding 67's predicate)
- `proof/corpus/footprint.ts` (takes `caseListColumnRuns`)
- `proof/corpus/__tests__/footprint.test.ts` (its literal cell)
- `proof/timings.json` (the new documents' and controls' groups)

**Scripts and the cutover**

- `scripts/lib/hqRoundTripCutover/steps/` (the five steps)
- `scripts/lib/hqRoundTripCutover/transform.ts`
- `scripts/lib/hqRoundTripCutover/behavior.ts` (four no-write reasons)
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests and fixture expectations)

**Docs**

- `proof/README.md`

### Pull request 12: Menus, navigation and search settings

**Nova source**

- `lib/domain/forms.ts`
- `lib/domain/modules.ts`
- `lib/domain/navigation.ts`
- `lib/domain/postSubmit.ts`
- `lib/domain/menuForms.ts`
- `lib/domain/index.ts`
- `lib/domain/translationUnits.ts`
- `lib/domain/localizedBlueprintProjection.ts`
- `lib/domain/referenceSlots.ts`
- `lib/domain/predicate/simplify.ts`
- `lib/commcare/session.ts`
- `lib/commcare/expander.ts`
- `lib/commcare/compiler.ts` (`moduleCaseTypeForActions`)
- `lib/commcare/formLinkProjection.ts`
- `lib/commcare/previousTaskProjection.ts`
- `lib/commcare/localeFile.ts`
- `lib/commcare/suite/displayConditions.ts`
- `lib/commcare/suite/case-search/` (the search emitters)
- `lib/commcare/suite/case-search/reservedInputNames.ts` (new)
- `lib/commcare/hqShells.ts`
- `lib/commcare/hqJson/caseList.ts`
- `lib/commcare/types.ts`
- `lib/commcare/validator/hqJsonOracle.ts` (block 10's spellings; the button label)
- `lib/commcare/validator/errors.ts`
- `lib/commcare/validator/gate.ts`
- `lib/commcare/validator/rules/form.ts`
- `lib/commcare/validator/rules/module.ts`
- `lib/commcare/validator/rules/displayConditions.ts`
- `lib/commcare/validator/rules/hiddenFromMenu.ts` (new)
- `lib/commcare/validator/rules/case-search/searchFirst.ts` (`searchFirstNoPreviousWorkflow` deleted)
- `lib/commcare/validator/rules/case-search/searchNoMatches.ts`
- `lib/commcare/validator/rules/case-list/searchInputReservedName.ts` (new)
- `lib/commcare/surface/entries/case-search.json`
- `lib/commcare/surface/entries/forms-and-case-writes.json`
- `lib/commcare/surface/entries/menus-and-case-lists.json`
- `lib/doc/mutations/modules.ts`
- `lib/doc/mutations/forms.ts` (the destination reconciliation)
- `lib/doc/formLinkMutations.ts`
- `lib/doc/searchNoMatchesForm.ts`
- `lib/doc/displayConditionMutations.ts`
- `lib/doc/caseSearchConfigPatchMutations.ts`
- `lib/doc/projectBuilderLanguageMutations.ts`
- `lib/doc/searchInputMutations.ts`
- `lib/doc/lookupReferences.ts`
- `lib/doc/diffDocsToMutations.ts`
- `lib/doc/types.ts`
- `lib/doc/userFacingErrors.ts`
- `lib/doc/hooks/useFormLinkFacts.ts`
- `lib/doc/hooks/useFormLinks.ts`
- `lib/preview/afterSubmitRouting.ts`
- `lib/preview/noMatchesForm.ts`
- `lib/preview/menuProjection.ts`
- `lib/preview/screenProjection.ts`
- `lib/preview/entryPointLaunch.ts`
- `lib/preview/workerModule.ts`
- `lib/preview/app-tests/submission.ts`
- `lib/preview/app-tests/navigation.ts`
- `lib/preview/engine/navigationProjection.ts`
- `lib/preview/engine/postSubmissionEvaluation.ts`
- `lib/preview/engine/formLinkEvaluation.ts`
- `lib/preview/engine/previousTask.ts`
- `lib/preview/engine/displayConditionEvaluation.ts`
- `lib/preview/engine/lookupEvaluation.ts`
- `lib/preview/engine/searchExpressionEvaluation.ts`
- `components/preview/screens/FormScreen.tsx`
- `components/preview/screens/HomeScreen.tsx`
- `components/preview/screens/ModuleScreen.tsx`
- `components/preview/screens/CaseListScreen.tsx`
- `components/builder/detail/formSettings/`
- `components/builder/detail/moduleSettings/ModuleSettingsPanel.tsx`
- `components/builder/form-links/`
- `components/builder/conditions/`
- `components/builder/case-list-config/noMatchesFormReview.tsx`
- `components/builder/case-list-config/CaseListConfigWorkspace.tsx`
- `components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx`
- `components/builder/case-list-config/inspector/SearchChoiceSourceEditor.tsx`
- `components/builder/app-setup/LanguagesSection.tsx`
- `components/builder/shared/editorSchemas.ts`
- `lib/agent/tools/createForm.ts`
- `lib/agent/tools/updateForm.ts`
- `lib/agent/tools/getForm.ts`
- `lib/agent/tools/updateModule.ts`
- `lib/agent/tools/getModule.ts`
- `lib/agent/tools/entry-points.ts`
- `lib/agent/tools/shared/formEntry.ts`
- `lib/agent/tools/form-links/`
- `lib/agent/tools/case-search-config/shared.ts`
- `lib/agent/tools/case-list-config/shared.ts`
- `lib/agent/tools/case-list-config/addSearchInputs.ts`
- `lib/agent/tools/case-list-config/updateSearchInput.ts`
- `lib/agent/summarizeBlueprint.ts`
- `lib/agent/blueprintHelpers.ts`
- `lib/agent/identitySchema.ts`
- `lib/agent/authoring/output.ts`
- `lib/agent/translation/translator.ts`
- `lib/models.ts`
- `lib/notices/` (the reasons and their renderers)

**Nova tests named outright**

- `lib/commcare/surface/__tests__/reservedInputNames.test.ts` (new)
- `lib/commcare/__tests__/` (the emission and rule tests)
- `lib/commcare/__tests__/hiddenFromMenu.validation.test.ts` (new)
- `lib/commcare/__tests__/searchEmissionFixture.ts`
- `lib/doc/mutations/__tests__/searchFirstPostSubmit.test.ts` (moved to `postSubmitMenuShape.test.ts`)
- `lib/doc/mutations/__tests__/postSubmitMenuShape.test.ts` (new: the renamed test)
- `lib/doc/__tests__/multiplayerMerge.test.ts`
- `lib/doc/__tests__/mutations-modules.test.ts`
- `lib/preview/app-tests/__tests__/journey.postgres.test.ts`
- `components/preview/__tests__/formScreenAfterSubmit.test.ts`
- `components/preview/screens/__tests__/noMatchesForm.test.ts`
- `e2e/lib/formLinksSeed.ts`
- `e2e/lib/caseChangesSeed.ts`
- `e2e/lib/previousTaskSeed.ts`
- `e2e/lib/caseWorkspaceSeed.ts`
- `e2e/lib/case-workspace-surface-client.tsx`
- `e2e/tests/browser/case-workspace-surface.spec.ts`
- `e2e/tests/app/authed.spec.ts`
- `lib/agent/tools/case-search-config/__tests__/setCaseSearchDisplay.test.ts` (loses its cases on the button label)
- `lib/agent/tools/case-search-config/__tests__/schema.test.ts` (loses its cases on the button label)
- `lib/agent/tools/case-search-config/__tests__/setCaseSearchAdvanced.test.ts` (loses its cases on the button label)
- `lib/agent/tools/case-list-config/__tests__/configureCaseList.test.ts`
- `lib/agent/__tests__/lookupAuthorBoundary.test.ts`
- `lib/agent/authoring/__tests__/schema.test.ts`

**The lane**

- `proof/targeted/documents/hiddenFromMenu.ts` (new)
- `proof/targeted/documents/searchApps.ts` (loses the button-label maker)
- `proof/targeted/documents/multiSelectDestinations.ts`
- `proof/targeted/documents/stableWitnesses.ts`
- `proof/targeted/index.ts`
- `proof/targeted/__tests__/stableWitnesses.test.ts`
- `proof/native/core/SearchRuntimeTest.java`
- `proof/native/core/SearchPromptRuntimeTest.java`
- `proof/native/test_search_emission.py`
- `proof/hq/test_case_search.py`
- `proof/android/navigation.py` (new)
- `proof/android/test_navigation.py` (new)
- `proof/android/conftest.py` (`DOCUMENTS` gains two documents)
- `proof/android/src/nova/proof/android/Nav.java` (new)
- `proof/android/src/nova/proof/android/Reader.java` (the `nav` request)
- `proof/android/src/nova/proof/android/Queries.java` (each dropdown's items)
- `proof/formplayer/test_end_of_form.py`
- `proof/formplayer/test_search.py`
- `proof/formplayer/conftest.py`
- `proof/webapps/test_links.py`
- `proof/webapps/test_search.py`
- `proof/webapps/conftest.py`
- `proof/corpus/footprint.ts`
- `proof/timings.json` (a document's groups enter, another's leave)

**Scripts and the cutover**

- `scripts/test-schema.ts` (registers `addFormLinks`, `updateFormLink`; the `configureCaseList` prompt)
- `scripts/lib/hqRoundTripCutover/steps/` (this pull request's steps)
- `scripts/lib/hqRoundTripCutover/transform.ts` (registers the steps)
- `scripts/lib/hqRoundTripCutover/behavior.ts`
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests and fixture expectations)

**Docs**

- `proof/android/README.md`
- `proof/README.md`

### Pull request 13: Publish gates

**Nova source**

- `lib/deployment/preflight.ts`
- `lib/deployment/service.ts`
- `lib/deployment/store.ts`
- `lib/deployment/types.ts`
- `lib/deployment/actions.ts`
- `lib/deployment/importApplication.ts`
- `lib/deployment/setupArtifact.ts`
- `lib/deployment/workerRecordRequirements.ts` (its function moves to `lib/domain/`)
- `lib/domain/workerRecordRequirements.ts` (new)
- `lib/commcare/planPrivileges.ts` (new)
- `lib/commcare/planPrivilegePlans.json` (new)
- `lib/commcare/projectSpaceCompatibility.ts`
- `lib/commcare/hqShells.ts`
- `lib/commcare/types.ts`
- `lib/commcare/expander.ts` (`APP_SHELL_KEYS` loses `build_spec`)
- `lib/commcare/locations/readsLocationsFixture.ts` (new)
- `lib/commcare/versionFloor.ts` (`compareToVersionFloor`)
- `lib/commcare/hq/appSource.ts` (`cloudcareEnabled`, `logoRefs`)
- `lib/commcare/connectDefaults.ts`
- `lib/commcare/connectSlugs.ts`
- `lib/commcare/caseOptions.ts`
- `lib/commcare/xform/caseOps.ts` (`formEmitsSaveToCase`)
- `lib/commcare/xform/builder.ts`
- `lib/commcare/suite/case-search/searchPrompts.ts`
- `lib/commcare/suite/case-search/xpathQuery.ts` (with a new test)
- `lib/commcare/formLinkProjection.ts`
- `lib/commcare/compiler.ts`
- `lib/commcare/client.ts`
- `lib/commcare/targetLogoRefs.ts` (new)
- `lib/commcare/multimedia/logoEntry.ts`
- `lib/commcare/multimedia/hqJsonExportArchive.ts`
- `lib/commcare/validator/hqJsonOracle.ts`
- `lib/commcare/validator/errors.ts`
- `lib/commcare/validator/gate.ts`
- `lib/commcare/surface/entries/gates.json`
- `lib/commcare/surface/entries/application-and-settings.json`
- `lib/domain/mediaRefs.ts` (`uncarriedLogoAsset` removed)
- `lib/doc/hooks/useUncarriedLogo.ts` (deleted)
- `lib/media/uploadOutcome.ts`
- `lib/export/boundaryValidation.ts` (a comment)
- `lib/publish/planFeatures.ts` (new)
- `lib/publish/manualImportGuide.ts`
- `lib/publish/projectSpaceCompatibility.ts`
- `app/api/commcare/upload/route.ts`
- `app/api/commcare/project-space-compatibility/route.ts`
- `app/api/compile/json/route.ts`
- `components/builder/PublishDialog.tsx`
- `components/builder/PublishPanel.tsx`
- `components/builder/publishOutcome.ts`
- `components/builder/DeploymentStatus.tsx`
- `components/builder/app-setup/PublishingSection.tsx`
- `components/builder/app-setup/publishingSectionModel.ts`
- `components/builder/detail/appSettings/AppAppearanceSection.tsx`
- `components/docs/ProjectSpaceCapabilityCatalog.tsx`
- `lib/mcp/tools/uploadAppToHq.ts`
- `lib/mcp/tools/checkProjectSpaceCompatibility.ts`
- `lib/mcp/tools/deploymentProjection.ts`
- `lib/mcp/tools/deploymentTools.ts`
- `lib/mcp/tools/compileApp.ts`
- `lib/mcp/tools/withdrawDeploymentConfirmation.ts` (new)
- `lib/mcp/server.ts`
- `lib/mcp/errors.ts`
- `lib/agent/tools/media/setAppLogo.ts`
- `lib/models.ts`
- `lib/notices/` (the three reasons and their renderers)

**Nova tests named outright**

- `lib/deployment/__tests__/publishGates.postgres.test.ts` (new)
- `lib/deployment/__tests__/confirmations.postgres.test.ts` (new)
- `lib/deployment/__tests__/publishSequence.postgres.test.ts` (the exact-key expectation)
- `lib/commcare/__tests__/targetLogoRefs.test.ts` (new)
- `lib/commcare/__tests__/compilerEvidence.ts` (four new assertions)
- `lib/commcare/__tests__/hqJsonOracle.test.ts` (loses its `logo_refs` block)
- `lib/commcare/__tests__/projectSpaceCompatibilityProbe.test.ts`
- `lib/commcare/__tests__/projectSpaceCompatibilityTransport.test.ts`
- `lib/commcare/surface/__tests__/gates.test.ts` (the new structural test)
- `lib/domain/__tests__/mediaRefDescribe.test.ts` (loses that function's cases)
- `e2e/tests/browser/publishing.spec.ts`
- `e2e/lib/publishing-boundary.ts`
- `lib/mcp/__tests__/` (the tools' Postgres tests)

**The lane**

- `proof/corpus/publish.ts`
- `proof/corpus/targetPeer.ts` (`buildSpecVersion`)
- `proof/corpus/hq/test_privileges.py`
- `proof/checks/configurations.py`
- `proof/checks/test_corpus.py`
- `proof/native/test_location_emission.py`
- `proof/views/test_linked_logos.py`
- `proof/views/test_case_list_offers.py` (rewritten)
- `proof/views/test_location_fixture.py` (rewritten)
- `proof/webapps/test_app_list.py`
- `proof/connect/hq.py`
- `proof/connect/test_forwarding.py`
- `proof/hq/seams.py` (`withheld`)
- `proof/android/predicates.py` (one new test)
- `proof/hq/test_version_floor.py` (new)
- `proof/hq/test_plan_features.py` (new)
- `proof/hq/test_flag_probe.py` (new)
- `proof/hq/test_logos.py` (new)
- `proof/editors/test_version_raise.py` (new)
- `proof/editors/test_plan_features.py` (new)
- `proof/editors/test_gated_pages.py` (new)
- `proof/targeted/documents/customTile.ts`
- `proof/walk-stops.json`
- `proof/fixed-defects.json`
- `proof/controls/expander-form-links-emission-emits-hq-form-links-with-3555b968-0/` (removed)
- `proof/timings.json` (the removed control's group)

**Scripts and the cutover**

- `scripts/lib/hqRoundTripCutover/notice.ts` (three deployment lines)
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests)

**Docs**

- `proof/README.md`

### Pull request 14: Lookup, CSQL, media and the model clean-up

**Nova source**

- `lib/lookup/` (the tag's rules)
- `lib/deployment/lookupResourcePlan.ts`
- `lib/deployment/preflight.ts`
- `lib/deployment/service.ts`
- `lib/deployment/types.ts` (`hq_table_content_unsupported`)
- `lib/deployment/remoteChanges.ts` (`LOOKUP_DISCARD_NOTE`)
- `lib/commcare/lookup/workbook.ts`
- `lib/commcare/hq/lookupTables.ts` (the upload arm)
- `lib/export/boundaryValidation.ts`
- `lib/commcare/validator/lookupReferences.ts`
- `lib/commcare/validator/timeOrdering.ts` (new)
- `lib/commcare/validator/index.ts`
- `lib/commcare/validator/errors.ts`
- `lib/commcare/validator/gate.ts`
- `lib/commcare/validator/xformOracle.ts`
- `lib/commcare/validator/mediaSuiteOracle.ts`
- `lib/commcare/validator/rules/app.ts`
- `lib/commcare/validator/rules/field.ts`
- `lib/commcare/validator/rules/media/shared.ts`
- `lib/domain/predicate/typeChecker.ts`
- `lib/domain/standardCaseProperties.ts`
- `lib/domain/modules.ts`
- `lib/domain/mediaRefs.ts`
- `lib/domain/referenceSlots.ts`
- `lib/domain/casePreload.ts`
- `lib/domain/effectiveCaseTypes.ts`
- `lib/domain/multimedia.ts`
- `lib/domain/fields/` (ten kinds lose `validate_msg_media`)
- `lib/domain/fields/base.ts`
- `lib/domain/fields/hidden.ts`
- `lib/domain/fields/file.ts`
- `lib/domain/fields/index.ts`
- `lib/commcare/predicate/` (the predicate emitters)
- `lib/commcare/predicate/runtimeCsqlDateSafety.ts` (new)
- `lib/commcare/suite/case-search/xpathQuery.ts` (the blank-comparand obligation)
- `lib/commcare/constants.ts`
- `lib/commcare/hqShells.ts`
- `lib/commcare/types.ts`
- `lib/commcare/xform/builder.ts`
- `lib/commcare/xform/constraintMessage.ts`
- `lib/commcare/xform/captureUpload.ts` (a comment)
- `lib/commcare/multimedia/mediaSuiteXml.ts`
- `lib/commcare/multimedia/assetWirePath.ts` (a comment)
- `lib/commcare/surface/media-formats.json`
- `lib/commcare/surface/surface.json`
- `lib/commcare/surface/entries/questions.json`
- `lib/commcare/surface/entries/expressions-and-data.json`
- `lib/media/validate.ts`
- `lib/media/bmp.ts` (new)
- `lib/media/webm.ts` (new)
- `lib/doc/userFacingErrors.ts`
- `lib/doc/types.ts` (`FIELD_MEDIA_SLOTS`)
- `lib/doc/diffDocsToMutations.ts`
- `lib/doc/mutations/fields.ts`
- `lib/doc/hooks/useBlueprintMutations.ts`
- `lib/preview/engine/searchInputValidation.ts`
- `lib/preview/engine/caseDataBinding.ts` (the blank-comparand obligation)
- `lib/preview/engine/formPresentation.ts`
- `components/preview/form/` (the components that drew the removed media)
- `components/preview/form/newFieldDefaults.ts`
- `components/preview/form/InteractiveFormRenderer.tsx`
- `components/builder/PublishDialog.tsx`
- `components/builder/editor/fieldEditorSchemas.ts`
- `components/builder/editor/fields/hiddenValueModel.ts`
- `components/builder/editor/fields/HiddenValueEditor.tsx`
- `components/builder/editor/fields/MediaSlotEditor.tsx` (a comment)
- `components/builder/case-list-config/inspector/SearchInputEditor.tsx`
- `components/builder/media/assetKindMeta.ts`
- `components/builder/shared/checkErrorPresentation.ts`
- `components/builder/shared/editorSchemas.ts`
- `components/builder/shared/cards/PredicateVerbMenu.tsx`
- `components/chat/ChatInput.tsx`
- `app/(dev-only)/rejection-test/page.tsx`
- `lib/codemirror/xpath-lint.ts`
- `lib/agent/tools/media/shared.ts`
- `lib/agent/tools/media/attachFieldMedia.ts`
- `lib/agent/tools/case-list-config/addSearchInputs.ts`
- `lib/agent/tools/case-list-config/shared.ts`
- `lib/agent/tools/editField.ts`
- `lib/agent/tools/addFields.ts`
- `lib/agent/toolSchemaGenerator.ts`
- `lib/agent/documentExtraction.ts`
- `lib/agent/resolveAttachments.ts`
- `lib/agent/sources.server.ts`
- `lib/mcp/tools/uploadAppToHq.ts`
- `lib/mcp/tools/uploadMediaAsset.ts`
- `lib/mcp/errors.ts`
- `lib/models.ts`
- `lib/notices/` (the reasons and their renderers)

**Nova tests named outright**

- `lib/case-store/migrations/__tests__/lookupTables.postgres.test.ts`
- `lib/commcare/surface/__tests__/manifest.test.ts`
- `lib/commcare/__tests__/mediaWireFixtures.ts`
- `lib/commcare/__tests__/xformDocArbitrary.ts`
- `lib/commcare/__tests__/constraintMessageFixture.ts`
- `lib/commcare/__tests__/constraintMessageEmission.test.ts`
- `lib/commcare/__tests__/reservedInstanceTags.test.ts`
- `lib/commcare/__tests__/mediaSuiteOracle.test.ts`
- `lib/commcare/__tests__/hqLookupTables.test.ts` (reads pull request 4's retained answers)
- `lib/media/__tests__/fixtures/` (a file for each new format and near miss)
- `lib/media/__tests__/bmpFixtures.ts` (new)
- `lib/preview/engine/__tests__/constraintMessages.test.ts` (follows the fixture)
- `e2e/tests/browser/media-play.spec.ts` (new)
- `e2e/tests/browser/media-transport.spec.ts`
- `e2e/tests/browser/publishing.spec.ts`

**The lane**

- `proof/targeted/documents/timeOrdering.ts` (deleted)
- `proof/targeted/documents/` (the rewritten documents)
- `proof/targeted/index.ts`
- `proof/checks/manifest_value_classes.py` (`time_operand`; the protected-message reader)
- `proof/checks/test_manifest_value_classes.py`
- `proof/checks/test_hq_side.py`
- `proof/hq/test_lookup_upload.py`
- `proof/hq/test_publish.py`
- `proof/hq/test_case_processing.py`
- `proof/hq/test_build.py`
- `proof/views/test_lookup_upload.py` (its docstring)
- `proof/views/__tests__/lookupUploadAnswer.test.ts` (turned over)
- `proof/core/test_evaluate.py`
- `proof/formplayer/test_lookup_tags.py` (new)
- `proof/formplayer/test_media_slots.py`
- `proof/formplayer/test_search.py`
- `proof/formplayer/conftest.py`
- `proof/formplayer/apps.py` (`with_the_media_slots`)
- `proof/formplayer/media_slots/` (new: the two forms as emitted before)
- `proof/webapps/test_media_slots.py`
- `proof/android/predicates.py`
- `proof/android/decode/DecodeProbe.java` (new)
- `proof/android/decode/run.sh` (new)
- `proof/android/decode/probe.py` (new)
- `proof/native/test_lookup_workbook.py`
- `proof/native/test_quote_payload.py`
- `proof/native/test_media_emission.py`
- `proof/native/core/CsqlQuoteRuntimeTest.java`
- `proof/native/core/StaticQuoteRuntimeTest.java`
- `proof/native/core/MediaRuntimeTest.java`
- `proof/native/producers/emit-media-evidence.ts`
- `proof/native/steps/media_emission.py`
- `proof/corpus/editBatches.ts` (a comment)
- `proof/corpus/__tests__/publishReadiness.test.ts`
- `proof/corpus/__tests__/publish.postgres.test.ts` (the lookup refusal's cases)
- `proof/surface/families/authored.py`
- `proof/walk-stops.json`
- `proof/timings.json` (groups added and removed)

**Scripts and the cutover**

- `scripts/test-schema.ts` (the `attachFieldMedia` prompt)
- `scripts/lib/hqRoundTripCutover/steps/` (this pull request's steps)
- `scripts/lib/hqRoundTripCutover/transform.ts` (registers the steps)
- `scripts/lib/hqRoundTripCutover/lookupTags.ts` (new)
- `scripts/lib/hqRoundTripCutover/plan.ts`
- `scripts/lib/hqRoundTripCutover/writer.ts`
- `scripts/lib/hqRoundTripCutover/notice.ts`
- `scripts/lib/hqRoundTripCutover/report.ts`
- `scripts/rollout/verify-runtime-packages.mjs`
- `scripts/lib/hqRoundTripCutover/__tests__/` (the modules' tests and fixture expectations)

**CI and config**

- `playwright.config.ts` (the `browser-webkit` project)
- `.github/workflows/ci.yml` (the smoke job runs WebKit too)

**Docs**

- `proof/README.md`

### Pull request 15: Contracts and public docs

**The lane**

- `proof/checks/registers.py` (`OPEN_DEFECTS`, new)
- `proof/checks/test_registers.py` (`test_every_live_defect_is_a_later_steps`)
- `proof/timings.json` (refreshed in both profiles)

**Docs**

- `CLAUDE.md` (root and subtree files; Contract sentences step 2 rewrites)
- `docs/architecture/contracts.md`
- `content/docs/` (Public docs that change)

### Pull request 16: Removal of the cutover tooling

**The lane**

- `proof/hq/test_retained_reads.py` (the `cutover` group leaves)
- `proof/hq-reads/cutover/` (deleted)

**Scripts and the cutover**

- `scripts/scan-hq-round-trip-cutover.ts` (deleted)
- `scripts/migrate-hq-round-trip-cutover.ts` (deleted)
- `scripts/lib/hqRoundTripCutover/` (deleted, with tests and fixtures)
- `scripts/rollout/deploy-cloud-run.py` (the Job's arm)
- `scripts/infra/` (the Job's cases)

**CI and config**

- `biome.json` (the fold's lint exclusion leaves)
- `Dockerfile` (the Job's `esbuild` line)
- `config/deployment-jobs.json` (the Job)

**Docs**

- `scripts/README.md` (the Job's line)
- `docs/architecture/deployment.md` (the Job's paragraph)
- `docs/plans/hq-round-trip/2-cutover-runbook.md` (deleted)
- `docs/plans/hq-round-trip/2-emission-and-publish.md` (deleted)
- `docs/plans/hq-round-trip/2-emission-and-publish/` (deleted)
- `proof/README.md` (the retained reads' `cutover` clause)

## What every pull request of the stack does

- A pull request that changes a stored shape adds its transform step under `scripts/lib/hqRoundTripCutover/steps/`, registers it in `transform.ts`, adds its notice reason and renderer, and adds its expectations over the frozen pre-step fixtures, all in that pull request. At every point of the stack the migrate script is therefore complete for the shape that point reads, which is how "a stored-shape change never merges without its migration" holds inside a stack that merges together. A pull request whose change stores nothing and still gets a line adds its reason's selection function to `scripts/lib/hqRoundTripCutover/behavior.ts` in the same way, and one whose reason is a deployment's adds its line to `notice.ts`. The Job's own steps land with their owners: the deployment reads and the matcher in pull request 3 (`hqRead.ts`, `matching.ts`), the baseline reads and writes in pull request 4 (`writer.ts`), and the lookup tag rename in pull request 14 (`lookupTags.ts`). Part 10, Scripts and their layout, gives each module's pull request.
- `transform.ts` holds the steps in one fixed order, which is not the order of the pull requests: `language-wire-codes`, `media-slots`, `hidden-inert-default`, `search-button-label`, `question-ids`, `case-operation-ids`, `connect-ids`, `connect-task-forms`, `entry-point-ids`, `option-values`, `option-labels`, `empty-forms`, `unsupplied-session-reads`, `reserved-search-inputs`, `time-ordering`, `hidden-from-menu`, `post-submit`, `id-mapping-keys`, `date-patterns`, `tile-hidden-calculated-sort`, `sort-property-ownership`, `tile-cells`, `app-settings`. A pull request inserts its step at that position, never at the end. The order is identity additions, then removals, then renames (later steps name questions), then semantic moves, then case lists, then the one step that takes values read from HQ. That order is part 10's (The transform steps, in order), which is the registry; where the two lists ever differ, part 10's holds. `option-labels` follows `option-values`, so a filled label is the value the option keeps. `time-ordering` runs before `hidden-from-menu`: the first only replaces comparisons and writes no flag, and the second, the only step that sets the flag, must see every `match-none` the first wrote. The table's step column gives each step id with the notice reasons it mints in brackets; a "no-write" reason is a line for a change that stores nothing (part 10, Changes that write nothing and still get a line), and each reason's copy is where part 10's reason tables say it is.
- A fix moves its entries to the fixed register and retires its rule (the module, its test, its reader tests, its import and its `RULES` line) in its own pull request. One reader test a retired rule names stays, because registered entries rest on it too (part 09, The spelling rules, row 20).
- A pull request that removes a document, or whose fix removes the cause of a held walk stop, changes that stop's entry in `proof/walk-stops.json` in the same change: to the control that still shows it, or out of the list where none does. A pull request that retains a control under another name from a document that holds a stop adds that control's entry. The list names only documents the corpus holds and directories `proof/controls/` holds (part 09, The held walk stops, gives each of the 33 its disposition).
- A validator narrowing runs the corpus emission first (no Docker), diffs `index.json`'s document ids before and after, and rewrites or removes each document it refuses (part 09, Corpus changes). An expander document's id is built from its test's title and its index among that test's documents (`proof/corpus/documents.ts::readExpanderCapture`), so retitling a test in `lib/commcare/__tests__/expander.test.ts` renames documents.
- A pull request writes `lib/commcare/surface/entries/gates.json`'s `effects` again when its sensitivity check fails on a difference a flipped gate made that the effects do not name, and when it adds or removes a gate entry. Each pull request that changes an emitter, adds a corpus document or changes a gate entry therefore runs the sensitivity check whole and fresh on a proof machine before it pushes, and writes the effects from that run where the check fails so (`python3 -m proof.checks.sensitivity effects <output>/blocks/* --corpus <output>/corpus`), committing them with the diff reviewed; where the check passes it commits nothing. Part 09, Where the lane runs, gives the command and the two other routes. Pull request 13 is the one that also edits gate entries' `content`.
- A pull request that adds or deletes a control directory, or a corpus document, updates `proof/timings.json` in each profile that holds the group: a new group is measured in, a deleted one removed (part 09, Corpus changes, names each). A document's groups are in both profiles. A control's is in the `readers` profile alone where every entry that names it is a served reader's, as 15 of the lane's 84 are. A test added to a package or taken out of one changes no group, since a module runs in its package's group unless `proof/checks/sharding.py::SPLIT` names it: so the `cutover` group of `proof/hq/test_retained_reads.py` edits nothing in `proof/timings.json` when it arrives in pull request 3 or leaves in pull request 16, and pull request 15's refresh measures the package with it (part 10, Block: the cutover, Files).
- From pull request 3 the lane writes every file under `proof/hq-reads/` again on each run and holds the committed copy to it byte for byte (`proof/hq/test_retained_reads.py`, and from pull request 4 `proof/editors/test_retained_reads.py`). A pull request that changes a byte Nova publishes for a document those reads are made of, or the ownership descriptor beside them, therefore commits the files again in that pull request: it copies `.proof/out/blocks/<id>/hq-reads/` over `proof/hq-reads/` and reviews the diff against what its own change sends (part 09, The retained HQ reads for the drift comparator; part 02, The retained HQ reads). Pull request 5 is the first, with `navigation-base`'s read after the Add-ons save and its `ownership.json` (part 04, Defect 4). A difference the pull request's change does not explain is a failure to find, never a file to commit. The legacy upload bodies under `proof/hq-reads/cutover/<document>/legacy/` are the pre-step emitter's and are never written again (part 10, The proofs that carry the cutover).
- A pull request that changes the name, the description or the input schema of a tool the Solutions Architect is offered, or the authoring guide, bumps `lib/models.ts::MODEL_CONTEXT_VERSION` in that pull request. Item 13 of the checklist below lists the nine that do and the value each sets.
- A pull request that changes what the billed schema check sends says so in its fix's block. The check is `npm run test:schema`, which bills one live OpenAI request for each schema it sends, so no pull request of the stack runs it at its own head. It is asked for once for the stack, at the head of pull request 14 after the last tool edit, as one question that gives the number of billed requests and names each schema; on a yes the implementer runs `npm run test:schema -- <schema name>` once per named schema, which bills one request per named schema and none for any other. The model-addition checklist, item 14, is the one statement of what the check sends, of the 20 schemas the question names, of the pull request that registers each new one in `scripts/test-schema.ts`, and of the question's words. Reason: the stack deploys once, so only the tool definitions at its top reach the provider, and a per-pull-request ask would bill the same schemas again at each later head. A schema the provider refuses is fixed in the pull request that owns it and the question is asked again for that schema alone.
- No pull request of this step adds an `/api` route (`/api/compile` and `/api/commcare/upload` gain inputs). A route added during implementation needs its `lib/hostnames.ts` allowlist entry in the same pull request, or the proxy answers 404 in production while localhost serves it.

## Ordering constraints

| Constraint | Reason |
|---|---|
| The proof lane's own pull request merges onto `main`, at `7b153dc3` or later, before the stack is cut | Every count of this plan is of the register that pull request merges, and its pull request lane, nightly, weekly and `proof/remote/` are how every pull request below proves itself |
| Lane mechanics is first | A fix cannot move an entry to a register that does not exist, and a control must be retained from the pre-fix corpus. Findings 56's, 57's, 70's and 71's controls and finding 43's `parsererror` control can only be captured before the fixes that silence them, and so can the second menu of `targeted-shared-property-sort`, whose pre-fix bytes its control must hold |
| `targeted-hq-side-state` is split in pull request 1 | Its entries need a republish (B) to land. Defect 5's refusal is the one stop with no discard, so with the table on its own document (`targeted-hq-side-lookup`) the other 14 entries never lose B. Defect 5 is still last among the fixes |
| The frozen pre-step fixtures are captured in pull request 2, before any shape change | They are the only witnesses of the old shape once the tree's fixtures change. Pull request 1 changes no emitter, so capturing after it loses nothing. The frozen fold (`scripts/lib/hqRoundTripCutover/prestep/prestepFold.generated.mjs`) is built there too, from the last tree that holds the pre-step reducer and schema: pull request 3 changes the mutation dialect and deletes the fold's entry, build script and inputs test, and a rebase that changes one of the fold's inputs rebuilds it in pull request 2 (part 10, The matching algorithm, "The fold is the pre-step one, frozen") |
| The source reader and the floor's constant (3) before their consumers (4, 5, 13) | `readHqAppSource` and `lib/commcare/versionFloor.ts` are created in pull request 3. Pull request 4 reads the source's `raw` for the comparison, pull request 5 adds the overlay's typed fields and reads the floor for the local profile, and pull request 13 adds `compareToVersionFloor` and, on `HqAppSource`, `logoRefs` and `cloudcareEnabled`. Each extends the one type and the one reader. Pull request 4 adds the read after the import; pull requests 5 and 13 add no read: the overlays and the `logo_refs` cleanup are built on the publish's last read before the import, the floor reads the first, and the Web Apps line reads the read after the import |
| The shell's drift exemption lands with drift (4) | From pull request 4 a changed target stops the publish. The version floor's own next step is to raise the CommCare version on the shell in HQ, so without the exemption (origin `create` compares only `modules`) that step would always be followed by a discard prompt. A failed read after the create still records origin `unread`, which stops |
| Ledger tables (2) before the behavior that reads them (3, 4, 5, 13) | `remote_missing_at` and its backfill must exist before any publish can create a shell: without it the retry of a failed first update takes the create path and makes a second HQ app (`lib/deployment/resources.ts::plannedInPlaceUpdate`). Pull request 4 reads and writes the baseline tables, pull request 5 reads the empty-list text flag into `app_deployments.target_empty_case_list_text`, and pull request 13 writes the confirmation store and `offered_logo_content_hash` |
| Drift (4) carries the capture's confirmed discard for `hqSide` documents | From pull request 4 a republish over an HQ-side change stops; the documents that need B must confirm the discard in the same pull request or their entries stop showing |
| Drift (4) before app-level emission (5), with the owned-key sets behind one descriptor | The comparison reads the baseline's own ownership descriptor (`lib/commcare/appOwnership.ts::appOwnershipOf`), so pull request 5 extending the owned keys changes no stored baseline's meaning. Pull request 4 writes the descriptor's producer with today's sets; pull request 5 replaces that producer with the `ownership` `lib/commcare/targetOverlay.ts::projectApplicationForTarget` returns, deletes `appOwnership.ts`, and narrows the comparison of `translations` from the whole map to the owned-key predicate. No consumer names the producer |
| Wire codes (3) before the sort spellings (11) | A sort element's `display` is keyed by the first language's HQ code; `sort_display_empty` retires only once that code is stored |
| Wire codes and the reached targets (3) before app-level emission (5) | The local profile's `cur_locale` is the first language's stored wire code (`localization.wireCodes`; part 04, Finding 39), and finding 65's download path hands the chosen target's empty-list flag through `lib/deployment/downloadTarget.ts::resolveDownloadTarget` and `lib/deployment/store.ts::readReachedDeploymentTargets`, both written in pull request 3 (part 04, Finding 65) |
| The empty-list text (5) before finding 41 (11) | Finding 41's HQ JSON text reads the one constant `lib/commcare/suite/case-list/detailTexts.ts::EMPTY_CASE_LIST_TEXT`, which pull request 5 writes (part 04, Finding 65; part 06, 12. Finding 41) |
| `setAppSettings` (5), the stack's one new mutation kind, as early as its feature allows | A new kind rebalances the fixed producers' edit batches (`proof/corpus/editKinds.ts::EDIT_KIND_GENERATORS`), and a document's configurations follow its edit. Executed during planning on the lane's branch with main merged: the kind moves the edits of 107 documents and changes no register outcome; pull request 10's removal of two documents then moves 28 documents' edits and one entry's document, `d14-logos-media-unmatched-logo-refs` (part 09, How the harness keeps publishing as Nova publishes, Mutation kinds) |
| The working submit (3) before the fixes that own what it shows (5, 6, 9, 11) | From pull request 3 the local archive's submit reaches HQ, and Formplayer's record then shows nineteen classes at paths the owners' entries do not name. No control that exists shows them, since a pre-fix archive cannot submit. So pull request 3 registers them and retains nine `-after-59` controls from its own corpus, after A5's bytes and before those fixes; each owner in this stack moves its entry with its own, pull request 5 deletes the two version entries, the first with `targeted-hq-side-state-after-59`, and defect 24's five stay live on their controls, step 5's (part 01, A5) |
| Defect 9 (5) before defect 15 (10) | On `targeted-invalid-question-ids` defect 9's two unpinned proof 1 entries hold `/installs/*` and `/update` today, where HQ's build does not install on Android and the local archive does. Pull request 5 moves both to the fixed register, the update entry under its judge change, so it registers those paths as defect 15's, three entries pinned to their values, on `targeted-invalid-question-ids-after-9`, retained at its head. Pull request 10, where HQ's build of the document installs, moves them (part 04, Defect 9) |
| Finding 34 (5) before defect 15 (10) | `d34-connect-location-trace-meta-location` sits on `targeted-invalid-connect-ids`, which defect 15 rewrites, and its control `connect-location-capture` is retained from that document's pre-fix bytes as pull request 5's first commit. The rewrite keeps it a Connect app |
| Finding 62 (5) before defect 15 (10) | `d62-incomplete-forms-tile-webapps-app-settings-screens-tiles-incomplete` is pinned to `targeted-invalid-question-ids` and stops showing there once defect 15's rewrite lets the client's walks leave the first screen, so pull request 5 moves it before the document is rewritten (part 08, Defect 15, Lane) |
| XForm first part (6) before the rename (7) | 18 of pull request 6's entries (12 leaf-constraint, 4 datetime-leaf and 2 shadow entries) hold `__nova_` in their paths. A fixed entry must show on its control, and a control keeps its pre-fix bytes, so each is fixed while its document still spells the old path |
| The Android corpus package (6) before its users (7, 9, 11, 12) | Pull request 6 writes `proof/android/conftest.py` with `DOCUMENTS` and makes `proof/android` a package that reads the corpus (`proof/store/queue.py::PACKAGE_DATA`, `proof/lane/blocks.py::CORPUS_PACKAGES`). Pull requests 7, 9, 11 and 12 each add their documents to that list (part 05, Reader tests this part adds, "How the Android tests run") |
| XForm first part (6) and the rename (7) before identifiers (10) | Pull request 6 deletes `proof/rules/test_connect_work_area_empty.py` with its rule, so finding 61 has no rule test to change. Pull request 7 deletes the `reserved_prefix` arm of `lib/doc/identifierVerdicts.ts::formatVerdict`, the code `RESERVED_FIELD_ID_PREFIX` and the `__nova_` refine of `operationIdInputSchema`, in whose place pull request 10's verdicts and refines stand (part 08, Defect 15, Finding 43 and Finding 61) |
| The root keyed create (7) with the groups | Its one-row repeat's control sits inside the `nova_operations` control, which exists only once the containers are groups (part 05, Order the parts land in). `case-operation-key` keeps its root keyed create, and its 15 guard-block entries stay on it through pull request 6 and move in pull request 7 |
| Finding 46 and defect 14's data node name share pull request 6 | Each fix needs the other: both write the default-language form name, one into `<h:title>` and one into the data node's `name` |
| Defect 3 (8) after the restructure (7) | The keys of `case_references_data.save` are the wrapper paths the restructure moves, and proof 4's entry empties only once Vellum keeps the containers. Its two intent entries are unpinned and also hold `case-capture-multiple`, where an attachment under a Save to Case block stays unlearned after the fix, so pull request 8 registers those two classes as defect 23's on a control it retains (part 04, Defect 3) |
| The comparison with Vellum's computation (5) before defect 3 (8) | `proof/checks/manifest_value_classes.py::save_differing_from_vellum` is written in pull request 5, where no form of the corpus reaches it, and first decides a form in pull request 8, where every form holding a Save to Case block stores its derived map (part 04, Defect 3) |
| Work item H's entries move with findings 45 and 47 (6) | With no `#case/` hashtag in any export the warning cannot occur; the document, its control and its two entries are on the lane's branch, so nothing of work item H precedes pull request 6 in the stack. Pull request 6 also rewrites `proof/README.md`'s two rows for the clause, and no later pull request records anything for it. Defect 3's fix needs no order against finding 47's |
| The rename (7) keeps later-step entries on `-after-13` controls | The six old control directories keep the pre-fix bytes that defect 13's, defect 14's, finding 33's and finding 37's fixed entries need, so they are never retained again. Defect 23's and 24's live entries move to six controls retained under new names, which no fixed entry names, and two of which, `case-extension-query-after-13` and `case-extension-repeat-after-13`, pull request 9 retains again in place |
| The moved close (9) after the rename (7) | It writes into `nova_operations` and a `nova_condition_` group and takes its names from `planGeneratedNodes` |
| Finding 33 (9) before the case-list sort rewrite (11) | Three of its entries sit on `expander-expanddoc-hq-json-projection-sort-elements-keeps-67fa0ac7-0`, a document the sort tests produce. Pull request 11 also keeps that test's title and count, so findings 35 and 36 keep their document |
| Case lists (11) before menus and search settings (12) | Both edit `lib/commcare/hqJson/caseList.ts`; the sort and carrier rewrite goes first so the later edits land on the plan-driven shape. Finding 41's entries move in 11 with the empty-list text, which `localization-optional` shows through pull request 10 |
| Tiles and finding 42 (11) before the tile gate (13) | The gate removes `targeted-custom-tile`'s `CASE_LIST_TILE` named configuration (`proof/corpus/entryWriter.ts` throws for a configuration the verdict refuses). Pull request 11 moves defect 14's and finding 42's tile entries and registers the thirteen classes the Case List save under `CASE_LIST_TILE` still shows as defect 12's, on their own control, so pull request 13 moves defect 12's 48 entries together and strands nothing |
| Emitters (7, 9, 11) before publish gates (13) | The plan-feature list reads the emitters' own predicates (which forms emit Save to Case, which lists are tiles), and moved close conditions widen who needs `save_to_case` |
| Identifiers (10) before publish gates (13) and before the media slots (14) | Pull request 13 adds its section to `content/docs/commcare-connect.mdx`, the page pull request 10 creates (part 03, C8). Pull request 14's media-slot tests write a form over a published app through `proof/formplayer/apps.py`'s `form_written`, which pull request 10 adds (part 08, Defect 16: three media slots leave the model, Lane) |
| Drift (4) and the republish statement (5) before defect 5 (14) | Defect 5's refusal reads the client changes and the retained upload answers pull request 4 wrote (`lib/commcare/hq/lookupTables.ts`, `proof/hq-reads/lookup-upload/`), and its document states `republish: "stops"` with a `stopCode`, the third value `proof/corpus/documents.ts::HqSideSaves.republish` declares from pull request 5 (part 02, Defect 5: the lookup push) |
| `hiddenFromMenu` (12) before defect 6's migration (14) | `time-ordering` (registered by pull request 14 before `hidden-from-menu` in `transform.ts`) only replaces comparisons with `match-none` and writes no flag. The `hidden-from-menu` step, which pull request 12 adds, is the only step that sets the flag, and it then sets it on every display condition that is, or starts with, a `match-none` the earlier step wrote. That step and the `hiddenFromMenu` slot must therefore exist before pull request 14 lands, or defect 6's migration would leave a display condition the shape rule refuses |
| `targeted-search-hq-compile` is edited three times, in 9, 12 and 14 | 20 entries of four fixes name it as their document (defect 14's non-writing follow-up 3 and search settings 5, defect 6's 9, finding 48's 3). Each pull request removes its part and keeps the document admitted. Pull request 12 removes its `include_closed` input with its case property and leaves its `owner_id` input as written, the one free-text input it keeps: finding 48's entries read that input's quote cascade until pull request 14, and pull request 14's witness keeps it. Its follow-up form stays through all three edits: pull request 9 moves the three non-writing follow-up entries and the form then stands as the passing witness |
| `POST_SUBMIT_NOT_OFFERED` exempts a fallback beside form links until step 5 | Otherwise `targeted-form-links-hidden-and-fallback`, the document of defect 26's live entries, becomes inadmissible in pull request 12 |
| `nova_count_` keeps reading as `*` in `proof/checks/compare/names.py` | Defect 30's four entries run through a count node; the rename must not start keeping that name literally |
| Each pull request is green on its lanes at its own head | Removing one fix's entries can leave another entry holding nothing on its document, which `proof/checks/registers.py::reconcile` refuses |
| The removal (16) differs from 15 only in tooling paths | The gate that migrated must be the gate the deploy's probe runs (`lib/db/runtimeDatabaseProbe.ts::runCanonicalRuntimeDatabaseProbe`). It touches nothing under `lib/domain`, `lib/commcare/validator`, `lib/doc`, `lib/db` or `lib/case-store/migrations`, and under `proof` only the lane's `cutover` group, which it removes (row 16; part 10, Removal) |

What the planning runs settled about the stack, each stated in its block:

- **Finding 52's control** shows both classes with `vellum_alert` retired, so pull request 1 writes its two fixed entries (part 09, The fixed-defect register and finding 52's orphaned control).
- **`d41-empty-list-text-app-no-items-text`** still shows on `localization-optional` after pull request 6's translation fill, which does not touch a stored short detail's `no_items_text`; it moves in pull request 11 with finding 41. From pull request 5, where Nova writes only the add-ons an app needs, finding 41's two entries that run without the readers already stop showing on four survey-menu documents, since HQ's menu page then shows a survey menu its Advanced panel only where the app needs one of two add-ons or the project space holds `CUSTOM_ASSERTIONS` or `MOBILE_UCR`, which no lane configuration does; neither entry goes unseen (part 04, Defect 4; part 05, Blank translations; part 06, 12).
- **Later-step entries a step 2 fix touches.** Defect 27's three and defect 25's two stand at their paths at pull requests 6 and 9; defect 25 gains 62 classes once the saved form builds, registered live in pull request 6; defect 24's five trace and three Formplayer entries stand at pull request 9, which registers 6 new classes finding 37's block order draws and moves the one entry filed under defect 24 that is finding 37's own, `d24-inert-subcase-formplayer-local-ccz-item-id-order`; defect 23's 70 move path in pull request 7, read from its run's evidence; finding 68's 31 lose one in pull request 3, where one derived `xmlns` leaves two pinned entries one difference to hold, and the other 30 leave every corpus document in pull request 10 and move to the fixed register (part 09, The entries that remain).
- **Every document at once.** Without the readers, over every document of the lane's branch with main merged, at one state holding pull request 5's edit kind and finding 65's emitter, pull requests 6, 7 and 9, and pull request 12's label: no class shows that this plan does not already assign, and no entry of a later step goes unseen (part 09, The entries that remain).
- **The rebalancing with every reader.** On the merged branch, with pull request 5's edit kind, each of the 62 reader entries pinned to a document whose edit moves keeps showing, the four `setAppSettings` documents show no reader class, and no document whose configurations change shows a class no entry holds; with pull request 10's removal on top the same holds for its 13 documents, the logo entry apart. The moved documents no reader entry is pinned to are in no pull request's reader slice and are held with every reader at the stack's top (part 09, How the harness keeps publishing as Nova publishes, Mutation kinds).
- **The working submit.** Once the local archive's submit reaches HQ in pull request 3, Formplayer's record shows nineteen classes other fixes own. Pull request 3 registers them: twelve leave with their owner's fix, in pull requests 5, 6, 9 and 11, two are deleted with pull request 5's judge change, and defect 24's five stay live past the step. The submission's `path` differs by the app's id alone, which the rule pull request 3 adds reads as one (part 01, A5).
- **Defect 15's proof 1 classes.** On `targeted-invalid-question-ids` HQ's build does not install on Android and the local archive does, so two proof 1 paths keep differing there once defect 9 is fixed. Pull request 5 registers them as three pinned defect 15 entries on a control of their own, and pull request 10 moves them (part 04, Defect 9).
- **Pull request 11's emitter, written and run.** The order plan and both emitters were written from part 07 and run without the readers over the whole corpus. Of the 25 entries of part 07's that run without the readers, 23 leave every corpus document that showed their class and stay held on their controls (`d51-sort-keys-trace-rows-sortfields-removed` leaves 187 documents); the other two, `d14-tiles-app-font-size` and `d42-tile-alignment-app-horizontal-align`, keep showing on `targeted-custom-tile` under `CASE_LIST_TILE` alone, the classes pull request 11 files as defect 12's. No entry of another block goes unseen, and with the four sort rules retired proof 4 reports no sort element difference on any document. The emission refuses six fuzz documents until the arbitrary rewrites them, changes no document's edit kind, and changes one batch's target. Then every reader ran on the emitter's bytes over 23 documents and their 17 controls: of the 85 entries of part 07's that the scratch register holds, 75 show on no document of the slice and each is held on its control, and the other ten show on `targeted-custom-tile` under `CASE_LIST_TILE` alone, the ones pull request 11 files as defect 12's; all 17 control groups pass (part 07, What was executed during planning; part 09, Corpus changes).
- **Pull request 10 over the whole corpus.** Each of its rules was held by the validator and run over every document and every document's edit, the corpus emitted, and all of `proof/checks` run without the readers. Outside the fuzz sample the rules refuse exactly the documents part 08 names, and no document for its edit alone; 23 of the fuzz sample's 24 documents change, each generator mapping its draw and removing none; no rule moves an edit. No entry goes unseen that was seen before, every moved entry that runs without the readers stays held on its control, and no moved class shows on a corpus document. One class showed that no entry held: HQ's form builder's "Unknown question: #form" on three fuzz documents, which is finding 71, fixed in the same pull request (part 08, Finding 71; part 09, Corpus changes).
- **Pull request 14 over the whole corpus.** The same way, on pull request 10's state. Its rules refuse the six documents its blocks name, `media-only`, 13 of the fuzz sample, and `container-cousins` for its edit alone; no edit kind moves and no configuration changes. Its emitters reach 46 documents the blocks do not name. Without the readers no class shows that no entry holds, every moved entry that runs without the readers stays held on its control, and the mixed-quote class and `time-operand` show on no corpus document (part 08; part 09, Corpus changes).
- **Pull request 5's three judge changes, written and run.** Each was written with its planted test and run with every reader, each document beside its control. The form-version mapping takes its class off the document and off every control, so its entries are deleted. The update comparison and `settings_replaced` take theirs off the document and leave them showing on the control, so `d9-android-proof1-local-ccz-update-changed` and finding 40's two worker-setting entries move to the fixed register like any other fixed entry (part 04, Defect 9 and Finding 40; part 09, What step 2 moves and deletes).
- **The lane's packages at each fix's state.** The whole lane without the readers, packages included, ran at the states of pull requests 6 and 7 (together), 8, 12 and 13, and `proof/native` and `proof/rules` at the states of pull requests 10, 11 and 14. Every package run passes whole but eighteen tests, each holding bytes its fix changes and each named in the Files of its part and in its pull request's list under Files, by pull request; pull request 10 breaks none of its own, and pull request 14 breaks three, `CsqlQuoteRuntimeTest`, `proof/native/test_quote_payload.py` and `MediaRuntimeTest` (part 08, What every block below shares; part 09, Where the lane runs). The state of pull requests 6 and 7 that ran held none of pull request 6's new Core tests and nothing they read: the five Hidden Values on the container fixture (three on `init-add` for the four default placements, two on `registration` for the own-id default and calculation), `ContainerRuntimeTest.java`'s two tests with the empty `casedb` its environment gains, and `CaseCaptureRuntimeTest.java`'s two tests with the whole extension registration form `proof/native/steps/case_emission.py` writes for them. All of it is written and has not run through HQ or Core (part 05, Default values read relatively; The registration case-id read and reads between case blocks).
- **The derived save map.** With defect 3's derivation implemented and the whole corpus run without the readers, 37 documents hold a save map and no local archive changes; the intent check needs `case_type` as a standard property; and `case-capture-multiple` keeps showing the two intent classes for its attachment, which pull request 8 registers as defect 23's (part 04, Defect 3).
- **The exit state, every reader.** Planning made the run the stack's top makes, with every fix a scratch chain wrote stacked on the lane's head: every check with every reader over every document and control. Executed during planning, from commit `52a84499` of the scratch branch `proof/plan-settle-main-exit-lane` over its own corpus, with A5's, pull request 5's and finding 65's bytes written in: 360 documents and 93 controls, 5,714 items, every block once. Every entry of a later step, 282, shows on its document, and every fixed entry, 113, on its control. 557 entries of step 2 show on no document; the 19 that still show are held by fixes that run's tree lacked, part 01's A3 and A2 (pull request 3), defect 5's push (pull request 14) and pull request 1's closed allowances. Nine classes no entry holds: pull request 5's seven manifest keys, the local profile's `checkoff` feature and the build-injected `pollsensor`; Connect's `task-completed-nothing` on `targeted-connect-deliver-rename`, which pull request 10's widened allowance drops; and Formplayer's `response/exception` from the local archive of `fuzz-suite-20260930-8`, which shows from pull request 3 and which that pull request's judge change reads (part 01, A5, "What the working submit shows"; executed during planning, with Formplayer, on that document at the exit state with the change: proof 3 passes with no difference). Three live entries on `targeted-hq-side-state` go unseen on that control, which pull request 5 deletes or re-homes. The run's list of walk stops held 30 of the lane's 33 entries, without the two case-search expander documents', which the lane gained after the run's base, and `targeted-supply-point-read`'s, whose document the stack removes. 21 walk stops show, the 21 the list keeps on documents: 20 of the 30, and `targeted-datetime-ordering`'s, which appears and which pull request 1 adds. The other ten held stops no longer occur: nine of the twelve the stack moves or removes beside `fuzz-xform-20260930-10`'s, the three more being the ones the run's list lacked, and `fuzz-xform-20260930-10`'s, which pull request 10 removes. 44 package tests fail, and each has an owner: 39 are their fixes', two of `proof/checks/test_connect_unit.py` are pull request 10's (part 08, Finding 61, Files), two of `proof/lane/test_forkserver.py` are pull request 1's, which gives their nested runs the time two served documents take (part 09, Corpus changes), and the determinism test of `proof/checks/test_connect_unit.py` is pull request 1's: the fault is the lane's own, pull request 13's privilege oracle brings it to that test's document, and pull request 1's change to `proof/observe/unit.py::_build` mends it (part 09, "A build recreated under a stored part"). Executed during planning, the five run again by themselves at that state with every reader: the first four pass as their pull requests write them, and the fifth fails as before, on one leaf. Its cause is read from the code; the change and a test of it that needs no reader are written as scratch; and neither test has run with the change yet (the same block; the main file, "Written and not yet run"). What the run does not hold, and the runs that do, are in part 09, Where the lane runs. The same stack with part 01's A3 as the two imports HQ receives and its A2 as a scratch emitter writes it (commit `16dd7c29` of the scratch branch `proof/plan-settle-true-exit`; no chain wrote the publish sequence's code, A6's import file or A7's capture, so each first publish of the corpus is split by hand into the shell's create and the first update) has run without the readers. Executed during planning, without the readers, every check over its 360 documents and 81 controls, 5,265 items, 118 of them failing: no class shows that no entry holds; `d1-ids-app-unique-id-b812` shows on no document and the two `d1-language-codes-*` show nothing on `targeted-hq-side-state`, each held on its control; every later-step entry that is not a served reader's, 192, shows on its document, and every fixed entry that is not a served reader's, 71, on its control and none on a document; 390 entries of step 2 show on no document and 9 still show, defect 5's seven (pull request 14) and finding 50's two (pull request 1). Of the 118, 82 are a document's or a control's check naming an entry that no longer shows there, 22 are package tests that fail in the same stack without A3 and A2, and 14 arrive with the two imports: `proof/hq/test_branches.py::test_branches_of_one_unit_equal_fresh_states` on its seven documents under both configurations, where HQ stamps a deleted blob's row from Postgres's own clock, and part 01's A7 leaves that column out of the comparison ("This pull request's lane, run without the readers"). So A3 and A2 are held without the readers at that state and, with them, not yet beyond pull request 3's own slice. Its run with every reader is composed and not yet run (part 09, Where the lane runs; `2-emission-and-publish.md`, "Written and not yet run").
- **The tile block.** Under `CASE_LIST_TILE` the Case List save drops `horizontal_align`, `vertical_align` and `font_size` from every cell with the custom tile. The explicit cell run read `vertical_align` as kept, because the lane then held the rule `tile_vertical_align_start`, which erases `start` against an absent value; pull request 11's emitter run, with the rule retired, shows it removed in the stored app and in Formplayer's styles, and not in the Web Apps client or on Android. So pull request 11 adds thirteen defect 12 entries and pull request 13 moves them (part 07, Tile cells and finding 42).

## House rules for the stack

1. The proof lane's pull request merges first, and the stack is one `gh stack` chain cut from the latest `origin/main` after it and rebased on it before the first pull request opens.
2. Every pull request is undrafted.
3. `/code-review medium` runs on each pull request and its findings are fixed there. Where the review's agents sit idle for about a minute with no notification, their findings are collected by hand.
4. The stack merges together with `gh stack merge <top> --squash`: one push, one deploy. Never pull request by pull request, and never through the merge API. `gh stack merge --squash` lands one squash commit per pull request (observed on #704 to #707 and on #729 and #730), so each pull request, the cutover scripts among them, stays one commit in `main`'s history.
5. The cutover runs before the merge. The maintenance image is built by hand (`docker build --target maintenance`) from the head commit of pull request 15, the pull request beneath the removal, and the Job is managed from a checkout of that same commit, because the Job contract and the allowlist arm exist only there. The scripts leave `main`'s tip with pull request 16 and stay in its history in pull request 15's commit. The runbook records pull request 15's head commit hash and the maintenance image's digest before the merge.
6. `main` is frozen from the image build to the merge. A rebase after the image is built changes the tree, so the image is rebuilt and the dry run repeated.
7. A rehearsal applies the stack's migrations for real (`runCaseStoreMigrationsWithReport` commits outside the rehearsal's rollback). After the first rehearsal a fix to any migration in the stack is a new migration file, never an edit.
8. The advisory scan runs between 30 hours and three days before the window and writes nothing. It reads HQ with the same credential order as the execute run, so the members whose keys it uses are the same unless membership or a key changed in between. Only the execute run records each member whose key it used, and those rows are what a member is shown; a member whose key only the advisory run used gets no notice line. The runbook states both bounds; the 30 hours let HQ's day counter forget the advisory run's reads (part 10, Pacing).
9. The capture-cleanup Scheduler job is resumed after the cutover Job commits and before the merge: `scripts/infra/manage-deployment.py::scheduler_findings` requires it enabled, and the deploy's `prerequisites` step fails otherwise.
10. After the merge the deploy check-run is watched on the merge commit with `gh`: list the commit's check-runs first and build the watch from the app name observed there. Pull request CI being green is not a deploy, and this deploy runs the runtime probe because the stack changes `lib/domain` and the validator.
11. The `../nova-plugin` change is its own pull request in that repository, cut after the stack's last tool change and merged only after the Nova deploy is live. `version` in `.claude-plugin/plugin.json` goes to the next minor from whatever it holds when the pull request is cut (it holds `2.1.2` at the plugin's `0976b10`, which makes `2.2.0`: new behavior, nothing removed from the plugin's own commands). What the pull request edits was read during planning at `0976b10`, over every prose file the repository tracks: the seven `skills/*/SKILL.md`, `agents/nova-architect-autonomous.md` and `README.md`. `.dev-plugin/` is a generated copy the repository ignores, and nothing there is edited.

    - **`skills/upload_to_hq/SKILL.md`, the sentences step 2 makes false.** All four follow from pull request 3, where a first upload makes the app, empty, before it sends the Project data (part 01, A3. The publish sequence, steps 5 to 8).
        - Under `hq_upload_failed`: "This also covers CommCare HQ refusing the app's Project data tables or its places, which happens before the app is sent, so the app never went up either." It becomes: "This also covers CommCare HQ refusing the app's Project data tables or its places. That happens before the app's content is sent. On a first upload Nova has by then made the app on the project space, empty, so `get_deployment` reports `hq_app_empty: true` and the next upload fills that same app."
        - In the same entry: "When a deployment comes back with `retry_from: "resources"`, say that retrying picks up at the data rather than starting over." From pull request 3 a first upload can stop at `resources` before any data goes, on a create CommCare HQ refuses or a read after the create that fails, and from pull request 13 on the CommCare version of the app it just made (part 01, A3. The publish sequence, steps 5 and 6). It becomes: "When a deployment comes back with `retry_from: "resources"`, say that retrying picks up where it stopped rather than starting over: at the app on a first upload that never made it, otherwise at the data."
        - Under `hq_organization_mismatch`: "**Nothing was uploaded.**" holds where the check before the upload finds the mismatch. Where CommCare HQ refuses a place during the upload, a first upload has already made the empty app, so the sentence becomes: "**The app's content was not sent.** If the check before the upload found this, nothing was written. If CommCare HQ refused a place during the upload, a first upload has already made the empty app, and `get_deployment` says what is there."
        - The paragraph that opens "A `retry_from: "resources"` does not mean nothing was created." gains, before its sentence on places: "On a first upload the app itself is already there, empty, and the next upload fills it."
    - **The same file, what it gains.** Each is new prose for an answer the tool did not give before.
        - Step 4, the compatibility check: `plan_features`, the plan features and project-space settings the upload will ask the person to confirm, relayed with their reasons before the upload; and the `not-a-member` issue, a project space the connected account has left, which stops the upload (part 03, C2 and C3).
        - Step 5 and the failed-upload list, one entry per new `error_type`. `hq_confirmation_needed`: ask the person about each item of `confirmations_needed`, one at a time, as the skill already does for `adopt_resources`, and resend with `confirm_plan_features`, `confirm_flat_location_fixture` or `confirm_connect_forwarder` naming only what they confirmed; the two Connect questions are among them (part 03, C2, C5 and C8). `hq_app_version_below_floor`: relay the message and its `url`, the app's settings page in CommCare HQ where the person raises the CommCare version (part 03, C1). `hq_changed`: list every entry of `remote_changes` with its parts, ask before writing over each, and resend with `discard_hq_changes` carrying each confirmed entry's `observed_digest`; never send a digest the person did not see. Where `remote_changes` is empty the change landed in CommCare HQ while this upload was sending the Project data: relay the message, send no `discard_hq_changes`, and upload again. That second upload normally comes back as an ordinary `hq_changed` with `remote_changes` listed, because the change is still in CommCare HQ, and that one is confirmed the usual way; this attempt's tables and places are already on the project space (part 02, Surfaces). `hq_table_content_unsupported`: a lookup table in CommCare HQ holds what Nova cannot keep yet, with the way out the message gives (part 02, Defect 5: the lookup push). A table or place CommCare HQ would not let Nova read reaches the tool as `hq_upload_failed` with its own sentence, as today, so it takes no entry. The entry for `hq_app_state_unknown`, "Nova could not safely read the current HQ app before updating it, so it left the existing app unchanged.", gains that on a first upload the type also covers an app Nova just made whose CommCare version it could not read, which is then on the project space, empty.
        - Step 6, the report: `app_preview_note`, relayed as it is when present (part 02, The 7-day App Preview statement); `logo_step`, the one step in CommCare HQ that puts the app's logo in Web Apps (part 03, C6); `web_apps_enabled`, relayed when it is false, in the tool's own sentence: the app is not in Web Apps on that project space, and once the plan includes Web Apps a person turns it on in the app's settings in CommCare HQ (part 03, C2. Plan features: the per-privilege confirmation, "Web Apps is read, never confirmed"); `hq_app_gone` and `hq_app_empty` on `get_deployment` and `refresh_deployment`, each said plainly (part 01, A3); `deployment.confirmations` on the same two, with `withdraw_deployment_confirmation` for a confirmation the person takes back (part 03, C2); and a non-empty `notices` from `get_app`, relayed before the upload is confirmed, since a notice can say what the next upload there does (part 10, Work item F: the migration notice).
    - **`skills/show/SKILL.md` and `skills/edit/SKILL.md`.** Each reads `get_app` ("Present its name, Project, workflows and languages in a readable overview."; "Read `get_app` for app `$0`, then inspect the modules, forms or fields relevant to the request.") and gains one sentence after it: "If `notices` is non-empty, tell the user what each one says before anything else, and offer `dismiss_app_notice` once they have read it."
    - **`README.md`.** Beside "Version 2.1's retained-session, page-action, operation-feedback and navigation guidance requires the paired Nova server release.", one sentence for the new minor: its publishing guidance (confirmations, the CommCare version stop, changes made in CommCare HQ, notices) requires the paired Nova server release, the one this stack deploys.
    - **No edit:** `skills/build/SKILL.md`, `skills/autobuild/SKILL.md`, `skills/list/SKILL.md`, `skills/find/SKILL.md` and `agents/nova-architect-autonomous.md`. None states an authoring rule. Each sends the model to `get_agent_prompt` and `get_authoring_guide`, which Nova serves and which change with the deploy. So for every authoring claim the parts name for the sweep, the plugin does not say it: what `get_languages` returns, and that `compile_app` takes only a server, returns bare JSON or compiles a CCZ for an app that is published nowhere (part 01; no file names either tool, and "compile" appears only in the one-line description of `README.md` and `plugin.json`); that the logo shows on the login and home screens (part 03; no file holds "logo"); that `update_app` sets the display name and nothing more (part 04); operation id rules (part 05); where a close is written, the list of after-submit destinations, `app_home` described as the list of menus, a search button label, the column a lookup-backed search input sorts its choices by, reserved search input names, an always-false display condition, and what a link to a hidden target opens (part 06; the one sentence on navigation, "After a submission, Previous resumes the preceding task or record selection.", in `build` and `edit`, with its like in `README.md`, stays true, since `previous` keeps its meaning); what a case list orders by, what its search matches, tile cell defaults and date patterns (part 07); question, Connect and entry-point id rules, media slot names, a hidden value needing a value, ordering a time, and the accepted media formats (part 08, which records its own sweep at the same commit). The one claim the plugin does hold is part 01's, that a deployment with an HQ app id holds the app: the four `upload_to_hq` sentences above.

    The plugin's pull request runs the sweep again at the head the plugin then holds, by claim and never by this list of files, so a sentence added there since `0976b10` is found.
12. Each pull request passes the pull request lane in CI at its own head; the lane has no time cap and runs every group the change invalidates, the lane's packages among them, and part 09, Where the lane runs, gives how long to expect and the local run of the packages (`PROOF_READERS=0 npm run proof`, no target) a pull request makes before it pushes. Before it is marked ready it runs its reader slice on a proof machine, as part 09, Where the lane runs, bounds it: the document and control of every served-reader entry it moves, registers, re-files or deletes and of every held walk stop it moves, removes or adds, plus its witnesses, with `PROOF_READERS` narrowed to the readers those entries name, and with them the reader package tests the pull request itself adds or changes, and nothing wider. No pull request runs every reader over the whole corpus; a pull request that changes an emitter, adds a corpus document or changes a gate entry also runs the sensitivity check whole and fresh there before it pushes, the run its sensitivity effects are written from where they must be written again. Pull request 14 makes one more run, on a machine that is neither CI nor a proof machine: its author runs the Android decode probe (`python3 -m unittest proof.android.decode.probe -v`) on an Apple-silicon Mac with the Android emulator and the arm64 system images of API 23, 29 and 35 before the pull request is marked ready, and so does any later pull request that changes the accepted media formats or a fixture (part 08, Defect 11, first half, "Lane"). Its description carries each run's gate summary. The whole lane with every reader runs once, from the stack's top, before the merge: 552 worker-hours on proof machines, as measured on the lane's own branch. The nightly runs on `main` after it, on its next scheduled night (Tuesday to Saturday, 03:23 UTC); the stack moves every key, so that night is a whole lane with the readers, about thirteen hours, and a merge on a Sunday or a Monday is read by Tuesday's. A night that fails opens an issue naming each failing group with the command that reruns it alone (`python3 -m proof.lane.report`; part 09, Where the lane runs). The implementer asks the person once, at the session's start, for the proof machine's use and budget (spot machines, each stopped when idle), and not again before each run. After the whole lane at the top, its `readers` timings are committed into pull request 15, and only then is the maintenance image built (rule 5).

Removing the tooling at the top of the same stack, not in a follow-up pull request, is a stated choice: a later removal would be a second deploy that exists only because of the split. The habit it adjusts (run, confirm, then remove) is kept in substance because the run and its post-migration scan precede the merge.

## The model-addition checklist

Step 2's additions that follow it: `localization.wireCodes`; `BlueprintDoc.appSettings { showSavedForms, showIncompleteForms }`; `postSubmit: firstMenu` and `parentMenu`; `hiddenFromMenu` on Module and Form; the Hidden Value with neither a calculate nor a default; the sort column on a lookup-backed search input; the accepted media formats; the required tile cell slots `horizontalAlign`, `verticalAlign` and `fontSize`. `Form.xmlns` is derived and stored nowhere, and UI string overrides belong to step 7, so neither is an addition here. Each addition is a complete feature when its pull request lands, and its author ticks every place below or writes "none" with the reason.

1. **Schema** (`lib/domain`): `blueprint.ts::blueprintDocObjectSchema` for a root slot, `forms.ts::formSchema`, `modules.ts`, `localization.ts`, or the field registry (`fields/base.ts`, the kind's module, `fields/index.ts`). A new slot is optional and omitted when empty unless every export writes it, in which case it is required and the cutover fills it (`appSettings`, `wireCodes`, the tile cell slots).
2. **Identity at birth**: a value no author chooses is set where the entity is born and carried in the creating mutation, because reducers never mint (`lib/doc/CLAUDE.md`). Step 2's one case is a language's wire code, set when the language is added: `addLanguage` and `relabelSourceLanguage` carry a required `wireCode`, every producer computes it with `lib/commcare/languageWire.ts::mintLanguageWireCode` when it builds the mutation (through `lib/doc/languageMutations.ts`, the one planner; part 01, A2. `localization.wireCodes`, lists the producers), and the reducer stores what the mutation carries and refuses a code another language holds. The reducer never computes one, because that function reads the language catalog and a code computed at replay could change with the catalog. An addition that needs such an identity names its producers, and the planner they share, in its own part.
3. **References, text and media**: a slot holding a reference joins `lib/domain/referenceSlots.ts`, `lib/domain/referenceIndex.ts` and `lib/doc/referenceIndex.ts`; translatable text joins `translationUnits.ts` and `localizedBlueprintProjection.ts`; media joins `mediaRefs.ts`.
4. **`lib/domain/CLAUDE.md`**.
5. **Storage, for a root slot only** (`lib/db`): a column on `apps` by migration; `pg.ts::AppsTable`; `blueprintRows.ts::BlueprintScalars`, `::blueprintScalars`, `::assembleBlueprint`; `canonicalCommitKernel.ts::PERSISTED_BLUEPRINT_APP_COLUMNS`, `::loadSchemaAdmittedAppSnapshotFromRowInTransaction`, `::denormalize`; `persistedJson.ts` (`PersistedBlueprintRootText` and the assembler); `runtimeDatabaseProbe.ts::readRuntimeProbeCarriers` and its decoder; `mediaDeletion.ts`; `appGenesis.ts`; `apps.ts` (`loadAppForReadOnlyInspection`'s projection, and the two `Omit<AppRow, ...>` types that leave the JSONB roots out); the four script loaders that select the root's carriers by name, `scripts/lib/loadPersistedBlueprint.ts`, `scripts/inspect-app.ts`, `scripts/lib/persistedLookupReferenceScan.ts` and `scripts/lib/repairAuthoringBaselines.ts`; `lib/doc/hooks/useAutoSave.ts::projectSaveSlice`, which lists every persisted root by key (a root it leaves out never saves); and a migration that replaces `nova_current_app_change_fold_snapshot` to project the column. Step 2 pays this once: `appSettings` in the one new nullable `apps.app_settings jsonb` column. A slot inside an existing root (`localization.wireCodes`) or on an entity needs none of it.
6. **A new entity kind** needs its own branch in the row classifier (`lib/db/blueprintRows.ts`; `docs/architecture/contracts.md`, "New top-level blueprint collections"). Step 2 adds none.
7. **Mutations** (`lib/doc`): a patch key on `updateForm`, `updateModule` or `updateField` in `types.ts::mutationSchema` (a clearable slot takes `null`), or a dedicated kind where the value is exclusive (`setAppSettings`); its reducer under `mutations/`; `diffDocsToMutations.ts`; for a new kind `mutationTargetAdmission.ts`, `mutationSequenceAdmission.ts`, `mutationIdentityAdmission.ts` and `incrementalValidationScope.ts` (an unclassified kind falls back to the whole-document gate); `hooks/useBlueprintMutations.ts` and a named read hook; `store.ts` where undo needs an inverse.
8. **The proof corpus, for a new mutation kind**: a generator in `proof/corpus/editKinds.ts::EDIT_KIND_GENERATORS` (the typecheck fails without one) and its footprint in `proof/corpus/footprint.ts`.
9. **Validation** (`lib/commcare/validator`): the code in `errors.ts`, its class in `gate.ts`, the rule under `rules/`, and its message in `lib/doc/userFacingErrors.ts`, written person to person: what was tried, what is expected, where to look. A retired code (`DISPLAY_CONDITION_ALWAYS_FALSE`, `HIDDEN_NO_VALUE`) leaves all four.
10. **Emission** (`lib/commcare`): `expander.ts` and `hqShells.ts` for HQ JSON, `xform/` for the XForm, `compiler.ts` and `session.ts` for the suite and the `.ccz`, `emissionPlan.ts` where lowering changes, the oracles (`validator/hqJsonOracle.ts`, `suiteOracle.ts`, `xformOracle.ts`), the surface manifest entry under `surface/entries/`, and `lib/commcare/CLAUDE.md`. What a publish sends is assembled only in `lib/deployment/importApplication.ts::hqImportApplication`, and a `.ccz` only in `lib/export/localArchive.ts::compileLocalArchive`.
11. **Preview** (`lib/preview`): the engine reads the same document (`engine/navigationProjection.ts`, the form engine, the case list); `RUNTIME_VERSION` in `lib/db/appTests.ts` moves when a stored test snapshot would mean something else; `lib/preview/CLAUDE.md`. The constant is the app-test runtime's version: a test session stored under another value is refused ("Nova's test runtime changed. Start a new test."). Step 2 moves it once, from 14 to 15, in pull request 2 (part 10, What else holds old-shape state, and what the cutover does with each). The stack deploys once, so that one bump refuses every test session stored before the deploy, whichever pull request changed what its snapshot means, and no later pull request of the stack moves it again: pull request 11's list order and quick filter (part 07) and pull request 12's hidden items and destinations (part 06) leave it at 15. A change to Preview's runtime after step 2 bumps it in its own pull request.
12. **Builder** (`components/builder`): the inspector or settings section (`detail/formSettings/`, `detail/appSettings/`, `editor/fields/`, `case-list-config/`), `shared/editorSchemas.ts`, built from `components/shadcn` with Tabler icons and Nova's voice; state in a pure model with its own test; Playwright for the interaction; `components/builder/CLAUDE.md`.
13. **SA and MCP**: the shared tool's input schema and handler under `lib/agent/tools/`, its declaration in `lib/agent/sharedToolRegistry.ts`, its activity entry in `lib/agent/toolPresentation.ts`, the read projections (`appOverview.ts`, `summarizeBlueprint.ts`, `tools/getForm.ts` and its siblings), the call's summary where its shape changes (`tools/shared/toolCallSummary.ts`, read by `lib/chat/toolSummary.ts` for the transcript row), `blueprintHelpers.ts`, the authoring guide where it teaches the concept. MCP publishes the same schemas through `lib/mcp/adapters`; a tool that is not shared lives in `lib/mcp/tools/` and declares its HQ scope through `lib/mcp/scopes.ts::oauthScopeChallenge`. `lib/agent/anatomy` composes from the production definitions and needs no edit. `lib/models.ts::MODEL_CONTEXT_VERSION` is bumped in each pull request that changes the tool catalog, which here means the name, the description or the input schema of a tool the Solutions Architect is offered (a shared tool or one of its own), or the authoring guide (`lib/agent/authoring/reference.ts`) its `get_authoring_guide` tool returns. Reason: a stored model context is replayed only under the catalog it was made against, and a narrowed input removes historical calls from the model's view. Each bump is a distinct literal, so every head of the stack states its own contract; the stack deploys once, so the value production takes is pull request 14's. The nine, with the value each sets:

    | PR | Catalog change | Value |
    |---|---|---|
    | 5 | `update_app`'s description and input schema (part 04, Defect 7, "`update_app`", gives each text) | `"v3-hq-round-trip-emission"` (from `"v2-private-authoring"`) |
    | 6 | the authoring guide's sentences on a datetime an operation copies and on a choice's label or media | `"v3-hq-round-trip-emission.6"` |
    | 7 | `operationIdInputSchema` | `"v3-hq-round-trip-emission.7"` |
    | 9 | the `close_condition` descriptions | `"v3-hq-round-trip-emission.9"` |
    | 10 | the case operation, link identifier, write-property, entry-point and Connect id inputs and the question id description (the Connect id description gains the rename sentence of defect 15's Connect forwarding); the Connect config's refine and its `deliver_unit` and `task` descriptions, which `configure_connect` and `update_form` share (finding 61) | `"v3-hq-round-trip-emission.10"` |
    | 11 | the case-list-config schemas and `update_module`, which holds the same column arms; the date column's `pattern` description, `set_case_list_tile`, the `grouping` description (finding 67). Part 07, The tool descriptions this part writes, gives each text and the five schema names | `"v3-hq-round-trip-emission.11"` |
    | 12 | `post_submit` and the form entry description (`lib/agent/tools/shared/formEntry.ts::FORM_ENTRY_DESCRIPTION`), `hiddenFromMenu` and the `displayCondition` description on `update_module` and `update_form`, the `ignoreDisplayConditions` descriptions of `add_entry_point` and `update_entry_point` and `add_entry_point`'s own description (part 06, 11. `hiddenFromMenu`, "SA and MCP", gives each text), the search inputs and `sortColumnId`, `set_case_search_display`, the `add_form_links` and `update_form_link` descriptions (finding 58) | `"v3-hq-round-trip-emission.12"` |
    | 13 | `set_app_logo`'s description | `"v3-hq-round-trip-emission.13"` |
    | 14 | `attach_field_media`'s slots and its two descriptions, the authoring guide's File and Hidden Value lines (each kind's `saDocs`), the Search input property descriptions of `addSearchInputs`, `updateSearchInput` and `configureCaseList` (defect 6 changes no tool schema and no description: the predicate schema the tools share, `lib/domain/predicate/types.ts::predicateSchema`, takes a comparison's operands untyped, and the ordered-types rule is the checker's, which the commit gate and the builder's menus read; part 08, Defect 6, Files) | `"v3-hq-round-trip-emission.14"` |

    Two kinds of change do not count, and pull requests 1 to 4, 8, 15 and 16 therefore leave the constant alone. A tool only MCP serves (`compile_app`, `get_deployment`, `refresh_deployment`, `upload_app_to_hq`, `check_project_space_compatibility`, `withdraw_deployment_confirmation`, `get_app`, `dismiss_app_notice`, `upload_media_asset`: pull requests 2, 3, 4, 13 and 14) is in no model context Nova stores. A field added to a shared read tool's result with no change to its name, description or input (`get_languages`' `commcareCode` in pull request 3, a unit row's `filledFrom` in pull request 6) refuses no stored call and makes no stored result false.
14. **The billed schema check**: `scripts/test-schema.ts` proves that the provider accepts a tool definition the Solutions Architect is given. Each entry of its `SCHEMA_TESTS` holds a tool's name, its description, its input schema and a prompt. For a tool the Solutions Architect shares with MCP (an entry of `lib/agent/sharedToolRegistry.ts::SHARED_TOOL_REGISTRY`, as each of the 20 below is), the script sends the description and the JSON Schema that `lib/agent/authoring/toolSchema.ts::authoringToolSchema` projects from the schema, with the prompt, as one live OpenAI request, and the entry passes when the request does not error. An entry that is no shared tool is sent through `wireToolSchema` instead. `npm run test:schema -- <name>` sends one entry. It is a paid action: the implementer asks the person before any run. What the check is for decides what a change owes it:

    - **A schema is changed** when the tool's description or its projected JSON Schema differs from the stack's base: a property, a type, an enum value, a pattern, or a description inside the schema. A refinement (`.refine`, `.superRefine`) and a refusal's message are no keyword of the JSON Schema, so a change to one sends the provider nothing new. `add_case_operations` and `update_case_operation`, whose `operationIdInputSchema` pull requests 7 and 10 change by refinement alone, are therefore not sent, though each narrows what the input accepts and so bumps `MODEL_CONTEXT_VERSION` (item 13).
    - **A tool only MCP serves is never sent.** No Solutions Architect request carries one (item 13 lists the nine the stack changes or adds). What an MCP client receives is held without billing by `lib/mcp/__tests__/servedSchemas.test.ts`, which reads every tool `lib/mcp/server.ts::registerNovaTools` serves as a client receives it from `tools/list` and compiles each schema with a JSON Schema validator for its declared dialect and each pattern with the Rust regex engine. It runs in every pull request's Vitest, and it is the check for every MCP-only input the stack changes. The script's one entry for an MCP-only tool, `uploadMediaAsset`, is left as it is and is not in the question: it holds a description of its own, so pull request 14's new description of `upload_media_asset` (part 08, Defect 11) changes nothing it sends.
    - **A Solutions Architect tool the stack changes and the script does not name is registered** by the pull request that first changes it: an entry of `SCHEMA_TESTS` (`name`, the tool's own `description` and `inputSchema`, and the prompt below), its import, and its name in the header's "Known names" list. That list holds 40 of the script's 42 names at the lane's head (`updateApp` and `generateSchema` are missing), so pull request 5, the first of the stack that edits the script, brings it to the full set, and each later registration adds its own name. A pull request that leaves a registered entry's prompt asking for something the tool no longer takes rewrites the prompt.

    The schemas the question names at the head of pull request 14, 20 in all. "Registered" is the pull request whose `scripts/test-schema.ts` gains the entry, or "today" where the lane's head holds it. "Changed in" gives each pull request that changes the definition and what it changes.

    | Schema | Registered | Changed in | Prompt |
    |---|---|---|---|
    | `updateApp` | today | 5: the input schema and the description (part 04, Defect 7) | Pull request 5 rewrites it, as part 04 gives it: "Use updateApp to name the app 'Village Health' and turn its incomplete forms list on." |
    | `addFields`, `editField` | today | 10: the question id description (`lib/agent/toolSchemaGenerator.ts`; part 08, Defect 15) | unchanged |
    | `updateForm` | 9 | 9: the `close_condition` description (part 06, block 2). 10: the Connect id description and the `deliver_unit` and `task` descriptions, which it shares with `configure_connect`. 12: `post_submit`, `hiddenFromMenu`, the `displayCondition` description and `FORM_ENTRY_DESCRIPTION` | "Use updateForm with moduleUuid 11111111-1111-4111-8111-111111111111 and formUuid 22222222-2222-4222-8222-222222222222 to close the case only when the answer to fieldUuid 33333333-3333-4333-8333-333333333333 is 'done'." |
    | `configureConnect` | 10 | 10: the Connect id description (part 08, Defect 15's Connect forwarding) and the `deliver_unit` and `task` descriptions (finding 61) | "Use configureConnect to make the app a learn app whose one participating form is formUuid 22222222-2222-4222-8222-222222222222, with a learn module named 'Hand washing', described as 'Why and when to wash hands', with a time estimate of 1 hour." |
    | `addEntryPoint` | 10 | 10: the `id` description (part 08, Defect 15; the narrowed grammar itself is a refinement, and the `pattern` stays). 12: the `ignoreDisplayConditions` description and the tool's own (part 06, block 11) | "Use addEntryPoint to add an entry point for the form with moduleUuid 11111111-1111-4111-8111-111111111111 and formUuid 22222222-2222-4222-8222-222222222222, with the id visit-form, that ignores display conditions." |
    | `updateEntryPoint` | 10 | 10: the `id` description. 12: the `ignoreDisplayConditions` description | "Use updateEntryPoint on entryPointUuid 33333333-3333-4333-8333-333333333333 to change its id to home-visit and go back to ordinary display-condition checks." |
    | `updateModule` | today | 11: the column arms and their guidance (part 07, The tool descriptions this part writes). 12: `hiddenFromMenu`, the `displayCondition` description | unchanged |
    | `configureCaseList` | today | 11: the column arms. 12: the search inputs, `sortColumnId`, and the search display fields, which lose the button label. 14: the description of its `searchInputs` property ends with `SEARCH_ANSWER_QUOTE_MARKS_GUIDANCE` (part 08, Finding 48) | Pull request 12 rewrites "the four root search-display fields" as "the three root search-display fields" |
    | `addCaseListColumns`, `updateCaseListColumn` | today | 11: the column arms and their guidance | unchanged |
    | `setCaseListTile` | today | 11: the cell and `grouping` descriptions | unchanged |
    | `createForm` | today | 12: the `post_submit` description and `FORM_ENTRY_DESCRIPTION` | unchanged |
    | `setCaseSearchDisplay` | today | 12: the search button label leaves | unchanged: it sets the title and clears "every other display slot" |
    | `addSearchInputs` | today | 12: `sortColumnId` and the reserved names sentence. 14: the description of its `searchInputs` property ends with `SEARCH_ANSWER_QUOTE_MARKS_GUIDANCE`, the sentence on an answer that holds both quote marks (part 08, Finding 48) | unchanged |
    | `updateSearchInput` | today | 12: `sortColumnId` and the reserved names sentence. 14: the description of its `searchInput` property ends with the same constant | unchanged |
    | `addFormLinks` | 12 | 12: `HIDDEN_TARGET_NOTE` at the end of the description (part 06, block 15) | "Use addFormLinks with moduleUuid 11111111-1111-4111-8111-111111111111 and formUuid 22222222-2222-4222-8222-222222222222 to add one link with no condition whose target is the form with moduleUuid 33333333-3333-4333-8333-333333333333 and formUuid 44444444-4444-4444-8444-444444444444." |
    | `updateFormLink` | 12 | 12, as `addFormLinks` | "Use updateFormLink with moduleUuid 11111111-1111-4111-8111-111111111111, formUuid 22222222-2222-4222-8222-222222222222 and linkUuid 55555555-5555-4555-8555-555555555555 to point the link at the module with moduleUuid 33333333-3333-4333-8333-333333333333, with no condition." |
    | `setAppLogo` | today | 13: the tool's description and the `logo` input's (part 03, C6) | unchanged |
    | `attachFieldMedia` | today | 14: the `slot` values and description, and the tool's description (part 08, Defect 16: three media slots leave the model) | Pull request 14 rewrites "hint audio" as "help audio" |

    The question, asked once: "Step 2 changes 20 of the tool definitions the Solutions Architect is given, and `npm run test:schema` checks that OpenAI accepts each one. Running it for these 20 sends 20 live OpenAI requests on your key, one per schema: `updateApp`, `addFields`, `editField`, `updateForm`, `configureConnect`, `addEntryPoint`, `updateEntryPoint`, `updateModule`, `configureCaseList`, `addCaseListColumns`, `updateCaseListColumn`, `setCaseListTile`, `createForm`, `setCaseSearchDisplay`, `addSearchInputs`, `updateSearchInput`, `addFormLinks`, `updateFormLink`, `setAppLogo`, `attachFieldMedia`. May I run it?" On a yes the implementer runs `npm run test:schema -- <name>` once per name, and never the bare command, which would send all 48 entries the script holds at that head (the 42 at the lane's head and the six this stack registers). A change made while implementing to a Solutions Architect tool this table does not hold adds its row, and its entry where the script has none, in the pull request that makes the change, and the question gives the new count. A schema the provider refuses is fixed in the pull request that owns it, and the question is asked again for that schema alone, as one billed request.

    A model addition after step 2 follows the same rules: a new Solutions Architect tool is registered in the script by the pull request that adds it, a changed one is named in that pull request's ask, and a tool only MCP serves is held by the served-schema test.
15. **Docs**: the `content/docs` page for the task a reader does, `content/docs/mcp/tools.mdx` for the callable reference, the nearest subtree `CLAUDE.md`, and `docs/architecture/complex-apps.md` where the addition records a binding CommCare fact.
16. **`../nova-plugin`**: sweep the skills' prose for the claim the change makes false; the change rides the plugin's one pull request (house rule 11).
17. **Existing documents**: a step under `scripts/lib/hqRoundTripCutover/steps/`, its notice reason in `DOCUMENT_NOTICE_REASONS` (`lib/notices/migrationNotice.ts`) with its renderer (`lib/notices/migrationNoticeCopy.ts`), and its expectations over the frozen pre-step fixtures. The step is inserted at its place in `transform.ts`'s fixed order. A change that stores nothing and still gets a line has no step: its pull request adds the reason's selection function to `scripts/lib/hqRoundTripCutover/behavior.ts`, or, where the reason is a deployment's, its line to `scripts/lib/hqRoundTripCutover/notice.ts` and the reason to `DEPLOYMENT_NOTICE_REASONS`, each with its renderer and its test (part 10, Changes that write nothing and still get a line; What every pull request of the stack does says the same). Nothing under `lib` or `app` imports from `scripts/lib/hqRoundTripCutover/`: the reason lists and renderers live in `lib/notices/`, so pull request 16 removes the tooling without touching either tree.

## Contract sentences step 2 rewrites

Each "Today" was read in today's file, at the lane's head (the worktree of `proof/run-every-reader`), and is quoted whole or, for a long passage, by its opening and its closing words in two quotes. A section is named by its heading or its opening words and never by a line, because the files move. Where one section takes several edits the row letters them, and each letter has its today-text and its replacement. "PR" is the pull request that makes the edit; a row marked 15 has no earlier owner. The first table holds the rows written with the plan's parts. The second completes it, file by file, with every other sentence a part's block promises to change and every sentence the stack makes false. A replacement in quotation marks is the text as it is written, and it names no plan step, pull request, part, defect or finding: the plan leaves the repository in pull request 16, and a contract file says what is so. Where a cell names one of those outside quotation marks, that is a note to the editor and is not written into the file. The proof lane's two documents are the one exception: they name the round trip's steps and the register's defect and finding numbers today (`proof/README.md`, "Step 1's decisions" and "The defect rows"), and their rows keep doing so. Where a row's text is split across pull requests, each pull request's text is true at that pull request's own head.

| File, section | Today | From step 2 | PR |
|---|---|---|---|
| `docs/architecture/contracts.md`, "Nova is not CommCare HQ." | "Their authoring models and UI are not Nova requirements, and "HQ does it this way" is never a design argument." | Two further HQ facts bind Nova: every app Nova emits is one HQ's current editors can produce and keep, and reading an app changes nothing HQ's servers or existing data depend on. HQ's authoring models and UI still set nothing about how Nova authors, and "HQ does it this way" is never a design argument. The paragraph's last sentence (one wire flavor) is step 4's and stays | 15 |
| Root `CLAUDE.md`, opening note | "the only admissible HQ facts are "the wire accepts / rejects this."" | The admissible HQ facts are three: what the wire accepts or rejects, that HQ's current editors can produce and keep every app Nova emits, and that reading an app changes nothing HQ's servers or existing data depend on | 15 |
| Root `CLAUDE.md`, mental model 3 | "Nova speaks its own clean vocabulary; CommCare's wire vocabulary is quarantined behind `lib/commcare`, a one-way emission boundary enforced by a Biome import rule. The SA and the builder never speak CommCare." | Adds: the document also holds each language's CommCare wire code (`localization.wireCodes`), an identity no author chooses. A form's `xmlns` and every HQ menu and form id are derived from the Nova entity's UUID and stored nowhere in the document. The row names no `Form.xmlns` slot: step 6 adds an optional stored one for imported forms | 3 |
| Root `CLAUDE.md`, the `lib/deployment` entry | "`resources` puts what the app depends on there BEFORE the app, and never writes over a remote resource Nova cannot account for: a name clash refuses and is resolved only by a caller naming the exact resources a person confirmed." | Pull request 3 rewrites the opening clause, which the shell create makes false: "`resources` puts what the app's content depends on there BEFORE that content (a first publish makes the empty app first), and never writes over a remote resource Nova cannot account for: a name clash refuses and is resolved only by a caller naming the exact resources a person confirmed." Pull request 15 adds a sentence after it: "Nor does it write over a change made in HQ since Nova's last push without the person confirming the discard, and a publish stops below CommCare 2.57 and without a confirmed plan feature." | 3, 15 |
| `lib/commcare/CLAUDE.md`, multilingual emission | "Two-letter language codes exist nowhere outside this directory" | A language's wire code is chosen here once, when the language is added, and stored in `localization.wireCodes`; every export reads the stored code, so adding or removing a language never renames another's | 3 |
| `lib/commcare/CLAUDE.md`, same paragraph | "`languageWire.ts::planLanguageWire` is the one tag→wire-code mapping, computed once per emission and total and injective by construction" | `languageWire.ts::mintLanguageWireCode` chooses a wire code once, when a language is added: the identity's preferred spelling where no held language has it, else the suffixed form. The producer of the `addLanguage` or `relabelSourceLanguage` mutation calls it and the mutation carries the result; no reducer calls it. `planLanguageWire` reads `localization.wireCodes` and no longer groups; the map is total and injective because the schema holds it so | 3 |
| `docs/architecture/multilingual-localization.md`, the compiler list | "`lib/commcare/languageWire.ts::planLanguageWire` is the one tag→wire-code mapping, computed once per emission over the ordered tag list, total and injective." | The same replacement, and: a stored code never changes while its language stays in the app; removing a language frees its code; the English-only state with no stored root still emits `en` | 3 |
| `lib/commcare/CLAUDE.md`, "Runtime request destinations" | The whole section, from "`runtimeTarget.ts` is the sole origin/domain/app projection for Search, case claim, and known-case hydration URLs." to "These portable placeholders require HQ import/build before runtime use." | Rewritten whole. `lib/deployment/runtimeTarget.ts::chooseDownloadTarget` (pure) and `lib/deployment/downloadTarget.ts::resolveDownloadTarget` (server-only) are the one resolver; it yields a full target (server, domain, the deployment's HQ working app id, its recorded ids) or none, and a bare server reaches no emitted byte. `lib/commcare/runtimeTarget.ts::runtimeUrls` has no partial-placeholder arm. Every `.ccz` is made for one published project space, and its profile names that space's four server properties (`ota-restore-url`, `PostURL`, `key_server` and `cc_user_domain`, from `runtimeTarget.ts::profileServerProperties`); an app that is published nowhere is offered no `.ccz`. The HQ import file carries derived ids and no target | 3 |
| `lib/commcare/CLAUDE.md`, project-space compatibility | "Public surfaces speak only semantic capabilities from `lib/publish/projectSpaceCompatibility.ts`" | Kept, and stated as the rule for publish too: publish names capabilities, never HQ flag names. Adds: at publish only the publisher's key reads a space's flags, because a flag keyed by project space alone is never on for a user (`corehq/toggles/__init__.py::StaticToggle.enabled`); a project space the key's user has left is the `not-a-member` issue. The capability list grows by defect 12's gate table | 13 |
| `lib/commcare/CLAUDE.md`, same section | (a) "HQ still emits and executes `_xpath_query` filters without that setting; the disabled path records telemetry but does not reject the query." (b) "Only a Search field with a starting value adds the private child setting to the SAME public Case search capability, because HQ omits `<prompt default>` without it." | (a) Pull request 12, in part 03's words (C4): "A search's own filter (`_xpath_query`), the zero-input `match-all()` included, does not add it: HQ's Case List page offers and keeps a default filter for every project space. Both export paths send the zero-input filter." (b) Pull request 13, in part 03's words (C3): "A Search field with a starting value, a hidden Search value, a search-first menu, a one-date Search field and a Search field Nova matches by its own filter each add the private child setting to the SAME public Case search capability: HQ omits `<prompt default>` without it and its editors offer none of the others without it." | 12, 13 |
| `lib/commcare/CLAUDE.md`, the `build_spec` paragraph | "`build_spec.version` in `hqShells.ts` is fixed output metadata for Nova's one application-shell target (`2.54.0`)." | Nova writes no `build_spec`. Publish reads the target's `build_spec.version` from its source and stops below `lib/commcare/versionFloor.ts`'s 2.57, which the local profile's `requiredMajor` and `requiredMinor` also state | 13 |
| `lib/commcare/CLAUDE.md`, "After-submit links", HQ shape | "HQ re-ids forms on import (`update_form_unique_ids` rewrites `form_id`) and not modules, so the expander pre-generates every form unique id before the module map." | HQ re-mints form ids only when it creates an app from a body that holds forms, and on every source read. Nova's create is an empty shell and its update writes ids verbatim, so every menu and form id is `lib/commcare/wireIdentity.ts`'s derivation or the target's recorded override (`ExpandOptions.identity`) | 3 |
| `lib/commcare/CLAUDE.md`, the `importApp` paragraph | "404 `Application not found` for an unknown id" | Adds: 400 for an app deleted in HQ, whose source read still answers 200 with a `doc_type` ending `-Deleted` (`app_manager/util.py::app_doc_types`). An update never writes `multimedia_map`, `build_profiles`, `custom_base_url` or `practice_mobile_worker_id`, and Nova sends no `multimedia_map` in any mode | 3 |
| `lib/commcare/CLAUDE.md`, "The generated app shell carries only fields Nova authors." | (a) From "So target-owned settings and state" to "are never emitted by `hqShells.ts::applicationShell`, and `logo_refs` is emitted only when the app has a Nova-authored logo." (b) "`profile` is the narrow exception added by the derived projection above: a new-app artifact may carry Nova's allowlisted derived properties, and an in-place update may emit the target's complete current profile only to change those properties. An inconclusive advisory update omits `profile` and preserves the target's current value." | (a) Pull request 5: `cc-show-saved` and `cc-show-incomplete` are app content (`appSettings`), written as a key-level overlay, and they are the only two profile settings Nova owns on HQ. The fifteen other explicit settings, constants at today's device behavior, are seeded on HQ only where the target's profile holds no value (absent, null or empty) and never written over a value the target holds, because Nova does not yet hold them as settings an author sets, and writing over a person's choice in HQ would undo it at every publish; the local `.ccz` writes all seventeen. In `translations`, of the keys HQ generates Nova writes only `app.display.name` and `homescreen.title`, each only in a language whose localized app name differs from `appName`, and it writes every current language's name; `android.package.name.*`, every runtime UI-catalog key and any other key keep HQ's value verbatim, and a generated key is never carried (`appStringKeys.ts::translationKeyOwner`): Nova holds no UI string overrides. `add_ons` sets needed slugs `true` and keeps the rest; `auto_gps_capture` is `true` for a Connect app and otherwise omitted. Pull request 13: publish writes no `logo_refs`, and an update takes out only an entry that holds a path alone, which HQ's own uploader never stores. Pull request 14 renames what the sentence's opening lists (part 08, Defect 16: what the code, the tools and the docs say): "App content Nova does not author yet (`cloudcare_enabled`, `case_sharing`) and target-owned settings and state (`secure_submissions`, the build/release metadata, and the rest of HQ's app Settings page) are never emitted by `hqShells.ts::applicationShell`." (b) Pull request 5: `profile`, `translations` and `add_ons` are the three keys an update projects against the target's current value (`targetOverlay.ts`; the row for the profile paragraphs is in the second table), and an update carries `profile` whenever a projected key differs from what the target holds, under any Search advisory | 5, 13, 14 |
| `lib/commcare/CLAUDE.md`, location owners | "The expander requests `location_fixture_restore: "both_fixtures"`" | Every app carries `location_fixture_restore: project_default`, and publish asks the person to confirm the flat fixture still syncs when the app reads the locations fixture | 13 |
| `lib/commcare/CLAUDE.md`, "Authored case-operation emission" | "Each multiplicity scope gets a reserved `__nova_operations` container" | Nova reserves no question names. Each generated node is named `nova_`, then its purpose and its owner's id, by `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`, which suffixes on a collision with an authored sibling; the containers are groups (`nova_operations`, `nova_condition_<operation>`), and guards are update-only Save to Case blocks. A leaf of a case block carries no `type` and no `constraint`, which is pull request 6's edit to this section (part 05, Leaf constraints and Datetime leaves) | 6, 7 |
| `lib/commcare/CLAUDE.md`, "Case-management scaffolding emission" | "under a reserved `__nova_subcases` container at the exact parent/repeat scope" | Under a `nova_subcases` group. The inert basic subcase beside it stays as it is | 7 |
| `lib/commcare/CLAUDE.md`, "Markdown itext" | "Count's `nova_count_` and the reserved `__nova_` URL/datetime/constraint-collection prefixes are disjoint." | Pull request 7: every question-level generated name comes from `planGeneratedNodes`, so the sentence's reserved prefixes go; the `__nova_identity`, `__nova_mode`, `__nova_locale` and `__nova_piece_<n>` names are itext form names, not question names, and stay. Pull request 14: the `__nova_mode;<medium>` forms go with validation-message media | 7, 14 |
| `lib/doc/CLAUDE.md`, `identifierVerdicts.ts` | "XML element-name legality, the reserved `__nova_` prefix, and sibling-id uniqueness" | Pull request 7: no reserved prefix. Pull request 10: the verdicts hold Nova's question-id grammar (HQ's form builder's without the hyphen, `lib/domain/questionId.ts::QUESTION_ID_PATTERN`), `meta` in any case, the three names the form builder cannot open a form with (`instance`, `bind`, `parsererror`) and the names its editors warn about (`case`, `registration`, `script`, in any case) | 7, 10 |
| `lib/commcare/CLAUDE.md`, case-search emission list | "a deeply always-false condition is a soundness finding." | "Not on the menu" is the flag `hiddenFromMenu` on a menu or form, with `displayCondition` as its rest. A display condition that is, or starts with, `match-none` is refused by a shape rule; any other condition false in every context is an ordinary condition and is no longer simplified by absorption. `DISPLAY_CONDITION_ALWAYS_FALSE` is gone | 12 |
| `lib/commcare/CLAUDE.md`, "Case-tile emission" | The whole sentence, the last of the paragraph that opens "Nova's authoring words for vertical alignment": "An unset presentation slot stays OFF the wire: an absent `font-size` makes the cell inherit the list's size, which is a different rendering from any named size, so emitting a default would change what a worker sees." | In part 07's words (Tile cells and finding 42, Files): "Both emitters write alignment and size on every cell: `horizontal_align`, `vertical_align` and `font_size` in the HQ JSON, and `horz-align`, `vert-align` and `font-size` on `<style>`. The document requires the three (`tileCell()` fills `left`, `top` and `medium`), because HQ's Case List save writes all three into a cell that holds none, so a cell without them changes on the first save. `showBorder` and `showShading` stay optional and stay off the wire when unset." | 11 |
| `lib/domain/CLAUDE.md`, field kinds | "A hidden field with nothing authored holds `HIDDEN_INERT_VALUE` in `default_value`, never in `calculate`" | A hidden field with nothing authored holds neither slot. One that writes a case property writes it blank on each submission unless the form preloads that property into it, and every authoring surface says so where the author sets it. `HIDDEN_INERT_VALUE` and `HIDDEN_NO_VALUE` are gone. The one-value-source sentence before it loses its claim that the default is dead in this pull request (its row is in the second table); the one-value-source rule itself stays | 14 |
| `components/builder/CLAUDE.md`, the hidden Value paragraph | From "**The inert placeholder never enters `calculate`.**" to "where set once is the fact worth showing.", which is every sentence of the paragraph about the placeholder | In part 08's words (The Hidden Value with neither a calculate nor a default, Files): "**A hidden field with nothing authored holds neither slot.** It is born that way (both minting paths), an empty save in either mode lands on that same shape (`HIDDEN_VALUE_EMPTY_PATCH`, which clears both slots), and choosing keep in step with nothing to carry is a local `await-calculation` state, not a write: the editor opens and only a typed calculation commits, so `calculate` holds only what a person typed. The control shows keep in step at rest over a field holding neither slot (a fresh insertion, a conversion that carried nothing) because that is the mode a typed calculation lands in, except on a preloaded writer, where set once is the fact worth showing. Under the switch, a field with no value that saves to a case property says what each submission saves, in the sentence `lib/domain/casePreload.ts::hiddenWriterBlankNote` gives the builder and the tools alike." The rest of the paragraph stands | 14 |
| `lib/media/CLAUDE.md`, "Accepted formats are HQ-ingestion-bound, not arbitrary" | "**audio is `audio/mpeg` (`.mp3`) and `audio/wav` (`.wav`) ONLY.**" | Nova accepts the formats every platform plays: BMP (a 40-byte header with `BI_RGB` at 1 to 32 bits, or a V5 header at 32 bits with `BI_BITFIELDS` and sRGB), M4A, FLAC, WebM and Ogg (Vorbis and Opus) join the set, from the one registry in `lib/domain/multimedia.ts`, with the body checks and HQ's true typing path. "SVG is excluded as an XSS script container." stays | 14 |
| `lib/lookup/CLAUDE.md` | "A tag is capped at 32 characters here, one past what a CommCare HQ data sheet can be named for, so the export boundary refuses the 32-character case by name" | A tag holds at most 32 characters, the length HQ's upload stores: a 32-character tag pushes, and Nova refuses a longer one itself, because HQ answers it with a server error and not a refusal. A tag containing `casedb` or `ledgerdb`, case-sensitively, is refused, because Core picks an instance's storage by substring (commcare-core `CommCareInstanceInitializer.generateRoot`) | 14 |
| `lib/commcare/CLAUDE.md`, the lookup carriers | "a data sheet is NAMED for its tag and a sheet name holds 31 characters while a tag may be authored up to 32, so exactly one authorable length is unpushable and the boundary refuses it by name rather than letting the emitter meet a sheet it cannot name." | HQ's upload reads a 32-character sheet name, so a 32-character tag pushes and the HQ modes take one size verdict, `LOOKUP_HQ_PUSH_TOO_LARGE`. `LOOKUP_TAG_TOO_LONG_FOR_HQ` is gone. `LOOKUP_TAG_RESERVED_BY_RUNTIME` also refuses a referenced table whose tag contains `casedb` or `ledgerdb` | 14 |
| `docs/architecture/complex-apps.md`, lookup export | "The HQ modes carry two size verdicts of their own: CommCare HQ's whole-workbook row ceiling (`LOOKUP_HQ_PUSH_TOO_LARGE`) and `LOOKUP_TAG_TOO_LONG_FOR_HQ`, because a data sheet is NAMED for its tag and a sheet name holds 31 characters while a tag may be authored up to 32." | "The HQ modes carry one size verdict of their own: CommCare HQ's whole-workbook row ceiling (`LOOKUP_HQ_PUSH_TOO_LARGE`)." Adds the reserved substrings and the commcare-core citation | 14 |
| `docs/architecture/complex-apps.md`, "Never match" | "`DISPLAY_CONDITION_ALWAYS_FALSE` refuses a navigation condition nobody could satisfy, so the editor withholds `match-none` there" | A navigation condition that is, or starts with, `match-none` is refused by a shape rule, because "not on the menu" is the flag `hiddenFromMenu`; the editor withholds `match-none` there for that reason. `allowsNeverMatch` stays its own axis | 12 |
| `docs/architecture/complex-apps.md`, extension-case creation | "emits the active extension under `__nova_subcases` at its exact root or repeat scope" | "emits the active extension inside a `nova_subcases` group at its exact root or repeat scope" | 7 |
| `docs/architecture/complex-apps.md`, the emitted app document | (a) "Target-owned settings and state (`cloudcare_enabled`, `case_sharing`, the build/release metadata, and the rest of the `commcare-app-settings.yml` attributes) are absent, so the overlay merge retains a project's HQ-side configuration across republishes, and `logo_refs` appears only when the app has a Nova-authored logo." (b) "The narrow profile exception is derived Search tuning: a new-app JSON may carry Nova's one owned optimization, while a direct update reads the current HQ app source immediately before import and sends the complete existing profile only when that owned value must change. `lib/commcare/hqShells.ts`, `derivedProfile.ts`, and `targetProfile.ts` state the rule." | (a) The same replacement as `lib/commcare/CLAUDE.md`'s shell row, in the same three pull requests: the two form-list settings are app content written as a key-level overlay, the fifteen constant settings are seeded only where the target holds no value, and `translations` and `add_ons` are merged by key as that row gives them (5); publish writes no `logo_refs`, because the logo is uploaded in HQ, and publish says so (13); `cloudcare_enabled` and `case_sharing` are named app content Nova does not author yet (14). (b) Pull request 5, which deletes `targetProfile.ts`: "A publish reads the current HQ app source before it imports: in preflight for an app that is already there, after the create for one it makes, and once more where it pushed a lookup table or a place in between. `lib/commcare/targetOverlay.ts` projects `profile`, `translations` and `add_ons` against the last of those reads: each carries what the target owns, and a key whose result equals that read's value is left out of the body. `lib/commcare/hqShells.ts`, `appProfileSettings.ts`, `derivedProfile.ts` and `targetOverlay.ts` state the rule." | 5, 13, 14 |
| `lib/deployment/CLAUDE.md`, "Ownership" | "A publish creates afresh only when there is no active mapping, or when a persisted upload failure says the mapped app is gone" | A publish creates afresh only when there is no active mapping or the active mapping's `remote_missing_at` is set. HQ reports an app gone in two forms: a 404 from the source read, the update or `current_app_version`; or a 200 source read whose `doc_type` ends `-Deleted`, HQ's ordinary delete being soft, with the update answering 400 for it. Either sets `remote_missing_at` and folds `remote_app_missing`; that publish refuses and the next creates an empty shell, then updates it. The recreated app keeps the deployment's recorded ids, which `app_deployment_identities` holds sparsely: only the ids that differ from the derivation, for a deployment first published before ids were derived (a menu's id and a form's `xmlns` as the app source held them, a form's id as the `ApplicationResource` read held it). No publish writes a row. No publish reads form ids back. A deployment whose HQ app is gone stays the same deployment: its live `app` mapping carries `remote_missing_at`, and its next publish creates a new app in that project space. One that holds no identity row gets derived ids there | 3 |
| `lib/deployment/CLAUDE.md`, the state ladder, and the paragraph of `docs/architecture/complex-apps.md` that says the same ("A publish refused at `resources` sent nothing of the app, so its retry re-pushes the data and never re-imports the app") | From "`resources` is what the app DEPENDS ON, put there before the app itself: its lookup tables and its organization's places." to "A publish refused at `resources` sent nothing of the app, which is what makes its retry cheap: it re-pushes the data and never re-imports the app." | Pull request 3: "`resources` is what the app's content DEPENDS ON, put there before that content: its lookup tables and its organization's places. The ordering is the reason it is a rung rather than a step inside the upload: the app's selects read those tables by name while somebody is using it, so content that arrived first would install and misbehave. On a first publish the empty app is made and read before any table or place is pushed: it holds no content, so nothing in it reads a table or a place, and CommCare HQ makes no build of it. A publish refused at `resources` sent none of the app's content, so its retry re-pushes the data and then sends the content once. A first publish refused there leaves the empty app, mapped with a null `pushed_revision`, and the retry fills that app and makes no second one. A create CommCare HQ refuses and a failed read after the create fold at `resources` too, since no later rung is reached." The paragraph of `complex-apps.md` becomes: "A publish refused at `resources` sent none of the app's content, so its retry re-pushes the data and then sends the content once; a first publish refused there leaves the empty app, which the retry fills". Pull request 13 adds, after the sentence on the empty app: "The empty app comes first so that its CommCare version, which nothing can read before HQ makes the app, is held to the floor before any Project data is written (`lib/commcare/versionFloor.ts::compareToVersionFloor`, the refusal `hq_app_version_below_floor`): every stop a person could decide differently precedes that first write. The floor's stop folds at `resources` as well." | 3, 13 |
| `lib/deployment/CLAUDE.md`, observation | "A 404 from `current_app_version` IS an answer (the app is gone) and is recorded" | Kept; adds that the same fact is `remote_missing_at`, which a succeeded `upload` observation or `recordRemoteResource` clears | 3 |
| `lib/db/CLAUDE.md`, the fold horizon paragraph | "`nova_admit_app_change_fold_baseline_insert` accepts exactly three identities" | Exactly four: the three named today and the paired `fold-baseline:hq-round-trip-emission` / `system:hq-round-trip-emission` operator cutover, which starts each app from the document its transform yields. "Adding another baseline identity needs new DDL." stays. The reason this horizon takes that route is the second table's row for the paragraph's opening, in pull request 15 | 2 |
| `lib/log/types.ts`, `archivedMutationEventSchema` | "A mutation event written before the canonical-identity fold horizon." | "A mutation event written before a fold horizon." | 2 |
| `lib/log/CLAUDE.md` | "Pre-cutover mutation payloads use the explicit opaque `archived-mutation` arm." | "Mutation payloads written before a fold horizon use the explicit opaque `archived-mutation` arm." | 2 |
| `docs/architecture/contracts.md`, "Nova's exports are proven where they are read." | "so a fix removes its entry in the same pull request" | "so a fix moves its entries to the fixed-defect register (`proof/fixed-defects.json`) in the same pull request, where each still shows on its retained control and is held on no document" | 1 |
| Root `CLAUDE.md`, the `proof/` entry | "held by the strict known-defect register (`proof/known-defects.json`)" | Adds: a fixed defect's entries move to `proof/fixed-defects.json` and keep showing on its retained control | 1 |
| `proof/CLAUDE.md`, the strict register | "A fix removes its entry in the same pull request." | "A fix moves its entries to `fixed-defects.json` in the same pull request, where each must still show on its control and is held on no document." Adds the repair rule for a fixed entry (re-pathed when the check's vocabulary or pinned upstream text moved and the control shows the same symptom; deleted with its citation when upstream changed the behavior, when a judge change deliberately stops the report on its control, or when a change to how the lane runs a control (the privileges its oracle grants it) takes the symptom off the control with no configuration left that shows it; never re-retained, never loosened), and the closed set of HQ's own reports with a proof per member | 1 |
| `proof/README.md`, "Claims held outside a document's checks" | The table's rows, each worded as what a test or a document shows today: "Defect 14's `both_fixtures`" (its cell opens "a device, which restores at the address that names the app, gets the flat fixture whatever the project space says"), "Defect 14's logos on a linked app" (its cell opens "HQ's own Copy Application view fails making a linked app over Nova's path-only logo"), "Defect 3's unknown-question clause", "Defect 4's add-ons", "Defect 5's "Upgrade Required" answer", "20, CommTrack" and "Defect 16's media slots" | Each row follows its fix: every app carries `project_default` and publish writes no `logo_refs` (13); the unknown-question row goes (6); an add-on stays after Nova's publish (5); Nova's client reports that nothing landed, and the media slots row names its tests (14); Nova's gate refuses the supply-point read (10). Part 09, What the two documents say when step 2 ships, gives each. "What the lane does not observe" holds only what depends on nothing in Nova's app and does not change | 13, 6, 5, 14, 10 |
| `proof/README.md`, "The defect rows" | One row per defect part, each worded as a live symptom (the row "13, reserved names" reads "Vellum reports each `__nova_` node as not a valid question id", and the row "14, search settings" opens "a Case List save resets the search button label and refuses a lookup prompt without a sort") | Each fix's pull request rewrites its own row to say fixed in step 2 and to name the control that still shows it; rows for findings 56, 57, 70 and 71 are added in pull request 1; defect 20's row says step 2 fixed its supply-point part (pull request 10), and defect 24's that step 2 fixed the repeat item's position (pull request 9). Part 09, What the two documents say when step 2 ships, lists every other passage of this file and of `proof/CLAUDE.md` that changes | each with its fix |
| `proof/CLAUDE.md`, the determinism rule | "the ordinals keep defects 1 and 9 visible" | In pull request 3, when a publish stops drawing ids: "the ordinals keep defect 9 visible and keep apart what a regression of defect 1's fix would mint apart" (part 01, A7. The proof capture, "The determinism sentences, at this pull request"). In pull request 5, when the profile's `uniqueid` stops being drawn: "the ordinals keep apart what a regression would mint apart" (part 04, Defect 9: the local profile identifies nothing stable) | 3, 5 |
| `proof/README.md`, "Emitting it" | "the ordinals keep apart what Nova keeps apart, so A and B mint different ids (defect 1 stays visible) and so do the two local exports (defect 9)" | In pull request 3: a publish draws no id, so A and B carry the same ones; the two local exports still draw different profile `uniqueid`s (defect 9); the ordinals keep a regression visible. In pull request 5: no export draws an id on either path, and the ordinals keep a regression visible. Each pull request's whole text is in its part (part 01, A7; part 04, Defect 9), and pull request 5's edit starts from pull request 3's text | 3, 5 |
| `proof/README.md`, the "weekly" bullet; `.github/workflows/proof-audit.yml`, the comment above the step "Seeding changes nothing observed" | "with defects 1 and 9 still showing"; "defects 1 and 9 must still show in both" | In pull request 3: "with defect 9 still showing"; "defect 9 must still show in both" (part 01, A7). In pull request 5: "with no identity difference"; "no identity difference shows in either" (part 04, Defect 9) | 3, 5 |

The second table, by file. Where today's sentence is kept, the row says so and gives what is written after it.

| File, section | Today | From step 2 | PR |
|---|---|---|---|
| `lib/commcare/CLAUDE.md`, "Client-safe barrel" | "Node-only modules (`./compiler` via `adm-zip`; `./ids` via `node:crypto`)" | "The Node-only module (`./compiler` via `adm-zip`)". `lib/commcare/ids.ts` is deleted, and `wireIdentity.ts`, which gives every menu and form its HQ id and every form its `xmlns`, draws nothing and reads no Node module, so the barrel exports its types (part 01, A1. Derived ids, and why `Form.xmlns` is not stored) | 3 |
| `lib/commcare/CLAUDE.md`, "Multilingual emission is one derived projection" | "Every configured language receives a complete effective value projection; a missing or stale target entry falls back to the current canonical source." | Kept, and followed by: "A form's itext values (a label, hint, help text, validation message and option label) then take the fill HQ's form builder applies on every save, `lib/domain/translationFill.ts::filledProse`: a blank value takes the default language's text, the app's first language; where that is blank too, the first non-blank value in language order; a text blank in every language stays blank. A leaf question's label that is blank in every language and carries no media is written with no `<label>` and no itext item, which is what a save leaves, and a written choice has a label or media (`SELECT_OPTION_LABEL_EMPTY`), because no spelling of an empty choice survives a save and a build." | 6 |
| `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility", the downloads sentence | "JSON and CCZ have no target project space, so compatibility is `not_checked`." | "A download checks no project space, so its compatibility is `not_checked`: the HQ import file has no target, and a `.ccz` is made for a project space the app is already published to, whose publish made the check." No part changes the report a download carries; pull request 3 makes the sentence's reason false for a `.ccz`, so part 01, A5 lists this edit | 3 |
| `lib/commcare/CLAUDE.md`, the two profile paragraphs of that section | (a) "Nova derives profile properties from app behavior; they are not authored settings and never enter `BlueprintDoc`." (b) The paragraph from "HQ shallow-replaces the full `profile` object when an import includes one, so in-place updates read and validate the current source profile immediately before import." to "New apps have no target state to preserve." | (a) "Nova derives one profile property from app behavior, the custom property `cc-index-case-search-results`; it is not an authored setting and never enters `BlueprintDoc`. Seventeen ordinary profile properties are stated by `appProfileSettings.ts::appProfileProperties`: `cc-show-saved` and `cc-show-incomplete` are app content (`appSettings`), and the other fifteen are constants, each the value a device reads when the key is absent." (b) "HQ's import replaces every top-level key an update's body carries and keeps every key it leaves out (`models/applications.py::_merge_source_into_app`), so three keys need the target's current value: `profile`, `translations` and `add_ons`. Every read of the app's source goes through one reader (`hq/appSource.ts::readHqAppSource`), and `targetOverlay.ts::projectApplicationForTarget` projects all three against the one read the publish hands it, its last before the import (`lib/deployment/CLAUDE.md` says which): it carries what the target owns, writes Nova's own values over it (`cc-show-saved` and `cc-show-incomplete` always; a constant setting only where the target holds no value for it), and leaves a key out of the body when the result equals that read's value. `profile.properties` is projected whatever the Search advisory says; an `unverified` advisory leaves `custom_properties` as the target's bag. A source that fails the shape check stops the import with `hq_app_state_unknown` and is never read as empty. Every content write is an update of an app Nova has read, the empty app a first publish makes included, so no body is sent blind." `targetProfile.ts` is deleted (part 04, Shared: the overlays' read and one overlay module) | 5 |
| `lib/commcare/CLAUDE.md`, "Validation counts keep their evaluation context" | "`constraintCollections.ts` lifts independent `count(otherQuestion[predicate])` expressions into reserved sibling calculations, then keeps the candidate comparison in the constraint." and "The executable and Vellum shadow expressions share the lowered result." | Pull request 6, the second sentence: "The lifted calculation carries no `vellum:calculate`, because its expression filters a form reference, and its predicate's own node is printed `./.`; the constraint's executable and shadow expressions share the lowered result." Pull request 7, the first: "`constraintCollections.ts` lifts independent `count(otherQuestion[predicate])` expressions into sibling Hidden Values named `nova_constraint_<question>_<n>` by the allocator (`xform/generatedNodes.ts::planGeneratedNodes`), then keeps the candidate comparison in the constraint." The name is not reserved: an authored sibling of the same name makes the allocator take the next suffix | 6, 7 |
| `lib/commcare/CLAUDE.md`, "Hidden fields carry one value source" | From "JavaRosa runs the `xforms-ready` seeds first and then re-evaluates every calculate (`commcare-core` `FormDef::initialize`), so the default is overwritten before anyone could read it" to "With `hiddenNoValue` it partitions the hidden state space; the shared recognizer is `lib/domain/fields/hidden.ts`." | "JavaRosa runs the `xforms-ready` seeds first and then re-evaluates every calculate (`commcare-core` `FormDef::initialize`), so the calculate's value is the one the field ends with; a later load-time setvalue can still read the default before that (run on Core: a hidden value with the default `'D'` and the calculate `'C'` ends as `C`, and a second value whose own default reads the first holds `D`). Nova does not yet write a Hidden Value's default beside its calculate (`lib/domain/fields/hidden.ts::HIDDEN_VALUE_ONE_SOURCE_SENTENCE`). A hidden field with neither slot is admitted and opens blank; the shared recognizer is `lib/domain/fields/hidden.ts`." `hiddenNoValue` and `HIDDEN_NO_VALUE` are gone (part 08, Defect 16) | 14 |
| `lib/commcare/CLAUDE.md`, "Vellum dual-attribute pattern" | (a) "`hashtags/formContext.ts::vellumShorthandInContext` is the projection, and the guaranteed set is small: `#form/` (always), and `#case/<prop>` (single plain segment, the form's OWN loaded case) on `followup`/`close` forms", with the rest of that paragraph. (b) The paragraph from "Form-wide hashtag metadata rides HEAD elements after `</model>`" to "omitted when no ref earned a shadow." and the two sentences after it on the transforms table. (c) "`case_references_data.load` is a SEPARATE vocabulary with looser rules (`hashtags.ts::hqLoadReference`)" | (a) "`hashtags/formContext.ts::vellumShorthandInContext` is the projection, and it projects `#form/` only: any other namespace in an expression means no shadow. No shadow carries `#case/`, because a `#case/` hashtag over `case_id`, `owner_id` or `status` is saved as a child element the case database does not have, and one over a property HQ's schema does not list is an unknown question on every save. With the raw casedb path in the real attribute, the form builder's reverse map turns a listed property into its own `#case/<property>` on load and saves the same real attribute, and leaves every other read raw. The projection also returns no shadow when a hashtag is the base of a predicate or the first component of a longer path: the form builder cannot parse that, writes the shadow verbatim into the real attribute, and HQ's next build fails. A predicate's own node is printed `./.` outside a validation condition (`xpath/selfSteps.ts::spellPredicateSelf`), because the form builder reads a bare `.` in any other condition as the question referring to itself." The sentences after it that list what is only conditionally present (`#user/`, parent and grandparent hashtags, registration and survey forms) become one: every namespace but `#form/` suppresses the shadow. (b) Deleted: no form source holds `<vellum:hashtags>` or `<vellum:hashtagTransforms>`, no `<output>` carries a `vellum:value` for a case reference, and `hashtags.ts::buildVellumTransforms` is gone. In their place: "Once a save in HQ's form builder has written its own `#case/x` shadow and `x` later leaves HQ's schema, the builder warns about HQ's bytes, as it does for any form made in HQ; a Nova publish replaces the source." (c) Kept: `case_references_data.load` keeps HQ's `#case/` strings, which HQ's app summary reads (`app_schemas/app_case_metadata.py`) and the form builder does not (part 05, Shadows (defect 13) with findings 45 and 47) | 6 |
| `lib/commcare/CLAUDE.md`, "Secondary instances", the primary instance root | "`xform/dataRootAttributes.ts` is the shared projection for emitted and Preview-visible `uiVersion`, `version`, and slugged `name` attributes." | Pull request 5: "`xform/dataRootAttributes.ts` is the shared projection for emitted and Preview-visible `uiVersion`, `version`, and slugged `name` attributes. The source and Preview keep `version` `1`; a local archive's forms take the app's sequence at compile time (`xform/formVersion.ts::setFormVersion`, called by `compileCcz` beside `addCaseBlocks` and `addMetaBlock`), as HQ's build overwrites the source's `1` with its own." Pull request 6 replaces "slugged `name`": "The data node's `name` and `<h:title>` are the form's name in the app's default language (`lib/domain/formWireName.ts::formWireName`), the text HQ's form builder writes into both on a save. No spelling survives a save made in another editing language: the builder then writes that language's name into both, as it does to a form made in HQ. The first save of a Nova form in the form builder gives it a new version at the next build, with nothing in it changed, so devices fetch it again." | 5, 6 |
| `lib/commcare/CLAUDE.md`, "Repeat modes" | (a) "Three modes via `repeat_mode` discriminator, each emits different wire shape:" (b) "No count setvalues or `__nova_count_*` snapshots remain." | (a) Pull request 6, kept and followed by: "Every repeat, the selected-cases repeat included, sits in a `<group>` with no `ref`, the wrapper HQ's form builder writes; a `ref` there is an attribute the builder never reads and never writes." Pull request 7, which adds the keyed create's repeat, widens its opening: "Every repeat, the selected-cases repeat and a keyed create's one-row repeat included,". (b) Pull request 7: "No count setvalues or count snapshots remain." The sentence before it keeps `nova_count_<repeatId>`, which the allocator now names (`xform/generatedNodes.ts::planGeneratedNodes`), and its "collision suffixes preserve authored siblings" is the allocator's one rule | 6, 7 |
| `lib/commcare/CLAUDE.md`, "Case-management scaffolding emission", the case-create and case-update bullets | (a) "The case-name source question's bind also gains `required="true()"` (merged onto the field's existing bind, not a duplicate)" (b) "Every per-property update bind also carries `relevant="count(<qPath>) > 0"`" (c) "Each subcase's name question also gets `required="true()"` merged onto its bind, same as the primary case." | All three in pull request 9. (a) "Each question a basic action reads as a case name or an external id has one sibling Hidden Value, `nova_trimmed_<question>` (its calculate the `replace()` trim, its `relevant` `count(<question>) > 0`), and the action names that node: HQ's build binds the leaf to the path the action names, so the trim lives where both export paths read it and the local archive binds the leaf to that path with no trim of its own. `required="true()"` is stamped on the node a create's name action names, as HQ's build stamps it, where it is inert; what keeps a name required of the worker is `required="true()"` on the question's own bind, which replaces an authored required condition there as HQ's build always did. A visible source question's constraint gains the guard, conjoined with the authored validation: for a case name, not blank after the trim and at most 255 characters; for an external id, the length alone. A Hidden Value source takes neither. The guarded set is `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`, which Preview reads too." (b) Kept, with `<qPath>` the path the action names, and followed by: "`update_case.condition` is `always` on every registration, follow-up and close form, as HQ's Case Management save writes it, so a follow-up that writes nothing still carries its case block in a single-select menu and marks its case as updated; a form of a multi-select menu has no primary block under either value. The local archive writes `<update>` exactly when the update map holds an entry, and writes an update's properties and an attachment's children in name order by code unit, as `XFormCaseBlock.add_case_updates` does. An external id is one of those rows: `open_case.external_id` is `null` and the write is `update_case.update.external_id`." (c) "Each subcase's name action names the question's `nova_trimmed_` node, and its name question carries `required` and the guard as the primary case's does." | 9 |
| `lib/commcare/CLAUDE.md`, "Case-management scaffolding emission" and "Repeat-context subcase splice + nest decision", where the blocks stand | "`xform/caseBlocks.ts::addCaseBlocks` mirrors CCHQ's `_create_casexml` splice: pre-count subcases per `repeat_context` to pick `nest = (count > 1)`." and "`nest = false` (single subcase under the repeat) splices `<case>` directly into the repeat's template subtree" | Both kept, and followed by: "The local data node reads as HQ's build writes it (`xform.py::XForm._create_casexml`): the fields, each `subcase_<n>`, the form's own `case`, `commcare_usercase`, `meta`. The form's own block is pushed after the subcase loop. A single repeat subcase's `<case>` is the first child of the repeat item (`CaseBlockChild.position: "first"`, through `xform/domSplice.ts::prependChildren`), also where the item holds Save to Case blocks; a nested `subcase_<n>` wrapper is appended." The spelling rule `proof/rules/case_block_position.py`, which erased Nova's former item position, retires in the same pull request | 9 |
| `lib/commcare/CLAUDE.md`, "Authored case-operation emission", its first paragraph | "Calculated writes to effective datetime properties carry an `xsd:dateTime` bind, using the operation's destination type after retyping. Core's `Recalculate.wrapData` otherwise wraps a calculated Java Date as `DateData`, which serializes the day and loses its clock time." | "A write to an effective datetime property, by the operation's destination type after retyping, is an untyped leaf whose calculate is `xform/datetimeCaseValue.ts::datetimeCaseValueExpression` of the value: `if(E = '', '', format-date(coalesce(E, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`. HQ's form builder writes a row's bind with no `type`, and Core's `Recalculate.wrapData` would wrap an untyped calculated Date as the day alone; `coalesce` unpacks the Date and `format-date` leaves it unrounded, so the instant is kept. Every `@date_modified` bind stays `xsd:dateTime`, the builder's own spelling. A value that is already text is parsed and printed again: a saved date and time copied to another property is written in the device's zone with milliseconds, and lands a day off where the device's local date for that instant differs from the date written; text that is no date raises `XPathTypeMismatchException`. Both are accepted: wrapping only the expressions Nova can prove yield a Date would need a second spelling a reader must recognize." | 6 |
| `lib/commcare/CLAUDE.md`, "Authored case-operation emission", conditions, ids and guards | (a) "Conditions become wrapper relevance and write conditions become child relevance." (b) "A live calculate bind is used even when singular, so the submitted id reflects the final answer." (c) "every data-dependent retype gets a trailing atomic guard that rejects a `nova-case-v1:` target before the effect can commit" (d) "repeated `id-of` binds are relative only within the exact correlated iteration" (e) The sentence that opens "Ordinary and advanced fixed-text scalar calculates pass through JavaRosa" and the one after it, "Guards cap every value at 255 Java/JS UTF-16 code units; names and explicit owners must also remain nonblank, while `external_id` may be the real empty string." | (a) Pull request 7: "A condition has two spellings, by what HQ's form builder keeps. A conditional create carries it as `relevant` on `<block>/case`, the builder's Open Case Condition. A conditional update or close sits inside the group `nova_condition_<operation id>`, whose bind carries `relevant`, because the builder writes no bind for a block's own node. Every guard of a conditional operation, a create's included, sits inside that group: a guard that ran while its create did not would update a case that does not exist. Write conditions stay child relevance." (b) Pull request 7: "A live calculate bind carries a keyed id, so the submitted id reflects the final answer. The form builder writes a create's id as a bind only inside a repeat, so a root create keyed by an answer sits in a one-row repeat no worker sees, `nova_keyed_<operation id>`, counted by `nova_count_nova_keyed_<operation id>` (`calculate="1"`), inside `nova_operations`; its guards stand outside the repeat." (c) Pull request 7: "A guard is an update-only Save to Case block after its operation's block, `nova_guard_<operation id>_type`, `_retype` or `_text`, at most one of each kind. It writes `update/case_type` to the type the case then holds, and its `@case_id` is `if(OK, ID, '')`: a blank id refuses the whole submission on Core and on HQ." (d) Pull request 7: "One block reads another's id and leaves through `current()`, at the form root as in a repeat row (`xform/formPath.ts::relativeXPath`), never by an absolute path: the form builder reads an absolute path into a case block as an unknown question. It does not follow a `current()` path, so a person who renames an operation's block in the form builder leaves these reads naming the old block; a Nova publish replaces the form." (e) Pull request 6 takes the leaf constraints away: "No leaf of a case block carries a `constraint`: a runtime evaluates one only for a question being answered. An authored operation's values are capped by its text guard, a calculate, at 255 Java/JS UTF-16 code units". Pull request 7, which renames the guard and makes it a Save to Case block, names it in that sentence: "capped by its `nova_guard_<operation id>_text` block, a calculate,". Pull request 9 narrows the first sentence to authored operations: a basic action's name and external id read the question's `nova_trimmed_` node | 6, 7, 9 |
| `lib/commcare/CLAUDE.md`, "Authored case-operation emission", the ordinary action beside the operations | "so every advanced operation executes before Nova's ordinary primary-case action; the integration oracle pins that relationship explicitly." | Kept, and followed by: "Where a form closes its case on a condition HQ's Case Management tab cannot state, the close is one of those earlier blocks. `lib/domain/closeCondition.ts::closeConditionPlacement` derives the placement and stores nothing: `form-action` when the field is a single select, a multi select, a Hidden Value or a label, sits in no repeat, the answer holds no `'` and neither starts nor ends with `"`, and a select with written choices holds the answer among them; `save-to-case` otherwise. For `save-to-case` in a single-select form, `close_case.condition` is `never` and the close is the block `nova_close` inside the group `nova_condition_close`, whose `relevant` is the condition." | 9 |
| `lib/commcare/CLAUDE.md`, "Hashtag form-context", the registration narrowing | "`#<own>/case_id` rewrites to `/data/case/@case_id` (populated by the case-create scaffolding's setvalue chain)" | "`#<own>/case_id` reads `instance('commcaresession')/session/data/case_id_new_<own type>_0` (`session.ts::newCaseIdDatumId`), the datum HQ's suite and the local suite both give a registration form and the one HQ's build sets the create block's id from; the form declares `commcaresession` whenever the read is emitted. `/data/case/@case_id` names a block the stored source does not hold, which HQ's form builder reports on every save." The section also gains: "A default value that reads another question reads it as `current()/<relative steps>` with no `vellum:value` (`expandHashtagsForDefaultValue`): the form builder refuses a `#form/` hashtag in a default and turns an absolute path into one on load. It does not follow a `current()` path, so renaming the question in the form builder leaves the read as it was." | 6 |
| `lib/commcare/CLAUDE.md`, "Ordinary datetime case writes" | "Hidden datetime writers derive their `xsd:dateTime` bind from the effective case-property catalog. Ordinary datetime writes use a reserved sibling text node (`xform/datetimeCaseValue.ts`) as their HQ action question path." | Pull request 6 adds, after "The sibling formats the unpacked typed value": "An authored operation's write to a datetime property uses the same calculate on an untyped leaf (`datetimeCaseValueExpression`)." Pull request 7 renames the node: "Ordinary datetime writes use a sibling text node, `nova_datetime_<question>` (`xform/datetimeCaseValue.ts`, named by the allocator), as their HQ action question path." | 6, 7 |
| `lib/commcare/CLAUDE.md`, "`post_submit` defaults" | (a) "The stored and machine-authored vocabulary is exactly `app_home`, `module`, or `previous`." (b) From "Form-type defaults when absent: registration/survey → `app_home`; followup/close → `previous`, except in a search-first module, where it is `module`" to "so the default cannot be `previous` there." | (a) "The stored and machine-authored vocabulary is exactly `app_home`, `firstMenu`, `module`, `parentMenu`, or `previous` (`lib/domain/forms.ts::POST_SUBMIT_DESTINATIONS`)." The next sentence keeps its wording and gains the two projections: `firstMenu` is HQ's `root`, one `<create/>` with no children, and `parentMenu` is `parent_module`, the parent menu's frame. (b) "Form-type defaults when absent: registration/survey → `app_home`; followup/close → the first the menu offers of `previous`, `module`, `firstMenu` (`lib/domain/forms.ts::defaultPostSubmit` takes the menu facts `searchFirst`, `multiSelect`, `parentMultiSelect` and `offTheMenu`; `lib/domain/postSubmit.ts::effectivePostSubmit` is the doc-level reader every consumer uses). `postSubmitDestinationsOffered` is what HQ's form settings page offers for the menu's shape, narrowed by Nova's own conditions for a menu that is off the menu, and one rule, `POST_SUBMIT_NOT_OFFERED`, refuses a stored destination outside `postSubmitDestinationsAdmitted`. Everything HQ's build refuses is unoffered (`previous` where exactly one of the menu and its parent selects several cases, `previous` in a menu that opens on Search, `parentMenu` with no parent), so the one rule covers the editor and the build." | 12 |
| `lib/commcare/CLAUDE.md`, the paragraph that opens "Module/form navigation display conditions use `suite/displayConditions.ts`." | (a) "direct self properties structurally anchor through the selected `commcaresession/session/data/<projected-own-case-id>` in local suite XML and through HQ's `#case` interpolation in JSON." (b) "their secondary instances are child `<instance>` elements on that menu, requiring the fixed HQ build 2.54." | (a) Pull request 5: "direct self properties structurally anchor through the selected `commcaresession/session/data/<projected-own-case-id>` in local suite XML. In HQ JSON a read of `case_id`, `case_type`, `owner_id` or `status` is printed as that same expanded read, `instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/<datum>]/@<property>`, because HQ's `validate_app()` refuses `#case/@<property>` (`form filter has xpath error`); every other property keeps `#case/<property>`, which lets HQ choose its own datum." (b) Pull request 13: "their secondary instances are child `<instance>` elements on that menu, which CommCare reads from 2.54, below the 2.57 every app Nova publishes or compiles requires (`versionFloor.ts::COMMCARE_VERSION_FLOOR`)." | 5, 13 |
| `lib/commcare/CLAUDE.md`, the `displayConditions` bullet of the case-search emission list | "Deeply always-true conditions disappear through `effectiveDisplayConditionForEmission`." | "A condition is emitted as written: `lib/domain/predicate/simplify.ts::displayConditionForEmission` gives nothing for an absent condition or one whose root is `match-all`, and otherwise the condition exactly as stored, so the instances the emitter declares are the ones the printed text reads. A menu or form with `hiddenFromMenu` emits `false()`, or `false() and (<rest>)` where it holds a condition, with the parentheses always written and its instances taken from the rest." The sentence before it is in the first table | 12 |
| `lib/commcare/CLAUDE.md`, "Search-first inline shape", the refusals | From "The four refusals mirror HQ's build validator (`helpers/validators.py`)" to "`SEARCH_FIRST_NO_PREVIOUS_WORKFLOW` (explicit `previous` on a case form; `workflow previous inline search`), and `SEARCH_FIRST_UNIQUE_INSTANCE`" | "The three refusals mirror HQ's build validator" and the list without its third member. `SEARCH_FIRST_NO_PREVIOUS_WORKFLOW` is gone: HQ's `workflow previous inline search` is the reason `menu-opens-on-search` of `POST_SUBMIT_NOT_OFFERED`, which the "`post_submit` defaults" section states | 12 |
| `lib/commcare/CLAUDE.md`, "No-matches registration lowering" | (a) "Explicit `postSubmit: "app_home"` on a no-matches form emits HQ `root` and one empty local `<create/>`." (b) "A multiple-selection host requires explicit App home:" | (a) "Explicit `postSubmit: "firstMenu"` on a no-matches form emits HQ `root` and one empty local `<create/>`, the ordinary `firstMenu` lowering: it is the one explicit destination a no-matches form may hold." (b) "A multiple-selection host requires explicit `firstMenu`:". No byte changes; the document now says what the wire does | 12 |
| `lib/commcare/CLAUDE.md`, "Not-yet-modeled", the validation stubs | "Validation stubs that activate when features land:" with its one item, "`previous` + `multi_select`" | Both lines are deleted: `POST_SUBMIT_NOT_OFFERED` holds the shape (its reasons `menu-selects-several` and `parent-selects-several`) | 12 |
| `lib/commcare/CLAUDE.md`, the three sentences on which saved columns reach a runtime | (a) "Fully off-screen, unsorted definitions have no runtime role and are ignored." (b) "every saved definition is validated, but a fully hidden unsorted definition does not trigger emitted support rows;" (c) "Only Preview, CommCare emission, and emitted-reference walks consult `caseListColumnIsEmitted`; hiding never creates deferred invalid state and revealing never repairs or rewrites a definition." | (a) "Every column of a list with no tile layout is a field of the short detail, so a calculated column hidden from both screens with no order rule is evaluated for every row and its instances are declared on the entry and on the remote request, as HQ's build declares them for an `invisible` expression column. In a tile list a column hidden from both screens declares nothing: with an order rule it rides as a property carrier, which reads the case's own property, and with none it has no runtime role." (b) "every saved definition is validated, and every column a runtime evaluates (`caseListColumnRuns`) triggers its emitted support rows;" (c) "Two predicates in `lib/domain/modules.ts` say whether a column reaches a runtime. `caseListColumnRuns(column, config)`: a runtime evaluates its value, which is every column of a list with no tile layout and, in a tile list, a column shown on Results or Details; the compiler's instance walk, `searchSession.ts::buildSearchQuery`, `relatedCaseProjection.ts` and Preview's case data binding read it. `caseListColumnTextShows(column)`: its header, labels or images reach a screen, which is a column shown on Results or Details; the translation units and the media reference walks read it. Hiding never creates deferred invalid state and revealing never repairs or rewrites a definition." | 11 |
| `lib/commcare/CLAUDE.md`, the paragraphs that open "Sort lives on each column." and "The comparator type for each `<sort>` is derived at wire emission, not authored." | (a) From "The wire emitter walks columns in Results order, drops columns without a `sort` slot, sorts the survivors by `priority` ascending (tie-break to Results index), and emits one `<sort>` block per column carrying its 1-based `order` attribute." to "the defensive tie-break keeps projection deterministic if malformed input reaches an inspection boundary." (b) From "The dispatch lives in `sortKeys.ts::resolveColumnSortType`" to "route to comparator type `"plain"` (lexicographic)." | (a) "`lib/domain/caseListOrder.ts::caseListOrderPlan` is the one statement of a list's order: what HQ's build writes for the app Nova sends, each rule with its citation in the module. Its `fields` are the short detail's fields in stored order, each with its wire class (a property column or an expression column), the text HQ joins a sort element to it by, the sort key it keeps with no rule, and its rule if the list orders by it; its `carriers` are the hidden sort fields HQ appends for rules that join no field. Authored rules become elements in `priority` order, ties by Results position; each lands on the first field whose join text equals its own; a list with no authored rule orders by its first shown field's own key, ascending, compared as text; blanks come first ascending and last descending. HQ JSON, the local suite and Preview's case store all read the plan, so the three order alike. `CASE_LIST_DUPLICATE_SORT_PRIORITY` stays soundness, and `CASE_LIST_SORT_PROPERTY_AMBIGUOUS` refuses two rules over one value, and a rule that would land on a field with another key, so in an admitted document every rule orders as authored." (b) "The comparator of each element is derived in the plan, not authored: integer or decimal only for a `property` or `calculated` key over an integer or decimal value (`caseListOrder.ts::comparatorForDataType`, and the plan's `calculatedType` option for a calculated column), and text for every key a field keeps on its own (a date's stored value, a mapping's position, a select's label, an interval's text)." `sortKeys.ts::resolveColumnSortType` and `applicableSortTypes` are deleted | 11 |
| `lib/commcare/CLAUDE.md`, the hidden Results field, before "The `interval` kind covers both relative-interval and threshold-flag UX" | From "`shortDetail` normally omits `visibleInList: false`; when such a field still owns a Default-order rule it emits the standard zero-width sort-carrier shape" to "HQ short details retain the corresponding `format: "invisible"` column for the same positional/sort reason." | "In a list with no tile layout `shortDetail` keeps every `visibleInList: false` column as a hidden field in HQ's own shape: `<header width="0"><text/></header>`, with no locale id and no app string, and a `width="0"` template over the raw wire path, or the calculated template for a calculated column. HQ short details hold the same column as `format: "invisible"`. A device's search matches a hidden field's text, and Android's Sort menu lists the shown columns alone. A tile list holds no hidden field; "Case-tile emission" gives what a hidden column's order rule becomes there." | 11 |
| `lib/commcare/CLAUDE.md`, "Case-tile emission", the sort carrier paragraph | From "The zero-width sort carrier needs NO tile change: an off-screen Results field that still owns a Default-order rule keeps emitting `<header width="0">` + `<template width="0">` + `<sort>` with no `<style>`" to "The carrier is an empty zero-size grid item, so a tile keeps the hide-but-sort affordance a row layout has." | "In a tile list a column hidden from Results is no field of the short detail: a stored hidden column would be given a cell by HQ's Case List save and a `<style>` by the build after it. Its order rule rides as a sort-only property carrier, a sort row on the property with no stored column, unless a placed column's join text is that property, which then takes the rule. HQ appends the carrier as a width 0 field with its `<sort>` and no `<style>`; `owner_id` and `status` ride under their bare names. A hidden calculated column, or a hidden column over `case_id`, with an order rule has no spelling HQ's editors keep and is refused (`CASE_TILE_HIDDEN_CALCULATED_SORT`). The carrier draws nothing on any runtime: Android lays out the placed cells alone, and the Web Apps client keeps the carrier's cell out of the layout. So a tile keeps the hide-but-sort affordance a row layout has." The citations of Core's and the Web Apps client's width 0 handling stay | 11 |
| `lib/commcare/CLAUDE.md`, "Case-search emission", the quote cascade | "and the fail-closed arm emits the deliberately invalid `search-value-mixes-quote-marks()` because Android never enforces prompt validation, making the on-device guard the injection defense there" | "and the fail-closed arm sends `match-none()`, the one value in HQ's query language that finds nothing, because Android never enforces prompt validation, making the on-device guard the injection defense there". On Android the worker then reads "Query response had no results" with the answer still editable. The same section gains pull request 14's obligation beside the numeric and geopoint ones: "A runtime value compared by any operator with `date_opened`, `closed_on` or `last_modified`, or by an ordering operator with any property, carries the typed obligation `blank-comparand` (`predicate/runtimeCsqlDateSafety.ts`): while the value is blank the whole clause is `match-none()`, because HQ's query raises on a blank there." | 14 |
| `lib/commcare/CLAUDE.md`, "The surface manifest", the authored family | "One family is authored instead: `media-formats.json` (`media-format:`), whose facts come from the vendors' documentation; a change to it is a reviewed edit." | "One family is authored instead: `media-formats.json` (`media-format:`), whose facts come from the vendors' documentation and, where an item carries `executed`, from the run its record names; a change to it is a reviewed edit." | 14 |
| `lib/commcare/CLAUDE.md`, the XForm oracle paragraph on definitions and data | "An answer named `secret`, `bind`, or `translation` is ordinary data; data cannot declare a secondary instance or satisfy a missing itext reference." | Kept, as what Core and Nova's oracle read, and followed by: "HQ's form builder cannot open a form that holds an element named `instance`, `bind` or `parsererror` at any depth, so the validator refuses those three as a question id and a Connect block id (`lib/domain/questionId.ts::RESERVED_QUESTION_IDS`), as a case operation id and a link identifier (`questionId.ts::stopsFormBuilder`), and as a property name a block in a form's source writes (`CASE_PROPERTY_NAME_STOPS_FORM_BUILDER`). A property a basic action alone writes is not refused: HQ's build adds that block and the source never holds it." | 10 |
| `lib/commcare/CLAUDE.md`, the `bindingResolutionOracle.ts` bullet | "Three rules: every `instance('commcaresession')/session/data/<X>` references a declared session datum on the form's entry;" | Kept, and the bullet gains: "The first rule is also the validator's, for every admitted document: `validator/rules/sessionData.ts::sessionDatumNotSupplied` (`SESSION_DATUM_NOT_SUPPLIED`) reads the datums `formLinkProjection.ts::entrySessionDatums` gives the form's entry, the projection the compiler writes each `<entry>` from. The oracle proves it over the fuzz corpora, which now draw raw session reads." | 10 |
| `lib/commcare/CLAUDE.md`, the zero-input Search shape | "The HQ JSON projection supplies a match-all default property for the explicit zero-input/manual shape because CCHQ offers Search only when a property or default property exists; this is wire scaffolding, not an authored filter." | In part 03's words (C4. Finding 53: the zero-input sentinel): "Both export paths send a match-all filter for the explicit zero-input/manual shape (`suite/case-search/xpathQuery.ts::ZERO_INPUT_SEARCH_SENTINEL`), because CCHQ offers Search only when a property or default property exists; this is wire scaffolding, not an authored filter." | 12 |
| `lib/domain/CLAUDE.md`, the localization root | "Two-letter codes exist only inside `lib/commcare` as emitted wire spellings." | "Each language's CommCare wire code is part of the document: `localization.wireCodes` holds it from the mutation that adds the language, which carries it, and it never changes while the language stays in the app. No author chooses one, and `lib/commcare` is the only reader of its spelling." | 3 |
| `lib/domain/CLAUDE.md`, the `caseScalarText.ts` sentence | "The wire emitter, Preview, and submission executor use that helper rather than letting Core, HQ, and Postgres normalize independently." | Kept, and followed by: "On the wire the trim of a name or an external id a basic action reads lives in a Hidden Value beside the question, `nova_trimmed_<question>`, which the action names, so HQ's build and the local archive bind the same trimmed value; the nonblank and 255 checks live on the visible question's own constraint. `caseScalarTextGuard.ts::caseScalarTextGuards` is the set of guarded questions, read by the emitter and by Preview's form engine." | 9 |
| `lib/domain/CLAUDE.md`, the option value sentence of the translation inventory | "Case-property option values are their semantic key; because Classic accepts repeated stored values, later same-value occurrences add their stable same-value ordinal so no legal label silently aliases the first occurrence." | "Case-property option values are their semantic key, and two options of one list never share one: `SELECT_OPTION_VALUE_DUPLICATE` refuses it among a select's written choices and `CASE_PROPERTY_OPTION_VALUE_DUPLICATE` in a case property's catalog, compared as exact strings, as HQ's form builder and Core compare them. The unit id's same-value ordinal stays as the projection's own guard for a value that repeats, which no admitted document holds." | 10 |
| `lib/domain/CLAUDE.md`, the paragraph that opens "Every saved case-list column is valid unconditionally" | "`caseListColumnIsEmitted` is the sole authored-to-runtime projection. Preview, CommCare emission, and emitted-reference walks consult it, as does the authored persistence walk `mediaRefs.ts::walkAuthoredAssetRefs` that backs reverse-index admission, deletion, and Project moves." | "Two predicates in `modules.ts` are the authored-to-runtime projection. `caseListColumnRuns(column, config)` says a runtime evaluates the column's value: every column of a list with no tile layout, and in a tile list a column shown on Results or Details. CommCare emission's instance walks and Preview's case data binding consult it. `caseListColumnTextShows(column)` says its header, labels or images reach a screen: a column shown on Results or Details. The translation inventory consults it, as does the authored persistence walk `mediaRefs.ts::walkAuthoredAssetRefs` that backs reverse-index admission, deletion, and Project moves." | 11 |
| `lib/domain/CLAUDE.md`, the tile paragraph | "a per-column `tile` cell carrying `{x, y, width, height}` and optional alignment / text size / border / shading" | "a per-column `tile` cell carrying `{x, y, width, height}`, its required `horizontalAlign`, `verticalAlign` and `fontSize` (`tileCell()` fills `left`, `top` and `medium`), and optional border / shading". HQ's Case List save writes the three on every cell, so a cell without them changes on a save | 11 |
| `lib/domain/CLAUDE.md`, the navigation defaults | "`defaultPostSubmit(formType, { searchFirst })` is the form-type-aware navigation default, and it is module-aware: a followup/close form in a search-first module (`modules.ts::moduleOpensOnSearch`) defaults to `module`, not `previous`, because the previous screen was the search." | "`defaultPostSubmit(formType, { searchFirst, multiSelect, parentMultiSelect, offTheMenu })` is the form-type-aware navigation default, and it is module-aware: a registration or survey defaults to `app_home`, and a followup/close form to the first its module offers of `previous`, `module`, `firstMenu`. A form holds one of five destinations (`forms.ts::POST_SUBMIT_DESTINATIONS`: `app_home`, `firstMenu`, `module`, `parentMenu`, `previous`). `postSubmit.ts::postSubmitDestinationsOffered` is the set a module's shape offers, and `postSubmitDestinationsAdmitted` the set the validator, the reducers and the builder read: the offered set, with the two several-case conditions ignored for a form that holds links, whose `postSubmit` is the fallback after them." | 12 |
| `lib/domain/CLAUDE.md`, the paragraph that opens "Modules and forms each carry an optional typed `displayCondition: Predicate`." | "Modules and forms each carry an optional typed `displayCondition: Predicate`." | Kept, and followed by: "Each also carries an optional `hiddenFromMenu: true`, the one way to say an item is not on the menu; `displayCondition` then holds the rest, the condition that applies once it is back. A module that is off the menu takes its forms with it; a child module of one is not itself off the menu. A condition that is `match-none`, or an `and` whose first clause is, is refused by a shape rule, because it would print the hidden spelling." | 12 |
| `lib/domain/CLAUDE.md`, field kinds, the hidden field | "JavaRosa evaluates every calculate after the `xforms-ready` seeds, so a default beside a calculate is dead;" | "JavaRosa evaluates every calculate after the `xforms-ready` seeds, so the calculate's value is the one the field ends with; Nova does not yet write a Hidden Value's default beside its calculate (`fields/hidden.ts::HIDDEN_VALUE_ONE_SOURCE_SENTENCE`);" The default is not dead: a later load-time value can read it (part 08, Defect 16). The sentence after it is in the first table | 14 |
| `lib/domain/CLAUDE.md`, the media primitives | "The media primitives (`MediaAssetId`, `Media`, MIME partitions, size caps, the export ceiling, GCS key derivations) live in `multimedia.ts`" | "The media primitives (`MediaAssetId`, `Media`, the format registry `ACCEPTED_FORMATS` from which the MIME partitions, the extension lookups and `ACCEPTED_EXTENSIONS` derive, `MODEL_READABLE_IMAGE_MIME_TYPES`, size caps, the export ceiling, GCS key derivations) live in `multimedia.ts`". The registry holds one entry for each canonical MIME type, documents included, and each media entry names the items of `lib/commcare/surface/media-formats.json` it admits. A model is sent only PNG, JPEG, GIF and WebP images, so a BMP never reaches one | 14 |
| `lib/doc/CLAUDE.md`, "Every reducer is deterministic." | "A mutation carries the identities it installs rather than minting them on the way past, so applying a batch twice reaches the same document." | Kept, and followed by: "A language's CommCare wire code is one of those identities: `addLanguage` and `relabelSourceLanguage` carry a required `wireCode`, which every producer computes when it builds the mutation, through the one planner `languageMutations.ts`, and the reducer stores what the mutation carries and refuses a code another language holds. The reducer never computes one: the function that does reads the language catalog, and a code computed at replay could change with the catalog." The file list gains `languageMutations.ts`, in the pattern of `userMutations.ts` | 3 |
| `lib/doc/CLAUDE.md`, `identifierVerdicts.ts`, the backstops | "the validator's `DUPLICATE_FIELD_ID` / `INVALID_FIELD_ID` / `RESERVED_FIELD_ID_PREFIX` rules stay as backstops." | "the validator's `DUPLICATE_FIELD_ID` / `INVALID_FIELD_ID` rules stay as backstops." `RESERVED_FIELD_ID_PREFIX` is deleted with the reserved prefix | 7 |
| `lib/doc/CLAUDE.md`, null-as-delete for `displayCondition` | "(the validator rules short-circuit on `=== undefined`, and `effectiveDisplayConditionForEmission` folds absent to no wire attribute)" | "(the validator rules short-circuit on `=== undefined`, and `displayConditionForEmission` gives no wire attribute for an absent condition)". The reducers gain one sentence beside it: "`mutations/modules.ts::reconcilePostSubmitWithMenuShape` keeps every form's destination admitted when a module's shape changes, in the five arms that change a fact the admitted set or the default reads (`updateModule`, `setCaseListMeta`, `moveModule`, `moveForm`, `removeFormLink`): an explicit destination that leaves the admitted set moves to the nearest admitted one (`previous` to `module`, else `firstMenu`; `module` and `parentMenu` to `firstMenu`); an absent slot whose effective destination leaves the admitted set stays absent and takes the new default; an absent slot whose destination is still admitted while the default would now be another is pinned to it; and an explicit destination that stays admitted is kept." | 12 |
| `lib/deployment/CLAUDE.md`, "Preflight is a graph with two kinds of edge" | (a) "A **blocking** edge is a real prerequisite: no connection, an app the export boundary refuses, or Project data Nova may not write over." (b) "`project-data` and `organization` are the two edges that TALK to CommCare HQ during preflight, and each appears only when the app carries that thing." | (a) Pull request 4: "A **blocking** edge is a real prerequisite: no connection, an app the export boundary refuses, Project data Nova may not write over, or a change made in CommCare HQ since Nova's last push that the person has not confirmed discarding." Pull request 13 adds to the list: "an HQ app below CommCare 2.57, and a plan feature or project-space setting the app needs that the person has not confirmed (`plan-features`, which asks HQ nothing)". (b) Pull request 3: "`project-data`, `organization` and `target-app` are the three edges that TALK to CommCare HQ during preflight, and each appears only when the app carries that thing: `target-app` whenever `plannedInPlaceUpdate` names an app. It reads the app's source (`lib/commcare/hq/appSource.ts::readHqAppSource`), and is the only edge that does. It is not the publish's only read of it: a first publish reads the source after it creates the empty app, and a publish that pushed a lookup table or a place reads it again before the import." Pull request 4 adds after it: "Each of the three compares what it read with its baseline and collects what changed, and preflight gives one verdict over all of it, `hq_changed`, before any write." Pull request 13 adds: "`target-app` also holds the CommCare version that read carries to the floor (`hq_app_version_below_floor`)." What reads the source beyond this edge is said where each lands: the comparison (4, the sentence above, and the next row's "One publish lifecycle"), and the overlays (5) and the version floor (13), both in this file's row of the new-sentences table | 3, 4, 13 |
| `lib/deployment/CLAUDE.md`, "One publish lifecycle" | (a) "`onUploadStarted` fires once, after every blocking preflight edge passes and before Nova sends CommCare HQ anything at all", with the clause between its dashes, "the lookup tables and the places go first, then the app" (b) "Everything a person could have decided differently is settled by then, both ownership conflicts and the whole organization shape included, so what remains after it is CommCare HQ's own answer." | (a) Pull request 3: "`onUploadStarted` fires once, after every blocking preflight edge passes and before Nova sends CommCare HQ anything at all. On a first publish the empty app is made first, read and recorded (`recordCreatedRemoteApp`, with no pushed revision); then the lookup tables and the places go; then the app's content, as an update. For an app that is already there nothing moves: the tables and places go first and the update follows. A publish that pushed a table or a place reads the app's source again before the update, which is built over that read; where nothing was pushed it is built over the read the publish already holds." Pull request 4 adds after it: "That second read is compared with the one before it (`diffHqAppSource`), and a change in anything Nova writes stops the publish at `upload` with `hq_changed`: it reached CommCare HQ while the Project data went, so no check before the push could hold it. After the update Nova reads the source back, before the media upload, and that read is the new baseline; a read-back that fails records an `unread` baseline and a warning, since the app landed." (b) Kept as it stands in pull request 3, which adds after it: "On a first publish that answer can come before any Project data goes: a create CommCare HQ refuses, or a read after the create that fails, stops the publish at `resources`." Pull request 4 adds: "One stop after it is no answer to a write: a change made in CommCare HQ while the Project data is pushed. That publish offers no discard, and the next one's preflight lists the change and asks." Pull request 13 adds: "A first publish has one more stop preflight cannot hold, the CommCare version of an app HQ has not made yet. It is checked on the read after the create, before any Project data is pushed, so a target below the floor holds nothing of the publish but an empty app." | 3, 4, 13 |
| `lib/deployment/CLAUDE.md`, the HQ adapters paragraph, the workbook upload | "An unknown workbook-upload verdict means data may have landed; only HQ's explicit format-refusal verdict proves that none did." | "An unknown workbook-upload verdict means data may have landed; two answers prove that none did: HQ's explicit format-refusal verdict, and an OK answer that is not JSON, which is the plan page HQ serves before its upload view runs (`upgradeRequired`)." | 14 |
| `lib/deployment/CLAUDE.md`, "Two things the record answers besides publishing" | (a) "`attachmentTarget.ts` names where a capture's case-bound link resolves." (b) "Its `attachmentSpace.ts` read deliberately does NOT swallow a fault the way `previewSpace.ts` does: degrading to "no target" would silently drop a case write from the exported app." | (a) Kept. The paragraph before it, on `readDeploymentPreviewRecords`, says it serves `previewSpace.ts` alone. (b) "`downloadTarget.ts::resolveDownloadTarget` names what a download is made for, over `store.ts::readReachedDeploymentTargets`: for a `.ccz`, the one published project space it signs workers in to, with that deployment's ids, or the refusal that lists the published spaces; for the HQ import file, only where its attachment links resolve. Its read deliberately does NOT swallow a fault the way `previewSpace.ts` does: degrading to "no target" would silently drop a case write from the exported app." `attachmentSpace.ts` is deleted | 3 |
| `lib/db/CLAUDE.md`, the fold horizon paragraph, its opening | "A blueprint-shape migration converts every replayable app change; no runtime reader accepts an alternate stored dialect. Advancing the fold horizon is not a route a future migration can simply take:" | Kept. Pull request 2 adds, after the identities the first table gives: "The `hq-round-trip-emission` horizon starts each app from its transformed document, the other route of the two the contract offers. A reader that folds at a sequence behind an app's greatest fold baseline answers from the current saved app instead. The rule lives once, in `lib/agent/change-set/baseLoader.ts::greatestFoldBaselineSeq`, read by the build orchestrator's finished branch, by `materializeGenesis.ts::readMaterializedGenesisReceipt`, and by the stream route, which answers `reload` without parsing a row behind the baseline." Pull request 15, when the schema holds every removal and every required slot, inserts the reason after that text's first sentence: "The schema it lands with drops keys a strict parse refuses and requires slots no earlier document holds. So no earlier document parses under it, a `blueprint-migration` batch has no source it can load, and a history row that carries a dropped key or installs a parent without its required slot does not replay. A suffix rewrite would rewrite every mutation kind whose payload changes, the immutable baselines and every recorded snapshot digest, so this horizon does not take it." | 2, 15 |
| `components/builder/CLAUDE.md`, the download options | "Download options can select US, India, or EU explicitly. Leaving the choice at Use published destination delegates resolution to the compile boundary and never silently selects US when no unambiguous destination exists." | "A CommCare mobile app file is made for one project space the app is published to. The dialog offers a select of those spaces (`onDownloadCcz` takes `{ server, domain }`): the only one is preselected, several leave the button off until one is chosen, and with none the dialog says why and offers Publish to CommCare HQ in its place. The CommCare HQ app file is always a ZIP (Download ZIP), and its outcome shows the steps of the guide the ZIP holds; its optional server select only scopes attachment links." | 3 |
| `components/builder/CLAUDE.md`, the no-matches form sentences | (a) "only explicit App home and, on scalar hosts, the implicit native return are offered." (b) "Clearing the entry preserves an explicit App home choice." (c) "New registration on a multiple-selection host includes explicit App home in the reviewed batch" | "First menu" where each says "App home": (a) "only explicit First menu (`firstMenu`) and, on scalar hosts, the implicit native return are offered." (b) "Clearing the entry preserves an explicit First menu choice." (c) "New registration on a multiple-selection host includes explicit First menu in the reviewed batch". The review sentence between them, "(explicit App home, or the scalar native return", changes the same way. The after-submit pickers offer exactly `postSubmitDestinationsOffered`, with the labels "App home", "First menu", "This module", "Parent module: <name>" and "Previous screen" | 12 |
| `components/builder/CLAUDE.md`, the Search canvas paragraph | "preserving any authored Search-action label/condition and the independent owner rule" | "preserving any authored Search-action condition and the independent owner rule". The action has no authored label: its button reads "Search All Cases" in every language | 12 |
| `components/builder/CLAUDE.md`, the display-condition section | "every single choice the editor offers is admissible, but "never matches" is a property of the whole tree, so a deliberately composed one is refused BESIDE the rule rather than as a toast over a silently reverted edit." | "every single choice the editor offers is admissible, and the one refused tree, a condition that is or starts with "never", is refused BESIDE the rule, in the sentence that points at the Show on the menu switch, rather than as a toast over a silently reverted edit." The section gains: "A Show on the menu switch sits beside the condition on a module's and a form's settings, on by default (`hiddenFromMenu`). The condition editor stays, labelled "When shown on the menu". With the switch off the section says, per platform, how the item is still reached." | 12 |
| `components/builder/CLAUDE.md`, the bullet "Presentation exists only for a placed cell" | Its second sentence, from "Absent text size is offered as *Same as the list*" to "across the whole tile." The first stays | In part 07's words (Tile cells and finding 42, Files): "Every placed cell states its alignment and its text size: a cell is born `left`, `top` and `medium` (`tileCell()`), and the Text size menu offers Small, Medium and Large and no *Same as the list*, because HQ's Case List save writes `medium` into a cell that holds no size, so an absent size is a state the app cannot keep. Border/shading carry the tile-wide consequence in their own words because the runtime computes one boxed/flow mode across the whole tile." The menu's own copy, in `tile/TileCellInspector.tsx`, is part 07's (the same Files, "Builder") | 11 |
| `components/builder/CLAUDE.md`, the bullet "The tile lays out exactly what Results shows" | Its first sentence after the title, from "A column hidden from Results needs no square whether or not it drives Default order" to "which draws nothing." The last stays | In part 07's words (The corrected tile clause, Files): "A column hidden from Results needs no square whether or not it drives Default order. An ordering one still reaches the wire, as a sort row with no stored column, for which CommCare appends its reserved zero-width carrier, which draws nothing; a calculated one, or one over `case_id`, has no such spelling and the gate refuses it (`CASE_TILE_HIDDEN_CALCULATED_SORT`). The list's search matches a hidden column only through that carrier." | 11 |
| `lib/media/CLAUDE.md`, "Media-OFF / ON emit contract", the HQ upload bullet | From "HQ's match set (`ApplicationMediaMixin.all_media`) deliberately EXCLUDES app-level logos, so a logo image used ONLY as the logo is ALWAYS reported `unmatched`" to "read by both the reconciliation and its proactive twin `uncarriedLogoAsset` (the app-settings warning, before any upload)." | "HQ's match set (`ApplicationMediaMixin.all_media`) leaves app-level logos out, so the logo is left out of the ZIP: `publishAppToHq` hands `buildMediaBulkUploadZip` only the assets some carrier other than the logo references (`lib/domain/mediaRefs.ts::carriesViaBulkUpload`), and an image shared between the logo and a question still uploads. No logo file is ever unmatched, so `uploadOutcome.ts::reportMediaAttach` has no heads-up arm: every unmatched file is a per-carrier failure logged at `error`. Nova sends no `logo_refs`. A logo reaches apps built on CommCare HQ when a person adds it in the app's settings there, which the landed outcome offers as a step with the file to download (`logoStep`), and the app-settings line says so for every logo." `uncarriedLogoAsset` is gone | 13 |
| `lib/media/CLAUDE.md`, the same section, its closing paragraph | (a) "`multimedia_map`, and the logo profile property emit the same way." (b) "empty manifest means the media-on code paths never run, `multimedia_map: {}`, no `media_suite.xml`, no media itext values." | (a) "and the logo profile property emit the same way. Nova sends no `multimedia_map` in any mode: HQ's media upload matches each file to a path the app's content references and writes the map itself." (b) "empty manifest means the media-on code paths never run: no `media_suite.xml`, no media itext values." | 3 |
| `lib/media/CLAUDE.md`, the same section, the JSON export bullet | "a media-ON bundle (app JSON + the same bulk zip) when the app has media; the plain media-OFF JSON otherwise." | Pull request 3, where the import file becomes a ZIP in every case (part 01, A6. The HQ import file as a ZIP with its guide): "a ZIP in every case (`lib/commcare/multimedia/hqJsonExportArchive.ts::buildHqJsonExportArchive`): the app JSON with its guide, media-ON with the same bulk zip beside it when the app has media, media-OFF otherwise." Pull request 13 adds (part 03, C6. Defect 14: logos): "The app JSON carries no `logo_refs`. The bulk zip leaves out a file only the logo uses, by the filter the direct upload uses (`lib/domain/mediaRefs.ts::carriesViaBulkUpload`), and the ZIP holds the logo's file beside it as `logo<ext>`, which the guide names." | 3, 13 |
| `lib/organization/CLAUDE.md`, the bullet "The compiler lowers fixed-place and reverse-hop owner terms" | "so neither a missing identity map nor a missing fixture is a reason to refuse" | "so a missing identity map is no reason to refuse; whether the project space still sends its flat location list to phones is a setting no API reads, which publish asks the person to confirm (`lib/deployment`)", as part 03, C5 gives it | 13 |
| `lib/domain/predicate/CLAUDE.md`, the navigation twin of `simplifyForFilter` | "**`effectiveDisplayConditionForEmission`** is the navigation twin: deep-simplify a module/form display condition and fold an all-true result to no wire attribute. It intentionally retains `match-none`; the validator rejects that as an always-hidden navigation item before emission." | "**`displayConditionForEmission`** is the navigation reader, and it rewrites nothing: it gives no wire attribute for an absent condition or one whose root is `match-all`, and otherwise the condition exactly as stored, so `x and always` prints `x and true()` and the instances declared are the ones the printed text reads. A condition that is `match-none`, or an `and` whose first clause is, is refused by a shape rule (`DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU`), because `hiddenFromMenu` is how an item is kept off the menu." | 12 |
| `lib/domain/predicate/CLAUDE.md`, "Type checker contract" | "Strings are deliberately excluded from `ORDERED_TYPES`" | The bullet is kept, and one follows it: "A time of day is excluded too. Core compares before and after as numbers and a time is not one, so the comparison would never be true, and HQ's query raises on it. `checkComparison` and `checkBetween` give it a code of its own, `time-ordering`, ahead of the ordered-types test; a date and a date and time keep their order." | 14 |
| `lib/preview/CLAUDE.md`, the structural world | "The main `/data` root exposes the same `uiVersion`, `version`, and slugged `name` attributes as the XForm." | Pull request 5: the sentence gains "Preview's `version` stays `1`: a submission's version is each export path's own counter (HQ's form version on an HQ build, the app's sequence in a local archive), the client engine also runs documents with unsaved edits, which have no sequence, and a stored app test would change with every unrelated edit." Pull request 6: "The main `/data` root exposes the same `uiVersion`, `version`, and `name` attributes as the XForm; `name` is the form's name in the default language (`lib/domain/formWireName.ts::formWireName`)." | 5, 6 |
| `lib/preview/CLAUDE.md`, the scalar slots paragraph | "Both use the shared Java `String.trim` boundary (only U+0000 through U+0020) and the 255 UTF-16-unit limit." | Kept, and followed by: "The form engine refuses a blank or over-long case name, and an over-long external id, at the question a worker answers, reading `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`, as a device refuses it from that question's own constraint; a Hidden Value source takes no such check." | 9 |
| `lib/preview/CLAUDE.md`, the no-matches return | "An explicitly authored `postSubmit: "app_home"` on a no-matches registration returns to App home and retires that search/form/parent request, matching HQ's empty root frame." | "An explicitly authored `postSubmit: "firstMenu"` on a no-matches registration returns to the home screen and retires that search/form/parent request, matching HQ's empty root frame." The section gains: "`firstMenu` and `app_home` resolve to the one home screen, which is what Web Apps does: Preview does not yet play each platform apart. `parentMenu` opens the parent module with its selections kept." | 12 |
| `lib/export/CLAUDE.md`, the compatibility report and the local archive | (a) "After the boundary passes, JSON/CCZ callers derive a targetless `not_checked` report from the same exact document and attach it without changing artifact bytes." (b) "is assembled by `lib/export/localArchive.ts::compileLocalArchive` from a `ccz`-mode prepared export; change what an archive holds there." | (a) "After the boundary passes, JSON/CCZ callers derive a `not_checked` report from the same exact document and attach it without changing artifact bytes: a download checks no project space, also where a `.ccz` is made for one." (b) "is assembled by `lib/export/localArchive.ts::compileLocalArchive` from a `ccz`-mode prepared export and the one published project space the archive is made for (`compileLocalArchive(prepared, runtimeTarget)`, the target required), so no archive is compiled without one; change what an archive holds there." | 3 |
| `lib/export/CLAUDE.md`, the mode-split carriers | "take CommCare HQ's whole-workbook row ceiling (`LOOKUP_HQ_PUSH_TOO_LARGE`) plus `LOOKUP_TAG_TOO_LONG_FOR_HQ`, which refuses a tag no data sheet could be named for BEFORE the workbook is built, so the builder stays a total function." | "take CommCare HQ's whole-workbook row ceiling (`LOOKUP_HQ_PUSH_TOO_LARGE`), their one size verdict. A 32-character tag pushes, so the workbook builder is total over every tag the schema admits." `LOOKUP_TAG_TOO_LONG_FOR_HQ` is gone | 14 |
| `docs/architecture/contracts.md`, the paragraph on a saved case-list column | "Only preview, CommCare compilation, and emitted-reference walks consult the one `caseListColumnIsEmitted` predicate." | "Only preview, CommCare compilation, and emitted-reference walks consult the two predicates that say a column reaches a runtime: `caseListColumnRuns`, a runtime evaluates its value, and `caseListColumnTextShows`, its header, labels or images reach a screen." | 11 |
| `docs/architecture/multilingual-localization.md`, the bullet that opens "Suite app strings become a complete table per language" | (a) "Hidden Results sort carriers retain their positional calculation join but strip unused translated-enum expressions and variables that HQ's final Invisible formatter cannot declare." (b) "HQ enum variables use fixed-width, prefix-free indices because HQ discovers them through ordered substring replacement." | In part 07's words (Hidden columns, Files). (a) "In a list with no case tile, a column hidden from Results is HQ's `invisible` column on both paths: the raw property, with no label expression and no enum variables, under an empty header that has no locale id and no app string. An order rule on it is a sort element over the property name. Only a hidden calculated column, and a hidden column over `case_id`, `owner_id` or `status`, keeps its expression and the positional join. In a tile list a hidden column is no field, and its order rule is a sort element with no stored column. A sort element's `display` holds one key, the first language's wire code, with empty text." (b) "A `translatable-enum` column's variables, a select's labels and an interval's text, use fixed-width, prefix-free indices because HQ discovers them through ordered substring replacement. An ID mapping is HQ's `enum`, whose variables HQ names from each entry's value." | 11 |
| `docs/architecture/complex-apps.md`, the `build_spec` paragraph | From "`hqShells.ts::applicationShell` emits one fixed `build_spec.version` (`2.54.0`) as part of Nova's single application-shell target." to "`ApplicationBase.wrap` substitutes the target domain's default." | "Nova writes no `build_spec`: HQ ignores the one a create or an update carries, gives a new app the project space's default CommCare version, and never changes it on an update. Publish reads the target's `build_spec.version` from the app's source and stops below 2.57 (`lib/commcare/versionFloor.ts`), saying how to raise it in CommCare HQ. A local `.ccz` states the same floor in its profile (`requiredMajor`, `requiredMinor`)." The same replacement as `lib/commcare/CLAUDE.md`'s `build_spec` row in the first table | 13 |
| `docs/architecture/complex-apps.md`, lookup export, the sentence before the size verdicts | "which the direct upload pushes to the project space before the app and the manual artifact ships beside the app JSON." | "which the direct upload pushes to the project space before the app's content and the manual artifact ships beside the app JSON." A first publish makes the empty app before the workbook goes | 3 |
| Root `CLAUDE.md`, the `lib/lookup` entry | "pushed before the app on a direct upload, shipped beside the app JSON for a manual import." | "pushed before the app's content on a direct upload, shipped beside the app JSON for a manual import." | 3 |
| `proof/README.md`, "Claims held outside a document's checks", the logo row | The row whose first cell is "The logo Nova sends (`logo_refs.hq_logo_web_apps`)" and whose second is "the app's tile shows HQ's own URL for the mapped file, and HQ serves Nova's bytes there; without one, the client's own image" | First cell: "The app's logo in Web Apps". Second: "the tile of an app Nova publishes shows the client's own icon and asks HQ for no image; after HQ's own uploader stores `hq_logo_web_apps` it shows HQ's URL for the uploaded file, served; a path-only entry written into the stored app shows HQ's URL for the mapped file". The third stays `test_app_list.py`, which pull request 13 rewrites (part 03, C6. Defect 14: logos, "Lane") | 13 |
| `proof/README.md`, "Claims held outside a document's checks", four rows the table gains | No row: the table holds no claim about a publish Nova stops | Pull request 4 adds two rows, each three cells. "The drift verdict on a live target", held by `proof/corpus/__tests__/publish.postgres.test.ts`, showing: "Nova's own publish, over a peer that serves HQ's retained reads, stops before any write when the app, a table or a place changed since its last push, lists every change, and lands only after the discard a person confirmed". "The drift comparison", held by `proof/hq/test_retained_reads.py` and `proof/editors/test_retained_reads.py` with `lib/deployment/__tests__/hqSourceBaseline.test.ts` and `hqResourceBaseline.test.ts`, showing: "HQ writes every answer under `proof/hq-reads/` again on each run and the committed copy is held to it byte for byte; Nova's production comparison over those files calls two reads of an unchanged app equal and names the part each of HQ's own saves changed". Pull request 13 adds two. "The version floor", held by `lib/deployment/__tests__/publishGates.postgres.test.ts`, `proof/hq/test_version_floor.py`, `proof/editors/test_version_raise.py` and `proof/android/predicates.py`, showing: "Nova publishes to no app below CommCare 2.57; HQ serves a new app's version from the project space's default and builds differently on each side of the floor; HQ's settings page changes these paths of the app's source when the version is raised there; a device neither installs nor updates to an archive that requires a newer CommCare". "The confirmations a publish asks for", held by the same Postgres test and `proof/checks/test_corpus.py`, showing: "Nova's publish stops until a person confirms each plan feature and project-space setting the app needs; the list Nova derives for every corpus document equals the one `proof/checks/configurations.py::required_privileges` derives from HQ's own model of the exported app" | 4, 13 |
| `proof/README.md`, "How the harness proves itself", the retained reads | No row: the lane retains no read of HQ's today | Pull request 3 adds the row, three cells: "The reads Nova is proven over are HQ's own answers"; "an answer a person wrote, or a pin move that changes an answer unseen"; "`proof/hq/test_retained_reads.py`: every file under `proof/hq-reads/` is written again on each run, each read made through HQ's own URLconf, API-key authentication, permission and privilege checks and rate limiter, the limiter over counters the lane answers (within limits, and as Redis does for the 429 answers), and held to the committed copy byte for byte (its `publish` group, and its `cutover` group over the legacy bodies in `proof/hq-reads/cutover/`)". Pull request 4 adds the drift groups and `proof/editors/test_retained_reads.py` to the third cell. Pull request 16 takes the `cutover` clause out with the group. "Changing a pin" gains, in pull request 3, that a pin move regenerates `proof/hq-reads/` and the diff is reviewed (part 09, The retained HQ reads for the drift comparator; part 10, Block: the cutover, Files) | 3, 4, 16 |
| `proof/CLAUDE.md`, the opening paragraph | "`proof/README.md` says what it proves, how to run it and read a failure, how to add a document, a targeted document, a spelling rule, a register entry and its control, and how a pin changes." | "`proof/README.md` says what it proves, how to run it and read a failure, how to add a document, a targeted document, a spelling rule, a register entry and its control, how a fixed defect's control keeps running, and how a pin changes." | 1 |
| `proof/CLAUDE.md`, "A walk reaches its end or a held stop" | "`walk-stops.json` holds every stop by its document, reader and cause, strict both ways as the register is (`proof/README.md`, "Walk stops")." | "`walk-stops.json` holds every stop by its document or its control, reader and cause, strict both ways as the register is (`proof/README.md`, "Walk stops")." And, after it, part 09's sentence: "A fix that takes a stop off its document moves the stop's entry to the control that still shows it, or removes it where none does, in the same pull request; an entry is never left naming a document the corpus does not hold." | 1 |
| `proof/CLAUDE.md`, a new rule, after the determinism rule | No such rule | Part 09's sentence (What the two documents say when step 2 ships): "The capture moves with publish. A change to what `publishAppToHq` reads or sends changes `proof/corpus/publish.ts` in the same pull request, the peer answers a read only with what the HQ side then holds to HQ's own view, and retained controls replay the layout they were captured in." Pull request 3 is the first that changes what a publish reads and sends, and it adds the layout marker a retained control replays under | 3 |
| `proof/CLAUDE.md`, the paragraph on a device's network | "Nova's local archive names no server (finding 59), so its device meets Android's own defaults, and a second device on it, and the device updated from one local export to the other, are given the input the lane gives Core over that archive" | "A local archive names its configuration's project space, so its device reaches HQ at the addresses the archive names. A control retained before the archive named one holds an archive that names no server (finding 59), so its device meets Android's own defaults, and a second device on it, and the device updated from one local export to the other, are given the input the lane gives Core over that archive". The rest of the sentence is kept (part 01, A7. The proof capture) | 3 |

Sentences that are new, not rewrites, each in the pull request that builds the thing. A sentence in quotation marks is the text; the rest names what the paragraph holds, whose wording is the part's:

| File | Gains | PR |
|---|---|---|
| `docs/architecture/contracts.md` | Pull request 2, in "Direct maintenance cutover", part 10's two sentences, which stay after the tooling is removed. After "Its advisory production scan runs first.": "An advisory scan writes nothing, also when it reads an external system with a member's stored credential inside the migration Job; the migration itself records each credential it uses." After "The exact new image then deploys and proves it can read the shape before writers and ingress resume.": "A writer that the deploy's own prerequisite check requires enabled, and whose database authority holds nothing of the changed shape, resumes before the deploy." Pull request 4, the drift rule: every drift decision a person can answer is made in preflight, before any write; the one later stop is a change that reaches HQ while the Project data is pushed, which stops that publish at `upload` and is asked about by the next publish's preflight; one refusal lists every change; a discard is bound to the digest the person saw. Pull request 11: the tile list's search gap, stated as what Nova does not yet do: a tile list's search does not match a column hidden from Results that has no order rule, and matches one that has a rule through its carrier (part 07, The corrected tile clause) | 2, 4, 11 |
| `lib/commcare/CLAUDE.md`, "CommCare HQ upload" | A paragraph on the import file: "The HQ import file is always a ZIP (`multimedia/hqJsonExportArchive.ts::buildHqJsonExportArchive`): the app's JSON, `README.txt`, `lookup-tables.xlsx` where the app reads lookup tables and `multimedia.zip` where it has media. The README is rendered from a pure derived guide, `lib/publish/manualImportGuide.ts`, whose steps are each present only when they apply: the lookup tables first, so the app finds its data when HQ builds it, then the import, the CommCare version to check, the media and the capabilities the project space needs. It names capabilities, never HQ flag names. The file carries derived ids and no runtime URL, and a person who imports it makes a create that carries forms, so its form ids are HQ's and its menu ids and every `xmlns` are Nova's." Pull request 13 makes two changes to it (part 03, C2, C5, C6 and C8). The list of what the ZIP holds ends: "`multimedia.zip` where it has media, and the logo's file as `logo<ext>` where the app has a logo." The list of steps ends: "the media, the capabilities the project space needs, the plan features, the logo, the flat location list and Connect forwarding." | 3, 13 |
| `lib/commcare/CLAUDE.md`, the local profile, beside "Runtime request destinations" | A paragraph: "A local `.ccz` names something stable. Its profile's `uniqueid` is the app's id (`doc.appId`). `version`, `cc-content-version`, `cc-app-version`, the suite, every form resource and every locale resource take the app's sequence (`apps.mutation_seq`), and each form's data node takes it as `version` (`xform/formVersion.ts::setFormVersion`); media resources keep `1`. The profile requires CommCare 2.57 (`requiredMajor`, `requiredMinor` from `versionFloor.ts::COMMCARE_VERSION_FLOOR`, `requiredMinimal="0"`). `cur_locale` is the first language's wire code, `force="false"`. `<features>` opens with `<checkoff active="true"/>`, without which a device hides its saved forms whatever the setting says. The seventeen settings of `appProfileSettings.ts::appProfileProperties` follow in its order, each with the `force` its table gives. The archive writes neither `heartbeat-url` nor HQ's six other server properties: a `.ccz` is no HQ build, and a phone on one takes a newer download through CommCare's update from a file." | 5 |
| `lib/commcare/CLAUDE.md`, "Form `<meta>` block" | "For a Connect app the local block also captures location, as HQ's build does (`metaBlock.ts::addMetaBlock(xform, { captureLocation })`, with `captureLocation` the condition `expandDoc` uses for HQ's `auto_gps_capture`): `<cc:location/>` is the last child of `<orx:meta>`, after `<orx:drift/>`, and the model's last two children are `<orx:pollsensor event="xforms-ready" ref="/data/meta/location"/>` and `<bind nodeset="/data/meta/location" type="geopoint"/>`. A model holds one `pollsensor` or none, as `xform.py::XForm._add_meta_2` writes it." | 5 |
| `lib/commcare/CLAUDE.md`, "Case-list emission" | Pull request 5, the texts HQ's build writes: "Every short detail of the local suite, the search target's included, carries `<select_text>` (`m<N>_select_text=Continue`), written after the fields and the action; every form has `forms.m<N>f<M>.submit_label=Submit` in every language; every image-map field carries `<alt_text>` as its last child, built as HQ's `EnumImage.alt_text` builds it. `<no_items_text>` (`List is empty.`) is written exactly where HQ's build writes it, which is where the target's flag is on: every publish reads that flag, stores it as `app_deployments.target_empty_case_list_text`, and a `.ccz` made for that deployment reads it. The texts are one constant each (`suite/case-list/detailTexts.ts::SELECT_TEXT`, `EMPTY_CASE_LIST_TEXT`, `suite/formStrings.ts::FORM_SUBMIT_LABEL`)." Pull request 11: "An image-map field with media on writes `width="13%"` on its header and template, and a hidden one `0`. HQ's build writes a date column's pattern between straight apostrophes as it stands, so a pattern holding one breaks the suite HQ builds, and the validator refuses it (`CASE_LIST_DATE_PATTERN_APOSTROPHE`). The local suite quotes the pattern. A column over `case_id`, `owner_id` or `status` (`lib/domain/standardCaseProperties.ts::ATTRIBUTE_BACKED_COLUMN_PROPERTIES`) is an expression column whose field is `@<name>`: HQ's property map has no entry for `case_id`, so a property column over it is blank on HQ's build, and HQ's Case List page refuses to save a property field spelled with `@`. The HQ JSON writes `no_items_text` as "List is empty." for every app language on every menu's short detail, and a search's `description` and `title_label` for every app language, blank where none is authored; the local suite always writes `<description>`." | 5, 11 |
| `lib/commcare/CLAUDE.md`, "Authored case-operation emission" | The allocator and what HQ's form builder imposes: "`xform/generatedNodes.ts::planGeneratedNodes(doc, formUuid, connectIds)` names every node Nova adds to a form's source, by purpose and owner identity and never by path. A base name is `nova_`, the purpose and the owner's id, or the container's fixed name; each parent element is one namespace, and a `nova_operations` group is one namespace with everything nested in it, so adding or removing a condition never renames a node; a base an authored sibling, a Connect block id or an earlier allocation holds takes `_<n>` for the smallest free `n` from 1. Nova refuses no authored name for being one of its own, because each is a name CommCare HQ's form builder takes for a question; the cost is that a generated node's HQ export column moves to the suffixed path when an author adds such a question. Two rules of the builder's parser shape the body. A parent's controls name its data children in the same relative order, and data-only children may sit anywhere between them: one control out of order makes the builder rebuild the parent with every data-only child last, which moves case blocks, and Core applies case blocks in document order. Each control sits inside its data parent's control. So the root `nova_operations` control is the first child of `<h:body>`, a repeat's follows its authored controls, each `nova_condition_` and `nova_keyed_` control sits inside its `nova_operations` control, no Save to Case block and no Hidden Value has a control, and setvalues are written in data-tree order." And the Save to Case facts the emitter follows, each kept by two saves in the form builder: "The plugin loads only under the `save_to_case` plan privilege. No block carries a bind on its own node. `relevant` on `<block>/case` is used only on a block that creates. An update-only block has at least one property row. No row carries `type` or `constraint`, and only `@date_modified` is typed. Children of `<case>` are written `create`, `update`, `close`, `index`, with the case namespace as the default namespace and no prefix. A create outside a repeat carries its id as an `xforms-ready` setvalue and one inside a repeat as a bind. Every `<index>` child carries `case_type` and `relationship`." Pull request 13, where publish first asks, ends the first of those sentences: "The plugin loads only under the `save_to_case` plan privilege, which publish asks the person to confirm." | 7, 13 |
| `lib/commcare/CLAUDE.md`, a "Case references" paragraph beside the `load` vocabulary | "`case_references_data.save` is derived from the constructed form, never assembled beside it: `xform/caseSaveReferences.ts::caseSaveReferences(root)` walks the tree before serialization and gives one entry per element carrying `vellum:role="SaveToCase"`, keyed by its absolute data path, repeat and iteration steps as plain steps. An entry holds `doc_type: "CaseSaveReference"`, the block's `case_type`, whether it creates and closes, and its `properties`: the create rows, then the update rows, in bind order, then `case_type`, `case_name` and `owner_id` where the block binds them; an update-only block lists its update rows, so a guard lists `case_type`. It is the map HQ's form builder computes on a save (`logic.js::LogicManager.caseReferences`), so a save changes nothing, and HQ learns the properties at publish: its case-property inventory and data dictionary list what the blocks write. HQ's build refuses a `create` entry that lacks `case_type` or `case_name`. An attachment is never listed." | 8 |
| `lib/commcare/CLAUDE.md`, a "CommCare Connect" paragraph | Pull request 10: "A Connect block's wrapper is named by the block's id, which follows the question-id grammar and is never one of the five names Connect's receiver searches a submission for at every depth (`assessment`, `deliver`, `module`, `task`, `work_area_update`, `lib/domain/questionId.ts::RESERVED_CONNECT_BLOCK_IDS`): a wrapper so named has no namespace where the receiver reads one, so Connect answers 500 for every submission of the form. A deliver form holds a deliver unit or a task, never both: Connect checks the delivery before it completes a task, so a form holding both has its own visit turned away while the task is assigned." Pull request 13 adds: "A Connect app's forms reach Connect only through CommCare HQ's data forwarding, which needs the Data Forwarding plan feature and a forwarder set up in the project space. No API key reads either, so publish asks the person to confirm both (`lib/deployment`)." | 10, 13 |
| `lib/commcare/CLAUDE.md`, the case-search sections | "Every search button reads `lib/domain/modules.ts::CASE_SEARCH_BUTTON_LABEL` ("Search All Cases") in every language, on both export paths and in Preview: HQ's Case List save keeps no other label, and the document holds none. A lookup-backed search input's `<sort ref>` is its `sortColumnId`, or its label column where none is set. `suite/case-search/reservedInputNames.ts::RESERVED_SEARCH_INPUT_NAMES` holds the sixteen names HQ's search request keeps for itself, and `RESERVED_SEARCH_INPUT_NAME_PREFIXES` the `indices.` prefix; `isReservedSearchInputName` tests a name against both, and a search input and a default filter may use none of them. A menu uploads its own case type, a survey-only menu's included, and `formLinkProjection.ts::moduleCaseTypeForActions` gates only what is built from the type. Four spellings are HQ's own and Nova writes them: no `no_vellum`, no `custom_variables`, a calculated column as `format: "plain"`, and one `name` column on a short list that holds none." | 12 |
| `lib/commcare/CLAUDE.md`, project-space compatibility | "`planPrivileges.ts::requiredPlanPrivileges` derives, from the document and what the publish pushes, the plan features the content needs (`user_case`, `lookup_tables`, `child_cases`, `form_link_workflow`, `save_to_case`, `locations`, `data_forwarding`), each with the sentences that say why this app needs it. HQ's slugs stay inside `lib/commcare`; `lib/publish/planFeatures.ts` holds what a person reads. No API key reads a plan, so these are confirmed by the person, never probed, and a lane test holds `planPrivilegePlans.json` to HQ's own plan lists." | 13 |
| `lib/commcare/CLAUDE.md`, the media sections | "A field carries media on its label and its help text. A hint, a validation message and a group's or repeat's label carry none, because no CommCare runtime shows media there, so a protected validation message has no `__nova_mode;image`, `;audio`, `;video` or `;video-inline` form." | 14 |
| `lib/domain/CLAUDE.md` | Pull request 5: "`appSettings` is a required root object, `{ showSavedForms, showIncompleteForms }`, both off in a new app: whether workers see their saved forms, on the Android home screen, and their incomplete forms, on Android and in Web Apps. `setAppSettings` patches it. The fifteen other profile settings Nova states are constants of the emitter (`lib/commcare/appProfileSettings.ts`) and not yet slots of the document." Pull request 6: "`translationFill.ts::filledProse` is the fill a worker reads, which is the one HQ's form builder applies on a save: a blank itext value takes the default language's text, then the first non-blank value in language order, and stays blank only where every language is blank. Preview and the emitter read it; every editor keeps showing the stored value." Pull request 9: "`closeCondition.ts::closeConditionPlacement` derives where a close is written, `form-action` or `save-to-case`, and stores nothing: placement is derived on every read and is not yet a property an author holds." Pull request 10: "`questionId.ts` is the one question-id grammar: `QUESTION_ID_PATTERN` (a letter first, then letters, digits and underscores, never starting `XML`), `RESERVED_QUESTION_IDS`, `RESERVED_CONNECT_BLOCK_IDS`, and `editorSafeQuestionId`, the one normalizer every minter and every refusal's offered replacement use." Pull request 11: "`caseListOrder.ts::caseListOrderPlan` is the one statement of a list's order, read by both emitters, Preview and the validator. A date column's pattern is any pattern Core formats; the validator refuses one that holds a straight apostrophe (`CASE_LIST_DATE_PATTERN_APOSTROPHE`)." Pull request 12: "`modules.ts::CASE_SEARCH_BUTTON_LABEL` is the search button's one text, a display constant like the search screen's default title. A lookup-backed search input may name a `sortColumnId`." Pull request 14: "A field's media slots are `label` and `help`." | 5, 6, 9, 10, 11, 12, 14 |
| `docs/architecture/multilingual-localization.md` | Pull request 3: `localization.wireCodes` as part of the localization root (the rewrite of the `planLanguageWire` sentence is in the first table). Pull request 6, where missing translations are described: "A blank translation of a form's label, hint, help text, validation message or option label shows the default language's text, and where that is blank the first language that has one. This is the fill CommCare HQ's form builder applies on every save, so Nova writes it and a save changes nothing. A label blank in every language is written with no label at all, and a written choice blank in every language with no media is refused." | 3, 6 |
| `lib/doc/CLAUDE.md` | Pull request 5: "`setAppSettings { settings }` patches the app's settings; `settings` is a strict partial with at least one key." | 5 |
| `lib/db/CLAUDE.md` | Pull request 2: the four ledger tables and the three notice tables with their runtime privileges, the key-reader rows among them (written only by the cutover's execute run, one per member, server and project space whose HQ key it sent, a refused key included); that the future whole-tenant deletion lifecycle must list `project_space_resource_baselines`. Pull request 5: "`apps.app_settings` is a root column holding the document's `appSettings` object. The DDL leaves it nullable, and every row holds an object: genesis writes it, a `NULL` fails the strict parse, and `nova_current_app_change_fold_snapshot` projects it." | 2, 5 |
| `lib/deployment/CLAUDE.md` | Pull request 3: "Identities": a menu's and a form's HQ id is its UUID with the hyphens removed and a form's `xmlns` follows from its UUID (`lib/commcare/wireIdentity.ts`); `app_deployment_identities` holds only the ids a target holds that differ. The runtime role reads it (`readDeploymentIdentityOverrides`) and cannot write it; every row belongs to a deployment first published before ids were derived. Pull request 4: baselines, holding no form ids; the shell's exemption (while a baseline's origin is `create`, the app comparison reads only `modules`, so a menu added in HQ stops with `hq_changed` and any other change to the shell, raising its CommCare version among them, does not; a failed read after the create records origin `unread`, which stops); and a section "What the check cannot close": "HQ's import takes no expected version, so two windows stay open, each one round trip wide. What a save made in HQ inside one meets follows from the import's own rule: HQ replaces every key the body carries, whole, and keeps every key the body leaves out. Between Nova's last source read and its import, a save under a key the body carries is written over: what Nova owns takes Nova's value, and the part an overlay carries for the target goes back to what the read held. A save under a key the body leaves out stays; where it changed a value Nova owns, that value enters the new baseline and the next publish writes Nova's over it with no stop. Between the import and the read-back, a save becomes part of the baseline, so the next publish's check sees no change; that publish writes over the save where its body carries Nova's value for what was saved, and keeps it where an overlay carries the target's part or the body leaves the key out. Nothing reports either: the read-back is compared with no earlier read, and the next check compares its own read with the baseline that read-back stored. A crash between the import and `recordRemoteResource` leaves HQ updated and the baseline old, and the next publish stops with `hq_changed` over Nova's own push, in copy that does not claim a person made the change. A table's description and indexed-field flags are invisible to the check. A change to a shell other than a menu is not seen. A baseline whose origin is `cutover` holds whatever HQ held when it was recorded, edits made in HQ before then included, so the first publish over it writes over them."; and in "Ownership, and why superseded rows are kept": "No baseline row is deleted when its resource is superseded. A publish reads a baseline only through the HQ resource it is about to write, so a superseded one is never read again, and a delete that asked whether another app still names the id would race that app's writer. A discard of changes made in CommCare HQ is recorded as an adoption is, with who and when." Pull request 5, in part 04's words (Shared: the overlays' read and one overlay module, "Which read"): "`hqImportApplication` projects `profile`, `translations` and `add_ons` on the publish's last read of the app's source before the import: the `target-app` read, the read after the shell create on a first publish, or the second read where this publish pushed a table or a place. The drift check compares Nova's part of the three keys, and nothing of them while the baseline's origin is `create`. The overlays carry the rest, the target's own, from that read, the same whether a comparison passed, none ran, or a person chose to publish over what CommCare HQ held. A save in CommCare HQ after that read meets the body as it was built: a key the body carries is replaced whole, with the target's part as the read held it, and a key the body leaves out keeps what HQ holds. Every publish also reads whether the target writes an empty-list text and stores the answer as `app_deployments.target_empty_case_list_text` with the `uploaded` fold; a read that fails leaves the column as it was." Pull request 13, in part 04's words: "The version floor reads the publish's first read of the source, the `target-app` read or the read after the shell create, and never the second read." Pull request 13 also: the `plan-features` edge; the confirmation ledger and its three kinds (a plan feature, the flat location list, a Connect forwarder), which mirrors adoption: a confirmation is a person's statement about the target, stored per deployment, shown with its reasons and withdrawable; "A project space the connected account has left is the `not-a-member` issue, and it stops every publish. The route to that state is a stored project-space list that outlived the membership."; the logo step and its column (`app_deployments.offered_logo_content_hash`, a content hash because a Project move remaps asset ids) | 3, 4, 5, 13 |
| `lib/case-store/CLAUDE.md` | A `followup` or `close` submission of one selected case that writes no property, name or external id stamps the case's `modified_on` (`lib/case-store/postgres/submissionEnvelope.ts::applyOrdinaryAction`), as HQ's processing of the touch block does; a several-case submission is not stamped | 9 |
| `lib/case-store/sql/CLAUDE.md` | "A `SortKey` carries its direction and its blanks placement, and an expression key its comparator. Text compares lowercased by code point with a missing property as `""`; integer and decimal read a value as a number only where its trimmed text is one, and put what is no number after every number ascending; the integer comparator truncates toward zero, and a value below zero that truncates to zero sorts just before zero; a leading key puts blanks first or last as the rule says, whatever the direction. `compileIntervalText.ts` is the one sort key that is no `ValueExpression`: an interval column's shown text, with its guard before any cast so a malformed stored value never fails the query." | 11 |
| `lib/preview/CLAUDE.md` | Pull request 11: "Preview orders a list from `lib/preview/engine/caseListOrder.ts::previewCaseListOrderPlan`, which is `caseListOrderPlan` with media on and identity lookup naming, and its quick filter matches every hidden field's text and every carrier's raw value. It differs from a device in five ways: a multi select's labels order by known labels in catalog order and then the raw value, where a device also appends tokens outside the catalog; a mapping over a text property holding several tokens matches the whole value, where a device matches a token; text compares by code point, where Core compares by UTF-16 code unit; rows that tie on every rule come in case id order; and a number written with an exponent, a leading `+` or a bare `.5` is no number." Pull request 12: "A menu or form that is off the menu is left off Preview's lists without evaluating its condition, and a hidden parent hides its child menus. After-submit routing opens a link's target whatever its visibility, which is Android's behavior; a form's entry point opens a hidden form only with `ignoreDisplayConditions`, which is Web Apps'." | 11, 12 |
| `lib/lookup/CLAUDE.md` | "A lookup-backed search input's `options.sortColumnId` is one more occurrence a table or column deletion sees, beside its value and label columns." | 12 |
| `lib/commcare/xpath/CLAUDE.md` | "An absolute path names a field of the form. The root alone, `/data`, names none and is refused under `INVALID_REF` (`lib/preview/xpath/dependencies.ts::formRootReadPositions`): HQ's form builder shows it as an unknown question." | 10 |
| `lib/media/CLAUDE.md` | "A field's media slots are `label` (every visible field but a group or repeat) and `help` (input fields)." | 14 |
| `components/builder/CLAUDE.md` | Pull request 2: the notice chip in the header band. Pull request 4: "`RemoteChangeChoice` stands beside `ResourceConflictChoice` in `PublishDialog.tsx`: where a publish stops on `hq_changed` it lists every change made in CommCare HQ since Nova's last push and offers to discard them, bound to the digest of the list the person saw. `publishOutcome` carries `remoteChanges` and, on the landed arm, `appPreviewNote`." Pull request 5, beside the paragraph on the data-sources row: "The App Settings panel carries a **saved and incomplete forms** section (`appSettings/AppSavedFormsSection.tsx`): two switches, each reading the document through `useAppSettings` and committing `setAppSettings` with the one key it changes, so a stale editor never writes over a peer's change to the other. The section holds no state of its own, so the reducer is its state model." | 2, 4, 5 |
| `lib/mcp/tools/getApp.ts`, the header comment | Today it reads "Authorized app overview. Detailed content is available through scoped reads." It becomes: "Authorized app overview, with the app's migration notices the caller has not dismissed (`notices`). Detailed content is available through scoped reads." | 2 |
| `lib/mcp/tools/dismissAppNotice.ts` (new), the header comment, in the form `deleteApp.ts`'s has | "`nova.dismiss_app_notice`: dismiss one migration notice of an app for the caller alone.", then "Scope: `nova.write`.", then "Resolves `view` on the app, so a viewer can dismiss. Other members keep seeing the notice until they dismiss it themselves." | 2 |
| `lib/collab/CLAUDE.md`, the opening section | After "`blueprint-migration`, `fold-baseline`, and `project-move` are durable server-side change kinds that force reauthorization and a whole-app reload.": "The stream route reads an app's greatest fold baseline above a subscriber's cursor before it parses any suffix row, and answers `reload` without parsing a row behind it, so a cursor below a horizon never meets a row of an earlier dialect." | 2 |
| `docs/architecture/deployment.md`, "Historical repairs", the Job's paragraph | Pull request 2 adds it as its own paragraph, after the one that ends "Historical schema migrations are immutable.": "The HQ round-trip emission cutover runs through its own Job, `commcare-nova-hq-round-trip-cutover`, from the same maintenance image. Its stored arguments are the dry run, which writes nothing. `--prove-decrypt`, `--settle-holders`, `--rehearse` and `--execute --expect-plan-digest <digest>` are its only allowlisted overrides, the last two also with `--transient-as-unreadable`, and `--without-hq` is refused. It is the one Job that decrypts a member's stored CommCare HQ key, under a grant on that key which the operator makes for one run and revokes after it. Its runbook is `docs/plans/hq-round-trip/2-cutover-runbook.md`; the Job, the runbook and this paragraph are removed together once the cutover has run." Pull request 16 removes the paragraph whole, and nothing of it outlives the tooling (part 10, Block: the cutover, Files) | 2, 16 |
| `docs/architecture/deployment.md`, "Historical repairs", the evidence archive | Directly after "Archive completed Job definitions, execution evidence, and immutable image references before deleting obsolete Jobs.", and kept after pull request 16: "The archive of a direct maintenance cutover is the private bucket `gs://commcare-nova-cutover-evidence`, one prefix per cutover. It has no lifecycle rule and nothing is deleted from it: it holds content-free reports, IAM policy reads and Job definitions, and its list of the member keys each run sent is the one record of a run that writes no row. It names members by user id, so the future whole-tenant deletion lifecycle must list it." (part 10, Deploy order and the operator runbook) | 2 |
| `scripts/README.md`, the cutover's entry | Pull request 2 adds an entry of its own. Its heading: "HQ round-trip emission cutover". Its sentence: "A one-off scan and migrate pair. Production writes run only through the Job `commcare-nova-hq-round-trip-cutover`, by `docs/plans/hq-round-trip/2-cutover-runbook.md`." Its commands, one a line: `npx tsx --conditions=react-server scripts/scan-hq-round-trip-cutover.ts`; the same with `--prod`; with `--app <appId> --debug-details`; with `--prod --recipients`; `NOVA_DB_WORKLOAD=migration npx tsx --conditions=react-server scripts/migrate-hq-round-trip-cutover.ts --rehearse --without-hq`; and that script with `--execute --expect-plan-digest <digest> --without-hq`. Pull request 16 removes the entry whole (part 10, Scripts and their layout) | 2, 16 |
| `lib/agent/CLAUDE.md`, after "Prompt, model, toolset, and context versions control checkpoint compatibility." | The rule of checklist item 13, which outlives the plan: "`lib/models.ts::MODEL_CONTEXT_VERSION` moves in every pull request that changes the name, the description or the input schema of a tool the Solutions Architect is offered, or the authoring guide (`lib/agent/authoring/reference.ts`), because a stored model context is replayed only under the catalog it was made against. A tool only MCP serves is in no stored model context and does not move it, and neither does a field added to a shared read tool's result with no change to the tool's name, description or input." | 15 |
| Root `CLAUDE.md`, the paragraph on `npm run test:schema`, after "Ask before running it." | The rule of checklist item 14, which outlives the plan: "A tool the Solutions Architect is given is registered in `scripts/test-schema.ts` by the pull request that adds it or first changes its description or its projected JSON Schema, and `npm run test:schema -- <name>` sends that one entry. A refinement and a refusal's message are no keyword of a JSON Schema, so a change to one sends the provider nothing new. A tool only MCP serves is never sent: `lib/mcp/__tests__/servedSchemas.test.ts` holds what a client receives, without billing." | 15 |

When this plan leaves `docs/plans/` (pull request 16), nothing in it is needed that the files above, and the files "Edits to the other plans and the research" names, do not then hold. That section gives the edits pull request 16 itself makes to the three plan files that cite this plan. The model-addition checklist leaves with the plan: every place it lists is in the code, and a later step's plan lists them again as the code then stands. Its two rules that no code states, when `MODEL_CONTEXT_VERSION` moves and what the billed schema check is owed, are the last two rows of the table above.

## Public docs that change

| Page | Change | PR |
|---|---|---|
| `content/docs/publishing.mdx` | Pull request 2: what a notice about a project space means and what the next publish there does (part 10, Work item F: the migration notice). Pull request 3: the sequence. The first publish makes an empty app, pushes the lookup tables and places, and then fills the app, and a stop anywhere between the first and the last can leave an empty app that the next publish fills. Today's page says in three places that the data goes before the app, and each takes "the app's content" for "the app": "Data in place" opens "Two things go on the project space before the app does" and goes on "An app that arrived first would install and then misbehave.", which become "before the app's content does" and "Content that arrived first would install and then misbehave."; and under "If something goes wrong" the bullet "**Before the app reached CommCare HQ**", with its sentence "A publish that stopped on the data never sent the app, so trying again picks up from there.", becomes "**Before the app's content reached CommCare HQ**" and "A publish that stopped on the data never sent the app's content, so trying again picks up from there. If it was the first publish to that project space, it left an empty app there, which the next publish fills." Also in pull request 3: an empty app named for the Nova app, left by a publish that was interrupted before Nova recorded it, can be deleted in CommCare HQ; a build made in CommCare HQ between the import and the media upload installs and shows no image until the media lands; a `.ccz` built before this change does not reopen forms saved incomplete under it, and what names a form by id in CommCare HQ after the one-time change; a deleted HQ app is made afresh; the download section: a `.ccz` is made for one project space the app is published to, signs workers in there and sends their forms there, an app that is published nowhere has no `.ccz` yet, and the HQ import file is a ZIP with its guide; and the statement on the check of a form CommCare HQ keeps for up to 7 days, in part 02's own four sentences (part 02, The 7-day App Preview statement), written under "On CommCare HQ" without the last sentence's second clause (part 01, A1, "Stable form ids keep HQ's validation verdict"). Pull request 4: "CommCare HQ changed" and the discard, including that a save in HQ that changes nothing a person can see can still stop the next publish; the two windows the check cannot close, each one round trip wide, said by what a person can lose and what helps (part 02, What the check cannot close): "A publish reads your app in CommCare HQ and then writes to it, and CommCare HQ gives Nova no way to write only if nothing changed in between. So a change saved in CommCare HQ in the moments a publish runs can slip past Nova's check: a setting can go back to what it was, or Nova's value can replace it at this publish or the next, with no question asked. Saving in CommCare HQ when no publish is running avoids this. If a save and a publish did overlap, the app in CommCare HQ shows what is there now, and you can make the change again."; that a publish interrupted between the import and its record makes the next publish stop over Nova's own change; the 7-day statement moves into the section on publishing over HQ's changes, with its last sentence completed; and "Checked", whose opening "it checks three things that would stop the publish working" loses its count ("it checks what would stop the publish working") and whose list gains that nothing Nova publishes there has changed in CommCare HQ since its last publish. Pull request 5: what a publish keeps in HQ (UI translations, add-ons, Auto Capture Location) and what it replaces, said as what CommCare HQ held when the publish last read the app, so it stands on the page beside pull request 4's sentence on a save made in CommCare HQ while a publish runs (part 04, Defect 4, Files); the saved and incomplete forms settings, in one sentence the plan gives here because part 04 names only the page: "In your app's settings you can show workers their saved forms, on the Android home screen, and their incomplete forms, on Android and in Web Apps. A publish writes both to CommCare HQ."; the settings a Nova app states and the three worker preferences an update resets; a downloaded `.ccz` needs CommCare 2.57 or later; a phone that holds the app takes a newer download through CommCare's update from a file, and CommCare refuses to install the same app a second time; a phone that holds a `.ccz` downloaded before this change can update to the next one the same way, and installing it instead adds a second app; in the download section, the sentence part 04 says the docs carry and no page holds today: "If a phone installs your app from CommCare HQ and also from a file downloaded here, CommCare keeps them as two separate apps." (part 04, Defect 9: the local profile identifies nothing stable); and one sentence for Connect apps. Pull request 6: each submission's form name in HQ; saving a form in CommCare HQ's form builder makes the next build send that form to devices again. Pull request 8: HQ's data dictionary lists the properties case operations write. Pull request 13: the version stop and how to raise the version in HQ, with what it means for phones on an older CommCare; the sequence sentence gains that a first publish checks the CommCare version of the empty app it made before it pushes a lookup table or a place; raising the version on that empty app is not a change Nova asks about; plan-feature confirmations and withdrawing one; the logo step; and the list in "Checked" gains the CommCare version of an app that is already there and the confirmations the app needs. Pull request 14: the two lookup stops, in sentences the plan gives here because part 02 names only the page: "A publish stops before it sends anything when a lookup table with the same tag in CommCare HQ holds something Nova can't keep yet: field properties, row attributes or rows limited to certain users. Giving your table a new export tag in Project data lets Nova publish its own and leave CommCare HQ's as it is." and, to agree with both forms of the tool's message (part 02, Defect 5: the lookup push): "Where the project space's plan doesn't include Lookup Tables, CommCare HQ takes none of your app's lookup tables and Nova stops before it sends the app's content. A first publish leaves an empty app there. Once the plan includes Lookup Tables, publishing again sends the tables and fills the app in." | 2, 3, 4, 5, 6, 8, 13, 14 |
| `content/docs/project-space-compatibility.mdx` | Pull request 3: "Downloads stay available", whose "You can always create" and "A download has no chosen project space" are rewritten for the project-space choice, as part 01 gives it (A5. A `.ccz` is made for one project space (findings 32 and 59), Files): a CommCare HQ app file is always there for a valid app, a CommCare mobile app file once the app is published, and neither download checks a project space. Pull request 9: a close condition the Case Management tab cannot state is saved as a Save to Case close, which needs that plan feature in CommCare HQ (part 06, 2. Close conditions the Case Management tab cannot state). Pull request 13: the capabilities defect 12 adds; the not-a-member stop; plan features as their own check, that close among what needs one | 3, 9, 13 |
| `content/docs/project-data.mdx` | "puts them on the project space before the app goes" becomes "puts them on the project space before the app's content goes" (3). The sentences after it, "and replaces their rows with the rows in Nova every time you publish. Anything edited on CommCare HQ is overwritten, so keep the values here.", become: "and replaces their rows with the rows in Nova every time you publish. If a table was edited in CommCare HQ since Nova last published it, the next publish stops and asks before it replaces the edit, so the values you keep here stay the ones your app reads." (4). The column a lookup-backed search input sorts its choices by (12). The reserved tag substrings; the 31-character sentence removed; what a push removes from an HQ table Nova adopts (a description, an indexed-field flag, owners on a global table) and which HQ tables are refused (14) | 3, 4, 12, 14 |
| `content/docs/organization.mdx` | A place changed in CommCare HQ since Nova's last push stops the publish, as a lookup table or the app does (4; part 02, Work item B, the standard block). The flat location list confirmation, with the two facts part 03 gives the page (Finding 69: a device and Web Apps read the location fixture choice apart): phones and Web Apps both take the location list by the project space's setting, and an app published before this change took it on phones whatever that setting said (13) | 4, 13 |
| `content/docs/languages.mdx` | A language's CommCare code is set when the language is added and never changes (3); a publish keeps the UI translations a person set in HQ (5); an empty translation shows the default language's text (6); the search button reads "Search All Cases" in every language and is no phrase to translate (12; part 06, 4. The search button label leaves the model) | 3, 5, 6, 12 |
| `content/docs/case-workspace.mdx` | "Downloads stay available so you can choose and check the destination later." becomes, in the words of the `project-space-compatibility.mdx` rewrite: "The CommCare HQ app file stays available for a valid app, and the CommCare mobile app file once the app is published. Neither download checks a project space." (3). What each column kind orders by; hidden columns and search; tile cell defaults, where "**Text size is inherited when you leave it alone.** An item with no size set reads at the same size as the rest of the list. There is no default size Nova fills in, so set a size only where an item should stand out or recede." becomes "**Every item has a text size.** A new item starts at Medium, and Small or Large make it recede or stand out. A tile's text has its own three sizes and doesn't follow the rest of the list."; a date pattern holds no straight apostrophe; one order rule per property; the record ID column; a form left unfinished under grouped tiles, for a case with no connection, can't be reopened on Android (11). The search button reads "Search All Cases"; the sort of lookup-backed choices; reserved search input names; and the no-matches registration form's one explicit destination reads "First menu" where the page says "App home", in both sentences: "After submit, choose **App home**, or let the form return to Results" becomes "After submit, choose **First menu**, or let the form return to Results", and "A module with multiple-case selection requires **App home**" becomes "A module with multiple-case selection requires **First menu**" (12). A time of day is not compared with before or after; a mixed-quote answer returns no results (14) | 3, 11, 12, 14 |
| `content/docs/case-changes.mdx` | A saved date and time copied to another property is written again in the device's time zone, and can land a day off when that zone's date differs from the one saved (6); a follow-up that changes nothing still marks its case as updated; a follow-up opened by a link updates the case that link names, so if the link's case value is empty Android can't save the form, and if it names no case CommCare HQ creates one; and close conditions a Case Management tab cannot state are saved as a Save to Case close (9); an operation id may not be `instance`, `bind` or `parsererror`, and the three refused property names (10) | 6, 9, 10 |
| `content/docs/display-conditions.mdx` | "Show on the menu" in place of an always-false condition, and that a condition which starts with "never" is refused. Of the platform table in part 06, 11 (What each runtime does with an item that is off the menu) the page carries row 1 (an item that is off the menu is not listed, and a menu takes its forms with it) and, as the one sentence the builder's switch shows, rows 2, 3, 5 and 6: on Android a form that is off the menu opens from an after-submit link or an entry point, and in Web Apps only from an entry point that ignores display conditions (12). Time ordering (14) | 12, 14 |
| `content/docs/nested-menus.mdx` | The parent-menu destination, offered to a form of a child menu (part 06, 3). Of the platform table in part 06, 11: the clause of row 1 that a parent which is off the menu takes its child menus off with it, under "Conditions and repeated views"; and row 10 as what a form is not offered, never as a behavior, since the gate withholds it: a form is not offered the parent menu as its destination while the parent is off the menu | 12 |
| `content/docs/form-links.mdx` | The first-menu and parent-menu destinations, and which destinations a multi-select menu offers. Of the platform table in part 06, 11, the page carries rows 2 and 3 as behavior, row 4 as a refusal, and row 9 as what a form is not offered: a form in a menu that is off the menu is not offered its own menu or the previous screen as its destination. An after-submit link to a menu or form that is off the menu, or hidden by a condition, is said per platform as part 06, 11 and 15 give it from the readers' runs: a link to a hidden form opens it on Android and lands on the menu that holds it in Web Apps; a link to a form inside a hidden menu opens the form on Android and lands on the app's first screen in Web Apps. A link to a menu that is off the menu is refused (`HIDDEN_MENU_NOT_A_DESTINATION`); a link to a menu a display condition hides stays admitted, and the page says what it does: Android opens the menu with nothing in it, and Web Apps opens the app's first screen instead. The page says Preview follows Android's behavior for links | 12 |
| `content/docs/building-with-nova.mdx` | Default values that read another question (renaming that question in CommCare HQ's form builder leaves the read as it was); each written choice has a label or media (6). A blank or over-long record name is refused at the question, with the app's own validation message where the question has one and CommCare's otherwise; each such form gains one Hidden Value per name or external id question, shown in CommCare HQ's form builder, in submissions and as a form-export column, and the names and external ids CommCare HQ stores from the next build are trimmed (9). The Hidden Value with no value and its blank write, and the paragraph on accepted media formats, in part 08's own sentences (14). The page takes no edit in pull request 5: part 04 puts the form-list settings and what a publish keeps on `publishing.mdx`, and its barcode and secret fix changes no page, since none holds a caveat about them | 6, 9, 14 |
| `content/docs/attachments.mdx` | The link capability named by what uses it (13; part 03, C3. Defect 12: the flag probe). Its format list is worker capture formats, and the file question on Android (14; part 08, Defect 11, first half, and Defect 16: what the code, the tools and the docs say) | 13, 14 |
| `content/docs/commcare-connect.mdx` (new in pull request 10, with its `content/docs/meta.json` entry after `automations`) | What a Connect app is in Nova, its id sentences, what changing a block's ID after publishing does (a deliver unit's deliveries are turned away until it is in a payment unit and are not sent again; a learn module becomes a second module; an assigned task is never completed), and that a task goes in a form of its own, each in part 08's own sentences (Defect 15: identifiers HQ's editors refuse, Files; Defect 15's Connect forwarding: deliveries refused between a rename and a new payment unit, Files; Finding 61: a deliver form that also holds a task, Files) (10); Data Forwarding and the Connect forwarder a Connect app's publish asks for (13) | 10, 13 |
| `content/docs/deep-links.mdx` | Entry-point ids follow the narrowed grammar (10). Of the platform table in part 06, 11, the page carries rows 5 and 6 as behavior and rows 7 and 8 as a refusal: a form's entry point opens a form that is off the menu in Web Apps only when it ignores display conditions, and on Android always; an entry point or a case list entry point on a menu that is off the menu is refused (12). The page keeps its standing rule (a link is made from the app as last published, so publish again after a change). The cutover's one-time effect is said in the notice (`deep-links-need-republish`), not here | 10, 12 |
| `content/docs/mcp/tools.mdx` | Four sentences pull request 3 makes false, each rewritten there. The `upload_app_to_hq` row's "Push the app to CommCare HQ: its lookup tables and its organization's places first, then the app itself. The first upload to a project space creates the app there; uploading again updates that same HQ app in place (`hq_app_action` in the result says which happened)." becomes "Push the app to CommCare HQ. The first upload to a project space creates the app there, empty, then sends its lookup tables and its organization's places, then fills the app in. Uploading again sends the tables and places and then updates that same HQ app in place (`hq_app_action` in the result says which happened, and reads `created` until an upload has filled the app)." In the callout on shared names, "are pushed before the app, because the app reaches for them by name at runtime" becomes "are pushed before the app's content, because the content reaches for them by name at runtime". In the callout on organization levels, "the upload refuses with `hq_organization_mismatch` and sends nothing;" becomes "the upload refuses with `hq_organization_mismatch` and sends none of the app's content. Where the check before the upload finds the mismatch nothing is written; where CommCare HQ refuses a place during the upload, a first upload has already made the empty app, which `get_deployment` reports as `hq_app_empty`;". And "`compile_app` stays available because a download has no selected destination." becomes "`compile_app` stays available for the CommCare HQ app file, which has no destination, and compiles a CommCare mobile app file for a project space the app is published to. Neither checks a project space." The rest, each with its tool change: `upload_app_to_hq` (`confirm_plan_features`, `confirm_flat_location_fixture`, `confirm_connect_forwarder`, `discard_hq_changes`, the error types `hq_confirmation_needed`, `hq_changed`, `hq_app_version_below_floor` and `hq_table_content_unsupported`, `logo_step`, `app_preview_note`, `web_apps_enabled`); `withdraw_deployment_confirmation`; `check_project_space_compatibility`'s `plan_features`; `get_deployment`'s `confirmations`, `hq_app_gone` and `hq_app_empty`; `check_project_space_compatibility`'s `flat_location_fixture` and `connect_forwarder`, its widened capability ids and the `not-a-member` issue; `refresh_deployment`'s `confirmations`; `compile_app`'s `domain` and `nova/target`, and that its import file is always the ZIP, with `nova_manual_import_guide`; `get_app.notices` and `dismiss_app_notice`; `get_languages`' `commcareCode`; the `update_app` row ("Set the app's name, and whether workers see their saved forms and their incomplete forms."); the `set_app_logo` row ("Set or clear the app logo. It shows in Preview, and in Web Apps once it is added in the app's settings in CommCare HQ."); the `attach_field_media` row and the sentence above the media tools ("a field's label or help"), and the `upload_media_asset` row's formats sentence, each as part 08 gives it; the `add_entry_point` row ("An `id` uses lowercase letters, digits, underscores and single hyphens, and starts and ends with a letter or digit."); the three refused names after the sentence on operation ids, link identifiers and write-property names; `postSubmit`, `hiddenFromMenu`, `set_case_search_display` without the search button label, a search input's `options.sortColumnId` and its reserved names, "On Android, an answer that holds both ' and \" finds nothing." on a free-text search input, a column's `sort` and `mapping` guidance, `visibleInList`, tile cells, date patterns, operation and entry-point ids, `idFrom` | each with its tool change |
| `content/docs/cross-facility-referrals.mdx` | "it creates the places on the project space first, working down from the top, so every owner rule's addresses exist before the app does." becomes "it creates the places on the project space before the app's content arrives, working down from the top, so every owner rule's addresses exist before the content that reads them." A first publish makes the empty app before the places go | 3 |
| `content/docs/claude-code/commands.mdx` | `/nova:upload_to_hq`: what Claude asks before it publishes (plan features, a change made in HQ) | 15 |
| `design/readme.md`, `design/components/core/Badge.prompt.md` | No new primitive and no token: the notice chip is a `Badge`, and `Badge.prompt.md` gains the chip as a use of that primitive; the notice dialog, the plan-feature and discard confirmations and the project-space choice on downloads are the existing dialog, `Button` and menu from `components/shadcn`. The readme gains, beside "Explain consequences, calmly", the notice as a named pattern: one line per change, each saying what changed, what a worker or a person now sees, and what is theirs to do. The two confirmations follow that existing rule and add nothing | 2 |

Every sentence follows `design/readme.md`, "Content fundamentals": it invites, takes responsibility, offers the next step, and uses no em dash.

## Edits to the other plans and the research

The first six ride this plan's own pull request, because they state what the plan decided. The last rides pull requests 1, 10 and 14 of the stack, because it records what the lane then shows. Pull request 16 deletes this plan, so it edits three of the six once more: those edits follow the table.

| File | Edit |
|---|---|
| `docs/plans/hq-round-trip/README.md` | The step table reads "planned in full" for step 2, where it reads "work items, planned in full next". Under "Step 1 is done", a paragraph after the closing one says where step 2 settles the two rows that paragraph names: work item H takes defect 3's unknown-question warning off `targeted-save-to-case-read` (pull request 6), and Nova's gate refuses the read "20, CommTrack" needs (finding 68, pull request 10). The pins rule names the commits `proof/pins.json` holds when a plan is written, and step 2's: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect `046c7fd78081`, Vellum `01215f251c57` (the build HQ vendors at that pin), formplayer `24383ac71bfb`, beside the research's own pins. "Nova since the research" runs from `982d2630` to the proof lane's merge onto `main` at `7b153dc3` or later: #699, #701, #698; #702, #703; #704 to #707 (step 1, with `hqImportApplication` and `compileLocalArchive` as the two assembly points); #712 (finding 52 fixed, `nova_constraint_message_<question>` and the `__nova_` itext form names); #717, #722, #723, #724, #716; #729 (case-write findings in `lib/commcare/caseWriteFindings.ts`), #730 (a select's choices from the worker's available cases, a casedb itemset on both export paths, `lib/commcare/caseOptions.ts`), #732 and #733; and the proof lane's own pull request, #738. Step 1's row already reads "done" there and no clause paragraph is left. Pull request 16 edits the file again, below. The file on this plan's branch is the lane's `README.md` with these four edits made, so this plan's pull request is rebased onto the lane's merge before it merges, and its diff of the file is then those edits alone |
| `docs/plans/hq-round-trip/3-expressions.md` | A section "Carried from step 2": finding 56, that step 2 holds it in the register with its control, and that step 3 fixes it by a lowering chosen per operand from its type or a refusal where none exists, with its entries removed at step 3's exit; and the seven requirements that lowering meets, as part 08 lists them (Finding 56: ordering a date and time never orders by instant on a device, "Fix"), since pull request 16 removes that part. And findings 72 and 73: a choice question's literal default that none of its own options carries, which Web Apps cannot open, and a date question filled from a case property the catalog gives no data type, which no reader opens for a case that holds text there. The lane holds each as walk stops (five and one; part 09, The held walk stops). Step 3's typed model refuses the first where it is decidable and types the property for the second, and its exit removes those six entries from `proof/walk-stops.json` |
| `docs/plans/hq-round-trip/4-platforms.md` | One passage in defect 18's item: finding 74, a date and time question whose placeholder answer the Web Apps client submits, so the form can never be submitted there. The lane holds it as two walk stops; step 2's pull request 10 removes the one on `fuzz-xform-20260930-10`, whose repeat after the question's repetition then holds rows, so step 2 ends holding it on `targeted-datetime-ordering` alone, and step 4's exit removes that entry |
| `docs/plans/hq-round-trip/5-case-writes-forms-navigation.md` | One paragraph: once a form may create a basic child case of its own menu's case type, step 5 adds defect 12's `DONT_INDEX_SAME_CASETYPE` refusal at publish with the offered move to a Save to Case placement. No Nova document can hold that shape before then |
| `docs/plans/hq-round-trip/6-import.md` | One sentence in the reader's item: it refuses an app that carries a translation for a runtime UI-catalog key until step 7 holds UI string overrides. Two more, each made in that file on this plan's branch: the reader keeps an imported form's `xmlns` in an optional stored slot step 6 adds (part 01, A1. Derived ids, and why `Form.xmlns` is not stored), and the `hq-import` birth owner writes the ids a target holds that differ from the derivation, so step 6 gives the runtime role the write privilege on `app_deployment_identities` that step 2 withholds |
| `docs/plans/hq-round-trip/7-rest-of-model.md` | The application-and-settings group holds the rest of `appSettings` (step 2 creates the object with two slots) and UI string overrides with `uiStringCatalogKeys`. Its lookup group, "Media and lookup data", carries the indexed-field flag ("indexed fields"), and says, in a sentence added on this plan's branch, that until then a push removes the flag from a table Nova adopts and that no step carries a table's description, which no lookup upload can hold (part 02, Defect 5: the lookup push) |
| `docs/research/2026-09-26-hq-round-trip/harness-findings.md` | The header gains one sentence: findings 56, 57, 70 and 71 were executed at step 2's pins, named there. The file's findings run from 31 to 55, 58 to 69 and 72 to 74 on the lane's branch, which leaves these four numbers free. **Finding 56** is added under a new heading "Found while planning step 2", with its table of operand classes and results and the note that step 3 fixes it. **Finding 57** is added there too: a case list column over `case_id` is blank on HQ's build (`detail_screen.py::CASE_PROPERTY_MAP` has no entry and the case database holds it only as an attribute), and a hidden sort carrier over `case_id`, `owner_id` or `status` makes the Case List page refuse to save. **Finding 50** moves from "HQ's editors, continued" to "What HQ does itself", with its citations and the name of its allowance. **Finding 53** is reworded: HQ notes the use of a search filter without Advanced Case Search at most once per project space per day (`case_search/utils.py::_require_case_search_advanced`), not for every search; the difference between the two export paths stays a finding and is step 2's to fix, and the note moves under "What HQ does itself". "What HQ does itself" also gains that a lookup push removes a table's description, which no workbook can carry (`fixtures/upload/workbook.py::_FixtureWorkbook.iter_tables`). **Findings 70 and 71** are added under "Found while planning step 2" too (part 08, Finding 70 and Finding 71). Finding 63 moves under "What HQ does itself" with its citations: no entry ever named it and it needs no allowance. Finding 67, and what Connect does with a renamed block (defect 15's Connect forwarding), move there with the names of their allowances (part 09). **Finding 74**, under "Found by holding every walk to its end", follows the list of held stops (part 09, The held walk stops): pull request 1 adds the second shape `targeted-datetime-ordering` shows, a form whose only questions are date and time questions, so nothing a worker answers replaces the text the client holds, and adds that document to the finding's documents line with its stop, Formplayer's `submit-refused:validation-error`; pull request 10 takes `fuzz-xform-20260930-10` out of that line, since the repeat after its repetition then holds rows and its stop leaves the list, and says the document showed the finding until then. Pull request 14 adds the table description entry, pull request 10 makes that one edit to finding 74, and the rest is pull request 1 |

Pull request 16 deletes `2-emission-and-publish.md`, its parts and `2-cutover-runbook.md`, and four places in the three files below cite them: the README's step table, `3-expressions.md` twice and `4-platforms.md` once. No other file of the repository names the plan, read on this plan's branch and at the lane's head; the two passages the stack itself adds that name the runbook, in `docs/architecture/deployment.md` and `scripts/README.md`, leave whole in pull request 16 (the new-sentences table). Each new target was checked to hold, at pull request 16's head, what its citation needs.

| File | Edit in pull request 16 |
|---|---|
| `docs/plans/hq-round-trip/README.md` | The step table's row for step 2 reads, in its three cells: "2"; "Emission and publish fixes", with no link; and "done: [`lib/commcare/CLAUDE.md`](../../../lib/commcare/CLAUDE.md), [`lib/deployment/CLAUDE.md`](../../../lib/deployment/CLAUDE.md), [`proof/README.md`](../../../proof/README.md)", in the form of step 1's row. Under "Step 1 is done", the paragraph this plan's branch adds ("Step 2 settles the two rows this paragraph names.", with its two pull request numbers) becomes: "Step 2 settled the two rows this paragraph names. Defect 3's unknown-question warning no longer shows on `targeted-save-to-case-read`: its two entries are in `proof/fixed-defects.json`, on the control of that name. And Nova's gate refuses the read "20, CommTrack" needs (finding 68)." A section "Step 2 is done" follows it, given in full below the table. Under "Why each later step is planned when the one before it exits", the first sentence takes the past tense: "Each defect part step 2 fixed that the lane reproduces was observed in the system it harms, by a register entry, before its fix was designed in detail, and step 2's proofs were written against the harness step 1 built rather than one imagined in advance." In the pins rule "Step 2's plan reads commcare-hq" becomes "Step 2's plan read commcare-hq". Under "Nova since the research", "Step 2's plan reads it at" becomes "Step 2's plan read it at", "the pins step 2's plan reads" becomes "the pins step 2's plan read", and the closing sentence "Step 2's plan states, defect by defect, what it re-verified and where the code a fix touches has moved." is removed, since the plan it names has left; that section's list is extended by step 3's plan when it is written, as this plan extended it |
| `docs/plans/hq-round-trip/3-expressions.md` | In "Carried from step 2", "Finding 56 (`2-emission-and-publish.md`, "Finding 56")" becomes "Finding 56 (`harness-findings.md`, "Found while planning step 2")": pull request 1 puts the finding there with its table of operand classes and results, and the seven requirements its lowering meets are already in this section. "`2-emission-and-publish/09-proof.md`, "The held walk stops"" becomes "`proof/README.md`, "Walk stops"": that section says how the list holds a stop, `proof/walk-stops.json` holds the six entries the paragraph names by document and cause, and `harness-findings.md` holds findings 72 and 73 with their documents and stops, which no pull request of the stack moves |
| `docs/plans/hq-round-trip/4-platforms.md` | In item 6, "(`2-emission-and-publish/09-proof.md`, "The held walk stops")" becomes "(`proof/README.md`, "Walk stops")", and the sentence takes the past tense for what step 2 did: "Step 2 ended holding it as one walk stop" and "the lane's second, on `fuzz-xform-20260930-10`, left in step 2 once that form's later repeat held rows". `proof/walk-stops.json` then holds the one entry on `targeted-datetime-ordering`, and `harness-findings.md` names that document under finding 74, by the edit of pull requests 1 and 10 above |

The section the README gains, in the form of "Step 1 is done", placed after the paragraph on the two rows:

```markdown
## Step 2 is done

Step 2 fixed the emission and publish defects the harness showed, so the
known-defect register holds no entry for defects 1 to 10 or 12 to 16 and
none for a finding of the harness but finding 56. It also made a publish an
update of an app Nova has read. Its plan has left this directory. What
endures lives where it is read:

- **Identity that holds across publishes**, `lib/commcare/wireIdentity.ts`
  and the document's `localization.wireCodes`: a menu's and a form's HQ id
  and a form's `xmlns` are derived from the Nova entity's UUID, and a
  language's CommCare code is stored when the language is added
  (`lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`). The ids a project
  space held before ids were derived are in `app_deployment_identities`
  (`lib/deployment/CLAUDE.md`, "Identities").
- **The publish sequence and its ledger**, `lib/deployment/`: the empty app
  a first publish makes before any Project data, the reads of the app's
  source, the stop on a change made in CommCare HQ since Nova's last push,
  the CommCare version floor, and the confirmations a publish asks a person
  for (`lib/deployment/CLAUDE.md`; the tables in `lib/db/CLAUDE.md`;
  `docs/architecture/contracts.md` for the drift rule).
- **Emission HQ's editors keep**, `lib/commcare/`: generated nodes named by
  one allocator, case operations as Save to Case blocks the form builder
  writes back unchanged, `profile`, `translations` and `add_ons` projected
  over what the project space holds, and one order plan for a case list
  (`lib/commcare/CLAUDE.md`; `docs/architecture/complex-apps.md` for the
  binding CommCare facts). The two HQ facts that bind every later step are
  in `docs/architecture/contracts.md`, "Nova is not CommCare HQ.".
- **The fixed-defect register**, `proof/fixed-defects.json`: every entry
  step 2 fixed, each still showing on its retained control
  (`proof/README.md`, "Fixed defects"). `proof/known-defects.json` holds
  only what a later step owns, and
  `proof/checks/registers.py::OPEN_DEFECTS` names the step for each.
  `proof/walk-stops.json` holds each place a reader's walk still ends short
  (`proof/README.md`, "Walk stops"), and `proof/hq-reads/` holds the
  answers of HQ the drift comparison is proven over.
- **What planning step 2 found**,
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md),
  "Found while planning step 2" and "What HQ does itself".
- **The cutover's trace.** The cutover ran once, before the merge, and its
  scripts, its Job and its runbook are removed. What it left is each app's
  `fold-baseline:hq-round-trip-emission` row (`lib/db/CLAUDE.md`), each
  app's notice (`lib/notices/`) and its evidence archive
  (`docs/architecture/deployment.md`, "Historical repairs").
  `docs/architecture/contracts.md`, "Direct maintenance cutover", holds the
  rules it followed.

Four findings belong to later steps and are held until then:
finding 56 by register entries, for step 3
([`3-expressions.md`](3-expressions.md), "Carried from step 2"); findings 72
and 73 by walk stops, for step 3 (the same section); and finding 74 by one
walk stop, for step 4 ([`4-platforms.md`](4-platforms.md), item 6). The
register's other entries are defects 20, 21, 23 to 28 and 30, which
`OPEN_DEFECTS` gives to steps 4 and 5.
```

The research's `README.md` is not edited: it is the record at its own pins. Where this plan cites a path that has moved since, it cites the current one: `cloudcare/utils.py::format_app_doc`, `static/app_manager/js/case_config_utils.js::getQuestions`, `static/app_manager/js/forms/bootstrap5/form_workflow.js::FormWorkflow`, `static/app_manager/js/details/bootstrap5/{column,screen,sort_rows}.js`, and commcare-android `app/src/org/commcare/AppUtils.java::getAppById`.
