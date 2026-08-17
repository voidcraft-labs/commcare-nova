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

The app language catalog uses Nova codes and metadata until this boundary. HQ
`langs`, localized property maps, itext language/default attributes,
`default/app_strings.txt`, per-language directories, endonyms, and
`lang.current` are one-way CommCare wire spellings here.

### CommCare HQ feature-flag lifecycle

`config/commcare-hq-feature-flags.json` is the single lifecycle catalog for HQ
feature flags required by wire Nova emits today. `featureFlags.ts` derives the
wire-specific requirement detector; `lib/publish/hqFeatureFlags.ts` derives the
serialized HTTP/MCP contract, public UI/docs catalog, and autonomous FYI without
giving browser code access to this emission boundary. Add an entry only with an
actual Nova emitter and exact current HQ source evidence. Remove or update it
when the upstream flag graduates or changes; never leave a retired flag as
historical documentation.

The publish modal's read-only preflight probes a selected HQ domain on open,
selection, and explicit refresh; direct HQ upload probes the selected domain
again only after `import_app` succeeds. Each required domain-only flag is
queried through the paginated
`UserDomainsResource` feature-flag filter. A negative result is confirmed
missing; an HTTP/shape/namespace failure is unverified and never blocks or
relabels the successful upload. JSON and CCZ have no target domain, so their
report is always `not_checked`: the flags are requirements, not known missing.
The MCP-only `get_app_hq_feature_flags` tool exposes the same detector before
any publish: each requirement carries app-specific reasons and inline public
docs content/links. With no domain it makes no state claim; with one explicit
connected domain it uses the same probe and missing/unverified distinction as
the modal. Keep it MCP-only; Nova's internal SA speaks domain vocabulary and
does not own CommCare deployment concerns.
The weekly `commcare-hq-feature-flags` workflow runs
`scripts/audit-commcare-hq-feature-flags.mjs` against current upstream HQ and
fails when symbols, slugs, namespaces, tags, or the recorded emitter evidence
drift. It also pins the shared `UserDomainsResource` filter/unknown-slug probe
contract. That failure is the retirement/GA or probe-compatibility review
signal.

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

`casedb` and `commcaresession` are accumulated at the point of use — XPath field + label scans, Connect expression scans. `casedb` implies `commcaresession`. One declaration happens outside `buildXForm`'s scan: `xform/caseBlocks.ts::addCaseBlocks` splices case-preload setvalues that read from `casedb` after the scan has run, so it declares `casedb` itself (idempotently) when it emits a preload.

### `post_submit` defaults

Controls post-submit navigation. The stored and machine-authored vocabulary is
exactly `app_home`, `module`, or `previous`. `lib/commcare/session.ts` projects
those values one-way to the different workflow spellings required on the wire;
wire vocabulary never enters the domain. Form-type defaults when absent:
followup/close → `previous`, registration/survey → `app_home`. The SA only sets
`post_submit` when overriding the default.

### Form links

`form_links` on a form enables conditional navigation: `condition?` (XPath) + `target` (form or module by uuid) + optional `datums`. First matching condition wins; `post_submit` is the fallback. Fully validated.

Core evaluates each form-link condition and datum as a post-form session-stack
operation, after the XForm instance has closed. These expressions may read the
entry's session and loaded case instances, but never `#form/...` or `/data/...`.
`expander.ts::translateFormLinks` projects typed case/user references into that
session scope and lowers JavaRosa shims; `deriveEntryDefinition` declares every
secondary instance the projected strings use. Empty datum XPath is invalid
(unlike an omitted condition, which means unconditional navigation).

### Repeat modes

Three modes via `repeat_mode` discriminator, each emits different wire shape:

- **`user_controlled`** — bare `<repeat nodeset="...">`. Runtime adds/removes instances.
- **`count_bound`** — `<repeat nodeset="..." jr:count="<path>" jr:noAddRemove="true()">`. `jr:count` MUST be a location path: JavaRosa parses it through `XPathReference`, which rejects any non-path expression (`commcare-core .../XPathReference.java::getPathExpr` → `XPathTypeMismatchException`). So the emitter classifies the expanded count via the Lezer parser (`xform/countReference.ts::isCountReferencePath`): a path emits directly; a literal/expression hoists into a hidden form-root node `__nova_count_<fieldId>` (seeded by a `<setvalue event="xforms-ready">`, bound `xsd:int`) and `jr:count` points at that node — the canonical `group_relevancy_in_repeat.xml` shape. The `__nova_` namespace is reserved against authored field ids by the `RESERVED_FIELD_ID_PREFIX` validator rule. Either way JavaRosa evaluates `jr:count` ONCE at form load; cardinality is frozen even when dependencies change. CommCare/JavaRosa spec — not a Nova choice.
- **`query_bound`** — Vellum's "model iteration" pattern. Data section nests `<item>` under the parent (`<id ids="" count="" current_index="" vellum:role="Repeat"><item id="" index="" jr:template="">…</item></id>`); body's `<repeat>` targets `<id>/item`; four `<setvalue>` elements seed `@ids`/`@count` (xforms-ready, OR jr-insert when nested inside another repeat) and `@index`/`@id` (jr-insert always); a `<bind nodeset="<id>/@current_index" calculate="count(<id>/item)"/>` drives the per-iteration index. Same one-time-eval freeze as count_bound.

`children`'s bind paths pick up the extra `/item` segment in query_bound — `childParentPath` rewrite in `xform/builder.ts` propagates this everywhere downstream.

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
- **case-update**: `case_id` calculates from the case-loading session datum `case_id`. Same meta-block bindings for the two timestamp attributes. Every per-property update bind also carries `relevant="count(<qPath>) > 0"` — the JavaRosa semantic when a field's `relevant` evaluates false is that the data node is absent, and an unguarded update would overwrite the existing case property with empty. The guard mirrors CCHQ's `XFormCaseBlock.add_case_updates`. Removing it silently destroys preserved case data on every conditionally-hidden field.
- **case-preload**: one `<setvalue event="xforms-ready">` per `case_preload` entry, reading the loaded case's property from `casedb` (`instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/<prop>`). Mirrors `XForm.add_case_preloads`. Spliced in after `buildXForm`'s instance scan, so `addCaseBlocks` declares the `casedb` instance itself (idempotently — skipped when a field-level case reference (`#<type>/…`) already pulled it in), mirroring `add_case_preloads`'s `add_casedb()`. Preload is the structural source of a case-loading form's initial field values — the agent layer stamps no `default_value` for this (`lib/agent/contentProcessing.ts::applyDefaults`). Gotcha: the preload setvalue lands after the field's own `default_value` setvalue in document order, so the loaded case value wins at `xforms-ready`. This matches a CCHQ-uploaded app (CCHQ emits preload regardless of any authored default) — an explicit `default_value` on a case-loading form's case property does not change what the user sees.
- **subcases**: per-subcase session datum `case_id_new_<subcasetype>_<idx>` (index mirrors CCHQ's `Form.session_var_for_action` — starts at 1 when the form also opens a primary case). Repeat-context subcases use literal `uuid()` calculate instead (no session datum is emitted for them, matching CCHQ's `delay_case_id` branch). Owner-id binds to `/data/meta/userID` on EVERY subcase regardless of relationship: the basic module Nova uploads runs `autoset_owner_id_for_subcase` (`'owner_id' not in case_properties`, which is always true for Nova's subcases), so CCHQ's regenerated form carries the userID owner bind for child and extension subcases alike. (The unowned-`owner_id` sentinel is an advanced-module-only shape — `autoset_owner_id_for_advanced_action` — which Nova never emits; the `extension` relationship is carried solely on the `<index>`.) Each subcase's name question also gets `required="true()"` merged onto its bind, same as the primary case. A subcase **close-on-submit** branch exists (renders `<close>` + a `relevant` bind from the subcase's `close_condition`) but is dormant: no authoring surface sets an active subcase close today, so `buildFormActions` always emits a `never` condition there; the branch is exercised only by `__tests__/caseBlocks.test.ts`.

The case-attachment shape (`update_attachment_case.xml` — a captured media field persisted to `<case><attachment>`) is NOT emitted: capture-field schemas carry no `caseWrite`, so the state is unrepresentable. Supporting it is a separate feature (add an explicit authoring model + emit on both pipelines + CCZ media bundling), distinct from the display-media work.

### Authored case-operation emission

`xform/caseOps.ts` lowers typed `Form.caseOperations` into the authored XForm source, so HQ upload and local `.ccz` compilation consume the same cx2 blocks; it is not another `FormActions` post-process. Each multiplicity scope gets a reserved `__nova_operations` container and each operation is a Vellum-recognizable `SaveToCase` wrapper carrying `vellum:case_type`. Singular operations live in the form root container, which is prepended before authored fields. Repeated operations are appended into the referenced repeat's exact iteration template after its authored children. Because CommCare Core executes case blocks in XML document order and a repeated effect cannot leave that template, the only representable cross-scope sequence is root followed by repeat scopes in post-order field traversal; `lib/doc/caseOperationOrder.ts` is the shared validator/planner proof of that constraint. On local compilation, the existing `FormActions` primary-case/subcase post-process appends its blocks after the authored field tree, so every advanced operation executes before Nova's ordinary primary-case action; the integration oracle pins that relationship explicitly. The rolling type proof includes those final implicit consumers: an ordinary primary write and every child-case parent index require the session case to retain the module type. A write-free close block needs only the case id and remains type-agnostic. The proof keeps every transition rather than only the latest nominal type, so a conditional restore cannot hide the branch where the case still has the prior transitioned type.

Inside `<case>`, child order is canonical and pinned against current Vellum/Core sources and fixtures: `<create>` (with `case_type`, `case_name`, `owner_id`), `<update>`, `<close>`, then `<index>`. Registration `external_id` is deliberately in `<update>`, never `<create>`, per CCHQ's exact `open_case_external_id.xml` fixture; child create and existing-case writes use the same scalar update leaf. Every non-create block carries a materially present update. When it has no authored update child, Nova emits an idempotent `case_type` assignment to the already-declared type: Core therefore takes the clean update-before-index missing-case path, and HQ classifies pure close/index blocks with an actual update sort key. An empty `<update/>` is sufficient for Core but NOT for this HQ ordering proof — HQ's parser treats it as absent when another action exists. Generated singular create ids alone use Vellum's `xforms-ready` setvalue. An `idFrom` answer is NOT emitted raw: the shared versioned contract derives `nova-case-v1:<UUIDv5(app,form,operation,type)>:<exact-key>`. The fixed namespace and JSON tuple serialization are pinned by TypeScript/XPath vectors; operation display-id renames and reorders do not affect it. A live calculate bind is used even when singular, so the submitted id reflects the final answer. The source field must be scalar text/single-select/hidden-string; multi-select is an array in Nova but a space-token string on device and has no safe implicit key serialization. The calculation accepts 1–205 UTF-16 code units, performs no trim/case-fold/Unicode normalization, and returns blank outside that range so Core/HQ reject the whole transaction rather than exceed HQ's 255-character case-id column or merge every blank row. Repeated duplicate keys intentionally address the same case, as does a retry of the same app/form/operation/type/key; the app/form/operation/type namespace separates every other ordinary collision, including type edits and two operations sharing one field. The order gate rejects a later non-create that can target that merged case when both definitions share a repeated execution ancestor: Core executes `C1,U1,C2,U2`, while HQ groups the concrete id and create-sorts `C1,C2,U1,U2`. A provably distinct target and independent root sibling repeats remain legal. Those deterministic identities are type-stable: a known authored-create retype is rejected statically, and every data-dependent retype gets a trailing atomic guard that rejects a `nova-case-v1:` target before the effect can commit. Because HQ sorts one case's create blocks before non-create blocks, a deterministic-key create must still precede all non-create operations whose runtime target could be that existing case; the shared order checker rejects the unsafe inverse. Targets otherwise come from earlier-create identity, the loaded session case, or a typed expression; repeated `id-of` binds are relative only within the exact correlated iteration. An `id-of` nested anywhere in a runtime target/link expression is rejected: only the first-class `op` target can address a fresh create without incorrectly filtering it through the pre-submission casedb. Owner expressions use explicit Nova vocabulary: `acting-user` emits `/data/meta/userID`, `unowned` emits the fixed `-` sentinel, and a create with no owner expression defaults to the acting user. Ordinary and advanced fixed-text scalar calculates pass through JavaRosa `replace(..., '^[\x00-\x20]+|[\x00-\x20]+$', '')`, matching Java `String.trim()` while preserving internal text. Guards cap every value at 255 Java/JS UTF-16 code units; names and explicit owners must also remain nonblank, while `external_id` may be the real empty string. Failure rolls the whole submission back. This pins the shared `caseScalarText.ts` contract for wire, Preview, and storage. Every operation-carried case type uses Core's identifier grammar and 255-character cap; every link identifier is XML-safe and at most the HQ index column's 255 characters.

Location owners add two exact leaves to that vocabulary. `fixed-location` lowers its app-scoped place UUID as a literal. `owner-location-at-level` lowers to `instance('locations')/locations/location[@type='<destination-level-code>'][@<nearest-case-owning-ancestor-code>_id = <owner-case-expression>]/@id` and pulls both `locations` and `casedb`. Either leaf must occupy the complete owner expression; the validator refuses name, rename, and nested carriers and proves the destination level owns cases before this boundary can print it. The export boundary currently rejects BOTH leaves for `.ccz`, HQ JSON, and HQ upload: the usercase/deployment unit has not shipped the matching persona-scoped `locations` fixture or local-to-HQ identity map, and an expression without that data would be a valid-looking dead owner rule.

Every expression sees one pre-submission snapshot. Form answers and earlier create ids bind explicitly; repeat-local identity paths start at `current()` so they remain anchored on the operation bind even while a nested relation predicate temporarily evaluates a `casedb` candidate. Root case-property reads anchor on `commcaresession/session/data/case_id` in `casedb`, including root relation predicates and counts, while related-case candidate properties remain candidate-relative. Those case-reading expression paths add `commcaresession` with `casedb`. A runtime expression target is lowered through `casedb/case[@case_id=(...) and @case_type='snapshot-type']/@case_id`, never emitted as an unchecked id. The shared order analysis keeps that immutable lookup type separate from the rolling semantic type, so A→B retype followed by a B operation on the exact same target still finds the pre-submission A row. Different ASTs can nevertheless resolve to one concrete id; the static gate therefore rejects a later differently-typed target/link after a potentially aliasing transition unless the ids are provably distinct. Repeated retype is restricted to an exact correlated generated create because duplicate repeat values otherwise make the second iteration consume the first iteration's result type. The authoritative submission envelope (`lib/case-store/postgres/submissionEnvelope.ts`) repeats this proof over expanded, server-resolved ids with `validateResolvedCaseOperationTypeSequence`. Dynamic link targets get the same selector plus a trailing empty-update guard block whose id is the operation case only when the typed link selector resolved to a different id. On absent/wrong type/self-link the blank guard id raises the clean transaction error before an empty index value could be mistaken for an unlink; on success the guard no-ops the case the operation already touches, never the linked case. Server-side preview separately reauthorizes Project/type facts; neither path trusts a client type descriptor.

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

### Case-search emission

The `<remote-request>` block's `<session>` carries ONE `<data key="_xpath_query">` element PER composed clause — the unified filter's top-level conjuncts, each advanced-arm search input's predicate, and each simple-arm input whose `(mode, via)` shape needs explicit-predicate emission. The server AND-composes every `_xpath_query` value it receives (`commcare-hq/corehq/apps/case_search/utils.py::_apply_filter` loops the multi-term criteria into one ES filter each; `commcare-core .../session/RemoteQuerySessionManager.java::getRawQueryParams` accumulates a `Multimap`, formplayer forwards repeated params, and Django folds them into a list at `corehq/apps/ota/views.py::app_aware_search`), so N small readable expressions filter identically to one fused mega-expression. On HQ JSON the same clauses land as N `default_properties[]` rows (`DefaultCaseSearchProperty` is a `SchemaListProperty`; CCHQ's `remote_requests.py::_remote_request_query_datums` loops every row into its own `<data>`).

Each clause's on-device wrapper is the shortest correct shape: a constant-only clause is a bare XPath string literal (HQ's own static emission shape); an input-gated clause is the doc-canonical `if(count(<input>), <query>, 'match-all()')` presence cascade with its value guards inside the presence branch; a clause whose only runtime interpolation is one free-text string uses the flat quote cascade (double-quoted CSQL delimiters, flip to single on an embedded `"`, fail closed on both — CSQL has no escape syntax per `eulxml/xpath/lexrules.py::t_LITERAL`, and the fail-closed arm emits the deliberately invalid `search-value-mixes-quote-marks()` because Android never enforces prompt validation, making the on-device guard the injection defense there). A `date`-widget input's value is picker-formatted on every runtime that binds it (Android doesn't support `input="date"` prompts at all), so it interpolates quote-free between fixed double-quote delimiters with no guard and no prompt validation.

The clause composition runs through `suite/case-search/xpathQuery.ts::composeXPathQueryEmission`, the single contract both the suite-XML emitter and the HQ-JSON emitter (`hqJson/caseList.ts::projectDefaultProperties`) consume. Simple-arm inputs that need explicit-predicate emission route through `suite/case-search/simpleArmDerivation.ts::deriveSimpleArmPredicate`, which lifts the `(property, mode, via)` shape to an advanced-style predicate (`when-input-present(input(name), op(prop, input(name)))`). Every search input still emits a prompt binding on both wire paths (`<prompt>` in local suite XML; `search_config.properties[]` in HQ JSON) because that is the only source CommCare uses to populate `instance('search-input:results')`. Every advanced prompt, plus every simple prompt routed through `_xpath_query`, emits `exclude="true()"` (suite XML) / `exclude: true` (HQ JSON): Core continues binding the typed value but does not ALSO submit the prompt key as an implicit exact case-property filter. Without that exclusion the automatic query parameter silently ANDs with the authored predicate; omitting an advanced `properties[]` row on HQ JSON removes the input from CCHQ's regenerated search screen entirely. Three CCHQ-runtime facts drive the routing rule:

- CCHQ's `CaseSearchProperty` carries no per-input matcher-strategy flag — verified against `commcare-hq/corehq/apps/app_manager/models.py::CaseSearchProperty`. The runtime default for a bare prompt is exact full-string match (`commcare-hq/corehq/apps/es/case_search.py::case_property_query` → `exact_case_property_text_query`). Fuzzy / phonetic / starts-with / fuzzy-date matching only reaches the runtime through an explicit XPath function call inside `_xpath_query` (`fuzzy-match` / `phonetic-match` / `starts-with` / `fuzzy-date` registered at `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`).
- CCHQ's `daterange` prompt binds one inseparable start/end pair. Nova therefore requires `range` mode if and only if the widget is `date-range`; that exact stored arm has no scalar `default` slot. Do not reinterpret one scalar as a From-only default. Exact one-date searches against datetime properties lower to UTC half-open day bounds, matching CCHQ CSQL's verified `datetime('YYYY-MM-DD')` UTC result rather than a hidden project or database-session timezone.
- Each `<prompt key="X">` binds one runtime value via `instance('search-input:results')/input/field[@name='X']` and carries no relation-walk metadata.
- CCHQ's runtime auto-matches the typed value against the case property NAMED BY the prompt key — verified against `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::build_query_prompts` (`'key': prop.name`) and `commcare-hq/corehq/apps/case_search/utils.py::_apply_filter` (the non-special key routes through `_get_case_property_query(criteria)` keyed on `criteria.key` as the case property name). Nova's authoring keeps the prompt key (`SearchInputDef.name`) and the targeted property (`SearchInputDef.property`) as separate slots; when the two diverge, the auto-match queries a property that may not exist. The `exclude="true()"` attribute (verified at `commcare-core/.../session/RemoteQuerySessionManager.java::RemoteQuerySessionManager.getRawQueryParams`) suppresses the auto-match without unbinding the typed value.

The routing rule is `(input type, mode, via, name vs property)`-shaped: a non-date `exact` input (or `range`) on self-walk / absent `via` AND `name === property` rides on the bare prompt slot alone (CCHQ's runtime auto-match against the prompt key IS the authored comparison; the `daterange` widget handles the two-bound semantic internally for the current case). A simple `date` input in exact mode always routes through `_xpath_query`: Nova lowers it to a half-open whole-day interval, using date boundaries for date properties and UTC datetime boundaries for datetime properties (including indexed metadata), because bare exact equality would miss every non-midnight datetime. Every other combination — non-`exact` modes on any via, `exact` mode with a non-self via, OR `exact` mode with `name !== property` — also routes through `_xpath_query` and stamps `exclude="true()"` on the prompt. Simple-arm properties are structurally nonblank, so every stored input reaches one of these final wire paths.

Validator rules anchoring the wire contract:
- `searchInputViaModeCompatibility` — rejects `range` on a non-self via and `range` with `name !== property` on self-walk. Simple multi-select matching is absent from the stored Search union.
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
rows-free snapshot cannot prove, and it is mode-split by which mode reads
rows. `ccz` reads every referenced table's complete rows, builds the fixture
blocks (below), and takes the row-dependent select-source and aggregate-budget
findings — `environment`-class, since rows change outside the document and
must never gate a commit. `hq-json` and `hq-upload` read the rows-free
definitions snapshot alone and derive no wire naming, so they reject every
authored carrier with the mode-bearing `LOOKUP_CARRIER_EXPORT_NOT_ACTIVE`
until the complex-app plan's push-and-provisioning unit pushes and maps the
resources — a carrier never reaches those
emitters unresolved.

Every real export surface enters through the Nova-neutral server seam at `lib/export/boundaryValidation.ts`, selecting `ccz`, `hq-json`, or `hq-upload`. That seam loads definitions even for an empty target set (plus complete ordered rows in one snapshot on `ccz`), passes the exact available context into `evaluateBoundary`, and returns the same snapshot with prepared media and lookup resources. Emitters consume that returned generation and never perform a second lookup read; operational lookup failures stop before expansion, compilation, or HQ import.

### Lookup wire — local CCZ only

`lib/commcare/lookup/` owns the carrier wire. `naming.ts` derives the one
identity resolver per emission run from the validated definitions
(tableId → current `tag`, columnId → current `wireName`; fixture id
`item-list:<tag>`, src `jr://fixture/item-list:<tag>`); every emitter resolves
through it and a missing naming is a deliberate throw — only the ccz path
supplies one, so a carrier reaching any other surface fails loudly.
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

`compileForPlatform.ts` is the pure decision tree from authored content + `PlatformContext` to a three-flag `WireShape`. Author intent is unambiguous on every input — Android always emits list-first / inline-results; web with an effective Search action, an effective filter, and zero search inputs emits skip-to-results; an explicit zero-input action without that filter remains manual; web fallback is list-first. The flags drive the orchestrator's `<query>` attributes + storage-instance choice + the case-list short-detail emitter's `<action auto_launch>` attribute. The HQ JSON projection supplies a match-all default property for the explicit zero-input/manual shape because CCHQ offers Search only when a property or default property exists; this is wire scaffolding, not an authored filter.

`caseSearchConfig.searchButtonDisplayCondition` is orthogonal to that flag decision. It emits as the case-list Search action's `relevant` predicate, not as a Results-row filter and not as the `auto_launch` expression itself. Core first removes irrelevant actions and then evaluates auto-launch among the remaining actions, so the predicate gates the automatic transition only in the web filter-plus-zero-input shape; in every list-first shape it gates the manual Search action. Preview and authoring copy must preserve that distinction rather than treating any input-free search config as a generic “go to Results” rule.

Module/form navigation display conditions use `suite/displayConditions.ts`.
Module conditions emit to `<menu relevant>` and HQ `module_filter`; their
secondary instances are child `<instance>` elements on that menu, requiring the
fixed HQ build 2.54. Form conditions emit to the menu's `<command relevant>` and
HQ `form_filter`; direct self properties structurally anchor through the
selected `commcaresession/session/data/case_id` in local suite XML and through
HQ's `#case` interpolation in JSON. The matching entry declares the condition's
instances, including both `casedb` and `commcaresession` for a selected-case
read. Emit raw comparisons: Core's absent node-set becomes `""` for string
comparison and NaN for numeric comparison, so a generic presence guard would
change equality/inequality semantics.

`caseSearchConfig.excludedOwnerIds` is Results availability, independent from the Search action. It resolves once from global session/Search state before any case is selected, then constrains ordinary case-list nodesets and HQ short-detail filters as well as effective remote Search; it can never read the row being filtered. `emitNormalizedExcludedOwnerIdsExpression` authors the canonical `normalize-space(...)` intent, then immediately crosses `lowerXPathForJavaRosa`, which emits only JavaRosa-native nested `replace()` calls over XML whitespace into local-suite remote data and HQ JSON. The ordinary list feeds that same lowered value to `selected(...)`; this matches Preview's whitespace split instead of letting CCHQ/Core preserve empty tokens from repeated/trailing/tab whitespace. The ordinary list also short-circuits when the normalized value is blank because Core considers `selected('', '')` true for an unassigned row. Owner-only configuration emits no Search action or remote request. On the remote path the normalized expression translates to CCHQ's `commcare_blacklisted_owner_ids` `<data>` key; authoring vocabulary stays in the schema and SA tools, and that wire token lives only at the emission boundary.

### Instance accumulation — local `.ccz` vs HQ-regenerated suite

CCHQ's server-side suite post-process (`commcare-hq/.../suite_xml/post_process/instances.py::InstancesHelper.add_entry_instances`) walks every detail an entry references and adds the matching `<instance>` declarations on the enclosing `<entry>` / `<remote-request>`. Nova's local `.ccz` emission has no equivalent post-pass, so the accumulators at `session.ts::deriveEntryDefinition` and `suite/case-search/searchSession.ts::buildSearchSession` walk every XPath surface the body holds — `caseListConfig.filter`, advanced-arm predicates, simple-arm-with-via derivations, prompt defaults, `excludedOwnerIds`, `searchButtonDisplayCondition`, form command display conditions, and each calculated expression that is shown on Results/Details or used by Default order. Fully off-screen, unsorted definitions have no runtime role and are ignored. A missing accumulation surfaces as an undeclared-instance XPathException at runtime; the HQ-upload path is unaffected because CCHQ regenerates the suite from the persisted document.

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

The import endpoints carry `@csrf_exempt` and `@waf_allow('XSS_BODY')`
(`app_import_api.py`, live on all three servers since commcare-hq
`b5dfe459`), so the client sends one plain authenticated multipart POST —
no CSRF token fetch and no WAF padding field.

## Not-yet-modeled

HQ features the pipeline does not cover yet — the validator's `app`/`module`/`form`/`field` rules gate additions as they land:

- Shadow modules, parent-select cycles
- Grouped case tiles (`<detail><group>`), smart links, case list field actions
- Sort field format regex, multimedia
- Itemset `<copy>` mode (lookup-backed selects emit value/label itemsets)
- Repeat homogeneity

Validation stubs that activate when features land:
- `previous` + `multi_select`, `previous` + `inline_search`
