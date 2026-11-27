# lib/routing — URL-driven navigation + selection

The builder's "where you are" and "what's focused" state lives in the URL, not in any store. This directory holds the path parser/serializer/validator and the React hooks that translate between path segments and the typed `Location` discriminated union.

## URL schema

```
/build/[id]                                   → home
/build/[id]/{moduleUuid}                      → module
/build/[id]/{moduleUuid}/results              → case-results authoring
/build/[id]/{moduleUuid}/cases/{caseId}       → case detail
/build/[id]/{moduleUuid}/search               → case-search authoring
/build/[id]/{moduleUuid}/details              → case-details authoring
/build/[id]/{moduleUuid}/data-review          → data review screen
/build/[id]/{moduleUuid}/condition            → module display condition
/build/[id]/{formUuid}                        → form
/build/[id]/{formUuid}/condition              → form display condition
/build/[id]/{formUuid}/operations             → form case operations
/build/[id]/{formUuid}/operations/{operationUuid}
                                               → selected case operation
/build/[id]/{formUuid}/links                  → form after-submit links
/build/[id]/{formUuid}/links/{linkUuid}       → selected after-submit link
/build/[id]/{formUuid}/{fieldUuid}             → form with field selected
/build/[id]/{menuUuid}/forms/{formUuid}[/...]  → a form (and any of its
                                               sub-screens above) opened
                                               through a menu that lists
                                               another menu's forms
```

`condition` is one URL noun over two `Location` kinds — `module-condition` and
`form-condition` — told apart by whichever entity the first segment names, the
same doc lookup the bare single-uuid path already does. They are separate kinds
because CommCare evaluates the two conditions in different places, which decides
what each editor may offer.

All entity UUIDs are globally unique in the doc store, so a single UUID segment identifies the entity type by a lookup in the doc's module / form / field maps. Case-operation selection is also URL-owned: the form UUID fixes the operation list and the optional operation UUID fixes the opened detail canvas, so refresh, back/forward, and multiplayer presence retain the same authored change. After-submit links (`form-links`) carry their selected link the same way, and `recoverLocation` drops a link a peer removed while keeping the list open.

Menu nesting is topology, not URL state. A child module, its case list, and its
forms keep the same identity-only paths when that module is reordered or moved
between root menus. The one exception is the menu a form opens through: a form
listed in a menu that lists another menu's forms is still the source's one
form, so its path carries the listing menu in front (`{menuUuid}/forms/...`).
`serializePath` and `buildUrl` take the doc to decide that, and
`parsePathToLocation` sends a form the listing menu does not show to that
menu, and any other malformed `forms` path to home. Breadcrumbs derive the current parent menu from the doc and
show it as a separate ancestor; they never treat the parent's case list as part
of the child's case-loading trail. Presence therefore continues to follow the
exact selected module, form, or field UUID rather than a positional menu path.

`LocationRecoveryEffect` also retains the last valid module topology. If a
remote edit deletes the module named by the unchanged current URL, recovery
opens its former parent (the parent's case list when it is bare) or Home when no
parent remains. Intentional navigation is not recovered through stale topology,
and reparenting a live module leaves its URL and selection untouched.

`{caseId}` is the one non-UUID segment: case ids are opaque text (`/`, `%`, `:`, spaces are legal), so `serializePath` percent-encodes the segment and `parsePathToLocation` decodes it — keep the pair symmetric. An undecodable segment (a raw `%` from a hand-typed URL) is taken verbatim and at worst reads as a missing case.

The authoring URLs deliberately use the same nouns as the workspace tabs:
**Search**, **Results**, and **Details**. The internal `Location.kind` values
(`search-config`, `cases`, and `detail-config`) are discriminators, not URL
tokens. The retired two-segment `/search-config`, `/cases`, and
`/detail-config` authoring paths neither parse nor redirect. `/cases/{caseId}`
is separate and remains the running case-record deep link.

## Browser History API, not Next's router

Navigation uses `pushState` / `replaceState` directly. Calling Next's router for selection changes triggers a server-side RSC re-render for every click, which is catastrophic on a canvas where selection flips constantly. The history events still work (back/forward traverse them), but we pay zero server cost for same-app navigation.

**A history entry's state holds identifiers and topology only, never a
value read from the Project's data or typed by the worker.** An entry
outlives the page that wrote it, the signed-in member and their Project
membership, so `builderHistoryState.ts` names the closed set the builder
writes (`__novaProjectScope`, the entry's own id `__novaEntry`, the entry it
was pushed after `__novaPreviousEntry: { path, entry }`, `__novaPreviousGap`,
and the standing searches' submission ids `__novaPreviewSearches` /
`__novaPreviewSearchesEnd`), and `useClientPath.ts::writeHistory` seals every
state through `sealedBuilderHistoryState` before `pushState` / `replaceState`:
Next's own keys pass through, every other builder key is dropped. What an
entry was shown with (the case selections, a held form menu's cases, each
search's context with its answers and hidden values) lives in
`previewEntryRecords.ts`: in memory, keyed by the entry's id, in the records
of the one Preview session that showed it. The session id is the key of the
container: a write for another session lets the earlier session's records go
and starts empty, a read for another session finds nothing, and a session once
let go never writes again. Every write mints a new entry id and carries the
current entry's search contexts on to it (the search history prunes them); a
lens write also carries the screen's held menu, a write that names a held
menu files the record in that menu's session, and the selections are
recorded as the screen shows them.

One Preview step lives in history rather than the path: a case
list's own form menu holding its chosen cases (`previewHeldMenu.ts`). It is
an entry at the list's URL whose record holds the held cases in the Preview
session that held them, written only by `navigate.holdPreviewMenu` (pushed
after the list, or replacing the case's details the choice went through) and
`navigate.reopenPreviewHeldMenu` (a case crumb on a form chosen there, which
steps back onto the menu where the form was opened from it, and otherwise
pushes the menu again; where the entry that step lands on no longer holds the
menu, as after the menu's own Back showed the list in its entry and Forward
came back to the form, it pushes the menu again there,
`previewHeldMenuStands`). Each takes the session that holds the menu.
`previewHeldMenu.ts::builderEntryState` decides every write's entry and
`useClientPath.ts` applies it: every other write's record holds no menu, so
no entry inherits a menu it did not open, and each pushed entry records the
entry it was pushed after; a replace, and a language change's copy of the
screen, keep the entry before the screen they stand for, with how many
entries lie between (`__novaPreviousGap`). That is how a menu knows its
list's entry is behind it (`afterList`: the list at its module's Results,
Search, Details or data review URL, all of which Preview shows the running
list at; an entry whose menu an earlier Preview session held has no record in
this one and shows the list, so it counts as the list's), whether pushed from
the list or in place of the case's details or their copy under another
language, and how a form knows the menu is right before it.
`usePreviewHeldMenu(session)` reads the current entry's, on writes and on
Back and Forward alike, in the session running now. A language change is a
lens on the screen, so `pushBuilderLensHistory` keeps the menu, and
`stepBackOffPreviewHeldMenu(session)` (the menu's own Back) steps past the
menu's entries, and the details it replaced, at once and keeps the language
where its list's entry is behind it, and otherwise shows the list in the
menu's own entry (`previewHeldMenuBack`). A stale Project generation's entry
loses its id, and the entry it was pushed after
(`reconcileBuilderHistoryEntry`), so nothing the session holds for it is read
under the new generation.

A screen's own Back to the screen it was opened from goes through
`navigate.stepBackTo` (`useClientPath.ts::stepBackToBuilderEntry`, given the
running Preview session): where the entry the current one was pushed after
is that screen, holding no form menu in that session
(`previewHeldMenu.ts::stepsBackToPrevious`, past a language change's copies
too), it steps back onto it rather than writing a copy after itself, which
would leave the screen twice in history and make the browser's next Back land
on it again. Otherwise the destination replaces the current entry. Its `leave`
callback lets go of what the screen held as the move happens: before the
replace, or on the step's popstate ahead of the path subscribers. Where the
step lands on an entry that is no longer that screen, the destination opens
after it; where it lands under an earlier language, the entry takes the
current one. A parent case's list cancelling its request is the user
(`CaseListScreen::cancelParentCaseSelection`).

`readBuilderHistoryMove` counts every move to another entry or screen (a
builder write, Back and Forward, a Project generation's reconcile; a language
change and a record of standing searches are none). Work that navigates after
an await reads it when it begins and goes on only if it is unchanged, as
`CaseListScreen` does for a choice whose claim or selection check lands after
the worker has moved on. `readBuilderHistoryArrival` says how the last move came:
`back` for Back and Forward and for a screen's own step back
(`stepBackToBuilderEntry`, `stepBackOffPreviewHeldMenu`, whether it steps or
writes), `forward` for every other write; a Preview case list reads it as it
shows again to keep or start afresh the worker's place in it
(`lib/preview/caseListReturn.ts`).

An entry's state also names which of Preview's searches stand on it
(`previewSearchHistory.ts`), by submission id, as Web Apps keeps each query
on the page's address. A pushed entry inherits the names of the entry it was
pushed from, as Web Apps' `addSelection` keeps the query data, and the screen
it lands on keeps only the searches on its path
(`lib/preview/searchStanding.ts`). `recordPreviewStandingSearches` rewrites
those names alone on the current entry (and prunes its record's contexts),
keeping its address, id, held menu and the entry it was pushed after, so it
is no screen write; `usePreviewStandingSearches` reads them on writes and on
Back and Forward. A form's submission ends the searches it was opened under
on the screen it lands on alone: `endPreviewStandingSearches` marks the
form's entry, and the next write from it
(`previewSearchHistory.ts::previewSearchHistoryWrite`, applied in
`pushBuilderHistory`) records only the searches begun on that entry since
(`beginPreviewStandingSearch`, a registration re-keying its menu's search)
and, being a push, drops the mark from the entry it leaves, which keeps its
searches for Back and Forward, as Web Apps clears the query data of the
address it pushes after a submission and no earlier one. A language change
keeps the mark with the screen. The context of each search standing on an
entry (its answers, hidden values, the values worked out for them) is in the
entry's record in the session that ran it, written with the search by
`beginPreviewStandingSearch` and pruned with the names, so a search the
session has since replaced stands again when history returns to the entry
(`previewSearchesOnEntry`); `usePreviewSearchContexts(session)` reads it. The
record says only that the search stands: what answers it runs with when it
stands again is the platform's
(`lib/preview/searchStanding.ts::previewSearchArrival`), on Web Apps the
answers the worker last gave the module's query in the session, taken on
every screen the search stands on (run again where the arrival shows that
module's list, held completed with them on a menu or a form past it), as Web
Apps' address carries no answers. Submissions are unique across every search,
so an entry an earlier session or Project wrote names none the session holds.

The session also keeps, in each entry's record, the case selections it was
shown with (`previewSelectionsHistory.ts`: the menu selections, the
selections part of the case target, the selected case, and the task they
were held in), as Web Apps' address holds the session's `selections`.
`usePreviewSelectionsArrival` writes it on every screen but Home on Web Apps
and on every change of the selections (`recordPreviewSelections`, a record in
place, never a move); Android shows every entry with the session as it
stands, so it keeps none. `builderEntryState` gives a written entry a record
of its own, so no entry inherits another's. Back or Forward onto an entry of
this session returns the entry's selections on Web Apps wherever the session
holds others (past Home, an entry of an earlier or later task, which the
session takes up again; within the task, an entry shown before a crumb let a
case go or a later list chose another) before any screen renders it:
`onPopState` runs the listeners `subscribeBuilderHistoryPop` registers after
the reconcile and before the path subscribers, since a screen reads the
selections as it mounts (`previewSelectionsHistory.ts::previewSelectionsArrival`).
The window runs its popstate listeners in the order they were added, and
Next's App Router adds its own at hydration, before the builder's; react-dom
renders the transition that listener starts in the microtask right after it
returns, while the popstate is still `window.event`. So until the builder
takes a pop in, every builder read of history (`viewedEntry`: the path, the
query, the held menu, the standing searches, the recorded selections) stays
on the entry it last took in, and every builder write first takes in the
pending pop (`takeInPendingPop`). A render that reached the screens first
would otherwise show the popped entry with the previous entry's session, and
record that session over the entry's own selections
(`lib/preview/hooks/__tests__/previewSelectionsArrival.test.ts`).
`recordPreviewSelections` takes a reader of the session for that reason.
A screen's own step back (`stepBackTo`) runs its `leave` after that return,
so what the screen lets go stays let go. The entry's address is the
builder's: Back onto a form's entry opens that form, with the entry's
selections, though Web Apps shows the screen before the form there
(`lib/preview/CLAUDE.md` § Platforms).

The `lang` query parameter is the independent worker-content lens. Path
serialization changes only the location path and preserves the current query;
changing language changes only that parameter and preserves the typed location.
`useBuilderSearch` is the reactive query reader for both History-API pushes and
popstate. Do not put language into `Location` or drop it while navigating: a
shared field link and back/forward history must reopen in the same locale.

`/build/new` carries two query states, each seeded by the server for the first paint: `design`, and `hq` with the key of the app being brought in (`bringInLocation.ts`). `useBuilderSearchFrom(initialSearch)` reads the query with the server's validated text as its server snapshot, so the first render agrees with the server.

## Breadcrumbs — `useBreadcrumbs` (edit) and `previewBreadcrumbs.ts` (preview)

`useBreadcrumbs` derives the edit-mode trail from the URL + doc names. In preview the trail follows the RUNNING APP instead (a Results URL is a case-loading form's selection step, so its crumb names that FORM, not "Results"), and that rewrite lives in the pure `previewBreadcrumbs.ts` — kept pure + unit-tested precisely because the breadcrumb and the preview engine both read the same ephemeral `previewCaseTarget` and once drifted.

For a module with the case list in its menu (`caseListMenuItem`) that has neither forms nor child menus (`moduleIsBareCaseList`), the module IS its Results screen, so its trail collapses: the module crumb points at `{kind:"cases"}` and the redundant trailing "Results" crumb is dropped. Such a module with children instead points at `{kind:"module"}` so its menu remains reachable, with Results as a separate destination. Beside forms the entry is one more destination on the module's menu, and the trail does not collapse. The same identity drives `recoverLocation` (`location.ts`): a Search / Results / Details location whose module has no case type (e.g. the type was cleared, which also drops its case list menu entry) degrades to `{kind:"module"}` rather than stranding the user on a blank workspace.

**`previewCaseTargetBindsLocation(loc, target)` is the one predicate both consumers gate on** — `PreviewShell` grafts the bound `caseId` onto the form with it, the breadcrumb names the bound case with it. Anything that reads `previewCaseTarget` to decide "is this form's case the active one?" MUST go through it, or the loaded case and the displayed case can drift again (the original bug: a follow-up's case named on a register form that never loaded it). A case-loading form chosen before its case reads form then case, and its crumb carries `reselectCaseFor`, so clicking it re-opens the case list holding the form rather than re-navigating to the form you're already on. A form chosen from the menu after its case reads case then form, in the session's order as Web Apps' trail does, and the case's crumb carries `holdsCaseOn`: clicking it reaches that menu with the case held. A running menu screen names each case its session holds after the crumb of the menu that chose it (`menuHeldCases`), with the same `holdsCaseOn` crumb, which reaches that menu screen whatever case target a list's form menu left in the session; a list, a case's details and a form name the parent cases their menu goes on with the same way (`heldBefore`), whichever screen is on show, both chosen by `previewTrailHeldCases` from the session's selections. A parent case a list off the trail chose, or a forms-first menu's list on the trail chose for its submenu (`askedForBy`), follows the crumb of the menu whose command asked for it (or the form chosen before its cases) and comes before that menu's own case, one crumb per selection as Formplayer's `MenuSession.handleInput` adds them; its crumb (`parentCaseOn`) reaches the screen after it, the menu's list asking for its case, or the menu where it was the last case chosen, or the list holding the form. Every case crumb carries the menus whose cases were chosen up to it (`keepsCasesOf`), and every crumb after one carries the last one's, which its cut keeps. In Preview each crumb cuts the session back to the screen it names, keeping every case named before it and letting every later one go, as Web Apps' breadcrumb does (`previewBreadcrumbLetGo`, the one cut `BreadcrumbStrip` runs, over `menuProjection.ts::previewMenuSelectionsLetGo`): a menu's crumb after a parent case a list off the trail chose keeps that case, and the crumb of a form chosen before its cases (or of the form a list holds) lets go a parent case asked for after the form, so its list asks for it again still holding the form (`components/preview/screens/moduleScreenNavigation.ts::previewTargetKeptForParentCase`). Its searches go the same way (`lib/preview/searchStanding.ts`); the crumb of a case a list's own form menu holds also carries those cases (`holdsCaseListMenu`) and reaches that menu's history entry again (`navigate.reopenPreviewHeldMenu`).

App setup's **Deep links** section owns `/setup/deep-links/{entryPointUuid}`.
The optional entry-point UUID selects its detail; it is not ephemeral local
state. Removing the point or its owner recovers to the overview, and renaming
its external link ID leaves its authoring URL unchanged.

## Testing the routing boundary

`navigation.ts` owns event-time navigation and guarded selection decisions;
`builderHistoryState.ts` owns what a history entry may hold and
`previewEntryRecords.ts` what the Preview session holds for it
(`__tests__/builderHistoryState.test.ts` drives the real writers through a
Preview walk and reads every entry the browser keeps);
`builderLocation.ts` owns the shared document/path cache and subscriptions;
`breadcrumbs.ts` derives the trail from already projected names;
`locationRecovery.ts` advances recovery and prior topology together;
`historyPolicy.ts` decides query retention and Project-generation scrubbing;
`historyStep.ts` admits and applies actual undo/redo batches. Their
programmatic tests use typed documents and real store mutations. React hooks
bind those decisions to the browser. Back/Forward, replace-only selection,
language query retention, and visible destinations are exercised in Playwright.
Do not replace the URL reader or History writer in a mounted hook test.

A legacy two-identity form URL may select only a field owned by that form. A
foreign or orphaned field segment leaves the named form open without selection;
the canonical single-field URL resolves that field's actual owner.

After a field deletion, `deletionSelection.ts` uses the old visual order and the
new document to select the next surviving row, then the previous row, then none.
Children removed with a group or repeat cannot become the new selection.


## Leaving with unsaved app edits

`departureGuard.ts` registers the mounted Builder's live unsaved-work predicate.
`useExternalNavigate` consults it before cross-route pushes/replacements; the
browser adapter handles links, native unload and cancellable Navigation API
history traversals. Same-app locations keep the document runtime and do not
warn. The registration is released with its provider, including effect replay.

### Home after a submitted form

A fresh Home carries no case selections. The Android Previous task records its retained menu selections on the Home history entry it opened. Back and Forward can restore that entry only for the same Preview session.
