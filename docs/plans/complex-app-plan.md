# Complex app plan

Nova's plan for building complex CommCare apps: lookup tables, display
conditions, case operations, case tiles, media capture, users and locations,
automations, and HQ deployment.

This is the only planning document for that program. It describes the system as
it is today and indexes the work that remains. Its primary sources are the two
research memos in `docs/research/` — `advanced-case-actions.md` and
`commcare-locations.md` — which stay as evidence; where a memo and this document
disagree, this document wins. It carries no history: what shipped, when, in which
PR, and against which revision lives in git. When behavior changes, this file
changes with it in the same PR.

Every CommCare citation uses stable names (`file::function`), never line numbers
— upstream lines rot silently.

---

## How to use this plan

The program spans three kinds of file, and each answers exactly one question:

| File | Answers |
| --- | --- |
| this one | what Nova builds today, and which unit owns what remains |
| [`complex-app/00-contracts.md`](complex-app/00-contracts.md) | the delivery, product, architecture, and UX rules that bind every unit |
| the other `complex-app/*.md` files | one remaining unit each: its contract, its binding CommCare facts, what a user observes |

Three rules govern reading them, in order:

- **Open the unit's file before you touch the unit.** The entries under
  [What remains](#what-remains) route you to a file; they do not brief you on it.
  Each one deliberately omits every binding fact, wire contract, and design fence
  the unit rests on — so planning, estimating, implementing, or answering a
  question from an index entry alone produces a confident wrong answer. The
  omitted facts are exactly the ones that decide the shape of the work.
- **Read the contracts file alongside it.** The rules there are stated once and
  never repeated in a unit file. A unit implemented without them will pass its own
  acceptance and still violate the program — a version floor, a draft state, a
  silently adopted remote resource, or a workspace masquerading as app content.
- **Re-verify every CommCare claim in source before you rely on it.** The facts
  recorded here were verified against the Dimagi checkouts at the time they were
  written; upstream moves. Each carries its `file::function` so it can be
  re-verified — never restate one from memory, and never soften one you could not
  re-find.

For shipped behavior, [What is built](#what-is-built) states what exists and why
it takes the shape it does; the code and the nearest subtree `CLAUDE.md` remain
authoritative for how.

---

## What is built

Each section states what exists, why it takes the shape it does, and the
CommCare wire facts that bind future work — with a pointer to the subtree
`CLAUDE.md` that owns the implementation detail. Where a section and a subtree
doc both speak, the subtree doc and the code are the authority for how.

### Canonical authored identity

A Nova UUID has exactly one spelling: lowercase, hyphenated, RFC version 1–8,
with the RFC variant (`lib/domain/uuid.ts::CANONICAL_UUID_PATTERN` — a string
regex rather than a Zod refinement, because `z.toJSONSchema()` carries a
`pattern` into the generated SA and MCP schemas and would silently drop a
refinement, so a model client is admitted against the same rule the store is).
Uppercase is rejected, never normalized; nil and max fail on their version and
variant nibbles. `lib/domain/lookupIds.ts` keeps the three lookup identities on
their own brands and the narrower UUIDv7 pattern.

Nineteen authorable kinds share ONE global identity namespace: modules, forms,
fields, select options, case-list columns, Search inputs, case operations,
worker properties, user types, personas, organization levels, location
properties, automations, and their criteria, setup-only criteria, updates,
recipients, events, and user-data filters
(`lib/domain/authoredIdentities.ts`) — because `blueprint_entities` keys every
entity row by `(app_id, uuid)`, and because a nested identity is both an SA/MCP
address and an expression leaf. App, case, Project, actor/owner, thread, run,
batch, capture-attachment, form-entry, and submission-intent ids stay opaque
protocol or storage values, not authoring addresses. Uploaded assets carry
their own strict `MediaAssetId`; built-in menu icons are closed `nova-icon:`
enums, with the module/case-list family and the form family separately closed.

There is no placeholder identity anywhere: a constructor with no eligible
target is unavailable rather than seeded with an empty or fixture UUID, and a
source tripwire (`lib/domain/__tests__/authoredIdentitySourceTripwire.test.ts`)
fails the build on `asUuid("")` (the parse-and-throw narrowing helper), an
`as Uuid`-family assertion, or a hard-coded authored UUID in production
roots — narrowing helpers validate, they do not cast.

**Topology is closed as well as typed.**
`lib/domain/blueprint.ts::blueprintTopologyIssues` is the one closure proof:
every entity appears exactly once in the membership array that owns it, every
membership entry resolves to the expected record kind and a valid parent, and
every record key equals its entity's embedded UUID. Both ends of
`lib/db/blueprintRows.ts` parse through the same schema, so the domain parser,
the commit gate, and persistence cannot disagree about which topology is
constructible. There is no orphan sentinel and no authorable entity outside
the runnable tree. `lib/domain/CLAUDE.md` owns the detail.

### Organization shape, places, and owner destinations

An app's organization has two deliberately separate stores. The blueprint owns
the shape: a branching forest of organization levels plus one flat catalog of
place properties. Postgres owns the contents: app-scoped place rows whose
parent, level, values, order, archive state, site code, and server-minted UUID
are independently editable without folding a potentially large tree through
the blueprint. Levels and properties are canonical authored identities; level
codes are create-once because they become the location fixture's `@type` and
`{code}_id` lineage attribute names
(`corehq/apps/locations/models.py::LocationType`,
`corehq/apps/locations/fixtures.py::FlatLocationSerializer._fill_in_location_element`).
Property values key by property UUID, so a slug rename rewrites no place, and
the catalog mirrors HQ's shared custom-data machinery with `LocationFields`
rather than inventing a second field model
(`corehq/apps/custom_data_fields/models.py::CustomDataFieldsDefinition`).

A level answers two independent authoring questions. `caseFlow` says whether
workers stand there, whether the level owns cases, and whether assigned workers
also receive descendant-owned cases. `addressBook` says which part of the
organization those workers may see and name. Nova exposes closed, coherent
choices rather than HQ's interacting storage flags: `shares_cases`,
`view_descendants`, and `expand_view_child_data_to` govern case delivery, while
`expand_from`, `expand_from_root`, `expand_to`, `include_without_expanding`, and
`include_only` govern fixture contents
(`corehq/apps/locations/models.py::LocationType`,
`corehq/apps/locations/sql_templates/get_location_fixture_ids.sql`). A place
that owns cases and a place a worker may address are therefore never treated as
the same concept. HQ's location-scoped web permissions remain absent because
they are a console-authorization axis with no device wire representation
(`corehq/apps/locations/permissions.py::location_safe`).

Each persona holds one adjacent assignment value: a primary place followed by
zero or more additional places. Every target must be live and at a level that
accepts workers, and Preview projects the assignment into the built-in location
identity values while leaving them empty for an unassigned persona. The Builder,
SA tools, and MCP tools create and edit the same levels, properties, places, and
assignments; public documentation uses the same Organization vocabulary.

Case ownership is typed rather than authored as a free-form location XPath. A
fixed-place owner stores a place UUID and is admitted only when that live place
owns cases and lies within every applicable persona's address book. An
owner-relative destination stores the destination level UUID plus a typed owner
case expression; admission requires a case-owning destination, the nearest
case-owning ancestor needed for the reverse hop, one scalar destination per
owner, and a destination present in every applicable persona footprint. The
wire compiler lowers those identities to a fixed location id or the exact
flat-fixture lineage lookup. Location terms occupy the entire owner rule, so
they cannot become a subtly wrong arithmetic, name, or nested expression.

**A device's `locations` fixture is HQ's to deliver, not Nova's.**
`FlatLocationSerializer` runs on RESTORE, from the domain's own `SQLLocation`
rows, so nothing Nova exports carries it and nothing Nova could export would:
a `.ccz` is an app, and this fixture is per worker. Nova emits it anyway, as a
TEST ASSET (`lib/commcare/locations/__tests__/flatLocationsFixture.ts`), for one
reason — the lowering has to be provable against the exact bytes a device reads,
and a shape nobody can execute is a shape nobody can check. It is the wire's
specimen, not a delivery path, and it lives beside the test that reads it so
nobody mistakes it for one. It matches
`locations/fixtures.py::FlatLocationSerializer.get_xml_nodes` node for node: the
sorted app-wide index schema, places ordered by `site_code`, one `{code}_id`
attribute per level present-and-empty except for the place itself and each
ancestor, HQ's seven children in order, and one `location_data` carrying every
declared field. It is a RESTORE fixture and never a suite one — it carries
`user_id` and differs per worker, which is exactly what `suiteOracle::checkFixtures`
rejects inside a `<suite>`. The instance declaration that would otherwise void
it silently rides the XForm already: a location term is authorable in exactly
one slot, a case operation's `owner`, and reaches the XForm through the
AST-level accumulator rather than as text, so no authored placeholder question
exists for an author to wonder about.

**The bytes are load-bearing rather than plausible.** One authored rule has two
independent lowerings — XPath over the fixture, and a recursive CTE over
`app_locations` — that share a rule but no code path, so they can drift into
disagreement with no symptom until a device assigns a case somewhere the
preview did not. Over generated organizations, every owner/destination pair the
commit gate admits resolves to the same place id on both sides, with the wire
side evaluated by a Lezer-driven reference evaluator that knows nothing about
organizations. An ambiguous hop is skipped rather than compared:
`assertReverseHopTargetsUnambiguous` refuses that shape and both sides pick
arbitrarily, so comparing them would test two coin flips.

**Export is closed for one owner shape, and no longer for two.** A
`fixed-location` owner emits a Nova place UUID as a literal `owner_id`, which
names nothing on a target domain until a compile path resolves it through the
deployment's location mappings; the ledger holds that mapping and nothing
threads it into emission yet. A reverse hop never needed one: it emits level
CODES, which a publish puts on the project space as `location_type_code`, and
joins them against the case's own `owner_id`, which is HQ's value at runtime.
Both read `jr://fixture/locations`, which HQ builds for each worker from its own
rows on every mode alike — so that half of the refusal was never Nova's to ship,
and pushing the place tree closed it.

Blueprint commits and place writes share the app-row-first lock order. Each
commit replaces the exact set of concrete place-reference edges for persona
assignments and fixed owners, so a concurrent delete cannot strand either;
removing a place-property declaration atomically sheds its UUID-keyed values,
and a level cannot be removed while any live or archived place still uses it
(`corehq/apps/locations/views.py::LocationTypesView.remove_old_location_types`).
Archiving a subtree clears its persona assignments in the same transaction,
refuses when the tentative archive would break either a fixed-place or
next-level case-owner rule, and reports case-owning places before confirmation.
It never reassigns cases: removing the last worker merely leaves existing
`owner_id` values orphaned, matching HQ's warning-only behavior. Because place
rows are keyed by app rather than Project, the authoritative cross-Project app
move carries the whole organization without a second retenant operation.
`lib/domain/CLAUDE.md` and `lib/organization/CLAUDE.md` own the implementation
detail.

### Representable automations and regenerated setup guidance

Nova authors two automation families in one canonical Blueprint collection:
automatic case updates and conditional alerts. Every rule and every nested
criterion, setup-only instruction, update, recipient, schedule event, and
user-data filter has global UUID identity. The Builder, Solutions Architect,
and MCP API edit those exact objects through one granular mutation grammar;
there is no draft object, whole-rule persistence shortcut, compatibility shape,
or second tool schema. Entity-row decomposition persists an automation as a
flat top-level entity, and replay admits the same UUID and ordering laws as the
rest of the document.

The vocabulary follows the two current HTML forms rather than a shared
criteria superset. Automatic updates accept the four value comparisons plus
four date comparisons against case, parent, or host properties, with `ALL` or
`ANY`, at most one standard parent-closed condition, and a separate
server-modified-age switch. Both families accept at most one UUID-backed
location condition plus its descendant flag. HQ's shared runtime and form POST
execute that `LocationFilterDefinition`, although the current visible rule and
alert editors hide its picker; generated guidance states the administrator-path
requirement instead of erasing the condition from Nova. Conditional alerts accept the four value
comparisons plus regex against direct case properties only; they do not accept
date, parent/host, closed-parent, or server-modified conditions.
The standard parent-closed condition has no custom index or extension relationship.
Equality and update literals are exact nonblank, unquoted stored values;
date criteria compare the current date directly with the property date plus a
signed day offset after truncating a datetime to its written calendar date;
regexes are nonempty and portable. Standard metadata stays
in Nova vocabulary in the document, then the setup projection translates reads
and message tokens exactly: `case_type` → `type`, `case_name` → `name`,
`date_opened` → `opened_on`, and `last_modified` → `modified_on`; `case_id`,
`owner_id`, and `external_id` are already the HQ automation names. `case_id`
and `case_type` are implicit text reads for criteria, message templates, update
value sources, and property-backed recipients only. They remain outside the
general case-list property catalog and are refused as update targets. Other
update targets use the projection too, preserving HQ's pre-write equality
check. `status` is refused because Nova's open/closed text is not HQ's boolean
`closed` model field, and standard datetime equality or regex is refused
because HQ compares its datetime object with authored text without coercion.
Restart-on-change and case-property event-time fields accept
custom properties only because their HQ runtime reads `dynamic_case_properties`
rather than any standard scalar field. After trimming, an event-time value
must begin with `H:MM` or `HH:MM`, and the whole value must parse as a time.
Suffixes such as AM/PM or seconds are accepted; blank, nonmatching, or
unparseable values fall back to 12:00 PM. A case update may set case, parent, or host properties from a literal
or property value and may close the case. HQ's deprecated
`RUN_AUTO_CASE_UPDATES_ON_SAVE` is deliberately absent because it is one
project-wide switch that evaluates every active update rule for a saved case
type, not a per-rule setting. A conditional alert carries the
closed case-relative/generic/custom recipient union, SMS/email/survey/Connect/
registered-custom content, immediate or timed schedules, and optional
user-data or usercase filters. Web users are not representable recipients, and
Connect content excludes the case-relative, case-property-email, and case-group
recipients that HQ refuses. Checkbox-style, case-property, and custom
recipient kinds are singletons; list-backed recipients keep unique concrete
targets. Descendant controls require a location recipient, location-level
filters require descendants, concrete HQ worker/group IDs are trimmed and
nonblank, and user-data filters have one structural value list per worker
property. A value is either an exact literal, including empty or whitespace, or
an explicit custom case-property reference carrying `(caseType, property)`
identity. Brace-wrapped literals are refused because HQ would execute them as
case lookups. Every triggering case must carry each referenced property because
HQ indexes `case_json[property]` directly and raises if it is missing. HQ
applies filters only to `CouchUser` contacts, so the canonical gate excludes
case, parent/child-case, case-email, case-group, and registered custom
recipients whenever filters exist; known non-users bypass the filter and a
custom handler's runtime type cannot be proven. The guide emits exact JSON when multiple keys/values or exact
blank/whitespace values require HQ's system-admin-only JSON mode on a new alert.
IVR and SMS/callback survive only so a historical
configuration remains representable; current HQ refuses new activation, which
the Builder and guide state rather than silently treating them as deployable.
Registered custom recipient/content handlers must exist on the target instance,
and the guide states HQ's additional system-administrator requirement to save
an alert that uses either handler; project-admin access alone is not enough.
There is no push-notification arm and no untyped escape hatch
(`corehq/apps/data_interfaces/models.py::AutomaticUpdateRule`,
`corehq/messaging/scheduling/models.py::Schedule`).

Message subjects, bodies, and rich HTML source store an ordered structural
template: literal text parts, explicit case-property scope and
`(caseType, property)` identity parts, and closed case-owner/recipient context
property parts. Typed or pasted `{case.foo}` text remains literal and is never
reparsed; the setup projection doubles literal braces before HQ's Python
Formatter evaluates the result. The Builder inserts references explicitly,
SA/MCP read and write the same canonical part union, property renames rewrite
only identity-bearing case leaves, and the generated guide projects them
one-way to HQ's current `{case...}` / `{recipient...}` token spelling.
Custom case properties named `owner`, `host`, or `last_modified_by` are refused
in every case/parent/host message scope because HQ's Formatter context shadows
them with framework objects.
Registered custom handlers and setup-only conditions must carry exact
trimmed nonblank values; UI instructions remain placeholders, not saved data.
Setup-only criteria distinguish UCR filters from registered custom criteria so
guidance can require `CASE_UPDATES_UCR_FILTERS` for the former and an HQ system
administrator for the latter.

Email content targets exactly one current HQ form. A plain-text body requires
the domain-level Rich text emails toggle to be off. A rich-text body requires
it on and stores only the submitted HTML source: HQ sanitizes supported markup
and CSS, rewraps the body, and derives the plain-text alternative, so Nova does
not store an independently authored plaintext body or promise byte-exact HTML.
All email events in one schedule use the same body form because the toggle is a
domain-wide prerequisite.

Every conditional-alert schedule also maps to one form the current HQ HTML
editor can save and uses its single schedule-wide content type. Immediate events after the first observe its five-minute tick.
Custom Daily events share one timing mode and satisfy ordering, separation, and
random-window rules; Weekly and Monthly schedules use the UI's shared timing and
content form, with their exact repetition, offset, and day sets. The canonical
zero-based Custom Daily day is projected to HQ's one-based event row, while a
Monthly day already uses the UI's 1–28 or -3–-1 value. Weekly and Monthly day
pickers exclude selected siblings, normalize event order, and stop adding when
their closed choices are exhausted. Weekly days remain runtime offsets from the
start weekday; the Builder labels their projected absolute weekdays and remaps
offsets when the start changes so existing selections retain their meaning. A
specific-date Custom Daily guide omits HQ's hidden start-offset control, and a
specific-date Weekly guide explains that HQ derives the hidden start weekday
from that date.
Dates use Nova's calendar picker, times use
locale clock entry with canonical storage, and repeated-row removal preserves
keyboard focus across all rule families. Survey reminder totals
remain below expiration and partial case updates cannot be selected without
partial submission. Timed reset-on-property-change requires a rule-trigger
start. Setup guidance selects **Immediately** only for one zero-delay event and
**Custom Immediate Schedule** for delayed or repeated immediate events.

Preview presents a read-only count over the same real open case rows used by the
running app. Nova's AST-to-Kysely boundary can exactly lower each kind's
property comparisons, including automatic-update parent/host reads, plus its
closed-parent relation and each location condition's direct/subtree location
owners plus personas whose primary place is in that set; the outer query
always excludes closed cases and relation walks retain app/Project tenancy.
Equality matches only an exact stored string; numbers, booleans, objects,
arrays, null, and missing values never equal the configured string and satisfy
inequality. Parent reads resolve the depth-one `parent` identifier regardless
of relationship. Host references resolve the declared canonical extension only
when no advanced case-operation link can add a second extension relationship to
the automation case type; otherwise the app gate refuses host-scoped criteria,
update targets, update sources, and message case-property parts because HQ's
host selection is unordered. The extra extension link and parent scope remain
valid. Every host-scoped reference also requires exactly one live
extension at runtime. Retained extra extension indices make the current-match
count unavailable, and HQ does not define which extension it chooses as the
host. A missing parent/host relation does not satisfy either comparison.
Date comparisons use the same relation resolver. They take an ISO datetime's
written calendar component before applying the day offset, matching HQ's
`.date()` behavior without a Postgres session-timezone conversion.
Whitespace-only strings count as blank and regex evaluation applies only to
stored strings, matching HQ instead of coercing JSON scalars.
UCR filters, instance-registered custom criteria, and HQ server-modified age
have no honest local evaluator, so the first two are distinct setup-only kinds and every
omission is named beside a partial count. Preview never updates a case, sends a
message, advances a schedule, or implies that current matching predicts HQ's
next sweep.

Each read regenerates a human-applied setup guide from current identities and
names. HQ provides HTML setup pages only (plus the conditional-alert content
spreadsheet); no REST resource exists for rules, alerts, or schedules. Publishing
therefore does not install an automation, and changing or removing one in Nova
does not claim to alter a manually configured HQ rule. The guide carries the
exact HTML route templates (`/a/<domain>/data/edit/automatic_updates/` and
`/a/<domain>/messaging/conditional/`) plus the actual gates and runtime facts:
survey content resolves its canonical Nova form UUID to the current published
`app > module > form` picker path rather than presenting that UUID as an HQ
identifier; the required default-language field chooses **Project Default**
when Nova stores no code, and an explicit code names the target-project
language prerequisite. The remaining setup facts are exact:
case updates require Data Cleanup (Pro+), alerts
require Reminders Framework (Standard+), SMS adds Outbound SMS at send time,
SMS Survey additionally requires Inbound SMS access, and Connect content
requires the `COMMCARE_CONNECT` domain toggle plus every resolved recipient
being a CommCare mobile worker with an active PersonalID link at runtime,
the hourly task visits each project once daily at `auto_case_update_hour`
(midnight UTC by default), and the default halt threshold is 10,000 updates per
project, case type, and database partition per run. HQ checks that threshold
between cases, so the final case may carry the total above it before the run
stops. The unrelated 50,000 outbound-SMS
daily limit never appears as an automation cap. A zero-ordinary-criterion claim
cleanup rule remains constructible with only server-modified age plus close,
and its guide warns that the boundary is latest server modification, not a
business claim date. `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`,
`lib/case-store/CLAUDE.md`, `lib/agent/CLAUDE.md`, and
`components/builder/CLAUDE.md` own the implementation detail.

### Expressions and prose store identity; text is a projection

Every XPath-bearing slot holds the canonical `XPathExpression` AST
(`lib/domain/xpath/ast.ts`): verbatim source in `text` runs, and reference
leaves that carry identity — `field-ref` and `path-ref` hold the target field's
UUID, `user-property-ref` a Nova worker-property UUID, `case-ref` a
`(caseType, property)` pair, `user-ref` an external CommCare/session name.
`path-ref` persists no depth-dependent bytes, so a move that changes a field's
depth changes only the printed projection. There is no stored arm for an
unresolved, contextual, or malformed hashtag — the parse boundary reports
those and the gate rejects them, so a dangling reference can never sit in a
document as UUID-shaped authored XPath.

Every reference-capable field label, hint, help, validation message,
select-option label, and case-property catalog display default holds a
`ProseTemplate` (`lib/domain/prose.ts`) — typed parts over `text` plus the
four reference kinds. A literal hashtag is text; a reference is a part;
adjacent text runs are noncanonical and reject, so one authored value has one
representation. Indexing, validation, rename and move, retirement, Preview,
and emission all walk those parts structurally — nothing scans a string.

`(caseType, property)` pairs and external CommCare/session names are the two
deliberate name-backed references: they are identities Nova does not own.
Everything else resolves through a UUID, which is why renaming, moving, or
reordering an object rewrites no stored expression.

**A person still types and reads `#form/first_name`.** The CodeMirror surface
prints current names from identity and parses once, at commit
(`lib/doc/expressionText.ts`); nobody is asked to type, read, or repair
`#form/<uuid>`. `projectXPath` and `projectProseTemplate` are the human
projections and render `[reference needs repair]` for a reference they cannot
resolve — never the UUID; `printXPath` and `printProseTemplate` are the strict
twins wire and runtime callers use, and throw on the same identity rather than
emit a guess. `proseTemplateText` returns only the literal typed characters
and is documented as NOT a projection — it exists for search and comparison,
where matching what was typed is the point. The prose editor is structural
(`lib/tiptap` — one inline atom per reference part; ordinary typing and paste
always produce text, and the `#` suggestion menu is the one path that inserts
a reference), and a value that does not survive the template ⇄ editor round
trip is a validator finding rather than an assumption.

Search-input references are identity too: Predicate and ValueExpression store
`{ kind: "input", searchInputUuid }` (`lib/domain/predicate/types.ts`),
resolved to the input's current saved wire name only at projection. Which
runtime evaluates a rule is a separate authoring axis: `EvaluationTarget`
(`components/builder/shared/editorSchemas.ts`) is `on-device`, `case-search`,
or both, and an absent value means the STRICT `on-device` one — a surface that
forgets it then offers less, visible and repairable, rather than offering a
choice the gate would bounce. A case-list filter in a search-enabled module
carries the both-runtimes value, since the same stored rule emits to the
device nodeset and the remote CSQL query and must satisfy both oracles.

Standard case metadata has one Nova vocabulary — `case_name`, `date_opened`,
`external_id`, `last_modified`, `owner_id`, `status`, `case_id`, and
`case_type` (`lib/domain/standardCaseProperties.ts`).
`lib/domain/casePropertyName.ts::authoredCasePropertyNameSchema` owns the
grammar and rejects CommCare's detail aliases `name`, `date-opened`, and
`external-id` outright; there is no alias-coalescing helper anywhere, because
a runtime that accepts two spellings has two representations. Every catalog,
expression-leaf, writer, column, Search, and SA/MCP surface uses that one
schema; a field's local `id` does not, so any survey question may still be
named `name`. A different CommCare spelling exists only as a one-way
`lib/commcare` output projection.

### Field id, case writes, and app-wide property rename

A field carries three independent facts: its immutable `uuid`, its local
question/path `id`, and — on eligible kinds — an optional
`caseWrite: { caseType, property }` (`lib/domain/fields/base.ts`). Changing
`id` changes the question node and the friendly projection and nothing else;
changing or clearing `caseWrite` retargets exactly one writer; `moveField`
preserves `id` and rejects a destination sibling collision instead of
auto-renaming. There is no `renameField` mutation arm and no before/after
heuristic that reads a local edit as global rename intent.

`lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory` is the one
form-tree walk that assigns writers to case actions, grouping them into the
primary action or a child-create action identified by
`(caseType, nearest repeat UUID)` — stable UUID identity, never a rendered
path or mutable id. Every consumer takes those exact writers and buckets
rather than reclassifying fields;
`lib/commcare/caseWriteAdmission.ts::assertAndProjectCaseWriteInventory` is
the sole semantic-plus-wire bridge. Admission is closed over the bucket that
is actually emitted:

- A survey, or any form with no case action, rejects every binding instead of
  storing a writer the wire would ignore. At most one field may write each
  property per bucket.
- Registration and every derived child-create bucket require exactly one
  `case_name`, emitted in `<create>`, and admit at most one `external_id`,
  emitted in the same block's `<update>`. Followup and close forms may bind
  exactly one primary `case_name`, emitted as `<update><case_name>`, because
  CommCare accepts a name update on an existing case.
- A writable destination is exactly the module's own case type or a declared
  type whose `parent_type` is that module type; a sibling, parent, grandchild,
  unrelated, or unknown type rejects and never becomes a child bucket.

Two projections are deliberately one-way. Nova's `case_name` becomes HQ
FormActions' private `name` key (`lib/commcare/formActions.ts`), which the
XForm lowering turns back into `<case_name>`; `name` is never accepted as Nova
input. `case_name` and `external_id` both route to dedicated `cases` columns
and never the JSONB document. Both pass one value contract before wire or
storage (`lib/domain/caseScalarText.ts`): strip boundary UTF-16 code units
U+0000 through U+0020 exactly as Java `String.trim()` does, then enforce
CommCare Core's 255 UTF-16-unit cap. A normalized blank `case_name` rejects;
an active blank `external_id` is a real `""` scalar write, distinct from no
write at all.

**App-wide case-property rename is one explicit semantic command.**
`renameCaseProperties` is the only mutation allowed in its batch, its relation
is interpreted simultaneously against the batch-start document
(`lib/doc/casePropertyRenames.ts`), and one command rewrites every carrier at
once — writers, operation writes, typed leaves, catalog, case-list and Search
configuration, schema intent, and saved rows. Chains, swaps, and cycles are
valid; many-to-one merges are not; the inverse relation is the sole undo
command. Because two Blueprint snapshots cannot prove that intent,
`lib/doc/diffDocsToMutations.ts` refuses to guess — a rename-shaped endpoint
diff throws unless the caller supplies the recorded command — and the store
keeps admitted command batches as an ordered queue, so document equality can
never elide a rename followed by its inverse. The binding rule lives in
[the contracts](complex-app/00-contracts.md#identity-and-references);
`lib/doc/CLAUDE.md` and `lib/case-store/CLAUDE.md` own the mechanics.

The builder keeps the two gestures in different homes: the selected field's
**Saves to** chooser retargets one writer (every candidate dry-run through
`lib/doc/caseWriteChoices.ts::caseWriteChoiceVerdict`), while the app-wide
**Case data** manager owns the **Case properties** rename dialog — the only
builder surface that changes property identity. `content/docs/mcp/tools.mdx`
carries the callable contract; the ordinary guides teach only the visible
workflow and carry no UUID material.

### One mutation dialect

`mutationSchema` (`lib/doc/types.ts`) is the single grammar for the builder,
SA, MCP, commits, durable rows, events, streams, diffs, undo, and replay.
There is no second canonical schema and no whole-catalog `setCaseTypes` —
catalog creation and edits use only the granular kinds.
`lib/doc/mutationWireRegistry.ts` derives every semantic leaf and nullable
slot from that schema and pins both inventories in checked-in snapshots, so a
new kind or patch key fails CI until its final meaning is reviewed.

`lib/doc/mutationAdmission.ts::admitMutationBatch` is the one shared boundary
in front of it, and on every path it is the outermost mutation operation:
nothing — route schema, dedup latch, reducer, saga, DDL, or side effect —
observes a raw batch first. It safely detaches the proposed batch without
invoking accessors or serialization hooks, proves it is a JSON data tree,
round-trips it through JSON and the schema, and requires the schema output to
be exactly the same JSON value — the schema may validate, never default,
coerce, strip, or transform. What travels onward is the detached, deep-frozen,
branded tree, never Zod's output and never a caller-owned object. Failure is
`MUTATION_WIRE_CANONICALITY_INVALID` (soundness), whose safe details are a
nullable `mutationIndex`, an RFC 6901 pointer, and one of six stable reasons;
the HTTP surface answers `400` non-retryable, and the reconciler maps it to a
protocol failure — retain every local edit, retry nothing, advance no cursor,
freeze editing. It is never a retryable collaborator conflict.

`evaluateCommit` (`lib/commcare/validator/gate.ts`) takes the complete
candidate plus the exact Project lookup snapshot — no previous document and no
allowance for a finding that happened to exist before this commit. An empty
batch does not bypass validation. `(app_id, batch_id)` idempotency is
content-bound (`lib/db/commitGuard.ts`): an exact match returns the existing
sequence with no second reducer run, and any difference raises a terminal
`mutation_batch_id_collision`. Clearing an optional slot is always an explicit
`null`; an own `undefined` is invalid everywhere, because `JSON.stringify`
drops it and the stale value would reappear on the next save.
`lib/doc/CLAUDE.md` owns the write surface, and a lifecycle source tripwire
(`lib/doc/__tests__/mutationLifecycleSourceTripwire.test.ts`) classifies every
production admission/reducer/writer entrypoint and fails CI on a new
unclassified one.

### The permanent app-change log

`app_changes` is the durable, append-only edit history and the multiplayer
stream. It has exactly six kinds — `autosave`, `mcp`, `chat`,
`blueprint-migration`, `fold-baseline`, and `project-move`
(`lib/db/types.ts::APP_CHANGE_KINDS`) — and their shape is enforced in
Postgres by admission trigger and CHECK constraint, not only in TypeScript;
runtime holds `SELECT, INSERT` and nothing more.
`app_change_fold_baselines` stores the complete canonical snapshot, a
database-computed digest, and the app's Project at that sequence; any UPDATE
or DELETE raises, and runtime holds `SELECT` only. Canonical folding
(`lib/db/canonicalMutationFold.ts`) starts from the greatest baseline and its
stored Project, strictly replays every later mutation-bearing row, applies
each Project move only when its source matches the rolling Project, and must
finish at the current state and `apps.project_id`.

The browser frame is deliberately narrower: reconciliation accepts only
`autosave | mcp | chat` (`lib/collab/mutationFrame.ts`), and a post-cursor
suffix containing a server-only kind emits zero mutation frames — the client
reauthorizes and reloads instead, without advancing the delivered cursor, so
it never learns a server-only kind. `lib/db/CLAUDE.md` owns the trigger,
grant, and folding detail.

### The frozen cutover migration

`lib/case-store/migrations/20260728000000_canonical_identity_foundation/` is a
self-contained historical unit — its own grammar, occurrence manifest,
transform, repair authority, and a generated frozen validator — with one
public door, the sibling Kysely entrypoint, whose `down` throws a forward-only
error. Two tripwires keep it history rather than a second live dialect, and
both must keep passing:
`lib/case-store/migrations/__tests__/frozenPersistableBlueprintArtifact.test.ts`
pins the generated validator's exact SHA-256 and proves the tree imports
nothing outside itself but four allowed packages, and
`lib/doc/__tests__/mutationLifecycleSourceTripwire.test.ts` proves the
reverse — no steady-state source may import anything BEHIND that door,
resolving specifiers rather than matching text, because a substring test
silently passes the relative imports of the modules physically next to the
tree.

That separation is the whole point. Steady state has one representation: the
frozen tree may recognize a historical byte shape, and every live schema,
reader, reducer, writer, UI, Preview, SA/MCP surface, and emitter rejects it.
Runtime code and documentation do not call a supported shape "legacy" — an old
shape is either consumed once, there, or it is refused.

### Lookup tables

Lookup tables are Project-scoped app-state data with stable table, column, and row
UUIDs, typed values, fractional row ordering, raw CSV replacement, exact Postgres
byte accounting, optimistic table revisions, and a Project-wide realtime
invalidation clock. `lib/lookup` is the sole persistence boundary and speaks Nova
vocabulary only; `lib/lookup/CLAUDE.md` is its contract.

Caps are 5,000 rows and 8 MiB per table, measured as exact Postgres bytes rather
than estimated. These bound what a client can be asked to load, which is what
makes client-side choice evaluation viable.

Table schema governance — deleting a table, removing a column, retyping a column —
lives in `lib/lookup/schemaGovernance.ts::applyLookupSchemaGovernanceInTransaction`.
Each requires the `delete` capability and zero applicable reference edges, proved
transactionally rather than by scan, and reaches authors through the three
governed actions in `lib/lookup/actions.ts`.

### The Project data workspace

Project data is a URL-owned builder workspace at
`/build/{appId}/project-data[/{tableId}]`, reachable from the expanded
structure sidebar's footer, the collapsed rail's footer, and therefore the
handset structure drawer. It is deliberately not a child of the structure
tree: the tree represents the runnable app, and a lookup table belongs to the
Project and is shared by every app in it. The `Location` kind carries no
`moduleUuid` at all, so the boundary is enforced by the compiler rather than
by convention; `project-data` is a reserved first path segment that names no
blueprint entity, so it is always valid and always survives recovery. Preview
from the workspace leaves for the app home — nobody using the app opens a
lookup table. Every screen states that a change affects every app in the
Project, as a permanent subtitle rather than a dismissible notice, because a
deep link never passes the door.

**Editing is row-shaped, and the row is the unit of concurrency.** The grid is
a real `<table>` in pages of 50; a selected row edits in the rail with one
correctly-typed control per column; bulk change goes through atomic CSV
replacement. A table's optimistic token is
`max(definitionRevision, rowsRevision)`, so any concurrent change invalidates
it; a refused write retries only when a fresh read proves the edit is still
the same edit — byte-identical row AND unmoved column definitions — while CSV
replacement never retries against a moving target, and a retained draft or
conflict survives every branch, including deletion of its row or its whole
table. Same-named recreation does not rebind anything: table UUID is identity.

**A destructive change names the apps it would break, before it happens**
(`lib/db/lookupReferenceEdges.ts::readLookupReferencingApps`; a soft-deleted
app still holds its edges, so it is named with its trashed state rather than
omitted). That read is advisory by construction — a scan races a concurrent
app commit — and the transactional edge check under the table lock remains the
authority. The advisory preflight fails closed: a failed reference query never
becomes an empty blocker list, and the UI never contradicts a refusal with
"No app uses it."

`components/builder/CLAUDE.md` (§ Project data) owns the controller, draft,
conflict, CSV, temporal-control, and dialog mechanics; `lib/lookup/CLAUDE.md`
is the persistence contract. `content/docs/project-data.mdx` is the
user-facing guide.

### Exact reference edges

Every app carries an exact, transactional edge set naming the lookup tables and
columns its blueprint references (`lib/db/lookupReferenceEdges.ts`). Composite
foreign keys make a referenced table undeletable and a referencing app unmovable;
`lib/db/apps.ts::repairLookupReferenceEdges` rederives the set from the committed
blueprint without touching history or the mutation sequence, and
`scripts/scan-lookup-reference-edges.ts` reports mismatches read-only.

Edges are derived state. Any authoritative commit reconciles them completely, so
an unrelated edit to an app with stale edges converges them.

### Display conditions

Modules and forms carry a typed `Predicate` display condition, validated by
`lib/commcare/validator/rules/displayConditions.ts` and emitted through
`lib/commcare/suite/displayConditions.ts`.

The validator's restrictions are wire-forced, not stylistic:

- A relevancy expression that throws at render takes down the **entire** Web Apps
  menu screen, not just the offending item — `MenuLoader::getMenuDisplayables`
  catches and `MenuScreen::init` rethrows at screen level. Every condition is
  therefore boolean by construction and checker-gated.
- HQ rejects any casedb reference in a form filter whose module does not
  guarantee a selected case (`menus.py`, via `xpath_references_case` after
  interpolation). Module filters skip that check but hard-reject `#case`,
  `#parent`, `#host`, **and** bare-dot case shorthand
  (`app_manager/xpath.py::_ensure_no_case_references`), so an emitted module
  filter must be dot-free as well as hashtag-free.
- Counts, `exists`/`missing`, and non-self reads are refused.

The form-condition evaluation locus for a case-first module is the case-list
screen after selection — including suppressing the single-form auto-continue;
the module screen's form list is a gating site only for the forms-first flow.
That locus is a product requirement as well as a validator rule, because it
decides what the editor may offer: `CaseDataScope` is `per-case` (case rows
and their relatives), `selected-case` (one chosen case's own properties —
relationship walks, counts, and presence tests withheld with the scope's own
explanation), or `global` (no case at all). A module condition and a
forms-first form condition are `global`; a case-first form condition is
`selected-case`. `PredicateEditProvider` composes the matching admission
oracle in front of any caller oracle, so no surface can silently offer a read
the commit gate would reject.

A second, independent axis governs **Never match**.
`DISPLAY_CONDITION_ALWAYS_FALSE` refuses a navigation condition nobody could
satisfy, so the editor withholds `match-none` there — but the same shape is
legitimate authored data in the Search-action carrier, which shares the
`global` scope, so `allowsNeverMatch` is its own axis rather than a reading of
the scope. A saved `match-none` always renders and re-emits — the flag governs
the add and replace menus, never round-tripping. Every *single* choice the
editors offer is admissible, but "can never match" is a property of the whole
tree — an author can still compose one deliberately by excluding an
always-true rule — so the condition canvas commits through the inline gate
flavor and shows a refusal beside the rule.

Display conditions are UX, not access control: a deep link with
`respect-relevancy="false"` traverses menus and cases that conditions would
hide, and the authoring surfaces say so in as many words.

Removing a condition is an explicit `null` on the `updateModule` /
`updateForm` patch (`lib/doc/displayConditionMutations.ts`), never an omitted
key or `undefined`. Each carrier is authored on its own URL
(`/{moduleUuid}/condition`, `/{formUuid}/condition`) with the shared
`PredicateWorkbench`; `components/builder/CLAUDE.md` (§ Display conditions)
owns the surface and Preview-entry behavior.
`content/docs/display-conditions.mdx` is the user-facing guide.

### Case operations

Forms carry ordered case operations — create, update, close, with links, renames,
retypes, and owner assignment — validated by
`lib/commcare/validator/rules/caseOperations.ts` and emitted by
`lib/commcare/xform/caseOps.ts`.

Facet legality by action is closed in the stored action-discriminated schema:
`create` requires a new target and a name and forbids rename/retype; `update`
forbids a new target and a name; `close` forbids a new target, name, owner,
rename, retype, **and** links — so unlinking is always a separate operation from
closing, while close may still carry final property writes. There is no
load-tolerant legacy operation arm in the live domain schema; pre-cutover bytes
are transformed before this schema is installed. The `name` restriction is on
the case-operation facet, not on the independent field `caseWrite`
binding: CommCare accepts `case_name` in an existing case's `<update>`, so a
followup/close field may explicitly save that standard property under the
unique-writer admission rules above.

Reserved case types are `commcare-user`, `commcare-case-claim`, and
`user-owner-mapping-case`. Reserved write properties are
`lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES` — HQ's authoring-side
case-reserved-words list plus `name` and `owner_id` — extended with
`location_id`, `hq_user_id`, `external_id`, `category`, and `state`.

`category` and `state` are reserved because the two runtimes disagree about
them. `case_type`, `case_name`, `owner_id`, `external_id`, `user_id`, and
`date_opened` land in the same dedicated slot on both sides
(`CaseXmlParser::updateCase` and `parser.py::CaseActionBase.V2_PROPERTY_MAPPING`),
but `category` and `state` have dedicated client setters and no server mapping at
all, so the same block sets a reserved slot on the device and an ordinary dynamic
property on HQ. A property that means two different things cannot be authored.

The emitter is total by structural construction, and four wire facts force its
shape:

- A case block with **no** `@case_id` is silently skipped server-side
  (`casexml/apps/case/xform.py::has_case_id` gates `_extract_case_blocks`), so the
  write vanishes with no signal. Guaranteeing `@case_id` structurally is
  mandatory, and the failure mode it prevents is data loss, not an error.
- An index-only block whose own case is locally absent NPEs the client:
  `CaseXmlParser`'s index arm calls `loadCase(errorIfMissing=false)` and
  dereferences unguarded. Pairing every non-create block with an `<update/>` (its
  writes, or an idempotent `case_type`) routes through
  `loadCase(errorIfMissing=true)` and yields a clean readable error instead. An
  empty `<update/>` is a no-op on both runtimes. Attachment-carrying blocks share
  the same null-deref shape and the same guard.
- `<create>` accepts only `case_type`, `case_name`, and `owner_id` children and
  rejects extras, so any additional create-time property write emits in the
  sibling `<update>` of the same block.
- Metadata binds are `@date_modified ← /data/meta/timeEnd` and
  `@user_id ← /data/meta/userID`. The meta block exists post-render on both export
  paths, so source-level binds referencing it are safe.

HQ's render pipeline preserves hand-authored case blocks: `FormBase.render_xform`
wraps the stored source and `xform.py::XForm._create_casexml` only appends
FormActions-driven blocks, with its single collision guard reading the direct
`/data/case` child. Operations therefore ride the XForm source on both export
paths, at nested container paths, never at bare `/data/case`.

Authored case ids follow Vellum's repeat-context split: creates outside a repeat
seed `@case_id` via `<setvalue event="xforms-ready">`, while creates under a
repeat use a bind calculate over the per-instance path. Generated UUIDs take the
setvalue path; authored deterministic keys stay live calculate binds.

An owner expression's result lands verbatim and unvalidated in the case block —
the only server-side check is length ≤ 255. Typed owner addressing is entirely
Nova's guarantee.

Operations are authored on the form's own URL — `/{formUuid}/operations`, with
`/{operationUuid}` selecting one — reached from the form settings panel. The
list is the answer to "what does submitting this form do to the case
universe?", the question the platform's own question-scoped surface never puts
on a screen: one row per change, in execution order, each a sentence
(`operationSentence.ts`, a display projection that forks no semantics),
showing the conditions it inherits from earlier changes at rest. The rail owns
the discrete choices and the centre canvas owns every recursive AST; adding is
chooser-first and lands a complete operation the commit gate already accepts,
every existing choice is dry-run through the real planners before it is
offered, and removal names each dependent consumer and the exact slot instead
of offering a delete that would bounce. Sequence is array position: a move
names the operation this one now follows, so a peer's insert cannot shift an
anchor and there is no rank to fence. `components/builder/CLAUDE.md`
(§ Case changes) and `lib/doc/CLAUDE.md` own the gesture, verdict, refusal,
and announcement mechanics.

Which form answers an operation may read is ONE rule with two callers:
`lib/domain/caseOperationScope.ts` holds `operationCanReadFormField` and
`formFieldCanKeyCreate`, the validator calls them, and the answer pickers apply
them — so the offered set cannot drift from the accepted set. `field` terms,
`acting-user`, `unowned`, and `id-of` become authorable in the shared expression
editor only when a surface supplies `formFields` / `operationScope`; absent means
unauthorable, which is what keeps every other surface's round-trip-only behavior
exactly as it was (`operationScopeFailsClosed.test.ts` pins it).

The same vocabulary is authorable through the Solutions Architect and MCP.
`getCaseOperations`/`get_case_operations` projects the ordered sequence with
immutable operation UUIDs and canonical identity-backed ASTs; batch add plus
singular update, move, and remove address operations by UUID, and same-call
references predeclare their final operation UUIDs. There is one mutation
dialect — `caseOperationPatch` carries granular edits, `caseOperationChange`
only add/remove — and the authoritative commit guard tracks operation UUIDs
and write-property/link-identifier sets through the batch, rejecting
peer-deleted targets and same-key peer adds instead of allowing a total
reducer no-op to report success. No tool-side slug/path/id projection or
rewrite layer exists. The operation id, write property, and link identifier
vocabularies share one domain-owned grammar
(`lib/domain/caseOperationIdentifiers.ts`) with the builder, validator, and
tool schemas — ASCII letters, digits, and underscores throughout; an operation
id or link identifier starts with a letter or underscore, a write property
with a letter only — so action-illegal facet combinations, platform-owned case
types, and reserved write properties are unconstructible at the shared tool
boundary.

Lookup-backed predicates and expressions use that same complete canonical AST
on the builder, SA, and MCP surfaces: reads return the lookup UUID leaves and
all three editors may update them without hiding or partially projecting the
operation.

`content/docs/case-changes.mdx` is the user-facing guide.

### Case identity storage

The whole case-identity family — `cases.case_id`, `cases.parent_case_id`,
`case_indices.{case_id,ancestor_id}`, and `parked_case_values.case_id` — is
`text`, because case ids are opaque CommCare wire identities rather than
intrinsically UUIDs. Nova-generated ids default to `uuidv7()::text`. Because ids
carry no time order, the durable default ordering is `(opened_on, case_id)`
ascending. `lib/case-store/CLAUDE.md` holds the detail;
`scripts/scan-case-id-storage.ts` is the durable read-only pre/post scan for the
family.

Client-side, `CaseXmlParser::parse` and `CaseXmlParserUtil::validateMandatoryProperty`
reject only null/empty, and `case_id` is deliberately absent from
`checkForMaxLength`; HQ bounds it by `CommCareCase.case_id` at 255 characters.

### Lookup carriers, table expressions, and itemsets

Selects own one required discriminated `optionsSource`: either `inline`, which
owns at least two fully UUID-identified options, or `lookup`, which owns the
table UUID, value-column UUID, label-column UUID, and optional row filter.
Expressions take `table-lookup` value terms and `table-column` comparison terms
(`lib/commcare/validator/rules/lookupOptionsSource.ts`, `lib/doc/lookupReferences.ts`).
Source switching is a complete atomic replacement — no inactive source survives
a switch, and there is no precedence, clear, or fallback state. Field
duplication remints every inline option UUID while lookup table and column
UUIDs remain references to the same Project resources.

`LookupOptionsSource.filter` is authored in a first-class table-row evaluation
scope: columns from the active table, session/current-user values, and form
answers earlier than the select in effective `(order, uuid)` DFS from the form
root or the current/enclosing repeat. Case properties, relations, and Search
answers are not available in a lookup row. The mounting surface composes that
admission oracle with every caller oracle, and the validator independently
enforces the same boundary at commit. Preview evaluates the filter against
every lookup row and recomputes the choice set when an earlier referenced
answer changes — a value no longer offered is cleared (token-wise for
multi-select) — and the XForm emitter prints the same rule in the itemset
nodeset with `current()` contextualized to the active repeat.

The Solutions Architect and MCP share the canonical identity-bearing domain
schemas: `getLookupTables` / `get_lookup_tables` returns table and column
UUIDs alongside readable names, tags, labels, wire names, and data types —
only the UUIDs are addresses — and `setFieldOptionsSource` /
`set_field_options_source` takes the complete canonical source and atomically
replaces it. Mutable field paths, operation ids, Search names, worker slugs,
lookup tags, column wire names, and positional module/form addresses reject at
the strict schema boundary rather than being resolved into identity.

The local `.ccz` emits the preservable lookup wire. The binding facts:

- A suite-embedded `<fixture>` may sit at any position, requires `id`, stores as
  global when `user_id` is absent, holds exactly one body element, and is
  overwritten on app upgrade (`SuiteParser`, `FixtureXmlParser`).
- `ItemListsProvider` expects the id `item-list:<tag>`, a `<{tag}_list>` wrapper,
  `<{tag}>` rows, and **every** defined field as a child element in definition
  order — an empty element for a missing value. Instances reference
  `jr://fixture/item-list:<tag>` (`generic_fixture_instances`).
- `XFormParser.parseItemset` requires `nodeset` plus `<label ref>` and
  `<value ref>`, and rejects literal items beside an itemset.
- `ItemSetUtils.populateDynamicChoices` resolves the nodeset by declared id, a
  missing one throwing a runtime `XPathException`, and evaluates the predicate
  with `current()` bound to the question node contextualized to the current
  repeat iteration.
- Decimal cells emit exponent-free. Relation tests inside a fixture-row `where`
  anchor on the containing slot's case. `rootCaseId` is honored. An escaped
  column name is a typed rejection (`lookup-row-escaped-column`), never a
  silently mangled emission.

JavaRosa has no XPath-1.0 first-node coercion — a scalar use of a multi-node path
throws (`XPathNodeset::unpack`) — and JavaRosa numeric predicates are **position**
matches, not value matches. First-match lowering therefore carries an explicit
positional `[1]` predicate structurally; coercion will never supply it.

The aggregate embedded-fixture budget is 10,000 rows, 100,000 cells, and 16 MiB of
exact UTF-8 fixture bytes. These are declared Nova policy sized against an
unindexed runtime that materializes XML as object-heavy `TreeElement` nodes; the
cell cap is what bounds that cardinality.

Every export mode carries the data a carrier reads, from one validated
generation. `.ccz` embeds it as suite fixtures; `hq-json` and `hq-upload` build
the fixapi workbook (`lib/commcare/lookup/workbook.ts`), which the direct upload
pushes to the project space before the app and the manual artifact ships beside
the app JSON. The HQ modes carry two size verdicts of their own: CommCare HQ's
whole-workbook row ceiling (`LOOKUP_HQ_PUSH_TOO_LARGE`) and
`LOOKUP_TAG_TOO_LONG_FOR_HQ`, because a data sheet is NAMED for its tag and a
sheet name holds 31 characters while a tag may be authored up to 32.

### Atomic submission and resolved identity

One submission is one transaction. The preview store exposes a single envelope
carrying ordinary form behavior plus advanced operations; the server builds the
`CaseOperationProgram` from the **committed** document, and identity resolves
server-side at the action boundary rather than being folded into a
client-supplied literal. The membership gate precedes the program build,
closing a one-bit cross-tenant survey oracle. Staleness rejects wholesale
rather than degrading: a committed operation-bearing form whose submission
lacks its answer bags, a repeat scope the committed document requires but the
payload omits (a client that knew the repeat always sends it, even empty), and
a missing form answer for an iteration that will actually compile all reject
as stale/skewed — empty bindings would blank-write, and an ordinary-only
fallback would silently skip committed semantics. `lib/preview/CLAUDE.md` and
`lib/case-store/CLAUDE.md` own the envelope protocol and executor detail.

Wire facts the envelope rests on:

- A `case_type` update rewrites only the type field: no property pruning, no value
  casting (`CaseXmlParser::updateCase`,
  `SqlCaseUpdateStrategy::_apply_update_action` / `::_update_known_properties`).
- `owner_id` is first-class mutable in create and update, with `@user_id` as the
  acting user and the create-time fallback owner; `-` is HQ's
  `UNOWNED_EXTENSION_OWNER_ID`.
- Blocks apply create → update → close → index regardless of child order
  (`parser.py::CaseUpdate`, `xform.py::order_updates`).
- An empty index target removes the link (`CaseXmlParser::indexCase`), and
  create-of-existing merges (`acceptCreateOverwrites` is true in every runtime
  caller).
- Formplayer commits a submission's case blocks together with the HQ POST as one
  transaction (`FormSubmissionHelper::processAndSubmitForm`).
- A default HQ domain performs **no** extension-close cascade: the cascade
  (`submission_post` → `casexml/apps/case/xform.py::close_extension_cases` →
  `get_all_extensions_to_close`) runs only under
  `toggles.EXTENSION_CASES_SYNC_ENABLED`, a frozen per-domain toggle that is off
  by default. The envelope closing only its target case **is** faithful device
  parity, and Nova adds no cascade.

### User properties, user types, and preview personas

Three flat blueprint collections answer three separate questions, and the
distinction is load-bearing everywhere downstream (`lib/domain/users.ts`):

- a **user property** is a slot workers carry data in — the app's half of
  CommCare's per-domain custom user-data schema;
- a **user type** is a reusable role template that fills those slots with
  default values;
- a **persona** is a named design/test actor with stable identity that
  *references* a user type and may override individual values. It is who Preview
  runs as.

A **deployed worker** — a real identity on a target HQ domain, with credentials
and its own lifecycle — is deliberately absent. It is owned by a deployment,
created *from* a type or persona, and is not a blueprint identity.
A persona is not an account. An explicit provisioning call makes a CommCare
mobile worker FROM one, carrying that persona's worker information and place
assignment, and the deployment's ownership ledger remembers which account stands
for which persona on which project space. What the app export and upload path
still does not configure is the project space's own custom user-data schema and
its role templates: neither has a REST resource, so both stay setup
instructions.

The builder, Solutions Architect, and MCP API author all three collections
through the same granular mutations and commit gate. Values cross the JSON
tool boundaries as `{ userPropertyUuid, value }[]` and bridge to the
UUID-keyed document record at one boundary; update omission keeps a slot and
explicit `null` clears one, and each changed role/persona value persists as
its own semantic mutation, so concurrent edits to different properties merge
instead of replacing one another. In the builder an absent persona value
inherits its role, an explicit `""` overrides the role with blank, and a
nonempty value overrides it with that value. All normalized identity-keyed
records use own membership and a null prototype, so schema-valid keys such as
`__proto__` and `constructor` survive persistence without inherited properties
masquerading as members; each flat collection's membership array is the only
sequence and is walked, never sorted (`lib/domain/CLAUDE.md`,
`lib/doc/CLAUDE.md`).

Custom worker-information references follow the same stable identity as
role/persona values. Predicate / ValueExpression stores
`session-user-property { userPropertyUuid }`; XPath stores
`user-property-ref { userPropertyUuid }`; every target resolves the property's
current saved slug only when it projects the AST, so a rename rewrites nothing
and takes effect everywhere immediately. The parallel name-backed
`session-user { field }` and XPath `user-ref { property }` arms are the final
vocabulary for CommCare-provided or external fields that have no Nova entity —
not compatibility spellings of the identity arm. The builder exposes the two
as **Worker information** (UUID catalog only) and **Other user field**
(external name only, never inferring identity from text); textual XPath
parsing converts a custom `#user/<slug>` to identity only on an exact, unique,
valid match, and every other spelling stays name-backed permanently
(`components/builder/CLAUDE.md` holds the editor's concurrent-rename rebase
rules). The reference index records both custom arms under one `p:<uuid>`
target, so removing worker information refuses while anything still reads it,
names every exact `(carrier, slot)` occurrence, and never silently deletes
expressions or degrades identity to mutable text; once unreferenced, the same
gated batch clears every role/persona value and removes the property.

The wire facts the shape rests on:

- HQ stores one `CustomDataFieldsDefinition` per `(domain, field_type)`
  (`custom_data_fields/models.py::CustomDataFieldsDefinition`); mobile and web
  users share `field_type='UserFields'`
  (`users/views/mobile/custom_data_fields.py::UserFieldsView`) and split only by
  per-field `required_for`. So one app's catalog compiles to that one
  definition.
- Slug legality is enforced at construction so a push can never fail on identity
  grounds. HQ's Django slug validator
  (`custom_data_fields/edit_model.py::XmlSlugField` lists `validate_slug`) admits
  a leading digit or hyphen, but Nova emits the slug as an XML element in both
  the session and usercase projections. Nova therefore requires a leading
  letter or underscore and admits letters, digits, underscores, and hyphens
  afterward — the intersection that keeps every emitted path representable. The
  remaining clauses are at least one non-digit (its
  `RegexValidator(r'\D', '')`), `SYSTEM_FIELDS` and the
  `commcare` / `xml` prefixes (`models.py::validate_reserved_words`), the
  case-reserved words and case-insensitive uniqueness
  (`edit_model.py::CustomDataFieldsForm.verify_no_reserved_words` /
  `::verify_no_duplicates`), and the 127-character column. `RESERVED_CASE_PROPERTIES`
  is HQ's `case-reserved-words.json` plus `name` and `owner_id`, both already
  system fields, so one list covers every clause. Nova compares it lowercased
  and is therefore marginally stricter than HQ on mixed case (`Name` is refused
  here, accepted there) — stricter never costs a push.
- The restore's `<Registration><user_data>` block injects framework keys **after**
  authored data, so they win collisions
  (`users/models.py::CouchUser.get_user_session_data`): `commcare_project`,
  `commcare_first_name`/`_last_name`/`_phone_number`, `commcare_user_type`,
  `commcare_location_id`/`_ids`/`commcare_primary_case_sharing_id`, plus
  `user_type='demo'` for practice users. `commcare_profile` reaches the same
  block by a different route — `users/user_data.py::UserData._provided_by_system`
  always includes the slot, so it rides in through `to_dict` rather than being
  injected after it. That combined set **is** `BUILT_IN_USER_PROPERTIES` and the
  reserved-name list — there is no second source, and
  `lib/domain/__tests__/users.test.ts` asserts the relationship rather than
  restating it.
- **`user_type` is the one key the restore does not decide.** HQ sends it only
  for a practice user, but the CLIENT seeds it: every
  `commcare-core .../User.java` constructor calls `setUserType(STANDARD)` — a
  plain `properties.put` — and `UserXmlParser::parse` builds the `User` before
  applying any `<data key>`. Both runtimes use that parser
  (`CommCareTransactionParserFactory::initUserParser`; Android subclasses it).
  So an ordinary worker's device holds `user_type = "standard"` and a practice
  user's restore overwrites it with `"demo"`; the key is never absent, which is
  why Preview supplies `"standard"` rather than leaving it out.
- Only three keys are read by the runtime framework: `user_type` (demo
  detection — `commcare-core .../User.java::getUserType`) and `commcare_project`
  + `commcare_location_ids`, read together by
  `formplayer .../UserUtils.java::getUserLocationsByDomain` to drive the local
  case purge in `RestoreFactory`. Everything else in `session/user/data` is
  inert.
- The client's registration parser writes every `<data key>` into
  `User.properties` verbatim — no key restrictions, last-wins on duplicates
  (`commcare-core .../UserXmlParser.java::parse`) — and merges into a retrieved
  user without clearing, so a key deleted on HQ lingers until a full resync.
  Nova documents that staleness rather than simulating it.
- The emitted session lookup is pinned byte-for-byte to
  `commcare-hq/corehq/apps/app_manager/tests/test_suite_remote_request.py::test_required`:
  `instance('commcaresession')/session/user/data/<slug>`. The emitted usercase
  lookup is pinned to
  `corehq/apps/app_manager/tests/data/suite/suite-case-detail-tabs-with-nodesets.xml`:
  `instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/<slug>`.
  HQ JSON, local suite/XForm, and HQ-upload XForm tests assert the exact
  corresponding bytes, including a hyphenated slug and a slug rename against an
  unchanged AST.
- `CustomDataFieldsProfile` sits behind the paid `APP_USER_PROFILES` privilege
  and is deliberately not the provisioning model; a user type compiles to plain
  per-user `user_data` values.

**Every app has a worker's case, whether or not it declares anything.** The
`commcare-user` case type is DERIVED from the worker-property catalog rather
than declared beside it, so it is storable but not authorable: it is absent
from `effectiveCaseTypes` (nothing can create, close, or model it) and present
in `buildCaseTypeMap` (the case store materializes it and the wire reads it).
Its contents come from one derivation with two consumers — Preview's `#user/`
answers and the materialized row — because `#user/` resolves against `casedb`
on the wire, so two derivations would make Preview disagree with a device for
any worker saved once.

The row is Nova-managed. Materialization runs on the commit that changes a
persona, a role, or the worker-property catalog — HQ's "each time a user is
saved" trigger (`sync_usercase.py::sync_usercases`) — plus lazily when a
preview resolves a persona with no row, and the sweep costs zero queries on the
overwhelmingly common commit that touches no worker at all. It diffs like
`::_get_changed_fields`: write only the keys whose value differs, and never
remove one. That is the whole non-clobbering contract — a value a form wrote
through `usercase_update` survives until a persona edit names that same
property. `owner_id` is the persona's own uuid (HQ passes `user.get_id`), the
case id IS the persona uuid so a double sync collides with itself instead of
racing, and removing a persona CLOSES the row rather than deleting it. Two
values are deliberately not written: `case_name` carries the worker's display
name with HQ's own `user.name or user.raw_username` fallback because
`cases.case_name` is `NOT NULL`, and **`external_id` is left empty**.
`external_id` is HQ's READ key for finding a usercase
(`CommCareCase.objects.get_case_by_external_id`, reached from
`CouchUser.get_usercase`); `_get_user_case_fields` never writes it and
`create_usercase` never passes it, so writing it would make an
`external_id = ''` comparison answer one way in Preview and the other in the
field.

**A form can save an answer into it.** `commcare-user` is a third
`deriveCaseWriteInventory` bucket beside primary and child, available on any
form including a survey with no case type of its own, with the fixed usercase
rather than a repeat as its bucket identity — a usercase writer inside a repeat
is refused, because one form writes one worker record. The destination must be
a declared worker property (the slug is emitted as an XML element name), never
a built-in worker field, and never `case_name`: HQ permits writing the name and
its byte oracle asserts exactly that, but materialization owns the worker's
name here, so a form-written one would be silently replaced by the next persona
edit. That refusal is a Nova authoring fence rather than a wire constraint, and
it says so. On the wire this populates `usercase_update` and emits the
`commcare_usercase` block, the computed `usercase_id` datum, and the
`count(…) = 1` assertion — all three gated exactly as HQ gates them on
`actions_use_usercase`, and the datum rides forms only, so Nova's case-list-only
browse entry carries neither. `usercase_preload` stays empty as a stated fence:
`#user/<prop>` already compiles to the identical `casedb` join, and a preload
action would be a second representation of one read.

**The usercase is behind a paid privilege, and the failure is sharper than it
looks.** `app_manager/util.py::domain_has_usercase_access` gates it, and on a
target without it NO usercase rows exist — so the emitted `count(…) = 1`
assertion fails and blocks entry into the form entirely. Not a degraded write, a
dead end. Nova cannot see a target's plan, so authoring stays ungated and this
travels as a publish-preflight attention edge and a line in the setup artifact,
never a refusal.

Two of HQ's `Field` columns are deliberately excluded from constructible state.
`regex` / `regex_msg` sit behind the paid `REGEX_FIELD_VALIDATION` privilege —
`edit_model.py::CustomDataModelMixin.get_field` drops the pattern and keeps
`choices` without it — so an authored pattern would silently not validate on a
stock domain. `required_for` is the mobile/web split, and Nova provisions mobile
workers only: web users arrive through HQ's `InvitationResource`, which resolves
a role by name a user type cannot supply.

Whether a persona satisfies a `required` property is likewise not a document
finding. HQ enforces the flag only when the pushed field's `required_for` names
the user type being created
(`users/views/mobile/custom_data_fields.py::UserFieldsView.is_field_required` —
NOT `edit_model.py::CustomDataModelMixin.is_field_required`, a different
function that returns a bare `field.is_required`), so it is a question about
one deployment target, and gating on it would make marking an existing property
required impossible. The authoring surface says so inline instead.

### Preview identity

`lib/preview/engine/identity.ts` carries **two ids that are not
interchangeable**. `actorUserId` is the signed-in member and the only thing
that ever authorizes; `ownerId` is the CommCare worker the preview acts as —
the `owner_id` stamp on rows it writes and the value
`session/context/userid` resolves to. Keying authorization on `ownerId` would
let authored blueprint content choose whose data a request reads; the split is
pinned by test and carried into the case store, where authorization fences
read the member and `owner_id` / `acting-user` read the worker. Every
persona-aware action authorizes the member, resolves the selected persona once
from the committed blueprint under the same locks, and binds the explicit
pair; a stale or missing persona is a typed refusal behind an explicit
**Preview as me** recovery — never an anonymous or one-frame member fallback.

The identity carries **two readings of one worker**, because the wire has two:
`session` (`SessionInstanceBuilder.java::addMetadata` + `::addUserProperties`)
and `usercase` (`callcenter/sync_usercase.py::_get_user_case_fields`) — same
authored data, different built-in keys (`first_name` there, `commcare_first_name` in the
session block). The three location keys diverge between them, and the
asymmetry is easy to state backwards: `get_user_session_data` writes all three
or none, so the session block omits them while nobody is assigned anywhere,
while `_get_user_case_fields` takes an explicit `else` branch to `''`, so the
usercase always carries them. Preview values are otherwise honest:
`commcare_project` is **absent** in both projections until a deployment target
supplies a domain, the worker's name rides as `case_name` rather than `name`
(HQ pops `name` into the case's name and never writes it as a property),
always-written HQ keys are present-and-empty rather than absent, `user_type`
is `"standard"`, and a **declared** property with no value is
present-and-empty while an undeclared key is genuinely absent — the split a
`= ''` comparison depends on.

The session reading is computed; **the usercase reading is a read of the
materialized row**, not a second computation of the same values. Once a form
can write through `usercase_update`, a computed projection and the row diverge
the moment a worker answers — and they diverge without that, because the
never-remove diff keeps a key on the row after the catalog drops the property
while the projection forgets it. The wire reads `casedb`, so the row is the one
to believe; the derivation survives as the materializer's input.
`lib/preview/CLAUDE.md` (§ Resolved preview identity) owns the full contract
and citations.

**Previewing as a persona shows what that worker's device would hold.** The
identity carries an owner SET beside the single `ownerId` scalar, and the two
are not interchangeable: `ownerId` stamps writes and answers
`session/context/userid`, while the set is the worker's own id plus one id per
case-sharing location group — `CouchUser.get_owner_ids`, whose location half is
(assigned places whose level shares cases) ∪ (descendants of assigned places
whose level views descendants), with the group's `_id` being the `location_id`
itself (`SQLLocation.case_sharing_group_object`). **Preview as me** is a worker
assigned nowhere, so its set is just the member id. Both modes materialize a
usercase, because HQ gives every real worker one and without a row for the
member identity the two modes would answer `#user/<prop>` differently.

That set seeds a restore CLOSURE, not an owner filter, and the difference is
the whole point: CommCare's restore is a liveness fixpoint over the case graph
(`livequery.py::get_live_case_ids_and_indices` — the fixpoint is there, NOT in
`do_livequery`, which only seeds it). A closed case can be in the result while a
closed HOST kills its extension chain. Nova reproduces it as two recursive CTEs
inside the case-store query, and it is applied at every relation hop as well as
the outer scan: restricting only the top level would leave the preview faithful
in the list and wrong one hop down, with nothing to reveal it. Authoring
surfaces — the case workspace, automations, every count that models HQ's
server-side sweep — keep their whole-tenant view; the closure is opt-in by
argument rather than by flag. A held row stays out of the returned list but
still relays liveness through the closure, because parking one property value
must not silently drop an extension subtree from what the preview shows. The
running case list offers a ghosted count of the rows the closure excluded, which
is authoring-only inspection and says which worker's restore it is showing.

Nova's closure is HQ's monotone completion rather than a transliteration.
`classify`'s first branch is order-dependent for an extension edge whose
subordinate is closed, so HQ's own answer changes under permutation on some
graphs; the declarative form is always a superset, never smaller, and identical
on all 45 of HQ's pinned relationship fixtures
(`casexml/apps/phone/tests/data/case_relationship_tests.json`, driven by
`test_extension_indexes.py`). **That file is the oracle, and `livequery.py`'s
module docstring contradicts it** — the docstring's eighth example claims
`a(closed) <--ext-- b <--chi-- c(owned) >> []`, while the pinned fixture of
exactly that shape, `open_child_of_closed_extension`, expects `["a","b","c"]`.
Build to the fixtures.

Deleting a persona never deletes case data: rows it owns keep naming it, and
the confirmation must successfully count every retained row for that owner —
including held rows and retired case types — before enabling Remove; the
dialog offers neither reassignment nor row removal. **This is Nova's own rule,
not HQ parity** — HQ has two different answers and neither is a template for
it. Deactivating a worker, or removing them from the domain, closes their
usercase and leaves their cases alone
(`sync_usercase.py::_get_sync_usercase_helper`). DELETING one is destructive:
`users/models.py::CommCareUser.retire` → `::delete_user_data` soft-deletes
every case the worker owns via `tag_cases_as_deleted_and_remove_indices`. A
persona is a design and test actor rather than a person who left an
organization, and the cases it created are the author's own test data, so
preserving them is the deliberate choice.

### Preview execution

The running preview executes the blueprint in a client-side engine
(`lib/preview/engine`) over real Postgres case rows. There is no mock mode.
`lib/preview/CLAUDE.md` is the engine contract.

- Display conditions evaluate live (`displayConditionEvaluation.ts`), hiding
  conditioned items exactly as a device would, with a "hidden items (N)"
  reveal and a person-readable summary (display-only; forks no predicate
  semantics). Authoring surfaces never hide conditioned items.
- Lookup-backed selects render live filtered choices. Choice rows hold stable
  within one form session, matching the wire's install/upgrade fixture
  semantic, while the builder-session cache refreshes on the Project realtime
  clock between sessions.
- The AST→Kysely compiler (`lib/case-store/sql`) carries `table-lookup` and
  `table-column` arms, so a lookup-bearing case-list filter compiles to SQL.
- Preview runs as the signed-in member or as a named persona, and the two
  modes never blend: the running app always states which identity it is
  showing, and an unavailable selected persona blocks execution until the
  author explicitly switches back.

### Case lists, search, and the case workspace

Every module carries a case-list configuration: one ordered column array carrying
display, sort, calculated, and visibility state together, plus search inputs and
their matching behavior. Predicates are typed ASTs throughout, so a column filter,
a search-input condition, and a display condition all speak the same vocabulary
and all compile to three surfaces — the on-device XPath dialect, CSQL for HQ-side
search, and Postgres for the preview (`lib/case-store/sql`). Search-button display
conditions, results availability, and default ordering are authored in the case
workspace; `content/docs/case-workspace.mdx` is the user-facing guide.

### Case tiles

A module's case list is laid out either as a row of columns or as a **tile** — a
12 × 12 grid where each Results field occupies a rectangle. The layout lives on
`caseListConfig.tile` and its presence IS the switch; each column carries its own
`tile` cell (`{x, y, width, height}` plus optional alignment, text size, border,
and shading). Placement is deliberately separate from the case list's two
ordering arrays: a cell is where a field sits on the tile, a sequence is
where it sits in a sequence.

One short detail drives all three tile surfaces. `models/modules.py::Module.search_detail`
deep-copies it for search results, and `caseListConfig.tile.persistOnForms` turns
the same detail into the persistent tile above every form in the module
(`detail-persistent` on each case-loading datum;
`cloudcare/.../formplayer/menus/views.js::PersistentCaseTileView` renders it in a
sticky region, suppressed only inside HQ's own App Preview pane, which Nova does
not target). The case-detail screen stays a plain field list.

Nova emits only HQ's `custom` tile vocabulary — `case_tile_template = "custom"`
plus per-column grid fields — and never the named templates `person_simple` or
`icon_text_grid`, whose slots are filled by name and whose emission carries a
hardcoded profile-image cell and a literal `m0-f0` registration action. Layout
presets are builder gestures that fill per-column placement; there is no template
slug in the schema, so a preset and a hand-drawn layout take one wire path. HQ's
regeneration is not toggle-gated — `suite_xml/sections/details.py::DetailContributor.build_detail`
fires `CaseTileHelper` on a bare truthiness check of `detail.case_tile_template`
— so an uploaded Nova tile emits on any domain with no setup artifact first.

The wire facts that shape the emitter:

- **`<style>` and `<grid>` are one indivisible unit.**
  `commcare-core/.../org/commcare/xml/DetailFieldParser.java::DetailFieldParser.parseStyle`
  runs `GridParser` unconditionally after `StyleParser`, and
  `GridParser::parse` opens with `checkNode("grid")` and then reads all four
  coordinates through unguarded `Integer.parseInt` calls. A `<style>` with no
  `<grid>` is an install-time `InvalidStructureException`; a `<grid>` missing one
  attribute is a raw `NumberFormatException` that escapes the parser's structured
  error path. HQ can emit both (its custom branch guards on `any(... is not None ...)`
  across the four, not `all(...)`). Nova cannot: `TileCell` carries the four as
  required slots of one object, so the partial state is unrepresentable. The
  corollary binds authoring too — alignment, text size, border, and shading are
  reachable only for a placed cell, because they have no wire spelling without
  one. A field is a tile cell iff all four are set
  (`DetailField::isCaseTileField`, against a `-1` unset sentinel).
- **The rendered grid is the occupied extent, not the 12-column canvas.**
  `Detail.java::Detail.getMaxWidthHeight` derives it from the cells, Formplayer
  ships it as `maxWidth`/`maxHeight`, and `views.js::buildCellGridStyle` builds
  `repeat(maxWidth, 1fr)`. A tile ending at column 6 renders six equal columns
  filling the width. `lib/preview/caseTileLayout.ts` is the one projection the
  running list and the authoring canvas both derive from, so they cannot disagree.
- **The 12-column cap is Nova's own.** CommCare Core has no column-count
  constant, and HQ has no server-side grid validation at all — its only
  enforcement is a Knockout dropdown range, and its parity assertion
  (`tests/test_suite_case_tiles.py::SuiteCaseTilesTest.test_case_tile_column_count`)
  lints only the two shipped named templates and never sees a `custom` tile.
  Nova enforces 12 columns and 12 rows itself, plus no-overlap and full coverage,
  in `lib/commcare/validator/rules/case-list/caseTileLayout.ts`.
- **Vertical alignment is authored in Nova's words and emitted in the wire's.**
  `top` / `middle` / `bottom` emit as `start` / `center` / `end`, because
  `views.js::getValidFieldAlignment` silently rewrites anything outside
  `constants.js::ALLOWED_FIELD_ALIGNMENTS` (`start`, `end`, `center`, `left`,
  `right`) to `start` — HQ's own shipped `icon_text_grid` template emits
  `vert-align="top"` and its renderer ignores it. A clean instance of the wire
  binding where HQ's authoring shape does not.
- **Border and shading are a tile-wide switch at the runtime.**
  `views.js::buildCellLayout` computes one `borderInTile` / `shadingInTile` over
  the whole tile; if any cell asks for either, every cell changes layout mode.
  Nova's renderer reproduces that rather than reading the flags per cell.
- **Absent text size means inherit, not medium.** An absent `font-size` produces
  an empty `font-size: ;` declaration the browser discards. The `medium` default
  exists only in HQ's authoring UI.
Emitted bytes are asserted against HQ's own fixtures —
`suite-case-tiles.xml` for the `<style>`/`<grid>` shape,
`case-tile-case-detail.xml` for `show-border` / `show-shading`, and
`case_tile_pulldown_session.xml` for `detail-persistent`.
`lib/commcare/CLAUDE.md` (§ Case-tile emission) owns the emitter detail.

Two scope fences are deliberate. Long-detail tiles stay out: CommCare allows
`custom` on the case-detail screen, and Nova keeps that screen a field list.
Pull-down (`detail-inline`) stays out because it is a navigation change rather
than a layout one — it replaces the case-detail confirm screen by folding the
long detail into the persistent tile.

### Grouped case tiles

A tile can also GROUP its cases: `caseListConfig.tile.grouping` carries an
`identifier` (a case-index name) and `headerRows`, and the cases sharing that
connection are shown together under one heading. Grouping lives INSIDE the tile
layout, so "a group on a detail with no tile" is unrepresentable rather than
merely rejected, and turning the tile off clears the grouping in the same write.

It emits `<group function="string(./index/<id>)" header-rows="N"/>` as the last
child of BOTH short details — `m{N}_case_short` and the deep-copied
`m{N}_search_short`, because
`suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail` gates
on `detail_type.endswith('short')` — plus a companion
`<datum id="<caseDatumId>_parent_ids">` on every FORM entry that loads a case
(`suite_xml/sections/entries.py::EntriesHelper.get_case_datums_basic_module`
adds it only under `if form:`). HQ JSON writes the same thing as
`case_tile_group`. The byte oracle is
`tests/test_suite_case_tiles_grouping.py::SuiteCaseTilesGroupingTest`, whose
inline `assertXmlPartialEqual` pair pins both exactly; three of the four upstream
`<group>` fixtures misspell the attribute `grid-header-rows` and prove nothing.
`header-rows` is always written, because the client falls back to `1`
(`DetailGroupParser::ATTRIBUTE_NAME_HEADER_ROWS`) while HQ's model defaults to
`2`.

Three facts shape everything above the wire:

- **The header/body split is a cell's START ROW alone.**
  `cloudcare/.../formplayer/menus/views.js::CaseTileGroupedListView.initialize`
  computes `isHeaderRow = (y) => y < groupHeaderRows` and never splits a cell, so
  a field crossing the line is drawn wholly in the heading, from the group's
  first case. The validator refuses that, a heading covering every occupied row,
  and a heading no field sits in;
  `lib/domain/modules.ts::tileGroupHeaderRowChoices` is the constructive twin the
  builder offers, pinned against those refusals in both directions.
- **A group is ONE choice, and it opens the group's first case.** That same
  `initialize` clones the models and removes every non-first one from the
  rendered collection, and
  `templates/cloudcare/partials/case_list/tile_grouped_item.html` gives the body
  rows no id, no checkbox, and no click target. Nova reproduces exactly that and
  says so where a worker sees it and where an author turns grouping on, rather
  than inventing a per-row selection the device does not have.
- **Cases with no such connection all land in ONE group.**
  `commcare-core/.../cases/entity/NodeEntityFactory::getEntity` evaluates the
  function to a plain `String`, which is `""` for them, and the clustering map
  takes it as an ordinary key. The commit gate cannot speak to that — it is case
  data, not document structure — so the authoring surface MEASURES the population
  and states the consequence (§ *What the commit gate may read* in
  `complex-app/00-contracts.md`).

The clustering runs in SQL, between the user's sort and the page window, because
that is the only place it can: `CaseStore.queryGrouped` reproduces
`EntityScreenHelper::groupEntities` (first-appearance ordinal, members in
post-sort order) and
`formplayer/.../beans/menus/EntityListResponse::getEntitiesForCurrentPage`
(boundaries on adjacent keys) in one four-level window statement. Its window
counts GROUPS, so a page holds whole groups and however many cases they carry —
the platform's own row-unboundedness, reproduced rather than clamped.

The group key is narrowed to a case index, which is Nova's choice and not a
platform rule: `DetailGroupParser::parse` accepts any parseable XPath and a
shipped fixture groups by `string(case_name)`. A heading drawn from the group's
first case is only honest when its value is invariant across the group, and an
index is the only key Nova can statically prove invariant. Property-keyed
grouping, a synthetic "ungrouped" bucket, clickable-icon endpoints, the
multi-select `instance-datum` variant, and long-detail grouping all stay out.

Grouping renders on Web Apps only. `commcare-core` parses `<group>` and
evaluates its key, but the only consumers are `EntityScreenHelper` and
formplayer's `EntityListResponse`; nothing in `commcare-android` reads it, so on
Android a grouped list is an ordinary tile list.

### Carrying a column without showing it

`width="0"` on a short-detail `<header>` and `<template>` is CommCare's own
reserved spelling for a column the list carries but does not display — not a
Nova convention and not a hack.
`commcare-core/.../org/commcare/suite/model/Style.java::Style(DetailField)`
records it in its own comment ("`'0'` is reserved for hidden (Search) fields")
and defaults an absent width to `-1` precisely to keep `0` free for it. Both
Web Apps tile templates honor the contract explicitly, branching on
`styles[index].widthHint === 0` to render the value inside a `d-none` wrapper —
`cloudcare/templates/cloudcare/partials/case_list/tile_item.html` and the
identical branch in `tile_grouped_item.html`, so grouping inherits it unchanged.

This is what lets Nova's zero-width sort carrier work on a tile with no special
case: the field occupies no cell (its `-grid-style-N` class has no rule, because
`views.js::buildCellLayout` filters null tile entries before building the style
block, and `formplayer-common/grid.scss::.box` adds no box size), and the
ordering still applies because the runtime sorts entities before it draws them.
Ordering by a field workers never see behaves the same on a tile as in a row of
columns.

**That only holds because a hidden column contributes no cell to any surface**,
and that refusal is load-bearing rather than incidental. A hidden column keeps
its stored cell — hiding and unhiding restores the drawing — so without the
refusal a carrier that retained a placement would emit a complete
`<style><grid>`. All four coordinates set makes it a tile cell by
`DetailField::isCaseTileField`, at which point it claims a real `grid-area`,
enlarges the extent `Detail.getMaxWidthHeight` computes across every field, and
joins the tile-wide border/shading switch — while its `width="0"` content still
renders inside `d-none`. The visible consequence is a tile silently widened, or
every cell boxed, by a column no worker can see; and the overlap rule cannot
catch it, because that check deliberately walks only the columns the tile shows.

**The decision therefore has exactly one home**:
`lib/domain/modules.ts::tileCellFor` answers "does this column hold a square?"
and every emission path calls it — the suite emitter
(`suite/case-list/columns.ts::tileStyleChildren`), the HQ JSON writer
(`hqJson/caseList.ts::applyTileLayoutToShortDetail`), the preview
(`lib/preview/caseTileRendering.ts::tileResultsColumns`), and the SA read
surface. Paths agreeing by hand is not an invariant, it is a coincidence with
a short half-life; `lib/commcare/__tests__/tileEmissionParity.test.ts` asserts
the agreement directly on one document carrying that exact shape, and the
suite fuzz generates hidden sort carriers that retain their placement.

The validator's visible-only overlap walk is sound **only** while that predicate
governs every path; a new delivery path or renderer must call it rather than
re-derive it.

The fact reaches past tiles. Any column that must ride the detail without being
shown — so its value is available to sorting, to a calculation, or to a later
surface — uses this shape rather than being dropped from the detail.

### Media

Assets are Project-scoped: bytes in GCS, a metadata row in Postgres, and
`project_id` set authoritatively at upload as the only access gate. Attach- and
export-time verdicts, the export budget, the wire manifest, and the deletion guard
live in `lib/media`. The manifest filters a document's referenced ids to the
Project, which is also the exfiltration-via-compile defense — a foreign-Project
reference resolves to `MEDIA_ASSET_NOT_FOUND` rather than being emitted. This is
authoring media (menu icons, field images); a worker's own captures are the
attachment questions below and never enter this library.

### Attachment questions

Five capture kinds — image, audio, video, signature, and file — carry a label,
hint, `required`, `relevant`, and a `caseWrite` of their own.
`captureFieldKinds` (`lib/domain/fields`) is the single home for which kinds
are captures; the reference-slot applicability groups, the capture-only
destination shape, and the wire emitter all read it. Each emits `<upload ref mediatype>` over a `<bind
type="binary">` and nothing else — no suite entry, no app-level declaration
(fixture: `form_preparation_v2/attachment.xml`).

**The `mediatype` is a closed four-literal enum with no fallback, and the
emitter makes an unmatched value unrepresentable rather than checking for one.**
`XFormParser::parseUpload` matches with literal `String.equals` against
`image/*`, `audio/*`, `video/*`, and `application/*,text/*` (comma, no space).
Anything else leaves the control at `CONTROL_UPLOAD`, `entries.js::getEntry`
falls through to `UnsupportedEntry`, and that constructor **sets the answer** to
the literal string `Not Supported by Web Entry`, which then submits. The failure
mode is silent bad data, so `UPLOAD_MEDIATYPE_BY_CAPTURE_KIND`
(`lib/commcare/xform/captureUpload.ts`) is a total table over the capture kinds
into a four-member literal type, and a new kind fails `tsc` until it names one.

Signature is its own Nova kind emitted as `image/*` plus
`appearance="signature"` — the wire collapses it onto the image control and
`entries.js::getEntry` splits it back apart on that appearance, but every
worker-visible property differs. `appearance="face"` stays out: Vellum authors it
and it is inert on both runtimes Nova targets. `jr:imageDimensionScaledMax` stays
out for the same reason — `UploadQuestionExtensionParser` is registered only by
`commcare-android`, so Web Apps does no downscaling and uploads the picked bytes.

File attachments are a first-class Web Apps kind (`entries.js::DocumentEntry`,
accept list `.pdf,.xlsx,.docx,.html,.txt,.rtf,.msg`) with full receiver support,
and they carry one asymmetry stated where the author picks the kind:
`CONTROL_DOCUMENT_UPLOAD` appears nowhere in `commcare-android`, so
`WidgetFactory::createWidgetFromPrompt` falls to `StringWidget` and a worker
there types free text into a `binary` node.

`hqShells.ts::applicationShell` emits one fixed `build_spec.version` (`2.54.0`)
as part of Nova's single application-shell target. It is not a feature floor,
reader gate, or capability switch, and no authoring/runtime branch consults it.
The upload path is declarative because `models/applications.py::import_app`
deletes `build_spec` and `ApplicationBase.wrap` substitutes the target domain's
default.

`FORM_TOO_MANY_ATTACHMENTS` rejects a form whose **non-repeating** capture
questions exceed `MAX_FORM_ATTACHMENTS` (50). Formplayer counts at submit time
over the session media directory (`FormSubmissionHelper::getMultiPartFormBody`,
before any per-file logic) and the whole submission aborts, with no worker-facing
way to shed a file — so a form past the cap is a dead end once fully answered.
The walk stops at a repeat deliberately: a capture there produces one attachment
per iteration and the worker chooses the count, so no authoring-time number
bounds it, and counting the template once would imply a guarantee the check
cannot make.

**Every author- and worker-facing string says "attach", never "take" or
"record".** Web Apps has no camera, microphone, or recorder anywhere in
cloudcare — `entry_file.html` binds only `accept` on its file input, and
`getUserMedia` / `MediaRecorder` / `capture=` occur nowhere in it. Every kind but
signature is the OS file picker. CommCare Android is the contrast, and that
contrast is a docs fact rather than a Nova behavior.

**A capture's `caseWrite` carries a required `mode`, and the case update names
a node the capture question is not.** A capture's answer is the submitted
file's name, so the answer can never BE the case value; `mode` says what is
written instead. `"url"` writes a link to the file, built as
`if(<capture> = '', '', concat('<origin>/a/<domain>/api/form_attachment/v1/',
/data/meta/instanceID, '/', <capture>))` on a SIBLING node
(`lib/commcare/xform/captureUrlNode.ts`), which `formActions.ts` then names as
the update's `question_path`.

That indirection is the unit's whole reason for existing.
`xform.py::CaseBlock.add_case_updates` routes an update into an `<attachment>`
block whenever its question path has an `<upload ref>` in the body
(`::is_attachment`) and consults no toggle, while
`update_strategy.py::_apply_attachments_action` drops that block on any domain
without the deprecated `MM_CASE_PROPERTIES`. Pointing the property at the
capture question therefore writes nothing, silently, on a stock project space.

The origin and project space arrive already resolved from the app's deployment
record (`lib/deployment/attachmentTarget.ts`, de-duped on `(server, domain)`
because the three CommCare installations can hold same-named project spaces);
a publish uses its own target authoritatively. With no single answer the node,
the bind, and the case update are all withheld, and the download says so
through `lib/publish/exportAdvisories.ts`. An attachment is refused
`case_name` and `external_id`, which reach the wire through their own
FormActions slots and would point back at the capture question.

`"attachment"` is the opposite member and the deprecated one: it names the
capture question deliberately, so HQ's structural rule builds the
`<attachment>` block and CommCare stores the FILE on the case. The local
`.ccz` reaches the same shape by running HQ's own rule rather than by being
told — `caseBlocks.ts::attachmentQuestionPaths` collects the body's
`<upload ref>` set, which is exactly what `::is_attachment` computes, so the
two surfaces consume one input pair (`FormActions` + the body) and cannot
diverge. The emitted bytes match `form_preparation_v2/update_attachment_case.xml`
and its `_advanced` twin: an empty `<update/>`, a sibling `<attachment>` whose
child is named by the case property and carries `src="" from="local"`, and
binds spelled `relevant="count(<question>) = 1"` plus `@src`
`calculate="<question>"`. The property holds no scalar at all, so
`casePropertyIsAttachmentSlot` (`lib/domain/attachmentSlots.ts`) is the one
predicate the case-list gate and the authoring surfaces read to refuse a
column that could only ever render blank.

Both modes name a project-space feature flag, advisory as every flag here is:
`MM_CASE_PROPERTIES` (deprecated) or the block is discarded without a word,
and `VIEW_FORM_ATTACHMENT` or a worker without the Submission History
permission cannot open the link. Neither ever blocks a publish.

**A `link` column renders a property holding an address as something a worker
can open.** `<template form="markdown">` over
`if(<field> = '', '', concat('[<linkText>](', <field>, ')'))`, and
`format: "markdown"` with `useXpathExpression` on the HQ JSON, so an
HQ-imported app and a local `.ccz` agree. Two CommCare limits ride with it and
are stated wherever the kind is offered: `linkText` is ONE string for every app
language, because `detail_screen.py::Markdown` inherits the base `variables`
(`$lang` only) and has nowhere to carry a translated label; and the cell is a
real link in Web Apps only, because `Style.getDisplayFormat()` has no callers
in commcare-core or commcare-android and `EntityView` branches only on
image/audio/graph/address/callout, so Android shows the raw markdown text.

### Attachments a worker captures

A worker attaches files in the running preview, and they ride the submission.
The lane is `form_attachments` plus two GCS prefixes — **never `media_assets`**:
a captured photo is data, not an authoring asset, and a row in the library would
surface it in the media picker, count it against the export budget, and make it
deletable through the library UI. CommCare's own model agrees, keeping staged
capture bytes under the form session and disposable.

The acceptance lifecycle is
`pending → staged → preparing → prepared → submitted`; Clear or expiry sends a
`preparing`/`prepared` row through `discarding` instead. A form answer may name
an attachment only once it is `staged`, because a `pending` row's object may
never have been PUT. Bytes take the media lane's initiate → signed-PUT →
confirm shape so they never travel through Cloud Run. Two tenancy axes:
`project_id` is the tenant, matching case rows, so every member of an app's
Project sees the same submissions; `created_by` is narrower and scopes the
writes, because reservation is keyed on a client-minted `entry_key` — without
it a co-member could reserve or delete another member's in-flight attachments.

**Names are server-minted and derived from nothing about the question** — not
the field id, not the node path, not the repeat index — because
`MediaHandler.kt::saveFile` is not either, and a field-derived name would
collide across repeat instances exactly where CommCare's does not. Nova cannot
produce CommCare's trailing-dot edge (`<uuid>.` from a filename with no
extension), since an unrecognized extension is rejected before an id is minted;
a consumer must still not assume a capture answer splits on a dot, because a
submission that went through Formplayer can carry it.

**Accepted means the bytes are already durable.** Before any case effect, the
server builds capture authority from the authorized committed document and
moves the selected rows to `preparing`; a row reaches `prepared` only after
its bytes are verified at a durable key outside the staging TTL's reach
(`lib/db/CLAUDE.md` owns the copy-and-verify mechanics). The case-store
transaction independently
requires every selected row to be `prepared`, applies every case effect, and
stores the replay result atomically — a case failure rolls back to `prepared`,
a matching retry returns the stored result, and a different payload under the
same entry key is rejected. The client emits the intent with
`attachments: []` even when the current projection is empty, so replay
protection still runs after a worker clears an answer, a condition hides it,
or a repeat removes it. There is no cross-system interval in which external
bytes exist without a DB recovery record, and no post-commit attachment await
can make an accepted form appear failed. The Project move protocol blocks
whenever capture rows or submission intents exist, because no partial move may
strand their rows or bytes in the source tenant.

Nova diverges from the platform in exactly two places, both toward correctness:

- **Only named attachments ride the submission.** The real runtime enumerates
  the session media DIRECTORY, not the answers
  (`FormSubmissionHelper::getMultiPartFormBody`), so a deleted repeat
  instance's file still uploads, still consumes one of the 50 slots, and lands
  in HQ referenced by nothing.
- **Clear and replace touch the answer first, bytes second.** The runtime does
  the reverse and strands a required question naming a file it just deleted.

Retention has two traffic-independent mechanisms with deliberately different
authority. The GCS lifecycle TTL reaps ordinary staged and browser-abandoned
source bytes even if the app receives no traffic, but GCS-only policy cannot
atomically distinguish a DB-accepted submission — so an accepted generation
must first live at a durable prefix the lifecycle never matches. A scheduled
bounded worker (a Cloud Run Job every five minutes, collapsed to one active
worker by a session advisory lock) owns the cross-system
`preparing`/`prepared`/`discarding` recovery and the row expiry sweep.
`lib/db/CLAUDE.md` owns the worker, IAM, and bucket-policy detail;
`lib/preview/CLAUDE.md` owns the client capture queue, retarget recovery,
signature draft, topology-move, and write-authority mechanics.

Clear and Replace carry no confirmation on the picked kinds, deliberately:
the device does not confirm either, and nothing is actually lost — the file
is still on the worker's disk, and replacing one means they already went
through the picker and chose another. Signature is the carve-out, because
it is drawn rather than picked and clearing destroys the only copy; it gets
inverse-action undo (the retained stroke buffer, re-emitted through the
ordinary upload path) rather than a confirm, per the contracts' preference
for undo over confirm-then-destroy. The real protection on both is the
ordering — answer first, bytes second — not a prompt.

The preview control is device-faithful: a filename and one visible removal
action (Nova says **Remove**, where `entry_file.html` says **Clear**), no
thumbnail, no playback, no way to reopen the file — and Formplayer declares no
route serving a staged capture back. The preview could render a thumbnail,
which is why it must not; an author laying out a form against a preview that
confirms attachments would ship a form whose workers cannot.

**The preview does not resume a partially-filled form** — nothing persists
runtime answers and `deactivate` wipes the store — so the entry key is minted
per activation and lives on the `EngineController`, not the engine. That is
also why the runtime's blank-pad-over-live-signature behavior has no Nova
counterpart to be faithful to; a future resume story must carry the entry key
forward with the answers, and leave the signature pad blank rather than
helpfully restoring it.

### Export, publishing, and the deployment record

`lib/commcare` compiles a `BlueprintDoc` to the wire on three paths: a downloadable
`.ccz`, an HQ import file, and a direct HQ upload through the REST client. All
three re-run the full validator with zero tolerance, and
`lib/export/boundaryValidation.ts` adds the boundary findings that depend on
things the document alone cannot know — Project media membership, and which
carriers a given export mode can represent. Credentials are KMS-encrypted per
server, and `lib/commcare/client.ts` resolves its base URL from the selected one.

**A publish is durable target state, not a fire-and-forget POST.** An
`app_deployments` row records what one CommCare HQ project space holds of one
app, keyed by app, Project, server, and domain — the server belongs to the key
because HQ's US, India, and EU installations share no account database, so a key
issued by one authenticates nowhere else. An `app_deployment_resources` row is
the ownership ledger: Nova repoints or updates what it created (`nova-created`)
and what somebody explicitly handed it (`adopted`), and never infers ownership
from a name, because two project spaces can hold unrelated apps — or unrelated
lookup tables — sharing a name and picking one would attach a deployment to
somebody else's work. An adoption is never inferred: the publish REFUSES,
names the resource, and only a caller naming that exact Nova id records it,
attributed to who and when. `pushed_identity` holds the external name a
resource carries there, which is what makes a renamed resource reportable as
left behind. `lib/deployment/CLAUDE.md` owns the detail.

The lifecycle is `preflight → resources → uploaded → built → released →
runnable`, plus the
terminal refusal `incomplete`, which carries the phase a retry resumes at and
withholds both `released` and `runnable`. Every phase is independently
retryable, and a retry never re-imports the app because the mapping already
holds the remote id. A refused ATTEMPT never touches what the target holds:
preflight failing against an already-released deployment writes nothing durable
— the refusal is reported on the attempt itself (`PublishOutcome.refusal`),
because the failure belongs to the caller's key or draft rather than to the app
every Project member shares — and an observation that could not reach HQ at all
writes nothing rather than demoting a healthy deployment. A later read failing
mid-pass keeps the rungs that pass already confirmed. Observation may move a
deployment BACKWARD, because a build that stops being released on HQ makes a
`runnable` deployment not runnable; an answered pass also re-confirms the
upload, which is what heals a deployment whose HQ app was deleted and then
restored. No lock spans the HQ round trips: every record write is one short
transaction folding against the freshly locked row, and an observation applies
only while the mapping it asked about is still the active one.

`resources` is what the app DEPENDS ON, put there before the app itself: its
lookup tables and its organization's places. Take the tables first — the app's
selects read them by name
at runtime, so an app that arrived first would install and misbehave. CommCare
HQ has no REST endpoint that takes a table's rows in bulk — the row resource
keys rows by a server-minted UUID with no natural key — so the push is the Excel
fixture upload (`POST /a/<domain>/fixtures/fixapi/`, synchronous, `replace=true`,
`waf_padding` first), whose types sheet creates the table definition and whose
`replace` makes each table in the workbook equal Nova's copy while leaving every
table not in it untouched (`fixtures/upload/run_upload.py::_run_upload`). The
synchronous path is the only one with a real verdict: `tasks.py::fixture_upload_async`
skips `validate_fixture_file_format` and drops the row errors. The verdict is in
the BODY — `views.py::UploadFixtureAPIResponse.response_codes` maps fail/warning/success
to 405/402/200 and `JsonResponse` carries all three over HTTP 200 — and a warning
is a refusal here, because Nova pushes whole tables and a partial result is a
project space whose data no longer matches the app about to be sent to it.

Because the upload matches tables BY TAG, the ownership read before it is
mandatory rather than defensive, and the two endpoints AUTHORIZE DIFFERENTLY:
the tastypie `lookup_table` read needs the domain's paid API_ACCESS privilege
and the account's `access_api` permission, while the upload needs neither. So a
project space can accept the push while refusing to say what it holds, which is
exactly the case Nova must refuse rather than push into. A publish refused at
`resources` sent nothing of the app, so its retry re-pushes the data and never
re-imports the app; a SUCCEEDED push folds through `applyAttemptOutcome` so a
republish of a `runnable` app is not walked backward by its own data landing.

`resources` also carries the app's PLACES, through
`locations/resources/v0_6.py::LocationResource`. Its `patch_list` is `@atomic`
and capped at `patch_limit = 100`, upserting on the presence of `location_id`,
so the push is one batch per level working down, threading each parent's
returned `location_id` into its children's batch — and each batch is the
partial-failure boundary, so a tree that stops partway really did leave the
levels above it there. Those are recorded (`ResourcePushOutcome` distinguishes a
`complete` push, which supersedes what it did not name, from a `partial` one,
which supersedes nothing and folds no rung), so a retry updates them rather than
making a second copy. The answer is a BARE ARRAY of ids in request order with
status 202 (`api/resources/__init__.py::patch_list_replica`), so position is the
only link back and a mismatched length is refused rather than recorded.

**The LEVELS are not pushable at all** — `v0_5.py::LocationTypeResource` allows
only `get` — which is why the `organization` preflight edge reads them and
refuses shapes CommCare HQ will not hold, rather than fixing anything: a level
the target lacks; a place whose level is not the IMMEDIATE child of its parent's
(`forms.py::LocationForm.get_allowed_types` filters
`parent_type=parent.location_type`, while Nova deliberately allows a skipped
rung); two live siblings sharing a name (`util.py::has_siblings_with_name`,
where Nova constrains only the site code); and a place Nova moved to the top
that the target holds under a parent, which `_update` offers no way to undo.
Two more are unknowable from here and surface as CommCare HQ's own sentence: a
site code an ARCHIVED place still holds (`util.py::validate_site_code` queries
`SQLLocation.objects` while the v0.6 list is `active_objects`), and a level
change on a place with children over there. Both location resources sit behind
four authorization gates — the project space's `LOCATIONS` and `API_ACCESS`
privileges and the account's Edit Locations and Access APIs permissions, the
last two checked together by `users/decorators.py::require_api_permission` —
and two of the four answer with an identical bodyless 403, so the refusal names
all of them rather than guessing.

A place's site code is create-once in Nova and domain-unique on CommCare HQ, so
unlike a table's tag it never renames; the route to `pushed_identity` mattering
is ARCHIVING, which stops the push naming the place while v0.6 offers Nova
neither archive nor delete, so the place stays there and its code stays
reserved. `location_data` is sent for every place the app models information
for, merged over whatever the target already holds, because `_update` REPLACES
`metadata` wholesale and the fields Nova does not model belong to whoever made
them. The field DEFINITION has no REST resource, and
`custom_data_fields/models.py::CustomDataFieldsDefinition.get_validator`
iterates the project space's own fields without rejecting unknown keys, so an
undefined slug arrives as real but unvalidated loose data while a field the
target marks required with no value takes the whole batch down.

**Mobile workers are provisioned by an explicit call, never by a publish.**
Making somebody an account hands out a credential and is aimed at named people,
so it is a button and an MCP tool (`provision_workers`) rather than a rung: it
folds no phase and leaves the deployment's states where it found them. The
ledger's `worker` kind keys a mapping on the PERSONA, with the complete username
in `pushed_identity`, because a persona is a design actor that can hold a
different name on each project space — so no blueprint schema changes and the SA
gains no vocabulary. Nova generates a strong password per new account, hands it
back once in the answer, and stores it nowhere. It never issues the resource's
DELETE: that is `users/models.py::CommCareUser.retire`, which soft-deletes every
case the worker owns, so a removed persona is reported as left behind, which is
also why a worker Nova already owns is UPDATED rather than remade even when the
account has vanished from the search.

Everything knowable is refused before the first account exists, because
`api/resources/v0_5.py::CommCareUserResource.obj_create` calls `_update` and
DISCARDS the errors it returns — a create whose location ids do not resolve
answers 201 with the worker standing nowhere and says nothing about it. So the
call refuses up front on an unusable username, on required worker information a
persona has no value for (the same rule the publish reports as attention, since
a publish creates no workers), and on a persona standing in a place the project
space does not hold; and a create that DOES carry places sends them as a second
call, which reports. The username is create-only
(`users/util.py::generate_mobile_username`, popped before `_update`), the update
field map is closed (`api/user_updates.py::CommcareUserUpdates.update`), and
`primary_location` and `locations` travel together or not at all. Nova speaks
about places only when the app has an organization, so an adopted account on an
app with none keeps whatever assignment a person gave it. Web users stay out of
reach: `InvitationResource` resolves a role BY NAME against the domain's roles
and fails without one, which is why the user-property catalog authors no
`required_for` and every pushed value is `["commcare_user"]`.

**Nova drives the first three states and observes the last three, because HQ
draws that line.** `app_import_api.py::import_app_api` passes
`login_decorator=api_auth()`, so an API key may import; `views/releases.py::save_copy`
and `views/releases.py::release_build` both go through `require_can_edit_apps`,
which is `require_permission(HqPermissions.edit_apps)` with the default
`login_and_domain_required` — a browser session and nothing else.
`cloudcare/views.py::FormplayerMain` is session-only too. The three reads an API
key can make are `views/releases.py::current_app_version` (`@login_or_api_key`)
for the version numbers, the read-only
`api/resources/v0_4.py::ApplicationResource.dehydrate_versions` for build ids and
release flags, and one build's `profile.ccpr` as the runnable proof. That last
one is the device's own install request rather than a pure read: the catch-all
`^download/<app_id>/<path>` route reaches `views/download.py::download_file`,
not `::download_odk_profile`, and that view regenerates a build's files when
they are missing — CommCare HQ repairing a build for a device, which cannot
change the version or what is released. **It always names a build id and never
`?latest=true`**, because on a working app `download_file` falls through to
`download_odk_profile` and `autogenerate_build`, starting a whole new version.

`built` means a build of what the project space currently holds rather than
merely that some build exists, so an app edited on HQ after its last build is
reported pending with the version gap named. The import endpoint updates in
place when the POST carries `app_id`
(`views/app_import_api.py::_handle_import_app`: update →
`models/applications.py::overwrite_app_from_source`, 200 with `version`;
create → `import_app_util`, 201 without; unknown `app_id` → 404). The update
is an overlay merge (`::_merge_source_into_app` keeps
`ApplicationBase._update_excluded_fields` plus any non-excluded field absent
from source, and applies `extra_properties` last, which is how `app_name`
renames through the `name` exclusion), and `save_attachments` persists with
exactly one version bump. Publishing again therefore updates the mapped app; a
mapping is superseded only by the recreate after an HQ-side deletion, and the
superseded row is retained rather than deleted so an app left behind stays
nameable.

The emitted app document carries only fields Nova authors: target-owned
settings and state (`cloudcare_enabled`, `profile`, `case_sharing`, the
build/release metadata, the rest of the `commcare-app-settings.yml`
attributes) are never emitted, so the overlay merge retains a project's
HQ-side configuration across republishes, and `logo_refs` is emitted only
when the app has a Nova-authored logo (`lib/commcare/hqShells.ts` states the
rule).

Preflight is a dependency graph with two kinds of edge. A blocking edge is a
real prerequisite — no connection, an app the export boundary refuses, or
Project data or places Nova may not write over — and failing one leaves the
deployment `incomplete` before anything externally visible happens. The
`project-data` and `organization` edges are the two that talk to HQ during
preflight, each appearing only when the app carries that thing; the table
refusal is all-or-nothing because the workbook is one upload and a half-pushed
project space has no honest state to describe it, and the place refusals are
decided in full before the first batch for the same reason one level down. An attention edge is something the target needs that Nova
cannot do from here, so it becomes a line in the setup artifact rather than a
refusal; whether a persona satisfies a `required` worker property is one of
these, because refusing a publish over it would refuse one that works while
Nova creates no workers. Feature-flag reports remain advisory by standing
contract: refusing a publish over one would let a target's configuration edit
the app.

The setup artifact regenerates from the document on every read and is never
stored — a stored copy goes stale the first time a worker property is renamed,
and somebody following stale instructions has no way to tell. It is target-aware
throughout, and never claims a prerequisite was installed. **Project data and
Places are the sections that flipped from instruction to record** — they name
what Nova keeps on that project space, which is the shape every other section
takes as its push driver ships. The rest are instructions still: the user-data
schema, the location-fields schema, and organization levels are session-only
HTML forms (`users/views/mobile/custom_data_fields.py::UserFieldsView`,
`locations/views.py::LocationFieldsView`, `locations/views.py::LocationTypesView`),
automations have no REST resource, and building and releasing are the pages
above. It also states that
`models/applications.py::_create_app_from_doc` initializes `cloudcare_enabled`
from the domain's Web Apps privilege at create, so an app published before the
feature was on starts with it off. The remedy is the ordinary **Web App**
setting (`commcare-app-settings.yml` id `cloudcare_enabled`, editable through
`views/apps.py::edit_app_attr`). Nova deliberately never emits
`cloudcare_enabled` (`lib/commcare/hqShells.ts`), so the in-place update's
overlay merge retains that HQ-side toggle across republishes.

Preview's `commcare_project` is supplied from that record: present when exactly
one deployment has reached `uploaded`, absent when none has and when several
have, since choosing between two real answers is a guess. It is a usercase
property in a way it is not a session key —
`callcenter/sync_usercase.py::_get_user_case_fields` writes it unconditionally,
while `users/models.py::CouchUser.get_user_session_data` is the sole injector
of the session copy — but NEITHER projection emits it empty, because the domain
is never empty on a device and `= ''` would therefore fire in Preview and never
in the field. Every identity resolver threads it, browser and server alike: the
server-resolved identity binds `sessionUser` for the SQL compiler, so a
client-only value would make one expression answer two ways.

`publishAppToHq` is the one lifecycle the browser route and MCP's
`upload_app_to_hq` both use; a refused publish answers 200 carrying the
attempt's refusal plus whatever record the target has (none, when the app
never reached it), and both callers read whether THIS attempt landed rather
than inferring it from a state that describes the target. Deployments
are reachable from the Builder's Publish dialog and from MCP (`get_deployment`,
`refresh_deployment`) and deliberately NOT from the Solutions
Architect, the same standing decision that keeps `get_app_hq_feature_flags` off
that surface. Deployments carry `app_id` and `project_id` but not the composite tenant key
case rows use, because the auth-app tenancy migration keeps an exact catalog of
everything referencing `apps.project_id` and blocks additions; coherence is
proved under the app lock every write already takes, and a Project move
re-tenants them in the same transaction.

Publishing also reports the HQ feature flags required by the emitted app.
Direct upload checks the selected project space after import and distinguishes
flags confirmed missing from flags whose state could not be verified; JSON and
CCZ name the requirements without claiming to know the eventual destination's
state. The Builder keeps all three choices and their durable follow-up in one
Publish dialog, MCP returns the same structured distinction, and the public
feature-flag guide tells users to contact `support@dimagi.com` for a named
project space. One central manifest drives detection, copy, docs, and a weekly
audit against current CommCare HQ source so a graduated or renamed flag becomes
an actionable failing check instead of stale product behavior.
`content/docs/publishing.mdx` is the user-facing guide.

### Projects, moves, and multiplayer

Projects are the tenancy and sharing unit: every app carries a `project_id`, every
user has a personal Project, and shared Projects let members co-edit an app plus
its case, media, and lookup data at viewer/editor/admin/owner roles. Invitations
are domain-gated (`lib/projects/invitePolicy.ts`). `apps.project_id` is
nonblank, `NOT NULL`, and foreign-keyed to the Better Auth Project; membership
is the only authorization path and `apps.owner` is provenance only. A deferred
composite foreign key binds every case row's `(project_id, app_id)` to the same
app tenant, so Project moves may change the complete closure in one transaction
without admitting a mismatched row.

Cross-Project moves are live. An admin/owner of both ends moves an app plus
its case, media, and conversation history — including chat-attached files — as
one transaction (`lib/db/moveAppToProject.ts::runCrossProjectMove`; media
bytes copy content-addressed into the destination first, so a retry dedups).
Governance requires `delete` on both ends, `deleted_at IS NULL`, owner
retention, and an exact empty lookup closure: an app whose blueprint
references lookup tables or has capture rows or capture-submission intents
cannot move, and stored lookup edges that disagree with the blueprint are
themselves a refusal until repaired. Same-Project case-data recovery is a
separate, always-available repair. Project deletion is globally disabled until
Nova has an audited whole-tenant deletion lifecycle. `lib/db/CLAUDE.md` owns
the move protocol and lock discipline.

### Multilingual app authoring and translation

An app has one canonical source language, one runtime default language, and an
ordered catalog of target languages. The canonical values on modules, forms,
fields, case lists, and Search remain ordinary Nova domain values; an optional
app-level localization overlay stores only target values, provenance, source
fingerprints, and review state. Legacy documents with no overlay are exactly an
English-only app. Missing or stale target values resolve to the current source,
so every document remains complete and valid throughout authoring.

One domain-owned translation-unit inventory enumerates every supported static
worker-facing string with stable identity, role, breadcrumb, semantic context,
value policy, and protected reference parts. The Builder's global language lens,
Languages workspace, ordinary inline editors, Preview engine, SA/MCP tools,
translation finalizer, validator, and CommCare compiler all consume that same
inventory and resolver. Authors can add any Classic-valid language by copying
the complete effective content of an existing language, then edit or review each
string without maintaining a second app model. Coverage diagnostics explicitly
name mutable lookup labels and other carriers that cannot honestly use the
static overlay.

Manual authoring, copy, Preview, and export accept every language code CommCare
Classic accepts; the vendored Classic picker catalog supplies discovery rather
than an allowlist. Automatic translation is a separate policy with Available,
Not evaluated, and Withheld states. At launch, every direction between two
distinct members of the checked-in 57-language set is Available; exact listed
variety aliases resolve before ordinary regional fallback, and equivalent
two-letter, ISO 639-2, and regional CommCare codes resolve to the same launch
identity. This is a product allowlist rather than a claim of provider-published
coverage or completed bilingual certification, so every machine-authored value
starts Needs review. All other languages remain copy/manual-only. Conversation
language is independent of app languages: the SA responds in the user's
language while preserving exact authored identifiers.

An accepted initial-build localization intent runs only after all build slices,
when the complete string inventory exists. Its bounded structured batches use
protected prose tokens and persist generation claims, outputs, failures, usage,
and protocol identity before one canonical localization commit and receipt.
Retries reuse accepted work; a failed protocol cannot be retried for random model
variance, while a deployed protocol generation may replace it. The design
session remains unfinished until the receipt exists, and usage accounting is
exactly once.

`lib/commcare` emits complete language maps in HQ JSON, one complete itext
translation per XForm language, and one suite app-string table per configured
language. A direct CCZ includes both the initialization-only `default` locale
and every named locale including the runtime default, with `homescreen.title`,
`app.display.name`, language endonyms, and `lang.current`. The domain, Builder,
agent, and CommCare subtree contracts own the detailed invariants; public usage
and MCP behavior live in `content/docs/languages.mdx` and
`content/docs/mcp/tools.mdx`.

### Run holders and the app-write surface

A run holds its app through a server-minted nonce; every claim mints one and
every terminal write compare-and-sets against it exactly. Only
`lib/db/apps.ts` and `lib/db/credits.ts` may issue `apps` DML, and
`lib/db/__tests__/runHolderWriteGuard.test.ts` pins that structurally — a new
writer outside those two files fails the build rather than quietly skipping
the holder proof. Operator recovery (`scripts/recover-app.ts`) delegates to
`recoverAppStatus` behind paired explicit token flags and never writes
directly. Request and run timings are three independently authored fields in
`config/runtime-capabilities.json`; none derives from another.
`lib/db/CLAUDE.md` owns the run lifecycle.

---

## What remains

Nine units, one file each. **Every entry below is a pointer, not a summary of
record** — the contract, the binding CommCare facts, the wire shapes, and the
observed outcome live only in the linked file, and each entry names what it is
withholding so you can tell when you need it. Read that file, and
[`00-contracts.md`](complex-app/00-contracts.md), before you plan or implement.

Units are named, not numbered: the file's name is the unit's identity, so a
unit that ships leaves no gap and nothing ever renumbers.



### App setup UI, SA, MCP, and docs

[`complex-app/app-setup-ui-sa-mcp-and-docs.md`](complex-app/app-setup-ui-sa-mcp-and-docs.md)
· depends on nothing outstanding · blocks nothing

The App setup workspace's remaining Deployment section, plus the SA and MCP
surfaces and public docs for the remaining prerequisite units.
**The file is deliberately short**: its substance is the prerequisite units'
files and the baseline UI review in the contracts.

### Exclusive form links and sections

[`complex-app/form-links-and-sections.md`](complex-app/form-links-and-sections.md)
· depends on nothing · blocks the nested-menus unit

An exhaustive-`else` link projection with durable link identity in one release,
then form sections in authored order. **The file holds** the six end-of-form
workflow mappings and their traps, the closed stack vocabulary, the negative sweep
proving sections have no wire notion, the no-expression-slots design fence, and
the verified mechanics that make sections beat multi-form chains.

### Nested menus and linked-form reuse

[`complex-app/nested-menus-and-linked-form-reuse.md`](complex-app/nested-menus-and-linked-form-reuse.md)
· depends on form links and sections · blocks the session-endpoints unit

One-tier menu nesting and native linked-form reuse. **The file holds** what
`root_module_id` and `put_in_root` each emit, and why shadow modules are
wire-level duplication rather than reference — which is what lets Nova emit the
shape with no shadow authoring object and no domain toggle.

### Session endpoints and deep links

[`complex-app/session-endpoints-and-deep-links.md`](complex-app/session-endpoints-and-deep-links.md)
· depends on nested menus · blocks nothing

Session endpoints and shareable deep links resolved against the selected HQ
server. **The file holds** the emission shape and why it pushes rather than
creates, why `respect_relevancy` exists only on forms, what a case-list endpoint
excludes, the runtime replay sequence, and the documented divergences that are
sharp edges rather than Nova bugs.

### Multi-select, related cases, and profile extensions

[`complex-app/multi-select-related-cases-and-profile.md`](complex-app/multi-select-related-cases-and-profile.md)
· depends on nothing outstanding · blocks nothing

Three independent vocabularies that ship as three PRs because they share only a
dependency. **The file holds** the multi-select datum and its virtual instance,
the related-case query keys and exclusion filter, the three authorable `cc-*`
profile keys against the reserved emitter-owned ones, and the removed `CaseSearch`
fields that must never be modeled.

---

## Dependency order

Each unit's prerequisites, matching the "Depends on" line in its file:

| Unit | Needs |
| --- | --- |
| [App setup UI, SA, MCP, and docs](complex-app/app-setup-ui-sa-mcp-and-docs.md) | — |
| [form links and sections](complex-app/form-links-and-sections.md) | — |
| [nested menus and linked-form reuse](complex-app/nested-menus-and-linked-form-reuse.md) | form links and sections |
| [session endpoints and deep links](complex-app/session-endpoints-and-deep-links.md) | nested menus |
| [multi-select, related cases, profile](complex-app/multi-select-related-cases-and-profile.md) | — |

Three units have no outstanding prerequisites and can start in any order: form
links and sections, multi-select, and the App setup UI. They are the independent
entry points — every other unit descends from one of them.

There is no critical path left. Push and provisioning was it, and with the
drivers and the usercase both shipped the remaining work is one short chain and
two loose units: form links → nested menus → session endpoints runs on its own,
and the App setup UI now waits on nothing.

The App setup UI, session endpoints, and multi-select are leaves — nothing waits
on them, so each can land whenever its own prerequisites are met. The App setup
UI and multi-select are both entry points and leaves: nothing blocks either and
nothing waits on either, which makes them the natural filler whenever another
unit is blocked on something external.

---

## Keeping these files honest

These files change in the same PR as the behavior they describe. The rules:

- **Present tense only.** Describe what the system does. If a sentence needs a
  date, a PR number, a revision, or a branch name to make sense, it belongs in the
  commit message.
- **Move a unit, don't annotate it.** When a unit ships, its contract moves into
  [What is built](#what-is-built) rewritten as current behavior, and its unit
  file, its entry under [What remains](#what-remains), and its dependency row all
  disappear together. No "shipped" markers, no status column, no changelog entry.
  When several units ship together — one PR or a stacked train — each still
  moves on its own: its own rewrite into What is built, its own removals, never
  one unit's record dispersed through another's.
- **What is built states the what and the why, and points at the how.** A
  section there carries the capability, the reasons for its shape, and the
  binding CommCare wire facts — not the implementation mechanics, which belong
  to the nearest subtree `CLAUDE.md` and the code. Moving a shipped unit in is a
  rewrite to that altitude, never a paste of the unit file or the PR
  description.
- **One home per fact.** A binding CommCare fact lives in exactly one place: this
  file once it is shipped behavior, or one unit file while it is not. The index
  entries and the dependency table restate nothing — a fact duplicated into the
  index is a fact that will silently rot there.
- **Anchor every platform claim.** A CommCare constraint carries its
  `file::function` when it is load-bearing. A claim with no anchor is a claim
  nobody can re-verify when upstream moves.
- **A new unit is a new file, and its name is its identity.** Adding one means
  a slug-named file under `complex-app/`, an entry under
  [What remains](#what-remains), and a dependency row — never a section
  grafted into this file, and never a numeric label: units are referenced by
  name everywhere, so shipping one leaves no gap and nothing ever renumbers.
