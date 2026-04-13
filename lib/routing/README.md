# lib/routing — URL-Driven Navigation + Selection

The builder's "where are you" and "what's focused" state lives in the URL,
not in any store. This directory contains the pure parser/serializer/
validator that translates between query-string form and the `Location`
discriminated union.

## URL schema

```
/build/[id]                                   → home
/build/[id]?s=m&m=<uuid>                      → module
/build/[id]?s=cases&m=<uuid>                  → case list
/build/[id]?s=cases&m=<uuid>&case=<caseId>    → case detail
/build/[id]?s=f&m=<uuid>&f=<uuid>             → form
/build/[id]?s=f&m=<uuid>&f=<uuid>&sel=<uuid>  → form with question selected
```

UUIDs are used instead of indices so URLs are stable across renames and
reordering. Param keys are short (`s`/`m`/`f`/`sel`/`case`) to keep URLs
bookmark-friendly.

## Contents

- `types.ts` — `Location` discriminated union, `LOCATION_PARAM`, `SCREEN_KIND`.
- `location.ts` — `parseLocation`, `serializeLocation`, `isValidLocation`.
  All three are pure and fully unit-tested (`__tests__/location.test.ts`).

## Status

**Phase 0 (scaffolding):** pure functions + tests are complete. No React
hooks or router adapters yet.

- Phase 2: adds `useLocation()`, `useNavigate()`, `useSelect()`, and the
  root-level "strip invalid URL params" effect.

See `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`.
