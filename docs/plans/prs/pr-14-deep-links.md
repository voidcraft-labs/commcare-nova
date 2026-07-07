# PR-14: Deep links — session endpoints + smart links

*Self-contained implementation plan. Reference rationale:
`docs/plans/2026-07-06-f7-navigation-workflow.md` (facts 7–8) — but this PR supersedes that
plan's "slice B deferred" posture per the owner's scope ruling: **this is a full
implementation plan, not a spec placeholder.** Depends on PR-13 (navigation machinery).
Wave 2 (personas) makes the preview simulation richer but is NOT required.*

**Goal.** Every module and form can mint a **session endpoint** — a stable id that outside
systems (and other CommCare apps) can deep-link to, with arguments for the case selections
the target screen needs — emitted per the verified suite shapes, simulated in the preview,
and surfaced as copyable Web Apps URLs after upload. The **smart-link emission machinery**
(the `<jump>` stack step and URL construction) ships too; its *authoring* surface activates
only when Nova models data-registry search, which is stated as the one named prerequisite —
explicitly, with citations, not as a silent deferral.

## What the user gets

A "Deep link" toggle on a module or form producing, post-upload, a URL like
`https://www.commcarehq.org/a/<domain>/app/v1/<app_id>/<endpoint_id>/?case_id=<id>` that
drops a Web Apps user directly onto that screen (claiming the case into their sandbox if
needed). In the preview: an "open at deep link" affordance that runs the same argument
resolution so the flow is testable before upload.

## Verified contracts this PR relies on (do not re-derive; cite by these names)

- **HQ authoring fields**: `ModuleBase.session_endpoint_id`, `ModuleBase.case_list_session_endpoint_id`,
  `FormBase.session_endpoint_id` + `FormBase.respect_relevancy` (default True) +
  `FormBase.function_datum_endpoints` (`commcare-hq/.../app_manager/models.py`). Gated by
  `toggles::SESSION_ENDPOINTS` — TAG_FROZEN, NAMESPACE_DOMAIN (a deployment prerequisite on
  the target domain, carried in docs + the setup artifact; NOT a Nova authoring gate).
- **Suite emission** (`suite_xml/post_process/endpoints.py::EndpointsHelper`): one
  `<endpoint id="…">` per endpoint, `<argument id="…">` per selection-requiring datum
  (multi-select datums emit `@instance-id` + `@instance-src="jr://instance/selected-entities"`
  — `xml_models.py::Argument`), then a `<stack>` of **`<push>` frames** (not `<create>`):
  per case-id argument a claim push (`_add_claim_frame`: a `<datum>` + `<command
  value="'claim_command.<endpoint_id>.<arg_id>'"/>`), skipped for inline-search modules,
  then the navigation frame of commands + `<datum id value="$<arg_id>"/>` built by the SAME
  `WorkflowHelper.get_frame_children` machinery as end-of-form nav.
  `respect-relevancy="false"` emits only when False (`xml_models.py::SessionEndpoint.respect_relevancy`).
- **Web URL contract**: `/a/<domain>/app/v1/<app_id>/<endpoint_id>/?arg=…` →
  `cloudcare/views.py::session_endpoint` (gates on the toggle, resolves the latest build,
  redirects into the Web Apps SPA with `{appId, endpointId, endpointArgs}`).
- **Runtime execution** (`formplayer/.../MenuSessionRunnerService.java::advanceSessionWithEndpoint`):
  arguments bind as XPath **variables** (`Endpoint.populateEndpointArgumentsToEvaluationContext`
  → `setVariable`; missing/unexpected args throw `InvalidEndpointArgumentsException`,
  user-visible "Invalid arguments supplied for link. Missing arguments: …"); stack ops replay
  **one at a time**, checking for a sync/claim screen after each and running `doPostAndSync`
  mid-sequence (claim failure → "Unable to claim case."); then
  `rebuildSessionFromFrame(respectRelevancy)` re-derives the selection path and replays it —
  with `respectRelevancy=false` walking `getAllChoices()` (traverses menus/cases display
  conditions would hide).
- **Smart links** (`suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_stack`
  / `::get_smart_link_function` / `::get_smart_link_variables`): a `PushFrame(if=not(<case
  domain == user domain>))` carrying a `StackJump` (`xml_models.py::StackJump`, `<jump><url>`)
  whose URL is an XPath `concat('https://…/a/', $domain, '/app/v1/<app_id>/<endpoint_id>/',
  '?arg=', $arg, …)` over the CASE's domain; the same-domain branch rewinds instead.
  Formplayer surfaces `smartLinkRedirect` and the SPA hard-navigates (cloudcare
  `menus/api.js`; refuses in App Preview). **Authoring precondition**:
  `util.py::module_uses_smart_links` requires registry search AND
  `CaseSearch.data_registry_workflow == 'smart_link'` — a data-registry feature Nova does not
  model. The `jump` stack STEP itself is plain runtime vocabulary
  (`commcare-core/.../xml/StackFrameStepParser.java` — steps `datum, instance-datum, command,
  query, mark, rewind, jump`; jump sets a redirect URL and terminates the push early).
- **`case_fixture` hydration**: `workflow.py::WorkflowQueryMeta.to_stack_datum` rewrites a
  query datum's URL `/phone/search/` → `/phone/case_fixture/` to hydrate a single known case
  without a live search — relevant to smart-link targets; recorded for the activation PR.

## Build

### 1. Domain (`lib/domain`, `lib/doc`)

- `moduleSchema.endpoint?: { id: string, respectRelevancy?: boolean }` and
  `formSchema.endpoint?: { id, respectRelevancy? }`. `id`: slug rules via
  `identifierVerdicts`-style checks, **unique across the app** (endpoints share one
  namespace on the wire); `respectRelevancy` defaults true (absent = true; only `false`
  stored). HQ's `case_list_session_endpoint_id` is covered structurally: a `caseListOnly`
  module's endpoint IS its case-list deep link — stated in docs, not silently dropped.
  HQ's `function_datum_endpoints` (arguments for computed datums) is a named non-goal (no
  Nova consumer: Nova's computed datums — usercase id, generated case ids — are derivable,
  never caller-supplied); revisit only with a concrete external integration asking for it.
- Rides `updateModule`/`updateForm` clearable patches (top-level slot; `null` clears).
- Reference/registry: endpoint ids join the app-unique identifier scan; no expression slots.
- Validator (gating soundness + repair judgments): `ENDPOINT_ID_INVALID` /
  `ENDPOINT_ID_DUPLICATE`; endpoint on a form whose module cannot derive its datums
  statically is impossible by construction (arguments derive from the same
  `deriveSessionDatums` the entry uses); `respectRelevancy: false` is legal but surfaces the
  authoring affordance note (§4).

### 2. Wire emission (`lib/commcare`)

- A post-suite endpoints step in `compiler.ts` (after menus/entries exist): per endpoint,
  `<endpoint id>` + `<argument id>` per **selection-requiring** datum of the target (module
  endpoint → the module's case-first datum chain; form endpoint → the form's entry datums),
  multi-select datums emitting the verified `@instance-id`/`@instance-src` shape (wave-1
  multi-select from PR-03/06); then the `<push>` stack: claim frame per case-id argument
  with the exact `claim_command.<endpoint_id>.<arg_id>` convention, then commands +
  `<datum id value="$<arg_id>"/>`. **Verify-first item (named for the implementer):** how
  HQ resolves `claim_command.*` command ids to claim `<remote-request>` entries — read
  `endpoints.py` + its remote-requests wiring fully and mirror the complete shape (the claim
  command must reference an emitted claim request; pin the HQ endpoint suite fixtures —
  locate them under `corehq/apps/app_manager/tests/` by grepping `endpoint`).
- `respect-relevancy="false"` attribute only when set.
- HQ-JSON projection: `session_endpoint_id` on module/form shells + `respect_relevancy` on
  forms (HQ regenerates its own endpoints — the verified fields exist for exactly this).
- Suite oracle: endpoint id uniqueness; argument ids match the target's datum ids; stack
  steps within the closed vocabulary (add `jump` to the accepted step set now — smart-link
  machinery); claim command references resolve.
- The **smart-link `<jump>` emission helper** lands here (URL `concat` builder over a domain
  variable + endpoint id + args, per `get_smart_link_function`'s shape) with tests — unused
  by any authoring surface until registry search exists (§5).

### 3. Preview (`lib/preview`, `components/builder`)

- "Open at deep link": pick an endpoint, supply each argument (case picker filtered to the
  argument's case type; free-text id accepted), then run the SAME resolution the runtime
  does — bind args, walk the datum chain, land on the target screen. Missing/unknown args
  reproduce the runtime's error message shape. `respectRelevancy: false` is simulated
  faithfully (navigates into hidden menus, visibly labeled). Persona-aware once wave 2
  lands (the case picker + visibility then respect the active persona); works
  persona-less today.

### 4. Builder UI + SA + docs

- UI: endpoint sections in the module/form settings panels (id + relevancy toggle + the
  caveat copy); post-upload, the app's endpoints list with **copyable URLs** in the deploy
  surface (`https://www.commcarehq.org/a/<domain>/app/v1/<app_id>/<endpoint_id>/` + arg
  template). The `SESSION_ENDPOINTS` toggle prerequisite joins the setup-artifact/docs
  prerequisites (PR-11's artifact when present; docs regardless).
- SA tools: `endpoint` params on `update_module`/`update_form` (MCP propagates); guidance —
  mint endpoints for external launch points and cross-app handoffs; endpoint ids are
  external contracts (renaming breaks published links — say so before renaming); and the
  security/UX caveat verbatim: **`respectRelevancy: false` lets a link reach screens display
  conditions hide — display conditions are UX, not access control.**
- Docs: a deep-links page — the URL contract, argument passing, the claim-on-entry behavior
  ("opening a link to a case you don't have claims it into your workspace"), the toggle
  prerequisite, and the smart-links activation note (§5).

### 5. Smart links — machinery now, authoring surface gated on a NAMED prerequisite

Everything smart links need that is endpoint-shaped ships in this PR (endpoints, args, the
`jump` emission helper, oracle vocabulary). What remains is not a deferral but a missing
prerequisite FEATURE, stated with citations: smart-link authoring requires **data-registry
search** (`module_uses_smart_links` = registry search config +
`data_registry_workflow='smart_link'`) — cross-domain case registries that Nova's case-search
model does not include. The docs and this plan say exactly that: "smart links activate when
Nova models registry search; the emission machinery is already in place" — so the follow-on
is a case-search-registry feature decision, not lost work here.

## Tests / acceptance

- Emission fixtures pinned against HQ's endpoint suite outputs (module endpoint, form
  endpoint with case datum, multi-select argument, respect-relevancy=false, claim frame +
  its resolved claim request) — locate + name the HQ fixtures in the first commit.
- Oracle: id uniqueness, argument/datum coherence, `jump` step accepted, claim-command
  resolution.
- Preview simulation state tests: arg binding, missing-arg error parity, hidden-menu
  traversal under respectRelevancy=false.
- Validator matrices; `lint/typecheck/test` clean; emitter fuzz grows endpoint arms.

## Non-goals

Registry search / `data_registry_workflow` modeling (the named smart-link prerequisite).
`function_datum_endpoints` (reason stated in §1). Endpoint analytics/rotation.

## Open choices (implementer)

- Endpoint id mutability: recommend editable with a loud "published links break" confirm
  (external contract), not immutable — pilots iterate.
- Where the copyable-URL list lives (deploy panel vs per-entity settings) — recommend both,
  one source component.
- Whether the preview's "open at deep link" also encodes a shareable internal preview URL
  (nice for team review; cheap if `lib/routing` already carries location state — check
  first).
