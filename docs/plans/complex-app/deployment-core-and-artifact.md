# Deployment core and artifact

**PR:** `Durable deployment records, ownership mappings, and the setup artifact`

**Depends on:** [the organization model](organization-model-and-locations-store.md)
and [automations](automations-and-setup-guidance.md) for artifact content.
· **Blocks:** [attachment emission](attachment-emission-and-link-ux.md),
[push and provisioning](push-and-provisioning-drivers.md), and
[App setup UI](app-setup-ui-sa-mcp-and-docs.md).

> Read [the binding contracts](00-contracts.md) first — the HQ deployment safety
> contract there (dependency graph, record keys, no auto-adoption, idempotent
> phases, the four distinct states) is this unit's specification.

Create durable deployment and resource mappings, state transitions, preflight,
ownership and adoption, independently retryable phases, the target-aware setup
artifact, and release/probe state. Establish the current upload lifecycle before
endpoint URLs or dependent drivers consume it.

The setup artifact is the regenerated, human-applied half of deployment: the user-
data field schema, the organization model (level definitions are UI-only — see
[push and provisioning](push-and-provisioning-drivers.md)), and automations. It
regenerates from the document on every export behind a push port.

Its user-data half is already modeled. Each authored user property renders one
`Field` row on the target domain's `UserFields` definition, and `required_for`
is `["commcare_user"]`, because Nova provisions mobile workers only. Whether a
given persona actually satisfies a required property is deliberately **not** a
document finding — it depends on the target, and
[what is built](../complex-app-plan.md#user-properties-user-types-and-preview-personas)
holds the enforcement site, including the same-named HQ function that is the
wrong one to read. It is a preflight check here.

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

Existing export guards stay until push and provisioning can satisfy them: you
cannot upload an app that references a resource you have not pushed.

**Observed:** an author connects an HQ domain, sees exactly what Nova will create
there and what they must set up by hand, and can retry a failed phase without
re-importing the app.
