# Phase 6: Cleanup + Lint Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete all legacy builder state files, migrate every call site to the new module boundaries, enforce those boundaries with Biome lint rules, and update documentation — completing the builder state re-architecture.

**Architecture:** The builder's state was split across three stores in Phases 0–5: `lib/doc/` (BlueprintDoc), `lib/session/` (BuilderSession), and `lib/routing/` (URL-driven). Legacy bridge files (`hooks/useBuilder.tsx`, `lib/services/builderStore.ts`) still exist with dead wrapper hooks and a near-empty legacy store. Phase 6 moves the provider to its final home, migrates every import, deletes the legacy files, and enforces store-boundary rules with Biome's `noRestrictedImports`.

**Tech Stack:** TypeScript, Biome 2.x, Zustand, Next.js 16 App Router, Vitest

**Worktree:** `.worktrees/phase-6-cleanup` on branch `refactor/phase-6-cleanup`

**Baseline:** 61 test files, 1107 tests, all passing.

---

## File Structure

### Files to create

| File | Responsibility |
|------|---------------|
| `components/builder/BuilderProvider.tsx` | Mounts the full provider stack — doc store, session store, capability contexts, hydrators, sync bridge. The builder's single entry point. |

### Files to delete

| File | Reason |
|------|--------|
| `hooks/useBuilder.tsx` | Legacy bridge module — wrapper hooks are dead code, provider moves to `components/builder/BuilderProvider.tsx`. |
| `lib/services/builderStore.ts` | Empty vestigial store — no component reads it. |

### Files to modify

| File | Change |
|------|--------|
| `lib/session/types.ts` | Add `ReplayInit` type (moved from `hooks/useBuilder.tsx`). |
| `lib/session/provider.tsx` | Re-export `BuilderSessionStoreApi` type for external consumers. |
| `app/build/[id]/[[...path]]/page.tsx` | Import `BuilderProvider` from new location. |
| `app/build/replay/[id]/replay-builder.tsx` | Import `BuilderProvider` and `ReplayInit` from new locations. |
| `hooks/__tests__/useBuilder.test.tsx` | Rename to `components/builder/__tests__/BuilderProvider.test.tsx`, import from new location. |
| `components/builder/BuilderSubheader.tsx` | Import `useDocHasData` directly from `@/lib/doc/hooks/useDocHasData`. |
| `components/builder/BuilderContentArea.tsx` | Import `useDocHasData` directly from `@/lib/doc/hooks/useDocHasData`. |
| `components/preview/screens/HomeScreen.tsx` | Import `useDocHasData` directly from `@/lib/doc/hooks/useDocHasData`. |
| `components/preview/screens/FormScreen.tsx` | Replace index-based `useModule(mIdx)` / `useForm(mIdx, fIdx)` with uuid-based doc hooks. |
| `components/preview/screens/ModuleScreen.tsx` | Replace index-based `useModule(mIdx)` with uuid-based doc hook. |
| `components/preview/screens/CaseListScreen.tsx` | Replace index-based `useModule(mIdx)` with uuid-based doc hook. |
| `components/chat/ChatContainer.tsx` | Import `BuilderSessionStoreApi` from `@/lib/session/provider` instead of `@/lib/session/store`. |
| `components/chat/ChatSidebar.tsx` | Import `BuilderSessionStoreApi` from `@/lib/session/provider` instead of `@/lib/session/store`. |
| `components/chat/SignalGrid.tsx` | Import `BuilderSessionStoreApi` from `@/lib/session/provider` instead of `@/lib/session/store`. |
| `biome.json` | Add `noRestrictedImports` rule in `overrides` for `components/` and `app/`. |
| `CLAUDE.md` | Update builder state section to reflect completed architecture. |

---

## Task 1: Create `BuilderProvider` at its final location

Move the provider, hydrators, and sync bridge out of the legacy `hooks/useBuilder.tsx` into `components/builder/BuilderProvider.tsx`. Remove the legacy `StoreContext` wrapper entirely. Export `ReplayInit` from `lib/session/types.ts`. Re-export `BuilderSessionStoreApi` from the session provider for external consumers.

**Files:**
- Create: `components/builder/BuilderProvider.tsx`
- Modify: `lib/session/types.ts` — add `ReplayInit` interface
- Modify: `lib/session/provider.tsx` — add `BuilderSessionStoreApi` re-export

- [ ] **Step 1: Add `ReplayInit` to `lib/session/types.ts`**

At the bottom of `lib/session/types.ts`, add:

```ts
/**
 * Replay data extracted from server-fetched events, passed to BuilderProvider.
 * Moved here from the legacy `hooks/useBuilder.tsx` during Phase 6 cleanup.
 */
export interface ReplayInit {
	stages: ReplayStage[];
	doneIndex: number;
	exitPath: string;
}
```

- [ ] **Step 2: Re-export `BuilderSessionStoreApi` from the session provider**

In `lib/session/provider.tsx`, add a re-export after the existing imports so component consumers don't need to reach into the store module:

```ts
/** Re-exported for component-level type annotations (refs, callback params).
 *  Components should use the context-bound hooks for reactive reads — this
 *  type is for imperative-access patterns only. */
export type { BuilderSessionStoreApi } from "./store";
```

- [ ] **Step 3: Create `components/builder/BuilderProvider.tsx`**

Create the new file with the provider stack, hydrators, and sync bridge. This is the content from `hooks/useBuilder.tsx` with the following changes:
- **Remove** `StoreContext` creation and wrapping (the legacy store is gone).
- **Remove** the `createBuilderStore()` call and `useState` for the legacy store.
- **Remove** all legacy hook exports (`useBuilderStore`, `useBuilderStoreShallow`, `useBuilderStoreApi`).
- **Remove** all wrapper entity hooks (`useModule(mIdx)`, `useForm(mIdx, fIdx)`, `useQuestion(uuid)`, `useOrderedModules()`, `useOrderedForms(mIdx)`, `useAssembledForm(mIdx, fIdx)`, `useBuilderTreeData`).
- **Remove** the `useBuilderHasData` re-export (consumers import directly).
- **Import** `ReplayInit` from `@/lib/session/types` instead of defining it locally.
- **Keep** `BuilderProvider`, `BuilderProviderInner`, `SyncBridge`, `ReplayHydrator`, `LoadAppHydrator` — with updated JSDoc removing "Phase 6 deletes" comments.

The provider stack in `BuilderProviderInner` becomes (no `StoreContext` wrapper):

```tsx
return (
    <BlueprintDocProvider
        appId={buildId === "new" ? undefined : buildId}
        initialBlueprint={initialBlueprint}
        startTracking={Boolean(initialBlueprint || replay)}
    >
        <BuilderSessionProvider init={sessionInit}>
            <ScrollRegistryProvider>
                <EditGuardProvider>
                    <BuilderFormEngineProvider>
                        <SyncBridge />
                        <LocationRecoveryEffect />
                        {replay ? <ReplayHydrator replay={replay} /> : null}
                        {!replay && initialBlueprint ? (
                            <LoadAppHydrator buildId={buildId} />
                        ) : null}
                        {children}
                    </BuilderFormEngineProvider>
                </EditGuardProvider>
            </ScrollRegistryProvider>
        </BuilderSessionProvider>
    </BlueprintDocProvider>
);
```

Imports needed:

```ts
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
import { BlueprintDocContext, BlueprintDocProvider } from "@/lib/doc/provider";
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { BuilderSessionContext, BuilderSessionProvider } from "@/lib/session/provider";
import type { ReplayInit, ReplayStage } from "@/lib/session/types";
```

Exports: `BuilderProvider` (component) and `type { ReplayInit }` (re-exported from session types for convenience).

- [ ] **Step 4: Verify the new file compiles**

Run: `cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-6-cleanup && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors in the new file (old file still exists, so no import failures elsewhere yet).

- [ ] **Step 5: Commit**

```bash
git add components/builder/BuilderProvider.tsx lib/session/types.ts lib/session/provider.tsx
git commit -m "refactor(builder): create BuilderProvider at final location

Move the provider stack, hydrators, and SyncBridge from hooks/useBuilder.tsx
to components/builder/BuilderProvider.tsx. Remove the legacy StoreContext
wrapper — the vestigial builder store is no longer part of the provider tree.

Move ReplayInit type to lib/session/types.ts (its logical home).
Re-export BuilderSessionStoreApi from the session provider module."
```

---

## Task 2: Migrate all import call sites

Update every file that imports from `hooks/useBuilder` or `lib/services/builderStore` to use the new module locations. Also migrate three chat components from importing `BuilderSessionStoreApi` directly from the store module to the provider re-export.

**Files:**
- Modify: `app/build/[id]/[[...path]]/page.tsx`
- Modify: `app/build/replay/[id]/replay-builder.tsx`
- Modify: `components/builder/BuilderSubheader.tsx`
- Modify: `components/builder/BuilderContentArea.tsx`
- Modify: `components/preview/screens/HomeScreen.tsx`
- Modify: `components/preview/screens/FormScreen.tsx`
- Modify: `components/preview/screens/ModuleScreen.tsx`
- Modify: `components/preview/screens/CaseListScreen.tsx`
- Modify: `components/chat/ChatContainer.tsx`
- Modify: `components/chat/ChatSidebar.tsx`
- Modify: `components/chat/SignalGrid.tsx`
- Move + modify: `hooks/__tests__/useBuilder.test.tsx` → `components/builder/__tests__/BuilderProvider.test.tsx`

### Substep 2a: Migrate page-level BuilderProvider imports

- [ ] **Step 1: Update `app/build/[id]/[[...path]]/page.tsx`**

Change:
```ts
import { BuilderProvider } from "@/hooks/useBuilder";
```
To:
```ts
import { BuilderProvider } from "@/components/builder/BuilderProvider";
```

- [ ] **Step 2: Update `app/build/replay/[id]/replay-builder.tsx`**

Change:
```ts
import { BuilderProvider, type ReplayInit } from "@/hooks/useBuilder";
```
To:
```ts
import { BuilderProvider } from "@/components/builder/BuilderProvider";
import type { ReplayInit } from "@/lib/session/types";
```

### Substep 2b: Migrate `useBuilderHasData` imports

These three components import `useBuilderHasData` from the old module. Switch to importing `useDocHasData` directly, and rename the call site variable for consistency.

- [ ] **Step 3: Update `components/builder/BuilderSubheader.tsx`**

Change:
```ts
import { useBuilderHasData } from "@/hooks/useBuilder";
```
To:
```ts
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
```

And rename the call site from `useBuilderHasData()` to `useDocHasData()`.

- [ ] **Step 4: Update `components/builder/BuilderContentArea.tsx`**

Same pattern — change the import and rename the call site from `useBuilderHasData()` to `useDocHasData()`.

- [ ] **Step 5: Update `components/preview/screens/HomeScreen.tsx`**

Same pattern — change the import and rename the call site from `useBuilderHasData()` to `useDocHasData()`.

### Substep 2c: Migrate preview screens from index-based to uuid-based entity hooks

These screens use the legacy `useModule(mIdx)` and `useForm(mIdx, fIdx)` wrappers from `hooks/useBuilder`. The screens already have entity UUIDs from `useLocation()` — switch to the doc store's uuid-based hooks.

**Type mapping:** `ModuleEntity` and `NModule` have identical field shapes (both camelCase, same fields). The only difference is `uuid: Uuid` (branded) vs `uuid: string`. Call sites access `.name`, `.caseType`, `.caseListColumns`, `.purpose` — all identical. The swap is type-safe without any field-access changes.

- [ ] **Step 6: Update `components/preview/screens/FormScreen.tsx`**

Remove the import of `useForm` and `useModule` from `@/hooks/useBuilder`. Add imports of the uuid-based hooks from the doc store:

```ts
import { useForm as useFormEntity, useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
```

Replace the index-based calls:
```ts
// Old:
const mod = useModule(moduleIndex);
const form = useForm(moduleIndex, formIndex);

// New:
const mod = useModuleEntity(moduleUuid as Uuid);
const form = useFormEntity(formUuid as Uuid);
```

The `moduleUuid` and `formUuid` are already derived from `useLocation()` on lines 59–60. The `as Uuid` cast is needed because the ternary produces `Uuid | undefined` — the hook safely returns `undefined` for undefined input. Also remove the `NForm` and `NModule` type imports if present (they aren't used explicitly in the component).

**Note:** Keep `moduleIndex` and `formIndex` variables — they're still passed to `useFormEngine(moduleIndex, formIndex, caseData)` and `EditContextProvider`. Those downstream consumers haven't been migrated off indices yet; that's a separate future task.

- [ ] **Step 7: Update `components/preview/screens/ModuleScreen.tsx`**

Remove the import of `useModule` from `@/hooks/useBuilder`. Add:

```ts
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
```

Replace:
```ts
// Old:
const mod = useModule(moduleIndex);

// New:
const mod = useModuleEntity(moduleUuid as Uuid);
```

The `moduleUuid` is already derived from `useLocation()` on line 42.

- [ ] **Step 8: Update `components/preview/screens/CaseListScreen.tsx`**

Remove the import of `useModule` from `@/hooks/useBuilder`. Add:

```ts
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
```

Replace:
```ts
// Old:
const mod = useModule(moduleIndex);

// New:
const mod = useModuleEntity(moduleUuid as Uuid);
```

The `moduleUuid` is already derived from `useLocation()` on line 30.

### Substep 2d: Migrate session store type imports in chat components

Three chat components import `BuilderSessionStoreApi` directly from `@/lib/session/store`. Switch to the provider re-export.

- [ ] **Step 9: Update `components/chat/ChatContainer.tsx`**

Change:
```ts
import type { BuilderSessionStoreApi } from "@/lib/session/store";
```
To:
```ts
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
```

- [ ] **Step 10: Update `components/chat/ChatSidebar.tsx`**

Same change — import from `@/lib/session/provider`.

- [ ] **Step 11: Update `components/chat/SignalGrid.tsx`**

Same change — import from `@/lib/session/provider`.

### Substep 2e: Move and update the provider test file

- [ ] **Step 12: Move the test file**

Move `hooks/__tests__/useBuilder.test.tsx` to `components/builder/__tests__/BuilderProvider.test.tsx`. Update its import:

```ts
// Old:
import { BuilderProvider } from "@/hooks/useBuilder";

// New:
import { BuilderProvider } from "@/components/builder/BuilderProvider";
```

Update the file's header comment to reflect the new location and remove references to `hooks/useBuilder.tsx`.

- [ ] **Step 13: Verify type-checking passes**

Run: `cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-6-cleanup && npx tsc --noEmit 2>&1 | head -30 && echo "✓"`

Expected: Clean — all imports resolve correctly now.

- [ ] **Step 14: Run tests**

Run: `cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-6-cleanup && npm test 2>&1 | tail -10`

Expected: 61 test files, 1107 tests passing (same as baseline). The moved test file runs from its new location.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "refactor(builder): migrate all imports to new module locations

Switch every consumer of hooks/useBuilder to the new canonical imports:
- BuilderProvider → components/builder/BuilderProvider
- useBuilderHasData → useDocHasData from lib/doc/hooks/useDocHasData
- useModule(mIdx)/useForm(mIdx,fIdx) → uuid-based hooks from lib/doc/hooks/useEntity
- BuilderSessionStoreApi → re-exported from lib/session/provider
- ReplayInit → lib/session/types

Move provider test to components/builder/__tests__/BuilderProvider.test.tsx."
```

---

## Task 3: Delete legacy files

Remove the two legacy files that no longer have any consumers. After Task 2, nothing imports from either file.

**Files:**
- Delete: `hooks/useBuilder.tsx`
- Delete: `lib/services/builderStore.ts`

- [ ] **Step 1: Delete `hooks/useBuilder.tsx`**

```bash
rm hooks/useBuilder.tsx
```

- [ ] **Step 2: Delete `lib/services/builderStore.ts`**

```bash
rm lib/services/builderStore.ts
```

- [ ] **Step 3: Verify type-checking passes**

Run: `cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-6-cleanup && npx tsc --noEmit 2>&1 | head -20 && echo "✓"`

Expected: Clean — no file imports either deleted module.

- [ ] **Step 4: Run tests**

Run: `cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-6-cleanup && npm test 2>&1 | tail -10`

Expected: 61 test files, 1107 tests passing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(builder): delete legacy builderStore and useBuilder

builderStore.ts was a near-empty Zustand shell (46 lines) serving only as
a per-build identity sentinel. useBuilder.tsx was a 434-line bridge module
with dead wrapper hooks. All consumers migrated in the previous commit.

Completes the 'what goes away' list from the design spec:
- BuilderEngine class (~1000 lines) — deleted in Phase 3
- builderSelectors.ts — deleted in Phase 3
- builderStore.ts — deleted now
- useBuilder.tsx — deleted now"
```

---

## Task 4: Add Biome `noRestrictedImports` lint rule

Enforce the store-boundary rules documented in `lib/doc/CLAUDE.md` and `lib/session/CLAUDE.md` at the lint level. Components and app code must use the named hooks, not the raw store modules.

**Files:**
- Modify: `biome.json`

- [ ] **Step 1: Add the lint rule to `biome.json`**

Add `linter` and `overrides` sections to the existing config. The `overrides` scope the restriction to `components/` and `app/` directories — internal package files (lib modules, tests) are allowed to import the store directly.

```json
{
	"css": {
		"parser": {
			"tailwindDirectives": true
		}
	},
	"files": {
		"includes": ["**", "!!.*", "!!**/dist"],
		"ignoreUnknown": true
	},
	"overrides": [
		{
			"includes": ["components/**", "app/**"],
			"linter": {
				"rules": {
					"style": {
						"noRestrictedImports": {
							"level": "error",
							"options": {
								"paths": {
									"@/lib/doc/store": "Import from @/lib/doc/hooks/ — the store is a private module.",
									"@/lib/session/store": "Import from @/lib/session/provider or @/lib/session/hooks — the store is a private module.",
									"@/hooks/useBuilder": "Deleted in Phase 6. Use @/components/builder/BuilderProvider for the provider, @/lib/doc/hooks/* for doc state, @/lib/session/hooks for session state.",
									"@/lib/services/builderStore": "Deleted in Phase 6. The legacy builder store no longer exists."
								}
							}
						}
					}
				}
			}
		}
	]
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-6-cleanup && npm run lint 2>&1 | tail -10`

Expected: Clean — all component/app imports use the public hook surfaces.

- [ ] **Step 3: Verify the rule catches violations (smoke test)**

Temporarily add a bad import to any component file:
```ts
import { createBlueprintDocStore } from "@/lib/doc/store";
```

Run lint, confirm it errors with the custom message. Remove the temporary import.

- [ ] **Step 4: Commit**

```bash
git add biome.json
git commit -m "chore(lint): enforce store-boundary rules with noRestrictedImports

Components and app code must use the named hooks from lib/doc/hooks/
and lib/session/hooks — never the raw store modules. Also blocks
resurrection of the deleted builderStore and useBuilder modules.

Scoped via overrides to components/ and app/ only — lib-internal
files and tests that create stores directly are exempt."
```

---

## Task 5: Update CLAUDE.md and final verification

Update documentation to reflect the completed re-architecture. Remove Phase references. Run the full verification suite.

**Files:**
- Modify: `CLAUDE.md` (root)
- Modify: `components/builder/CLAUDE.md` (add BuilderProvider docs)

- [ ] **Step 1: Update root `CLAUDE.md` builder state section**

Replace the existing "Builder state" section (under `### Builder state`) with text that reflects the final architecture. The current text says "See `components/builder/CLAUDE.md`" which is correct. Update to:

```markdown
### Builder state

Three sources of truth — URL (where you are + selection), doc store (blueprint entities with zundo undo/redo), session store (ephemeral UI + generation lifecycle + replay). See `components/builder/CLAUDE.md`.

Navigation is URL-owned and uses the browser History API (not Next's router) to avoid server-side RSC re-renders. All entity UUIDs are globally unique, so a single path segment identifies the entity.

**Undo tracking is paused during hydration and agent writes** — the empty→populated transition must not enter history, and the entire agent write becomes one undoable unit. Do not remove the pause/resume calls.

**Store boundary rules enforced by Biome.** Components and app code import from `lib/doc/hooks/`, `lib/session/hooks`, and `lib/routing/hooks` — never from the raw store modules. The `noRestrictedImports` rule in `biome.json` fails the build on violations. Internal lib code (providers, stream dispatchers, tests) is exempt.

**BuilderProvider** lives at `components/builder/BuilderProvider.tsx` — mounts the full provider stack (doc store → session store → scroll registry → edit guard → form engine) and the lifecycle hydrators (SyncBridge, ReplayHydrator, LoadAppHydrator).
```

- [ ] **Step 2: Add BuilderProvider entry to `components/builder/CLAUDE.md`**

Append to the end of `components/builder/CLAUDE.md`:

```markdown

## BuilderProvider

`BuilderProvider.tsx` mounts the complete provider stack for a builder session. `key={buildId}` forces a full unmount/remount when the build identity changes — no stale cross-store references can leak.

Provider tree (outer → inner): BlueprintDocProvider → BuilderSessionProvider → ScrollRegistryProvider → EditGuardProvider → BuilderFormEngineProvider. Three lifecycle children: SyncBridge (wires doc store into session), ReplayHydrator (dispatches saved emissions for replay mode), LoadAppHydrator (clears loading flag for existing-app loads).
```

- [ ] **Step 3: Clean up any remaining "Phase 6" comments in source files**

Search for any comments referencing "Phase 6" in the codebase and remove them — they're no longer future work, they're done:

```bash
grep -rn "Phase 6" --include="*.ts" --include="*.tsx" lib/ components/ hooks/ app/
```

Remove or update any found comments.

- [ ] **Step 4: Run the full verification suite**

Run all four checks:

```bash
cd /Users/braxtonperry/work/personal/code/commcare-nova/.worktrees/phase-6-cleanup
npm run lint 2>&1 | tail -5
npm run build 2>&1 | tail -10
npx tsc --noEmit 2>&1 && echo "✓ tsc clean"
npm test 2>&1 | tail -10
```

Expected:
- `npm run lint` — clean
- `npm run build` — clean
- `npx tsc --noEmit` — clean (no output)
- `npm test` — 61 test files, 1107 tests passing

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: update CLAUDE.md for completed builder state re-architecture

Document the final three-store architecture, BuilderProvider location,
and Biome-enforced store boundary rules. Remove Phase 6 future-work
comments — the re-architecture is complete."
```

---

## Success criteria (from design spec)

After all tasks, verify these hold:

1. ✅ `BuilderEngine` class no longer exists (deleted in Phase 3).
2. ✅ No field in any store represents "current screen" or "current selection" (Phase 2).
3. ✅ `generationData` and `replayStages` no longer exist (Phase 4).
4. ✅ `select*` and `derive*` function styles no longer exist (Phase 3).
5. ✅ Browser back/forward, Cmd+click deep links, and bookmarking all work (Phase 2).
6. ✅ Frame 5 in a fresh React DevTools profile is ≤10ms (Phase 5).
7. ✅ Total render time in the same trace is ≤30ms (Phase 5).
8. ✅ `npm run lint`, `npm run build`, `npx tsc --noEmit`, and `npm test` are clean (Phase 6 — this phase).
9. ✅ `builderStore.ts`, `builderEngine.ts`, `builderSelectors.ts`, `useBuilder.tsx` all deleted (Phase 6 — this phase).
