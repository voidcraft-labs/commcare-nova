# lib/commcare

One-way emission boundary: `BlueprintDoc` → CommCare wire formats (XForm XML, `HqApplication` JSON, `.ccz` archive). The only package in `lib/` that imports CommCare's vocabulary (HQ shell shapes, `doc_type` strings, XPath functions, session datums, identifier rules). A Biome `noRestrictedImports` rule enforces the one-way direction.

## Client-safe barrel

The `./index.ts` barrel must stay client-safe: Node-only modules (`./compiler` via `adm-zip`; `./ids` via `node:crypto`) and the heavy emission pipeline (`./expander`, `./xform`) are imported from explicit sub-paths so Turbopack tree-shakes them out of client bundles. The XPath engine, validator, encryption, and HQ HTTP client follow the same sub-path rule. The allowed-consumer set lives in `biome.json`'s `noRestrictedImports` rule — read it there; a copy here drifts.

## Key design decisions

### Multilingual emission is one derived projection

`localization.ts` is the emission facade over the domain translation inventory.
Every configured language receives a complete effective value projection; a
missing or stale target entry falls back to the current canonical source. HQ
JSON language maps, XForm itext blocks, suite locale-variable links, and local
CCZ app-string directories all consume that projection rather than cloning or
mutating `BlueprintDoc`. Exactly one XForm translation is default, every
translation covers the same itext IDs, and every localized suite app-string
table covers the same locale IDs. The XForm and suite oracles enforce those
properties for every language, not only the runtime default.

Optional XForm itext entries and their body/bind references are gated on
effective content across every configured language, not source content alone.
Suite multi-select option filtering carries original catalog indexes through to
localized variables. Direct-CCZ app-string values serialize through Core's
actual locale grammar (`\#` comments and `\n` line breaks) and fail closed for
literal backslash-`n` or boundary content that the grammar cannot round-trip.

A local CCZ emits Classic's initialization-only `default` locale resource and
one named resource for every configured language, including the default
language. Both tables for the default language carry the same effective values.
CommCare Android removes only the literal `default` locale from its language
picker, so the named copy is required to let a worker switch back to the app's
default language.

The app language catalog uses Nova identity tags until this boundary.
`languageWire.ts::planLanguageWire` is the one tag→wire-code mapping,
computed once per emission and total and injective by construction: each
identity's preferred spelling is its Classic catalog row's code — reached
directly or by widening a macrolanguage member through
`classicWideningTarget` (`cmn` widens through `zho` to Classic's Chinese
row) — three-letter except the four grandfathered two-letter rows
(`eng`→`en`, `spa`→`es`, `swh`→`sw`, `afr`→`af`); an identity with no
Classic reach emits its Set 3 code, which is always wire-valid. Identities
colliding on one preferred spelling each take a single lowercase suffix
segment (`cmn-Hans`/`cmn-Hant` → `cmn-hans`/`cmn-hant`) because Classic's
grammar allows exactly one hyphen; a final injectivity assert throws as a
compiler bug. Device-picker name rows come from the registry's baked display
labels at the most specific key — never runtime `Intl`, whose Node/ICU
variance must not reach wire bytes. HQ `langs`, localized property maps,
itext language/default attributes, `default/app_strings.txt`, per-language
directories, endonyms, and `lang.current` are one-way CommCare wire
spellings here. Two-letter language codes exist nowhere outside this
directory; `classicLanguages.ts` (over
`config/commcare-classic-languages.json`) is wire data quarantined here, and
its only consumers are the wire plan and the language-identity migration
script. An `eng`-only app — including every app with an absent localization
root — emits byte-identical output to the historical `en`-only shape.

### CommCare HQ project-space compatibility

Public surfaces speak only semantic capabilities from
`lib/publish/projectSpaceCompatibility.ts`: Case search, CommCare Connect,
attachments saved to cases, and links to captured files. Literal HQ setting
names, namespaces, and raw probe arrays live only in
`config/commcare-hq-feature-flags.json`, `projectSpaceCompatibility.ts`, and the
server-side HQ client. They are implementation details, never settings a person
or an agent chooses. Add a private catalog entry only with an actual Nova
emitter and exact current HQ source evidence. Remove or update it when the
upstream setting graduates or changes; never retain retired settings as history.

Direct publish preflight checks the selected project space before any remote
write. Domain-only settings use the `UserDomainsResource` filter. A
negative result is missing only after the unfiltered endpoint proves the target
is still visible; transport, shape, namespace, and unknown-setting failures are
unverified. Current HQ returns the complete unpaginated list with one numeric
`meta.total_count`; the sibling paginator that returns a null count does not own
this endpoint. Case search has an additional qualified read against the mobile
Search endpoint, which checks both its base toggle and `CaseSearchConfig.enabled`.
HQ accepts an API key there but separately requires the connected web account's
Mobile App Access permission; a 403 is therefore a permission-specific
unverified result, never evidence that Search is missing. Only the exact
configured-off 404 is missing, and no result body is retained or logged.
Only a Search field with a starting value adds the private child setting to the
SAME public Case search capability, because HQ omits `<prompt default>` without
it. HQ still emits and executes `_xpath_query` filters without that setting;
the disabled path records telemetry but does not reject the query. Missing or
unverified required capabilities block before writes.
The large-search performance check is advisory: it controls only whether Nova
can add its derived Search optimization and never blocks publishing or removes
Search.

JSON and CCZ have no target project space, so compatibility is `not_checked`.
The weekly `commcare-hq-feature-flags` workflow runs
`scripts/audit-commcare-hq-feature-flags.mjs` against current upstream HQ and
fails when private symbols, names, namespaces, tags, runtime gates, or probe
behavior drift. That failure is the retirement/GA or probe-compatibility review
signal.

Nova derives profile properties from app behavior; they are not authored
settings and never enter `BlueprintDoc`. Effective remote Search derives
`cc-index-case-search-results=yes`, which indexes Search results in CommCare's
temporary case storage and does not request or imitate a sync. Local CCZ emits
the property because its supported runtime is fixed. Targetless HQ JSON carries
the derived property as intent. Direct publishing includes it when the selected
project space supports the performance advisory. An inconclusive advisory
preserves the target's current owned value on update; confirmed missing support
removes it, as does removing Search from the app.

HQ shallow-replaces the full `profile` object when an import includes one, so
in-place updates read and validate the current source profile immediately
before import. Nova preserves every foreign profile section and custom property,
changes or removes only `NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS`, and omits
`profile` entirely when its owned state is already correct. A source read or
shape failure stops the app import; never invent an empty profile bag. New apps
have no target state to preserve. `_attachments` remains the final HQ JSON key
after every projection.

### Shared field-string accessor

`fieldProps.ts::readFieldString(field, key, doc)` is the one expression-reading helper the wire emitters share: expression slots (`relevant`, `validate`, `calculate`, `default_value`, `required`, the repeat slots, `label`, `hint`, …) delegate to the domain's `expressionSource`, which projects typed AST storage to text against `doc` — identity references resolve to CURRENT names at every read. It accepts only the registry's expression-slot IDs; non-expression data uses typed domain accessors. Case bindings use `fieldCaseWrite(field)` and remain independent from the field's friendly id.

### Worker-information identity projection

Custom worker information has one stable document identity and two authored AST
spellings. Predicate / ValueExpression stores
`session-user-property { userPropertyUuid }`; XPath stores
`user-property-ref { userPropertyUuid }`. Every wire emitter receives the
current UUID→slug map and throws if an identity has no binding — the commit
validator should have caught the dangling reference, and silently emitting a
UUID or stale name would corrupt behavior. The separate name-backed
`session-user { field }` and XPath `user-ref { property }` arms are exclusively
for CommCare-provided or external fields with no Nova entity. Worker-property
slugs begin with a letter or underscore and admit hyphens only after that first
character: both session and usercase emit the slug as an XML element, so this
XML-safe intersection is stricter than HQ's Django slug validator. The HQ JSON,
local XForm, and local suite fixtures pin a hyphenated slug to exact emitted
bytes.

The emitted paths are pinned to named CommCare authorities:
`test_suite_remote_request.py::test_required` for
`instance('commcaresession')/session/user/data/<slug>`,
`suite-case-detail-tabs-with-nodesets.xml` for the usercase selector
`instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/<slug>`,
and the corresponding suite session path. The HQ JSON, local suite/XForm, and
HQ-upload XForm tests assert those exact bytes and re-run them after a slug
rename without changing the stored AST.

### Capture uploads — a closed enum, not a conditional

`xform/captureUpload.ts` owns the `<upload mediatype>` vocabulary. It is a table rather than a conditional because an unmatched `mediatype` does not fail: `XFormParser::parseUpload` matches with literal `String.equals` against exactly four strings (`image/*`, `audio/*`, `video/*`, `application/*,text/*` — comma, NO space), anything else leaves the control at `CONTROL_UPLOAD`, `entries.js::getEntry` falls through to `UnsupportedEntry`, and that constructor SETS the answer to the literal string `Not Supported by Web Entry`, which submits. Silent bad data, not a visible error — so `UploadMediatype` admits only the four literals and `UPLOAD_MEDIATYPE_BY_CAPTURE_KIND` is total over `captureFieldKinds`, making the bad state unrepresentable. Signature shares `image/*` and is split out by `appearance="signature"`; `appearance="face"` and `jr:imageDimensionScaledMax` stay out because both are inert on every runtime Nova targets.

`build_spec.version` in `hqShells.ts` is fixed output metadata for Nova's one application-shell target (`2.54.0`). It is not a feature floor, reader gate, or capability switch; no producer or runtime branch may consult it. The upload path is declarative (`import_app` deletes `build_spec`; `ApplicationBase.wrap` substitutes the domain default).

### Vellum dual-attribute pattern

Real attributes (`calculate`, `relevant`, `constraint`, `required`) get the expanded instance XPath — the only thing the device/validator parses; `vellum:` shadow attributes carry the shorthand HQ's form designer treats as source of truth on round-trip. Every bind also gets `vellum:nodeset="#form/..."`.

Shadows emit ONLY vocabulary the editor is GUARANTEED to know for the form, never merely plausible vocabulary: an unknown hashtag makes the editor's XPath engine (`Vellum/src/xpath.js::isValidNamespace`) mark the whole expression unparseable and re-serialize it VERBATIM into the real attribute on the user's next save — raw hashtags on the wire, failing HQ's next build ("Couldn't understand the expression"). `hashtags/formContext.ts::vellumShorthandInContext` is the projection, and the guaranteed set is small: `#form/` (always), and `#case/<prop>` (single plain segment, the form's OWN loaded case) on `followup`/`close` forms — those upload with `requires: "case"`, and `casedb_schema.py::get_casedb_schema` gates the case data sources on `form.requires_case()` with generation 0 unconditional inside the gate. Everything else is only conditionally present in HQ and suppresses the shadow (the expanded real attribute round-trips as plain XPath, and the editor's reverse map re-derives the shorthand when it does know the vocabulary): `#user/` is gated on `domain_has_usercase_access` (a target-domain privilege, off by default, unknowable at emission); `#case/parent/`/`#case/grandparent/` exist only when the app's own forms establish the relationship (`case_properties.py::get_case_relationships` derives generations from in-app subcase actions, NOT from any catalog — Nova's catalog parent link doesn't imply them); registration/survey forms have no case vocabulary at all. There is NO way to teach the editor more: it reads hashtag metadata only from head elements, only as a pre-datasources fallback, and `Vellum/src/form.js::_updateHashtags` resets namespaces to `#form` + data sources once they load.

Two attribute names are not what you'd guess, both verified against `Vellum/src/parser.js` (only POPPED attributes round-trip; an unread `vellum:*` attribute lands in `rawBindAttributes` and accretes an extra prefix on every editor save — HQ's own wash template app carries `vellum:vellum__required` chains from this): a conditional required's shadow is `vellum:requiredCondition` (never `vellum:required`; the bare `requiredCondition` attribute Vellum itself writes is deliberately NOT emitted — JavaRosa ignores it with an "unrecognized attributes" warning and rebuilds the condition from `required`), and a repeat count's shadow is `vellum:jr__count` (`:` → `__`; emitted only on the direct-path branch — shadowing the raw expression on the hoisted branch would arm the editor's next save to write a non-path into `jr:count`).

Form-wide hashtag metadata rides HEAD elements after `</model>` — `<vellum:hashtags>` (each shadowed case ref → its expansion) + `<vellum:hashtagTransforms>` (`{prefixes}` table) — built by `hashtags.ts::buildVellumTransforms`, omitted when no ref earned a shadow. Vanilla Vellum serializes its ENTIRE known-transforms table while Nova emits only the prefixes its shadowed refs use — per-entry the prefix→expansion strings match HQ's template apps exactly, but the table as a whole is a subset (both satisfy the sole consumer, `parser.js::initHashtags`, which looks prefixes up per ref). Never as per-bind attributes: the editor doesn't read those, and they accrete (see above). `case_references_data.load` is a SEPARATE vocabulary with looser rules (`hashtags.ts::hqLoadReference`): it's string-parsed HQ metadata, not editor-expanded XPath, so per-type refs land there at every depth — generation form through `grandparent`, parent-chain past it (`app_case_metadata.py::_parse_case_type` recognizes only `#case/`/`#user/` prefixes and normalizes `grandparent/` to `parent/parent/`) — except a registration form's `#case/case_id`, which is a form-local read, not a case load.

### Bare hashtags in prose

Reference-capable label/hint text is a typed `ProseTemplate`; only explicit reference atoms lower to `<output>`, while hashtag-looking text remains literal. `lib/domain/hashtagSegments.ts` still owns the friendly projection's segment vocabulary for editor chips and, via `xpath/__tests__/hashtagMatchers.divergence.test.ts`, keeps that projection in lockstep with the Lezer grammar's `HashtagType`/`HashtagSegment` tokens.

### Markdown itext

All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`. Safe for plain text: identical rendering when no markdown syntax is present.

### Secondary instances

`casedb`, `commcaresession`, and lookup fixtures are accumulated at the point of use through the structural `instance()` scanner — XPath field + label scans and Connect expression scans. A lookup id must be an XForm tag in the exact `LookupWireNaming` snapshot and declares that tag with the matching `jr://fixture/item-list:<tag>` source; an unknown literal fails closed. `casedb` implies `commcaresession`. One declaration happens outside `buildXForm`'s scan: `xform/caseBlocks.ts::addCaseBlocks` splices case-preload setvalues that read from `casedb` after the scan has run, so it declares `casedb` itself (idempotently) when it emits a preload.

`sessionContext.ts` owns Core's complete closed context-child namespace:
`deviceid`, `appversion`, `username`, `userid`, `drift`, `window_width`, and
`applanguage`. Both the binding-resolution oracle and Preview's structural
instance template consume that set. The primary instance root follows the same
rule: `xform/dataRootAttributes.ts` is the shared projection for emitted and
Preview-visible `uiVersion`, `version`, and slugged `name` attributes.

### `post_submit` defaults

Controls post-submit navigation. The stored and machine-authored vocabulary is
exactly `app_home`, `module`, or `previous`. `lib/commcare/session.ts` projects
those values one-way to the different workflow spellings required on the wire;
wire vocabulary never enters the domain. Form-type defaults when absent:
registration/survey → `app_home`; followup/close → `previous`, except in a
search-first module, where it is `module` (`lib/domain/forms.ts::defaultPostSubmit`
takes the module fact; `lib/domain/postSubmit.ts::effectivePostSubmit` is the
doc-level reader every consumer uses). HQ's build validator refuses `previous`
on a case-requiring form of an inline-search module, so the default cannot be
`previous` there. The SA only sets `post_submit` when overriding the default.

### Ordinary nested menus

Nova authors one tier: a root module and ordinary child modules. The domain
stores the parent UUID; `projectedModulePreorder` is the only wire order. HQ
JSON lowers a child to `root_module_id=<root unique_id>` while leaving
`put_in_root=false`; local suite XML lowers the same edge to
`<menu root="m{root}" id="m{child}">`. A child's own `module_filter` /
`<menu relevant>` remains its own condition. Never conjoin the parent's filter,
and never project this as `ShadowModule` or `put_in_root`.

HQ's `add_parent_datums` aligns a child entry against the root module's first
form. A form-less `caseListOnly` root therefore admits only same-case-type
children: they reuse the one `case_id` and need no alignment. A different-type
child is rejected by `NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM` at the commit
gate; it needs a form-bearing root so HQ can keep the two selections distinct.

`formLinkProjection.ts::entrySessionDatums` owns the entry namespace shared by
the suite, XForm, form links, and post-submit frames. First it builds the
parent-select chain from case-type relationships. Then, for a child menu, it
mirrors HQ's `add_parent_datums` against the root module's first form datums:
same-case selections at the same remaining position reuse the root id; an id
collision for a different case type becomes `case_id_<case-type>`; computed
root datums are carried; unrelated root selections are not. A parent-select
child therefore commonly emits root
`case_id` followed by child `case_id_<child-type>`, with the child nodeset's
index predicate refreshed to reference the final root id. Case-list-only child
entries use the same projection.

The selected own-case id is not assumed to be `case_id`. It is threaded into
form display conditions, executable hashtag expansion and Vellum metadata,
ordinary update/preload case blocks, and authored advanced case operations.
Every new case-reading carrier must consume this projection rather than add a
fresh `session/data/case_id` constant.

`entrySelectionDatumSources` is the non-wire provenance twin of that list: it
maps every final selected datum id back to the module whose menu/session case
supplies it. Preview uses those stable module UUIDs after its own menu/session
resolver has separated structural same-type inheritance from case ancestry;
form-link evaluation never guesses either relationship from a case type or id.

### After-submit links (`form_links`)

`Form.formLinks` is an ordered array of `{uuid, condition?, target, datums?}`;
CommCare's `form_links` spelling and the workflow words live only here. ONE
projector, `formLinkProjection.ts`, owns everything both paths emit (it imports
`buildFormActions` from `formActions.ts`, never the expander, so the preview
engine can reach it too); `session.ts::deriveFormLinkStack` and
`expander.ts::toHqFormLink` are its two printers.

- **Exclusive guards.** Core executes EVERY true `<create>` and lands on the
  LAST one (`CommCareSession::executeStackOperations` / `finishAndPop`), and HQ
  emits authored conditions raw (`workflow.py::_get_link_frame`; fixture
  `form_link_multiple.xml`: `if="a = 1"`, `if="a = 2"`). "First true link wins"
  is therefore Nova's to make true: `planFormLinkGuards` emits link i as
  `(c_i) and not(c_1) … and not(c_{i-1})` — the first link stays bare `c_i`,
  byte-identical to HQ's first frame, and the positive operand is parenthesized
  so a top-level `or` cannot fire two frames. A TERMINAL unconditional link is
  the exhaustive else: guard `not(c_1) … and not(c_{n-1})`, no fallback frame.
  A condition that prints to empty XPath is unconditional. The fallback frame
  is `postSubmit` guarded by `not(g_1) and … and not(g_n)` over the EMITTED
  guards — HQ's literal `' and '.join(f'not({xpath})')` in `_get_fallback_frame`
  over the `xpath`s Nova sends, so both paths derive identical bytes —
  and `app_home` (HQ `default`) emits no frame at all.
  `formLinkProjection.property.test.ts` proves exactly one guard-or-fallback is
  true under every assignment; `formLinkParity.test.ts` pins local `<create if>`
  against HQ `form_links[i].xpath` on one document.
- **HQ shape.** `form_links[]` is HQ's real `FormLink`:
  `{xpath, form_id, form_module_id, datums}` or `{xpath, module_unique_id,
  datums}` (`xpath: ""` = unconditional). `post_form_workflow` is `"form"` iff
  the form has links (HQ reads links only then); `post_form_workflow_fallback`
  is the `postSubmit` workflow word when a guarded fallback frame exists, else
  `null` (`WORKFLOW_FALLBACK_OPTIONS` is `None` — no choice validation). HQ
  re-ids forms on import (`update_form_unique_ids` rewrites `form_id`) and not
  modules, so the expander pre-generates every form unique id before the module
  map. `hqJsonOracle.ts::checkFormLinks` pins the shape and id resolution.
- **Frame children follow `WorkflowHelper.get_frame_children`** exactly:
  module command → longest common prefix (by datum id) of every FORM entry's
  datums in the target module → form command → the target form's remaining
  datums. A single-form module's whole datum list is that prefix, so its
  selection datum is hoisted AHEAD of the form command. For a child target HQ
  prepends the root module frame and its common user selections; a module target
  carries that root path plus the child command, while a form target carries the
  root path plus the child's ordinary form frame with duplicate aligned datums
  removed. A flat module target remains the module command alone. Auto-match
  (`datums` absent) mirrors `_find_best_match`: the FIRST source datum in
  source order with the same case type, excluding a child entry's root-copied
  placeholders (`WorkflowDatumMeta.from_parent_module`) — same id keeps the
  id, a different id carries `session/data/<source id>`; function datums carry
  their function (`uuid()`). Root-computed datums still emit on the child entry,
  but their weak provenance survives into `FrameDatum` so they cannot masquerade
  as a case created or selected by the child source form. Manual datums
  (`min(1)`, unique names) land on the target datums they name; a name the target
  never reads is `FORM_LINK_DATUM_UNUSED` (HQ's
  `_get_datums_matched_to_manual_values` iterates TARGET datums and drops it).
- **No runtime prompt on an unmatched datum.** HQ yields one as a self-named
  session ref (`<datum id="case_id"
  value="instance('commcaresession')/session/data/case_id"/>`), Core evaluates
  it to `""` at push (`StackFrameStep.defineStep`), `syncState` stores it, and
  `getFirstMissingDatum` checks only `containsKey` — the target opens with an
  EMPTY case id. So `FORM_LINK_DATUMS_INCOMPLETE` refuses any form target
  whose selection datum no source datum (auto) or no named datum (manual)
  satisfies, and only resolvable frames reach the wire. Nova is deliberately
  stricter than HQ here.
- **`previous`** — as `postSubmit` AND as the fallback frame — is the source
  entry's own frame children with the last child popped, popping again while
  the child just popped was a non-selection datum (`WORKFLOW_PREVIOUS` arm of
  `_get_static_stack_frame`): `[m, m-f]` for a followup in a forms-first
  module, `[m, case_id]` in a case-first one, `[m]` for a registration form
  beside other forms, and `[m, case_id_new_x=uuid()]` for a single-registration
  module (HQ's `form_link_tdh_with_fallback_previous.xml` keeps
  `case_id_new_visit_0=uuid()`). `derivePostSubmitStack` routes `previous`
  through the same projection, so the local suite matches HQ's build. A child
  previous frame begins with root command then child command before its aligned
  datums, matching HQ's `include_root_module=True` branch.
- **Session scope.** Core evaluates link conditions and datum XPath after the
  XForm instance has closed, with a NULL main instance
  (`CommCareSession::getEvaluationContext`; `XPathPathExpr::evalRaw` throws on
  `/data/...`), so they may read the session and loaded case instances, never
  `#form/` or `/data/`, and a bare relative name has no context node at all.
  `validateXPath(…, scope: "session")` owns those three refusals, so the deep
  validator, the inline linter, and the editor's save gate say one sentence;
  `formLinkExpressionProjectable` is the projector's own precondition, and
  the deep validator reports the offending reference with the link's uuid.
  Typed case references anchor at the SOURCE entry's own case datum
  (`ownCaseSessionRef`): `case_id` on a case-loading form, the create datum
  `case_id_new_<type>_0` on a registration form — its case exists once the
  form has closed, which is why `caseRefAcceptMap(index, formType,
  "session")` applies no registration narrowing — and `#<own>/case_id` IS that
  datum. A `case_id` leaf at any depth reads casedb's `@case_id` ATTRIBUTE
  (`commcare-core .../CaseChildElement.java` installs the id under the
  attribute name; no child element `case_id` exists), in form scope too.
  `deriveEntryDefinition` declares every secondary instance the projected
  guards, children, datums, fallback guard, and the `previous` frame's datum
  values use.
- **Validator** (`rules/form.ts::formLinkValidation`, all soundness):
  `FORM_LINK_UNREACHABLE` (a link after an unconditional one),
  `FORM_LINK_NO_FALLBACK` (every link conditional and no EXPLICIT `postSubmit`
  — the form-type default does not count), `FORM_LINK_DATUMS_INCOMPLETE`,
  `FORM_LINK_DATUM_UNUSED`, plus `TARGET_NOT_FOUND` / `SELF_REFERENCE` /
  `CIRCULAR` (graph-backed, `lib/domain/formLinkGraph.ts`). Every finding
  carries `details.linkUuid` and names the destination. The projection runs
  only where every target resolves, every expression is session-scope, and
  every form the frame reads has buildable actions — each "no" is a finding
  another rule already owns, which is what keeps this rule total.

### Repeat modes

Three modes via `repeat_mode` discriminator, each emits different wire shape:

- **`user_controlled`** — bare `<repeat nodeset="...">`. Runtime adds/removes instances.
- **`count_bound`** — `<repeat nodeset="..." jr:count="<path>" jr:noAddRemove="true()">`. `jr:count` MUST be a location path: JavaRosa parses it through `XPathReference`, which rejects any non-path expression (`commcare-core .../XPathReference.java::getPathExpr` → `XPathTypeMismatchException`). So the emitter classifies the expanded count via the Lezer parser (`xform/countReference.ts::isCountReferencePath`): a path emits directly; a literal/expression hoists into a hidden form-root node `__nova_count_<fieldId>` (seeded by a `<setvalue event="xforms-ready">`, bound `xsd:int`) and `jr:count` points at that node — the canonical `group_relevancy_in_repeat.xml` shape. The `__nova_` namespace is reserved against authored field ids by the `RESERVED_FIELD_ID_PREFIX` validator rule. Either way JavaRosa evaluates `jr:count` ONCE at form load; cardinality is frozen even when dependencies change. CommCare/JavaRosa spec — not a Nova choice.
- **`query_bound`** — Vellum's "model iteration" pattern. Data section nests `<item>` under the parent (`<id ids="" count="" current_index="" vellum:role="Repeat"><item id="" index="" jr:template="">…</item></id>`); body's `<repeat>` targets `<id>/item`; four `<setvalue>` elements seed `@ids`/`@count` (xforms-ready, OR jr-insert when nested inside another repeat) and `@index`/`@id` (jr-insert always); a `<bind nodeset="<id>/@current_index" calculate="count(<id>/item)"/>` drives the per-iteration index. Same one-time-eval freeze as count_bound.

`children`'s bind paths pick up the extra `/item` segment in query_bound — `childParentPath` rewrite in `xform/builder.ts` propagates this everywhere downstream.

### Sections are data groups that are always field-lists

A `section` field (one page of a form) emits exactly like a group — a DATA group, `<group ref="/data/<id>">` in the body over an instance node of its own — with `appearance="field-list"` ALWAYS, titled or not; a LABELLED group carries the attribute as Nova's default and a transparent (no-label) group never does (`xform/builder.ts::buildContainer`, the one gate). The fixture is Vellum's `tests/static/all_question_types.xml` field-list group, and HQ's `xform.py::_infer_vellum_type` reads that attribute back as `FieldList`. A section has no `relevant` by schema, so it emits no `<bind>`; an untitled one emits no `<label>` and registers no itext. The data-group shape is the only safe one: a ref-less control group binds to its parent (`XFormParser::getAbsRef`), Vellum corrupts it on save, and HQ's App Summary collapses it. The section-level rules (root only, sections only once sectioned, no add-entries repeat below — the CommCare app never raises `EVENT_PROMPT_NEW_REPEAT` inside a field-list host) are the validator's, so the emitter stays total; `__tests__/xformDocArbitrary.ts::sectionRoot` pages roughly one fuzz form in four so every oracle meets the shape.

### XForm parse-time oracle + fuzzer

`validator/xformOracle.ts::validateXForm` mirrors the FATAL contract JavaRosa enforces while parsing a form (`commcare-core .../xform/parse/XFormParser.java`). It's a TEST ORACLE proving emitter totality, never a user gate: a form that fails it is a generator bug, not a fixable authoring state. Co-developed with the fuzzer at `__tests__/xformOracle.fuzz.test.ts` (+ the `blueprintDocArbitrary` generator) — the fuzzer generates schema-valid `BlueprintDoc`s, emits, and asserts the oracle returns clean. A failing fuzz case is either (A) the oracle being too strict → fix the oracle, or (B) an emitter bug → fix `xform/builder.ts`; never a new reject rule.

Two XPath surfaces, both classified by the shared `xform/pathExpression.ts` gate (the single Lezer-backed classifier the emitter and oracle both consume; `countReference.ts::isCountReferencePath` delegates to it). PATH-only surfaces (bind `nodeset`, control `ref`, `<setvalue ref>`) go through `isPathExpression`, mirroring `XPathReference.getPathExpr`'s `instanceof XPathPathExpr` check; ANY-expression surfaces (`relevant`/`constraint`/`calculate`, `<output value>`, `<setvalue value>`) go through `isParseableXPath`. The repeat-member-scope check (`verifyRepeatMemberBindings`) first applies Core's `collapseRepeatGroups` (a non-repeat `<group>` wrapping a single `<repeat>` collapses into the repeat) so the canonical Vellum wrapper-group shape isn't read as a skipped-repeat violation. Dependency-cycle detection is intentionally NOT ported — the doc-layer validator (`validateBlueprintDeep` via `TriggerDag`) owns cycles.

Every wire emitter in this package is **DOM construction**, not string assembly — XForm (`xform/builder.ts`, `xform/caseBlocks.ts`, `xform/metaBlock.ts`), suite.xml (`compiler.ts`, `session.ts`, `suite/case-list/*`, `suite/case-search/*`). Each emitter builds a `domhandler` element tree via the shared `elementBuilders.ts` helpers (`el(name, attribs, children)` / `text(data)` / `RENDER_OPTS`) and the orchestrator serializes once via `dom-serializer`, so malformed output (unescaped `<` / `&`, broken nesting, double-encoded entities) is unrepresentable by construction — the serializer is the sole escaping authority, and there is no `escapeXml` helper anywhere. The oracle is the test-time backstop; the construction shape is the structural guarantee.

### Suite + HQ-JSON oracles (same test-oracle pattern)

Two more wire oracles follow the XForm oracle's shape — a faithful mirror of the platform's parse/import contract, co-developed with a fuzzer that emits from schema-valid `BlueprintDoc`s and asserts clean; a failure is a generator bug, never a new reject rule.

- `validator/suiteOracle.ts::validateSuite` mirrors the device's `suite.xml` contract (`commcare-core .../suite/model/*` + `org/commcare/xml/*Parser`). Two layers: **Category 1** (fatal at `SuiteParser` parse — required attrs, enums, PATH-only `<datum nodeset>` / `<data>` per `SessionDatumParser`/`QueryDataParser`) and **Category 2** (parse-clean but session-runtime-fatal — the device does NO cross-reference validation, so the oracle owns menu→command, datum `detail-select`/`-confirm`→detail, `instance('id')` resolution with per-entry intersection, locale-id resolution against app_strings, command/detail/instance id uniqueness). Menu and command relevance both use Core's restricted context: expand commands from every menu whose own id matches the evaluated id, select the first resulting entry (falling back to a direct same-id entry only when that expansion is empty), then add declarations from all same-id menus. A command's containing menu contributes only when its own id matches the command id, and the broad runtime allowlist is not ambient. Nova's canonical producer placement remains simpler: module-condition dependencies live on the module menu, while form-condition dependencies live on the form's matching entry. `xform/instanceRefs.ts` extracts `instance()` refs via the Lezer parser. Wired into `compiler.ts` as a post-emit throw.
- `validator/hqJsonOracle.ts::validateHqJson` mirrors CommCare HQ's import contract (`Application.wrap`, a recursive jsonobject `DocumentSchema`). Import is FATAL only on enum (`choices=`) violations, type mismatches, `doc_type` dispatch failures, and custom property validators (none on Nova-emitted types) — the TS `HqApplication` type already guarantees the structural slots, so the oracle checks the emitter-derived enum/`doc_type`/finite-number slots that TS types only as `string`. It is a **regression guard** over those constants (their values come from shell factories / the `toHqWorkflow` table, not user input). A test-time oracle beside the XForm oracle — the compile/upload paths run the boundary gate; the oracles guard the emitters in CI.
- `validator/bindingResolutionOracle.ts::validateBindingResolution` mirrors JavaRosa's install-time XPath-resolution contract — the layer between parse-time validity (which `xformOracle` proves) and form-init runtime evaluation. Three rules: every `instance('commcaresession')/session/data/<X>` references a declared session datum on the form's entry; every `instance('commcaresession')/session/context/<X>` is in the closed CommCare-populated set (`SessionInstanceBuilder.addMetadata`); every `instance('<id>')` matches a `<model><instance id="...">` declaration. Form-path refs inside expression bodies are intentionally NOT checked — JavaRosa resolves a missing path to an empty node-set at runtime (degraded UX, not install-time-fatal); dangling bind NODESETS are caught upstream by `XFORM_DANGLING_BIND`. The oracle is a **test-time totality proof**, never a user-facing emit gate — `compileCcz` does not call it. The fuzz at `__tests__/bindingResolutionOracle.fuzz.test.ts` invokes it directly per form post-compile; the user-visible authoring gate is `validator/rules/form.ts::caseHashtagOnCreateForm`, which narrows typed case refs on registration forms to the created type's `case_id`, using the same reachable-type accept set as the builder (`caseTypes.ts::caseRefAcceptMap`).

### Case-management scaffolding emission

`xform/caseBlocks.ts::addCaseBlocks` mirrors CCHQ's server-side post-process (`commcare-hq/.../app_manager/xform.py::XFormCaseBlock`) so local-CCZ emission produces forms JavaRosa can install. This is a true lockstep contract, not a partial mirror: CCHQ regenerates the uploaded app's XForm case blocks from the `FormActions` JSON, and Nova's local `.ccz` renders from that *same* `FormActions` (`hqForm.actions`) — so the two surfaces consume one input and can't diverge as long as `addCaseBlocks` consumes all of it. Every `<case>` element carries the cx2 namespace (`http://commcarehq.org/case/transaction/v2`) — without it CommCare's submission processor treats the element as inert data, not a case transaction. The three `<case>` attributes (`case_id` / `date_modified` / `user_id`) wire to:
- **case-create**: `case_id` setvalues at `xforms-ready` from the per-entry session datum `case_id_new_<casetype>_0` (a `function="uuid()"` datum `session.ts::deriveSessionDatums` emits). `date_modified` / `user_id` calculate off the meta block at `/data/meta/timeEnd` / `/data/meta/userID` (the compiler injects the meta block on the same `.ccz` path, after the case block, so both resolve). The case-name source question's bind also gains `required="true()"` (merged onto the field's existing bind, not a duplicate) — CommCare forces it so a case can't be created nameless, mirroring `XFormCaseBlock.add_create_block`.
- **case-update**: `case_id` calculates from the projected own-case session datum (`case_id` for a flat form, potentially `case_id_<type>` for a child). Same meta-block bindings for the two timestamp attributes. Every per-property update bind also carries `relevant="count(<qPath>) > 0"` — the JavaRosa semantic when a field's `relevant` evaluates false is that the data node is absent, and an unguarded update would overwrite the existing case property with empty. The guard mirrors CCHQ's `XFormCaseBlock.add_case_updates`. Removing it silently destroys preserved case data on every conditionally-hidden field.
- **case-preload**: one `<setvalue event="xforms-ready">` per `case_preload` entry, reading the loaded case's property from `casedb`, anchored by the same projected own-case session datum. Mirrors `XForm.add_case_preloads`. Spliced in after `buildXForm`'s instance scan, so `addCaseBlocks` declares the `casedb` instance itself (idempotently — skipped when a field-level case reference (`#<type>/…`) already pulled it in), mirroring `add_case_preloads`'s `add_casedb()`. Preload is the structural source of a case-loading form's initial field values — the agent layer stamps no `default_value` for this (`lib/agent/contentProcessing.ts::applyDefaults`). Gotcha: the preload setvalue lands after the field's own `default_value` setvalue in document order, so the loaded case value wins at `xforms-ready`. This matches a CCHQ-uploaded app (CCHQ emits preload regardless of any authored default) — an explicit `default_value` on a case-loading form's case property does not change what the user sees.
- **subcases**: per-subcase session datum `case_id_new_<subcasetype>_<idx>` (index mirrors CCHQ's `Form.session_var_for_action` — starts at 1 when the form also opens a primary case). Repeat-context subcases use literal `uuid()` calculate instead (no session datum is emitted for them, matching CCHQ's `delay_case_id` branch). Owner-id binds to `/data/meta/userID` on EVERY subcase regardless of relationship: the basic module Nova uploads runs `autoset_owner_id_for_subcase` (`'owner_id' not in case_properties`, which is always true for Nova's subcases), so CCHQ's regenerated form carries the userID owner bind for child and extension subcases alike. (The unowned-`owner_id` sentinel is an advanced-module-only shape — `autoset_owner_id_for_advanced_action` — which Nova never emits; the `extension` relationship is carried solely on the `<index>`.) Each subcase's name question also gets `required="true()"` merged onto its bind, same as the primary case. A subcase **close-on-submit** branch exists (renders `<close>` + a `relevant` bind from the subcase's `close_condition`) but is dormant: no authoring surface sets an active subcase close today, so `buildFormActions` always emits a `never` condition there; the branch is exercised only by `__tests__/caseBlocks.test.ts`.

- **capture URL node**: a capture field's `caseWrite` carries `mode`, and `"url"` emits a SIBLING node (`xform/captureUrlNode.ts`) holding `if(<capture> = '', '', concat('<origin>/a/<domain>/api/form_attachment/v1/', /data/meta/instanceID, '/', <capture>))`. The case update names THAT node, never the capture. This indirection is not stylistic: `xform.py::CaseBlock.add_case_updates` routes an update into an `<attachment>` block whenever its question path is an `<upload ref>` in the body (`::is_attachment`), consulting no toggle, and a stock domain then drops the block silently (`update_strategy.py::_apply_attachments_action` returns immediately without `MM_CASE_PROPERTIES`). The origin + project space arrive as an already-resolved `AttachmentUrlTarget` from the caller (`lib/deployment/attachmentTarget.ts`), because the emission boundary is one-way; with none, the node, the bind, and the case update are all withheld rather than written against a guess, and the caller says so through `lib/publish/exportAdvisories.ts`.

- **capture attachment block**: `caseWrite.mode === "attachment"` names the
  original upload node in FormActions, so both HQ regeneration and local CCZ
  emission create the same `<case><attachment>` transaction pinned to
  `update_attachment_case.xml`. This is the legacy case-file behavior, not a
  scalar property write: a project space without its corresponding capability
  silently drops the block, so `projectSpaceCompatibility.ts` derives and
  checks that semantic requirement before direct publish. Nova never exposes
  the downstream flag slug as an authoring setting.

### Authored case-operation emission

`xform/caseOps.ts` lowers typed `Form.caseOperations` into the authored XForm source, so HQ upload and local `.ccz` compilation consume the same cx2 blocks; it is not another `FormActions` post-process. Each multiplicity scope gets a reserved `__nova_operations` container and each operation is a Vellum-recognizable `SaveToCase` wrapper carrying `vellum:case_type`. Singular operations live in the form root container, which is prepended before authored fields. Repeated operations are appended into the referenced repeat's exact iteration template after its authored children. Because CommCare Core executes case blocks in XML document order and a repeated effect cannot leave that template, the only representable cross-scope sequence is root followed by repeat scopes in post-order field traversal; `lib/doc/caseOperationOrder.ts` is the shared validator/planner proof of that constraint. On local compilation, the existing `FormActions` primary-case/subcase post-process appends its blocks after the authored field tree, so every advanced operation executes before Nova's ordinary primary-case action; the integration oracle pins that relationship explicitly. The rolling type proof includes those final implicit consumers: an ordinary primary write and every child-case parent index require the session case to retain the module type. A write-free close block needs only the case id and remains type-agnostic. The proof keeps every transition rather than only the latest nominal type, so a conditional restore cannot hide the branch where the case still has the prior transitioned type.

Inside `<case>`, child order is canonical and pinned against current Vellum/Core sources and fixtures: `<create>` (with `case_type`, `case_name`, `owner_id`), `<update>`, `<close>`, then `<index>`. Registration `external_id` is deliberately in `<update>`, never `<create>`, per CCHQ's exact `open_case_external_id.xml` fixture; child create and existing-case writes use the same scalar update leaf. Every non-create block carries a materially present update. When it has no authored update child, Nova emits an idempotent `case_type` assignment to the already-declared type: Core therefore takes the clean update-before-index missing-case path, and HQ classifies pure close/index blocks with an actual update sort key. An empty `<update/>` is sufficient for Core but NOT for this HQ ordering proof — HQ's parser treats it as absent when another action exists. Generated singular create ids alone use Vellum's `xforms-ready` setvalue. An `idFrom` answer is NOT emitted raw: the shared versioned contract derives `nova-case-v1:<UUIDv5(app,form,operation,type)>:<exact-key>`. The fixed namespace and JSON tuple serialization are pinned by TypeScript/XPath vectors; operation display-id renames and reorders do not affect it. A live calculate bind is used even when singular, so the submitted id reflects the final answer. The source field must be scalar text/single-select/hidden-string; multi-select is an array in Nova but a space-token string on device and has no safe implicit key serialization. The calculation accepts 1–205 UTF-16 code units, performs no trim/case-fold/Unicode normalization, and returns blank outside that range so Core/HQ reject the whole transaction rather than exceed HQ's 255-character case-id column or merge every blank row. Repeated duplicate keys intentionally address the same case, as does a retry of the same app/form/operation/type/key; the app/form/operation/type namespace separates every other ordinary collision, including type edits and two operations sharing one field. The order gate rejects a later non-create that can target that merged case when both definitions share a repeated execution ancestor: Core executes `C1,U1,C2,U2`, while HQ groups the concrete id and create-sorts `C1,C2,U1,U2`. A provably distinct target and independent root sibling repeats remain legal. Those deterministic identities are type-stable: a known authored-create retype is rejected statically, and every data-dependent retype gets a trailing atomic guard that rejects a `nova-case-v1:` target before the effect can commit. Because HQ sorts one case's create blocks before non-create blocks, a deterministic-key create must still precede all non-create operations whose runtime target could be that existing case; the shared order checker rejects the unsafe inverse. Targets otherwise come from earlier-create identity, the loaded session case, or a typed expression; repeated `id-of` binds are relative only within the exact correlated iteration. An `id-of` nested anywhere in a runtime target/link expression is rejected: only the first-class `op` target can address a fresh create without incorrectly filtering it through the pre-submission casedb. Owner expressions use explicit Nova vocabulary: `acting-user` emits `/data/meta/userID`, `unowned` emits the fixed `-` sentinel, and a create with no owner expression defaults to the acting user. Ordinary and advanced fixed-text scalar calculates pass through JavaRosa `replace(..., '^[\x00-\x20]+|[\x00-\x20]+$', '')`, matching Java `String.trim()` while preserving internal text. Guards cap every value at 255 Java/JS UTF-16 code units; names and explicit owners must also remain nonblank, while `external_id` may be the real empty string. Failure rolls the whole submission back. This pins the shared `caseScalarText.ts` contract for wire, Preview, and storage. Every operation-carried case type uses Core's identifier grammar and 255-character cap; every link identifier is XML-safe and at most the HQ index column's 255 characters.

Location owners add two exact leaves to that vocabulary. `fixed-location` lowers its app-scoped place UUID as a literal. `owner-location-at-level` lowers to `instance('locations')/locations/location[@type='<destination-level-code>'][@<nearest-case-owning-ancestor-code>_id = <owner-case-expression>]/@id` and pulls both `locations` and `casedb`. Either leaf must occupy the complete owner expression; the validator refuses name, rename, and nested carriers and proves the destination level owns cases before this boundary can print it. The export boundary still rejects BOTH leaves for `.ccz`, HQ JSON, and HQ upload, now for ONE reason: a place UUID is a Nova identity and nothing maps it to the target domain's `location_id`, so an exported expression would be a valid-looking dead owner rule. The fixture is NOT a second reason — HQ builds it per worker on restore from its own rows, so pushing the place tree is what puts it on a device.

`locations/__tests__/flatLocationsFixture.ts` emits Nova's own copy of that fixture, matching `locations/fixtures.py::FlatLocationSerializer.get_xml_nodes`. **It is a TEST ASSET and is on no delivery path**: the real fixture is generated by HQ on restore, per worker, from the domain's `SQLLocation` rows, so nothing Nova exports carries it and nothing could — a `.ccz` is an app and this is per worker. It lives under `__tests__` for that reason, and exists so the lowering is provable against the exact bytes a device reads: a wire shape nobody can execute is a wire shape nobody can check. Four things about it are easy to get wrong. **It is not a suite fixture** — it carries `user_id` and differs per worker, exactly what `suiteOracle::checkFixtures` rejects inside a `<suite>`, so nothing about it enters the compiled suite; the restore delivers it. **It drops archived places itself** rather than trusting its caller, matching `get_location_fixture_ids.sql`'s `is_archived = FALSE` in every arm — an archived place shipped to a device is still a destination a worker can be handed cases at, and nothing downstream would notice. **Its instance declaration is already automatic**: an owner term is authorable in exactly one slot (a case operation's `owner`) and reaches the XForm through `caseOps`' AST-level accumulator, never as text, so `scanXPath`'s substring scan never sees one and HQ's dummy always-false question has no counterpart here. Do not add a `locations` branch to `scanXPath` for a shape that cannot reach it. **Its bytes are held by a parity test**, not by inspection: `emitTerm`'s XPath evaluated against the emitted fixture must yield the same place id as `compileTerm.ts`'s `owner-location-at-level` SQL arm, over generated organizations. The wire side of that test uses `locations/__tests__/wireXPathReference.ts`, a Lezer-driven evaluator that is a TEST ASSET and must never ship — Nova has one owner evaluator, and a differential test needs a second reading, not a second implementation.

A form can save an answer into the worker's own record, and the emission is gated exactly as HQ gates it. `deriveCaseWriteInventory`'s `usercase` bucket populates `usercase_update` (`usercase_preload` stays empty — `#user/<prop>` already compiles to the identical `casedb` join), which makes `util.py::actions_use_usercase` true, which is what turns on the `commcare_usercase` block in the XForm, the computed `usercase_id` datum, and the `<assertions>` entry child. HQ's `_add_usercase` has NO `<create>` arm, so neither does Nova. The datum rides `module_form` only (`EntriesHelper.get_extra_case_id_datums`), so Nova's case-list-only browse entry carries neither datum nor assertion. `<assertions>` sits between `<session>` and `<stack>`, pinned by the whole-suite `case-list-form-suite-usercase.xml`, and its locale id needs a matching app_strings entry or the suite dies at `NoLocalizedTextException` — Nova supplies its own message there rather than HQ's, because HQ's names a supervisor and an id an author never sees.

Every expression sees one pre-submission snapshot. Form answers and earlier create ids bind explicitly; repeat-local identity paths start at `current()` so they remain anchored on the operation bind even while a nested relation predicate temporarily evaluates a `casedb` candidate. Root case-property reads anchor on the projected own-case session datum in `casedb`, including root relation predicates and counts, while related-case candidate properties remain candidate-relative. Those case-reading expression paths add `commcaresession` with `casedb`. A runtime expression target is lowered through `casedb/case[@case_id=(...) and @case_type='snapshot-type']/@case_id`, never emitted as an unchecked id. The shared order analysis keeps that immutable lookup type separate from the rolling semantic type, so A→B retype followed by a B operation on the exact same target still finds the pre-submission A row. Different ASTs can nevertheless resolve to one concrete id; the static gate therefore rejects a later differently-typed target/link after a potentially aliasing transition unless the ids are provably distinct. Repeated retype is restricted to an exact correlated generated create because duplicate repeat values otherwise make the second iteration consume the first iteration's result type. The authoritative submission envelope (`lib/case-store/postgres/submissionEnvelope.ts`) repeats this proof over expanded, server-resolved ids with `validateResolvedCaseOperationTypeSequence`. Dynamic link targets get the same selector plus a trailing empty-update guard block whose id is the operation case only when the typed link selector resolved to a different id. On absent/wrong type/self-link the blank guard id raises the clean transaction error before an empty index value could be mistaken for an unlink; on success the guard no-ops the case the operation already touches, never the linked case. Server-side preview separately reauthorizes Project/type facts; neither path trusts a client type descriptor.

Conditions become wrapper relevance and write conditions become child relevance. A consumer of an earlier conditional create automatically inherits that create's relevance (transitively): if the producer does not execute, no target/link/value may leak its preallocated UUID into an update-only block or dangling index. Conditional retypes participate in the same shared guard analysis: a later operation/link that requires the destination type inherits the transition condition, while a source-type consumer after the transition is rejected. The preview's operation-program fold (`lib/preview/engine/caseDataBindingHelpers.ts`) must use `caseOperationConditionalGuardUuids`, not treat an allocated id or declared retype as proof that the producer effect ran. The validator dry-runs these same emitters after type checking so a schema-valid but nonportable expression cannot reach compilation.

Operation assignment typing follows storage direction, not the symmetric comparison table: exact representations, integer-to-decimal, and text/single-select strings are portable; decimal-to-int, scalar-to-multi-select, null-as-clear, and any incompatible branch are not. A direct multi-select form answer may write a multi-select property, but concat/coercion cannot turn its Nova JSON array into CommCare's token string implicitly. `concat` is the explicit boolean-to-text boundary; boolean primitives hidden under numeric/date coercion remain rejected. Generic writes admit the standard `external_id` scalar and route it outside JSONB; `case_name` stays owned by the dedicated name/rename facets. Retype has a second parity gate: only `planCaseRetype(...).wirePortable` plans emit, meaning every existing JSON property retains the exact same type and no value needs conversion or parking. CommCare's wire changes only `case_type`; source-only or converted values would otherwise remain lexically present on device while Nova changed its active projection. Scalar case metadata such as `case_name` and `external_id` is outside that JSON plan and survives normally.

These case-operation wire facts were verified against `commcare-core`
`CaseXmlParser.java` at `130df00962a289381a8e0936c3ea5d3f53d96f73`, Vellum
`saveToCase.js` plus `tests/static/saveToCase/create_property.xml` at
`3e69aa1c166e24ca062a2aa0b34b2aba0bceb431`, and CommCare HQ at
`0fa01e0e8aea95ed9013d564145ad6cffeb91371`. Those sources establish only the
accepted transaction wire and processing order; Nova's typed operation model
and authoring semantics remain independent. Operations commit through the
ordinary rules: `validateCaseOperations` runs on every form carrying them, and
its `CASE_OPERATION_*` findings gate a commit exactly like any other soundness
code. The builder, SA, and MCP share the semantic planners, complete lookup
table/table-row/column/form-field term vocabulary, and one commit gate.

### Repeat-context subcase splice + nest decision

A field whose `caseWrite.caseType` names an exact direct child of the module case type authors a CHILD case; when the field sits inside a repeat, the child case is created per iteration. `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory` is the sole field walk and buckets these by `(caseType, nearest repeat UUID)` — never a mutable field id or rendered path — so two cousin repeats that legally share an id (`children > section_a > kids` + `children > section_b > kids`) emit two independent `OpenSubCaseAction`s. Its Nova-only writer records carry the source field UUID, explicit destination pair, ordered UUID/current-id path segments, query-bound iteration facts, and nearest repeat UUID/path.

`caseWriteAdmission.ts::assertAndProjectCaseWriteInventory` is the only semantic-plus-structural bridge into private CommCare path vocabulary. It admits the canonical inventory, then projects every writer path and present repeat path exactly once through `FormPath`, returning writer-to-bucket identity with the projected paths. `INVALID_FIELD_ID` remains the sole authoring finding for an XML-illegal segment; a validation-bypassing lowering call fails at that shared projection rather than inventing a second public error. `deriveCaseConfig` consumes the projected inventory and performs no field walk, path resolution, or bucket classification of its own.

`xform/caseBlocks.ts::addCaseBlocks` mirrors CCHQ's `_create_casexml` splice: pre-count subcases per `repeat_context` to pick `nest = (count > 1)`. `nest = false` (single subcase under the repeat) splices `<case>` directly into the repeat's template subtree, bind nodesets anchor at `/data/<X>/case/...` (`subcase-repeat.xml` shape). `nest = true` (multiple subcases sharing a repeat OR every non-repeat-context subcase) wraps in `<subcase_N>`, binds at `/data/<X>/subcase_N/case/...` (`multiple_subcase_repeat.xml` shape). Splice target resolution walks the parsed DOM by `repeat_context`'s FormPath segments — `data → X → item` for `query_bound` falls out naturally because Vellum's `getPathName` rewrites the iteration path to include `/item`.

Adding a second cross-case-type field to a single-subcase-in-repeat form FLIPS the wire shape (`<case>` → `<subcase_0>`/`<subcase_1>`). Old case_ids persist (the bind calculate is the same `uuid()`); old submissions are unaffected.

### Typed FormPath

`xform/formPath.ts::FormPath` is the typed value every wire emitter constructs paths through. Element + attribute steps only; attribute steps are terminal; element-step names pass `XML_ELEMENT_NAME_REGEX` at construction. The serializer `toXPath()` is the sole place `/data/...` literals appear in the package. Use it for PATH REFERENCES (bind `nodeset`, control `ref`, `<setvalue ref>`, splice walk steps); XPath EXPRESSION bodies (`calculate` / `relevant` / `constraint`) stay parsed via the Lezer grammar.

### Form `<meta>` block — build-time injection

The OpenRosa `<meta>` block (`<deviceID>`/`<timeStart>`/`<timeEnd>`/`<username>`/`<userID>`/`<instanceID>`/`<appVersion>`/`<drift>`, eight populating setvalues, two `<bind type="xsd:dateTime">` timestamp binds) is a CCHQ render-time artifact, NOT part of a form's source — exactly like the case transaction blocks. CCHQ injects it for every form via `xform.py::add_case_and_meta` → `_add_meta_2` (stripping any pre-existing meta first), so a Vellum-edited source never carries it. `buildXForm` therefore omits it: the HQ-upload source has no meta block and CCHQ regenerates it on render. Only the local `.ccz` path — which has no CCHQ render step — injects it, via `xform/metaBlock.ts::addMetaBlock`, which `compiler.ts` calls right after `addCaseBlocks` (case-then-meta order). The split is load-bearing: a meta block in the uploaded source can't be opened in CCHQ's form builder (Vellum parses every `<data>` child as a question and rejects `<meta>`/`<orx:meta>` — "'meta' is not a valid Question ID").

`addCaseBlocks` and `addMetaBlock` share `xform/domSplice.ts` so the two render-time injections stay in lockstep — one splice-into-`<data>`/`<model>` path, one idempotent secondary-instance declaration (`casedb` / `commcaresession`), one `dom-serializer` escaping authority.

### Hashtag form-context

`hashtags/formContext.ts::expandHashtagsInContext` is the sole form-context projection for canonical case references. References are **per-case-type**: `#<case_type>/<prop>` names the form's own module case type or an ancestor up the parent-index chain (never a child type — a form loads one case and can only reach up the index at runtime). The resolver looks the namespace up in the form's reachable-type depths (`lib/domain/caseTypes.ts::reachableCaseTypes`: own = 0, parent = 1, …) and sends that depth through the single `expandCaseToWire` casedb walk. Raw authored `#case/...` throws at this boundary; only the emitter may generate HQ's private `#case/`, `#case/parent/`, or `#case/grandparent/` editor/metadata spelling from a typed reference.

Registration narrowing: the form's own new case isn't in `casedb` at form-init, so only its allocated `case_id` (own type, depth 0) resolves — `#<own>/case_id` rewrites to `/data/case/@case_id` (populated by the case-create scaffolding's setvalue chain). Every other own/ancestor ref on a registration form expands to the case-loading shape, so the binding-resolution oracle catches the unresolved `session/data/case_id` at compile time; the deep validator rejects it first at authoring time, gated by the form's reachable-type accept set (`caseTypes.ts::caseRefAcceptMap` — the single home of the form-type narrowing, also read by the inline linter + autocomplete). `xform/builder.ts` threads a captured `expand` closure through every helper that touches hashtag-bearing XPath surfaces so every emitted bind / setvalue / output respects the form's context.

### Case-list emission

Both detail surfaces (`<detail id="m{n}_case_short">` / `m{n}_case_long`) share one per-kind column emitter via a `DetailKind` discriminator — five precise branch sites cover the long-detail-only `template_form="phone"`, the short-detail-only sort wrap, the long-detail no-sort short-circuit, and the locale-id substring choice. Don't fork the emitters per surface.

### Case-tile emission

`suite/case-list/tileStyle.ts` is the ONLY place the package emits CommCare's grid vocabulary, and `<style>` + `<grid>` is one indivisible wire unit, not an element with an optional child: `commcare-core .../xml/DetailFieldParser.java::parseStyle` runs `GridParser` unconditionally after `StyleParser`, `GridParser::parse` opens with `checkNode("grid")`, and all four coordinates go through UNGUARDED `Integer.parseInt`. So a `<style>` with no `<grid>` is an install-time `InvalidStructureException` and a `<grid>` missing one attribute is a raw `NumberFormatException` outside the parser's structured-error path. CCHQ can emit both (its custom branch guards on `any(... is not None ...)`, not `all(...)`); Nova can't, because `TileCell` carries the four as required slots of one object. The corollary reaches authoring: the five presentation attributes are reachable only for a placed cell, so no surface may offer alignment / size / border / shading on an unplaced column.

**Whether a column holds a square is `lib/domain/modules.ts::tileCellFor`'s decision and nobody else's.** All FOUR consumers call it — `suite/case-list/columns.ts::tileStyleChildren`, `hqJson/caseList.ts::applyTileLayoutToShortDetail`, `lib/preview/caseTileRendering.ts::tileResultsColumns`, and the SA read surface `lib/agent/summarizeBlueprint.ts::tilePlace`.

It has one home because it briefly had four, and **every place that decided independently got it wrong at least once.** The HQ JSON writer — the PRIMARY delivery path — had no visibility check at all, so an uploaded app drew a different tile from the local `.ccz`. The SA summary reported a placement for a column the wire refuses, and in the Details block, which is never a tile; that one is not cosmetic, because the SA reasons about overlap from that text, so a phantom cell makes the model route around an obstacle that is not on the grid and then refuse its own next layout for a collision that cannot happen. A new delivery path, renderer, or read surface calls this predicate — re-deriving the rule is precisely how they diverge, and agreement reached by hand is a coincidence with a short half-life. `__tests__/tileEmissionParity.test.ts` asserts the three emission paths against one document; `lib/agent/tools/case-list-config/__tests__/caseListReadProjection.test.ts` covers the read surface.

Its two conditions: the case list has a `tile` layout, and the column is shown in Results. Cells persist while the layout is off (switching tiles off keeps the drawing) and emit nothing until it is on. Which detail SURFACE is a separate axis that stays with the emitter — the detail must be SHORT, and the case-detail screen stays a plain field list even though CCHQ allows `custom` there. `case_tile_template` is written only on the HQ-JSON short detail, and `Module.search_detail`'s deepcopy is what carries the tile to search results — never a second projection.

The zero-width sort carrier needs NO tile change: an off-screen Results field that still owns a Default-order rule keeps emitting `<header width="0">` + `<template width="0">` + `<sort>` with no `<style>` (HQ JSON spells the same thing as `format: "invisible"`, CCHQ's `detail_screen.py::Invisible(HideShortColumn)`), and that is CCHQ's own reserved hidden-field spelling — `commcare-core .../suite/model/Style.java::Style(DetailField)` comments "'0' is reserved for hidden (Search) fields", both cloudcare tile templates branch on `styles[index].widthHint === 0` into a `d-none` wrapper, `views.js::buildCellLayout` writes no rule for a null tile entry, and `formplayer-common/grid.scss::.box` adds no box size. The carrier is an empty zero-size grid item, so a tile keeps the hide-but-sort affordance a row layout has.

Nova's authoring words for vertical alignment (`top`/`middle`/`bottom`) map to `start`/`center`/`end` at emission through `TILE_VERTICAL_ALIGN_WIRE`, because `cloudcare .../menus/views.js::getValidFieldAlignment` silently rewrites anything outside `constants.js::ALLOWED_FIELD_ALIGNMENTS` to `start` — CCHQ's own `icon_text_grid` template emits a `vert-align` its renderer ignores. An unset presentation slot stays OFF the wire: an absent `font-size` makes the cell inherit the list's size, which is a different rendering from any named size, so emitting a default would change what a worker sees.

`css-id` is the sixth attribute `StyleParser` reads. Nova doesn't emit it — Formplayer serializes `Tile.cssId` and cloudcare consumes it nowhere, so an authoring surface for it would be an affordance with no effect.

### Grouped-tile emission

`caseListConfig.tile.grouping` emits `<group function="string(./index/<id>)" header-rows="N"/>` as the LAST child of the short `<detail>` (`suite/case-list/tileGroup.ts`, appended by `shortDetail.ts::buildDetailShell`), plus a companion `<datum id="<caseDatumId>_parent_ids">` on every FORM entry that loads a case (`session.ts::deriveSessionDatums`). HQ JSON writes the same thing as `case_tile_group: { doc_type: "CaseTileGroupConfig", index_identifier, header_rows }` on the short detail only, and omits the key entirely when grouping is off — safe because `Detail.wrap` default-constructs a `CaseTileGroupConfig()` whose `index_identifier` is `None`, and because `_merge_source_into_app` replaces `modules` wholesale so a republish leaves no stale value.

The byte oracle is `commcare-hq/corehq/apps/app_manager/tests/test_suite_case_tiles_grouping.py::SuiteCaseTilesGroupingTest`, whose inline `assertXmlPartialEqual` pair pins both the element and the datum exactly. `__tests__/tileGroupEmission.test.ts` asserts against those strings; `__tests__/tileEmissionParity.test.ts` proves the suite, the HQ JSON, the preview split, and the SA read surface agree about one grouped document.

Six facts the shape depends on:

- **BOTH short details carry it.** `models/modules.py::ModuleDetailsMixin.get_details` yields `search_short` from a deep copy of the case short detail, and `case_tiles.py::CaseTileHelper.build_case_tile_detail` gates on `self.detail_type.endswith('short')` — so the search-results list groups exactly as the browse list does. The long detail never does.
- **`header-rows` is always written.** Absent, `commcare-core .../xml/DetailGroupParser::parse` falls back to `1` while HQ's own `models/case_list.py::CaseTileGroupConfig.header_rows` defaults to `2`, so an omitted attribute halves or doubles the header depending on which side reads it.
- **The companion datum is form-entry-only.** `suite_xml/sections/entries.py::EntriesHelper.get_case_datums_basic_module` takes `datums[-1]` and adds it only under `if form:`, so a `caseListOnly` browse entry and a registration form's entry carry none. Its predicate is a plain `@case_id` match and deliberately does NOT reuse `caseLoadingNodeset`'s type/status/filter fragment.
- **Child order is a pin, not a constraint.** `commcare-core .../xml/DetailParser::parse` is a `while (nextTagInBlock("detail"))` name-dispatch loop. Last-child position matches HQ's assignment order and the one correctly-spelled upstream fixture (`formplayer/src/test/resources/archives/case_list_auto_select/suite.xml`); three of the four upstream `<group>` fixtures misspell the attribute `grid-header-rows` and prove nothing.
- **`function` is validated only by `XPathParseTool.parseXPath`** (`DetailGroupParser::parse`), so the identifier's schema — `XML_ELEMENT_NAME_PATTERN` on `CaseTileGrouping.identifier` — is what makes the interpolation total. There is no escaping anywhere, by construction.
- **The grouping is Web-Apps-only at the RENDERER.** `commcare-core` parses `<group>`, stores it on `Detail`, and evaluates the key in `cases/entity/AsyncEntity::getGroupKey` — but the only consumers of that key are `util/screen/EntityScreenHelper::groupEntities` (the `src/cli` session engine formplayer builds on) and formplayer's `EntityListResponse`. Nothing in `commcare-android` reads it, so on Android a grouped list is an ordinary tile list. Say that in author-facing copy rather than implying parity.

The three refusals live in `validator/rules/case-list/caseTileGrouping.ts`, all walking only the cells `tileCellFor` admits. `lib/domain/modules.ts::tileGroupHeaderRowChoices` is their constructive twin — the depths that cut a tile cleanly — and the builder offers exactly that list, with a test pinning the two against each other in both directions. The fourth state the unit worried about is unrepresentable: `grouping` lives INSIDE `caseTileLayoutSchema`, so a `<group>` on a detail with no tile cannot be constructed.

### Multi-select case-list emission

`caseListConfig.selection: { kind: "multiple", maximum }` is the sole authored
switch. Absence preserves the existing scalar bytes. HQ JSON writes
`case_details.short.multi_select = true` and `max_select_value = maximum`; the
long detail carries neither. Local suite entries replace their own-case
`<datum>` with `<instance-datum ... max-select-value="N">`, while preserving the
same nodeset, value, short/long details, parent constraint, filter, and secondary
instances. Its id follows the current root projection (`selected_cases`, with
the existing parent prefixes where required) and is also the selected-entities
instance id that XForms read from
`jr://instance/selected-entities/<datum-id>` as
`<results><value>case-id</value>...</results>`. Never print one case by taking
`value[1]`; a consumer is collection-aware or admission rejects it.

Nested selection uses the same authored-shape proof as Preview. A same-type
structural child reuses the root datum only when type, scalar/set cardinality,
and authored maxima are compatible. A different-type child keeps its own datum
and filters its nodeset with XPath 1.0 node-set equality against EVERY
`instance('<parent-datum-id>')/results/value`; this is the union of direct
non-extension children of the complete selected-parent set, not an arbitrary
first member. A form-less case-list-only root can supply a compatible same-type
set through its browse entry because Nova supports exactly one submenu tier.

The byte oracles are split by behavior. The selection datum and configured
maximum are the inline partials in
`commcare-hq/corehq/apps/app_manager/tests/test_suite_multi_select_case_list.py::MultiSelectCaseListTests`.
Search and claim are
`tests/data/suite/multi_select_case_list/basic_remote_request.xml`. The selected
instance in a form is `tests/data/form_preparation_v2/multi_no_actions.xml`.
`tests/data/session_endpoint_remote_request_multi_select.xml` lives directly
under `tests/data`, not `tests/data/suite`; it is the endpoint unit's oracle and
must not be used as proof that ordinary form entries are complete.

Search uses `search_selected_cases` consistently across the results
`<instance-datum>`, the `<rewind>`, the selected-entities `<instance>`, and the
claim `<post>`. One `<data key="case_id" ref=".">` walks every
`instance('search_selected_cases')/results/value` and excludes ids already in
the device casedb. HQ receives all remaining ids in ONE request. Its 204 does
not merely mean "already claimed":
`corehq/apps/ota/views.py::claim` returns 204 only when it created no new claim,
the supplied sync log is valid and proves the device already holds every
requested case, and none changed since that sync. A new claim, missing/stale
sync proof, absent local case, or changed case returns 201 so the client
restores. No ids returns 400; any nonexistent id returns 410 before any case is
claimed. Nova does not reproduce that restore lifecycle in Preview.

Grouped tiles remain legal and use the existing selected-values join for their
companion parent-id datum, pinned by
`test_suite_case_tiles_grouping.py::SuiteCaseTilesGroupingTest.test_case_tiles_with_grouping_multiselect`.
The Web Apps renderer still exposes one choice per group and that choice is the
first case. Persistent form tiles are different: Formplayer reads one scalar
session datum there, so the authoring planner clears `persistOnForms` when
multiple selection is enabled and no emitted `detail-persistent` branch has to
guess a representative case.

Batch form semantics are Nova-owned but the emitted XForm remains ordinary
CommCare case wire. HQ's scalar primary preload/update action is absent on a
batch-consuming form. Nova instead lowers each ordinary primary destination as
one derived SaveToCase wrapper inside the selected-case iteration, after
authored operations and before ordinary children and close. Each nonblank
shared answer therefore applies to every selected value; a blank answer omits
its property, and an all-blank wrapper is irrelevant. Explicit session-targeted
operations lower once per selected value, with authored-repeat order outside
selected-case order; every per-case wrapper reads the current value from the
selected-entities instance.
An automatic direct-form carry is admitted only when every possible final type
of those selected session cases still matches the destination form. Conditional
retypes retain both branches; an inherited unconditional restoration closes the
transitioned branch because it runs everywhere that transition did. A runtime
expression target also contributes a possible selected-case branch unless the
shared case-operation identity proof can show it is distinct; repeated use of
the same expression keeps that alias decision correlated across transitions.
The authored-operation wrapper, derived primary update, implicit close, child
creation, and their correlated `id-of` values are asserted as exact XForm
partials in Nova, because HQ's own
`tests/data/form_preparation_v2/multi_no_actions.xml` proves only that HQ drops
ordinary primary actions for a multi-select form. Local `.ccz` and HQ JSON must
produce the same operation order and transaction meaning.

### Case-search emission

The `<remote-request>` block's `<session>` carries ONE `<data key="_xpath_query">` element PER composed clause — the unified filter's top-level conjuncts, each advanced-arm search input's predicate, and each simple-arm input whose `(mode, via)` shape needs explicit-predicate emission. The server AND-composes every `_xpath_query` value it receives (`commcare-hq/corehq/apps/case_search/utils.py::_apply_filter` loops the multi-term criteria into one ES filter each; `commcare-core .../session/RemoteQuerySessionManager.java::getRawQueryParams` accumulates a `Multimap`, formplayer forwards repeated params, and Django folds them into a list at `corehq/apps/ota/views.py::app_aware_search`), so N small readable expressions filter identically to one fused mega-expression. On HQ JSON the same clauses land as N `default_properties[]` rows (`DefaultCaseSearchProperty` is a `SchemaListProperty`; CCHQ's `remote_requests.py::_remote_request_query_datums` loops every row into its own `<data>`).

Each clause's on-device wrapper is the shortest correct shape: a constant-only clause is a bare XPath string literal (HQ's own static emission shape); an input-gated clause is the doc-canonical `if(count(<input>), <query>, 'match-all()')` presence cascade with its value guards inside the presence branch; a clause whose only runtime interpolation is one free-text string uses the flat quote cascade (double-quoted CSQL delimiters, flip to single on an embedded `"`, fail closed on both — CSQL has no escape syntax per `eulxml/xpath/lexrules.py::t_LITERAL`, and the fail-closed arm emits the deliberately invalid `search-value-mixes-quote-marks()` because Android never enforces prompt validation, making the on-device guard the injection defense there). A `date`-widget input's value is picker-formatted on every runtime that binds it (Android doesn't support `input="date"` prompts at all), so it interpolates quote-free between fixed double-quote delimiters with no guard and no prompt validation.

The clause composition runs through `suite/case-search/xpathQuery.ts::composeXPathQueryEmission`, the single contract both the suite-XML emitter and the HQ-JSON emitter (`hqJson/caseList.ts::projectDefaultProperties`) consume. Simple-arm inputs that need explicit-predicate emission route through `suite/case-search/simpleArmDerivation.ts::deriveSimpleArmPredicate`, which lifts the `(property, mode, via)` shape to an advanced-style predicate (`when-input-present(input(name), op(prop, input(name)))`). Every search input still emits a prompt binding on both wire paths (`<prompt>` in local suite XML; `search_config.properties[]` in HQ JSON) because that is the only source CommCare uses to populate `instance('search-input:results')`. Every advanced prompt, plus every simple prompt routed through `_xpath_query`, emits `exclude="true()"` (suite XML) / `exclude: true` (HQ JSON): Core continues binding the typed value but does not ALSO submit the prompt key as an implicit exact case-property filter. Without that exclusion the automatic query parameter silently ANDs with the authored predicate; omitting an advanced `properties[]` row on HQ JSON removes the input from CCHQ's regenerated search screen entirely. Three CCHQ-runtime facts drive the routing rule:

- CCHQ's `CaseSearchProperty` carries no per-input matcher-strategy flag — verified against `commcare-hq/corehq/apps/app_manager/models.py::CaseSearchProperty`. The runtime default for a bare prompt is exact full-string match (`commcare-hq/corehq/apps/es/case_search.py::case_property_query` → `exact_case_property_text_query`). Fuzzy / phonetic / starts-with / fuzzy-date matching only reaches the runtime through an explicit XPath function call inside `_xpath_query` (`fuzzy-match` / `phonetic-match` / `starts-with` / `fuzzy-date` registered at `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`).
- CCHQ's `daterange` prompt binds one inseparable start/end pair. Nova therefore requires `range` mode if and only if the widget is `date-range`; that exact stored arm has no scalar `default` slot. Do not reinterpret one scalar as a From-only default. Exact one-date searches against datetime properties lower to UTC half-open day bounds, matching CCHQ CSQL's verified `datetime('YYYY-MM-DD')` UTC result rather than a hidden project or database-session timezone.
- Each `<prompt key="X">` binds one runtime value via `instance('search-input:results')/input/field[@name='X']` and carries no relation-walk metadata.
- CCHQ's runtime auto-matches the typed value against the case property NAMED BY the prompt key — verified against `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::build_query_prompts` (`'key': prop.name`) and `commcare-hq/corehq/apps/case_search/utils.py::_apply_filter` (the non-special key routes through `_get_case_property_query(criteria)` keyed on `criteria.key` as the case property name). Nova's authoring keeps the prompt key (`SearchInputDef.name`) and the targeted property (`SearchInputDef.property`) as separate slots; when the two diverge, the auto-match queries a property that may not exist. The `exclude="true()"` attribute (verified at `commcare-core/.../session/RemoteQuerySessionManager.java::RemoteQuerySessionManager.getRawQueryParams`) suppresses the auto-match without unbinding the typed value.

The routing rule is `(input type, mode, via, name vs property)`-shaped: a non-date `exact` input (or `range`) on self-walk / absent `via` AND `name === property` rides on the bare prompt slot alone (CCHQ's runtime auto-match against the prompt key IS the authored comparison; the `daterange` widget handles the two-bound semantic internally for the current case). A simple `date` input in exact mode always routes through `_xpath_query`: Nova lowers it to a half-open whole-day interval, using date boundaries for date properties and UTC datetime boundaries for datetime properties (including indexed metadata), because bare exact equality would miss every non-midnight datetime. Every other combination — non-`exact` modes on any via, `exact` mode with a non-self via, OR `exact` mode with `name !== property` — also routes through `_xpath_query` and stamps `exclude="true()"` on the prompt. Simple-arm properties are structurally nonblank, so every stored input reaches one of these final wire paths.

**Prompt children and the seven arms.** `suite/case-search/searchPrompts.ts::searchPromptWire` lowers one input to everything a `<prompt>` / `CaseSearchProperty` carries, and both wire paths read that one description. Children emit in `QueryPrompt`'s order — `<display><text/><hint><text/></hint></display>`, `<itemset nodeset><label ref/><value ref/></itemset>`, `<required test><text/></required>`, `<validation test><text/></validation>` — and attributes in `key appearance hidden input default exclude` order (`test_suite_remote_request.py::test_prompt_hint / test_prompt_hidden / test_prompt_itemset / test_prompt_default_value / test_exclude_from_search / test_required / test_case_search_validation_conditions` are the partials the unit tests pin). A lookup-backed `select` is `input="select1"` and `multi-select` is `input="select"` (Core's `QueryScreen::getSupportedPrompts`); the itemset nodeset is `instance('item-list:<tag>')/<list>/<row>[filter]` through `lookup/naming.ts`, the label/value refs are the columns' wire names, and the fixture id joins the remote-request's instance list. `required.when` and `validation.rule` lower through `emitCaseListFilter` with an unaddressable case anchor, so a bare `input(uuid)` prints as the absolute `instance('search-input:results')/input/field[@name='…']` path and `matches-pattern` prints as `regex(...)`; an always-required input carries the literal `true()`. Core keeps only the LAST `<validation>` it parses (`xml/QueryPromptParser.java`), so the authored rule and the compiler's CSQL quote guard share ONE element: `(authored) and (guard)`, messages joined by a space, each half keeping its own translation unit. A hidden input is `hidden="true"`, its value in `@default` (Core re-evaluates it at every query-screen construction and seeds it even under `default_search`), and `exclude="true()"`, so the value binds to the search-input instance without ever auto-matching a property. The three new locale ids are `search_property.<m>.<key>.hint`, `.required.text`, and `.validation.0.text`. Required and validation are enforced by Web Apps only — Android never runs prompt validation — so every surface says "checked in the browser app"; the on-device quote guard remains the injection defense there because the runtime validation that would carry it does not run.

Validator rules anchoring the wire contract:
- `searchInputViaModeCompatibility` — rejects `range` on a non-self via and `range` with `name !== property` on self-walk. A choice input admits `exact` only.
- `searchInputScreenPredicateTypeCheck` — types `required.when` and `validation.rule` under the search-screen context (`patternMatching: true`, bare input refs admitted, case data refused with `CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_CASE_DATA_UNAVAILABLE` / `…_VALIDATION_RULE_…`); the hidden `value` under the global context with input refs refused (`…_HIDDEN_VALUE_…`); and a choice input's `options.filter` under the table-row scope (`…_OPTIONS_FILTER_SCOPE` / `…_TYPE_ERROR` / `…_NOT_ON_DEVICE`).
- `matchModeOnDeviceCompatibility` — rejects `fuzzy` / `phonetic` / `fuzzy-date` in slots that lower to JavaRosa-on-device XPath (`caseListConfig.filter`, `caseSearchConfig.searchButtonDisplayCondition`). JavaRosa has only `starts-with` of the four match functions; the other three are CSQL-server-only. The mode table itself lives once, at `predicate/matchModes.ts`, which this rule, the display-condition rule, and the on-device emitter all read. **The on-device emitter now REFUSES the three rather than lowering them**, which is what extends the fact to every carrier that dry-runs it — case operations reached the emitter through their own portability check and got nothing, because a silent lowering has nothing to catch. Precisely what happens at runtime is worth stating, since "crash" is only half true: an unregistered name still PARSES (`ASTNodeFunctionCall::buildFuncExpr` falls through to `XPathCustomRuntimeFunc`, whose `validateArgCount` is a no-op), so the app installs clean and throws `XPathUnhandledException` at EVALUATION. In form logic that surfaces as an error; in a case list `AsyncEntity::evaluateField` catches it and substitutes the literal string `<invalid xpath: …>` into the cell, so the failure is silent corruption rather than a crash.
- `expression/onDeviceCompatibility.ts` owns the structured, TypeContext-aware date-arithmetic capability decision shared by module slots, navigation display conditions, form case operations, lookup-backed select filters, and the builder's complete-candidate admission seam in `lib/doc/commitVerdicts.ts`. A property reference stores identity rather than its resolved type, so emitter dry-runs are only defensive totality checks and never the semantic source for deciding whether a `date-add` base is a date or datetime; lookup-row filters additionally install their table scope before resolving a column's type. `dateAddOnDeviceCompatibility` maps that shared decision into module-slot findings. JavaRosa-on-device date arithmetic stays on the portable fixed-duration lowering: a date-typed base plus seconds, minutes, hours, days, or weeks. Core registers no `date-add` / `datetime-add`, but it does provide numeric epoch-day arithmetic and `floor()`, so the emitter scales the quantity to days and emits `date(floor(base + scaledQuantity))`; this preserves positive, negative, fractional, and pre-epoch date results. Datetime bases (time-of-day would be lost) and calendar-relative months/years are rejected across every on-device expression slot. Advanced predicates are mixed-dialect: direct native CSQL `date-add` / `datetime-add` calls retain the full server surface, while date arithmetic beneath a non-native value root is checked because that subtree is interpolated through JavaRosa. Builder menus use the same dialect-state walk, so an unavailable choice is withheld before mutation rather than first surfacing at commit or export.
- `onDeviceExpressionCompatibility` — blocks persisted scalar-expression shapes Core cannot evaluate safely: `prop(via: subcase|any-relation)` in a standalone scalar value slot (the walk can return several cases while Core scalar-unpack requires one), and a child/any count nested beneath a multi-case child/any scope that Core cannot name. Self/ancestor reads remain valid; `count(self)` reduces to 1/0, root child counts are valid, and a child count beneath a pure singleton ancestor chain uses that ancestor's absolute case-id anchor. Predicate-rooted relation reads are owned by the relation-scope normalizer instead. Table lookups are on-device expressions: their table-scoped row predicate lowers against the declared lookup fixture and their result is then interpolated into CSQL where needed. The rule validates saved calculated/default definitions even while latent so a later visibility or input change cannot activate a runtime-failing expression.
- `excludedOwnerIdsTypeCheck` — treats the assigned-case exclusion as one global value resolved before a case is selected. It rejects every case-property or relationship read (including nested `prop`, `count`, `exists`, and `missing`) so Preview cannot resolve blank while an ordinary suite nodeset evaluates the same expression per row; literals, session/current-user values, Search answers, and pure calculations over them remain valid and must resolve to text.
- `searchInputDefaultTypeCheck` + `searchButtonDisplayConditionTypeCheck` carry the same global-context guard for their slots (`CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE` / `CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`): a prompt default evaluates when the search screen opens and the display condition emits as the Search action's `relevant` — both before any case is selected, where a case read emits as a bare relative leaf path that resolves blank (Preview deliberately resolves it blank too). Search answers are additionally invalid in these two (the default fires before the user types; the action relevance evaluates where the search-input instance isn't loaded — the standing `CASE_LIST_BARE_SEARCH_INPUT_REF` forbids-input-ref arm). Unlike the paired type-error codes these never depend on the catalog: the read is invalid whatever the property's type.
- `moduleDisplayCondition` + `formDisplayCondition` gate navigation conditions
  against their exact evaluation contexts. Modules admit no case/Search reads.
  Forms admit a direct self property of the owning case type only when
  `isCaseFirstModule` proves selection happens first; forms-first, related,
  presence/count, and Search shapes reject. Both conditions must be portable to
  Core's on-device evaluator (CSQL-only match modes, unsafe date arithmetic,
  and invalid fixed geopoints reject), and a deeply
  always-false condition is a soundness finding. Deeply always-true conditions
  disappear through `effectiveDisplayConditionForEmission`.
- `csqlPredicateRepresentability` — when case search is effective, rejects case-list filters and advanced-input predicates that CCHQ's server query language cannot represent faithfully (missing/direct query anchor, case-property reads on the comparison-value side, unsupported related counts, and self-relation envelopes). A reversible comparison with its sole property/count anchor on the right is admitted because the CSQL emitter swaps the operands and inverts ordered operators before emission; strict-null portability stays in the module-wide rule above so it produces one repair across every wire slot.
- `caseSearchConfigRequiresCaseType` — `<remote-request>` carries a mandatory `case_type` slot.
- `ancestorExistsCannotNestSubcase` — runs after shared relation canonicalization and CSQL relation-read adaptation. A canonical `any-relation(parent)` whose selected case type proves one graph direction is first narrowed to that ancestor or child direction, preserving filters CCHQ can faithfully express. Recursive, custom-index, and otherwise ambiguous `any-relation` paths retain both arms and are ancestor-bearing because CSQL emits an ancestor arm. CCHQ rejects ancestor-exists with subcase-exists or subcase-count nested in the filter argument.

Lookup-aware validation takes a required `LookupValidationContext` on every runner, commit, readiness, and boundary call. `available` carries one rows-free Project definition snapshot; `unavailable` is an explicit state, never an empty available registry or a reason to skip rules. `lib/doc/lookupReferences.ts` registers the immutable production structural extractors; ordinary carrier-free documents remain clean with unavailable context, while every persisted carrier occurrence is visible to the shared validator and edge writers. Synthetic tests may still inject a purpose-built extractor registry. Each exact occurrence validates independently: unavailable context, absent table, absent column, and incompatible column type use stable `LOOKUP_*` codes whose identity includes carrier uuid, registry slot, canonical nested subpath, table id, and column id. Missing and foreign definitions are deliberately indistinguishable. Commit validation gives previous and candidate docs the exact same context object; operational definition-read failures belong to the caller and must throw before writing or emitting rather than becoming findings.

The runner also materializes one rows-free table→column→type index from that
same snapshot and threads it through every Predicate/ValueExpression type-check
surface (module, form, case operation, and lookup-backed selects). Structural
extractors remain the sole owner of missing/unavailable table or column
findings; containing-slot type rules filter those checker codes so one broken
identity does not become a second generic type error. Lookup-backed select
filters have an additional row-scope contract: only columns from the source
table, literals, session values, and value-bearing answers earlier in effective
`(order, uuid)` DFS are available; a repeated answer must come from the current
or an enclosing repeat. Case/Search reads, later fields, child/sibling repeat
answers, other-table columns, and nested table lookups reject. The restriction
is leaf-based, so generic expression operators (including temporal and composed
values) remain legal over admitted leaves, and the real answer type—including
`multi_select`—continues into operator compatibility rather than being erased
by the row-scope policy. Semantic walking covers reachable forms only; the
structural extractor deliberately continues scanning the complete normalized
maps so detached persisted carriers cannot hide.

Case-operation lookup filters have their own form-completion correlation rule,
without relaxing ordinary operation expressions. A singular operation may read
root answers only. An operation running over repeat R may read root answers and
answers from R or any enclosing repeat; child, sibling, and unrelated repeats
reject. Ordinary operation terms remain exact-repeat-only because their current
wire bindings cannot safely address an enclosing repeat from a nested
operation.

Those structural rules are the whole commit policy: `evaluateCommit` adds no
carrier-specific finding, so an authored carrier lands like any other document
content once its identities resolve. The export boundary owns the verdict a
rows-free snapshot cannot prove. EVERY mode reads every referenced table's
complete rows, because every mode now carries the data: `ccz` embeds it as
suite fixtures, and the two HQ modes build the fixapi workbook. The
row-dependent select-source findings are common to all three — a choice list
whose saved values are blank or duplicated is equally broken however the table
reached the device — and are `environment`-class, since rows change outside the
document and must never gate a commit. What differs is what each CARRIER can
hold: `ccz` takes the aggregate fixture budgets, and the HQ modes take
`LOOKUP_HQ_PUSH_TOO_LARGE` (CommCare HQ's whole-workbook row ceiling) plus
`LOOKUP_TAG_TOO_LONG_FOR_HQ` — a data sheet is NAMED for its tag and a sheet
name holds 31 characters while a tag may be authored up to 32, so exactly one
authorable length is unpushable and the boundary refuses it by name rather than
letting the emitter meet a sheet it cannot name.

Every real export surface enters through the Nova-neutral server seam at `lib/export/boundaryValidation.ts`, selecting `ccz`, `hq-json`, or `hq-upload`. That seam loads definitions and complete ordered rows in one snapshot on every mode, passes the exact available context into `evaluateBoundary`, and returns the same snapshot with prepared media and the mode's lookup carrier (`lookupWire` on `ccz`, `lookupWorkbook` on the two HQ modes). Emitters consume that returned generation and never perform a second lookup read; operational lookup failures stop before expansion, compilation, or HQ import.

### Lookup wire — two carriers, one generation

`lib/commcare/lookup/` owns the carrier wire. `naming.ts` derives the one
identity resolver per emission run from the validated definitions
(tableId → current `tag`, columnId → current `wireName`; fixture id
`item-list:<tag>`, src `jr://fixture/item-list:<tag>`); every emitter resolves
through it and a missing naming is a deliberate throw — only the ccz path
supplies one to the XForm/suite emitters, so a carrier reaching any other
surface fails loudly.
`fixtures.ts` builds the suite-embedded global `<fixture id="item-list:<tag>">`
blocks — one `<{tag}_list>` body, one `<{tag}>` per row in authored
`(order_key, row UUID)` order, EVERY defined column as a child element in
authored column order with an empty element for missing and stored-empty cells
alike, matching HQ's `ItemListsProvider` body so the same XPaths work
whichever path later delivers the data. `SuiteParser`/`FixtureXmlParser`
(no `user_id` → global storage, overwrite on app upgrade) are the wire
authority: HQ never emits suite-embedded item-list fixtures. `compileCcz`
splices the blocks after `<menu>` elements, mirroring HQ's section order.
`cellText.ts` lexicalizes stored cells (text/temporal pass through; int/decimal
are the canonical JS number spelling); the aggregate 10,000-row /
100,000-cell / 16 MiB-exact-byte budgets and the row-dependent select-source
validity live at the export boundary, measured on the exact serialized blocks
the compiler embeds.

Lowering: a `table-lookup` becomes
`instance('item-list:<tag>')/<tag>_list/<tag>[<where>][1]/<column>` — the
explicit first-match positional predicate over authored row order; no match is
an empty node-set (ordinary absent-node semantics), never manufactured empty
text. Inside a `where` the fixture row is the predicate context: same-table
`table-column` terms print row-relative wire names, and a bare self
case-property re-anchors through the captured case anchor (`current()/<leaf>`
at root scope, the ancestor join chain otherwise) because Core preserves
`current()` from the first predicate. The row scope clears when emission
descends into a relation `where` (`clearLookupRowScope`), where the candidate
case is the context again. A lookup-backed select emits one `<itemset>` (label
then value column refs, filter predicate on the nodeset) with zero inline
`<item>`s and no option itext; its filter's form answers print absolute paths
at root and `current()`-relative paths for repeat-borne fields
(`bindLookupFilterFieldPaths` — `ItemSetUtils.populateDynamicChoices` binds
`current()` to the question node contextualized to its iteration). Instance
accumulation contributes `item-list:<tag>` everywhere a carrier is reachable —
XForm models (`InstanceTracker.requireFixture`), entries, menus, and remote
requests — through the same `collectPredicateInstances` /
`collectExpressionInstances` seams, now naming-parameterized. The suite oracle
cross-checks embedded fixtures (`SUITE_FIXTURE_INVALID`: id required/unique,
single body element, no `user_id`, every declared `jr://fixture/` src
delivered) and the XForm oracle checks itemset shape
(`XFORM_ITEMSET_INVALID`). Validator dry-runs use `inertLookupWireNaming` so
portability checks stay total without real definitions. Preview and
case-store SQL evaluate carriers (the preview reuses these
emitters row-scoped over its loaded fixture snapshot — see
`lib/preview/CLAUDE.md`); CSQL and the case-search `_xpath_query` path keep
rejecting them.

`workbook.ts` is the OTHER carrier: the `.xlsx` CommCare HQ's fixture upload
reads, built from the same `naming.ts` identities and the same
`cellText.ts` projection, so the workbook and the `.ccz` fixtures cannot
disagree about a decimal or an empty cell. Its byte oracle is CommCare HQ's own
exporter — `fixtures/download.py::_prepare_fixture` writes what
`fixtures/upload/workbook.py` reads back — so the sheet names and header
strings are the contract, not labels: a mandatory `types` sheet
(`Delete(Y/N)`, `table_id`, `is_global?`, `field 1`…) that CREATES the table
definition, and one data sheet per table NAMED BY ITS TAG (`UID`,
`Delete(Y/N)`, `field: <wireName>`…). `IteratorJSONReader.set_field_value` is
the header grammar (`a N` is a list, `a: b` nests, `a?` is a boolean). Because
the types sheet carries the definition, CommCare HQ's JSON `lookup_table`
resource is not on the write path at all. `lib/commcare/hq/lookupTables.ts`
drives both endpoints; `lib/deployment` owns what may be written over.

`compileForPlatform.ts` is the pure decision tree from authored content + `PlatformContext` to a three-flag `WireShape`. Author intent is unambiguous on every input — Android always emits list-first / inline-results; web with an effective Search action, an effective filter, and zero search inputs emits skip-to-results; an explicit zero-input action without that filter remains manual; web fallback is list-first. The flags drive the orchestrator's `<query>` attributes + storage-instance choice + the case-list short-detail emitter's `<action auto_launch>` attribute. The HQ JSON projection supplies a match-all default property for the explicit zero-input/manual shape because CCHQ offers Search only when a property or default property exists; this is wire scaffolding, not an authored filter.

### Search-first inline shape

`caseSearchConfig.searchFirst: true` (`lib/domain/modules.ts::moduleOpensOnSearch`)
lowers to HQ's inline search — `inline_search && auto_launch`
(`app_manager/util.py::module_uses_inline_search`), with `default_search` when
the module has no visible prompt — on both wire paths, whatever the platform.
The shape is a different suite, not a flag on the remote-request one, and
`compiler.ts` branches on `moduleIsSearchFirst` at every site:

- **No `<remote-request>`, no `m{N}_search_*` details, no Search `<action>`**
  on `m{N}_case_short` (`models/modules.py::get_details` skips the search
  details; `EntriesHelper` never adds the action). The search screen's
  translation units still emit (`inlineSearch.ts::searchScreenTranslationUnits`)
  because the `<query>` carries the same `<title>`/`<prompt>` locale ids.
- **Each case-requiring entry carries the search itself.** `<session>` is
  `[parent datum] <query url storage-instance="results:inline" template="case"
  [default_search="true"]>` then the own `<datum id="case_id"
  nodeset="instance('results:inline')/results/case[@case_type='t'][@status='open']{filter}[not(commcare_is_related_case=true())]{parent}">`
  (`EntriesHelper.get_query_datums` / `get_datum_meta_module`). The browse
  entry of a `caseListOnly` module carries the query and no post
  (`test_inline_search_case_list_item`). `formLinkProjection.ts::withInlineSearchQueries`
  inserts the query datum before every nodeset datum whose source module is
  search-first, after `alignWithRootMenu`, so a search-first parent-select
  source contributes its query to the child's chain too.
- **The claim `<post>`** (`claim.ts::buildInlineClaimPost`) sits between
  `<form>` and `<command>`. Single: `relevant="count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/V]) = 0"`
  + `<data key="case_id" ref=".../V"/>`. Multi-select: `relevant="$case_id != ''"`
  + `<data key="case_id" ref="." nodeset="instance('V')/results/value"
  exclude="count(instance('casedb')/casedb/case[@case_id=current()/.]) = 1"/>`.
  Parent-relationship parent-select
  (`module_uses_inline_search_with_parent_relationship_parent_select`):
  `relevant="$case_id != ''"`, own data plus one `<data>` per other case
  datum, each `exclude="count(instance('casedb')/casedb/case[@case_id=…]) != 0"`,
  and a trailing `_xpath_query "ancestor-exists(parent, @case_type='P')"`.
  The oracle is `tests/test_suite_inline_search.py::InlineSearchSuiteTest`;
  `__tests__/inlineSearchEmission.test.ts` pins five of its partials with the
  stack compared separately (HQ's fixture forms carry `post_form_workflow:
  default`; Nova's `module` default emits `[command 'm0']`) and three
  deliberate deviations (`x_commcare_include_all_related_cases`, the
  calculated `<variable>` template, the `@case_type` qualifier).
- **Instances.** `results:inline` is a Core instance id whose root prints as
  `results` (`predicate/termEmitter.ts::instanceRootPath`; `InstanceRoot` is
  `casedb | results | results:inline`), and every `input(...)` read on a
  search-first module — prompt defaults, Results filter, calculated columns,
  the search-button condition — prints `instance('search-input:results:inline')`
  (`validator/rules/case-list/shared.ts::moduleTypeContext` sets
  `searchInputInstanceId`; `session.ts::accumulateCaseLoadingInstances`
  declares it). Details read `caseSource: "results:inline"`
  (`suite/case-list/columns.ts::instanceRootFor`) so a calculated column's
  `current()/../case[...]` sibling walk resolves inside the results roster.
- **Links into a search-first module** carry HQ's `WorkflowQueryMeta` child:
  `<query id="results:inline" value="https://www.commcarehq.org/a/__DOMAIN__/phone/case_fixture/__APP_ID__/"><data key="case_type" ref="'t'"/><data key="case_id" ref="instance('commcaresession')/session/data/<source>"/></query>`
  (`formLinkProjection.ts::queryChild`, `CASE_FIXTURE_URL_TEMPLATE`;
  `test_form_linking_to_inline_search_module_from_registration_form`). The
  query is `requiresSelection` only without prompts and with `default_search`,
  so a manual-datum link that omits the selection is `FORM_LINK_DATUMS_INCOMPLETE`
  there too. The stack parser needs `id` and a `java.net.URL`-parseable
  `value` (`StackFrameStepParser::parseQuery`); `suiteOracle.ts` checks both
  (`SUITE_STACK_QUERY_INVALID`) and scopes the session-query rules to
  non-stack queries.

The four refusals mirror HQ's build validator (`helpers/validators.py`)
because every Nova-uploaded module carries a `search_config` shell, which is
what its `non-unique instance name` checks key on: `SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE`
(inline needs a case datum on every entry), `SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION`
(there is no action for `relevant` to gate), `SEARCH_FIRST_NO_PREVIOUS_WORKFLOW`
(explicit `previous` on a case form; `workflow previous inline search`), and
`SEARCH_FIRST_UNIQUE_INSTANCE` (no submenu under, and no parent-select from, a
search-first module; a search-first CHILD of an ordinary parent-select source
is fine). The setter tool refuses `searchFirst` on an owner-only config
because there is no search to open on.

`caseSearchConfig.searchButtonDisplayCondition` is orthogonal to that flag decision. It emits as the case-list Search action's `relevant` predicate, not as a Results-row filter and not as the `auto_launch` expression itself. Core first removes irrelevant actions and then evaluates auto-launch among the remaining actions, so the predicate gates the automatic transition only in the web filter-plus-zero-input shape; in every list-first shape it gates the manual Search action. Preview and authoring copy must preserve that distinction rather than treating any input-free search config as a generic “go to Results” rule.

### No-matches registration lowering

`Form.entry = { kind: "search-no-matches" }` (`lib/domain/forms.ts::isNoMatchesForm`)
is Nova's whole authoring of CommCare's `case_list_form`; the wire vocabulary
never enters a document (`validationRules.test.ts` keeps `case_list_form`
rejected by the strict module schema). `emissionPlan.ts::emissionPlan(doc)` is
the ONE derived module sequence both emitters walk: the authored preorder with
every no-matches form lifted out of its host, then one synthetic module per
lifted form appended in host order (`syntheticModuleUuid(formUuid)`, a UUIDv5
so `m{H}` is stable across emissions), carrying the host's case type and that
one form. `compiler.ts` and `expander.ts` consume the plan, so `m{N}` /
`unique_id` / `owningModuleOf` agree on both paths. The lowering is emitted
only when `hostLowersNoMatchesForm(host)` (the host opens on Search and has a
case type); a form whose module fails that is a validator finding, not a
partial emission.

- **Host module.** HQ JSON `case_list_form: { form_id, label,
  post_form_workflow: "case_list", relevancy_expression:
  "count(instance('results:inline')/results/case) = 0" }`; local suite an
  `<action relevant="count(instance('results:inline')/results/case) = 0">` on
  `m{N}_case_short` (row and tile) whose `<stack><push>` carries the synthetic
  form's command, the target's `case_id_new_<type>_0 = uuid()` datum, and
  `<datum id="return_to" value="'m{N}'"/>`, before any Search action
  (`suite/case-list/shortDetail.ts::RegisterActionContext`). The relevancy is
  an explicit boolean comparison because Core string-compares
  `Action.relevant` to `"true"`, and it is safe only in the inline shape,
  where `results:inline` exists before the list renders; the label rides
  `case_list_form.m{N}` (`emissionPlan.ts::caseListFormLabelUnit`, source
  `entry.label ?? form.name`). Bytes pinned to
  `tests/data/case_list_form/case-list-form-suite.xml` and the relevancy
  partial in `test_case_list_form.py`.
- **Synthetic module.** HQ `module_filter: "false()"` / local
  `<menu relevant="false()">` (`displayConditions.ts::NEVER_RELEVANT`): stack
  pushes ignore menu relevance, so the form is reachable through the action
  and nowhere else. Its entry's `<stack>` is the return frame
  `<create if="count(instance('commcaresession')/session/data/return_to) = 1 and instance('commcaresession')/session/data/return_to = 'm{N}'">`
  with the host command plus the `case_fixture` query child
  (`formLinkProjection.ts::caseListFormReturnFrame`), so the worker lands on
  Results showing exactly the case they registered; HQ regenerates the same
  frame from `post_form_workflow: case_list`
  (`test_form_linking_to_inline_search_module_from_registration_form`).
- **Carried answers.** The XPath leaf `search-answer-ref { searchInputUuid }`
  prints `#search/<name>` for people and emits
  `instance('search-input:results:inline')/input/field[@name='<name>']`
  (`xpath/expressionAst.ts` binds it only through
  `searchInputNameResolver(doc, formUuid)`, which resolves inside a no-matches
  form alone); `xform/builder.ts` declares the
  `jr://instance/search-input/results:inline` instance, `xpath/carriers.ts`
  admits it for that profile only, and no Vellum shadow is emitted for it.
  `validator/index.ts::searchAnswerRefError` refuses the leaf outside a
  no-matches form or against a prompt the module no longer has
  (`INVALID_SEARCH_REF`).
- **Validator** (`rules/case-search/searchNoMatches.ts`, all soundness):
  `SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST`, `…_NOT_REGISTRATION`,
  `…_HAS_NAVIGATION` (links, an after-submit choice, a display condition),
  `SEARCH_NO_MATCHES_DUPLICATE`, and `FORM_LINK_TARGET_NO_MATCHES_FORM` in
  `rules/form.ts`. `hqJsonOracle.ts::checkCaseListForm` pins `form_id`
  resolution and `post_form_workflow ∈ {default, case_list}`
  (`HQJSON_BAD_CASE_LIST_FORM`).
- **Compatibility.** HQ emits the action's `relevant` only under
  `FOLLOWUP_FORMS_AS_CASE_LIST_FORM` (`details.py::get_case_list_form_action`);
  without it the action is UNCONDITIONAL. The flag row is
  `no-matches-registration` in `config/commcare-hq-feature-flags.json`, the
  public capability `registration-after-empty-search` ("Registration offered
  after an empty search", required), derived by
  `projectSpaceCompatibility.ts::moduleRequiresNoMatchesRegistration`.
- **Web Apps only at runtime.** Android never shows the case list on an
  empty search response and passes no search-input extra
  (`QueryRequestActivity::processSuccess`), so author-facing copy says the
  action and the carried answers work in the browser app.

Module/form navigation display conditions use `suite/displayConditions.ts`.
Module conditions emit to `<menu relevant>` and HQ `module_filter`; their
secondary instances are child `<instance>` elements on that menu, requiring the
fixed HQ build 2.54. Form conditions emit to the menu's `<command relevant>` and
HQ `form_filter`; direct self properties structurally anchor through the
selected `commcaresession/session/data/<projected-own-case-id>` in local suite XML and through
HQ's `#case` interpolation in JSON. The matching entry declares the condition's
instances, including both `casedb` and `commcaresession` for a selected-case
read. Emit raw comparisons: Core's absent node-set becomes `""` for string
comparison and NaN for numeric comparison, so a generic presence guard would
change equality/inequality semantics.

`caseSearchConfig.excludedOwnerIds` is Results availability, independent from the Search action. It resolves once from global session/Search state before any case is selected, then constrains ordinary case-list nodesets and HQ short-detail filters as well as effective remote Search; it can never read the row being filtered. `emitNormalizedExcludedOwnerIdsExpression` authors the canonical `normalize-space(...)` intent, then immediately crosses `lowerXPathForJavaRosa`, which emits only JavaRosa-native nested `replace()` calls over XML whitespace into local-suite remote data and HQ JSON. The ordinary list feeds that same lowered value to `selected(...)`; this matches Preview's whitespace split instead of letting CCHQ/Core preserve empty tokens from repeated/trailing/tab whitespace. The ordinary list also short-circuits when the normalized value is blank because Core considers `selected('', '')` true for an unassigned row. Owner-only configuration emits no Search action or remote request. On the remote path the normalized expression translates to CCHQ's `commcare_blacklisted_owner_ids` `<data>` key; authoring vocabulary stays in the schema and SA tools, and that wire token lives only at the emission boundary.

### Instance accumulation — local `.ccz` vs HQ-regenerated suite

CCHQ's server-side suite post-process (`commcare-hq/.../suite_xml/post_process/instances.py::InstancesHelper.add_entry_instances`) walks every detail an entry references and adds the matching `<instance>` declarations on the enclosing `<entry>` / `<remote-request>`. Nova's local `.ccz` emission has no equivalent post-pass, so the accumulators at `session.ts::deriveEntryDefinition` and `suite/case-search/searchSession.ts::buildSearchSession` walk every XPath surface the body holds — `caseListConfig.filter`, advanced-arm predicates, simple-arm-with-via derivations, prompt defaults, `excludedOwnerIds`, `searchButtonDisplayCondition`, form command display conditions, and each calculated expression that is shown on Results/Details or used by Default order. Fully off-screen, unsorted definitions have no runtime role and are ignored. A missing accumulation surfaces as an undeclared-instance XPathException at runtime; the HQ-upload path is unaffected because CCHQ regenerates the suite from the persisted document.

Search carries supporting parent cases only when an emitted calculated Results/Details/Default-order value is exactly one direct ancestor property. `suite/case-search/relatedCaseProjection.ts` is the private shared decision: every saved definition is validated, but a fully hidden unsorted definition does not trigger emitted support rows; subcase, ambiguous, aggregate, and wrapped relation calculations are rejected for effective Search. The direct suite derives one `x_commcare_include_all_related_cases='true'` query datum. HQ JSON sets `include_all_related_cases` and stores the allowed column as a calculated `current()/../case[...]` expression, so CCHQ's copied ordinary/Search details resolve against their containing roster without losing canonical `@case_type` qualifiers; reserved case metadata leaves use their `@case_id` / `@case_type` / `@owner_id` / `@status` spellings. Both selection datums keep CCHQ's `[not(commcare_is_related_case=true())]` predicate exactly once, so supporting rows never become choices. Ordinary non-Search relation calculations retain their existing on-device expression projection.

A `caseListOnly` module emits a third case-loading entry — the standalone case-list-browse command (`session.ts::deriveCaseListEntryDefinition`, CCHQ's `case_list.show` block at `suite_xml/sections/entries.py`). It has no `<form>` (its `EntryDefinition.formXmlns` is omitted, and `buildEntryElement` skips the `<form>` child) and its `case_id` datum always carries `detail-select` (`m{N}_case_short`); `detail-confirm` (`m{N}_case_long`) appears only when the author put information on Details. With no Details fields, selection stays on Results instead of navigating to an empty screen. It loads the same details the form entry does, so it shares the case-loading nodeset builder and the body-instance accumulation with `deriveEntryDefinition` (`session.ts::accumulateCaseLoadingInstances`) — and is the SOLE loader of those details in a formless module, so it's the only place their instances can land. Without this command the `caseListOnly` module's `<menu>` carried zero commands and the case list was unreachable on a directly-installed `.ccz`, diverging from the HQ-regenerated suite.

Results and Details have independent column sequences, held as the config's two arrays. `listColumnOrder` drives the running results list, suite short detail, HQ `case_details.short.columns`, and every sort tie-break / calculated-sort positional index; `detailColumnOrder` drives the running confirmation screen, suite long detail, and HQ `case_details.long.columns`. Read either through `orderedColumns(config, surface)` — the storage array is a SET and its position means nothing. CCHQ already stores short and long as separate ordered arrays; never collapse the two surface sequences at emission.

Every saved column definition is validated unconditionally, even when hidden
from both layouts and absent from sort. Only Preview, CommCare emission, and
emitted-reference walks consult `caseListColumnIsEmitted`; hiding never creates
deferred invalid state and revealing never repairs or rewrites a definition.

Sort lives on each column. The wire emitter walks columns in Results order,
drops columns without a `sort` slot, sorts the survivors by `priority`
ascending (tie-break to Results index), and emits one `<sort>` block per column
carrying its 1-based `order` attribute. Priority collisions are rejected at the
commit gate (`CASE_LIST_DUPLICATE_SORT_PRIORITY` is soundness); the defensive
tie-break keeps projection deterministic if malformed input reaches an
inspection boundary. The schema has no parallel `SortKey[]` array, so sort
directives cannot refer to a non-existent column.

The comparator type for each `<sort>` is derived at wire emission, not authored. The dispatch lives in `sortKeys.ts::resolveColumnSortType`: property-rooted columns (plain / date / phone / id-mapping / interval) consult `applicableSortTypes(propertyDataType)[0]`; calculated columns consult `checkExpression(expression)` mapped to a `SortType`. Three explicit failure shapes — `undefined` (resolution failure), `ANY_TYPE` (e.g. on a `null` literal arm), or a `ResolvedType` with no mapping (defensive — covers schema drift) — route to comparator type `"plain"` (lexicographic).

Calc-column sort directives write `field: "_cc_calculated_{columnIndex}"` (matching `commcare-hq/.../app_manager/const.py::CALCULATED_SORT_FIELD_RX`) so sibling calc sorts each get their own row in CCHQ's `sort_elements_by_field` dict — a shared placeholder key would collapse multiple calc sorts on the HQ-uploaded path.

The `Column` discriminated union has seven arms — `plain`, `date`, `phone`, `id-mapping`, `image-map` (the id-mapping shape with image paths instead of text labels — emits CCHQ's `enum-image` format, `<template form="image">`, with inlined `jr://file/commcare/...` literals; degrades to a plain column when media emission is off), `interval` (covers both relative-display and threshold-flag UX, dispatched by `display: "always" | "flag"`), and `calculated` (a `ValueExpression` AST node — calculated columns are a column kind, not a parallel array). Calculated columns emit CCHQ's inline-`<variable name="calculated_property">` template (verified against `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.template`'s `useXpathExpression` branch); they have no `field` slot — the expression is the source.

A `plain` column stays a bare property reference for ordinary properties. When its effective property is `single_select` or `multi_select` and carries an option catalog, `columns.ts` derives worker-facing labels in the template XPath so the installed app matches Nova Preview. Single-select uses nested exact-equality arms (`field = 'value'`) with the raw property as the final fallback — never `selected()`, whose space-token membership would let one option value shadow a later multi-word value and diverge from Preview's exact-match projection. Multi-select renders known labels in catalog order and independently removes only those known tokens from a normalized raw copy; remaining imported/historical tokens are appended unchanged, so a catalog edit never makes saved data disappear.

Per-surface visibility lives on the column. The `MISSING_CASE_LIST_COLUMNS` completeness rule requires at least one `visibleInList !== false` field on every reachable case list, including a `caseListOnly` viewer; Details may be empty. `longDetail` and HQ `case_details.long.columns` omit `visibleInDetail: false` entries entirely — CCHQ's `invisible` format only collapses short details and would render normally on an ordinary long detail. `shortDetail` normally omits `visibleInList: false`; when such a field still owns a Default-order rule it emits the standard zero-width sort-carrier shape (`<header width="0">` + `<template width="0">` + `<sort>`), so ordering survives without resurrecting the field in Results. HQ short details retain the corresponding `format: "invisible"` column for the same positional/sort reason.

The `interval` kind covers both relative-interval and threshold-flag UX through one `display` discriminator. `display: "always"` always shows the relative interval (the runtime label decorates the cell when the threshold is exceeded); `display: "flag"` only shows the `text` slot when the threshold is exceeded (otherwise empty cell). Both arms share the same `(threshold, unit)` mechanics; the dispatcher in `columns.ts` switches on `column.display` to pick the per-arm wire emission.

## CommCare HQ upload

`importApp` creates an app, or — given the optional HQ app id — updates that
app in place: HQ's import endpoint takes an `app_id` multipart field
(`corehq/apps/app_manager/views/app_import_api.py::_handle_import_app`,
update via `overwrite_app_from_source`; 200 `{success, app_id, version}` on
update, 201 without `version` on create, 404 `Application not found` for an
unknown id). Which of the two a publish does, and what happens to it
afterwards, lives in `lib/deployment`:
this package owns the HTTP calls, that one owns the lifecycle, the ownership
ledger, and the setup artifact. The three reads a key CAN make about a
published app (`readAppVersions`, `listAppBuilds`, `probeBuildProfile`) live
here beside the writes. `probeBuildProfile`'s doc block states what that call
actually is: the catch-all `download_file` route handles it, not
`download_odk_profile`, so it can regenerate a build's files, and naming a
BUILD id is what keeps it on that build instead of falling through to
`autogenerate_build` and starting a new version. Dimagi runs three separate SaaS deployments (`servers.ts`: production/www, india, eu — mirroring HQ's `ServerLocation`), each with its own account DB, so an API key only authenticates against the server that issued it; the connection stores which one it was verified against and every request derives its base URL from that closed catalog (the SSRF boundary — never a user-supplied URL). User API keys are KMS-encrypted at rest via `./encryption`. Domain slugs are validated against HQ's legacy regex to prevent path traversal in the import URL.

A key is **not** one-project-per-user: an unscoped HQ key reaches every project space its owner belongs to. `discoverAccessibleDomains` lists them and probes app-level access in a bounded-concurrency window (an unbounded fan-out self-inflicts a 429 on big accounts). The upload *target* is chosen by `resolveUploadDomain` (`@/lib/db/domainResolution`) — explicit arg, else the sole space of a single-space key, else **error** (ambiguous) for a multi-space key (never silently the first space). There is no stored default: a multi-space key's target is a per-upload choice. Don't reintroduce the one-project assumption that caused the wrong-target bug.

The import endpoints carry `@csrf_exempt` (`app_import_api.py`, live on all
three servers since commcare-hq `b5dfe459`), so the client fetches no CSRF
token. They also carry `@waf_allow('XSS_BODY')`, and **that decorator does
not make the WAF let the upload through**:
`corehq/apps/hqwebapp/decorators.py::waf_allow` only records the view in a
module-level dict for whoever configures the WAF, wrapping nothing and
changing nothing at request time. The WAF in front of CommCare HQ still
matches an `xmlns=` / `xmlns:<prefix>=` declaration in roughly the first
8 KiB of a request body and answers 403 from the edge, before Django. So
both uploads still send `WAF_PADDING` as their FIRST multipart field — the
XForm XML inside `importApp`'s JSON and the compressed bytes inside
`uploadAppMediaBundle`'s ZIP both match otherwise. Removing the padding
does not fail loudly or uniformly: only apps small enough to put their
first form's XML inside that window break, which reads as an app-size bug
rather than a wire one. `isEdgeRefusal` marks those responses
(`CommCareApiError.edgeRefusal`) so no surface reports a proxy's 403 as a
verdict about the key or the account's permissions.

**The generated app shell carries only fields Nova authors.** HQ's update is an
overlay merge (`_merge_source_into_app`): a field present in the source
overwrites the HQ app's value, and an absent one is retained. So target-owned
settings and state — `cloudcare_enabled`, `case_sharing`,
`secure_submissions`, the build/release metadata, and the rest of HQ's app
Settings page — are never emitted by `hqShells.ts::applicationShell`, and
`logo_refs` is emitted only when the app has a Nova-authored logo. `profile` is
the narrow exception added by the derived projection above: a new-app artifact
may carry Nova's allowlisted derived properties, and an in-place update may
emit the target's complete current profile only to change those properties. An
inconclusive advisory update omits `profile` and preserves the target's current
value. Adding any other shell field means deciding whether Nova authors it,
because every emitted field stomps the target's value on every republish.

## Not-yet-modeled

HQ features the pipeline does not cover yet — the validator's `app`/`module`/`form`/`field` rules gate additions as they land:

- Shadow modules, parent-select cycles
- Smart links, case list field actions
- Sort field format regex, multimedia
- Itemset `<copy>` mode (lookup-backed selects emit value/label itemsets)
- Repeat homogeneity

Validation stubs that activate when features land:
- `previous` + `multi_select`
