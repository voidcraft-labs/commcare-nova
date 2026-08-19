# Multi-select, related cases, and profile extensions

**PRs:**
1. `Multi-select case lists and selected-case operation semantics`
2. `Related-case pulls in case search`
3. `Authored app-profile properties`

**Depends on:** nothing outstanding. · **Blocks:** nothing.

The profile PR needs a live push path to confirm that the `CUSTOM_PROPERTIES`
toggle is present on the target before offering authored properties that HQ
would otherwise merge away silently. That path is shipped.

> Read [the binding contracts](00-contracts.md) first — the wire-fixture rule
> there is why the three PRs below name their suite fixtures up front.

Three independent vocabularies that only share a dependency, so they ship as three
PRs rather than one with a contingency. Every HQ JSON and compiler projection
stays identical across all three.

Define selected-case runtime semantics before suite flags: ordinary primary-case
preloads and writes must either reject or lower through per-selected-case
operations. Add preview repeat materialization, integer limits 1–100,
empty-selection behavior, and cross-page/search/back persistence.

## Binding facts

The emitted datums and claim POST are asserted against
`suite/multi_select_case_list/basic_remote_request.xml` and
`session_endpoint_remote_request_multi_select.xml` under
`commcare-hq/corehq/apps/app_manager/tests/data/`.

- **Multi-select.** The short detail carries `multi_select` (Boolean) and
  `max_select_value` (Integer, default 100); emission swaps the datum class to
  `<instance-datum … max-select-value="N">`; selected ids materialize as a virtual
  instance (`jr://instance/selected-entities/…`, a `<results><value>` shape) that
  forms read as `instance('selected_cases')`; the client enforces the cap
  (`DEFAULT_MAX_SELECT_VAL = 100`,
  `MultiSelectEntityScreen.validateSelectionSize`); and claim is **one** POST
  carrying all ids, with 204 meaning already claimed.
- **Related-case pulls** emit as query `<data>` keys
  `x_commcare_include_all_related_cases` (`ref="'true'"`) and
  `x_commcare_custom_related_case_property`. Result-instance nodesets append
  `EXCLUDE_RELATED_CASES_FILTER = "[not(commcare_is_related_case=true())]"` so
  pulled relatives ride the instance without polluting the visible list.
- **App-profile custom properties** ride the app JSON untouched at import and emit
  as `<property key value force="true"/>`, but HQ merges them **only** when the
  domain has the `CUSTOM_PROPERTIES` toggle; Nova's own local `profile.ccpr` is
  ungated. The three verified keys and their Formplayer effects are
  `cc-sync-after-form` (sync after every submission), `cc-auto-advance-menu` (a
  single visible choice self-selects and the advanced menu drops out of the
  persistent menu and breadcrumb), and `cc-index-case-search-results`.
  `lib/commcare/compiler.ts::generateProfile` currently hardcodes its property
  list; this unit makes exactly those three `cc-*` keys authored. The
  emitter-owned properties — the app name, the `cc-content-version` blueprint
  stamp every export carries, `cc-app-version`, and the logo — stay reserved and
  unauthorable, because an author who overwrites the version stamp breaks the
  upgrade path silently.
- **Several `CaseSearch` fields are removed upstream and must never be modeled or
  reproduced:** `search_label`, `additional_relevant`, `dynamic_search`, and
  `search_filter`.

**Observed:** a worker selects several cases at once and runs one form over all of
them.
