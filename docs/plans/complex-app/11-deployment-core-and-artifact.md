# Unit 11 — Deployment core and artifact

**PR:** `Durable deployment records, ownership mappings, and the setup artifact`

**Depends on:** units 8 and 10 for artifact content. · **Blocks:** units 6, 12,
and 13.

> Read [the binding contracts](00-contracts.md) first — the HQ deployment safety
> contract there (dependency graph, record keys, no auto-adoption, idempotent
> phases, the four distinct states) is this unit's specification.

Create durable deployment and resource mappings, state transitions, preflight,
ownership and adoption, independently retryable phases, the target-aware setup
artifact, and release/probe state. Establish the current upload lifecycle before
endpoint URLs or dependent drivers consume it.

The setup artifact is the regenerated, human-applied half of deployment: the user-
data field schema, the organization model (level definitions are UI-only — see
unit 12), and automations. It regenerates from the document on every export behind
a push port.

Its user-data half is already modeled. Each authored user property renders one
`Field` row on the target domain's `UserFields` definition, and `required_for` is
`["commcare_user"]`: HQ enforces `is_required` only when the pushed field's
`required_for` names the user type being created
(`custom_data_fields/edit_model.py::UserFieldsView.is_field_required`), and Nova
provisions mobile workers only. Whether a given persona actually satisfies a
required property is deliberately **not** a document finding — it depends on the
target, and gating the document on it would make marking an existing property
required impossible. It is a preflight check here.

Two other target-dependent values are absent from Preview until this unit
supplies them, and the authoring surface already says so: `commcare_project` (the
HQ domain slug) and `commcare_phone_number`.

The state machine is this unit's core deliverable, so it is enumerated here rather
than discovered later. A deployment is `preflight` while prerequisites are being
checked, `uploaded` once the app JSON lands, `built` once HQ has produced a build,
`released` once that build is released, and `runnable` once a released endpoint
URL has been probed. `incomplete` is the terminal refusal: any required phase that
fails lands there and withholds both `released` and `runnable`, and it is reached
from any earlier state. Every phase is independently retryable from the state it
failed in, and retrying never requires re-importing the app.

Existing export guards stay until unit 12 can satisfy them: you cannot upload an
app that references a resource you have not pushed.

Two organization prerequisites are **required** rather than advisory, so a
failure of either lands the deployment in `incomplete` and withholds `released`
and `runnable`:

- **A level that caps descendant case access needs a toggle on the target.**
  Nova's "cases reach down to this level" compiles to
  `LocationType.expand_view_child_data_to`, which only the
  `USH_RESTORE_FILE_LOCATION_CASE_SYNC_RESTRICTION` arm of
  `users/models.py::CouchUser._get_case_owning_locations` honours — the default
  path walks `get_queryset_descendants(...)` with no bound at all. Without the
  toggle the cap silently does nothing and workers receive cases from levels the
  author excluded, so this is a named target-domain prerequisite in the setup
  artifact, exactly like `MM_CASE_PROPERTIES`.
- **A ragged tree cannot be created through the location push.** A place that
  skips an intermediate level is legal in Nova, previews correctly, and exports
  to a `.ccz` faithfully, but HQ's location API refuses to create one — see
  [the deliberate target gaps](00-contracts.md#deliberate-target-gaps) for the
  anchors and the reasoning. Preflight it before external mutation and report
  which places are affected.

**Observed:** an author connects an HQ domain, sees exactly what Nova will create
there and what they must set up by hand, and can retry a failed phase without
re-importing the app.
