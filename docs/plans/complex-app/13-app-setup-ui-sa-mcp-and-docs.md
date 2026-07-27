# Unit 13 — App setup's remaining sections, SA, MCP, and docs

**PR:** `App setup: organization, automations, and deployment`

**Depends on:** units 8, 9, 10, 11, and 12. · **Blocks:** nothing.

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
docs for units 8 through 12, and the cross-facility owner/restore walkthrough
scenario.

Unit 7 already ships the **user-property, user-type, and persona** vocabulary on
all three authoring surfaces: builder, Solutions Architect, and MCP. Its shared
`getUsers` plus granular add/update/remove tools are an existing contract. This
unit may consume and preserve those tools while completing the remaining App
setup vocabulary; it must not rebuild, duplicate, defer, or rename them.

**Observed:** every capability from units 8 through 12 is reachable without chat,
and everything App setup can author is reachable from chat and MCP.
