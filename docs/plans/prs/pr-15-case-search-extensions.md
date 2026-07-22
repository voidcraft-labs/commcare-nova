# PR-15: Case-search extensions + app-profile properties

> [!WARNING]
> **Execution superseded (2026-07-21).** Keep this document as verified wire evidence and
> design rationale, but do not execute its PR shape, sequencing, dependencies, or acceptance
> checklist directly. The authoritative implementation stages and gates are in the
> [complex-app roadmap](../complex-app-roadmap.md).

*Self-contained implementation plan. Added at final review (2026-07-07): these F4-plan §4
EXT items were scoped IN by owner ruling but had fallen between PR-03 and PR-07/08 — this
PR is their home. Reference rationale: `docs/plans/2026-07-06-f4-case-operations.md` §1
facts 14–17 + §4. Depends on PR-03 (search/entry emitters), PR-06 (SA/docs surfaces to
extend); runs after PR-08 in wave 1 (last of the wave — it extends the same case-list and
search emitters).*

**Goal.** Three verified, wire-alive capabilities the reference apps lean on: **multi-select
case lists** (pick several cases, the form runs once over the set — the multiplicity source
for F4 ops via `forEach`), **related-case search pulls** (a search result drags its
related cases into the result set), and **app-profile custom properties** (the
`cc-sync-after-form` family). Plus the SA/docs rows for each.

## 2026-07-21 rebaseline

- **Execution mapping:** roadmap **S25** owns these case-search/profile extensions after the
  selected-case operation contract is ready. Preserve the three verified wire contracts
  below, but do not treat them as one undifferentiated acceptance story.
- **Multi-select runtime contract:** `<instance-datum>` emission is insufficient by itself.
  Preview and runtime must materialize the selected-case set, feed it into `query_bound`
  repeats, and execute the corresponding per-selected-case operations. Incompatible ordinary
  single-case preload/update/close behavior must be rejected or explicitly lowered through
  that selected-case path.
- **Multi-select UX contract:** selection and the configured `1..100` cap must survive result
  pagination, changed searches, and back-navigation; Continue is unavailable with no
  selection, and cap errors are actionable. Test selections that span multiple result pages.
- **Separate acceptance:** multi-select, related-case pulls, and profile properties each need
  their own local-preview behavior, local-suite and HQ-JSON fixtures, validator/UI coverage,
  and user-phrased acceptance. Passing selection → repeat → operations does not establish
  related-case expansion or profile-property parity.

## Verified contracts (inline; all re-verified 2026-07-06 at source)

- **Multi-select**: the SHORT detail carries `multi_select = BooleanProperty` +
  `max_select_value = IntegerProperty(default=100)` (`commcare-hq/.../models.py::
  case_details.short`); emission swaps the case datum class — `<instance-datum … max-
  select-value="N">` instead of `<datum>` (`suite_xml/post_process/remote_requests.py::
  build_remote_request_datums`; `xml_models.py::InstanceDatum`). Runtime: selected ids
  materialize as a virtual instance (`jr://instance/selected-entities/…`,
  `<results><value>` shape — `commcare-core/.../VirtualInstances.java`); forms read
  `instance('selected_cases')…` (HQ adds that instance in `xform.py::_create_casexml`'s
  multi-select branch); the client enforces the cap (`SessionDatumParser.DEFAULT_MAX_SELECT_
  VAL = 100`, `MultiSelectEntityScreen.validateSelectionSize`); claim is ONE POST carrying
  all ids (HQ loops server-side; 204 = already claimed —
  `formplayer/.../MenuSessionRunnerService.doPostAndSync`, `WebClient.caseClaimPost`).
  **The op-multiplicity bridge**: "for each selected case" = a `query_bound` repeat whose
  `ids_query` reads the selected-entities instance, then F4 ops `forEach` that repeat — one
  mechanism, already specced (PR-01's forEach; PR-03's repeat emission).
- **Related-case pulls**: `CaseSearch.include_all_related_cases` / `custom_related_case_
  property` emit as `<data key="x_commcare_include_all_related_cases" ref="'true'"/>` /
  `x_commcare_custom_related_case_property` on the `<query>` (`remote_requests.py`); server
  behavior `case_search/utils.py::get_related_cases_result/get_expanded_case_results`.
  Result-instance nodesets append `[not(commcare_is_related_case=true())]`
  (`case_search/const.py::EXCLUDE_RELATED_CASES_FILTER`) so pulled relatives ride the
  instance without polluting the visible list.
- **Profile custom properties**: `profile.custom_properties` ride the app JSON untouched at
  import and emit as `<property key value force="true"/>` — on HQ **only when the domain
  has the `CUSTOM_PROPERTIES` toggle** (TAG_FROZEN; `models.py::create_profile`); Nova's
  local `profile.ccpr` is ungated (Nova writes it — `lib/commcare/compiler.ts::
  generateProfile`, today a hardcoded list; the HQ-JSON type `HqApplication.profile.
  properties` is `Record<string, never>` and must widen). The three verified keys and their
  formplayer effects: `cc-sync-after-form` (sync after every submission —
  `FormplayerPropertyManager::isSyncAfterFormEnabled`), `cc-auto-advance-menu`
  (single-visible-choice menus self-select and drop out of the breadcrumb —
  `MenuScreen::handleAutoMenuAdvance`, `PersistentMenuHelper`), `cc-index-case-search-
  results` (`CaseSearchHelper`). Lifecycle: all alive; several OTHER CaseSearch fields are
  REMOVED upstream (search_label, additional_relevant, dynamic_search, search_filter —
  model docstring) and must not be reproduced.

## Build

1. **Domain**: `caseListConfig.multiSelect?: { maxSelect?: number (≤100 default 100) }`
   (legal only on case-first modules with search or case list — mirror HQ's short-detail
   placement); `caseSearchConfig` gains `includeAllRelatedCases?: boolean` and
   `relatedCaseProperty?: string` (catalog-checked property name); app-level
   `profileProperties?: { syncAfterForm?, autoAdvanceMenu?, indexSearchResults? }` (three
   NAMED booleans — no generic key-value escape, per the F4 plan's recommendation).
   Validator rules + class rows + repair judgments (multi-select × form-type constraints:
   the selection instance only feeds `query_bound`/ops — a case-loading form's single
   `case_id` datum is incompatible with multi-select, mirror HQ's `registration from case
   list`-era rules by rejecting case-loading forms in multi-select modules unless they
   consume the selection repeat; verify HQ's exact constraint at build time from
   `helpers/validators.py` and mirror it).
2. **Wire**: `<instance-datum>` emission with `max-select-value` (both suite paths — local
   entry derivation in `lib/commcare/session.ts` + HQ JSON `multi_select`/
   `max_select_value` on the short detail); the selected-entities instance declaration in
   consuming forms; the two query `<data>` keys; profile: widen the HQ-JSON type + emit the
   three properties in `generateProfile` and the app JSON, with the HQ-path
   `CUSTOM_PROPERTIES` toggle caveat carried in docs + the deployment notes (the wave-2
   artifact gains the row when PR-11 lands; until then it lives in the export docs).
   Fixtures: pin `<instance-datum>` and query-key emission against the HQ suite tests named
   in the F4 plan (`remote_requests` fixtures); suite-oracle arms for the new shapes.
3. **Preview**: multi-select case list UX (checkbox selection up to the cap, one "continue"
   action), the selection instance feeding `query_bound` repeats + ops `forEach`;
   related-case pulls approximated faithfully (the preview's search already queries
   Postgres — pull relatives via `case_indices` one hop + the property-expansion hop,
   excluded from the visible list like the wire filter); profile properties affect the
   preview where they have meaning (`autoAdvanceMenu`: single-visible-choice menus
   auto-advance; `syncAfterForm`: no-op locally, documented).
4. **Builder UI + SA + docs**: multi-select toggle + cap on the case-list workspace;
   search-config advanced rows; an app-settings card for the three profile flags with
   per-flag "what this does" copy (auto-advance includes the breadcrumb-collapse caveat);
   SA params + guidance (multi-select as the fan-out selection source; sync-after-form
   recommended for claim-heavy designs — wave-2 note); tools.mdx + docs rows.

## Tests / acceptance

Fixture-pinned emission (instance-datum, query keys, profile properties on both paths);
preview selection→repeat→ops round-trip; cap enforcement; validator matrix; user-phrased:
"I turn on multi-select, pick three clients, submit one form that updates all three — in
the preview and on Web Apps."

## Non-goals

Claim-post-on-entry (F4 tier b, unchanged); smart-link/endpoint interplay (PR-14 owns);
generic custom-property passthrough (named flags only — widening is a new decision).

## Open choices (implementer)

- The exact HQ validator constraint for form types under multi-select (verify at
  `helpers/validators.py` and mirror; the plan's rule above is the expected shape).
- Whether the preview's related-case pull matches server semantics exactly on the
  property-expansion hop or one-hop-only in v1 (recommend exact — it is one more join).
