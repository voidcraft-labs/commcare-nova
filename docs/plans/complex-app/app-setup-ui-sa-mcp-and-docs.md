# App setup UI, SA, MCP, and docs

**PR:** `App setup: organization, automations, and deployment`

**Depends on:** [the organization model](organization-model-and-locations-store.md),
[usercase & wire](usercase-owner-sets-and-wire.md),
[automations](automations-and-setup-guidance.md),
[deployment core](deployment-core-and-artifact.md), and
[push and provisioning](push-and-provisioning-drivers.md). · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first — the workspace-structure,
> baseline-UI-review, and three-surfaces rules there are the acceptance criteria
> for this unit. Each prerequisite unit's file states the vocabulary it exposes.

**The App setup workspace already exists — inherit it, do not rebuild it.** It is
URL-owned at `/build/<appId>/setup/<section>`, reachable from expanded and
collapsed desktop navigation and the mobile path menu, and it already owns
breadcrumbs, deep links, route recovery, viewer mode, focus restoration, mobile
layout, and global Preview behavior. Its section vocabulary already names all
four sections; **Users & Personas** is built and the other three render an honest
not-built-yet state. Filling one is adding its content, not adding a workspace.

Build the Organization, Automations, and Deployment sections with responsive
layout, permissions, conflict and recovery states, deployment progress and retry,
and honest target prerequisites. Complete the SA and MCP tools and the public
docs for the five prerequisite units, and the cross-facility owner/restore
walkthrough scenario.

The **user-property, user-type, and persona** vocabulary is already shipped on
all three authoring surfaces — builder, Solutions Architect, and MCP
([what is built](../complex-app-plan.md#user-properties-user-types-and-preview-personas)).
Its shared `getUsers` plus granular add/update/remove tools are an existing
contract. This unit may consume and preserve those tools while completing the
remaining App setup vocabulary; it must not rebuild, duplicate, defer, or
rename them.

**Observed:** every capability from the five prerequisite units is reachable
without chat, and everything App setup can author is reachable from chat and
MCP.
