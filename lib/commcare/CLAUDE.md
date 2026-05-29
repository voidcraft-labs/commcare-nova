# lib/commcare

One-way emission boundary: `BlueprintDoc` → CommCare wire formats (XForm XML, `HqApplication` JSON, `.ccz` archive). The only package in `lib/` that imports CommCare's vocabulary (HQ shell shapes, `doc_type` strings, XPath functions, session datums, identifier rules). A Biome `noRestrictedImports` rule enforces the one-way direction.

## Public surface

- `expandDoc(doc)` → `HqApplication` JSON for HQ import (`./expander`).
- `compileCcz(hqJson, appName, doc)` → `.ccz` archive as `Buffer` (`./compiler`).
- `buildXForm(doc, formUuid, opts)` → XForm XML (`./xform`).
- `runValidation(doc)` → `ValidationError[]` (`@/lib/commcare/validator`).
- `parser`, `transpile`, term constants, `detectUnquotedStringLiteral` (`@/lib/commcare/xpath`).
- `listDomains`, `importApp` (`./client`); `encrypt`, `decrypt` (`./encryption`).
- Shared primitives re-exported from `./index.ts`: `constants`, `types`, `hqShells`, `hashtags`, `identifierValidation`, `session`, `formActions`, `deriveCaseConfig`, `xml`. The barrel stays client-safe: Node-only modules (`./compiler` via `adm-zip`; `./ids` via `node:crypto`) and the heavy emission pipeline (`./expander`, `./xform`) are imported from their explicit sub-paths so Turbopack can tree-shake them out of client bundles. The XPath engine, validator, encryption, and HQ HTTP client follow the same sub-path rule for the same reason.

## Allowlist

The set of allowed consumers is enforced by `biome.json`'s `noRestrictedImports` rule on `@/lib/commcare`. Read it there — keeping a hand-maintained copy here drifts.

## Key design decisions

### Shared field-string accessor

`fieldProps.ts::readFieldString` is the one reading-helper the wire emitters share: a single untyped lookup over `Field`'s discriminated union for the optional string properties (`relevant`, `validate`, `calculate`, `default_value`, `required`, `hint`, `label`, `case_property_on`, `validate_msg`). Narrowing per kind at every call site would cascade N×M branches.

### Vellum dual-attribute pattern

CommCare's Vellum editor requires both expanded XPath AND the original shorthand on every bind. Real attributes (`calculate`, `relevant`, `constraint`) get the expanded instance XPath; `vellum:` attributes preserve the original `#case/` and `#user/` shorthand. Every bind also gets `vellum:nodeset="#form/..."`.

### Bare hashtags in prose

Hashtag wrapping in label/hint text uses regex, NOT the Lezer XPath parser. Labels are prose; surrounding characters like `**` (markdown bold) parse as XPath operators, which swallows the `#`.

### Markdown itext

All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`. Safe for plain text: identical rendering when no markdown syntax is present.

### Secondary instances

`casedb` and `commcaresession` are accumulated at the point of use — XPath field + label scans, Connect expression scans. `casedb` implies `commcaresession`. One declaration happens outside `buildXForm`'s scan: `xform/caseBlocks.ts::addCaseBlocks` splices case-preload setvalues that read from `casedb` after the scan has run, so it declares `casedb` itself (idempotently) when it emits a preload.

### `post_submit` defaults

Controls post-submit navigation. Three user-facing values: `app_home`, `module`, `previous`. Two internal values (`root`, `parent_module`) exist for export fidelity. Form-type defaults when absent: followup/close → `previous`, registration/survey → `app_home`. The SA only sets `post_submit` when overriding the default.

### Form links

`form_links` on a form enables conditional navigation: `condition?` (XPath) + `target` (form or module by uuid) + optional `datums`. First matching condition wins; `post_submit` is the fallback. Fully validated.

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

- `validator/suiteOracle.ts::validateSuite` mirrors the device's `suite.xml` contract (`commcare-core .../suite/model/*` + `org/commcare/xml/*Parser`). Two layers: **Category 1** (fatal at `SuiteParser` parse — required attrs, enums, PATH-only `<datum nodeset>` / `<data>` per `SessionDatumParser`/`QueryDataParser`) and **Category 2** (parse-clean but session-runtime-fatal — the device does NO cross-reference validation, so the oracle owns menu→command, datum `detail-select`/`-confirm`→detail, `instance('id')` resolution with per-entry intersection, locale-id resolution against app_strings, command/detail/instance id uniqueness). `xform/instanceRefs.ts` extracts `instance()` refs via the Lezer parser. Wired into `compiler.ts` as a post-emit throw.
- `validator/hqJsonOracle.ts::validateHqJson` mirrors CommCare HQ's import contract (`Application.wrap`, a recursive jsonobject `DocumentSchema`). Import is FATAL only on enum (`choices=`) violations, type mismatches, `doc_type` dispatch failures, and custom property validators (none on Nova-emitted types) — the TS `HqApplication` type already guarantees the structural slots, so the oracle checks the emitter-derived enum/`doc_type`/finite-number slots that TS types only as `string`. It is a **regression guard** over those constants (their values come from shell factories / the `toHqWorkflow` table, not user input). Wired into `validationLoop.ts::validateExpansion` alongside the XForm oracle.
- `validator/bindingResolutionOracle.ts::validateBindingResolution` mirrors JavaRosa's install-time XPath-resolution contract — the layer between parse-time validity (which `xformOracle` proves) and form-init runtime evaluation. Three rules: every `instance('commcaresession')/session/data/<X>` references a declared session datum on the form's entry; every `instance('commcaresession')/session/context/<X>` is in the closed CommCare-populated set (`SessionInstanceBuilder.addMetadata`); every `instance('<id>')` matches a `<model><instance id="...">` declaration. Form-path refs inside expression bodies are intentionally NOT checked — JavaRosa resolves a missing path to an empty node-set at runtime (degraded UX, not install-time-fatal); dangling bind NODESETS are caught upstream by `XFORM_DANGLING_BIND`. The oracle is a **test-time totality proof**, never a user-facing emit gate — `compileCcz` does not call it. The fuzz at `__tests__/bindingResolutionOracle.fuzz.test.ts` invokes it directly per form post-compile; the user-visible authoring gate is `validator/rules/form.ts::caseHashtagOnCreateForm` (rejects the `#case/<X>` shape on registration forms that would surface the oracle's `BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED` at runtime).

### Case-management scaffolding emission

`xform/caseBlocks.ts::addCaseBlocks` mirrors CCHQ's server-side post-process (`commcare-hq/.../app_manager/xform.py::XFormCaseBlock`) so local-CCZ emission produces forms JavaRosa can install. This is a true lockstep contract, not a partial mirror: CCHQ regenerates the uploaded app's XForm case blocks from the `FormActions` JSON, and Nova's local `.ccz` renders from that *same* `FormActions` (`hqForm.actions`) — so the two surfaces consume one input and can't diverge as long as `addCaseBlocks` consumes all of it. Every `<case>` element carries the cx2 namespace (`http://commcarehq.org/case/transaction/v2`) — without it CommCare's submission processor treats the element as inert data, not a case transaction. The three `<case>` attributes (`case_id` / `date_modified` / `user_id`) wire to:
- **case-create**: `case_id` setvalues at `xforms-ready` from the per-entry session datum `case_id_new_<casetype>_0` (a `function="uuid()"` datum `session.ts::deriveSessionDatums` emits). `date_modified` / `user_id` calculate off the always-on meta block at `/data/meta/timeEnd` / `/data/meta/userID`. The case-name source question's bind also gains `required="true()"` (merged onto the field's existing bind, not a duplicate) — CommCare forces it so a case can't be created nameless, mirroring `XFormCaseBlock.add_create_block`.
- **case-update**: `case_id` calculates from the case-loading session datum `case_id`. Same meta-block bindings for the two timestamp attributes. Every per-property update bind also carries `relevant="count(<qPath>) > 0"` — the JavaRosa semantic when a field's `relevant` evaluates false is that the data node is absent, and an unguarded update would overwrite the existing case property with empty. The guard mirrors CCHQ's `XFormCaseBlock.add_case_updates`. Removing it silently destroys preserved case data on every conditionally-hidden field.
- **case-preload**: one `<setvalue event="xforms-ready">` per `case_preload` entry, reading the loaded case's property from `casedb` (`instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/<prop>`). Mirrors `XForm.add_case_preloads`. Spliced in after `buildXForm`'s instance scan, so `addCaseBlocks` declares the `casedb` instance itself (idempotently — skipped when a field-level `#case/` reference already pulled it in), mirroring `add_case_preloads`'s `add_casedb()`. Preload is the structural source of a case-loading form's initial field values — the agent layer no longer stamps `default_value = "#case/{id}"` for this (`lib/agent/contentProcessing.ts::applyDefaults`). Gotcha: the preload setvalue lands after the field's own `default_value` setvalue in document order, so the loaded case value wins at `xforms-ready`. This matches a CCHQ-uploaded app (CCHQ emits preload regardless of any authored default) — an explicit `default_value` on a case-loading form's case property does not change what the user sees.
- **subcases**: per-subcase session datum `case_id_new_<subcasetype>_<idx>` (index mirrors CCHQ's `Form.session_var_for_action` — starts at 1 when the form also opens a primary case). Repeat-context subcases use literal `uuid()` calculate instead (no session datum is emitted for them, matching CCHQ's `delay_case_id` branch). Owner-id binds to `/data/meta/userID` on EVERY subcase regardless of relationship: the basic module Nova uploads runs `autoset_owner_id_for_subcase` (`'owner_id' not in case_properties`, which is always true for Nova's subcases), so CCHQ's regenerated form carries the userID owner bind for child and extension subcases alike. (The unowned-`owner_id` sentinel is an advanced-module-only shape — `autoset_owner_id_for_advanced_action` — which Nova never emits; the `extension` relationship is carried solely on the `<index>`.) Each subcase's name question also gets `required="true()"` merged onto its bind, same as the primary case. A subcase **close-on-submit** branch exists (renders `<close>` + a `relevant` bind from the subcase's `close_condition`) but is dormant: no authoring surface sets an active subcase close today, so `buildFormActions` always emits a `never` condition there; the branch is exercised only by `__tests__/caseBlocks.test.ts`.

The case-attachment shape (`update_attachment_case.xml` — a captured media field persisted to `<case><attachment>`) is NOT emitted: the `mediaCaseProperty` validator rejects media-kind fields with `case_property_on`, so the state is unreachable in a valid doc. Supporting it is a separate feature (lift the rejection + emit on both pipelines + CCZ media bundling), distinct from the display-media work.

### Repeat-context subcase splice + nest decision

A field whose `case_property_on` names a non-module case type authors a CHILD case; when the field sits inside a repeat, the child case is created per iteration. `deriveCaseConfig` buckets these by `(case_type, repeat_ancestor_path)` — keying on the repeat's resolved `FormPath`, not its bare field id, so two cousin repeats that legally share an id (`children > section_a > kids` + `children > section_b > kids`) emit two independent `OpenSubCaseAction`s rather than collapsing into one with split-scope `field_paths`. Each bucket carries both `repeat_context` (wire-format XPath, e.g. `/data/group_a/kids` or `/data/X/item` for `query_bound`) for emission and `repeat_ancestor_id` (bare field id) for human-readable validator messages.

`xform/caseBlocks.ts::addCaseBlocks` mirrors CCHQ's `_create_casexml` splice: pre-count subcases per `repeat_context` to pick `nest = (count > 1)`. `nest = false` (single subcase under the repeat) splices `<case>` directly into the repeat's template subtree, bind nodesets anchor at `/data/<X>/case/...` (`subcase-repeat.xml` shape). `nest = true` (multiple subcases sharing a repeat OR every non-repeat-context subcase) wraps in `<subcase_N>`, binds at `/data/<X>/subcase_N/case/...` (`multiple_subcase_repeat.xml` shape). Splice target resolution walks the parsed DOM by `repeat_context`'s FormPath segments — `data → X → item` for `query_bound` falls out naturally because Vellum's `getPathName` rewrites the iteration path to include `/item`.

Adding a second cross-case-type field to a single-subcase-in-repeat form FLIPS the wire shape (`<case>` → `<subcase_0>`/`<subcase_1>`). Old case_ids persist (the bind calculate is the same `uuid()`); old submissions are unaffected.

### Typed FormPath

`xform/formPath.ts::FormPath` is the typed value every wire emitter constructs paths through. Element + attribute steps only; attribute steps are terminal; element-step names pass `XML_ELEMENT_NAME_REGEX` at construction. The serializer `toXPath()` is the sole place `/data/...` literals appear in the package. Use it for PATH REFERENCES (bind `nodeset`, control `ref`, `<setvalue ref>`, splice walk steps); XPath EXPRESSION bodies (`calculate` / `relevant` / `constraint`) stay parsed via the Lezer grammar.

### Form `<meta>` block

Every Nova-emitted XForm carries the OpenRosa `<meta>` block (`<deviceID>`/`<timeStart>`/`<timeEnd>`/`<username>`/`<userID>`/`<instanceID>`/`<appVersion>`/`<drift>`) plus the eight setvalues that populate them at form load/save and two `<bind type="xsd:dateTime">` elements typing the timestamp nodes. Unconditional emission via `xform/metaBlock.ts::buildMetaBlock`. Without the block, submissions are accepted on the wire but downstream tooling that filters or joins on `instanceID` / `timeStart` / `userID` falls over.

### Hashtag form-context

`hashtags/formContext.ts::expandHashtagsInContext` is the form-context-aware variant of the context-free `hashtags.ts::expandHashtags`. On registration forms, rewrites `#case/case_id` to `/data/case/@case_id` (the form's own new case, populated by the case-create scaffolding's setvalue chain). Every other `#case/<X>` on a registration form falls through to the context-free expander, which produces the case-loading shape; the binding-resolution oracle catches the unresolved `session/data/case_id` reference at compile time. `xform/builder.ts` threads a captured `expand` closure through every helper that touches hashtag-bearing XPath surfaces so every emitted bind / setvalue / output respects the form's context.

### Case-list emission

Case-list wire emission lives at `suite/case-list/`. The orchestrators (`shortDetail.ts`, `longDetail.ts`) walk `module.caseListConfig` and produce `<detail id="m{n}_case_short">` / `<detail id="m{n}_case_long">` blocks; per-kind emitters in `columns.ts` lower each `Column` arm to its `<field>` shape; `sortKeys.ts` resolves comparator types and emits `<sort>` blocks; `nodesetFilter.ts` wraps the `caseListConfig.filter` predicate's compiled XPath into the entry's nodeset. The two detail surfaces share `columns.ts` via a `DetailKind` discriminator (`"short" | "long"`) — five precise branch sites cover the long-detail-only `template_form="phone"`, the short-detail-only sort wrap, the long-detail no-sort short-circuit, and the locale-id substring choice.

### Case-search emission

Case-search wire emission lives at `suite/case-search/`. The orchestrator (`remoteRequest.ts`) walks one module's `caseSearchConfig` + `caseListConfig` and produces the `<remote-request>` block — `<post>` claim guard, `<command>` label, `<instance>` declarations, `<session>` body, `<stack>` rewind. Three sub-emitters specialize: `searchSession.ts` owns the `<session>` (`<query>` + `<datum>` + the `<data>` slot list AND-composing the unified filter with every advanced-arm search input's predicate AND every simple-arm input whose `(mode, via)` shape needs explicit-predicate emission, before the CSQL emitter); `searchPrompts.ts` emits the per-input `<prompt>` elements; `claim.ts` owns the static `<post>` template.

The `_xpath_query` AND-composition runs through `suite/case-search/xpathQuery.ts::composeXPathQueryEmission`, the single contract both the suite-XML emitter and the HQ-JSON emitter (`hqJson/caseList.ts::projectDefaultProperties`) consume. Simple-arm inputs that need explicit-predicate emission route through `suite/case-search/simpleArmDerivation.ts::deriveSimpleArmPredicate`, which lifts the `(property, mode, via)` shape to an advanced-style predicate (`when-input-present(input(name), op(prop, input(name)))`). The bare `<prompt>` element still emits on the wire because CCHQ binds the user-typed value to the prompt key at runtime — but the explicit matcher predicate lives in `_xpath_query`, not on the prompt slot. When the simple-arm derivation gate routes an input through `_xpath_query`, the prompt also emits `exclude="true()"` (suite XML) / `exclude: true` (HQ JSON) so CCHQ's runtime skips the bogus auto-match against the prompt key while leaving the typed value bound to the search-input instance for the explicit predicate to reference. Three CCHQ-runtime facts drive the routing rule:

- CCHQ's `CaseSearchProperty` carries no per-input matcher-strategy flag — verified against `commcare-hq/corehq/apps/app_manager/models.py::CaseSearchProperty`. The runtime default for a bare prompt is exact full-string match (`commcare-hq/corehq/apps/es/case_search.py::case_property_query` → `exact_case_property_text_query`). Fuzzy / phonetic / starts-with / fuzzy-date matching only reaches the runtime through an explicit XPath function call inside `_xpath_query` (`fuzzy-match` / `phonetic-match` / `starts-with` / `fuzzy-date` registered at `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`).
- Each `<prompt key="X">` binds one runtime value via `instance('search-input:results')/input/field[@name='X']` and carries no relation-walk metadata.
- CCHQ's runtime auto-matches the typed value against the case property NAMED BY the prompt key — verified against `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::build_query_prompts` (`'key': prop.name`) and `commcare-hq/corehq/apps/case_search/utils.py::_apply_filter` (the non-special key routes through `_get_case_property_query(criteria)` keyed on `criteria.key` as the case property name). Nova's authoring keeps the prompt key (`SearchInputDef.name`) and the targeted property (`SearchInputDef.property`) as separate slots; when the two diverge, the auto-match queries a property that may not exist. The `exclude="true()"` attribute (verified at `commcare-core/.../session/RemoteQuerySessionManager.java::RemoteQuerySessionManager.getRawQueryParams`) suppresses the auto-match without unbinding the typed value.

The routing rule is `(mode, via, name vs property)`-shaped: only `exact` (or `range`) on self-walk / absent `via` AND `name === property` rides on the bare prompt slot alone (CCHQ's runtime auto-match against the prompt key IS the authored comparison; the `daterange` widget handles the two-bound semantic internally for the current case). Every other combination — non-`exact` modes on any via, `exact` mode with a non-self via, OR `exact` mode with `name !== property` — routes through `_xpath_query` and stamps `exclude="true()"` on the prompt. Blank-property simple-arm inputs (the transient editor state the schema admits as `property === ""`) fall back to the bare-prompt shape so the compile path stays clean while the validator's `CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY` carries the authoring signal.

Validator rules anchoring the wire contract:
- `searchInputViaModeCompatibility` — rejects `range` on a non-self via, `range` with `name !== property` on self-walk, and `multi-select-contains` on every simple-arm input (no faithful wire form covers these shapes).
- `matchModeOnDeviceCompatibility` — rejects `fuzzy` / `phonetic` / `fuzzy-date` in slots that lower to JavaRosa-on-device XPath (`caseListConfig.filter`, `caseSearchConfig.searchButtonDisplayCondition`). JavaRosa has only `starts-with` of the four match functions; the other three are CSQL-server-only and would crash the case-list at render time.
- `caseSearchConfigRequiresCaseType` — `<remote-request>` carries a mandatory `case_type` slot.
- `ancestorExistsCannotNestSubcase` — runs after `liftPropertyVias` so post-lift `any-relation` expansions get scanned; CCHQ rejects ancestor-exists with subcase-exists nested in the filter argument.

`compileForPlatform.ts` is the pure decision tree from authored content + `PlatformContext` to a three-flag `WireShape`. Author intent is unambiguous on every input — Android always emits list-first / inline-results; web with an effective filter and zero search inputs emits skip-to-results; web fallback is list-first. The flags drive the orchestrator's `<query>` attributes + storage-instance choice + the case-list short-detail emitter's `<action auto_launch>` attribute.

CCHQ wire tokens differ from the authoring vocabulary in one place: `caseSearchConfig.excludedOwnerIds` translates to the `commcare_blacklisted_owner_ids` `<data>` key at the call site in `searchSession.ts`. Authoring vocabulary stays in the schema and SA tools; the wire token lives at the emission boundary.

### Instance accumulation — local `.ccz` vs HQ-regenerated suite

CCHQ's server-side suite post-process (`commcare-hq/.../suite_xml/post_process/instances.py::InstancesHelper.add_entry_instances`) walks every detail an entry references and adds the matching `<instance>` declarations on the enclosing `<entry>` / `<remote-request>`. Nova's local `.ccz` emission has no equivalent post-pass, so the accumulators at `session.ts::deriveEntryDefinition` and `suite/case-search/searchSession.ts::buildSearchSession` walk every XPath surface the body holds — `caseListConfig.filter`, advanced-arm predicates, simple-arm-with-via derivations, prompt defaults, `excludedOwnerIds`, `searchButtonDisplayCondition`, and every calc-column expression on `caseListConfig.columns`. A missing accumulation surfaces as an undeclared-instance XPathException at runtime; the HQ-upload path is unaffected because CCHQ regenerates the suite from the persisted document.

Sort lives on each column. The wire emitter walks `caseListConfig.columns`, drops columns without a `sort` slot, sorts the survivors by `priority` ascending (tie-break to source-array index — the rule binds uniformly at the saga, preview, and wire-emission layers; no layer assumes priority uniqueness), and emits one `<sort>` block per column carrying its 1-based `order` attribute. The schema has no parallel `SortKey[]` array — sort directives can't refer to a non-existent column, so the silent-drop bug class is structurally impossible.

The comparator type for each `<sort>` is derived at wire emission, not authored. The dispatch lives in `sortKeys.ts::resolveColumnSortType`: property-rooted columns (plain / date / phone / id-mapping / interval) consult `applicableSortTypes(propertyDataType)[0]`; calculated columns consult `checkExpression(expression)` mapped to a `SortType`. Three explicit failure shapes — `undefined` (resolution failure), `ANY_TYPE` (e.g. on a `null` literal arm), or a `ResolvedType` with no mapping (defensive — covers schema drift) — route to comparator type `"plain"` (lexicographic).

Calc-column sort directives write `field: "_cc_calculated_{columnIndex}"` (matching `commcare-hq/.../app_manager/const.py::CALCULATED_SORT_FIELD_RX`) so sibling calc sorts each get their own row in CCHQ's `sort_elements_by_field` dict — a shared placeholder key would collapse multiple calc sorts on the HQ-uploaded path.

The `Column` discriminated union has six arms — `plain`, `date`, `phone`, `id-mapping`, `interval` (covers both relative-display and threshold-flag UX, dispatched by `display: "always" | "flag"`), and `calculated` (a `ValueExpression` AST node — calculated columns are a column kind, not a parallel array). Calculated columns emit CCHQ's inline-`<variable name="calculated_property">` template (verified against `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.template`'s `useXpathExpression` branch); they have no `field` slot — the expression is the source.

Per-surface visibility lives on the column. `shortDetail` filters columns by `visibleInList ?? true`; `longDetail` filters by `visibleInDetail ?? true`. "Search-only" semantics — a column declared and indexed but not displayed in the case list — are expressed as `visibleInList: false`, not as a separate kind. A search-only column still appears in the short-detail XML (CCHQ keeps the field present for sort + index purposes); the wire emitter renders the standard `Invisible.HideShortColumn` template shape (`<header><text/></header>` + `<template width="0">`) for these rows.

The `interval` kind covers both relative-interval and threshold-flag UX through one `display` discriminator. `display: "always"` always shows the relative interval (the runtime label decorates the cell when the threshold is exceeded); `display: "flag"` only shows the `text` slot when the threshold is exceeded (otherwise empty cell). Both arms share the same `(threshold, unit)` mechanics; the dispatcher in `columns.ts` switches on `column.display` to pick the per-arm wire emission.

## CommCare HQ upload

Upload creates a new app each time — HQ has no atomic update API. The HQ base URL is hardcoded (prevents SSRF). User API keys are KMS-encrypted at rest via `./encryption`. Domain slugs are validated against HQ's legacy regex to prevent path traversal in the import URL.

A key is **not** one-project-per-user: an unscoped HQ key reaches every project space its owner belongs to. `discoverAccessibleDomains` lists them and probes app-level access in a bounded-concurrency window (an unbounded fan-out self-inflicts a 429 on big accounts). The upload *target* is chosen by `resolveUploadDomain` (`@/lib/db/settings`) — explicit arg, else the sole space of a single-space key, else **error** (ambiguous) for a multi-space key (never silently the first space). There is no stored default: a multi-space key's target is a per-upload choice. Don't reintroduce the one-project assumption that caused the wrong-target bug.

Two workarounds live on the import endpoint because HQ's decorators on it are incomplete:

- **CSRF:** HQ is missing `@csrf_exempt`. The client fetches a token from the unauthenticated login GET and sends it on the POST. Harmless if HQ fixes it upstream.
- **WAF:** HQ is missing the XSS-body exemption. AWS WAF blocks XForms-looking tags in multipart bodies. Fix: a 16KB padding form field inserted before the app file pushes JSON past the WAF inspection window. Padding field name must NOT start with `_` (CouchDB reserved). Symptom of a block: bare nginx 403 — distinct from Django's verbose CSRF 403.

## Not-yet-modeled

HQ features the pipeline does not cover yet — the validator's `app`/`module`/`form`/`field` rules gate additions as they land:

- Shadow modules, parent-select cycles
- Case tile configuration, smart links, case list field actions
- Sort field format regex, multimedia, multi-language
- Itemset nodeset/label/copy/value relationships
- Repeat homogeneity

Validation stubs that activate when features land:
- `parent_module` + `root_module` (parent modules not modeled yet)
- `previous` + `multi_select`, `previous` + `inline_search`

### `put_in_root` impact (not yet modeled)

When added: `'module'` becomes invalid (no menu), `'root'` diverges from `'app_home'`, `'parent_module'` with a `put_in_root` parent is invalid. Validation should auto-resolve `'module'` → `'root'` for `put_in_root` modules.
