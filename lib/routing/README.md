# lib/routing — URL-Driven Navigation + Selection

The builder's "where are you" and "what's focused" state lives in the URL,
not in any store. This directory contains the path parser/serializer/
validator and React hooks that translate between path segments and the
`Location` discriminated union.

## URL schema

```
/build/[id]                                   → home
/build/[id]/{moduleUuid}                      → module
/build/[id]/{moduleUuid}/cases                → case list
/build/[id]/{moduleUuid}/cases/{caseId}       → case detail
/build/[id]/{formUuid}                        → form
/build/[id]/{formUuid}/{questionUuid}         → form with question selected
```

All entity UUIDs are globally unique in the doc store. A single UUID
segment identifies the entity type by checking `doc.modules`, `doc.forms`,
`doc.questions`. Navigation uses the browser History API
(pushState/replaceState) via `useClientPath.ts` to avoid server-side RSC
re-renders.

## Contents

- `types.ts` — `Location` discriminated union.
- `location.ts` — `serializePath`, `parsePathToLocation`, `buildUrl`,
  `isValidLocation`, `recoverLocation`. All are pure and fully unit-tested.
- `useClientPath.ts` — `useBuilderPathSegments()` hook (useSyncExternalStore
  over window.location.pathname) and `notifyPathChange()` for programmatic
  navigation.
- `hooks.tsx` — `useLocation()`, `useNavigate()`, `useSelect()`,
  `useBreadcrumbs()`, `useSelectedQuestion()`, `useSelectedFormContext()`,
  `useIsModuleSelected()`, `useIsFormSelected()`, `useIsQuestionSelected()`.
- `builderActions.ts` — `useUndoRedo()`, `useDeleteSelectedQuestion()`.
- `domQueries.ts` — Pure DOM helpers (findFieldElement, flashUndoHighlight).
