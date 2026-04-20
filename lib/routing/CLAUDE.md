# lib/routing — URL-driven navigation + selection

The builder's "where you are" and "what's focused" state lives in the URL, not in any store. This directory holds the path parser/serializer/validator and the React hooks that translate between path segments and the typed `Location` discriminated union.

## URL schema

```
/build/[id]                                   → home
/build/[id]/{moduleUuid}                      → module
/build/[id]/{moduleUuid}/cases                → case list
/build/[id]/{moduleUuid}/cases/{caseId}       → case detail
/build/[id]/{formUuid}                        → form
/build/[id]/{formUuid}/{fieldUuid}         → form with field selected
```

All entity UUIDs are globally unique in the doc store, so a single UUID segment identifies the entity type by a lookup in the doc's module / form / field maps.

## Browser History API, not Next's router

Navigation uses `pushState` / `replaceState` directly. Calling Next's router for selection changes triggers a server-side RSC re-render for every click, which is catastrophic on a canvas where selection flips constantly. The history events still work (back/forward traverse them), but we pay zero server cost for same-app navigation.
