# lib/commcare

One-way emission boundary: `BlueprintDoc` → CommCare wire formats (XForm XML, `HqApplication` JSON, `.ccz` archive). The only package in `lib/` that imports CommCare's vocabulary (HQ shell shapes, `doc_type` strings, XPath functions, session datums, identifier rules). A Biome `noRestrictedImports` rule enforces the one-way direction.

## Client-safe barrel

The `./index.ts` barrel must stay client-safe: the Node-only module (`./compiler` via `adm-zip`) and the heavy emission pipeline (`./expander`, `./xform`) are imported from explicit sub-paths so Turbopack tree-shakes them out of client bundles. The XPath engine, validator, encryption, and HQ HTTP client follow the same sub-path rule. The allowed-consumer set lives in `biome.json`'s `noRestrictedImports` rule — read it there; a copy here drifts.

## Key design decisions

### Multilingual emission is one derived projection

`localization.ts` is the emission facade over the domain translation inventory.
Every configured language receives a complete effective value projection; a
missing or stale target entry falls back to the current canonical source. A
form's itext values (a label, hint, help text, validation message and option
label) then take the fill HQ's form builder applies on every save,
`lib/domain/translationFill.ts::filledProse`: a blank value takes the default
language's text, the app's first language; where that is blank too, the first
non-blank value in language order; a text blank in every language stays blank.
A leaf question's label that is blank in every language and carries no media is
written with no `<label>` and no itext item, which is what a save leaves, and a
written choice has a label or media (`SELECT_OPTION_LABEL_EMPTY`), because no
spelling of an empty choice survives a save and a build. HQ
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

The app language catalog uses Nova identity tags until this boundary. A
language's wire code is chosen here once, when the language is added, and
stored in `localization.wireCodes`; every export reads the stored code, so
adding or removing a language never renames another's.
`languageWire.ts::mintLanguageWireCode` chooses a wire code once, when a
language is added: the identity's preferred spelling where no held language
has it, else the suffixed form. Each identity's preferred spelling is its
Classic catalog row's code, reached directly or by widening a macrolanguage
member through `classicWideningTarget` (`cmn` widens through `zho` to
Classic's Chinese row), three-letter except the four grandfathered
two-letter rows (`eng`→`en`, `spa`→`es`, `swh`→`sw`, `afr`→`af`); an
identity with no Classic reach takes its Set 3 code, which is always
wire-valid. The suffixed form lowers the identity's script and region into a
single suffix segment (`cmn-Hant` → `cmn-hant`) because Classic's grammar
allows exactly one hyphen, and no preferred spelling holds one. The producer
of the `addLanguage` or `relabelSourceLanguage` mutation calls it and the
mutation carries the result; no reducer calls it. `planLanguageWire` reads
`localization.wireCodes` and computes no code; the map is total and
injective because the schema holds it so. Device-picker name rows come from
the registry's baked display labels at the most specific key — never runtime
`Intl`, whose Node/ICU variance must not reach wire bytes. HQ `langs`,
localized property maps, itext language/default attributes,
`default/app_strings.txt`, per-language directories, endonyms, and
`lang.current` are one-way CommCare wire spellings here.
`classicLanguages.ts` (over `config/commcare-classic-languages.json`) is wire
data quarantined here, and its only consumers are the wire plan and the
language-identity migration script. An `eng`-only app — including every app
with an absent localization root — emits byte-identical output to the
historical `en`-only shape.

### Runtime request destinations

`lib/deployment/runtimeTarget.ts::chooseDownloadTarget` (pure) and
`lib/deployment/downloadTarget.ts::resolveDownloadTarget` (server-only) are
the one resolver of what an export is made for. It yields a full target (the
server, the domain, the deployment's HQ working app id and its recorded ids)
or none, and a bare server reaches no emitted byte. `runtimeTarget.ts` here
projects that target into the Search, case claim and known-case hydration
URLs (`runtimeUrls`, which has no partial-placeholder arm: with no target it
prints the neutral `__COMMCARE_HOST__` template that structural validation and
the HQ JSON path read, since HQ writes its own URLs when it builds); `expandDoc`,
`compileCcz` and the shared navigation context carry the same target, and
direct publishing supplies its selected server and domain. Every `.ccz` is
made for one published project space, and its profile names that space's
four server properties (`ota-restore-url`, `PostURL`, `key_server` and
`cc_user_domain`, from `runtimeTarget.ts::profileServerProperties`); an app
that is published nowhere is offered no `.ccz`. An app that does not declare
Android has no `.ccz` at all (`runtimeTarget.ts::chooseDownloadTarget`,
`not-declared-for-android`): a `.ccz` installs an app on Android. The HQ import
file carries derived ids and no target.

A local `.ccz` names something stable. Its profile's `uniqueid` is Nova's own
id for the app on one project space (`runtimeTarget.ts::profileUniqueId`, from
`doc.appId` and the target's server and domain, never its HQ app id), so every
`.ccz` of an app for one project space is one app to a phone, the files for
two project spaces are two, and none is HQ's build, whose `uniqueid` is HQ's
app id. `cc-content-version`, `cc-app-version`, every form resource and every
locale resource take the app's sequence (`apps.mutation_seq`), and each form's
data node takes it as `version` (`xform/formVersion.ts::setFormVersion`);
media resources keep `1`. The profile's `version`, its two suite resources and
`<suite>` take the sequence plus `CompileOptions.earlierHqApps`, the number of
HQ apps the target's deployment held before the one it holds, so the file made
after a deleted HQ app is made afresh is newer to a phone though the document
did not change. The profile requires CommCare 2.57 (`requiredMajor`,
`requiredMinor` from `versionFloor.ts::COMMCARE_VERSION_FLOOR`,
`requiredMinimal="0"`). `cur_locale` is the first language's wire code,
`force="false"`. `<features>` opens with `<checkoff active="true"/>`, without
which a device hides its saved forms whatever the setting says. The seventeen
settings of `appProfileSettings.ts::appProfileProperties` follow in its order,
each with the `force` its table gives. The archive writes neither
`heartbeat-url` nor HQ's six other server properties: a `.ccz` is no HQ build,
and a phone on one takes a newer `.ccz` for the same project space through
Offline Update, on CommCare's update screen.

### The surface manifest

`surface/` records everything CommCare's upstreams accept in an app and what
Nova does with each, in two layers:

- **The surface**, `surface.json`, generated: every item HQ, Core and Android
  accept at the commits `proof/pins.json` names, keyed `<family>:<name>`
  (`schema:Detail.display`, `toggle:SESSION_ENDPOINTS`, `jr-fn:count`,
  `parser:DetailFieldParser/field@sort`, `hq-api:import_app_api`), each with the
  facts whose change matters and the source it was read from.
  `npm run surface` regenerates it in the proof image (`proof/surface`, which
  reads code by parsing it, never by matching text); never edit it by hand. The
  proof lane's gate fails while the committed file is not byte for byte the
  extraction at the pins. One family is authored instead:
  `media-formats.json` (`media-format:`), whose facts come from the vendors'
  documentation and, where an item carries `executed`, from the run its
  record in `executions` names; a change to it is a reviewed edit.
- **The entries**, authored, parsed by `schema.ts`. `entries/<area>.json`
  holds one inventory entry per counted row of the research's inventory area
  files: the surface keys it covers (or `noSurfaceKey`, why no surface item
  can hold it), a value class where the inventory splits one item by value,
  its disposition (HELD, HELD-NEW, TARGET-OWNED, INERT or REFUSED), the slot
  change or the refusal's reason, the Web Apps and Android behavior, the gates
  it needs, and its emission. An entry marked `origin: "export-use"` covers an
  item Nova's exports use that no row covers. `entries/gates.json` holds one
  gate entry per gate (a toggle, a removed toggle with document residue, a
  plan privilege, a build version, a project-space setting): its class, the
  entries whose content it gates, its target preflight, and its `effects`,
  the build differences flipping it makes, which the proof lane's sensitivity
  runs write (`proof/README.md`, "Configuration sensitivity").

A surface item no entry names is refused wherever an app uses it: a schema
field at any value other than HQ's default, and any other item wherever it
occurs. The manifest is the living record of every disposition. A change to
an entry edits its row in the inventory under
`docs/research/2026-09-26-hq-round-trip/inventory/` in the same pull request:
a split entry adds its row beside the row it splits from, an entry marked
`export-use` has none, and the inventory's Counts table stays the research's.

`surface/__tests__/manifest.test.ts`, in ordinary CI, holds the entries to the
schema and to the surface (every key and gate an entry names exists, no two
entries claim one key at one value class, a REFUSED entry without a value
class shares its key with no other entry unless only HQ's build refuses it)
and prints the coverage, "N of M entries held". The proof lane's manifest
check holds Nova's own exports to the entries: every item an export uses must
be held by the entry whose value class takes it, where holding is a HELD,
TARGET-OWNED or INERT entry's, so a use whose key only HELD-NEW entries name
is a difference (`/<key>/held-new`); and every flag HQ reads while building it
must have a gate entry (`proof/README.md`, "Manifest checks"). Server code
reads gate entries through `surface/gates.ts`, never `surface.json`, so a
server bundle carries the gate entries alone.

The platform table in `lib/domain/platforms.ts` stands for the manifest's
per-platform readings, held to them by `surface/__tests__/platformFeatures.test.ts`
over `surface/platformFeatureEntries.ts`, which only tests import; a HELD entry
that differs by platform is a feature's or ambient, so an entry that gains such
a reading lands with its row. The validator refuses a structural use a declared
platform cannot run (`validator/rules/platforms.ts`, `PLATFORM_FEATURE_UNAVAILABLE`).

### CommCare HQ project-space compatibility

Deployment readiness uses the bounded `readBuildXml` path for an exact released
build. `probeBuildProfile` confirms the profile's remote suite identity with
`profileReferencesBuildSuite`; HTTP 200 with empty, malformed, unrelated, or
wrong-build bytes is unverified. Version and build-list readers validate the
JSON envelope before reading fields, so JSON `null` remains an unavailable HQ
answer rather than an internal exception.

The XML reader counts decompressed HTTP body bytes as it streams, accepts at most
20,000,000 bytes, and cancels an oversized body before buffering more. UTF-8
decoding spans chunks; the 30-second deadline owns headers and body consumption.
Resource consumers still own XML syntax and selected-build identity checks.

JSON source, version/build, project-space and collection reads share
`hq/readJson.ts`: native fetch, no redirects, no cache, an owned deadline through
body consumption, and explicit HTTP/transport/JSON failures. Paginated reads
carry one signal through the full list; compatibility retains its shorter
five-second deadline. Project-space pages must retain their count, unique valid
names, exact endpoint and private filter. Discovery awaits every started probe
in its eight-request window before returning a failure. App-access success
requires the HQ `status: success` / `applications` envelope. Build rows and
version fields are complete evidence: malformed release flags or missing
version values are unavailable, never an absent release.

Standalone `.` and `..` are not usable project-space or app path segments:
native URL parsing removes them before HQ receives a request. Other legacy
project-space dots, colons and underscores remain supported.

The same response boundary applies to publishing. Import acknowledgements
validate the verdict, remote identity, optional version and warnings before
the deployment service records them; an update cannot return a different app.
Lookup and organization inventories validate every identity and an explicit pagination cursor,
and stays within the selected project space and resource path. Inventory reads
and app imports do not follow redirects. Unknown lookup-upload verdicts retain
the possibility that rows landed, so the service re-reads ownership evidence.
The shared collection reader owns one 30-second deadline across every page and
body read. Location levels resolve parent resource URIs across the full list;
an unresolved parent or cycle refuses the inventory. Place reads preserve all
foreign JSON metadata for the replacement write. Atomic place acknowledgements
must be HTTP 202 with unique positional ids, and every update must return its
requested id. A lost or malformed acknowledgement carries uncertainty.

Public surfaces speak only semantic capabilities from
`lib/publish/projectSpaceCompatibility.ts`: Case search, CommCare Connect,
attachments saved to cases, links to captured files, registration offered after
an empty search, choosing several cases at once (a multi-select case list),
search across related cases (a relation in a search's own filter, supporting
related cases, or a search-first menu that follows a parent case chosen first),
and case tiles. Publish names capabilities too, never HQ flag names. At publish
only the publisher's key reads a space's flags: a toggle keyed by project space
alone is never on for a user (`corehq/toggles/__init__.py::StaticToggle.enabled`),
so a flag the probe reads as on is the space's own. A project space the key's
user has left is the `not-a-member` issue: the unfiltered list answers without
it, and every publish there stops. Literal HQ setting
names, namespaces, and raw probe arrays live only inside this boundary: the
surface manifest (`surface/`), `projectSpaceCompatibility.ts`, and the
server-side HQ client. They are implementation details, never settings a person
or an agent chooses. The flags the probe checks, and for which content, are
written in `projectSpaceCompatibilityProbePlan`, with each Nova flag id's HQ
toggle in `HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`. A flag's slug and namespace come
from that toggle's gate entry in the manifest (`surface/entries/gates.json`),
read through `surface/gates.ts::domainFeatureFlag`, which refuses a
FrozenPrivilegeToggle (HQ's feature-flag filter never lists its slug) and a
toggle not keyed by project space alone. Server code reads gate entries through
`surface/gates.ts`, never the generated `surface.json`. Add a probed flag only
with an actual Nova emitter and its gate entry; remove or update it when the
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
Mobile App Access permission. An HQ-origin 403 gives that permission-specific
unverified result; a recognized edge refusal remains unverified without blaming
account permissions. Readiness requires HTTP 200 with an XML content type, so an
HTML login/proxy page cannot pass preflight. The successful body is cancelled
without reading case data. Only the exact configured-off 404 is missing, and no
result body is retained or logged. Each visibility, flag, and runtime check owns
its five-second deadline through response-body completion or cancellation.
A Search field with a starting value, a hidden Search value, a search-first
menu, a one-date Search field and a Search field Nova matches by its own filter
each add the private child setting to the SAME public Case search capability:
HQ omits `<prompt default>` without it and its editors offer none of the others
without it. A search's own filter (`_xpath_query`), the zero-input `match-all()`
included, does not add it: HQ's Case List page offers and keeps a default
filter for every project space. Both export paths send the zero-input filter.
Missing or
unverified required capabilities block before writes.

`planPrivileges.ts::requiredPlanPrivileges` derives, from the document, what
the publish pushes, and the attachment target the emitter is handed (a capture
saved as a link is a case write only where there is a link to write), the plan
features the content needs (`cloudcare` for an app that declares Web Apps,
`user_case`, `lookup_tables`, `child_cases`, `form_link_workflow`,
`save_to_case`, `locations`, `data_forwarding`), each
with the sentences that say why this app needs it. The `locations` feature
and the flat location list's confirmation name each form whose source or
links read places (`locations/readsLocationsFixture.ts::formsReadingLocationsFixture`):
it prints every expression the form carries (question logic, Connect, case
operations and the display condition as XForm, link conditions and datum
values as suite) under the identity lookup naming, counts a form whose printed
trees declare `locations`, and says `owner` when a case owner is its only place
read. Forms are the whole count: every menu, case list, Search and display
condition slot is a record rule, where the checker refuses a place read
(`arm-unavailable`, reason `places-unavailable`), so no suite menu, detail or
remote request declares `locations`. An owner read says the form "sets a case's owner from a place in your
organization", any other "reads places in your organization". A level code
alone prints a literal and reads no place. HQ's build asks for `lookup_tables`
on a form whose source holds the literal `src="jr://fixture/item-list:`
(`models/forms.py::FormBase.has_fixtures`), which the XForm serializer's
double-quoted attributes write for a form-logic table read. Each rule asks the
emitter's own decision over the form link context `expandDoc` builds, so the
answer and the wire cannot disagree. HQ's slugs stay inside `lib/commcare`; `lib/publish/planFeatures.ts`
holds what a person reads. No API key reads a plan, so these are confirmed by
the person, never probed, and a lane test holds `planPrivilegePlans.json` to
HQ's own plan lists.
The large-search performance check is advisory: it controls only whether Nova
can add its derived Search optimization and never blocks publishing or removes
Search.

`planPrivileges.ts::formEntrySyncReasons` names each form that works on a case
in a module whose case list offers Search, for an app that declares Android:
HQ's build gives such a form's entry a claim that always posts while the
project space syncs cases on form entry, and Android can't open a form whose
entry asks for a sync, so publish asks a person to confirm the setting is off
(`form-entry-sync-off`).

A download checks no project space, so its compatibility is `not_checked`: the HQ import file has no target, and a `.ccz` is made for a project space the app is already published to, whose publish made the check.
Upstream drift reaches the probe through the weekly pin pull request
(`.github/workflows/upstream-pins.yml`), which moves the pins to each
upstream's default-branch head, regenerates the surface there, and classifies
every item added, removed or changed: a toggle's class, slug, tag, namespaces
or parents, and the routes, decorators, request reads, module constants (the
refusal message the probe compares) and resource meta (the paginator) of the HQ
views and resources the probe calls (the `hq-api` family: `UserDomainsResource`,
`search`, `app_aware_search`). Every toggle gate entry's slug, namespaces and
class must equal its surface item (`surface/__tests__/gates.test.ts`), so a
changed flag fails CI on that pull request. It is the retirement/GA or
probe-compatibility review signal.

Nova derives one profile property from app behavior, the custom property
`cc-index-case-search-results`; it is not an authored setting and never
enters `BlueprintDoc`. Seventeen ordinary profile properties are stated by
`appProfileSettings.ts::appProfileProperties`: `cc-show-saved` and
`cc-show-incomplete` are app content (`appSettings`), and the other fifteen
are constants, each the value a device reads when the key is absent.
Effective remote Search derives
`cc-index-case-search-results=yes`, which indexes Search results in CommCare's
temporary case storage and does not request or imitate a sync. Local CCZ emits
the property because its supported runtime is fixed. Targetless HQ JSON carries
the derived property as intent. Direct publishing includes it when the selected
project space supports the performance advisory. An inconclusive advisory
preserves the target's current owned value on update; confirmed missing support
removes it, as does removing Search from the app.

HQ's import replaces every top-level key an update's body carries and keeps
every key it leaves out (`models/applications.py::_merge_source_into_app`), so
three keys need the target's current value: `profile`, `translations` and
`add_ons`. Every read of the app's source goes through one reader
(`hq/appSource.ts::readHqAppSource`), and
`targetOverlay.ts::projectApplicationForTarget` projects all three against the
one read the publish hands it, its last before the import
(`lib/deployment/CLAUDE.md` says which): it carries what the target owns,
writes Nova's own values over it (`cc-show-saved` and `cc-show-incomplete`
always; a constant setting only where the target holds no value for it), and
leaves a key out of the body when the result equals that read's value.
`profile.properties` is projected whatever the Search advisory says; an
`unverified` advisory leaves `custom_properties` as the target's bag. A source
that fails the shape check stops the import with `hq_app_state_unknown` and is
never read as empty. Every content write is an update of an app Nova has
read, the empty app a first publish makes included, so no body is sent blind.
`_attachments` remains the final HQ JSON key after every projection.

### Typed form expression emission

`xform/formExpressions.ts` lowers the saved `Expression` directly through `toWire`, with its exact field, form, prose, or case-operation member slot context. `xpath/formNodeProjection.ts` maps the shared finite form-node graph to physical `FormPath` locations. A query-repeat field read addresses its iteration rows; the explicit query-wrapper role addresses the wrapper. Runtime attributes and Vellum shadows serialize the same resolved tree, with no human-source projection or text rewrite between them. `xform/itextIds.ts` owns logical field ancestry and option identity to itext IDs, including prepared authoring structures. Prose remains `ProseTemplate`; each explicit reference lowers through that prose slot's context. Non-expression data uses typed domain accessors; case bindings use `fieldCaseWrite(field)`.

Wire-only menu placement does not change an expression's authored owner. The expander passes the canonical document to the XForm expression boundary even when `emissionPlan` has placed a no-matches registration form in a synthetic menu. The boundary asserts that this placement preserves the form and question coordinates; Search input identities resolve against the original host's prompt map and the emitted inline-search instance.

Query-repeat insertion bookkeeping counts `../item` from its wrapper attribute. An absolute count can include another parent's rows during dependency recalculation when an outside expression reads nested iterations. Native Core tests cover these consumers in both local CCZ and HQ-regenerated forms.

### Validation counts keep their evaluation context

Core substitutes a question's proposed answer while evaluating its constraint,
including at a filtered collection's current node. `constraintCollections.ts`
lifts independent `count(otherQuestion[predicate])` expressions into sibling
Hidden Values named `nova_constraint_<question>_<n>` by the allocator
(`xform/generatedNodes.ts::planGeneratedNodes`), then keeps the candidate
comparison in the constraint. The name is not reserved: an authored sibling of
the same name makes the allocator take the next suffix.
Only typed scalar references and context-independent predicates qualify. The AST walk retains counts that read the validated answer, use outer relative/current paths or functions, or occur inside another predicate. The original expression identities remain unchanged; lowering substitutes the selected count nodes with their generated sibling paths. The lifted calculation carries no
`vellum:calculate`, because its expression filters a form reference, and its
predicate's own node is printed `./.`; the constraint's executable and shadow
expressions share the lowered result. `ContainerRuntimeTest` exercises actual
controller answer admission, zero/one/multiple selections, and direct candidate
validation through local and HQ-regenerated forms. This is a bounded correction,
not general native parity for every possible predicate.

### Hidden fields carry one value source

`validator/rules/field.ts::hiddenValueBothSources` (`HIDDEN_VALUE_BOTH_SOURCES`,
soundness, located at the field) refuses a hidden field
holding both a `calculate` and a `default_value`. JavaRosa runs the
`xforms-ready` seeds first and then re-evaluates every calculate
(`commcare-core` `FormDef::initialize`), so the calculate's value is the one
the field ends with; a later load-time setvalue can still read the default
before that (run on Core: a hidden value with the default `'D'` and the
calculate `'C'` ends as `C`, and a second value whose own default reads the
first holds `D`). Nova does not yet write a Hidden Value's default beside its
calculate (`lib/domain/fields/hidden.ts::HIDDEN_VALUE_ONE_SOURCE_SENTENCE`). A
hidden field with neither slot is admitted and opens blank; the shared
recognizer is `lib/domain/fields/hidden.ts`. The same
ordering is why the case preload below beats a `default_value` but never a
`calculate` on a hidden writer.

A Hidden Value that saves to a case property is a typed writer
(`validator/rules/hiddenValueWriterAgreement.ts`, reading
`lib/domain/expression/inference.ts::hiddenWriterVerdicts`): each value it can
end with must be write-assignable to the property's agreed type
(`lib/domain/expression/ruleSets.ts::isWriteAssignable`: storage assignability,
plus a `format-date` fixed to `%Y-%m-%d` into a date property), a date and
time whose clock may be gone cannot write a date-and-time property, and Hidden
Values that alone type a property must agree (`int` with `decimal` on
`decimal`, `text` with `single_select` on `text`). Each disagreeing writer is
`HIDDEN_VALUE_WRITER_TYPE_MISMATCH` at the field. A blank `''` fits every
property, and a starting value the case preload overwrites holds no opinion.

### Worker-information identity projection

Custom worker information has one stable document identity and one leaf in
every expression slot, `session-user-property { userPropertyUuid }`. A form's
`#user/<slug>` read is that leaf with `source: "worker-record"`, which reads
the worker's own case. `toWire` receives the current UUID→slug map and throws
if an identity has no binding — the commit
validator should have caught the dangling reference, and silently emitting a
UUID or stale name would corrupt behavior. The name-backed
`session-user { field }` leaf is exclusively
for CommCare-provided or external fields with no Nova entity. Worker-property
slugs begin with a letter or underscore and admit hyphens only after that first
character: both session and usercase emit the slug as an XML element, so this
XML-safe intersection is stricter than HQ's Django slug validator. The HQ JSON,
local XForm, and local suite fixtures pin a hyphenated slug to exact emitted
bytes.

The emitted paths are pinned to named CommCare authorities:
`test_suite_remote_request.py::test_required` for
`instance('commcaresession')/session/user/data/<slug>`, `suite-case-detail-tabs-with-nodesets.xml` for the usercase selector, which Nova prints in its canonical spacing as `instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/<slug>`, and the corresponding suite session path. The HQ JSON, local suite/XForm, and HQ-upload XForm tests assert those exact bytes and re-run them after a slug rename without changing the stored tree.

### Capture uploads — a closed enum, not a conditional

The delivered question contract joins the control, answer bind, and itext label
in both HQ source and the actual CCZ. Decimal questions emit `xsd:double`, the
Decimal type HQ and Vellum classify; Core accepts both `decimal` and `double`,
so runtime parse success alone does not prove HQ round-trip behavior.

The XForm model keeps form definitions separate from every instance's data
subtree. Both oracles read binds, controls, actions, and localization from that
definition inventory. An answer named `secret`, `bind`, or `translation` is
ordinary data; data cannot declare a secondary instance or satisfy a missing
itext reference. A missing localization catalog does not make a referenced
label valid.

HQ's form builder cannot open a form that holds an element named `instance`,
`bind` or `parsererror` at any depth, so the validator refuses those three as
a question id and a Connect block id
(`lib/domain/questionId.ts::RESERVED_QUESTION_IDS`), as a case operation id
and a link identifier (`questionId.ts::stopsFormBuilder`), and as a property
name a block in a form's source writes
(`CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP`). It reads a Save to Case
block's `close` and `create` as the block's own action at any depth inside
`<case>`, so a link identifier may be neither and a written property may not
be `close`. A property a basic action alone writes is not refused: HQ's build
adds that block and the source never holds it.

`xform/captureUpload.ts` owns the `<upload mediatype>` vocabulary. It is a table rather than a conditional because an unmatched `mediatype` does not fail: `XFormParser::parseUpload` matches with literal `String.equals` against exactly four strings (`image/*`, `audio/*`, `video/*`, `application/*,text/*` — comma, NO space), anything else leaves the control at `CONTROL_UPLOAD`, `entries.js::getEntry` falls through to `UnsupportedEntry`, and that constructor SETS the answer to the literal string `Not Supported by Web Entry`, which submits. Silent bad data, not a visible error — so `UploadMediatype` admits only the four literals and `UPLOAD_MEDIATYPE_BY_CAPTURE_KIND` is total over `captureFieldKinds`, making the bad state unrepresentable. Signature shares `image/*` and is split out by `appearance="signature"`; `appearance="face"` and `jr:imageDimensionScaledMax` stay out because both are inert on every runtime Nova targets.

Nova writes no `build_spec`. Publish reads the target's `build_spec.version` from its source and stops below `versionFloor.ts`'s 2.57 (`compareToVersionFloor`), which the local profile's `requiredMajor` and `requiredMinor` also state.

### Vellum dual-attribute pattern

A real attribute (`calculate`, `relevant`, `constraint`, `required`) and its `vellum:` shadow print from one wire tree: the real attribute in `xform` mode, the only text the device and validator parse, and the shadow in `vellum` mode, the shorthand HQ's form designer treats as source of truth on round trip (`xpath/wire/serialize.ts::serializeWire`). Every bind also gets `vellum:nodeset="#form/..."`.

An expression gets a shadow only when its tree contains an authored form
field read, spelled `#form/` or `/data/` (both print `#form/` in the shadow,
as production's emitter always has), and no withheld read. Constant-only and
relative-only expressions have none, nor do generated absolute paths; a
hashtag-looking string literal does not count as a read. Generated bind calculations and setvalue defaults never
request expression shadows.

Shadows emit ONLY vocabulary the editor is GUARANTEED to know for the form, never merely plausible vocabulary: an unknown hashtag makes the editor's XPath engine (`Vellum/src/xpath.js::isValidNamespace`) mark the whole expression unparseable and re-serialize it VERBATIM into the real attribute on the user's next save — raw hashtags on the wire, failing HQ's next build ("Couldn't understand the expression"). `vellum` mode owns this projection: a field read spelled `#form/` prints `#form/<path>`. A case, worker, or Search read is an `expansion` in the tree and withholds the shadow. No shadow carries `#case/`, because a `#case/` hashtag over `case_id`, `owner_id` or `status` is saved as a child element the case database does not have, and one over a property HQ's schema does not list is an unknown question on every save. With the raw casedb path in the real attribute, the form builder's reverse map turns a listed property into its own `#case/<property>` on load and saves the same real attribute, and leaves every other read raw. `vellum` mode also withholds the shadow when a `#form/` read carries a predicate or heads a longer path: the form builder cannot parse that, writes the shadow verbatim into the real attribute, and HQ's next build fails. Outside a validation condition the serializer prints a predicate's own node as `./.` in `xform` and `vellum` modes, because the form builder reads a bare `.` in any other condition as the question referring to itself. There is NO way to teach the editor more: it reads hashtag metadata only from head elements, only as a pre-datasources fallback, and `Vellum/src/form.js::_updateHashtags` resets namespaces to `#form` + data sources once they load. A comparison of two dates and times carries its lowering in the shadow too. The form builder prefers the shadow on load (`parser.js::parseVellumAttrs`), so a shadow holding the bare comparison would put it back at the next save. A person who opens such a form in HQ's form builder therefore sees the longer lowered formula in the question's logic field; it keeps its meaning.

Two attribute names are not what you'd guess, both verified against `Vellum/src/parser.js` (only POPPED attributes round-trip; an unread `vellum:*` attribute lands in `rawBindAttributes` and accretes an extra prefix on every editor save — HQ's own wash template app carries `vellum:vellum__required` chains from this): a conditional required's shadow is `vellum:requiredCondition` (never `vellum:required`; the bare `requiredCondition` attribute Vellum itself writes is deliberately NOT emitted — JavaRosa ignores it with an "unrecognized attributes" warning and rebuilds the condition from `required`), and the native editor spelling for a repeat count is `vellum:jr__count` (`:` → `__`). Count-bound repeats emit a shadow naming the same question or calculated helper as `jr:count`. For expression counts the authored formula belongs on the helper calculate, never on the repeat shadow. Query-repeat shadow behavior is unchanged.

Once a save in HQ's form builder has written its own `#case/x` shadow and `x` later leaves HQ's schema, the builder warns about HQ's bytes, as it does for any form made in HQ; a Nova publish replaces the source. `case_references_data.load` walks typed form-case and worker-record terms, resolves current custom worker-property names, and emits HQ's `#case/` and `#user/` metadata strings. Session actor values and hashtag-looking literals contribute no case load. HQ's app summary reads these strings (`app_schemas/app_case_metadata.py::_add_load_references`) and the form builder does not: it posts its own map on save (`Vellum/src/core.js`, `case_references`) and never reads the stored one. That map is a SEPARATE vocabulary with looser rules (`hashtags.ts::hqLoadReference`): it's string-parsed HQ metadata, not editor-expanded XPath, so per-type refs land there at every depth — generation form through `grandparent`, parent-chain past it (`app_case_metadata.py::_parse_case_type` recognizes only `#case/`/`#user/` prefixes and normalizes `grandparent/` to `parent/parent/`) — except a registration form's `#case/case_id`, which reads the session datum the entry mints the new case's id into, not a case load (`formActions.ts::buildCaseReferencesLoad`).

**Case references, `save`.** `case_references_data.save` is the other half, and it is not hand-assembled at any emission site: `xform/caseSaveReferences.ts::caseSaveReferences` derives it from the constructed `<h:html>` tree before serialization (`xform/builder.ts::buildXFormSource` returns it beside the XML, and `expander.ts` hands it to `hqShells.ts::formShell`), so every Save to Case block the emitter constructs, guards and `nova_operations` blocks included, is listed. The rules are the form builder's own computation (`Vellum/src/logic.js::LogicManager.caseReferences`, `src/saveToCase.js::parseBindElement` and `getCaseSaveData`): one `CaseSaveReference` per `vellum:role="SaveToCase"` element keyed by its absolute data path, its properties the bound `create/` and `update/` leaves in bind order, then `case_type`, `case_name` and `owner_id` for a block that creates; attachments and `index/` leaves are never listed. That makes the stored map a fixed point of the builder's save, and it is what HQ reads as the properties those blocks write (`models/forms.py::FormBase.get_save_to_case_updates`, its case-property inventory and the data dictionary). HQ's build refuses a creating reference without `case_type` or `case_name` (`helpers/validators.py::IndexedFormBaseValidator.check_save_to_case_references`). `validator/hqJsonOracle.ts::checkCaseReferences` holds Nova's own output to this in tests; the proof lane's two editor saves and its manifest comparison (`save_differing_from_vellum`) hold it to the builder. The local `.ccz` carries no such map.

### Bare hashtags in prose

Reference-capable label/hint text is a typed `ProseTemplate`; only explicit reference atoms lower to dynamic `<output>` values, while hashtag-looking text remains literal. Whitespace-only text runs use literal outputs as described below. `lib/domain/hashtagSegments.ts` owns the segment vocabulary of prose chips and, via `xpath/__tests__/hashtagMatchers.divergence.test.ts`, keeps it in lockstep with the Lezer grammar's `HashtagType`/`HashtagSegment` tokens. Expression chips come from parse spans.

### Markdown itext

All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`. Safe for plain text: identical rendering when no markdown syntax is present.

`xform/builder.ts::buildLabelNodes` protects decoded whitespace-only runs with
outputs that carry no Vellum shadow. Core's `XFormParser::getXMLDocument` removes
Java `String.trim()`-empty text nodes; HQ's `WrappedNode.render` calls lxml
indent, which replaces Unicode whitespace-only tails too. ASCII runs use
literal `<output value="'...'"/>`; Unicode runs use `json-property` with ASCII
JSON escapes, which Core decodes during substitution. Vellum's XML serializer
replaces literal NBSP throughout the XML, so NBSP inside ordinary prose uses
that protected spelling too. Other prose retains its decoded text nodes.
The character classifier mirrors these consumers, not JavaScript `trim()`.

Plain literal validation messages emit the compatible bind `jr:constraintMsg`
reference and a body `<alert>` pointing at the same itext entry. Empty messages
retain that path and its shared entry gate. A field carries media on its label
and its help text. A hint, a validation message and a group's or repeat's label
carry none, because no CommCare runtime shows media there, so a protected
validation message has no `__nova_mode;image`, `;audio`, `;video` or
`;video-inline` form. For a validation message, commcare-android
(`FormEntryActivity`) and Formplayer (`JsonActionUtils`) both read a
constraint's text through Core's `FormEntryPrompt.getConstraintText()` with no
text form.

If any effective locale has a typed reference or decoded `${` literal,
`xform/constraintMessage.ts` instead composes the raw constraint expression.
Core's alert template filler would substitute marker-like authored or returned
data. ASCII JSON literal forms under the original itext id preserve exact
characters through HQ and Vellum. Typed values build their wire trees through
`toWire`, as every expression does. One reference stays
a direct term; `concat(singleNodeset)` would silently join multiple nodes.
Internal locale/mode forms select the effective wording. The expression's
outer `if` on `jr:itext('<id>;__nova_mode') = 'media'` stays, and the message
writes no `__nova_mode;<medium>` form, so it always takes the wording branch.
Each protected group carries its base id in an inert `__nova_identity` form
in every locale, preventing HQ from merging equal groups while leaving the
suffix-based internal references pointed at a removed id.

An irrelevant, readonly sibling input owns the original itext id without an
alert on the real question. It carries no value source or case action, is
excluded from native traversal and normal submission, and retains media
ownership through HQ and Vellum. Its letter-leading name reserves all authored
siblings (including later ones), earlier allocations and root Connect ids in
the actual group/repeat item scope. Every question-level generated name, this
one included, comes from the one allocator
(`xform/generatedNodes.ts::planGeneratedNodes`). The `__nova_identity`,
`__nova_mode`, `__nova_locale` and `__nova_piece_<n>` names are itext form
names, not question names, and keep their prefix. These are wire artifacts
only; the blueprint and its authored identities do not change.

Core catches raw-message evaluation failures and returns expression text.
Plain/Markdown composition therefore checks each typed reference's actual
nodeset count first. A count above one returns no custom wording, so the native
client shows its existing localized validation warning, while zero/singleton
references retain normal scalar coercion. The answer is still rejected and no
row is selected or joined. A completely empty resolved message also uses that
warning. This deliberately improves old exception/empty behavior rather than
claiming identical error handling.
The admitted fixture runs through local CCZ, HQ source and HQ regeneration;
the ordinary proof also builds it through HQ and saves it twice through Vellum.
`XmlTextRuntimeTest` reads exact plain and Markdown prompts and validation
messages after changing an answer and switching languages. This proves Core
text values, not Android or browser typography.

### Secondary instances

Instance declarations are the instances the printed wire tree reads: `serializeWire` returns them with the text, and each emitter adds them to the scope Core evaluates in. A non-self `count`, `exists` or `missing` prints a `casedb` path even without a `where` property, so it declares `casedb` like every other case read; a case operation's selected-case anchor prints its `commcaresession` read. Each compile mode supplies lookup naming, including HQ XForm sources. `RelationInstanceRuntimeTest` opens and submits isolated
consumers on both form paths and retains the formerly missing-declaration form
as a native negative control.

An XForm's `<instance>` elements are the set its printed attributes read, the case blocks (`addCaseBlocks`) and the meta block included. They are collected in one `InstanceSink` and written `casedb`, `commcaresession`, then the rest by id; a declaration nothing reads is not written. A lookup read declares its tag with the `jr://fixture/item-list:<tag>` source, from the exact `LookupWireNaming` snapshot; an unknown table fails closed. Two declarations of one id with two sources throw. Authored expressions and generated scaffolding both enter as typed trees; declarations come from serialization, without scanning printed XPath text.

`sessionContext.ts` owns Core's complete closed context-child namespace:
`deviceid`, `appversion`, `username`, `userid`, `drift`, `window_width`, and
`applanguage`. Both the binding-resolution oracle and Preview's structural
instance template consume that set. The `session-context` leaf stores and
parses all seven. The authoring choices offer all seven. `drift` and
`window_width` type as whole numbers; `window_width` is admitted only in a slot
CommCare evaluates while a menu or a list loads; and `window_width` and
`applanguage`, which can be absent, print under the count guard
(`xpath/wire/emptyRows.ts::guardAbsentNode`). The case list's search text,
`session/data/stringquery`, is a value arm admitted in a form that opens after
exactly one case list, printed `if(count(P) > 0, P[1], '')`. The primary instance root follows the same
rule: `xform/dataRootAttributes.ts` is the shared projection for emitted and
Preview-visible `uiVersion`, `version`, and `name` attributes. The data node's
`name` and `<h:title>` are the form's name in the app's default language
(`lib/domain/formWireName.ts::formWireName`), the text HQ's form builder writes
into both on a save. No spelling survives a save made in another editing
language: the builder then writes that language's name into both, as it does to
a form made in HQ. The first save of a Nova form in the form builder gives it a
new version at the next build, with nothing in it changed, so devices fetch it
again. The source and Preview keep `version` `1`; a local archive's forms take
the app's sequence at compile time (`xform/formVersion.ts::setFormVersion`,
called by `compileCcz` beside `addCaseBlocks` and `addMetaBlock`), as HQ's
build overwrites the source's `1` with its own.

### `post_submit` defaults

Controls post-submit navigation. The stored and machine-authored vocabulary is
exactly `app_home`, `firstMenu`, `module`, `parentMenu`, or `previous`
(`lib/domain/forms.ts::POST_SUBMIT_DESTINATIONS`). `lib/commcare/session.ts`
projects those values one-way to the different workflow spellings required on
the wire; wire vocabulary never enters the domain. `firstMenu` is HQ's `root`,
one `<create/>` with no children, and `parentMenu` is `parent_module`, the
parent menu's frame (`formLinkProjection.ts::parentMenuDestinationFrameChildren`,
as HQ's `workflow.py::_get_static_stack_frame` builds them). Form-type defaults
when absent: registration/survey → `app_home`; followup/close → the first the
menu offers of `previous`, `module`, `firstMenu`
(`lib/domain/forms.ts::defaultPostSubmit` takes the menu facts `searchFirst`,
`multiSelect`, `parentMultiSelect` and `offTheMenu`;
`lib/domain/postSubmit.ts::effectivePostSubmit` is the doc-level reader every
consumer uses). `postSubmitDestinationsOffered` is what HQ's form settings page
offers for the menu's shape, narrowed by Nova's own conditions for a menu that
is off the menu, and one rule, `POST_SUBMIT_NOT_OFFERED`, refuses a stored
destination outside `postSubmitDestinationsAdmitted`. Everything HQ's build
refuses is unoffered (`previous` where exactly one of the menu and its parent
selects several cases, `previous` in a menu that opens on Search, `parentMenu`
with no parent), so the one rule covers the editor and the build. The SA only
sets `post_submit` when overriding the default.

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

Two native HQ limitations are target refusals in
`hqNestedSelection.ts`, called only by the export boundary for HQ JSON/upload.
A parent datum selecting several cases cannot feed HQ's scalar parent-index
join; local `session.ts` instead tests each non-extension index against the
selected-value set with Core-supported `selected(join(...), .)`. HQ also aligns
same-type collection datums without comparing their maxima, which can bypass a
smaller child limit. The local projection keeps that child datum distinct and
reports the incompatible HQ alignment to the export analyzer. Both shapes
remain admitted, and the local projection carries both in every `.ccz`. A
`.ccz` is made for a reached deployment alone, so an app that holds one of them
has that archive only for a project space it reached without the shape
(`lib/export/CLAUDE.md`). No registration-only or unused catalog relationship
is refused. Native nested-menu proofs execute both local workflows
and deliberately bypassed HQ counterexamples, separate from supported HQ parity.

The selected own-case id is not assumed to be `case_id`. It is threaded into
form display conditions, the form's case reads and Vellum metadata,
ordinary update/preload case blocks, and authored advanced case operations.
A session datum read in an expression stores what supplies its value
(`DatumRef`: a module's selected case, the case a form creates, a child case
it creates, the worker's record, or a tile group's parents), and prints the id
`formLinkProjection.ts::entryDatumIds` gives it, over the supplies
`lib/domain/entryDatumSupplies.ts` derives.
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
  is therefore Nova's to make true: `planFormLinkGuards` builds link i as the
  tree `c_i and not(c_1) … and not(c_{i-1})`. The serializer parenthesizes
  `c_i` wherever its precedence needs it, so a top-level `or` cannot fire two
  frames; the first link prints as the bare `c_i`, byte-identical to HQ's first
  frame. A TERMINAL unconditional link is
  the exhaustive else: guard `not(c_1) … and not(c_{n-1})`, no fallback frame.
  An absent condition is unconditional. The fallback frame
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
  re-mints form ids only when it creates an app from a body that holds forms
  (`util.py::update_form_unique_ids` rewrites `form_id` with them), and on
  every source read. Nova's create is an empty shell and its update writes ids
  verbatim, so every menu and form id is `lib/commcare/wireIdentity.ts`'s
  derivation or the target's recorded override (`ExpandOptions.identity`). A
  manual import of the HQ import file is a create that carries forms, so its
  form ids are HQ's and its menu ids and every `xmlns` are Nova's.
  `hqJsonOracle.ts::checkFormLinks` pins the shape and id resolution.
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
  (`min(1)`, each name a case the target entry selects, stored as that selection
  and printed as its current datum id) land on the target datums they name; a name the target
  never reads is `FORM_LINK_DATUM_UNUSED` (HQ's
  `_get_datums_matched_to_manual_values` iterates TARGET datums and drops it).
  Distinct stored selection refs can be aliases of one root-aligned target
  datum. `FORM_LINK_DATUM_TARGET_COLLISION` refuses two assignments to that
  target, even when their values agree, before HQ's name-keyed matcher could
  silently keep only the last. Semantic ref uniqueness remains a separate
  schema rule; no wire id is stored or exposed as an authoring choice.
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
  `previousEntryFrameChildren` exposes this same raw result before matching;
  its stable command and selection provenance feeds `previousTaskProjection.ts`
  for Preview, App Tests and authoring reads. That bridge publishes no wire
  names and never parses command or datum spelling to recover identity.
  `projectTaskFormSelections` reads the chosen form's actual entry datums
  for admission on its current menu. External entry-point frames may prepend
  structural parent selections that this entry never loads; those prerequisites
  remain specific to `projectEntryPoint`.
  `projectModuleTaskSelectionUuids` reads the same module-target frame for
  destination lifetime: a module command contributes no own leaf slot, while
  ancestor-owned selections remain explicit identities.
  Private incomplete-form reads may qualify an uncompiled entry as unavailable;
  runtime and export always use the strict projection.
- **Session scope.** Core evaluates link conditions and datum XPath after the
  XForm instance has closed, with a NULL main instance
  (`CommCareSession::getEvaluationContext`; `XPathPathExpr::evalRaw` throws on
  `/data/...`), so they may read the session and loaded case instances, never
  `#form/` or `/data/`, and a bare relative name has no context node at all.
  The link slots' profile owns those three refusals: the parser refuses a bare
  relative name there, and the checker refuses a read of the form's answers,
  so the builder's linter, the SA and MCP, and the commit gate say one sentence.
  The finding names the offending reference with the link's uuid.
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
  `FORM_LINK_DATUM_UNUSED`, `FORM_LINK_DATUM_TARGET_COLLISION`, plus
  `TARGET_NOT_FOUND` / `SELF_REFERENCE` /
  `CIRCULAR` (graph-backed, `lib/domain/formLinkGraph.ts`). Every finding
  carries `details.linkUuid` and names the destination. The projection runs
  only where every target resolves, every expression is session-scope, and
  every form the frame reads has buildable actions — each "no" is a finding
  another rule already owns, which is what keeps this rule total.

### Repeat modes

Three modes via `repeat_mode` discriminator, each emits different wire shape:

- **`user_controlled`** — bare `<repeat nodeset="...">`. Runtime adds/removes instances.
- **`count_bound`** — `jr:count` points directly at a bare integer question reference. A hidden-value reference or any other expression uses a sibling `nova_count_<repeatId>` hidden value with an `xsd:int` calculate. `xform/repeatCountNames.ts` reserves every count-bound repeat's potential name from structural declarations alone, in sibling order, so name binding never depends on parsing another expression. `domain/repeatCount.ts::planRepeatCountCarriers` lazily chooses physical carriers from the complete typed form: a direct question still gets a carrier when another expression references that count-result identity. Collision suffixes preserve authored siblings, and the generated-node plan shares the exact name reservation. Case and lookup reads always go through that own-form value. Core requires a location path and rereads it during entry: increasing the count creates rows, but decreasing it removes none. Retained rows, answers, and case operations are submitted. Blank counts create no rows; calculated numeric counts use Core's integer narrowing. Direct decimal and text question counts are refused; use an integer question or explicit numeric conversion. Nested calculated helpers live in the repeat's parent scope, so each parent row has its own count. No count setvalues or count snapshots remain. Admission rejects counts that depend on the rows they create, including through calculations or other repeats: Core accepts that feedback but can keep adding rows indefinitely during entry.
- **`query_bound`** — Vellum's model-iteration pattern. Data nests `<item>` below a container carrying `@ids`, `@count`, and calculated `@current_index`; the repeat targets that item path. Setvalues initialize ids at form load or parent-row insertion, then each row's index/id on insertion. A calculate bind derives `@count` from `../@ids`, so an initially excluded repeat can recover its cardinality when shown; this does not refresh the snapshotted membership query. Parent identity initialization precedes descendant setvalues, so a nested query sees the correct parent. The membership list is an initial snapshot.

Every repeat, the selected-cases repeat and a keyed create's one-row repeat included, sits in a `<group>` with no `ref`, the wrapper HQ's form builder writes; a `ref` there is an attribute the builder never reads and never writes.

Canonical field references carry identities rather than the synthetic `/item` segment. The shared form-node projection derives actual `FormPath` locations and supplies both executable XPath and Vellum editor shadows. This applies to binds, defaults, repeat queries/counts and prose outputs. Native `ContainerRuntimeTest` executes the admitted local and HQ-regenerated corpus, including distinct nested-query identities, nested counts, later-authored defaults, live growth, retained rows after decreases, and native count conversions.

### Sections are data groups that are always field-lists

A `section` field (one page of a form) emits exactly like a group — a DATA group, `<group ref="/data/<id>">` in the body over an instance node of its own — with `appearance="field-list"` ALWAYS, titled or not; a LABELLED group carries the attribute as Nova's default and a transparent (no-label) group never does (`xform/builder.ts::buildContainer`, the one gate). The fixture is Vellum's `tests/static/all_question_types.xml` field-list group, and HQ's `xform.py::_infer_vellum_type` reads that attribute back as `FieldList`. A section has no `relevant` by schema, so it emits no `<bind>`; an untitled one emits no `<label>` and registers no itext. The data-group shape is the only safe one: a ref-less control group binds to its parent (`XFormParser::getAbsRef`), Vellum corrupts it on save, and HQ's App Summary collapses it. The section-level rules (root only, sections only once sectioned, no add-entries repeat below — Core's `getQuestionPrompts` skips `EVENT_PROMPT_NEW_REPEAT` when collecting a field-list page) are the validator's, so the emitter stays total; `__tests__/xformDocArbitrary.ts::sectionRoot` pages roughly one fuzz form in four so every oracle meets the shape.

### XForm parse-time oracle + fuzzer

The shared external-wire corpora (`xformOracleCorpus.ts`, `suiteOracleCorpus.ts`) run through actual Core parsers in `XFormOracleRuntimeTest` and `SuiteOracleRuntimeTest`. They distinguish parser refusal, static cross-reference joins, and stricter Nova conventions. Empty XPath attributes must be checked, fixture data subtrees are not suite definitions, and output `ref` takes precedence over `value`. Suite instances are declared per loading scope; no casedb/session/search id is globally ambient. Detail title locale `cchq.case` is explicitly registered by `compiler.ts` in every emitted table, because Core has no built-in mapping. These are finite consumer proofs, not exhaustive compatibility.

`validator/xformOracle.ts::validateXForm` mirrors the FATAL contract JavaRosa enforces while parsing a form (`commcare-core .../xform/parse/XFormParser.java`). It is a regression oracle for emitted forms, not proof of totality or execution by JavaRosa. A failure requires investigating the fixture, oracle, and emitter before changing authoring admission. Co-developed with the fuzzer at `__tests__/xformOracle.fuzz.test.ts` (+ the `blueprintDocArbitrary` generator) — the fuzzer generates schema-valid `BlueprintDoc`s, emits, and asserts the oracle returns clean. A failing fuzz case is either (A) the oracle being too strict → fix the oracle, or (B) an emitter bug → fix `xform/builder.ts`; never a new reject rule.

Two XPath surfaces. The emitter needs no classifier: a PATH-only slot takes a path tree by type. The oracle classifies emitted text with its own Lezer reading. PATH-only surfaces (bind `nodeset`, control `ref`, `<setvalue ref>`) go through `xform/pathExpression.ts::isPathExpression`, mirroring `XPathReference.getPathExpr`'s `instanceof XPathPathExpr` check; ANY-expression surfaces (`relevant`/`constraint`/`calculate`, `<output value>`, `<setvalue value>`) go through `isParseableXPath`. The repeat-member-scope check (`verifyRepeatMemberBindings`) first applies Core's `collapseRepeatGroups` (a non-repeat `<group>` wrapping a single `<repeat>` collapses into the repeat) so the canonical Vellum wrapper-group shape isn't read as a skipped-repeat violation. Dependency-cycle detection is intentionally NOT ported — the doc-layer validator (`validateBlueprintDeep` via `TriggerDag`) owns cycles.

Every wire emitter constructs a `domhandler` tree through `elementBuilders.ts`. Its generated XPath slots take a `WireExpr` and an `InstanceSink`, never a string. `el` rejects executable attributes; `xel` prints the typed slot and records its actual reads. HQ JSON XPath fields hold an `HqXPath` containing the wire tree and its interpolation mode until `hqJson/xpath.ts::serializeHqApplication` serializes the complete document. Authored form expressions and form-link guards/manual datums lower from the shared `Expression` model before entering these slots. Generated scaffolding composes with those trees directly; no branded text bridge or raw expression arm exists.

`serializeXml.ts` is the sole encoder: raw text and attributes enter unchanged,
XML metacharacters are escaped once, and numeric references preserve CR in text
and tab/LF/CR in attributes. It refuses characters outside XML 1.0's repertoire.
`xmlParse.ts` uses SAXES for both well-formedness and DOM construction, including
namespace scope and XML character decoding. Never use an HTML parser or
serializer on these resources: their XML modes can still substitute C1
characters or normalize authored attribute whitespace incorrectly. DTDs and
XML 1.1 declarations are outside Nova's generated resource vocabulary.

`APP_TEXT_UNREPRESENTABLE` gates app names, module/form/field definitions,
case catalogs and translation values before every commit, including dormant
translations and typed expression literals. Purpose notes and preview-only
metadata are outside that wire inventory. External lookup rows are checked at
export with `LOOKUP_CELL_TEXT_UNREPRESENTABLE` before either carrier is built.
The native proof under `proof/native/` checks the actual HQ parser,
compiled form values and malformed counterexamples; `XmlTextRuntimeTest` also
initializes the exported forms in Core and checks the resulting answer and label.


Local CCZ compilation removes attributes in the Vellum namespace after case/meta lowering (`xform/deviceForm.ts`), matching HQ `strip_vellum_ns_attributes`. The source retains them for HQ editing. Core looks up bind/action attributes by local name, so an earlier editor shadow can otherwise be parsed as executable XPath. Namespace identity, including aliases and nested rebindings, determines removal. The native capture proof parses, enters, evaluates and serializes both export paths with actual CommCare Core; it covers concrete cases, not the whole dialect.

### Suite + HQ-JSON oracles (same test-oracle pattern)

The XForm and suite oracles refuse a declared instance no XPath of its scope reads (`XFORM_UNREAD_INSTANCE`, `SUITE_UNREAD_INSTANCE`), so the derived declarations are held exact from both sides.

The wire oracles encode selected platform parse/import contracts. The two seeded corpora (`xformOracle.fuzz.test.ts`, 500 field-tree samples; `suiteOracle.fuzz.test.ts`, 400 workflow samples) share `compilerEvidence.ts`. Each sample must pass the strict persisted schema and domain validation, then one expansion and archive feed HQ-JSON, XForm, suite, media, and binding checks. Suite entries join archived forms by their actual XML namespaces, never by array position. Media uses real PNG/WAV/MP4 bytes and SHA-256 content hashes; archive checks verify the full file set and exact bytes. Each corpus owns its census assertions within the same test and enables shrinking. These finite regression checks complement independent wire examples and do not execute CommCare.

- `validator/suiteOracle.ts::validateSuite` mirrors the device's `suite.xml` contract (`commcare-core .../suite/model/*` + `org/commcare/xml/*Parser`). Two layers: **Category 1** (fatal at `SuiteParser` parse — required attrs, enums, PATH-only `<datum nodeset>` / `<data>` per `SessionDatumParser`/`QueryDataParser`) and **Category 2** (parse-clean but session-runtime-fatal — the device does NO cross-reference validation, so the oracle owns menu→command, datum `detail-select`/`-confirm`→detail, `instance('id')` resolution with per-entry intersection, locale-id resolution against app_strings, command/detail/instance id uniqueness). Menu and command relevance both use Core's restricted context: expand commands from every menu whose own id matches the evaluated id, select the first resulting entry (falling back to a direct same-id entry only when that expansion is empty), then add declarations from all same-id menus. A command's containing menu contributes only when its own id matches the command id, and the broad runtime allowlist is not ambient. Nova's canonical producer placement remains simpler: module-condition dependencies live on the module menu, while form-condition dependencies live on the form's matching entry. Its own Lezer reader, private to `suiteOracle.ts`, extracts `instance()` refs. Wired into `compiler.ts` as a post-emit throw.
- `validator/hqJsonOracle.ts::validateHqJson` mirrors CommCare HQ's import contract (`Application.wrap`, a recursive jsonobject `DocumentSchema`). Import is FATAL only on enum (`choices=`) violations, type mismatches, `doc_type` dispatch failures, and custom property validators (none on Nova-emitted types) — the TS `HqApplication` type already guarantees the structural slots, so the oracle checks the emitter-derived enum/`doc_type`/finite-number slots that TS types only as `string`. It is a **regression guard** over those constants (their values come from shell factories / the `toHqWorkflow` table, not user input). A test-time oracle beside the XForm oracle — the compile/upload paths run the boundary gate; the oracles guard the emitters in CI.
- `validator/bindingResolutionOracle.ts::validateBindingResolution` mirrors JavaRosa's install-time XPath-resolution contract — the layer between parse-time validity (which `xformOracle` proves) and form-init runtime evaluation. Three rules: every `instance('commcaresession')/session/data/<X>` references a declared session datum on the form's entry; every `instance('commcaresession')/session/context/<X>` is in the closed CommCare-populated set (`SessionInstanceBuilder.addMetadata`); every `instance('<id>')` matches a `<model><instance id="...">` declaration. Form-path refs inside expression bodies are intentionally not checked here. Native Core initialization proves that a missing structural session leaf can throw `XPathTypeMismatchException` in scalar calculations, while an undeclared session instance throws `XPathMissingInstanceException`; missing paths have no universal harmless-empty guarantee. Dangling bind nodesets are caught upstream by `XFORM_DANGLING_BIND`. The oracle is a **test-time regression check**, never a user-facing emit gate — `compileCcz` does not call it. Both fuzz corpora invoke it per form through `__tests__/compilerEvidence.ts` after compilation; the user-visible authoring gate is the checker's admission (`CASE_HASHTAG_ON_CREATE_FORM`), which narrows typed case reads on registration forms to the created type's `case_id`, using the same reachable-type accept set as the builder (`caseTypes.ts::caseRefAcceptMap`). The first rule is also the checker's, for every admitted document: a stored session datum read holds what supplies it, text naming an id no supplier gives is refused at parse, and a stored read the entry stops supplying is `SESSION_DATUM_NOT_SUPPLIED`, over `lib/domain/entryDatumSupplies.ts` and `formLinkProjection.ts::entryDatumIds`, the projection the compiler writes each `<entry>` from. The oracle proves it over the fuzz corpora, which draw typed session reads.

The compiler navigation corpus in `__tests__/compilerNavigationFixture.ts` is
shared with the native proofs under `proof/native/`. Native HQ regenerates
its forms; Core verifies saved-value/default precedence, normalized ordinary
registration external IDs, owner availability, condition scopes and link frames.
Core's exact Search payloads then pass through HQ's CSQL compiler with expected
UTC/date bounds. This is native value and query-compilation evidence, not a
full device session or an Elasticsearch query result.

CSQL runtime operands and nested native-function arguments share
`csql/emitter.ts`'s runtime holes, each a `WireExpr`: suite lookup naming, Search input identity,
worker property names and the type context survive every nesting level. A table
value wrapped in `date`, `datetime`, `double` or date arithmetic still reads the
same declared fixture. The native function corpus consumes both exports in Core,
then compiles the resulting scalar queries with HQ and checks relation argument
ASTs separately, without claiming server relation-query results.

HQ's pinned eulxml lexer omits commas from `OPERATOR_FORCERS`. Native functions
in later argument positions therefore require grouping: `date-add(..., 'days',
(double(...)))`. The emitter writes that grouping as a `group` node of the
`CsqlNode` tree (`csql/emitter.ts::groupedValueFunction` for native
quantity/matcher values, and around relation/count filters), and `printCsql`
prints it. Never repair this by parsing or rewriting emitted text.

### Case-management scaffolding emission

`xform/caseBlocks.ts::addCaseBlocks` emits the local case scaffolding for HQ's basic `FormActions`. Sharing an action input does not itself establish parity: HQ accepts fields its basic builder does not consume. In particular, it ignores `OpenSubCaseAction.relationship`. `subcaseWire.ts::hqCaseActions` therefore marks extension actions `never` while `xform/caseOps.ts` carries their active transactions in the source XForm, under a `nova_subcases` group at the exact parent/repeat scope. The retained action positions and types are necessary navigation metadata: HQ allocates non-repeat subcase ID datums even for `never` actions and matches form links by those types. Source extension creates use those same IDs; repeated creates use `uuid()` calculations. HQ emits an inactive redundant block (`relevant="false()"`), which the local splicer omits. The native proof in `proof/native/` executes HQ's import, case builder, datum allocator, and navigation matcher; the six export regressions check mixed relationships, repeat scopes, required names, guarded property writes, and exact ID joins. Every `<case>` element carries the cx2 namespace (`http://commcarehq.org/case/transaction/v2`) — without it CommCare's submission processor treats the element as inert data, not a case transaction. The three `<case>` attributes (`case_id` / `date_modified` / `user_id`) wire to:
- **case-create**: `case_id` setvalues at `xforms-ready` from the per-entry session datum `case_id_new_<casetype>_0` (a `function="uuid()"` datum `session.ts::deriveSessionDatums` emits). `date_modified` / `user_id` calculate off the meta block at `/data/meta/timeEnd` / `/data/meta/userID` (the compiler injects the meta block on the same `.ccz` path, after the case block, so both resolve). Each question a basic action reads as a case name or an external id has one sibling Hidden Value, `nova_trimmed_<question>` (its calculate the `replace()` trim, its `relevant` `count(<question>) > 0`), and the action names that node: HQ's build binds the leaf to the path the action names, so the trim lives where both export paths read it and the local archive binds the leaf to that path with no trim of its own. `required="true()"` is stamped on the node a create's name action names, as HQ's build stamps it, where it is inert; what keeps a name required of the worker is `required="true()"` on the question's own bind, which replaces an authored required condition there as HQ's build always did. A visible source question's constraint gains the guard, conjoined with the authored validation: for a case name, not blank after the trim and at most 255 characters; for an external id, the length alone. A Hidden Value source takes neither. The guarded set is `lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`, which Preview reads too.
- **case-update**: `case_id` calculates from the projected own-case session datum (`case_id` for a flat form, potentially `case_id_<type>` for a child). Same meta-block bindings for the two timestamp attributes. Every per-property update bind also carries `relevant="count(<qPath>) > 0"`, `<qPath>` being the path the action names — the JavaRosa semantic when a field's `relevant` evaluates false is that the data node is absent, and an unguarded update would overwrite the existing case property with empty. The guard mirrors CCHQ's `XFormCaseBlock.add_case_updates`. Removing it silently destroys preserved case data on every conditionally-hidden field. `update_case.condition` is `always` on every registration, follow-up and close form, as HQ's Case Management save writes it, so a follow-up that writes nothing still carries its case block in a single-select menu and marks its case as updated; a form of a multi-select menu has no primary block under either value. The local archive writes `<update>` exactly when the update map holds an entry, and writes an update's properties and an attachment's children in name order by code unit, as `XFormCaseBlock.add_case_updates` does. An external id is one of those rows: `open_case.external_id` is `null` and the write is `update_case.update.external_id`.
- **case-preload**: capture writers are excluded because stored links and case attachments are not upload filenames for the new submission. Scalar writers emit one `<setvalue event="xforms-ready">` per `case_preload` entry, reading the loaded case's property from `casedb`, anchored by the same projected own-case session datum. HQ's private `name` and `owner_id` preload keys read `case_name` and `@owner_id` respectively. Mirrors `XForm.add_case_preloads`. Its setvalues add their `casedb` and `commcaresession` reads to the form's one instance set, as every printed attribute does, mirroring `add_case_preloads`'s `add_casedb()`. Preload is the structural source of a case-loading form's initial field values — the agent layer stamps no `default_value` for this (`lib/agent/contentProcessing.ts::applyDefaults`). Gotcha: the preload setvalue lands after the field's own `default_value` setvalue in document order, so the loaded case value wins at `xforms-ready`. This matches a CCHQ-uploaded app (CCHQ emits preload regardless of any authored default) — an explicit `default_value` on a case-loading form's case property does not change what the user sees.
- **subcases**: per-subcase session datum `case_id_new_<subcasetype>_<idx>` (index mirrors CCHQ's `Form.session_var_for_action` — starts at 1 when the form also opens a primary case). Repeat-context subcases use literal `uuid()` calculate instead (no session datum is emitted for them, matching CCHQ's `delay_case_id` branch). Owner-id binds to `/data/meta/userID` on every active subcase, including source-emitted extensions. For ordinary children, the basic module Nova uploads runs `autoset_owner_id_for_subcase` (`'owner_id' not in case_properties`, which is always true for Nova's subcases), so CCHQ's regenerated child form carries the same userID owner bind. (The unowned-`owner_id` sentinel is an advanced-module-only shape — `autoset_owner_id_for_advanced_action` — which Nova never emits; the `extension` relationship is carried solely on the `<index>`.) Each subcase's name action names the question's `nova_trimmed_` node, and its name question carries `required` and the guard as the primary case's does. A subcase **close-on-submit** branch exists (renders `<close>` + a `relevant` bind from the subcase's `close_condition`) but is dormant: no authoring surface sets an active subcase close today, so `buildFormActions` always emits a `never` condition there; the branch is exercised only by `__tests__/caseBlocks.test.ts`.

- **capture URL node**: a capture field's `caseWrite` carries `mode`, and `"url"` emits a SIBLING node (`xform/captureUrlNode.ts`) holding `if(<capture> = '', '', concat('<origin>/a/<domain>/api/form_attachment/v1/', /data/meta/instanceID, '/', <capture>))`. The case update names THAT node, never the capture. This indirection is not stylistic: `xform.py::CaseBlock.add_case_updates` routes an update into an `<attachment>` block whenever its question path is an `<upload ref>` in the body (`::is_attachment`), consulting no toggle, and a stock domain then drops the block silently (`update_strategy.py::_apply_attachments_action` returns immediately without `MM_CASE_PROPERTIES`). The origin + project space arrive as an already-resolved `AttachmentUrlTarget` from the caller (`lib/deployment/attachmentTarget.ts`), because the emission boundary is one-way; with none, the node, the bind, and the case update are all withheld rather than written against a guess, and the caller says so through `lib/publish/exportAdvisories.ts`.

- **capture relevance**: the URL sibling has `relevant="count(<capture>) > 0"`. Hiding a capture therefore removes its URL update from the submitted case transaction; an active blank capture still submits a blank property. A child-only followup retains the empty primary case block and its selected case ID so child indices can resolve their parent.

- **capture attachment block**: `caseWrite.mode === "attachment"` names the
  original upload node in FormActions, so both HQ regeneration and local CCZ
  emission create the same `<case><attachment>` transaction pinned to
  `update_attachment_case.xml`. This is the legacy case-file behavior, not a
  scalar property write: a project space without its corresponding capability
  silently drops the block, so `projectSpaceCompatibility.ts` derives and
  checks that semantic requirement before direct publish. Nova never exposes
  the downstream flag slug as an authoring setting.

### Authored case-operation emission

A write to an effective datetime property, by the operation's destination type
after retyping, is an untyped leaf whose calculate is
`xform/datetimeCaseValue.ts::datetimeCaseValueExpression` of the value:
`if(E = '', '', format-date(coalesce(E, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`. HQ's
form builder writes a row's bind with no `type`, and Core's
`Recalculate.wrapData` would wrap an untyped calculated Date as the day alone;
`coalesce` unpacks the Date and `format-date` leaves it unrounded, so the
instant is kept. Every `@date_modified` bind stays `xsd:dateTime`, the
builder's own spelling. A value that is already text is parsed and printed
again: a saved date and time copied to another property is written in the
device's zone with milliseconds, and lands a day off where the device's local
date for that instant differs from the date written; text that is no date
raises `XPathTypeMismatchException`. Both are accepted: wrapping only the
expressions Nova can prove yield a Date would need a second spelling a reader
must recognize. The case-operation native
corpus checks create and update timestamps plus an explicit offset instant on
both local CCZ and HQ-regenerated forms. Existing stored dates are not rewritten.

`xform/caseOps.ts` lowers typed `Form.caseOperations` into the authored XForm source, so HQ upload and local `.ccz` compilation consume the same cx2 blocks; it is not another `FormActions` post-process. Nova reserves no question names. Each generated node is named `nova_`, then its purpose and its owner's id, by `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`, which suffixes on a collision with an authored sibling; the containers are groups (`nova_operations`, `nova_condition_<operation>`), and guards are update-only Save to Case blocks. Each operation is a Vellum-recognizable `SaveToCase` wrapper carrying `vellum:case_type`. A leaf of a case block carries no `type` and no `constraint`. Singular operations live in the form root container, which is prepended before authored fields. Repeated operations are appended into the referenced repeat's exact iteration template after its authored children. Because CommCare Core executes case blocks in XML document order and a repeated effect cannot leave that template, the only representable cross-scope sequence is root followed by repeat scopes in post-order field traversal; `lib/doc/caseOperationOrder.ts` is the shared validator/planner proof of that constraint. On local compilation, the existing `FormActions` primary-case/subcase post-process appends its blocks after the authored field tree, so every advanced operation executes before Nova's ordinary primary-case action; the integration oracle pins that relationship explicitly. Where a form closes its case on a condition HQ's Case Management tab cannot state, the close is one of those earlier blocks. `lib/domain/closeCondition.ts::closeConditionPlacement` derives the placement and stores nothing: `form-action` when the field is a single select, a multi select, a Hidden Value or a label, sits in no repeat, the answer holds no `'` and neither starts nor ends with `"`, and a select with written choices holds the answer among them; `save-to-case` otherwise. For `save-to-case` in a single-select form, `close_case.condition` is `never` and the close is the block `nova_close` inside the group `nova_condition_close`, whose `relevant` is the condition. The rolling type proof includes those final implicit consumers: an ordinary primary write and every child-case parent index require the session case to retain the module type. A write-free close block needs only the case id and remains type-agnostic. The proof keeps every transition rather than only the latest nominal type, so a conditional restore cannot hide the branch where the case still has the prior transitioned type.

`xform/generatedNodes.ts::planGeneratedNodes(doc, formUuid)` names every node Nova adds to a form's source, by purpose and owner identity and never by path, and makes each form's plan once per document object (documents are replaced, never changed in place), so the XForm builder, `formActions.ts` and Preview share it. A base name is `nova_`, the purpose and the owner's id, or the container's fixed name; each parent element is one namespace, and the `nova_operations` groups of one authored scope (the form root, or one repeat), that is the scope's own group and the group in its selected-cases item, share one namespace with everything nested in them, so adding or removing a condition, or changing the menu's case selection, never renames a node; `nova_subcases` is its own namespace and holds no authored name; a base an authored sibling, a Connect block id or an earlier allocation holds takes `_<n>` for the smallest free `n` from 1. Nova refuses no authored name for being one of its own, because each is a name CommCare HQ's form builder takes for a question; the cost is that a generated node's HQ export column moves to the suffixed path when an author adds such a question. Two rules of the builder's parser shape the body. A parent's controls name its data children in the same relative order, and data-only children may sit anywhere between them: one control out of order makes the builder rebuild the parent with every data-only child last, which moves case blocks, and Core applies case blocks in document order. Each control sits inside its data parent's control. So the root `nova_operations` control is the first child of `<h:body>`, a repeat's follows its authored controls, each `nova_condition_` and `nova_keyed_` control sits inside its `nova_operations` control, no Save to Case block and no Hidden Value has a control, and setvalues are written in data-tree order. The groups carry no label, no appearance and no bind, and HQ's Web Apps client, Android and Core lay out no box and no screen for any of them (Vellum `parser.js::parseControlTree`, `parseControlElement`).

The Save to Case facts the emitter follows, each kept by two saves in the form builder (Vellum `saveToCase.js`): The plugin loads only under the `save_to_case` plan privilege, which publish asks the person to confirm. No block carries a bind on its own node. `relevant` on `<block>/case` is used only on a block that creates. An update-only block has at least one property row. No row carries `type` or `constraint`, and only `@date_modified` is typed. Children of `<case>` are written `create`, `update`, `close`, `index`, with the case namespace as the default namespace and no prefix. A create outside a repeat carries its id as an `xforms-ready` setvalue and one inside a repeat as a bind. Every `<index>` child carries `case_type` and `relationship`. So an update's or close's condition is its `nova_condition_` group's `relevant`, a guard's one row is `update/case_type`, and every app with a block is gated on that privilege (`surface/entries/questions.json`, gate `privilege/save_to_case`).

Inside `<case>`, child order is canonical and pinned against current Vellum/Core sources and fixtures: `<create>` (with `case_type`, `case_name`, `owner_id`), `<update>`, `<close>`, then `<index>`. Registration `external_id` is deliberately in `<update>`, never `<create>`, per CCHQ's exact `open_case_external_id.xml` fixture; child create and existing-case writes use the same scalar update leaf. Every non-create block carries a materially present update. When it has no authored update child, Nova emits an idempotent `case_type` assignment to the already-declared type: Core therefore takes the clean update-before-index missing-case path, and HQ classifies pure close/index blocks with an actual update sort key. An empty `<update/>` is sufficient for Core but NOT for this HQ ordering proof — HQ's parser treats it as absent when another action exists. Generated singular create ids alone use Vellum's `xforms-ready` setvalue. An `idFrom` answer is NOT emitted raw: the shared versioned contract derives `nova-case-v1:<UUIDv5(app,form,operation,type)>:<exact-key>`. The fixed namespace and JSON tuple serialization are pinned by TypeScript/XPath vectors; operation display-id renames and reorders do not affect it. A live calculate bind carries a keyed id, so the submitted id reflects the final answer. The form builder writes a create's id as a bind only inside a repeat, so a root create keyed by an answer sits in a one-row repeat no worker sees, `nova_keyed_<operation id>`, counted by `nova_count_nova_keyed_<operation id>` (`calculate="1"`), inside `nova_operations`; its guards stand outside the repeat. The source field must be scalar text/single-select/hidden-string; multi-select is an array in Nova but a space-token string on device and has no safe implicit key serialization. The calculation accepts 1–205 UTF-16 code units, performs no trim/case-fold/Unicode normalization, and returns blank outside that range so Core/HQ reject the whole transaction rather than exceed HQ's 255-character case-id column or merge every blank row. Repeated duplicate keys intentionally address the same case, as does a retry of the same app/form/operation/type/key; the app/form/operation/type namespace separates every other ordinary collision, including type edits and two operations sharing one field. The order gate rejects a later non-create that can target that merged case when both definitions share a repeated execution ancestor: Core executes `C1,U1,C2,U2`, while HQ groups the concrete id and create-sorts `C1,C2,U1,U2`. A provably distinct target and independent root sibling repeats remain legal. Those deterministic identities are type-stable: a known authored-create retype is rejected statically, and every data-dependent retype gets a retype guard that rejects a `nova-case-v1:` target. A guard is an update-only Save to Case block after its operation's block, `nova_guard_<operation id>_type`, `_retype` or `_text`, at most one of each kind. It writes `update/case_type` to the type the case then holds, and its `@case_id` is `if(OK, ID, '')`: a blank id refuses the whole submission on Core and on HQ. Because HQ sorts one case's create blocks before non-create blocks, a deterministic-key create must still precede all non-create operations whose runtime target could be that existing case; the shared order checker rejects the unsafe inverse. Targets otherwise come from earlier-create identity, the loaded session case, or a typed expression. One block reads another's id and leaves through `current()`, at the form root as in a repeat row (`xform/formPath.ts::originalContextWirePath`), never by an absolute path: the form builder reads an absolute path into a case block as an unknown question. It does not follow a `current()` path, so a person who renames an operation's block in the form builder leaves these reads naming the old block; a Nova publish replaces the form. An `id-of` nested anywhere in a runtime target/link expression is rejected: only the first-class `op` target can address a fresh create without incorrectly filtering it through the pre-submission casedb. Owner expressions use explicit Nova vocabulary: `acting-user` emits `/data/meta/userID`, `unowned` emits the fixed `-` sentinel, and a create with no owner expression defaults to the acting user. An authored operation's fixed-text scalar calculates pass through JavaRosa `replace(..., '^[\x00-\x20]+|[\x00-\x20]+$', '')`, matching Java `String.trim()` while preserving internal text; a basic action's name and external id, and a source-lowered block's, read the question's `nova_trimmed_` node instead. No leaf of a case block carries a `constraint`: a runtime evaluates one only for a question being answered. An authored operation's values are capped by its `nova_guard_<operation id>_text` block, a calculate, at 255 Java/JS UTF-16 code units; names and explicit owners must also remain nonblank, while `external_id` may be the real empty string. Failure rolls the whole submission back. This pins the shared `caseScalarText.ts` contract for wire, Preview, and storage. Every operation-carried case type uses Core's identifier grammar and 255-character cap; every link identifier is XML-safe and at most the HQ index column's 255 characters.

Location owners add two exact leaves to that vocabulary. `fixed-location` lowers its app-scoped place UUID as a literal. `owner-location-at-level` lowers to `instance('locations')/locations/location[@type = '<destination-level-code>'][@<nearest-case-owning-ancestor-code>_id = <owner-case-expression>]/@id` and reads both `locations` and `casedb`; it is never guarded for empty rows (`xpath/wire/CLAUDE.md`, "Reads of rows that may be empty"), so a worker assigned nowhere is refused at the read. Either leaf must occupy the complete owner expression; the validator refuses name, rename, and nested carriers and proves the destination level owns cases before this boundary can print it. The export boundary rejects `fixed-location` for `.ccz`, HQ JSON, and HQ upload because its Nova UUID is not translated to the target domain's location identity. Reverse hops carry level codes and the case's runtime owner identity, so they export. Every app carries `location_fixture_restore: project_default`, and for an app that reads places publish asks the person to confirm that the project space sends its flat location list; HQ produces the per-worker fixture from its own location rows. Target level codes, privileges and unambiguous destinations remain deployment preconditions owned by `lib/deployment`.

Location compatibility evidence uses the real HQ `FlatLocationSerializer.get_xml_nodes`, including its native index schema and lineage attributes, and Core's actual restore parser, indexed fixture storage, form initialization and case submission. The native proofs are `proof/native/test_location_emission.py` and `proof/native/core/LocationOwnerRuntimeTest.java`. The same schema- and validator-admitted app corpus drives local CCZ and HQ-regenerated forms. Native cases cover immediate and multi-rung hops, branch identity and an omitted intermediate place. The Postgres companion uses organization service writes and verifies exact owner destinations and atomic refusal of ambiguity. HQ's own location models hold the places in the check's database; worker session data is supplied explicitly; these checks do not claim to execute HQ's footprint SQL or a remote restore. Nova emits no copy of this per-worker fixture. Its XForm declaration comes from the instance set its printed tree reads, and the fixture never belongs in the app's suite. Form logic and a form link's condition and datum values read the same flat list, `instance('locations')/locations/location[…]`, by level and location-property UUID (a place's own attributes, its level, a lineage attribute or a property). A `locations` read in an app with no organization levels is `LOCATIONS_READ_NEEDS_ORGANIZATION` (`validator/rules/locationsRead.ts`), and the plan feature and the flat-list confirmation follow from the declared instance (`locations/readsLocationsFixture.ts`).

A form can save an answer into the worker's own record, and the emission is gated exactly as HQ gates it. `deriveCaseWriteInventory`'s `usercase` bucket populates `usercase_update` (`usercase_preload` stays empty — `#user/<prop>` already compiles to the identical `casedb` join), which makes `util.py::actions_use_usercase` true, which is what turns on the `commcare_usercase` block in the XForm, the computed `usercase_id` datum, and the `<assertions>` entry child. HQ's `_add_usercase` has NO `<create>` arm, so neither does Nova. The datum rides `module_form` only (`EntriesHelper.get_extra_case_id_datums`), so Nova's case-list-only browse entry carries neither datum nor assertion. `<assertions>` sits between `<session>` and `<stack>`, pinned by the whole-suite `case-list-form-suite-usercase.xml`, and its locale id needs a matching app_strings entry or the suite dies at `NoLocalizedTextException` — Nova supplies its own message there rather than HQ's, because HQ's names a supervisor and an id an author never sees.

Every expression sees one pre-submission snapshot. Form answers and earlier create ids bind explicitly; repeat-local identity paths start at `current()` so they remain anchored on the operation bind even while a nested relation predicate temporarily evaluates a `casedb` candidate. Root case-property reads anchor on the projected own-case session datum in `casedb`, including root relation predicates and counts, while related-case candidate properties remain candidate-relative. Those case-reading expression paths add `commcaresession` with `casedb`. A runtime expression target is lowered through `casedb/case[@case_id = <target> and @case_type = '<snapshot type>']/@case_id`, never emitted as an unchecked id. The shared order analysis keeps that immutable lookup type separate from the rolling semantic type, so A→B retype followed by a B operation on the exact same target still finds the pre-submission A row. Different ASTs can nevertheless resolve to one concrete id; the static gate therefore rejects a later differently-typed target/link after a potentially aliasing transition unless the ids are provably distinct. Repeated retype is restricted to an exact correlated generated create because duplicate repeat values otherwise make the second iteration consume the first iteration's result type. The authoritative submission envelope (`lib/case-store/postgres/submissionEnvelope.ts`) repeats this proof over expanded, server-resolved ids with `validateResolvedCaseOperationTypeSequence`. Dynamic link targets get the same selector plus the type guard, `nova_guard_<operation id>_type`, whose id is the operation case only when the typed link selector resolved to a different id. On absent/wrong type/self-link the blank guard id raises the clean transaction error before an empty index value could be mistaken for an unlink; on success the guard no-ops the case the operation already touches, never the linked case. Server-side preview separately reauthorizes Project/type facts; neither path trusts a client type descriptor.

The operation export corpus starts from strictly admitted documents and emits actual HQ source and CCZ forms. `proof/native/core/CaseOperationRuntimeTest.java` opens both those CCZ forms and the native HQ-regenerated counterparts, evaluates them over native case instances, and applies finalized submissions through `CaseXmlParser`. Stored-record assertions cover ordering, pre-submission reads, conditional dependencies, repeat correlation, authored-key merges, scalar bounds, dynamic-link refusal and nested-menu child selection. The sequence form's recorded-clock matrix preserves typed `now()` capture and formats both the direct clock and a coalesced typed answer as text, then reads unchanged plain and Markdown prompts across writer and reader zones. Only `now()` is controlled through Core's supported function-handler seam; `java.time` supplies independent expected calendars and offsets. This proves capture-as-recorded display, not viewer-local conversion of stored datetime strings. These examples run against Core's indexed in-memory storage; they do not prove rollback or HQ server case processing. They run in the proof lane; `proof/README.md` ("Native proofs") describes them.

A condition has two spellings, by what HQ's form builder keeps. A conditional create carries it as `relevant` on `<block>/case`, the builder's Open Case Condition. A conditional update or close sits inside the group `nova_condition_<operation id>`, whose bind carries `relevant`, because the builder writes no bind for a block's own node. Every guard of a conditional operation, a create's included, sits inside that group: a guard that ran while its create did not would update a case that does not exist. Write conditions stay child relevance. A consumer of an earlier conditional create automatically inherits that create's relevance (transitively): if the producer does not execute, no target/link/value may leak its preallocated UUID into an update-only block or dangling index. Conditional retypes participate in the same shared guard analysis: a later operation/link that requires the destination type inherits the transition condition, while a source-type consumer after the transition is rejected. The preview's operation-program fold (`lib/preview/engine/caseDataBindingHelpers.ts`) must use `caseOperationConditionalGuardUuids`, not treat an allocated id or declared retype as proof that the producer effect ran. The validator dry-runs these same emitters after type checking so a schema-valid but nonportable expression cannot reach compilation.

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

### Dates and times compare as moments on a device

A comparison of two dates and times (`<`, `<=`, `>`, `>=`, `between`, and `=`,
`!=`, `in` or `switch` between two date-and-time operands) is lowered inline,
per operand, to zone-free integer microseconds
(`xpath/wire/instant.ts::instantMicros`) wherever a device evaluates it: XForm
binds, setvalues, outputs, itemset filters and repeat counts; suite datum
filters, details, display conditions and search prompts; form-link conditions
and datums; case operation conditions; and the runtime segments of
`_xpath_query`. `toWire` lowers in every target, with no target switch, because
every target it prints is evaluated by Core. Which comparisons lower, and each
operand's class, come from `lib/domain/expression/instantOperand.ts`, the
classification the checker refuses by. Each operand's instant text follows what
Core holds, branch by branch inside `if`, `coalesce` and `switch`:
date-and-time text as itself; a typed instant as
`format-date(coalesce(x, ''), '%Y-%m-%dT%H:%M:%S.%3%Z')`, so Core's
`format-date` does not round it; a coerced date as its UTC midnight
(`concat(…, 'T00:00:00Z')`, under a blank guard inside `coalesce` so a blank
still falls through); coerced text as itself, or its UTC midnight when it is a
date; a coerced day number as `x * 86400000000` with no parse; and a literal
folded to its integer at emission (a literal inside a branch, or a
`datetime-coerce` of one printed as a value, prints as
`instantOperand.ts::literalInstantText`: its own date and clock with seconds
and a fraction, then `Z` or its own offset as `±HH:MM`, since one parse reads
whichever branch is chosen; a form string literal branch is typed by its
comparison as a direct one is). Keeping the literal's own date spells every
literal with its own four-digit year, so `9999-12-31T23:59:59-05:00`, whose
UTC moment is in the year 10000, prints and reads back exactly, and Core's
own parse reads the same date (`DateUtils.parseTimeAndStore` applies an
offset to the clock only). An offset's hours and minutes are any two digits,
which Core adds to the clock as integers (`+24:00`, `+05:75`); a literal
without a four-digit year, a day that doesn't exist or a clock past 23:59:59
names no moment, and the checker refuses it.
`now()` is not hoisted, because a generated node would read the clock at
another moment. A value of unknown type compared with a moment takes the row
of what it holds, text or a typed date, under an equality as under an
ordering; two values of unknown type are compared as written. An equality
whose other side is neither a date and time nor of unknown type, such as the
blank test `x = ''`, stays bare; two blanks are no longer equal, because a
blank names no moment. Each side is built once and shared across the
comparisons of an `in`, `between` or `switch`, and the parse shares its own
sub-terms, so the memoised print stays linear.

`datetime-coerce` of a moment never emits `date()` on a device, because Core's
`date()` of a typed `Date` rounds it to the device's day; only a comparison by
day prints it, as `date(x)`. As a
value (a case write, a calculated column, a `format-date` operand) it prints
the moment as text: a date as its UTC midnight `…T00:00:00.000Z` under a blank
guard, text as itself, a typed instant as `instant.ts::typedInstantValue`
(the same spelling `xform/datetimeCaseValue.ts::datetimeCaseValueExpression`
writes), a day number as its UTC midnight. A value with no moment to print, a
`casedb` system date, a clock-lost value or a value that names no moment
(blank, a yes/no), keeps Core's `date()`, a day, the bytes it had before; a
literal that names no moment is refused there by the checker
(`unreadable-datetime`), in every slot whose expressions reach `toWire`.
`date-coerce` is unchanged,
`date(x)`. On a device `date_opened` and `last_modified` from `casedb` are
days (`CaseChildElement` holds them as `DateData`): ordered against a
day-aligned operand, or against each other, they compare by day with
unchanged bytes (`date_opened >= date('2026-01-01')`), and the checker refuses
them ordered against any other date and time, or under `=` / `!=` against any
date and time, day-aligned included. A value whose clock may be lost has no
instant text either and is refused the same way (`clock-lost`). The emitter
throws an invariant on any leaf the checker refuses rather than print a
comparison that answers wrongly. In a server search condition the checker
holds the same rules over exactly the values a device works out before the
search runs, the runtime segments, by the walk the CSQL emitter picks them by
(`lib/domain/expression/searchRuntimeValues.ts`). `instantAgreement.test.ts`
holds the checker and the print together over every leaf class, literal
branches, a `datetime-coerce` printed as a value, extreme years and a Search
field's runtime value. `InstantOrderingRuntimeTest` holds the
lowering in every zone of the `expression` native family, and
`lib/preview/xpath/__tests__/instantLowering.test.ts` holds Preview's
evaluation of the same text per zone.

### Repeat-context subcase splice + nest decision

A field whose `caseWrite.caseType` names an exact direct child of the module case type authors a CHILD case; when the field sits inside a repeat, the child case is created per iteration. `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory` is the sole field walk and buckets these by `(caseType, nearest repeat UUID)` — never a mutable field id or rendered path — so two cousin repeats that legally share an id (`children > section_a > kids` + `children > section_b > kids`) emit two independent `OpenSubCaseAction`s. Its Nova-only writer records carry the source field UUID, explicit destination pair, ordered UUID/current-id path segments, query-bound iteration facts, and nearest repeat UUID/path.

`caseWriteAdmission.ts::assertAndProjectCaseWriteInventory` is the only semantic-plus-structural bridge into private CommCare path vocabulary. It admits the canonical inventory, then projects every writer path and present repeat path exactly once through `FormPath`, returning writer-to-bucket identity with the projected paths. `INVALID_FIELD_ID` remains the sole authoring finding for an XML-illegal segment; a validation-bypassing lowering call fails at that shared projection rather than inventing a second public error. `deriveCaseConfig` consumes the projected inventory and performs no field walk, path resolution, or bucket classification of its own.

`xform/caseBlocks.ts::addCaseBlocks` mirrors CCHQ's `_create_casexml` splice: pre-count subcases per `repeat_context` to pick `nest = (count > 1)`. `nest = false` (single subcase under the repeat) splices `<case>` directly into the repeat's template subtree, bind nodesets anchor at `/data/<X>/case/...` (`subcase-repeat.xml` shape). `nest = true` (multiple subcases sharing a repeat OR every non-repeat-context subcase) wraps in `<subcase_N>`, binds at `/data/<X>/subcase_N/case/...` (`multiple_subcase_repeat.xml` shape). Splice target resolution walks the parsed DOM by `repeat_context`'s FormPath segments — `data → X → item` for `query_bound` falls out naturally because Vellum's `getPathName` rewrites the iteration path to include `/item`. The local data node reads as HQ's build writes it (`xform.py::XForm._create_casexml`): the fields, each `subcase_<n>`, the form's own `case`, `commcare_usercase`, `meta`. The form's own block is pushed after the subcase loop. A single repeat subcase's `<case>` is the first child of the repeat item (`CaseBlockChild.position: "first"`, through `xform/domSplice.ts::prependChildren`), also where the item holds Save to Case blocks; a nested `subcase_<n>` wrapper is appended.

Adding a second cross-case-type field to a single-subcase-in-repeat form FLIPS the wire shape (`<case>` → `<subcase_0>`/`<subcase_1>`). Old case_ids persist (the bind calculate is the same `uuid()`); old submissions are unaffected.

### Typed FormPath

`xform/formPath.ts::FormPath` is the typed value every wire emitter constructs form paths through. Element + attribute steps only; attribute steps are terminal; element-step names pass `XML_ELEMENT_NAME_REGEX` at construction. `toXPath()` prints a PATH REFERENCE (bind `nodeset`, control `ref`, `<setvalue ref>`, splice walk steps). An EXPRESSION body (`calculate` / `relevant` / `constraint`) is a wire tree whose `form` root `serializeWire` prints, and no emitter parses XPath text. The legacy answer-path admission (`validateXFormPath`) delegates to this same parser and additionally requires a non-root element; there is no separate permissive path regex. The element-name vocabulary is Nova's ASCII subset, not the full XML Name grammar.

### Form `<meta>` block — build-time injection

The OpenRosa `<meta>` block (`<deviceID>`/`<timeStart>`/`<timeEnd>`/`<username>`/`<userID>`/`<instanceID>`/`<appVersion>`/`<drift>`, eight populating setvalues, two `<bind type="xsd:dateTime">` timestamp binds) is a CCHQ render-time artifact, NOT part of a form's source — exactly like the case transaction blocks. CCHQ injects it for every form via `xform.py::add_case_and_meta` → `_add_meta_2` (stripping any pre-existing meta first), so a Vellum-edited source never carries it. `buildXForm` therefore omits it: the HQ-upload source has no meta block and CCHQ regenerates it on render. Only the local `.ccz` path — which has no CCHQ render step — injects it, via `xform/metaBlock.ts::addMetaBlock`, which `compiler.ts` calls right after `addCaseBlocks` (case-then-meta order). The split is load-bearing: a meta block in the uploaded source can't be opened in CCHQ's form builder (Vellum parses every `<data>` child as a question and rejects `<meta>`/`<orx:meta>` — "'meta' is not a valid Question ID").

`addCaseBlocks` and `addMetaBlock` share `xform/domSplice.ts` so the two render-time injections stay in lockstep: one splice-into-`<data>`/`<model>` path, one instance set their printed reads join, one `serializeXml` escaping authority.

For a Connect app the local block also captures location, as HQ's build does (`metaBlock.ts::addMetaBlock(xform, { captureLocation })`, with `captureLocation` the condition `expandDoc` uses for HQ's `auto_gps_capture`): `<cc:location/>` is the last child of `<orx:meta>`, after `<orx:drift/>`, and the model's last two children are `<orx:pollsensor event="xforms-ready" ref="/data/meta/location"/>` and `<bind nodeset="/data/meta/location" type="geopoint"/>`. A model holds one `pollsensor` or none, as `xform.py::XForm._add_meta_2` writes it.

### Form reads

`xpath/wire/formReads.ts` projects the form's finite node identities into wire paths using the actual slot's `ExpressionContext` and the form-node projection. `toWire` projects typed case reads from the same context. References are **per-case-type**: `#<case_type>/<prop>` names the form's own module case type or an ancestor up the parent-index chain (never a child type — a form loads one case and can only reach up the index at runtime). The resolver looks the case type up in the form's reachable-type depths (`lib/domain/caseTypes.ts::reachableCaseTypes`: own = 0, parent = 1, …) and sends that depth through the single casedb walk, which `toWire` builds inside an `expansion` node. Only the emitter generates HQ's private `#case/`, `#case/parent/`, or `#case/grandparent/` editor and metadata spelling, and only from a typed read.

Registration narrowing: the form's own new case isn't in `casedb` at form-init, so only its allocated `case_id` (own type, depth 0) resolves — `#<own>/case_id` reads `instance('commcaresession')/session/data/case_id_new_<own type>_0` (`session.ts::newCaseIdDatumId`), the datum HQ's suite and the local suite both give a registration form and the one HQ's build sets the create block's id from; the form declares `commcaresession` whenever the read is emitted. `/data/case/@case_id` names a block the stored source does not hold, which HQ's form builder reports on every save. The checker refuses other own/ancestor reads first, one finding per read (`CASE_HASHTAG_ON_CREATE_FORM`), gated by the form's reachable-type accept set (`caseTypes.ts::caseRefAcceptMap`, the single home of the form-type narrowing, also read by the editor's linter and completion). Every bind, setvalue and output builds its tree through `toWire` with the form's build context, so each respects the form's context.

A default value that reads another question prints it as `current()/<relative steps>` with no `vellum:value` (`formReads.ts`, the `default_value` slot): the form builder refuses a `#form/` hashtag in a default and turns an absolute path into one on load. It does not follow a `current()` path, so renaming the question in the form builder leaves the read as it was.

### CommCare Connect

A Connect block's wrapper is named by the block's id, which follows the
question-id grammar and is never one of the five names Connect's receiver
searches a submission for at every depth (`assessment`, `deliver`, `module`,
`task`, `work_area_update`, `lib/domain/questionId.ts::RESERVED_CONNECT_BLOCK_IDS`):
a wrapper so named has no namespace where the receiver reads one, so Connect
answers 500 for every submission of the form. A deliver form holds a deliver
unit or a task, never both (`CONNECT_DELIVER_FORM_HOLDS_TASK`): Connect checks
the delivery before it completes a task, so a form holding both has its own
visit turned away while the task is assigned. A Connect app's forms reach
Connect only through CommCare HQ's data forwarding, which needs the Data
Forwarding plan feature and a forwarder set up in the project space. No API key
reads either, so publish asks the person to confirm both (`lib/deployment`).

### Case-list emission

Both detail surfaces (`<detail id="m{n}_case_short">` / `m{n}_case_long`) share one per-kind column emitter via a `DetailKind` discriminator — five precise branch sites cover the long-detail-only `template_form="phone"`, the short-detail-only sort wrap, the long-detail no-sort short-circuit, and the locale-id substring choice. Don't fork the emitters per surface.

**A list's fields and order are one derived plan.** `lib/domain/caseListOrder.ts::caseListOrderPlan` states what HQ's build writes for the app Nova sends: the short detail's fields in stored order, each field's wire class (property or expression) and join text (its HQ `field`), the sort key each field keeps with no rule, each rule's element, and the carriers HQ appends for a rule no field's text equals. Its three readers are `hqJson/caseList.ts` (the stored columns and `sort_elements`), `suite/case-list/` (`shortDetail.ts` walks the plan's fields; `sortKeys.ts::planSortNodes` writes each field's `<sort>`, and a carrier as an appended width 0 field), and Preview through the case store. Every reader builds it through `suite/case-list/orderPlanOptions.ts::caseListOrderOptions`, so none can pass different options; the validator and Preview pass `mediaOn: true` and no lookup naming (join texts print under `lookup/naming.ts::identityLookupWireNaming`). A difference proof 3 reports between HQ's build and the local suite is a wrong rule in the plan or a wrong spelling in an emitter, never a register entry.

A column over an attribute-backed property (`lib/domain/standardCaseProperties.ts::ATTRIBUTE_BACKED_COLUMN_PROPERTIES`: `case_id`, `owner_id`, `status`) is an expression column on HQ's paths, shown or hidden: `field: "@<name>"` with `useXpathExpression: true`, because HQ reads a property column's `field` as a property name, which takes no `@`, and has no property element for `case_id`. Only a sort row with no stored column (a carrier) names `owner_id` or `status` bare; HQ's appended field reads the attribute. An image-map field written as images (`lib/domain/modules.ts::imageMapShowsImages`) writes `width="13%"` on its header and template on both details, as HQ's `EnumImage` does. HQ writes a date column's pattern unescaped between straight apostrophes, so a pattern holding `'` builds a suite Core refuses; the gate refuses it (`CASE_LIST_DATE_PATTERN_APOSTROPHE`).

Every short detail of the local suite, the search target's included, carries `<select_text>` (`m<N>_select_text=Continue`), written after the fields and the action; every form has `forms.m<N>f<M>.submit_label=Submit` in every language; every image-map field carries `<alt_text>` as its last child, built as HQ's `EnumImage.alt_text` builds it. `<no_items_text>` (`List is empty.`) is written exactly where HQ's build writes it, which is where the target's flag is on: every publish reads that flag, stores it as `app_deployments.target_empty_case_list_text`, and a `.ccz` made for that deployment reads it. The texts are one constant each (`suite/case-list/detailTexts.ts::SELECT_TEXT`, `EMPTY_CASE_LIST_TEXT`, `suite/formStrings.ts::FORM_SUBMIT_LABEL`). The HQ JSON holds the empty-list text on every menu's short detail, a menu with no case list included, under every app language's wire code (`expander.ts::expandDoc`): HQ's model default holds `en` alone, and its module settings save writes the page's language into the short detail of every menu, which reads blank in an app with no English.

Every search's `search_config` holds `title_label` and `description` under every app language's wire code, blank where nothing is authored (`hqShells.ts::caseSearchConfigShell`), because HQ's Case List save writes both for the page's language on every menu (`views/modules.py::_gather_and_update_search_properties`); the oracle refuses a map missing a language (`HQJSON_BAD_SEARCH_LABEL`). Locally every search's `<query>` writes `<description>` after its `<title>` (`suite/case-search/searchSession.ts::buildSearchQuery`), whose `case_search.m<N>.description` is a blank string where no subtitle is authored, written as a non-breaking space as HQ's locale writer writes it.

### Case-tile emission

`suite/case-list/tileStyle.ts` is the ONLY place the package emits CommCare's grid vocabulary, and `<style>` + `<grid>` is one indivisible wire unit, not an element with an optional child: `commcare-core .../xml/DetailFieldParser.java::parseStyle` runs `GridParser` unconditionally after `StyleParser`, `GridParser::parse` opens with `checkNode("grid")`, and all four coordinates go through UNGUARDED `Integer.parseInt`. So a `<style>` with no `<grid>` is an install-time `InvalidStructureException` and a `<grid>` missing one attribute is a raw `NumberFormatException` outside the parser's structured-error path. CCHQ can emit both (its custom branch guards on `any(... is not None ...)`, not `all(...)`); Nova can't, because `TileCell` carries the four as required slots of one object. The corollary reaches authoring: the five presentation attributes are reachable only for a placed cell, so no surface may offer alignment / size / border / shading on an unplaced column.

**Whether a column holds a square is `lib/domain/modules.ts::tileCellFor`'s decision and nobody else's.** All FOUR consumers call it — `suite/case-list/columns.ts::tileStyleChildren`, `hqJson/caseList.ts::applyTileLayoutToShortDetail`, `lib/preview/caseTileRendering.ts::tileResultsColumns`, and the SA read surface `lib/agent/summarizeBlueprint.ts::tilePlace`.

Every surface that decides this independently diverges. An HQ JSON writer (the PRIMARY delivery path) without the visibility check draws a different tile from the local `.ccz`. A read surface that reports a placement the wire refuses, or reports one in the Details block, which is never a tile, is not cosmetic: the SA reasons about overlap from that text, so a phantom cell makes the model route around an obstacle that is not on the grid and then refuse its own next layout for a collision that cannot happen. A new delivery path, renderer, or read surface calls this predicate rather than re-deriving the rule. `__tests__/tileEmissionParity.test.ts` asserts the three emission paths against one document; `lib/agent/tools/case-list-config/__tests__/caseListReadProjection.test.ts` covers the read surface.

Its two conditions: the case list has a `tile` layout, and the column is shown in Results. Cells persist while the layout is off (switching tiles off keeps the drawing) and emit nothing until it is on. Which detail SURFACE is a separate axis that stays with the emitter — the detail must be SHORT, and the case-detail screen stays a plain field list even though CCHQ allows `custom` there. `case_tile_template` is written only on the HQ-JSON short detail, and `Module.search_detail`'s deepcopy is what carries the tile to search results — never a second projection.

In a tile list a column hidden from Results is no field of the short detail: a stored hidden column would be given a cell by HQ's Case List save and a `<style>` by the build after it. Its order rule rides as a sort-only property carrier, a sort row on the property with no stored column, unless a placed column's join text is that property, which then takes the rule. HQ appends the carrier as a width 0 field with its `<sort>` and no `<style>` (`util.py::create_temp_sort_column`); `owner_id` and `status` ride under their bare names. A hidden calculated column, or a hidden column over `case_id`, with an order rule has no spelling HQ's editors keep and is refused (`CASE_TILE_HIDDEN_CALCULATED_SORT`). The carrier draws nothing on any runtime: Android lays out the placed cells alone, and the Web Apps client keeps the carrier's cell out of the layout. Width 0 is CCHQ's own reserved hidden-field spelling: `commcare-core .../suite/model/Style.java::Style(DetailField)` comments "'0' is reserved for hidden (Search) fields", both cloudcare tile templates branch on `styles[index].widthHint === 0` into a `d-none` wrapper, `views.js::buildCellLayout` writes no rule for a null tile entry, and `formplayer-common/grid.scss::.box` adds no box size. So a tile keeps the hide-but-sort affordance a row layout has. A tile list's search matches a hidden column only through that carrier.

Nova's authoring words for vertical alignment (`top`/`middle`/`bottom`) map to `start`/`center`/`end` at emission through `TILE_VERTICAL_ALIGN_WIRE`, because `cloudcare .../menus/views.js::getValidFieldAlignment` silently rewrites anything outside `constants.js::ALLOWED_FIELD_ALIGNMENTS` to `start` — CCHQ's own `icon_text_grid` template emits a `vert-align` its renderer ignores. Both emitters write alignment and size on every cell: `horizontal_align`, `vertical_align` and `font_size` in the HQ JSON, and `horz-align`, `vert-align` and `font-size` on `<style>`. The document requires the three (`tileCell()` fills `left`, `top` and `medium`), because HQ's Case List save writes all three into a cell that holds none, so a cell without them changes on the first save. `showBorder` and `showShading` stay optional and stay off the wire when unset.

`css-id` is the sixth attribute `StyleParser` reads. Nova doesn't emit it — Formplayer serializes `Tile.cssId` and cloudcare consumes it nowhere, so an authoring surface for it would be an affordance with no effect.

### Grouped-tile emission

`caseListConfig.tile.grouping` emits `<group function="string(./index/<id>)" header-rows="N"/>` as the LAST child of the short `<detail>` (`suite/case-list/tileGroup.ts`, appended by `shortDetail.ts::buildDetailShell`), plus a companion `<datum id="<caseDatumId>_parent_ids">` on every FORM entry that loads a case (`session.ts::deriveSessionDatums`). HQ JSON writes the same thing as `case_tile_group: { doc_type: "CaseTileGroupConfig", index_identifier, header_rows }` on the short detail only, and omits the key entirely when grouping is off — safe because `Detail.wrap` default-constructs a `CaseTileGroupConfig()` whose `index_identifier` is `None`, and because `_merge_source_into_app` replaces `modules` wholesale so a republish leaves no stale value.
Computed-datum functions declare, on the owning entry, every instance their wire tree reads. `deriveEntryDefinition` and `deriveCaseListEntryDefinition` collect those sets alongside explicit datum metadata. Core's session evaluator imports the entry's declarations; `commcaresession` and `casedb` are not ambient. The grouped parent-id companion therefore declares both before selection completion evaluates it. Native `TileGroupingRuntimeTest` retains the old missing-declaration failure and executes all three grouped form variants through actual parent selection.


`__tests__/tileEmissionParity.test.ts` uses strict admissible documents and
checks the actual archive, HQ JSON and programmatic preview projection. The
native proof under `proof/native/` imports those same documents and runs
HQ's real `DetailContributor`; Core's `SuiteParser` then reads both artifacts.
It covers ordinary and Search details, hidden sort carriers, explicit and
inherited presentation, grouping and persistent selection details.

Six facts the shape depends on:

- **BOTH short details carry it.** `models/modules.py::ModuleDetailsMixin.get_details` yields `search_short` from a deep copy of the case short detail, and `case_tiles.py::CaseTileHelper.build_case_tile_detail` gates on `self.detail_type.endswith('short')` — so the search-results list groups exactly as the browse list does. The long detail never does.
- **`header-rows` is always written.** Absent, `commcare-core .../xml/DetailGroupParser::parse` falls back to `1` while HQ's own `models/case_list.py::CaseTileGroupConfig.header_rows` defaults to `2`, so an omitted attribute halves or doubles the header depending on which side reads it.
- **The companion datum is form-entry-only.** `suite_xml/sections/entries.py::EntriesHelper.get_case_datums_basic_module` takes `datums[-1]` and adds it only under `if form:`, so a `caseListOnly` browse entry and a registration form's entry carry none. Its predicate is a plain `@case_id` match and deliberately does NOT reuse `caseLoadingNodeset`'s type/status/filter fragment.
- **Child order is not a constraint.** `commcare-core .../xml/DetailParser::parse` dispatches children by name. Nova appends the group last; actual HQ regeneration puts a Search action after it. Both parse correctly, so tests compare the consumed detail contract rather than requiring byte order.
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
`value[1]`; a consumer is collection-aware or admission rejects it. A form
expression reads the selection as `instance('<datum id>')/results/value` (the
`selected-cases` leaf, declared from its printed tree), and the checker
refuses it where one value is needed (`XPATH_MANY_VALUES`).

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
claimed. Preview plays the claim's effect where CommCare posts it and writes no
claim row: a claim for a result the worker's restore does not hold adds it to
that worker's claims, which seed the restore scope as HQ's claim extension
does, so the form opens with the case as it does on a device. A search action's
claim posts when the result is chosen; a search-first module's claim sits in
each form's entry and posts once a form is chosen, with the entry's other case
datums under a selected parent, so its form menu shows before it
(`lib/preview/searchClaims.ts`).

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

Integer division is its own operator, `quotient`; `div` is XPath's real division in every slot. `xpath/wire/fromExpression.ts::toWire` lowers `quotient` by removing the signed remainder before dividing (`if(r = 0, l div r, (l - l mod r) div r)`), avoiding Core's 32-bit `int()` conversion; a zero divisor keeps raw division's native Infinity/NaN. `ArithmeticRuntimeTest.java` executes the admitted `arithmeticFixture` form through Core's case transaction processor, with the same fixture submitted to real Postgres in the Preview program acceptance suite.

The `<remote-request>` block's `<session>` carries ONE `<data key="_xpath_query">` element PER composed clause — the unified filter's top-level conjuncts, each advanced-arm search input's predicate, and each simple-arm input whose `(mode, via)` shape needs explicit-predicate emission. The server AND-composes every `_xpath_query` value it receives (`commcare-hq/corehq/apps/case_search/utils.py::_apply_filter` loops the multi-term criteria into one ES filter each; `commcare-core .../session/RemoteQuerySessionManager.java::getRawQueryParams` accumulates a `Multimap`, formplayer forwards repeated params, and Django folds them into a list at `corehq/apps/ota/views.py::app_aware_search`), so N small readable expressions filter identically to one fused mega-expression. On HQ JSON the same clauses land as N `default_properties[]` rows (`DefaultCaseSearchProperty` is a `SchemaListProperty`; CCHQ's `remote_requests.py::_remote_request_query_datums` loops every row into its own `<data>`).

CSQL text is a `CsqlNode` tree (`csql/tree.ts`) printed by `csql/print.ts::printCsql`, the only place CSQL text is assembled; each node's position (query, anchor, server value, raw argument, runtime; `csql/positions.ts`, whose core `lib/domain/expression/csqlPositions.ts` the checker reads too) decides its emission, and the wrapper is a wire tree printed by `serializeWire`. A runtime segment is on-device XPath and takes the on-device lowering; no lowering enters CSQL text, because HQ compares instants itself. Each runtime segment carries its raw read and a segment key, the checker path of its subtree in `csql/emitter.ts::prepareCsqlClause`'s clause. Each `_xpath_query` source is typed in its own slot (`xpathQuery.ts::composeXPathQueryClauses`), and a case chosen in an earlier menu prints under the id the module's case list step holds (`formLinkProjection.ts::caseListStepDatumId`; HQ JSON's `case_details.short.filter` takes the id before root alignment).

Each clause's on-device wrapper is the shortest correct shape: a constant-only clause is a bare XPath string literal (HQ's own static emission shape); an input-gated clause is the doc-canonical `if(count(<input>), <query>, 'match-all()')` presence cascade with its value guards inside the presence branch; a clause whose only runtime interpolation is one free-text string uses the flat quote cascade (double-quoted CSQL delimiters, flip to single on an embedded `"`, fail closed on both — CSQL has no escape syntax per `eulxml/xpath/lexrules.py::t_LITERAL`, and the fail-closed arm sends `match-none()`, the one value in HQ's query language that finds nothing, because Android never enforces prompt validation, making the on-device guard the injection defense there; on Android the worker then reads "Query response had no results" with the answer still editable). The admitted `csqlQuoteFixture` is executed by Core's actual query manager and its complete payloads pass through native HQ compilation, including negation, OR, computed values and raw-query refusal independent of prompt errors. A `date`-widget input's value is picker-formatted on every runtime that binds it (Android doesn't support `input="date"` prompts at all), so it interpolates quote-free between fixed double-quote delimiters with no guard and no prompt validation.

A runtime value compared by any operator with `date_opened`, `closed_on` or `last_modified`, or by an ordering operator with any property, carries the typed obligation `blank-comparand` (`csql/runtimeCsqlDateSafety.ts`): while the value is blank the whole clause is `match-none()`, because HQ's query raises on a blank there.

The clause composition runs through `suite/case-search/xpathQuery.ts::composeXPathQueryEmission`, the single contract both the suite-XML emitter and the HQ-JSON emitter (`hqJson/caseList.ts::projectDefaultProperties`) consume. Simple-arm inputs that need explicit-predicate emission route through `suite/case-search/simpleArmDerivation.ts::deriveSimpleArmPredicate`, which lifts the `(property, mode, via)` shape to an advanced-style predicate (`when-input-present(input(name), op(prop, input(name)))`). Every search input still emits a prompt binding on both wire paths (`<prompt>` in local suite XML; `search_config.properties[]` in HQ JSON) because that is the only source CommCare uses to populate `instance('search-input:results')`. Every advanced prompt, plus every simple prompt routed through `_xpath_query`, emits `exclude="true()"` (suite XML) / `exclude: true` (HQ JSON): Core continues binding the typed value but does not ALSO submit the prompt key as an implicit exact case-property filter. Without that exclusion the automatic query parameter silently ANDs with the authored predicate; omitting an advanced `properties[]` row on HQ JSON removes the input from CCHQ's regenerated search screen entirely. Three CCHQ-runtime facts drive the routing rule:

- CCHQ's `CaseSearchProperty` carries no per-input matcher-strategy flag — verified against `commcare-hq/corehq/apps/app_manager/models.py::CaseSearchProperty`. The runtime default for a bare prompt is exact full-string match (`commcare-hq/corehq/apps/es/case_search.py::case_property_query` → `exact_case_property_text_query`). Fuzzy / phonetic / starts-with / fuzzy-date matching only reaches the runtime through an explicit XPath function call inside `_xpath_query` (`fuzzy-match` / `phonetic-match` / `starts-with` / `fuzzy-date` registered at `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`).
- CCHQ's `daterange` prompt binds one inseparable start/end pair. Nova therefore requires `range` mode if and only if the widget is `date-range`; that exact stored arm has no scalar `default` slot. Do not reinterpret one scalar as a From-only default. Exact one-date searches against datetime properties lower to UTC half-open day bounds, matching CCHQ CSQL's verified `datetime('YYYY-MM-DD')` UTC result rather than a hidden project or database-session timezone. `today()` in a search is the worker's day: it is sent as Core's `today()` in a runtime segment, so HQ's search, the device's list and Preview read one day. `eq`, `neq` and `in` on a date-and-time anchor emit the closed instant range `(p >= v and p <= v)` (negated for `neq`, an `or` of ranges for `in`; `csql/emitter.ts::readsInstantByRange`), because HQ answers `=` on a custom property by text equality and would miss every other spelling of the instant; a custom property takes the range in every CSQL slot, `date_opened`, `last_modified` and `closed_on` only where no device evaluates the slot, and a date-and-time literal holds at most milliseconds. `closed_on` is readable only in an advanced Search rule, because neither a device's case database nor HQ's results carry it. `@case_type` is authorable as `record-type()`, all nine of HQ's distance units and a runtime radius and unit are authorable, a runtime `if` or `switch` chooses between clauses, and an ancestor case-id equality against the case chosen in an earlier menu is written `parent/@case_id = v`, which needs no related-lookups flag.
- Each `<prompt key="X">` binds one runtime value via `instance('search-input:results')/input/field[@name='X']` and carries no relation-walk metadata.
- CCHQ's runtime auto-matches the typed value against the case property NAMED BY the prompt key — verified against `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::build_query_prompts` (`'key': prop.name`) and `commcare-hq/corehq/apps/case_search/utils.py::_apply_filter` (the non-special key routes through `_get_case_property_query(criteria)` keyed on `criteria.key` as the case property name). Nova's authoring keeps the prompt key (`SearchInputDef.name`) and the targeted property (`SearchInputDef.property`) as separate slots; when the two diverge, the auto-match queries a property that may not exist. The `exclude="true()"` attribute (verified at `commcare-core/.../session/RemoteQuerySessionManager.java::RemoteQuerySessionManager.getRawQueryParams`) suppresses the auto-match without unbinding the typed value.

The routing rule is `(input type, mode, via, name vs property)`-shaped: a non-date `exact` input (or `range`) on self-walk / absent `via` AND `name === property` rides on the bare prompt slot alone (CCHQ's runtime auto-match against the prompt key IS the authored comparison; the `daterange` widget handles the two-bound semantic internally for the current case). A simple `date` input in exact mode always routes through `_xpath_query`: Nova lowers it to a half-open whole-day interval, using date boundaries for date properties and UTC datetime boundaries for datetime properties (including indexed metadata), because bare exact equality would miss every non-midnight datetime. Every other combination — non-`exact` modes on any via, `exact` mode with a non-self via, OR `exact` mode with `name !== property` — also routes through `_xpath_query` and stamps `exclude="true()"` on the prompt. Simple-arm properties are structurally nonblank, so every stored input reaches one of these final wire paths.

**Prompt children and the seven arms.** `suite/case-search/searchPrompts.ts::searchPromptWire` lowers one input to everything a `<prompt>` / `CaseSearchProperty` carries, and both wire paths read that one description. Children emit in `QueryPrompt`'s order — `<display><text/><hint><text/></hint></display>`, `<itemset nodeset><label ref/><value ref/><sort ref/></itemset>`, `<required test><text/></required>`, `<validation test><text/></validation>` — and attributes in `key appearance hidden input default exclude` order (native HQ regenerates complete prompt-bearing entries from the admitted `searchPromptFixture` corpus; `SearchPromptRuntimeTest.java` evaluates defaults, required/validation transitions and dynamic itemsets with Core's actual query manager). A lookup-backed `select` is `input="select1"` and `multi-select` is `input="select"` (Core's `QueryScreen::getSupportedPrompts`); the itemset nodeset is `instance('item-list:<tag>')/<list>/<row>[filter]` through `lookup/naming.ts`, the label/value refs are the columns' wire names, and the fixture id joins the remote-request's instance list. `required.when` and `validation.rule` lower through `toWire` with an unaddressable case anchor, so a bare `input(uuid)` prints as the absolute `instance('search-input:results')/input/field[@name = '…']` path and `matches-pattern` prints as `regex(...)`; an always-required input carries the literal `true()`. Core keeps only the LAST `<validation>` it parses (`xml/QueryPromptParser.java`), so the authored rule and the compiler's CSQL quote guard share ONE element: `(authored) and (guard)`, messages joined by a space, each half keeping its own translation unit. A hidden input is `hidden="true"`, its value in `@default` (Core re-evaluates it at every query-screen construction and seeds it even under `default_search`), and `exclude="true()"`, so the value binds to the search-input instance without ever auto-matching a property. The three new locale ids are `search_property.<m>.<key>.hint`, `.required.text`, and `.validation.0.text`. Required and validation are enforced by Web Apps only — Android never runs prompt validation — so every surface says "checked in the browser app"; the on-device quote guard remains the injection defense there because the runtime validation that would carry it does not run.

Validator rules anchoring the wire contract:
- `searchInputViaModeCompatibility` — rejects `range` on a non-self via and `range` with `name !== property` on self-walk. A choice input admits `exact` only.
- `searchInputScreenPredicateTypeCheck` — types `required.when` and `validation.rule` under the search-screen context (`patternMatching: true`, bare input refs admitted, case data refused with `CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_CASE_DATA_UNAVAILABLE` / `…_VALIDATION_RULE_…`); the hidden `value` under the global context with input refs refused (`…_HIDDEN_VALUE_…`); and a choice input's `options.filter` under the table-row scope (`…_OPTIONS_FILTER_SCOPE` / `…_TYPE_ERROR` / `…_NOT_ON_DEVICE`).
- `matchModeOnDeviceCompatibility` — rejects `fuzzy` / `phonetic` / `fuzzy-date` in slots that lower to JavaRosa-on-device XPath (`caseListConfig.filter`, `caseSearchConfig.searchButtonDisplayCondition`). JavaRosa has only `starts-with` of the four match functions; the other three are CSQL-server-only. The mode table itself lives once, under `lib/commcare/csql/`, which this rule, the display-condition rule and `toWire` all read. **The on-device emitter refuses the three and never lowers them**, so every carrier that dry-runs it inherits the rule, including carriers such as case operations that reach the emitter through their own portability check. Precisely what happens at runtime is worth stating, since "crash" is only half true: an unregistered name still PARSES (`ASTNodeFunctionCall::buildFuncExpr` falls through to `XPathCustomRuntimeFunc`, whose `validateArgCount` is a no-op), so the app installs clean and throws `XPathUnhandledException` at EVALUATION. In form logic that surfaces as an error; in a case list `AsyncEntity::evaluateField` catches it and substitutes the literal string `<invalid xpath: …>` into the cell, so the failure is silent corruption rather than a crash.
- `validator/onDeviceCompatibility.ts` owns the structured, type-aware date-arithmetic capability decision shared by module slots, navigation display conditions, form case operations, lookup-backed select filters, and the builder's complete-candidate admission seam in `lib/doc/commitVerdicts.ts`. A property reference stores identity rather than its resolved type, so emitter dry-runs are only defensive totality checks and never the semantic source for deciding whether a `date-add` base is a date or datetime; lookup-row filters additionally install their table scope before resolving a column's type. `dateAddOnDeviceCompatibility` maps that shared decision into module-slot findings. JavaRosa-on-device date arithmetic stays on the portable fixed-duration lowering: a date-typed base plus seconds, minutes, hours, days, or weeks. Core registers no `date-add` / `datetime-add`, but it does provide numeric epoch-day arithmetic and `floor()`, so the emitter scales the quantity to days and emits `date(floor(base + scaledQuantity))`; this preserves positive, negative, fractional, and pre-epoch date results. Datetime bases (time-of-day would be lost) and calendar-relative months/years are rejected across every on-device expression slot. Advanced predicates are mixed-dialect: direct native CSQL `date-add` / `datetime-add` calls retain the full server surface, while date arithmetic beneath a non-native value root is checked because that subtree is interpolated through JavaRosa. Builder menus use the same dialect-state walk, so an unavailable choice is withheld before mutation rather than first surfacing at commit or export.
- `onDeviceExpressionCompatibility` — blocks persisted scalar-expression shapes Core cannot evaluate safely: `prop(via: subcase|any-relation)` in a standalone scalar value slot (the walk can return several cases while Core scalar-unpack requires one), and a child/any count nested beneath a multi-case child/any scope that Core cannot name. Self/ancestor reads remain valid; `count(self)` reduces to 1/0, root child counts are valid, and a child count beneath a pure singleton ancestor chain uses that ancestor's absolute case-id anchor. Predicate-rooted relation reads are owned by the relation-scope normalizer instead. Table lookups are on-device expressions: their table-scoped row predicate lowers against the declared lookup fixture and their result is then interpolated into CSQL where needed. The rule validates saved calculated/default definitions even while latent so a later visibility or input change cannot activate a runtime-failing expression.
- `excludedOwnerIdsTypeCheck` — treats the assigned-case exclusion as one global value resolved before a case is selected. It rejects every case-property or relationship read (including nested `prop`, `count`, `exists`, and `missing`) so Preview cannot resolve blank while an ordinary suite nodeset evaluates the same expression per row; literals, session/current-user values, Search answers, and pure calculations over them remain valid and must resolve to text.
- `searchInputDefaultTypeCheck` + `searchButtonDisplayConditionTypeCheck` carry the same global-context guard for their slots (`CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE` / `CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`): a prompt default evaluates when the search screen opens and the display condition emits as the Search action's `relevant` — both before any case is selected, where a case read emits as a bare relative leaf path that resolves blank (Preview deliberately resolves it blank too). Search answers are additionally invalid in these two (the default fires before the user types; the action relevance evaluates where the search-input instance isn't loaded — the standing `CASE_LIST_BARE_SEARCH_INPUT_REF` forbids-input-ref arm). Unlike the paired type-error codes these never depend on the catalog: the read is invalid whatever the property's type.
- `moduleDisplayCondition` + `formDisplayCondition` gate navigation conditions
  against their exact evaluation contexts. Modules admit no case/Search reads.
  Forms admit a direct self property of the owning case type only when
  `isCaseFirstModule` proves selection happens first; forms-first, related,
  presence/count, and Search shapes reject. Both conditions must be portable to
  Core's on-device evaluator (CSQL-only match modes, unsafe date arithmetic,
  and invalid fixed geopoints reject). A condition is held as written
  (`lib/domain/expression/simplify.ts::displayConditionForEmission`: absent, or
  a root `match-all`, emits nothing; nothing inside is absorbed), and the
  instance declarations beside it read that same condition. A condition that
  is `never`, or an `and` that starts with it, would print exactly what
  `hiddenFromMenu` prints, so it is `DISPLAY_CONDITION_USE_HIDDEN_FROM_MENU`.
  An item off the menu (`Module.hiddenFromMenu` / `Form.hiddenFromMenu`) writes
  `false()`, or `false() and (<rest>)` with its condition as the rest, the
  parentheses always written (`suite/displayConditions.ts`).
- `hiddenFromMenu.ts` — `HIDDEN_MENU_NOT_A_DESTINATION`: a link whose target is
  a module off the menu, and a module off the menu holding an entry point or a
  case list entry point. Android opens such a module as a menu screen that
  lists nothing and Web Apps lands on the app's first screen, so neither is a
  destination. A link or an entry point to a form inside it is admitted.
- `csqlPredicateRepresentability` — when case search is effective, rejects case-list filters and advanced-input predicates that CCHQ's server query language cannot represent faithfully (missing/direct query anchor, case-property reads on the comparison-value side, unsupported related counts, and self-relation envelopes). Fixed quote-output reachability follows emitted Core equality (null to empty text, boolean literals to text, numeric absolute tolerance below 1e-12), retaining both branches for unknown numeric/text coercion and stopping ordered switch selection at the first unknown comparison. Native `StaticQuoteRuntimeTest` retains the formerly admitted failed-search counterexample and executes current safe counterparts. A reversible comparison with its sole property/count anchor on the right is admitted because the CSQL emitter swaps the operands and inverts ordered operators before emission; strict-null portability stays in the module-wide rule above so it produces one repair across every wire slot.
- `caseSearchConfigRequiresCaseType` — `<remote-request>` carries a mandatory `case_type` slot.
- `ancestorExistsCannotNestSubcase` — runs after shared relation canonicalization and CSQL relation-read adaptation. A canonical `any-relation(parent)` whose selected case type proves one graph direction is first narrowed to that ancestor or child direction, preserving filters CCHQ can faithfully express. Recursive, custom-index, and otherwise ambiguous `any-relation` paths retain both arms and are ancestor-bearing because CSQL emits an ancestor arm. CCHQ rejects ancestor-exists with subcase-exists or subcase-count nested in the filter argument.

Lookup-aware validation takes a required `LookupValidationContext` on every runner, commit, readiness, and boundary call. `available` carries one rows-free Project definition snapshot; `unavailable` is an explicit state, never an empty available registry or a reason to skip rules. `lib/doc/lookupReferences.ts` registers the immutable production structural extractors; ordinary carrier-free documents remain clean with unavailable context, while every persisted carrier occurrence is visible to the shared validator and edge writers. Synthetic tests may still inject a purpose-built extractor registry. Each exact occurrence validates independently: unavailable context, absent table, absent column, and incompatible column type use stable `LOOKUP_*` codes whose identity includes carrier uuid, registry slot, canonical nested subpath, table id, and column id. Missing and foreign definitions are deliberately indistinguishable. Commit validation gives previous and candidate docs the exact same context object; operational definition-read failures belong to the caller and must throw before writing or emitting rather than becoming findings.

The runner also materializes one rows-free table→column→type index from that
same snapshot and threads it through every expression the checker types
(module, form, field, case operation, and lookup-backed selects). Structural
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
complete rows, because every mode carries the data: `ccz` embeds it as
suite fixtures, and the two HQ modes build the fixapi workbook. The
row-dependent select-source findings are common to all three — a choice list
whose saved values are blank or duplicated is equally broken however the table
reached the device — and are `environment`-class, since rows change outside the
document and must never gate a commit. What differs is what each CARRIER can
hold: `ccz` takes the aggregate fixture budgets, and the HQ modes take one
size verdict, `LOOKUP_HQ_PUSH_TOO_LARGE` (CommCare HQ's whole-workbook row
ceiling). HQ's upload reads a 32-character sheet name, so a 32-character tag
pushes. `LOOKUP_TAG_RESERVED_BY_RUNTIME` also refuses a referenced table whose
tag contains `casedb` or `ledgerdb`, case-sensitively, naming the word in its
details (`reservedWord`).

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
`current()` to the question node contextualized to its iteration). A carrier's lookup root declares itself wherever its tree is printed, from the serializer's instance set under the lookup naming: in an XForm the bare tag with source `jr://fixture/item-list:<tag>`, and in entries, menus and remote requests `item-list:<tag>`. Form logic reads a table too, by table and column UUID: `instance('<tag>')/<tag>_list/<tag>[…]` in a form and `instance('item-list:<tag>')/…` in a form link, printed under the current tag and wire names, so a rename keeps the read. Its reads join the reference edges (`lib/doc/lookupReferences.ts`), so the publish push, the `.ccz` fixtures and the plan feature follow. The suite oracle
cross-checks embedded fixtures (`SUITE_FIXTURE_INVALID`: id required/unique,
single body element, no `user_id`, every declared `jr://fixture/` src
delivered) and the XForm oracle checks itemset shape
(`XFORM_ITEMSET_INVALID`). Validator dry-runs use `inertLookupWireNaming` so
portability checks stay total without real definitions. Preview and
case-store SQL evaluate carriers (Preview evaluates the same wire tree in
`preview` mode over its loaded fixture snapshot, a lookup-backed choice list's
through the one `lookupOptions.ts::lookupOptionsNodeset` the XForm itemset and
the Search prompt print; see `lib/preview/CLAUDE.md`); CSQL and the case-search `_xpath_query` path keep
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

`searchWireShape.ts` is the pure decision tree from authored content to a three-flag `WireShape`, one shape for every platform an app declares: an effective Search action with an effective filter and zero search inputs emits skip-to-results; an explicit zero-input action without that filter remains manual; otherwise list-first. Android reads no `auto_launch` and opens the list first, which the platform table states (`skip-to-results`). The flags drive the orchestrator's `<query>` attributes + storage-instance choice + the case-list short-detail emitter's `<action auto_launch>` attribute. Both export paths send a match-all filter for the explicit zero-input/manual shape (`suite/case-search/xpathQuery.ts::ZERO_INPUT_SEARCH_SENTINEL`), because CCHQ offers Search only when a property or default property exists; this is wire scaffolding, not an authored filter.

Every search button reads `lib/domain/modules.ts::CASE_SEARCH_BUTTON_LABEL` ("Search All Cases") in every language, on both export paths and in Preview: HQ's Case List save keeps no other label, and the document holds none. A lookup-backed search input's `<sort ref>` is its `sortColumnId`, or its label column where none is set. `suite/case-search/reservedInputNames.ts::RESERVED_SEARCH_INPUT_NAMES` holds the sixteen names HQ's search request keeps for itself, and `RESERVED_SEARCH_INPUT_NAME_PREFIXES` the `indices.` prefix; `isReservedSearchInputName` tests a name against both, and a search input and a default filter may use none of them. A menu uploads its own case type, a survey-only menu's included, and `formLinkProjection.ts::moduleCaseTypeForActions` gates only what is built from the type. Four spellings are HQ's own and Nova writes them: no `no_vellum`, no `custom_variables`, a calculated column as `format: "plain"`, and one `name` column on a short list that holds none.

### Search-first inline shape

`caseSearchConfig.searchFirst: true` (`lib/domain/modules.ts::moduleOpensOnSearch`)
lowers to HQ's inline search, `inline_search && auto_launch`
(`app_manager/util.py::module_uses_inline_search`), with `default_search` when
the module has no visible prompt, on both wire paths. Search first is
unavailable on Android (`search-first`), so only an app that runs in Web Apps
only holds it.
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
  nodeset="instance('results:inline')/results/case[@case_type = 't'][@status = 'open']{filter}[not(commcare_is_related_case = true())]{parent}">`
  (`EntriesHelper.get_query_datums` / `get_datum_meta_module`). The browse
  entry of a `caseListOnly` module carries the query and no post
  (`test_inline_search_case_list_item`). `formLinkProjection.ts::withInlineSearchQueries`
  inserts the query datum before every nodeset datum whose source module is
  search-first, after `alignWithRootMenu`, so a search-first parent-select
  source contributes its query to the child's chain too.
- **The claim `<post>`** (`claim.ts::buildInlineClaimPost`) sits between
  `<form>` and `<command>`. Single: `relevant="count(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/V]) = 0"`
  + `<data key="case_id" ref=".../V"/>`. Multi-select: `relevant="$case_id != ''"`
  + `<data key="case_id" ref="." nodeset="instance('V')/results/value"
  exclude="count(instance('casedb')/casedb/case[@case_id = current()/.]) = 1"/>`.
  Parent-relationship parent-select
  (`module_uses_inline_search_with_parent_relationship_parent_select`):
  `relevant="$case_id != ''"`, own data plus one `<data>` per other case
  datum, each `exclude="count(instance('casedb')/casedb/case[@case_id=…]) != 0"`,
  and a trailing `_xpath_query "ancestor-exists(parent, @case_type='P')"`.
  The oracle is `tests/test_suite_inline_search.py::InlineSearchSuiteTest`;
  its stacks differ from Nova's (HQ's fixture forms carry `post_form_workflow:
  default`; Nova's `module` default emits `[command 'm0']`), and Nova deviates
  deliberately in three places (`x_commcare_include_all_related_cases`, the
  calculated `<variable>` template, the `@case_type` qualifier).
  `__tests__/searchEmission.test.ts` checks the inline and remote shapes.
- **Instances.** `results:inline` is a Core instance id whose root prints as
  `results` (`xpath/wire/instances.ts` and `xpath/wire/rowScope.ts`). Every
  admitted `input(...)` read in the query's clauses, owner exclusion, or prompt
  required/validation rules prints `instance('search-input:results:inline')`
  for a search-first module, through the explicit `searchInputInstanceId`
  wire binding. HQ JSON and the local suite derive that binding from the same
  query storage shape, as Core's `VirtualInstances.makeSearchInputInstanceID`
  does. Starting values, choice filters, calculated columns and search-button
  conditions refuse answer reads; ordinary list filters substitute unanswered
  inputs before emission. Expression facts come from the actual owning module
  slot (`expressionContext.ts`), while the serializer's instance set declares
  every printed read. Details read
  `caseSource: "results:inline"`
  (`suite/case-list/columns.ts::instanceRootFor`) so a calculated column's
  `current()/../case[...]` sibling walk resolves inside the results roster.
- **Forms read the results.** A form whose entry carries the inline query
  reads what the search found as
  `instance('results:inline')/results/case[not(commcare_is_related_case = true())][…]`,
  a row of the module's searched case type (`cases { source: "search-results" }`;
  the parser and the checker both type it from the supplying module), in
  question and Connect slots and in a link's condition and datums; the form
  declares `results:inline` and the source entry already does. Elsewhere that
  read is `SEARCH_RESULTS_NOT_SUPPLIED` (reasons `not-search-first`,
  `no-matches-form`, `link-source`). A read whose answer depends on HQ's order
  (a numeric or `last()` predicate, `position()` inside the query, `join`,
  `distinct-values` or `index-of` over the results, `concat` of the results
  alone) is `SEARCH_RESULTS_READ_INVALID` reason `order`, because HQ orders
  results by relevance, and a `@case_type` the search cannot return is the
  same code, reason `other-type`. In a results row `date_opened` is the UTC
  day and `last_modified` HQ's instant. `session.ts::SEARCH_RESULTS_CAP` (500,
  `case_search/const.py::CASE_SEARCH_MAX_RESULTS`) is the most a device
  receives, and Preview reads the same number. Text naming
  `instance('results')`, the remote search's instance, is a parse refusal.
- **Links into a search-first module** carry HQ's `WorkflowQueryMeta` child:
  `<query id="results:inline" value="https://__COMMCARE_HOST__/a/__DOMAIN__/phone/case_fixture/__APP_ID__/"><data key="case_type" ref="'t'"/><data key="case_id" ref="instance('commcaresession')/session/data/<source>"/></query>`
  (`formLinkProjection.ts::queryChild`, `CASE_FIXTURE_URL_TEMPLATE`;
  `test_form_linking_to_inline_search_module_from_registration_form`). The
  query is `requiresSelection` only without prompts and with `default_search`,
  so a manual-datum link that omits the selection is `FORM_LINK_DATUMS_INCOMPLETE`
  there too. The stack parser needs `id` and a `java.net.URL`-parseable
  `value` (`StackFrameStepParser::parseQuery`); `suiteOracle.ts` checks both
  (`SUITE_STACK_QUERY_INVALID`) and scopes the session-query rules to
  non-stack queries.

The three refusals mirror HQ's build validator (`helpers/validators.py`)
because every Nova-uploaded module carries a `search_config` shell, which is
what its `non-unique instance name` checks key on: `SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE`
(inline needs a case datum on every entry), `SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION`
(there is no action for `relevant` to gate), and
`SEARCH_FIRST_UNIQUE_INSTANCE` (no submenu under, and no parent-select from, a
search-first module; a search-first CHILD of an ordinary parent-select source
is fine). The setter tool refuses `searchFirst` on an owner-only config
because there is no search to open on.

`caseSearchConfig.searchButtonDisplayCondition` is orthogonal to that flag decision. It emits as the case-list Search action's `relevant` predicate, not as a Results-row filter and not as the `auto_launch` expression itself. Core first removes irrelevant actions and then evaluates auto-launch among the remaining actions, so the predicate gates the automatic transition only in the web filter-plus-zero-input shape; in every list-first shape it gates the manual Search action. Preview and authoring copy must preserve that distinction rather than treating any input-free search config as a generic “go to Results” rule.

### No-matches registration lowering

Explicit `postSubmit: "firstMenu"` on a no-matches form emits HQ `root` and
one empty local `<create/>`, the ordinary `firstMenu` lowering: it is the one
explicit destination a no-matches form may hold. HQ's `WorkflowHelper._get_stack_frames` uses a
nonempty explicit end-of-form workflow instead of `CaseListFormWorkflow`, so
this reset bypasses the implicit return to Results. The implicit return stays
unchanged for single-case hosts. A multiple-selection host requires explicit
`firstMenu`: HQ's `WorkflowQueryMeta.clone_to_match` retains the target collection
transport while using the registration's scalar new-case id; Core cannot load
that scalar `uuid()` as a selected-entities instance. Admission reports
`SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN`; never widen the instance allowlist
or locally scalarize a query that HQ regenerates as a collection.


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
  form's command, the target entry's datums as HQ's `get_datums_for_action`
  offers them (`compiler.ts::registerActionFor`: a function datum as its
  function, `case_id_new_<type>_0 = uuid()`), and
  `<datum id="return_to" value="'m{N}'"/>`. Registration creates its own
  primary case and has no existing-case selection, even when that case
  type has a catalog parent. Explicit child writes carry their own indices.
  The action appears before any Search action (`suite/case-list/shortDetail.ts::RegisterActionContext`).
  The relevancy is
  an explicit boolean comparison because Core string-compares
  `Action.relevant` to `"true"`, and it is safe only in the inline shape,
  where `results:inline` exists before the list renders; the label rides
  `case_list_form.m{N}` (`emissionPlan.ts::caseListFormLabelUnit`, source
  `entry.label ?? form.name`). Bytes pinned to
  `tests/data/case_list_form/case-list-form-suite.xml` and the relevancy
  partial in `test_case_list_form.py`.
- **Synthetic module.** HQ `module_filter: "false()"` / local
  `<menu relevant="false()">` (`suite/displayConditions.ts`, the off-the-menu `false()`): stack
  pushes ignore menu relevance, so the form is reachable through the action
  and nowhere else. Its entry's `<stack>` is the return frame
  `<create if="count(instance('commcaresession')/session/data/return_to) = 1 and instance('commcaresession')/session/data/return_to = 'm{N}'">`
  with the host command plus the `case_fixture` query child
  (`formLinkProjection.ts::caseListFormReturnFrame`), so the worker lands on
  Results showing exactly the case they registered; HQ regenerates the same
  frame from `post_form_workflow: case_list`
  (`test_form_linking_to_inline_search_module_from_registration_form`). A
  host without menu forms has no common datum prefix (HQ reads form entries
  only), so its frame is the host command alone and the worker returns to
  the module's search; Preview mirrors both.
- **Carried answers.** The `input { searchInputUuid }` leaf
  prints `#search/<name>` for people and emits
  `instance('search-input:results:inline')/input/field[@name = '<name>']`.
  The parser binds it only inside a no-matches form. The form declares
  `jr://instance/search-input/results:inline` because its tree reads it,
  and `vellum` mode withholds the shadow. The parser refuses `#search/`
  outside a no-matches form; the checker refuses a stored read outside one
  or of a prompt the module no longer has
  (`INVALID_SEARCH_REF`).
- **Validator** (`rules/case-search/searchNoMatches.ts`, all soundness):
  `SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST`, `…_NOT_REGISTRATION`,
  `…_HAS_NAVIGATION` (links, an after-submit choice, a display condition),
  `SEARCH_NO_MATCHES_DUPLICATE`,
  and `FORM_LINK_TARGET_NO_MATCHES_FORM` in
  `rules/form.ts`. `hqJsonOracle.ts::checkCaseListForm` pins `form_id`
  resolution and `post_form_workflow ∈ {default, case_list}`
  (`HQJSON_BAD_CASE_LIST_FORM`).
- **Compatibility.** HQ emits the action's `relevant` only under
  `FOLLOWUP_FORMS_AS_CASE_LIST_FORM` (`details.py::get_case_list_form_action`);
  without it the action is UNCONDITIONAL. The probe's flag is
  `no-matches-registration` in
  `projectSpaceCompatibility.ts::HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`, the
  public capability `registration-after-empty-search` ("Registration offered
  after an empty search", required), derived by
  `projectSpaceCompatibility.ts::moduleRequiresNoMatchesRegistration`.
- **Web Apps only at runtime.** Android never shows the case list on an
  empty search response and passes no search-input extra
  (`QueryRequestActivity::processSuccess`), so author-facing copy says the
  action and the carried answers work in the browser app.

Module/form navigation display conditions use `suite/displayConditions.ts`.
Module conditions emit to `<menu relevant>` and HQ `module_filter`; their
secondary instances are child `<instance>` elements on that menu, which
CommCare reads from 2.54, below the 2.57 every app Nova publishes or compiles
requires (`versionFloor.ts::COMMCARE_VERSION_FLOOR`). Form conditions emit to the menu's `<command relevant>` and
HQ `form_filter`; direct self properties structurally anchor through the
selected `commcaresession/session/data/<projected-own-case-id>` in local suite
XML. In HQ JSON a read of `case_id`, `case_type`, `owner_id` or `status` is
printed as that same expanded read,
`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/<datum>]/@<property>`, because HQ's `validate_app()` refuses `#case/@<property>` (`form filter has
xpath error`); every other property keeps `#case/<property>`, which lets HQ
choose its own datum. The matching entry declares the condition's
instances, including both `casedb` and `commcaresession` for a selected-case
read. Emit raw comparisons: Core's absent node-set becomes `""` for string
comparison and NaN for numeric comparison, so a generic presence guard would
change equality/inequality semantics.

`caseSearchConfig.excludedOwnerIds` is Results availability, independent from the Search action. It resolves once from global session/Search state before any case is selected, then constrains ordinary case-list nodesets and HQ short-detail filters as well as effective remote Search; it can never read the row being filtered. `emitNormalizedExcludedOwnerIdsExpression` lowers the owner expression through `toWire` and builds JavaRosa-native nested `replace()` calls over XML whitespace through `suite/wire.ts::normalizeSpace`, in local-suite remote data and HQ JSON. The ordinary list feeds that same lowered value to `selected(...)`; this matches Preview's whitespace split instead of letting CCHQ/Core preserve empty tokens from repeated/trailing/tab whitespace. The ordinary list also short-circuits when the normalized value is blank because Core considers `selected('', '')` true for an unassigned row. Owner-only configuration emits no Search action or remote request. On the remote path the normalized expression translates to CCHQ's `commcare_blacklisted_owner_ids` `<data>` key; authoring vocabulary stays in the schema and SA tools, and that wire token lives only at the emission boundary.

### Instance accumulation — local `.ccz` vs HQ-regenerated suite

CCHQ's server-side suite post-process (`commcare-hq/.../suite_xml/post_process/instances.py::InstancesHelper.add_entry_instances`) walks every detail an entry references and adds the matching `<instance>` declarations on the enclosing `<entry>` / `<remote-request>`. Nova's local `.ccz` emission has no equivalent post-pass, so `session.ts::deriveEntryDefinition` and `suite/case-search/searchSession.ts::buildSearchSession` union the instance sets of every wire tree the body prints — `caseListConfig.filter`, advanced-arm predicates, simple-arm-with-via derivations, prompt defaults, `excludedOwnerIds`, `searchButtonDisplayCondition`, form command display conditions, and each calculated expression a runtime evaluates (`lib/domain/modules.ts::caseListColumnRuns`). Every column of a list with no tile layout is a field of the short detail, so a calculated column hidden from both screens with no order rule is evaluated for every row and its instances are declared on the entry and on the remote request, as HQ's build declares them for an `invisible` expression column. In a tile list a column hidden from both screens declares nothing: with an order rule it rides as a property carrier, which reads the case's own property, and with none it has no runtime role. A missing accumulation surfaces as an undeclared-instance XPathException at runtime; the HQ-upload path is unaffected because CCHQ regenerates the suite from the persisted document.

Search carries supporting parent cases only when an emitted calculated Results/Details/Default-order value is exactly one direct ancestor property. `suite/case-search/relatedCaseProjection.ts` is the private shared decision: every saved definition is validated, and every column a runtime evaluates (`caseListColumnRuns`) triggers its emitted support rows; subcase, ambiguous, aggregate, and wrapped relation calculations are rejected for effective Search. The direct suite derives one `x_commcare_include_all_related_cases='true'` query datum. HQ JSON sets `include_all_related_cases` and stores the allowed column as a calculated `current()/../case[...]` expression, so CCHQ's copied ordinary/Search details resolve against their containing roster without losing canonical `@case_type` qualifiers; reserved case metadata leaves use their `@case_id` / `@case_type` / `@owner_id` / `@status` spellings. Both selection datums keep CCHQ's `[not(commcare_is_related_case = true())]` predicate exactly once, so supporting rows never become choices. Ordinary non-Search relation calculations retain their existing on-device expression projection.

A `caseListOnly` module emits a third case-loading entry — the standalone case-list-browse command (`session.ts::deriveCaseListEntryDefinition`, CCHQ's `case_list.show` block at `suite_xml/sections/entries.py`). It has no `<form>` (its `EntryDefinition.formXmlns` is omitted, and `buildEntryElement` skips the `<form>` child) and its `case_id` datum always carries `detail-select` (`m{N}_case_short`); `detail-confirm` (`m{N}_case_long`) appears only when the author put information on Details. With no Details fields, selection stays on Results instead of navigating to an empty screen. It loads the same details the form entry does, so it shares the case-loading nodeset builder and the body-instance accumulation with `deriveEntryDefinition` (`session.ts::entryInstances`, the instance set its printed datums read) — and is the SOLE loader of those details in a formless module, so it's the only place their instances can land. Without this command the `caseListOnly` module's `<menu>` would carry zero commands, leaving the case list unreachable on a directly installed `.ccz` while the HQ-regenerated suite reaches it.

Results and Details have independent column sequences, held as the config's two arrays. `listColumnOrder` drives the running results list, suite short detail, HQ `case_details.short.columns`, and every sort tie-break / calculated-sort positional index; `detailColumnOrder` drives the running confirmation screen, suite long detail, and HQ `case_details.long.columns`. Read either through `orderedColumns(config, surface)` — the storage array is a SET and its position means nothing. CCHQ already stores short and long as separate ordered arrays; never collapse the two surface sequences at emission.

Every saved column definition is validated unconditionally, even when hidden
from both layouts and absent from sort. Two predicates in
`lib/domain/modules.ts` say whether a column reaches a runtime.
`caseListColumnRuns(column, config)`: a runtime evaluates its value, which is
every column of a list with no tile layout and, in a tile list, a column shown
on Results or Details; the compiler's instance walk,
`searchSession.ts::buildSearchQuery`, `relatedCaseProjection.ts` and Preview's
case data binding read it. `caseListColumnTextShows(column)`: its header,
labels or images reach a screen, which is a column shown on Results or
Details; the translation units and the media reference walks read it. Hiding
never creates deferred invalid state and revealing never repairs or rewrites a
definition.

Sort lives on each column. `lib/domain/caseListOrder.ts::caseListOrderPlan` is the one statement of a list's order: what HQ's build writes for the app Nova sends, each rule with its citation in the module. Its `fields` are the short detail's fields in stored order, each with its wire class (a property column or an expression column), the text HQ joins a sort element to it by, the sort key it keeps with no rule, and its rule if the list orders by it; its `carriers` are the hidden sort fields HQ appends for rules that join no field. Authored rules become elements in `priority` order, ties by Results position; each lands on the first field whose join text equals its own; a list with no authored rule orders by its first shown field's own key, ascending, compared as text; blanks come first ascending and last descending. HQ JSON, the local suite and Preview's case store all read the plan, so the three order alike. `CASE_LIST_DUPLICATE_SORT_PRIORITY` stays soundness, and `CASE_LIST_SORT_PROPERTY_AMBIGUOUS` refuses two rules over one value, and a rule that would land on a field with another key, so in an admitted document every rule orders as authored. The schema has no parallel `SortKey[]` array, so sort directives cannot refer to a non-existent column. HQ JSON writes each element in the Case List page's own spelling (`type` `plain`, `date`, `int` or `double`, `blanks` `first` or `last`, `display` keyed by the first language's wire code, `sort_calculation` empty), so a save there changes nothing.

The comparator of each element is derived in the plan, not authored: integer or decimal only for a `property` or `calculated` key over an integer or decimal value (`caseListOrder.ts::comparatorForDataType`, and the plan's `calculatedType` option for a calculated column), and text for every key a field keeps on its own (a date's stored value, a mapping's position, a select's label, an interval's text).

Calculated sorting uses the same case source as its displayed value: `casedb` for ordinary lists, `results` for remote Search, and `results:inline` for inline Search even though that detail retains the case target.

Calc-column sort directives write `field: "_cc_calculated_{columnIndex}"` (matching `commcare-hq/.../app_manager/const.py::CALCULATED_SORT_FIELD_RX`) so sibling calc sorts each get their own row in CCHQ's `sort_elements_by_field` dict — a shared placeholder key would collapse multiple calc sorts on the HQ-uploaded path.

The `Column` discriminated union has seven arms — `plain`, `date`, `phone`, `id-mapping`, `image-map` (the id-mapping shape with image paths instead of text labels — emits CCHQ's `enum-image` format, `<template form="image">`, with inlined `jr://file/commcare/...` literals; written as images wherever `lib/domain/modules.ts::imageMapShowsImages` holds, which is in an export that carries a media manifest and, for a map with no entries, in every export; a map with entries in an export with no manifest is a plain column, which no production export writes), `interval` (covers both relative-display and threshold-flag UX, dispatched by `display: "always" | "flag"`), and `calculated` (an `Expression`; calculated columns are a column kind, not a parallel array). Calculated columns emit CCHQ's inline-`<variable name="calculated_property">` template (verified against `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.template`'s `useXpathExpression` branch); they have no `field` slot — the expression is the source.

A `plain` column stays a bare property reference for ordinary properties. When its effective property is `single_select` or `multi_select` and carries an option catalog, `columns.ts` derives worker-facing labels in the template XPath so the installed app matches Nova Preview. Single-select uses nested exact-equality arms (`field = 'value'`) with the raw property as the final fallback — never `selected()`, whose space-token membership would let one option value shadow a later multi-word value and diverge from Preview's exact-match projection. Multi-select renders known labels in catalog order and independently removes only those known tokens from a normalized raw copy; remaining imported/historical tokens are appended unchanged, so a catalog edit never makes saved data disappear.

Per-surface visibility lives on the column. The `MISSING_CASE_LIST_COLUMNS` completeness rule requires at least one `visibleInList !== false` field on every reachable case list, including a `caseListOnly` viewer; Details may be empty. `longDetail` and HQ `case_details.long.columns` omit `visibleInDetail: false` entries entirely — CCHQ's `invisible` format only collapses short details and would render normally on an ordinary long detail. In a list with no tile layout `shortDetail` keeps every `visibleInList: false` column as a hidden field in HQ's own shape: `<header width="0"><text/></header>`, with no locale id and no app string, and a `width="0"` template over the raw wire path, or the calculated template for a calculated column. HQ short details hold the same column as `format: "invisible"`. A device's search matches a hidden field's text, and Android's Sort menu lists the shown columns alone. An order rule on one is a sort element over the property name, or a positional element for a calculated or attribute-backed (`@<name>`) one. A tile list holds no hidden field; "Case-tile emission" gives what a hidden column's order rule becomes there.

The `interval` kind covers both relative-interval and threshold-flag UX through one `display` discriminator. `display: "always"` always shows the relative interval (the runtime label decorates the cell when the threshold is exceeded); `display: "flag"` only shows the `text` slot when the threshold is exceeded (otherwise empty cell). Both arms share the same `(threshold, unit)` mechanics; the dispatcher in `columns.ts` switches on `column.display` to pick the per-arm wire emission.

## CommCare HQ upload

`importApp` creates an app, or — given the optional HQ app id — updates that
app in place: HQ's import endpoint takes an `app_id` multipart field
(`corehq/apps/app_manager/views/app_import_api.py::_handle_import_app`,
update via `overwrite_app_from_source`; 200 `{success, app_id, version}` on
update, 201 without `version` on create, 404 `Application not found` for an
unknown id, and 400 for an app deleted in HQ, whose source read still answers
200 with a `doc_type` ending `-Deleted` (`app_manager/util.py::app_doc_types`)).
An update never writes `multimedia_map`, `build_profiles`, `custom_base_url` or
`practice_mobile_worker_id`, and Nova sends no `multimedia_map` in any mode.
Which of the two a publish does, and what happens to it
afterwards, lives in `lib/deployment`:
this package owns the HTTP calls, that one owns the lifecycle, the ownership
ledger, and the setup artifact. The three reads a key CAN make about a
published app (`readAppVersions`, `listAppBuilds`, `probeBuildProfile`) live
here beside the writes. `probeBuildProfile`'s doc block states what that call
actually is: the catch-all `download_file` route handles it, not
`download_odk_profile`, so it can regenerate a build's files, and naming a
BUILD id is what keeps it on that build instead of falling through to
`autogenerate_build` and starting a new version. Dimagi runs three separate SaaS deployments (`servers.ts`: production/www, india, eu — mirroring HQ's `ServerLocation`), each with its own account DB, so an API key only authenticates against the server that issued it; the connection stores which one it was verified against and every request derives its base URL from that closed catalog (the SSRF boundary — never a user-supplied URL). User API keys are KMS-encrypted at rest via `./encryption`. Domain slugs are validated against HQ's legacy regex to prevent path traversal in the import URL.

The HQ import file is always a ZIP
(`multimedia/hqJsonExportArchive.ts::buildHqJsonExportArchive`): the app's
JSON, `README.txt`, `lookup-tables.xlsx` where the app reads lookup tables,
`multimedia.zip` where it has media, and the logo's file as `logo<ext>` where
the app has a logo. The README is rendered from a pure derived
guide, `lib/publish/manualImportGuide.ts`, whose steps are each present only
when they apply: the lookup tables first, so the app finds its data when HQ
builds it, then the import, the CommCare version to check, the media, the
capabilities the project space needs, the plan features, the logo, the flat
location list and Connect forwarding. It names capabilities, never HQ flag
names. The file carries derived ids and no runtime URL, and a person who
imports it makes a create that carries forms, so its form ids are HQ's and its
menu ids and every `xmlns` are Nova's.

A key is **not** one-project-per-user: an unscoped HQ key reaches every project space its owner belongs to. `discoverAccessibleDomains` lists them and probes app-level access in a bounded-concurrency window (an unbounded fan-out self-inflicts a 429 on big accounts). The upload *target* is chosen by `resolveUploadDomain` (`@/lib/db/domainResolution`) — explicit arg, else the sole space of a single-space key, else **error** (ambiguous) for a multi-space key (never silently the first space). There is no stored default: a multi-space key's target is a per-upload choice, and no path assumes one project space per key.

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

App imports, lookup workbook uploads, and media ZIP uploads own a 60-second
deadline through success and refusal response bodies. Location batches own 30
seconds. All writes refuse redirects. Expiry preserves uncertainty about remote
changes, and the operation owner releases its timer only after body consumption.
Accepted
ZIPs start a separate 45-second status clock shared by every fetch and retry wait.
Both requests refuse redirects and bind routeable app/processing IDs. A completion
requires HQ's literal success and completion flags, the acknowledged processing ID,
nonnegative integer counts, and complete error/unmatched-file lists whose count
agrees. Malformed evidence is unconfirmed attachment, never zero-file success.
A polling timeout makes no claim about whether the remote task is still running.

Worker discovery is an Elasticsearch hint: strict object/identity validation
rejects malformed or ambiguous replies, and only exact requested usernames are
returned. HQ's create-time uniqueness check remains authoritative. Worker POST
and PUT own a 30-second deadline through body reads, refuse redirects, and require
201/new-ID and 200/exact-ID acknowledgements respectively. A timeout, unreadable
body or malformed acknowledgement may have landed; return that uncertainty with
no response body in logging so the provisioning caller preserves its credential.

**The generated app shell carries the fields Nova authors, and in three keys
the target's own part beside them.** HQ's update is an overlay merge
(`_merge_source_into_app`): a field present in the source overwrites the HQ
app's value, and an absent one is retained. So app content Nova does not
author yet (`case_sharing`) and target-owned settings and state
(`secure_submissions`, the build/release metadata, and the rest of HQ's app
Settings page) are never emitted by `hqShells.ts::applicationShell`.
`cloudcare_enabled` is where the app runs, written on every update from
`declaresWebApps`; a create takes the plan's answer (`_create_app_from_doc`),
which a first publish reads. Publish writes no `logo_refs`,
and an update takes out only an entry whose only key is `path`
(`targetLogoRefs.ts::withoutPathOnlyLogoRefs`), which HQ's own uploader never
stores. `cc-show-saved` and
`cc-show-incomplete` are app content (`appSettings`), written as a key-level
overlay, and they are the only two profile settings Nova owns on HQ. The
fifteen other explicit settings, constants at today's device behavior, are
seeded on HQ only where the target's profile holds no value (absent, null or
empty) and never written over a value the target holds, because Nova does not
yet hold them as settings an author sets, and writing over a person's choice
in HQ would undo it at every publish; the local `.ccz` writes all seventeen.
In `translations`, of the keys HQ generates Nova writes only
`app.display.name` and `homescreen.title`, each only in a language whose
localized app name differs from `appName`, and it writes every current
language's name; `android.package.name.*`, every runtime UI-catalog key and
any other key keep HQ's value verbatim, and a generated key is never carried
(`appStringKeys.ts::translationKeyOwner`): Nova holds no UI string overrides.
`add_ons` sets needed slugs `true` and keeps the rest; `auto_gps_capture` is
`true` for a Connect app and otherwise omitted. `profile`, `translations` and
`add_ons` are the three keys an update projects against the target's current
value (`targetOverlay.ts`), and an update carries `profile` whenever a
projected key differs from what the target holds, under any Search advisory.
Adding any other shell field means deciding whether Nova authors it, because
every emitted field stomps the target's value on every republish.

## Not-yet-modeled

HQ features the pipeline does not cover yet — the validator's `app`/`module`/`form`/`field` rules gate additions as they land:

- Shadow modules, parent-select cycles
- Smart links, case list field actions
- Sort field format regex, multimedia
- Itemset `<copy>` mode (lookup-backed selects emit value/label itemsets)
- Repeat homogeneity

### Named entry points

`entryPointProjection.ts` shares the form-link frame machinery and projects
against the emission document, so hidden no-matches forms never change the
common selection prefix. Module endpoints include the destination's common
selections; case-list endpoints omit only the final selection, and are refused
when that does not faithfully open a list. A formless module keeps its actual
module command. No-matches registration forms never admit an endpoint.

`entryPointSuite.ts` mirrors HQ `EndpointsHelper`: one argument per selectable
case datum, ordered claim push frames and resolvable remote-request commands,
then a navigation push. Collection arguments use the selected-entities instance;
computed datums remain owned by their entry. Only form endpoints can bypass
relevancy. Inline-search destinations hydrate a known case through the selected
target's case-fixture URL and reuse their entry's claim behavior. Current HQ
hardcodes `$case_id` for scalar endpoint query hydration; a query whose next
selection is another datum cannot be offered as an endpoint. Pre-selection
search-list endpoints likewise cannot bind that argument and are refused.

HQ JSON always emits the owned endpoint IDs (empty after removal) and a form's
relevancy policy (true after reset), so overlay imports remove previous settings.
`entryPointSignature.ts` checks released XML strictly and fingerprints the
endpoint plus referenced navigation definitions. It normalizes only explicitly
provided working/build app IDs in known search/fixture URL slots, preserving the
server and project space; labels do not define endpoint identity. Stored signatures
retain that format. `endpointSignaturesMatch` validates both stored shapes and
compares known XPath slots through the Lezer tree, ignoring only spelling whitespace
and quote delimiters while preserving operands, grouping and literal contents.
Canonical wire formatting therefore does not invalidate an already published endpoint;
ordinary values and URLs remain exact, and malformed or unknown shapes fail closed.

### Manual links into Search

Core defines every frame step against the source evaluation context. HQ's
manual link matcher leaves an inline hydration query pointed at the target's
old selection even when the following datum assigns another value. Native
`StackFrameStep.defineStep` reproduces the resulting missing-value failure
from both emitted suites. `projectFormLinks` uses automatic matching when all
non-query steps are identical to the manual projection, preserving authored
intent while letting HQ bind hydration to the actual source case. Otherwise a
manual query may only retain an existing source selection under the same datum.
`FORM_LINK_SEARCH_CASE_UNREPRESENTABLE` refuses incompatible manual assignments
at both shared mutation gates. Ordinary list destinations retain manual values.

Parent-record selection is explicit on `Module.parentCaseModuleUuid`. Both the HQ `parent_select` and shared session-datum projection read that identity; catalog ancestry and structural menu nesting do not infer it. Flat modules may contain child records and unparented records of the same type. Parent selectors follow direct non-extension child indexes. The existing target-specific HQ refusal for a multiple-parent selector remains; Preview and local CCZ retain their supported union semantics.

### Ordinary datetime case writes

Hidden datetime writers derive their `xsd:dateTime` bind from the effective
case-property catalog. The bind follows the property the Hidden Value writes,
not the type inferred from its calculation, because an `xsd:dateTime` bind
makes Core cast the case's text at form open, and malformed text stops the form.
A Hidden Value that writes nothing binds `xsd:dateTime` only where its calculation is the clock-keeping date (`lib/domain/expression/datePattern.ts::isClockKeepingDate`), as the date-and-time split's joined value is, so Core keeps its clock. Ordinary datetime writes use a sibling text node,
`nova_datetime_<question>` (`xform/datetimeCaseValue.ts`, named by the
allocator), as their HQ action question path. HQ creates
untyped case-update binds, where Core would otherwise wrap a Date as DateData
and lose its clock. The sibling formats the unpacked typed value; Core's
`format-date(node-set)` itself rounds typed dates, so `coalesce` unpacks first.
An authored operation's write to a datetime property uses the same calculate on
an untyped leaf (`datetimeCaseValueExpression`).
Blank answers remain blank, and sibling relevance follows the source question.
The sibling stays inside the same group/repeat and is derived wire, never an
authored field. Native CCZ and HQ-regenerated submission tests prove saved
instants, active blank clearing and excluded-answer omission. Generic XPath
string conversion and ordinary preload precedence are unchanged.

Typed form case references share `emitCasePropertyWirePath` with case lists and
queries after selecting the own or ancestor record. Identity, owner and lifecycle
status use attributes; external ID remains Core's copied child property.
`StandardCaseReadsRuntimeTest` executes all supported metadata reads in the exact
CCZ against native Case instances, including a closed parent.

## Case-backed question choices

`caseOptions.ts::caseOptionsNodeset` lowers the typed cases source to a standard
casedb itemset. Values are @case_id; label properties use the shared wire-path
mapper, including attributes for standard metadata. Both CCZ and HQ source forms
use the same lowering. Candidate records use immediate-scope relationship joins:
itemset current() is the QUESTION, never the candidate. `form-case` resolves
separately through the form's selected-case bindings.

`caseOptionsSource.ts` checks declared source/label identities, scalar selected
record scope, and the same earlier/current-or-enclosing-repeat answer rule as
lookup filters. It dry-runs `toWire` to reject unsupported relation shapes before commit. This adds no report instance or arbitrary nodeset
source. Core's ItemSetUtils::populateDynamicChoices evaluates the nodeset in the
question context and the label/value in each candidate context; CaseInstanceTreeElement
reads local case storage. The native case-choice family checks CCZ and HQ-regenerated
forms with duplicate names, changed earlier answers and final-only attendance effects.

Vellum's `src/itemset.js::Itemset.itemsetData.validationFunc` requires the
`lookup_tables` privilege for every dynamic itemset, including casedb sources.
HQ's build-only `FormBase.has_fixtures` check does not detect those; the proof
configuration derives the editor privilege from the emitted itemset element too.
