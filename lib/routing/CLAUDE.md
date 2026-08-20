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
```

`condition` is one URL noun over two `Location` kinds — `module-condition` and
`form-condition` — told apart by whichever entity the first segment names, the
same doc lookup the bare single-uuid path already does. They are separate kinds
because CommCare evaluates the two conditions in different places, which decides
what each editor may offer.

All entity UUIDs are globally unique in the doc store, so a single UUID segment identifies the entity type by a lookup in the doc's module / form / field maps. Case-operation selection is also URL-owned: the form UUID fixes the operation list and the optional operation UUID fixes the opened detail canvas, so refresh, back/forward, and multiplayer presence retain the same authored change. After-submit links (`form-links`) carry their selected link the same way, and `recoverLocation` drops a link a peer removed while keeping the list open.

`{caseId}` is the one non-UUID segment: case ids are opaque text (`/`, `%`, `:`, spaces are legal), so `serializePath` percent-encodes the segment and `parsePathToLocation` decodes it — keep the pair symmetric. An undecodable segment (a raw `%` from a hand-typed URL) is taken verbatim and at worst reads as a missing case.

The authoring URLs deliberately use the same nouns as the workspace tabs:
**Search**, **Results**, and **Details**. The internal `Location.kind` values
(`search-config`, `cases`, and `detail-config`) are discriminators, not URL
tokens. The retired two-segment `/search-config`, `/cases`, and
`/detail-config` authoring paths neither parse nor redirect. `/cases/{caseId}`
is separate and remains the running case-record deep link.

## Browser History API, not Next's router

Navigation uses `pushState` / `replaceState` directly. Calling Next's router for selection changes triggers a server-side RSC re-render for every click, which is catastrophic on a canvas where selection flips constantly. The history events still work (back/forward traverse them), but we pay zero server cost for same-app navigation.

The `lang` query parameter is the independent worker-content lens. Path
serialization changes only the location path and preserves the current query;
changing language changes only that parameter and preserves the typed location.
`useBuilderSearch` is the reactive query reader for both History-API pushes and
popstate. Do not put language into `Location` or drop it while navigating: a
shared field link and back/forward history must reopen in the same locale.

## Breadcrumbs — `useBreadcrumbs` (edit) and `previewBreadcrumbs.ts` (preview)

`useBreadcrumbs` derives the edit-mode trail from the URL + doc names. In preview the trail follows the RUNNING APP instead (a Results URL is a case-loading form's selection step, so its crumb names that FORM, not "Results"), and that rewrite lives in the pure `previewBreadcrumbs.ts` — kept pure + unit-tested precisely because the breadcrumb and the preview engine both read the same ephemeral `previewCaseTarget` and once drifted.

For a `caseListOnly` module (a bare case list with no forms) the module IS its Results screen, so its trail collapses: the module crumb points at `{kind:"cases"}` and the redundant trailing "Results" crumb is dropped. The same identity drives `recoverLocation` (`location.ts`): a Search / Results / Details location whose module has no case type (e.g. the type was cleared, which also drops the `caseListOnly` flag) degrades to `{kind:"module"}` rather than stranding the user on a blank workspace.

**`previewCaseTargetBindsLocation(loc, target)` is the one predicate both consumers gate on** — `PreviewShell` grafts the bound `caseId` onto the form with it, the breadcrumb names the bound case with it. Anything that reads `previewCaseTarget` to decide "is this form's case the active one?" MUST go through it, or the loaded case and the displayed case can drift again (the original bug: a follow-up's case named on a register form that never loaded it). A case-loading form's crumb carries `reselectCaseFor`, so clicking it re-opens the case list rather than re-navigating to the form you're already on.
