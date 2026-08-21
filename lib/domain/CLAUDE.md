# lib/domain — the blueprint vocabulary

The shape every surface speaks. The agent (`lib/agent`), the doc store (`lib/doc`), the builder (`components/builder`), the wire emitter (`lib/commcare`), the case store (`lib/case-store`), and the preview engine (`lib/preview`) all bind against the Zod schemas here and cross to each other only as these domain shapes. This package is a leaf — it imports none of them.

**The schemas ARE the reference.** `blueprint.ts`, `fields/*`, `forms.ts`, `modules.ts`, `xpath/`, and `predicate/` (its own `CLAUDE.md`) are the authoritative shape; this doc holds only the few truths the schemas can't state.

**Persisted numbers use one injective JavaScript/JSON contract.**
`jsonNumber.ts` is the shared leaf for every Blueprint numeric slot. Values
must be finite and not negative zero; an integral value must be a safe integer.
This matches the exact-text JSONB loader: non-integers persist through
`JSON.stringify`'s unique shortest round-trip decimal, while values that JSON
would silently alias are rejected before mutation construction. New numeric
slots reuse this leaf in addition to their own positive/nonnegative/integer
range, never a bare `z.number()`.

## BlueprintDoc — normalized, with derived state stripped at the boundary

An app is UUID-keyed records (`modules` / `forms` / `fields`) plus membership arrays (`moduleOrder` / `formOrder` / `fieldOrder`) — not a nested tree.

Sequence is plain array position. Position belongs to the collection, so entities and nested members carry no parallel `order` key. Every stored ENTITY has a required UUID (modules, forms, fields, user properties, user types, personas, organization levels, location properties, and automations, plus case-list columns, Search inputs, case operations, inline select options, and every addressable automation child); nested members that are not entities, such as case-operation writes and links, catalog properties and their options, and ID/image mapping rows, are identified by position and their own keys instead. Hydration restores only derived indexes/prototypes and never invents identity or repairs sequence.

**A membership array IS the sequence.** `formOrder` is keyed by module and `fieldOrder` by form-or-container, so a hierarchical collection's array also says which parent an entity belongs to. A FLAT top-level collection (`userProperties` / `userTypes` / `personas` / `organizationLevels` / `locationProperties` / `automations`) has no parent to express, but it carries an array for the same reason every other collection does: position belongs to the collection, not to the member. A position stored ON the entity has to be computed from the sequence its author could see, so two people adding from one document compute the SAME position, and nothing sorts between two equal positions, which silently strands every later insertion between them. The record and its array cannot drift: `assembleBlueprint` throws when they disagree. All nine top-level entity kinds share one GLOBAL entity-UUID namespace because `blueprint_entities` persists them under one `(app_id, uuid)` primary key. The validator rejects a duplicate before commit and `decomposeBlueprint` repeats the check against each entity's own `uuid` before row assembly, so two identities can never collapse into one durable row. The case list is the one collection with TWO sequences over one set: `caseListConfig.listColumnOrder` and `detailColumnOrder`, both required, both naming every column from birth whatever its visibility. Read either through `orderedColumns(config, surface)`; the `columns` array is the set, and its position means nothing. Two slots are derived and NEVER persisted: `fieldParent` (the field→parent reverse index, rebuilt from `fieldOrder` on load) and `refIndex` (the reference index, built on demand; see `lib/doc`). The type system enforces the strip: `PersistableDoc` is the on-disk shape, `BlueprintDoc` adds the derived slots for in-memory use, and `PersistedBlueprint` (a `never`-typed wall) is what every writer takes so an unstripped doc can't serialize its derived state.

## Localization is an overlay over canonical source content

`localization.ts` owns app-language identity. The ordinary Blueprint slots
remain the canonical source-language values; `AppLocalization` stores only
target-language entries plus provenance and review state. An absent root means
the canonical English-only state (`eng` source, default, and sole order
entry) and is never materialized. The source language has no duplicate target
map, the default language is first in `languageOrder`, and every other app
language has exactly one map. A language is `AppLanguageIdentity`
`{language, script?, region?}`: an ISO 639:2023 Set 3 individual living
language, an ISO 15924 script present exactly when the language has more than
one customary writing system, and an optional ISO 3166-1 alpha-2 region.
`languageTag(identity)` joins the parts with `-` (`cmn-Hans-CN`) and
`parseLanguageTag` inverts it; the tag (`LANGUAGE_TAG_PATTERN`, the only tag
grammar) is the record key, mutation reference, and `?lang=` value, never a
rendered string. Parsing admits shape only; registry membership is enforced at
the authoring boundaries (tool schemas, design contract, picker), so the
persistence layer never consults catalogs. Names, directions, and descriptors
are never stored or authored anywhere; they derive from the identity through
`languageRegistry/` (generated ISO/CLDR catalogs plus `search.ts`, the lazy
big-name chunk behind `load.ts::loadLanguageRegistrySearch`). Neither registry
module is exported from the `lib/domain` barrel. Two-letter codes exist only
inside `lib/commcare` as emitted wire spellings.

`translationUnits.ts::collectTranslationUnits` is the ONE inventory of static
worker-facing strings. A unit id is an injective, versioned projection of stable
owner identity plus semantic slot, never visible text. Case-property option
values are their semantic key; because Classic accepts repeated stored values,
later same-value occurrences add their stable same-value ordinal so no legal
label silently aliases the first occurrence.
Builder, tools, Preview, translation orchestration, and wire emission resolve
language values through `resolveTranslationUnit(s)` rather than independently
walking labels. Each target entry fingerprints the current source. Missing and
out-of-date entries fall back to the canonical source; an out-of-date explicit
value remains stored for review but is never emitted as current. Prose
translations may reorder literal text and reference parts, but must preserve the
exact multiset and identity of every protected reference part. A source edit
therefore makes overlays stale rather than rewriting them, while removal of the
owning slot prunes its now-orphaned entries.

`collectTranslationCoverageDiagnostics` is the adjacent honesty boundary for
worker-facing carriers that the static overlay cannot represent. Lookup-backed
labels, Connect text, shared media, and recipient-owned automation messages are
reported to Builder and agents but never counted as untranslated inventory or
silently promised per-locale behavior.

## Automations describe HQ behavior; they never execute here

`automations.ts` owns one closed union: automatic case updates and conditional
alerts. An automation, and every criterion, setup-only instruction, update,
recipient, event, and user-data filter inside it, has canonical UUID identity.
Names, case properties, HQ ids, and registered custom ids are editable values,
never addresses. Criteria follow the two different HQ forms rather than one
shared superset. Case updates accept the four value comparisons plus four date
comparisons against case, parent, or host properties, and the one standard
closed-parent condition. Conditional alerts accept the four value comparisons
plus portable regex against the matched case only. Both automation families
also accept at most one UUID-backed location condition with an explicit
descendant flag. HQ executes it and accepts it through the form payload even
though its current visible rule and alert editors hide the picker. A setup-only
criterion structurally distinguishes `ucr-filter` from `registered-custom`
while its exact configuration remains trimmed prose; case-update server-modified age is a separate structured
field that Nova names as omitted from local matching. Case updates, recipients, content,
schedule starts, and user filters are similarly closed to shapes current HQ can
represent. There is no generic payload arm and no draft or disabled-invalid
state. HQ's deprecated `RUN_AUTO_CASE_UPDATES_ON_SAVE` flag is deliberately not
modeled: it is one domain-wide switch that evaluates every active update rule
for the saved case type, not a property of an individual rule.

The portable regex subset rejects newline-bearing patterns, lookarounds and
other `(?...)` extensions, shorthand escapes, PostgreSQL collating/equivalence
classes, malformed or lower-less bounds, and repetition bounds above 255. This
is the complete Python/PostgreSQL intersection Nova admits; the case-store
lowering then preserves Python `re.match` newline behavior for `.` and `$`
instead of relying on PostgreSQL's materially different newline modes.

Standard case metadata remains Nova vocabulary in storage. The derived HQ
automation projection maps `case_type`/`case_name`/`date_opened`/`last_modified`
to `type`/`name`/`opened_on`/`modified_on` for model-field readers and templates,
while `case_id`, `owner_id`, and `external_id` already match. `case_id` and
`case_type` are implicit text reads only in automation criteria, message
templates, update value sources, and property-backed recipients; they remain
outside the general case-list catalog and are never update targets. `status` is
never admitted because Nova text and HQ's boolean field differ. Standard
datetime values admit date or blankness matches, not text equality/regex.
Reset-on-change and case-property event-time slots accept custom properties only
because HQ reads those two from `dynamic_case_properties()` rather than any
standard scalar field. After trimming, an event-time value must begin with
`H:MM` or `HH:MM`, and the whole value must parse as a time. Suffixes such as
AM/PM or seconds are accepted. Blank, nonmatching, or unparseable values fall
back to 12:00 PM in HQ.

Message subjects, bodies, and HTML source are `AutomationMessageTemplate`
values: ordered literal-text parts plus explicit structural case-property
parts carrying scope and the full `(caseType, property)` identity, plus closed
case-owner and message-recipient context-property parts. Text that merely looks
like `{case.foo}` remains literal forever: the setup projection doubles literal
braces before HQ's Python Formatter sees them. The Builder inserts a reference
part explicitly, machine editors send the canonical part shape directly,
case-property renames rewrite only structural case parts, and the setup guide
alone projects those identities to HQ's `{case...}` spelling.
No reader reparses rendered message text to recover a reference. HQ's Formatter
context shadows custom properties named `owner`, `host`, or `last_modified_by`
in every case/parent/host template scope, so those structural parts are refused
at the app gate. Host-scoped criteria, update targets, update sources, and
message case-property parts are also refused when an advanced case
operation can add a non-`parent` extension index to that automation case type:
HQ leaves extension-host ordering undefined, while parent-scoped references
and the extra link itself remain valid. At runtime, every host-scoped reference
still requires exactly one live extension. Historical cases may retain extra
extension indices; Nova cannot count current matches for those cases, and HQ
does not define which extension it chooses as the host.

The HTML form owns several less-obvious boundaries. Only a case-update rule has
the standard parent-closed criterion, at most once, with no authored index or
relationship. Equality and fixed-update literals are exact nonblank HQ values
without whitespace normalization or outer quote syntax, automation names are
already trimmed and nonblank, and alert regex patterns are nonempty. The recipient union has no web
user, and Connect content refuses self, parent-case, all-child-cases,
case-property-email, and case-group recipients. SMS Survey setup requires
Inbound SMS access; Connect setup requires the `COMMCARE_CONNECT` toggle and
runtime recipients that resolve to CommCare mobile workers with active
PersonalID links. A timed reset property requires
a rule-trigger start. Concrete HQ worker/group recipient IDs are already trimmed
and nonblank. Registered custom recipient/content IDs and setup-only
instructions are likewise concrete, trimmed, and nonblank; instructional copy
is editor placeholder text and never canonical data. Each checkbox-style or case-property/custom recipient
kind appears at most once; multi-target HQ lists may carry distinct workers,
groups, or locations but never the same concrete target twice. Descendant
settings require a location recipient, location-level filtering additionally
requires descendants, and the user-data filter carries one structural value
list per worker-property UUID. Its values are exact literals, including empty
and whitespace, or explicit `(caseType, property)` lookups into custom case data.
A brace-wrapped literal is invalid because HQ would reinterpret it as a lookup;
property renames rewrite only the structural lookup. Every triggering case must
contain a referenced property because HQ indexes `case_json[property]`
directly and raises when it is missing. HQ applies these filters only to
`CouchUser` contacts. The shared recipient-capability map therefore refuses a
filter alongside case, parent/child-case, case-email, case-group, or registered
custom recipients: the known non-user results bypass filtering, and Nova cannot
prove a custom handler's runtime result. Setup guidance emits exact JSON
whenever HQ's single-value fields would trim or lose the model.

Every schedule uses the HQ form's one content type. Timed schedules use the
runtime's day/repeat encoding but must project into one actual HQ setup form.
Positive schedules without a start weekday are Custom
Daily; a start weekday selects Weekly; a negative repeat selects Monthly.
Schedule refinements enforce each form's shared timing/content, ordering,
five-minute separation, window, day, offset, and repetition laws before commit.
Custom Daily days are stored zero-based and projected as one-based HQ event-row
values. A Weekly event day is an offset from the schedule's start weekday, so
the editor labels the projected absolute weekday and remaps offsets when the
start changes to preserve the chosen weekdays. Weekly and Monthly days are unique closed choices, and Monthly days are
already the UI's 1–28 / -3–-1 values in positive-then-month-end order. Survey reminder
totals stay strictly below expiration, and partial case updates imply partial
submission.

Email content is a discriminated body, never parallel plaintext/HTML fields.
`plain-text { message }` targets a domain without Rich text emails;
`rich-text { html }` requires it. All email events share that target form. HQ
sanitizes and rewraps rich HTML and derives plaintext, so rich content stores
the source only and makes no byte-exact-output promise.

The derived local matcher keeps HQ's value distinctions that the ordinary
Predicate AST cannot express: equality compares exact stored text without
typed SQL coercion; a related comparison requires the related case to exist;
whitespace-only strings are blank; and regexes run only against actual string
values. It fixes closed-parent matching to HQ's standard `parent` child index.
A location condition matches location-owned rows in the selected subtree plus
rows owned by personas whose primary location is in that subtree, matching
HQ's direct-location-or-mobile-worker-primary-location runtime.

The domain records intent only. `lib/automations` derives the current-match
projection and manual HQ setup guide; neither belongs in the document.
Publishing does not install a rule, Preview does not mutate cases or advance a
schedule, and a generated guide is never persisted beside its source object.

Every saved case-list column is valid unconditionally, including one hidden
from both layouts and absent from sort. `caseListColumnIsEmitted` is the sole
authored-to-runtime projection. Preview, CommCare emission, and emitted-reference
walks consult it, as does the authored persistence walk
`mediaRefs.ts::walkAuthoredAssetRefs` that backs reverse-index admission,
deletion, and Project moves. Schemas, admission, and editor projections retain
and validate the complete definition; no validator, `lib/doc`, or component
reads it.

**A choice's stored value has one grammar, and the slug is what Nova teaches, not all it admits.** `selectOptionValue.ts` is the shared leaf for the VALUE of an inline select option and of a catalog property's option: non-empty, no whitespace, no `'` `"` `` ` `` (`SELECT_OPTION_VALUE_PATTERN`). The bound is the wire's, not a naming taste: CommCare Android throws on any select value holding a space, a multi-select answer is a space-joined token list, and the case list compares the property inside an XPath literal. The stored schemas (`selectOptionSchema`, the catalog `options`) stay permissive so a document written before the rule still hydrates; the validator (`SELECT_OPTION_VALUE_INVALID` / `CASE_PROPERTY_OPTION_VALUE_INVALID`), the SA/MCP schemas, and the builder's editor all apply the leaf, and every one of them suggests the underscore-joined slug rather than only refusing: `suggestSelectOptionValue` mints it from a label and `repairSelectOptionValue` from a refused value (its own words first, then the label's), both NFC-normalized and lowercased over Unicode letters, combining marks, and digits (so "Sí" becomes `sí`, not `s`, and "नमस्ते" keeps its vowel signs and virama rather than splitting at each one; the grammar admits those characters, so the suggester must too) and both suffixed `_2`, `_3` past any sibling's value, because the validator has no inline duplicate-value rule to catch a collision the suggestion itself created. `sanitizeSelectOptionValue` is the keystroke repair (whitespace to `_`, quotes dropped) and deliberately never trims an edge: it runs on every keystroke of a controlled input, where trimming would erase the `_` just typed before the next character lands. It keeps case and every other character, because `ICD10` and `a-b` are safe data.

`caseTypes` is a **generation-time catalog**, not a runtime authority: a case type's property defaults bake onto a field when the field is added, so **fields are self-contained**. The catalog is not consulted for a field's own defaults again, though `deriveCaseWriteInventory` and `deriveCaseConfig` still read `caseTypes` at emit to resolve a writable destination's `parent_type`.

## Property types are derived facts — the effective case-type view

A property's `data_type` in the catalog is a plan-time SEED, usually absent. The truth is derived from the WRITERS: `effectiveCaseTypes.ts::effectiveCaseTypes(doc)` materializes the catalog with each untyped declared entry filled from its writing fields' kinds (`caseDataTypeForFieldKind`; hidden writers via structural expression inference — a lone `today()`/`now()` text run or a lone case-ref copy, nothing parsed) and typed case-operation writes, plus the CommCare standard properties (`standardCaseProperties.ts`), plus writer-derived entries. The validator's admission set and the workspace's verdicts + pickers (`useEffectiveCaseTypes`) consume THIS view; the SQL compiler's schema map (`buildCaseTypeMap`) and the running-preview/sample surfaces (`useMaterializableCaseTypes`) consume the `materializableCaseTypes` flavor — same derived types, minus implicit standard entries. An explicitly declared standard entry remains for catalog metadata/order, while the JSON-schema and JSONB-index projections filter every scalar-backed name and runtime SQL/display resolves it through `RESERVED_SCALAR_COLUMN_BY_PROPERTY` onto the `cases` column. One derivation, so gate/UI/SQL can't disagree about what a property is. The validator's writer-agreement rules are the proof obligations that make "declared ?? writer-derived" well-defined; `concreteCasePropertyWriterTypes` exposes the same proof input so field and operation writers cannot silently disagree. **Unknown is honest**: a property nothing pins keeps `data_type` ABSENT — value semantics still read it as text (`effectiveDataType`), but COMPATIBILITY verdicts (`columnApplicability.ts`, the one predicate the pickers, workspace dots, and the gate's `CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH` rule share) treat unknown as no-opinion — missing metadata never manufactures an error. Derived, memoized per doc reference, never persisted.

**One case type is storable but not authorable.** `commcare-user` (`usercase.ts`) is DERIVED from the worker-property catalog rather than declared beside the others, so it is absent from `effectiveCaseTypes` and `materializableCaseTypes` — nothing can create it, close it, model it, or offer it in a picker — and present in `buildCaseTypeMap`, because the case store materializes one row per worker and the wire reads it through `casedb`. The same module owns its CONTENTS, and that derivation has two consumers on purpose: Preview's `#user/<prop>` answers and the materialized row. `#user/` resolves against `casedb` on the wire, so two derivations would make Preview disagree with a device for any worker saved once. `usercaseChangedFields` is the diff, and its never-remove half is a contract rather than an optimization: a value a form wrote survives until a persona edit names that same property.

**Temporal values have wire shapes, and one of them Nova cannot store as-is.** `temporalValues.ts` owns what a deployed app's `date` / `time` / `datetime` answers actually look like (cited to JavaRosa's `*Data::uncast`) and is the ONE place any surface turns a temporal value into something storable — the form engine, the migration cast, the submission envelope, and the data-review editor all route through it. Two facts drive every consumer: a **time answer is a wall clock with no zone** (JavaRosa suppresses the offset deliberately), so Nova appends a `Z` STORAGE TAG the strict `format: "time"` schema requires — a label, never a claim about an instant, and safe only while `DATE_DATA_TYPES` keeps `time` out of `format-date` and `NAIVE_TEMPORAL_TEXT_PATTERN` keeps it out of the zone pinning. The tag is NOT removed on the way back in: the form instance holds a temporal value exactly as the case store holds it, so a field's preload, its `Tracked` twin, and the same property read through a typed case-property atom cannot disagree — rendering the value for a person stays the question widget's job. A **datetime answer carries the offset of the zone it was entered in**, so it takes the VIEWER's offset (Preview's browser standing in for the device), never `Z` — stamping `Z` on a wall clock silently moves every stored moment by the author's offset.

The canonicalizers are TOTAL, and that is the reason a shape check is a separate export. Text the grammar cannot read comes back untouched — so `canonicalizer(v) === v` is true of `"sometime tuesday"` and is NOT a validity test. `isStorageTemporalValue(kind, value)` checks readability first and canonicality second, against that same grammar, which is what lets a widget decide whether a value is showable as human text and the form engine decide whether it may reach submission without either of them re-deriving the shapes. The grammar is range-bound for the same reason: an hour like `99:00` is text it cannot read, never a clock it pads into the canonical-LOOKING `99:00:00.000Z` that no schema accepts. Offsets normalize to RFC 3339's `±HH:MM` — ISO's `-05` and `-0530` arrive from imported data and ajv-formats rejects both.

Standard metadata has ONE Nova authoring name. `case_name`, `external_id`, and `date_opened` are the only accepted spellings; CCHQ's alternate detail names are rejected at every live schema and writer boundary, and only the frozen one-off migration recognizes historical bytes. `status` is the built-in open/closed case lifecycle value; the Predicate type checker rejects any direct literal comparison or membership value outside `open` / `closed`, while app-specific lifecycle words belong in a separate property. `current_status` is not its alias — CommCare Core treats that as an old fallback for the separate `state` data property, so Nova only shows it when an app explicitly declares it.

## Field identity, form paths, and case storage

Every field carries a mutable **form `id`** (the XForm node name; unique among siblings) and an immutable **stable `uuid`** (assigned at creation, never changes on rename). Use the UUID for UI identity, every mutation/tool address, and every cross-entity reference that must survive a rename. Use the `id` only for the field's authored question path and project UUID-backed expression references to the current friendly path when text or CommCare wire needs one.

**Question identity and case storage are separate.** `Field.id` is only the friendly form question/node name. An eligible field saves case data only when it carries the complete explicit `caseWrite: { caseType, property }` pair; neither member is inferred from `id`. Editing `id` changes the question path only. Editing or clearing `caseWrite` retargets that one writer only. App-wide property renames use their dedicated semantic mutation and never hide behind a field edit. Naming the module's own type is an ordinary property write; naming a different type auto-derives child-case creation.

`caseWriteInventory.ts::deriveCaseWriteInventory` is the one form-tree walk that assigns those writers to case actions. The inventory stays entirely in Nova vocabulary: every writer carries its stable field UUID, current friendly field id, explicit destination pair, and ordered path segments containing both the stable UUID/current id and whether a query-bound iteration follows that segment. A repeated writer also carries its nearest repeat UUID, current repeat id, and ordered repeat path. Buckets use stable repeat UUID identity, never a rendered path or mutable id. Only the module's own type or an exact declared direct child is eligible; ancestor, sibling, grandchild, unrelated, and unknown types remain explicit invalid destinations. Survey and module-less forms own no case action, so any writer on them is invalid. Registration and child-create buckets require exactly one `case_name` writer; update buckets treat `case_name` as an ordinary supported write. Validator, doc analysis, Preview, and CommCare lowering consume this inventory rather than walking or reclassifying fields independently.

## Fields are a registry, not a switch

Each field kind is one file under `fields/`, and the union (`fieldSchema`) discriminates on `kind`. Each kind's schema declares ONLY the slots it actually has — which is the structural reason a wrong-property-for-kind state is unexpressible (it's also why the SA's per-kind tool arms can't carry a slot the kind lacks). `kinds.ts` holds the per-kind metadata table (`FieldKindMetadata` — XForm control + data type, icon, label, `convertTargets`, the three-section editor schema) that the compiler, validator, editor panel, and SA tool-schema generator all read from ONE place: **adding a kind is one `fields/` file + a registry entry; adding a property is one schema field + one editor entry.** `captureFieldKinds` is the one sub-grouping the registry can't express: the five kinds whose answer is an attachment rather than a value (image / audio / video / signature / file). The reference-slot applicability group, the emitter's `mediatype` table, and the capture-only `caseWrite` shape all read that tuple, so a kind cannot be a capture on one surface and an ordinary field on another. Those five extend the ordinary destination with `captureCaseWriteSchema`, whose required `mode` names what reaches the case: a capture's answer is a file name, so it can never BE the case value, and the mode says what is written instead (`"url"`, a link built from the published project space). Requiring the member is what makes a destination-without-a-mode unrepresentable; the same tuple is why an attachment is refused the two standard scalars (`case_name`, `external_id`), which bypass the update map through their own FormActions slots and would point back at the capture question. `saDocs` on those five is load-bearing prose, not a summary: Web Apps has no camera, microphone, or recorder, so every one says "attach" and none says "take" or "record". The three containers (`group`, `repeat`, `section`) are kinds, not a parallel tree — their children are the fields whose `fieldOrder` entry names them. A `section` is one page of a form: its own kind rather than a flag on group because it has no slots at all (`structuralFieldBase` + an optional title, strict: no `relevant`, no media), lives only at a form's root, and is always `appearance="field-list"` on the wire; `isContainer` / `isContainerKindName` are the predicates every container site reads (`lib/domain/__tests__/containerSites.test.ts` pins that no site spells the kinds out), so a fourth container never needs a sweep.

## Forms and modules

**Four form types** (`forms.ts`): `registration` creates a case, `followup` updates one, `close` loads + closes (a superset of followup), `survey` touches no case. Use the centralized sets — `CASE_FORM_TYPES`, `CASE_LOADING_FORM_TYPES` (`{followup, close}`) — never ad-hoc string comparisons. `isCaseFirstModule` mirrors `commcare-core`'s `getDataNeededByAllEntries` exactly (a module lands on its case list only when every form is case-loading); `defaultPostSubmit` is the form-type-aware navigation default.

Modules and forms each carry an optional typed `displayCondition: Predicate`.
The schema records the expression; the CommCare validator owns the narrower
runtime-context contract. A module is evaluated before case selection and may
not read case rows or Search answers. A form may read a direct self property of
the module's case type only when `isCaseFirstModule` proves a selected case;
forms-first modules may not. Related reads, relation presence/counts, and Search
answers are invalid on both carriers. The running preview executes both
(`lib/preview/engine/displayConditionEvaluation.ts`); authoring surfaces
activate in their owning slice.

`Form.formLinks` is the form's ordered list of after-submit links, each an ENTITY: `{uuid, condition?: XPathExpression, target, datums?}` (`forms.ts::formLinkObjectSchema`). The array IS the sequence — the `caseOperations` precedent — so moves address a link uuid and the uuid it now follows, and no link carries an order key. The slot is optional with `min(1)`: an empty list is unrepresentable, and reducers delete the slot when the last link goes. `datums` is absent (the wire auto-matches the destination's datums from the source entry) or a non-empty list of uniquely named `{name, xpath}` values; both ends of that rule are the wire's (`lib/commcare/CLAUDE.md` § After-submit links). A condition is a session-scope XPath AST — it may read `#user/` and `#<type>/` references, never `#form/`; the validator owns that. `formLinkGraph.ts` is the reachability reader (`formLinkAdjacency`, `formLinkPath`, `formLinkDestination`) shared by the cycle rule and every surface that must refuse a self-link or a cycle before it is authored; `authoredIdentities.ts` and `referenceSlots.ts` register link uuids as identities, so a rename or move never rewrites a link.

`Form.caseOperations` is the typed submission-effects program a form executes on submit. Every operation has immutable reference identity (`uuid`), an authored id (`id`), an action, a declared case type, and one typed target: a new case (optionally taking a stable key from a scalar text/single-select/hidden-string form field), an earlier create by operation UUID, the loaded session case, or a runtime expression. The stored schema is a strict action-discriminated union: `create` requires a `new` target and `name`, admits owner/writes/links, and forbids rename/retype; `update` requires a non-new target, forbids name, and admits owner/rename/retype/writes/links; `close` requires a non-new target, admits final writes, and forbids name/owner/rename/retype/links. `caseOperationIdentifiers.ts` is the import-light grammar shared by the validator, builder verdicts, and SA/MCP schemas: operation ids and link identifiers match `[A-Za-z_][A-Za-z0-9_]*`, while write properties match `[A-Za-z][A-Za-z0-9_]*`; none trims or admits XML-name punctuation that the emitted case wire rejects. Optional `forEach.repeat` makes multiplicity explicit; references to a repeated create must stay iteration-correlated with that exact repeat. `idFrom` is a key, never a raw CommCare case id: `caseOperationIdentity.ts` derives `nova-case-v1:<UUIDv5(app,form,operation,type)>:<exact-key>`, rejects the zero-length key, preserves whitespace/case/Unicode without normalization, and caps the key at 205 Java/JS UTF-16 code units so the final id fits HQ's 255-character column. Multi-select fields are deliberately excluded: Nova carries them as arrays while CommCare carries space-token strings, and no collision-free cross-runtime key serialization exists. The namespace makes retries or duplicate values for the same create definition deliberate same-type merges, while different apps/forms/operations/types cannot accidentally share an identity; two operations may use the same key field and remain distinct. A repeated authored-key create cannot feed or potentially alias a later non-create under the same repeated execution ancestor: Core's iteration-major `C1,U1,C2,U2` and HQ's per-case create sort `C1,C2,U1,U2` would disagree when two keys merge. A namespaced keyed identity is type-stable: direct retype is rejected, including by a runtime prefix guard when a session/expression target's provenance is data-dependent. Retype ordering also treats distinct AST targets as possible aliases unless their concrete ids are provably distinct; repeated retype is legal only over the exact correlated generated-UUID create, because repeated session/expression/authored keys may resolve to one case. Writes, links, rename, owner, close, and retype are facets over the operation rather than CommCare action-model vocabulary. Link identifiers and every operation-carried case type obey their respective 255-character HQ/Core storage caps as well as Nova's identifier grammar. `caseScalarText.ts` owns the shared evaluated-value contract for fixed text columns: remove boundary UTF-16 code units U+0000 through U+0020 exactly like Java `String.trim()`, then cap the normalized value at 255 UTF-16 code units. Names, renames, and explicit owners require a nonblank result (explicit unowned remains `-`); generic `external_id` writes admit blank as the real scalar `""`. The wire emitter, Preview, and submission executor use that helper rather than letting Core, HQ, and Postgres normalize independently. The `caseOperations` array IS the execution order; `orderedCaseOperations` reads it. The validator owns only contextual legality after structural parsing; the server-side supplier builds the program from the committed doc and the atomic executor runs it as one transaction on every submission.

Case-operation expressions add submission-local leaves to the generic Predicate / ValueExpression AST: `field { uuid }` for a form answer, `id-of { opUuid }` for an earlier create, `acting-user` for the server-resolved submitting identity, and `unowned` for CommCare's explicit no-owner sentinel. Owner slots also admit two identity-backed location terms: `fixed-location { locationUuid }` names one app row, while `owner-location-at-level { levelUuid, ownerCaseType }` derives the destination level's current code and its nearest case-owning ancestor's `{code}_id` lineage join. Both must be the complete owner expression and are invalid in every other slot. The shared editor offers form-field terms only when a slot declares its `formFields`, offers `id-of` only for creates earlier than the edited operation, and offers owner-only values only when the owning slot declares `ownerValues`; absence means the node is invalid and unauthorable, never preserved as a hidden compatibility state. An `id-of` is an effect dependency, not merely a generated string: every consumer of a conditional create inherits the producer's effective condition transitively, so a skipped create cannot leak its allocated UUID into a later effect. Runtime target/link expressions reject `id-of` anywhere in their tree; the first-class `{ kind: "op" }` target is the only safe way to address a fresh create because `casedb` is an immutable pre-submission snapshot. Persisted operation values use directional storage assignment, not predicate comparison compatibility: exact types, `int` to `decimal`, and text/single-select string interchange are admitted; decimal-to-int, scalar-to-multi-select, null-as-clear, and every mismatched branch are rejected. Multi-select may write directly to multi-select storage, but cannot hide beneath concat/coercion because CommCare's token string and Nova's JSON array diverge; `concat` is the explicit portable boolean-to-text boundary. A conditional retype establishes its destination type only on the same true branch, so later operations/links that rely on that transition inherit its condition transitively too; `lib/doc/caseOperationOrder.ts` is the one analysis used by wire and runtime alike. `caseRetype.ts::planCaseRetype` is the pure cross-schema plan: retained JSON properties, conversions that may park, source-only values to park, missing destination requirements, review need, the storage-atomic `safe` verdict, and the stricter `wirePortable` verdict. Scalar row metadata such as `case_name` and `external_id` is excluded because it always survives a type change outside JSONB. Only unconditional operation writes satisfy a missing destination requirement statically. Authored portable retypes currently require `wirePortable` (no conversion or parking): CommCare's case wire changes only `case_type`, so admitting a richer Nova projection would create device/Preview divergence. The submission executors may execute the richer plan only after a shared wire representation exists; they must never interpret retype facets independently.

A `Module` (`modules.ts`) carries an optional `caseType`, the `caseListConfig` (a `Column[]` of eight kinds + an optional `filter` predicate + `searchInputs`), and the `caseSearchConfig` (search-screen display + niche filters). These structured configs are the single source of truth every case-list surface reads — validator, wire emitters, SA tools, and the case-list workspace UI. Their AST-typed slots (the filter, calculated-column expressions, search-input predicates/defaults) come from `lib/domain/predicate`. Search inputs are an exact stored union: text, date, date-range, barcode, or advanced predicate. The union is four arms over two independent axes — kind (simple | advanced) and widget (scalar | date-range) — which is what makes a range default and a scalar range mode unrepresentable. Simple inputs require a nonblank case property. A SIMPLE date-range input requires range mode; the ADVANCED date-range arm declares no `mode` slot at all and is `.strict()`, so it carries none. Neither date-range arm has a scalar default. Three slots resolve GLOBALLY — once, before any case is selected — so property and relationship reads are invalid in them: `caseSearchConfig.excludedOwnerIds`, `caseSearchConfig.searchButtonDisplayCondition`, and each scalar `searchInputs[].default`. Literals, session/current-user values, and pure calculations over them are valid (Search answers additionally so for `excludedOwnerIds` only). The shared semantic guards are `expressionReadsCaseData` / `predicateReadsCaseData` in `predicate/walk.ts`, consumed by the validator rules, the SA/MCP boundary schemas, and the builder's global-scope pickers. Owner-only availability is the exact `{ searchActionEnabled: false, excludedOwnerIds }` arm; it cannot carry Search-screen presentation, inputs, or an inferred Never condition. Sort lives per-column (direction + priority); the comparator TYPE is derived at wire emission from the property's `data_type`, never authored.

## Organization shape

`organization.ts` owns two flat Blueprint collections: levels and the catalog
of information places carry. Actual place rows are deliberately absent and
live in `lib/organization`. A level has a create-once code, mutable display
name, forest parentage, and two independent closed settings: case flow (holds
workers, owns cases, descendant reach) and address-book reach (which places a
worker can see and name). A location property has immutable UUID identity,
mutable slug/label/constraints, and optional level UUID membership; row values
key by the property UUID, never the slug. A closed accepted-values catalog is
nonempty at the schema boundary; an empty catalog would make a required field
impossible to satisfy and dead-end every future place write. Every collection
reader follows its membership array. Semantic level UUID lists are nonempty
and duplicate-free, so an address-book allowlist or property applicability set
has one canonical spelling. Persona locations store one nonempty
primary-first identity list, and absence means unassigned rather than an empty
second spelling.

## Who runs the app — properties, roles, personas

`users.ts` holds three flat collections that answer three different questions, and blurring them is the failure mode: a **user property** is a slot workers carry data in (the app's half of CommCare's custom user-data schema), a **user type** is a reusable role that fills those slots with defaults, and a **persona** is a named actor with stable identity that *references* a role and may override values. A **deployed worker** is none of the three — it belongs to a deployment, is created *from* a type or persona, and is deliberately absent from the blueprint. Authored references compile to their current saved slug, but app export/upload does not yet provision HQ's project-level `UserFields` definition, templates, or worker accounts (that is the complex-app plan's push-and-provisioning unit); public docs must not imply that it does.

Values are keyed by property **UUID**, never slug, so a slug rename rewrites nothing. Custom worker-information reads use the same identity law: Predicate / ValueExpression stores `session-user-property { userPropertyUuid }`, and XPath stores `user-property-ref { userPropertyUuid }`; every target resolves the CURRENT slug only at projection. The distinct name-backed `session-user { field }` and XPath `user-ref { property }` arms are the final vocabulary for CommCare-provided or external fields that have no Nova entity. Worker-property slugs begin with a letter or underscore and then admit letters, digits, underscores, or hyphens: HQ's Django slug validator alone admits leading digits/hyphens, but Nova also emits the slug as an XML element in both worker projections, so the intersection is the valid-by-construction boundary. `personaUserData` is the one place a role's defaults and a persona's overrides combine. UUIDs and authored slugs are untrusted record keys: membership and lookup always mean an **own** property, and record construction never uses assignment that can invoke the `__proto__` setter. `ownRecordSchema` exists because Zod's native record parser intentionally drops `__proto__`; it validates enumerable own entries and rebuilds through the shared null-prototype record helper, preserving that valid key as ordinary data. Mutation and hydration boundaries normalize every structural/derived identity map plus nested user value bag to that same representation before use, including ordinary objects produced by JSON and `structuredClone`. That keeps valid identities such as `__proto__` and `constructor` representable without letting inherited prototype members masquerade as authored entities. Each collection is a record plus a membership array (`userPropertyOrder` / `userTypeOrder` / `personaOrder`); both slots are `.optional()` and omitted when empty, so an app declaring none serializes byte-identically to one without them. The array is the sequence and is walked, never sorted — read them through `orderedUserProperties` / `orderedUserTypes` / `orderedPersonas` so no surface can order them differently from another. Their `blueprint_entities` rows carry a real ordinal. A user property's accepted choices are unique by exact value at the schema boundary; duplicate user-property slugs, user-type names, and persona names produce one deterministic finding for every member of the duplicate group in collection-sequence order rather than depending on record iteration order.

`BUILT_IN_USER_PROPERTIES` is the set CommCare injects into every worker's session AFTER the authored data, so it doubles as the reserved-name list — `__tests__/users.test.ts` asserts that every built-in slug is already unreachable through the slug rule rather than maintaining a second list. Each entry carries an `availability` saying whether Nova can honestly supply it before a deployment target exists, and a `readByRuntime` flag: exactly three keys change how the runtime behaves and the rest are inert. Slug legality itself is a CommCare rule and lives with the validator (`lib/commcare/validator/userPropertySlug.ts`), re-exported through `lib/doc/identifierVerdicts.ts` so authoring surfaces keep one import home. Two HQ `Field` columns are excluded on purpose: `regex` (paid privilege — an authored pattern would silently not validate) and `required_for` (the mobile/web split Nova does not model, because it provisions mobile workers only).

A case list is laid out either as a row of columns or as a **tile**: `caseListConfig.tile` (presence IS the switch) plus a per-column `tile` cell carrying `{x, y, width, height}` and optional alignment / text size / border / shading. Placement is NOT sequence — a cell is where a field sits on the grid, the config's two ordering arrays are where it sits in a sequence, and the two never derive from each other. The five presentation slots live INSIDE the cell because CommCare's `<style>` cannot exist without a complete `<grid>`, so styling an unplaced column has no wire spelling; keeping them nested is what makes that state unrepresentable rather than merely rejected. The schema keeps only the per-cell bounds with no repair ambiguity (non-negative origin, positive span) so an imported out-of-grid or overlapping layout still LOADS; the grid contract itself — the 12 × 12 cap, no overlap, full coverage — is the validator's (`lib/commcare/validator/rules/case-list/caseTileLayout.ts`). `tileGridExtent` is the derived fact every renderer must share: the drawn grid is the OCCUPIED extent, never the 12-column authoring canvas.

## Expressions, Connect, media live where their boundary is

XPath-bearing slots store the typed AST from `xpath/` — **references are identity, text is a projection** (`printXPath`); field and custom-worker-property renames never rewrite stored expressions, and human-authored text remains friendly (`#form/first_name`) rather than exposing UUIDs. The Predicate / ValueExpression AST (`predicate/`) is the boolean + typed-value family behind filters, calculated columns, and search, and carries the parallel UUID-backed custom-worker arm. Connect is a per-form opt-in (`form.connect`) gated by the app-level `connectType` (`learn` | `deliver` | null). Every stored Connect sub-config has a required nonblank id, matches the app's Connect mode, and participates in app-wide id uniqueness across Learn and Deliver sub-kinds. Local editor/tool drafts are separate types; they receive their final id before entering the document, and emitters only assert the already-complete invariant. The media primitives (`MediaAssetId`, `Media`, MIME partitions, size caps, the export ceiling, GCS key derivations) live in `multimedia.ts`; the verdicts, manifest, and wire emission live in `lib/media`.

Every reference-capable label, hint, help text, validation message,
select-option label, and case-property display default stores a `ProseTemplate`
(`prose.ts`), never a string: an array of typed parts — `text`, `field-ref`,
`case-ref`, `user-property-ref`, and external `user-ref`. The same rule as XPath
applies for the same reason — a reference holds identity, so a rename rewrites
nothing. A literal `#` is text; only a part is a reference, which is why typing
`#form/name` into a label leaves it literal. Adjacent text parts are
noncanonical and reject, so one authored value has exactly one representation.

Read a template through the right projector. `projectProseTemplate(template,
doc)` is the human one: it takes the owning document and returns
`{ ok, text, unresolved }`, rendering `[reference needs repair]` rather than
leaking a stored UUID. `printProseTemplate` is its strict twin for wire and
runtime callers and throws on the same input rather than emitting a guess.
`proseTemplateText` returns only the literal typed characters and is NOT a
projection — it exists for search and comparison, where matching what someone
typed is the point. Interpolating a template into a string produces
`[object Object]`; every consumer walks the parts.

Lookup table, column, and row identity is domain vocabulary even though lookup
persistence lives elsewhere. `lookupIds.ts` is the import-light leaf containing
the three distinct UUIDv7 brands and their runtime schemas. Never collapse them
to one generic lookup id, and never import `lib/lookup` into this package.

**Built-in icons** (`builtinIcons.ts` — the closed reference schemas + the `MODULE_ICON_SLUGS` / `FORM_ICON_SLUGS` tool enums — plus the generated `builtinIcons.catalog.ts`) are a curated set of menu-tile PNGs Nova ships. Uploaded assets use the strict UUID-branded `MediaAssetId`; built-ins use the separate closed `BuiltinIconRef` (`nova-icon:<catalog-slug>`). Only module, form, and case-list icon slots union those families, and each slot accepts only its matching module/form catalog. App logos, audio labels, field/option media, image-map cells, chat attachments, routes, and persistence accept uploaded UUIDs only. A prefixed string is not identity unless it is in the closed catalog. The catalog (slug → kind/label/contentHash/sizeBytes) is regenerated by `scripts/build-builtin-icons.ts` from the masters in the sibling `nova-claude-design-icons` repo; the shipped 512² PNGs live in `public/nova-icons/`. Built-ins resolve to shared bytes at the manifest seam (`lib/media/builtinIconAssets.ts`) and never impersonate uploaded rows.
