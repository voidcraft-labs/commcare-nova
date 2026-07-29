# Binding contracts

The rules every unit of the complex-app program obeys. The unit files do not
repeat them; read this file once at the start of any unit, alongside
[what is built](../complex-app-plan.md#what-is-built).

Every CommCare citation uses stable names (`file::function`), never line numbers
— upstream lines rot silently.

---

## Delivery discipline

**Ship the end state.** A unit ships what it will finally be and nothing else. No
version floors, capability leases, reader-version gates, staged activation flags,
traffic-split controllers, or compatibility shims between a unit's own PRs. Work
splits across PRs for review, but no PR carries code that exists only because of
the split.

**Instant live.** A merge to `main` builds one image, runs pending migrations as a
blocking Cloud Run Job, and deploys one revision. That is the entire release
mechanism. Cloud Run waits for the startup probe before moving traffic; a deploy
may briefly interrupt the service, and that is accepted rather than engineered
around.

**Instant migration.** A data migration reaches its final shape in one step. It
never lands a transitional column, a dual-write, or a backfill that a later
release finishes. Migrations are additive where they can be and immediate where
they cannot; a migration that has run anywhere is immutable, because it must
still build a fresh database years later.

**Direct maintenance cutover.** A persisted-shape change that the old and new
revisions cannot both read is not forced through a rolling compatibility layer.
Its advisory production scan runs first. The exceptional operator runbook then
blocks ingress and every independent writer, drains in-flight work, proves the
database quiescent, and reruns the blocking scan under the migration's locks.
Only that frozen proof authorizes the one final-shape migration. The exact new
image then deploys and proves it can read the shape before writers and ingress
resume. A verified restore point, rollback decision, capacity proof, runbook,
and post-migration scan ship with the behavior. Failure after the first write
leaves traffic paused; an old revision never resumes against the new shape.
This is accepted downtime, not a staged rollout: there are no dual readers,
dual writes, temporary schemas, aliases, feature flags, version gates, or
traffic-split controllers.

**Valid by construction.** An invalid app cannot exist. Every mutation batch is
gated before it commits, identically on the chat SA, the visual builder, and the
MCP API. There is no save/validate/release cycle and no draft state. New
mutations follow the compatibility rules in `lib/doc/CLAUDE.md`: persisted
mutation history after the active baseline must always replay. When a stored
shape changes incompatibly, the same release either migrates the replayable
suffix or atomically establishes an explicit fold horizon whose earlier rows
remain opaque audit history.

**Runnable topology is closed.** Every module, form, field, and flat authored
entity appears exactly once in the membership sequence that owns it. Every
membership entry resolves to the expected record kind and valid parent. A
parent is required for an owned/nested kind and is exactly null for a
Blueprint-root or flat kind; an unexpected null/non-null parent, missing or
wrong-kind parent, cycle, duplicate membership, stray sequence key, or
record/sequence disagreement rejects the document. No authorable entity may
persist outside the runnable topology. Domain validation, the commit gate,
assembly, decomposition, reads, and writes enforce this same invariant; an
unreachable record is corruption to repair, never a tolerated draft or an
alternate storage dialect.

**Every wire unit names its fixture.** A unit that emits new wire states the
CommCare suite fixture under
`commcare-hq/corehq/apps/app_manager/tests/data/suite/` that its implementer and
its reviewer assert the emitted bytes against. The bar is "would HQ's importer
accept these bytes", never "does the shape look right", and it applies to tiles,
form links, endpoints, and multi-select alike.

Some shapes HQ never filed as a fixture file — it asserts them as inline
`assertXmlPartialEqual` partials inside its own test. Those partials **are** HQ's
canonical bytes; whether they live in a file is HQ's filing convention, not a
difference in authority. So where no fixture file exists, name the inline
assertion by `file::Class` and assert against it exactly as against a file. What
the rule forbids is unchanged either way: "I verified it against the emitter" is
not a byte assertion, and a unit that cannot name a byte oracle has not met the
bar.

**Every author-facing vocabulary ships its three surfaces.** A unit that adds
something an author can create also ships its SA tools, its MCP projection, and
its public docs — the three editors edit one document, so a vocabulary reachable
from only one of them is an unfinished feature, not a smaller one. Where a
vocabulary is deliberately builder-only, the unit says so and why.

**Nova is not CommCare HQ.** HQ, CommCare Core, Formplayer, and CommCare Android
establish only what the target wire and runtime accept, reject, or execute. Their
authoring models and UI are not Nova requirements, and "HQ does it this way" is
never a design argument. Nova emits one wire flavor: the maximal subset Web Apps
supports, faithfully.

---

## Approved product contracts

These decisions are closed unless the project owner explicitly reopens them.

### Identity and references

- **Every authorable Nova entity and every cross-object authoring reference is
  addressed by its immutable UUID on every editor surface.** This includes
  modules, forms, fields, select options, case-list columns, Search inputs,
  uploaded media assets, lookup tables, lookup columns and rows,
  worker-information properties, user types, personas, operations, organization
  levels, locations, sections, links, and endpoints. SA and MCP tools accept and
  return the same identity-bearing domain shapes the builder stores; they never
  introduce a parallel slug, path, tag, wire-name, position, or mutable-id
  address layer.
- A Nova UUID is lowercase hyphenated RFC form, version 1–8, with the RFC
  variant. Uppercase, nil, max, malformed, non-versioned, and non-RFC-variant
  strings are rejected rather than normalized. Domain-specific UUID identities
  may further restrict the version, such as UUIDv7 lookup ids.
- Human names, module/form/field ids, operation ids, Search input names, lookup
  tags, column wire names, worker-property slugs, level codes, location site
  codes, and endpoint ids are display projections, semantic values, or external
  contracts. They may be edited and emitted, but never substitute for Nova-owned
  identity.
- Ordering values describe placement only. They never identify the member being
  moved or edited.
- Same-call construction has no second handle vocabulary. A new object that
  another item in the call references predeclares its stable UUID. Topology
  parents are declared earlier; expression references resolve against the
  complete final same-call overlay, but identity visibility never relaxes
  runtime effect order: `id-of` and any value dependent on an operation result
  must target an earlier producer in the canonical operation sequence.
  Unreferenced objects may let Nova mint their UUIDs, and every creation result
  returns those identities structurally.
- App, Project/auth, case, actor/owner, thread, run, batch, capture-attachment,
  form-entry, and submission-intent ids are opaque storage or protocol
  identities, not authorable entity addresses. A schema may require UUID bytes
  for one of those protocols independently, but that does not make it a target
  in the authoring identity vocabulary.
- The sanctioned name-backed references are identities Nova does not own:
  `(caseType, property)` pairs for the CommCare case-data contract and explicit
  CommCare/session field names. They are final domain vocabulary, not
  compatibility aliases for a hidden Nova UUID.
- A rename or move does not rewrite a stored expression reference. Printers and
  emitters resolve its current external spelling from immutable identity.
- The human XPath editor is a text projection over the canonical stored AST.
  A person continues to type and read `#form/first_name`; the editor resolves it
  once, stores the target UUID, and later prints the target's current friendly
  path. It never asks a person to author `#form/<uuid>`.
  Reference-bearing prose is a structural editor projection: reference parts are
  inline identity-bearing atoms, while ordinary typed or pasted characters stay
  text until the author explicitly converts or inserts a reference. Machine
  editors read and write the canonical AST/template directly; they never send
  textual field paths or custom-worker slugs for Nova to resolve. A literal
  hashtag and an object reference therefore remain distinct values through
  edit, storage, and projection.
- External-contract names may require confirmation or elevated permission, but a
  rename never silently retargets or deletes a remote resource.

### Users, personas, and workers

- A **user type** is a reusable role/default-data template in the blueprint.
- A **preview persona** is a named design/test actor with stable identity,
  location assignments, and optional user-data overrides. It references a user
  type but is not the type.
- A **deployed worker** is a target-HQ identity associated with one deployment;
  provisioning is the lifecycle action that creates or adopts it. It is created
  from a type or persona, has separate credentials and lifecycle, and is not a
  blueprint identity.
- Preview exposes explicit **Preview as me**, **Preview as persona**, and
  authoring-only hidden-content inspection. These modes must not blend.
- Preview values must be honest. Target-dependent values such as the HQ domain
  slug are absent until a deployment target supplies them; Nova does not invent
  wire values to make a condition pass.

### HQ deployment safety

- Deployment is a dependency graph, not a fixed "app first, warn later" list.
  Required prerequisites are checked before destructive or externally visible
  mutation. A required dependency failure leaves the deployment `incomplete`,
  never ordinary success with a warning.
- A durable deployment record is keyed by Nova app, Project, HQ server, and HQ
  domain. Remote-resource mappings additionally key the Nova resource UUID and
  store ownership/adoption, remote id, pushed identity, and revision.
- Nova never auto-adopts a same-named HQ resource, overwrites an unowned
  resource, or deletes a remote resource on rename. First adoption is explicit.
  Renames create/repoint or update only resources Nova demonstrably owns, and
  report any old remote resource left behind.
- Phases are idempotent and independently retryable. Retrying a table or location
  push must not require importing a duplicate app.
- `uploaded`, `built`, `released`, and `runnable` are distinct states. Endpoint
  links are shown as durable only after their deployment is released and the URL
  has been probed.
- Endpoint URLs derive from the selected HQ server. `lib/commcare/client.ts`
  resolves its base URL per credential server from `COMMCARE_SERVERS`. Two
  suite-emission constants still hardcode the US host and must move to the
  selected server before endpoints ship —
  `lib/commcare/suite/case-search/claim.ts::CLAIM_URL_TEMPLATE` and the search
  template in `lib/commcare/suite/case-search/searchSession.ts`.

### Deliberate target gaps

- **Tile controls HQ cannot express.** Tiles per row and square cells are
  excluded from constructible state. These are not fields HQ round-trips badly —
  HQ has no model field for either, never emits the corresponding attributes, and
  can reach them only through a raw `Detail.custom_xml` escape hatch. They exist
  solely as `<detail>` attributes the client reads (`fit-across` and
  `uniform-units`, both in
  `commcare-core/.../org/commcare/xml/DetailParser.java::DetailParser.parse`),
  defaulting to one tile per row and content-sized rows. Because they are absent,
  Nova's tile renderer pins those two runtime defaults explicitly rather than
  leaving them implied.
- **Case attachment display is link-first.** URL-property mode is the normal
  path. The deprecated `MM_CASE_PROPERTIES` attachment mode is an explicit
  opt-in that works only on a domain carrying HQ's `MM_CASE_PROPERTIES` toggle —
  a target-domain prerequisite recorded in the deployment record and the setup
  artifact, never the default. On a stock domain
  `update_strategy.py::_apply_attachments_action` returns before doing anything,
  so the block parses and is then silently dropped. Inline picture presentation
  is not promised until the Web Apps HTTPS-resource path works.
- **Smart-link authoring does not ship before Nova models data-registry search.**
  No unused emission helper lands as speculative machinery.
- **Long-detail tiles are out of scope.** Tiles apply to the short and
  search details; the case-detail view emits a plain field list.
- **The offline demo sandbox is out of scope.** A `.ccz` can embed a complete
  `<user-restore>`, but Web Apps never boots it — Formplayer installs the
  resource and has no practice-login path, so restores are always live HTTP
  (`OfflineUserRestoreInstaller`). The mechanism is recorded for a future
  mobile-offline story.

---

## Architecture contracts

### One Postgres system

All persistent state uses the Cloud SQL Postgres pool and the Kysely migration
owner.

Lookup definitions and rows are Project-scoped. Organization and persona data are
app-scoped unless a later approved contract says otherwise. Every table has
explicit tenancy keys, authorization, project-move behavior, indexes, migration
ownership, and retention/deletion behavior.

Realtime updates use committed rows plus LISTEN/NOTIFY pokes and cursor/revision
catch-up. Notifications are never the data plane.

Build, migration, and runtime identities are separate. Migration owns fixed
schema objects; the `cases` schema is isolated and runtime-owned because runtime
creates indexes concurrently, which requires table ownership rather than grants.

### New top-level blueprint collections

A vocabulary that is a genuinely new collection — not a new slot on a module,
form, or field — mints **ordinary new mutation discriminators**. There is no
honest way to ride an existing one: a user type is not a refinement of a form,
and encoding it as one puts a lie in the durable log, breaks
`batchTargetsMissing`, and poisons the reference index. The standing rules are:

- Optionality and empty-value omission follow the domain meaning and storage
  shape, never a pre-deploy reader. Compact empty collections may still be
  omitted, but no feature earns a second mutation or document dialect from that
  choice.
- New `blueprint_entities` kinds get an **explicit branch** in the row
  classifier. Its shape is `if module / else if form / else field`, so a kind
  that falls through is read as a field, fails `blueprintDocSchema`, and stops
  the whole app from loading rather than losing one row.
- Every editor, route, event, durable row, and reducer uses one canonical
  `mutationSchema`. There is no carrier-blind/rolling schema, origin projection,
  pre-deploy fallback body, or duplicated semantic-and-wholesale mutation.
  Fine-grained patches remain when they are the final merge unit; they do not
  travel beside a second whole-object payload for an older reducer.
- An incompatible persisted mutation or document change uses the direct
  maintenance cutover and an explicit fold horizon. Older rows remain opaque
  audit history and old clients reload; runtime code does not retain a second
  parser or reducer to make them live.
- Collections that are flat carry a **membership array beside the record**, the
  same shape every hierarchical collection uses: the array is the sequence, and
  record holds the entities. A record and its array cannot silently disagree
  because the assembler throws on exactly that mismatch
  (`lib/db/blueprintRows.ts::assembleBlueprint`), which is the guard
  `moduleOrder` and `formOrder` have always relied on.

  Sequence is **never** a value stored on the entity. Nothing in `lib/doc` mints,
  compares, or repairs an ordering key: a position computed on the client is a
  pure function of the sequence that client can see, so two people inserting at
  the same place from the same starting document compute the *same* position —
  and no position exists between two equal ones, which silently strands every
  later insertion between them. Position belongs to the collection, not to the
  member.

### Exact external-reference governance

Lookup table/column and location references participate in exact, transactional
reference-edge maintenance. A best-effort scan cannot authorize a destructive
schema change, because it races a concurrent app commit.

The authoritative app commit rebuilds the fresh blueprint and validates it with
fresh Project-scoped external context inside the consistency protocol. Optimistic
client validation may use a revisioned snapshot for fast feedback, but the server
result wins. Missing and foreign-Project resources are indistinguishable and fail
closed for newly introduced references — a differing message would confirm that a
resource exists in a Project the caller cannot see.

Two lock prefixes share one global order. App commits, Project moves, and
reference-edge writes take the app row, then lookup tables in canonical UUID
order, then thread rows. Lookup resource writes — row and definition edits, and
schema governance — never take an app lock at all: their complete prefix is
Project state, then the target table, then the exact edges
(`lib/lookup/schemaGovernance.ts::applyLookupSchemaGovernanceInTransaction`).
Because neither prefix ever holds a lock the other takes first, a table deletion
racing an app commit serializes rather than deadlocking.

### Case operations and submissions

- All expressions for one submission evaluate against a single pre-submission
  snapshot. Effects then apply atomically in declared order.
- Repeated creates have iteration-correlated outputs. A singular operation
  reference cannot escape its repeat or ambiguously name multiple created cases.
- Runtime-resolved targets are tenant-bound and must match the declared case
  type. Client-submitted descriptors are parsed as data, never trusted authority.
- Retype is a real schema transition. It succeeds only when the current
  conversion/parking/data-review model can complete atomically; otherwise the
  operation rejects without partial writes.
- The preview store exposes one atomic submission envelope containing ordinary
  form behavior plus advanced operations. It is not a mutually exclusive fifth
  submission variant.

### Locations and restore scope

Organization structure lives partly in the blueprint and partly in app-scoped
rows, so mutations and row writes share the app-row lock discipline. Removing or
retyping a level, archiving a referenced location, moving an app between
Projects, and adding a reverse-hop expression must account for current rows and
references atomically.

Location custom fields use one app-wide catalog with optional applicable-level
UUIDs. Level codes and site codes are create-once external identities; display
names may change independently.

Restore scope has an authoritative Postgres revision. Client invalidation reuses
the existing case-data invalidation channel; session-local Cloud Run memory is
never the source of truth. Start with the measured CTE inline and materialize
only when measurements justify the storage and invalidation cost.

---

## UX and information architecture

### Design-system authority

Nova generally follows **Google Material 3** for foundations, design tokens,
adaptive layout, interaction states, accessibility, content hierarchy, and
motion. **Apple HIG** supplies platform polish where it improves focus,
keyboard/pointer behavior, touch ergonomics, and motion without contradicting
Material 3, web semantics, or Nova's established visual language.

Precedence for implementation:

1. accessibility, semantic HTML, and valid interaction behavior;
2. the explicit product and UX contract in this document and the active unit;
3. Nova's existing semantic tokens, components, and `components/CLAUDE.md`
   conventions;
4. Material 3 guidance;
5. Apple HIG polish.

This does not mean copying Google's component catalog or Android UI. It means
using the underlying system deliberately: token-driven color/type/shape/spacing;
clear hierarchy and containment; consistent enabled/hover/focus/pressed/dragged
states; adaptive rather than merely scaled layouts; and motion that explains
state or spatial relationship.

### Baseline UI review

- semantic landmarks and sequential headings, logical DOM/focus order, visible
  keyboard focus, focus entry/return for dialogs and route changes, and labels
  that describe purpose rather than icon appearance;
- at least 48 × 48 CSS-pixel touch targets where the mobile layout permits and
  never below a 44 × 44 pointer target, normally separated by at least 8 px;
- text and graphic contrast, text resizing without clipping, RTL-safe ordering,
  and no state conveyed by color alone;
- explicit compact, medium, expanded, large, and extra-large behavior. Material's
  600/840/1200/1600 width boundaries are the review grid; a unit may retain
  Nova's existing breakpoint tokens when it documents equivalent behavior;
- one pane at compact widths, deliberate list-detail or supporting-pane reflow
  where added space improves the task, and more information rather than merely
  larger controls at wide widths;
- complete loading, empty, disabled, stale, conflict, selection, hover, focus,
  pressed, and dragged states using existing semantic tokens; and
- restrained, coherent motion with reduced-motion behavior. Utility transitions
  stay quick; exits are faster than entrances; large expressive transitions are
  exceptional rather than builder-wide decoration.

### Workspace structure

The structure tree represents the runnable app: modules, case-list surfaces,
forms, and eventually their nested structure. Project and app administration does
not masquerade as a child of that tree.

- **Project data** is a URL-owned workspace for Project-shared lookup tables. It
  is reachable from expanded and collapsed desktop navigation and the mobile path
  menu, and it always states that changes affect every referencing app.
- **App setup** is a URL-owned workspace with Users & Personas, Organization,
  Automations, and Deployment sections.
- Configuration workspaces own breadcrumbs, deep links, route recovery, viewer
  mode, focus restoration, mobile layout, and global Preview behavior.
- Destructive or dependency-affecting edits explain consequences before commit.
  Recoverable data edits use inverse-action undo or archive where practical;
  implementation boundaries do not become permanent "No undo" boilerplate.
- Drag/resize/reorder interactions have keyboard and numeric alternatives, stable
  focus, meaningful disabled-drop explanations, and adequate touch targets.
- Empty, loading, stale, conflict, and permission states are acceptance criteria,
  not polish deferred beyond the feature PR.
- Automations do not pretend to execute inside Preview. The UI explains cadence
  and may show a safe read-only "currently matches N cases" evaluation.
