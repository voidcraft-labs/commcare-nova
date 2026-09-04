# Session endpoints and deep links

**PR:** `Session endpoints and shareable deep links`

**Depends on:** nothing outstanding. The shipped
[one-tier menu contract](../complex-app-plan.md#one-tier-nested-menus) and
[multi-select datum contract](../complex-app-plan.md#multi-select-case-workflows)
are inputs, not remaining units.
· **Blocks:** nothing.

A shareable link must resolve to a *released* build whose referenced tables and
locations already exist on the target — linking into an app whose lookup tables
were never pushed produces a dead claim frame at runtime rather than a
build-time error. Publishing puts both there, so that half is shipped.

> Read [the binding contracts](00-contracts.md) first — the HQ deployment safety
> contract there names the two hardcoded US hosts this unit must retire, and
> [what is built](../complex-app-plan.md#display-conditions) states why
> `respect-relevancy="false"` is not an access-control bypass Nova introduces.

Verify claim-command resolution against current HQ fixtures **first** — the claim
push is the part most likely to have drifted. The emitted frames are asserted
against `session_endpoint_remote_request.xml` and
`session_endpoint_remote_request_multi_select.xml`, both directly under
`commcare-hq/corehq/apps/app_manager/tests/data/` rather than the `suite/`
subdirectory.

Endpoints depend on durable released deployments, use the selected server, reject
flattened modules, preserve tenant authorization even when relevancy is bypassed,
and distinguish internal preview routes from shareable HQ links. Registry-search
smart links stay out of scope.

This is also the unit that must retire the two hardcoded US hosts named in
[HQ deployment safety](00-contracts.md#hq-deployment-safety): a deep link that
ignores the selected server sends an India or EU deployment's users to the wrong
cluster.

## Binding facts

- Nova never emits an endpoint for a
  [no-matches registration form](../complex-app-plan.md#register-when-nothing-matches) and never offers
  `respect_relevancy=false` toward one: that form is reachable only through the
  Register action after a completed empty search, and a link that replays it
  without the search-input instance would open it with every carried answer
  blank.
- HQ's authoring fields are `ModuleBase.session_endpoint_id`,
  `ModuleBase.case_list_session_endpoint_id`, `FormBase.session_endpoint_id`,
  `FormBase.respect_relevancy` (default True), and
  `FormBase.function_datum_endpoints`. The whole feature is gated by
  `toggles::SESSION_ENDPOINTS` (frozen, domain-namespaced) — **a deployment
  prerequisite on the target domain**, carried in docs and the setup artifact,
  never a Nova authoring gate.
- Emission is one `<endpoint id>` per endpoint, one `<argument id>` per
  selection-requiring datum (multi-select arguments additionally carry
  `@instance-id` and `@instance-src="jr://instance/selected-entities"`), then a
  `<stack>` of `<push>` frames — **not** `<create>` — with a claim push per case-id
  argument (a `<datum>` plus
  `<command value="'claim_command.<endpoint_id>.<arg_id>'"/>`, skipped for
  inline-search modules), followed by the navigation frame built by the **same**
  `WorkflowHelper.get_frame_children` machinery as end-of-form navigation.
  `respect-relevancy="false"` is emitted only when False.
- `respect_relevancy` exists **only** on `FormBase`, and `EndpointsHelper` passes
  it only for form endpoints. A module-level toggle would emit into a local `.ccz`
  and then silently revert to true after HQ regeneration, so Nova must not offer
  the slot on modules.
- A case-list endpoint **excludes** the trailing selection datum
  (`should_add_last_selection_datum=False`): no `case_id` argument and no claim
  frame for it, so the link lands on the list rather than on a selected case.
- Runtime execution: arguments bind as XPath **variables**
  (`populateEndpointArgumentsToEvaluationContext` → `setVariable`), and
  missing/unexpected arguments throw `InvalidEndpointArgumentsException` with a
  user-visible "Invalid arguments supplied for link. Missing arguments: …". Stack
  ops replay one at a time, checking for a sync/claim screen after each and running
  `doPostAndSync` mid-sequence (claim failure → "Unable to claim case."), then
  `rebuildSessionFromFrame(respectRelevancy)` re-derives and replays the selection
  path — and with `respectRelevancy=false` it walks `getAllChoices()`, traversing
  menus and cases that display conditions would hide.
- `workflow.py::WorkflowQueryMeta.to_stack_datum` rewrites a query datum's URL
  from `/phone/search/` to `/phone/case_fixture/` to hydrate a single **known**
  case without running a live search — the mechanism any deep link landing on a
  specific case without a search screen depends on.
- The public web URL contract is
  `/a/<domain>/app/v1/<app_id>/<endpoint_id>/?arg=…` →
  `cloudcare/views.py::session_endpoint`, which gates on the toggle, resolves the
  latest build, and redirects into the Web Apps SPA.
- `jump` is a frame **step** that sets a redirect URL and terminates the push
  early — never a stack op.
- An endpoint replays the authored navigation frames without Nova adding an
  automatic-menu profile setting. A menu with one available choice remains a
  real step in both ordinary use and a deep-link reconstruction.

**Observed:** an author copies a link that opens a specific case in a specific
form, and is told plainly when the target domain lacks the required toggle.
