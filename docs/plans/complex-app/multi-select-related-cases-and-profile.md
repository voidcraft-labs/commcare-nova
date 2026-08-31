# Related-case pulls and derived compatibility

**PRs:**
1. `Related-case pulls in case search`
2. `Derived search tuning and project-space compatibility`

**Depends on:** nothing outstanding. · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first. The wire-fixture rule
> there is why each projection below names its byte oracle up front.

The two projections share the Search inventory but no author-facing setting.
When an emitted Results, Details, or Default-order calculation is one parent
property read by itself, Nova carries the supporting case in the Search
response automatically. Search-result indexing is an emitted
performance choice Nova derives from effective Search, not another constraint
for an author or the design agent to remember. Nova authors no sync setting,
restore imitation, generic profile-property bag, or automatic menu navigation.

## Binding facts

- **Related-case pulls** are derived from effective Search and emitted Results,
  Details, or Default-order information. When an emitted calculated column is
  one parent property read by itself, the query emits
  `x_commcare_include_all_related_cases` (`ref="'true'"`). A definition hidden
  from both screens and absent from sort remains saved but does not trigger the
  query datum. Result-instance nodesets append
  `EXCLUDE_RELATED_CASES_FILTER = "[not(commcare_is_related_case=true())]"` so
  supporting cases ride the query response without becoming visible choices.
  The include-all row needs its own exact partial assertion because the current
  `basic_remote_request.xml` fixture does not contain it; the parent-property
  expression is pinned by
  `tests/data/suite/search_command_detail.xml::detail[@id='m0_search_short']`.
  The supporting rows belong to Results and Details evaluation only. They do
  not add a form data source or open beside the selected case.
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

**Observed:** Results and Details can show parent-case information without
turning the supporting cases into choices or form data, and Nova states whether
a chosen project space can run the app without exposing the downstream
switches that establish that fact.
