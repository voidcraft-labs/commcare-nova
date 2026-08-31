# Related-case pulls and derived compatibility

**PRs:**
1. `Related-case pulls in case search`
2. `Derived search tuning and project-space compatibility`

**Depends on:** nothing outstanding. · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first. The wire-fixture rule
> there is why each projection below names its byte oracle up front.

The two projections share the Search inventory but no author-facing setting.
Related pulls are explicit Search intent. Search-result indexing is an emitted
performance choice Nova derives from effective Search, not another constraint
for an author or the design agent to remember. Nova authors no sync setting,
restore imitation, generic profile-property bag, or automatic menu navigation.

## Binding facts

- **Related-case pulls** emit as query `<data>` keys
  `x_commcare_include_all_related_cases` (`ref="'true'"`) and
  `x_commcare_custom_related_case_property`. Result-instance nodesets append
  `EXCLUDE_RELATED_CASES_FILTER = "[not(commcare_is_related_case=true())]"` so
  pulled relatives ride the query response without polluting the visible list.
  The custom-property row is pinned by
  `test_suite_remote_request.py::RemoteRequestSuiteTest.test_custom_related_case_property`;
  the include-all row needs its own exact partial assertion because the current
  `basic_remote_request.xml` fixture does not contain it.
- **Derived Search tuning** emits `cc-index-case-search-results=yes` only when
  the app has effective case Search. The literal is private CommCare wire, not
  Blueprint or tool vocabulary. Search continues to run when a target cannot
  accept that advisory profile property; publishing omits the optimization and
  states that large result sets may be slower.
- **No sync model.** Preview reads and writes Nova's authoritative shared case
  rows. It does not imitate restores, timers, or post-submit sync. Nova does not
  author or emit `cc-sync-after-form`, and does not expose downstream profile
  keys to a person or agent.
- **Safe profile preservation.** A direct update reads the target app source
  immediately before import, removes only Nova-owned derived keys, overlays the
  currently applicable ones, and preserves foreign profile state. A missing or
  malformed source blocks the app import. A manual HQ JSON artifact describes a
  new app, not a safe patch for an existing one.
- **Project-space compatibility** replaces the public feature-flag inventory.
  Private manifests keep downstream slugs, namespaces, format applicability,
  runtime consumers, and source evidence. Builder and MCP report friendly
  required capabilities, verification state, consequences, and next steps.
  Required missing or unverified capabilities block before any remote write;
  an advisory optimization never does. Construction and downloads remain
  available, and the design agent carries no project-space constraint ledger.
- **Several `CaseSearch` fields are removed upstream and must never be modeled or
  reproduced:** `search_label`, `additional_relevant`, `dynamic_search`, and
  `search_filter`.

**Observed:** a form can read supporting cases pulled with each Search result,
and Nova states whether a chosen project space can run the app without exposing
the downstream switches that establish that fact.
