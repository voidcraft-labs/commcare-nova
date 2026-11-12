# Step 6, part 13: The experience

This part plans everything a person, an agent or a reader of the docs meets when an app is brought in
from CommCare HQ: the three entry points; the flow as one URL-backed surface of `/build/new` (choose,
read, a stop, the account, the review, create, land); the home list's rows; what the Publishing card,
the Publish dialog, the drift stop and a restore say afterwards; the components, their pure state
model and their Playwright specs; the six MCP tools stack B registers and what five existing tools
gain; the guide, `MODEL_CONTEXT_VERSION` and the billed schema check for stack B; the nova-plugin
skill and its sweep; and the public docs. It plans pull requests **B11** (the experience) and **B12**
(MCP, the guide, the plugin skill, versions, the billed check) in full. It draws exactly the states,
answers and sentences that part 01 (`01-the-bar-and-the-manifest.md`, A2, A3), part 05
(`05-reading-commcare-hq.md`, B1), part 09 (`09-acceptance-and-the-first-publish.md`, B7), part 10
(`10-identity-and-the-ledger.md`, B8), part 11 (`11-project-data.md`, B9) and part 12
(`12-the-reading-and-the-birth.md`, B10) define, and adds no reading state. Pull requests are named
by the plan's ids (A1 to A11, B1 to B15; the top-level file `../6-bring-in.md`, "Work items"), parts by
their number and file name. The other parts it cites are part 04 (`04-names.md`, A9), part 06
(`06-the-reader-forms.md`, B2, B3), part 07 (`07-the-reader-cases-menus-lists.md`, B4, B5), part 08
(`08-the-reader-expressions.md`, B6), part 14 (`14-proof.md`, A1, B13) and part 15
(`15-stack-contracts-and-exit.md`, A10, A11, B14, B15). A citation "(part 12, 4.3)" is section 4.3 of
that part's file. Stack B's order is B1 to B6, B8, B9, B7, B10, B11, B12, B13, B14, B15 (part 09,
Departure 14), so B7 sits above B8 and B9 and beneath B10.

Citations are `path::symbol`: Nova at `main` `15a00a97`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. This
part couples to CommCare HQ in one place of its own, the addresses of five HQ pages the account links
to (section 7.4), read at `d6c6e16d8ae1` and lifecycle-cited there. Every other HQ fact it shows a
person is another part's, cited where it is used.

Versions: `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.14"` at `15a00a97`
and `"v7-hq-round-trip-bring-in.b9"` beneath B11: B6 sets `.b6` (part 08's opening) and B9 sets
`.b9` (part 11's opening), each for a guide sentence, and no other pull request of stack B beneath
B11 moves it. B11 moves nothing. B12 moves it to `"v7-hq-round-trip-bring-in.b12"`, because it adds
one paragraph to the authoring guide (section 15). `lib/db/appTests.ts::RUNTIME_VERSION` stays `19`,
the value A9 leaves (part 04, 3.4): no pinned document and no evaluator changes in B11 or B12.

| Section | Owns | Pull request |
|---|---|---|
| 2 | the three entry points | B11 |
| 3 | the flow as one surface: where it mounts, its URL, what a refresh does, its pure state model | B11 |
| 4 | choosing a Project, a project space and an app; the picker's route and the connection's | B11 |
| 5 | reading, with its named steps | B11 |
| 6 | a stop | B11 |
| 7 | the account | B11 |
| 8 | the review | B11 |
| 9 | creating, landing, and what the builder shows first | B11 |
| 10 | the home list's rows and the empty state | B11 |
| 11 | after the app is in: the Publishing card, the first publish, the drift stop, a restore | B11 |
| 12 | component inventory, primitives, state | B11 |
| 13 | accessibility; empty, error and loading states of every screen | B11 |
| 14 | MCP: six tools registered, five tools changed, error shapes, budgets, `servedSchemas` | B12 |
| 15 | the guide, `MODEL_CONTEXT_VERSION`, `scripts/test-schema.ts`, the billed check | B12 |
| 16 | the nova-plugin: the `bring_in` skill, the `upload_to_hq` sweep, the version | the plugin's pull request, merged after stack B is live |
| 17 | public docs and `design/readme.md` | text fixed here; B14 lands the pages, B11 lands `design/` |

---

## Decisions in brief

1. **Three entries, one destination** (2): an outline button beside "New app", a line under "Get
   started" in the empty state, and a second outline button under the "or" on `/build/new`. Each
   leads to `/build/new?hq=choose`.
2. **The flow is a state of `/build/new`, never a dialog** (3.1). It takes the centred column in place
   of the composer, inside `ChatContainer`'s tree, so a created app lands through part 12's
   `landCreatedAppReceipt` and "Creation never navigates" holds.
3. **The URL is `/build/new?hq=choose` while choosing and `/build/new?hq=<reading id>` from the moment
   a reading exists** (3.2). A refresh of the first shows the picker with its defaults; a refresh of
   the second loads the reading and shows whatever state it is in; a reading that is already an app
   loads `/build/<id>`.
4. **The whole flow is one pure model** (3.3): a reducer over events and a function that says what
   the driver does next. Vitest tests the model; no component holds a decision.
5. **Step one asks three things in one screen** (4): the Project ("Add it to", preselected to the
   Project the tab is looking at where the person can add to it), the project space, and the app.
   The picker reads CommCare HQ through one new route, `GET /api/commcare/hq-apps`, which
   `/api/commcare` already admits.
6. **A row the person cannot bring in says why and what to do, in the list** (4.3): already in Nova
   with Open; already in Nova in a Project they are not part of, with who and when and the two ways
   forward. A linked or deleted app is learned at the first read step, as a stop (6).
7. **No connection is a step of the picker, not an error** (4.4): the connection aside the Publish
   dialog shows, extracted and reworded for reading. "Check connection" reads the connection through
   one new route, `GET /api/commcare/connection`, and never through the Next router, in the picker
   and in the Publish dialog alike (Departure 3).
8. **Reading shows the step that is running, by name, and nothing a row does not hold** (5): part
   12's `READING_PHASE_LABELS`, the files' count, a reassurance after twenty seconds, and what
   leaving does: Nova finishes the step in flight and carries on when the person comes back, and
   the screen says where the reading is kept, by Project. No percent, no ladder of results.
9. **A stop is its own screen and is never mixed into an account** (6): part 01's block, the one
   sentence "Nothing was created, and nothing changed in CommCare HQ", and the actions the code
   allows.
10. **The account groups findings by place in the app's own order, under three labels explained
    once** (7), each group with a link to that page in CommCare HQ. Under the groups it says a later
    check may find more (part 01's `ACCOUNT_CHECK_AGAIN_LINE`), and it ends in Copy the list, Check
    again and Done.
11. **The review is one screen with no ticks** (8). Where it runs is a preselected choice with the
    reason beside it; the date-and-time split is one of the choices; a table that meets one the
    Project has is two named answers; "After it's in" says what follows, and part 09's "What the
    first publish changes" lists it from the chosen row's own list, redrawn when the row changes.
12. **"Bring it in" stays enabled** (8.9). Pressed with a table choice unanswered, it sends nothing,
    moves focus to that choice and says what is missing.
13. **A brought-in app lands on its own home in the builder, with one toast that leads to Publishing**
    (9.3). Nothing is written into the conversation.
14. **The home list gains "Coming in from CommCare HQ"** (10), a sibling of "Designs in progress",
    drawn from part 12's `listOpenReadings`.
15. **The Publishing card of a brought-in app says where it came from, and every card with a live
    app mapping offers "Stop publishing here" to an admin or owner** (11.1; Departure 10), the
    members whose role allows `delete`. An ended deployment draws part 10's line and no ladder.
16. **The first publish says what it changes in the Publish dialog and over MCP** (11.2), from part
    09's `DeploymentView.firstPublish`, the list the person reviewed, which part 09 keeps on the
    read baseline until Nova's first push (its 12.3). B11 adds no column and no migration.
17. **A drift stop whose changes hold the app's own offers "Stop publishing here" under the list of
    changes** (11.3), whatever the app's origin, with part 10's origin-aware sentences.
18. **B12 registers six MCP-only tools** (14): `list_hq_apps`, `read_hq_app`, `bring_in_hq_app`,
    `stop_publishing`, `refresh_managed_data` and `set_lookup_table_management`. The Solutions
    Architect is given none of them.
19. **`bring_in_hq_app` takes every answer as a required argument and has no default** (14.4): the
    name, where it runs, the split and each table choice. The Project is the reading's, chosen at
    `read_hq_app`.
20. **`check_project_space_compatibility` returns `first_publish`** (14.7): part 09's
    `firstPublishLines` value, built for the publish surface, for an app brought in and not yet
    published, and null otherwise. `read_hq_app` returns the same object on each `review.runs_on`
    entry, built for the review. An agent relays `workers.lines` first, then `hq_only.lines`, each
    `sentence` as written, then `reassurance` where it is not null, then `note`.
21. **The guide gains one paragraph and `MODEL_CONTEXT_VERSION` becomes
    `"v7-hq-round-trip-bring-in.b12"`** (15). The billed check sends the entries the schema-hash
    run shows moved, `getLookupTables` and `getOrganization` expected, on the person's yes.
22. **The plugin gains the skill `bring_in`, and `upload_to_hq` is swept for five claims, with one
    sentence added for part 01** (16). Its version becomes `2.5.0`, and it merges after stack B is
    live.
23. **One new docs page, `content/docs/bringing-in-from-commcare-hq.mdx`** (17), and the sentences of
    nine existing pages (the eight of 17.2 and `mcp/tools.mdx`, 17.3), the two Claude Code pages that
    describe the plugin's commands among them.

---

## Executed during planning

Read, by file and symbol. Nothing was run but `rg`, `sed` over single files and directory listings.

- **The other parts of this plan**: part 01, sections 6.5, 8 and 9; part 04, section 3.4; part 05,
  sections 4, 5, 11 to 13 and "Copy"; part 06, section 16.3 and Departure 11; part 08, its opening,
  run E7 and "Copy" (C7, C13, C14); part 09, sections 11 and 12, "Copy", "Contracts", "Files by pull
  request", "What this part needs of other parts" and "What other parts read from this one"; part
  10, sections 5.4, 5.5, 6.5, 7, 8 and 9 and "Copy"; part 11, sections 7, 12, 13 and 14.1 and
  "Copy"; part 12, its opening, sections 2.3 to 2.7, 3.1, 3.2, 3.5, 3.8, 3.9, 4, 5.1, 5.3, 6.5, 6.6,
  7, 9 and 10, "Copy", "What this part needs of other parts" and "What other parts read from this
  one".
- **The design system**: `design/readme.md` whole; `components/CLAUDE.md` whole;
  `components/builder/CLAUDE.md`, "Creation never navigates", "Publishing" and "App setup, Publishing";
  `e2e/CLAUDE.md`, every bullet from "Hermetic, free, no real GCP" through "Case-workspace visual QA
  has one canonical fixture".
- **Home**: `app/(app)/(site)/app-list.tsx::AppList`; `page.tsx::HomePage`, `GetStarted`,
  `AppListFallback`; `designs-in-progress.tsx::DesignsInProgress`, `DesignRow`;
  `app-actions.ts::RestoreAppResult`; `RefreshStaleAppList.tsx` and
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
  `app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS` and `app/api/mcp/route.ts::maxDuration`;
  `lib/hostnames.ts::AS_ORIGIN`; `node_modules/zod/v4/core/json-schema-processors.js`, the object
  processor (when it writes `additionalProperties: false`).
- **Shared pieces**: `lib/commcare/servers.ts` whole; `biome.json`, the `noRestrictedImports` rule
  over `@/lib/commcare` and its list of allowed consumers; `lib/deployment/types.ts::
  deploymentServerLabel`, `DeploymentConfirmationKey`; `lib/deployment/service.ts::hqAppUrlFor`;
  `lib/deployment/setupArtifact.ts::hqBase` and the addresses it builds; `lib/ui/toastStore.ts::
  showToast`, `showProjectToast`; `lib/session/hooks.tsx::useCanDelete`;
  `components/shadcn/badge.tsx` (its variants) and the list of `components/shadcn`;
  `lib/domain/uuid.ts::CANONICAL_UUID_PATTERN` through `lib/agent/authoring/workId.ts`;
  `lib/publish/planFeatures.ts::PLAN_FEATURES`; `lib/projects/membership.ts::listUserProjects`,
  `ProjectSummary`; `lib/db/settings.ts::getCommCareSettings`, `CommCareSettingsPublic`;
  `docs/testing.md`, "Do not pin incidental strings" and the MCP handler paragraph.
- **The agent**: `lib/agent/CLAUDE.md`, the paragraph that binds `MODEL_CONTEXT_VERSION`;
  `lib/agent/authoring/reference.ts::AUTHORING_REFERENCE` (its `workflows` entry);
  `lib/agent/authoring/__tests__/platformGuide.test.ts` (its head); `lib/chat/__tests__/
  compaction.test.ts` (that it imports the constant); `scripts/test-schema.ts`, its header and
  imports.
- **The plugin**: `../nova-plugin/.claude-plugin/plugin.json`; `skills/upload_to_hq/SKILL.md`, the
  passages quoted in section 16; `skills/find/SKILL.md`; `README.md`; the `.dev-plugin/` mirror.
- **Docs**: `content/docs/meta.json`; `index.mdx`; `publishing.mdx`, its opening, "The six stages",
  the head of "Checked" and "On CommCare HQ" to "Changes made in CommCare HQ";
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
  file above"). B11 extracts its frame into `components/builder/HqNotConnected.tsx` with the words
  as props (4.4).
- **A read in flight holds no result to show.** A reading's row holds no count before its outcome:
  part 12 (2.3) stores the account or the review and nothing of a read in flight but `phase`,
  `media_done`, `media_total` and the mark that a step is running. So no step of the reading screen
  can carry a result of its own ("2 menus, 5 forms", "1 table", "4 levels, 1,240 places"). The
  reading screen shows the step's name and the files' count (5).
- **A step cannot be stopped.** The two long routes do not pass the request's signal to the
  service, so a closed tab does not stop a step (part 12, 4.3), and a "Stop reading" button would
  stop nothing. The screen offers leaving, which is safe, and the home row offers Remove (5).
- **The picker has no row state for an app in Nova's recently deleted.** The claim passes over a
  deleted holder (part 10, Departure 1), so an HQ app whose only Nova app is in recently deleted is
  free in the picker.
- **A disabled "Bring it in" cannot say what is missing.** A disabled button cannot say what is
  missing to a keyboard or screen reader user at the moment they press it. Decision 12 keeps the
  button enabled.
- **The platform choice is not reusable from `AppPlatformsSection.tsx`.** Its `CHOICES` lines are a
  module constant of that file, and its check (`checkPlatformChange`) reads a saved app through the
  reconciler. The review has no app. B11 moves the three lines to
  `lib/domain/platforms.ts::PLATFORM_DECLARATION_LINES`, which both read (8.3).
- **"Refresh from CommCare HQ" on the Publishing card is A3's.** It is built by A3 (part 01, 6.5),
  with part 01's Departure 5 on when it writes. B11 adds nothing to the kept list.
- **B12 registers six tools, not three.** Beside the three that bring an app in, parts 10 and 11
  give B12 three more (`stop_publishing`; `refresh_managed_data`, `set_lookup_table_management`):
  part 10's Departure 3 and part 11's section 12.4. B12 registers six (14).
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
  B11 gives the context a refresh of its own that does not touch the router (4.4, Departure 3).
- **`RefreshStaleAppList` as it stands does not cover a home reached with Back after a reading
  changed.** It refreshes only where `consumeAppListStale()` is true, and the
  one caller of `markAppListStale()` is `ChatContainer.tsx::installCreatedApp`. The home's empty
  state does not mount it at all. B11 marks the list stale wherever the flow changes a row, and
  mounts the refresher in the empty state too (12.3).
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

---

## Written and not yet run

- **E1, the billed schema check for stack B (B12).** Stack B asks one billed check, this one, and its
  list is whatever the schema-hash run shows moved (part 15, `15-stack-contracts-and-exit.md`, section 3,
  rule 7): the implementer runs `npx tsx --conditions=react-server scripts/inspect-tool-schema-hashes.ts`
  at the `main` stack B was cut from and at B12's head (free, no network), and the list is every
  Solutions Architect tool whose hash differs. `getLookupTables` and `getOrganization` are expected, both
  moved by B9. Where: the implementer's shell, `npm run test:schema -- <name>` once for each name on the
  list, each one live OpenAI request on the person's key, never the bare command. Asked once, as the
  first act of B12, in these words, with the count and the names the run gave in place of these: "Stack B
  changed the descriptions of two tools the Solutions Architect holds, getLookupTables and
  getOrganization. Checking that the provider still accepts them costs two live OpenAI requests on your
  key. May I run them?" A further name joins the list, and the question then names it as one the plan did
  not expect; an expected name whose hash did not move leaves both. Outcomes: **A**, every entry answers
  without error: nothing lands, and B12's description records each pass. **B**, an entry is refused: the
  entry's description or schema is corrected in B12 in the file B9 changed it in
  (`lib/agent/tools/getLookupTables.ts` or `lib/agent/tools/organization.ts`, which "Files by pull
  request" lists for this outcome alone), and that one entry is sent again on a fresh yes. **C**, the
  person says no or not now: nothing is sent, B12 is not merged, and the question is asked again when
  they next open the stack. No other entry is expected: B6 changes the guide and no tool input schema
  (part 08, run E7), B8 changes only tools MCP alone serves (part 10's opening: "stack B moves the value
  in B6, B9 and B12 alone"), no other pull request of stack B changes a tool the Solutions Architect is
  given, and the six tools of section 14 are served by MCP alone, which
  `lib/mcp/__tests__/servedSchemas.test.ts` holds without billing.
- **Part 05's G2, consumed here (B11).** Outcome C (the app list holds no remote app) removes the
  `remote-app` row from `STOP_ACTIONS` (6.2) and from the model's test table in B11, since B1 then
  never lands the code. Outcomes A and B change nothing here.
- **Part 05's G7, consumed here.** `table-rows-unreadable` is an account finding, drawn by 7.2's
  circumstance block whatever its code, so neither outcome changes a line of this part.
- **Part 10's G1 and G2, part 11's R1 and R2.** No outcome changes a screen or a tool of this part.
  G2's outcome B adds one entry to part 09's register, which sections 8.8 and 11.2 draw as they draw
  every entry.
- **The Playwright specs of B11** are not a gated run: they decide no fact. They run in the pull
  request's own CI on hosted runners and never on the person's laptop ("Tests").

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

## 2. Entry points (B11)

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

## 3. The flow as one surface (B11)

### 3.1 Where it mounts

The flow is a state of `/build/new`. `design/readme.md` gives the dialog pattern to publishing
("Publish opens in place, including from Preview"), which acts on an app that is open. Bringing an app
in has no app to open over, its account can run to hundreds of lines, it must survive a reload and be
reachable from a home row, and its last act is a birth, which `components/builder/CLAUDE.md` binds to
the mounted tree: "a route change swaps `BuilderProvider`'s `key={buildId}` and rebuilds every store
under it". A dialog over the home list could do none of the four.

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
not an existing app, `messages.length === 0`, and the URL holds an `hq` value (3.2). A design in
progress in the tab therefore never loses its conversation to a typed URL.

The tab's own role is not one of the conditions. `ChatContainer`'s `readOnly` is `!canEdit` for the
Project the tab is looking at (`lib/session/hooks.tsx::useProjectCanEdit`), and an app is brought in
to a Project the person chooses, which need not be that one: someone who only views the active
Project and edits another can add an app to the other. Who may start one is decided by
`BringInSeed.projects` (3.2): where it is empty the picker shows the sentence of 4.5 and no fields.
A reading opened by its address is shown whatever that list holds, since part 12 lets its person see
and remove a reading after losing `edit` (its 2.5). The entries of section 2 stay under
`canCreateApp`, the role in the active Project, as "New app" is, so a viewer of the active Project
reaches the flow by its address or after switching Projects.

The band is untouched: "`/build/new` before a send has no app, so it claims nothing and wears the site
band exactly" (`components/CLAUDE.md`), and that stays so through the whole flow, until
`installCreatedApp` lands an app and the builder claims the band as it does for every birth.

### 3.2 The URL, and what a refresh does

```ts
// lib/routing/bringInLocation.ts (new, client-safe, pure)
export type BringInLocation =
	| { readonly kind: "none" }
	| { readonly kind: "choose" }
	| { readonly kind: "reading"; readonly readingId: string };
/** Reads the `hq` value of a query string: `choose`, a UUID, or anything else as `none`. */
export function bringInLocation(search: string): BringInLocation;
/** The address of a location: `/build/new`, `/build/new?hq=choose` or `/build/new?hq=<id>`. */
export function bringInHref(location: BringInLocation): string;
```

A reading id is admitted only where it matches `lib/domain/uuid.ts::CANONICAL_UUID_PATTERN`, the
pattern work ids are held to (`lib/agent/authoring/workId.ts::workIdSchema`). Any other `hq` value is
`none`: the page shows the composer and says nothing.

| The address | Shows | A refresh |
|---|---|---|
| `/build/new?hq=choose` | the picker (4) | the picker again, with the Project preselected to the tab's and nothing else chosen. Nothing was stored, so nothing is lost but the selection |
| `/build/new?hq=<id>` | the reading with that id, in whatever state its row holds (5 to 9) | loads the row through `GET /api/commcare/readings/<id>` and shows that state. The answers of a review are not kept across a refresh: the review opens again with Nova's preselected choices. A row in state `created` replaces the page with `/build/<id>` (`window.location.replace`). A row that is not found shows the `reading_not_found` sentence (part 12, C1) with **Choose an app** and **Go to your apps** |

Moves between the two are History-API calls on the mounted tree: `pushBuilderHistory(bringInHref(…))`
to enter the picker and to leave a reading for the picker, and `pushBuilderHistory(…, true)` (replace)
when `startReading` answers, exactly as the first `data-design-session` scope replaces the URL with
`/build/new?design=<id>` (`components/CLAUDE.md`, "Build recovery is URL-backed"). The reading's id is
the app's id (part 12, Decision 1), so the address a person bookmarks while reading differs from the
app's by one path segment.

**No act of the flow calls the Next router while the flow is on screen.** `pushBuilderHistory`
spreads the entry's existing state into the one it writes (`historyPolicy.ts::
scopedBuilderHistoryState`), Next's marker among it, and Next's patched `pushState` and
`replaceState` leave its canonical address alone for a state that carries that marker. So after the
first move above, Next still holds the address the page was loaded at, and any router change (a
`router.refresh()`, a revalidating Server Action) makes its history updater write that address
back (`next/dist/client/components/app-router.js`), which is the rule `components/builder/CLAUDE.md`
states for a creation: "the router re-render carrying the revalidation restores Next's own
canonical URL". Every read and write of the flow is therefore a plain `fetch` of a route, and the
two acts that leave the page for good (a removed reading to `/`, a created reading opened by its
address) are `window.location.replace`, a page load. Section 4.4 holds "Check connection" to the
same rule.

**The first render agrees with the server.** `lib/routing/useClientPath.ts::useBuilderSearch` answers
`""` on the server, which would draw the composer and then swap it for the flow at hydration. So
`page.tsx::freshBuildPage` reads `searchParams.hq`, keeps it only where `bringInLocation` admits it,
and hands the text to the tree; a new hook reads the URL with that text as its server snapshot:

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
	/** `""` or `?hq=…`, already validated. */
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
that already makes three. The tab's Project is the session's (`lib/session/hooks.tsx::useProjectId`),
which the flow reads where it needs to say that a reading lives somewhere else (5, 7.1). The
connection is already in the tree (`CommCareConnectionContext`, provided in `BuilderLayout` from
`getCommCareSettings`).

### 3.3 The state model

`components/bring-in/bringInModel.ts` (new, pure, no React import) is the whole flow as data. The
components render `screenOf(model)` and dispatch events; the driver hook does what `nextAct(model)`
says and dispatches what came back.

```ts
import type { CircumstanceFinding } from "@/lib/publish/hqFindings";
import type {
	BringInInput, CreateResult, ReadingDeclarationChoice, ReadingRefusal, ReadingReview, ReadingView,
} from "@/lib/deployment";
// `LookupTableChoice` is declared beside `LOOKUP_TABLE_CHOICES` in part 11's client-safe
// `lib/deployment/reading/projectData/reviewTypes.ts` (B9), and re-exported as a type from
// `lib/deployment` (part 12, "Files by pull request", B10).
import type { LookupTableChoice } from "@/lib/deployment";
import type { Platform } from "@/lib/domain";
import type { BringInLocation } from "@/lib/routing/bringInLocation";
import type { HqAppPicker } from "@/lib/deployment";                  // 4.2

/**
 * A request that changes or reads the row. At most one is in flight. `load`, `advance` and `create`
 * are started by the driver from `nextAct`. `start`, `check-again` and `remove` are started by the
 * handler of the button that asks for them, which dispatches `call`, makes the request and
 * dispatches what came back (`row`, `removed`, `refused` or `failed`).
 */
export type BringInCall = "load" | "start" | "advance" | "check-again" | "create" | "remove";

export interface ReviewAnswers {
	/** The digest of the review these answer. Answers for another digest are discarded. */
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
	/** `idle` before a project space is chosen; `loading` is what makes the driver list its apps. */
	readonly apps:
		| { readonly kind: "idle" }
		| { readonly kind: "loading" }
		| { readonly kind: "loaded"; readonly picker: HqAppPicker }
		| { readonly kind: "failed" };
	readonly remoteAppId: string | null;
	readonly filter: string;
}

export interface BringInModel {
	readonly location: BringInLocation;
	readonly picker: PickerModel;
	readonly reading: ReadingView | null;
	readonly call: BringInCall | null;
	/**
	 * True once this tab has taken on advancing the row: from its own start or Check again, or
	 * once two rows in a row said no step is running (part 12, 3.2 and 4.4).
	 */
	readonly driving: boolean;
	/**
	 * Rows in a row, the load's among them, that found `reading` or `media` with `stepRunning`
	 * false while this tab was not driving.
	 */
	readonly quietRows: number;
	/** When the wait on screen began, for the reassurance at twenty seconds. */
	readonly waitingSince: number | null;
	/** How many times in a row a call failed with no code. Any call that answers makes it 0. */
	readonly failures: number;
	/** The call that last failed with no code, so the screen can say which act to try again. */
	readonly failedCall: BringInCall | null;
	readonly answers: ReviewAnswers | null;
	/**
	 * The input of a creation that has begun and not ended. Set by `create-asked`, kept through an
	 * `again` answer and a lost request, cleared when creation ends any other way. While it is set
	 * the screen is `creating`, whatever the row's state.
	 */
	readonly pendingCreate: BringInInput | null;
	readonly held: CircumstanceFinding | null;
	/** `CREATE_RESULT_LEADS`' sentence for the last creation that did not create. */
	readonly lead: string | null;
	readonly refusal: ReadingRefusal | null;
	readonly publishing: { readonly done: number; readonly total: number } | null;
	readonly landing: "landed" | "leaving" | "unverified" | null;
	/** True once this tab removed the reading. The next act loads `/`. */
	readonly removed: boolean;
	/** The tag of the table choice focus was last sent to, with a counter so a second press moves it again. */
	readonly needsChoice: { readonly tag: string; readonly nonce: number } | null;
}

export type BringInEvent =
	| { readonly type: "location"; readonly location: BringInLocation }
	/** The connection as the context holds it now: dispatched at mount and whenever it changes. */
	| { readonly type: "connection"; readonly domains: readonly string[] }
	| { readonly type: "picker-project"; readonly projectId: string }
	| { readonly type: "picker-domain"; readonly domain: string }
	| { readonly type: "picker-apps"; readonly domain: string; readonly projectId: string | null;
	    readonly picker: HqAppPicker | null }
	/** "Try again" after a list that failed, and "Check again" on a stop met while choosing. */
	| { readonly type: "picker-reload" }
	| { readonly type: "picker-app"; readonly remoteAppId: string }
	| { readonly type: "picker-filter"; readonly filter: string }
	/** Bring it in, pressed with every answer given: the input becomes `pendingCreate`. */
	| { readonly type: "create-asked"; readonly input: BringInInput }
	| { readonly type: "call"; readonly call: BringInCall; readonly at: number }
	| { readonly type: "row"; readonly reading: ReadingView; readonly from: "load" | "poll" | "start" | "check-again" }
	| { readonly type: "advanced"; readonly reading: ReadingView; readonly again: boolean }
	| { readonly type: "created"; readonly result: CreateResult }
	| { readonly type: "removed" }
	| { readonly type: "refused"; readonly call: BringInCall; readonly refusal: ReadingRefusal }
	| { readonly type: "failed"; readonly call: BringInCall }
	/** "Try again" and "Carry on" after two lost requests: the person asks for the same act again. */
	| { readonly type: "retry" }
	| { readonly type: "answers"; readonly answers: ReviewAnswers }
	| { readonly type: "choice-needed"; readonly tag: string }
	| { readonly type: "landed"; readonly answer: "landed" | "leaving" | "unverified" };

/** `projectId` is the Project to preselect: the tab's where the seed lists it, else the first, else null. */
export function initialBringInModel(location: BringInLocation, projectId: string | null): BringInModel;
export function reduceBringIn(model: BringInModel, event: BringInEvent): BringInModel;

export type BringInScreen =
	| { readonly kind: "none" }
	| { readonly kind: "choose" }
	/** `lost`: the load failed with no code, and the screen offers Try again. */
	| { readonly kind: "opening"; readonly lost: boolean }
	| { readonly kind: "gone"; readonly refusal: ReadingRefusal }
	| { readonly kind: "reading"; readonly reading: ReadingView; readonly lost: boolean }
	| { readonly kind: "stopped"; readonly reading: ReadingView; readonly finding: CircumstanceFinding }
	| { readonly kind: "account"; readonly reading: ReadingView }
	| { readonly kind: "review"; readonly reading: ReadingView; readonly answers: ReviewAnswers }
	/** `lost`: the creation request failed twice, and the screen offers Try again. */
	| { readonly kind: "creating"; readonly reading: ReadingView; readonly lost: boolean }
	/** The app exists and this tab could not open it (9.2). */
	| { readonly kind: "unopened"; readonly appId: string };
export function screenOf(model: BringInModel): BringInScreen;

export type BringInAct =
	| { readonly kind: "none" }
	| { readonly kind: "list-apps"; readonly domain: string; readonly projectId: string | null }
	| { readonly kind: "load"; readonly readingId: string }
	| { readonly kind: "advance"; readonly readingId: string; readonly afterMs: number }
	| { readonly kind: "poll"; readonly readingId: string; readonly afterMs: 2000 }
	| { readonly kind: "create"; readonly readingId: string; readonly input: BringInInput;
	    readonly afterMs: number }
	| { readonly kind: "replace"; readonly href: string };
export function nextAct(model: BringInModel): BringInAct;
```

**The reducer's rules**, each a row of the model's test table:

| Event | The model becomes |
|---|---|
| `location` to `choose` | `reading`, `answers`, `pendingCreate`, `held`, `lead`, `refusal`, `publishing`, `needsChoice` cleared and `failures` 0; `picker` kept, so "Choose another app" returns to the list the person left |
| `location` to `reading` with another id than `reading.id` | `reading` null and everything about it cleared (`pendingCreate`, `landing` and `removed` among it); `failures` 0; `driving` false |
| `connection` | `picker.domains` set. Where it holds exactly one and none is chosen: `domain` that one and `apps: loading`, so one project space is never a choice. Where the chosen `domain` is no longer among them: `domain` null, `apps: idle`, `remoteAppId` null. Otherwise nothing else moves |
| `picker-project` | `picker.projectId`; `apps: loading` where a domain is chosen, because the mark of the person's own open reading depends on the Project, which makes the driver list again |
| `picker-domain` | `picker.domain`, `apps: loading`, `remoteAppId` null, `filter` "" |
| `picker-reload` | `apps: loading` where a domain is chosen; nothing otherwise |
| `picker-apps` | taken only where `apps` is `loading` and its `domain` and `projectId` are still the picker's; `null` is `failed`. `remoteAppId` is cleared where the list holds no row of it that can be chosen |
| `create-asked` | `pendingCreate` the event's `input`; `held`, `lead`, `refusal`, `needsChoice` and `failedCall` cleared; `failures` 0. No request is in flight yet: the next act is `create` (rule 8), which the driver posts |
| `call` | `call` set; `waitingSince` set to `at` where it was null; `refusal` and `failedCall` null |
| `row` from `start` or `check-again` | `reading` set, `call` null, `driving` true, `failures` 0, `answers`, `held`, `lead`, `needsChoice` cleared |
| `row` from `load` | `reading` set, `call` null, `driving` false, `failures` 0. `quietRows` is 1 where the state is `reading` or `media` and `stepRunning` is false, and 0 otherwise |
| `row` from `poll` | `reading` replaced only where its `revision` is not lower than the one held, or where it differs only in `stepRunning`, `phase` and `media`. `quietRows` plus one where the state is `reading` or `media`, `stepRunning` is false and `driving` is false, else 0. `driving` becomes true where `quietRows` reaches 2 (part 12, 4.4). So a tab watching a running step never starts a second one, whatever the step's `phase`; a tab that opens a reading nobody is driving takes it on at its first poll, two seconds after its load; and a tab watching a step whose server died takes it on two seconds after the step's mark is thirty seconds old. Two rows are asked, and not one, because between two steps of one driver the row is unmarked for the moment between an outcome's write and the next call's first mark |
| `advanced` | `reading` set, `call` null, `failures` 0, `driving` kept true where `again`, `waitingSince` null where the state left is not `reading` or `media` |
| `created`, `again` | `reading`, `publishing` set, `call` null, `failures` 0. `pendingCreate` is kept, so the screen stays `creating` and the next act is `create` with the same input |
| `created`, `review-changed` | `reading` set, `lead` from `CREATE_RESULT_LEADS` by the state it is now in, `answers`, `held` and `pendingCreate` cleared, `failures` 0, `driving` true (so a row in `reading` or `media` is advanced), `call` null |
| `created`, `held` | `held` the finding, `lead` the `held` sentence, `call` null, `pendingCreate` cleared, `failures` 0; `answers` kept. Where the finding is `table-differs-in-project`, `needsChoice` names `detail.name` |
| `created`, `refused` | `refusal` set, `reading` replaced where the answer carries one, `call` null, `pendingCreate` cleared, `failures` 0; `answers` kept |
| `created`, `created` | `call` stays `create` and `pendingCreate` stays set until `landed` |
| `landed` | `landing` set; `call` null and `pendingCreate` null, whatever the answer |
| `refused` (a route answered a coded refusal) | `refusal` set, `call` null, `pendingCreate` cleared |
| `failed` | `failures` plus one, `failedCall` the event's `call`, `call` null, and nothing else: `pendingCreate` is kept, so a creation whose request was lost is still a creation on screen. A failed `start`, `check-again` or `remove` leaves the screen as it was, with its sentence (13) |
| `retry` | `failures` 0, `failedCall` null, and `driving` true where the row is in `reading` or `media`. The next act is then the one that failed |
| `answers` | taken only where `answers.reviewDigest` is the reading's `reviewDigest`; `needsChoice` cleared where its tag now has an answer; `held` cleared where it was `table-differs-in-project` and no choice is unanswered |
| `choice-needed` | `needsChoice` set, with `nonce` raised |
| `removed` | `removed` true; `call` stays `remove`, so the screen keeps its busy button until the page goes |

**`screenOf`**, first match:

1. `location.kind === "none"` is `none`; `choose` is `choose`.
2. `landing === "unverified"` is `unopened`, with the location's reading id as `appId` (a reading's
   id is its app's).
3. `refusal === "reading_not_found"` is `gone`.
4. `reading === null` is `opening`, `lost` where `failures >= 1`.
5. `pendingCreate !== null`, or `landing` of `landed` or `leaving`, is `creating`, `lost` where
   `failures >= 2`. This is what keeps the review off the screen between two calls of one creation
   and during the wait before a retry: part 12 keeps the row `ready` through creation's media steps
   (its 2.4), so the row's state alone would draw the review again.
6. Then by `reading.state`: `reading` and `media` are `reading` (`lost` where `failures >= 2`),
   `stopped` is `stopped` with `outcome.finding`, `account` is `account`, `ready` is `review` with
   `answers ?? initialAnswers(reading)`, `created` is `creating` with `lost` false (the act is a
   `replace` to `/build/<id>`), and `removed` is `gone` with `reading_not_found`.

**`nextAct`**, first match. It is a function of the model alone: nothing it answers depends on which
event came last.

1. `removed` is `replace` to `/`.
2. `location.kind === "none"` is `none`. `choose` is `list-apps` with the picker's `domain` and
   `projectId` where `picker.apps.kind === "loading"`, and `none` otherwise.
3. `landing !== null` is `none`: the builder, the next page or the `unopened` screen has it.
4. `call !== null` is `poll` at 2000 ms where the call is `advance` or `create`, and `none` for any
   other call.
5. `reading === null` is `load` where `refusal === null` and `failures === 0`, and `none` otherwise:
   a load that failed waits for Try again.
6. `reading.state === "created"` is `replace` to `/build/<reading.id>`.
7. `failures >= 2` is `none`: the screen offers Carry on or Try again, which dispatches `retry`.
8. `pendingCreate !== null` is `create` with that input, `afterMs` 3000 where `failures` is 1 and 0
   otherwise. So an `again` answer is posted again at once, and one lost request is retried once,
   three seconds later, with the input the person sent.
9. `reading.state` of `reading` or `media` is `advance` where `driving` (`afterMs` 3000 where
   `failures` is 1, else 0) and `poll` otherwise.
10. Everything else is `none`.

```ts
/** The review's defaults: HQ's name, the preselected choice, and no table answered. */
export function initialAnswers(reading: ReadingView): ReviewAnswers;
/** The tags whose review entry asks a choice and has no answer, in tag order. */
export function unansweredChoices(reading: ReadingView, answers: ReviewAnswers): readonly string[];
/** `BringInInput` from the answers, name trimmed. */
export function bringInInputOf(answers: ReviewAnswers): BringInInput;
/**
 * The `review.runsOn` entry whose `runsOnlyOn` and `splitDatetime` the answers hold. `initialAnswers`
 * and every `answers` event take both from one entry, so there is always exactly one.
 */
export function chosenDeclaration(
	review: ReadingReview, answers: ReviewAnswers,
): ReadingDeclarationChoice;
```

The remaining pure functions of the file are given, with their types, where their screen uses them:
`StopAction` and `STOP_ACTIONS` (6.2), `placeGroupKey`, `accountGroups`, `accountHeading`,
`accountCounts`, `countLine`, `accountAsText` (7.1, 7.2, 7.5), `declarationRows`, `declarationWhy`
(8.3) and `chosenDeclaration` (above; used in 8.3 and 8.8). `hqPlaceUrl` (7.4) is `lib/deployment`'s.

**The driver.**

```ts
// components/bring-in/useBringIn.ts
import type { useProjectToast } from "@/lib/collab/useProjectToast";

export function useBringIn(input: {
	/** What `freshBuildPage` handed the tree (3.2). */
	readonly seed: BringInSeed;
	/** `ChatContainer`'s own function (part 12, 7.3). */
	readonly landCreatedAppReceipt: (
		raw: Record<string, unknown>, origin: "blank" | "brought-in",
	) => "landed" | "leaving" | "unverified";
	/** `ChatContainer`'s Project-scoped toast, for the landing toast of 9.3. */
	readonly projectToast: ReturnType<typeof useProjectToast>;
}): {
	readonly model: BringInModel;
	readonly screen: BringInScreen;
	readonly dispatch: (event: BringInEvent) => void;
	/** Read this app, and Carry on (4.1). Does nothing while a call is in flight. */
	readonly start: () => void;
	/** Check again, on a stop or an account (6.2, 7.6). */
	readonly checkAgain: () => void;
	/** Remove from your list, once the person has confirmed it (6.2). */
	readonly remove: () => void;
};
```

`components/bring-in/useBringIn.ts` holds `useReducer(reduceBringIn, …)` and one
effect over `nextAct(model)`, keyed by the act's kind and its fields, so a render that answers the
same act starts nothing twice. `list-apps`, `load`, `advance`, `create` and `replace` run once for
each time the act appears: each of the first four changes the model as its first step (a `call`, or
the list's answer), so the act is another one until its own answer brings it back. `poll` is the one
act that repeats while it stands: it runs every `afterMs` for as long as `nextAct` stays `poll`. An
`advance` or a `create` with `afterMs` above zero starts from a timer the effect clears when it is
torn down. The hook calls the routes through `components/bring-in/bringInClient.ts`, which
is seven `fetch` wrappers (part 12's six and the picker's one):

```ts
// components/bring-in/bringInClient.ts (new; plain `fetch`, no Next router, no Server Action)
export type BringInAnswer<T> =
	| { readonly ok: true; readonly value: T }
	/** A body with a `code` is that refusal. Any other failure, a lost request among them, is null. */
	| { readonly ok: false; readonly refusal: ReadingRefusal | null };

/** `GET /api/commcare/hq-apps` (4.2). */
export function fetchHqApps(
	input: { readonly domain: string; readonly projectId: string | null }, signal: AbortSignal,
): Promise<BringInAnswer<HqAppPicker>>;
/** `POST /api/commcare/readings`. */
export function postStartReading(key: {
	readonly projectId: string; readonly server: CommCareServer;
	readonly domain: string; readonly remoteAppId: string;
}): Promise<BringInAnswer<ReadingView>>;
/** `GET /api/commcare/readings/<id>`. */
export function fetchReading(
	readingId: string, signal?: AbortSignal,
): Promise<BringInAnswer<ReadingView>>;
/** `POST /api/commcare/readings/<id>/advance`. */
export function postAdvanceReading(
	readingId: string,
): Promise<BringInAnswer<{ readonly reading: ReadingView; readonly again: boolean }>>;
/** `POST /api/commcare/readings/<id>/check-again`. */
export function postCheckReadingAgain(readingId: string): Promise<BringInAnswer<ReadingView>>;
/** `POST /api/commcare/readings/<id>/create`. */
export function postCreateFromReading(
	readingId: string, input: BringInInput,
): Promise<BringInAnswer<CreateResult>>;
/** `DELETE /api/commcare/readings/<id>`. */
export function deleteReading(
	readingId: string,
): Promise<BringInAnswer<{ readonly removed: true }>>;
```

`CommCareServer` is imported as a type from `@/lib/deployment`, which re-exports it
(`lib/deployment/types.ts`), so `components/bring-in` names no module of `lib/commcare`; the other
types are `lib/deployment`'s re-exports too. A body with a `code` is the refusal, and
any other failure is `refusal: null` (part 12, 4.1: "the page treats any body without a `code` as
the request failing and offers the same act again"). By act:

- `list-apps` fetches the picker's route and dispatches `picker-apps` with the `domain` and
  `projectId` it asked for. The request is aborted when the key changes.
- `load` dispatches `call`, then `row` from `load`, `refused` or `failed`.
- `advance` and `create` dispatch `call`, post (for `create`, the act's `input`, which is the
  model's `pendingCreate`), then dispatch `advanced` or `created`, `refused` or `failed`. Neither is
  ever aborted, and an answer that arrives after the
  component unmounted is dropped (`mountedRef`), since the step finishes on the server either way.
- `poll` fetches the row and dispatches `row` from `poll`. It is aborted when its effect is torn
  down, and a poll that fails dispatches nothing: the next one runs.
- `replace` is `window.location.replace(href)`.

The three calls a person starts have no act. The handler of **Read this app** (4.1), of **Check
again** (6.2, 7.6) and of a confirmed **Remove from your list** (6.2) each dispatches `call`, makes
its request and dispatches `row` (from `start` or `check-again`) or `removed`, or `refused` or
`failed`.

The hook subscribes to the URL through `useBuilderSearchFrom` and dispatches `location`, and to
`useCommCareConnection()` and dispatches `connection` with the names of `availableDomains`. It marks
the home list stale as 12.3 says. `BringInFlow` calls it, inside `ChatContainer`'s tree, with the
`landCreatedAppReceipt` that `ChatContainer` hands the flow (9.2, 12.1). Each wrapper returns the
route's value unwrapped (`picker`, `reading`, or the whole body where the body is the value).

---

## 4. Choosing: a Project, a project space and an app (B11)

### 4.1 The screen

One card, in the order a person reads it. Strings are in "Copy" by id.

1. Heading **K1**, as an `h1` that takes focus when the screen appears. Under it **K2**.
2. **Add it to** (**K3**): a `Select` (`components/shadcn/select.tsx`, with `items` so the trigger
   shows the Project's name) over `BringInSeed.projects`, preselected to the tab's Project where it is
   in the list, else the first. With one Project it is still shown, as text in the field's place, so
   the person always reads where the app will live. Under it **K4**, which says who will see the app
   (everyone in a shared Project; only the person in their own, by the row's `personal`) and that an
   app reading lookup tables stays where it is added (`lib/db/apps.ts` refuses that move; part 12,
   2.7).
3. **Project space** (**K5**): over `picker.domains`, which the driver keeps equal to
   `useCommCareConnection()`'s `availableDomains` (3.3, the `connection` event). One: the text
   **K6**, and its apps are listed at once, since the reducer chooses a lone project space. Two to
   eight: a `Select`. More: `components/shadcn/combobox.tsx` with the placeholder **K7**, in
   uncontrolled mode, committing on item press (`components/CLAUDE.md`, "Floating elements"). This is
   `UploadForm`'s one-or-many rule with the combobox added for a key that reaches many.
4. **App** (**K8**): a radio group of the project space's apps (4.3), with the filter input **K11**
   above it where there are more than eight.
5. Footer: **Cancel** and **Read this app** (**K16**), and beside them **K17**.

Cancel is `pushBuilderHistory("/build/new", true)`: the composer and both ways of starting come back.

**Read this app** dispatches `call` for `start`, calls `POST /api/commcare/readings` with
`{ projectId, server, domain, remoteAppId }` (`server` is the loaded list's, `picker.apps.picker
.server`), dispatches `row` from `start` with the answer, replaces the URL with
`/build/new?hq=<id>`, and the driver advances it. A coded refusal dispatches `refused` and a failure
with no code `failed`, which the screen words as section 13's "Picker, starting" row says. Where the
row chosen holds `openReadingId` the button reads **Carry on** and does the same thing:
`startReading` returns the open row (part 12, 3.5), so there is one path.

### 4.2 The picker's transport

Part 12 hands the picker's reads to this part ("The picker's reads … are part 13's transport"). They
are one service function and one route.

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
	/** The caller's own open reading of it in the chosen Project, or null. */
	readonly openReadingId: string | null;
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
	actor: ReadingActor,
	input: { readonly domain: string; readonly projectId: string | null },
): Promise<HqAppPicker>;
```

In order, with no write:

1. `getHqCredentials(actor.userId, input.domain)` (part 05, section 11). `not_configured` answers
   `not-connected`. `not_authorized` answers a stop of `not-a-member` at place `{ kind: "app" }`.
   `ambiguous` cannot be the answer for a named project space and is thrown with part 12's C8
   sentence.
2. `listHqApps(creds, domain)` (part 05, 5.1). An error answers the stop
   `hqReadCircumstance(classifyHqFailure(error, "app-list"))`.
3. `probeHqApiAccess(creds, domain)` (part 05, 5.2), after the list and never beside it.
   `plan-lacks-api-access` answers that stop, `account-lacks-access-apis` answers `cannot-access-apis`,
   and `failed` answers `hqReadCircumstance(failure)`. `available` goes on.
4. `readHqAppClaims({ viewerUserId, server, domain, remoteAppIds })` (part 10, 5.5), one query. Each
   view becomes the row's `claim` with `remoteAppId` dropped, which is part 01's `HqAppClaimDetail`.
5. Where `projectId` is given and the caller holds `view` there: `listOpenReadings(actor, projectId)`
   (part 12, 3.5), and each summary whose `server`, `domain` and `remoteAppId` match a row gives that
   row its `openReadingId`. A caller without `view` gets none, as that function answers an empty
   list.

Rows are in CommCare HQ's order, which is by name (part 05, 5.1). The function reads nothing else of
HQ: part 05 states that a list row cannot say an app is linked, remote, when it was edited or whether
it is built, so the picker shows the name alone, and a linked, remote or deleted app is a stop of the
first read step (6).

| Route | File | Calls | Request | 200 body |
|---|---|---|---|---|
| `GET /api/commcare/hq-apps` | `app/api/commcare/hq-apps/route.ts` (new) | `listHqAppsForPicker` | query `domain` (required, through `lib/commcare/client.ts::isValidDomainSlug`), `projectId` (optional, at most 255 characters) | `{ picker: HqAppPicker }` |

A thin shell as part 12's are: `requireSession(req)`, the two query values checked, the service call,
`handleApiError`. A stop is an answer and is 200. A bad query is 400 with `{ error, code:
"invalid_input" }` and part 12's sentence. `lib/hostnames.ts::HOSTNAME_ALLOWLIST` holds `/api/commcare`
for the main host and matches by segment, so the route needs no entry and is not reachable on the MCP
or docs host; B11's route test holds both, as part 12's does for its six. No `maxDuration` export: the
two reads are bounded at 30 seconds each by part 05 (its 3.3), with its wait for a throttled answer
between them.

It is a route and not a Server Action for part 12's reason (its 4.2): the page may be polling, and
Next dispatches a client's actions one at a time.

### 4.3 The rows

Each app is one row of a radio group (12.2), `selectableRowCls`, at least 44px tall, growing for a
second line.

| The row | Shows | Can be chosen |
|---|---|---|
| free | the name, or **K13** where CommCare HQ holds none | yes |
| the person's own open reading (`openReadingId`) | the name and a `Badge` **K15** | yes; the footer's button reads **Carry on** |
| `claim.kind === "open"` | the name, a `Badge` `HQ_APP_CLAIM_OPEN_LABEL` ("Already in Nova"), and a `Button variant="link"` `HQ_APP_CLAIM_OPEN_ACTION` ("Open") rendering a `Link` to `/build/<claim.appId>` | no: the radio is `aria-disabled`, keeps its place in the tab order, and its label says why |
| `claim.kind === "elsewhere"` | the name, the label `HQ_APP_CLAIM_ELSEWHERE_LABEL` ("Already in Nova, in a Project you're not part of"), and under it part 01's `alreadyInNovaNext(claim)` sentence with its date in the reader's locale (who brought it in or published it and when, and the two ways forward: be invited, or ask them to stop publishing to it) | no, as above |

The two row labels and the action "Open" are the three exports of `lib/publish/hqAppClaims.ts` (part
10, 5.5, "The picker's marks", B8), which exports no line. The line under an `elsewhere` row is part
01's `alreadyInNovaNext(claim)` (its 8.4, A2), called with the row's claim; a picker row is no
finding, so `circumstanceNext` (6.1) does not apply to it. This part places the four and writes
none. The holding Project's name and, for `elsewhere`, the Nova app's name are never on the wire
(part 10, 5.5), so the row cannot show them.

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

A `stop` answer is drawn in the App field's place by the same block a stopped reading uses (6.1), with
part 01's title, body and next for the code, `{space}` the chosen project space and `{server}` the
connection's label. The codes this screen can meet are the ones steps 1 to 3 of 4.2 give:
`not-a-member`, `key-not-accepted`, `plan-lacks-api-access`, `api-cut-off`, `cannot-access-apis`,
`rate-limited`, `hq-unavailable`, `hq-gateway-refused` and `browser-only`. Their actions are
`STOP_ACTIONS`' (6.2), less "Choose another app" and "Remove from your list", which have nothing to
act on here; "Check again" dispatches `picker-reload`, which lists again. Choosing another project
space clears the stop.

A person who can add an app to no Project (`BringInSeed.projects` is empty, so `picker.projectId` is
null; they came by the address, since no entry is offered to them) sees part 12's
`no_project_access` sentence in the card with **Go to your apps**, and no fields. A person who only
views the tab's Project and edits another sees the picker with that other Project chosen (3.1).

---

## 5. Reading (B11)

The screen for a row in state `reading` or `media`.

- A status row, `role="status"`, with the one spinner of the screen: **W1**, naming the app once the
  row holds its name.
- Under it, the step that is running: `READING_PHASE_LABELS[reading.phase]` (part 12, C4), with
  `{done}` and `{total}` from `reading.media`; **W2** where `phase` is null. Part 12 reports a
  phase only while a step is marking the row (its 3.1), so W2 is what the line says in two
  cases, each of them true: a step has started and named no phase yet, and a step died with its
  server and this tab is taking the reading on. It never names a step that nothing is running. A
  step that is waiting for the server's one reading slot has a label of its own, part 12's
  `waiting` (its 3.6 and C4). It is an `aria-live`
  region at `polite`, and its text changes only when the label does, so a file count that moves every
  two seconds is not read out each time: the count is a separate `aria-hidden` span beside a
  visually hidden sentence that is updated at most every ten files.
- After twenty seconds of `waitingSince`: **W3**. This is the design system's rule for a wait, "Long
  operations get patient company ("Still building. Big apps take a minute or two."), not spinners in
  silence or percent counters", and it is why there is no bar.
- Always: **W4** and **W4b** as one paragraph, and one link, **Go to your apps**.

W4 says what leaving does, and it does not say the read carries on alone, because it does not: no
worker advances a reading (part 12, 4.3 and 4.4). A tab that closes lets the
step in flight finish and write its outcome, and nothing runs after it until a tab opens the reading
again. Until then the home row reads "Paused" (10.2). W4b says where the reading is kept. The home
list shows the readings of the Project the tab is looking at (10.1), so where the reading's
`projectId` is not the tab's (`useProjectId()`), W4b names the Project it was added to, from
`BringInSeed.projects`:
the person finds the row by switching to that Project, and **Go to your apps** alone would show
them a list without it.

The named steps a person can see are part 12's nine labels and no others. Which run, in which order,
is the row's business: the read step runs before the files are fetched and again after (part 12,
Decision 8), so the label can return from "Bringing in pictures and sounds" to "Reading the app", and
each time it says what is true.

**The driver here.** While `nextAct` is `advance`, the hook posts `…/advance` and, while that call is
in flight (`call` is `advance`, so `nextAct` is `poll`), polls `GET …/<id>` every 2 seconds and
dispatches `row` from `poll`, so `phase` and `media` move on screen. When the call answers it
dispatches `advanced` and, where `again`, advances again. A tab that opened a reading it did not
start only polls while the row says a step is running, and takes the reading on once two rows in
a row say none is (3.3), which is part 12's rule for who drives (its 4.4). An `advance` answered
`again` with the row unchanged is a step that waited for the server's reading slot and started
nothing (its 3.6); the hook advances again as for any `again`, the wait was the server's, so no
timer is added here, and while it lasts the line reads part 12's `waiting` label.

**A lost request.** The first failure of an `advance` with no code shows the amber line **W5**
("Trying again", the design system's recovery word) and retries once after 3 seconds. The second
shows **W6** with **Carry on**, which dispatches `retry`. Nothing is lost either way: a step that
did not write left the row as it was (part 12, 3.2).

A coded refusal is one of two: `project_access_lost` shows its sentence (part 12, C1) with **Go to
your apps**, and `reading_not_found` is the `gone` screen.

---

## 6. A stop (B11)

### 6.1 The block

A row in state `stopped`, and a `stop` answer of the picker, draw one component, `BringInStop`:

- an amber `tabler:info-circle`, never a tick and never rose: a stop is no error of the person's and
  no failure of Nova's;
- the title as the screen's `h1` (focus goes to it) and the body, each from
  `CIRCUMSTANCE_COPY[code]` (part 01, 9.3), and the next step, which is
  `circumstanceNext(finding)` (part 01, 8.4, landed in B2): the one function that words a
  circumstance's next step for a stop, the account (7.2) and MCP (14.3) alike. `{space}`,
  `{server}`, `{app}` and `{name}` are filled from the reading;
- one line, **S1**: "Nothing was created, and nothing changed in CommCare HQ";
- the actions of 6.2.

A `held` answer of creation is the same block with no `S1` and no actions of its own, set above the
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
	/** **Remove from your list**. */
	| { readonly kind: "remove" }
	/** **Go to your apps**: a link to `/`. */
	| { readonly kind: "go-to-apps" }
	/** **Open {appName}**: a link to `/build/<appId>`. */
	| { readonly kind: "open-app"; readonly appId: string; readonly appName: string };

export const STOP_ACTIONS: {
	readonly [K in StopCircumstance]: (finding: CircumstanceFinding) => readonly StopAction[];
};
```

`STOP_ACTIONS` is written with `satisfies Record<StopCircumstance, (finding: CircumstanceFinding) =>
readonly StopAction[]>`. `StopCircumstance` is part 01's type (its 8.3, A2): every member of
`READ_CIRCUMSTANCES` whose `CIRCUMSTANCE_STANDINGS` entry is `stop`, which is nineteen codes once B1
has landed its five (`hq-gateway-refused`, `api-cut-off`, `browser-only`, `remote-app`,
`cannot-read-organization`). So a `stop` code added to part 01's list fails to compile here until
it has a row. Every row but `already-in-nova` ignores its argument; that row reads
`finding.detail.claim` and answers `open-app` where its `kind` is `open`.

| Code | Actions, in order, the first one primary |
|---|---|
| `not-connected`, `key-not-accepted` | **Open Settings** (a link to `/settings` in a new tab), **Check again**, **Remove from your list** |
| `plan-lacks-api-access`, `not-a-member`, `cannot-edit-apps`, `cannot-access-apis`, `api-cut-off`, `browser-only`, `cannot-read-organization` | **Check again**, **Choose another app**, **Remove from your list** |
| `rate-limited`, `hq-unavailable`, `hq-gateway-refused`, `changed-while-reading` | **Check again**, **Go to your apps** |
| `app-gone`, `linked-app`, `remote-app` | **Choose another app**, **Remove from your list** |
| `app-deleted` | **Check again**, **Choose another app**, **Remove from your list** |
| `already-in-nova`, the holder `open` | **Open {appName}** (a link to `/build/<claim.appId>`), **Choose another app**, **Remove from your list** |
| `already-in-nova`, any other holder | **Choose another app**, **Check again**, **Remove from your list** |
| `table-differs-in-project` | none: it is only ever a `held` answer (part 12, 3.8) |

**Check again** dispatches `call` for `check-again`, posts `…/check-again` and dispatches `row` from
`check-again`, after which the driver advances the row. **Choose another app** pushes
`/build/new?hq=choose`, keeping the picker's Project and project space. **Remove from your list** asks
with the home row's dialog (10.4) and, on a yes, dispatches `call` for `remove`, sends
`DELETE …/<id>` and dispatches `removed`, whose act loads `/` (`window.location.replace`, so the
list is read afresh and Back does not return to a reading that is gone). **Go to your apps** is a
link to `/`.

### 6.3 Every circumstance, and where it is drawn

Part 01's `READ_CIRCUMSTANCES` holds thirty-five codes once B10 has landed (its 8.3). Each has one
layout, decided by its standing alone, so a code a later pull request adds needs a row of 6.2 where
its standing is `stop` and nothing else of this part. The title, the body and the next step of
every code are part 01's (`CIRCUMSTANCE_COPY`, `circumstanceNext`), in the words of the part that
proposed the code; this part writes none.

| Codes | Standing | Lands in | Drawn |
|---|---|---|---|
| the nineteen rows of 6.2 | `stop` | A2 (fourteen), B1 (five) | the stop block (6.1) with the actions of 6.2: as the whole screen for a row in state `stopped`, in the App field's place for a `stop` answer of the picker (4.5), and above the review, with no S1 and no actions, for a `held` answer of creation (8.10) |
| `too-large` | `not-yet` | A2 | the circumstance block of 7.2, in the group of the finding's own place; the heading is A1 (7.1) |
| `unrecognized`, `read-back-differs` | `not-yet` | A2 | the same block; the heading is A2 where every finding of the account is one of these or `could-not-create`, else A1 (7.1) |
| `menu-unreadable-in-hq`, `shadow-disagrees`, `media-file-unreadable` | `fix-in-hq` | A2 | the same block, under the amber label |
| `app-unreadable-in-hq`, `table-rows-unreadable` | `fix-in-hq` | B1 | the same block |
| `no-platform-runs-everything` | `fix-in-hq` | B2 | the same block; its next step is the second sentence where `detail.reason` is `split-refused`, which `circumstanceNext` chooses |
| `places-over-nova-limit`, `place-not-holdable`, `owner-rule-needs-one-place` | `not-yet` | B9 | the same block, under the violet label; the heading is A1 |
| `media-not-played-where-app-runs`, `table-cell-unrepresentable`, `table-choices-unusable` | `fix-in-hq` | B9 | the same block; a finding at a `media` place sits in the "Pictures and sounds" group, its line beginning with the path (7.2) |
| `could-not-create` | `not-yet` | B10 | the same block; the heading as for `unrecognized` |

An account never holds a `stop` code and a stop never holds one of the other sixteen: part 12
writes a `stop` finding only as a `stopped` row's outcome or a `held` answer (its 3.8), which is
what keeps a stop out of every account (Decision 9).

---

## 7. The account (B11)

A row in state `account`. Its `outcome` is `{ kind: "account", findings, more, mediaChecked }` (part
12, 2.3), each finding part 01's `Finding`.

### 7.1 The screen, top to bottom

1. An amber `tabler:info-circle` and the heading, as `h1`: **A1**, or **A2** where
   `accountHeading(findings)` says every finding is a fault of Nova's own that a later check can
   clear (each one a circumstance among `read-back-differs`, `unrecognized` and `could-not-create`).
   `too-large` and `places-over-nova-limit` are not among them: each is a limit Nova has, `not-yet`
   in part 01's and part 11's tables (part 01's block for `too-large`: "That limit is Nova's, not the
   app's"), and "this time" would promise that checking again gets past it. They take **A1**, which
   says "yet".
2. The lead: **A3**, or **A4** under heading A2.
3. The lead of a creation that ended here, where the model holds one: `CREATE_RESULT_LEADS`' sentence
   for `account` (part 12, C2), as a `role="status"` line above the heading.
4. The count line, `countLine(accountCounts(findings))`: the parts of **A5** that are not zero,
   joined by ` · `. Each part is a whole phrase with its own noun, singular at one ("1 thing Nova
   can't hold yet", "3 things to change in CommCare HQ"). The counts are of the findings the row
   holds; where the read met more, item 9 says how many.
5. What Nova has learned, where `reading.learned` is not null: `READING_LEARNED_LINES[learned]` (part
   12, C3), in `text-nova-violet-bright` with `tabler:sparkles`.
6. The three labels, each shown only where the account holds a finding of it, as a short definition
   list: the `Badge` of 7.3, then `FINDING_NEXT_STEPS[standing]` (part 01, 9.1). This is where the
   next step of every `not-yet` finding is said once, and not on each of two hundred lines.
7. The groups (7.2).
8. `ACCOUNT_CHECK_AGAIN_LINE` (part 01, 9.1; part 06, Departure 11), under the groups of every
   account, always: "When these are changed, Nova will check the app again and may find more to
   name." One pass reports everything the reader can decide, and what it postpones out of a reading
   that holds another finding can surface on a later read, so no screen, tool or page of this part
   calls an account complete.
9. `moreFindingsLine(more)` where `more > 0` (part 12, C5).
10. Part 11's line R12 where `mediaChecked` is false: "Nova checks pictures and sounds once
    everything else can come in."
11. The footer, which does not scroll: **Copy the list**, **Check again**, **Done** (a link to `/`),
    and under them **A8**, which names the reading's Project where it is not the tab's, by the rule
    W4b follows (5).

```ts
// components/bring-in/bringInModel.ts
import type { Finding } from "@/lib/publish/hqFindings";

/** How many findings a list holds under each label. The shape of `ReadingSummary.counts`. */
export interface AccountCounts {
	readonly notYet: number;
	readonly never: number;
	readonly fixInHq: number;
}
export function accountCounts(findings: readonly Finding[]): AccountCounts;
/** The A5 parts that are not zero, joined by " · ". The empty string where all three are zero. */
export function countLine(counts: AccountCounts): string;
/**
 * `this-time` (A2, A4) where every finding is a circumstance among `read-back-differs`,
 * `unrecognized` and `could-not-create`; `yet` (A1, A3) for any other list, the empty one included.
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
order each key first appears in the row's list (part 12 sorts by place in the app's own order, then
by code), and within a group keeps the row's order. Grouping is by key and not by where the key
changes, because part 12's order (its 2.3: "forms by index, questions by path") does not promise
that a form's questions sit directly after that form's own findings, and a heading must never
appear twice. `placeGroupKey` is this part's, in `bringInModel.ts`; its keys are the middle column:

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
  `CIRCUMSTANCE_COPY[code]`, then its next step, `circumstanceNext(finding)` (part 01, 8.4), then
  the label of its standing as a `Badge`. A circumstance says its own next step because it has one
  of its own, and one function words it for this screen, a stop (6.1) and MCP (14.3). Section 6.3
  lists the sixteen codes this block draws.

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
/** The whole account as plain text. `date` is the read's day, already in the reader's locale. */
export function accountAsText(
	reading: ReadingView, findings: readonly Finding[], date: string,
): string;
```

`accountAsText` is pure and gives plain text: the heading, the project space
and the date of the read (**A12**), the count line, then each group's heading followed by one line
per finding ("- {label}: {sentence}" and, where named, " In CommCare HQ: {name}."; a circumstance's
sentence is its body, then its next step), and it ends with `ACCOUNT_CHECK_AGAIN_LINE` on a line of
its own, so "Copy the list" carries the line a person reads on the screen. The button writes it with
`navigator.clipboard.writeText` and reads **Copied** for two seconds, announced through a
`role="status"` region; where the browser refuses the clipboard the same text opens selected in a
read-only `Textarea` under the button with the line **A10**, so the list can always be taken away.

### 7.6 Check again

The handler of 6.2: it posts `…/check-again`; the row goes to `reading` with its verdicts kept (part
12, 2.4), and the screen is section 5's. A reading whose account was only about Nova's own fault is
checked the same way:
part 01's blocks for `read-back-differs` and `unrecognized` already say the gap was reported and that
checking again after Nova's next update is the way on.

---

## 8. The review (B11)

A row in state `ready`. Its `outcome.review` is part 12's `ReadingReview`; `reviewDigest` names it.
Nothing has been created when this screen shows, and the heading's next line says so.

### 8.1 The screen, top to bottom

| # | Section (its `h2`) | Shown |
|---|---|---|
| | the heading **V1**, as `h1`; under it **V2** | always |
| | a creation's lead (`CREATE_RESULT_LEADS`, for `ready`), and a held stop's block (8.10) | where the model holds one |
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
  Emptied, it shows `READING_REFUSAL_COPY.name_missing` (part 12, C1) as its `FieldError` when Bring
  it in is pressed, and takes focus.
- One line of counts, **V5**: menus, forms, questions and languages, each pluralized, joined by ` · `
  (the design system's metadata separator). Languages are a count and never a code: "no ISO code
  appears in any Builder surface" (`components/builder/CLAUDE.md`).
- Where `creates.caseTypes` is not empty, **V6** with the names in `font-mono`.
- **V7**, naming the Project the reading belongs to and who can open the app there (everyone in a
  shared Project; only the person in their own, by the seed's `personal`), and where `review.tables`
  is not empty, **V8**.

### 8.3 Where workers use this app

A radio group (12.2) over `review.runsOn`, in the order part 12 gives, the `preselected` entry
chosen. Each row is a declaration the app's content really runs on, so no row is disabled:

- its label, `PLATFORM_DECLARATION_LABELS[runsOnlyOn ?? "both"]` (`lib/domain/platforms.ts`);
- its line, `PLATFORM_DECLARATION_LINES[runsOnlyOn ?? "both"]`. B11 moves the three lines of
  `AppPlatformsSection.tsx::CHOICES` to that new export of `lib/domain/platforms.ts`, unchanged, and
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

`runsOnWhy`, `webAppsOnInHq`, `datetimeQuestions` and `platformsOut` are four values this part needs
`ReadingReview` to carry, each computed where the choices are computed ("What this part needs of
other parts", part 12). They are in the review, so they are in its digest.

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
  part 11's (its 7.2): the Project's table holds something a workbook to the reading's project
  space would be refused for, so `use-project` is not offered, and R10 says "{Project}'s table holds
  something CommCare HQ won't take in {domain} as it is, so this app can't use it there.";
- under the group, where at least one answer is offered, **R11**, with the action **Choose another
  Project**, which pushes `/build/new?hq=choose`. The reading stays on the home list of the Project it
  was started in, where Remove takes it away.

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
current one, as the card formats it. There is no Refresh here: Check again reads everything. The
list arrives computed: part 12's read step fills `review.kept` as the `kept` row of its 5.1 says,
over the source as the adopted baseline will store it. This part writes no call for it and holds no
source on the client, which is how part 01's need (the kept list "over the reading's own source
before a baseline exists") is met.

### 8.8 After it's in, and the first publish

**After it's in**, three sentences that are always shown and one that is shown where it applies:

- **V21a**: the app can be worked on in Nova and published back to this app in its project space.
- **V21b**: a change made in CommCare HQ stops the next publish before anything is sent, and the
  publish lists what changed.
- **V21c**: a copy of the app in another project space cannot be updated yet; publishing there makes
  a new app.
- part 10's `adoptionRecordedFeaturesLine(labels, domain)`, where the chosen row's `recordedFeatures`
  is not empty. `labels` is `PLAN_FEATURES[key.subject].label` (`lib/publish/planFeatures.ts`) for
  each `plan-feature` key, in words. It moves when the person chooses another row, since Web Apps is
  recorded only for a declaration that includes it (part 10, 6.5).

V21b is deliberately modest. Step 6's stop names what changed by menu and form (`describeAppChange`)
and offers publishing over it or stopping; bringing the changes in is step 7's first group
(`changes-made-in-hq`), and nothing in the product promises it. V21c states the one thing step 6
leaves to step 7's `second-project-space` group, updating an existing copy of the app in another
project space, and D7 says it again in the Publish dialog (11.2).

**What the first publish changes** is generated, never one fixed paragraph: the list is the entries
of part 09's register that apply to this app (its 11 and 12.1), and a fixed paragraph would be true
of some apps only. Every word of it is part 09's (its 12.2 and its Copy, C1 and
C2, in `lib/publish/firstPublishCopy.ts`). This part places it and writes no sentence of it.

The list is the chosen row's, not the review's. Three register entries depend on the choice
(`web-apps-turned-off` and `web-apps-turned-on`, `scope: "declaration"`, and
`date-and-time-questions-split`, `scope: "birth"`; part 09, 11.2), so part 09 gives each choice its
own view (its 12.1: part 12's `ReadingDeclarationChoice` holds `firstPublish: FirstPublishView`,
taken from the `AcceptedDeclaration` at the same position), and
`ReadingReview.firstPublish` is only the preselected choice's. The screen reads
`chosenDeclaration(review, answers).firstPublish` (3.3) and draws it again on every `answers` event
that changes the row, with no request. A person who chooses Android only while CommCare HQ has Web
Apps on therefore reads that Web Apps will be turned off, in this section, before they create.

`FirstPublishLines` (12.1; props `{ view, surface }`) draws one `FirstPublishView` for one surface.
What it draws is decided by part 09's one renderer, `firstPublishLines(view, surface)`
(`lib/publish/firstPublishCopy.ts`, its 12.2, B7), which returns part 09's `FirstPublishLines`
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

The component holds no rule: it never reads `view.touchesWorkers`, never sorts a line and never
picks a string. Part 09's `firstPublishCopy.test.ts` holds the rule; this part adds no model
function for it. It adds no sentence and drops none, as part 09 asks: "a list is shown whole".
Part 07's `detail-only-columns-searched`, part 10's media path entries and part 11's
`media-references-with-no-file-removed` are entries like any other, drawn by steps 3 and 5 with no
arm of their own here. Where the row changes, the list's `aria-live` region at `polite` announces
the heading once, not each sentence.

The review, the Publish dialog (11.2) and MCP (14.3, 14.7) all read `firstPublishLines(view,
surface)`, so the three say one thing in one order.

### 8.9 Bring it in

The button is a `Button` (the default lilac keycap), always enabled while the screen is idle. Pressed:

1. Where the name is empty after trimming or over 255 characters: the name field shows its error and
   takes focus. Nothing is sent.
2. Else where `unansweredChoices(reading, answers)` is not empty: `choice-needed` is dispatched for
   the first tag, that `fieldset` scrolls into view, its first radio that can be chosen takes focus
   (its `legend` where none can), and the line **V16** (or **V17**) shows under it with
   `role="alert"`. Nothing is sent.
3. Else `create-asked` is dispatched with `input: bringInInputOf(answers)`, which the model keeps as
   `pendingCreate`, and the driver posts `…/create` with it (`nextAct`'s rule 8). The screen becomes
   section 9.1's at once, so the review's button needs no in-progress label: the creating screen's
   status row is the progress.

Step 2 is in the browser so nobody waits on a round trip to learn what the screen already knows. The
server holds the same rule for every other caller (part 12, 5.3, step 3), and its `held` answer is
handled the same way (8.10).

### 8.10 When creation answers something other than "created"

Part 12's `CreateResult`, by kind:

| Answer | The screen |
|---|---|
| `again` | section 9.1's screen stays (`pendingCreate` is kept), and the same `create` is posted again at once |
| `review-changed`, the row now `ready` | this screen again with the new review, Nova's preselected choices, and the lead sentence for `ready` in a `role="status"` line above the heading, which takes focus |
| `review-changed`, the row now `account` or `stopped` | section 7's or 6's screen, with that state's lead above it |
| `review-changed`, the row now `media` or `reading` | section 5's screen with that state's lead, and the driver advances it; the review returns when the row is `ready` |
| `held` | this screen with the answers kept; above the heading, the `held` lead and the circumstance's block (6.1). For `table-differs-in-project` the named table's `fieldset` also takes focus, as in 8.9 step 2 |
| `refused`, `name_missing` | the name field's error |
| `refused`, `choice_not_offered` or `not_ready` | the sentence (part 12, C1) in a `role="alert"` line above the footer, over the row the answer carries (`CreateResult`'s `reading`), which is the screen that row's state draws |
| `refused`, `project_changed` | the sentence above the footer; Bring it in is offered again |
| `refused`, `project_access_lost` or `app_unavailable` | the sentence, with **Go to your apps** |
| `refused`, `reading_not_found` | the `gone` screen |

---

## 9. Creating, and landing in the builder (B11)

### 9.1 Creating

While the model holds `pendingCreate` (`screenOf`'s rule 5), from the press of Bring it in until
creation ends: the card shows a status row **X1** with the spinner, the running step under it from
`READING_PHASE_LABELS` (`publishing-media` with the count of `publishing`, and without the count
while `publishing` is null, which is the first call of a creation before any answer; then
`reading-again`, or `waiting` where the final step waits for the server's reading slot; part 12, C4,
gives `publishing-media` its two forms), **X2**, and W3's reassurance after twenty seconds. On the
phase `creating` no step line is drawn under X1, which already says it: part 12's label for that
phase is "Creating your app", X1's own words. The review's choices are not on screen at any moment
of it, between two calls and during the wait before a retry included, so nothing can be changed
under a creation in flight. The driver polls the row for `phase` exactly as in section 5 while a
call is in flight, and `nextAct`'s rule 8 posts `create` again with the same input while the answer
is `again` (part 12, 4.5: a creation over an app of `n` files reaches `created` in at most `ceil(n /
12) + 1` calls that did work, beside any answered `again` because another reading held the server's
reading slot, which do none).

**A lost request.** The first `create` that fails with no code shows **W5** and is posted again
after 3 seconds, with the same input. The second shows **X4** with **Try again**, which dispatches
`retry`, and the same `create` goes again. The screen is still this one throughout (`creating`
with `lost`), never the review. Trying again is safe because a retry returns the same app (part 12,
6.6).

**A reload during a creation** drops the model, and the address loads the row. A row that committed
is `created`, and the tab loads `/build/<id>`. A row that did not is still `ready`, since part 12
keeps that state through creation's media steps (its 2.4), and the review shows again with Nova's
preselected choices: nothing was created, the files already published are recorded on the row or
found again by their hash (part 12, 6.6), and the person presses Bring it in when they are ready.

### 9.2 The landing

On `created`, the hook calls part 12's `landCreatedAppReceipt(result.receipt, "brought-in")`, which
`ChatContainer` hands it as an argument of `useBringIn`, and dispatches `landed` with its answer:

| Answer | What the person sees |
|---|---|
| `landed` | the builder, in this tab, with no page load: `installCreatedApp` installs the app and promotes the URL to `/build/<id>`, the centred column gives way to the builder as it does for a blank app, and the toast of 9.3 shows |
| `leaving` | the creating screen stays while the tab loads `/build/<id>` (the app went to another Project than the tab's; part 12, 7.3). The app's own page then shows the toast of 9.3 from a one-time marker (below) |
| `unverified` | part 12's toast C6 for `brought-in`, which `ChatContainer` shows (`UNVERIFIED_LANDING_TITLE`, "Your app is in, and this tab couldn't open it", with `UNVERIFIED_LANDING_BODY`), and the screen `unopened`: the line `UNVERIFIED_LANDING_TITLE`, the same export of part 12's `lib/publish/hqReadingCopy.ts`, so the toast and the screen say one sentence and this part writes none; **Open your app** (a plain link to `/build/<appId>`, which loads the app's own page through the ordinary hydration read) and **Go to your apps**. The review is not drawn again: the app exists, and a second Bring it in would only answer the same receipt |

**The marker for `leaving`.** `landCreatedAppReceipt` assigns the location itself and only then
answers `leaving` (part 12, 7.3), so the hook cannot act between the two. It decides before the
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
  12, 6.4 and 9.6: "a first message saying what came in would be a transcript no run wrote"), so the
  chat panel shows what it shows for every app with no messages yet: `ChatSidebar`'s
  `ConversationEmptyState` ("Your conversation with Nova appears here. Start it in the box below.")
  above the composer's "What would you like to change?". B11 changes neither. The first message is an
  ordinary edit turn.
- **Publishing already holds a card.** The adopted deployment exists from the birth (part 10, 6.1), so
  App setup's Publishing section shows the project space the app came from at once, in the words of
  11.1, before any publish.

Nothing is stored in the session or the document to say an app was brought in (part 12, 7.3). After
this first minute, the Publishing card is where it is said.

---

## 10. The home list (B11)

### 10.1 The section

`app/(app)/(site)/app-list.tsx::AppList` adds `listOpenReadings({ userId }, projectId)` (part 12, 3.5)
to its `Promise.all` and renders `<ReadingsInProgress readings={…} />` directly under
`<DesignsInProgress />`. `page.tsx::HomePage` adds `userHasOpenReadings({ userId }, activeProjectId)`
beside `userHasDesignsInProgress`, and shows the empty state only where the Project has no app, no
design in progress and no open reading, so a home whose one thing is an app coming in never reads "No
apps yet".

`app/(app)/(site)/readings-in-progress.tsx` (new, a client component, the shape of
`designs-in-progress.tsx`): a `section` labelled by its heading **H1**, the line **H2**, and a list of
rows. Nothing renders where the list is empty. Rows are the person's own readings in the Project the
tab is looking at (part 12, 2.5), most recently updated first, twenty at most.

### 10.2 A row

`app/(app)/(site)/readingRowModel.ts::readingRow(summary)` (new, pure) gives each row its text and
its actions from part 12's `ReadingSummary`. The component formats times with
`components/ui/RelativeTime.tsx`, as a design's row does.

- Icon: `tabler:cloud-download` in the violet tile a design's row uses.
- Title: `remoteAppName`, or **H3** where the row holds none yet.
- Under it, "From {domain}" (**H4**) and the relative time of `updatedAt`.

| `state` | The status line | Actions, the first one the row's primary link |
|---|---|---|
| `reading` or `media`, `stepRunning` true | `READING_PHASE_LABELS[phase]`, `fetching-media` with the files' count from `media`; **W2** ("Getting ready") where the running step has reported no phase | **Continue**, **Remove** |
| `reading` or `media`, `stepRunning` false | **H5** ("Paused. Continue picks up where Nova stopped.") | **Continue**, **Remove** |
| `ready` | **H6** ("Ready for you to review"), with a violet `Badge` | **Review**, **Check again**, **Remove** |
| `account` | `countLine(counts)` (7.1), then "Checked {relative time of readAt}"; under them, where `learned` is not null, `READING_LEARNED_LINES[learned]` | **See the list**, **Check again**, **Remove** |
| `stopped` | `CIRCUMSTANCE_COPY[stopCode].title` | **See why**, **Check again**, **Remove** |

A row never draws `publishing-media`, `reading-again` or `creating`: those are the phases of a
creation, and a row is `ready` through creation (part 12, 2.4), so the `ready` line stands until
the row is `created` and leaves the list. Status is always text, "never color alone", as the design
row's comment already requires.

```ts
// app/(app)/(site)/readingRowModel.ts
import type { ReadingSummary } from "@/lib/deployment";

export interface ReadingRow {
	/** `bringInHref({ kind: "reading", readingId: summary.id })`. */
	readonly href: string;
	/** `remoteAppName`, or H3. */
	readonly title: string;
	/** H4. */
	readonly from: string;
	/** The status line. For `account` it is `countLine(counts)`; the component adds H11's time. */
	readonly status: string;
	/** For `account`: `readAt`, which the component formats as H11. Null for every other state. */
	readonly checkedAt: string | null;
	/** `READING_LEARNED_LINES[learned]` for an account that holds one, else null. */
	readonly learned: string | null;
	/** True for `ready`, which wears the violet `Badge`. */
	readonly ready: boolean;
	/** The row's primary link, worded by state. */
	readonly primary: "continue" | "review" | "see-the-list" | "see-why";
	/** False for `reading` and `media`, which have nothing to check again. */
	readonly canCheckAgain: boolean;
}
/** A row for a summary whose state is one of `OPEN_READING_STATES`. */
export function readingRow(summary: ReadingSummary): ReadingRow;
```

### 10.3 What the actions do

- **Continue**, **Review**, **See the list** and **See why** are one link, to
  `/build/new?hq=<id>`, worded for what the person will find. The flow shows the row's state and, for
  a `reading` or `media` row with no step running, takes it on at its first poll (3.3).
- **Check again** posts `…/check-again` from the row. On an answer it calls `markAppListStale()`
  (12.3) and routes to `/build/new?hq=<id>`, where the flow loads the row, finds it in `reading`
  with no step running, and takes it on at its first poll (3.3), as it does for any reading opened
  by its address; while the row's own request waits the button reads **Checking** with
  `aria-busy`. A refusal or a failed request shows **H9** under the row with `role="alert"`, and the
  row stays as it was. This is the one click "Nova can now hold everything
  this list named" asks for, and it reads CommCare HQ only after the person is on the page that shows
  the progress.
- **Remove** opens the dialog of 10.4.

### 10.4 Remove

An `AlertDialog` (`components/shadcn/alert-dialog.tsx`), the pattern of a design's Discard: the title
**H7**, the body **H8** with the app's name, **Keep it** as the cancel and **Remove** as the action,
which is a `ghost-destructive` button reading **Removing** with `aria-busy` while `DELETE …/<id>` is
in flight. On success the dialog closes and `router.refresh()` drops the row. On a failure it closes
and **H10** shows under the row.

The body says what Remove does and does not do, in the design system's manner for a consequence
("state what happens and how to undo, never alarm or guilt"): nothing was created, nothing changes in
CommCare HQ, and the app can be brought in again at any time. It says nothing of files: staged bytes
lapse by the bucket's own rule (part 12, 2.6), and a file a creation step already published is an
ordinary file of the Project, which the Files dialog shows.

---

## 11. After the app is in (B11)

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
  `view.firstPublish` is not null (part 09, 12.3: the live app mapping is `adopted` and the read
  baseline still holds the list stored for that app, so Nova has not published here yet), that text
  is **D2**: Nova read
  the app on that day and has not published to it. It says what Nova did and knows, and makes no
  claim about what CommCare HQ holds today, which Nova has not looked at since. After the first
  publish it is today's text. The label is unchanged, and the card never says "Uploaded" of an app
  Nova did not upload: `DEPLOYMENT_STATE_LABELS.uploaded` is "On CommCare HQ" already.
- The kept list with its date and **Refresh from CommCare HQ**: A3's block (part 01, 6.5), unchanged.
- The confirmations Nova recorded at the birth are ordinary rows of the card's confirmations
  (`liveConfirmationRows`), attributed to the person who brought the app in, each with Withdraw
  (part 10, 6.5). B11 adds no row kind.
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

**The data is part 09's, and B11 stores nothing.** The list a person reviewed is kept on the app's
read baseline, not on the reading (part 09, 12.3):

- the column `app_deployment_baselines.first_publish_changes jsonb`, with a CHECK that holds it null
  unless the baseline's origin is `read`, lands in B8 (part 10's migration
  `20261201000000_hq_bring_in_ledger`, its section 11, with part 09's statements, its 12.3);
- B7 writes it at the birth through `adoptedAppBaselineWrite` as a `StoredFirstPublish` (the ids of
  the chosen declaration's list less the two Web Apps ids, and CommCare HQ's Web App setting at the
  reading), the first push ends it, and `recordRefreshedAppBaseline` keeps it;
- the viewer's reader is B7's `store.ts::readFirstPublishStates`, not `readAppBaseline`, which does
  not change for it;
- `DeploymentView.firstPublish: FirstPublishView | null` is filled through
  `resources.ts::firstPublishOf` (B7), which answers
  `firstPublishViewFromStored(state.stored, doc.appSettings.runsOnlyOn)` while the live app mapping
  is the adopted one the list was stored for, and null otherwise.

So the column is in B8; the writer, the reader, `firstPublishOf` and `DeploymentView.firstPublish`
are in B7; and B11, above both, adds no column, no migration, no store function and no type for it.
A person who chose a row other than the preselected one reads, at the first publish, the list of
the row they chose, and a person who has since changed where the app runs in App settings reads the
two Web Apps lines as they stand for the app now, because those two are worked out again from the
document and never stored (part 09, 12.3). B11 reads
`DeploymentView.firstPublish` from the records the dialog and the card already hold
(`usePublishingRecords`), and imports `FirstPublishView` from
`lib/publish/firstPublishChangeIds.ts` and `firstPublishLines` from
`lib/publish/firstPublishCopy.ts`, both client-safe.

**The Publish dialog.** In `PublishDialogBody.tsx`, the review step of a direct upload shows, for a
selected project space whose record holds `firstPublish`, a section above the confirmations:
`<FirstPublishLines view={record.firstPublish} surface="publish" />` (8.8), which draws the heading
`FIRST_PUBLISH_HEADING` as the section's `h2` and the lead `FIRST_PUBLISH_LEAD_PUBLISH`, which
tells the person that these changes come along with their own edits. It is information and holds no
control:
"Required confirmations and their consequences stay visible" (`design/readme.md`, "Publishing"), and
this is a consequence. It is not under Details, for the same reason. What the publish asks is
unchanged: the confirmations part 10 did not record, the project-space settings, and the Web App
setting where the declaration differs. A record with `firstPublish` null (a Nova-made app, any app
after its first push, a baseline Nova could not read) shows no section.

**The plan line.** `publishPlanCopy` and the type it reads, `PublishPlan`, are today private to
`PublishDialogBody.tsx` (the function takes `plan` alone), so no test and no second surface can
reach them. B11 moves both to `components/builder/publishOutcome.ts` as exports, with the three
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
| `creates`, where some other record of this app has a live `app` mapping whose `ownership` is `adopted` | "This creates a new app in this project space." | **D7**: that sentence, then that Nova can't update a copy of the app already there yet |

The second arm is the review's V21c said again at the moment it matters: a person reads the review
once, before the app exists, and meets this line when they are about to publish to another project
space. `publishingSectionModel.ts::broughtInElsewhere(records, target)` decides it from the
records the dialog already holds, and the dialog passes its answer as `context.broughtInElsewhere`.
`publishPlanCopy("creates", { broughtInElsewhere: true })` is D7, and every other plan ignores the
context.

### 11.3 The drift stop

Part 10 gives every sentence its origin (`hqChangedMessage`, `baselineUnknownSentence`,
`hqChangesConfirmedDetail`, `hqChangesNoneDetail`, `webAppsChangeMessage`) and moves
`PublishDialogBody.tsx` to them in B8, with the reader's own date. B11 adds what stands beside the
list of changes. Two strings of that dialog are named here, and they are two controls today:
"Publish over this" is the unticked checkbox on each change (`PublishDialogBody.tsx::
RemoteChangeChoice`), and "Publish over these changes" is the label the footer's primary button
takes while the publish holds changes to confirm. B11 changes neither.

Where a publish stops on `hq_changed` and the changes hold the app's own (`kind: "app"`), whatever
the app's origin, the dialog shows, inside `RemoteChangeChoice` and under its list of changes with
their "Publish over this" ticks:

- for a member who may delete: the heading **D8**, the button `STOP_PUBLISHING_ACTION` and
  `STOP_PUBLISHING_HELPER`. It opens the confirmation of 11.1. On success the dialog drops the
  refusal and every tick, returns to its destination step with the `role="status"` line **D9**, and
  its plan line for that project space reads `PUBLISH_PLAN_CREATES_BESIDE`;
- for an editor: the one line **D8b**, so the third way is known to exist and who can take it.

The three ways on are then all on one screen and none is chosen for the person: publish over what
changed (unticked, per change, as today), stop publishing here, or close the dialog and publish
later. The step 7 answer, bringing the changes in, is not named in the product.

### 11.4 Restoring an app whose HQ app another Nova app has since taken

Part 10 (5.4) makes `restoreApp` answer the project spaces it stopped publishing to. In
`app/(app)/(site)/app-list-body.tsx`, after a restore that succeeds with `stoppedPublishing` not
empty: `showToast("info", D11, restoredStoppedPublishing(spaces), { persistent: true })`, each
project space as "“{domain}”" with its server's label where the app publishes to more than one
server. A restore that met `RestoreClaimsChangedError` arrives as the action's `error`,
`RESTORE_CLAIMS_CHANGED`, in the card's existing error line. The restored app's Publishing section
then shows the ended card of 11.1 with the `claimed-elsewhere` sentence, which names no person.

---

## 12. Components, primitives and state (B11)

### 12.1 New components

Every control comes from `@/components/shadcn`; every icon is Tabler through
`@iconify/react/offline`; every color is a `nova-*` token. No component below holds a decision: each
renders `screenOf(model)` or a pure function of its props.

| Component (file under `components/bring-in/` unless a path is given) | Renders | Composes |
|---|---|---|
| `BringInFlow.tsx` | the card's frame (a heading region, a scrolling middle, a footer that does not scroll) and the screen `screenOf` names. It draws the three short screens itself: `opening`, `gone` and `unopened` (9.2) | `useBringIn`; the eight below; `Spinner`, `Button` |
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
| `app/(app)/(site)/readings-in-progress.tsx` | section 10 | `Badge`, `Button`, `AlertDialog`, `RelativeTime` |
| `components/builder/StopPublishingDialog.tsx` | the confirmation of 11.1, shared by the card and the drift stop; its props are in 11.1 | `AlertDialog`, `Button` |

`BringInFlow` takes the three members of `useBringIn`'s input as its props (`seed`,
`landCreatedAppReceipt`, `projectToast`; 3.3) and calls the hook itself, so the hook's state lives
exactly as long as the flow is mounted.

Changed, not new: `components/chat/ChatSidebar.tsx` (the `takeover` prop),
`components/chat/ChatContainer.tsx` (mounts `BringInFlow` as `takeover`, handing it the seed, its
`landCreatedAppReceipt` and its `projectToast`), `components/builder/BuilderLayout.tsx` (passes
`BringInSeed` down; shows the `leaving` toast of 9.2),
`components/builder/CommCareConnectionContext.tsx` (`refresh`, `isRefreshing`, `refreshFailed`;
4.4), `components/builder/PublishPanel.tsx` (the context's refresh in place of its router
transition), `components/builder/DeploymentStatus.tsx` (section 11.1, with the prop `canStop`) and
`PublishDialogBody.tsx` (sections 4.4, 11.2 and 11.3),
`components/builder/app-setup/PublishingSection.tsx` (passes `canStop`),
`components/builder/publishOutcome.ts` (`PublishPlan`, `publishPlanCopy`),
`app/(app)/(site)/app-list.tsx`, `page.tsx` and `app-list-body.tsx` (sections 2, 10, 11.4 and
12.3). `components/builder/PublishDialog.tsx` is not changed: it forwards `PublishDialogProps`
whole to the body, and the one member that type gains is declared in `PublishDialogBody.tsx`
(4.4).

### 12.2 One new primitive: the radio group

`components/shadcn` has no radio group, and three screens here choose exactly one of a few full-width
rows with a line each (the app, where it runs, a table's answer). `components/CLAUDE.md` forbids
hand-rolling one and says how a missing primitive lands: "`npx shadcn add <name>` and then gets the
Nova pass". B11 adds `components/shadcn/radio-group.tsx` (`RadioGroup`, `RadioGroupItem`, on Base
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

- **The URL** owns which screen (`bringInLocation`), as it owns where a person is in the builder.
- **The model** (`bringInModel.ts`) owns everything else, in `useBringIn`'s reducer. It is component
  state of `ChatContainer`'s subtree and is gone when the flow unmounts; the row is what is durable.
- **Nothing goes in the session store or the doc store.** The session store is "ephemeral run/UI
  lifecycle" of a builder with an app, and there is no app until the landing, which is
  `installCreatedApp`'s to write.
- **The home rows** are server-rendered from `listOpenReadings` and refreshed by `router.refresh()`
  after a Remove made from the row, as a design's row is after a Discard.
- **A home reached with Back is told when it is stale.** Next serves Back from its client cache
  "whatever the route's own freshness says" (`RefreshStaleAppList.tsx`), and that component
  refreshes only where `lib/ui/appListFreshness.ts::consumeAppListStale()` is true, a note only
  `installCreatedApp` sets today. So a reading started, checked again or finished from the flow
  would leave the old rows behind it. `useBringIn` calls `markAppListStale()` in three places: when
  `row` from `start` or from `check-again` is dispatched; whenever an answer (`advanced`, `created`,
  a polled `row`) holds a `state` other than the one the model held; and the home row's own Check
  again calls it before it routes (10.3). A Remove made from the flow loads `/` afresh
  (`window.location.replace`), which needs no note. And since a person whose Project holds nothing
  yet starts from the empty state, `page.tsx::HomePage` mounts `<RefreshStaleAppList />` in that
  branch too: today only `AppList` mounts it, so a home that was empty when the flow was entered
  would otherwise come back from the cache still reading "Build your first app" over a reading in
  progress. The note is a module singleton that a page load drops, as its file says, so nothing
  outlives the tab.
- **The Publishing card** reads `DeploymentView` through `usePublishingRecords`, whose one store per
  app both the section and the dialog share; a stop upserts it and bumps
  `deploymentRecordsRevision`, as a publish does.

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
(`proof/hq-reads/reading/`, undici's `MockAgent`), and part 12's service in real-Postgres tests. The
specs here prove the screens and the landing. They are listed under "Tests".

---

## 13. Accessibility; empty, error and loading states (B11)

**The frame.** The card is a `section` labelled by its heading. Each screen's heading is the one `h1`
of the centred column and takes focus when the screen appears, through
`lib/ui/hooks/useDeferredFocus`, so "a delayed focus move yields when the person has already chosen
another control". The middle scrolls and the footer does not, at every width: under 560px the footer's
buttons stack, each at its one 44px height, primary first. Every control is reachable in reading
order by Tab, radio groups by arrow keys, and Escape does nothing here (there is nothing to dismiss;
the picker's Cancel is a button). Entrances fade and rise on the shared ease; under
`prefers-reduced-motion` the global near-zero rule applies and no lifecycle depends on an animation
ending.

**Announcements.** One `role="status"` region per screen carries progress (the step's label, a
creation's lead, "Copied"). `role="alert"` is used for exactly three things: a refusal's sentence,
the line that says which choice is missing, and a request that failed and now waits for the person
(the lines of the Error column below). The one silent retry (**W5**) is progress and rides the
status region. A stop is not an alert:
it is the screen's heading. No state is told by color alone: every badge is a word, every rung of the
card states its condition in text, and amber is used only where the design system gives it meaning
(a stop, recovering, something to change in CommCare HQ).

**Links that leave Nova** (each "Open in CommCare HQ", "Open Settings") open a new tab, carry
`tabler:external-link` and a visually hidden "opens in a new tab".

| Screen | Loading | Empty | Error |
|---|---|---|---|
| Picker, connection | `HqNotConnected`'s button reads "Checking connection" with `aria-busy` while the context's `isRefreshing` is true | no connection: the aside of 4.4 | the context's `refreshFailed`: **K22** under the aside's buttons with `role="alert"`, the button offered again. The Publish dialog shows the same line |
| Picker, Project | none: the seed is in the page | no Project to add to: part 12's `no_project_access` sentence and **Go to your apps** | none |
| Picker, apps | three `Skeleton` rows of the row's height and the status **K9**; while no app is chosen the footer's primary is `aria-disabled` with **K18** ("You can read an app once you've chosen one") as its description | **K10**; with a filter that matches nothing, **K12** | a stop: its block (4.5). `picker.apps` of `failed`: **K20** with **Try again**, which dispatches `picker-reload` |
| Picker, starting | the primary reads **Starting** with `aria-busy` while `call` is `start` | none | a coded refusal's sentence in a `role="alert"` line above the footer; `failedCall` of `start`: **K21** there, and the primary offered again |
| Opening a reading (`opening`) | the status **W7** ("Opening where you left off") with the spinner | `gone`: the `reading_not_found` sentence, **Choose an app**, **Go to your apps** | `lost` (a load that failed with no code): **W8** with **Try again**, which dispatches `retry` |
| Reading | the screen is the loading state (5) | none | one silent retry shown as **W5**, then `lost`: **W6** with **Carry on**, which dispatches `retry`; `project_access_lost`: its sentence |
| Stop | none | none | `failedCall` of `check-again`: **S2** in a `role="alert"` line, the block unchanged. `failedCall` of `remove`: **H10** there |
| Account | none | an account always holds at least one finding (part 12, 2.4); `accountGroups` of an empty list renders the lead and the footer alone, and logs `[bring-in] account with no findings` at error | `failedCall` of `check-again`: **S2**. Clipboard refused: the text in a `Textarea` with **A10** |
| Review | none | a section whose data is absent is not rendered (8.1) | section 8.10, row by row |
| Creating (`creating`) | the screen is the loading state (9.1) | none | one silent retry shown as **W5**, then `lost`: **X4** with **Try again**, which dispatches `retry` and posts the same `create` (a retry returns the same app; part 12, 6.6) |
| Created, not opened (`unopened`) | none | none | the screen is the error state (9.2): part 12's `UNVERIFIED_LANDING_TITLE`, **Open your app**, **Go to your apps** |
| Home rows | the list streams with the app list's `Suspense`; `AppListFallback` is unchanged | the section is absent | **H9**, **H10** under the row |
| Publishing card | as today | as today | a stop that failed: the error's sentence or **D10**, in the dialog |

---

## 14. MCP (B12)

### 14.1 What B12 registers, and who is given it

Six tools, in `lib/mcp/server.ts::registerNovaTools`, after `registerGetHqConnection`:

| Tool | File (`lib/mcp/tools/`) | Scope | Calls |
|---|---|---|---|
| `list_hq_apps` | `listHqApps.ts` | `nova.hq.read` | `listHqAppsForPicker` (4.2) |
| `read_hq_app` | `readHqApp.ts` | `nova.hq.read` | `startReading`, `advanceReadingWithin`, `checkReadingAgain`, `readReading`, `removeReading` (part 12) |
| `bring_in_hq_app` | `bringInHqApp.ts` | `nova.hq.write` | `createFromReadingWithin` (part 12) |
| `stop_publishing` | `stopPublishing.ts` | `nova.hq.write` | `stopPublishing` (part 10, 8.3) |
| `refresh_managed_data` | `managedData.ts` | `nova.hq.write` | `refreshManagedLookupTable`, `refreshManagedPlaces` (part 11, 12.4) |
| `set_lookup_table_management` | `managedData.ts` | `nova.hq.write` | `manageLookupTableInNova`, `letHqManageLookupTable` (part 11, 12.4) |

Each declares `scopeChallenge: oauthScopeChallenge(ctx, <scope>)` and calls `assertScope(ctx, <scope>,
"<tool>")` as its first statement, before any read, "so a missing-scope credential can't probe
whether a record exists" (`lib/mcp/scopes.ts`). The scopes are part 05's (its section 13):
`read_hq_app` writes Nova's own reading and nothing at CommCare HQ, and `bring_in_hq_app` records a
deployment that authorizes later writes to that HQ app.

**The Solutions Architect is given none of the six**, and none enters `SHARED_TOOL_REGISTRY`. The
standing reason is `deploymentTools.ts`'s own: "A deployment is not authored vocabulary: it is durable
state about somebody else's server, and an agent designing an app has no business reasoning about
it." Bringing an app in also needs answers only a person gives (a Project, where it runs, what happens
to a table other apps read), and the chat's agent works inside one app that already exists. So no
`scripts/test-schema.ts` entry is added for them: "A tool only MCP serves needs no entry" (root
`CLAUDE.md`).

**The budget.** `read_hq_app` and `bring_in_hq_app` pass part 12's
`lib/deployment/reading/budget.ts::HQ_READING_STEP_MS`, 270 seconds, as its `budgetMs`: the one
budget a step has for every caller, the browser's routes included (its 3.6 and 4.5). They do not
pass the request's cap. `app/api/mcp/dispatch.ts::MCP_MAX_DURATION_SECONDS` is 300 seconds
measured from the request's start, and the token's check and the tool's dispatch have spent part
of it before a tool body runs, so a step given all 300 could not answer inside it. The 30 seconds
between the two numbers are part 12's `HQ_READING_ROUTE_MARGIN_SECONDS`, and its `budget.test.ts`
holds the sum equal to the cap, so B12 adds no constant, no `lib/mcp/budget.ts` and no change to
`dispatch.ts` but a sentence of its comment ("Contracts"). `app/api/mcp/route.ts::maxDuration`
stays the literal `300` Next requires. Under part 12's rule (its 4.5) one call runs one read step,
or media steps for its first minute, or creation's final step, and always answers inside its 270
seconds with the reading's id and state. A call that finds the server's one reading slot taken
answers `again: true` after at most 20 seconds with the state unchanged (part 12, 3.6), and the
client calls again as for any `again`. **Resuming is calling the same tool again with the same
arguments**: every step is idempotent, a reading's id is in every answer, and a creation that
already committed answers `created` with the same app.

### 14.2 `list_hq_apps`

Description: "List the apps in one CommCare HQ project space that can be brought in to Nova. Call
`get_hq_connection` first and pass the exact `domain` the user chose; never choose a project space for
them. Each app has its `hq_app_id` and `name`. `in_nova` is null where the app is free to bring in.
Otherwise it says a Nova app already manages it, since one CommCare HQ app is managed by one Nova app:
`open` with the Nova `app_id` where the user can open it, or `elsewhere` with `next`, a sentence that
says who to ask and the two ways forward. Relay `next` as written. Pass `project_id` to also learn
which apps the user has already started bringing in to that Project (`reading_id`). Reads CommCare HQ
with the user's own key and changes nothing."

```ts
inputSchema: z.strictObject({
	domain: z.string().trim().min(1).describe(
		"Exact CommCare HQ project space the user chose. One of get_hq_connection's available_domains."),
	project_id: z.string().min(1).max(255).optional().describe(
		"A Nova Project the user can edit. Marks the apps they have already started bringing in there."),
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
			| { kind: "elsewhere"; how: "brought-in" | "published"; at: string;
			    contact: { role: "person" | "owners"; names: string[] }; next: string };
		reading_id: string | null;
	}[];
}
```

`next` is `alreadyInNovaNext(claim)` with its date as the UTC day. Errors: `not-connected` is the
existing `hq_not_configured` with the sentence "CommCare HQ is not configured. Add your HQ credentials
in Settings before listing a project space's apps."; every stop whose code is `not-a-member` is the
existing `domain_not_authorized`; every other stop is `hq_read_stopped` (14.8).

`listHqAppsForPicker` answers `not-a-member` from two places (4.2): `getHqCredentials` answering
`not_authorized`, where the stored key does not list the project space, and CommCare HQ's own
answer classified by part 05, where the key lists it and HQ turns the account away. A client cannot
act differently on the two and should not have to tell them apart, so both are one tag, the one
`check_project_space_compatibility` already uses for a project space the key can't reach. The
message differs, because what is true differs. Where the stored key does not list the project
space, it is that tool's own sentence, built from the user's stored project spaces
(`getCommCareSettings`): "Your stored CommCare HQ API key can't reach the “{domain}” project space.
It reaches: {reachable}. Pass one of those as `domain`, or update your key in Settings." Where the
key lists it and CommCare HQ turned the account away, that sentence would name the project space
as both out of reach and in reach, so the message is part 01's body for `not-a-member`, and the
payload carries `circumstance: "not-a-member"` with the block's `title` and `next`, which say the
membership is what to look at.

### 14.3 `read_hq_app`

Description: "Read one CommCare HQ app so it can be brought in to Nova, and say whether it can be.
Nothing is created and nothing changes in CommCare HQ. Start with `project_id`, `domain` and
`hq_app_id`: where the user can edit more than one Nova Project, ask which one the app should be
added to and never choose it for them, because an app that reads lookup tables stays in the Project
it is added to; where they can edit one, tell them which it is. Reading takes several
calls for a large app. While `again` is true, call this tool again with only the `reading_id` it
returned; each call does one bounded step and is safe to repeat. `state` ends as one of: `ready`,
with `review` (what will be created; `runs_on`, the ways the app can run, each with
`first_publish`, what the first upload from Nova changes in CommCare HQ under that choice;
what stays in CommCare HQ; and `review.review_digest`); `account`, with `account.findings`, each thing
Nova cannot hold, where it is, and whether it is Nova's to build, something Nova does not bring in, or
something to change in CommCare HQ; or `stopped`, with `stop`, something that ended the read such as a
permission, a plan without API access, or an app already in Nova. Relay titles, sentences and next
steps as written, and do not summarize an account as a failure: it is everything Nova found on this
read, and `check_again` says a later read may find more. For a `first_publish`, relay
`workers.lines` first, then `hq_only.lines`, each `sentence` as written, then `reassurance` where it
is not null, then `note`. With
`action: \"check_again\"` Nova reads the app afresh, after a change in CommCare HQ or a Nova update.
With `action: \"remove\"` it forgets the reading. An account longer than one answer is paged: pass
`findings_from` with the `next_from` it gave."

```ts
inputSchema: z.strictObject({
	project_id: z.string().min(1).max(255).optional().describe(
		"To start: the Nova Project the user chose to add the app to. Send with domain and hq_app_id."),
	domain: z.string().trim().min(1).optional().describe(
		"To start: the exact CommCare HQ project space the app is in."),
	hq_app_id: z.string().regex(/^[\w-]{1,255}$/).optional().describe(
		"To start: the app's hq_app_id from list_hq_apps."),
	reading_id: z.string().regex(CANONICAL_UUID_PATTERN).optional().describe(
		"To continue: the reading_id an earlier call returned. Send it alone, or with action or findings_from."),
	action: z.enum(["continue", "check_again", "remove"]).optional().describe(
		"With reading_id. continue (the default) does the next step. check_again reads the app afresh. remove forgets the reading."),
	findings_from: z.number().int().min(0).optional().describe(
		"With reading_id, for an account: the next_from of the previous answer."),
})
```

The two forms are checked by the handler, because a choice between property sets is no keyword of an
object schema the SDK serves and "handler-owned argument validation" is what `McpInvalidInputError`
is for: exactly the three start fields and nothing else, or `reading_id` with only `action` and
`findings_from`. Anything else answers `invalid_input` with "Send project_id, domain and hq_app_id to
start reading an app, or reading_id alone to continue one. This call mixed the two."

Starting resolves the server from the user's connection (`getCommCareSettings`; none is
`hq_not_configured` with **M6**), calls `startReading`, then `advanceReadingWithin`. Continuing calls
`advanceReadingWithin`; `check_again` calls `checkReadingAgain` first; `remove` calls `removeReading`
and answers `{ reading_id, state: "removed" }`. A refusal of part 12 maps as 14.8 says.

Result, built by `lib/mcp/tools/readingProjection.ts` (new):

```ts
// lib/mcp/tools/readingProjection.ts
/** One reading as an MCP client reads it: the object below. */
export function describeReading(
	view: ReadingView,
	options: {
		/** The first finding of the page, 0 unless the call sent `findings_from`. */
		readonly findingsFrom: number;
		/** The `again` that `advanceReadingWithin` answered (part 12, 3.5). */
		readonly again: boolean;
	},
): ReadingProjection;
/** The tool error of 14.8 for one refusal of part 12. `projectId` is the call's, where it had one. */
export function mapReadingRefusal(
	refusal: ReadingRefusal, projectId: string | null,
): BringInToolError;

export interface ReadingProjection {
	reading_id: string;
	project_id: string;
	server: "production" | "india" | "eu";
	domain: string;
	hq_app_id: string;
	hq_app_name: string | null;
	state: "reading" | "media" | "account" | "stopped" | "ready" | "created" | "removed";
	/** Call read_hq_app again now with reading_id. */
	again: boolean;
	/** The step last reported, in words: READING_PHASE_LABELS with its counts filled. */
	step: string | null;
	media: { done: number; total: number } | null;
	read_at: string | null;
	/** `next` is circumstanceNext(finding), the string the stop screen shows (6.1). */
	stop?: { code: string; title: string; body: string; next: string };
	account?: {
		/** accountCounts over the findings the row holds (7.1). */
		counts: { not_yet: number; never: number; fix_in_hq: number };
		/** FINDING_LABELS and FINDING_NEXT_STEPS for each standing the account holds. */
		labels: { standing: "not-yet" | "never" | "fix-in-hq"; label: string; next: string }[];
		findings: {
			code: string;
			standing: "not-yet" | "never" | "fix-in-hq";
			/** placeLine(place). */
			place: string;
			/** lib/deployment's hqPlaceUrl for the reading's app and this place, for the user to open. */
			hq_url: string | null;
			sentence: string;
			/** detail.name, as CommCare HQ shows it. */
			named: string | null;
			/** A circumstance's own title, and its next step: circumstanceNext(finding) (7.2). */
			title?: string;
			next?: string;
		}[];
		findings_from: number;
		next_from: number | null;
		total: number;
		/** ACCOUNT_CHECK_AGAIN_LINE (part 01, 9.1): a later read may find more. On every page. */
		check_again: string;
		/** moreFindingsLine, where the row holds fewer findings than the read met. */
		more: string | null;
		media_checked: boolean;
		/** Part 11's line R12 where media_checked is false. */
		note: string | null;
		/** READING_LEARNED_LINES, where the manifest has moved since this check. */
		learned: string | null;
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
	app_id?: string;
}
```

**The first-publish list is on each `runs_on` entry, and the review holds none of its own.** Part 09
gives B12 one object, `first_publish`: its `firstPublishLines` value with the keys in snake case
(`heading`, `lead`, `workers: { label, lines: [{ id, sentence }] }`, `hq_only` likewise,
`reassurance`, `note`; its 12.2). Its own 12.1 makes the list a fact of a choice, so the object
sits on the choice, built with the surface `review`: an agent that shows the user three ways the
app can run shows, with each, what choosing it changes, and cannot relay the preselected row's list
for a row the user did not take (Departure 14, which part 09's 12.2 states the same way). The
key names, the line shape and the order are part 09's, unchanged, and no `touches_workers` key is
served: `workers.lines` is empty exactly where `reassurance` is not null.

**A circumstance's next step is one string on every surface.** `stop.next`, a finding's `next`, the
`stop.next` of a `held` creation (14.4) and the `next` of an `hq_read_stopped` error (14.8) are all
`circumstanceNext(finding)` (part 01, 8.4), the function the stop screen and the account call, so
`already-in-nova` and a refused date and time split read the same over MCP as on screen.

Every sentence is the one the screen shows, from the same exports (`lib/publish/hqFindingCopy.ts`,
`hqReadingCopy.ts`, `managedData.ts`, `keptValues.ts`, part 09's `firstPublishCopy.ts` and this
part's `bringInCopy.ts`), with dates as ISO text or the UTC day. **The page of findings fits the client.**
`describeReading` takes findings from `findings_from` until the JSON of the whole result would pass
80,000 characters, which is under `lib/mcp/resultSize.ts::MAX_RESULT_SIZE_CHARS`, and sets `next_from`
to the first finding left out, or null. The tool registers `LARGE_RESULT_META`. `total` is how many
the row holds.

### 14.4 `bring_in_hq_app`

Description: "Create a Nova app from a CommCare HQ app that `read_hq_app` found ready. Call it only
after the user has seen the review and answered it. Every answer is theirs: never choose the name,
where the app runs, the date-and-time split or a lookup table's answer for them, and never default to
the preselected choice without saying so and hearing yes. `review_digest` is the review they
answered. `runs_only_on` and `split_datetime` together must be one of `review.runs_on`. `table_choices`
holds one answer for each table whose review entry has a `choice`, by tag, and `{}` where none has.
The result's `status` is `created` (the app exists, in the Project the reading was started in, and
publishes back to the CommCare HQ app it came from); `again` (call again now with the same arguments,
Nova is still bringing in its files); `review_changed` (something changed in CommCare HQ or the
Project, nothing was created, and `reading` holds what stands now, to show the user again); or `held`
(nothing was created and `stop` says why, such as a table choice still to make or a key CommCare HQ
turned down). Creating changes nothing in CommCare HQ. Before the first `upload_app_to_hq`, relay
`first_publish`, from the chosen `review.runs_on` entry or from
`check_project_space_compatibility`: `workers.lines` first, then `hq_only.lines`, each `sentence` as
written, then `reassurance` where it is not null, then `note`."

```ts
inputSchema: z.strictObject({
	reading_id: z.string().regex(CANONICAL_UUID_PATTERN).describe(
		"The reading_id of a reading whose state is ready."),
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
the schema and not only by a description. `project_id` is not an input: the reading has had its
Project since `read_hq_app` started it (Departure 1). The handler maps the six fields to
`BringInInput` (`reviewDigest`, `appName`, `runsOnlyOn`, `splitDatetime`, `tableChoices`) and calls
`createFromReadingWithin(actor, reading_id, input, HQ_READING_STEP_MS)`. A pair that is none of
`review.runs_on`, and an answer the review did not offer, are part 12's `choice_not_offered`; a tag
left unanswered is its `held` with `table-differs-in-project`, whose `detail.name` is the tag (part
11, 7.2). Why an answer is not offered is already in the review the agent showed: that answer's
`reason` (14.3), R10's sentence for `needs-admin`, `managed-elsewhere`, `app-reads-a-missing-column`
or `fails-a-project-space-rule`, the same four the screen draws (8.5). A `choice_not_offered`
refusal is a tool error with part 12's sentence (14.8); the agent reads the review again with
`read_hq_app` and relays that answer's `reason`.

Result, by part 12's `CreateResult`:

```ts
| { status: "created"; app_id: string; project_id: string; app_name: string; url: string;
    brought_in_from: { server: "production" | "india" | "eu"; domain: string; hq_app_id: string };
    message: string }
| { status: "again"; publishing: { done: number; total: number } | null; message: string;
    reading: ReadingProjection }
| { status: "review_changed"; message: string; reading: ReadingProjection }
/** `stop.next` is circumstanceNext(finding), as in 14.3. */
| { status: "held"; message: string; stop: { code: string; title: string; body: string; next: string };
    reading: ReadingProjection }
```

Each `reading` is `describeReading(result.reading, { findingsFrom: 0, again })`, `again` true
exactly where the status is `review_changed` and the row is in `reading` or `media`: that reading
is advanced with `read_hq_app`, and its review is shown when it is `ready` again.

`url` is the app's page on the main host: `` `${AS_ORIGIN}/build/${appId}` ``, with
`lib/hostnames.ts::AS_ORIGIN`, the main host's origin in production and the dev origin locally. No
MCP tool returns a builder address today (`get_app` returns none), so this is the first, built in
`bringInHqApp.ts` alone. `message` is **M1** for `created`,
**M2** for `again`, and `CREATE_RESULT_LEADS`' sentence for the other two. The receipt's blueprint is
not returned: `get_app` reads the app. A `refused` answer is a tool error (14.8).

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
returns. `not_permitted` arrives as `permission_denied` with part 10's sentence (its map lands in
B8).

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

Results carry the sentences of part 11's `lib/publish/managedData.ts` as `message`, each the one
its outcome names (its section 9's table of reasons, and its 11.4 for places): for a table, T4 to
T7 and T13 to T21; for places, O6, O8 to O13 and O17, with T18 and T19, which both share. T4 and
O17 are what a caller with no CommCare HQ connection is told. For `confirmed: false` the dialog's
body lines (T9 or T11) are `lines`, with `apps`.

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

`touches_workers` is not added. The view is the one part 09 keeps on the read baseline and shows as
`DeploymentView.firstPublish` (11.2): for the deployment of this app on the checked project space,
non-null while the live app mapping is the adopted one the list was stored for, and null for an app
Nova made, for any app after its first push, for an ended deployment and for a project space the
app has not reached. The tool calls `readFirstPublishStates(scope)` and
`firstPublishOf(deployment, states.get(deployment.id), doc.appSettings.runsOnlyOn)` (both part
09's, B7; its 12.3), the function that fills the view for the builder, so the dialog and MCP cannot
answer differently, and returns `firstPublishLines(view, "publish")` with its keys in snake case.
Its description gains, at its end: " `first_publish`, where it is not null, is what this app's first
upload changes in the CommCare HQ app it was brought in from. Relay each `sentence` of
`workers.lines`, then of `hq_only.lines`, then `reassurance` where it is not null, then `note`,
before the upload." This tool is where an agent learns the first-publish lines of a brought-in app
before the fact, since `upload_app_to_hq` has no review step (part 09, 12.2).

**`get_deployment`** and **`refresh_deployment`**: `state` already admits `ended` (B8, part 10); B12
adds `brought_in` and `ending` and names all three in `get_deployment`'s description.
`deploymentProjection.ts::describeDeployment` gains
`brought_in: { at: string; by: string } | null` (from `broughtInOf`'s rule, server-side) and `ending:
{ at: string; by: string; reason: "stopped" | "claimed-elsewhere"; hq_app_id: string; message: string
} | null` (part 10's `deploymentEnding`, with `endedLine` as `message` and the UTC day).
`get_deployment`'s description changes its state list to "`preflight`, `uploaded`,
`built`, `released`, `runnable`, `incomplete` or `ended`" and gains: " `brought_in` says the app came
from CommCare HQ on that project space, when and by whom. `ending` says Nova stopped publishing
there: the app in CommCare HQ stays, and the next upload makes a new app beside it."

**`upload_app_to_hq`**: its description gains: " An app brought in from CommCare HQ updates the app it
came from, keeping every menu's and form's ID there. `hq_changed` then measures changes since the app
was brought in: each change's `since` says which (`published` or `brought-in` with `at`), and a date
in a message is the UTC day. `publishing_stopped` means someone stopped publishing this app to that
project space while the upload was getting ready; relay the `message`, which says whether anything was
sent, and do not upload again unless the user wants a new app there." The `remote_changes` entries
gain `since: { kind: "published" } | { kind: "brought-in"; at: string }` in B12: part 10 gives the
origin and its instant (its 9.1) and serves no new key in B8 ("`ending`, `brought_in` and `since`
are B12's", its "Tests"). The error tag `publishing_stopped` joins `UploadErrorType` and the served
enum in B8 (part 10, 8.5); B12 writes its paragraph in that type's comment and this description.

**`get_hq_connection`**: its description's "Call this before `upload_app_to_hq` to confirm the
target" becomes "Call this before `upload_app_to_hq` or `list_hq_apps` to confirm the project space",
and nothing else moves.

### 14.8 Error shapes

`lib/mcp/errors.ts::McpErrorType` gains two members, `McpErrorPayload` four optional fields, and the
file one thrown class that carries them:

```ts
export type BringInErrorType =
	/** A read of CommCare HQ ended before there was a reading to hold it. */
	| "hq_read_stopped"
	/** A creation Nova refused for a reason that is neither bad input, access, nor absence. */
	| "bring_in_refused";

export type McpErrorType =
	| "not_found" | "invalid_input" | "scope_missing" | "permission_denied"
	| UploadErrorType | BringInErrorType | AgentErrorType;

export interface McpErrorPayload {
	// as today, then:
	/** The READ_CIRCUMSTANCES code, on hq_read_stopped and on a not-a-member domain_not_authorized. */
	circumstance?: string;
	/** The circumstance's title and its circumstanceNext(finding), beside message (its body). */
	title?: string;
	next?: string;
	/** Part 12's ReadingRefusal, wherever a reading refused. */
	refusal?: string;
}

/** An expected refusal of a bring-in tool, already worded. The handlers of 14.2 to 14.4 throw it. */
export class BringInToolError extends Error {
	constructor(
		readonly errorType:
			| BringInErrorType | "not_found" | "permission_denied" | "invalid_input"
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
So the four fields need a branch of their own. B12 adds one, before the generic classifier: `err
instanceof BringInToolError` logs `log.warn("[mcp] bring-in refused", { userId, errorType,
circumstance, refusal })` (an expected outcome, as every other branch of the kind logs at `warn`)
and returns `payload(err.errorType, err.message)` with `circumstance`, `title`, `next` and
`refusal` spread on where the error holds them, and `project_id` from `err.fields.projectId` where
the handler's context gave none. `mapReadingRefusal(refusal, projectId)` in
`lib/mcp/tools/readingProjection.ts` builds the error for each `ReadingRefusal` from a `satisfies
Record<ReadingRefusal, …>` table of the rows below, so a refusal part 12 adds fails to compile
until it has a tag. Adding `BringInErrorType` to the union is what the compiler holds: every
consumer that switches on `McpErrorType` exhaustively meets the two new tags.

| What happened | `error_type` | Also carried | `message` |
|---|---|---|---|
| a tool called without its scope | `scope_missing` (today's) | `required_scope` | today's |
| no CommCare HQ connection, at `list_hq_apps` | `hq_not_configured` (today's) | | **M5**: "CommCare HQ is not configured. Add your HQ credentials in Settings before listing a project space's apps." |
| no CommCare HQ connection, at a starting `read_hq_app` | `hq_not_configured` (today's) | | **M6**: "CommCare HQ is not configured. Add your HQ credentials in Settings before reading an app." |
| a `not-a-member` stop at `list_hq_apps`, the stored key not listing the project space | `domain_not_authorized` (today's) | | names the project spaces it reaches (14.2) |
| a `not-a-member` stop at `list_hq_apps`, CommCare HQ turning the account away | `domain_not_authorized` (today's) | `circumstance`, `title`, `next` | the circumstance's body |
| any other stop at `list_hq_apps` | `hq_read_stopped` | `circumstance`, `title`, `next` | the circumstance's body |
| `reading_not_found` | `not_found` (today's) | `refusal` | part 12's sentence |
| `no_project_access`, `project_access_lost` | `permission_denied` (today's) | `refusal`, `project_id` | part 12's sentence |
| `invalid_input`, `name_missing`, `choice_not_offered`, and the handler's own checks | `invalid_input` (today's) | `refusal` where part 12 gave one | the sentence |
| `not_ready`, `project_changed`, `app_unavailable` | `bring_in_refused` | `refusal` | part 12's sentence |
| `not_permitted` at `stop_publishing` | `permission_denied` | | part 10's sentence |

A stop, an account and a review that changed are never errors: they are results with a `state` or a
`status`, as part 12's routes answer them with 200. `not_permitted` at `stop_publishing` does not go
through `BringInToolError`: part 10's own map for it lands in B8 (14.5).

### 14.9 `servedSchemas`, and the tools' own tests

`lib/mcp/__tests__/servedSchemas.test.ts` already compiles every served schema and reads every
pattern with the Rust engine, so the six new tools are held to both by being registered. B12 adds
five tests there ("Tests"), and the handler tests of each tool under `lib/mcp/__tests__/`, every one
of them through the real SDK client and server over the linked transport
(`lib/mcp/__tests__/client.ts::withMcpClient`), as `docs/testing.md` requires of an MCP handler
test.

### 14.10 `content/docs/mcp/tools.mdx`

Text fixed here, landed by B14 with the other public docs (17.3).

---

## 15. The guide, the versions and the billed check (B12)

### 15.1 The guide

`lib/agent/authoring/reference.ts::AUTHORING_REFERENCE` is the guide both the Solutions Architect and
an MCP agent read (`lib/agent/tools/getAuthoringGuide.ts`). Stack B has already added to it: part 08's
sentence C7 (B6, on `list(…)` in a search condition, in `expressions`) and part 11's sentence on
data managed in CommCare HQ (B9, in `expressions` too). B12 adds one paragraph, as the last
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
sit and needs no edit. B12 adds no test for this paragraph. One that held the `workflows` entry to end
with these words would pin a prose string whose exact value and position are no contract of any consumer,
which `docs/testing.md` rules out ("Do not pin incidental strings … unless that exact value or order is
the external contract"); the platform test is different in kind, since it holds a generated sentence to
the feature it describes. What holds the paragraph is what holds every guide sentence: the
`MODEL_CONTEXT_VERSION` move in the same pull request (15.2), which `lib/agent/CLAUDE.md` binds to any
change of the guide, and the pull request's own review.

That is the whole of the final guide's assembly for stack B: three additions in two entries (part
08's C7 and part 11's sentence both sit in `expressions`; this one is in `workflows`), each written
by the part that makes it true, with this one last.

### 15.2 `MODEL_CONTEXT_VERSION` and `RUNTIME_VERSION`

`lib/models.ts::MODEL_CONTEXT_VERSION` moves from `"v7-hq-round-trip-bring-in.b9"` to
`"v7-hq-round-trip-bring-in.b12"` in B12, because the guide changed (`lib/agent/CLAUDE.md`: it "moves in
every pull request that changes … the authoring guide"). The six new tools do not move it: "A tool only
MCP serves is in no stored model context and does not move it". B11 moves nothing: it changes no tool, no
description and no guide sentence. Stack B's literals are therefore three, each written by the pull
request that changes what a model reads: `.b6` (part 08, B6), `.b9` (part 11, B9) and `.b12` here. B8,
which sits between B6 and B9, and B7 and B10, which sit between B9 and B11, write none (part 10's opening
says so of B8). `lib/chat/__tests__/compaction.test.ts`, which reads the constant, needs no edit: it
compares against the import. `lib/db/appTests.ts::RUNTIME_VERSION` stays `19`, the value A9 leaves (part
04, 3.4): no pinned document and no evaluator changes in B11 or B12.

### 15.3 `scripts/test-schema.ts`

No entry is added by B11 or B12, and the header's list of known names does not change: B9 already
added `getOrganization` beside `getLookupTables` (part 11, 12.4). The six tools of section 14 are
MCP-only. The one billed run of stack B is **E1** ("Written and not yet run"): its list is the
schema-hash run's between the `main` stack B was cut from and B12's head, with `getLookupTables` and
`getOrganization` expected, asked once, on the person's yes, never on a standing approval. A tool
the run names that `scripts/test-schema.ts` does not register was missed by the pull request that
moved it, so B12 registers it with a prompt that uses one of its inputs, and names it in its
description (part 15, section 13.4, the same rule as stack A's).

---

## 16. The nova-plugin

One pull request in `../nova-plugin`, opened with B12 and merged only after stack B's deploy is live,
since a skill that names a tool the server does not yet serve fails at its first call. Every file
below changes in `skills/` and in its mirror under `.dev-plugin/skills/`.

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
5. **Read.** `read_hq_app { project_id, domain, hq_app_id }`, then `read_hq_app { reading_id }` while
   `again` is true. Tell the user once that a large app takes a few minutes and that nothing is being
   created or changed. Relay `step` when it changes, not on every call.
6. **If it stopped** (`state: "stopped"`): relay `stop.title`, `stop.body` and `stop.next` as
   written. Offer to check again where `next` invites it.
7. **If Nova can't bring it in yet** (`state: "account"`): say plainly that nothing was created and
   nothing changed in CommCare HQ. Give the counts, then the findings grouped by `place`, each with
   its `sentence`, its `named` where present, and the label of its standing; give each standing's
   `next` once. Page with `next_from` until it is null, or offer the rest where the list is long.
   Relay `learned` and `note` where present, and after the list relay `check_again` as written.
   "Never tell the user the list is complete: a later check may find more." "Never soften the list,
   never call it an error, and never offer to bring in part of the app: Nova brings in an app only
   when it can hold all of it."
   Tell the user the list is kept on their apps page in Nova, and that `/nova:bring_in` again checks
   it afresh.
8. **If it is ready** (`state: "ready"`): show the review in this order: the name; what will be
   created (`creates`); **where it runs**, every entry of `runs_on` with its `label`, `line` and
   `split_line`, saying which one Nova proposes, each of `runs_on_notes` and each entry of
   `cannot_run` (its `sentence`, its `features` as a list, its `files`); each table, with its
   `sentence` or its `choice` (title, body, and each answer's `label`, `lines` and `reason`); places
   and media; what stays in CommCare HQ (`kept`); `after`; and **what the first publish changes**,
   the proposed entry's `first_publish`: its `lead`, then "relay `workers.lines` first, then
   `hq_only.lines`, each `sentence` as written, then `reassurance` where it is not null, then
   `note`". "If the user picks another way for the app to run, show that entry's `first_publish`
   before you create: the list belongs to the choice."
9. **Ask, and wait.** The name (keep CommCare HQ's or another); where it runs; and each table choice.
   The callout, as a blockquote at the top of this step:

   > Never answer one of these for the user, and never send `bring_in_hq_app` until they have
   > answered every one: the Project where they can edit more than one, the name, where the app
   > runs, whether date and time questions are split, and each lookup table's answer. A table's
   > answer can change what other apps of the Project read. If the user says "use the defaults",
   > say what the defaults are first and get a yes.

10. **Create.** `bring_in_hq_app` with the six fields. While `status` is `again`, call it again with
    the same arguments. `review_changed`: say what `message` says, show `reading` again from step 6,
    7 or 8, and ask again; never resend old answers against a new review. `held`: relay `stop`, and
    for a table choice ask that one question.
11. **Report.** On `created`: the app's name, its `url`, that it is in Nova and nothing changed in
    CommCare HQ, that publishing from Nova updates the same HQ app, and the `after` sentences once
    more. Offer `/nova:show` and `/nova:edit`. "Do not upload it now unless the user asks."
12. **Errors.** One bullet for each `error_type` of section 14.8, written as given:
    - "`scope_missing`: the user's connection to Nova lacks the CommCare HQ access this needs.
      Relay `message`, which names the access to grant, and stop."
    - "`hq_not_configured`: the user has not connected CommCare HQ. Point at commcare.app/settings
      and stop, as in step 2."
    - "`domain_not_authorized`: the key can't reach that project space, or CommCare HQ turned the
      account away there. Relay `message`, and `title` and `next` where the response has them.
      Where the message names project spaces the key reaches, ask whether to use one of those."
    - "`hq_read_stopped`: CommCare HQ ended the read before Nova had anything to keep. Relay
      `title`, `message` and `next` as written, and try again only where `next` invites it."
    - "`not_found`: that reading is gone. Relay `message` and offer to start again from step 3."
    - "`permission_denied`: the user can't add an app to that Project, or no longer can. Relay
      `message`, and ask which other Project to use where they can edit one."
    - "`invalid_input`: an answer was not one the review offered, or the name was missing. Relay
      `message`, read the review again with `read_hq_app` and the `reading_id`, and ask the user
      again. Never pick a replacement answer."
    - "`bring_in_refused`: Nova can't create the app from this reading as it stands. Relay
      `message` and stop. Do not send `bring_in_hq_app` again until the user asks."

### 16.2 The `upload_to_hq` sweep, by claim

The sweep is by what the skill claims, in prose, not by a search for a tool's name. Five claims
change and one sentence is added for part 01:

| The claim, in `skills/upload_to_hq/SKILL.md` | Today | From this pull request |
|---|---|---|
| the frontmatter `description` | "…along with the lookup tables it reads and the places in its organization. … The first upload to a project space creates the HQ app; uploading again updates that same app in place." | "…along with the lookup tables and places Nova manages for it. … The first upload to a project space creates the HQ app, or updates the HQ app it was brought in from; uploading again updates that same app in place." |
| the confirmation the skill shows before uploading (step 5) | "a first upload creates the app there, and a later one updates that same HQ app in place. Any Project data tables the app reads and any places in its organization go up with it." | "a first upload creates the app there, and a later one updates that same HQ app in place. If this app was brought in from **<target>**, even the first upload updates the app it came from. Project data tables and places that Nova manages go up with it; ones CommCare HQ manages are left exactly as they are." |
| before the confirmation (step 4, after the compatibility check) | nothing | a new paragraph: "If the check's `first_publish` is not null, this is Nova's first upload to an app it brought in. In the same message as the confirmation, before the user says yes, relay `workers.lines` first, then `hq_only.lines`, each `sentence` as written, then `reassurance` where it is not null, then `note`." |
| the `hq_changed` bullet | "changed in CommCare HQ since Nova last published it" | "changed in CommCare HQ since Nova last published it, or, for an app brought in and not yet published, since it was brought in (each entry's `since` says which, and the `message` names the day in UTC)". The bullet gains: "Where the user would rather leave CommCare HQ's version alone, an admin or owner of the Project can stop publishing there with `stop_publishing`: the app in CommCare HQ stays, and a later upload makes a new app beside it. Say what it does and ask before calling it." |
| the list of refusals | no `publishing_stopped` | a new bullet: "`publishing_stopped`: someone stopped publishing this app to that project space while this upload was getting ready. Relay the `message`, which says whether anything was sent. Uploading again makes a new app there, so ask first." |
| after the paragraph on `hq_app_empty` and `hq_app_gone` | nothing | "Each deployment can also carry `kept`: the settings that stay as CommCare HQ holds them on that project space, with the date Nova read them. Say them when the user asks what Nova leaves alone. `refresh_deployment` with `kept_values: true` reads them again and answers with a sentence instead of a state; relay it as it is." (part 01, "Contracts", A3) |

Two more sentences are read and left: "`created` also covers an upload that filled the empty app an
earlier, unfinished first upload left there" and the `left_behind` bullet for `kind: "app"` are both
still true, since an ended deployment's HQ app is named by the deployment's `ending` and is not left
behind (part 10, 8.6). The report step gains one line: "If `deployment.ending` is not null, say that
Nova stopped publishing there and relay its `message`."

`skills/build`, `edit`, `autobuild`, `find`, `list` and `show` make no claim this stack changes.

### 16.3 The version, the README and the order

`.claude-plugin/plugin.json`'s `version` moves from `2.4.2` to `2.5.0` (a new skill is a minor), and
`.dev-plugin/.claude-plugin/plugin.json` takes its own next minor from `1.31.0`, `1.32.0`. `README.md`
gains under "Skills": "- `/nova:bring_in [project space] [app name]`: bring an app you already have
in CommCare HQ in to Nova (reads it first and creates nothing until you've seen what comes in)". The
pull request is merged after the Nova deploy that carries stack B is confirmed live, and never
before.

---

## 17. Public docs, and `design/`

Stack B's public docs land in B14, "Contracts and public docs for stack B" (part 15,
`15-stack-contracts-and-exit.md`, sections 7.2 and 15). This part fixes their text; B14 lands the
pages in the same stack, so they are public in the deploy that makes them true. `design/readme.md`
changes with the screens it describes, in B11.

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
4. **While Nova reads.** "Reading a large app takes a few minutes, most of it for pictures and sounds.
   You can leave the page: Nova pauses after the step it's on and keeps your place under **Coming in
   from CommCare HQ** on your apps page, in the Project you added the app to. **Continue** picks up
   where it stopped."
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
   - part 08's sentence C13, verbatim (its "Copy", B6): "Nova brings in the expressions of your
     app: display conditions, validation, calculations, case list filters and search filters. It
     keeps the questions, case properties and tables they name as links, so renaming one later
     updates every expression that reads it."
   - "Nothing is created until you choose **Bring it in**."
6. **When Nova can't bring it in yet.** "Nova brings in an app only when it can hold every part of it
   exactly, so nothing is lost when you publish back. When it can't, it creates nothing and lists
   every reason it found, grouped by where it is in your app." Then:
   - "Each reason has one of three labels." Then the three labels with part 01's own sentence for
     each (`FINDING_LABELS` and `FINDING_NEXT_STEPS`, its 9.1), verbatim: "**Nova can't hold this
     yet.** There is nothing for you to change. Nova keeps this list, and you can check again
     whenever you like." "**Nova doesn't bring this in.** The app can come in once it no longer
     uses this. If your team relies on it, the app is best kept in CommCare HQ." "**Something to
     change in CommCare HQ.** Once this is changed in CommCare HQ, you can check again and Nova
     will read the app afresh."
   - "Under the list Nova says: When these are changed, Nova will check the app again and may find
     more to name." The quoted line is part 01's `ACCOUNT_CHECK_AGAIN_LINE`, verbatim, so the page
     never calls the list complete.
   - part 08's sentence C14, verbatim (its "Copy", B6): "A case list column, a filter, a display
     condition or a search setting that calls a function such as `int()` or `substr()` can't come
     in yet. Expressions inside forms can use every function CommCare runs."
   - "The list stays on your apps page. When Nova learns to hold what a list named, the row says
     so, and **Check again** reads the app afresh."
   - "Nova doesn't bring in part of an app."
7. **After it's in.** "The app opens in the builder, and **App setup → Publishing** already shows the
   project space it came from." Then the review's three sentences, V21a to V21c, with the project
   space said in general: "You can keep working on it in Nova and publish back to the same app in
   its project space." "If someone changes it in CommCare HQ, your next publish stops before
   sending anything and lists what changed." "If your team keeps a copy of this app in another
   project space, Nova can't update that copy yet. Publishing there makes a new app." And:
   "Bringing changes made in CommCare HQ in to Nova comes later; for now you can publish over them
   or stop publishing."
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

| Page | Today | From stack B (B14) |
|---|---|---|
| `building-with-nova.mdx`, "Start with a blank app" | ends "…without the reviewed conversational design flow." | gains a paragraph: "If the app already exists in CommCare HQ, you can [bring it in](./bringing-in-from-commcare-hq.mdx) and carry on from where it is." |
| `index.mdx`, the line for Building an app | "…resume an unfinished design, or start with a blank app." | unchanged; the new page's line follows it (17.1) |
| `publishing.mdx`, the opening | "Publishing sends your app to a CommCare HQ project space. Nova remembers where it went, so you can come back at any time and see how far along it is." | gains: "An app you [brought in from CommCare HQ](./bringing-in-from-commcare-hq.mdx) publishes back to the app it came from." |
| `publishing.mdx`, "On CommCare HQ" | "Publishing again **updates this same app in place**, name included…" | gains before it: "For an app you brought in, this card is there from the start, and its first publish updates the app it came from." Then part 09's one paragraph, as part 09 writes it ("The first time you publish an app you brought in, Nova lists what will differ in CommCare HQ…"; its "Contracts"), and no second wording of it from this part |
| `publishing.mdx`, "Each publish keeps every menu's and every form's ID in CommCare HQ." | as quoted | gains: "An app you brought in keeps the IDs CommCare HQ gave it, in the project space it came from. In any other project space Nova makes a new app with its own." |
| `publishing.mdx`, "Changes made in CommCare HQ" | part 10's two changes (its "Public docs") | as part 10 fixes them; this part adds nothing there |
| `project-space-compatibility.mdx`, "Plan features" | "…The Publish dialog lists each one your app needs, with the forms that need it, and asks you to confirm the project space has it." | gains: "For an app you brought in from that project space, Nova doesn't ask about a feature the app was already using there, because publishing changes nothing about it. Those show on the project space's card with who brought the app in, and you can withdraw one like any other." |
| `case-workspace.mdx`, "Cases assigned to the person using the app" | "If an imported app has a different assignment rule, Nova keeps it unchanged…" and "…because the imported rule cannot be recovered from the builder afterward." | "If an app you brought in from CommCare HQ has a different assignment rule, Nova keeps it unchanged…" and "…because the rule it came with cannot be recovered from the builder afterward." ("Import" is the CommCare HQ app file and CSV replacement; `../6-bring-in.md`, "What changed from the outline, and why", item 13.) |
| `projects.mdx`, "When a move waits" | "Apps that use Project data tables can't move yet, those shared tables would be left behind. Nova blocks those moves rather than splitting an app from its data." | gains: "That includes an app brought in from CommCare HQ that reads lookup tables, so it's worth choosing its Project when you bring it in." |
| `claude-code/commands.mdx`, the opening | "The plugin adds seven `/nova:*` commands." | "The plugin adds eight `/nova:*` commands." The next paragraph, "The intended flow is: build an app…", gains: "If your app already lives in CommCare HQ, `/nova:bring_in` brings it in to Nova first." |
| `claude-code/commands.mdx`, a new section before "Uploading to CommCare HQ" | none | "## Bringing in an app from CommCare HQ", holding "### `/nova:bring_in [project space] [app name]`" and: "Brings an app you already have in CommCare HQ in to Nova, so you can keep working on it here and publish back to the same HQ app. Nova reads the app first with your API key (saved in [Nova settings](https://commcare.app/settings)) and creates nothing until you've seen what comes in. Name a project space and an app to go straight to them; leave them off and Claude asks." Then: "Claude asks you for each thing that is yours to decide: the Nova Project where you can edit more than one, the app's name, where the app runs, and what to do about a lookup table your Project already has. If Nova can't hold every part of the app yet, Claude shows you the whole list of what and where, and nothing is created." A `text` block: `/nova:bring_in` and `/nova:bring_in my-project-space "vaccine tracking"`. And a link to [Bringing in an app from CommCare HQ](../bringing-in-from-commcare-hq.mdx) |
| `claude-code/commands.mdx`, `/nova:upload_to_hq`, its last paragraph | "The first upload to a project space creates the app there; uploading again updates that same HQ app in place." | "The first upload to a project space creates the app there, or updates the app it was brought in from; uploading again updates that same HQ app in place. Before the first upload of an app you brought in, Claude shows you what that upload changes in CommCare HQ." |
| `claude-code/commands.mdx`, `/nova:upload_to_hq`, "Changes made in CommCare HQ" | "…changed in CommCare HQ since Nova last published it…" | "…changed in CommCare HQ since Nova last published it, or since you brought the app in…", as part 10 words the origin in the product. The bullet gains at its end: "An admin or owner of the Project can also stop publishing there, which leaves CommCare HQ's version as it is." |
| `claude-code/quickstart.mdx`, the paragraph on uploading | "`/nova:upload_to_hq` pushes a Nova app to CommCare HQ as a new HQ app." | "`/nova:upload_to_hq` pushes a Nova app to CommCare HQ as a new HQ app, or back to the HQ app it was brought in from." |

### 17.3 `content/docs/mcp/tools.mdx`

A new section, "Bringing in an app from CommCare HQ", after "Creating and deleting apps":

> `list_hq_apps`, `read_hq_app` and `bring_in_hq_app` bring an app that already exists in CommCare HQ
> in to Commcare Nova. Reading creates nothing and changes nothing in CommCare HQ. `read_hq_app` does
> one bounded step a call: while `again` is true, call it again with the `reading_id`. It ends
> `ready`, with a review; `account`, with what Nova can't hold yet and where; or `stopped`,
> with what ended the read. `bring_in_hq_app` takes the user's answers to the review and has no
> defaults.

| Tool | What it does |
|---|---|
| `list_hq_apps` | List the apps of one CommCare HQ project space by name and `hq_app_id`. `in_nova` says a Nova app already manages one, with the app to open or who to ask. Requires `nova.hq.read`. |
| `read_hq_app` | Start or continue reading one HQ app into a Nova Project the user chose. Returns `state`, and with it a `review`, an `account` of findings (each with its place, sentence, standing and next step) or a `stop`. `action: "check_again"` reads afresh; `action: "remove"` forgets the reading. Requires `nova.hq.read`. |
| `bring_in_hq_app` | Create the Nova app from a ready reading, given `review_digest`, `app_name`, `runs_only_on`, `split_datetime` and `table_choices`. `status` is `created`, `again`, `review_changed` or `held`. Nothing is sent to CommCare HQ. Requires `nova.hq.write`. |

A callout after the table: "An agent never chooses the Project, the name, where the app runs, the
date-and-time split or a lookup table's answer for the user. `bring_in_hq_app` has no defaults for
that reason."

In "Publishing", the table gains `stop_publishing` ("Stop publishing an app to one project space.
The app in CommCare HQ stays; a later upload makes a new app beside it. Admins and owners of the
app's Project only. Requires `nova.hq.write`."), `get_deployment`'s row gains "`ended`" in its state
list and "`brought_in` and `ending` say where the app came from and whether Nova stopped publishing
there", and `upload_app_to_hq`'s row gains after its first sentence: "For an app brought in from that
project space, the first upload updates the app it came from." The row of
`check_project_space_compatibility` (under "Browsing apps") gains: "`first_publish` is what a first
upload changes for an app brought in from that project space: `workers.lines` for what workers
will notice, `hq_only.lines` for what changes only in CommCare HQ, then `reassurance` where it is
not null and `note`. It is null for any other app." Part 11's rows for
`refresh_managed_data` and `set_lookup_table_management` land with these.

### 17.4 `design/readme.md` (B11)

The voice gains no rule. The look gains one pattern and the system one primitive, each recorded
where the code will read it:

- After "Publishing", a section **Bringing in**: "Bringing an app in from CommCare HQ is a state of
  the new-app page, not a dialog. One card takes the composer's place, with a heading that takes
  focus as each step appears, a scrolling middle and a footer that stays. The address holds the
  app being read, so a reload returns to it and a row on the apps page leads back. A read that
  cannot bring the app in is a full account and never an error: amber, never rose, grouped by
  where each thing lives in the app, with three plain labels explained once. A review asks nothing
  by tick: where the app runs is chosen for the person and theirs to change, and only a real choice
  between two outcomes is left open. Nothing is created until the review's one button."
- In "Primitive contracts", a row for `RadioGroup.prompt.md` and `components/shadcn/radio-group.tsx`,
  and the contract file `design/components/core/RadioGroup.prompt.md` with section 12.2's five rules.

---

## Copy

Every string B11 and B12 add that a person, an agent or a developer reads. All of it follows
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
`lib/publish/firstPublishCopy.ts` (its Copy, C1 and C2): this part adds no string to that file and
no string of that kind to its own. Sentences with a value are functions
(`pickerProjectLine(project)`), named for their id's meaning. Strings owned by
another part are named here by their export and not repeated.

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
| K14 | a row already in Nova | part 10's three exports of `lib/publish/hqAppClaims.ts` (`HQ_APP_CLAIM_OPEN_LABEL` "Already in Nova", `HQ_APP_CLAIM_OPEN_ACTION` "Open", `HQ_APP_CLAIM_ELSEWHERE_LABEL` "Already in Nova, in a Project you're not part of"), and under an `elsewhere` row part 01's `alreadyInNovaNext(claim)` |
| K15 | the person's own open reading, badge | You've started bringing this in |
| K16 | footer | Cancel · Read this app · Carry on · Starting (in flight) |
| K17 | beside the footer | Reading creates nothing. You'll see what Nova found first. |
| K18 | the primary's description while no app is chosen | You can read an app once you've chosen one |
| K19 | no connection: title, body | Connect CommCare HQ to bring in an app / You can add your CommCare HQ API key in Settings. Nova uses it to read your app. |
| K20 | the list request failed | Nova couldn't list the apps in {domain} just now. You can try again. |
| K21 | starting failed | Nova couldn't start reading this app just now. You can try again. |
| K22 | Check connection could not be read (the picker and the Publish dialog) | Nova couldn't check your connection just now. You can try again. |

K18 is the accessible description of a button that does nothing yet. It says what the button will
do and when, as an invitation, and never as a step to take or a fault.

**Reading and opening (W).**

| Id | Where | Text |
|---|---|---|
| W1 | status | Reading {app} from CommCare HQ (before the row holds a name: Reading your app from CommCare HQ) |
| W2 | no step reported yet | Getting ready |
| W3 | after twenty seconds | Still reading. Apps with lots of pictures and sounds take a few minutes. |
| W4 | always | You can leave this page. Nova finishes the step it's on and carries on when you come back to it. |
| W4b | always, the reading is in the tab's Project | Your place is kept under Coming in from CommCare HQ on your apps page. |
| | the reading is in another Project the seed names | Your place is kept under Coming in from CommCare HQ on {Project}'s apps page. |
| | the reading is in a Project the seed does not name (the person no longer edits it) | Your place is kept under Coming in from CommCare HQ, on the apps page of the Project you added it to. |
| W5 | first lost request | Trying again |
| W6 | second lost request | Nova lost its connection partway. Nothing was created, and Nova kept its place. |
| W7 | opening a reading by its address | Opening where you left off |
| W8 | that load failed | Nova couldn't open this just now. You can try again. |
| | the steps | part 12's `READING_PHASE_LABELS` |

**Shared actions.** Go to your apps · Choose an app · Choose another app · Choose another Project ·
Check again · Carry on · Try again · Open Settings · Open {appName} · Open your app · Remove from
your list · Done.

**A stop (S).**

| Id | Where | Text |
|---|---|---|
| S1 | under every stop | Nothing was created, and nothing changed in CommCare HQ |
| S2 | Check again failed to start | Nova couldn't start checking this again. You can try again. |
| | title, body | part 01's `CIRCUMSTANCE_COPY` |
| | next step | part 01's `circumstanceNext(finding)` (its 8.4), for a stop, an account's circumstance and MCP alike |

**The account (A).**

| Id | Where | Text |
|---|---|---|
| A1 | heading | Nova can't bring in {app} yet |
| A2 | heading, where every finding is `read-back-differs`, `unrecognized` or `could-not-create` (7.1) | Nova couldn't bring in {app} this time |
| A3 | lead | Nothing was created, and nothing changed in CommCare HQ. Nova only brings in an app when it can hold every part of it exactly, so nothing is lost when you publish back. |
| A4 | lead under A2 | Nothing was created, and nothing changed in CommCare HQ. |
| A5 | the count line's parts, each singular at one | {n} thing Nova can't hold yet / {n} things Nova can't hold yet · {n} thing Nova doesn't bring in / {n} things Nova doesn't bring in · {n} thing to change in CommCare HQ / {n} things to change in CommCare HQ |
| A6 | a group's link | Open in CommCare HQ |
| A7 | footer | Copy the list · Copied · Check again · Done |
| A8 | under the footer, the reading is in the tab's Project | Nova keeps this list under Coming in from CommCare HQ on your apps page |
| | the reading is in another Project the seed names | Nova keeps this list under Coming in from CommCare HQ on {Project}'s apps page |
| | the reading is in a Project the seed does not name | Nova keeps this list under Coming in from CommCare HQ, on the apps page of the Project you added it to |
| A9 | the media group's heading | Pictures and sounds |
| A10 | the clipboard was refused | Your browser didn't let Nova copy this, so here it is to select and copy. |
| A11 | a folded run of one sentence | on {n} questions · Show the questions · Hide the questions |
| A12 | the copied text's first line | {heading} ({domain}, checked {date}) |
| | under the groups of every account, and the last line of the copied text | part 01's `ACCOUNT_CHECK_AGAIN_LINE` (its 9.1, landed in B2): "When these are changed, Nova will check the app again and may find more to name." This part draws it and writes no line of its own |
| | labels, next steps, sentences | part 01's `FINDING_LABELS`, `FINDING_NEXT_STEPS`, `findingLine`, `placeLine`, `circumstanceNext`; part 12's `moreFindingsLine`, `READING_LEARNED_LINES`; part 11's R12 |

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
| V21b | | If someone changes it in CommCare HQ, your next publish stops before sending anything and lists what changed. |
| V21c | | If your team keeps a copy of this app in another project space, Nova can't update that copy yet. Publishing there makes a new app. |
| V22 | section, its lead, its two labels, its sentences and its note | part 09's `FIRST_PUBLISH_HEADING` ("What the first publish changes"), `FIRST_PUBLISH_LEAD_REVIEW`, `FIRST_PUBLISH_WORKERS_LABEL`, `FIRST_PUBLISH_HQ_LABEL`, `FIRST_PUBLISH_NO_WORKER_CHANGE`, `FIRST_PUBLISH_FORM_BUILDER_NOTE` and `FIRST_PUBLISH_SENTENCES`, all through `firstPublishLines(view, "review")`. This part writes none of them |
| V23 | footer | Choose another app · Bring it in (no in-progress label: the press shows the creating screen, 8.9) |
| | tables, places, files | part 11's R1 to R11 and R3 to R5; the answer under R11 is the action Choose another Project |
| | kept list | part 01's 9.4 strings |
| | recorded features | part 10's `adoptionRecordedFeaturesLine` |
| | leads, refusals | part 12's `CREATE_RESULT_LEADS`, `READING_REFUSAL_COPY` |

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

V10 and A8 are single lines and end without a period. V12a and V12b are two sentences and keep
theirs.

**Creating and landing (X, T).**

| Id | Where | Text |
|---|---|---|
| X1 | status | Creating your app |
| X2 | under it | Nova reads the app once more, so it creates exactly what you reviewed. |
| | the landing could not be verified (the `unopened` screen's line) | part 12's `UNVERIFIED_LANDING_TITLE` (`lib/publish/hqReadingCopy.ts`, its C6): "Your app is in, and this tab couldn't open it". This part writes no sentence for it, and the id X3 is not used |
| X4 | a creation request lost twice | Nova lost its connection while creating your app. Trying again is safe: if the app was created, Nova opens it. |
| T1 | toast, title | Your app is here |
| T2 | toast, body | Nova brought in {name} from {domain}. Publishing shows where it came from and what stays in CommCare HQ. |
| T3 | toast, action | See what came in |

**The home list (H).**

| Id | Where | Text |
|---|---|---|
| H1 | heading | Coming in from CommCare HQ |
| H2 | under it | Apps Nova is reading, ready for you to review, or can't bring in yet. Only you see these. |
| H3 | a row with no name yet | An app from {domain} |
| H4 | under the title | From {domain} |
| H5 | no step in flight | Paused. Continue picks up where Nova stopped. |
| H6 | ready | Ready for you to review |
| H7 | Remove, title | Remove this from your list? |
| H8 | Remove, body | Nova forgets what it read of {app}. Nothing was created, nothing changes in CommCare HQ, and you can bring it in again any time. |
| H9 | Check again failed | S2's sentence |
| H10 | Remove failed | Nova couldn't remove this just now. You can try again. |
| H11 | an account's date | Checked {relative time} |
| | actions | Continue · Review · See the list · See why · Check again · Checking (in flight) · Remove · Removing (in flight) · Keep it |

**After (D).**

| Id | Where | Text |
|---|---|---|
| D1 | the card, under the project space | Brought in from “{domain}” on {date} by {name} |
| D2 | the rung On CommCare HQ, before Nova's first publish ({date} is the day it was brought in) | Nova read this app from CommCare HQ on {date} and hasn't published to it yet |
| D3 | the dialog's section: its heading, lead, labels, sentences and note | part 09's `FIRST_PUBLISH_HEADING`, `FIRST_PUBLISH_LEAD_PUBLISH`, the two labels, `FIRST_PUBLISH_NO_WORKER_CHANGE`, `FIRST_PUBLISH_FORM_BUILDER_NOTE` and `FIRST_PUBLISH_SENTENCES`, through `FirstPublishLines` (11.2). This part writes none of them. The ids D4 to D6 are not used, and D7 keeps its number because part 01 cites it (its 2.3) |
| D7 | plan line, a new app for a brought-in app | This creates a new app in this project space. Nova can't update a copy of this app that's already there yet. |
| D8 | the drift stop, heading | Or leave CommCare HQ's version as it is |
| D8b | the drift stop, for an editor | An admin or owner of this Project can also stop publishing here, which leaves CommCare HQ's version as it is. |
| D9 | the dialog, after stopping | Nova stopped publishing this app to “{domain}”. The app in CommCare HQ stays as it is. |
| D10 | a stop that failed | Nova couldn't stop publishing just now. Nothing was changed, and you can try again. |
| D11 | the restore toast's title | Your app is back, and where it publishes changed |
| D12 | the dialog's compact row | Publishing stopped |
| | the rest | part 10's `lib/publish/stopPublishing.ts` and its drift sentences |

**MCP and the guide (M, G).** The descriptions are in section 14, in full.

| Id | Where | Text |
|---|---|---|
| M1 | `bring_in_hq_app`, `created` | {name} is in Nova. Nothing changed in CommCare HQ. Publishing from Nova updates the app it came from in {domain}. |
| M2 | `bring_in_hq_app`, `again` | Nova is still bringing in this app's files. Call bring_in_hq_app again with the same arguments. |
| M3 | `read_hq_app`, the two forms mixed | Send project_id, domain and hq_app_id to start reading an app, or reading_id alone to continue one. This call mixed the two. |
| M4 | `refresh_managed_data`, both or neither | Send table_id to refresh one lookup table, or app_id to refresh that app's places. This call sent both or neither. |
| M5 | `list_hq_apps`, no connection | CommCare HQ is not configured. Add your HQ credentials in Settings before listing a project space's apps. |
| M6 | a starting `read_hq_app`, no connection | CommCare HQ is not configured. Add your HQ credentials in Settings before reading an app. |
| G1 | the guide, `workflows` | the paragraph of 15.1 |

M5 and M6 keep the words of `check_project_space_compatibility`'s own `hq_not_configured` sentence
(`lib/mcp/tools/checkProjectSpaceCompatibility.ts`: "CommCare HQ is not configured. Add your HQ
credentials in Settings before checking a project space."), with the act changed, so the three
tools say one thing. M1 to M6 are exports of `lib/publish/bringInCopy.ts` that B12 adds to the file
B11 creates, and G1 is B12's in `lib/agent/authoring/reference.ts` ("Files by pull request"). B11
lands every other id of "Copy".

**For a developer.**

| Where | Message |
|---|---|
| `BringInAccount`, an account with no findings | `[bring-in] account with no findings` at error, with `appId` the reading's id: "The reading ${id} is in state account and holds no finding. An account is written only where a read met one. Look at lib/deployment/reading/gather.ts." |
| `chosenDeclaration`, answers that match no entry of `review.runsOn` (unreachable from the screen, which sets both answers from one entry) | "The review of reading ${id} offers no way to run that matches the answers held (runsOnlyOn ${runsOnlyOn}, splitDatetime ${splitDatetime}). Answers are taken from one entry of review.runsOn at a time. Look at components/bring-in/bringInModel.ts::reduceBringIn, the answers event." |
| `BuilderLayout`, a `nova:brought-in` value that is not the three strings it writes | `log.warn("[bring-in] landing marker unreadable")`, the key removed, no toast. A warning and not an error: the value is the browser's to lose, and the Publishing card still says where the app came from |
| `toMcpErrorResult`, a `BringInToolError` | `log.warn("[mcp] bring-in refused", { userId, errorType, circumstance, refusal })`, as 14.8 says. The message a client reads is the sentence the error carries |

B11 adds no migration, so there is no `down` to word.

---

## Tests

Nothing here is run by this plan. Each test names its boundary and the failure it would catch. No
test renders a component in jsdom: "UI is f(state)", so the model is tested as data in Vitest and the
screens in Playwright. Playwright and real-Postgres suites run in the pull request's CI on hosted
runners, never on the person's laptop.

### Plain Vitest: the model (B11)

| File | Holds | Would catch |
|---|---|---|
| `components/bring-in/__tests__/bringInModel.test.ts` | every row of 3.3's reducer table; `screenOf` over every `ReadingState` through a `satisfies Record<ReadingState, …>` table; `nextAct` for each state with and without `driving`, a call in flight, one failure and two; the driving rule: a `row` from `load` with `stepRunning` false leaves `driving` false with `quietRows` 1, and the next `row` from `poll` with it false sets `driving`, so `nextAct` becomes `advance`; a run of `row` from `poll` events over 5 seconds, each with `stepRunning` true and `phase` null (a step that has named no phase yet), leaves `driving` false and `nextAct` a `poll`; one `row` with `stepRunning` false between two with it true (the moment between two steps of another driver) leaves `driving` false; after rows with `stepRunning` true, two in a row with it false (a killed step, its mark thirty seconds old) set `driving`; a `row` from `poll` that arrives while this tab is driving changes `driving` and `quietRows` not at all | a state part 12 adds with no screen; a second driver for a step that is slow to say what it is doing; a second tab that never takes a stalled reading on; a retry storm after a lost request |
| the same, a creation as a sequence of events | `create-asked`: `screenOf` is `creating` and `nextAct` is `create` with that input. Then `call` for `create` and `created` with `again`: `screenOf` is `creating` with `call` null and the row still `ready`, and `nextAct` is `create` with the input first sent and `afterMs` 0. Then `failed`: still `creating`, `nextAct` is `create` after 3000. A second `failed`: `creating` with `lost`, `nextAct` is `none`. `retry`: `create` at once, same input. At no step of the sequence is the screen `review` | the review's choices back on screen under a creation in flight; an `again` that is never re-posted because no field remembered it; a lost creation with no way on |
| the same, the three ends of a landing | `landed` with `unverified`: `screenOf` is `unopened` and `nextAct` is `none`, so no second create can be sent; with `leaving`: `creating` and `none`; with `landed`: `creating` and `none` | Bring it in offered again for an app that exists |
| the same, the picker | `connection` with one project space chooses it and sets `apps` to `loading`; `nextAct` is then `list-apps` with that project space and the chosen Project; `picker-project` and `picker-reload` return a loaded list to `loading`; a `picker-apps` for another project space or Project is dropped; `connection` that no longer holds the chosen project space clears it; `initialBringInModel` with no Project gives a picker whose `nextAct` is always `none` | a picker with one project space that never lists; a Project change that keeps the other Project's marks; a list for a project space no longer chosen painted over the new one |
| the same, the person's own calls | `failed` for `start`, `check-again` and `remove` sets `failedCall` and leaves the screen; `removed` makes `nextAct` a `replace` to `/`; `row` from `check-again` zeroes `failures` and sets `driving`; a load that failed is `opening` with `lost` and `nextAct` `none` until `retry` | a load retried forever; a failed Remove worded as a failed check |
| the same | a poll's row with a lower `revision` than the one held is dropped; `answers` for another digest are dropped | a stale answer painting over a newer screen |
| the same | `created` with `held` keeps the answers and, for `table-differs-in-project`, sets `needsChoice`; `review-changed` clears them | the person's answers resent against a review that changed |
| `components/bring-in/__tests__/bringInAccount.test.ts` | `accountGroups` makes one group a key, in first-appearance order, over a list where a form's questions come after another form's findings; folds a run of more than twenty; `accountHeading` is A2 for the three faults and A1 for `too-large`, for `places-over-nova-limit` and for any mix; `accountCounts` and `countLine` singular and plural for each of the three parts and with zero parts left out; `placeGroupKey` gives a form and its questions one key and two menus two; `accountAsText` holds every finding, folded or not, gives a circumstance its `circumstanceNext`, and ends with `ACCOUNT_CHECK_AGAIN_LINE` | a form's heading drawn twice; a finding lost between the row and the screen or the clipboard; "1 things"; "this time" over a limit a retry cannot pass; a copied list that reads as complete |
| the same | `STOP_ACTIONS satisfies Record<StopCircumstance, …>` (part 01's type), every `StopAction["kind"]` has a label through a `satisfies Record`, and the row of `already-in-nova` answers `open-app` for an `open` claim and none for any other | a circumstance part 01 adds with no way on; Open offered for an app the person cannot open |
| `lib/deployment/__tests__/hqPlaceUrl.test.ts` | every `HqPlace["kind"]` through a `satisfies Record`, at index 0 and on each of the three servers | a link to another server's host; `modules-undefined` |
| `components/bring-in/__tests__/bringInReview.test.ts` | `initialAnswers` takes the preselected choice and HQ's name and answers no table; `unansweredChoices` in tag order; `declarationWhy` for each `runsOnWhy`, both V12 lines and each V13 form, with a feature's label never inside a sentence; `bringInInputOf` trims the name | a default that answers a table for the person; a reason that contradicts the choice |
| the same, the first-publish list | over a review whose preselected row runs on both platforms and whose other row is Android only with a split, with CommCare HQ's Web Apps on: `firstPublishLines(chosenDeclaration(review, answers).firstPublish, "review")` for the first holds no `web-apps-turned-off` in `workers.lines`; after an `answers` event for the second, `workers.lines` holds `web-apps-turned-off` and `date-and-time-questions-split` and `reassurance` is null; a view with `touchesWorkers` false gives `reassurance` and an empty `workers.lines`; the two surfaces differ only in `lead`. The test holds `chosenDeclaration`, this part's one function in the path; the renderer's own rule is held by part 09's `firstPublishCopy.test.ts` | the preselected row's list shown for the row the person chose; the reassurance over a list that changes what workers see |
| `lib/routing/__tests__/bringInLocation.test.ts` | `bringInLocation` and `bringInHref` are inverses; any value that is not `choose` or a canonical UUID is `none` | an address that makes the page request a row for arbitrary text |
| `lib/publish/__tests__/bringInCopy.test.ts` | no export of `bringInCopy.ts` holds an em dash; none holds an ellipsis; no label of a button ends in a period; every string of two or more sentences ends in one. These four are `design/readme.md`'s rules for copy, held over the whole file, and no string's own words are pinned. Part 09's `firstPublishCopy.test.ts` (B7) holds its file | a rule of the voice broken by a later string |
| `app/(app)/(site)/__tests__/readingRowModel.test.ts` | `readingRow` for every member of `OPEN_READING_STATES` through a `satisfies Record`; the learned line only for an account; the stop's title for a stop | a row with no action; a learned line on a review |
| `components/builder/app-setup/__tests__/publishingSectionModel.test.ts` (extended) | `broughtInOf`; `cardKind` is `ended` for a deployment whose state moved to `preflight` after an ending and before a new app; `broughtInElsewhere`; the compact row of an ended deployment | an ended card that returns to a ladder on a refused publish (part 10's 8.1 case) |
| `components/builder/__tests__/publishOutcome.test.ts` (extended) | `publishPlanCopy`, now an export of `publishOutcome.ts` (11.2): `creates-beside` whatever the context; `creates` with `broughtInElsewhere` true is D7 and false is today's sentence; `updates`, `fills-shell` and `unknown` unchanged by the context | a second project space told "updates"; the move from the dialog changing one of the three strings |
### Real Postgres (B11)

| File | Holds | Would catch |
|---|---|---|
| `lib/deployment/reading/__tests__/picker.postgres.test.ts` | `listHqAppsForPicker` over part 05's retained answers served through `MockAgent`: free apps in HQ's order; an `open` claim; an `elsewhere` claim whose JSON holds neither the holding Project's name nor the Nova app's; the caller's own open reading marked only in its Project; no connection; a project space the key does not reach; a plan with no API access; and that no table's row count changes | a claim view that leaks another Project; the probe run beside the list; a read that writes |
| `app/api/commcare/connection/__tests__/route.postgres.test.ts` | with a real `user_settings` row: the body is `getCommCareSettings`' answer for the session's user, and `connection` holds exactly the keys of `CommCareSettingsPublic` (`configured`, `username`, `server`, `availableDomains`), so nothing of the stored key; a second user's row is never the answer; a user with no row answers `{ connection: { configured: false } }`; 401 without a session | another user's connection returned; a credential on the wire |

Where the first-publish list is stored, when it ends and what `DeploymentView.firstPublish` answers
are part 09's and are held by its `firstPublishBaseline.postgres.test.ts` (B7) and by the CHECK's
case in part 10's `hqBringInLedger.postgres.test.ts` (B8). B11 adds no test of storage, because it
adds no storage.

### Routes with no database (B11)

| File | Holds | Would catch |
|---|---|---|
| `app/api/commcare/hq-apps/__tests__/route.test.ts` (a mocked service) | 401 without a session; 400 for a bad `domain`; a stop is 200; `isPathAllowedOnHost` admits `/api/commcare/hq-apps` and `/api/commcare/connection` on the main host and refuses both on the MCP and docs hosts | the deploy-time 404 the root `CLAUDE.md` warns of |

### Playwright, browser peers (B11)

`e2e/tests/browser/bring-in.spec.ts`, with the peer `e2e/lib/bring-in-client.tsx`, which mounts
`BringInFlow` inside the production `CommCareConnectionProvider` (given the `settings` the test
sets) with a `landCreatedAppReceipt` that records its calls and a seed of two Projects, one of them
`personal`. Every Nova route is answered from `page.route` with typed bodies built from the
production types (`ReadingView`, `HqAppPicker`, `CreateResult`, `CommCareSettingsPublic`), as
`publishing.spec.ts` builds `PublishResponseBody`. A route a journey takes away again mid-test (a
`…/create` whose answer changes between two posts here, and the one held open and then answered in
the app journeys below) is added through `e2e/lib/routes.ts::removableRoutes` and removed with its
`removeAll`, as `e2e/CLAUDE.md` requires of every route a test removes ("A route a test removes
goes through `e2e/lib/routes.ts`"). The file is used and not changed.

| Journey | Asserts |
|---|---|
| choosing | no connection shows the aside; Check connection requests `/api/commcare/connection`, brings the fields back with focus on Project space, and leaves the address at `?hq=choose`; a connection the route could not answer shows K22 and the button again; one project space lists its apps with no choice asked; a chosen project space lists apps; an `open` row has Open and cannot be chosen; an `elsewhere` row reads its line and cannot be chosen; arrow keys move through the rows; the filter narrows; the personal Project reads "Only you can open it"; Read this app posts exactly `{ projectId, server, domain, remoteAppId }` and the address becomes `?hq=<id>`; a seed with no Project shows the `no_project_access` sentence and no fields |
| reading | the step's label follows the polled row; the reassurance appears after twenty seconds (`page.clock`); two failed advances show Carry on, which posts again; a reading whose Project is not the tab's names that Project in W4b |
| a stop | for one code of each row of `STOP_ACTIONS`, the title has focus and exactly those actions are offered; Check again posts |
| the account | each heading once, in the app's order; each label as text; a form group's link ends `modules-0/forms-1/`; a folded run opens; `ACCOUNT_CHECK_AGAIN_LINE` shows under the groups; a `no-platform-runs-everything` finding whose `detail.reason` is `split-refused` reads the second next step; Copy the list puts the whole text on the clipboard, the line included, and with the permission denied the text is selectable on screen |
| the review | no checkbox exists on the screen; the preselected choice is checked; choosing another choice changes the Web Apps line, the recorded-features line and the list under "What the first publish changes", which gains "Web Apps is turned off for this app" and loses `FIRST_PUBLISH_NO_WORKER_CHANGE` ("Workers see the same questions, and their answers save to the same places."), and keeps `FIRST_PUBLISH_FORM_BUILDER_NOTE` as its last line; a platform the app can't run on shows its features as list items; Bring it in with a table unanswered sends no request, focuses that group and shows V16; a table with neither answer offered shows V17 and not R11; with every choice answered, posts exactly the `BringInInput`; a `held` answer shows the block and focuses the group; a `review-changed` answer shows its lead and Nova's choices again; an empty name focuses the field with its error |
| creating | from the press on, no radio of the review is on screen; `again` re-posts the same body, and between the two posts the screen is still "Creating your app"; `created` calls the landing once with the receipt; a lost request retries once after three seconds (`page.clock`) with the same body and then offers Try again, which posts it again; a landing that answers `unverified` shows part 12's `UNVERIFIED_LANDING_TITLE` with Open your app, and no Bring it in; while the polled phase is `publishing-media` and no answer has come, the step reads "Adding pictures and sounds to your Project" with no count, and on `creating` no step line shows under X1 |
| narrow | at 360px wide the footer's buttons stack at 44px, the middle scrolls, and the document does not scroll sideways |

`e2e/tests/browser/publishing.spec.ts` (extended): a brought-in record shows D1 and D2; Stop
publishing here is present for a role with `delete` and absent for an editor; its dialog calls the
action once and the card becomes the ended card with its link; the review step shows "What the
first publish changes" with its lines, workers' first, for a record with `firstPublish` and no such
section without; an `hq_changed` refusal that names the app shows D8 for an admin and D8b for an
editor; the plan line reads D7 for a second project space of a brought-in app; and the dialog's
Check connection requests `/api/commcare/connection`, shows the upload form when it answers a
connection, and makes no document or RSC request.

### Playwright, app journeys (B11)

`e2e/tests/app/bring-in.spec.ts`, profile `@seed:bring-in`: the name joins
`e2e/lib/smokeProfiles.ts::SMOKE_PROFILES`, and its builder, written in `e2e/lib/bringInSeed.ts`, is
registered under that name in `e2e/lib/smokeSeedFactory.ts`, as `"deep-links"` is. It seeds an owner
with Projects A (active) and B and a CommCare connection; in A, one reading in `ready`, one in
`account` and one in `reading` with no phase and no step's mark, written through part 12's own store
functions over fixture outcomes; one brought-in app in A and one in B, each made by part 12's birth
over its fixture (no CommCare HQ is read: the birth takes prepared inputs), with each app's receipt
(`adoptedAppReceipt`) in the typed scenario data; a third Project C of the owner's that holds
nothing; an editor of A; and a third person who views A and edits B. `…/advance`, `…/create` and
`/api/commcare/hq-apps` are answered from `page.route`, since each would read CommCare HQ. Every
other request reaches the production server: starting a reading, loading one, checking again and
removing make no request to CommCare HQ (part 12, 3.5 and 4.1), and `/api/commcare/connection` reads
Nova's own row.

| Journey | Asserts |
|---|---|
| the home list | "Coming in from CommCare HQ" holds the three rows with their actions, the `reading` row as "Paused"; a Project whose only content is a reading does not show "No apps yet" |
| Back to the home list | from the home list, open the `account` row, choose Check again (the real route moves the row to `reading`), then press Back: the home list, served from the router's cache, refreshes itself and the row reads as a reading in progress, not as the account it was; with Project C active, from its empty home, start a reading and press Back: the home shows "Coming in from CommCare HQ" and not the empty state. This is what would catch a home that still shows what a reading was before the flow changed it |
| the three entries | each reaches `/build/new?hq=choose`; from the button under the chat box, Back returns to the composer with no page load |
| the address survives a connection check | from the composer, choose the second button (the address becomes `?hq=choose` through the History API), then Check connection: the address is still `/build/new?hq=choose` and the picker is still on screen. This is what would catch a refresh that hands the address back to Next and drops the person on the composer |
| a viewer who edits elsewhere | as the third person, with A active, `/build/new?hq=choose` shows the picker with B under "Add it to", and the home shows no entry button |
| a reload | `/build/new?hq=<ready id>` shows the review from the real row; a reload shows it again; `/build/new?hq=nonsense` shows the composer |
| retry after a reload | `/build/new?hq=<the reading row's id>`, opened by address: after its load and one poll that both find no step running (`stepRunning` false), the page posts `…/advance` once. With the row answered as `stepRunning` true by `page.route`, the page posts nothing and shows the step; once the route has answered false twice it posts once. And during a creation whose `…/create` is held open, a reload shows the review again from the real row (still `ready`), with nothing created; with `…/create` then answered by the seeded receipt, Bring it in lands. This is what would catch a reading nobody drives, and a reload mid-creation that strands the person on a spinner |
| landing in the tab's Project | Bring it in, with `…/create` answered by A's seeded receipt: the address becomes `/build/<id>` with no document load (a marker set on `window` before the click is still there), the builder is open on the app's own menus, the toast reads T1, and See what came in opens Publishing with D1 |
| landing in a second Project | the same with B's receipt: the page loads `/build/<id>`, the builder is open, T1 shows once, no "Reload" toast appears, and `sessionStorage` no longer holds `nova:brought-in`. In the first landing journey the key is never written, and T1 shows once |
| Remove | a row's Remove, confirmed, takes the row off the list across a reload |
| stopping | as the owner, Stop publishing here on the brought-in app's card gives the ended card; as the editor the button is absent |

In the two landing journeys the receipt names the seeded app, whose id is not the reading on screen.
In production a reading's id is its app's id, which part 12's real-Postgres tests hold; what these
journeys prove is the landing itself, on the real builder.

### MCP (B12)

| File | Holds | Would catch |
|---|---|---|
| `lib/mcp/__tests__/servedSchemas.test.ts` (extended), "serves bring_in_hq_app with every answer required and no default" | `required` is all six properties; `additionalProperties` is false; `runs_only_on` admits `null`, `"web-apps"` and `"android"` and nothing else; `review_digest` admits 64 lower-case hex and refuses upper case; no schema position holds a `default` | an optional answer an agent can leave for Nova to choose |
| the same, "serves read_hq_app as one closed object of six optional fields" | the property set; `action`'s three members; `additionalProperties` false | a start field renamed without the description |
| the same, "serves the four other bring-in tools as closed objects" | the property sets of `list_hq_apps`, `stop_publishing`, `refresh_managed_data` and `set_lookup_table_management`, the last two as part 11's table has them, and `additionalProperties` false on each of the four, which holds only because all four are `z.strictObject` (14.5) | an input drifting from the two parts' tables; a tool served open because it was written `z.object` |
| the same, "tells a client an agent never chooses for the user" | `bring_in_hq_app`'s description contains "never choose the name, where the app runs, the date-and-time split or a lookup table's answer for them"; `read_hq_app`'s contains "never choose it for them"; `set_lookup_table_management`'s contains "Never decide this for the user." These three phrases are the contract a client is served: they are how the plan's rule that `bring_in_hq_app` never chooses for the person (14.4; `../6-bring-in.md`, "Work items", B12) reaches an agent, which is the exception `docs/testing.md` makes for a pinned string | the rule softened in an edit |
| the same, "names first_publish, the ending and publishing_stopped where a client reads them" | each of the keys `first_publish`, `check_again`, `brought_in`, `ending` and the tag `publishing_stopped` is named in the description of a tool that returns it (14.3, 14.7), and the three tools that name `first_publish` (`read_hq_app`, `bring_in_hq_app`, `check_project_space_compatibility`) each say to relay `workers.lines` first, then `hq_only.lines`, then `reassurance` where it is not null, then `note` | a projection key no description explains; an agent told to read a key that is no longer served |
| `lib/mcp/__tests__/readingProjection.test.ts` | `describeReading` for each state; every sentence equals the copy export the screen uses; a stop's `next` and a circumstance finding's `next` equal `circumstanceNext(finding)`, for `already-in-nova` and for a `split-refused` `no-platform-runs-everything` among them; an account holds `check_again` equal to `ACCOUNT_CHECK_AGAIN_LINE` on every page; each `runs_on` entry's `first_publish` equals `firstPublishLines(choice.firstPublish, "review")` with its keys in snake case, so two entries that differ in declaration differ in list, the review holds no list of its own, and no `touches_workers` key is served; `cannot_run` holds a feature's label as an item and never inside `sentence`; with 2,000 findings whose names and places are at their longest, each page's JSON is under 80,000 characters and the pages together hold every finding once; `mapReadingRefusal` is total through its `satisfies Record<ReadingRefusal, …>` table | an answer the client truncates in silence; MCP and the screen saying different things; an agent relaying the proposed row's list for the row the user chose |
| `lib/mcp/__tests__/errors.test.ts` (extended) | `toMcpErrorResult(new BringInToolError("hq_read_stopped", body, { circumstance, title, next }))` carries the three fields beside `message`; one with `refusal` and `projectId` carries `refusal` and `project_id`; fields the error does not hold are absent keys, not nulls | a stop that reaches a client as a bare message, with no next step |
| `lib/mcp/__tests__/bringInToolScopes.test.ts` (no database) | through `withMcpClient` with a token that lacks the tool's scope: each of the six answers `scope_missing` with its `required_scope`, and the service functions, mocked at the module boundary, are never called | a scope hole; a missing-scope credential learning whether a reading exists |
| `lib/mcp/__tests__/bringInTools.postgres.test.ts` | through `withMcpClient`, over real Postgres and part 05's retained answers served by `MockAgent`: `read_hq_app` from start to `ready` across calls; the two forms mixed is `invalid_input` with M3; `remove`; `bring_in_hq_app` answers `created` twice with one app, and its `url` is `AS_ORIGIN` then `/build/` then the app's id; a table left out is `held` with the tag; a changed review is `review_changed`; each `ReadingRefusal` a call can produce arrives with the `error_type` and `refusal` of 14.8's table; a stop at `list_hq_apps` is `hq_read_stopped` with `circumstance`, `title` and `next`; both kinds of `not-a-member` there are `domain_not_authorized`, each with its own message | a retry that makes a second app; a refusal with no bucket |
| `lib/mcp/__tests__/compatibility.postgres.test.ts` (extended) | `first_publish` is null for a Nova-made app and for a brought-in app after its first publish; before it, it equals `firstPublishLines(view, "publish")` in snake case for the declaration the app was created with, for an app whose chosen declaration was not the preselected one; and after `runsOnlyOn` is changed in the document, its two Web Apps lines follow the document (part 09, 12.3) | the list arriving after the fact; the preselected row's list told for an app created with another; a stored Web Apps line told for an app that no longer runs that way |
| `lib/mcp/__tests__/deploymentTools.postgres.test.ts` (extended) | `brought_in` and `ending` on `get_deployment`; `stop_publishing` as an editor is `permission_denied` with part 10's sentence, and as an owner returns the ended deployment | a member told "not found" for something they can see |

No test of this part holds the tools' budget to the request's cap: part 12's `budget.test.ts` holds
`HQ_READING_STEP_SECONDS + HQ_READING_ROUTE_MARGIN_SECONDS` equal to `MCP_MAX_DURATION_SECONDS`
(14.1). No test holds the guide's paragraph (15.1).

---

## Contracts and docs these changes make false

| Where | Today | From step 6 | Pull request |
|---|---|---|---|
| `components/builder/CLAUDE.md`, "Creation never navigates" | part 12's sentence, as B10 leaves it beneath this pull request (its "Contracts"): "Every way a receipt reaches the client (the design build's `data-app-materialized` frame, the blank-app Server Action's return value, and the bring-in's create route) hands it the SAME receipt", with part 12's paragraph on the `adoption` key and the one landing that loads a page after it. B11 changes neither | adds only, after part 12's paragraph: "The flow that brings an app in is a state of `/build/new` (`components/bring-in`), inside `ChatContainer`'s tree, so its app lands through the same installer." | B11 |
| `components/CLAUDE.md`, "Build recovery is URL-backed" | names `/build/new?design=<id>` alone | gains: "A bring-in is URL-backed the same way: `/build/new?hq=choose` is the picker and `/build/new?hq=<reading id>` a reading, whose id is the app's. The flow reads the `hq` value through `useBuilderSearchFrom`, seeded by the server so the first paint agrees." | B11 |
| `components/CLAUDE.md`, "Primitives come from `components/shadcn`" | the list of primitives has no radio group | the list gains "radio-group (`RadioGroup`, rows wearing `selectableRowCls`; an item that cannot be chosen stays focusable and says why)" | B11 |
| `components/builder/CLAUDE.md`, "Publishing" | "`RemoteChangeChoice` stands beside `ResourceConflictChoice` … it lists every change made in CommCare HQ since Nova's last push and offers to discard them" | gains: "Where the app itself changed, an admin or owner is also offered Stop publishing here (`StopPublishingDialog`), and an editor is told who can. For an app brought in and not yet published, the review step states what the first publish changes (`FirstPublishLines`), from `DeploymentView.firstPublish`." | B11 |
| `components/builder/CLAUDE.md`, "App setup, Publishing" | "renders one full `DeploymentStatus` card per project space the app has reached" | gains: "A card says where a brought-in app came from, offers Stop publishing here to a member who may delete, and draws an ended deployment from `deploymentEnding`, never from the state: no ladder, no Check status, no Workers panel." | B11 |
| `components/builder/PublishDialogBody.tsx`, the comment over `RemoteChangeChoice` | "What changed in CommCare HQ since Nova last published there, and the only thing that lets the publish write over it." | "What changed in CommCare HQ since Nova last published there or brought the app in, and what lets the publish write over it. Stop publishing here stands beside it." | B11 |
| `components/chat/StartFromScratch.tsx`, its header comment | "the "skip the SA, build it yourself" affordance" | "the two ways to start without describing an app: a blank app, and an app brought in from CommCare HQ" | B11 |
| `app/(app)/(site)/page.tsx`, the comment on branch 2 | "Authenticated, no apps or active designs → role-aware empty state" | "Authenticated, no apps, no active designs and no app coming in from CommCare HQ → role-aware empty state" | B11 |
| `lib/routing/CLAUDE.md` | no word of `/build/new`'s query | gains: "`/build/new` carries two query states, each seeded by the server for the first paint: `design` and `hq` (`bringInLocation.ts`)." | B11 |
| `e2e/CLAUDE.md` | its list of profiles and peers | gains the `@seed:bring-in` profile and the `bring-in` peer, and the sentence "No test reaches a CommCare HQ: a bring-in journey answers the routes that would from `page.route`, and seeds its readings and brought-in apps through the production store and birth." | B11 |
| `lib/mcp/tools/deploymentTools.ts`, its header | "`nova.get_deployment` and `nova.refresh_deployment`: the read and re-check operations around `upload_app_to_hq`." | unchanged; the same reason is cited by the six new tools' headers | B12 |
| `lib/mcp/errors.ts`, the comment on `McpErrorType` | "Spans five independent failure sources", over a list that already names six (`not_found`, `invalid_input`, `scope_missing`, `permission_denied`, `UploadErrorType`, `AgentErrorType`) | "Spans seven independent failure sources", with a seventh bullet: "`BringInErrorType`: a read of CommCare HQ that stopped before there was a reading to hold it (`hq_read_stopped`, with the circumstance's code, title and next step), and a creation Nova refused for a reason that is neither input, access nor absence (`bring_in_refused`, with the refusal). Surfaces via `BringInToolError`." | B12 |
| `app/api/mcp/dispatch.ts`, the comment on `MCP_MAX_DURATION_SECONDS` | "Next requires that export to be a numeric literal, so the two are kept in sync by hand and the route's docblock points back here." | gains: "The tools that advance a reading of a CommCare HQ app give their step `lib/deployment/reading/budget.ts::HQ_READING_STEP_SECONDS`, 30 seconds less than this cap, because the cap is measured from the request's start and a step starts after the caller is checked." | B12 |
| `components/builder/CommCareConnectionContext.tsx`, its header | "The value is memoized against the settings object (RSC-stable across renders), so `PublishPanel`'s memo and the dialog's domain-reset effect see one identity per page load rather than a fresh array per render." | "The value is memoized against the settings object and the last answer of `refresh`, so `PublishPanel`'s memo and the dialog's domain-reset effect see one identity until a refresh answers. `refresh` reads `GET /api/commcare/connection` and never calls the Next router: on a page whose address the History API wrote, a router refresh would write Next's own address back." | B11 |
| `lib/ui/appListFreshness.ts`, its header and the comment on `markAppListStale` | "Both ways an app is born now install it in place rather than navigating…" and "Called the moment an app is installed in place." | the header gains: "The flow that brings an app in from CommCare HQ marks it too, whenever a reading it holds is started, checked again or changes state, since the list shows those rows." The comment becomes "Called the moment an app is installed in place, or a reading on the list changes." | B11 |
| `app/(app)/(site)/RefreshStaleAppList.tsx`, its header | "Refetches the app list once, when the user arrives on a list that was rendered before an app they have since created." | "…before an app they have since created, or before a change to an app they are bringing in. The empty state mounts it too, since a reading can be the first thing a Project holds." | B11 |
| `components/builder/CLAUDE.md`, "Creation never navigates" (second paragraph) | "…the router re-render carrying the revalidation restores Next's own canonical URL, undoing the promotion." | gains: "The same holds for `router.refresh()`, which is why Check connection reads `GET /api/commcare/connection` through `CommCareConnectionContext`'s `refresh` and not through the router." | B11 |
| `lib/deployment/CLAUDE.md`, "Surfaces" | names the deployment tools MCP serves | gains `list_hq_apps`, `read_hq_app`, `bring_in_hq_app` and `stop_publishing`, and "none is given to the Solutions Architect" | B12 |
| `lib/agent/authoring/CLAUDE.md` | no word of a brought-in app | gains: "The guide says one thing about an app brought in from CommCare HQ: it is an ordinary app. It gives no instruction to bring one in." | B12 |
| root `CLAUDE.md`, the map's builder UI entry | lists `components/builder` and its libraries | gains "`components/bring-in` (the flow that brings an app in from CommCare HQ, a state of `/build/new`)" | B14 |
| root `CLAUDE.md`, the first paragraph | "The user then refines it by chatting or by editing directly in a visual builder" | unchanged. The sentence before it, "Nova turns a natural-language conversation into a working CommCare app", gains after it: "An app that already lives in CommCare HQ can be brought in and carried on from there." | B14 |
| `design/readme.md` | no "Bringing in"; no radio group contract | section 17.4 | B11 |
| public docs | section 17 | section 17 | B14 |
| `../nova-plugin` | section 16 | section 16 | the plugin's pull request |

---

## Departures

Departures from the outline and the research, and the decisions this part took where an alternative
was weighed and not taken. Each states the evidence and the decision taken.

1. **`bring_in_hq_app` takes no `project_id`.** Its arguments are the reading, the review's digest, the
   name, `runs_only_on`, the split answer and the table choices (14.4). A reading belongs to a Project
   from its start (part 12, 2.5: "`startReading` takes it as an argument"), its lookup ids are minted
   against that Project and its home row lives there. `read_hq_app` takes `project_id`, and its
   description makes the agent ask. Not done: a `project_id` argument of `bring_in_hq_app` beside the
   answers, because a second Project at creation would be a second source of one fact.
2. **Six tools, not three.** Beside the three that bring an app in (`list_hq_apps`, `read_hq_app`,
   `bring_in_hq_app`), `stop_publishing` is part 10's Departure 3, and `refresh_managed_data` and
   `set_lookup_table_management` are part 11's (its 12.4). B12 registers all six.
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
   `/api/commcare`, which the allowlist already holds, so the plan's rule that bringing an app in adds
   no route the proxy allowlist does not already hold (part 12, 4.1) is kept. The dialog changes with
   the picker and not after it, because one connection read by two mechanisms would let the picker see
   a key the dialog, minutes later in the same tab, says is missing.
4. **Reading shows the running step's name, not a ladder of steps with results.** The row holds `phase`,
   the files' counts and a running step's mark, and nothing else of a read in flight (part 12, 2.3
   and Decision 4), and this
   part adds no reading state of its own (its opening). The read still has named steps: each step is
   named as it runs (5). Not done: a ladder that keeps each finished step on screen with its result
   ("2 menus, 5 forms", "1 table"), because no row holds such a count before its outcome.
5. **No "Stop reading".** A step cannot be cancelled (part 12, 4.3). The screen offers leaving, and the
   home row Remove. Not done: a footer button that stops a read, because it would stop nothing.
6. **"Bring it in" is never disabled for a missing answer.** The press moves focus to what is missing
   and says so (8.9), and the server keeps the rule for every other caller. Not done: a button disabled
   until every choice is answered, with the reason beside it, because a disabled button cannot move
   focus to what is missing.
7. **The review's platform control lists only the declarations the app runs on, and says in a sentence
   why another is absent.** Not done: a choice the content cannot run, shown disabled with its
   `platformPickerLine`, because `platformPickerLine` words one feature's refusal for the picker of
   that feature; an app can be kept off a platform by several features and by its files, which V13 says
   whole. Part 12's `ReadingReview.runsOn` holds only offered choices.
8. **The picker marks the person's own open reading.** `startReading` returns the open row for the same
   key (part 12, 3.5), so without the mark a person who chose the app again would land mid-read with no
   warning. The mark and the button's "Carry on" say what will happen.
9. **A new primitive, `radio-group`.** Three screens need one-of-several rows with lines,
   `components/shadcn` has none, and `components/CLAUDE.md` forbids a hand-rolled one (12.2).
10. **"Stop publishing here" is on every deployment's card, not only a brought-in app's.** Part 10's
    ending is a state of any deployment (its section 8), and a Nova-made app's team can want the same
    thing. Not done: offering it only on the card of an app that was brought in, as a way a bring-in
    ends, because the helper's sentence is true of a Nova-made app's deployment too (11.1).
11. **The public docs of stack B land in B14, with their text fixed here.** B14 is "Contracts and
    public docs for stack B" (part 15, sections 1.2 and 7), and parts 10, 11 and 12 hand their public
    sentences to it the same way. Not done: landing the pages in B11 and B12 with the screens and tools
    they describe, because each stack lands its public docs in one pull request. `design/readme.md`
    lands in B11 with the screens, since `components/CLAUDE.md` makes it the authority the code
    follows.
12. **No header chip and no check on open.** Bringing changes made in CommCare HQ in is step 7's first
    group (`changes-made-in-hq`; `../7-rest-of-model.md`), and the chip that says CommCare HQ's copy
    has moved and the check on open that feeds it go with it. Step 6 says what it does do: V21b states
    that the next publish stops and lists what changed, and the docs page says bringing the changes in
    comes later (17.1, item 7). It names no step 7 answer in the product (11.3) and adds nothing to the
    builder's header.
13. **The account's links use HQ's position addresses.** Each group links to the page of CommCare HQ
    that holds its place, where the place has a page (7.2, 7.4). A finding's place holds positions
    (part 01, 8.1), and HQ serves those addresses on purpose and tests them (7.4). Not done: an
    address built from a menu's or a form's own HQ id, because the reading's real ids are not on a
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

**The outline, item by item, where it touches this part.**

| Item | The outline | Settled |
|---|---|---|
| 5, "Entry points. Import from the builder and over MCP, each confirming the platform declaration before the app exists" | a confirmation step | here: three entries (2); the declaration is a preselected choice of the review, the person's to change, and a required argument over MCP (8.3, 14.4; `../6-bring-in.md`, "What changed from the outline, and why", item 5) |
| 9, "The person confirms it, or narrows it, before the app exists" and "the first publish after import asks before changing the setting" | | here: 8.3, with V12a and V12b saying what the first publish will ask |
| 9, "Offered the split, else refused … the person confirms it before the app exists" | | here: the split is a row of the same choice (V10). An app no declaration runs is part 06's `no-platform-runs-everything`, an account finding drawn by 7.2 |
| 9, "Defect 20's confirmations" and 10, "Confirmations" | asked at import | not asked at a bring-in (part 12, Departures; part 10, 6.5). The review says which plan features Nova will not ask about (`adoptionRecordedFeaturesLine`), and the first publish asks the rest |
| 4, "Drift merging" | step 6 | step 7's first group, `changes-made-in-hq` (`../6-bring-in.md`, "What changed from the outline, and why", item 4; `../7-rest-of-model.md`). This part words the stop's three ways on (11.3) |
| 10, "Ending a deployment, this step's lifecycle" | | part 10 (B8) for the state; here for the card, the drift stop and the confirmation (11.1, 11.3) |
| 1 to 3, 6 to 8, the cutover | | no screen or tool of this part; parts 01 to 12 and 14 |

---

## Files by pull request

**B11, the experience.** Above B10, below B12.

- New: `components/bring-in/bringInModel.ts`, `bringInClient.ts`, `useBringIn.ts`, `BringInFlow.tsx`,
  `BringInPicker.tsx`, `BringInReading.tsx`, `BringInStop.tsx`, `BringInAccount.tsx`,
  `BringInReview.tsx`, `ReviewRunsOn.tsx`, `ReviewTableChoice.tsx`, `FirstPublishLines.tsx`;
  `components/builder/HqNotConnected.tsx`, `StopPublishingDialog.tsx`;
  `components/shadcn/radio-group.tsx`; `app/(app)/(site)/readings-in-progress.tsx`,
  `readingRowModel.ts`; `app/api/commcare/hq-apps/route.ts`,
  `app/api/commcare/connection/route.ts`; `lib/routing/bringInLocation.ts`;
  `lib/publish/bringInCopy.ts`; `lib/deployment/reading/picker.ts`, `pickerTypes.ts`;
  `lib/deployment/hqPlaceUrl.ts`; `design/components/core/RadioGroup.prompt.md`;
  `e2e/lib/bring-in-client.tsx`, `bringInSeed.ts`; `e2e/tests/browser/bring-in.spec.ts`;
  `e2e/tests/app/bring-in.spec.ts`; the Vitest and Postgres files of "Tests".
- Changed: `app/(app)/(site)/app-list.tsx`, `page.tsx` (the empty state's probe, its entry line,
  and `RefreshStaleAppList` in the empty branch), `app-list-body.tsx`, `RefreshStaleAppList.tsx`
  (its header);
  `app/(app)/build/[id]/[[...path]]/page.tsx` (`freshBuildPage`: `BringInSeed`);
  `components/chat/StartFromScratch.tsx`, `ChatSidebar.tsx`, `ChatContainer.tsx`;
  `components/builder/BuilderLayout.tsx`, `CommCareConnectionContext.tsx` (`refresh`),
  `PublishPanel.tsx` (the context's refresh), `DeploymentStatus.tsx` (11.1, with `canStop`),
  `PublishDialogBody.tsx` (`HqNotConnected` in place of `NotConfigured`, the first-publish
  section, the drift stop's block, and `PublishDialogProps.hqConnectionRefreshFailed`),
  `publishOutcome.ts` (`PublishPlan`, `publishPlanCopy`),
  `app-setup/publishingSectionModel.ts`, `app-setup/PublishingSection.tsx` (passes `canStop`,
  11.1);
  `components/builder/detail/appSettings/AppPlatformsSection.tsx` and `lib/domain/platforms.ts`
  (`PLATFORM_DECLARATION_LINES`); `lib/routing/useClientPath.ts` (`useBuilderSearchFrom`);
  `lib/ui/appListFreshness.ts` (its comments); `lib/deployment/reading/index.ts`
  (`listHqAppsForPicker`); `lib/deployment/index.ts` (`hqPlaceUrl`, and `HqAppPicker` and
  `HqAppPickerRow` as types; the reading's own types are re-exported there by B10);
  `e2e/lib/smokeProfiles.ts` and `e2e/lib/smokeSeedFactory.ts` (the `bring-in` profile and its
  builder), `e2e/tests/browser/publishing.spec.ts` and its peer; `design/readme.md`;
  `components/CLAUDE.md`, `components/builder/CLAUDE.md`, `lib/routing/CLAUDE.md`, `e2e/CLAUDE.md`.
- Used and not changed: `components/builder/PublishDialog.tsx` (it forwards `PublishDialogProps`
  whole, 4.4); `e2e/lib/routes.ts` ("Tests").
- Not in B11: `lib/publish/firstPublishCopy.ts` (created by B6, part 08; given its first-publish
  exports by B7, part 09) and `lib/publish/firstPublishChangeIds.ts` (B7, part 09);
  `DeploymentView.firstPublish`, `readFirstPublishStates`, `firstPublishOf` (B7); the baseline's
  column (B8). B11 reads the first two files and `DeploymentView.firstPublish`, and changes none.
- No migration, no column, no `lib/db/pg.ts` change. No `lib/hostnames.ts` entry (4.2, 4.4). No
  `MODEL_CONTEXT_VERSION` move. No `scripts/test-schema.ts` entry. No billed run.

**B12, MCP, the guide, the plugin skill, versions, the billed check.** Above B11, below B13.

- New: `lib/mcp/tools/listHqApps.ts`, `readHqApp.ts`, `bringInHqApp.ts`, `stopPublishing.ts`,
  `managedData.ts`, `readingProjection.ts` (`describeReading`, `mapReadingRefusal`);
  `lib/mcp/__tests__/readingProjection.test.ts`,
  `bringInToolScopes.test.ts`, `bringInTools.postgres.test.ts`.
- Changed: `lib/mcp/server.ts`; `lib/mcp/errors.ts` (`BringInErrorType`, `BringInToolError`, the
  payload's four fields, the branch of `toMcpErrorResult`); `app/api/mcp/dispatch.ts`
  (one sentence of the comment on `MCP_MAX_DURATION_SECONDS`; the constant stands);
  `lib/mcp/tools/deploymentProjection.ts`,
  `deploymentTools.ts`, `checkProjectSpaceCompatibility.ts`, `uploadAppToHq.ts`, `getHqConnection.ts`
  (descriptions and projections of 14.7); `lib/publish/bringInCopy.ts` (M1 to M6, added to the
  file B11 creates) with `lib/publish/__tests__/bringInCopy.test.ts` unchanged, since its four
  rules run over every export;
  `lib/agent/authoring/reference.ts`; `lib/models.ts`;
  `lib/mcp/__tests__/servedSchemas.test.ts`, `errors.test.ts`, `compatibility.postgres.test.ts`,
  `deploymentTools.postgres.test.ts`; `lib/deployment/CLAUDE.md`, `lib/agent/authoring/CLAUDE.md`.
- Under run E1's outcome B alone: `lib/agent/tools/getLookupTables.ts` or
  `lib/agent/tools/organization.ts`, whichever holds the entry the provider refused.
- Not in B12: `lib/deployment/resources.ts`, `store.ts` and `actions.ts`. `firstPublishOf` and
  `readFirstPublishStates` are B7's (part 09, 12.3), and B12 calls them.
- The billed run E1, asked once at the head of the pull request, over the hash run's list.
- No route and no migration. No `scripts/test-schema.ts` entry, unless the hash run names a moved
  tool the script does not register (15.3).

**The plugin's pull request** (`../nova-plugin`): `skills/bring_in/SKILL.md` and its `.dev-plugin`
mirror; `skills/upload_to_hq/SKILL.md` and its mirror; both `plugin.json` files; `README.md`. Merged
after stack B is live.

**B14** (part 15) lands `content/docs/bringing-in-from-commcare-hq.mdx` (with part 08's C13 and
C14 in it, 17.1), `meta.json`, the `index.mdx` line, the rows of 17.2 (`claude-code/commands.mdx`
and `claude-code/quickstart.mdx` among them) and 17.3, and the two root `CLAUDE.md` sentences of
"Contracts".

---

## What this part needs of other parts

- **Part 12 (`12-the-reading-and-the-birth.md`, B10).** Every need below is one part 12
  holds as written (its 5.1, "Files by pull request", "Tests" and "Copy"); B11 changes no function
  of B10's. Four values on `ReadingReview`, in
  `readingReviewSchema`, filled in `gather.ts` where `runsOn` is, and therefore in the digest:

  ```ts
  /** Why the preselected choice is the one proposed (part 06's `narrowedByHq` and `keepsWebApps`). */
  readonly runsOnWhy: "content" | "web-apps-off-in-hq" | "keeps-web-apps";
  /** `HqAppSource.cloudcareEnabled`. */
  readonly webAppsOnInHq: boolean;
  /** How many date-and-time questions a choice that splits changes; 0 where no choice splits. */
  readonly datetimeQuestions: number;
  /** Each platform no offered choice declares, with what keeps the app off it. */
  readonly platformsOut: readonly {
  	readonly platform: Platform;
  	/** The distinct features of `platformUses.ts::unavailableUses` for that platform, in table order. */
  	readonly features: readonly PlatformFeatureId[];
  	/** A referenced file does not play there (part 11's `readingMediaFindings().playsOn`). */
  	readonly media: boolean;
  }[];
  ```

  `runsOnWhy` is `web-apps-off-in-hq` where the draft's `narrowedByHq` is true and the proposal
  stands, `keeps-web-apps` where `keepsWebApps` is true and the proposal stands, and `content`
  otherwise, including where part 11's files removed the proposal. Also: `lib/deployment/index.ts`
  re-exports, as types, `ReadingView`, `ReadingSummary`, `ReadingReview`, `ReviewTable`,
  `ReviewPlaces`, `ReadingDeclarationChoice`, `ReadingOutcome`, `ReadingRefusal`, `BringInInput`,
  `CreateResult`, `AdoptedAppReceipt` and part 11's `LookupTableChoice`, since this part imports no
  module of `lib/deployment/reading`. `ReviewPlaces` is declared in part 11's `reviewTypes.ts` with
  the members part 12's 5.1 gives it (`count`, `digest`), and `lib/deployment/index.ts` re-exports
  it; this part reads `count`. `landCreatedAppReceipt` is reachable where `ChatContainer` mounts
  `BringInFlow`, which hands it to `useBringIn`. Its birth test's fixture is exported as
  `lib/deployment/reading/__tests__/adoptionFixture.ts::adoptFixtureApp(input: { projectId: string;
  actorUserId: string }): Promise<{ appId: string; receipt: AdoptedAppReceipt }>`, which
  `e2e/lib/bringInSeed.ts` calls. `ReadingView.stepRunning` (its 3.1 and 3.2) is what the model
  drives by (3.3) and what the home row's status line reads (10.2), and its `phase` is null
  wherever `stepRunning` is false. An `advance` or a `create` answered `again` with the row
  unchanged is a step that found the server's reading slot taken (its 3.6), and needs nothing of
  this part but the call again that every `again` already gets. One more field, which part 09
  asks of part 12 (its 12.1) and this part's 8.8 and 14.3 read:
  `ReadingDeclarationChoice.firstPublish: FirstPublishView`, taken from the `AcceptedDeclaration`
  at the same position, in `readingReviewSchema` and so in the digest. `ReadingReview.firstPublish`
  stays the preselected choice's and this part reads it nowhere. Three things of its "Copy" and
  5.1 this part draws and does not word: `READING_PHASE_LABELS`' entry for `publishing-media`,
  a function of the count with two forms (its C4; 9.1 here); `UNVERIFIED_LANDING_TITLE` and
  `UNVERIFIED_LANDING_BODY`, exports of `lib/publish/hqReadingCopy.ts` (its C6; 9.2 here); and
  `review.kept`, filled as the `kept` row of its 5.1 says (8.7 here).
- **Part 09 (`09-acceptance-and-the-first-publish.md`, B7, with its column in B8's
  migration).** As written, and nothing renamed: `FIRST_PUBLISH_CHANGE_IDS`, `FirstPublishChangeId`,
  `FirstPublishView`, `firstPublishViewSchema`, `StoredFirstPublish` and
  `firstPublishViewFromStored` in `lib/publish/firstPublishChangeIds.ts`;
  `FIRST_PUBLISH_SENTENCES`, `FirstPublishLine` (`id`, `sentence`), `firstPublishLines(view,
  surface)` returning `FirstPublishLines` (`heading`, `lead`, `workers`, `hqOnly`, `reassurance`,
  `note`; each group in registry order), `FIRST_PUBLISH_HEADING`, `FIRST_PUBLISH_LEAD_REVIEW`,
  `FIRST_PUBLISH_LEAD_PUBLISH`, `FIRST_PUBLISH_WORKERS_LABEL`, `FIRST_PUBLISH_HQ_LABEL`,
  `FIRST_PUBLISH_NO_WORKER_CHANGE` and `FIRST_PUBLISH_FORM_BUILDER_NOTE` in
  `lib/publish/firstPublishCopy.ts`; the list kept on
  `app_deployment_baselines.first_publish_changes`, written at the birth with the chosen
  declaration's view and ended by the first push; `readFirstPublishStates` (B7); and
  `DeploymentView.firstPublish: FirstPublishView | null` (the column B8, the rest B7). This part
  settles every need part 09 states of it: the review and the dialog draw what
  `firstPublishLines(view, surface)` returns, in its order, and add no rule of their own (8.8,
  11.2); the review redraws from the chosen `ReadingDeclarationChoice.firstPublish`
  (8.8); B12 returns `first_publish` on each `runs_on` entry and on
  `check_project_space_compatibility`, held in `servedSchemas.test.ts` (14.3, 14.7, with the one
  placement Departure 14 argues). The rule that fills `DeploymentView.firstPublish` is a pure
  export of part 09's, so MCP and the builder cannot differ:

  ```ts
  // lib/deployment/resources.ts (B7), beside part 10's deploymentEnding
  /** The list the person reviewed, while the live app mapping is adopted and names the app the list
   *  was stored for; null otherwise. */
  export function firstPublishOf(
  	deployment: DeploymentWithResources,
  	state: { readonly remoteAppId: string; readonly stored: StoredFirstPublish } | undefined,
  	runsOnlyOn: Platform | undefined,
  ): FirstPublishView | null;
  ```

  `lib/deployment/actions.ts` fills the view with it and B12's `checkProjectSpaceCompatibility.ts`
  calls it with `readFirstPublishStates`' entry for the deployment and
  `doc.appSettings.runsOnlyOn` (14.7). Its publishing paragraph for `publishing.mdx` is placed by
  17.2.
- **Part 10 (`10-identity-and-the-ledger.md`, B8).** As written: `DeploymentResource` with
  `ownership`, `adoptedAt` and `adoptedByName`; `deploymentEnding` in `lib/deployment/resources.ts`,
  importable by a client component as `activeRemoteApp` is today; `stopPublishingAction` and
  `DeploymentActionResult`'s `not_permitted`; `NextPublishAction`'s `creates-beside` reaching the
  dialog's `PublishPlan`; `lib/publish/stopPublishing.ts` and
  `lib/publish/hqAppClaims.ts`; `adoptionRecordedFeaturesLine`; `RestoreAppResult.stoppedPublishing`;
  the MCP error map for `not_permitted`, and `ended` and `publishing_stopped` in the served enums,
  landed in B8. B12 adds the keys `ending`, `brought_in` and `since` to the projections and names
  `ended`, `ending` and `publishing_stopped` in the tool descriptions (14.7), which is the whole of
  what part 10 asks of B12 beside `stop_publishing` (14.5) and the skill's sweep (16.2).
- **Part 11 (`11-project-data.md`, B9).** As written: R1 to R12 as exports of
  `lib/publish/managedData.ts` that take the values of `ReviewTable` and `ReviewPlaces`;
  `LookupReferencingAppSummary` carrying each app's name; `LOOKUP_TABLE_CHOICES`,
  `LookupTableChoice`, `LookupChoiceOffer`, `ReviewTable` and `ReviewPlaces` in
  `lib/deployment/reading/projectData/reviewTypes.ts`, whose only run-time import is `zod`; the
  fourth reason an answer is not offered, `fails-a-project-space-rule`, with its R10 sentence
  (8.5); and the services behind `refresh_managed_data` and `set_lookup_table_management`
  with their outcome sentences.
- **Part 01 (`01-the-bar-and-the-manifest.md`, A2, A3).** `CIRCUMSTANCE_STANDINGS` exported
  as a typed record and `StopCircumstance` over it (its 8.3), so `STOP_ACTIONS` is held total over
  the `stop` codes at compile time; the copy of sections 9.1 to 9.4 as written. It reads
  `ACCOUNT_CHECK_AGAIN_LINE` and `circumstanceNext` (part 01, 8.4 and 9.1), both landed in B2.
- **Part 05 (`05-reading-commcare-hq.md`, B1).** `getHqCredentials`, `listHqApps`,
  `probeHqApiAccess`, `classifyHqFailure` and `hqReadCircumstance` as written.
- **Parts 04, 06 and 08.** Nothing asked. This part reads `RUNTIME_VERSION` 19 from part 04 (its
  3.4, A9); part 06's `narrowedByHq` and `keepsWebApps` through part 12's `runsOnWhy`, its
  `no-platform-runs-everything` with `detail.reason: "split-refused"` (its 16.3, B2) and its
  Departure 11, which is why an account says a later check may find more; and part 08's guide
  sentence C7 (15.1), its docs sentences C13 and C14 (17.1), and its run E7, which this part's E1
  answers.
- **Part 14 (`14-proof.md`, A1, B13).** Nothing of the lane. No base, variant or canonicalization
  comes from this part.
- **Part 15 (`15-stack-contracts-and-exit.md`, B14, B15).** B11 sits above B10 and B12 above B11. This
  part adds no migration, so it takes no timestamp. B14 lands section 17's pages, the rows of 17.2 for
  `claude-code/commands.mdx` and `claude-code/quickstart.mdx` among them, and the two root `CLAUDE.md`
  sentences. B15 removes nothing of this part: it adds no one-off script and no transitional file. The
  plugin's pull request is on the stack's checklist as "merge after the deploy is live". Stack B's one
  billed check is this part's run E1, asked once at B12's head over the hash run's list (part 15, section
  3, rule 7); part 15 lists it and asks nothing. And `../7-rest-of-model.md` lists, under
  `second-project-space`, updating an existing copy of the app in another project space, which V21c and
  D7 state meanwhile; and under `changes-made-in-hq`, a header chip and a check on open (Departure 12).

## What other parts read from this one

- **The flow**: `components/bring-in/` (`BringInFlow`, `useBringIn`, `bringInModel.ts` with
  `BringInModel`, `PickerModel`, `BringInCall`, `BringInEvent`, `BringInScreen`, `BringInAct`,
  `initialBringInModel`, `reduceBringIn`, `screenOf`, `nextAct`, `ReviewAnswers`, `initialAnswers`,
  `unansweredChoices`, `bringInInputOf`, `chosenDeclaration`, `StopAction`, `STOP_ACTIONS`,
  `placeGroupKey`, `AccountItem`, `AccountGroup`, `accountGroups`, `accountHeading`,
  `AccountCounts`, `accountCounts`, `countLine`, `accountAsText`, `DeclarationRow`,
  `declarationRows`, `DeclarationWhy`, `declarationWhy`); `bringInClient.ts` (`BringInAnswer` and
  its seven wrappers); the component `FirstPublishLines` (props `view`, `surface`), which calls
  part 09's `firstPublishLines(view, surface)` and holds no rule; `ChatSidebar`'s `takeover` prop;
  `BringInSeed` (`initialSearch`, `projects` with `id`, `name`, `personal`).
- **Routing**: `lib/routing/bringInLocation.ts` (`BringInLocation`, `bringInLocation`, `bringInHref`);
  `useBuilderSearchFrom`; the addresses `/build/new?hq=choose` and `/build/new?hq=<reading id>`.
- **The picker**: `HqAppPicker`, `HqAppPickerRow` (`lib/deployment/reading/pickerTypes.ts`);
  `listHqAppsForPicker`; the route `GET /api/commcare/hq-apps`.
- **The connection**: the route `GET /api/commcare/connection` (`{ connection:
  CommCareSettingsPublic }`); `CommCareConnection`'s `refresh`, `isRefreshing` and `refreshFailed`;
  `HqNotConnected` (props `title`, `body`, `note`, `error`, `isRefreshing`, `onRefresh`).
- **Links to CommCare HQ**: `hqPlaceUrl` (`lib/deployment/hqPlaceUrl.ts`, exported from
  `lib/deployment`).
- **The first publish**: nothing of this part's own. It reads part 09's `FirstPublishView`,
  `firstPublishLines(view, surface)`, its copy and `DeploymentView.firstPublish`, and over MCP its
  `readFirstPublishStates` and `firstPublishOf` (`lib/deployment`, B7), and adds no column,
  migration, store function, model function or sentence.
- **Copy**: `lib/publish/bringInCopy.ts`, with the ids of "Copy" (K22, W4b and `platformOutBlock`
  among them, M1 to M6 added by B12, and no string about what the first publish changes). No X3:
  the `unopened` screen draws part 12's `UNVERIFIED_LANDING_TITLE`. The account draws part 01's
  `ACCOUNT_CHECK_AGAIN_LINE`, and every circumstance's next step is part 01's
  `circumstanceNext(finding)`.
- **Publishing**: `broughtInOf`, `cardKind`, `broughtInElsewhere`
  (`app-setup/publishingSectionModel.ts`); `StopPublishingDialog` (props `open`, `onOpenChange`,
  `target`, `onStopped`); `DeploymentStatus`'s prop `canStop`;
  `PublishDialogProps.hqConnectionRefreshFailed`; `PublishPlan` and
  `publishPlanCopy(plan, { broughtInElsewhere })`, exports of `components/builder/publishOutcome.ts`
  with two new arms; `PLATFORM_DECLARATION_LINES` (`lib/domain/platforms.ts`).
- **The home list's freshness**: `markAppListStale()` called by the flow and by the home row's Check
  again; `RefreshStaleAppList` mounted in the empty state too.
- **Primitives**: `components/shadcn/radio-group.tsx` (`RadioGroup`, `RadioGroupItem`) and its
  contract.
- **The home list**: `ReadingsInProgress`, `ReadingRow`, `readingRow`.
- **MCP**: the tools `list_hq_apps`, `read_hq_app`, `bring_in_hq_app`, `stop_publishing`,
  `refresh_managed_data`, `set_lookup_table_management`, each a `z.strictObject`; `describeReading`,
  `mapReadingRefusal` and `ReadingProjection` (`lib/mcp/tools/readingProjection.ts`);
  that `read_hq_app` and `bring_in_hq_app` give a step part 12's `HQ_READING_STEP_MS`, 30 seconds
  inside `MCP_MAX_DURATION_SECONDS`;
  `BringInErrorType` (`hq_read_stopped`, `bring_in_refused`), `BringInToolError` and
  `McpErrorPayload`'s `circumstance`, `title`, `next` and `refusal`; `first_publish`, part 09's
  `firstPublishLines` value in snake case, on each `review.runs_on` entry of `read_hq_app` (built
  with `review`) and at the top level of `check_project_space_compatibility` (built with `publish`,
  null where `firstPublishOf` answers null), with no `first_publish_changes` and no
  `touches_workers` key anywhere; an agent relays `workers.lines` first, then `hq_only.lines`, each
  `sentence` as written, then `reassurance` where it is not null, then `note`;
  `account.check_again`; every circumstance `next` as `circumstanceNext(finding)`;
  `review.cannot_run`; `brought_in` and `ending` on the deployment projection and `since` on
  `upload_app_to_hq`'s `remote_changes` entries, all three added by B12 (`ended` and
  `publishing_stopped` are in the served enums from B8); `url` on a `created` answer.
- **Versions**: `MODEL_CONTEXT_VERSION` `"v7-hq-round-trip-bring-in.b12"` after B12;
  `RUNTIME_VERSION` stays `19`, the value A9 leaves (part 04, 3.4): no pinned document and no
  evaluator changes in B11 or B12.
- **Tests and seeds**: the `@seed:bring-in` profile (`SMOKE_PROFILES`, `smokeSeedFactory.ts`,
  `e2e/lib/bringInSeed.ts`); the `bring-in` component peer.
- **The plugin**: the skill `bring_in`; version `2.5.0`.
- **Docs**: `content/docs/bringing-in-from-commcare-hq.mdx`; the rows of 17.2, the two Claude Code
  pages among them; the section "Bringing in" of `design/readme.md`.
- **Facts**: the flow is a state of `/build/new` and never a dialog; its address holds the reading's
  id, which is the app's; a refresh loads the row and keeps no review answer; a stop is never mixed
  into an account; the review asks nothing by tick, preselects where the app runs and leaves a table
  choice open; Bring it in is never disabled for a missing answer; a brought-in app lands on its own
  home with one toast and an empty conversation; what the first publish changes is part 09's list,
  drawn in the review from the chosen declaration's own view and in the Publish dialog and over MCP
  from the read baseline's, and this part stores none of it; no act of the flow calls the Next
  router while the flow is on screen, and Check connection reads a route in the picker and in the
  Publish dialog alike; a creation holds the creating screen from the press to its end, through
  `again` answers and a lost request; a reading added to another Project than the tab's is named
  with its Project wherever the screen says where it is kept; leaving pauses a read after the step
  in flight and the copy says so; a viewer of the tab's Project who edits another can use the flow;
  the Solutions Architect is given none of the bring-in tools; `bring_in_hq_app` has no optional
  answer and takes no Project; B11 adds no migration, moves no version and asks for no billed run,
  and B12 asks for one, of two entries.
