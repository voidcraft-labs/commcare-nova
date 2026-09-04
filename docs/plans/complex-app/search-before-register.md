# Search before register

**PR train:** `Search-first modules and the no-matches registration form`
(three PRs stacked on the shipped Search-prompt PR: the inline `searchFirst`
shape, the completed-search context plus the no-matches form, then the builder
surfaces and smoke).

**Depends on:** nothing outstanding. The shipped richer Search prompts (hint,
required, one check, lookup-backed choices, hidden values, `matches-pattern`)
are inputs, not remaining work; see
[what is built](../complex-app-plan.md#case-lists-search-and-the-case-workspace).
· **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first. Every wire byte below is
> asserted against a named HQ test partial or fixture, and the `~/code`
> checkouts must be re-read before a PR relies on one of them.

## Contract

A worker must search for an existing case before they may register one, and
the registration form they reach after an empty search carries what they
searched for. Nova models that natively, not as CommCare's workaround:

- **Search-first is an explicit module setting** (`caseSearchConfig.searchFirst:
  true`). The browse list goes away; the module opens on the Search screen and
  Results exist only after a completed search. Turning on the no-matches form
  turns search-first on in the same atomic commit, and the builder says so.
- **A completed search is a context distinct from not-searched and failed.**
  The running app records `not-searched | running | failed | completed
  {matchCount}` per module; the no-matches action is available only for
  `completed` with zero matches. A failed search (invalid input, server error,
  no persona) never offers registration.
- **One no-matches registration form per module** (`Form.entry = {kind:
  "search-no-matches", label?}`). It is a registration form of the module's own
  case type, it leaves the menu (nothing lists it, no link may target it, it
  carries no display condition and no after-submit choice), and its fields may
  read the search answers through `#search/<name>` (`search-answer-ref` in the
  XPath AST, identity-backed like every other reference). After submit the
  worker lands on Results showing only the case they just registered, with
  **Search again** returning to the Search screen.
- **Lowering is at the CommCare boundary only.** Preview, local `.ccz`, and
  HQ-regenerated output agree byte for byte with HQ's own emission of the
  `case_list_form` + hidden-module shape below; the SA and the builder never
  speak it.
- **Web Apps is the enforcing runtime.** Android never shows a case list on an
  empty search response and never passes the search-input instance to a form,
  so the no-matches action and the carried answers are browser-app behaviour;
  copy says so, as grouped tiles do.

## Binding facts

Verified in `~/code/commcare-hq` (master `f391f622123`), `~/code/commcare-core`
(`8e9ba8d90`), `~/code/formplayer` (`372832b36`). Cite by stable name;
re-verify before relying.

| Fact | Where | Consequence |
| --- | --- | --- |
| The Register `<action>` is emitted on EVERY `*_short` detail, row and tile | `suite_xml/sections/details.py::DetailContributor.build_detail`; `features/case_tiles.py::CaseTileHelper.build_case_tile_detail` | On the remote-request shape it would sit on the pre-search casedb list |
| `instance('results…')` before the query ran THROWS `XPathMissingInstanceException` | `commcare-core javarosa/xpath/expr/XPathPathExpr.java`; `core/process/CommCareInstanceInitializer.java::setupExternalDataInstance` | A zero-results gate is safe only post-query, so the module must be inline search |
| Inline search = `inline_search && auto_launch`: no `<remote-request>`, no `m{N}_search_*`; `<query storage-instance="results:inline">` plus the claim `<post>` inside each case-requiring `<entry><session>`; datum `case_id` over `instance('results:inline')/results/case[@case_type][@status='open']<filter>[not(commcare_is_related_case=true())]`; multi-select uses `selected_cases` and `<post relevant="$case_id != ''">`; the browse entry has the query and no post; no search `<action>` on `case_short` | `app_manager/util.py::module_uses_inline_search`; `models/modules.py::get_details`; `suite_xml/sections/entries.py::EntriesHelper.get_query_datums / add_post_to_entry / include_post_in_entry / get_datum_meta_module` | Oracle: `tests/test_suite_inline_search.py::InlineSearchSuiteTest` (`test_inline_search`, `test_inline_search_case_list_item`, `test_inline_search_multi_select`) |
| The Register action's `relevant` is emitted ONLY under `toggles.FOLLOWUP_FORMS_AS_CASE_LIST_FORM` (TAG_FROZEN, domain); without it HQ emits an UNCONDITIONAL action | `details.py::DetailContributor.get_case_list_form_action`; `corehq/toggles/__init__.py` | A required project-space capability; blocks direct publish when missing or unverified |
| Register action bytes: `<action relevant><display><text><locale id="case_list_form.m{N}"/></text></display><stack><push><command value="'m{H}-f0'"/>…<datum id="return_to" value="'m{N}'"/></push></stack></action>`; no `auto_launch` / `redo_last`; datums copy the target entry's non-selection datums (`case_id_new_<type>_0 = uuid()`) | `tests/data/case_list_form/case-list-form-suite.xml`; relevancy partial in `tests/test_case_list_form.py`; `details.py::DetailContributor.get_datums_for_action` | Pin these bytes |
| `Action.relevant` is string-compared to `"true"`; `Detail.get_all_xpaths` ignores `action.relevant` | `commcare-core suite/model/Action.java::isRelevant`; `suite_xml/xml_models.py::Detail.get_all_xpaths` | Emit an explicit boolean comparison; the `results:inline` instance comes from the datum nodeset |
| Stack pushes ignore menu relevance; relevance is display-only | `commcare-core session/CommCareSession.java::performPushInner`; `suite/model/MenuLoader.java` | Pushing into `<menu relevant="false()">` works |
| A hidden module is `module_filter='false()'` → `<menu relevant="false()">` | `suite_xml/sections/menus.py::MenuContributor._generate_menu` | The synthetic module emits `module_filter: "false()"` |
| HQ validates only `form.is_registration_form(module.case_type)` = one `open_case` AND the form's OWN module `case_type` equals the search module's; the importer validates nothing | `helpers/validators.py::ModuleBaseValidator.validate_case_list_form`; `models/forms.py::Form.get_registration_actions`; `models/applications.py::import_app` | The synthetic module carries the host case type |
| End-of-form frames win over `case_list_forms_frames`. For an INLINE target under `post_form_workflow='case_list'` the regenerated frame is `<create if="count(…return_to) = 1 and …return_to = 'm{N}'"><command value="'m{N}'"/><query id="results:inline" value="…/phone/case_fixture/<app>/"><data key="case_type" ref="'t'"/><data key="case_id" ref="instance('commcaresession')/session/data/case_id_new_t_0"/></query></create>`; the query child is cloned from the target module's common datum prefix and the `case_id` datum is NOT added | `post_process/workflow.py::WorkflowHelper._get_stack_frames`, `CaseListFormWorkflow._get_stack_frames / _add_stack_children_for_target`, `WorkflowQueryMeta.to_stack_datum`, `_get_datums_matched_to_source`; partial in `test_suite_inline_search.py::test_form_linking_to_inline_search_module_from_registration_form` | The worker lands on Results showing the new case; Nova emits the same frame and Preview mirrors it |
| HQ's build validator rejects `post_form_workflow == previous` on a case-requiring form of an inline module, and two inline modules sharing an instance name across parent-select / root relations | `helpers/validators.py` ('workflow previous inline search', 'non-unique instance name') | Matching Nova rules |
| Required and validation evaluate with the search-input instance under `search-input:<storage>` AND the legacy `search-input`; validation is skipped on empty, required fires only on empty, nulls are dropped | `session/RemoteQuerySessionManager.java::getEvaluationContextWithUserInputInstance / validateUserAnswers / getUserQueryValues` | Search-screen scope may read other answers; "unanswered" = `is-blank(input)` lowered to `count(field) = 0` |
| `default_search="true"` skips validation and sends no PROMPT values, but hidden defaults are seeded into `userAnswers` and reach the search-input instance | `formplayer services/MenuSessionRunnerService.java::doQuery`; `RemoteQuerySessionManager.initUserAnswers` | Hidden-only inputs are fine; verify `doQuery` still passes the search-input extra to `updateSession` in the default-search path (implementation gate) |
| `<prompt default>` needs build ≥ 2.51 + `CASE_SEARCH_ADVANCED`; `exclude` sees no answers; hidden defaults re-evaluate at every query-screen construction | `feature_support.py::enable_default_value_expression`; `RemoteQuerySessionManager.java::getRawQueryParams`; `QueryScreen.java::init` | Hidden inputs extend `advanced-case-search`; emit the literal `exclude="true()"` |
| The `search-input:results:inline` declaration is `src="jr://instance/search-input/results:inline"` | `post_process/instances.py::search_input_instances` | The XForm instance declaration |
| Core registers only `search-input:<storage>`; HQ stores `default_properties` / validation `test` raw | `RemoteQuerySessionManager.java::getEvaluationContextWithUserInputInstance` | In the inline shape every `input(...)` read on both wire paths prints `search-input:results:inline` |
| Android never shows the case list on an empty search response and passes no search-input extra | `commcare-android …/activities/QueryRequestActivity.java::processSuccess` | No-matches registration and carried answers are Web Apps-only at runtime |
| `CaseSearch` REMOVED `search_filter / search_label / search_again_label / additional_relevant / dynamic_search`; the `USH_INLINE_SEARCH` / `USH_SEARCH_FILTER` toggles are gone; the `CaseListForm` attribute is `relevancy_expression` | `models/case_search.py::CaseSearch` docstring; `models/modules.py::CaseListForm` | Lifecycle: `case_list_form.{form_id, label, relevancy_expression, post_form_workflow}` alive; `inline_search / auto_launch / default_search` alive, untoggled |

## Implementation gates

Verify in source before the step that depends on it:

- The default-search path still hands the search-input instance to the frame:
  `formplayer services/MenuSessionRunnerService.java::doQuery` →
  `QueryScreen.updateSession`. If not, add a "hidden input needs a visible
  input" rule.
- Web Apps echoes hidden prompt values on submit:
  `corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views/query.js`
  (else `now()` re-evaluates per screen build; still an honest search time).
- `EntriesHelper.get_query_datums` applies to the `case_list` browse entry
  (`test_inline_search_case_list_item` should pin it).
- `is_registration_form` on Nova's emitted registration form: exactly one
  `open_case` for the host case type in the HQ JSON `actions`.

## What a user observes

A **Search first** switch on the Search canvas, and **When no cases match** on
the same canvas (do nothing / register a new case / use an existing
registration form) with a review dialog that names the search-first
consequence. In Preview and the deployed browser app the module opens on
Search; a blank required field refuses; a search that finds cases shows them
with **Search again**; a search that finds none shows "No cases match" and the
register action; the form opens with the searched values filled in; Submit
lands on Results showing only the new case. Opening the form's URL directly
meets "This form opens after a search finds no matches" and **Go to Search**.
Nova never emits a session endpoint for a no-matches form and never offers
`respect_relevancy=false` toward one.
