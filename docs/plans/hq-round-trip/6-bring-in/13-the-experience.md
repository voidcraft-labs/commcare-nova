# Step 6, part 13: The experience

This part plans everything a person, an agent or a reader of the docs meets when an app is brought in
from CommCare HQ: the three entry points; the flow as one URL-backed surface of `/build/new` (choose,
read, a stop, the account, the review, create, land); what the home list shows; what the Publishing
card, the Publish dialog, the drift stop and a restore say afterwards; the components, their pure
state model and their Playwright specs; the six MCP tools this part registers and what five existing
tools gain; the guide's paragraph; the nova-plugin skill and its sweep; and the public docs. It draws
exactly the answers and sentences that part 01 (`01-the-bar-and-the-manifest.md`), part 05
(`05-reading-commcare-hq.md`), part 09 (`09-acceptance-and-the-first-publish.md`), part 10
(`10-identity-and-the-ledger.md`), part 11 (`11-project-data.md`) and part 12
(`12-the-reading-and-the-birth.md`) define. It adds nothing a server stores: a read and a create are
part 12's two requests, and everything between them lives in the page's address and the tab's own
state. The other parts it cites are part 06 (`06-the-reader-forms.md`), part 08
(`08-the-reader-expressions.md`) and part 15 (`15-changes-made-in-commcare-hq.md`), which owns
everything a person meets when a change made in CommCare HQ is brought in. A citation "(part 12,
5.1)" is section 5.1 of that part's file; where a part's section is named and not numbered, the
name is its heading.

Citations are `path::symbol`: Nova at `main` `1f103305`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. This
part couples to CommCare HQ in one place of its own, the addresses of five HQ pages the account links
to (section 7.4), read at `d6c6e16d8ae1` and lifecycle-cited there. Every other HQ fact it shows a
person is another part's, cited where it is used.

| Section | Owns |
|---|---|
| 2 | the three entry points |
| 3 | the flow as one surface: where it mounts, its URL, what a refresh does, its pure state model |
| 4 | choosing a Project, a project space and an app; the picker's route and the connection's |
| 5 | reading, with its named stages |
| 6 | a stop |
| 7 | the account |
| 8 | the review |
| 9 | creating, landing, and what the builder shows first |
| 10 | the home list: what it does not show, and the empty state's refresh |
| 11 | after the app is in: the Publishing card, the first publish, the drift stop, a restore |
| 12 | component inventory, primitives, state |
| 13 | accessibility; empty, error and loading states of every screen |
| 14 | MCP: six tools registered, five tools changed, progress, error shapes, `servedSchemas` |
| 15 | the guide, and what of this part reaches a model |
| 16 | the nova-plugin: the `bring_in` skill, the sweep, the version |
| 17 | public docs and `design/readme.md` |

---

## Decisions in brief

1. **Three entries, one destination** (2): an outline button beside "New app", a line under "Get
   started" in the empty state, and a second outline button under the "or" on `/build/new`. Each
   leads to `/build/new?hq=choose`.
2. **The flow is a state of `/build/new`, never a dialog** (3.1). It takes the centred column in place
   of the composer, inside `ChatContainer`'s tree, so a created app lands through part 12's
   `landCreatedAppReceipt` and "Creation never navigates" holds.
3. **The URL is `/build/new?hq=choose` while choosing, and from the moment an app is chosen it names
   that app** (3.2): `/build/new?hq=app` with the Project, the server, the project space and the HQ
   app's id. A refresh of the first shows the picker with its defaults. A refresh of the second reads
   the app again and shows where it stands now, unless the tab holds the key of a create in flight
   for that app, in which case it sends that create again (9.1). The server stores nothing between a
   read and a create (part 12), so the address is the whole of what comes back after a reload.
4. **The whole flow is one pure model** (3.3): a reducer over events and a function that says what
   the hook does next. Vitest tests the model; no component holds a decision.
5. **Step one asks three things in one screen** (4): the Project ("Add it to", preselected to the
   Project the tab is looking at where the person can add to it), the project space, and the app.
   The picker reads CommCare HQ through one new route, `GET /api/commcare/hq-apps`, which
   `/api/commcare` already admits.
6. **A row the person cannot bring in says why and what to do, in the list** (4.3): already in Nova
   with Open; already in Nova in a Project they are not part of, with who to ask, since when, and
   the two ways forward. A linked or deleted app is learned when the app is read, as a stop (6).
7. **No connection is a step of the picker, not an error** (4.4): the connection aside the Publish
   dialog shows, extracted and reworded for reading. "Check connection" reads the connection through
   one new route, `GET /api/commcare/connection`, and never through the Next router, in the picker
   and in the Publish dialog alike (Departure 3).
8. **Reading shows the stage that is running, by name, and a count of files that moves** (5): the
   stages arrive as lines of the read's own response (part 12, 4.3), under one spinner,
   with a reassurance after twenty seconds and one sentence on what leaving does. A read is one
   request: closing the tab stops it, nothing is created, and coming back reads the app afresh. No
   percent, no ladder of results.
9. **A stop is its own screen and is never mixed into an account** (6): part 01's block, one
   sentence that nothing was created (under every stop but `already-in-nova`), and the actions the
   code allows.
10. **The account groups findings by place in the app's own order, under three labels explained
    once** (7), each group with a link to that page in CommCare HQ. Under the groups it says a later
    check may find more (part 01's `ACCOUNT_CHECK_AGAIN_LINE`), and it ends in Copy the list, Check
    again and Done. Nova keeps no account: Copy the list is how a person keeps one, and the address
    and Check again are the way back.
11. **The review is one screen with no ticks** (8). Where it runs is a preselected choice with the
    reason beside it; the date-and-time split is one of the choices; a table that meets one the
    Project has is two named answers; "After it's in" says what follows, and part 09's "What the
    first publish changes" lists it from the chosen row's own list, redrawn when the row changes.
12. **"Bring it in" stays enabled** (8.9). Pressed with a table choice unanswered, it sends nothing,
    moves focus to that choice and says what is missing.
13. **A create is one request, and the creating screen stands from the press to its end** (9.1). A
    review that comes back keeps the person's answers wherever they still apply (`carryAnswers`,
    3.3), and a reload during a create sends the same create again, from one key kept in the tab.
14. **A brought-in app lands on its own home in the builder, with one toast that leads to Publishing**
    (9.3). Nothing is written into the conversation.
15. **The home list holds no row for an app that is being read** (10). There is nothing to list: a
    read leaves nothing behind. The empty state gains the list's own refresh, so a home that was
    empty when the flow was entered shows the app after it lands.
16. **The Publishing card of a brought-in app says where it came from, and every card with a live
    app mapping offers "Stop publishing here" to an admin or owner** (11.1; Departure 10), the
    members whose role allows `delete`. An ended deployment draws part 10's line and no ladder.
17. **The first publish says what it changes in the Publish dialog and over MCP** (11.2), from part
    09's `DeploymentView.firstPublish`, the list the person reviewed, which part 09 keeps on the
    read baseline until Nova's first push (its 12.3). This part adds no column and no migration.
18. **A drift stop whose changes hold the app's own shows part 15's panel where the change can be
    brought in, and otherwise offers "Stop publishing here" under the list of changes** (11.3),
    whatever the app's origin, with part 10's origin-aware sentences.
19. **Six MCP-only tools are registered** (14): `list_hq_apps`, `read_hq_app`, `bring_in_hq_app`,
    `stop_publishing`, `refresh_managed_data` and `set_lookup_table_management`. The Solutions
    Architect is given none of them. `read_hq_app` is one whole read and `bring_in_hq_app` one whole
    create: neither has a deadline of Nova's own, both report progress, and checking again is
    calling `read_hq_app` again. Part 15 registers two more beside them, `read_hq_changes` and
    `bring_in_hq_changes` (14.1).
20. **`bring_in_hq_app` takes every answer as a required argument and has no default** (14.4): the
    name, where it runs, the split and each table choice, beside the Project, the app and the
    reading the review came from.
21. **`check_project_space_compatibility` returns `first_publish`** (14.7): part 09's
    `firstPublishLines` value, built for the publish surface, for an app brought in and not yet
    published and for a `next-publish` list of part 15's (its section 9.4), and null otherwise.
    `read_hq_app` returns the same object on each `review.runs_on`
    entry, built for the review. An agent relays `workers.lines` first, then `hq_only.lines`, each
    `sentence` as written, then `reassurance` where it is not null, then `note`.
22. **The guide gains one paragraph** (15). It is the one change of this part that reaches a stored
    model context: the six new tools and the five changed ones are served by MCP alone.
23. **The plugin gains the skill `bring_in`, and `upload_to_hq` is swept by claim** (16), two
    sentences of part 01's and two of part 11's among what it gains. Its version becomes `2.5.0`, and
    its pull request merges after the step's deploy is live.
24. **One new docs page, `content/docs/bringing-in-from-commcare-hq.mdx`** (17), and the sentences of
    nine existing pages (the eight of 17.2 and `mcp/tools.mdx`, 17.3), the two Claude Code pages that
    describe the plugin's commands among them. Each lands with the behavior it describes.

---

## Executed during planning

Read, by file and symbol. Nothing was run but `rg`, `sed` over single files and directory listings.

- **The other parts of this plan**, for every type, answer and sentence this part draws: part 01
  (sections 6.5, 8 and 9), part 05 (sections 4, 5, 11 and 13), part 06 (section 16.3), part 08
  ("Copy"), part 09 (sections 11 and 12 and "Copy"), part 10 (sections 5.4, 5.5, 6.5, 8 and 9 and
  "Copy"), part 11 (sections 7 and 12 and "Copy"), part 12 (the read, the create, the stream,
  the review of its 5.1, the receipt of its section 7, and "Copy") and part 15 (sections 8, 9 and
  10, "Copy" and "Contracts and docs these changes make false").
- **The design system**: `design/readme.md` whole; `components/CLAUDE.md` whole;
  `components/builder/CLAUDE.md`, "Creation never navigates", "Publishing" and "App setup, Publishing";
  `e2e/CLAUDE.md`, every bullet from "Hermetic, free, no real GCP" through "Case-workspace visual QA
  has one canonical fixture".
- **Home**: `app/(app)/(site)/app-list.tsx::AppList`; `page.tsx::HomePage`, `GetStarted`,
  `AppListFallback`; `app-actions.ts::RestoreAppResult`; `RefreshStaleAppList.tsx` and
  `lib/ui/appListFreshness.ts::markAppListStale`, `consumeAppListStale`, with their one caller.
- **`/build/new`**: `app/(app)/build/[id]/[[...path]]/page.tsx::BuilderPage`, `freshBuildPage`,
  `resumedDesignPage`; `components/chat/StartFromScratch.tsx::StartFromScratch`;
  `components/chat/ChatContainer.tsx::installCreatedApp`, `verifyActivationDigest`,
  `handleCreateStarterApp` and the render that passes `startFromScratch`;
  `components/chat/ChatSidebar.tsx`, the centred layout and its empty state;
  `lib/routing/useClientPath.ts::pushBuilderHistory`, `useBuilderSearch`;
  `lib/routing/historyPolicy.ts::scopedBuilderHistoryState`, `builderNavigationUrl`;
  `lib/routing/types.ts`, the App setup sections; `lib/session/hooks.tsx::useProjectId`,
  `useProjectCanEdit`; and, for what a router refresh does to an address the History API wrote,
  `node_modules/next/dist/client/components/app-router.js` (the history updater and the patched
  `pushState` and `replaceState`).
- **Publishing**: `components/builder/PublishDialogBody.tsx::publishPlanCopy`, `RemoteChangeChoice`,
  `ProjectSpaceCompatibilityNotice`, `NotConfigured`, the private `PublishPlan`, and the function
  list of the file; `components/builder/PublishPanel.tsx::handleRefreshHqConnection`;
  `components/builder/CommCareConnectionContext.tsx` whole;
  `components/builder/DeploymentStatus.tsx::DeploymentStatus` (its props and the head of its body);
  `components/builder/app-setup/publishingSectionModel.ts` and `components/builder/publishOutcome.ts`
  (their exports); `lib/deployment/actions.ts::DeploymentView`;
  `components/builder/detail/appSettings/AppPlatformsSection.tsx::CHOICES`, `checkPlatformChange`;
  `lib/domain/platforms.ts::PLATFORM_DECLARATION_LABELS`, `PLATFORM_FEATURES` (its labels),
  `platformPickerLine`, `platformRefusalMessage`, `inPlatform`;
  `components/builder/shared/datetimeSplitNotice.ts::SPLIT_DATETIME_LABEL`.
- **MCP**: `lib/mcp/server.ts::registerNovaTools`; `lib/mcp/scopes.ts` whole;
  `lib/mcp/tools/deploymentTools.ts` whole; `checkProjectSpaceCompatibility.ts` whole;
  `getHqConnection.ts` whole; `getApp.ts` (that it returns no address); `lib/mcp/errors.ts` whole
  (`HqToolErrorType`, `UploadErrorType`, `McpErrorType`, `McpErrorPayload`, `McpInvalidInputError`,
  `toMcpErrorResult`); `lib/mcp/__tests__/servedSchemas.test.ts` whole and the list of
  `lib/mcp/__tests__`; `lib/mcp/resultSize.ts::MAX_RESULT_SIZE_CHARS`;
  `lib/mcp/progress.ts::ProgressStage`, `createProgressEmitter`; `lib/mcp/context.ts::McpCallExtra`,
  `initMcpCall`; `lib/mcp/tools/uploadAppToHq.ts` (where it sends progress);
  `config/runtime-capabilities.json::cloudRunRequestSeconds`; `lib/hostnames.ts::AS_ORIGIN`;
  `lib/utils/canonicalJson.ts::canonicalJsonDigest`;
  `node_modules/zod/v4/core/json-schema-processors.js`, the object processor (when it writes
  `additionalProperties: false`).
- **Shared pieces**: `lib/commcare/servers.ts` whole; `biome.json`, the `noRestrictedImports` rule
  over `@/lib/commcare` and its list of allowed consumers; `lib/deployment/types.ts::
  deploymentServerLabel`, `isDeploymentServer`, `DeploymentConfirmationKey`;
  `lib/deployment/service.ts::hqAppUrlFor`;
  `lib/deployment/setupArtifact.ts::hqBase` and the addresses it builds; `lib/ui/toastStore.ts::
  showToast`, `showProjectToast`; `lib/session/hooks.tsx::useCanDelete`;
  `components/shadcn/badge.tsx` (its variants) and the list of `components/shadcn`;
  `lib/publish/planFeatures.ts::PLAN_FEATURES`; `lib/projects/membership.ts::listUserProjects`,
  `ProjectSummary`; `lib/db/settings.ts::getCommCareSettings`, `CommCareSettingsPublic`;
  `app/api/media/[assetId]/extract/route.ts::POST` (a route that answers NDJSON lines today);
  `docs/testing.md`, "Do not pin incidental strings" and the MCP handler paragraph.
- **The agent**: `lib/agent/CLAUDE.md`, the paragraph that binds `MODEL_CONTEXT_VERSION`;
  `lib/agent/authoring/reference.ts::AUTHORING_REFERENCE` (its `workflows` entry);
  `lib/agent/authoring/__tests__/platformGuide.test.ts` (its head); `lib/agent/sharedToolRegistry.ts`
  (that it holds none of the deployment tools); `scripts/test-schema.ts`, its header and imports.
- **The plugin**: `../nova-plugin/.claude-plugin/plugin.json`; `skills/upload_to_hq/SKILL.md`, the
  passages quoted in section 16; `skills/find/SKILL.md`; `README.md`; the `.dev-plugin/` mirror.
- **Docs**: `content/docs/meta.json`; `index.mdx`; `publishing.mdx`, its opening, "The six stages",
  the head of "Checked", "On CommCare HQ" to "Changes made in CommCare HQ", and that section;
  `building-with-nova.mdx`, its head and "Start with a blank
  app"; `mcp/tools.mdx`, "Browsing apps", "Checking project-space compatibility", "Creating and
  deleting apps" and "Publishing"; `project-space-compatibility.mdx`, "Plan features";
  `case-workspace.mdx`, the paragraph that says "imported app"; `claude-code/commands.mdx`, its
  opening and `/nova:upload_to_hq`; `claude-code/quickstart.mdx`, the paragraph on uploading.
- **e2e**: `e2e/tests/browser/publishing.spec.ts` (its peer, its routes and its imports);
  `e2e/tests/app/publish-flow.spec.ts` (its seed and loads); `e2e/lib/smokeProfiles.ts::
  SMOKE_PROFILES` and `e2e/lib/smokeSeedFactory.ts` (where a profile and its builder are
  registered); the lists of `e2e/lib`, `e2e/tests/browser` and `e2e/tests/app`.
- **CommCare HQ at `d6c6e16d8ae1`**: `corehq/apps/app_manager/urls.py::app_urls` (`view_app`,
  `app_settings`, `app_languages`, `view_module_legacy`, `view_form_legacy`);
  `views/modules.py::view_module_legacy`; `views/forms.py::view_form_legacy`;
  `views/view_generic.py::view_generic`, `_get_module_and_form`;
  `models/applications.py::Application.get_module`; `models/modules.py::ModuleBase.get_form`;
  `tests/test_views.py::test_view_module_legacy`, `test_view_form_legacy`;
  `corehq/apps/fixtures/urls.py`.

Facts checked at source, each of which a decision of this part rests on:

- **`NotConfigured` cannot be reused as it stands.** It is a private function of
  `PublishDialogBody.tsx` whose three strings are about uploading ("Connect CommCare HQ to upload",
  "to upload directly from commcare nova", "You can still choose a CommCare HQ app file or mobile app
  file above"). Its frame is extracted into `components/builder/HqNotConnected.tsx` with the words
  as props (4.4).
- **The picker has no row state for an app in Nova's recently deleted.** The claim passes over a
  deleted holder (part 10, Departure 1), so an HQ app whose only Nova app is in recently deleted is
  free in the picker.
- **A disabled "Bring it in" cannot say what is missing.** A disabled button cannot say what is
  missing to a keyboard or screen reader user at the moment they press it. Decision 12 keeps the
  button enabled.
- **The platform choice is not reusable from `AppPlatformsSection.tsx`.** Its `CHOICES` lines are a
  module constant of that file, and its check (`checkPlatformChange`) reads a saved app through the
  reconciler. The review has no app. The three lines move to
  `lib/domain/platforms.ts::PLATFORM_DECLARATION_LINES`, which both read (8.3).
- **`CommCareConnectionContext` holds no refresh today, so "Check connection" cannot call one.**
  `CommCareConnectionContext.tsx::CommCareConnection` holds `configured`, `server`
  and `availableDomains` and no refresh. The dialog's is `PublishPanel.tsx::
  handleRefreshHqConnection`, a transition around `router.refresh()`. That cannot serve the flow:
  `pushBuilderHistory` writes its address with Next's own history state spread into it
  (`historyPolicy.ts::scopedBuilderHistoryState`), Next's patched `pushState` leaves its canonical
  address alone for a state that carries its marker, and its history updater writes that canonical
  address back on the next router change (`next/dist/client/components/app-router.js`). A refresh
  on `/build/new?hq=choose`, reached from the composer, would put `/build/new` back in the address
  bar. This is the hazard `components/builder/CLAUDE.md` records under "Creation never navigates".
  The context gains a refresh of its own that does not touch the router (4.4, Departure 3).
- **The home's empty state never refreshes after an app lands.** `RefreshStaleAppList` refreshes
  where `consumeAppListStale()` is true, a note `ChatContainer.tsx::installCreatedApp` sets for
  every birth. `app-list.tsx::AppList` mounts it and `page.tsx::HomePage`'s empty branch does not,
  so a person who starts from "Build your first app", lands an app and presses Back gets the
  cached empty state. That is so today for a blank or a designed app, and the empty state's new
  entry (section 2) adds a third way to meet it. The empty branch mounts the refresher too (10).
- **`hqPlaceUrl` cannot live in `components/bring-in` and read `lib/commcare/servers.ts`.**
  `biome.json` refuses `@/lib/commcare/*` to `components/**`, and
  `lib/deployment/types.ts::deploymentServerLabel` exists for that reason. `hqPlaceUrl` lives in
  `lib/deployment`, an allowed consumer, where `service.ts::hqAppUrlFor` already builds the same
  kind of address (7.4).
- **An address of an HQ page that names a menu or a form by its position works at position zero.**
  `view_generic.py::_get_module_and_form` tests `if module_id:` on the URL's
  text, and `"0"` is true; `Application.get_module` and `ModuleBase.get_form` are both wrapped in
  `@parse_int([1])`, and HQ's own `tests/test_views.py::test_view_module_legacy` and
  `test_view_form_legacy` open such addresses and expect the page (7.4).
- **The tools this part changes are served by MCP alone.** `lib/agent/sharedToolRegistry.ts` holds
  none of `check_project_space_compatibility`, `get_deployment`, `refresh_deployment`,
  `upload_app_to_hq` and `get_hq_connection`: `lib/mcp/server.ts` registers each directly. So no
  description this part changes is in a stored model context (15.2).

---

## Written and not yet run

Two things wait on execution, and each ends in an action the session takes alone.

- **The Playwright specs** ("Tests") decide no fact. They run in the work's own CI on hosted
  runners. A failing spec is a defect in the screen or the spec, and is fixed there.
- **The plugin sweep** (16.3). Where: the session's shell, at the step's head, free: a reading by
  claim of `../nova-plugin`'s `skills`, `agents`, `.dev-plugin` and `README.md`, with `rg -i` to
  find the passages. Outcomes: no sentence beyond the edits of section 16 is made false by the
  step, and the one plugin pull request carries those edits alone; or a further sentence is made
  false, and it is corrected in the same pull request, with both `plugin.json` versions moved
  once. Where the plugin's head has moved since `0a67203`, each version is the next minor from
  what it then holds.

The billed schema check is the top-level file's (`../6-bring-in.md`). Nothing of this part is on
its list (15.3).

---

## 1. What Nova does today

**Starting an app.** `app/(app)/(site)/app-list.tsx::AppList` draws "Your apps" with one button, "New
app", a link to `/build/new`, where the member's role allows `edit`. `page.tsx::HomePage` shows
`GetStarted` ("Build your first app", the button "Get started") where the Project has no app and the
person no design in progress (`projectHasApps`, `userHasDesignsInProgress`). `/build/new` is
`page.tsx::freshBuildPage`: a `BuilderProvider` with `buildId="new"` seeded from the active Project,
whose `ChatContainer` renders `ChatSidebar` centred, with `StartFromScratch` under the chat card ("or",
then "Start with a blank app" and "Build it yourself, with Nova here whenever you want a hand").
`/build/new?design=<id>` reopens a design (`resumedDesignPage`). Nothing reads an app from CommCare
HQ.

**Landing.** Both births hand `ChatContainer.installCreatedApp` one receipt behind
`parseAppMaterializationReceipt`, and it promotes `/build/new` to `/build/{id}` through
`pushBuilderHistory`, never the Next router (`components/builder/CLAUDE.md`, "Creation never
navigates"). `handleCreateStarterApp` refuses a receipt whose Project is not the session's and shows
the persistent toast "Reload to finish opening this app".

**The home list** has one pre-app section, "Designs in progress"
(`designs-in-progress.tsx::DesignsInProgress`): rows with a title, a stage in words, a relative time,
Continue and a confirmed Discard.

**Publishing.** `PublishDialogBody.tsx` holds the one publish flow. `publishPlanCopy` says "This
updates the app already in this project space.", "This creates a new app in this project space." or
"Nova made an empty app here on an earlier try. Uploading fills it in.". `RemoteChangeChoice` lists
each change made in CommCare HQ with one unticked "Publish over this". `NotConfigured` is the amber
aside with "Open Settings" and "Check connection". `DeploymentStatus` draws a record's ladder, its
confirmations, what was left behind and, in the Publishing section, the Workers panel. No surface says
an app came from CommCare HQ, and nothing ends a deployment.

**The platform declaration** is `AppPlatformsSection.tsx`: three full-width choices, each with a line
(`CHOICES`), checked against the saved app before a platform is added.

**MCP.** `lib/mcp/server.ts::registerNovaTools` registers the account, saved-app and deployment tools
and then every `SHARED_TOOL_REGISTRY` entry. HQ tools declare `oauthScopeChallenge(ctx, SCOPES.hqRead |
SCOPES.hqWrite)` and call `assertScope` before any read. `check_project_space_compatibility` returns
the compatibility report and the confirmations an upload will ask. Errors are `McpErrorPayload`s with a
closed `error_type`. No tool lists or reads an HQ app.

**The plugin** (`../nova-plugin`, version `2.4.2`) has seven skills, mirrored under `.dev-plugin/`.
`upload_to_hq` tells the person "a first upload creates the app there, and a later one updates that
same HQ app in place. Any Project data tables the app reads and any places in its organization go up
with it."

**Docs.** No page mentions bringing an app in. "Import" names the CommCare HQ app file and CSV
replacement, and `case-workspace.mdx` says "If an imported app has a different assignment rule".

---

## 2. Entry points

All three are offered exactly where "New app" or "Start with a blank app" is offered today, under the
same capability, and all lead to `/build/new?hq=choose`.

| Where | Today | From step 6 |
|---|---|---|
| `app-list.tsx::AppList`, the header row | `Button` "New app" (icon `tabler:plus`), under `canCreateApp` | to its left, `Button variant="outline"` rendering a `Link` to `/build/new?hq=choose` (`nativeButton={false}`), icon `tabler:cloud-download`, label **N1**. The row's right side becomes `flex flex-wrap items-center justify-end gap-3`, so under the width that holds both they stack, each at its one 44px height |
| `page.tsx::GetStarted`, with `canCreateApp` | the heading, one paragraph, the button "Get started" | under the button, one `text-sm text-nova-text-muted` line: **N2**, then a link **N3** to `/build/new?hq=choose` in `text-nova-violet-bright` with the `.nova-focusable` ring. A viewer sees neither, as today |
| `StartFromScratch.tsx` | "or", one outline button, one line | "or", then a grid `grid-cols-1 sm:grid-cols-2 gap-3` of two columns, each an outline `Button` with its line under it: "Start with a blank app" with today's line, and **N4** (icon `tabler:cloud-download`) with **N5**. Both collapse together when a message is sent, in the one `motion.div` that collapses today. The new button is never `disabled`, for the reason the file's own comment gives of the first |

`StartFromScratch` gains one prop, `onBringIn: () => void`, which `ChatContainer` fills with
`() => pushBuilderHistory("/build/new?hq=choose")`: a History-API push inside the mounted tree, so Back
returns to the composer. It is inert under the same two latches `handleCreateStarterApp` reads
(`agentEngagedRef`, `creatingStarterAppRef`).

`icon`: `@iconify-icons/tabler/cloud-download`, imported from `@iconify/react/offline` as every icon
is (`components/CLAUDE.md`, "Icons").

---

## 3. The flow as one surface

### 3.1 Where it mounts

The flow is a state of `/build/new`. `design/readme.md` gives the dialog pattern to publishing
("Publish opens in place, including from Preview"), which acts on an app that is open. Bringing an app
in has no app to open over, its account can run to hundreds of lines, it must survive a reload and be
reachable by an address a person can keep or send, and its last act is a birth, which
`components/builder/CLAUDE.md` binds to the mounted tree: "a route change swaps `BuilderProvider`'s
`key={buildId}` and rebuilds every store under it". A dialog over the home list could do none of
the four.

`components/chat/ChatSidebar.tsx` gains one prop:

```ts
/** In centred mode, what takes the chat card's place: the bring-in flow. */
takeover?: ReactNode;
```

Where `centered` is true and `takeover` is given, the inner card (the `motion.div` that is
`w-full max-w-2xl max-h-[min(700px,80vh)] rounded-2xl border border-nova-border bg-nova-deep`) renders
`takeover` in place of its header, `Conversation` and `PersistentChatComposer`, and `startFromScratch`
is not rendered. The card keeps its class, so the flow has the composer's width, radius and bounded
height, and "the header carries the whole lockup on `/build/new`" stays true: the flow draws no logo.
`ChatContainer` passes `takeover` exactly when all of these hold: the layout is centred, the build is
not an existing app, `messages.length === 0`, and `bringInLocation` reads the URL as `choose` or an
app (3.2). A design in progress in the tab therefore never loses its conversation to a typed URL.

The tab's own role is not one of the conditions. `ChatContainer`'s `readOnly` is `!canEdit` for the
Project the tab is looking at (`lib/session/hooks.tsx::useProjectCanEdit`), and an app is brought in
to a Project the person chooses, which need not be that one: someone who only views the active
Project and edits another can add an app to the other. Who may start one is decided by
`BringInSeed.projects` (3.2): where it is empty the picker shows the sentence of 4.5 and no fields.
An app opened by its address is read whatever that list holds: the read's own check says whether
the person may add an app to the Project the address names (3.2). The entries of section 2 stay
under `canCreateApp`, the role in the active Project, as "New app" is, so a viewer of the active
Project reaches the flow by its address or after switching Projects.

The band is untouched: "`/build/new` before a send has no app, so it claims nothing and wears the site
band exactly" (`components/CLAUDE.md`), and that stays so through the whole flow, until
`installCreatedApp` lands an app and the builder claims the band as it does for every birth.

### 3.2 The URL, and what a refresh does

```ts
// lib/routing/bringInLocation.ts (new, client-safe, pure)
import type { ReadingKey } from "@/lib/deployment";

export type BringInLocation =
	| { readonly kind: "none" }
	| { readonly kind: "choose" }
	/** One HQ app, to be added to one Project: part 12's key of a read. */
	| { readonly kind: "app"; readonly key: ReadingKey };
/** Reads the `hq` state of a query string: `choose`, an app's key, or anything else as `none`. */
export function bringInLocation(search: string): BringInLocation;
/** The address of a location: `/build/new`, `/build/new?hq=choose` or the app's address below. */
export function bringInHref(location: BringInLocation): string;
```

An app's address is

```
/build/new?hq=app&project=<projectId>&server=<server>&space=<domain>&app=<remoteAppId>
```

with its values written by `URLSearchParams` in that order. It is admitted only where the four values
pass part 12's `readingKeySchema` (its 3.1; `lib/deployment/reading/types.ts`, client-safe) and `space`
is 1 to 255 characters. Any other `hq` value, and an `hq=app` that misses a value, is `none`: the page
shows the composer and says nothing. The read route holds the project space to CommCare's own slug rule
(part 12, 4.1) and answers `invalid_input` for one it refuses, which the page shows as that refusal
(5).

The address names the app and the Project and holds nothing of what Nova read. That is the whole of
what the page has after a reload, because the server stores nothing between a read and a create
(part 12): there is no stored account to come back to and no reading to resume. A person who opens
the address a teammate sent reads the app with their own CommCare HQ key, for the Project the
address names, and where they cannot add an app to that Project the read's own check answers
`no_project_access` (5).

| The address | Shows | A refresh |
|---|---|---|
| `/build/new?hq=choose` | the picker (4) | the picker again, with the Project preselected to the tab's and nothing else chosen. Nothing was stored, so nothing is lost but the selection |
| `/build/new?hq=app&…` | the app it names: the reading screen while the read runs (5), then the stop, the account or the review the read answers (6 to 8) | reads the app again and shows where it stands now. The answers of a review are not kept across a refresh: the review opens again with Nova's preselected choices. Where the tab holds the key of a create in flight for the same app (9.1), the page shows the creating screen and sends that create again |

Moves between the two are History-API calls on the mounted tree, each a push:
`pushBuilderHistory(bringInHref(…))` to enter the picker, to open an app from the picker, and to
leave an app for the picker. So Back from an app returns to the picker with its list as the person
left it, and Back from the picker returns to the composer. A created app is never reached by this
address: its landing is the receipt's (9.2).

**No act of the flow calls the Next router while the flow is on screen.** `pushBuilderHistory`
spreads the entry's existing state into the one it writes (`historyPolicy.ts::
scopedBuilderHistoryState`), Next's marker among it, and Next's patched `pushState` and
`replaceState` leave its canonical address alone for a state that carries that marker. So after the
first move above, Next still holds the address the page was loaded at, and any router change (a
`router.refresh()`, a revalidating Server Action) makes its history updater write that address
back (`next/dist/client/components/app-router.js`), which is the rule `components/builder/CLAUDE.md`
states for a creation: "the router re-render carrying the revalidation restores Next's own
canonical URL". Every read and write of the flow is therefore a plain `fetch` of a route. Section
4.4 holds "Check connection" to the same rule.

**The first render agrees with the server.** `lib/routing/useClientPath.ts::useBuilderSearch` answers
`""` on the server, which would draw the composer and then swap it for the flow at hydration. So
`page.tsx::freshBuildPage` reads the five query values, keeps them only where `bringInLocation`
admits them, and hands the tree the query string `bringInHref` writes for that location; a new hook
reads the URL with that text as its server snapshot:

```ts
// lib/routing/useClientPath.ts
/** The builder's query string, with the server's own rendering of it for the first paint. */
export function useBuilderSearchFrom(initialSearch: string): string;
```

`freshBuildPage` also loads what the picker needs that no client call gives: the Projects the person
may add an app to.

```ts
// app/(app)/build/[id]/[[...path]]/page.tsx::freshBuildPage passes, through BuilderLayout to ChatContainer:
export interface BringInSeed {
	/** `""`, `?hq=choose` or an app's query, already validated. */
	readonly initialSearch: string;
	/**
	 * Projects where the person holds `edit`: the tab's Project first where it is one of them, the
	 * rest by name. Empty for a person who edits none.
	 */
	readonly projects: readonly {
		readonly id: string;
		readonly name: string;
		/** The person's own Project, which nobody else is in (`ProjectSummary.personal`). */
		readonly personal: boolean;
	}[];
}
```

`projects` is `lib/projects/membership.ts::listUserProjects(userId)` filtered by
`roleAllowsApp(role, "edit")`, each row's `id`, `name` and `personal` kept: one indexed read on a page
that already makes three. The review names the Project an app is added to from this list (8.2). The
connection is already in the tree (`CommCareConnectionContext`, provided in `BuilderLayout` from
`getCommCareSettings`).

### 3.3 The state model

`components/bring-in/bringInModel.ts` (new, pure, no React import) is the whole flow as data. The
components render `screenOf(model)` and dispatch events; the hook does what `nextAct(model)` says
and dispatches what came back.

```ts
import type { CircumstanceFinding } from "@/lib/publish/hqFindings";
// Part 12's types of a read and a create (`lib/deployment/reading/types.ts`) and part 11's
// `LookupTableChoice`, each re-exported as a type from `lib/deployment`.
import type {
	AccountAnswer, BringInInput, CreateAnswer, HqAppPicker, LookupTableChoice, ReadingAnswer,
	ReadingDeclarationChoice, ReadingKey, ReadingRefusal, ReadingReview, ReadingStage,
} from "@/lib/deployment";
import type { Platform } from "@/lib/domain";
import type { BringInLocation } from "@/lib/routing/bringInLocation";

/** A request to one of part 12's two routes. At most one is in flight. */
export type BringInCall = "read" | "create";

/** A read's answer that is a review. */
export type ReviewAnswer = Extract<ReadingAnswer, { readonly kind: "review" }>;

export interface ReviewAnswers {
	/** The digest of the review these answer. */
	readonly reviewDigest: string;
	readonly appName: string;
	readonly runsOnlyOn: Platform | null;
	readonly splitDatetime: boolean;
	readonly tableChoices: Readonly<Record<string, LookupTableChoice>>;
}

export interface PickerModel {
	/** The Project chosen under "Add it to", or null where the person can add to none. */
	readonly projectId: string | null;
	/** The project spaces the connection reaches, by name. Empty where there is no connection. */
	readonly domains: readonly string[];
	readonly domain: string | null;
	/** `idle` before a project space is chosen; `loading` is what makes the hook list its apps. */
	readonly apps:
		| { readonly kind: "idle" }
		| { readonly kind: "loading" }
		| { readonly kind: "loaded"; readonly picker: HqAppPicker }
		| { readonly kind: "failed" };
	readonly remoteAppId: string | null;
	readonly filter: string;
}

/**
 * Which lead of part 12's `CREATE_ANSWER_LEADS` stands above what a create's answer shows: one for
 * each answer that did not create and is no refusal, with `changed` told apart by what it carries.
 */
export type CreateLead =
	| "changed-review" | "changed-account" | "changed-stop" | "changed-already-in-nova"
	| "read-again" | "check-failed" | "held";

export interface BringInModel {
	readonly location: BringInLocation;
	readonly picker: PickerModel;
	/**
	 * False at an app's address until the hook has looked at the tab's key for a create to send
	 * again (9.1). Nothing is requested before it is true.
	 */
	readonly resumeChecked: boolean;
	/** What the app's last read answered, or what a create said the app is now. Null before one. */
	readonly answer: ReadingAnswer | null;
	/** When `answer` arrived, for the date of a copied account (7.5). */
	readonly answeredAt: number | null;
	readonly call: BringInCall | null;
	/** The last stage the request in flight named, and its last count of files. */
	readonly stage: ReadingStage | null;
	readonly files: { readonly done: number; readonly total: number } | null;
	/** When the wait on screen began, for the reassurance at twenty seconds. */
	readonly waitingSince: number | null;
	/** How many requests in a row ended with no last line. Any request that answers makes it 0. */
	readonly lost: number;
	/** The request whose stream ended in a `failed` line. Its screen stands until Try again. */
	readonly failed: BringInCall | null;
	readonly answers: ReviewAnswers | null;
	/**
	 * The answers a person held when a create answered `read-again`, with the review they answered,
	 * waiting for the review the next read answers.
	 */
	readonly carried: { readonly answers: ReviewAnswers; readonly review: ReadingReview } | null;
	/**
	 * The input of a create that has begun and not ended. Set by `create-asked`, kept through a
	 * lost request and a `failed` line, cleared when the create ends any other way. While it is set
	 * the screen is `creating` or the failed screen, never the review.
	 */
	readonly pendingCreate: BringInInput | null;
	/** The finding of a create answered `held`. */
	readonly held: CircumstanceFinding | null;
	/** The lead of the last create that did not create, and whether a choice could not be kept. */
	readonly lead: { readonly kind: CreateLead; readonly dropped: boolean } | null;
	readonly refusal: ReadingRefusal | null;
	/** How the landing of a created app ended, and that app's id. */
	readonly landing: {
		readonly answer: "landed" | "leaving" | "unverified"; readonly appId: string;
	} | null;
	/** The tag of the table choice focus was last sent to, with a counter so a second press moves it again. */
	readonly needsChoice: { readonly tag: string; readonly nonce: number } | null;
}

export type BringInEvent =
	| { readonly type: "location"; readonly location: BringInLocation }
	/** What the tab's key held for the app the location now names: a create to send again, or null. */
	| { readonly type: "resume"; readonly input: BringInInput | null }
	/** The connection as the context holds it now: dispatched at mount and whenever it changes. */
	| { readonly type: "connection"; readonly domains: readonly string[] }
	| { readonly type: "picker-project"; readonly projectId: string }
	| { readonly type: "picker-domain"; readonly domain: string }
	| { readonly type: "picker-apps"; readonly domain: string; readonly picker: HqAppPicker | null }
	/** "Try again" after a list that failed, and "Check again" on a stop met while choosing. */
	| { readonly type: "picker-reload" }
	| { readonly type: "picker-app"; readonly remoteAppId: string }
	| { readonly type: "picker-filter"; readonly filter: string }
	/** Check again, on a stop, an account or a refusal: the app is read afresh. */
	| { readonly type: "read-asked" }
	/** Bring it in, pressed with every answer given: the input becomes `pendingCreate`. */
	| { readonly type: "create-asked"; readonly input: BringInInput }
	| { readonly type: "call"; readonly call: BringInCall; readonly at: number }
	/** Lines of the request's stream (part 12, 4.3). */
	| { readonly type: "stage"; readonly stage: ReadingStage }
	| { readonly type: "files"; readonly done: number; readonly total: number }
	| { readonly type: "read-done"; readonly answer: ReadingAnswer; readonly at: number }
	| { readonly type: "create-done"; readonly answer: CreateAnswer; readonly at: number }
	/** The stream's last line was `failed`: Nova's own fault, logged on the server. */
	| { readonly type: "failed"; readonly call: BringInCall }
	/** The response ended with no last line, or was no stream and held no `code`. */
	| { readonly type: "lost"; readonly call: BringInCall }
	/** A route refused with a `code` before it opened its stream. */
	| { readonly type: "refused"; readonly call: BringInCall; readonly refusal: ReadingRefusal }
	/** "Try again" after a `failed` line or two lost requests: the person asks for the same act. */
	| { readonly type: "retry" }
	| { readonly type: "answers"; readonly answers: ReviewAnswers }
	| { readonly type: "choice-needed"; readonly tag: string }
	| { readonly type: "landed"; readonly answer: "landed" | "leaving" | "unverified";
	    readonly appId: string };

/** `projectId` is the Project to preselect: the tab's where the seed lists it, else the first, else null. */
export function initialBringInModel(location: BringInLocation, projectId: string | null): BringInModel;
export function reduceBringIn(model: BringInModel, event: BringInEvent): BringInModel;

export type BringInScreen =
	| { readonly kind: "none" }
	| { readonly kind: "choose" }
	/** `lost`: two requests in a row ended with no last line, and the screen offers Try again. */
	| { readonly kind: "reading"; readonly lost: boolean }
	/** Nova's own fault, in a read or in a create (5, 9.1). */
	| { readonly kind: "failed"; readonly operation: BringInCall }
	/** A refusal that leaves nothing else to show (8.10). */
	| { readonly kind: "refused"; readonly refusal: ReadingRefusal }
	| { readonly kind: "stopped"; readonly finding: CircumstanceFinding }
	| { readonly kind: "account"; readonly answer: AccountAnswer }
	| { readonly kind: "review"; readonly answer: ReviewAnswer; readonly answers: ReviewAnswers }
	| { readonly kind: "creating"; readonly lost: boolean }
	/** The app exists and this tab could not open it (9.2). */
	| { readonly kind: "unopened"; readonly appId: string };
export function screenOf(model: BringInModel): BringInScreen;

export type BringInAct =
	| { readonly kind: "none" }
	| { readonly kind: "list-apps"; readonly domain: string }
	| { readonly kind: "read"; readonly key: ReadingKey; readonly afterMs: number }
	| { readonly kind: "create"; readonly input: BringInInput; readonly afterMs: number };
export function nextAct(model: BringInModel): BringInAct;
```

**The reducer's rules**, each a row of the model's test table. "Everything about the app" is
`answer`, `answeredAt`, `answers`, `carried`, `held`, `lead`, `refusal`, `failed`, `needsChoice`,
`stage`, `files` and `waitingSince`, with `lost` 0.

| Event | The model becomes |
|---|---|
| `location` to `choose` | everything about the app cleared, and `pendingCreate`; `picker` kept, so "Choose another app" returns to the list the person left |
| `location` to `app` with another key than the one held | everything about the app cleared, `pendingCreate` and `landing` among it; `resumeChecked` false |
| `resume` | `resumeChecked` true. With an input: `pendingCreate` that input, as `create-asked` sets it. With null: nothing else, and the next act is the read |
| `connection` | `picker.domains` set. Where it holds exactly one and none is chosen: `domain` that one and `apps: loading`, so one project space is never a choice. A picker with no Project (`projectId` null) chooses none, since it shows no fields (4.5). Where the chosen `domain` is no longer among them: `domain` null, `apps: idle`, `remoteAppId` null. Otherwise nothing else moves |
| `picker-project` | `picker.projectId`, and nothing else: the list is the project space's, whatever the Project |
| `picker-domain` | `picker.domain`, `apps: loading`, `remoteAppId` null, `filter` "" |
| `picker-reload` | `apps: loading` where a domain is chosen; nothing otherwise |
| `picker-apps` | taken only where `apps` is `loading` and its `domain` is still the picker's; `null` is `failed`. `remoteAppId` is cleared where the list holds no row of it that can be chosen |
| `read-asked` | everything about the app cleared. The next act is the read |
| `create-asked` | `pendingCreate` the event's `input`; `held`, `lead`, `refusal`, `failed` and `needsChoice` cleared; `lost` 0. No request is in flight yet: the next act is `create`, which the hook posts |
| `call` | `call` set; `stage` and `files` null; `waitingSince` set to `at` where it was null |
| `stage` | taken only while a call is in flight: `stage` set, and `files` null where the stage counts no files |
| `files` | taken only while a call is in flight: `files` set |
| `read-done` | `answer` and `answeredAt` set; `call`, `stage`, `files` and `waitingSince` null; `lost` 0. Where the answer is a review and `carried` holds answers: `answers` is what `carryAnswers` keeps of them for this review, `lead.dropped` its `dropped`, and `carried` is cleared. Otherwise `answers` and `carried` are null. `held`, `lead` and `refusal` are kept, so what a create left to say stands above what the read answers (8.10) |
| `create-done`, `created` | `call` stays `create` and `pendingCreate` stays set until `landed`: the hook lands the receipt (9.2) |
| `create-done`, `changed` | `answer` is `now`, `answeredAt` `at`. `lead` is by what `now` is: `changed-review`, `changed-account`, `changed-already-in-nova` for a stop whose code is `already-in-nova`, `changed-stop` for any other stop. Where `now` is a review and the model held a review with answers: `answers` is what `carryAnswers` keeps, and `lead.dropped` its `dropped`. Otherwise `answers` is null. `pendingCreate`, `held` and `refusal` cleared; `call` null; `lost` 0 |
| `create-done`, `read-again` | `carried` the answers and the review the model held, where it held both; `answer` and `answers` null; `lead` `read-again`; `pendingCreate` cleared; `call` null; `lost` 0. The next act is the read |
| `create-done`, `check-failed` | `answer` an account of the one finding (`accountOfOne`, below); `lead` `check-failed`; `answers`, `pendingCreate` and `held` cleared; `call` null; `lost` 0 |
| `create-done`, `held` | `held` the finding, `lead` `held`, `call` null, `pendingCreate` cleared, `lost` 0; `answers` kept |
| `create-done`, `refused` | `refusal` set, `call` null, `pendingCreate` cleared, `lost` 0; `answers` kept |
| `landed` | `landing` set; `call` null and `pendingCreate` null, whatever the answer |
| `failed` | `failed` the event's `call`; `call`, `stage` and `files` null; `lost` 0. `pendingCreate` is kept, so Try again after a failed create sends the same create |
| `lost` | `lost` plus one, `call` null, and nothing else: `pendingCreate` is kept, so a create whose request was lost is still a create on screen |
| `refused` (a route answered a coded refusal before its stream) | `refusal` set, `call` null, `pendingCreate` cleared |
| `retry` | `lost` 0 and `failed` null. The next act is then the one that was lost or failed: the create where `pendingCreate` is set, else the read |
| `answers` | taken only where `answers.reviewDigest` is the digest of the review on screen; `needsChoice` cleared where its tag now has an answer; `refusal` cleared where it is `name_missing`, `choice_missing` or `choice_not_offered` |
| `choice-needed` | `needsChoice` set, with `nonce` raised |

A create that answers `held` or a refusal of the person's answers after a reload (9.1) finds no
review in the model. The next act is then the read (rule 8 below), and the lead, the held block or
the refusal's sentence stands above the review it answers.

**`screenOf`**, first match:

1. `location.kind === "none"` is `none`; `choose` is `choose`.
2. `landing.answer === "unverified"` is `unopened`, with `landing.appId`.
3. `failed !== null` is `failed`, with that request as `operation`.
4. `pendingCreate !== null`, or a `landing` of `landed` or `leaving`, is `creating`, `lost` where
   `lost >= 2`. This is what keeps the review off the screen during a create and during the wait
   before its one retry.
5. A `refusal` of `no_project_access`, `invalid_input` or `app_unavailable` is `refused`. Every other
   refusal is drawn on the review (8.10).
6. `answer === null` is `reading`, `lost` where `lost >= 2`.
7. Then by `answer.kind`: `stop` is `stopped`, `account` is `account`, and `review` is `review` with
   `answers ?? initialAnswers(answer)`.

**`nextAct`**, first match. It is a function of the model alone: nothing it answers depends on which
event came last.

1. `location.kind === "none"` is `none`. `choose` is `list-apps` with the picker's `domain` where
   `picker.apps.kind === "loading"`, and `none` otherwise.
2. `resumeChecked` false is `none`.
3. `landing !== null` is `none`: the builder, the next page or the `unopened` screen has it.
4. `call !== null` is `none`: the hook is reading that request's stream.
5. `failed !== null` is `none`: a defect answers the same way twice, so the page never sends a
   failed request again by itself (5).
6. `lost >= 2` is `none`: the screen offers Try again, which dispatches `retry`.
7. `pendingCreate !== null` is `create` with that input, `afterMs` 3000 where `lost` is 1 and 0
   otherwise. So one lost request is sent again once, three seconds later, with the input the person
   sent.
8. A `refusal` of `no_project_access`, `invalid_input` or `app_unavailable` is `none`.
9. `answer === null` is `read` with the location's key, `afterMs` 3000 where `lost` is 1 and 0
   otherwise.
10. Everything else is `none`.

```ts
/** The review's defaults: HQ's name, the preselected choice, and no table answered. */
export function initialAnswers(answer: ReviewAnswer): ReviewAnswers;
/** The tags whose review entry asks a choice and has no answer, in tag order. */
export function unansweredChoices(review: ReadingReview, answers: ReviewAnswers): readonly string[];
/** Part 12's create body: the key, the reading's id, the digest and the answers, name trimmed. */
export function bringInInputOf(
	key: ReadingKey, answer: ReviewAnswer, answers: ReviewAnswers,
): BringInInput;
/**
 * The `review.runsOn` entry whose `runsOnlyOn` and `splitDatetime` the answers hold. `initialAnswers`,
 * `carryAnswers` and every `answers` event take both from one entry, so there is always exactly one.
 */
export function chosenDeclaration(
	review: ReadingReview, answers: ReviewAnswers,
): ReadingDeclarationChoice;
/**
 * What of a person's answers still applies to a review that came back. The name is kept where the
 * person had changed it from `before.appName`, and is `now.appName` otherwise. The pair
 * `(runsOnlyOn, splitDatetime)` is kept where it is still a member of `now.runsOn`, and is the
 * preselected entry's otherwise. Each table answer is kept where `now.tables` still asks a choice
 * for that tag and still offers that answer, and the tag is left unanswered otherwise. `dropped`
 * is true where a declaration or a table answer could not be kept.
 */
export function carryAnswers(
	previous: ReviewAnswers, before: ReadingReview, now: ReadingReview, digest: string,
): { readonly answers: ReviewAnswers; readonly dropped: boolean };
/**
 * CommCare HQ's name for the app, where the page knows one: the review's, the account's, or the
 * chosen row's in a loaded picker. Null otherwise, as on an address opened afresh before its read
 * answers.
 */
export function knownAppName(model: BringInModel): string | null;
/** The context part 01's `circumstanceBlock` fills a block from (6.1). */
export function circumstanceContextOf(
	model: BringInModel, serverLabel: string, formatDate: (iso: string) => string,
): CircumstanceContext;

/** How long after the press a create kept in the tab is still sent again: one hour. */
export const BRING_IN_RESUME_WINDOW_MS = 60 * 60 * 1000;
/**
 * The create to send again for `key`, from the tab's stored text (9.1): its input where the text
 * parses, the input passes part 12's `bringInInputSchema`, its four key fields are `key`'s, and it
 * was written less than `BRING_IN_RESUME_WINDOW_MS` before `now`. Null otherwise.
 */
export function resumableCreate(raw: string | null, key: ReadingKey, now: number): BringInInput | null;
```

`carryAnswers` is why a review that comes back does not ask a person the same thing twice. A
`changed` create that carries a review, and the read after a `read-again`, each put the person in
front of a review whose digest is new, and discarding their answers there would make them choose a
name, a platform and each table again for a change that may have touched none of them. Where a
choice could not be kept, the lead gains part 12's one sentence for it (its "Copy"). Across a
reload nothing is kept (3.2).

The remaining pure functions of the file are given, with their types, where their screen uses them:
`StopAction` and `STOP_ACTIONS` (6.2), `placeGroupKey`, `accountGroups`, `accountHeading`,
`countLine`, `accountAsText` (7.1, 7.2, 7.5), `declarationRows`, `declarationWhy` (8.3). `hqPlaceUrl`
(7.4) is `lib/deployment`'s. `CircumstanceContext` is part 01's (its 8.4).

One type and one function sit outside the page, because MCP's projection reads them too (14.4):

```ts
// lib/deployment/reading/answers.ts (new, client-safe; exported from lib/deployment)
/** A read's answer that is an account. */
export type AccountAnswer = Extract<ReadingAnswer, { readonly kind: "account" }>;
/**
 * The account a `check-failed` create shows: its one finding, `more` 0, `mediaChecked` true, and
 * `counts` holding 1 under the finding's standing.
 */
export function accountOfOne(finding: CircumstanceFinding, appName: string | null): AccountAnswer;
```

**The hook.**

```ts
// components/bring-in/useBringIn.ts
import type { useProjectToast } from "@/lib/collab/useProjectToast";

export function useBringIn(input: {
	/** What `freshBuildPage` handed the tree (3.2). */
	readonly seed: BringInSeed;
	/** `ChatContainer`'s own function (part 12, section 7). */
	readonly landCreatedAppReceipt: (
		raw: Record<string, unknown>, origin: "blank" | "brought-in",
	) => "landed" | "leaving" | "unverified";
	/** `ChatContainer`'s Project-scoped toast, for the landing toast of 9.3. */
	readonly projectToast: ReturnType<typeof useProjectToast>;
}): {
	readonly model: BringInModel;
	readonly screen: BringInScreen;
	readonly dispatch: (event: BringInEvent) => void;
};
```

`components/bring-in/useBringIn.ts` holds `useReducer(reduceBringIn, …)` and one effect over
`nextAct(model)`, keyed by the act's kind and its fields, so a render that answers the same act
starts nothing twice. Each act changes the model as its first step (a `call`, or the list's
answer), so the act is another one until its own answer brings it back. A `read` or a `create` with
`afterMs` above zero starts from a timer the effect clears when it is torn down. The hook calls the
routes through `components/bring-in/bringInClient.ts`, which is three `fetch` wrappers:

```ts
// components/bring-in/bringInClient.ts (new; plain `fetch`, no Next router, no Server Action)
import type { ReadingEvent } from "@/lib/deployment";

export type BringInAnswer<T> =
	| { readonly ok: true; readonly value: T }
	/** A body with a `code` is that refusal. Any other failure, a lost request among them, is null. */
	| { readonly ok: false; readonly refusal: ReadingRefusal | null };

/** How a request to one of part 12's two routes ended. */
export type BringInStreamEnd<T> =
	/** The stream's last line was `done`. */
	| { readonly kind: "done"; readonly answer: T }
	/** The stream's last line was `failed`. */
	| { readonly kind: "failed" }
	/** The route answered a JSON body with a `code` and opened no stream. */
	| { readonly kind: "refused"; readonly refusal: ReadingRefusal }
	/** The stream ended with no last line, or the response was no stream and held no `code`. */
	| { readonly kind: "lost" };

/** `GET /api/commcare/hq-apps` (4.2). */
export function fetchHqApps(
	input: { readonly domain: string }, signal: AbortSignal,
): Promise<BringInAnswer<HqAppPicker>>;
/** `POST /api/commcare/bring-in/read`. `onEvent` takes each `stage` and `files` line as it arrives. */
export function postRead(
	key: ReadingKey, onEvent: (event: ReadingEvent) => void, signal: AbortSignal,
): Promise<BringInStreamEnd<ReadingAnswer>>;
/** `POST /api/commcare/bring-in/create`. It takes no signal: a create is never stopped (9.1). */
export function postCreate(
	input: BringInInput, onEvent: (event: ReadingEvent) => void,
): Promise<BringInStreamEnd<CreateAnswer>>;
```

`postRead` and `postCreate` read the response through part 12's one client-side reader,
`lib/deployment/reading/stream.ts::readBringInStream` (client-safe; the module is imported by its
path, since `lib/deployment/reading/index.ts` is server-only). `bringInInputSchema` is imported the
same way from `lib/deployment/reading/types.ts`, and `components/bring-in` names no module of
`lib/commcare`. By act:

- `list-apps` fetches the picker's route and dispatches `picker-apps` with the `domain` it asked
  for. The request is aborted when the project space changes.
- `read` dispatches `call`, posts, dispatches `stage` and `files` for each line, then `read-done`,
  `failed`, `refused` or `lost`. Its `AbortController` is held in a ref and aborted when the
  location leaves that app or the flow unmounts, and never because the act changed: the route hands
  the request's signal to the read (part 12, 4.1), so a read nobody is watching stops at its
  next call to CommCare HQ. An aborted read dispatches nothing.
- `create` dispatches `call`, posts the act's `input`, which is the model's `pendingCreate`, dispatches
  the lines, then `create-done`, `failed`, `refused` or `lost`. It is never aborted, and an answer that
  arrives after the component unmounted is dropped (`mountedRef`): the create runs to its end on the
  server either way (part 12, 4.1: the create route is handed no signal). On `created` the hook lands
  the receipt and dispatches `landed` (9.2). A `location` event never touches `call`, so a person who
  goes Back from the creating screen leaves the create running: if it answers `created` it lands all
  the same, since the app exists, and any other answer of it clears `call` and changes nothing else.

The hook subscribes to the URL through `useBuilderSearchFrom` and dispatches `location`, and each
time the location becomes an app it reads the tab's key and dispatches `resume` (9.1). It
subscribes to `useCommCareConnection()` and dispatches `connection` with the names of
`availableDomains`. `BringInFlow` calls it, inside `ChatContainer`'s tree, with the
`landCreatedAppReceipt` that `ChatContainer` hands the flow (9.2, 12.1).

---

## 4. Choosing: a Project, a project space and an app

### 4.1 The screen

One card, in the order a person reads it. Strings are in "Copy" by id.

1. Heading **K1**, as an `h1` that takes focus when the screen appears. Under it **K2**.
2. **Add it to** (**K3**): a `Select` (`components/shadcn/select.tsx`, with `items` so the trigger
   shows the Project's name) over `BringInSeed.projects`, preselected to the tab's Project where it is
   in the list, else the first. With one Project it is still shown, as text in the field's place, so
   the person always reads where the app will live. Under it **K4**, which says who will see the app
   (everyone in a shared Project; only the person in their own, by the row's `personal`) and that an
   app reading lookup tables stays where it is added (`lib/db/apps.ts` refuses that move, as it
   refuses it for every app that reads Project data tables).
3. **Project space** (**K5**): over `picker.domains`, which the hook keeps equal to
   `useCommCareConnection()`'s `availableDomains` (3.3, the `connection` event). One: the text
   **K6**, and its apps are listed at once, since the reducer chooses a lone project space. Two to
   eight: a `Select`. More: `components/shadcn/combobox.tsx` with the placeholder **K7**, in
   uncontrolled mode, committing on item press (`components/CLAUDE.md`, "Floating elements"). This is
   `UploadForm`'s one-or-many rule with the combobox added for a key that reaches many.
4. **App** (**K8**): a radio group of the project space's apps (4.3), with the filter input **K11**
   above it where there are more than eight.
5. Footer: **Cancel** and **Read this app** (**K16**), and beside them **K17**.

Cancel is `pushBuilderHistory("/build/new", true)`: the composer and both ways of starting come back.

**Read this app** pushes the app's address, `bringInHref({ kind: "app", key })`, with `key` the
chosen Project, the loaded list's `server`, the project space and the row's `remoteAppId`. Nothing
is posted from this screen: the location's change is what starts the read (3.3), and the reading
screen shows at once, so the button has no in-flight label. Back returns here, with the list as the
person left it.

### 4.2 The picker's transport

The picker's reads of CommCare HQ are this part's: one service function and one route.

```ts
// lib/deployment/reading/pickerTypes.ts (new, client-safe; re-exported as types from lib/deployment)
import type { CommCareServer } from "@/lib/commcare/servers";
import type { CircumstanceFinding, HqAppClaimDetail } from "@/lib/publish/hqFindings";

export interface HqAppPickerRow {
	readonly remoteAppId: string;
	/** CommCare HQ's name for the app. May be empty. */
	readonly name: string;
	/** Who holds it in Nova, or null where it is free. */
	readonly claim: HqAppClaimDetail | null;
}
export type HqAppPicker =
	| { readonly kind: "apps"; readonly server: CommCareServer; readonly domain: string;
	    readonly apps: readonly HqAppPickerRow[] }
	/** The caller has no CommCare HQ connection at all. */
	| { readonly kind: "not-connected" }
	/** A read of CommCare HQ ended at a circumstance whose standing is `stop`. */
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding };

// lib/deployment/reading/picker.ts (new, server-only; exported from lib/deployment/reading/index.ts)
export function listHqAppsForPicker(
	actor: { readonly userId: string }, input: { readonly domain: string },
): Promise<HqAppPicker>;
```

In order, with no write. Every stop's finding is made by part 01's `circumstanceFinding` (its 8.1)
at the place `{ kind: "app" }`:

1. `getHqCredentials(actor.userId, input.domain)` (part 05, section 11). `not_configured` answers
   `not-connected`. `not_authorized` answers a stop of `key-cannot-reach-space`: the project spaces
   Nova holds for the stored key do not hold this one, and no request is sent. `ambiguous` cannot
   be the answer for a named project space, and is thrown with the developer's message of "Copy".
2. `listHqApps(creds, domain)` (part 05, 5.1). An error answers the stop for
   `hqReadCircumstance(classifyHqFailure(error, "app-list"))` (part 05, 4.3).
3. `probeHqApiAccess(creds, domain)` (part 05, 5.2), after the list and never beside it.
   `plan-lacks-api-access` answers that stop, `account-lacks-access-apis` answers `cannot-access-apis`,
   and `failed` answers the stop for `hqReadCircumstance(failure)`. `available` goes on.
4. `readHqAppClaims({ viewerUserId, server, domain, remoteAppIds })` (part 10, 5.5), one query. Each
   view becomes the row's `claim` with `remoteAppId` dropped, which is part 01's `HqAppClaimDetail`.

Rows are in CommCare HQ's order, which is by name (part 05, 5.1). The function reads nothing else of
HQ: part 05 states that a list row cannot say an app is linked, remote, when it was edited or whether
it is built, so the picker shows the name alone, and a linked, remote or deleted app is a stop of
the app's own read (6).

| Route | File | Calls | Request | 200 body |
|---|---|---|---|---|
| `GET /api/commcare/hq-apps` | `app/api/commcare/hq-apps/route.ts` (new) | `listHqAppsForPicker` | query `domain` (required, through `lib/commcare/client.ts::isValidDomainSlug`) | `{ picker: HqAppPicker }` |

A thin shell: `requireSession(req)`, the query value checked, the service call, `handleApiError`. A
stop is an answer and is 200. A bad query is 400 with `{ error, code: "invalid_input" }` and part
12's sentence for that refusal. `lib/hostnames.ts::HOSTNAME_ALLOWLIST` holds `/api/commcare` for the
main host and matches by segment, so the route needs no entry and is not reachable on the MCP or
docs host; the route test holds both ("Tests"). No `maxDuration` export: the two reads are bounded
at 30 seconds each by part 05 (its 3.3), with its wait for a throttled answer between them.

It is a route and not a Server Action for the reason part 12 gives of its own two routes (its 4.2):
Next dispatches a client's actions one at a time, and a read of CommCare HQ that takes seconds would
hold every other action of the tab behind it.

### 4.3 The rows

Each app is one row of a radio group (12.2), `selectableRowCls`, at least 44px tall, growing for a
second line.

| The row | Shows | Can be chosen |
|---|---|---|
| free | the name, or **K13** where CommCare HQ holds none | yes |
| `claim.kind === "open"` | the name, a `Badge` `HQ_APP_CLAIM_OPEN_LABEL` ("Already in Nova"), and a `Button variant="link"` `HQ_APP_CLAIM_OPEN_ACTION` ("Open") rendering a `Link` to `/build/<claim.appId>` | no: the radio is `aria-disabled`, keeps its place in the tab order, and its label says why |
| `claim.kind === "elsewhere"` | the name, the label `HQ_APP_CLAIM_ELSEWHERE_LABEL` ("Already in Nova, in a Project you're not part of"), and under it part 01's `alreadyInNovaNext(claim, formatDate)` sentence with its date in the reader's locale (who has the app in Nova and since when, and the two ways forward: be invited, or ask them to stop publishing to it) | no, as above |

The two row labels and the action "Open" are the three exports of `lib/publish/hqAppClaims.ts` (part
10, "Copy", "The picker's marks"), which exports no line. The line under an `elsewhere` row is part
01's `alreadyInNovaNext(claim, formatDate)` (its 8.4 and 9.3), called with the row's claim; a picker
row is no finding, so `circumstanceBlock` (6.1) does not apply to it. This part places the two and
writes none. The holding Project's name and, for `elsewhere`, the Nova app's name are never on the
wire (part 10, 5.5), so the row cannot show them.

A person's own app is one of these rows. Someone who brought an app in and comes back to the picker
reads "Already in Nova" with **Open**, which is true and is the way to it.

The filter narrows by a case-insensitive match of the name, in the browser, and never selects.

### 4.4 No connection yet

Where `useCommCareConnection()` says the person has no connection, or the route answers
`not-connected`, the Project space and App fields are replaced by the connection aside: the frame of
`PublishDialogBody.tsx::NotConfigured` (an amber `tabler:info-circle`, a title, a body, "Open Settings"
as a link that opens `/settings` in a new tab, and an outline button that re-reads the connection),
extracted as:

```ts
// components/builder/HqNotConnected.tsx (new)
export function HqNotConnected(props: {
	readonly title: string;
	readonly body: string;
	/** A third, quieter line. The Publish dialog's "You can still choose a file" is one. */
	readonly note?: string;
	/** Why the last check could not be read, drawn under the buttons with `role="alert"`. */
	readonly error?: string;
	readonly isRefreshing: boolean;
	readonly onRefresh: () => void;
}): ReactElement;
```

`PublishDialogBody.tsx` renders it with today's three strings, byte for byte, and loses its private
`NotConfigured`. The picker renders it with **K19**. The Project choice and the footer's Cancel stay
on screen throughout, so the step is part of the screen and not a wall in front of it.

**"Check connection" reads the connection again without the Next router.** Today the dialog's button
is `PublishPanel.tsx::handleRefreshHqConnection`, a transition around `router.refresh()`, and the
context holds no refresh. A router refresh is what this flow may not do (3.2): on
`/build/new?hq=choose` reached from the composer it would put `/build/new` back in the address bar
and the picker would give way to the composer. So the connection gains one read of its own, and the
context one refresh, which both surfaces use:

| Route | File | Calls | 200 body |
|---|---|---|---|
| `GET /api/commcare/connection` | `app/api/commcare/connection/route.ts` (new) | `lib/db/settings.ts::getCommCareSettings(session.user.id)` | `{ connection: CommCareSettingsPublic }` |

A thin shell: `requireSession(req)`, the one read, `handleApiError`. It reads Nova's own row and
makes no request to CommCare HQ. It is under `/api/commcare`, so it needs no allowlist entry (4.2),
and the route test of "Tests" holds that. The body is what the page already receives as a prop
today: it never holds the key.

```ts
// components/builder/CommCareConnectionContext.tsx (changed)
export interface CommCareConnection {
	// configured, server and availableDomains as today, then:
	/** Reads the connection again and takes what comes back. Never rejects. */
	readonly refresh: () => Promise<void>;
	/** True while a refresh is in flight. */
	readonly isRefreshing: boolean;
	/** True where the last refresh could not be read. Cleared by the next one that answers. */
	readonly refreshFailed: boolean;
}
```

`CommCareConnectionProvider` keeps `useState<CommCareSettingsPublic | null>(null)` beside its
`settings` prop: `refresh` fetches the route and stores the answer, and the value is built from the
stored answer where there is one and from the prop otherwise. A new `settings` prop (a later server
render) clears the stored answer, so the server's word wins whenever it speaks. The value stays
memoized, so its identity changes once per refresh that answered, as it does today once per
`router.refresh()`. `PublishPanel.tsx` drops its `useTransition` and its `router.refresh()` and
passes the dialog the context's `refresh` as `onRefreshHqConnection`, its `isRefreshing` as
`isRefreshingHqConnection`, and its `refreshFailed` as a new member of
`PublishDialogBody.tsx::PublishDialogProps`, `hqConnectionRefreshFailed: boolean`.
`PublishDialog.tsx` forwards its props whole and is not edited. For a person the dialog's "Check
connection" does what it does today, and by the source read in 3.2 it stops handing Next the
address of an app that was created in the tab, which is the same hazard one step later (Departure
3).

Both surfaces pass `HqNotConnected` **K22** as its `error` where `refreshFailed` is true. In the
picker, when a refresh finds a connection, the `connection` event gives the model its project
spaces, the fields return and focus goes to the Project space field.

One connection, read once, then serves the whole tab: a person who connects in Settings, checks the
connection in the picker and brings an app in lands in a builder whose Publish dialog already knows
the connection, because it reads the same context.

### 4.5 Stops met while choosing

A `stop` answer is drawn in the App field's place by the same block a stopped read uses (6.1):
part 01's `circumstanceBlock(finding, { server, space, app: null, formatDate })`, with `space` the
chosen project space and `server` the connection's label. The codes this screen can meet are the
ones steps 1 to 3 of 4.2 give, ten of them: `key-cannot-reach-space`, `not-a-member`,
`key-not-accepted`, `plan-lacks-api-access`, `api-cut-off`, `cannot-access-apis`, `rate-limited`,
`hq-unavailable`, `hq-gateway-refused` and `browser-only`. No block among them names an app (part
01, 9.3), which is why `app: null` is right here. Their actions are `STOP_ACTIONS`' (6.2), less
"Choose another app", which has nothing to act on here; "Check again" dispatches `picker-reload`,
which lists again. Choosing another project space clears the stop.

A person who can add an app to no Project (`BringInSeed.projects` is empty, so `picker.projectId` is
null; they came by the address, since no entry is offered to them) sees part 12's
`no_project_access` sentence in the card with **Go to your apps**, and no fields. A person who only
views the tab's Project and edits another sees the picker with that other Project chosen (3.1).

---

## 5. Reading

The screen while the read of the app the address names is in flight (`screenOf` is `reading`). A
read is one request (part 12, section 3), and the screen draws what that request's own response
says as it arrives.

- A status row, `role="status"`, with the one spinner of the screen: **W1**, naming the app where
  the page knows its name (`knownAppName`, 3.3: the row the person chose in the picker). On an
  address opened afresh the page knows none until the read answers, and W1 reads its second form.
- Under it, the stage that is running: part 12's `READING_STAGE_LABELS[stage]` (its "Copy"), with
  `{done}` and `{total}` from the model's `files` on `checking-media`. Before the first line of
  the stream arrives the row shows W1 alone. The line is an `aria-live` region at `polite`, and
  its text changes only when the label does, so a file count that moves several times a second is
  not read out each time: the count is a separate `aria-hidden` span beside a visually hidden
  sentence that is updated at most every ten files.
- After twenty seconds of `waitingSince`: **W3**. This is the design system's rule for a wait, "Long
  operations get patient company ("Still building. Big apps take a minute or two."), not spinners in
  silence or percent counters", and it is why there is no bar.
- Always: **W4**, and one link, **Go to your apps**.

W4 says what leaving does, and it is true whichever way the person leaves: the read stops at its
next call to CommCare HQ once nobody is waiting for it (the hook aborts its request, and the route
hands the request's signal to the read; part 12, 3.2), it has stored nothing, and the address
reads the app afresh whenever it is opened again (3.2). There is no "Stop reading" button, because
leaving is the stop.

The stages a person can see are the ones a read names (part 12, 4.3): connecting, reading the
app, reading its lookup tables and places, checking what Nova read, checking pictures and sounds
with a count, then checking once more. A stage with nothing to do is not named, so an app with no
files never shows a count. The ordinary read is a matter of seconds (part 12, 3.7); the count is
what a person watches where an app holds hundreds of files.

**A lost request.** A response that ends with no last line, or that is no stream and holds no
`code`, is a lost request: the network or the instance ended it. The first shows the amber line
**W5** ("Trying again", the design system's recovery word) and the hook reads once more after 3
seconds (`nextAct`, rule 9). The second shows **W6** with **Try again**, which dispatches `retry`.
Nothing was created either way, and a read that is sent again is a whole read.

**Nova's own failure.** A stream whose last line is `failed` is something thrown on the server
that is no answer (part 12, 4.3), which it has logged. The screen is `failed` with the operation
`read`: an amber `tabler:info-circle`, part 12's `READING_FAILED_COPY.read` (its title as the
`h1`, which takes focus, and its body, with `{app}` the known name or "this app"), **Try again**,
which dispatches `retry`, and **Go to your apps**. The page never sends a failed request again by
itself: a lost stream is retried once because the network may have been the cause, and a defect
answers the same way twice.

**A refusal before the stream.** The read route refuses two things as ordinary JSON with a `code`
before it opens a stream (part 12, 4.1), and each is the `refused` screen, the refusal's sentence
(part 12's `READING_REFUSAL_COPY`) as its one line:

| Refusal | When | Actions |
|---|---|---|
| `no_project_access` | the person cannot add an app to the Project the address names: the address was sent by someone else, or the person's role changed | **Choose another Project**, which pushes `/build/new?hq=choose`, and **Go to your apps** |
| `invalid_input` | the address held a project space that is no project space slug | **Choose an app**, which pushes `/build/new?hq=choose`, and **Go to your apps** |

The third refusal that takes this screen, `app_unavailable`, comes only from a create (8.10).

---

## 6. A stop

### 6.1 The block

One component, `BringInStop`, draws every stop: a read's answer of kind `stop`, a `stop` answer of
the picker (4.5), and a create's `changed` answer whose `now` is a stop (8.10).

- an amber `tabler:info-circle`, never a tick and never rose: a stop is no error of the person's and
  no failure of Nova's;
- the title as the screen's `h1` (focus goes to it), the body and the next step, all three from
  part 01's `circumstanceBlock(finding, context)` (its 8.4): the one function that words a
  circumstance for a stop, the account (7.2), the copied text (7.5) and MCP (14.3) alike, with
  every placeholder filled. The page builds `context` with `circumstanceContextOf` (3.3): the
  server's label, the project space of the address, the app's name where the page knows one and
  null where it does not, and the viewer's locale date;
- one line, **S1**, under every stop but `already-in-nova`. That block's own body and next step
  say where the app is, and "Nothing was created" beside the name of an app the person may have
  made a minute ago would read as a contradiction. On a screen drawn from a create's answer (the
  model holds a `lead`) S1 reads its second form, "No app was created, and nothing changed in
  CommCare HQ", which is true before the create's files are added to the Project and after;
- where the model holds a `lead`, part 12's `CREATE_ANSWER_LEADS` sentence for it in a
  `role="status"` line above the heading;
- the actions of 6.2.

A `held` answer of a create is the same block with no S1 and no actions of its own, set above the
review (8.10).

### 6.2 The actions, by code

```ts
// components/bring-in/bringInModel.ts
import type { CircumstanceFinding, StopCircumstance } from "@/lib/publish/hqFindings";

/** One action a stop offers. Its label is the shared action of "Copy" with that meaning. */
export type StopAction =
	/** **Open Settings**: a link to `/settings` in a new tab. */
	| { readonly kind: "open-settings" }
	/** **Check again**. */
	| { readonly kind: "check-again" }
	/** **Choose another app**. */
	| { readonly kind: "choose-another-app" }
	/** **Go to your apps**: a link to `/`. */
	| { readonly kind: "go-to-apps" }
	/** **Open {appName}**: a link to `/build/<appId>`. */
	| { readonly kind: "open-app"; readonly appId: string; readonly appName: string };

export const STOP_ACTIONS: {
	readonly [K in StopCircumstance]: (finding: CircumstanceFinding) => readonly StopAction[];
};
```

`STOP_ACTIONS` is written with `satisfies Record<StopCircumstance, (finding: CircumstanceFinding) =>
readonly StopAction[]>`. `StopCircumstance` is part 01's type (its 8.3): every member of
`READ_CIRCUMSTANCES` whose `CIRCUMSTANCE_STANDINGS` entry is `stop`, nineteen codes. So a `stop`
code added to part 01's list fails to compile here until it has a row. Every row but
`already-in-nova` ignores its argument; that row reads `finding.detail.claim` and answers `open-app`
where its `kind` is `open`.

| Code | Actions, in order, the first one primary |
|---|---|
| `not-connected`, `key-not-accepted`, `key-cannot-reach-space` | **Open Settings** (a link to `/settings` in a new tab), **Check again** |
| `plan-lacks-api-access`, `not-a-member`, `cannot-edit-apps`, `cannot-access-apis`, `api-cut-off`, `browser-only`, `cannot-read-organization` | **Check again**, **Choose another app** |
| `rate-limited`, `hq-unavailable`, `hq-gateway-refused`, `changed-while-reading` | **Check again**, **Go to your apps** |
| `app-gone`, `linked-app`, `remote-app` | **Choose another app**, **Go to your apps** |
| `app-deleted` | **Check again**, **Choose another app** |
| `already-in-nova`, the holder `open` | **Open {appName}** (a link to `/build/<claim.appId>`), **Choose another app** |
| `already-in-nova`, any other holder | **Choose another app**, **Check again** |

**Check again** dispatches `read-asked`: the app is read afresh and the screen is section 5's. In
the picker it dispatches `picker-reload` (4.5). **Choose another app** pushes
`/build/new?hq=choose`, keeping the picker's Project and project space. **Go to your apps** is a
link to `/`. `key-cannot-reach-space` offers Settings first because that is where the step is:
Settings reads the key's project spaces again, and Check again then reads the app with what the
key reaches now (part 01, 8.3).

### 6.3 Every circumstance, and where it is drawn

Part 01's `READ_CIRCUMSTANCES` holds thirty-four codes (its 8.3). Each has one layout, decided by
its standing alone, so a code added later needs a row of 6.2 where its standing is `stop` and
nothing else of this part. The title, the body and the next step of every code are part 01's
(`CIRCUMSTANCE_COPY`, through `circumstanceBlock`); this part writes none.

| Codes | Standing | Drawn |
|---|---|---|
| the nineteen codes of 6.2 | `stop` | the stop block (6.1) with the actions of 6.2: as the whole screen for a read's `stop` answer and for a create's `changed` answer that carries one, in the App field's place for a `stop` answer of the picker (4.5), and above the review, with no S1 and no actions, for a `held` answer of a create (8.10) |
| `too-large` | `not-yet` | the circumstance block of 7.2, in the group of the finding's own place; the heading is A1 (7.1) |
| `unrecognized`, `read-back-differs` | `not-yet` | the same block; the heading is A2 where every finding of the account is one of part 01's `NOVA_FAULT_CIRCUMSTANCES`, else A1 (7.1) |
| `menu-unreadable-in-hq`, `shadow-disagrees`, `media-file-unreadable`, `app-unreadable-in-hq`, `table-rows-unreadable` | `fix-in-hq` | the same block, under the amber label |
| `no-platform-runs-everything` | `fix-in-hq` | the same block; its next step is the sentence about the date and time question where `detail.reason` is `split-refused`, which `circumstanceBlock` chooses |
| `places-over-nova-limit`, `place-not-holdable`, `owner-rule-needs-one-place` | `not-yet` | the same block, under the violet label; the heading is A1 |
| `media-not-played-where-app-runs`, `table-cell-unrepresentable`, `table-choices-unusable` | `fix-in-hq` | the same block; a finding at a `media` place sits in the "Pictures and sounds" group, its line beginning with the path (7.2) |

An account never holds a `stop` code and a stop never holds one of the other fifteen: a stop is
answered only as a `stop` answer or a `held` answer (part 12, 3.8), which is what keeps a stop out
of every account (Decision 9).

---

## 7. The account

A read's answer of kind `account`: `{ appName, findings, more, counts, mediaChecked }` (part 12,
3.1), each finding part 01's `Finding`. A create shows this screen too, for a `changed` answer
that carries an account and for a `check-failed` answer (8.10).

### 7.1 The screen, top to bottom

1. An amber `tabler:info-circle` and the heading, as `h1`: **A1**, or **A2** where
   `accountHeading(findings)` says every finding is a fault of Nova's own (each one a circumstance
   of part 01's `NOVA_FAULT_CIRCUMSTANCES`, its 8.3). `too-large` and the three place codes are not
   among them: each is a limit Nova has, and "this time" would promise that checking again gets
   past it. They take **A1**, which says "yet". `{app}` is the answer's `appName`, or "this app"
   where the read ended before it learned one.
2. The lead: **A3**, or **A4** under heading A2. On a screen drawn from a create's answer each
   reads its second form, with "No app was created" where the first says "Nothing was created".
3. The lead of a create that ended here, where the model holds one: part 12's
   `CREATE_ANSWER_LEADS` sentence, as a `role="status"` line above the heading.
4. The count line, `countLine(answer.counts)`: the parts of **A5** that are not zero, joined by
   ` · `. Each part is a whole phrase with its own noun, singular at one ("1 thing Nova can't hold
   yet", "3 things to change in CommCare HQ"). The counts are over every finding the read met, the
   ones past the listed limit included (part 12, 3.1).
5. The three labels, each shown only where the account holds a finding of it, as a short definition
   list: the `Badge` of 7.3, then `FINDING_NEXT_STEPS[standing]` (part 01, 9.1). This is where the
   next step of every `not-yet` finding is said once, and not on each of two hundred lines.
6. The groups (7.2).
7. `ACCOUNT_CHECK_AGAIN_LINE` (part 01, 9.1; part 06, Departure 11), under the groups of every
   account, always: "When you check again, Nova may find more to name." One pass reports
   everything the reader can decide, and what it postpones out of a reading that holds another
   finding can surface on a later read, so no screen, tool or page of this part calls an account
   complete.
8. `moreFindingsLine(more)` where `more > 0` (part 12, "Copy").
9. Part 11's line R12 where `mediaChecked` is false: "Nova checks pictures and sounds once
   everything else can come in."
10. The footer, which does not scroll: **Copy the list**, **Check again**, **Done** (a link to `/`).

Nova keeps no account. The way back to this app is its address and Check again, both of which the
screen already offers, and Copy the list (7.5) is how a person keeps what this read found.

```ts
// components/bring-in/bringInModel.ts
import type { Finding } from "@/lib/publish/hqFindings";

// `AccountAnswer` is `lib/deployment`'s (3.3).
/** The A5 parts that are not zero, joined by " · ". The empty string where all three are zero. */
export function countLine(counts: AccountAnswer["counts"]): string;
/**
 * `this-time` (A2, A4) where every finding is a circumstance of `NOVA_FAULT_CIRCUMSTANCES`; `yet`
 * (A1, A3) for any other list, the empty one included.
 */
export function accountHeading(findings: readonly Finding[]): "yet" | "this-time";
```

### 7.2 Groups

```ts
// components/bring-in/bringInModel.ts
import type { Finding, FindingStanding, HqPlace } from "@/lib/publish/hqFindings";

/** The key two places share exactly where they sit under one heading (the table below). */
export function placeGroupKey(place: HqPlace): string;

export type AccountItem =
	/** `prefix` is the question's path or the file's path the line begins with, else null. */
	| { readonly kind: "finding"; readonly finding: Finding; readonly prefix: string | null }
	/** More than twenty findings of one sentence and one standing in a group, said once. */
	| { readonly kind: "fold"; readonly sentence: string; readonly standing: FindingStanding;
	    readonly findings: readonly Finding[] };

export interface AccountGroup {
	readonly key: string;
	/** The heading of the table below. */
	readonly heading: string;
	/** What `hqPlaceUrl` is asked for: the first finding's place, a question's as its form. */
	readonly place: HqPlace;
	readonly items: readonly AccountItem[];
}
export function accountGroups(findings: readonly Finding[]): readonly AccountGroup[];
```

`accountGroups(findings)` is pure. It makes one group for each distinct `placeGroupKey(place)`, in the
order each key first appears in the answer's list (part 12 sorts by place in the app's own order,
then by code; its 3.1), and within a group keeps the answer's order. Grouping is by key and not by
where the key changes, because that order does not promise that a form's questions sit directly
after that form's own findings, and a heading must never appear twice. `placeGroupKey` is this
part's, in `bringInModel.ts`; its keys are the middle column:

| Place kind | Group key | Group heading |
|---|---|---|
| `app`, `app-settings`, `languages`, `organization` | the kind | `placeLine(place)` (part 01, 9.1) |
| `menu`, `case-list`, `case-detail`, `search` | the kind and the menu's index | `placeLine(place)` |
| `form` | the menu's and the form's index | `placeLine(place)` |
| `question` | the menu's and the form's index, so a form's questions list under their form | `placeLine` of the form, and each finding's own line begins with the question's path in `font-mono` |
| `lookup-table` | the tag | `placeLine(place)` |
| `media` | one group for every file | "Pictures and sounds" (**A9**), and each finding's line begins with the path in `font-mono` |

Each group is a `section` with its heading as an `h2` and, where `hqPlaceUrl` gives an address, a link
**A6** that opens it in a new tab (`target="_blank"`, `rel="noopener noreferrer"`,
`tabler:external-link`, and a visually hidden " (opens CommCare HQ in a new tab)").

Within a group each finding is one list item:

- **A manifest finding**: `findingLine(finding).sentence` (part 01, 8.4), then, where `named` is not
  null, "In CommCare HQ: {name}" on its own line with the name in `font-mono` and
  `overflow-wrap: anywhere`, then the finding's label as a `Badge`.
- **A circumstance finding** (`subject` null): its title in medium weight and its body, from
  `circumstanceBlock(finding, context)`; then, where `findingLine(finding).named` is not null,
  "In CommCare HQ: {name}" on its own line, as a manifest finding has it; then the block's next
  step; then the label of its standing as a `Badge`. A circumstance says its own next step because
  it has one of its own, and one function words it for this screen, a stop (6.1) and MCP (14.3).
  The name on its own line is what tells two findings of one code apart: five findings that no one
  platform runs the whole app would otherwise read alike. Section 6.3 lists the fifteen codes this
  block draws.

Where a group holds more than twenty findings of one sentence (one unsupported appearance on every
question of a long form), `accountGroups` folds them into one `fold` item: the sentence once, "on
{n} questions", and a `Collapsible` (`components/shadcn/collapsible.tsx`) holding the paths. Nothing
is dropped; the copied list holds every line.

### 7.3 The labels

| Standing | Label (`FINDING_LABELS`, part 01) | Badge |
|---|---|---|
| `not-yet` | Nova can't hold this yet | `variant="violet"` |
| `never` | Nova doesn't bring this in | the default `muted` |
| `fix-in-hq` | Something to change in CommCare HQ | `variant="amber"` |

The label is always text. No finding is distinguished by color alone, and none is rose: nothing here
is the person's error.

### 7.4 The links to CommCare HQ

```ts
// lib/deployment/hqPlaceUrl.ts (new, client-safe; exported from lib/deployment/index.ts)
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import type { HqPlace } from "@/lib/publish/hqFindings";

/** The page of CommCare HQ that holds a place, or null where there is no one page. */
export function hqPlaceUrl(
	target: { readonly server: CommCareServer; readonly domain: string; readonly remoteAppId: string },
	place: HqPlace,
): string | null;
```

It lives in `lib/deployment` and not beside the screens because `biome.json` refuses
`@/lib/commcare/*` to `components/**` (its `noRestrictedImports` rule; `components/bring-in` is not
among the allowed consumers and `lib/deployment` is), which is the reason
`lib/deployment/types.ts::deploymentServerLabel` exists: "components reach deployment vocabulary
through this package". The account's screen, the ended card (11.1) and MCP's `hq_url` (14.3) import
it from `@/lib/deployment`, as client components import `deploymentServerLabel` today, so no file of
`components/` or of `lib/publish` reads `lib/commcare`. The module's only runtime import is the
server table, which is client-safe data by its own header.

`base` is `COMMCARE_SERVERS[server].baseUrl`, the closed set every HQ address in Nova starts from
(`lib/deployment/setupArtifact.ts::hqBase`, `lib/deployment/service.ts::hqAppUrlFor`). `<app>` is
`base + "/a/" + domain + "/apps/view/" + remoteAppId`.

| Place | Address | HQ's view, and its lifecycle at `d6c6e16d8ae1` |
|---|---|---|
| `app` | `<app>/` | `app_manager/urls.py::app_urls`, `view_app`: alive. Nova already links here (`lib/deployment/service.ts::hqAppUrlFor`) |
| `app-settings` | `<app>/settings/` | `app_settings`: alive; Nova already links here (`lib/deployment/setupArtifact.ts::logoSection`) |
| `languages` | `<app>/languages/` | `app_languages`, served by `view_app`: alive |
| `menu`, `case-list`, `case-detail`, `search` | `<app>/modules-<menu>/` | `views/modules.py::view_module_legacy`: alive. Its docstring says it "has been kept around to not break any documentation on example apps and partner-distributed documentation on existing apps. PLEASE DO NOT DELETE." |
| `form`, `question` | `<app>/modules-<menu>/forms-<form>/` | `views/forms.py::view_form_legacy`: alive, with the same docstring |
| `lookup-table` | `base + "/a/" + domain + "/fixtures/"` | `corehq/apps/fixtures/urls.py`: redirects to `edit_lookup_tables`; alive; Nova already links here (`setupArtifact.ts`) |
| `organization` | the address part 11 gives its Organization banner (`readManagedPlacesView().hqUrl`'s path, `/a/<domain>/settings/locations/list/`) | part 11's citation |
| `media` | null | HQ has no one page for a file; the group has no link |

The two index addresses are the right ones because a finding's place holds positions and not ids:
part 01's `HqPlace` carries "0-based positions in HQ's lists", which is exactly what these views take.
`view_generic.py::_get_module_and_form` resolves `module_id` through `Application.get_module` and
`form_id` through `ModuleBase.get_form`, each of which parses its index from the URL's text
(`@parse_int([1])`), and HQ's `tests/test_views.py::test_view_module_legacy` and
`test_view_form_legacy` hold both to a 200. One thing HQ does on that page is stated for whoever
reads this later: where a menu has no id of its own yet, opening it by position gives it one and saves
the app (`_get_module_and_form`), as opening it from HQ's own sidebar does. The next "Check again"
reads the app afresh, so nothing in Nova depends on it.

The links open in the person's own CommCare HQ session. Nova sends no credential with them.

### 7.5 Copy the list

```ts
// components/bring-in/bringInModel.ts
/**
 * The whole account as plain text. `context` is the one the screen's blocks are built from (6.1),
 * and `date` the day the read answered, already in the reader's locale.
 */
export function accountAsText(
	answer: AccountAnswer, context: CircumstanceContext, date: string,
): string;
```

`accountAsText` is pure and gives plain text: the heading, the project space
and the date of the read (**A12**; the date is the model's `answeredAt`), the count line, then each
group's heading followed by one line per finding ("- {label}: {sentence}" and, where named, " In
CommCare HQ: {name}."; a circumstance's lines are its body, the name where `named` is not null, and
its next step, all from `circumstanceBlock`), and it ends with `ACCOUNT_CHECK_AGAIN_LINE` on a line
of its own, so "Copy the list" carries the line a person reads on the screen. The button writes it
with `navigator.clipboard.writeText` and reads **Copied** for two seconds, announced through a
`role="status"` region; where the browser refuses the clipboard the same text opens selected in a
read-only `Textarea` under the button with the line **A10**, so the list can always be taken away.

### 7.6 Check again

**Check again** dispatches `read-asked`: the model drops what it held of the app, the hook reads it
afresh, and the screen is section 5's until the read answers. Every read is whole, so there is
nothing to say about what a second one skips. An account that held only Nova's own fault is checked
the same way: part 01's blocks for `read-back-differs` and `unrecognized` already say the gap was
reported and that checking again after a Nova update is the way on.

---

## 8. The review

A read's answer of kind `review` (part 12, 3.1): its `review` is part 12's `ReadingReview` (its
5.1), and its `readingId` and `reviewDigest` are what a create is sent back (8.9). Nothing has been
created when this screen shows, and the heading's next line says so.

### 8.1 The screen, top to bottom

| # | Section (its `h2`) | Shown |
|---|---|---|
| | the heading **V1**, as `h1`; under it **V2** | always |
| | a create's lead (part 12's `CREATE_ANSWER_LEADS`), and a held stop's block (8.10) | where the model holds one |
| 1 | **Your app** (8.2) | always |
| 2 | **Where workers use this app** (8.3) | always |
| 3 | **Lookup tables** (8.4, 8.5) | where `review.tables` is not empty |
| 4 | **Places** (8.6) | where `review.places` is not null |
| 5 | **Pictures and sounds** (8.6) | where `creates.mediaFiles > 0` or `mediaLeftOut > 0` |
| 6 | **Stays as it is in CommCare HQ** (8.7) | always |
| 7 | **After it's in** (8.8) | always |
| 8 | **What the first publish changes** (8.8; part 09's `FIRST_PUBLISH_HEADING`) | always |
| | the footer, which does not scroll: **Choose another app** and **Bring it in** | always |

Sections 3 to 8 hold no control but a table's choice. A person who changes nothing presses one
button.

### 8.2 Your app

- A `Field` with the label **V4** and an `Input` holding `answers.appName`, which starts as
  `review.appName` (CommCare HQ's name), `maxLength` 255, `autoComplete="off"` and `data-1p-ignore`.
  Emptied, it shows `READING_REFUSAL_COPY.name_missing` (part 12, "Copy") as its `FieldError` when Bring
  it in is pressed, and takes focus.
- One line of counts, **V5**: menus, forms, questions and languages, each pluralized, joined by ` · `
  (the design system's metadata separator). Languages are a count, the length of `creates.languages`,
  and never a code: "no ISO code appears in any Builder surface" (`components/builder/CLAUDE.md`).
- Where `creates.caseTypes` is not empty, **V6** with the names in `font-mono`.
- **V7**, naming the Project the address names and who can open the app there (everyone in a
  shared Project; only the person in their own, by the seed's `personal`), and where `review.tables`
  is not empty, **V8**.

### 8.3 Where workers use this app

A radio group (12.2) over `review.runsOn`, in the order part 12 gives, the `preselected` entry
chosen. Each row is a declaration the app's content really runs on, so no row is disabled:

- its label, `PLATFORM_DECLARATION_LABELS[runsOnlyOn ?? "both"]` (`lib/domain/platforms.ts`);
- its line, `PLATFORM_DECLARATION_LINES[runsOnlyOn ?? "both"]`. The three lines of
  `AppPlatformsSection.tsx::CHOICES` move to that new export of `lib/domain/platforms.ts`, unchanged, and
  `CHOICES` reads them, so App settings and the review say one thing;
- where `splitDatetime` is true, **V10**, which says how many questions the choice asks in two
  parts and why.

```ts
// components/bring-in/bringInModel.ts
export interface DeclarationRow {
	readonly choice: ReadingDeclarationChoice;
	/** `PLATFORM_DECLARATION_LABELS[choice.runsOnlyOn ?? "both"]`. */
	readonly label: string;
	/** `PLATFORM_DECLARATION_LINES[choice.runsOnlyOn ?? "both"]`. */
	readonly line: string;
	/** V10 over `review.datetimeQuestions` where the choice splits, else null. */
	readonly splitLine: string | null;
}
/** One row for each entry of `review.runsOn`, in its order. */
export function declarationRows(review: ReadingReview): readonly DeclarationRow[];

export interface DeclarationWhy {
	/** V11a, V11b or V11c, by `review.runsOnWhy`. */
	readonly why: string;
	/** V12a or V12b where the chosen declaration differs from CommCare HQ's setting, else null. */
	readonly firstPublishAsks: string | null;
	/** `platformOutBlock` of each entry of `review.platformsOut`, in its order ("Copy", V13). */
	readonly cannotRun: readonly ReturnType<typeof platformOutBlock>[];
	/** V14. */
	readonly later: string;
}
export function declarationWhy(review: ReadingReview, answers: ReviewAnswers): DeclarationWhy;
```

`declarationRows(review)` builds the rows; `declarationWhy(review, answers)` builds the lines under
the group:

| Line | When | Text |
|---|---|---|
| why Nova chose | always, for the preselected row | **V11a** where `runsOnWhy` is `content`; **V11b** where it is `web-apps-off-in-hq`; **V11c** where it is `keeps-web-apps` |
| what the first publish will ask | the chosen declaration leaves Web Apps out and `webAppsOnInHq` is true | **V12a** |
| | the chosen declaration includes Web Apps and `webAppsOnInHq` is false | **V12b** |
| a platform the app cannot run on | one block for each entry of `platformsOut` | **V13**: its lead, then the features as a list, then the files' sentence where `media` is true |
| | always | **V14** |

**What these lines leave to the first-publish list.** The chosen row's own list (8.8) says what the
first publish changes, in part 09's sentences: `date-and-time-questions-split` for a row that
splits, and `web-apps-turned-off` or `web-apps-turned-on` for a row whose declaration differs from
CommCare HQ's setting. So V10 says only what the choice is and why, and makes no second statement of
the change. V12a and V12b stay whole, because they say something no entry of the list says: that
the publish stops and asks before it changes the Web App setting (`lib/deployment`'s `web-apps`
edge, which part 09's 11.4 keeps: "the publish also asks before it changes the setting, as it does
today"). The list says what will differ; V12 says the person will be asked first.

**V13 sets a feature's label down as a list item.** `PLATFORM_FEATURES[feature].label` is a row
label of the platform table ("Date and time questions", "Case list first", "CommCare Connect",
"here() in a case list"): written to stand alone, capitalized as a heading, and some begin with a
name that keeps its capitals, so no rule lowers a first letter safely. Run into a sentence after
"it uses", such a label breaks sentence case. So V13's lead ends in a colon and each label is an
item of a list under it, as written, which is the position the label was written for.

`runsOnWhy`, `webAppsOnInHq`, `datetimeQuestions` and `platformsOut` are four values of part 12's
`ReadingReview`, each computed where the choices are computed (its 5.1). They are in the review, so
they are in its digest.

This is the plan's decision that the platform declaration is a preselected choice in the review,
never a gate before the app exists (`../6-bring-in.md`, "What changed from the outline, and why",
item 5): no step, no tick, and the choice can be changed later in App settings, which the last line
says. Choosing a row dispatches `answers`; it asks nothing of the server.

### 8.4 Lookup tables that need no answer

- Part 11's **R1**, with `{tags}` the tags of every entry whose standing is `new` or `same-managed`
  (in words, each tag in `font-mono`), where there is one.
- Part 11's **R2**, once for each entry whose standing is `same-equal`.

### 8.5 A table that meets one the Project has

One `fieldset` for each entry whose standing is `choice`, with part 11's words (its "Copy", R6 to
R11) and its data (`ReviewTable.choice`):

- the `legend`: **R6**, in the form for `differs` empty or not;
- the body: **R7**. Where `differs` is empty, the form is chosen by the first answer's offer: where
  `options["use-commcare-hq"]` is not offered with `why: "managed-elsewhere"`, the form that names the
  other project space (the offer's `name`); else the form that says Nova manages the Project's
  table. `{apps}` is the names of `choice.apps` in words, and its clause is dropped where there are
  none, as part 11 says;
- two radio rows, neither chosen: **R8** ("Use CommCare HQ's table") with its lines, including the
  retyped-columns line where its offer's `retypedColumns` is not empty and one gone-columns line for
  each of its offer's `goneColumns` (both on `options["use-commcare-hq"]` where it is offered); and
  **R9** ("Use {Project}'s table") with its line;
- an answer that is not offered is a row that cannot be chosen (`aria-disabled`, in the tab order),
  with its reason under it: **R10**'s sentence for the offer's `why`, one of `needs-admin`,
  `managed-elsewhere`, `app-reads-a-missing-column` and `fails-a-project-space-rule`. The last is
  part 11's (its 7.2): the app could not be born on the Project's table as it stands, so
  `use-project` is not offered, and R10 says "{Project}'s table, as it stands, holds something this
  app couldn't be published or exported with, so this app can't use it.";
- under the group, where at least one answer is offered, **R11**, with the action **Choose another
  Project**, which pushes `/build/new?hq=choose`, where the picker keeps the project space.

Neither answer is preselected: part 11 (7.2) makes each one a change to a table other apps read or to
what a later publish asks, so it is the person's to say. Choosing dispatches `answers`.

Where neither answer is offered, the group shows both reasons and, in R11's place, **V17** with the
same action, **Choose another Project**. R11 ("Or go back and add this app to another Project.") is
an alternative beside a choice; with no choice open it would say the same way out twice, so only
V17 shows. Bring it in moves focus here as it does for an unanswered choice (8.9).

### 8.6 Places, pictures and sounds

- **Places**: part 11's **R5** with `{count}` from `review.places.count`.
- **Pictures and sounds**: part 11's **R4** with `{count}` from `creates.mediaFiles`, where it is
  above zero, and **R3** with `{count}` from `mediaLeftOut`, where it is above zero.

### 8.7 Stays as it is in CommCare HQ

Part 01's kept list (its 9.4, `lib/publish/keptValues.ts`), which the Publishing card draws after the
birth, drawn here before it from `review.kept` and `review.readAt`: the lead "These stay as they are
in CommCare HQ, as it held them on {date}:" and `KEPT_LABELS[id]` for each id as a list; or, with no
id, "Every setting CommCare HQ keeps for this app matches a new app's, as it held them on {date}.";
then, under either, "Nova doesn't change these when it publishes. A CCZ made for this project space
follows them." The date is the reader's locale date of `readAt`, with the year where it is not the
current one, as the card formats it. There is no Refresh here: a reload reads everything again. The
list arrives computed: part 12's read fills `review.kept` as the `kept` row of its 5.1 says,
over the source as the adopted baseline will store it. This part writes no call for it and holds no
source on the client, which is how the kept list is shown before any baseline exists (part 01, 9.4).

### 8.8 After it's in, and the first publish

**After it's in**, three sentences that are always shown and one that is shown where it applies:

- **V21a**: the app can be worked on in Nova and published back to this app in its project space.
- **V21b**: a change made in CommCare HQ stops the next publish before anything is sent, and the
  publish lists what changed and offers to bring it in.
- **V21c**: publishing to another project space makes a new app there, and a copy the team already
  keeps there stays as it is.
- part 10's `adoptionRecordedFeaturesLine(labels, domain)`, where the chosen row's `recordedFeatures`
  is not empty. `labels` is `PLAN_FEATURES[key.subject].label` (`lib/publish/planFeatures.ts`) for
  each `plan-feature` key, in words. It moves when the person chooses another row, since Web Apps is
  recorded only for a declaration that includes it (part 10, 6.5).

V21b says what part 15 builds (`15-changes-made-in-commcare-hq.md`): the stop lists what changed and
the person can bring it in, publish over it or stop publishing there. V21c says what publishing to
another project space does, and D7 says it again in the Publish dialog (11.2). Updating a copy that is
already there is not planned (`../7-rest-of-model.md`, "Not planned"). Neither sentence names a later
step.

**What the first publish changes** is generated, never one fixed paragraph: the list is the entries
of part 09's register that apply to this app (its 11 and 12.1), and a fixed paragraph would be true
of some apps only. Every word of it is part 09's (its 12.2 and its "Copy", in
`lib/publish/firstPublishCopy.ts`). This part places it and writes no sentence of it.

The list is the chosen row's, not the review's. Three register entries depend on the choice
(`web-apps-turned-off` and `web-apps-turned-on`, whose `scope` is `declaration`, and
`date-and-time-questions-split`; part 09, 11.2 and 12.1), so part 09 gives each choice its
own view (its 12.1: part 12's `ReadingDeclarationChoice` holds `firstPublish: FirstPublishView`,
taken from the `AcceptedDeclaration` at the same position), and
`ReadingReview.firstPublish` is only the preselected choice's. The screen reads
`chosenDeclaration(review, answers).firstPublish` (3.3) and draws it again on every `answers` event
that changes the row, with no request. A person who chooses Android only while CommCare HQ has Web
Apps on therefore reads that Web Apps will be turned off, in this section, before they create.

`FirstPublishLines` (12.1; props `{ view, surface }`) draws one `FirstPublishView` for one surface.
What it draws is decided by part 09's one renderer, `firstPublishLines(view, surface)`
(`lib/publish/firstPublishCopy.ts`, its 12.2), which returns part 09's `FirstPublishLines`
value: `heading`, `lead`, `workers: { label, lines }`, `hqOnly: { label, lines }`, `reassurance`
and `note`. The component calls it and draws, in this order:

1. `heading` as the section's `h2` (`FIRST_PUBLISH_HEADING`);
2. `lead` (`FIRST_PUBLISH_LEAD_REVIEW` here, `FIRST_PUBLISH_LEAD_PUBLISH` in the Publish dialog,
   11.2; the renderer picks it by `surface`);
3. where `workers.lines` is not empty, `workers.label` ("Workers will notice") as an `h3` and its
   lines as a list, each its `sentence`;
4. where `reassurance` is not null, `reassurance` (`FIRST_PUBLISH_NO_WORKER_CHANGE`) in that
   group's place, and nowhere else;
5. `hqOnly.label` ("Only in CommCare HQ") as an `h3` and its lines as a list;
6. `note` (`FIRST_PUBLISH_FORM_BUILDER_NOTE`) last.

The component holds no rule: it never reads `view.touchesWorkers`, never sorts a line and never picks a
string. Part 09's `firstPublishCopy.test.ts` holds the rule; this part adds no model function for it.
It adds no sentence and drops none, as part 09 asks: "a list is shown whole". Part 10's
`media-files-renamed` and part 11's `media-references-with-no-file-removed` are entries like any other,
drawn by steps 3 and 5 with no arm of their own here. A list can hold fewer lines than its view has ids
(part 09, 12.2), so nothing here counts ids. Where the row changes, the list's `aria-live` region at
`polite` announces the heading once, not each sentence.

The review, the Publish dialog (11.2) and MCP (14.3, 14.7) all read `firstPublishLines(view,
surface)`, so the three say one thing in one order.

### 8.9 Bring it in

The button is a `Button` (the default lilac keycap), always enabled while the screen is idle. Pressed:

1. Where the name is empty after trimming or over 255 characters: the name field shows its error and
   takes focus. Nothing is sent.
2. Else where `unansweredChoices(review, answers)` is not empty: `choice-needed` is dispatched for
   the first tag, that `fieldset` scrolls into view, its first radio that can be chosen takes focus
   (its `legend` where none can), and the line **V16** (or **V17**) shows under it with
   `role="alert"`. Nothing is sent.
3. Else `create-asked` is dispatched with `input: bringInInputOf(key, answer, answers)`: the
   address's key, the review's `readingId` and `reviewDigest`, and the answers (part 12's
   `BringInInput`, its 5.3). The model keeps it as `pendingCreate`, the hook writes the tab's key
   (9.1) and posts the create (`nextAct`'s rule 7). The screen becomes section 9.1's at once, so
   the review's button needs no in-progress label: the creating screen's status row is the
   progress.

Step 2 is in the browser so nobody waits on a round trip to learn what the screen already knows.
The server holds the same rule for every other caller and refuses a missing answer as
`choice_missing` (part 12, 5.3).

### 8.10 When a create answers something other than the app

Part 12's `CreateAnswer` (its 5.3), by kind. Each lead is part 12's `CREATE_ANSWER_LEADS` sentence
for the model's `lead` (3.3), and each refusal's sentence is its `READING_REFUSAL_COPY` entry.

| Answer | The screen |
|---|---|
| `created` | the landing (9.2) |
| `changed`, `now` a review | this screen with the new review, the answers `carryAnswers` kept (3.3), and the lead in a `role="status"` line above the heading, which takes focus. Where a choice could not be kept, the lead gains part 12's sentence for that |
| `changed`, `now` an account | section 7's screen, with the lead above it |
| `changed`, `now` a stop | section 6's screen, with the lead above it. `already-in-nova` has a lead of its own, which says the app was brought in after the review and that Nova made no second one, and its block offers **Open {appName}** where the person can open it |
| `read-again` | section 5's screen with the lead above it, while the hook reads the app again. Whatever that read answers is then shown with the lead still above it: a review comes back with the answers `carryAnswers` kept |
| `check-failed` | section 7's screen for the one finding (`accountOfOne`, 3.3), with the lead in a `role="status"` line above the heading. The heading is A2, and the lead under it is A4 in its form for a create's answer |
| `held` | this screen with the answers kept; above the heading, the lead and the circumstance's block (6.1), which says what to clear before pressing Bring it in again |
| `refused`, `name_missing` | the name field's error |
| `refused`, `choice_not_offered` | its sentence in a `role="alert"` line above the footer |
| `refused`, `choice_missing` | its sentence in a `role="alert"` line above the footer, as `choice_not_offered`'s. The page does not reach it: 8.9's step 2 stops a missing answer before anything is sent |
| `refused`, `project_changed` | its sentence above the footer; Bring it in is offered again |
| `refused`, `no_project_access` | the `refused` screen of section 5, with **Choose another Project** and **Go to your apps**. The birth checks `edit` once more, so a role that changed during the create is refused here (part 12, 4.1) |
| `refused`, `app_unavailable` | the `refused` screen, with its sentence and **Go to your apps** |

A lost request and a `failed` line during a create are section 9.1's. A create that was sent again
after a reload (9.1) can answer `held` or a refusal of the person's answers to a page that holds no
review: the hook then reads the app, and the lead, the held block or the refusal's sentence stands
above the review that read answers (3.3).

Three rules keep every one of these screens true, and each is drawn from the model's `lead` alone.
A create's answer never says "Nothing was created": S1, A3 and A4 read their second form (6.1,
7.1), which is true before the create adds the app's files to the Project and after. The three
answers that can come after the files are added (`read-again`, `check-failed` and `refused` with
`project_changed`) carry part 12's sentence about files, worded with "any" so it is true where
none had been added. And S1 is not drawn under `already-in-nova`.

---

## 9. Creating, and landing in the builder

### 9.1 Creating

While the model holds `pendingCreate` (`screenOf`'s rule 4), from the press of Bring it in until
the create ends: the card shows a status row **X1** with the spinner; under it the stage the
create's own stream names, `READING_STAGE_LABELS[stage]`, with the count on `checking-media` and on
`bringing-in-media`; then **X2**, **X6**, and after twenty seconds **X5**, the creating screen's own
reassurance. On the stage `creating` no stage line is drawn under X1, which already says it: part
12's label for that stage is X1's own words. The review's choices are not on screen at any moment
of it, the wait before a retry included, so nothing can be changed under a create in flight.

A create is one request (part 12, 5.3): it reads the app once more, which is why its stream names
a read's stages first, adds the app's files to the Project only once the review is known to be the
one the person answered, and creates the app in one transaction. The hook posts it once, reads its
stream, and never aborts it: the route hands the create no signal (part 12, 4.1), so the work runs
to its end whether or not the tab stays. Whether the platform keeps an instance with no open
request long enough to finish is not something this part can promise, so **X6** promises only what
holds either way: if Nova finishes, the app is in the person's apps, and if it does not, no app is
created.

**A lost request.** The first response that ends with no last line shows **W5** and the same create
is posted again after 3 seconds, with the same input. The second shows **X4** with **Try again**,
which dispatches `retry`, and the same create goes again. The screen is this one throughout
(`creating` with `lost`), never the review. Trying again is safe because a repeat of one reading's
create answers the same app, wherever the first one stands (part 12, 6.6).

**Nova's own failure.** A stream whose last line is `failed` shows the `failed` screen with the
operation `create`: part 12's `READING_FAILED_COPY.create` (title and body, `{app}` the review's
name), **Try again**, which dispatches `retry` and sends the same create, and **Go to your apps**.
The page never sends it again by itself (5).

**A reload during a creation sends the same create again.** Nothing on the server says a create is
in flight, so a page that simply read the app again would either show the stop `already-in-nova`
for the app the person had just made, or show a review they would answer a second time. One key in
the tab closes that:

- On `create-asked` the hook writes `sessionStorage["nova:bring-in-create"] =
  JSON.stringify({ at: Date.now(), input })`, `input` the `BringInInput` it posts.
- It removes the key on every final answer: `created` (after the landing, 9.2), `changed`,
  `read-again`, `check-failed`, `held`, `refused`, and a `failed` line. A lost stream keeps it.
- Each time the location becomes an app, before any read, the hook reads the key and asks the pure
  `bringInModel.ts::resumableCreate(raw, key, now)` (3.3). It answers the input where the text
  parses, the input passes part 12's `bringInInputSchema`, its `projectId`, `server`, `domain` and
  `remoteAppId` are the address's, and `at` is less than `BRING_IN_RESUME_WINDOW_MS` before `now`;
  otherwise null. The hook dispatches `resume` with the answer. With an input the screen is this
  one and the act is the create; with null the hook removes the key and the page reads the app.

The create it sends answers `created` where the first committed, joins the first where it is still
running, and runs whole where the first died (part 12, 6.6). The window is one hour because that is
the service's request ceiling (`config/runtime-capabilities.json::cloudRunRequestSeconds`): no
create is still running after it, and a create that starts on a page load long after the person
asked is one they did not ask for. Every access to `sessionStorage` is inside `try`/`catch`, as the
landing's marker is (9.2): a browser that refuses storage costs only this, and the stop the reload
then shows names the app and offers to open it. A tab that was closed has no key, and the picker
then shows the app as "Already in Nova" with **Open** (4.3), which is true. The key is tab-local
and holds nothing a member of the Project cannot see: a key, a digest, a name and the answers.

### 9.2 The landing

On `created`, the hook calls part 12's `landCreatedAppReceipt(result.receipt, "brought-in")`, which
`ChatContainer` hands it as an argument of `useBringIn`, and dispatches `landed` with its answer
and the receipt's `appId`. It then removes the tab's create key (9.1):

| Answer | What the person sees |
|---|---|
| `landed` | the builder, in this tab, with no page load: `installCreatedApp` installs the app and promotes the URL to `/build/<id>`, the centred column gives way to the builder as it does for a blank app, and the toast of 9.3 shows |
| `leaving` | the creating screen stays while the tab loads `/build/<id>` (the app went to another Project than the tab's; part 12, section 7). The app's own page then shows the toast of 9.3 from a one-time marker (below) |
| `unverified` | part 12's toast for `brought-in`, which `ChatContainer` shows (`UNVERIFIED_LANDING_TITLE`, "Your app is in, and this tab couldn't open it", with `UNVERIFIED_LANDING_BODY`), and the screen `unopened`: the line `UNVERIFIED_LANDING_TITLE`, the same export of part 12's `lib/publish/hqReadingCopy.ts`, so the toast and the screen say one sentence and this part writes none; **Open your app** (a plain link to `/build/<appId>`, which loads the app's own page through the ordinary hydration read) and **Go to your apps**. The review is not drawn again: the app exists, and a second Bring it in would only answer the same receipt |

**The marker for `leaving`.** `landCreatedAppReceipt` assigns the location itself and only then
answers `leaving` (part 12, section 7), so the hook cannot act between the two. It decides before the
call, by the rule that function follows: where `result.receipt.projectId` is not the tab's Project
(`useProjectId()`), it writes `sessionStorage["nova:brought-in"] = JSON.stringify({ appId, domain,
name })` (`receipt.appId`, `receipt.adoption.domain`, `receipt.blueprint.appName`), and then
calls. Where the answer is anything but `leaving` (a receipt that failed its parse answers
`unverified` whatever Project it names), it removes the key at once. A receipt for the tab's own
Project writes nothing, so the `landed` path, whose promotion keeps `BuilderLayout` mounted, can
never show the toast twice.

`BuilderLayout` reads and removes the key in a `useEffect` on mount, never during render, and shows
the toast of 9.3 where the stored `appId` is the app the page opened. Every access to
`sessionStorage` (the write, the read, the two removals) is inside `try`/`catch`: a browser that
refuses storage costs the toast and nothing else, and the Publishing card still says where the app
came from. The key is tab-local, it names nothing a member of the Project cannot see, and a tab that
never arrives leaves nothing behind but one unread key.

### 9.3 What the builder shows first

The app's own home: its structure tree, its canvas, and the chat docked, exactly as a blank app lands.
The person reads their own menus and forms by name before anything else, which is the proof it came
in.

- **One toast**, through `ChatContainer`'s `projectToast` (or, after a page load, `lib/ui/toastStore.ts::
  showProjectToast`) at severity `info`, persistent until dismissed: title
  **T1**, body **T2**, and the action **T3** ("See what came in"), which calls
  `pushBuilderHistory("/build/<id>/setup/publishing")`. Publishing is where the app's origin, what
  stays in CommCare HQ and what the first publish changes all live (11.1), and the toast is how a
  person finds it the first time.
- **The conversation is empty and is not a dead end.** A brought-in app is born with no thread (part
  12, 6.4), since a first message saying what came in would be a transcript no run wrote, so the chat
  panel shows what it shows for every app with no messages yet: `ChatSidebar`'s
  `ConversationEmptyState` ("Your conversation with Nova appears here. Start it in the box below.")
  above the composer's "What would you like to change?". This part changes neither. The first message
  is an ordinary edit turn.
- **Publishing already holds a card.** The adopted deployment exists from the birth (part 10, 6.1), so
  App setup's Publishing section shows the project space the app came from at once, in the words of
  11.1, before any publish.

Nothing is stored in the session or the document to say an app was brought in (part 12, section 7). After
this first minute, the Publishing card is where it is said.

---

## 10. The home list

**No row for an app that is being read.** A read is one request that leaves nothing behind, so
there is nothing "coming in" to list, and the home list gains no section, no row and no action for
it. `app/(app)/(site)/app-list.tsx::AppList` changes only by the entry of section 2, and
`page.tsx::HomePage` only by the empty state's line (2) and the refresh below. Coming back to an
account or a review is the address (3.2), which a person can keep or send; a brought-in app is a
row of "Your apps" like any other, and its Publishing card is where its origin is said (11.1).

**The empty state refreshes after a landing.** Next serves Back from its client cache "whatever
the route's own freshness says" (`RefreshStaleAppList.tsx`), and that component refreshes where
`lib/ui/appListFreshness.ts::consumeAppListStale()` is true, a note
`ChatContainer.tsx::installCreatedApp` sets for every birth. `AppList` mounts it and the empty
branch of `HomePage` does not, so a person who starts from "Build your first app", lands an app and
presses Back gets the cached empty state. That is so today for a blank app and a designed one, and
the empty state's new line (N2, N3) adds a third way to meet it. So `HomePage` mounts
`<RefreshStaleAppList />` in the empty branch too. The flow adds no call of `markAppListStale()`:
a brought-in app lands through `installCreatedApp` (9.2), which already marks the list, and a
landing in another Project is a page load.

---

## 11. After the app is in

### 11.1 The Publishing card

`components/builder/DeploymentStatus.tsx` and `app-setup/publishingSectionModel.ts`. Every derivation
is in the model, as that file's rule is.

```ts
// components/builder/app-setup/publishingSectionModel.ts
/** Where a deployment's app came from, where Nova did not make it. */
export function broughtInOf(view: DeploymentView): { readonly at: string; readonly byName: string } | null;
/** What the card draws for a deployment: its ordinary record, or the ending it stands at. */
export function cardKind(view: DeploymentView): "record" | "ended";
/**
 * Whether some record of this app other than `target`'s has a live `app` mapping whose `ownership`
 * is `adopted`: the app was brought in from another project space (11.2, the plan line).
 */
export function broughtInElsewhere(
	records: readonly DeploymentView[],
	/** `CommCareServer` as the file imports it today, from `@/lib/deployment`. */
	target: { readonly server: CommCareServer; readonly domain: string },
): boolean;
```

`broughtInOf` reads the live `app` mapping (`lib/deployment/resources.ts::activeRemoteApp`): where its
`ownership` is `adopted`, its `adoptedAt` and part 10's `adoptedByName`; else null. `cardKind` is
`ended` exactly where part 10's `deploymentEnding(view.deployment)` is not null, and never reads the
state (part 10, 8.1: "the state would be the wrong witness").

**A record that was brought in** gains, top to bottom:

- Under the project space's name: **D1**, "Brought in from “{domain}” on {date} by {name}", the date
  in the reader's locale as the card formats a confirmation's.
- The rung "On CommCare HQ" states its condition in text, as every rung does. Where
  `view.firstPublish?.of` is `first-publish` (part 09, 12.3: the baseline still holds the list
  stored at the bring-in, so Nova has not published here yet), that text is **D2**: Nova read
  the app on that day and has not published to it. It says what Nova did and knows, and makes no
  claim about what CommCare HQ holds today. After the first publish it is today's text. The label
  is unchanged, and the card never says "Uploaded" of an app
  Nova did not upload: `DEPLOYMENT_STATE_LABELS.uploaded` is "On CommCare HQ" already.
- The kept list with its date and **Refresh from CommCare HQ**: part 01's block (its 6.5). Where
  Refresh answers `changed-in-hq`, its sentence is part 15's C1 with the button C2 beside it (its
  section 9.6), which opens `HqChangesDialog` on this project space. This holds for every record
  with a kept list, brought in or made by Nova.
- The confirmations Nova recorded at the birth are ordinary rows of the card's confirmations
  (`liveConfirmationRows`), attributed to the person who brought the app in, each with Withdraw
  (part 10, 6.5). This part adds no row kind.
- At the card's foot, for a member whose role allows `delete` (`lib/session/hooks.tsx::useCanDelete`)
  and only while the deployment has a live `app` mapping: a `ghost` `Button`,
  `STOP_PUBLISHING_ACTION` ("Stop publishing here"), with `STOP_PUBLISHING_HELPER` under it as its
  description. An editor sees neither: part 10 offers it only to a member who may delete, and "an
  editor who reaches the action another way reads the `not_permitted` sentence". `DeploymentStatus`
  gains one prop for it, `canStop?: boolean` (default false), and
  `app-setup/PublishingSection.tsx` passes `canStop={useCanDelete()}` to each card, beside the
  `canRefresh` it passes today. The card the Publish dialog draws after a publish
  (`PublishDialogBody.tsx`'s own `DeploymentStatus`) passes none, so that card offers no stop: the
  dialog's one place for it is the drift stop (11.3).

"Stop publishing here" is offered on every deployment with a live app mapping, brought in or made by
Nova: ending is a state of any deployment (part 10, section 8), and the helper's sentence is true of
both.

**The confirmation** is an `AlertDialog`: title `stopPublishingConfirmTitle(domain)`, body
`stopPublishingConfirmBody(domain)`, `STOP_PUBLISHING_CANCEL` and `STOP_PUBLISHING_CONFIRM` (all part
10's, `lib/publish/stopPublishing.ts`). The action is a `ghost-destructive` button; it calls
`stopPublishingAction({ appId, server, domain })`. On success the card's surface takes the returned
view (`onUpdated`), bumps the session's `deploymentRecordsRevision` and applies
`previewProjectSpace`, as a Check status does. On `not_permitted` or `invalid` the error's own
sentence shows in the dialog with `role="alert"`; any other failure shows **D10**. This is one
question with its consequence and its undo in the body, which is the design system's shape for a
change that cannot be taken back from the same screen, and it is the only confirmation this part
adds.

```ts
// components/builder/StopPublishingDialog.tsx (new)
import type { CommCareServer } from "@/lib/deployment";
import type { stopPublishingAction } from "@/lib/deployment/actions";

type StopPublishingData =
	Extract<Awaited<ReturnType<typeof stopPublishingAction>>, { success: true }>["data"];

export function StopPublishingDialog(props: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** The deployment to stop: the three fields `stopPublishingAction` takes. */
	readonly target: { readonly appId: string; readonly server: CommCareServer;
	                   readonly domain: string };
	/** Called once with the action's answer when the stop succeeds, before the dialog closes. */
	readonly onStopped: (next: StopPublishingData) => void;
}): ReactElement;
```

The card passes an `onStopped` that does what the paragraph above says; the drift stop passes the
one of 11.3.

**An ended card** (`cardKind` of `ended`) draws, in place of the ladder, Check status, the kept list
and the Workers panel:

- `endedLine(ending, date)` (part 10's two sentences, by reason), with `date` the reader's locale day
  of `ending.at`, formatted as the card formats a confirmation's. The picker's and the card's other
  dates are formatted the same way; part 10's drift sentences arrive with their date already in
  them (its 9.1);
- a link `ENDED_HQ_APP_LINK` ("Open the app in CommCare HQ") to `hqPlaceUrl({ server, domain,
  remoteAppId: ending.hqAppId }, { kind: "app" })` (7.4);
- "Publish again" where `publishAgainDomain` allows it, as today. It opens the dialog, whose plan
  line for this project space is `PUBLISH_PLAN_CREATES_BESIDE`;
- where a publish after the ending stopped before it made the new app, that attempt's refusal, drawn
  as the card draws any refusal, under the ending's line (part 10, 8.6).

Confirmations stay on an ended card: they are about the project space (part 10, 8.2).

**The dialog's compact rows** (`compactTargetRows`) gain one status label, "Publishing stopped", for
an ended deployment, and the line `PUBLISH_PLAN_CREATES_BESIDE` in place of the update-or-fresh line.

### 11.2 The first publish

**The data is part 09's, and this part stores nothing.** The list a person reviewed is kept on the
app's read baseline (part 09, 12.3): written at the birth from the chosen declaration's view, ended
by the first push, and read back as `DeploymentView.firstPublish: FirstPublishView | null`, which
is not null while the live app mapping names the app a list was stored for. So a person who
chose a row other than the preselected one reads, at the first publish, the list of the row they
chose, and a person who has since changed where the app runs in App settings reads the two Web Apps
lines as they stand for the app now, because those two are worked out again from the document and
never stored. This part reads `DeploymentView.firstPublish` from the records the dialog and the
card already hold (`usePublishingRecords`), and imports `FirstPublishView` from
`lib/publish/firstPublishChangeIds.ts` and `firstPublishLines` from
`lib/publish/firstPublishCopy.ts`, both client-safe. It adds no column, no migration, no store
function and no type for the list.

**The Publish dialog.** In `PublishDialogBody.tsx`, the review step of a direct upload shows, for a
selected project space whose record holds `firstPublish`, a section above the confirmations:
`<FirstPublishLines view={record.firstPublish} surface="publish" />` (8.8), which draws the heading
`FIRST_PUBLISH_HEADING` as the section's `h2` and the lead `FIRST_PUBLISH_LEAD_PUBLISH`, which
tells the person that these changes come along with their own edits. It is information and holds no
control:
"Required confirmations and their consequences stay visible" (`design/readme.md`, "Publishing"), and
this is a consequence. It is not under Details, for the same reason. What the publish asks is
unchanged: the confirmations part 10 did not record, the project-space settings, and the Web App
setting where the declaration differs. A record with `firstPublish` null shows no section. A list
of kind `next-publish`, which part 15 stores after a bring-in of changes or a read that compared
equal, shows in the same place with part 15's heading and lead (its section 9.4) in place of
`FIRST_PUBLISH_HEADING` and `FIRST_PUBLISH_LEAD_PUBLISH`. The component and its `surface` prop
(12.1) do not change for it: part 09's renderer chooses the heading and the lead from `view.of`.

**The plan line.** `publishPlanCopy` and the type it reads, `PublishPlan`, are today private to
`PublishDialogBody.tsx` (the function takes `plan` alone), so no test and no second surface can
reach them. Both move to `components/builder/publishOutcome.ts` as exports, with the three
strings they hold unchanged, and the dialog imports them:

```ts
// components/builder/publishOutcome.ts
export type PublishPlan = NextPublishAction | "unknown";
export function publishPlanCopy(
	plan: PublishPlan,
	context: { readonly broughtInElsewhere: boolean },
): string;
```

It gains two arms:

| Plan | Today | From step 6 |
|---|---|---|
| `creates-beside` (part 10) | no such plan | `PUBLISH_PLAN_CREATES_BESIDE` |
| `creates`, where some other record of this app has a live `app` mapping whose `ownership` is `adopted` | "This creates a new app in this project space." | **D7**: Publishing to another project space makes a new app there. A copy your team already keeps there stays as it is. |

The second arm is the review's V21c said again at the moment it matters: a person reads the review
once, before the app exists, and meets this line when they are about to publish to another project
space. `publishingSectionModel.ts::broughtInElsewhere(records, target)` decides it from the
records the dialog already holds, and the dialog passes its answer as `context.broughtInElsewhere`.
`publishPlanCopy("creates", { broughtInElsewhere: true })` is D7, and every other plan ignores the
context.

Where the dialog was opened with a discard from part 15's panel, the plan line is followed by part
15's line (its section 9.6, "The card's publish-over line") and the footer button reads "Publish
over these changes".

### 11.3 The drift stop

Part 10 gives every sentence its origin (`hqChangedMessage`, `baselineUnknownSentence`,
`hqChangesConfirmedDetail`, `hqChangesNoneDetail`, `webAppsChangeMessage`) and moves
`PublishDialogBody.tsx` to them, with the reader's own date (its section 9). Two strings of that
dialog are named here, and they are two controls today: "Publish over this" is the unticked checkbox
on each change (`PublishDialogBody.tsx::RemoteChangeChoice`), and "Publish over these changes" is
the label the footer's primary button takes while the publish holds changes to confirm. This part
changes neither.

Where a publish stops on `hq_changed` and the changes hold the app's own (`kind: "app"`), whatever
the app's origin, the app's item inside `RemoteChangeChoice` is drawn one of two ways, by
`canBringIn` on that change (part 15, `15-changes-made-in-commcare-hq.md`, section 9.2):

- **`canBringIn` true.** The item shows part 15's `HqChangesPanel` and nothing else: its loading
  row, then one of its states (its section 9.3). The item's own list of parts, its "Publish over
  this" tick and the stop block below are not drawn while the panel shows its loading row or its
  states S1 to S3, because the panel's choices are those controls (its section 9.4). Part 15 owns
  every word of the panel and the headline over it.
- **`canBringIn` false, and under the panel's S4 and its stops.** The item is drawn with its list
  of changes and their "Publish over this" ticks, and under them:
  - for a member who may delete: the heading **D8**, the button `STOP_PUBLISHING_ACTION` and
    `STOP_PUBLISHING_HELPER`. It opens the confirmation of 11.1. On success the dialog drops the
    refusal and every tick, returns to its destination step with the `role="status"` line **D9**,
    and its plan line for that project space reads `PUBLISH_PLAN_CREATES_BESIDE`;
  - for an editor: the one line **D8b**, so the way is known to exist and who can take it.

  Where `canBringIn` is false, part 15 adds one line under the item's parts, its U1 (its sections
  9.4 and 9.5).

The panel's own "Stop publishing here" (its S2) is this section's button, with the same
confirmation and the same `onStopped`, and an editor reads D8b in its place. Changes to lookup
tables and places in the same refusal keep their items and their ticks whichever way the app's item
is drawn (part 11).

The ways on are then four, and none is chosen for the person: bring the changes in, publish over
them, stop publishing here, or close the dialog and decide later. Which of them the dialog shows
on one screen is the panel's state to say (part 15, section 9.3): where bringing the changes in
removes nothing from Nova (its S1), the panel offers the first two, and "Stop publishing here"
stays on the project space's card (11.1).

### 11.4 Restoring an app whose HQ app another Nova app has since taken

Part 10 (5.4) makes `restoreApp` answer the project spaces it stopped publishing to. In
`app/(app)/(site)/app-list-body.tsx`, after a restore that succeeds with `stoppedPublishing` not
empty: `showToast("info", D11, restoredStoppedPublishing(spaces), { persistent: true })`, each
project space as "“{domain}”" with its server's label where the app publishes to more than one
server. A restore that met `RestoreClaimsChangedError` arrives as the action's `error`,
`RESTORE_CLAIMS_CHANGED`, in the card's existing error line. The restored app's Publishing section
then shows the ended card of 11.1 with the `claimed-elsewhere` sentence, which names no person.

---

## 12. Components, primitives and state

### 12.1 New components

Every control comes from `@/components/shadcn`; every icon is Tabler through
`@iconify/react/offline`; every color is a `nova-*` token. No component below holds a decision: each
renders `screenOf(model)` or a pure function of its props.

| Component (file under `components/bring-in/` unless a path is given) | Renders | Composes |
|---|---|---|
| `BringInFlow.tsx` | the card's frame (a heading region, a scrolling middle, a footer that does not scroll) and the screen `screenOf` names. It draws the three short screens itself: `failed` (5, 9.1), `refused` (5, 8.10) and `unopened` (9.2) | `useBringIn`; the eight below; `Spinner`, `Button` |
| `BringInPicker.tsx` | section 4 | `Field`, `FieldLabel`, `FieldDescription`, `Select`, `Combobox`, `Input`, `RadioGroup`, `Badge`, `Button`, `Skeleton`, `HqNotConnected`, `BringInStop` |
| `BringInReading.tsx` | sections 5 and 9.1 (one component, two sets of words, each with its `lost` form) | `Spinner`, `Button` |
| `BringInStop.tsx` | section 6.1 | `Button`; `tabler:info-circle`, `tabler:external-link` |
| `BringInAccount.tsx` | section 7 | `Badge`, `Collapsible`, `Button`, `Textarea` |
| `BringInReview.tsx` | section 8's frame, sections 8.2, 8.4, 8.6 to 8.8 | `Field`, `Input`, `Button`, `ReviewRunsOn`, `ReviewTableChoice`, `FirstPublishLines` |
| `ReviewRunsOn.tsx` | section 8.3 | `FieldSet`, `FieldLegend`, `RadioGroup` |
| `ReviewTableChoice.tsx` | section 8.5, one table | `FieldSet`, `FieldLegend`, `RadioGroup`, `Button` |
| `FirstPublishLines.tsx` | section 8.8's six steps over one view. Props: `{ readonly view: FirstPublishView; readonly surface: "review" \| "publish" }`. It calls part 09's `firstPublishLines(view, surface)` and holds no sentence and no rule. It types the value as `ReturnType<typeof firstPublishLines>`, since part 09's type for it shares the component's name. Used by the review and the Publish dialog | none |
| `components/chat/StartFromScratch.tsx` (changed) | the second entry (2) | `Button` |
| `components/builder/HqNotConnected.tsx` | section 4.4 | `Button`; `tabler:info-circle`, `tabler:refresh`, `tabler:external-link` |
| `components/builder/StopPublishingDialog.tsx` | the confirmation of 11.1, shared by the card and the drift stop; its props are in 11.1 | `AlertDialog`, `Button` |
| `components/builder/HqChangesPanel.tsx` (part 15, section 9.3) | every state of the panel, over `hqChangesPanelModel.ts` | `Button`, `Spinner`, `BringInAccount` (its S4), `BringInStop` (its 9.5), `ReviewTableChoice` (its 5.3), `StopPublishingDialog` (its S2) |
| `components/builder/HqChangesDialog.tsx` (part 15, section 9.1) | the panel in a `Dialog` titled "Changes in CommCare HQ", for the card and the header's button | `Dialog`, `HqChangesPanel` |
| `components/builder/HqChangesCheck.tsx` (part 15, section 8) | nothing | none |

`BringInFlow` takes the three members of `useBringIn`'s input as its props (`seed`,
`landCreatedAppReceipt`, `projectToast`; 3.3) and calls the hook itself, so the hook's state lives
exactly as long as the flow is mounted.

Changed, not new: `components/chat/ChatSidebar.tsx` (the `takeover` prop),
`components/chat/ChatContainer.tsx` (mounts `BringInFlow` as `takeover`, handing it the seed, its
`landCreatedAppReceipt` and its `projectToast`), `components/builder/BuilderLayout.tsx` (passes
`BringInSeed` down; shows the `leaving` toast of 9.2),
`components/builder/CommCareConnectionContext.tsx` (`refresh`, `isRefreshing`, `refreshFailed`; 4.4),
`components/builder/PublishPanel.tsx` (the context's refresh in place of its router transition),
`components/builder/DeploymentStatus.tsx` (section 11.1, with the prop `canStop`, and part 15's C1
and C2) and `PublishDialogBody.tsx` (sections 4.4, 11.2 and 11.3, and the panel of 11.3),
`components/builder/app-setup/PublishingSection.tsx` (passes `canStop`),
`components/builder/publishOutcome.ts` (`PublishPlan`, `publishPlanCopy`),
`components/builder/BuilderProvider.tsx` (mounts `HqChangesCheck`),
`components/builder/BuilderHeader.tsx` (part 15's C3, beside `AppNoticeChip`),
`app/(app)/(site)/app-list.tsx`, `page.tsx` and `app-list-body.tsx` (sections 2, 10 and 11.4).
`components/builder/PublishDialog.tsx` is not changed: it forwards `PublishDialogProps` whole to the
body, and the one member that type gains is declared in `PublishDialogBody.tsx` (4.4). The three
`HqChanges` components, `BuilderProvider.tsx` and `BuilderHeader.tsx` are placed here and listed in
part 15's "Files", not in this part's.

### 12.2 One new primitive: the radio group

`components/shadcn` has no radio group, and three screens here choose exactly one of a few full-width
rows with a line each (the app, where it runs, a table's answer). `components/CLAUDE.md` forbids
hand-rolling one and says how a missing primitive lands: "`npx shadcn add <name>` and then gets the
Nova pass". This part adds `components/shadcn/radio-group.tsx` (`RadioGroup`, `RadioGroupItem`, on Base
UI's radio) with that pass:

- each item is a row wearing `lib/styles.ts::selectableRowCls`, the shared skin of "a control that
  holds a SELECTED state", so a chosen row has the violet tint and the hairline drawn inside and still
  answers hover one step toward light;
- the row is the 44px floor and grows for a second and third line, with the label and its lines the
  item's content (`overflow-wrap: anywhere`, never truncated: "do not silently truncate distinct
  choices into the same-looking label");
- focus is `.nova-focusable-inset`, since the rows sit in a scrolling middle;
- an item that cannot be chosen is `aria-disabled`, keeps pointer events and `cursor-not-allowed`,
  stays reachable by arrow keys, and its reason is its description (`aria-describedby`);
- no icon ships with it but the selected mark, a filled `tabler:circle-dot` beside an empty
  `tabler:circle`, so selection is never tint alone.

```ts
// components/shadcn/radio-group.tsx (new; the one file that names Base UI's radio)
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

/** The group: the primitive's own props (`value`, `defaultValue`, `onValueChange`, `aria-*`). */
export function RadioGroup(props: RadioGroupPrimitive.Props): ReactElement;

/** One row. `children` is the label. */
export function RadioGroupItem(
	props: Omit<RadioPrimitive.Root.Props, "disabled"> & {
		/** The lines under the label, part of the row and of its accessible description. */
		readonly description?: ReactNode;
		/**
		 * Why this row cannot be chosen. Given, the row is `aria-disabled`, a press changes nothing,
		 * and this text is drawn under the row and joined to its description.
		 */
		readonly unavailableReason?: ReactNode;
	},
): ReactElement;
```

`disabled` is left off the item's props on purpose: the fourth rule above is that a row that cannot
be chosen stays reachable and says why, which `unavailableReason` gives and a disabled control does
not. `ReactElement` and `ReactNode` are React's types.

`AppPlatformsSection.tsx` keeps its own segment buttons: its choice commits a change to a saved app
and has a check in flight, which a radio group does not model. Only its three lines move (8.3).

### 12.3 State

- **The URL** owns which screen and which app (`bringInLocation`), as it owns where a person is in
  the builder.
- **The model** (`bringInModel.ts`) owns everything else, in `useBringIn`'s reducer. It is component
  state of `ChatContainer`'s subtree and is gone when the flow unmounts. Nothing on a server stands
  behind it: an app's address reads the app again.
- **Nothing goes in the session store or the doc store.** The session store is "ephemeral run/UI
  lifecycle" of a builder with an app, and there is no app until the landing, which is
  `installCreatedApp`'s to write.
- **Two keys live in the tab's session storage**, each written and removed by the hook, each read
  once: `nova:bring-in-create`, which lets a reload send a create again (9.1), and
  `nova:brought-in`, which carries the landing toast across the one landing that loads a page
  (9.2). A browser that refuses storage costs those two conveniences and nothing else.
- **The home list** is section 10's: the flow marks nothing stale, because the landing already
  does.
- **The Publishing card** reads `DeploymentView` through `usePublishingRecords`, whose one store per
  app both the section and the dialog share; a stop upserts it and bumps
  `deploymentRecordsRevision`, as a publish does.
- **One field of the builder session** is part 15's: `hqChangedTargets`, the project spaces its
  check found changed. It has no pending value, and nothing reads it but the header's button (part
  15, section 8). `requestPublishDialog` takes an optional `discard`, which the publish dialog puts
  in the discards it sends (part 15, section 9.3).

### 12.4 How e2e controls CommCare HQ

Nova's Playwright suite never talks to a CommCare HQ, real or fake. `lib/commcare/servers.ts` is a
closed set of three hosts and "the SSRF boundary for every outbound HQ request", and no test seam
widens it. Two things exist instead, and this part uses both:

- **Browser component tests** (`e2e/tests/browser/`, with `e2e/lib/componentPeer.ts`) mount a real
  component against production CSS and answer Nova's own routes from `page.route`, as
  `publishing.spec.ts` answers `**/api/commcare/upload`. They start no Nova server and no Postgres.
- **App journeys** (`e2e/tests/app/`) run the production standalone server over a local Postgres
  seeded per test by a typed `@seed:` profile, with any route that would reach CommCare HQ answered
  from `page.route`. A profile is a name in `e2e/lib/smokeProfiles.ts::SMOKE_PROFILES` and a
  builder under that name in `e2e/lib/smokeSeedFactory.ts`; `e2e/seed.ts` only runs what those two
  register.

The server side of every read is held where it belongs: part 05's readers against retained answers
(`proof/hq-reads/reading/`, undici's `MockAgent`), and part 12's two requests in real-Postgres tests. The
specs here prove the screens and the landing. They are listed under "Tests".

---

## 13. Accessibility; empty, error and loading states

**The frame.** The card is a `section` labelled by its heading. Each screen's heading is the one `h1`
of the centred column and takes focus when the screen appears, through
`lib/ui/hooks/useDeferredFocus`, so "a delayed focus move yields when the person has already chosen
another control". The middle scrolls and the footer does not, at every width: under 560px the footer's
buttons stack, each at its one 44px height, primary first. Every control is reachable in reading
order by Tab, radio groups by arrow keys, and Escape does nothing here (there is nothing to dismiss;
the picker's Cancel is a button). Entrances fade and rise on the shared ease; under
`prefers-reduced-motion` the global near-zero rule applies and no lifecycle depends on an animation
ending.

**Announcements.** One `role="status"` region per screen carries progress (the stage's label, a
create's lead, "Copied"). `role="alert"` is used for exactly three things: a refusal's sentence,
the line that says which choice is missing, and a request that was lost twice and now waits for the
person (the lines of the Error column below). The one silent retry (**W5**) is progress and rides
the status region. A stop is not an alert, and neither is the `failed` screen: each is the screen's
heading, which takes focus. No state is told by color alone: every badge is a word, every rung of
the card states its condition in text, and amber is used only where the design system gives it
meaning (a stop, recovering, something to change in CommCare HQ, a failure Nova owns).

**Links that leave Nova** (each "Open in CommCare HQ", "Open Settings") open a new tab, carry
`tabler:external-link` and a visually hidden "opens in a new tab".

| Screen | Loading | Empty | Error |
|---|---|---|---|
| Picker, connection | `HqNotConnected`'s button reads "Checking connection" with `aria-busy` while the context's `isRefreshing` is true | no connection: the aside of 4.4 | the context's `refreshFailed`: **K22** under the aside's buttons with `role="alert"`, the button offered again. The Publish dialog shows the same line |
| Picker, Project | none: the seed is in the page | no Project to add to: part 12's `no_project_access` sentence and **Go to your apps** | none |
| Picker, apps | three `Skeleton` rows of the row's height and the status **K9**; while no app is chosen the footer's primary is `aria-disabled` with **K18** ("You can read an app once you've chosen one") as its description | **K10**; with a filter that matches nothing, **K12** | a stop: its block (4.5). `picker.apps` of `failed`: **K20** with **Try again**, which dispatches `picker-reload` |
| Reading | the screen is the loading state (5) | none | one silent retry shown as **W5**, then `lost`: **W6** with **Try again**, which dispatches `retry`. A `failed` line: the `failed` screen. A refusal before the stream: the `refused` screen |
| Stop | none | none | none of its own: Check again shows the reading screen, and what can go wrong there is the Reading row's |
| Account | none | a read answers an account only where it met a finding (part 12, 3.3); `accountGroups` of an empty list renders the lead and the footer alone, and logs `[bring-in] account with no findings` at error | clipboard refused: the text in a `Textarea` with **A10** |
| Review | none | a section whose data is absent is not rendered (8.1) | section 8.10, row by row |
| Creating (`creating`) | the screen is the loading state (9.1) | none | one silent retry shown as **W5**, then `lost`: **X4** with **Try again**, which dispatches `retry` and posts the same create. A `failed` line: the `failed` screen |
| Failed (`failed`) | none | none | the screen is the error state (5, 9.1): part 12's `READING_FAILED_COPY` for the operation, **Try again**, **Go to your apps** |
| Refused (`refused`) | none | none | the screen is the error state (5, 8.10): the refusal's sentence and its two actions |
| Created, not opened (`unopened`) | none | none | the screen is the error state (9.2): part 12's `UNVERIFIED_LANDING_TITLE`, **Open your app**, **Go to your apps** |
| Publishing card | as today | as today | a stop that failed: the error's sentence or **D10**, in the dialog |

---

## 14. MCP

### 14.1 What is registered, and who is given it

Eight tools, in `lib/mcp/server.ts::registerNovaTools`, after `registerGetHqConnection`. Six are
this part's. The last two are part 15's: their inputs, answers and descriptions are its section 10
and are not repeated here.

| Tool | File (`lib/mcp/tools/`) | Scope | Calls |
|---|---|---|---|
| `list_hq_apps` | `listHqApps.ts` | `nova.hq.read` | `listHqAppsForPicker` (4.2) |
| `read_hq_app` | `readHqApp.ts` | `nova.hq.read` | `readHqAppForReview` (part 12, section 3) |
| `bring_in_hq_app` | `bringInHqApp.ts` | `nova.hq.write` | `createFromReview` (part 12, 5.3) |
| `stop_publishing` | `stopPublishing.ts` | `nova.hq.write` | `stopPublishing` (part 10, 8.3) |
| `refresh_managed_data` | `managedData.ts` | `nova.hq.write` | `refreshManagedLookupTable`, `refreshManagedPlaces` (part 11, 12.4) |
| `set_lookup_table_management` | `managedData.ts` | `nova.hq.write` | `manageLookupTableInNova`, `letHqManageLookupTable` (part 11, 12.4) |
| `read_hq_changes` | `readHqChanges.ts` | `nova.hq.read` | `reviewHqChanges` (part 15, section 9.2) |
| `bring_in_hq_changes` | `bringInHqChanges.ts` | `nova.hq.write` | `bringInHqChanges` (part 15, section 9.2) |

Each declares `scopeChallenge: oauthScopeChallenge(ctx, <scope>)` and calls `assertScope(ctx, <scope>,
"<tool>")` as its first statement, before any read, "so a missing-scope credential can't probe
whether a record exists" (`lib/mcp/scopes.ts`). The scopes are part 05's (its section 13):
`read_hq_app` writes nothing, in Nova or in CommCare HQ, and `bring_in_hq_app` records a deployment
that authorizes later writes to that HQ app.

**The Solutions Architect is given none of the eight**, and none enters `SHARED_TOOL_REGISTRY`. The
standing reason is `deploymentTools.ts`'s own: "A deployment is not authored vocabulary: it is durable
state about somebody else's server, and an agent designing an app has no business reasoning about
it." Bringing an app in also needs answers only a person gives (a Project, where it runs, what happens
to a table other apps read), and the chat's agent works inside one app that already exists. So no
`scripts/test-schema.ts` entry is added for them: "A tool only MCP serves needs no entry" (root
`CLAUDE.md`).

**One call is one whole read, or one whole create.** `read_hq_app` and `bring_in_hq_app` call the
two functions the browser's routes call, after the same authorization (`authorizeBringIn`), and
hand them what part 12 gives a tool call (its 4.4): no deadline of Nova's own; the call's own
cancellation signal for a read, and none for a create, which runs to its end once asked; and
progress notifications for each stage and for the file counts, through the one event sink the
routes use (`readingProgressSink`). So nothing here continues a call or resumes one. Checking again
is calling `read_hq_app` again. Nothing is kept between the two tools: the client holds the
`reading_id` and the `review_digest` a read returned, as it holds any tool result, and sends both
back to `bring_in_hq_app`. A repeated `bring_in_hq_app` with the same arguments answers the same
app (part 12, 6.6).

Which clients keep a call open while progress arrives is theirs to decide, so each description
says what is true for one that stops waiting (14.3, 14.4).

### 14.2 `list_hq_apps`

Description: "List the apps in one CommCare HQ project space that can be brought in to Nova. Call
`get_hq_connection` first and pass the exact `domain` the user chose; never choose a project space for
them. Each app has its `hq_app_id` and `name`. `in_nova` is null where the app is free to bring in.
Otherwise it says a Nova app already manages it, since one CommCare HQ app is managed by one Nova app:
`open` with the Nova `app_id` where the user can open it, or `elsewhere` with `next`, a sentence that
says who to ask and the two ways forward. Relay `next` as written. Reads CommCare HQ with the
user's own key and changes nothing."

```ts
inputSchema: z.strictObject({
	domain: z.string().trim().min(1).describe(
		"Exact CommCare HQ project space the user chose. One of get_hq_connection's available_domains."),
})
```

Result:

```ts
{
	server: "production" | "india" | "eu";
	server_url: string;
	domain: string;
	apps: {
		hq_app_id: string;
		name: string;
		in_nova:
			| null
			| { kind: "open"; app_id: string; app_name: string }
			| { kind: "elsewhere"; at: string;
			    contact: { role: "person" | "owners"; names: string[] }; next: string };
	}[];
}
```

`next` is part 01's `alreadyInNovaNext(claim, formatDate)` with `formatDate` the UTC day, and `at`
is ISO text. Errors: `not-connected` is the existing `hq_not_configured` with **M5**; every stop
whose code is `key-cannot-reach-space` or `not-a-member` is the existing `domain_not_authorized`;
every other stop is `hq_read_stopped` (14.8).

Two stops share that tag, because a client acts on them the same way: the stored key does not list
the project space (`key-cannot-reach-space`), and CommCare HQ turned the account away
(`not-a-member`). The message differs, because what is true differs. For `key-cannot-reach-space`
it is the sentence `check_project_space_compatibility` already uses, built from the user's stored
project spaces (`getCommCareSettings`): "Your stored CommCare HQ API key can't reach the “{domain}”
project space. It reaches: {reachable}. Pass one of those as `domain`, or update your key in
Settings." For `not-a-member` it is the block's body. Each carries its `circumstance`, `title` and
`next`.

### 14.3 `read_hq_app`

Description: "Read one CommCare HQ app so it can be brought in to Nova, and say whether it can be.
Nothing is created, nothing is kept and nothing changes in CommCare HQ. Send `project_id`, `domain`
and `hq_app_id`: where the user can edit more than one Nova Project, ask which one the app should be
added to and never choose it for them, because an app that reads lookup tables stays in the Project
it is added to; where they can edit one, tell them which it is. One call is one whole read. `state`
is one of: `review`, with `reading_id` and `review` (what will be created; `runs_on`, the ways the
app can run, each with `first_publish`, what the first upload from Nova changes in CommCare HQ under
that choice; what stays in CommCare HQ; and `review.review_digest`); `account`, with
`account.findings`, each thing Nova cannot hold, where it is, and whether it is Nova's to build,
something Nova does not bring in, or something to change in CommCare HQ; or `stop`, with `stop`,
something that ended the read such as a permission, a plan without API access, or an app already in
Nova. Relay titles, sentences and next steps as written, and do not summarize an account as a
failure: it is everything Nova found on this read, and `check_again` says a later read may find
more. For a `first_publish`, relay `workers.lines` first, then `hq_only.lines`, each `sentence` as
written, then `reassurance` where it is not null, then `note`. To check again after a change in
CommCare HQ or a Nova update, call this tool again. An account longer than one answer is paged: pass
`page` with the `next_page` it gave. Each page reads the app again, and where the app changed since
the last page the answer starts over with `restarted` true. An app with many pictures and sounds can
take a few minutes, and Nova reports progress while it works. If your client stops waiting before
the answer comes, the app can be read in Nova in a browser."

```ts
inputSchema: z.strictObject({
	project_id: z.string().min(1).max(255).describe(
		"The Nova Project the user chose to add the app to."),
	domain: z.string().trim().min(1).describe(
		"The exact CommCare HQ project space the app is in."),
	hq_app_id: z.string().regex(/^[\w-]{1,255}$/).describe(
		"The app's hq_app_id from list_hq_apps."),
	page: z.string().regex(/^\d{1,5}:[0-9a-f]{64}$/).optional().describe(
		"For an account longer than one answer: the next_page of the previous answer."),
})
```

The handler resolves the server from the user's connection (`getCommCareSettings`; none is
`hq_not_configured` with **M6**), holds `domain` to `lib/commcare/client.ts::isValidDomainSlug`
(`invalid_input` otherwise, with part 12's sentence), authorizes, and calls `readHqAppForReview`
with the call's progress sink and its cancellation signal (14.1). A refusal of part 12 maps as
14.8 says.

Result, built by `lib/mcp/tools/readingProjection.ts` (new):

```ts
// lib/mcp/tools/readingProjection.ts
/** One read's answer as an MCP client reads it: the object below. */
export function describeReading(
	answer: ReadingAnswer,
	key: ReadingKey,
	options: {
		/** The first finding of the page: 0 unless the call sent a `page` that still stands. */
		readonly from: number;
		/** True where the call sent a `page` and the app is no longer what that page was cut from. */
		readonly restarted: boolean;
	},
): ReadingProjection;
/** The cursor's two halves, or null for text the schema let through and no account could give. */
export function parseAccountPage(page: string): { readonly from: number; readonly digest: string } | null;
/** `canonicalJsonDigest` of an account's whole listed content: its `findings` and its `more`. */
export function accountDigest(answer: Extract<ReadingAnswer, { readonly kind: "account" }>): string;
/** The tool error of 14.8 for one refusal of part 12. */
export function mapReadingRefusal(refusal: ReadingRefusal, projectId: string): BringInToolError;

export interface ReadingProjection {
	project_id: string;
	server: "production" | "india" | "eu";
	domain: string;
	hq_app_id: string;
	/** CommCare HQ's name for the app, where the read learned it. */
	hq_app_name: string | null;
	state: "review" | "account" | "stop";
	/** True where the call sent `page` and Nova answered the fresh read from its start. */
	restarted: boolean;
	/** M7 where `restarted` is true, else null. */
	message: string | null;
	/** With `review`: sent back to bring_in_hq_app, beside review.review_digest. */
	reading_id?: string;
	/** circumstanceBlock(finding, context): the three strings the stop screen shows (6.1). */
	stop?: { code: string; title: string; body: string; next: string };
	account?: {
		/** The answer's counts, over every finding the read met (7.1). */
		counts: { not_yet: number; never: number; fix_in_hq: number };
		/** FINDING_LABELS and FINDING_NEXT_STEPS for each standing the account holds. */
		labels: { standing: "not-yet" | "never" | "fix-in-hq"; label: string; next: string }[];
		findings: {
			code: string;
			standing: "not-yet" | "never" | "fix-in-hq";
			/** placeLine(place). */
			place: string;
			/** lib/deployment's hqPlaceUrl for the app and this place, for the user to open. */
			hq_url: string | null;
			/** findingLine's sentence for a manifest finding; a circumstance's body. */
			sentence: string;
			/** findingLine(finding).named: the name as CommCare HQ shows it, or null. */
			named: string | null;
			/** A circumstance's own title and next step, from circumstanceBlock (7.2). */
			title?: string;
			next?: string;
		}[];
		/** How many findings the account lists, over every page. */
		total: number;
		/** The cursor of the next page, or null on the last. */
		next_page: string | null;
		/** ACCOUNT_CHECK_AGAIN_LINE (part 01, 9.1): a later read may find more. On every page. */
		check_again: string;
		/** moreFindingsLine, where the read met more findings than it lists. */
		more: string | null;
		media_checked: boolean;
		/** Part 11's line R12 where media_checked is false. */
		note: string | null;
	};
	review?: {
		review_digest: string;
		app_name: string;
		read_at: string;
		creates: { menus: number; forms: number; questions: number; case_types: string[];
		           languages: number; media_files: number };
		runs_on: {
			runs_only_on: "web-apps" | "android" | null;
			split_datetime: boolean;
			preselected: boolean;
			label: string;
			line: string;
			split_line: string | null;
			/** Labels of the plan features Nova records as already in use under this choice. */
			recorded_features: string[];
			/**
			 * What the first upload from Nova changes in CommCare HQ under this choice: part 09's
			 * firstPublishLines(choice.firstPublish, "review"), with its keys in snake case.
			 */
			first_publish: {
				heading: string;
				lead: string;
				workers: { label: string; lines: { id: string; sentence: string }[] };
				hq_only: { label: string; lines: { id: string; sentence: string }[] };
				reassurance: string | null;
				note: string;
			};
		}[];
		/** Why Nova proposes the preselected choice, what the first upload will ask, and V14. */
		runs_on_notes: string[];
		/** Each platform no choice runs on: V13's lead, its feature labels, and its files' sentence. */
		cannot_run: { platform: "web-apps" | "android"; sentence: string; features: string[];
		              files: string | null }[];
		kept: { lead: string; labels: string[]; note: string };
		tables: {
			tag: string;
			standing: "new" | "same-managed" | "same-equal" | "choice";
			/** R1 or R2's sentence for a table that asks nothing. */
			sentence: string | null;
			choice: null | {
				title: string;
				body: string;
				answers: {
					answer: "use-commcare-hq" | "use-project";
					offered: boolean;
					label: string;
					lines: string[];
					/**
					 * R10's sentence where the answer is not offered, for its `why`: needs-admin,
					 * managed-elsewhere, app-reads-a-missing-column or fails-a-project-space-rule.
					 */
					reason: string | null;
				}[];
			};
		}[];
		places: { count: number; sentence: string } | null;
		media: { sentence: string | null; left_out: string | null };
		after: string[];
	};
}
```

`creates.languages` is a count, the length of the review's list of codes, as the screen shows it
(8.2).

**The first-publish list is on each `runs_on` entry, and the review holds none of its own.** Part 09
gives one object, `first_publish`: its `firstPublishLines` value with the keys in snake case
(`heading`, `lead`, `workers: { label, lines: [{ id, sentence }] }`, `hq_only` likewise,
`reassurance`, `note`; its 12.2). Its own 12.1 makes the list a fact of a choice, so the object
sits on the choice, built with the surface `review`: an agent that shows the user three ways the
app can run shows, with each, what choosing it changes, and cannot relay the preselected row's list
for a row the user did not take (Departure 14, which part 09's 12.2 states the same way). The
key names, the line shape and the order are part 09's, unchanged, and no `touches_workers` key is
served: `workers.lines` is empty exactly where `reassurance` is not null. A list can hold fewer
lines than its view has ids (part 09, 12.2), and a line's `id` is the one whose sentence it shows.

**A circumstance reads the same on every surface.** `stop`, a circumstance finding's `title` and
`next`, the `stop` of a `held` create (14.4) and the `title` and `next` of an `hq_read_stopped`
error (14.8) all come from `circumstanceBlock(finding, context)` (part 01, 8.4), the function the
stop screen and the account call, with `formatDate` the UTC day and `app` the name where the read
gave one. So `already-in-nova` and a refused date and time split read the same over MCP as on
screen.

Every sentence is the one the screen shows, from the same exports (`lib/publish/hqFindingCopy.ts`,
`hqReadingCopy.ts`, `managedData.ts`, `keptValues.ts`, part 09's `firstPublishCopy.ts` and this
part's `bringInCopy.ts`), with dates as ISO text or the UTC day.

**A long account, one page at a time.** `describeReading` takes findings from `from` until the JSON
of the whole result would pass 80,000 characters, which is under
`lib/mcp/resultSize.ts::MAX_RESULT_SIZE_CHARS`, and the tool registers `LARGE_RESULT_META`. Nothing
is kept between calls, so each page is a fresh read, and two pages could come from two versions of
the app. One opaque cursor closes that. `next_page` is the text `<index>:<digest>`: the first
finding the next page holds, and `accountDigest` of the account the page was cut from. The client
sends it back as `page`, alone beside the three key fields, so no rule pairs two fields. Where the
fresh read is an account with that digest, the answer is its page from `<index>`. Where it is no
longer an account, or its account has another digest, the tool answers the fresh read from its
start with `restarted: true` and **M7** as `message`, so a client never stitches two versions of
an app into one list.

### 14.4 `bring_in_hq_app`

Description: "Create a Nova app from a CommCare HQ app that `read_hq_app` answered a review for.
Call it only after the user has seen the review and answered it. Every answer is theirs: never
choose the name, where the app runs, the date-and-time split or a lookup table's answer for them,
and never default to the preselected choice without saying so and hearing yes. Send the
`project_id`, `domain` and `hq_app_id` the read was given, the `reading_id` it returned, and
`review_digest`, the review they answered. `runs_only_on` and `split_datetime` together must be one
of `review.runs_on`. `table_choices` holds one answer for each table whose review entry has a
`choice`, by tag, and `{}` where none has. The result's `status` is `created` (the app exists, in
that Project, and publishes back to the CommCare HQ app it came from); `changed` (something changed
in CommCare HQ or the Project since the review, no app was created, and `reading` holds what stands
now, to show the user again); `read_again` (a lookup table the app reads changed in the Project
while Nova was creating the app, and no app was created: call `read_hq_app` again and show the user
the new review); `check_failed` (one of Nova's own checks stopped the create, no app was created,
and `reading` holds what Nova reported); or `held` (no app was created and `stop` says why, such as
a key CommCare HQ turned down). Creating changes nothing in CommCare HQ. If this call ends before
you get an answer, call it again with the same arguments. It answers the app if it was created, and
creates it if it was not. Before the first `upload_app_to_hq`, relay `first_publish`, from the
chosen `review.runs_on` entry or from `check_project_space_compatibility`: `workers.lines` first,
then `hq_only.lines`, each `sentence` as written, then `reassurance` where it is not null, then
`note`."

```ts
inputSchema: z.strictObject({
	project_id: z.string().min(1).max(255).describe(
		"The Nova Project the app is added to: the project_id read_hq_app was given."),
	domain: z.string().trim().min(1).describe(
		"The CommCare HQ project space: the domain read_hq_app was given."),
	hq_app_id: z.string().regex(/^[\w-]{1,255}$/).describe(
		"The app: the hq_app_id read_hq_app was given."),
	reading_id: z.string().regex(READING_ID_PATTERN).describe(
		"The reading_id read_hq_app returned with the review."),
	review_digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
		"review.review_digest of the review the user answered."),
	app_name: z.string().trim().min(1).max(255).describe(
		"The app's name in Nova. review.app_name is CommCare HQ's; ask the user whether to keep it."),
	runs_only_on: z.enum(["web-apps", "android"]).nullable().describe(
		"Where the app runs: null for Web Apps and Android, or one platform. The user's choice among review.runs_on."),
	split_datetime: z.boolean().describe(
		"Whether date and time questions are asked as a date and a time. Must match the chosen review.runs_on entry."),
	table_choices: z.record(z.string(), z.enum(["use-commcare-hq", "use-project"])).describe(
		"The user's answer for each lookup table whose review entry has a choice, by tag. {} where none has."),
})
```

No field is optional and none has a default: that is how "never chooses for the person" is held by
the schema and not only by a description. The Project, the project space and the app are arguments
because nothing is stored for a `reading_id` to stand for: the create reads the app again from
these three and proves by the digest that it is what the user reviewed (part 12, 5.3; Departure
1). `READING_ID_PATTERN` is part 12's (`lib/deployment/reading/types.ts`). The handler resolves the
server as 14.3 does, maps the fields to part 12's `BringInInput`, authorizes, and calls
`createFromReview` with the call's progress sink and no cancellation signal (14.1). A pair that is
none of `review.runs_on`, and an answer the review did not offer, are part 12's
`choice_not_offered`; a tag left unanswered is its `choice_missing`. Why an answer is not offered
is already in the review the agent showed: that answer's `reason` (14.3), R10's sentence for
`needs-admin`, `managed-elsewhere`, `app-reads-a-missing-column` or `fails-a-project-space-rule`,
the same four the screen draws (8.5). Each refusal is a tool error with part 12's sentence (14.8);
the agent reads the review again with `read_hq_app` and relays that answer's `reason`.

Result, by part 12's `CreateAnswer`:

```ts
| { status: "created"; app_id: string; project_id: string; app_name: string; url: string;
    brought_in_from: { server: "production" | "india" | "eu"; domain: string; hq_app_id: string };
    message: string }
| { status: "changed"; message: string; reading: ReadingProjection }
| { status: "read_again"; message: string }
| { status: "check_failed"; message: string; reading: ReadingProjection }
/** `stop` is circumstanceBlock's three strings, as in 14.3. */
| { status: "held"; message: string; stop: { code: string; title: string; body: string; next: string } }
```

`changed`'s `reading` is `describeReading(now, key, { from: 0, restarted: false })`, and
`check_failed`'s is the same over `accountOfOne(finding, appName)` (3.3), the account of the one
finding. `message` is **M1** for `created` and, for the other four, the sentence of part 12's
`CREATE_ANSWER_LEADS` the screen sets above the same answer (8.10): for `changed`, the one for what
`now` is.

`url` is the app's page on the main host: `` `${AS_ORIGIN}/build/${appId}` ``, with
`lib/hostnames.ts::AS_ORIGIN`, the main host's origin in production and the dev origin locally. No
MCP tool returns a builder address today (`get_app` returns none), so this is the first, built in
`bringInHqApp.ts` alone. The receipt's blueprint is not returned: `get_app` reads the app. A
`refused` answer is a tool error (14.8).

### 14.5 `stop_publishing`

Input and scope are part 10's (its 8.3): `z.strictObject({ app_id:
deploymentTargetSchema.shape.appId, server: deploymentServerSchema, domain:
deploymentTargetSchema.shape.domain })`, each described as `refresh_deployment` describes it. It is
`strictObject` and not the `z.object` `refresh_deployment` uses, because the SDK converts a tool's
input schema with `io` `"input"` (`@modelcontextprotocol/server`, `standardSchemaToJsonSchema(
tool.inputSchema, "input")`), and Zod's object processor writes `additionalProperties: false` for a
plain object only on the output side (`zod/v4/core/json-schema-processors.js`: a `never` catchall
always, a regular object "if (ctx.io === "output")"). A plain object would be served open, and
14.9's test holds all six tools closed. Description: "Stop publishing an app to one CommCare HQ project
space. The app in CommCare HQ stays exactly as it is, this Nova app stops publishing to it, and it can
be brought in to Nova again as a new app. A later upload to that project space makes a new app there,
beside the one that stays. Nothing is sent to CommCare HQ. Only an admin or owner of the app's Project
can do this; anyone else gets `permission_denied` with who can. This cannot be undone from Nova, so
call it only when the user asked for exactly this, after telling them what it does." The result is
`{ app_id, ...describeDeployment(deployment, identities), setup_artifact }`, as `refresh_deployment`
returns. `not_permitted` arrives as `permission_denied` with part 10's sentence (its 8.3).

### 14.6 `refresh_managed_data` and `set_lookup_table_management`

Inputs are part 11's table (its 12.4), each a `z.strictObject` for the reason 14.5 gives:
`refresh_managed_data` takes `{ project_id: string,
table_id?: string, app_id?: string }` with exactly one of the two (checked by the handler,
`invalid_input` with "Send table_id to refresh one lookup table, or app_id to refresh that app's
places. This call sent both or neither."); `set_lookup_table_management` takes `{ project_id: string,
table_id: string, managed_by: "nova" | "commcare-hq", confirmed: boolean }`.

Descriptions:

- `refresh_managed_data`: "Read again a lookup table, or an app's places, that CommCare HQ manages,
  and update Nova's copy. Nova never changes that data in the project space that manages it. Use it
  after the user changed the table or the places in CommCare HQ and wants Preview to show it. The
  result's `message` says what changed, or why the copy was kept as it was."
- `set_lookup_table_management`: "Change who manages a lookup table that came from CommCare HQ. With
  `confirmed: false` this changes nothing: it returns what the change does and the apps that read the
  table. Show the user that answer and ask. Send `confirmed: true` only after they agree.
  `managed_by: \"nova\"` means the table is edited in Nova from then on and each publish replaces it
  in CommCare HQ, and a later change there stops the next publish. `managed_by: \"commcare-hq\"` hands
  it back: Nova takes CommCare HQ's columns and rows and stops changing the table there. Never decide
  this for the user."

Results carry, as `message`, the sentence part 11's `lib/publish/managedData.ts` gives the
outcome (its section 9 for a table, its 11.4 for places), the one a caller with no CommCare HQ
connection is told among them. For `confirmed: false` the dialog's body lines are `lines`, with
`apps`.

### 14.7 Five tools that change

**`check_project_space_compatibility`** gains one key (part 09, 12.2) and one sentence:

```ts
/**
 * Part 09's firstPublishLines(view, "publish") over the list the user reviewed, with its keys in
 * snake case: the object each review.runs_on entry of read_hq_app carries (14.3). Null where
 * firstPublishOf answers null.
 */
first_publish: null | {
	heading: string;
	lead: string;
	workers: { label: string; lines: { id: string; sentence: string }[] };
	hq_only: { label: string; lines: { id: string; sentence: string }[] };
	reassurance: string | null;
	note: string;
};
```

`touches_workers` is not added. The view is the one part 09 keeps on the baseline and shows as
`DeploymentView.firstPublish` (11.2): for the deployment of this app on the checked project space,
non-null while the live app mapping names the app a list was stored for, and null where no list is
stored (an app Nova made, and any app after a push, until part 15 stores a `next-publish` list; its
section 4.4), for an ended deployment and for a project space the app has not reached. The tool
calls `readFirstPublishStates(scope)` and
`firstPublishOf(deployment, states.get(deployment.id), doc.appSettings.runsOnlyOn)` (both part
09's; its 12.3), the function that fills the view for the builder, so the dialog and MCP cannot
answer differently, and returns `firstPublishLines(view, "publish")` with its keys in snake case.
Its description gains, at its end: " `first_publish`, where it is not null, is what this app's next
upload changes in CommCare HQ beyond the user's own edits. Its `lead` says why: the app was brought
in and Nova has not uploaded to it yet, or CommCare HQ's version holds something Nova writes its own
way. Relay each `sentence` of `workers.lines`, then of `hq_only.lines`, then `reassurance` where it
is not null, then `note`, before the upload." This tool is where an agent learns the first-publish
lines of a brought-in app before the fact, since `upload_app_to_hq` has no review step (part 09,
12.2), and where it learns a `next-publish` list (part 15, section 9.4) before the upload that
makes those changes: the same key carries it, with part 15's heading and lead.

**`get_deployment`** and **`refresh_deployment`**: `state` admits `ended` (part 10, 8.1); this part
adds `brought_in` and `ending` and names all three in `get_deployment`'s description.
`deploymentProjection.ts::describeDeployment` gains
`brought_in: { at: string; by: string } | null` (from `broughtInOf`'s rule, server-side) and `ending:
{ at: string; by: string; reason: "stopped" | "claimed-elsewhere"; hq_app_id: string; message: string
} | null` (part 10's `deploymentEnding`, with `endedLine` as `message` and the UTC day).
`get_deployment`'s description changes its state list to "`preflight`, `uploaded`,
`built`, `released`, `runnable`, `incomplete` or `ended`" and gains: " `brought_in` says the app came
from CommCare HQ on that project space, when and by whom. `ending` says Nova stopped publishing
there: the app in CommCare HQ stays, and the next upload makes a new app beside it." Part 15 adds
`nova_revision: number | null` beside `pushed_revision` in the same projection, and the sentence
`refresh_deployment` relays where CommCare HQ's copy changed (its section 10).

**`upload_app_to_hq`**: its description gains: " An app brought in from CommCare HQ updates the app it
came from, keeping every menu's and form's ID there. `hq_changed` then measures changes since the app
was brought in: each change's `since` says which (`published`, `brought-in` with `at`, or
`changes-brought-in`), and a date in a message is the UTC day. `publishing_stopped` means someone
stopped publishing this app to that project space while the upload was getting ready; relay the
`message`, which says whether anything was sent, and do not upload again unless the user wants a new
app there." The `remote_changes` entries gain `since: { kind: "published" } | { kind: "brought-in";
at: string } | { kind: "changes-brought-in" }`: part 10 gives the origin and its instant (its 9.1),
part 15 the third kind (its section 9.3), and the served key is this part's. Each entry also gains
`can_bring_in: boolean`, false for a table and a place (part 15, section 9.2), and the description
gains part 15's sentence for it, word for word (its section 10, "Three tools that change"). The
error tag `publishing_stopped`
joins `UploadErrorType` and the served enum with part 10's ending (its 8.5); its paragraph in that
type's comment and in this description is written here. Part 01 adds one more tag and one more
sentence to this description, for a build profile that names a language the app no longer has
(its 7.4). Part 11 adds two tags and their sentences, for a lookup table managed in CommCare HQ that
changed in a way the app depends on and for one handed back to CommCare HQ during the upload (its
12.4).

**`get_hq_connection`**: its description's "Call this before `upload_app_to_hq` to confirm the
target" becomes "Call this before `upload_app_to_hq` or `list_hq_apps` to confirm the project space",
and nothing else moves.

### 14.8 Error shapes

`lib/mcp/errors.ts::McpErrorType` gains two members, `McpErrorPayload` four optional fields, and the
file one thrown class that carries them:

```ts
export type BringInErrorType =
	/** A read of CommCare HQ ended before there was an app's read to answer. */
	| "hq_read_stopped"
	/** A create Nova refused for a reason that is neither bad input nor access. */
	| "bring_in_refused";

export type McpErrorType =
	| "not_found" | "invalid_input" | "scope_missing" | "permission_denied"
	| UploadErrorType | BringInErrorType | AgentErrorType;

export interface McpErrorPayload {
	// as today, then:
	/** The READ_CIRCUMSTANCES code, on hq_read_stopped and on a domain_not_authorized that is a stop. */
	circumstance?: string;
	/** The circumstance's title and next step from circumstanceBlock, beside message (its body). */
	title?: string;
	next?: string;
	/** Part 12's ReadingRefusal, wherever a read or a create refused. */
	refusal?: string;
}

/** An expected refusal of a bring-in tool, already worded. The handlers of 14.2 to 14.4 throw it. */
export class BringInToolError extends Error {
	constructor(
		readonly errorType:
			| BringInErrorType | "permission_denied" | "invalid_input"
			| "hq_not_configured" | "domain_not_authorized",
		message: string,
		readonly fields: {
			readonly circumstance?: string;
			readonly title?: string;
			readonly next?: string;
			readonly refusal?: ReadingRefusal;
			readonly projectId?: string;
		} = {},
	);
}
```

`toMcpErrorResult` is not a switch over `McpErrorType`: it dispatches on the class of what was
thrown (`McpInvalidInputError`, `ProjectPermissionError`, `DeploymentError` and the rest), and its
local `payload(errorType, message)` stamps only `error_type`, `message`, `app_id` and `project_id`.
So the four fields need a branch of their own, before the generic classifier: `err instanceof
BringInToolError` logs `log.warn("[mcp] bring-in refused", { userId, errorType, circumstance,
refusal })` (an expected outcome, as every other branch of the kind logs at `warn`) and returns
`payload(err.errorType, err.message)` with `circumstance`, `title`, `next` and `refusal` spread on
where the error holds them, and `project_id` from `err.fields.projectId` where the handler's
context gave none. `mapReadingRefusal(refusal, projectId)` in `lib/mcp/tools/readingProjection.ts`
builds the error for each `ReadingRefusal` from a `satisfies Record<ReadingRefusal, …>` table of
the rows below, so a refusal part 12 adds fails to compile until it has a tag. Adding
`BringInErrorType` to the union is what the compiler holds: every consumer that switches on
`McpErrorType` exhaustively meets the two new tags.

| What happened | `error_type` | Also carried | `message` |
|---|---|---|---|
| a tool called without its scope | `scope_missing` (today's) | `required_scope` | today's |
| no CommCare HQ connection, at `list_hq_apps` | `hq_not_configured` (today's) | | **M5** |
| no CommCare HQ connection, at `read_hq_app` or `bring_in_hq_app` | `hq_not_configured` (today's) | | **M6** |
| a `key-cannot-reach-space` stop at `list_hq_apps` | `domain_not_authorized` (today's) | `circumstance`, `title`, `next` | names the project spaces the key reaches (14.2) |
| a `not-a-member` stop at `list_hq_apps` | `domain_not_authorized` (today's) | `circumstance`, `title`, `next` | the circumstance's body |
| any other stop at `list_hq_apps` | `hq_read_stopped` | `circumstance`, `title`, `next` | the circumstance's body |
| `no_project_access` | `permission_denied` (today's) | `refusal`, `project_id` | part 12's sentence |
| `invalid_input`, `name_missing`, `choice_not_offered`, `choice_missing`, and the handler's own checks | `invalid_input` (today's) | `refusal` where part 12 gave one | the sentence |
| `project_changed`, `app_unavailable` | `bring_in_refused` | `refusal` | part 12's sentence |
| `not_permitted` at `stop_publishing` | `permission_denied` | | part 10's sentence |

A stop, an account, a review and a create that did not create are never errors: they are results
with a `state` or a `status`, as part 12's routes answer them on the stream's last line. No error
is added for a deadline, because there is none (part 12, 4.4). Something thrown inside a read or a
create that is no answer reaches `toMcpErrorResult`'s generic classifier as it does for every
tool. `not_permitted` at `stop_publishing` does not go through `BringInToolError`: part 10's own
map carries it (its 8.3).

### 14.9 `servedSchemas`, and the tools' own tests

`lib/mcp/__tests__/servedSchemas.test.ts` already compiles every served schema and reads every
pattern with the Rust engine, so the six new tools are held to both by being registered. It gains
five tests ("Tests"), and each tool has its handler tests under `lib/mcp/__tests__/`, every one of
them through the real SDK client and server over the linked transport
(`lib/mcp/__tests__/client.ts::withMcpClient`), as `docs/testing.md` requires of an MCP handler
test.

### 14.10 `content/docs/mcp/tools.mdx`

Its text is section 17.3's.

---

## 15. The guide, and what of this part reaches a model

### 15.1 The guide

`lib/agent/authoring/reference.ts::AUTHORING_REFERENCE` is the guide both the Solutions Architect and
an MCP agent read (`lib/agent/tools/getAuthoringGuide.ts`). This part adds one paragraph, as the last
paragraph of the `workflows` entry, after the one that begins "Some edits change where CommCare HQ
keeps a published app's answers":

> An app brought in from CommCare HQ is an ordinary app, and every tool reads and changes it the same
> way. Some of its settings stay in CommCare HQ and are not part of the app, so no tool changes them:
> the user changes those in CommCare HQ. Its first publish back rewrites each form the way Nova writes
> it, which the user is told before they publish.

It is true of every app the reader admits ("the reader admits exactly what the gate admits", clause (a)
of the admission bar; part 01, its opening), and it is all an authoring agent needs: it gives no
instruction to bring an app in, since the Solutions Architect has no such tool and an MCP agent learns
the flow from the tools' own descriptions and the plugin's skill.
`lib/agent/authoring/__tests__/platformGuide.test.ts` pins where the guide's generated platform sentences
sit and needs no edit. No test is added for this paragraph. One that held the `workflows` entry to end
with these words would pin a prose string whose exact value and position are no contract of any consumer,
which `docs/testing.md` rules out ("Do not pin incidental strings … unless that exact value or order is
the external contract"); the platform test is different in kind, since it holds a generated sentence to
the feature it describes. What holds the paragraph is what holds every guide sentence: the step's
`MODEL_CONTEXT_VERSION` move (15.2), which `lib/agent/CLAUDE.md` binds to any change of the guide,
and review.

### 15.2 What moves `MODEL_CONTEXT_VERSION`, and what does not

`lib/models.ts::MODEL_CONTEXT_VERSION` moves once for the whole step (`../6-bring-in.md`). One
change of this part is among what moves it: the guide's paragraph (15.1), since a build whose
authoring guide differs from the build deployed before it must carry a different value. That is
the rule as this step writes it into `lib/agent/CLAUDE.md` ("Provider contract"). The sentence
there today says the constant "moves in every pull request that changes" a served tool or the
guide, which a step of many changes and one deploy does not do, and which its own reason never
asked: a stored model context is replayed only under the catalog it was made against, and
production stores one only under a deployed build. "Contracts and docs these changes make false"
holds the old sentence and its replacement in full, and the top-level file's exit check 8 fails
while the old one stands.

Nothing else of this part reaches a stored model context. The six new tools and the five tools of
14.7 are served by MCP alone: `lib/agent/sharedToolRegistry.ts` holds none of them and
`lib/mcp/server.ts` registers each directly, and "A tool only MCP serves is in no stored model
context and does not move it", a sentence of that paragraph that stands. The screens change no
tool, no description and no guide sentence.

`lib/db/appTests.ts::RUNTIME_VERSION` is not moved by anything here: this part changes no pinned
document and no evaluator.

### 15.3 `scripts/test-schema.ts`

This part adds no entry, and the header's list of known names does not change for it: every tool it
adds or changes is MCP-only, held by `lib/mcp/__tests__/servedSchemas.test.ts` without billing ("A
tool only MCP serves needs no entry", root `CLAUDE.md`). So the step's one billed schema check,
which the top-level file names (`../6-bring-in.md`), sends nothing of this part: it proves that the
provider accepts the Solutions Architect's tools the step changed, and this part changes none.

---

## 16. The nova-plugin

One pull request in `../nova-plugin`, read at `0a67203`. It is opened against the tool text the
step serves and merged only after the step's deploy is live, since a skill that names a tool the
server does not yet serve fails at its first call. Every file below changes in `skills/` and in
its mirror under `.dev-plugin/skills/`.

### 16.1 The skill `bring_in`

`skills/bring_in/SKILL.md`, invoked as `/nova:bring_in [project space] [app name]`.

```yaml
---
name: bring_in
description: Bring an app that already exists in CommCare HQ in to Nova, using the user's stored API key, so they can keep working on it in Nova and publish back to the same HQ app. Nova reads the app first and creates nothing until the user has seen what will come in. If Nova can't hold every part of the app yet, it says exactly what and where, and creates nothing. Name a project space and an app to go straight to them; otherwise it asks.
argument-hint: [project space] [app name]
---
```

Body, in order. Each numbered step is a heading of the file; the quoted sentences are written as
given.

1. **Parse the arguments.** An optional CommCare domain slug, then an optional app name. "A CommCare
   HQ **project space** is not a Nova **Project**", which is how `upload_to_hq` opens the same point
   today, word for word.
2. **Check the connection.** `get_hq_connection`. Not configured: say so, point at
   commcare.app/settings, stop. Several project spaces and none named: list them and ask. "Never
   choose a project space for the user."
3. **Choose the app.** `list_hq_apps { domain }`. Show the names as a list. For an app whose
   `in_nova` is `open`, say it is already in Nova and offer `/nova:show <app_id>`. For `elsewhere`,
   relay `next` as written and stop there for that app: "Do not try another way in. One CommCare HQ
   app is managed by one Nova app." Ask which app where the argument did not name exactly one.
4. **Settle the Nova Project.** `list_projects`. "Say which Project the app will be added to and why
   it matters: an app that reads lookup tables stays in the Project it is added to. Where the user
   can edit several, ask which one and never pick for them. Where they can edit exactly one, say its
   name and go on: there is nothing to choose, and the user can still stop you. Where they can edit
   none, say so and stop." This is what the screen does: one Project is shown as text in the field's
   place (4.1), and several are a choice.
5. **Read.** `read_hq_app { project_id, domain, hq_app_id }`, once. "Tell the user Nova is reading
   the app and that nothing is being created or changed. An app with many pictures and sounds can
   take a few minutes." Keep the `project_id`, `domain` and `hq_app_id` you sent: creating needs
   the same three.
6. **If it stopped** (`state: "stop"`): relay `stop.title`, `stop.body` and `stop.next` as
   written. Offer to read again where `next` invites it.
7. **If Nova can't bring it in yet** (`state: "account"`): say plainly that nothing was created and
   nothing changed in CommCare HQ. Give the counts, then the findings grouped by `place`, each with
   its `sentence`, its `named` where present, and the label of its standing; give each standing's
   `next` once. Page by calling `read_hq_app` with `page` set to `next_page` until it is null, or
   offer the rest where the list is long. "If an answer has `restarted` true, the app changed while
   you were paging: relay `message` and start the list over from this answer." Relay `note` where
   present, and after the list relay `check_again` as written. "Never tell the user the list is
   complete: a later check may find more." "Never soften the list, never call it an error, and
   never offer to bring in part of the app: Nova brings in an app only when it can hold all of it."
   "Nova keeps no list. `/nova:bring_in` again reads the app afresh."
8. **If it is ready** (`state: "review"`): keep `reading_id` and `review.review_digest`, and show
   the review in this order: the name; what will be created (`creates`); **where it runs**, every
   entry of `runs_on` with its `label`, `line` and `split_line`, saying which one Nova proposes,
   each of `runs_on_notes` and each entry of `cannot_run` (its `sentence`, its `features` as a
   list, its `files`); each table, with its `sentence` or its `choice` (title, body, and each
   answer's `label`, `lines` and `reason`); places and media; what stays in CommCare HQ (`kept`);
   `after`; and **what the first publish changes**, the proposed entry's `first_publish`: its
   `lead`, then "relay `workers.lines` first, then `hq_only.lines`, each `sentence` as written,
   then `reassurance` where it is not null, then `note`". "If the user picks another way for the
   app to run, show that entry's `first_publish` before you create: the list belongs to the
   choice."
9. **Ask, and wait.** The name (keep CommCare HQ's or another); where it runs; and each table choice.
   The callout, as a blockquote at the top of this step:

   > Never answer one of these for the user, and never send `bring_in_hq_app` until they have
   > answered every one: the Project where they can edit more than one, the name, where the app
   > runs, whether date and time questions are split, and each lookup table's answer. A table's
   > answer can change what other apps of the Project read. If the user says "use the defaults",
   > say what the defaults are first and get a yes.

10. **Create.** `bring_in_hq_app` with the nine fields, once. "If the call ends before you get an
    answer, send it again with the same arguments: it answers the app if it was created." By
    `status`:
    - `changed`: "say what `message` says, show `reading` again from step 6, 7 or 8, and ask again;
      never resend old answers against a new review."
    - `read_again`: "relay `message`, call `read_hq_app` again, and go on from step 6, 7 or 8 with
      what it answers. Ask again for any choice the new review changed."
    - `check_failed`: "relay `message` and the finding in `reading`. Do not send it again by
      yourself: nothing the user can change clears it."
    - `held`: "relay `stop`, and send the same arguments again only after the user has done what
      `stop.next` says."
11. **Report.** On `created`: the app's name, its `url`, that it is in Nova and nothing changed in
    CommCare HQ, that publishing from Nova updates the same HQ app, and the `after` sentences once
    more. Offer `/nova:show` and `/nova:edit`. "Do not upload it now unless the user asks."
12. **Errors.** One bullet for each `error_type` of section 14.8, written as given:
    - "`scope_missing`: the user's connection to Nova lacks the CommCare HQ access this needs.
      Relay `message`, which names the access to grant, and stop."
    - "`hq_not_configured`: the user has not connected CommCare HQ. Point at commcare.app/settings
      and stop, as in step 2."
    - "`domain_not_authorized`: the key can't reach that project space, or CommCare HQ turned the
      account away there. Relay `message`, `title` and `next`. Where the message names project
      spaces the key reaches, ask whether to use one of those."
    - "`hq_read_stopped`: CommCare HQ ended the read before Nova had anything to show. Relay
      `title`, `message` and `next` as written, and try again only where `next` invites it."
    - "`permission_denied`: the user can't add an app to that Project, or no longer can. Relay
      `message`, and ask which other Project to use where they can edit one."
    - "`invalid_input`: an answer was not one the review offered, a table still needs its answer,
      or the name was missing. Relay `message`, read the review again with `read_hq_app`, and ask
      the user again. Never pick a replacement answer."
    - "`bring_in_refused`: Nova can't create the app as things stand. Relay `message` and stop. Do
      not send `bring_in_hq_app` again until the user asks."

### 16.2 The `upload_to_hq` sweep, by claim

The sweep is by what the skill claims, in prose, not by a search for a tool's name. Five claims
change, two sentences are added for part 01, and two for part 11:

| The claim, in `skills/upload_to_hq/SKILL.md` | Today | From this pull request |
|---|---|---|
| the frontmatter `description` | "…along with the lookup tables it reads and the places in its organization. … The first upload to a project space creates the HQ app; uploading again updates that same app in place." | "…along with the lookup tables and places Nova manages for it. … The first upload to a project space creates the HQ app, or updates the HQ app it was brought in from; uploading again updates that same app in place." |
| the confirmation the skill shows before uploading (step 5) | "a first upload creates the app there, and a later one updates that same HQ app in place. Any Project data tables the app reads and any places in its organization go up with it." | "a first upload creates the app there, and a later one updates that same HQ app in place. If this app was brought in from **<target>**, even the first upload updates the app it came from. Project data tables and places that Nova manages go up with it; ones CommCare HQ manages are left exactly as they are." |
| before the confirmation (step 4, after the compatibility check) | nothing | a new paragraph: "If the check's `first_publish` is not null, this upload changes things in CommCare HQ beyond the user's own edits, and its `lead` says why. In the same message as the confirmation, before the user says yes, relay `lead`, then `workers.lines`, then `hq_only.lines`, each `sentence` as written, then `reassurance` where it is not null, then `note`." |
| the `hq_changed` bullet | "changed in CommCare HQ since Nova last published it" | "changed in CommCare HQ since Nova last published it, or, for an app brought in and not yet published, since it was brought in, or since Nova last brought in changes from it (each entry's `since` says which, and the `message` names the day in UTC)". The bullet gains first: "When the app's change has `can_bring_in` true, read what changed with `read_hq_changes` and show the user both lists. Bringing the changes in keeps everything when `nova_changes` is empty. When it is not empty, it removes every change listed there for good: show that list and ask before calling `bring_in_hq_changes` with `discard_nova_changes` true. The user can also publish over the change instead." Then: "Where the user would rather leave CommCare HQ's version alone, an admin or owner of the Project can stop publishing there with `stop_publishing`: the app in CommCare HQ stays, and a later upload makes a new app beside it. Say what it does and ask before calling it." |
| the list of refusals | no `publishing_stopped` | a new bullet: "`publishing_stopped`: someone stopped publishing this app to that project space while this upload was getting ready. Relay the `message`, which says whether anything was sent. Uploading again makes a new app there, so ask first." |
| the list of refusals | no `hq_build_profile_language_missing` | the bullet part 01 writes for it (its 7.4), word for word |
| the list of refusals | no `hq_managed_data_changed` | the bullet part 11 writes for it (its 12.4), word for word |
| the list of refusals | no `managed_table_handed_back` | the bullet part 11 writes for it (its 12.4), word for word |
| after the paragraph on `hq_app_empty` and `hq_app_gone` | nothing | "Each deployment can also carry `kept`: the settings that stay as CommCare HQ holds them on that project space, with the date Nova read them. Say them when the user asks what Nova leaves alone. `refresh_deployment` with `kept_values: true` reads them again and answers with a sentence instead of a state; relay it as it is." (part 01, section 11) |

Two more sentences are read and left: "`created` also covers an upload that filled the empty app an
earlier, unfinished first upload left there" and the `left_behind` bullet for `kind: "app"` are both
still true, since an ended deployment's HQ app is named by the deployment's `ending` and is not left
behind (part 10, 8.6). The report step gains one line: "If `deployment.ending` is not null, say that
Nova stopped publishing there and relay its `message`."

`skills/build`, `edit`, `autobuild`, `find`, `list` and `show` make no claim this part changes.

### 16.3 The version, the README, and the sweep at the step's head

`.claude-plugin/plugin.json`'s `version` moves from `2.4.2` to `2.5.0` (a new skill is a minor), and
`.dev-plugin/.claude-plugin/plugin.json` takes its own next minor from `1.31.0`, `1.32.0`. `README.md`
gains under "Skills": "- `/nova:bring_in [project space] [app name]`: bring an app you already have
in CommCare HQ in to Nova (reads it first and creates nothing until you've seen what comes in)".

The sweep is made once more at the step's head, as a reading by claim of the plugin's `skills`,
`agents`, `.dev-plugin` and `README.md`, with `rg -i` to find the passages ("Written and not yet
run"). The same reading looks for what the rest of the step makes false of a skill's own prose,
which the top-level file lists with the parts that own each claim (`../6-bring-in.md`). A sentence
it finds is corrected in this one pull request.

---

## 17. Public docs, and `design/`

Each page changes with the behavior it describes, so every sentence below is public in the deploy
that makes it true. `design/readme.md` changes with the screens it describes.

### 17.1 The new page

`content/docs/bringing-in-from-commcare-hq.mdx`, listed in `content/docs/meta.json` after
`"building-with-nova"`, and in `index.mdx` after that page's line: "- [Bringing in an app from
CommCare HQ](./bringing-in-from-commcare-hq.mdx): carry on in Nova with an app you already have, and
publish back to the same app."

```yaml
---
title: Bringing in an app from CommCare HQ
description: How to carry on in Nova with an app you already have in CommCare HQ, what Nova checks first, and what happens when you publish back.
---
```

Outline, with the sentences that carry each section:

1. *(opening)* "If your app already lives in CommCare HQ, you can bring it in to Nova and keep working
   on it here. Nova reads the app with your CommCare HQ account, shows you what will come in, and
   creates nothing until you say so. Nothing changes in CommCare HQ until you publish from Nova."
2. **Before you start.** "You need a CommCare HQ API key saved in Settings, and a project space whose
   plan includes API access. Your account there needs the Edit Apps and Access APIs permissions."
   "Nova needs API access because it is how Nova learns each form's own ID, which is what lets things
   in CommCare HQ that open a form, such as an SMS keyword, keep working after you publish back."
3. **Choosing the app.** "There are three ways in: **Bring in from CommCare HQ** beside **New app**
   on your apps page, **You can bring it in** on an apps page with no apps yet, and **Bring in an
   app from CommCare HQ** under the chat box when you start a new app." "Choose the Nova Project to
   add it to, the project space, and the app." "An app that reads lookup tables stays in the
   Project it's added to,
   so it's worth choosing the Project your team shares." "One CommCare HQ app is managed by one Nova
   app. If someone already brought an app in, the list says so: you can open it, or it tells you who
   to ask."
4. **While Nova reads.** "Reading most apps takes a few seconds. An app with lots of pictures and
   sounds takes longer, and Nova shows how many it has checked. You can leave the page: nothing is
   created until you choose **Bring it in**, and Nova reads the app afresh when you come back."
   "The page's address names the app, so you can keep it or send it to a teammate."
5. **When Nova can bring it in.** The review, section by section, in the screen's own headings, each
   sentence as given:
   - "Nova shows you one review before anything is created."
   - "**Your app** has the name, which you can change, and what comes in: its menus, forms,
     questions, languages and case types."
   - "**Where workers use this app**: Nova proposes where the app runs from what it uses and from
     its Web App setting in CommCare HQ. You can choose differently here or later in App settings."
   - "**Lookup tables** and **Places**: the tables and places the app reads come in as copies that
     CommCare HQ keeps managing. [Project data](/docs/project-data) and
     [Organization](/docs/organization) say what that means."
   - "If your Project already has a lookup table by the same name, Nova asks which one this app
     should use and says what each answer does to your other apps."
   - "**Stays as it is in CommCare HQ** lists the settings Nova leaves alone when it publishes.
     [Publishing](/docs/publishing) shows the same list once the app is in."
   - part 08's sentence C13, verbatim (its "Copy"), on the expressions that come in.
   - "Nothing is created until you choose **Bring it in**."
6. **When Nova can't bring it in yet.** "Nova brings in an app only when it can hold every part of it
   exactly, so nothing is lost when you publish back. When it can't, it creates nothing and lists
   every reason it found, grouped by where it is in your app." Then:
   - "Each reason has one of three labels." Then the three labels with part 01's own sentence for
     each (`FINDING_LABELS` and `FINDING_NEXT_STEPS`, its 9.1), verbatim: "**Nova can't hold this
     yet.** There is nothing for you to change. You can check again whenever you
     like." "**Nova doesn't bring this in.** The app can come in once it no longer
     uses this. If your team relies on it, the app is best kept in CommCare HQ." "**Something to
     change in CommCare HQ.** Once this is changed in CommCare HQ, you can check again and Nova
     will read the app afresh."
   - "Under the list Nova says: When you check again, Nova may find more to name." The quoted line is
     part 01's `ACCOUNT_CHECK_AGAIN_LINE`, verbatim, so the page never calls the list complete.
   - part 08's sentence C14, verbatim (its "Copy"), on the functions a case list or a search
     setting can't bring in.
   - "Nova keeps no copy of the list. **Copy the list** lets you take it with you, and **Check
     again** reads the app afresh whenever you like."
   - "Nova doesn't bring in part of an app."
7. **After it's in.** "The app opens in the builder, and **App setup → Publishing** already shows the
   project space it came from." Then what the review's V21a to V21c say, with the
   project space said in general: "You can keep working on it in Nova and publish back to the same
   app in its project space." "When the app changes in CommCare HQ after you bring it in, your next
   publish stops and lists what changed. You can bring those changes in to Nova, publish over them,
   stop publishing to that app, or close the dialog and decide later. [Changes made in CommCare
   HQ](./publishing.mdx#changes-made-in-commcare-hq) says what each one does." "Publishing to
   another project space makes a new app there. A copy your team already keeps there stays as it
   is."
8. **What the first publish changes** (part 09's heading, and its words). "Nova writes an app in its
   own way, so the first time you publish an app you brought in, some things will differ in CommCare
   HQ. Nova lists them before you bring the app in, and again in the Publish dialog before that
   first publish: what workers will notice, and what changes only in how CommCare HQ stores the
   app." "The list follows the choice you make for where the app runs." "Where nothing in it changes
   what workers see or do, the list says so." The page makes no promise of its own about what stays
   the same: the list is generated for each app, and a fixed sentence here would be true of some
   apps only.
9. **Stopping.** "An admin or owner of the Project can choose **Stop publishing here** on the
   project space's card. The app in CommCare HQ stays as it is, this app stops publishing to it, and
   it can be brought in again as a new app."
10. **From an agent.** "Over MCP the same steps are `list_hq_apps`, `read_hq_app` and
    `bring_in_hq_app`, and in Claude Code `/nova:bring_in`. An agent asks you for the Project, the
    name, where the app runs and each table's answer; it doesn't choose them."

No client app, no project space by name and no count of real apps appears on the page: its examples
are the screen's own headings.

### 17.2 Sentences of existing pages

| Page | Today | From step 6 |
|---|---|---|
| `building-with-nova.mdx`, "Start with a blank app" | ends "…without the reviewed conversational design flow." | gains a paragraph: "If the app already exists in CommCare HQ, you can [bring it in](./bringing-in-from-commcare-hq.mdx) and carry on from where it is." |
| `index.mdx`, the line for Building an app | "…resume an unfinished design, or start with a blank app." | unchanged; the new page's line follows it (17.1) |
| `publishing.mdx`, the opening | "Publishing sends your app to a CommCare HQ project space. Nova remembers where it went, so you can come back at any time and see how far along it is." | gains: "An app you [brought in from CommCare HQ](./bringing-in-from-commcare-hq.mdx) publishes back to the app it came from." |
| `publishing.mdx`, "On CommCare HQ" | "Publishing again **updates this same app in place**, name included…" | gains before it: "For an app you brought in, this card is there from the start, and its first publish updates the app it came from." Then part 09's one paragraph, as part 09 writes it ("The first time you publish an app you brought in, Nova lists what will differ in CommCare HQ…"; its "Contracts"), and no second wording of it from this part |
| `publishing.mdx`, "Each publish keeps every menu's and every form's ID in CommCare HQ." | as quoted | gains: "An app you brought in keeps the IDs CommCare HQ gave it, in the project space it came from. In any other project space Nova makes a new app with its own." |
| `publishing.mdx`, "Changes made in CommCare HQ" | the section offers one way on for a change to the app: "Tick **Publish over this** beside each one you're happy to replace with this app's version…" | part 15's text for the section (its "Contracts and docs these changes make false", "Public docs"): the four ways on, what bringing a change in keeps, what using CommCare HQ's version removes, a replaced picture or sound, and the check when the builder opens. This part writes no sentence of it |
| `project-space-compatibility.mdx`, "Plan features" | "…The Publish dialog lists each one your app needs, with the forms that need it, and asks you to confirm the project space has it." | gains: "For an app you brought in from that project space, Nova doesn't ask about a feature the app was already using there, because publishing changes nothing about it. Those show on the project space's card with who brought the app in, and you can withdraw one like any other." |
| `case-workspace.mdx`, "Cases assigned to the person using the app" | "If an imported app has a different assignment rule, Nova keeps it unchanged…" and "…because the imported rule cannot be recovered from the builder afterward." | "If an app you brought in from CommCare HQ has a different assignment rule, Nova keeps it unchanged…" and "…because the rule it came with cannot be recovered from the builder afterward." ("Import" is the CommCare HQ app file and CSV replacement; `../6-bring-in.md`, "What changed from the outline, and why", item 13.) |
| `projects.mdx`, "When a move waits" | "Apps that use Project data tables can't move yet, those shared tables would be left behind. Nova blocks those moves rather than splitting an app from its data." | gains: "That includes an app brought in from CommCare HQ that reads lookup tables, so it's worth choosing its Project when you bring it in." |
| `claude-code/commands.mdx`, the opening | "The plugin adds seven `/nova:*` commands." | "The plugin adds eight `/nova:*` commands." The next paragraph, "The intended flow is: build an app…", gains: "If your app already lives in CommCare HQ, `/nova:bring_in` brings it in to Nova first." |
| `claude-code/commands.mdx`, a new section before "Uploading to CommCare HQ" | none | "## Bringing in an app from CommCare HQ", holding "### `/nova:bring_in [project space] [app name]`" and: "Brings an app you already have in CommCare HQ in to Nova, so you can keep working on it here and publish back to the same HQ app. Nova reads the app first with your API key (saved in [Nova settings](https://commcare.app/settings)) and creates nothing until you've seen what comes in. Name a project space and an app to go straight to them; leave them off and Claude asks." Then: "Claude asks you for each thing that is yours to decide: the Nova Project where you can edit more than one, the app's name, where the app runs, and what to do about a lookup table your Project already has. If Nova can't hold every part of the app yet, Claude shows you the whole list of what and where, and nothing is created." A `text` block: `/nova:bring_in` and `/nova:bring_in my-project-space "vaccine tracking"`. And a link to [Bringing in an app from CommCare HQ](../bringing-in-from-commcare-hq.mdx) |
| `claude-code/commands.mdx`, `/nova:upload_to_hq`, its last paragraph | "The first upload to a project space creates the app there; uploading again updates that same HQ app in place." | "The first upload to a project space creates the app there, or updates the app it was brought in from; uploading again updates that same HQ app in place. Before the first upload of an app you brought in, Claude shows you what that upload changes in CommCare HQ." |
| `claude-code/commands.mdx`, `/nova:upload_to_hq`, "Changes made in CommCare HQ" | "…changed in CommCare HQ since Nova last published it…" | "…changed in CommCare HQ since Nova last published it, or since you brought the app in…", as part 10 words the origin in the product. The bullet gains at its end: "Claude can read what changed and bring it in to Nova, and asks before removing anything you changed in Nova. An admin or owner of the Project can also stop publishing there, which leaves CommCare HQ's version as it is." |
| `claude-code/quickstart.mdx`, the paragraph on uploading | "`/nova:upload_to_hq` pushes a Nova app to CommCare HQ as a new HQ app." | "`/nova:upload_to_hq` pushes a Nova app to CommCare HQ as a new HQ app, or back to the HQ app it was brought in from." |

### 17.3 `content/docs/mcp/tools.mdx`

A new section, "Bringing in an app from CommCare HQ", after "Creating and deleting apps":

> `list_hq_apps`, `read_hq_app` and `bring_in_hq_app` bring an app that already exists in CommCare HQ
> in to Commcare Nova. Reading creates nothing, keeps nothing and changes nothing in CommCare HQ.
> One call of `read_hq_app` is one whole read. It answers `review`, with what will come in;
> `account`, with what Nova can't hold and where; or `stop`, with what ended the read.
> `bring_in_hq_app` takes the user's answers to the review and has no defaults. Both report
> progress while they work.

| Tool | What it does |
|---|---|
| `list_hq_apps` | List the apps of one CommCare HQ project space by name and `hq_app_id`. `in_nova` says a Nova app already manages one, with the app to open or who to ask. Requires `nova.hq.read`. |
| `read_hq_app` | Read one HQ app for a Nova Project the user chose. Returns `state`, and with it a `review` (with the `reading_id` to create from), an `account` of findings (each with its place, sentence, standing and next step) or a `stop`. A long account is paged with `page` and `next_page`. Calling it again reads afresh. Requires `nova.hq.read`. |
| `bring_in_hq_app` | Create the Nova app from a review, given the `project_id`, `domain` and `hq_app_id` that were read, the `reading_id`, `review_digest`, `app_name`, `runs_only_on`, `split_datetime` and `table_choices`. `status` is `created`, `changed`, `read_again`, `check_failed` or `held`. Sending it again with the same arguments answers the same app. Nothing is sent to CommCare HQ. Requires `nova.hq.write`. |

A callout after the table: "An agent never chooses the Project, the name, where the app runs, the
date-and-time split or a lookup table's answer for the user. `bring_in_hq_app` has no defaults for
that reason."

The same section also documents part 15's two tools, `read_hq_changes` and `bring_in_hq_changes`,
in two more rows of that table, whose text is part 15's ("Contracts and docs these changes make
false", "Public docs").

In "Publishing", the table gains `stop_publishing` ("Stop publishing an app to one project space.
The app in CommCare HQ stays; a later upload makes a new app beside it. Admins and owners of the
app's Project only. Requires `nova.hq.write`."), `get_deployment`'s row gains "`ended`" in its state
list and "`brought_in` and `ending` say where the app came from and whether Nova stopped publishing
there", and `upload_app_to_hq`'s row gains after its first sentence: "For an app brought in from that
project space, the first upload updates the app it came from." The row of
`check_project_space_compatibility` (under "Browsing apps") gains: "`first_publish` is what the
next upload changes in CommCare HQ beyond the user's own edits, for an app brought in from that
project space and not yet uploaded, and after a change in CommCare HQ that Nova writes its own way:
`lead` says which, then `workers.lines` for what workers will notice, `hq_only.lines` for what
changes only in CommCare HQ, then `reassurance` where it is not null and `note`. It is null
otherwise." Part 11 holds the rows for
`refresh_managed_data` and `set_lookup_table_management` (its "Contracts"), and part 01 the
sentence `upload_app_to_hq`'s row gains for a build profile (its 7.4).

### 17.4 `design/readme.md`

The voice gains no rule. The look gains one pattern and the system one primitive, each recorded
where the code will read it:

- After "Publishing", a section **Bringing in**: "Bringing an app in from CommCare HQ is a state of
  the new-app page, not a dialog. One card takes the composer's place, with a heading that takes
  focus as each step appears, a scrolling middle and a footer that stays. The address names the
  app, so a reload reads it again and the address can be kept or sent. A read that
  cannot bring the app in is a full account and never an error: amber, never rose, grouped by
  where each thing lives in the app, with three plain labels explained once. A review asks nothing
  by tick: where the app runs is chosen for the person and theirs to change, and only a real choice
  between two outcomes is left open. Nothing is created until the review's one button."
- In "Primitive contracts", a row for `RadioGroup.prompt.md` and `components/shadcn/radio-group.tsx`,
  and the contract file `design/components/core/RadioGroup.prompt.md` with section 12.2's five rules.
- In "Publishing", part 15's four sentences on a change made in CommCare HQ (its "Contracts and docs
  these changes make false").

---

## Copy

Every string this part adds that a person, an agent or a developer reads. All of it follows
`design/readme.md`, "Content fundamentals": "Invite, never instruct" ("Prefer "you can" and "would you
like" over imperatives; never "you must", never "invalid""); "Take responsibility, offer the next
step"; sentence case; "No em dashes"; "No ellipsis in buttons, menu items, or placeholders, ever";
"Skip periods on single-line text … Keep them on multi-sentence copy", so a string of one sentence
that stands alone as a line ends without a period and a string of two or more keeps every one. No
string names a wire key, a status code or an HQ setting by its stored name. A project space stands
bare where the string is this part's and inside curly quotes where it sits on the Publishing card
beside part 10's strings, which quote it.

The strings live in one new client-safe file, `lib/publish/bringInCopy.ts`, beside part 01's
`hqFindingCopy.ts` and part 12's `hqReadingCopy.ts`, because the screens and MCP return the same
sentences. Every word about what the first publish changes is part 09's, in
`lib/publish/firstPublishCopy.ts`: this part adds no string to that file and no string of that kind
to its own. Sentences with a value are functions (`pickerProjectLine(project)`), named for their
id's meaning. Strings owned by another part are named here by their export and not repeated.

**Entries (N).**

| Id | Where | Text |
|---|---|---|
| N1 | home, the button beside New app | Bring in from CommCare HQ |
| N2 | empty state, under Get started | Already have an app in CommCare HQ? |
| N3 | the link after N2 | You can bring it in |
| N4 | `/build/new`, the second button | Bring in an app from CommCare HQ |
| N5 | under N4 | Carry on in Nova with an app you already have |

**Choosing (K).**

| Id | Where | Text |
|---|---|---|
| K1 | heading | Bring in an app from CommCare HQ |
| K2 | under the heading | Nova reads the app with your CommCare HQ account. Nothing changes in CommCare HQ until you publish from Nova. |
| K3 | field label | Add it to |
| K4 | under the Project, a shared Project | Everyone in {Project} can open it. An app that reads lookup tables stays in the Project it's added to. |
| | the person's own Project (`personal`) | Only you can open it. An app that reads lookup tables stays in the Project it's added to. |
| K5 | field label | Project space |
| K6 | one project space | {domain}, on CommCare HQ ({server}) |
| K7 | combobox placeholder | Search project spaces |
| K8 | field label | App |
| K9 | apps loading, status | Reading the apps in {domain} |
| K10 | no apps | There are no apps in {domain} yet |
| K11 | filter placeholder | Search apps by name |
| K12 | filter matches nothing | No app in {domain} matches that |
| K13 | an app CommCare HQ holds no name for | An app with no name |
| K14 | a row already in Nova | part 10's three exports of `lib/publish/hqAppClaims.ts` (`HQ_APP_CLAIM_OPEN_LABEL` "Already in Nova", `HQ_APP_CLAIM_OPEN_ACTION` "Open", `HQ_APP_CLAIM_ELSEWHERE_LABEL` "Already in Nova, in a Project you're not part of"), and under an `elsewhere` row part 01's `alreadyInNovaNext(claim, formatDate)` |
| K16 | footer | Cancel · Read this app (no in-flight label: the press shows the reading screen, 4.1) |
| K17 | beside the footer | Reading creates nothing. You'll see what Nova found first. |
| K18 | the primary's description while no app is chosen | You can read an app once you've chosen one |
| K19 | no connection: title, body | Connect CommCare HQ to bring in an app / You can add your CommCare HQ API key in Settings. Nova uses it to read your app. |
| K20 | the list request failed | Nova couldn't list the apps in {domain} just now. You can try again. |
| K22 | Check connection could not be read (the picker and the Publish dialog) | Nova couldn't check your connection just now. You can try again. |

K18 is the accessible description of a button that does nothing yet. It says what the button will
do and when, as an invitation, and never as a step to take or a fault.

**Reading (W).**

| Id | Where | Text |
|---|---|---|
| W1 | status | Reading {app} from CommCare HQ (where the page knows no name yet: Reading your app from CommCare HQ) |
| W3 | after twenty seconds | Still reading. Apps with lots of pictures and sounds take a few minutes. |
| W4 | always | You can leave this page. Nothing is created until you choose Bring it in, and Nova reads the app afresh when you come back. |
| W5 | first lost request, in a read or a create | Trying again |
| W6 | second lost request of a read | Nova lost its connection partway. Nothing was created, and you can try again. |
| | the stages | part 12's `READING_STAGE_LABELS` |
| | Nova's own failure: title, body | part 12's `READING_FAILED_COPY`, its `read` and `create` forms |

**Shared actions.** Go to your apps · Choose an app · Choose another app · Choose another Project ·
Check again · Try again · Open Settings · Open {appName} · Open your app · Done.

**A stop (S).**

| Id | Where | Text |
|---|---|---|
| S1 | under every stop but `already-in-nova`, from a read | Nothing was created, and nothing changed in CommCare HQ |
| | the same, on a screen drawn from a create's answer | No app was created, and nothing changed in CommCare HQ |
| | title, body, next step | part 01's `circumstanceBlock(finding, context)` (its 8.4), for a stop, an account's circumstance, the copied text and MCP alike |

**The account (A).**

| Id | Where | Text |
|---|---|---|
| A1 | heading | Nova can't bring in {app} yet (where the read learned no name: Nova can't bring in this app yet) |
| A2 | heading, where every finding is one of Nova's own faults (7.1) | Nova couldn't bring in {app} this time (with no name: Nova couldn't bring in this app this time) |
| A3 | lead, from a read | Nothing was created, and nothing changed in CommCare HQ. Nova only brings in an app when it can hold every part of it exactly, so nothing is lost when you publish back. |
| | lead, from a create's answer | No app was created, and nothing changed in CommCare HQ. Nova only brings in an app when it can hold every part of it exactly, so nothing is lost when you publish back. |
| A4 | lead under A2, from a read | Nothing was created, and nothing changed in CommCare HQ. |
| | lead under A2, from a create's answer | No app was created, and nothing changed in CommCare HQ. |
| A5 | the count line's parts, each singular at one | {n} thing Nova can't hold yet / {n} things Nova can't hold yet · {n} thing Nova doesn't bring in / {n} things Nova doesn't bring in · {n} thing to change in CommCare HQ / {n} things to change in CommCare HQ |
| A6 | a group's link | Open in CommCare HQ |
| A7 | footer | Copy the list · Copied · Check again · Done |
| A9 | the media group's heading | Pictures and sounds |
| A10 | the clipboard was refused | Your browser didn't let Nova copy this, so here it is to select and copy. |
| A11 | a folded run of one sentence | on {n} questions · Show the questions · Hide the questions |
| A12 | the copied text's first line | {heading} ({domain}, checked {date}) |
| | under the groups of every account, and the last line of the copied text | part 01's `ACCOUNT_CHECK_AGAIN_LINE` (its 9.1): "When you check again, Nova may find more to name." This part draws it and writes no line of its own |
| | labels, next steps, sentences | part 01's `FINDING_LABELS`, `FINDING_NEXT_STEPS`, `findingLine`, `placeLine`, `circumstanceBlock`; part 12's `moreFindingsLine`; part 11's R12 |

**The review (V).**

| Id | Where | Text |
|---|---|---|
| V1 | heading | Nova can bring in {app} |
| V2 | under it | Here's what comes in and what stays where it is. Nothing is created until you choose Bring it in. |
| V3 | section | Your app |
| V4 | field label | App name |
| V5 | counts | {m} menus · {f} forms · {q} questions · {l} languages (each noun singular at one) |
| V6 | case types | Case types: {names} |
| V7 | the Project, a shared Project | Added to {Project}. Everyone in {Project} can open it. |
| | the person's own Project (`personal`) | Added to {Project}. Only you can open it. |
| V8 | where the app reads a table | This app reads lookup tables, so it stays in {Project} once it's in. |
| V9 | section | Where workers use this app |
| V10 | a choice that splits, one question | Nova asks for the date and the time separately in this app's date and time question, so Web Apps can run it |
| | several | Nova asks for the date and the time separately in this app's {n} date and time questions, so Web Apps can run them |
| V11a | why, `content` | Nova chose this from what the app uses. |
| V11b | why, `web-apps-off-in-hq` | CommCare HQ has Web Apps turned off for this app, so Nova chose Android only. The app can run in Web Apps too, and you can choose that here. |
| V11c | why, `keeps-web-apps` | This app's date and time questions can't run in Web Apps as they are, and CommCare HQ has Web Apps turned on for it. Nova chose to ask for the date and the time separately so it keeps running there. |
| V12a | the choice leaves Web Apps out, HQ has it on | CommCare HQ has Web Apps turned on for this app. Your first publish asks before turning it off. |
| V12b | the choice includes Web Apps, HQ has it off | CommCare HQ has Web Apps turned off for this app. Your first publish asks before turning it on. |
| V13 | a platform the app can't run on, by features: the lead, then each feature's label as a list item | This app can't run {in Web Apps / on Android} because of what it uses: |
| | by files alone | This app can't run {in Web Apps / on Android}: some of its pictures, sounds or videos don't play there. |
| | by both: the features' lead and list, then this line | Some of its pictures, sounds or videos don't play there either. |
| V14 | always | You can change this later in App settings. |
| V15 | section | Lookup tables |
| V16 | a choice with no answer, on Bring it in | This one needs your choice before Nova can create the app |
| V17 | neither answer is offered | Neither choice is open to you here. You can go back and add this app to another Project. |
| V18, V19, V20 | sections | Places · Pictures and sounds · Stays as it is in CommCare HQ |
| V21 | section | After it's in |
| V21a | | You can keep working on it in Nova and publish back to this app in {domain}. |
| V21b | | If someone changes it in CommCare HQ, your next publish stops before sending anything, lists what changed, and offers to bring it in to Nova. |
| V21c | | Publishing to another project space makes a new app there. A copy your team already keeps there stays as it is. |
| V22 | section, its lead, its two labels, its sentences and its note | part 09's `FIRST_PUBLISH_HEADING` ("What the first publish changes"), `FIRST_PUBLISH_LEAD_REVIEW`, `FIRST_PUBLISH_WORKERS_LABEL`, `FIRST_PUBLISH_HQ_LABEL`, `FIRST_PUBLISH_NO_WORKER_CHANGE`, `FIRST_PUBLISH_FORM_BUILDER_NOTE` and `FIRST_PUBLISH_SENTENCES`, all through `firstPublishLines(view, "review")`. This part writes none of them |
| V23 | footer | Choose another app · Bring it in (no in-progress label: the press shows the creating screen, 8.9) |
| | tables, places, files | part 11's R1 to R11 and R3 to R5; the answer under R11 is the action Choose another Project |
| | kept list | part 01's 9.4 strings |
| | recorded features | part 10's `adoptionRecordedFeaturesLine` |
| | leads, refusals | part 12's `CREATE_ANSWER_LEADS`, `READING_REFUSAL_COPY` |

V13's list items are `PLATFORM_FEATURES[feature].label`, each as written, one to an item and never
joined into the sentence (8.3). V13's two prepositions are `lib/domain/platforms.ts::inPlatform`.
`bringInCopy.ts::platformOutBlock` returns the three parts as data, which the screen draws and MCP's
`cannot_run` carries (14.3, its `sentence` the lead, or the files' line where there is no feature):

```ts
// lib/publish/bringInCopy.ts
import type { Platform, PlatformFeatureId } from "@/lib/domain/platforms";

/** `entry` is one member of `ReadingReview.platformsOut`, typed by its shape so this file imports
 *  nothing of `lib/deployment`. */
export function platformOutBlock(entry: {
	readonly platform: Platform;
	readonly features: readonly PlatformFeatureId[];
	readonly media: boolean;
}): {
	/** V13's first form, where `entry.features` is not empty; null where only files keep it out. */
	readonly lead: string | null;
	/** `PLATFORM_FEATURES[feature].label` for each of `entry.features`, in its order. */
	readonly features: readonly string[];
	/** V13's second form where `lead` is null, its third where it is not; null where `media` is false. */
	readonly files: string | null;
};
```

V10 is a single line and ends without a period. V12a, V12b and V21c are two sentences and keep
theirs. V21b and V21c say what Nova does and name no later step.

**Creating and landing (X, T).**

| Id | Where | Text |
|---|---|---|
| X1 | status | Creating your app |
| X2 | under it | Nova reads the app once more, so it creates exactly what you reviewed. |
| X4 | a create's request lost twice | Nova lost its connection while creating your app. Trying again is safe: if the app was created, Nova opens it. |
| X5 | after twenty seconds | Still bringing it in. Apps with lots of pictures and sounds take a few minutes. |
| X6 | always, under X2 | You can leave this page. If Nova finishes, your app will be in your apps. If it doesn't, no app is created, and you can bring it in again. |
| | the landing could not be verified (the `unopened` screen's line) | part 12's `UNVERIFIED_LANDING_TITLE` (`lib/publish/hqReadingCopy.ts`): "Your app is in, and this tab couldn't open it". This part writes no sentence for it |
| T1 | toast, title | Your app is here |
| T2 | toast, body | Nova brought in {name} from {domain}. Publishing shows where it came from and what stays in CommCare HQ. |
| T3 | toast, action | See what came in |

**After (D).**

| Id | Where | Text |
|---|---|---|
| D1 | the card, under the project space | Brought in from “{domain}” on {date} by {name} |
| D2 | the rung On CommCare HQ, before Nova's first publish ({date} is the day it was brought in) | Nova read this app from CommCare HQ on {date} and hasn't published to it yet |
| D3 | the dialog's section: its heading, lead, labels, sentences and note | part 09's `FIRST_PUBLISH_HEADING`, `FIRST_PUBLISH_LEAD_PUBLISH`, the two labels, `FIRST_PUBLISH_NO_WORKER_CHANGE`, `FIRST_PUBLISH_FORM_BUILDER_NOTE` and `FIRST_PUBLISH_SENTENCES`, through `FirstPublishLines` (11.2). This part writes none of them. D7 keeps its number because part 01 cites it (its 2.3) |
| D7 | plan line, a new app for a brought-in app | Publishing to another project space makes a new app there. A copy your team already keeps there stays as it is. |
| D8 | the drift stop, heading | Or leave CommCare HQ's version as it is |
| D8b | the drift stop, for an editor | An admin or owner of this Project can also stop publishing here, which leaves CommCare HQ's version as it is. |
| D9 | the dialog, after stopping | Nova stopped publishing this app to “{domain}”. The app in CommCare HQ stays as it is. |
| D10 | a stop that failed | Nova couldn't stop publishing just now. Nothing was changed, and you can try again. |
| D11 | the restore toast's title | Your app is back, and where it publishes changed |
| D12 | the dialog's compact row | Publishing stopped |
| | the rest | part 10's `lib/publish/stopPublishing.ts` and its drift sentences |

D2's "yet" is a fact about today, which the first publish ends: it promises nothing.

**MCP and the guide (M, G).** The descriptions are in section 14, in full.

| Id | Where | Text |
|---|---|---|
| M1 | `bring_in_hq_app`, `created` | {name} is in Nova. Nothing changed in CommCare HQ. Publishing from Nova updates the app it came from in {domain}. |
| M4 | `refresh_managed_data`, both or neither | Send table_id to refresh one lookup table, or app_id to refresh that app's places. This call sent both or neither. |
| M5 | `list_hq_apps`, no connection | CommCare HQ is not configured. Add your HQ credentials in Settings before listing a project space's apps. |
| M6 | `read_hq_app` or `bring_in_hq_app`, no connection | CommCare HQ is not configured. Add your HQ credentials in Settings before reading an app. |
| M7 | `read_hq_app`, a `page` the app no longer matches | This app changed in CommCare HQ since the last page, so Nova read it again. Here is what Nova found, from the start. |
| G1 | the guide, `workflows` | the paragraph of 15.1 |

M5 and M6 keep the words of `check_project_space_compatibility`'s own `hq_not_configured` sentence
(`lib/mcp/tools/checkProjectSpaceCompatibility.ts`: "CommCare HQ is not configured. Add your HQ
credentials in Settings before checking a project space."), with the act changed, so the three
tools say one thing. M1 to M7 are exports of `lib/publish/bringInCopy.ts`, and G1 is in
`lib/agent/authoring/reference.ts`.

**For a developer.**

| Where | Message |
|---|---|
| `BringInAccount`, an account with no findings | `[bring-in] account with no findings` at error: "A read answered an account that holds no finding. An account is answered only where a read met one. Look at lib/deployment/reading/gather.ts::gatherReading." |
| `chosenDeclaration`, answers that match no entry of `review.runsOn` (unreachable from the screen, which sets both answers from one entry) | "The review offers no way to run that matches the answers held (runsOnlyOn ${runsOnlyOn}, splitDatetime ${splitDatetime}). Answers are taken from one entry of review.runsOn at a time. Look at components/bring-in/bringInModel.ts::reduceBringIn, the answers event, and carryAnswers." |
| `listHqAppsForPicker`, `getHqCredentials` answering `ambiguous` for a named project space | "listHqAppsForPicker asked for the credentials of one named project space and was told the choice is ambiguous, which a named project space cannot be. Look at lib/db/settings.ts::getHqCredentials." |
| `BuilderLayout`, a `nova:brought-in` value that is not the three strings it writes | `log.warn("[bring-in] landing marker unreadable")`, the key removed, no toast. A warning and not an error: the value is the browser's to lose, and the Publishing card still says where the app came from |
| `toMcpErrorResult`, a `BringInToolError` | `log.warn("[mcp] bring-in refused", { userId, errorType, circumstance, refusal })`, as 14.8 says. The message a client reads is the sentence the error carries |

A stored create the tab's key holds that `resumableCreate` does not take (9.1) is logged nowhere:
text another version of the page wrote is expected, and the page reads the app. This part adds no
migration, so there is no `down` to word.

---

## Tests

Nothing here is run by this plan. Each test names its boundary and the failure it would catch. No
test renders a component in jsdom: "UI is f(state)", so the model is tested as data in Vitest and the
screens in Playwright. The Playwright and real-Postgres suites run in the work's own CI, on hosted
runners.

### Plain Vitest: the model

| File | Holds | Would catch |
|---|---|---|
| `components/bring-in/__tests__/bringInModel.test.ts` | every row of 3.3's reducer table; `screenOf` over every `ReadingAnswer["kind"]` through a `satisfies Record` table; `nextAct` at each location, with a call in flight, with one lost request and with two, and after a `failed` line; at an app's address `nextAct` is `none` until `resume` is dispatched, then `read` | an answer kind part 12 adds with no screen; a read sent before the tab's key is looked at; a retry storm after a lost request |
| the same, a create as a sequence of events | `create-asked`: `screenOf` is `creating` and `nextAct` is `create` with that input. `call`, then `stage` and `files` events: still `creating`, with the stage and the count held. `lost`: still `creating`, and `nextAct` is `create` after 3000 with the input first sent. A second `lost`: `creating` with `lost`, `nextAct` is `none`. `retry`: `create` at once, same input. `failed`: the screen is `failed` with the operation `create`, and `nextAct` is `none` until `retry`, which gives the same create. At no step of the sequence is the screen `review` | the review's choices back on screen under a create in flight; a lost create with no way on; a failed request sent again by the page itself |
| the same, every `CreateAnswer` | `changed` with a review: the lead is `changed-review` and `answers` are what `carryAnswers` keeps; with an account: the screen is `account` under its lead; with a stop: `stopped`, the lead `changed-stop`, and `changed-already-in-nova` for that code; `read-again`: `carried` holds the answers and their review, `answer` is null, `nextAct` is `read`, and the `read-done` that follows with a review applies `carryAnswers` and keeps the lead; `check-failed`: the account of the one finding, under its lead; `held`: the review with the answers kept and `held` set; each refusal on the review or on the `refused` screen, as 8.10's table has it | the person's answers resent against a review that changed; a lead lost when the read after `read-again` answers; a refusal with no screen |
| the same, `carryAnswers` | it keeps a name the person had changed and takes the new review's name where they had not; it keeps a declaration still offered and a table answer still offered; it takes the preselected entry, and leaves a tag unanswered, where each is no longer offered, with `dropped` true; its answers carry the new digest | a person asked the same thing twice; an answer kept that the new review does not offer |
| the same, `resumableCreate` | it answers the input for a stored create of the address's own key written inside the window; null for another app's key, for one written `BRING_IN_RESUME_WINDOW_MS` ago or more, for text that fails `bringInInputSchema`, and for no text | a create started on a page load the person did not ask for; one app's create sent for another |
| the same, the three ends of a landing | `landed` with `unverified`: `screenOf` is `unopened` with the app's id and `nextAct` is `none`, so no second create can be sent; with `leaving`: `creating` and `none`; with `landed`: `creating` and `none` | Bring it in offered again for an app that exists |
| the same, the picker | `connection` with one project space chooses it and sets `apps` to `loading`; `nextAct` is then `list-apps` with that project space; `picker-reload` returns a loaded list to `loading`; `picker-project` changes no list; a `picker-apps` for another project space is dropped; `connection` that no longer holds the chosen project space clears it; with no Project, `connection` chooses nothing and `nextAct` stays `none` | a picker with one project space that never lists; a list for a project space no longer chosen painted over the new one |
| the same | `read-asked` clears what the model held of the app and makes `nextAct` a `read`; a `stage` or `files` event with no call in flight is dropped; `answers` for another digest are dropped; `accountOfOne` counts its one finding under that finding's standing | a stale line painting over a newer screen; a Check again that reads nothing |
| `components/bring-in/__tests__/bringInAccount.test.ts` | `accountGroups` makes one group a key, in first-appearance order, over a list where a form's questions come after another form's findings; folds a run of more than twenty; `accountHeading` follows part 01's `NOVA_FAULT_CIRCUMSTANCES`: `this-time` for a list of those alone, and `yet` for `too-large` alone, for `places-over-nova-limit` alone and for any mix; `countLine` singular and plural for each of the three parts and with zero parts left out; `placeGroupKey` gives a form and its questions one key and two menus two; a circumstance item whose code's row holds `name: "line"` (part 01, 8.3) draws its `named` line, and one whose row holds none draws no such line; `accountAsText` holds every finding, folded or not, gives a circumstance its body, its name and its next step from `circumstanceBlock`, and ends with `ACCOUNT_CHECK_AGAIN_LINE` | a form's heading drawn twice; a finding lost between the answer and the screen or the clipboard; "1 things"; "this time" over a limit a retry cannot pass; two findings of one code that read alike; a copied list that reads as complete |
| the same | `STOP_ACTIONS satisfies Record<StopCircumstance, …>` (part 01's type) over the nineteen codes, every `StopAction["kind"]` has a label through a `satisfies Record`, and the row of `already-in-nova` answers `open-app` for an `open` claim and none for any other | a circumstance part 01 adds with no way on; Open offered for an app the person cannot open |
| `lib/deployment/__tests__/hqPlaceUrl.test.ts` | every `HqPlace["kind"]` through a `satisfies Record`, at index 0 and on each of the three servers | a link to another server's host; `modules-undefined` |
| `components/bring-in/__tests__/bringInReview.test.ts` | `initialAnswers` takes the preselected choice and HQ's name and answers no table; `unansweredChoices` in tag order; `declarationWhy` for each `runsOnWhy`, both V12 lines and each V13 form, with a feature's label never inside a sentence; `bringInInputOf` carries the address's key, the review's `readingId` and digest, and trims the name | a default that answers a table for the person; a reason that contradicts the choice; a create sent for another app than the one on screen |
| the same, the first-publish list | over a review whose preselected row runs on both platforms and whose other row is Android only with a split, with CommCare HQ's Web Apps on: `firstPublishLines(chosenDeclaration(review, answers).firstPublish, "review")` for the first holds no line of `web-apps-turned-off` in `workers.lines`; after an `answers` event for the second, `workers.lines` holds the lines of `web-apps-turned-off` and `date-and-time-questions-split` and `reassurance` is null; a view with `touchesWorkers` false gives `reassurance` and an empty `workers.lines`; the two surfaces differ only in `lead`. The test finds a line by its `id` and never counts ids, since a list can hold fewer lines than its view has ids (part 09, 12.2). It holds `chosenDeclaration`, this part's one function in the path; the renderer's own rule is held by part 09's `firstPublishCopy.test.ts` | the preselected row's list shown for the row the person chose; the reassurance over a list that changes what workers see |
| `lib/routing/__tests__/bringInLocation.test.ts` | `bringInLocation` and `bringInHref` are inverses over `none`, `choose` and an app's key; an `hq=app` with a value missing, a server that is none of the three, or an app id outside its pattern is `none`; any other `hq` value is `none` | an address that makes the page post a read for arbitrary text |
| `lib/publish/__tests__/bringInCopy.test.ts` | no export of `bringInCopy.ts` holds an em dash; none holds an ellipsis; no label of a button ends in a period; every string of two or more sentences ends in one. These four are `design/readme.md`'s rules for copy, held over the whole file, and no string's own words are pinned. Part 09's `firstPublishCopy.test.ts` holds its file | a rule of the voice broken by a later string |
| `components/builder/app-setup/__tests__/publishingSectionModel.test.ts` (extended) | `broughtInOf`; `cardKind` is `ended` for a deployment whose state moved to `preflight` after an ending and before a new app; `broughtInElsewhere`; the compact row of an ended deployment | an ended card that returns to a ladder on a refused publish (part 10's 8.1 case) |
| `components/builder/__tests__/publishOutcome.test.ts` (extended) | `publishPlanCopy`, now an export of `publishOutcome.ts` (11.2): `creates-beside` whatever the context; `creates` with `broughtInElsewhere` true is D7 and false is today's sentence; `updates`, `fills-shell` and `unknown` unchanged by the context | a second project space told "updates"; the move from the dialog changing one of the three strings |

### Real Postgres

| File | Holds | Would catch |
|---|---|---|
| `lib/deployment/reading/__tests__/picker.postgres.test.ts` | `listHqAppsForPicker` over part 05's retained answers served through `MockAgent`: free apps in HQ's order; an `open` claim; an `elsewhere` claim whose JSON holds neither the holding Project's name nor the Nova app's; no connection; a project space the stored key does not list, which answers `key-cannot-reach-space` with no request sent to the HQ peer; a membership CommCare HQ refuses, which answers `not-a-member`; a plan with no API access; and that no table's row count changes | a claim view that leaks another Project; a key's limit worded as CommCare HQ's refusal; the probe run beside the list; a read that writes |
| `app/api/commcare/connection/__tests__/route.postgres.test.ts` | with a real `user_settings` row: the body is `getCommCareSettings`' answer for the session's user, and `connection` holds exactly the keys of `CommCareSettingsPublic` (`configured`, `username`, `server`, `availableDomains`), so nothing of the stored key; a second user's row is never the answer; a user with no row answers `{ connection: { configured: false } }`; 401 without a session | another user's connection returned; a credential on the wire |

Where the first-publish list is stored, when it ends and what `DeploymentView.firstPublish` answers
are part 09's and part 10's, held by their own tests (part 09, "Tests"). This part adds no test of
storage, because it adds no storage.

### Routes with no database

| File | Holds | Would catch |
|---|---|---|
| `app/api/commcare/hq-apps/__tests__/route.test.ts` (a mocked service) | 401 without a session; 400 for a bad `domain`; a stop is 200; `isPathAllowedOnHost` admits `/api/commcare/hq-apps` and `/api/commcare/connection` on the main host and refuses both on the MCP and docs hosts | the deploy-time 404 the root `CLAUDE.md` warns of |

### Playwright, browser peers

`e2e/tests/browser/bring-in.spec.ts`, with the peer `e2e/lib/bring-in-client.tsx`, which mounts
`BringInFlow` inside the production `CommCareConnectionProvider` (given the `settings` the test
sets) with a `landCreatedAppReceipt` that records its calls and a seed of two Projects, one of them
`personal`. Every Nova route is answered from `page.route` with typed bodies built from the
production types (`HqAppPicker`, `ReadingEvent`, `ReadingAnswer`, `CreateAnswer`,
`CommCareSettingsPublic`), as `publishing.spec.ts` builds `PublishResponseBody`; the read and the
create are answered as NDJSON bodies, one `ReadingEvent` a line. A route a journey holds open and
answers later, or answers differently on a second post, is added through
`e2e/lib/routes.ts::removableRoutes` and removed with its `removeAll`, as `e2e/CLAUDE.md` requires
of every route a test removes ("A route a test removes goes through `e2e/lib/routes.ts`"). The file
is used and not changed.

| Journey | Asserts |
|---|---|
| choosing | no connection shows the aside; Check connection requests `/api/commcare/connection`, brings the fields back with focus on Project space, and leaves the address at `?hq=choose`; a connection the route could not answer shows K22 and the button again; one project space lists its apps with no choice asked; a chosen project space lists apps; an `open` row has Open and cannot be chosen; an `elsewhere` row reads its line and cannot be chosen; arrow keys move through the rows; the filter narrows; the personal Project reads "Only you can open it"; Read this app puts the app's four values in the address and posts the read with exactly `{ projectId, server, domain, remoteAppId }`; Back returns to the picker with its list; a seed with no Project shows the `no_project_access` sentence and no fields |
| reading | the stage's label follows the stream's lines and the count moves; the reassurance appears after twenty seconds (`page.clock`); a response with no last line is read again once after three seconds, and a second shows W6 with Try again, which posts again; a `failed` line shows the read's failed screen and nothing more is posted until Try again; a 403 with `no_project_access` shows its sentence with Choose another Project |
| a stop | for one code of each row of `STOP_ACTIONS`, the title has focus and exactly those actions are offered; S1 shows under each but `already-in-nova`; Check again posts a read |
| the account | each heading once, in the app's order; each label as text; a form group's link ends `modules-0/forms-1/`; a folded run opens; a circumstance with a name of its own shows "In CommCare HQ:" and the name; `ACCOUNT_CHECK_AGAIN_LINE` shows under the groups; a `no-platform-runs-everything` finding whose `detail.reason` is `split-refused` reads the next step about the date and time question; Copy the list puts the whole text on the clipboard, the line included, and with the permission denied the text is selectable on screen; Check again posts a read |
| the review | no checkbox exists on the screen; the preselected choice is checked; choosing another choice changes the Web Apps line, the recorded-features line and the list under "What the first publish changes", which gains "Web Apps is turned off for this app" and loses `FIRST_PUBLISH_NO_WORKER_CHANGE`, and keeps `FIRST_PUBLISH_FORM_BUILDER_NOTE` as its last line; a platform the app can't run on shows its features as list items; Bring it in with a table unanswered sends no request, focuses that group and shows V16; a table with neither answer offered shows V17 and not R11; with every choice answered, posts exactly the `BringInInput`, the address's key and the review's `readingId` and digest in it; an empty name focuses the field with its error |
| a create's answers | `held` shows the block above the review and keeps every answer; `changed` with a review shows its lead, keeps the name the person typed and the choice that is still offered, and says so where one was dropped; `changed` with a stop of `already-in-nova` shows its own lead, Open, and no S1; `read-again` shows the reading screen under its lead and then the review with the answers kept; `check-failed` shows the account under heading A2 with "No app was created" |
| creating | from the press on, no radio of the review is on screen; the count reads "Checking pictures and sounds" and then "Bringing in pictures and sounds", and on `creating` no stage line shows under X1; `created` calls the landing once with the receipt; a lost response retries once after three seconds (`page.clock`) with the same body and then offers Try again, which posts it again; a `failed` line shows the create's failed screen, and Try again posts the same body; a landing that answers `unverified` shows part 12's `UNVERIFIED_LANDING_TITLE` with Open your app, and no Bring it in |
| a reload during a create | with the create held open, a reload shows the creating screen and posts the same body again, with no read between; `sessionStorage` holds `nova:bring-in-create` until the answer and not after it; with a key written for another app, and with one older than an hour (`page.clock`), the page removes the key and posts a read |
| narrow | at 360px wide the footer's buttons stack at 44px, the middle scrolls, and the document does not scroll sideways |

`e2e/tests/browser/publishing.spec.ts` (extended): a brought-in record shows D1 and D2; Stop
publishing here is present for a role with `delete` and absent for an editor; its dialog calls the
action once and the card becomes the ended card with its link; the review step shows "What the
first publish changes" with its lines, workers' first, for a record with `firstPublish` and no such
section without; an `hq_changed` refusal that names the app with `canBringIn` false shows D8 for an
admin and D8b for an editor, and one with `canBringIn` true shows part 15's panel and no tick (its
`hq-changes.spec.ts`); the plan line reads D7 for a second project space of a brought-in app; and
the dialog's Check connection requests `/api/commcare/connection`, shows the upload form when it
answers a connection, and makes no document or RSC request.

### Playwright, app journeys

`e2e/tests/app/bring-in.spec.ts`, profile `@seed:bring-in`: the name joins
`e2e/lib/smokeProfiles.ts::SMOKE_PROFILES`, and its builder, written in `e2e/lib/bringInSeed.ts`, is
registered under that name in `e2e/lib/smokeSeedFactory.ts`, as `"deep-links"` is. It seeds an owner
with Projects A (active) and B and a CommCare connection; one brought-in app in A and one in B, each
made by part 12's birth over the fixture its own birth tests export (no CommCare HQ is read: the
birth takes prepared inputs), with each app's receipt in the typed scenario data; a third Project C
of the owner's that holds nothing; an editor of A; and a third person who views A and edits B. It
plants no reading, because there is none to plant. `/api/commcare/bring-in/read`,
`/api/commcare/bring-in/create` and `/api/commcare/hq-apps` are answered from `page.route`, since
each would read CommCare HQ. Every other request reaches the production server, and
`/api/commcare/connection` reads Nova's own row.

| Journey | Asserts |
|---|---|
| the three entries | each reaches `/build/new?hq=choose`; from the button under the chat box, Back returns to the composer with no page load |
| the address survives a connection check | from the composer, choose the second button (the address becomes `?hq=choose` through the History API), then Check connection: the address is still `/build/new?hq=choose` and the picker is still on screen. This is what would catch a refresh that hands the address back to Next and drops the person on the composer |
| a viewer who edits elsewhere | as the third person, with A active, `/build/new?hq=choose` shows the picker with B under "Add it to", and the home shows no entry button |
| an address | an app's address, opened by typing it, posts one read and shows the review the route answers; a reload posts the read again and shows it again; `/build/new?hq=nonsense`, and an app's address with one value missing, show the composer and post nothing |
| landing in the tab's Project | Bring it in, with the create answered by A's seeded receipt: the address becomes `/build/<id>` with no document load (a marker set on `window` before the click is still there), the builder is open on the app's own menus, the toast reads T1, and See what came in opens Publishing with D1 |
| landing in a second Project | the same with B's receipt: the page loads `/build/<id>`, the builder is open, T1 shows once, no "Reload" toast appears, and `sessionStorage` no longer holds `nova:brought-in`. In the first landing journey the key is never written, and T1 shows once |
| a reload while a create is held open | Bring it in with the create held open, then a reload: the creating screen shows. The create is then answered with A's seeded receipt: the builder opens, and the home list holds that app once |
| Back to a home that was empty | with Project C active, from its empty home, start a blank app, which lands with no model call, and press Back: the home shows the app and not "Build your first app". This is what would catch an empty state the router's cache serves after a birth |
| stopping | as the owner, Stop publishing here on the brought-in app's card gives the ended card; as the editor the button is absent |

In the landing journeys the receipt names a seeded app, whose id is not the one the reading on
screen would derive. In production a brought-in app's id is derived from the reading's id, which
part 12's real-Postgres tests hold; what these journeys prove is the landing itself, on the real
builder.

### MCP

| File | Holds | Would catch |
|---|---|---|
| `lib/mcp/__tests__/servedSchemas.test.ts` (extended), "serves bring_in_hq_app with every answer required and no default" | `required` is all nine properties; `additionalProperties` is false; `runs_only_on` admits `null`, `"web-apps"` and `"android"` and nothing else; `review_digest` admits 64 lower-case hex and refuses upper case; `reading_id` admits a UUIDv7 and refuses a UUIDv4; no schema position holds a `default` | an optional answer an agent can leave for Nova to choose |
| the same, "serves read_hq_app as one closed object" | `required` is `project_id`, `domain` and `hq_app_id`; `page` is the one optional property, with its pattern; `additionalProperties` false | a continuation field left over from a flow that had steps; a key field renamed without the description |
| the same, "serves the four other bring-in tools as closed objects" | the property sets of `list_hq_apps` (`domain` alone), `stop_publishing`, `refresh_managed_data` and `set_lookup_table_management`, the last two as part 11's table has them, and `additionalProperties` false on each of the four, which holds only because all four are `z.strictObject` (14.5) | an input drifting from the two parts' tables; a tool served open because it was written `z.object` |
| the same, "tells a client an agent never chooses for the user" | `bring_in_hq_app`'s description contains "never choose the name, where the app runs, the date-and-time split or a lookup table's answer for them"; `read_hq_app`'s contains "never choose it for them"; `set_lookup_table_management`'s contains "Never decide this for the user." These three phrases are the contract a client is served: they are how the rule that `bring_in_hq_app` never chooses for the person (14.4) reaches an agent, which is the exception `docs/testing.md` makes for a pinned string | the rule softened in an edit |
| the same, "names each key where a client reads it" | each of the keys `first_publish`, `check_again`, `next_page`, `restarted`, `brought_in`, `ending` and the tag `publishing_stopped` is named in the description of a tool that returns it (14.3, 14.4, 14.7), and the three tools that name `first_publish` (`read_hq_app`, `bring_in_hq_app`, `check_project_space_compatibility`) each say to relay `workers.lines` first, then `hq_only.lines`, then `reassurance` where it is not null, then `note` | a projection key no description explains; an agent told to read a key that is no longer served |
| `lib/mcp/__tests__/readingProjection.test.ts` | `describeReading` for each of the three answer kinds; every sentence equals the copy export the screen uses; a stop's and a circumstance finding's `title` and `next` equal `circumstanceBlock`'s with the UTC day, for `already-in-nova` and for a `split-refused` `no-platform-runs-everything` among them; a circumstance whose row holds `name: "line"` carries `named`; an account holds `check_again` equal to `ACCOUNT_CHECK_AGAIN_LINE` on every page; each `runs_on` entry's `first_publish` equals `firstPublishLines(choice.firstPublish, "review")` with its keys in snake case, so two entries that differ in declaration differ in list, the review holds no list of its own, and no `touches_workers` key is served; `cannot_run` holds a feature's label as an item and never inside `sentence`; with 2,000 findings whose names and places are at their longest, each page's JSON is under 80,000 characters and following `next_page` to its end gives every finding once; a `page` whose digest is another account's gives the fresh account from its start with `restarted` true and M7; a `page` against a read that is now a review gives the review with `restarted` true; `mapReadingRefusal` is total through its `satisfies Record<ReadingRefusal, …>` table | an answer the client truncates in silence; two versions of an app stitched into one list; MCP and the screen saying different things; an agent relaying the proposed row's list for the row the user chose |
| `lib/mcp/__tests__/errors.test.ts` (extended) | `toMcpErrorResult(new BringInToolError("hq_read_stopped", body, { circumstance, title, next }))` carries the three fields beside `message`; one with `refusal` and `projectId` carries `refusal` and `project_id`; fields the error does not hold are absent keys, not nulls | a stop that reaches a client as a bare message, with no next step |
| `lib/mcp/__tests__/bringInToolScopes.test.ts` (no database) | through `withMcpClient` with a token that lacks the tool's scope: each of the six answers `scope_missing` with its `required_scope`, and the service functions, mocked at the module boundary, are never called | a scope hole; a missing-scope credential learning whether an app exists |
| `lib/mcp/__tests__/bringInTools.postgres.test.ts` | through `withMcpClient`, over real Postgres and part 05's retained answers served by `MockAgent`: `read_hq_app` answers a review with its `reading_id` in one call; with the HQ peer held open and a progress token, a notification arrives for each stage, and with no token none does; a call the client cancels aborts the HQ requests in flight; `bring_in_hq_app` answers `created`, and sent again with the same arguments answers the same `app_id`, and its `url` is `AS_ORIGIN` then `/build/` then the app's id; a table left out is `invalid_input` with `refusal: "choice_missing"`; a source that changed after the read is `changed` with `reading`; a birth whose own check is made to refuse is `check_failed` with the one finding in `reading`; each `ReadingRefusal` a call can produce arrives with the `error_type` and `refusal` of 14.8's table; a stop at `list_hq_apps` is `hq_read_stopped` with `circumstance`, `title` and `next`; `key-cannot-reach-space` and `not-a-member` there are both `domain_not_authorized`, each with its own message | a retry that makes a second app; a client that times out on an app with many files; a refusal with no bucket |
| `lib/mcp/__tests__/compatibility.postgres.test.ts` (extended) | `first_publish` is null for a Nova-made app and for a brought-in app after its first publish; before it, it equals `firstPublishLines(view, "publish")` in snake case for the declaration the app was created with, for an app whose chosen declaration was not the preselected one; and after `runsOnlyOn` is changed in the document, its two Web Apps lines follow the document (part 09, 12.3) | the list arriving after the fact; the preselected row's list told for an app created with another; a stored Web Apps line told for an app that no longer runs that way |
| `lib/mcp/__tests__/deploymentTools.postgres.test.ts` (extended) | `brought_in` and `ending` on `get_deployment`; `stop_publishing` as an editor is `permission_denied` with part 10's sentence, and as an owner returns the ended deployment | a member told "not found" for something they can see |

No test holds the guide's paragraph (15.1).

---

## Contracts and docs these changes make false

Each row lands with the behavior that makes it true.

| Where | Today | From step 6 |
|---|---|---|
| `components/builder/CLAUDE.md`, "Creation never navigates" | the sentence on every way a receipt reaches the client, as part 12 rewrites it for the bring-in's create route (its "Contracts") | adds, after part 12's paragraph: "The flow that brings an app in is a state of `/build/new` (`components/bring-in`), inside `ChatContainer`'s tree, so its app lands through the same installer." |
| `components/builder/CLAUDE.md`, "Creation never navigates" (second paragraph) | "…the router re-render carrying the revalidation restores Next's own canonical URL, undoing the promotion." | gains: "The same holds for `router.refresh()`, which is why Check connection reads `GET /api/commcare/connection` through `CommCareConnectionContext`'s `refresh` and not through the router." |
| `components/CLAUDE.md`, "Build recovery is URL-backed" | names `/build/new?design=<id>` alone | gains: "A bring-in is URL-backed too: `/build/new?hq=choose` is the picker, and `/build/new?hq=app&…` names one CommCare HQ app and the Project it is added to. Nothing is stored for it, so opening the address reads the app again. The flow reads the query through `useBuilderSearchFrom`, seeded by the server so the first paint agrees. One key in the tab's session storage lets a reload during a create send that create again." |
| `components/CLAUDE.md`, "Primitives come from `components/shadcn`" | the list of primitives has no radio group | the list gains "radio-group (`RadioGroup`, rows wearing `selectableRowCls`; an item that cannot be chosen stays focusable and says why)" |
| `components/builder/CLAUDE.md`, "Publishing" | "`RemoteChangeChoice` stands beside `ResourceConflictChoice` … it lists every change made in CommCare HQ since Nova's last push and offers to discard them" | gains: "Where the app itself changed and its list of changes is drawn, an admin or owner is also offered Stop publishing here (`StopPublishingDialog`), and an editor is told who can. For an app brought in and not yet published, the review step states what the first publish changes (`FirstPublishLines`), from `DeploymentView.firstPublish`." |
| `components/builder/CLAUDE.md`, "App setup, Publishing" | "renders one full `DeploymentStatus` card per project space the app has reached" | gains: "A card says where a brought-in app came from, offers Stop publishing here to a member who may delete, and draws an ended deployment from `deploymentEnding`, never from the state: no ladder, no Check status, no Workers panel." |
| `components/builder/PublishDialogBody.tsx`, the comment over `RemoteChangeChoice` | "What changed in CommCare HQ since Nova last published there, and the only thing that lets the publish write over it." | "What changed in CommCare HQ since Nova last published there, brought the app in or brought changes in, and what lets the publish write over it. Where the app's change can be brought in, `HqChangesPanel` takes its item's place; otherwise Stop publishing here stands beside it." |
| `components/builder/CommCareConnectionContext.tsx`, its header | "The value is memoized against the settings object (RSC-stable across renders), so `PublishPanel`'s memo and the dialog's domain-reset effect see one identity per page load rather than a fresh array per render." | "The value is memoized against the settings object and the last answer of `refresh`, so `PublishPanel`'s memo and the dialog's domain-reset effect see one identity until a refresh answers. `refresh` reads `GET /api/commcare/connection` and never calls the Next router: on a page whose address the History API wrote, a router refresh would write Next's own address back." |
| `components/chat/StartFromScratch.tsx`, its header comment | "the "skip the SA, build it yourself" affordance" | "the two ways to start without describing an app: a blank app, and an app brought in from CommCare HQ" |
| `app/(app)/(site)/RefreshStaleAppList.tsx`, its header | "Refetches the app list once, when the user arrives on a list that was rendered before an app they have since created." | gains: "The empty state mounts it too, since the first app a Project holds is created from there." |
| `lib/routing/CLAUDE.md` | no word of `/build/new`'s query | gains: "`/build/new` carries two query states, each seeded by the server for the first paint: `design`, and `hq` with the key of the app being brought in (`bringInLocation.ts`)." |
| `e2e/CLAUDE.md` | its list of profiles and peers | gains the `@seed:bring-in` profile and the `bring-in` peer, and the sentence "No test reaches a CommCare HQ: a bring-in journey answers the routes that would from `page.route`, and seeds its brought-in apps through the production birth." |
| `lib/mcp/errors.ts`, the comment on `McpErrorType` | "Spans five independent failure sources", over a list that already names six (`not_found`, `invalid_input`, `scope_missing`, `permission_denied`, `UploadErrorType`, `AgentErrorType`) | "Spans seven independent failure sources", with a seventh bullet: "`BringInErrorType`: a read of CommCare HQ that stopped before there was an app's read to answer (`hq_read_stopped`, with the circumstance's code, title and next step), and a create Nova refused for a reason that is neither input nor access (`bring_in_refused`, with the refusal). Surfaces via `BringInToolError`." |
| `lib/deployment/CLAUDE.md`, "Surfaces" | names the deployment tools MCP serves | gains `list_hq_apps`, `read_hq_app`, `bring_in_hq_app` and `stop_publishing`, and "none is given to the Solutions Architect" |
| `lib/agent/authoring/CLAUDE.md` | no word of a brought-in app | gains: "The guide says one thing about an app brought in from CommCare HQ: it is an ordinary app. It gives no instruction to bring one in." |
| `lib/agent/CLAUDE.md`, "Provider contract", the rule for `MODEL_CONTEXT_VERSION` | "`lib/models.ts::MODEL_CONTEXT_VERSION` moves in every pull request that changes the name, the description or the input schema of a tool the Solutions Architect is offered, or the authoring guide (`lib/agent/authoring/reference.ts`), because a stored model context is replayed only under the catalog it was made against." | "`lib/models.ts::MODEL_CONTEXT_VERSION` differs between any two deployed builds that differ in the name, the description or the input schema of a tool the Solutions Architect is offered, or in the authoring guide (`lib/agent/authoring/reference.ts`), because a stored model context is replayed only under the catalog it was made against, and production stores one only under a deployed build. A set of changes that merges and deploys together moves it once, in that set. A change that deploys alone moves it in its own pull request." The sentence after it stands word for word ("A tool only MCP serves is in no stored model context and does not move it, and neither does a field added to a shared read tool's result with no change to the tool's name, description or input."). This step is the first set of that kind: the whole step moves the value once (the top-level file, "Versions"). Every other place that names the constant was read, and none restates the rule: `lib/agent/authoring/CLAUDE.md` ("a change to a platform note or remedy changes the guide and moves `MODEL_CONTEXT_VERSION`") states a consequence the new sentence keeps true, so it is not edited; the closing sentence of the same section of `lib/agent/CLAUDE.md` ("A pull request finds what it moved by hashing every shared tool's served schema at its base and head") says how a change finds the schemas it moved and stays true; `lib/commcare/CLAUDE.md`, the root `CLAUDE.md`, `docs/architecture/` and `docs/testing.md` do not name the constant; and the comment over it in `lib/models.ts` ("A compaction item is replayable only inside this model-context contract.") stands |
| root `CLAUDE.md`, the map's builder UI entry | lists `components/builder` and its libraries | gains "`components/bring-in` (the flow that brings an app in from CommCare HQ, a state of `/build/new`)" |
| root `CLAUDE.md`, the first paragraph | "Nova turns a natural-language conversation into a working CommCare app." | gains after it: "An app that already lives in CommCare HQ can be brought in and carried on from there." |
| `design/readme.md` | no "Bringing in"; no radio group contract | section 17.4 |
| public docs | section 17 | section 17 |
| `../nova-plugin` | section 16 | section 16 |

The comments on `app/api/mcp/route.ts::maxDuration` and
`app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS`, which this part's tools would otherwise make
misleading, are part 12's to correct (its 4.4).

---

## Departures

Departures from the outline and the research, and the decisions this part took where an alternative
was weighed and not taken. Each states the evidence and the decision taken.

1. **`bring_in_hq_app` is sent the Project, the project space and the app again, beside the
   reading's id.** Its arguments are the three fields `read_hq_app` took, the `reading_id` and the
   review's digest it returned, and the answers (14.4). Nothing is stored between a read and a
   create (part 12, section 2), so the create reads the app again from those three and proves by
   the digest that it is what the user reviewed. Not done: a `reading_id` that stands for the
   three, because there is no record for it to name, and a tool that took one would be asking the
   server to remember what the design says it never keeps.
2. **Six tools, not three.** Beside the three that bring an app in (`list_hq_apps`, `read_hq_app`,
   `bring_in_hq_app`), `stop_publishing` is part 10's Departure 3, and `refresh_managed_data` and
   `set_lookup_table_management` are part 11's (its 12.4). All six are registered here (14.1).
3. **"Check connection" stops going through the Next router, in the Publish dialog as well as in the
   picker, and one route is added for it.** Today the dialog's `NotConfigured` refreshes with
   `router.refresh()`. Not done: reusing that aside and its refresh in the picker as they stand,
   because of what a router refresh does there. Evidence, at source: `pushBuilderHistory` writes an
   address with Next's own history state spread into it
   (`historyPolicy.ts::scopedBuilderHistoryState`); Next's patched `pushState` returns early for a
   state that carries its marker, leaving its canonical address unchanged, and its history updater
   calls `replaceState` with that canonical address on every router state change
   (`next/dist/client/components/app-router.js`). So a router refresh on `/build/new?hq=choose`,
   reached from the composer's button, writes `/build/new` back and the picker gives way to the
   composer; `components/builder/CLAUDE.md` records the same effect for a revalidation after a
   creation. Decision: `GET /api/commcare/connection` reads the person's own stored connection,
   `CommCareConnectionContext` gains `refresh`, and both surfaces use it (4.4). The route sits under
   `/api/commcare`, which the allowlist already holds, so bringing an app in adds no route the
   proxy's allowlist does not already admit (part 12, 4.1). The dialog changes with the picker,
   because one connection read by two mechanisms would let the picker see a key the dialog, minutes
   later in the same tab, says is missing.
4. **Reading shows the running stage's name and a count of files, not a ladder of steps with
   results.** A read's stream carries the stage that is running and the file count, and nothing
   else before its answer (part 12, 4.3). The read still has named stages: each is named as it
   runs (5). Not done: a ladder that keeps each finished stage on screen with its result ("2 menus,
   5 forms", "1 table"), because no line of the stream holds such a count, and an ordinary read is
   over in seconds, which a ladder would only flicker through.
5. **No "Stop reading" button.** Leaving is the stop: a read whose tab closed or moved on is aborted
   and ends at its next call to CommCare HQ, having stored nothing (part 12, 3.2). Not done: a
   footer button that stops a read, because it would do what Back and Go to your apps already do. A
   create is the opposite case and has no stop either: once asked it runs to its end (9.1), and the
   screen says what leaving does.
6. **"Bring it in" is never disabled for a missing answer.** The press moves focus to what is missing
   and says so (8.9), and the server keeps the rule for every other caller. Not done: a button disabled
   until every choice is answered, with the reason beside it, because a disabled button cannot move
   focus to what is missing.
7. **The review's platform control lists only the declarations the app runs on, and says in a sentence
   why another is absent.** Not done: a choice the content cannot run, shown disabled with its
   `platformPickerLine`, because `platformPickerLine` words one feature's refusal for the picker of
   that feature; an app can be kept off a platform by several features and by its files, which V13 says
   whole. Part 12's `ReadingReview.runsOn` holds only offered choices.
8. **The address names the app, never a stored reading.** It holds the Project, the server, the
   project space and the HQ app's id (3.2). Not done: an address that holds a reading's id, because
   each read mints its own and nothing keeps one, so the id would name nothing a second page load
   could find. The address is therefore also something a person can send: a teammate who opens it
   reads the app with their own key, for the Project it names.
9. **A new primitive, `radio-group`.** Three screens need one-of-several rows with lines,
   `components/shadcn` has none, and `components/CLAUDE.md` forbids a hand-rolled one (12.2).
10. **"Stop publishing here" is on every deployment's card, not only a brought-in app's.** Part 10's
    ending is a state of any deployment (its section 8), and a Nova-made app's team can want the same
    thing. Not done: offering it only on the card of an app that was brought in, as a way a bring-in
    ends, because the helper's sentence is true of a Nova-made app's deployment too (11.1).
11. **The home list gains no section for an app that is being read** (10). A read is one request of
    seconds that leaves nothing behind, so there is no half-done work to list, to continue or to
    remove. Not done: a list of apps a person read lately, kept in the browser, because an account
    shown from a copy would be a list CommCare HQ may have left. The two needs such a list would
    meet are met as they are: the address reads the app as it stands now, and Copy the list (7.5)
    is how a person keeps what one read found.
12. **The header's button and the check on open are part 15's.** A check when the builder opens, and
    the one button it can show, are planned there (its section 8) with the rule that nothing in the
    builder waits on them. This part places the button beside the notice chip (12.1) and adds no
    other header control.
13. **The account's links use HQ's position addresses.** Each group links to the page of CommCare HQ
    that holds its place, where the place has a page (7.2, 7.4). A finding's place holds positions
    (part 01, 8.1), and HQ serves those addresses on purpose and tests them (7.4). Not done: an
    address built from a menu's or a form's own HQ id, because the app's real ids are not on a
    finding.
14. **Over MCP the first-publish list is on each `runs_on` entry of the review, not once on the
    review.** Evidence: part 09's own 12.1 makes the list a fact of a declaration choice, three of
    whose entries change with it, and `bring_in_hq_app` takes the choice as an argument. Not done: one
    list on the review, beside its digest, because it could only be the preselected row's, and an agent
    would relay it for whatever row the user took. Part 09's 12.2 states the placement the same way.
    What is served is part 09's one object, `first_publish` (its `firstPublishLines` value in snake
    case, 14.3), built with the surface `review` on each entry; `check_project_space_compatibility`
    carries the same object at its top level, built with `publish`, because a deployment has one list:
    the chosen row's, as it stands for where the app runs now.
15. **A single Project is stated, not asked.** `bring_in_hq_app` never chooses for the person (14.4),
    and where a person can edit exactly one Project there is no choice to make for them: the screen
    shows that Project as text in the field's place (4.1), and the skill and `read_hq_app`'s
    description say its name and why it matters and go on (16.1, 14.3). Not done: a skill that always
    asks, even when there is only one Project, because asking a question with one answer is a gate with
    nothing behind it. With two or more, the agent asks and never picks.
16. **A review that comes back keeps the person's answers** (`carryAnswers`, 3.3). A create that
    answers `changed` with a review, and the read after a `read-again`, each put the person in front
    of a review with a new digest. Not done: discarding every answer made for another digest, because
    the change may have touched none of them, and a person would then choose a name, a platform and
    each table a second time. What cannot be kept is said (8.10), and across a reload nothing is
    kept (3.2).
17. **A reload during a create sends the same create again, from one key in the tab** (9.1). Not
    done: reading the app again as every other reload does, because the read would then answer
    `already-in-nova` for the app the person had just made, or a review they would answer twice. Not
    done either: a record on the server of a create in flight, which would be the stored reading
    this design does without. A repeat of a create is safe by part 12's own rule (its 6.6), so the
    tab only has to remember what it sent.
18. **A long account over MCP is paged by a cursor that carries the account's digest** (14.3). Each
    page is a fresh read, since nothing is kept. Not done: a bare index, because two pages could
    then come from two versions of the app and a client would stitch them into one list that never
    existed. Not done either: the whole account in one answer, which a long one would push past
    what a client accepts (`lib/mcp/resultSize.ts::MAX_RESULT_SIZE_CHARS`).
19. **Nova's own failure is a screen of its own, and the page never sends that request again by
    itself** (5, 9.1). A lost response is retried once, because the network may have been the cause.
    Not done: one retry rule for both, because a defect answers the same way twice, and a silent
    second try would only delay the sentence that says the fault is Nova's.

**The outline, item by item, where it touches this part.**

| Item | The outline | Settled |
|---|---|---|
| 5, "Entry points. Import from the builder and over MCP, each confirming the platform declaration before the app exists" | a confirmation step | here: three entries (2); the declaration is a preselected choice of the review, the person's to change, and a required argument over MCP (8.3, 14.4; `../6-bring-in.md`, "What changed from the outline, and why", item 5) |
| 9, "The person confirms it, or narrows it, before the app exists" and "the first publish after import asks before changing the setting" | | here: 8.3, with V12a and V12b saying what the first publish will ask |
| 9, "Offered the split, else refused … the person confirms it before the app exists" | | here: the split is a row of the same choice (V10). An app no declaration runs is part 06's `no-platform-runs-everything`, an account finding drawn by 7.2 |
| 9, "Defect 20's confirmations" and 10, "Confirmations" | asked at import | not asked at a bring-in (part 10, 6.5). The review says which plan features Nova will not ask about (`adoptionRecordedFeaturesLine`), and the first publish asks the rest |
| 4, "Drift merging" | step 6 | part 15, which brings a change in with no merge. This part keeps the layout of the stop and the card (11.1, 11.3) |
| 10, "Ending a deployment, this step's lifecycle" | | part 10 for the state; here for the card, the drift stop and the confirmation (11.1, 11.3) |
| 1 to 3, 6 to 8, the cutover | | no screen or tool of this part; parts 01 to 12 and 14 |

---

## Files

**New.**

| File | Holds |
|---|---|
| `components/bring-in/bringInModel.ts` | the flow's pure model (3.3): `BringInModel`, `PickerModel`, `BringInCall`, `BringInEvent`, `BringInScreen`, `BringInAct`, `CreateLead`, `initialBringInModel`, `reduceBringIn`, `screenOf`, `nextAct`; `ReviewAnswer`, `ReviewAnswers`, `initialAnswers`, `unansweredChoices`, `bringInInputOf`, `chosenDeclaration`, `carryAnswers`; `knownAppName`, `circumstanceContextOf`; `BRING_IN_RESUME_WINDOW_MS`, `resumableCreate`; `StopAction`, `STOP_ACTIONS` (6.2); `placeGroupKey`, `AccountItem`, `AccountGroup`, `accountGroups`, `accountHeading`, `countLine`, `accountAsText` (7); `DeclarationRow`, `declarationRows`, `DeclarationWhy`, `declarationWhy` (8.3) |
| `components/bring-in/bringInClient.ts` | `BringInAnswer`, `BringInStreamEnd`, `fetchHqApps`, `postRead`, `postCreate` (3.3) |
| `components/bring-in/useBringIn.ts` | the hook: the reducer, the one effect over `nextAct`, the two session-storage keys (3.3, 9.1, 9.2) |
| `components/bring-in/BringInFlow.tsx`, `BringInPicker.tsx`, `BringInReading.tsx`, `BringInStop.tsx`, `BringInAccount.tsx`, `BringInReview.tsx`, `ReviewRunsOn.tsx`, `ReviewTableChoice.tsx`, `FirstPublishLines.tsx` | the screens (12.1) |
| `components/builder/HqNotConnected.tsx` | the connection aside, extracted from `PublishDialogBody.tsx::NotConfigured` (4.4) |
| `components/builder/StopPublishingDialog.tsx` | the confirmation the card and the drift stop share (11.1) |
| `components/shadcn/radio-group.tsx` | `RadioGroup`, `RadioGroupItem` (12.2) |
| `design/components/core/RadioGroup.prompt.md` | the primitive's contract (17.4) |
| `app/api/commcare/hq-apps/route.ts` | `GET`, the picker's list (4.2) |
| `app/api/commcare/connection/route.ts` | `GET`, the person's own stored connection (4.4) |
| `lib/routing/bringInLocation.ts` | `BringInLocation`, `bringInLocation`, `bringInHref` (3.2) |
| `lib/publish/bringInCopy.ts` | every string of "Copy" that is this part's, `platformOutBlock`, M1 and M4 to M7 |
| `lib/deployment/reading/pickerTypes.ts` | client-safe: `HqAppPickerRow`, `HqAppPicker` (4.2) |
| `lib/deployment/reading/picker.ts` | server-only: `listHqAppsForPicker` (4.2) |
| `lib/deployment/reading/answers.ts` | client-safe: `AccountAnswer`, `accountOfOne` (3.3), which the model and MCP's projection both read |
| `lib/deployment/hqPlaceUrl.ts` | client-safe: `hqPlaceUrl` (7.4) |
| `lib/mcp/tools/listHqApps.ts`, `readHqApp.ts`, `bringInHqApp.ts`, `stopPublishing.ts`, `managedData.ts` | the six tools (14.1 to 14.6) |
| `lib/mcp/tools/readingProjection.ts` | `describeReading`, `parseAccountPage`, `accountDigest`, `mapReadingRefusal`, `ReadingProjection` (14.3) |
| `e2e/lib/bring-in-client.tsx`, `e2e/lib/bringInSeed.ts`, `e2e/tests/browser/bring-in.spec.ts`, `e2e/tests/app/bring-in.spec.ts` | the peer, the seed and the two specs ("Tests") |
| the Vitest and Postgres files of "Tests" | as that section names them |
| `content/docs/bringing-in-from-commcare-hq.mdx` | the new page (17.1) |
| `../nova-plugin`: `skills/bring_in/SKILL.md` and its `.dev-plugin` mirror | the skill (16.1) |

**Changed.**

| File | What changes |
|---|---|
| `app/(app)/(site)/app-list.tsx` | the entry button (2) |
| `app/(app)/(site)/page.tsx` | the empty state's line (2), and `RefreshStaleAppList` in the empty branch (10) |
| `app/(app)/(site)/app-list-body.tsx` | the restore toast (11.4) |
| `app/(app)/(site)/RefreshStaleAppList.tsx` | its header ("Contracts") |
| `app/(app)/build/[id]/[[...path]]/page.tsx` | `freshBuildPage` builds and passes `BringInSeed` (3.2) |
| `components/chat/StartFromScratch.tsx` | the second button and `onBringIn` (2) |
| `components/chat/ChatSidebar.tsx` | the `takeover` prop (3.1) |
| `components/chat/ChatContainer.tsx` | mounts `BringInFlow` as `takeover`, handing it the seed, its `landCreatedAppReceipt` and its `projectToast` (3.1, 9.2) |
| `components/builder/BuilderLayout.tsx` | passes `BringInSeed` down; shows the toast after a landing that loaded a page (9.2) |
| `components/builder/CommCareConnectionContext.tsx` | `refresh`, `isRefreshing`, `refreshFailed` (4.4) |
| `components/builder/PublishPanel.tsx` | the context's refresh in place of its router transition (4.4) |
| `components/builder/PublishDialogBody.tsx` | `HqNotConnected` in place of `NotConfigured`; `PublishDialogProps.hqConnectionRefreshFailed`; the first-publish section (11.2); the drift stop's block (11.3); `publishPlanCopy` and `PublishPlan` leave it |
| `components/builder/publishOutcome.ts` | `PublishPlan` and `publishPlanCopy`, moved from `PublishDialogBody.tsx`, with the two new arms (11.2) |
| `components/builder/DeploymentStatus.tsx` | the brought-in lines, the ended card and the prop `canStop` (11.1) |
| `components/builder/app-setup/publishingSectionModel.ts` | `broughtInOf`, `cardKind`, `broughtInElsewhere`, the compact row's label (11.1) |
| `components/builder/app-setup/PublishingSection.tsx` | passes `canStop` (11.1) |
| `components/builder/detail/appSettings/AppPlatformsSection.tsx`, `lib/domain/platforms.ts` | the three lines of `CHOICES` move to `PLATFORM_DECLARATION_LINES`, which `CHOICES` reads (8.3) |
| `lib/routing/useClientPath.ts` | `useBuilderSearchFrom` (3.2) |
| `lib/deployment/reading/index.ts` | exports `listHqAppsForPicker` |
| `lib/deployment/index.ts` | exports `hqPlaceUrl` and `accountOfOne`, and `HqAppPicker`, `HqAppPickerRow` and `AccountAnswer` as types |
| `lib/mcp/server.ts` | registers the six tools (14.1) |
| `lib/mcp/errors.ts` | `BringInErrorType`, `BringInToolError`, the payload's four fields, the branch of `toMcpErrorResult` (14.8) |
| `lib/mcp/tools/deploymentProjection.ts`, `deploymentTools.ts`, `checkProjectSpaceCompatibility.ts`, `uploadAppToHq.ts`, `getHqConnection.ts` | the descriptions and projections of 14.7 |
| `lib/agent/authoring/reference.ts` | the guide's paragraph (15.1) |
| `e2e/lib/smokeProfiles.ts`, `e2e/lib/smokeSeedFactory.ts` | the `bring-in` profile and its builder |
| `e2e/tests/browser/publishing.spec.ts` and its peer | the cases of "Tests" |
| `lib/mcp/__tests__/servedSchemas.test.ts`, `errors.test.ts`, `compatibility.postgres.test.ts`, `deploymentTools.postgres.test.ts`; `components/builder/app-setup/__tests__/publishingSectionModel.test.ts`; `components/builder/__tests__/publishOutcome.test.ts` | the extensions of "Tests" |
| `design/readme.md`; `components/CLAUDE.md`, `components/builder/CLAUDE.md`, `lib/routing/CLAUDE.md`, `e2e/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `lib/agent/authoring/CLAUDE.md`, `lib/agent/CLAUDE.md`, root `CLAUDE.md` | the rows of "Contracts" |
| `content/docs/meta.json`, `index.mdx`, and the pages of 17.2 and 17.3 | section 17 |
| `../nova-plugin`: `skills/upload_to_hq/SKILL.md` and its mirror, both `plugin.json` files, `README.md` | section 16 |

**Used and not changed.** `components/builder/PublishDialog.tsx`, which forwards `PublishDialogProps`
whole (4.4); `e2e/lib/routes.ts` ("Tests"); `lib/ui/appListFreshness.ts`, whose one caller already
marks the list for every landing (10); part 09's `lib/publish/firstPublishCopy.ts` and
`firstPublishChangeIds.ts`, and its `DeploymentView.firstPublish`, `readFirstPublishStates` and
`firstPublishOf`, which this part reads and calls.

**Removed.** `PublishDialogBody.tsx`'s private `NotConfigured`, in favor of `HqNotConnected`.

This part adds no migration, no column and no `lib/db/pg.ts` change, no `lib/hostnames.ts` entry
(4.2, 4.4) and no `scripts/test-schema.ts` entry (15.3).
