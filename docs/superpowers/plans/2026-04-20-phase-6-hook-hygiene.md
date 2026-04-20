# Phase 6: Hook + Selector Hygiene + Lint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the top-level `/hooks/` directory by relocating every remaining hook to its domain owner, lint-enforce subscription discipline (no inline selector functions in components/app), and ban raw-router navigation outside `lib/routing/**` — completing Phase 6 of `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`.

**Architecture:** Every hook in `/hooks/` relocates to one of five domain owners: `lib/doc/hooks/` (doc-store consumers), `lib/session/hooks/` (session consumers), `lib/ui/hooks/` (cross-cutting UI), `lib/auth/hooks/` (auth), or `lib/preview/hooks/` (preview-engine wrapper). The three `lib/preview/hooks/` shims the spec marked for deletion (`useFormEngine`, `useEditContext`, `useTextEditSave`) are UUID-ified and either deleted or reduced to a thin engine wrapper — the positional-identity channel (`moduleIndex`, `formIndex`) disappears from the preview/form subtree. The raw store hooks (`useBlueprintDoc`, `useBlueprintDocShallow`, `useBlueprintDocEq`, `useBlueprintDocTemporal`, `useBuilderSession`, `useBuilderSessionShallow`) become lib-private — every component/app call site switches to a named domain hook. A new `useExternalNavigate` wraps Next.js `router.push/replace/refresh` so `useRouter` can be banned outside `lib/routing/**`. Biome `noRestrictedImports` enforces all three boundaries.

**Tech Stack:** TypeScript 5.x strict, React 19, Zustand, Next.js 16 App Router, Biome 2.4, Vitest.

**Worktree:** `.claude/worktrees/phase-6-hook-hygiene` on branch `refactor/phase-6-hook-hygiene`. Worktree already created off `main` at `ae2ee67`; `npm install` complete.

**Baseline (`main` @ `ae2ee67`):**
- `npm test -- --run` — 88 test files, 1405 tests passing.
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (632 files).

Re-verify this baseline in the final verification task.

**Phase status context.** The spec's §10 table lists `useSaveField`, `useTextEditSave`, `useFormEngine`, and `useEditContext` as Phase 6 deletions. This plan handles all four: `useSaveField` is dead code (deleted in Task 4); the three preview shims are relocated to `lib/preview/hooks/` in Task 4 to unblock the `/hooks/` removal, then UUID-ified and deleted (or, for `useFormEngine`, collapsed to a thin engine wrapper) in Task 12. The `/hooks/` top-level directory goes away at the end of Task 4.

---

## North star (read before every task)

1. **One hook per read. No inline selectors in components.** Every entity read from a component reaches the store through a named, typed hook. `useBlueprintDoc((s) => s.foo)` at a call site under `components/` or `app/` is a lint error after this plan lands.
2. **Raw store hooks are lib-private.** `useBlueprintDoc` / `useBlueprintDocShallow` / `useBlueprintDocEq` / `useBlueprintDocTemporal` / `useBuilderSession` / `useBuilderSessionShallow` may be imported **only** from `lib/**`. `useBlueprintDocApi` / `useBuilderSessionApi` (imperative, no selector) stay allowed everywhere because they don't subscribe.
3. **Raw Next.js router is lib-private.** Components import `useNavigate` (intra-builder, History-API) or `useExternalNavigate` (cross-route, Next.js router) from `@/lib/routing/hooks`. `useRouter` from `next/navigation` is banned outside `lib/routing/**`.
4. **Domain-owned hooks live with their domain.** A hook that reads the doc lives in `lib/doc/hooks/`. A hook that wraps auth session state lives in `lib/auth/hooks/`. Cross-cutting UI utilities (toasts, breakpoints, keyboard shortcuts, inline-commit) live in `lib/ui/hooks/`. Preview-only shims live in `lib/preview/hooks/`.
5. **No top-level `/hooks/` directory after this lands.** The directory is deleted — every hook moves.

## Bridge-smell guardrails

- **No re-export shims for moved hooks.** After a move, no `hooks/useX.ts` file remains that re-exports from the new location. Update every call site.
- **No inline selectors "just this one."** Every `useBlueprintDoc((s) => ...)` under `components/` or `app/` is replaced with a named hook — either an existing one, or a new one added to `lib/doc/hooks/` or `lib/session/hooks`.
- **No lint-suppression comments to paper over a violation.** If a rule complains, the right response is to use the named hook, not `// biome-ignore`.
- **No "Phase 5 will fix it" TODO comments.** Task 4 relocates the preview shims; Task 12 UUID-ifies their consumers and deletes the positional-identity ones. No deferral.
- **No `/hooks/` files left behind.** Verify with `ls hooks/ 2>/dev/null` → no output at end of Task 11.

---

## Scope boundaries

**IN SCOPE:**
- Relocate all 12 hooks under `/hooks/` to their domain owners per the spec's §10 table; delete `/hooks/` at end of Task 4.
- Delete `/hooks/useSaveField.ts` (confirmed dead: grep finds zero consumers).
- Add named hooks to `lib/doc/hooks/` and `lib/session/hooks` to cover every inline-selector call site under `components/` or `app/`.
- Add `useExternalNavigate()` to `lib/routing/hooks.tsx` wrapping Next.js `router.push/replace/refresh`.
- Migrate every `useBlueprintDoc((s) => …)`, `useBlueprintDocShallow((s) => …)`, `useBuilderSession((s) => …)`, `useBuilderSessionShallow((s) => …)` call under `components/` and `app/` to a named hook.
- Migrate every `useRouter()` call under `components/` and `app/` to `useExternalNavigate()`.
- Expand `biome.json` `noRestrictedImports` to enforce all three boundaries (inline-selector hooks, raw-router, deleted hook paths).
- UUID-ify `EngineController.activateForm` + `useFormEngine`; collapse `useEditContext` consumers to `useEditMode()`; inline `useTextEditSave` at its three call sites. Delete `useEditContext` and `useTextEditSave`. (Task 12.)
- Update `CLAUDE.md` root + any affected subdirectory docs to reflect the finished topology.

**OUT OF SCOPE (deferred to later phases):**
- Splitting `lib/routing/hooks.tsx` into a folder — current single-file layout already provides the required named hooks.
- Moving `next/navigation` `usePathname` / `notFound` / `redirect` behind named hooks — Phase 6 only targets the navigating forms (`useRouter`).
- Migrating `PreviewScreen` type to carry `formUuid` instead of `moduleIndex`/`formIndex` — out-of-scope for this phase; preview shell wiring can follow up independently.
- Touching `lib/commcare/`, `lib/agent/`, `lib/log/`, CommCare emission boundaries — none of those own hooks.

---

## File Structure

### Directories created

| Directory | Responsibility |
|---|---|
| `lib/ui/hooks/` | Cross-cutting UI hooks — toasts, breakpoints, keyboard shortcuts, inline commit, menu navigation, TipTap editor wrapper. |
| `lib/auth/hooks/` | Auth-session hooks — wraps Better Auth's `authClient.useSession`. |
| `lib/preview/hooks/` | Preview-only shims (form-engine activation, edit-context positional identity, inline-edit save wrapper). Phase 5 will delete these wholesale when FormRenderer is replaced. |

### Hooks relocated

| Current path | New path |
|---|---|
| `hooks/useAutoSave.ts` | `lib/doc/hooks/useAutoSave.ts` |
| `hooks/useAuth.ts` | `lib/auth/hooks/useAuth.ts` |
| `hooks/useCommitField.ts` | `lib/ui/hooks/useCommitField.ts` |
| `hooks/useToasts.ts` | `lib/ui/hooks/useToasts.ts` |
| `hooks/useKeyboardShortcuts.ts` | `lib/ui/hooks/useKeyboardShortcuts.ts` |
| `hooks/use-is-breakpoint.ts` | `lib/ui/hooks/useIsBreakpoint.ts` (renamed to camelCase) |
| `hooks/use-menu-navigation.ts` | `lib/ui/hooks/useMenuNavigation.ts` (renamed to camelCase) |
| `hooks/use-tiptap-editor.ts` | `lib/ui/hooks/useTiptapEditor.ts` (renamed to camelCase) |
| `hooks/useFormEngine.ts` | `lib/preview/hooks/useFormEngine.ts` |
| `hooks/useEditContext.tsx` | `lib/preview/hooks/useEditContext.tsx` |
| `hooks/useTextEditSave.ts` | `lib/preview/hooks/useTextEditSave.ts` |

### Hooks deleted (dead code)

| Path | Reason |
|---|---|
| `hooks/useSaveField.ts` | Zero consumers — confirmed by `rg "from ['\"]@/hooks/useSaveField"` returning no matches. |

### New named hooks added

**`lib/doc/hooks/`** (added to cover inline-selector call sites in components/app):

- `useAppName.ts` — `useAppName(): string` — wraps `s.appName`.
- `useConnectType.ts` — `useConnectType(): ConnectType | null` and `useConnectTypeOrUndefined(): ConnectType | undefined` — wraps `s.connectType`, covering both existing call-site shapes.
- `useFieldKind.ts` — `useFieldKind(uuid: Uuid | undefined): FieldKind | undefined` and `useChildFieldCount(parentUuid: Uuid | undefined): number` — used by AppTree `FieldRow` / `FormCard` / `ModuleCard` so the tree can display per-row kind/counts without subscribing to the full field entity.
- `useDocEntityMaps.ts` — `useDocEntityMaps(): { modules, forms, fields }` — narrow shallow-select wrapper used by `LocationRecoveryEffect` for its recovery walk. Returns reference-stable maps via `useShallow`.
- `useFirstFormForModule.ts` — `useFirstFormForModule(moduleUuid: Uuid | undefined): Form | undefined` — used by `CaseListScreen`'s "first form" lookup.
- `useHasFieldsInForm.ts` — `useHasFieldsInForm(formUuid: Uuid | undefined): boolean` — used by `FormScreen` to branch on emptiness.
- `useAppStructure.ts` — `useAppStructure(): { moduleOrder: readonly Uuid[]; formOrder: Readonly<Record<Uuid, readonly Uuid[]>> }` — used by `BuilderLayout` for its structural derivations and `PreviewShell` for the outer traversal. Returns both maps with shallow equality.

**`lib/session/hooks.tsx`** (additive):

- `useSessionEventsEmpty(): boolean` — replaces `useBuilderSession((s) => s.events.length === 0)` in `ChatSidebar`.
- `useReplayState(): BuilderSessionState["replay"]` — replaces `useBuilderSession((s) => s.replay)` in `ReplayController`.

**`lib/routing/hooks.tsx`** (additive):

- `useExternalNavigate(): ExternalNavigateActions` with `{ push, replace, refresh }` wrapping Next.js `router.push/replace/refresh`. Internally uses `useRouter()` — the **only** remaining permitted call site.

### Files modified

- `biome.json` — expand `noRestrictedImports`.
- `lib/routing/hooks.tsx` — add `useExternalNavigate`.
- `lib/session/hooks.tsx` — add `useSessionEventsEmpty`, `useReplayState`.
- Every file currently importing from `@/hooks/*` — retargeted to the new location (~47 component files plus `app/landing.tsx`).
- Every file under `components/` or `app/` with inline selectors — migrated to named hooks.
- `components/chat/{ChatContainer,ChatSidebar}.tsx`, `components/builder/ReplayController.tsx`, `app/admin/user-table.tsx`, `components/ui/AppCardList.tsx` — `useRouter` call sites retargeted to `useExternalNavigate`.
- `CLAUDE.md` (root) — refresh the "Builder state" + hooks sections.
- `lib/doc/CLAUDE.md` — note the expanded named-hook surface (optional — only if existing text refers to a now-moved file).

### Files deleted

- `hooks/useSaveField.ts` (dead code)
- `hooks/` directory itself (empty after all moves)

---

## Task 1: Create `lib/ui/hooks/` with the first batch of moves (pure UI)

Move the eight cross-cutting UI hooks into `lib/ui/hooks/`. Each move is mechanical: new file with identical contents (module-private state, no external deps on `/hooks/`), then update every importer. Two hooks get camelCase renames (`use-is-breakpoint.ts` → `useIsBreakpoint.ts` etc.) to match the rest of the codebase.

**Files:**
- Create: `lib/ui/hooks/useToasts.ts`
- Create: `lib/ui/hooks/useCommitField.ts`
- Create: `lib/ui/hooks/useKeyboardShortcuts.ts`
- Create: `lib/ui/hooks/useIsBreakpoint.ts`
- Create: `lib/ui/hooks/useMenuNavigation.ts`
- Create: `lib/ui/hooks/useTiptapEditor.ts`
- Modify: every consumer listed in the migration table below.

- [ ] **Step 1: Create `lib/ui/hooks/useToasts.ts`**

Content is byte-for-byte copy of `hooks/useToasts.ts`, which imports from `@/lib/services/toastStore` (unchanged).

```ts
import { useSyncExternalStore } from "react";
import { toastStore } from "@/lib/services/toastStore";

export function useToasts() {
	useSyncExternalStore(
		toastStore.subscribe,
		toastStore.getSnapshot,
		toastStore.getSnapshot,
	);
	return toastStore;
}
```

- [ ] **Step 2: Create `lib/ui/hooks/useCommitField.ts`**

Byte-for-byte copy of `hooks/useCommitField.ts`. Confirm no imports reach into `@/hooks/*` — this hook is self-contained (uses React only).

- [ ] **Step 3: Create `lib/ui/hooks/useKeyboardShortcuts.ts`**

Byte-for-byte copy of `hooks/useKeyboardShortcuts.ts` (imports `@/lib/services/keyboardManager` — unchanged).

- [ ] **Step 4: Create `lib/ui/hooks/useIsBreakpoint.ts`**

Copy of `hooks/use-is-breakpoint.ts`. No import changes.

- [ ] **Step 5: Create `lib/ui/hooks/useMenuNavigation.ts`**

Copy of `hooks/use-menu-navigation.ts`. No import changes.

- [ ] **Step 6: Create `lib/ui/hooks/useTiptapEditor.ts`**

Copy of `hooks/use-tiptap-editor.ts`. No import changes.

- [ ] **Step 7: Retarget every consumer**

Run this find+replace across the tree — one grep per module being moved, then update each hit. Expected edits (use the exact `from "@/hooks/..."` specifier each consumer currently has):

| Hook | Consumers to edit |
|---|---|
| `useToasts` | `components/ui/ToastContainer.tsx` |
| `useCommitField` | `components/builder/EditableText.tsx`; `components/builder/editor/FieldHeader.tsx`; `components/builder/detail/formSettings/InlineField.tsx` |
| `useKeyboardShortcuts` | `components/builder/BuilderLayout.tsx` |
| `useIsBreakpoint` | `components/tiptap-ui/link-popover/link-popover.tsx`; `components/tiptap-ui/image-popover/image-popover.tsx` |
| `useMenuNavigation` | `components/tiptap-ui-primitive/toolbar/toolbar.tsx` |
| `useTiptapEditor` | Every file under `components/tiptap-ui/` that currently imports from `@/hooks/use-tiptap-editor` (~18 files — see grep list below) |

Grep for each module and update every hit:

```
rg -l "from ['\"]@/hooks/useToasts['\"]" | xargs sed -i '' "s|@/hooks/useToasts|@/lib/ui/hooks/useToasts|g"
rg -l "from ['\"]@/hooks/useCommitField['\"]" | xargs sed -i '' "s|@/hooks/useCommitField|@/lib/ui/hooks/useCommitField|g"
rg -l "from ['\"]@/hooks/useKeyboardShortcuts['\"]" | xargs sed -i '' "s|@/hooks/useKeyboardShortcuts|@/lib/ui/hooks/useKeyboardShortcuts|g"
rg -l "from ['\"]@/hooks/use-is-breakpoint['\"]" | xargs sed -i '' "s|@/hooks/use-is-breakpoint|@/lib/ui/hooks/useIsBreakpoint|g"
rg -l "from ['\"]@/hooks/use-menu-navigation['\"]" | xargs sed -i '' "s|@/hooks/use-menu-navigation|@/lib/ui/hooks/useMenuNavigation|g"
rg -l "from ['\"]@/hooks/use-tiptap-editor['\"]" | xargs sed -i '' "s|@/hooks/use-tiptap-editor|@/lib/ui/hooks/useTiptapEditor|g"
```

After each command verify with `rg "from ['\"]@/hooks/<module>"` returning zero matches.

- [ ] **Step 8: Delete the six now-orphaned files**

```
rm hooks/useToasts.ts hooks/useCommitField.ts hooks/useKeyboardShortcuts.ts \
   hooks/use-is-breakpoint.ts hooks/use-menu-navigation.ts hooks/use-tiptap-editor.ts
```

- [ ] **Step 9: Verify**

```
npx tsc --noEmit && echo "✓ tsc"
npm run lint 2>&1 | tail -5
npm test -- --run 2>&1 | tail -5
```

Expected: `✓ tsc`, lint clean, 88 test files / 1405 tests.

- [ ] **Step 10: Commit**

```
git add lib/ui/hooks/ hooks/ components/
git commit -m "refactor(hooks): move UI hooks to lib/ui/hooks

Relocate useToasts, useCommitField, useKeyboardShortcuts, useIsBreakpoint,
useMenuNavigation, useTiptapEditor out of the top-level /hooks/ into their
domain owner lib/ui/hooks. Camel-case the three dash-cased filenames.
Consumers updated; no behavior change."
```

---

## Task 2: Create `lib/auth/hooks/useAuth.ts` and migrate

Auth gets its own domain dir — `useAuth` is the only hook in it now, and any future auth hooks land here.

**Files:**
- Create: `lib/auth/hooks/useAuth.ts`
- Modify: `app/landing.tsx`; `components/ui/AccountMenu.tsx`
- Delete: `hooks/useAuth.ts`

- [ ] **Step 1: Create `lib/auth/hooks/useAuth.ts`**

Byte-for-byte copy of `hooks/useAuth.ts` (imports `@/lib/auth-client` — path unchanged).

- [ ] **Step 2: Retarget consumers**

```
rg -l "from ['\"]@/hooks/useAuth['\"]" | xargs sed -i '' "s|@/hooks/useAuth|@/lib/auth/hooks/useAuth|g"
```

Verify: `rg "from ['\"]@/hooks/useAuth"` returns nothing.

- [ ] **Step 3: Delete the old file**

```
rm hooks/useAuth.ts
```

- [ ] **Step 4: Verify**

```
npx tsc --noEmit && echo "✓ tsc"
npm run lint 2>&1 | tail -3
npm test -- --run 2>&1 | tail -5
```

Expected all clean.

- [ ] **Step 5: Commit**

```
git add lib/auth/hooks/ hooks/ app/ components/
git commit -m "refactor(hooks): move useAuth to lib/auth/hooks

Relocate useAuth to its domain owner. No behavior change."
```

---

## Task 3: Move `useAutoSave` to `lib/doc/hooks/`

`useAutoSave` subscribes to the doc store and writes to Firestore; it is unambiguously doc-owned.

**Files:**
- Create: `lib/doc/hooks/useAutoSave.ts`
- Modify: `components/builder/SaveIndicator.tsx`
- Delete: `hooks/useAutoSave.ts`

- [ ] **Step 1: Create `lib/doc/hooks/useAutoSave.ts`**

Byte-for-byte copy of `hooks/useAutoSave.ts`. Inspect its imports — if any reach into `@/hooks/*` they must be rewritten to their new location BEFORE this move lands (they shouldn't — it's a doc-store consumer).

- [ ] **Step 2: Retarget consumers**

```
rg -l "from ['\"]@/hooks/useAutoSave['\"]" | xargs sed -i '' "s|@/hooks/useAutoSave|@/lib/doc/hooks/useAutoSave|g"
```

- [ ] **Step 3: Delete the old file**

```
rm hooks/useAutoSave.ts
```

- [ ] **Step 4: Verify**

```
npx tsc --noEmit && echo "✓ tsc"
npm run lint 2>&1 | tail -3
npm test -- --run 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```
git add lib/doc/hooks/useAutoSave.ts hooks/ components/
git commit -m "refactor(hooks): move useAutoSave to lib/doc/hooks

useAutoSave subscribes to the doc store and mirrors it to Firestore —
the doc module owns it. Update consumer import."
```

---

## Task 4: Create `lib/preview/hooks/` and move the three preview shims

`useFormEngine`, `useEditContext`, `useTextEditSave` are preview-only. Phase 5 (declarative editor + FormRenderer split) will delete them, but Phase 6 doesn't need to wait — it just needs them out of `/hooks/`. Move into `lib/preview/hooks/`. The inter-hook import in `useTextEditSave.ts` (`import { useEditContext } from "./useEditContext"`) stays a relative import since both files live side by side in the new directory.

**Files:**
- Create: `lib/preview/hooks/useFormEngine.ts`
- Create: `lib/preview/hooks/useEditContext.tsx`
- Create: `lib/preview/hooks/useTextEditSave.ts`
- Modify: all consumers listed below
- Delete: `hooks/useFormEngine.ts`, `hooks/useEditContext.tsx`, `hooks/useTextEditSave.ts`

- [ ] **Step 1: Create the three new files**

Byte-for-byte copies of the three originals. In `useTextEditSave.ts` the `import { useEditContext } from "./useEditContext"` relative import works unchanged because both files are colocated.

- [ ] **Step 2: Retarget consumers**

```
rg -l "from ['\"]@/hooks/useFormEngine['\"]" | xargs sed -i '' "s|@/hooks/useFormEngine|@/lib/preview/hooks/useFormEngine|g"
rg -l "from ['\"]@/hooks/useEditContext['\"]" | xargs sed -i '' "s|@/hooks/useEditContext|@/lib/preview/hooks/useEditContext|g"
rg -l "from ['\"]@/hooks/useTextEditSave['\"]" | xargs sed -i '' "s|@/hooks/useTextEditSave|@/lib/preview/hooks/useTextEditSave|g"
```

Known consumers to spot-check afterward: `components/preview/screens/FormScreen.tsx`, every file under `components/preview/form/**`.

- [ ] **Step 3: Delete the old files**

```
rm hooks/useFormEngine.ts hooks/useEditContext.tsx hooks/useTextEditSave.ts
```

- [ ] **Step 4: Delete `hooks/useSaveField.ts` (dead code)**

Confirm zero consumers:

```
rg "from ['\"]@/hooks/useSaveField['\"]"
```

Expected: no output. Then delete:

```
rm hooks/useSaveField.ts
```

- [ ] **Step 5: Verify `/hooks/` is empty**

```
ls hooks/ 2>/dev/null
```

Expected: nothing prints (empty directory) OR only the `__tests__` subdir if any tests remain. Confirm no `*.ts`/`*.tsx` files in `hooks/` root.

- [ ] **Step 6: Delete the now-empty `/hooks/` directory**

```
rmdir hooks
```

If `rmdir` errors because of remaining hidden files, investigate — the move is incomplete.

- [ ] **Step 7: Verify**

```
npx tsc --noEmit && echo "✓ tsc"
npm run lint 2>&1 | tail -5
npm test -- --run 2>&1 | tail -5
```

- [ ] **Step 8: Commit**

```
git add lib/preview/hooks/ hooks/ components/ app/
git commit -m "refactor(hooks): move preview shims; delete /hooks/ directory

Relocate useFormEngine, useEditContext, useTextEditSave to
lib/preview/hooks — their natural domain owner until Phase 5 deletes
them when FormRenderer is replaced. Delete the dead useSaveField.ts
(zero consumers). Remove the now-empty top-level /hooks/ directory.

Completes the 'Top-level /hooks/ directory deleted' success criterion
from the builder-foundation-design spec."
```

---

## Task 5: Add named doc-hooks that cover every inline-selector call site

Before migrating call sites, enumerate every inline selector in `components/` and `app/` and add the named hooks that will replace them. This task only adds hooks — no call-site migration yet.

**Files:**
- Create: `lib/doc/hooks/useAppName.ts`
- Create: `lib/doc/hooks/useConnectType.ts`
- Create: `lib/doc/hooks/useFieldKind.ts`
- Create: `lib/doc/hooks/useDocEntityMaps.ts`
- Create: `lib/doc/hooks/useFirstFormForModule.ts`
- Create: `lib/doc/hooks/useHasFieldsInForm.ts`
- Create: `lib/doc/hooks/useAppStructure.ts`
- Create: `lib/doc/hooks/__tests__/useFieldKind.test.tsx` (see step 8)
- Create: `lib/doc/hooks/__tests__/useAppStructure.test.tsx` (see step 8)

- [ ] **Step 1: Write a failing test for `useAppName`**

Tests live alongside existing doc-hook tests in `lib/doc/hooks/__tests__/`. Create `lib/doc/hooks/__tests__/useAppName.test.tsx` (look at `lib/doc/hooks/__tests__/useEntity.test.tsx` for the harness pattern — it wraps `renderHook` with a `BlueprintDocProvider`).

```tsx
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { TestDocProvider } from "./testUtils"; // Or replicate inline if testUtils doesn't exist

describe("useAppName", () => {
	it("returns s.appName from the store", () => {
		const { result } = renderHook(() => useAppName(), {
			wrapper: ({ children }) => (
				<TestDocProvider overrides={{ appName: "Example App" }}>
					{children}
				</TestDocProvider>
			),
		});
		expect(result.current).toBe("Example App");
	});
});
```

If `testUtils.tsx` doesn't exist under `lib/doc/hooks/__tests__/`, replicate the minimal wrapper inline — `<BlueprintDocProvider initialBlueprint={...}>`. Check `lib/doc/hooks/__tests__/useEntity.test.tsx` for the exact shape; follow it.

Run: `npm test -- --run lib/doc/hooks/__tests__/useAppName`

Expected: FAIL — `useAppName` doesn't exist.

- [ ] **Step 2: Implement `lib/doc/hooks/useAppName.ts`**

```ts
/**
 * Named hook — subscribe to the app's display name. Re-renders only when
 * `appName` changes reference (which, via Immer, means a `setAppName`
 * mutation ran). Replaces inline `useBlueprintDoc((s) => s.appName)`
 * call sites in components/app.
 */
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useAppName(): string {
	return useBlueprintDoc((s) => s.appName);
}
```

Re-run the test — it should pass.

- [ ] **Step 3: Write + implement `useConnectType`**

`BlueprintDoc.connectType` is `ConnectType | null` in the store. Two call shapes exist at sites:
- `useBlueprintDoc((s) => s.connectType)` — returns raw value (may be null).
- `useBlueprintDoc((s) => s.connectType ?? undefined)` — callers that want `undefined`.

Ship one hook with both shapes as separate exports. Test first: add `lib/doc/hooks/__tests__/useConnectType.test.tsx` covering both a null and a non-null store state for each export. Then implement:

```ts
import type { ConnectType } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** Raw connect-type reading — may be null if the app has no connect config. */
export function useConnectType(): ConnectType | null {
	return useBlueprintDoc((s) => s.connectType);
}

/** Same, but collapses null → undefined for callers whose downstream
 *  API takes `ConnectType | undefined` (e.g. connect-sub-config selectors). */
export function useConnectTypeOrUndefined(): ConnectType | undefined {
	return useBlueprintDoc((s) => s.connectType ?? undefined);
}
```

- [ ] **Step 4: Write + implement `useFieldKind` and `useChildFieldCount`**

Used by the app tree to display kind and child counts without subscribing to full entities. Two hooks in the same file because they both read the fields/field-order slices and the AppTree needs both side-by-side:

```ts
import type { Uuid } from "@/lib/doc/types";
import type { FieldKind } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** Field kind for a uuid. `undefined` if the uuid doesn't resolve. */
export function useFieldKind(uuid: Uuid | undefined): FieldKind | undefined {
	return useBlueprintDoc((s) => (uuid ? s.fields[uuid]?.kind : undefined));
}

/** Count of immediate children under a form or container. 0 when the
 *  order entry is missing (no children / uuid not a container). */
export function useChildFieldCount(parentUuid: Uuid | undefined): number {
	return useBlueprintDoc((s) =>
		parentUuid ? (s.fieldOrder[parentUuid]?.length ?? 0) : 0,
	);
}
```

TDD order: two tests (one per function), run, then implement.

- [ ] **Step 5: Write + implement `useDocEntityMaps`**

Used by `LocationRecoveryEffect` which walks the modules/forms/fields maps to detect stale URLs. Must return reference-stable slice via `useShallow` — otherwise the recovery effect retriggers on unrelated mutations.

```ts
import type { Uuid } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export interface DocEntityMaps {
	modules: Readonly<Record<Uuid, Module>>;
	forms: Readonly<Record<Uuid, Form>>;
	fields: Readonly<Record<Uuid, Field>>;
}

/** Shallow-stable view of the three entity maps. Use when you genuinely
 *  need all three together — normal call sites should prefer `useModule`,
 *  `useForm`, `useField` for single-entity reads. */
export function useDocEntityMaps(): DocEntityMaps {
	return useBlueprintDocShallow((s) => ({
		modules: s.modules,
		forms: s.forms,
		fields: s.fields,
	}));
}
```

- [ ] **Step 6: Write + implement `useFirstFormForModule` and `useHasFieldsInForm`**

Both are narrow reads driven by preview screens. Test first.

```ts
// lib/doc/hooks/useFirstFormForModule.ts
import type { Uuid } from "@/lib/doc/types";
import type { Form } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** First form (by order) of a module, or undefined when module/order is empty. */
export function useFirstFormForModule(
	moduleUuid: Uuid | undefined,
): Form | undefined {
	return useBlueprintDoc((s) => {
		if (!moduleUuid) return undefined;
		const firstUuid = s.formOrder[moduleUuid]?.[0];
		return firstUuid ? s.forms[firstUuid] : undefined;
	});
}
```

```ts
// lib/doc/hooks/useHasFieldsInForm.ts
import type { Uuid } from "@/lib/doc/types";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** `true` when the form has any child fields in its order array. */
export function useHasFieldsInForm(formUuid: Uuid | undefined): boolean {
	return useBlueprintDoc((s) =>
		formUuid ? (s.fieldOrder[formUuid]?.length ?? 0) > 0 : false,
	);
}
```

- [ ] **Step 7: Write + implement `useAppStructure`**

Used by `BuilderLayout` and `PreviewShell` which both derive from the module+form ordering pair. Returns shallow-stable pair.

```ts
// lib/doc/hooks/useAppStructure.ts
import type { Uuid } from "@/lib/doc/types";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export interface AppStructure {
	moduleOrder: readonly Uuid[];
	formOrder: Readonly<Record<Uuid, readonly Uuid[]>>;
}

/** Shallow-stable view of the module+form ordering pair. Callers that
 *  need both together (e.g. outer layout renderers) pay one subscription
 *  instead of two. */
export function useAppStructure(): AppStructure {
	return useBlueprintDocShallow((s) => ({
		moduleOrder: s.moduleOrder,
		formOrder: s.formOrder,
	}));
}
```

- [ ] **Step 7b: Write + implement `useFieldsAndOrder`**

Used by `CloseConditionSection` — a component that genuinely needs the paired `fields` + `fieldOrder` maps for a deep recursive lookup via `findFieldById`. Shallow-stable.

```ts
// lib/doc/hooks/useFieldsAndOrder.ts
import type { Uuid } from "@/lib/doc/types";
import type { Field } from "@/lib/domain";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export interface FieldsAndOrder {
	fields: Readonly<Record<Uuid, Field>>;
	fieldOrder: Readonly<Record<Uuid, readonly Uuid[]>>;
}

/** Paired field-map + field-order read. Use when a component genuinely
 *  needs both together — e.g. recursive lookup by id across the tree.
 *  For single-field reads prefer `useField(uuid)`. */
export function useFieldsAndOrder(): FieldsAndOrder {
	return useBlueprintDocShallow((s) => ({
		fields: s.fields,
		fieldOrder: s.fieldOrder,
	}));
}
```

Test then implement (same pattern as the other additions).

- [ ] **Step 8: Run all new hook tests**

```
npm test -- --run lib/doc/hooks/__tests__/
```

Expected: all new tests pass, existing tests still pass.

- [ ] **Step 9: Verify + commit**

```
npx tsc --noEmit && echo "✓ tsc"
npm run lint 2>&1 | tail -3
```

Commit:

```
git add lib/doc/hooks/
git commit -m "feat(doc): add named hooks covering component inline-selector sites

Pre-work for Phase 6 selector hygiene: seven new named hooks
(useAppName, useConnectType, useFieldKind, useChildFieldCount,
useDocEntityMaps, useFirstFormForModule, useHasFieldsInForm,
useAppStructure) cover every inline useBlueprintDoc((s) => ...) call
site currently in components/app. Call-site migration in the next commit."
```

---

## Task 6: Add named session-hooks + `useExternalNavigate`

Cover the remaining inline-selector sites in chat + ReplayController, and provide `useExternalNavigate` to replace direct `useRouter` usage.

**Files:**
- Modify: `lib/session/hooks.tsx` — add `useSessionEventsEmpty`, `useReplayState`
- Modify: `lib/routing/hooks.tsx` — add `useExternalNavigate`
- Create: test file `lib/session/__tests__/hooks-new.test.tsx` if no suitable existing file
- Create: test file `lib/routing/__tests__/hooks-useExternalNavigate.test.tsx`

- [ ] **Step 1: Write failing test for `useSessionEventsEmpty`**

Look at `lib/session/__tests__/` for the existing test harness (e.g. `derivePhase.test.ts`). If a `renderHook`-based harness exists, extend it; otherwise create `lib/session/__tests__/hooks-useSessionEventsEmpty.test.tsx` with a `<BuilderSessionProvider>` wrapper and two cases (empty events → true, non-empty → false).

- [ ] **Step 2: Implement `useSessionEventsEmpty`**

Add to `lib/session/hooks.tsx` in the lifecycle section, near `useAgentStage`:

```ts
/** `true` when the active run's events buffer is empty — i.e. no run is
 *  in progress (the buffer is cleared at both `beginRun` and `endRun`).
 *  Preferred over `useBuilderSession((s) => s.events.length === 0)` at
 *  call sites. */
export function useSessionEventsEmpty(): boolean {
	return useBuilderSession((s) => s.events.length === 0);
}
```

Re-run tests — pass.

- [ ] **Step 3: Write failing test for `useReplayState`**

Tests a session with and without a `replay` init; asserts reference-stable return.

- [ ] **Step 4: Implement `useReplayState`**

Add to `lib/session/hooks.tsx` next to `useInReplayMode`:

```ts
import type { ReplayState } from "./store";

/** Full replay state (events, chapters, cursor, exitPath) or undefined when
 *  no replay is loaded. Reference-stable — the session store only replaces
 *  this slot on load / scrub / exit, so subscribers don't thrash. Used by
 *  `ReplayController`, which needs the whole thing for cumulative scrubs. */
export function useReplayState(): ReplayState | undefined {
	return useBuilderSession((s) => s.replay);
}
```

(Import the actual `ReplayState` type name from `lib/session/store.ts` or `lib/session/types.ts` — verify before writing.)

- [ ] **Step 5: Write failing test for `useExternalNavigate`**

Next.js routing is easier to mock at the module boundary. In `lib/routing/__tests__/hooks-useExternalNavigate.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useExternalNavigate } from "@/lib/routing/hooks";

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace, refresh }),
}));

describe("useExternalNavigate", () => {
	it("delegates push/replace/refresh to next/navigation", () => {
		const { result } = renderHook(() => useExternalNavigate());
		result.current.push("/hello");
		result.current.replace("/bye");
		result.current.refresh();
		expect(push).toHaveBeenCalledWith("/hello");
		expect(replace).toHaveBeenCalledWith("/bye");
		expect(refresh).toHaveBeenCalled();
	});
});
```

Run — FAIL (hook missing).

- [ ] **Step 6: Implement `useExternalNavigate`**

Add to `lib/routing/hooks.tsx`. Keep next/navigation's `useRouter` import localized — this is the one allowed consumer:

```tsx
import { useRouter } from "next/navigation";

/**
 * Stable action bag for navigations that leave the current URL's builder
 * context and trigger a Next.js route change (RSC re-render). Use for:
 *
 *  - exiting replay mode to a non-builder path,
 *  - opening a build from `/` or a card list,
 *  - admin page transitions.
 *
 * Intra-builder selection + screen changes use `useNavigate` / `useSelect`
 * instead — those use the History API to avoid server re-renders.
 */
export interface ExternalNavigateActions {
	push: (path: string) => void;
	replace: (path: string) => void;
	refresh: () => void;
}

export function useExternalNavigate(): ExternalNavigateActions {
	const router = useRouter();
	return {
		push: (path: string) => router.push(path),
		replace: (path: string) => router.replace(path),
		refresh: () => router.refresh(),
	};
}
```

Note: `router.push/replace` on App Router returns void (no promise needed). No `useMemo` — the returned object is fine to recompute per render; Next.js `router` is already stable within a session.

- [ ] **Step 7: Verify**

```
npm test -- --run lib/session/__tests__/ lib/routing/__tests__/
npx tsc --noEmit && echo "✓ tsc"
```

- [ ] **Step 8: Commit**

```
git add lib/session/hooks.tsx lib/routing/hooks.tsx lib/session/__tests__/ lib/routing/__tests__/
git commit -m "feat(routing,session): add useExternalNavigate + named session hooks

Add useSessionEventsEmpty and useReplayState to lib/session/hooks to
cover inline-selector call sites in chat + ReplayController. Add
useExternalNavigate to lib/routing/hooks wrapping Next.js router
push/replace/refresh — the only permitted consumer of next/navigation's
useRouter going forward."
```

---

## Task 7: Migrate inline-selector call sites under `components/` and `app/`

Every `useBlueprintDoc((s) => …)` / `useBlueprintDocShallow((s) => …)` / `useBuilderSession((s) => …)` / `useBuilderSessionShallow((s) => …)` call in `components/` or `app/` gets replaced with a named hook. The hooks for every case exist after Tasks 5–6.

This is mechanical but wide — touches ~16 files. Do the edits in one pass per file, verifying `tsc` clean after each batch. Group by file so one commit per logical area, or a single commit covering the whole migration — reviewer preference, but keep the commit atomic per successful `tsc` + `npm test` cycle.

**Files to edit** (with the exact mapping for each hit — `components/` first, then `app/`):

| File | Inline selector → named hook |
|---|---|
| `components/builder/appTree/FieldRow.tsx:61` | `useBlueprintDoc((s) => s.fields[uuid]) as Field \| undefined` → `useField(uuid)` (remove `as Field \| undefined` cast — the hook is already typed) |
| `components/builder/appTree/FieldRow.tsx:64` | `useBlueprintDoc((s) => s.fieldOrder[uuid])` → `useOrderedFields(uuid)` |
| `components/builder/appTree/FormCard.tsx:67` | `useBlueprintDoc((s) => s.fieldOrder[formId])` → `useOrderedFields(formId)` |
| `components/builder/appTree/FormCard.tsx:71` | `useBlueprintDoc((s) => ...count...)` → `useChildFieldCount(formId)` |
| `components/builder/LocationRecoveryEffect.tsx:45-47` | three separate `useBlueprintDoc((s) => s.modules/forms/fields)` → one `const { modules, forms, fields } = useDocEntityMaps();` |
| `components/builder/UploadToHqDialog.tsx:69` | `useBlueprintDoc((s) => s.appName)` → `useAppName()` |
| `components/builder/detail/formSettings/ConnectSection.tsx:40` | `useBlueprintDoc((s) => s.connectType ?? undefined)` → `useConnectTypeOrUndefined()` |
| `components/builder/appTree/AppTree.tsx:38` | `useBlueprintDoc((s) => s.appName)` → `useAppName()` |
| `components/preview/PreviewShell.tsx:104-105` | two `useBlueprintDoc` for moduleOrder + formOrder → one `const { moduleOrder, formOrder } = useAppStructure();` |
| `components/builder/appTree/ModuleCard.tsx:49` | `useBlueprintDoc((s) => s.modules[moduleUuid]) as …` → `useModule(moduleUuid)` (remove cast) |
| `components/builder/appTree/ModuleCard.tsx:54` | `useBlueprintDoc((s) => s.formOrder[moduleUuid])` → `useFormIds(moduleUuid)` |
| `components/builder/appTree/ModuleCard.tsx:56` | `useBlueprintDoc((s) => s.connectType)` → `useConnectType()` |
| `components/preview/screens/HomeScreen.tsx:16-17` | `useBlueprintDoc((s) => s.appName)` → `useAppName()`; `useBlueprintDoc((s) => s.formOrder)` → use `useAppStructure()` if paired with moduleOrder reading; otherwise `useBlueprintDoc((s) => s.formOrder)` was the only read, use `useAppStructure().formOrder`. Inspect the file first. |
| `components/preview/screens/FormScreen.tsx:82` | `useBlueprintDoc((s) => s.fieldOrder[formUuid]?.length > 0)` → `useHasFieldsInForm(formUuid)` |
| `components/builder/BuilderSubheader.tsx:73` | `useBlueprintDoc((s) => s.appName)` → `useAppName()` |
| `components/preview/screens/CaseListScreen.tsx:31` | `useBlueprintDoc((s) => s.formOrder[moduleUuid]?.[0])` → use `useFirstFormForModule(moduleUuid)?.uuid` (the hook returns the `Form` — if the call site only wants the uuid, read `.uuid`). Inspect + adapt. |
| `components/preview/screens/CaseListScreen.tsx:38` | `useBlueprintDoc((s) => s.forms[firstFormUuid]?.name)` → `useFirstFormForModule(moduleUuid)?.name` — the two reads collapse into one hook call |
| `components/builder/detail/formSettings/FormSettingsButton.tsx:39` | `useBlueprintDoc((s) => s.connectType)` → `useConnectType()` |
| `components/builder/BuilderLayout.tsx:323-324` | `useBlueprintDoc((s) => s.moduleOrder)` + `useBlueprintDoc((s) => s.formOrder)` → one `const { moduleOrder: docModuleOrder, formOrder: docFormOrder } = useAppStructure();` |
| `components/builder/detail/AppConnectSettings.tsx:12-13` | `useBlueprintDoc((s) => s.connectType ?? undefined)` → `useConnectTypeOrUndefined()`; `useBlueprintDoc((s) => s.moduleOrder.length)` → add a small hook `useModuleCount()` or call `useModuleIds().length`. Prefer `useModuleIds().length` — it's a reference-stable subscription already. |
| `components/builder/appTree/useSearchFilter.ts:98` | `useBlueprintDocShallow((s) => ({ fields, fieldOrder, modules, forms }))` → if the shape is broader than `useDocEntityMaps` provides (includes `fieldOrder`), keep this as internal doc-layer code — **or** move the file into `lib/doc/hooks/` since it IS a doc-subscription hook. Inspect. Most likely resolution: move `useSearchFilter.ts` into `lib/doc/hooks/` (it belongs with search-blueprint), making the inline selector legal again. |
| `components/builder/appTree/useFieldIconMap.ts:34` | Same call: `useBlueprintDocShallow` with fields+fieldOrder. Same resolution: this is a doc-derivation hook — move it into `lib/doc/hooks/useFieldIconMap.ts`. |
| `components/builder/detail/formSettings/CloseConditionSection.tsx:54` | `useBlueprintDocShallow((s) => ({ fields, fieldOrder }))` — this IS a genuine shallow read at a component level. Replace with a new tiny hook added to `lib/doc/hooks/useFieldsAndOrder.ts`: `useFieldsAndOrder(): { fields, fieldOrder }` — or just use `useDocEntityMaps()` + `useBlueprintDoc((s) => s.fieldOrder)`. Prefer adding `useFieldsAndOrder` for the specific pair (field map + field order) since the call site genuinely needs both. Add the hook in Task 5 if missed; otherwise add it here and run its own test. |
| `components/chat/ChatContainer.tsx:172` | `useBuilderSession((s) => s.replay !== undefined)` → `useInReplayMode()` (already exists — verify and swap) |
| `components/chat/ChatSidebar.tsx:269` | `useBuilderSession((s) => s.events.length === 0)` → `useSessionEventsEmpty()` |
| `components/builder/ReplayController.tsx:54` | `useBuilderSession((s) => s.replay)` → `useReplayState()` |

For each file:

- [ ] **Step 1: Read the file, locate the inline selectors**

Use `Grep` or open in the editor to confirm the exact line content.

- [ ] **Step 2: Add the named-hook import, remove/adjust old imports**

If the file imported `useBlueprintDoc` or `useBlueprintDocShallow` purely for inline selector use, delete that import. If it still uses `useBlueprintDocApi`, keep that import. Add the appropriate named-hook import(s) from `@/lib/doc/hooks/*`.

- [ ] **Step 3: Replace the call(s)**

Edit the call-site lines to use the named hook. Remove redundant casts that the named hook already returns typed.

- [ ] **Step 4: Repeat for every file in the table above**

Group batches — e.g., do all of `components/builder/appTree/*` as one batch, then chat, then preview.

- [ ] **Step 5: If `useSearchFilter.ts` or `useFieldIconMap.ts` move to `lib/doc/hooks/`**

Follow the same pattern as Task 1–4 moves: new file, update imports at consumers, delete old file, verify.

- [ ] **Step 6: Verify**

```
npx tsc --noEmit && echo "✓ tsc"
npm run lint 2>&1 | tail -5
npm test -- --run 2>&1 | tail -5
```

Also verify zero inline-selector violations remain:

```
rg "useBlueprintDoc\(\(s" components/ app/
rg "useBlueprintDocShallow\(\(s" components/ app/
rg "useBuilderSession\(\(s" components/ app/ -g '!**/__tests__/**'
rg "useBuilderSessionShallow\(\(s" components/ app/ -g '!**/__tests__/**'
```

Expected: all four return zero matches (tests are exempt — see the `-g` on the session ones since a couple of tests legitimately pass inline selectors through the store harness).

- [ ] **Step 7: Commit**

```
git add components/ app/ lib/doc/hooks/
git commit -m "refactor(components): replace inline selectors with named hooks

Every useBlueprintDoc/useBlueprintDocShallow/useBuilderSession inline
selector under components/ and app/ migrated to a named hook from
lib/doc/hooks or lib/session/hooks. Preparation for the lint ban in
the next commit.

No behavior change — each named hook is a 1:1 wrapper over its prior
inline selector, with shallow selectors unchanged where they were."
```

---

## Task 8: Migrate `useRouter` call sites to `useExternalNavigate`

Three components and one page import `useRouter` directly from `next/navigation`. Migrate to `useExternalNavigate`.

**Files:**
- Modify: `components/builder/ReplayController.tsx` — swap `useRouter` for `useExternalNavigate`, replace `router.push(exitPath)` with `navigate.push(exitPath)`
- Modify: `components/ui/AppCardList.tsx` — same
- Modify: `app/admin/user-table.tsx` — same (check for `router.refresh()` calls; `useExternalNavigate` supports it)

- [ ] **Step 1: Update `components/builder/ReplayController.tsx`**

Replace:

```ts
import { useRouter } from "next/navigation";
// …
const router = useRouter();
// …
router.push(exitPath);
```

with:

```ts
import { useExternalNavigate } from "@/lib/routing/hooks";
// …
const navigate = useExternalNavigate();
// …
navigate.push(exitPath);
```

Remove the `useRouter` import. Update the `useCallback` deps array (`router` → `navigate`).

- [ ] **Step 2: Update `components/ui/AppCardList.tsx`**

Same swap. Inspect for `router.refresh()` or `router.push` calls — `useExternalNavigate` supports both.

- [ ] **Step 3: Update `app/admin/user-table.tsx`**

Same swap. Admin routes aren't under the builder so the swap is purely about centralizing the router wrapper.

- [ ] **Step 4: Verify zero `useRouter` usage outside `lib/routing/**`**

```
rg "from ['\"]next/navigation['\"]" components/ app/ | grep useRouter
```

Expected: no matches. (Other `next/navigation` imports — `notFound`, `redirect`, `usePathname` — stay allowed.)

- [ ] **Step 5: Verify**

```
npx tsc --noEmit && echo "✓ tsc"
npm run lint 2>&1 | tail -3
npm test -- --run 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```
git add components/ app/
git commit -m "refactor(routing): use useExternalNavigate in place of useRouter

Three call sites (ReplayController, AppCardList, admin user-table)
swapped from direct useRouter to the new useExternalNavigate wrapper
in lib/routing/hooks. Raw Next.js router access is now lib-private —
components always route through the named hook."
```

---

## Task 9: Expand `biome.json` `noRestrictedImports` to enforce all three boundaries

Add per-import-name restrictions banning:
- `useBlueprintDoc`, `useBlueprintDocShallow`, `useBlueprintDocEq`, `useBlueprintDocTemporal` from `@/lib/doc/hooks/useBlueprintDoc` — allow only `useBlueprintDocApi`.
- `useBuilderSession`, `useBuilderSessionShallow` from `@/lib/session/provider` — allow `useBuilderSessionApi`.
- `useRouter` from `next/navigation`.
- The deleted paths (`@/hooks/*`).

The existing `@/lib/doc/store` and `@/lib/session/store` bans stay.

**Files:**
- Modify: `biome.json`

- [ ] **Step 1: Update `biome.json`**

Replace the existing `overrides` block with:

```json
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
								"@/lib/doc/hooks/useBlueprintDoc": {
									"message": "Pass-through selector hooks are lib-private. Use a named hook from @/lib/doc/hooks/*; useBlueprintDocApi stays allowed for imperative, non-subscribing access.",
									"importNames": [
										"useBlueprintDoc",
										"useBlueprintDocShallow",
										"useBlueprintDocEq",
										"useBlueprintDocTemporal"
									]
								},
								"@/lib/session/provider": {
									"message": "Pass-through selector hooks are lib-private. Use a named hook from @/lib/session/hooks; useBuilderSessionApi and BuilderSessionStoreApi stay allowed.",
									"importNames": [
										"useBuilderSession",
										"useBuilderSessionShallow"
									]
								},
								"next/navigation": {
									"message": "Use useExternalNavigate from @/lib/routing/hooks for router.push/replace/refresh. notFound, redirect, usePathname stay allowed.",
									"importNames": ["useRouter"]
								},
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
```

- [ ] **Step 2: Verify lint passes**

```
npm run lint 2>&1 | tail -10
```

Expected: clean. If any file still has a banned import, fix it (you missed a call site in Task 7 or 8).

- [ ] **Step 3: Smoke-test the rule**

Temporarily add an illegal import to a component file, e.g. in a copy of `components/ui/ToastContainer.tsx`:

```ts
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
```

Run `npm run lint`; confirm it errors with the custom `message`. Remove the temporary import.

Repeat the smoke test for each of the four new restrictions:
- `useBuilderSession` from `@/lib/session/provider`
- `useRouter` from `next/navigation`

Each should error with its own message. `useBlueprintDocApi` from `@/lib/doc/hooks/useBlueprintDoc` should **not** error — confirm by adding and removing the line.

- [ ] **Step 4: Commit**

```
git add biome.json
git commit -m "chore(lint): ban inline-selector hooks + raw Next.js router

Expand noRestrictedImports in biome.json:
- Block useBlueprintDoc/useBlueprintDocShallow/useBlueprintDocEq/
  useBlueprintDocTemporal outside lib/** (useBlueprintDocApi stays).
- Block useBuilderSession/useBuilderSessionShallow outside lib/**
  (useBuilderSessionApi + BuilderSessionStoreApi stay).
- Block next/navigation's useRouter outside lib/routing/**
  (useExternalNavigate wraps it).
- Keep existing bans on @/lib/doc/store and @/lib/session/store.

Enforces the subscription-discipline + routing rules from the
2026-04-16 builder-foundation-design spec's §10."
```

---

## Task 10: Update `CLAUDE.md` files

Reflect the finished topology in documentation.

**Files:**
- Modify: `CLAUDE.md` (root)
- Modify: `lib/doc/CLAUDE.md` (if it referenced files now moved)
- Optional: add short stub notes in `lib/ui/hooks/`, `lib/auth/hooks/`, `lib/preview/hooks/` if existing sibling `CLAUDE.md` pattern has similar notes

- [ ] **Step 1: Root `CLAUDE.md` updates**

The "Builder state" section already mentions store-boundary rules. Extend it with the three new rules:

Replace the current paragraph beginning "**Store boundary rules enforced by Biome.**" with:

```markdown
**Store boundary rules enforced by Biome.** `noRestrictedImports` enforces three independent boundaries:
- Raw Zustand store modules (`@/lib/doc/store`, `@/lib/session/store`) cannot be imported outside their owning package — use the named hooks in `lib/doc/hooks/`, `lib/session/hooks`, or `lib/routing/hooks.tsx`.
- Raw selector-accepting hooks (`useBlueprintDoc`, `useBlueprintDocShallow`, `useBlueprintDocEq`, `useBlueprintDocTemporal`, `useBuilderSession`, `useBuilderSessionShallow`) are lib-private — components/app code uses named domain hooks. The imperative `*Api` hooks (`useBlueprintDocApi`, `useBuilderSessionApi`) stay allowed everywhere because they don't subscribe.
- Next.js `useRouter` is banned outside `lib/routing/**` — `useNavigate` handles intra-builder navigation via the History API, `useExternalNavigate` wraps router.push/replace/refresh for cross-route moves.

All hooks colocate with their domain: `lib/doc/hooks/`, `lib/session/hooks`, `lib/routing/hooks.tsx`, `lib/ui/hooks/`, `lib/auth/hooks/`, `lib/preview/hooks/`. The top-level `/hooks/` directory is gone.
```

- [ ] **Step 2: Check `lib/doc/CLAUDE.md`**

If it mentions files now moved or hooks now added, update accordingly. Likely no change needed.

- [ ] **Step 3: Sweep for lingering `"@/hooks/"` references in docs**

```
rg "@/hooks/" docs/ --hidden
```

Plan docs in `docs/superpowers/plans/` are historical — leave them alone. But if any active CLAUDE.md or README references `@/hooks/*`, update them.

- [ ] **Step 4: Sweep for `"Phase 6"` TODO-style comments in source**

```
rg "Phase 6" --type=ts --type=tsx components/ app/ lib/
```

Update or delete comments that referenced Phase 6 as a future milestone — it is now complete.

- [ ] **Step 5: Commit**

```
git add CLAUDE.md lib/
git commit -m "docs: update CLAUDE.md for hook + selector hygiene completion

Document the three Biome boundary rules (raw stores, raw selector
hooks, raw Next.js router) and the final hook-directory topology
(lib/doc/hooks, lib/session/hooks, lib/routing/hooks.tsx, lib/ui/hooks,
lib/auth/hooks, lib/preview/hooks). Remove Phase 6 future-work notes."
```

---

## Task 11: Final verification

End-of-plan sanity. Every check that the spec's success criteria demand for Phase 6.

- [ ] **Step 1: `/hooks/` is gone**

```
ls hooks/ 2>/dev/null
```

Expected: nothing prints.

- [ ] **Step 2: Zero inline selectors under `components/` and `app/`**

```
rg "useBlueprintDoc\(\(s" components/ app/
rg "useBlueprintDocShallow\(\(s" components/ app/
rg "useBuilderSession\(\(s" components/ app/ -g '!**/__tests__/**'
rg "useBuilderSessionShallow\(\(s" components/ app/ -g '!**/__tests__/**'
```

Expected: all four return zero.

- [ ] **Step 3: Zero raw `useRouter` outside `lib/routing/**`**

```
rg "useRouter" components/ app/ | grep "from.*next/navigation"
```

Expected: zero matches.

- [ ] **Step 4: Full verification suite**

```
npm run lint 2>&1 | tail -5
npx tsc --noEmit && echo "✓ tsc clean"
npm test -- --run 2>&1 | tail -15
npm run build 2>&1 | tail -10
```

Expected:
- Lint: `Checked N files in M. No fixes applied.` where `N` is similar to baseline (632 pre-plan) but may differ due to file relocations.
- `tsc`: `✓ tsc clean`.
- Tests: all passing — the baseline was 88 test files, 1405 tests; new hooks add a handful of test files; no test count decrease is expected.
- Build: clean.

- [ ] **Step 5: Smoke-test the three new Biome rules**

One last time, confirm each restriction triggers when violated:

| Attempted import | Expected error |
|---|---|
| `useBlueprintDoc` from `@/lib/doc/hooks/useBlueprintDoc` in a component | fails with "Pass-through selector hooks are lib-private…" |
| `useBuilderSession` from `@/lib/session/provider` in a component | fails with "Pass-through selector hooks are lib-private…" |
| `useRouter` from `next/navigation` in a component | fails with "Use useExternalNavigate…" |
| `useBlueprintDocApi` from the same path | **allowed** |

Add each temporarily, run lint, confirm error (or non-error for the last), remove the temporary line.

- [ ] **Step 6: Final commit (if any doc polish lands in step 4/5)**

Otherwise skip.

---

## Task 12: Delete the three index-based compat shims (UUID-ify preview/form)

The spec's §10 table marks `useFormEngine`, `useEditContext`, `useTextEditSave` for deletion in Phase 6 ("index-based compat shim"). Tasks 1–11 moved them out of `/hooks/` but left their bodies + positional-identity consumers untouched. Task 12 finishes the job by UUID-ifying the engine + the 11 consumer files, then deleting the two that no longer serve a purpose.

**Scope estimate:** ~15 files, net ≈ −200 lines (investigation confirmed the consumers only read `.mode` from `useEditContext`, never indices).

**Files:**
- Modify: `lib/preview/engine/engineController.ts` — replace `activeModuleIndex` + `activeFormIndex` with single `activeFormUuid: Uuid | undefined`; change `activateForm(moduleIndex, formIndex, caseData)` to `activateForm(formUuid: Uuid, caseData?)`; add a `findModuleForForm(state, formUuid)` reverse-lookup helper for the internal sites that need the owning module; clear `activeFormUuid` + `activeCaseData` in `deactivate()`.
- Modify: `lib/preview/hooks/useFormEngine.ts` — signature `(formUuid: Uuid | undefined, caseData?)`; body is a `useEffect` activating the controller with `[controller, formUuid, caseData]` deps. Drop the internal `useBlueprintDoc` call — caller provides the UUID.
- Modify: `components/preview/screens/FormScreen.tsx` — pass `formUuid` (from `useLocation()`) to `useFormEngine`; remove the `EditContextProvider` wrapper and its ternary (only the `formBody` branch remains).
- Modify (useEditContext → useEditMode): `components/preview/form/FormRenderer.tsx`, `EditableFieldWrapper.tsx`, `InsertionPoint.tsx`, `fields/LabelField.tsx`, `fields/MediaField.tsx`. Each swaps `const ctx = useEditContext(); ctx?.mode === …` for `const mode = useEditMode(); mode === …` — confirmed by pre-task inspection that no consumer reads `.moduleIndex`/`.formIndex`.
- Modify (useTextEditSave inline): `components/preview/form/virtual/rows/FieldRow.tsx`, `rows/GroupBracket.tsx`, `fields/LabelField.tsx`. Each replaces `const saveField = useTextEditSave(uuid)` with a local `useMemo<(fn) | null>` gating on `useEditMode() === "edit"` and calling `updateField(uuid, patch)`.
- Modify tests: `lib/preview/engine/__tests__/engineController.test.ts` — replace the "out-of-range index" cases with "unknown form uuid" + "orphaned form" (form exists but no module lists it) to exercise the new UUID path. `lib/preview/engine/__tests__/provider.test.tsx` — update `activateForm` call + fixture comment to the UUID API.
- Delete: `lib/preview/hooks/useEditContext.tsx`, `lib/preview/hooks/useTextEditSave.ts`.

`lib/preview/hooks/useFormEngine.ts` STAYS — it's no longer a compat shim once it takes a UUID; it's a legitimate thin wrapper over the controller's activation API.

### Step-by-step

- [ ] **Step 1: Rewrite `EngineController.activateForm` to take a UUID**

Internal re-derivation sites (currently three: `setupMetadataSubscription`, `currentEngineInput`, `onMetadataChanged`) all read `s.moduleOrder[activeModuleIndex]` + `s.formOrder[moduleUuid][activeFormIndex]`. After the rewrite each uses `this.activeFormUuid` directly; the owning module (needed for case-type lookup in a couple of spots) comes from `findModuleForForm(state, formUuid)` — O(modules × forms-per-module) walk, called at activation time + metadata subscription callback, not in render hot paths.

`buildEngineInput` drops its unused `moduleUuid` parameter.

- [ ] **Step 2: Simplify `useFormEngine`**

```tsx
export function useFormEngine(
    formUuid: Uuid | undefined,
    caseData?: Map<string, string>,
): EngineController {
    const controller = useBuilderFormEngine();
    useEffect(() => {
        if (!formUuid) return;
        controller.activateForm(formUuid, caseData);
        return () => controller.deactivate();
    }, [controller, formUuid, caseData]);
    return controller;
}
```

- [ ] **Step 3: Migrate `FormScreen.tsx`**

Drop the `screen.moduleIndex`/`screen.formIndex` locals. Call `useFormEngine(formUuid, caseData)` where `formUuid` is already derived from `useLocation()`. Remove the `editable ? <EditContextProvider …>{formBody}</EditContextProvider> : formBody` ternary — `BuilderContentArea` already gates the whole preview tree on `isReady && hasData`, so the inner gate is redundant.

- [ ] **Step 4: Migrate `useEditContext` consumers (5 files)**

In `FormRenderer`, `EditableFieldWrapper`, `InsertionPoint`, `LabelField`, `MediaField`:
- Remove the `useEditContext` import, add `useEditMode` from `@/lib/session/hooks`.
- Replace `const ctx = useEditContext(); … ctx?.mode === "test"` / `!ctx` with `const mode = useEditMode(); … mode === "test"`. The `!ctx` null branches are dead after the swap (`useEditMode()` always returns a value) — drop them.

- [ ] **Step 5: Inline `useTextEditSave` at its three consumers**

Pattern (same shape in all 3 sites):

```tsx
const saveField = useMemo<((field: string, value: string) => void) | null>(() => {
    if (mode !== "edit" || !uuid) return null;
    return (field, value) => {
        const patch = { [field]: value === "" ? undefined : value } as FieldPatch;
        updateField(asUuid(uuid), patch);
    };
}, [mode, uuid, updateField]);
```

If the consumer already has `mode` or `updateField` in scope from other hook calls, reuse those — don't duplicate.

- [ ] **Step 6: Update EngineController tests**

Replace the two "out-of-range index" tests with:
- "unknown form uuid" — pass a UUID not present in `s.forms`; controller deactivates cleanly; runtime store empty.
- "orphaned form" — form exists in `s.forms` but no module's `formOrder` contains it; same graceful behavior.

Assert on observable state, not private fields.

- [ ] **Step 7: Delete the two shim files**

```
rm lib/preview/hooks/useEditContext.tsx lib/preview/hooks/useTextEditSave.ts
```

`lib/preview/hooks/useFormEngine.ts` stays.

- [ ] **Step 8: Verify**

```
rg "useEditContext\b" components/ app/ lib/
rg "useTextEditSave\b" components/ app/ lib/
npx tsc --noEmit && echo "✓ tsc"
npm run lint 2>&1 | tail -5
npm test -- --run 2>&1 | tail -10
npm run build 2>&1 | tail -10
```

All three greps return zero. tsc / lint / tests / build clean. Test count stays at 1449.

- [ ] **Step 9: Commit**

```
refactor(preview): delete index-based compat shims

- Change EngineController.activateForm + useFormEngine to accept a
  formUuid instead of (moduleIndex, formIndex). Store activeFormUuid
  on the controller and drop the index fields.
- Delete useEditContext + EditContextProvider; collapse every consumer
  to useEditMode() from lib/session/hooks — no consumer ever read the
  context's indices, only its mode field.
- Delete useTextEditSave; inline the updateField + mode-gate at its
  three call sites (FieldRow, GroupBracket, LabelField).

Completes the spec §10 deletion list for Phase 6. The preview/form
subtree now identifies forms by UUID end-to-end.
```

---

## Success criteria (from `2026-04-16-builder-foundation-design.md`)

After Phase 6 lands, these spec-level assertions hold:

1. ✅ Top-level `/hooks/` no longer exists.
2. ✅ `useSaveField.ts` no longer exists (dead code purge — bundled here).
3. ✅ `useEditContext`, `useTextEditSave` deleted. `useFormEngine` retained as a UUID-based thin wrapper (no longer a compat shim).
4. ✅ No inline selector functions exist outside store-owning directories. `rg "useBlueprintDoc\(\(s" components/ app/` returns zero results. Biome fails the build if any appear.
5. ✅ Lint-enforced boundaries for: raw store modules (pre-existing); raw selector hooks (new); raw Next.js `useRouter` (new); deleted `@/hooks/*` paths (pre-existing).
6. ✅ `useNavigate`, `useSelect`, `useExternalNavigate` available from `@/lib/routing/hooks`; `useRouter` no longer imported by any file under `components/` or `app/`.
7. ✅ `EngineController` + `useFormEngine` take `formUuid: Uuid` — positional identity is gone from the preview/form subtree.
8. ✅ `npm run lint`, `npm run build`, `npx tsc --noEmit`, and `npm test` are all clean.
