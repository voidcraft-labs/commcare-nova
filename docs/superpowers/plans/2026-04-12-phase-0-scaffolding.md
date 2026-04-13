# Phase 0 — Builder State Re-architecture: Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the directory skeleton, shared type definitions, and URL-parsing utilities that every subsequent phase of the builder state re-architecture will build on. No runtime behavior changes; the app continues to use the existing store/engine.

**Architecture:** Creates three new top-level library directories — `lib/doc/`, `lib/session/`, `lib/routing/` — each with a typed interface surface defined but no stores, hooks, or providers wired up. The only fully-implemented deliverable is the pure `Location` parser (`parseLocation`/`serializeLocation`/`isValidLocation`) under `lib/routing/`, landing with full test coverage because every later phase reads from it.

**Tech Stack:** TypeScript (strict), Vitest, Biome. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md` — Phase 0 (migration table).

---

## File Structure

New files created in this phase (absolute paths from repo root):

```
lib/doc/
  README.md          # Documents the boundary rule enforced in Phase 6
  types.ts           # Uuid branded type + BlueprintDoc + entity types + Mutation union
  hooks/.gitkeep     # Placeholder; domain hooks land in Phase 1
lib/session/
  README.md          # Same boundary rule for session hooks
  types.ts           # BuilderSession + BuilderPhase + CursorMode
  hooks/.gitkeep     # Placeholder; session hooks land in Phase 3
lib/routing/
  README.md          # Explains URL schema
  types.ts           # Location discriminated union
  location.ts        # parseLocation + serializeLocation + isValidLocation
  __tests__/
    location.test.ts # Covers the three functions above
```

No files are modified in existing code. Nothing imports from the new directories yet. This is by design — Phase 0 is inert from the running app's perspective.

**Type dependencies:**

- `lib/doc/types.ts` re-uses the existing Zod-derived types from `lib/schemas/blueprint.ts` (`BlueprintModule`, `BlueprintForm`, `Question`, `ConnectType`, `CaseType`) rather than redefining them. The new `ModuleEntity`, `FormEntity`, and `QuestionEntity` types are transformations (`Omit`) of those existing types that drop nested arrays, because our normalized store replaces nesting with ordering maps.
- `lib/session/types.ts` imports `Uuid` and `ConnectType` from `lib/doc/types.ts` (session references doc entities; doc never references session).
- `lib/routing/types.ts` imports `Uuid` from `lib/doc/types.ts`.

---

### Task 1: Create empty directory scaffolding

**Files:**
- Create: `lib/doc/hooks/.gitkeep`
- Create: `lib/session/hooks/.gitkeep`
- Create: `lib/routing/__tests__/.gitkeep`

- [ ] **Step 1: Create the directories with `.gitkeep` placeholders so git tracks them**

Run:

```bash
mkdir -p lib/doc/hooks lib/session/hooks lib/routing/__tests__
touch lib/doc/hooks/.gitkeep lib/session/hooks/.gitkeep lib/routing/__tests__/.gitkeep
```

Expected: no output, exit code 0.

- [ ] **Step 2: Verify directories exist**

Run:

```bash
ls lib/doc/hooks lib/session/hooks lib/routing/__tests__
```

Expected: each lists `.gitkeep`.

- [ ] **Step 3: Commit**

```bash
git add lib/doc lib/session lib/routing
git commit -m "chore(builder): scaffold lib/doc lib/session lib/routing directories"
```

---

### Task 2: Define `Uuid` branded type in `lib/doc/types.ts`

**Files:**
- Create: `lib/doc/types.ts`

Why branded: prevents accidental mixing of UUIDs with ordinary strings at compile time. All mutation APIs and hooks introduced in later phases will take `Uuid` parameters, catching bugs that would otherwise slip through (e.g. passing a question ID slug where a UUID is expected). Branding is type-only and has zero runtime cost.

- [ ] **Step 1: Create the file with the `Uuid` type, helper, and exports**

Create `lib/doc/types.ts` with exactly this content:

```ts
/**
 * Builder state re-architecture — domain type definitions.
 *
 * This file is imported by every later phase of the re-architecture:
 *   - Phase 1 uses `BlueprintDoc`, entity types, and the `Mutation` union to
 *     build the normalized Zustand store and its mutation reducer.
 *   - Phase 2 uses `Uuid` as the selection/screen identifier type in the URL.
 *   - Phase 3 uses entity types when dissolving the engine into hooks.
 *   - Phase 4 uses `Mutation` to translate agent events via `toMutations`.
 *   - Phase 5 uses `Uuid` for virtual-list row keys.
 *
 * NOTHING in this file is wired into the running app yet. Phase 0 is inert.
 */

/**
 * Branded UUID type. Prevents accidental mixing with ordinary strings.
 *
 * Branding is a compile-time-only construct — at runtime a Uuid is just a
 * string. Use `asUuid(s)` to cast an existing crypto UUID string into the
 * branded type when entering the doc layer (e.g. when converting a legacy
 * blueprint into the normalized doc shape).
 */
export type Uuid = string & { readonly __brand: "Uuid" };

/** Narrowing cast from `string` to `Uuid`. Prefer this over `as Uuid`. */
export function asUuid(s: string): Uuid {
	return s as Uuid;
}
```

- [ ] **Step 2: Typecheck passes**

Run:

```bash
npx tsc --noEmit
```

Expected: no output (exit 0). If it errors, fix the code in Step 1 before continuing.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/types.ts
git commit -m "feat(builder/doc): add branded Uuid type"
```

---

### Task 3: Add entity types (`ModuleEntity`, `FormEntity`, `QuestionEntity`) to `lib/doc/types.ts`

**Files:**
- Modify: `lib/doc/types.ts`

The existing schema in `lib/schemas/blueprint.ts` has `BlueprintModule`, `BlueprintForm`, and `Question` types. The doc store flattens these: each entity table is a `Record<Uuid, Entity>`, and parent-child relationships are captured by ordering maps instead of nested arrays. The entity types are therefore `Omit<Nested, "children-array-field">` of their blueprint counterparts.

The current `Question` already carries a `uuid: string`. `BlueprintModule` and `BlueprintForm` do NOT carry UUIDs in the on-disk schema — Phase 1 will generate them at doc-load time. That's why `ModuleEntity` and `FormEntity` add a `uuid: Uuid` field, while `QuestionEntity` narrows its existing `uuid: string` to `uuid: Uuid`.

- [ ] **Step 1: Append entity types to `lib/doc/types.ts`**

Add the following to the end of `lib/doc/types.ts`:

```ts
import type {
	BlueprintForm,
	BlueprintModule,
	Question,
} from "@/lib/schemas/blueprint";

/**
 * A module as stored in the normalized doc.
 *
 * Derived from `BlueprintModule` by dropping the `forms` array (forms are
 * looked up via `BlueprintDoc.formOrder[moduleUuid]` → `BlueprintDoc.forms`)
 * and adding a required stable `uuid`. The on-disk `BlueprintModule` schema
 * does not carry a UUID — Phase 1's blueprint→doc converter assigns one at
 * load time and persists it in Firestore going forward.
 */
export type ModuleEntity = Omit<BlueprintModule, "forms"> & { uuid: Uuid };

/**
 * A form as stored in the normalized doc.
 *
 * Same pattern as `ModuleEntity`: drops the nested `questions` array, adds a
 * `uuid`. Questions are looked up via `questionOrder[formUuid]`.
 */
export type FormEntity = Omit<BlueprintForm, "questions"> & { uuid: Uuid };

/**
 * A question as stored in the normalized doc.
 *
 * The blueprint `Question` already carries a `uuid: string`; we narrow that
 * to the branded `Uuid` type. Children are represented by
 * `questionOrder[questionUuid]` (when the question is a group/repeat) rather
 * than an inline `children: Question[]` array.
 */
export type QuestionEntity = Omit<Question, "uuid" | "children"> & {
	uuid: Uuid;
};
```

- [ ] **Step 2: Typecheck passes**

Run:

```bash
npx tsc --noEmit
```

Expected: no output. If `@/lib/schemas/blueprint` symbols are not found, confirm the import path matches the existing codebase convention (the `@/` alias is defined in `tsconfig.json` and `vitest.config.ts`).

- [ ] **Step 3: Commit**

```bash
git add lib/doc/types.ts
git commit -m "feat(builder/doc): add ModuleEntity, FormEntity, QuestionEntity types"
```

---

### Task 4: Add `BlueprintDoc` type to `lib/doc/types.ts`

**Files:**
- Modify: `lib/doc/types.ts`

- [ ] **Step 1: Append the `BlueprintDoc` type**

Add the following to the end of `lib/doc/types.ts`:

```ts
import type { CaseType, ConnectType } from "@/lib/schemas/blueprint";

/**
 * The normalized builder document. Single source of truth for the domain.
 *
 * Shape rationale:
 *   - Entity tables (`modules`, `forms`, `questions`) are keyed by `Uuid` so
 *     hooks can subscribe to a single entity's slot without rendering when
 *     siblings change. Immer's structural sharing keeps unchanged entity
 *     references stable across mutations.
 *   - Ordering maps (`*Order`) are the only place hierarchy is expressed.
 *     Reordering a module doesn't touch the module entity itself — only the
 *     `moduleOrder` array — so entity-level subscribers don't re-render.
 *   - `questionOrder` is keyed by either a form uuid (top-level questions)
 *     or a group/repeat question uuid (nested children). Same map, two
 *     logical uses.
 *
 * Phase 1 builds the Zustand store, loader, and mutation reducer around this
 * shape. `connectType` and `caseTypes` are nullable to mirror the current
 * blueprint schema where surveys/empty apps can omit them.
 */
export type BlueprintDoc = {
	appId: string;
	appName: string;
	connectType: ConnectType | null;
	caseTypes: CaseType[] | null;

	modules: Record<Uuid, ModuleEntity>;
	forms: Record<Uuid, FormEntity>;
	questions: Record<Uuid, QuestionEntity>;

	moduleOrder: Uuid[];
	formOrder: Record<Uuid /* moduleUuid */, Uuid[]>;
	questionOrder: Record<Uuid /* formUuid | groupUuid */, Uuid[]>;
};
```

- [ ] **Step 2: Typecheck passes**

Run:

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/types.ts
git commit -m "feat(builder/doc): add BlueprintDoc normalized type"
```

---

### Task 5: Add `Mutation` discriminated union to `lib/doc/types.ts`

**Files:**
- Modify: `lib/doc/types.ts`

The mutation union is the typed contract between the store's action API and its consumers (user edits in Phases 1–3, agent event translation in Phase 4). Defining it in Phase 0 lets Phase 4 write `toMutations(event, doc): Mutation[]` without forward references.

- [ ] **Step 1: Append the `Mutation` union**

Add the following to the end of `lib/doc/types.ts`:

```ts
/**
 * Every way the document can change, as a discriminated union.
 *
 * Design notes:
 *   - `kind` names follow the mutation-action method names on the store
 *     (e.g. `addQuestion` → `{ kind: "addQuestion", ... }`). Phase 1 defines
 *     the reducer that switches on `kind`.
 *   - Every payload uses `Uuid` for identity — no paths, no indices. Phase 1
 *     will expose thin `qpath → uuid` adapters for callers that haven't been
 *     migrated yet.
 *   - `replaceForm` carries its own questions + questionOrder because
 *     wholesale form replacement (an LLM tool today) needs to atomically
 *     swap the form's entire subtree.
 *   - `duplicateQuestion` takes no payload other than the source uuid; the
 *     reducer generates a new uuid, deep-clones children, and deduplicates
 *     ids as needed.
 *   - App-level mutations (`setAppName`, etc.) are separate entries rather
 *     than a single "update app" patch because each has distinct undo
 *     semantics.
 */
export type Mutation =
	// Module mutations
	| { kind: "addModule"; module: ModuleEntity; index?: number }
	| { kind: "removeModule"; uuid: Uuid }
	| { kind: "moveModule"; uuid: Uuid; toIndex: number }
	| { kind: "renameModule"; uuid: Uuid; newId: string }
	| { kind: "updateModule"; uuid: Uuid; patch: Partial<Omit<ModuleEntity, "uuid">> }
	// Form mutations
	| { kind: "addForm"; moduleUuid: Uuid; form: FormEntity; index?: number }
	| { kind: "removeForm"; uuid: Uuid }
	| { kind: "moveForm"; uuid: Uuid; toModuleUuid: Uuid; toIndex: number }
	| { kind: "renameForm"; uuid: Uuid; newId: string }
	| { kind: "updateForm"; uuid: Uuid; patch: Partial<Omit<FormEntity, "uuid">> }
	| {
			kind: "replaceForm";
			uuid: Uuid;
			form: FormEntity;
			questions: QuestionEntity[];
			questionOrder: Uuid[];
	  }
	// Question mutations
	| { kind: "addQuestion"; parentUuid: Uuid; question: QuestionEntity; index?: number }
	| { kind: "removeQuestion"; uuid: Uuid }
	| { kind: "moveQuestion"; uuid: Uuid; toParentUuid: Uuid; toIndex: number }
	| { kind: "renameQuestion"; uuid: Uuid; newId: string }
	| { kind: "duplicateQuestion"; uuid: Uuid }
	| {
			kind: "updateQuestion";
			uuid: Uuid;
			patch: Partial<Omit<QuestionEntity, "uuid">>;
	  }
	// App-level mutations
	| { kind: "setAppName"; name: string }
	| { kind: "setConnectType"; connectType: ConnectType | null }
	| { kind: "setCaseTypes"; caseTypes: CaseType[] | null };
```

- [ ] **Step 2: Typecheck passes**

Run:

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/doc/types.ts
git commit -m "feat(builder/doc): add Mutation discriminated union"
```

---

### Task 6: Add session types to `lib/session/types.ts`

**Files:**
- Create: `lib/session/types.ts`

- [ ] **Step 1: Create the file**

Create `lib/session/types.ts` with exactly this content:

```ts
/**
 * Builder state re-architecture — ephemeral session type definitions.
 *
 * Everything in this store lives only while the builder route is mounted
 * and is NEVER undoable. Separating from BlueprintDoc means there's no
 * risk of UI state bleeding into undo history and no need for a partialize
 * allow-list — the two stores have disjoint responsibilities.
 *
 * Phase 3 builds the actual store, reducer-shaped actions, and hook API.
 * This file only declares the types those pieces will conform to.
 */

import type { ConnectType } from "@/lib/schemas/blueprint";
import type { Uuid } from "@/lib/doc/types";

/** Lifecycle phases of the builder. */
export type BuilderPhase = "idle" | "loading" | "ready" | "completed";

/** Interaction mode. "edit" = click to select + inline text editing;
 *  "pointer" = live form-fill preview. */
export type CursorMode = "edit" | "pointer";

/**
 * UI-facing representation of a failed agent stream. Phase 4 will map the
 * route handler's internal `GenerationError` enum onto this shape; defining
 * `AgentError` here keeps the session store free of a cross-layer import
 * until Phase 4 lands.
 */
export type AgentError = { code: string; message: string };

/**
 * Visibility + stash state for one sidebar column. `open` is current
 * visibility; `stashed` records whether we should reopen when leaving edit
 * mode. See `switchCursorMode` in Phase 3.
 */
export type SidebarState = { open: boolean; stashed: boolean };

/**
 * The ephemeral builder session.
 *
 * Field layout mirrors the spec exactly: flat agent fields (not nested
 * under an `agent:` object) so that selector hooks can subscribe to
 * `agentActive` without pulling the full agent payload on every render.
 *
 * Keys grouped by concern:
 *   - Lifecycle (`phase`, `agent*`, `postBuildEdit`) for what mode we're in.
 *   - Interaction (`cursorMode`, `activeFieldId`) for how the user is editing.
 *   - Chrome (`sidebars`) for layout.
 *   - Connect stash (`connectStash`, `lastConnectType`) for learn↔deliver
 *     toggle preservation within a session.
 */
export type BuilderSession = {
	phase: BuilderPhase;
	agentActive: boolean;
	agentStage?: string;
	agentError?: AgentError;
	postBuildEdit: boolean;

	cursorMode: CursorMode;
	activeFieldId?: Uuid;

	sidebars: {
		chat: SidebarState;
		structure: SidebarState;
	};

	/**
	 * Saved form-connect configs from the non-active connect mode, keyed by
	 * mode. Ephemeral: lost on reload. Same lifecycle as today's
	 * `BuilderEngine._connectStash` Map. `FormConnect` is currently typed in
	 * `lib/schemas/blueprint.ts` but Phase 3 will import it directly;
	 * `unknown` is a deliberate placeholder here to keep Phase 0 free of
	 * wire-through-session dependencies that none of the Phase 0 code
	 * actually exercises.
	 */
	connectStash: Partial<Record<ConnectType, Record<Uuid, unknown>>>;
	lastConnectType?: ConnectType;
};
```

- [ ] **Step 2: Typecheck passes**

Run:

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/session/types.ts
git commit -m "feat(builder/session): add BuilderSession ephemeral type"
```

---

### Task 7: Add `Location` discriminated union to `lib/routing/types.ts`

**Files:**
- Create: `lib/routing/types.ts`

- [ ] **Step 1: Create the file**

Create `lib/routing/types.ts` with exactly this content:

```ts
/**
 * Builder state re-architecture — URL location types.
 *
 * `Location` is a discriminated union over every valid URL shape the builder
 * can occupy. Phase 0 ships the type and the pure parser/serializer/
 * validator in `lib/routing/location.ts`. Phase 2 builds the `useLocation`,
 * `useNavigate`, and `useSelect` hooks that read/write these via Next.js's
 * `useSearchParams` and `useRouter`.
 *
 * URL schema (query params on the single /build/[id] route):
 *
 *   /build/[id]                                   → home
 *   /build/[id]?s=m&m=<uuid>                      → module
 *   /build/[id]?s=cases&m=<uuid>                  → case list
 *   /build/[id]?s=cases&m=<uuid>&case=<caseId>    → case detail
 *   /build/[id]?s=f&m=<uuid>&f=<uuid>             → form
 *   /build/[id]?s=f&m=<uuid>&f=<uuid>&sel=<uuid>  → form + selected question
 *
 * UUIDs are used instead of indices so URLs are stable across renames and
 * reordering. The schema uses short param keys (`s`, `m`, `f`, `sel`,
 * `case`) to keep URLs short for bookmarking.
 */

import type { Uuid } from "@/lib/doc/types";

/**
 * Every valid builder location. Home is the default when `s` is absent or
 * unrecognized. Cases and Form require their respective UUID params; a
 * missing param on a screen that requires it collapses to home.
 */
export type Location =
	| { kind: "home" }
	| { kind: "module"; moduleUuid: Uuid }
	| { kind: "cases"; moduleUuid: Uuid; caseId?: string }
	| {
			kind: "form";
			moduleUuid: Uuid;
			formUuid: Uuid;
			selectedUuid?: Uuid;
	  };

/**
 * The short query-param keys used in the URL. Kept as a typed constant so
 * the parser, serializer, and any future consumer (tests, docs) agree on
 * spelling.
 */
export const LOCATION_PARAM = {
	screen: "s",
	module: "m",
	form: "f",
	caseId: "case",
	selected: "sel",
} as const;

/** Values of the `s` (screen) param for each non-home screen. */
export const SCREEN_KIND = {
	module: "m",
	cases: "cases",
	form: "f",
} as const;
```

- [ ] **Step 2: Typecheck passes**

Run:

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/routing/types.ts
git commit -m "feat(builder/routing): add Location discriminated union"
```

---

### Task 8: Write failing tests for `serializeLocation`

**Files:**
- Create: `lib/routing/__tests__/location.test.ts`

We TDD the location functions, writing the serializer tests first. Serialization is the simpler direction (one `Location` in, one `URLSearchParams` out — no ambiguity), and the parser tests in Task 10 will reuse fixtures built from serialize results to avoid duplication.

- [ ] **Step 1: Create the test file with failing tests**

Create `lib/routing/__tests__/location.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import { serializeLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
const qUuid = asUuid("33333333-3333-3333-3333-333333333333");

describe("serializeLocation", () => {
	it("emits empty params for home", () => {
		const loc: Location = { kind: "home" };
		const params = serializeLocation(loc);
		expect(params.toString()).toBe("");
	});

	it("emits s=m&m=<uuid> for module screen", () => {
		const loc: Location = { kind: "module", moduleUuid: modUuid };
		const params = serializeLocation(loc);
		expect(params.get("s")).toBe("m");
		expect(params.get("m")).toBe(modUuid);
		expect(Array.from(params.keys())).toEqual(["s", "m"]);
	});

	it("emits s=cases&m=<uuid> for case list", () => {
		const loc: Location = { kind: "cases", moduleUuid: modUuid };
		const params = serializeLocation(loc);
		expect(params.get("s")).toBe("cases");
		expect(params.get("m")).toBe(modUuid);
		expect(params.get("case")).toBeNull();
	});

	it("emits case= when caseId is present", () => {
		const loc: Location = {
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "abc123",
		};
		const params = serializeLocation(loc);
		expect(params.get("case")).toBe("abc123");
	});

	it("emits s=f&m=&f= for form without selection", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
		};
		const params = serializeLocation(loc);
		expect(params.get("s")).toBe("f");
		expect(params.get("m")).toBe(modUuid);
		expect(params.get("f")).toBe(formUuid);
		expect(params.get("sel")).toBeNull();
	});

	it("emits sel= when a question is selected", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		};
		const params = serializeLocation(loc);
		expect(params.get("sel")).toBe(qUuid);
	});
});
```

- [ ] **Step 2: Run tests — expect failure with module-not-found**

Run:

```bash
npx vitest run lib/routing/__tests__/location.test.ts
```

Expected: fails because `@/lib/routing/location` does not exist yet. The error message should mention `Cannot find module` or similar.

---

### Task 9: Implement `serializeLocation` to pass tests

**Files:**
- Create: `lib/routing/location.ts`

- [ ] **Step 1: Create the implementation**

Create `lib/routing/location.ts`:

```ts
/**
 * Builder state re-architecture — URL location parser/serializer/validator.
 *
 * Pure functions only. No React, no browser APIs beyond the standard
 * `URLSearchParams` class (which is available in Node and browsers). Every
 * function is deterministic and free of side effects so it can be unit
 * tested without a DOM or router.
 *
 * Phase 2 wires these into `useLocation`, `useNavigate`, and `useSelect`
 * hooks that subscribe to Next.js's `useSearchParams` and call
 * `router.push`/`router.replace`.
 */

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import {
	LOCATION_PARAM,
	type Location,
	SCREEN_KIND,
} from "@/lib/routing/types";

/**
 * Convert a `Location` into `URLSearchParams`. The returned params are in
 * insertion order; callers that care about a stable serialization should
 * pass the result through `toString()` of a `new URLSearchParams([...pairs])`
 * if they need a specific order.
 *
 * For `home`, we return empty params — the builder route itself (no query
 * string) encodes home.
 */
export function serializeLocation(loc: Location): URLSearchParams {
	const params = new URLSearchParams();
	switch (loc.kind) {
		case "home":
			// No query params. Defaults to home on the client.
			return params;
		case "module":
			params.set(LOCATION_PARAM.screen, SCREEN_KIND.module);
			params.set(LOCATION_PARAM.module, loc.moduleUuid);
			return params;
		case "cases":
			params.set(LOCATION_PARAM.screen, SCREEN_KIND.cases);
			params.set(LOCATION_PARAM.module, loc.moduleUuid);
			if (loc.caseId !== undefined) {
				params.set(LOCATION_PARAM.caseId, loc.caseId);
			}
			return params;
		case "form":
			params.set(LOCATION_PARAM.screen, SCREEN_KIND.form);
			params.set(LOCATION_PARAM.module, loc.moduleUuid);
			params.set(LOCATION_PARAM.form, loc.formUuid);
			if (loc.selectedUuid !== undefined) {
				params.set(LOCATION_PARAM.selected, loc.selectedUuid);
			}
			return params;
	}
}
```

- [ ] **Step 2: Run tests — expect them to pass**

Run:

```bash
npx vitest run lib/routing/__tests__/location.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/routing/location.ts lib/routing/__tests__/location.test.ts
git commit -m "feat(builder/routing): implement serializeLocation with full coverage"
```

---

### Task 10: Write failing tests for `parseLocation`

**Files:**
- Modify: `lib/routing/__tests__/location.test.ts`

- [ ] **Step 1: Append parser test suite**

Add this to the end of `lib/routing/__tests__/location.test.ts`:

```ts
import { parseLocation } from "@/lib/routing/location";

const params = (s: string): URLSearchParams => new URLSearchParams(s);

describe("parseLocation", () => {
	it("returns home for empty params", () => {
		expect(parseLocation(params(""))).toEqual({ kind: "home" });
	});

	it("returns home when s is missing but other params are present", () => {
		// Defensive: if someone strips the screen param by mistake, we fall
		// back to home rather than rendering a broken screen.
		expect(parseLocation(params(`m=${modUuid}`))).toEqual({ kind: "home" });
	});

	it("returns home for an unrecognized s value", () => {
		expect(parseLocation(params("s=bogus"))).toEqual({ kind: "home" });
	});

	it("parses module screen", () => {
		expect(parseLocation(params(`s=m&m=${modUuid}`))).toEqual({
			kind: "module",
			moduleUuid: modUuid,
		});
	});

	it("falls back to home when module screen is missing m=", () => {
		expect(parseLocation(params("s=m"))).toEqual({ kind: "home" });
	});

	it("parses case list", () => {
		expect(parseLocation(params(`s=cases&m=${modUuid}`))).toEqual({
			kind: "cases",
			moduleUuid: modUuid,
		});
	});

	it("parses case detail", () => {
		expect(
			parseLocation(params(`s=cases&m=${modUuid}&case=abc`)),
		).toEqual({
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "abc",
		});
	});

	it("falls back to home when case screen is missing m=", () => {
		expect(parseLocation(params("s=cases"))).toEqual({ kind: "home" });
	});

	it("parses form without selection", () => {
		expect(
			parseLocation(params(`s=f&m=${modUuid}&f=${formUuid}`)),
		).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
		});
	});

	it("parses form with selection", () => {
		expect(
			parseLocation(
				params(`s=f&m=${modUuid}&f=${formUuid}&sel=${qUuid}`),
			),
		).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		});
	});

	it("falls back to home when form screen is missing f=", () => {
		expect(parseLocation(params(`s=f&m=${modUuid}`))).toEqual({
			kind: "home",
		});
	});

	it("round-trips every Location shape through serialize→parse", () => {
		const cases: Location[] = [
			{ kind: "home" },
			{ kind: "module", moduleUuid: modUuid },
			{ kind: "cases", moduleUuid: modUuid },
			{ kind: "cases", moduleUuid: modUuid, caseId: "abc" },
			{ kind: "form", moduleUuid: modUuid, formUuid },
			{
				kind: "form",
				moduleUuid: modUuid,
				formUuid,
				selectedUuid: qUuid,
			},
		];
		for (const loc of cases) {
			expect(parseLocation(serializeLocation(loc))).toEqual(loc);
		}
	});
});
```

- [ ] **Step 2: Run tests — expect failure**

Run:

```bash
npx vitest run lib/routing/__tests__/location.test.ts
```

Expected: the new `parseLocation` tests fail with `parseLocation is not a function` or a similar "not exported" error. The `serializeLocation` tests continue to pass.

---

### Task 11: Implement `parseLocation` to pass tests

**Files:**
- Modify: `lib/routing/location.ts`

- [ ] **Step 1: Append the parser**

Add the following to the end of `lib/routing/location.ts`:

```ts
/**
 * Parse `URLSearchParams` into a `Location`. Always returns a valid Location
 * — malformed or missing required params collapse to `{ kind: "home" }`.
 *
 * This "degrade to home" behavior is intentional: a user landing on a
 * malformed URL (deleted entity, stale bookmark) sees the app's home screen
 * rather than a broken state. Phase 2 adds a separate `isValidLocation`
 * pass against the live doc to additionally strip references to UUIDs that
 * used to exist but no longer do.
 *
 * Accepts either a standard `URLSearchParams` or Next.js's
 * `ReadonlyURLSearchParams` (structurally compatible — same read-only API).
 */
export function parseLocation(
	searchParams: Pick<URLSearchParams, "get">,
): Location {
	const screen = searchParams.get(LOCATION_PARAM.screen);
	const moduleUuidRaw = searchParams.get(LOCATION_PARAM.module);

	switch (screen) {
		case SCREEN_KIND.module: {
			if (!moduleUuidRaw) return { kind: "home" };
			return {
				kind: "module",
				moduleUuid: moduleUuidRaw as Uuid,
			};
		}
		case SCREEN_KIND.cases: {
			if (!moduleUuidRaw) return { kind: "home" };
			const caseId = searchParams.get(LOCATION_PARAM.caseId);
			return caseId === null
				? { kind: "cases", moduleUuid: moduleUuidRaw as Uuid }
				: {
						kind: "cases",
						moduleUuid: moduleUuidRaw as Uuid,
						caseId,
					};
		}
		case SCREEN_KIND.form: {
			const formUuidRaw = searchParams.get(LOCATION_PARAM.form);
			if (!moduleUuidRaw || !formUuidRaw) return { kind: "home" };
			const selectedRaw = searchParams.get(LOCATION_PARAM.selected);
			return selectedRaw === null
				? {
						kind: "form",
						moduleUuid: moduleUuidRaw as Uuid,
						formUuid: formUuidRaw as Uuid,
					}
				: {
						kind: "form",
						moduleUuid: moduleUuidRaw as Uuid,
						formUuid: formUuidRaw as Uuid,
						selectedUuid: selectedRaw as Uuid,
					};
		}
		default:
			return { kind: "home" };
	}
}
```

- [ ] **Step 2: Run tests — expect all to pass**

Run:

```bash
npx vitest run lib/routing/__tests__/location.test.ts
```

Expected: all tests pass, including the round-trip test.

- [ ] **Step 3: Commit**

```bash
git add lib/routing/location.ts lib/routing/__tests__/location.test.ts
git commit -m "feat(builder/routing): implement parseLocation with round-trip coverage"
```

---

### Task 12: Write failing tests for `isValidLocation`

**Files:**
- Modify: `lib/routing/__tests__/location.test.ts`

`isValidLocation` walks the current doc to confirm every UUID in the location refers to a real entity. Phase 2's hooks run it on every location change; invalid locations collapse back to home via `router.replace`.

- [ ] **Step 1: Append validator tests**

Add this to the end of `lib/routing/__tests__/location.test.ts`:

```ts
import { isValidLocation } from "@/lib/routing/location";
import type { BlueprintDoc } from "@/lib/doc/types";

const emptyDoc: BlueprintDoc = {
	appId: "test-app",
	appName: "Test",
	connectType: null,
	caseTypes: null,
	modules: {},
	forms: {},
	questions: {},
	moduleOrder: [],
	formOrder: {},
	questionOrder: {},
};

function docWith(overrides: Partial<BlueprintDoc>): BlueprintDoc {
	return { ...emptyDoc, ...overrides };
}

describe("isValidLocation", () => {
	it("accepts home against any doc", () => {
		expect(isValidLocation({ kind: "home" }, emptyDoc)).toBe(true);
	});

	it("rejects module location when module uuid is unknown", () => {
		expect(
			isValidLocation(
				{ kind: "module", moduleUuid: modUuid },
				emptyDoc,
			),
		).toBe(false);
	});

	it("accepts module location when module uuid exists", () => {
		const doc = docWith({
			modules: {
				[modUuid]: {
					uuid: modUuid,
					name: "Test Module",
				} as never, // Partial module OK for this test
			},
		});
		expect(
			isValidLocation({ kind: "module", moduleUuid: modUuid }, doc),
		).toBe(true);
	});

	it("accepts cases when module exists; ignores caseId content", () => {
		const doc = docWith({
			modules: {
				[modUuid]: { uuid: modUuid, name: "m" } as never,
			},
		});
		expect(
			isValidLocation(
				{ kind: "cases", moduleUuid: modUuid, caseId: "anything" },
				doc,
			),
		).toBe(true);
	});

	it("rejects form when module is missing even if form exists", () => {
		const doc = docWith({
			forms: {
				[formUuid]: { uuid: formUuid } as never,
			},
		});
		expect(
			isValidLocation(
				{ kind: "form", moduleUuid: modUuid, formUuid },
				doc,
			),
		).toBe(false);
	});

	it("rejects form when form is missing even if module exists", () => {
		const doc = docWith({
			modules: {
				[modUuid]: { uuid: modUuid } as never,
			},
		});
		expect(
			isValidLocation(
				{ kind: "form", moduleUuid: modUuid, formUuid },
				doc,
			),
		).toBe(false);
	});

	it("accepts form when both exist", () => {
		const doc = docWith({
			modules: { [modUuid]: { uuid: modUuid } as never },
			forms: { [formUuid]: { uuid: formUuid } as never },
		});
		expect(
			isValidLocation(
				{ kind: "form", moduleUuid: modUuid, formUuid },
				doc,
			),
		).toBe(true);
	});

	it("rejects form when selectedUuid points to a missing question", () => {
		const doc = docWith({
			modules: { [modUuid]: { uuid: modUuid } as never },
			forms: { [formUuid]: { uuid: formUuid } as never },
		});
		expect(
			isValidLocation(
				{
					kind: "form",
					moduleUuid: modUuid,
					formUuid,
					selectedUuid: qUuid,
				},
				doc,
			),
		).toBe(false);
	});

	it("accepts form when selectedUuid points to an existing question", () => {
		const doc = docWith({
			modules: { [modUuid]: { uuid: modUuid } as never },
			forms: { [formUuid]: { uuid: formUuid } as never },
			questions: { [qUuid]: { uuid: qUuid } as never },
		});
		expect(
			isValidLocation(
				{
					kind: "form",
					moduleUuid: modUuid,
					formUuid,
					selectedUuid: qUuid,
				},
				doc,
			),
		).toBe(true);
	});
});
```

- [ ] **Step 2: Run tests — expect failure**

Run:

```bash
npx vitest run lib/routing/__tests__/location.test.ts
```

Expected: `isValidLocation` tests fail with `isValidLocation is not a function`.

---

### Task 13: Implement `isValidLocation` to pass tests

**Files:**
- Modify: `lib/routing/location.ts`

- [ ] **Step 1: Append the validator**

Add the following to the end of `lib/routing/location.ts`:

```ts
/**
 * Check that every UUID referenced by the location exists in the current
 * doc. Returns `true` for `home` regardless of doc state.
 *
 * Phase 2 uses this on every URL change: if the result is `false`, a root
 * effect calls `router.replace()` with the location stripped of dangling
 * references (usually falling back to home). This keeps selection-after-
 * deletion and stale-bookmark scenarios from ever rendering a broken UI.
 */
export function isValidLocation(
	loc: Location,
	doc: BlueprintDoc,
): boolean {
	switch (loc.kind) {
		case "home":
			return true;
		case "module":
			return doc.modules[loc.moduleUuid] !== undefined;
		case "cases":
			// `caseId` is free-form from the user — we can't validate it
			// against the doc. Only the module reference matters here.
			return doc.modules[loc.moduleUuid] !== undefined;
		case "form": {
			if (doc.modules[loc.moduleUuid] === undefined) return false;
			if (doc.forms[loc.formUuid] === undefined) return false;
			if (
				loc.selectedUuid !== undefined &&
				doc.questions[loc.selectedUuid] === undefined
			) {
				return false;
			}
			return true;
		}
	}
}
```

- [ ] **Step 2: Run tests — expect all passing**

Run:

```bash
npx vitest run lib/routing/__tests__/location.test.ts
```

Expected: every test in the file passes (serialize + parse + isValidLocation).

- [ ] **Step 3: Commit**

```bash
git add lib/routing/location.ts lib/routing/__tests__/location.test.ts
git commit -m "feat(builder/routing): implement isValidLocation"
```

---

### Task 14: Add README files documenting the architecture boundary

**Files:**
- Create: `lib/doc/README.md`
- Create: `lib/session/README.md`
- Create: `lib/routing/README.md`

Documenting the boundary now means when later phases add the actual store and hooks, there's a reference for "why this file structure exists" without anyone having to re-read the spec. In Phase 6 these READMEs are updated to reflect enforced lint rules.

- [ ] **Step 1: Create `lib/doc/README.md`**

Create `lib/doc/README.md`:

```markdown
# lib/doc — The Builder Document Store

The normalized, undoable source of truth for the blueprint domain. Every
module, form, and question the builder edits lives here, keyed by UUID.

## Boundary rule

**Anything outside `lib/doc/hooks/**` must NOT import from `lib/doc/store.*`
directly.** The store is private; its public surface is the hooks under
`lib/doc/hooks/`.

Consumer code imports named domain hooks (e.g. `useQuestion(uuid)`,
`useOrderedChildren(parentUuid)`) that handle subscription, selector
shape, and memoization internally. No component ever passes a raw selector
function to a Zustand hook for this store.

This rule will be enforced by a Biome `noRestrictedImports` rule in Phase 6
of the builder re-architecture. Until then it is enforced by convention and
code review.

## Status

**Phase 0 (scaffolding):** only `types.ts` exists. The actual store and
hook implementations are added in later phases. Nothing in the running app
imports from this directory yet.

- Phase 1: builds the Zustand store with Immer + zundo middleware, adds the
  mutation reducer, introduces the `hooks/` directory with `useQuestion`,
  `useForm`, `useModule`, `useOrderedChildren`, etc.
- Phase 2+: only additions; the types here do not change shape.

See `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`.
```

- [ ] **Step 2: Create `lib/session/README.md`**

Create `lib/session/README.md`:

```markdown
# lib/session — The Builder Ephemeral Session Store

Transient UI state scoped to the builder route: cursor mode, sidebar
visibility, agent status, active field, connect-mode stash. None of this is
undoable; none of it is persisted across page loads.

## Boundary rule

Same as `lib/doc`: anything outside `lib/session/hooks/**` must not import
from `lib/session/store.*` directly. Consumer code uses named hooks
(`useCursorMode()`, `useAgentStatus()`, `useSidebarState("chat")`, ...).

## Why a separate store

Separating ephemeral UI from the blueprint document means:
- Zundo (undo middleware) can track the entire document store without a
  `partialize` allow-list, because UI fields don't live in it.
- The two stores have disjoint responsibilities and can be reasoned about
  independently.
- Stream handlers and route handlers can toggle `agent` status from outside
  React's render tree without threading through context.

## Status

**Phase 0 (scaffolding):** only `types.ts` exists. Store and hooks are
added in Phase 3.

See `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`.
```

- [ ] **Step 3: Create `lib/routing/README.md`**

Create `lib/routing/README.md`:

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add lib/doc/README.md lib/session/README.md lib/routing/README.md
git commit -m "docs(builder): add README files documenting architecture boundaries"
```

---

### Task 15: Final verification — full test suite + typecheck + build

**Files:**
- None modified.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test -- --run
```

Expected: all tests pass. The new `lib/routing/__tests__/location.test.ts` tests run alongside existing tests; no prior test is affected.

- [ ] **Step 2: Typecheck the whole project**

Run:

```bash
npx tsc --noEmit && echo "✓ typecheck clean"
```

Expected: `✓ typecheck clean` prints (tsc emits no output on success).

- [ ] **Step 3: Lint + format check**

Run:

```bash
npm run lint
```

Expected: clean. If Biome reports formatting issues on the new files, run `npm run format` to fix them, then re-run the lint check. If issues remain, they should be addressed in a follow-up commit rather than squashed into Phase 0's last commit — the scaffolding is complete as of Step 1–2 above.

- [ ] **Step 4: Production build**

Run:

```bash
npm run build
```

Expected: build succeeds. Since nothing in the app imports from the new directories yet, the output bundle size is unchanged.

- [ ] **Step 5: Verify commit graph**

Run:

```bash
git log --oneline -15
```

Expected: ~14 new commits on top of `main`, each scoped to a single task (e.g. `feat(builder/doc): add branded Uuid type`, `feat(builder/routing): implement parseLocation with round-trip coverage`, etc.). No amended commits, no mixed-concern commits.

---

## Phase 0 complete

What exists at the end of this phase:

- Three new top-level library directories (`lib/doc`, `lib/session`, `lib/routing`), each with a `README.md` that explains its boundary.
- Full TypeScript type definitions for every piece of state Phase 1–5 will build on: `Uuid`, `ModuleEntity`, `FormEntity`, `QuestionEntity`, `BlueprintDoc`, `Mutation`, `BuilderSession`, `Location`.
- A fully-tested, pure-function URL parser/serializer/validator under `lib/routing/location.ts` with round-trip coverage.

What does NOT exist yet:

- Any Zustand store, hook, provider, or React component that uses these types.
- Any change to the running app's behavior. The existing `BuilderEngine`, `builderStore`, and `builderSelectors` are untouched.
- The Biome `noRestrictedImports` lint rule — that lands in Phase 6 when it has something to enforce.

**Next plan:** Phase 1 — BlueprintDoc store + mutation API. The adapter pattern that lets the old store read-forward from the new doc during Phases 1–2. Domain hooks. Returns to the writing-plans skill after Phase 0 merges to `main`.
