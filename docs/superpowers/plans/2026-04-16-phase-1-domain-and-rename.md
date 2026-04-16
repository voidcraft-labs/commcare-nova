# Phase 1: Domain Layer + Rename + Normalized Firestore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-shape `Question` type with a TypeScript discriminated union `Field`, rename "question" out of the internal domain, delete `AppBlueprint` / `normalizedState` / `converter`, and store the normalized doc directly in Firestore. Phase 1 of 7 from `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`.

**Architecture:** `lib/domain/` becomes the single source of truth. One file per field kind holding TS type + Zod schema + kind metadata + declarative editor schema. `lib/doc/` keeps its normalized structure but renames fields→kinds, `questions`→`fields`, `Question`→`Field`, `questionOrder`→`fieldOrder`, and adds a `fieldParent` reverse index maintained atomically by the reducer. Firestore persists the normalized shape directly. A one-time migration script converts existing docs on first deploy.

**Tech Stack:** TypeScript 5.x strict, Zod 4.x (`z.discriminatedUnion`), Zustand + Immer + zundo, Firestore, Biome.

**Worktree:** `.worktrees/phase-1-domain-rename` on branch `refactor/phase-1-domain-rename`.

**Baseline before starting:** run `npm test` from the current `main` branch and record the passing test count. Re-verify this count in Task 30 as the smoke gate.

---

## Scope boundaries

IN SCOPE (this plan):
- Create `lib/domain/` with per-kind field files (19 kinds), `Field` discriminated union, `fieldRegistry`, `fieldEditorSchemas`.
- Move `Module`, `Form`, `BlueprintDoc` types into `lib/domain/`.
- Rename `Question`→`Field`, `question`→`field`, `questionOrder`→`fieldOrder`, `QuestionEntity`→`Field`, etc. throughout the entire codebase except inside `lib/commcare/` (which is scaffolded empty in this phase and populated in a later phase — until then, CommCare-facing code stays in `lib/services/` and internally uses `Question`-named types via a thin adapter; see Task 20).
- Add `fieldParent` reverse-index map, maintained atomically by the reducer.
- Delete `AppBlueprint`, `toDoc`, `toBlueprint`, `converter.ts`, `lib/services/normalizedState.ts`.
- Update Firestore save/load paths to read/write the normalized doc directly.
- Write and run a one-time migration script.
- SA prompts + SA tool schemas updated to say "field" (SA still emits `replaceForm` — Phase 2's job to kill it).

OUT OF SCOPE (future phases):
- Phase 2: Kill `replaceForm`, remove `notify*` from public API, add `convertField` mutation.
- Phase 3: Tool schema generator + server-side mutation mapper.
- Phase 4: Event log unification.
- Phase 5: Declarative editor UI + component splits.
- Phase 6: Hook + lint hygiene, move `/hooks/` into `lib/`.
- Phase 7: Delete `lib/services/`, `lib/schemas/`, `lib/types/`, `lib/prompts/`, `lib/transpiler/`, `lib/codemirror/`.

**This phase intentionally leaves the codebase in a half-migrated shape.** Some files will still live under `lib/services/` and `lib/schemas/`. The `replaceForm` mutation still exists. `notify*` mutations still exist. That is correct — later phases clean them up.

---

## File structure

### Files to create

| File | Responsibility |
|------|---------------|
| `lib/domain/index.ts` | Barrel export of every public type (Field, Module, Form, BlueprintDoc, Mutation, etc.). |
| `lib/domain/fields/index.ts` | `Field` discriminated union, `ContainerField` type, `fieldKinds` tuple, `FieldKind` type, `fieldRegistry`, `fieldEditorSchemas`, `isContainer()` type guard, `fieldSchema` (Zod). |
| `lib/domain/fields/base.ts` | `FieldBase`, `InputFieldBase` shared types + helper schemas. |
| `lib/domain/fields/text.ts` | `TextField`, `textFieldSchema`, `textFieldMetadata`, `textFieldEditorSchema`. |
| `lib/domain/fields/int.ts` | `IntField` and its tuple. |
| `lib/domain/fields/decimal.ts` | `DecimalField` and its tuple. |
| `lib/domain/fields/date.ts` | `DateField` and its tuple. |
| `lib/domain/fields/time.ts` | `TimeField` and its tuple. |
| `lib/domain/fields/datetime.ts` | `DatetimeField` and its tuple. |
| `lib/domain/fields/singleSelect.ts` | `SingleSelectField` and its tuple. |
| `lib/domain/fields/multiSelect.ts` | `MultiSelectField` and its tuple. |
| `lib/domain/fields/geopoint.ts` | `GeopointField` and its tuple. |
| `lib/domain/fields/image.ts` | `ImageField` and its tuple. |
| `lib/domain/fields/audio.ts` | `AudioField` and its tuple. |
| `lib/domain/fields/video.ts` | `VideoField` and its tuple. |
| `lib/domain/fields/barcode.ts` | `BarcodeField` and its tuple. |
| `lib/domain/fields/signature.ts` | `SignatureField` and its tuple. |
| `lib/domain/fields/label.ts` | `LabelField` and its tuple (structural; no input fields). |
| `lib/domain/fields/hidden.ts` | `HiddenField` and its tuple (no label, has calculate). |
| `lib/domain/fields/secret.ts` | `SecretField` and its tuple (no calculate). |
| `lib/domain/fields/group.ts` | `GroupField` (container, no options/validate/required/case_property). |
| `lib/domain/fields/repeat.ts` | `RepeatField` (container, no options). |
| `lib/domain/kinds.ts` | `FieldKindMetadata<K>`, `FieldEditorSchema<F>`, `XFormControlKind`, `XFormDataType`. |
| `lib/domain/modules.ts` | `Module` type + Zod + metadata (moved from `lib/doc/types.ts` + `lib/schemas/blueprint.ts`). |
| `lib/domain/forms.ts` | `Form` type + Zod + metadata. |
| `lib/domain/blueprint.ts` | `BlueprintDoc` type (moved from `lib/doc/types.ts`). Includes `fieldParent`. |
| `lib/domain/uuid.ts` | `Uuid` branded type, `asUuid`, `uuidSchema` (moved from `lib/doc/types.ts`). |
| `lib/domain/__tests__/fields.test.ts` | Round-trip each kind's Zod schema against fixture values; exhaustiveness tests. |
| `lib/domain/__tests__/blueprint.test.ts` | `fieldSchema.parse` happy + sad path per kind. |
| `scripts/migrate-to-normalized-doc.ts` | One-time Firestore migration (legacy `AppBlueprint` → `BlueprintDoc`). |
| `lib/commcare/` | Empty directory with a placeholder `index.ts` (CLAUDE.md comment). Population is a later phase's job; the directory exists so the import boundary can be referenced. |

### Files to delete

| File | Reason |
|------|--------|
| `lib/schemas/blueprint.ts` | Superseded by `lib/domain/`. Any helpers that still have callers (e.g. `deriveCaseConfig`) move to `lib/services/deriveCaseConfig.ts` verbatim (a Phase 2/3 chore will find a better home). |
| `lib/services/normalizedState.ts` | Compat layer is gone; the store is normalized directly. |
| `lib/doc/converter.ts` | `toDoc` / `toBlueprint` are no longer needed; normalized is the only shape. |
| `lib/doc/types.ts` | Its contents move to `lib/domain/`. This file becomes a re-export barrel that Phase 7 will delete; for this phase it re-exports from `lib/domain/` to keep the existing import graph working. |

### Files to modify heavily

| File | Change |
|------|--------|
| `lib/doc/store.ts` | Reducer renames: `addQuestion` → `addField`, etc. New invariant: every mutation that touches `fieldOrder` rebuilds the `fieldParent` index for affected parents. Delete `replaceForm` handling of `questionOrder` key → `fieldOrder` key. |
| `lib/doc/hooks/useQuestion.ts` | Rename file → `useField.ts`, rename hook. |
| `lib/doc/hooks/useOrderedQuestions.ts` | Rename → `useOrderedFields.ts`. |
| `lib/doc/hooks/useQuestionTree.ts` | Rename → `useFieldTree.ts`. |
| `lib/doc/hooks/*` | Rename every `question`→`field` in identifiers, file names, comments, tests. |
| `lib/doc/loader.ts` | Load reads the normalized Firestore doc directly (no `toDoc` conversion). Rebuilds `fieldParent` index after load. |
| `lib/doc/persist.ts` (or equivalent auto-save) | Save writes the normalized doc directly (no `toBlueprint` conversion). |
| `app/api/chat/route.ts` | Replace `toBlueprint`/`toDoc` calls. SA receives/emits via blueprintHelpers (which take doc), not via `AppBlueprint`. |
| `lib/services/blueprintHelpers.ts` | Update every helper to operate on the normalized doc shape + new field names. These stay in `lib/services/` this phase — Phase 3's job to move them into `lib/agent/`. |
| `lib/services/solutionsArchitect.ts` | Update tool handlers to read/write `Field` (not `Question`). Field names in tool output: `case_property_on` remains for now in the *tool schema* only (SA backward compat); mutation mapper converts `case_property_on` (tool wire) → `case_property` (domain) on ingress. |
| `lib/prompts/solutionsArchitectPrompt.ts` | SA prompt uses "field" throughout. "Question" survives only in quoted CommCare terminology. |
| `lib/schemas/toolSchemas.ts` | Minimal update: rename TS type exports referring to `Question` → `Field`; leave the wire-format field name (`case_property_on`) unchanged on the tool surface. Full generator replacement is Phase 3's job. |
| `components/**`, `app/**`, `hooks/**` | Rename every occurrence of `Question`, `question`, `QuestionEntity`, `QuestionRow`, `QuestionRenderer`, `useQuestion`, etc. to the field-named equivalent. |
| `biome.json` | Expand `noRestrictedImports` to ban `import { Question } from "@/lib/schemas/blueprint"` and friends — they don't exist after deletion. Mostly self-enforcing via the TS build. |
| `firestore.rules` | If any field-name-specific rules exist, update (there should be none — rules are at the document level). |

---

## Task 1: Create worktree and branch

**Files:**
- Worktree: `.worktrees/phase-1-domain-rename`

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/braxtonperry/work/personal/code/commcare-nova
git worktree add .worktrees/phase-1-domain-rename -b refactor/phase-1-domain-rename
cd .worktrees/phase-1-domain-rename
npm install
```

- [ ] **Step 2: Verify baseline passes**

```bash
npm run lint
npx tsc --noEmit
npm test -- --run
```

Record the passing test count. All three commands must be clean before starting.

- [ ] **Step 3: Commit baseline marker**

```bash
git commit --allow-empty -m "chore: phase 1 baseline marker"
```

---

## Task 2: Create `lib/domain/kinds.ts` — metadata and editor schema types

Defines the shape of per-kind metadata and editor schemas that every field file in the next tasks will produce.

**Files:**
- Create: `lib/domain/kinds.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/domain/kinds.ts
//
// Types that describe per-field-kind metadata and declarative editor
// schemas. Every file under lib/domain/fields/* exports values of these
// shapes so the compiler, validator, editor panel, and SA tool schema
// generator can all read one table.

import type { ComponentType, ReactNode } from "react";
import type { Field, FieldKind } from "./fields";

/** XForm control element emitted by the compiler for a given field kind. */
export type XFormControlKind =
  | "input"
  | "select1"
  | "select"
  | "trigger"
  | "group"
  | "repeat"
  | "output";

/** XForm data type (xsd:* or CommCare extensions). "" for structural kinds. */
export type XFormDataType =
  | ""
  | "xsd:string"
  | "xsd:int"
  | "xsd:decimal"
  | "xsd:date"
  | "xsd:time"
  | "xsd:dateTime"
  | "geopoint"
  | "binary";

/** Non-behavioral metadata for a field kind. */
export type FieldKindMetadata<K extends FieldKind> = {
  kind: K;
  xformKind: XFormControlKind;
  dataType: XFormDataType;
  icon: string;
  isStructural: boolean;
  isContainer: boolean;
  saDocs: string;
  convertTargets: readonly FieldKind[];
};

/** Props a declarative editor component receives for a single field key. */
export type FieldEditorComponentProps<F extends Field, K extends keyof F> = {
  field: F;
  value: F[K];
  onChange: (next: F[K]) => void;
};

/** A declarative editor component, narrowed to one field key. */
export type FieldEditorComponent<F extends Field, K extends keyof F> =
  ComponentType<FieldEditorComponentProps<F, K>>;

/** One entry in a kind's declarative editor schema. */
export type FieldEditorEntry<F extends Field> = {
  [K in keyof F]: {
    key: K;
    component: FieldEditorComponent<F, K>;
    label?: string;
    visible?: (field: F) => boolean;
    // Override how the entry renders. Used for headers or grouped entries.
    renderOverride?: (props: FieldEditorComponentProps<F, K>) => ReactNode;
  };
}[keyof F];

/** Declarative per-kind editor schema — three fixed sections. */
export type FieldEditorSchema<F extends Field> = {
  data: FieldEditorEntry<F>[];
  logic: FieldEditorEntry<F>[];
  ui: FieldEditorEntry<F>[];
};
```

- [ ] **Step 2: Commit**

```bash
git add lib/domain/kinds.ts
git commit -m "feat(domain): add FieldKindMetadata + FieldEditorSchema types"
```

---

## Task 3: Create `lib/domain/uuid.ts` — branded Uuid type

Move `Uuid` and `asUuid` out of `lib/doc/types.ts` into the domain layer.

**Files:**
- Create: `lib/domain/uuid.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/domain/uuid.ts
//
// Branded UUID type. Prevents accidental mixing of entity UUIDs with
// ordinary strings. Runtime representation is plain string.

import { z } from "zod";

export type Uuid = string & { readonly __brand: "Uuid" };

/** Narrowing cast from string → Uuid. Prefer over `as Uuid`. */
export function asUuid(s: string): Uuid {
  return s as Uuid;
}

/** Zod schema that accepts any string and types it as `Uuid`. */
export const uuidSchema = z
  .string()
  .min(1)
  .transform((s) => s as Uuid);
```

- [ ] **Step 2: Commit**

```bash
git add lib/domain/uuid.ts
git commit -m "feat(domain): add Uuid branded type"
```

---

## Task 4: Create `lib/domain/fields/base.ts` — shared field bases

Defines `FieldBase` and `InputFieldBase` that every kind extends.

**Files:**
- Create: `lib/domain/fields/base.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/domain/fields/base.ts
//
// Shared base types for all field kinds. Input kinds extend
// InputFieldBase; structural kinds (group/repeat/label/hidden) extend
// FieldBase directly and opt in to whichever optional fields apply.

import { z } from "zod";
import { uuidSchema, type Uuid } from "../uuid";

/** Every field has identity, a CommCare property id, and a display label. */
export type FieldBase = {
  uuid: Uuid;
  id: string;
  label: string;
};

export const fieldBaseSchema = z.object({
  uuid: uuidSchema,
  id: z.string(),
  label: z.string(),
});

/** Input-capable fields additionally carry hint / required / relevant / case wiring. */
export type InputFieldBase = FieldBase & {
  hint?: string;
  required?: string; // XPath expression or "true()"
  relevant?: string; // XPath expression
  case_property?: string; // case type name this field writes to
};

export const inputFieldBaseSchema = fieldBaseSchema.extend({
  hint: z.string().optional(),
  required: z.string().optional(),
  relevant: z.string().optional(),
  case_property: z.string().optional(),
});

/** Select option value + label pair, shared by singleSelect/multiSelect. */
export type SelectOption = { value: string; label: string };

export const selectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});
```

- [ ] **Step 2: Commit**

```bash
git add lib/domain/fields/base.ts
git commit -m "feat(domain): add FieldBase + InputFieldBase shared types"
```

---

## Task 5: Create `lib/domain/fields/text.ts` — reference implementation

This is the template every other kind follows. Implement text first and review carefully before writing the remaining 18 kinds.

**Files:**
- Create: `lib/domain/fields/text.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/domain/fields/text.ts
//
// Free-text single-line string field. Supports XPath validation +
// calculation. Maps to CommCare <input> control with xsd:string type.

import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import type { FieldEditorSchema } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const textFieldSchema = inputFieldBaseSchema.extend({
  kind: z.literal("text"),
  validate: z.string().optional(),
  validate_msg: z.string().optional(),
  calculate: z.string().optional(),
  default_value: z.string().optional(),
});

export type TextField = z.infer<typeof textFieldSchema>;

export const textFieldMetadata: FieldKindMetadata<"text"> = {
  kind: "text",
  xformKind: "input",
  dataType: "xsd:string",
  icon: "tabler:cursor-text",
  isStructural: false,
  isContainer: false,
  saDocs:
    "Free-text field for single-line string input. Supports XPath validation and calculate.",
  convertTargets: [
    "int",
    "decimal",
    "date",
    "time",
    "datetime",
    "single_select",
    "multi_select",
    "hidden",
    "secret",
  ],
};

// Editor schema is a placeholder for Phase 1 — components referenced here
// (`CasePropertySelect`, `TextareaField`, `XPathField`, `BooleanField`) are
// Phase 5's job. In Phase 1 we publish the entries with stub components that
// match the typed shape but render a disabled input. Phase 5 replaces them.
import { StubField } from "@/components/builder/editor/StubField";

export const textFieldEditorSchema: FieldEditorSchema<TextField> = {
  data: [{ key: "case_property", component: StubField }],
  logic: [
    { key: "required", component: StubField },
    { key: "relevant", component: StubField },
    { key: "validate", component: StubField },
    { key: "validate_msg", component: StubField },
    { key: "calculate", component: StubField },
    { key: "default_value", component: StubField },
  ],
  ui: [{ key: "hint", component: StubField }],
};
```

- [ ] **Step 2: Create `components/builder/editor/StubField.tsx`**

```tsx
// components/builder/editor/StubField.tsx
//
// Placeholder editor component used by Phase 1's declarative editor
// schemas. Phase 5 replaces it with real per-type editors
// (CasePropertySelect, XPathField, etc.). Until then, every registered
// editor entry renders this stub — the schema wiring is provable but the
// UI stays the legacy ContextualEditor* components.

import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import type { Field } from "@/lib/domain/fields";

export function StubField<F extends Field, K extends keyof F>({
  field,
  value,
  onChange,
}: FieldEditorComponentProps<F, K>) {
  return (
    <input
      type="text"
      disabled
      value={typeof value === "string" ? value : ""}
      data-phase-1-stub={String(field.kind)}
      data-field-key={String(arguments[0].key ?? "")}
      onChange={(e) => onChange(e.target.value as F[K])}
      className="text-xs opacity-50"
    />
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/domain/fields/text.ts components/builder/editor/StubField.tsx
git commit -m "feat(domain): add TextField kind (reference implementation)"
```

---

## Task 6: Create remaining 18 field kind files

Each file follows the `text.ts` template. Per-kind variation is summarized below — everything else matches the text.ts shape, including editor-schema stubs. All editor schemas use `StubField` in Phase 1.

**File:** `lib/domain/fields/int.ts` — integers. Fields same as text: validate, validate_msg, calculate, default_value. Metadata: `xformKind: "input"`, `dataType: "xsd:int"`, `icon: "tabler:number"`, `saDocs: "Whole-number input (age, count, quantity)."`, `convertTargets: ["text","decimal","single_select","multi_select","hidden","secret"]`.

**File:** `lib/domain/fields/decimal.ts` — decimals. Same field set as int. Metadata: `xformKind: "input"`, `dataType: "xsd:decimal"`, `icon: "tabler:decimal"`, `saDocs: "Decimal-number input for measurements (weight, height, price)."`, `convertTargets: ["text","int","hidden","secret"]`.

**File:** `lib/domain/fields/date.ts` — date picker. Fields: validate, validate_msg, calculate, default_value. Metadata: `xformKind: "input"`, `dataType: "xsd:date"`, `icon: "tabler:calendar"`, `saDocs: "Date-only picker."`, `convertTargets: ["text","time","datetime","hidden"]`.

**File:** `lib/domain/fields/time.ts` — time picker. Metadata: `xformKind: "input"`, `dataType: "xsd:time"`, `icon: "tabler:clock"`, `saDocs: "Time-only picker."`, `convertTargets: ["text","date","datetime","hidden"]`.

**File:** `lib/domain/fields/datetime.ts`. Metadata: `xformKind: "input"`, `dataType: "xsd:dateTime"`, `icon: "tabler:calendar-clock"`, `saDocs: "Combined date + time picker."`, `convertTargets: ["text","date","time","hidden"]`.

**File:** `lib/domain/fields/singleSelect.ts` — one choice from options. Fields: **options (required, ≥2)**, validate, validate_msg, calculate (no default_value — selects don't accept one). Metadata: `xformKind: "select1"`, `dataType: "xsd:string"`, `icon: "tabler:circle-dot"`, `saDocs: "Single-choice from a fixed option list."`, `convertTargets: ["text","multi_select","hidden"]`.

Schema:
```ts
export const singleSelectFieldSchema = inputFieldBaseSchema.extend({
  kind: z.literal("single_select"),
  options: z.array(selectOptionSchema).min(2),
  validate: z.string().optional(),
  validate_msg: z.string().optional(),
  calculate: z.string().optional(),
});
```

**File:** `lib/domain/fields/multiSelect.ts` — multiple choices. Fields: **options (required, ≥2)**, validate, validate_msg, calculate. Metadata: `xformKind: "select"`, `dataType: "xsd:string"`, `icon: "tabler:checkbox"`, `saDocs: "Multi-choice from a fixed option list."`, `convertTargets: ["single_select","hidden"]`.

**File:** `lib/domain/fields/geopoint.ts` — GPS. Fields: calculate, default_value. Metadata: `xformKind: "input"`, `dataType: "geopoint"`, `icon: "tabler:map-pin"`, `saDocs: "GPS coordinate capture."`, `convertTargets: ["hidden"]`.

**File:** `lib/domain/fields/image.ts` — image capture. Fields: no validate/calculate/default_value; media kinds cannot be calculated or case-written (per schema.md). `case_property` disallowed — remove from InputFieldBase extension. Metadata: `xformKind: "input"`, `dataType: "binary"`, `icon: "tabler:photo"`, `saDocs: "Image capture from camera or gallery. Cannot be saved to a case property."`, `convertTargets: []`.

Schema — note `case_property` is explicitly omitted:
```ts
export const imageFieldSchema = fieldBaseSchema.extend({
  kind: z.literal("image"),
  hint: z.string().optional(),
  required: z.string().optional(),
  relevant: z.string().optional(),
});
export type ImageField = z.infer<typeof imageFieldSchema>;
```

**File:** `lib/domain/fields/audio.ts` — same shape as image; `xformKind: "input"`, `dataType: "binary"`, `icon: "tabler:microphone"`, `saDocs: "Audio recording. Cannot be saved to a case property."`, `convertTargets: []`.

**File:** `lib/domain/fields/video.ts` — same shape as image; icon `"tabler:video"`, saDocs "Video recording.", etc.

**File:** `lib/domain/fields/barcode.ts` — barcode scan. Same as text but no default_value. `xformKind: "input"`, `dataType: "xsd:string"`, `icon: "tabler:barcode"`, `saDocs: "Barcode/QR scan."`, `convertTargets: ["text","hidden"]`.

**File:** `lib/domain/fields/signature.ts` — same shape as image; icon `"tabler:signature"`, saDocs "Signature capture.", convertTargets `[]`.

**File:** `lib/domain/fields/label.ts` — display-only. Fields: `relevant` only (no required, calculate, case_property, validate, hint). Schema extends `fieldBaseSchema` directly, not `inputFieldBaseSchema`. Metadata: `xformKind: "trigger"`, `dataType: ""`, `icon: "tabler:info-circle"`, `isStructural: true`, `saDocs: "Display-only text. Renders a read-only message — collects no input."`, `convertTargets: []`.

**File:** `lib/domain/fields/hidden.ts` — computed, no UI. Fields: calculate (required), default_value, required, relevant, case_property. **No label** (hidden has no UI). Schema:
```ts
export const hiddenFieldSchema = z.object({
  kind: z.literal("hidden"),
  uuid: uuidSchema,
  id: z.string(),
  calculate: z.string(),
  default_value: z.string().optional(),
  required: z.string().optional(),
  relevant: z.string().optional(),
  case_property: z.string().optional(),
});
```
Metadata: `xformKind: "input"`, `dataType: "xsd:string"`, `icon: "tabler:eye-off"`, `saDocs: "Computed value that the user never sees. Must have a calculate expression."`, `convertTargets: ["text","int","decimal"]`.

**File:** `lib/domain/fields/secret.ts` — password/PIN. Same shape as text but no calculate. Metadata: `xformKind: "input"`, `dataType: "xsd:string"`, `icon: "tabler:eye-off"`, `saDocs: "Sensitive input (password, PIN)."`, `convertTargets: ["text","hidden"]`.

**File:** `lib/domain/fields/group.ts` — container. Fields: `relevant` only. Schema extends `fieldBaseSchema` directly. Metadata: `xformKind: "group"`, `dataType: ""`, `icon: "tabler:folder"`, `isStructural: true`, `isContainer: true`, `saDocs: "Groups a set of fields under one visual header. Contents collapse and re-appear together."`, `convertTargets: ["repeat"]`.

**File:** `lib/domain/fields/repeat.ts` — iteration container. Fields: `relevant`. Schema extends `fieldBaseSchema`. Metadata: `xformKind: "repeat"`, `dataType: ""`, `icon: "tabler:repeat"`, `isStructural: true`, `isContainer: true`, `saDocs: "Repeats its child fields N times (e.g. one set per household member)."`, `convertTargets: ["group"]`.

- [ ] **Step 1: Create all 18 files**

Create each file following the `text.ts` template, adjusting per-kind schemas and metadata as above. Every editor schema uses `StubField` for every entry.

- [ ] **Step 2: Verify each file type-checks**

```bash
npx tsc --noEmit
```

Expected: clean. Any errors mean a schema shape mismatch.

- [ ] **Step 3: Commit**

```bash
git add lib/domain/fields/
git commit -m "feat(domain): add 18 remaining field kinds"
```

---

## Task 7: Create `lib/domain/fields/index.ts` — union + registry

Ties every per-kind file together into one exported surface.

**Files:**
- Create: `lib/domain/fields/index.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/domain/fields/index.ts
//
// Public barrel: Field discriminated union, ContainerField, fieldKinds
// tuple, fieldRegistry, fieldEditorSchemas, isContainer type guard.
//
// This file is the ONLY place anything outside lib/domain/ imports from
// the fields/ directory. Individual kind files are private.

import { z } from "zod";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";

import { textFieldSchema, type TextField, textFieldMetadata, textFieldEditorSchema } from "./text";
import { intFieldSchema, type IntField, intFieldMetadata, intFieldEditorSchema } from "./int";
import { decimalFieldSchema, type DecimalField, decimalFieldMetadata, decimalFieldEditorSchema } from "./decimal";
import { dateFieldSchema, type DateField, dateFieldMetadata, dateFieldEditorSchema } from "./date";
import { timeFieldSchema, type TimeField, timeFieldMetadata, timeFieldEditorSchema } from "./time";
import { datetimeFieldSchema, type DatetimeField, datetimeFieldMetadata, datetimeFieldEditorSchema } from "./datetime";
import { singleSelectFieldSchema, type SingleSelectField, singleSelectFieldMetadata, singleSelectFieldEditorSchema } from "./singleSelect";
import { multiSelectFieldSchema, type MultiSelectField, multiSelectFieldMetadata, multiSelectFieldEditorSchema } from "./multiSelect";
import { geopointFieldSchema, type GeopointField, geopointFieldMetadata, geopointFieldEditorSchema } from "./geopoint";
import { imageFieldSchema, type ImageField, imageFieldMetadata, imageFieldEditorSchema } from "./image";
import { audioFieldSchema, type AudioField, audioFieldMetadata, audioFieldEditorSchema } from "./audio";
import { videoFieldSchema, type VideoField, videoFieldMetadata, videoFieldEditorSchema } from "./video";
import { barcodeFieldSchema, type BarcodeField, barcodeFieldMetadata, barcodeFieldEditorSchema } from "./barcode";
import { signatureFieldSchema, type SignatureField, signatureFieldMetadata, signatureFieldEditorSchema } from "./signature";
import { labelFieldSchema, type LabelField, labelFieldMetadata, labelFieldEditorSchema } from "./label";
import { hiddenFieldSchema, type HiddenField, hiddenFieldMetadata, hiddenFieldEditorSchema } from "./hidden";
import { secretFieldSchema, type SecretField, secretFieldMetadata, secretFieldEditorSchema } from "./secret";
import { groupFieldSchema, type GroupField, groupFieldMetadata, groupFieldEditorSchema } from "./group";
import { repeatFieldSchema, type RepeatField, repeatFieldMetadata, repeatFieldEditorSchema } from "./repeat";

// Order here defines iteration order for the type picker + docs.
export const fieldKinds = [
  "text",
  "int",
  "decimal",
  "date",
  "time",
  "datetime",
  "single_select",
  "multi_select",
  "geopoint",
  "image",
  "audio",
  "video",
  "barcode",
  "signature",
  "label",
  "hidden",
  "secret",
  "group",
  "repeat",
] as const;

export type FieldKind = (typeof fieldKinds)[number];

export const fieldSchema = z.discriminatedUnion("kind", [
  textFieldSchema,
  intFieldSchema,
  decimalFieldSchema,
  dateFieldSchema,
  timeFieldSchema,
  datetimeFieldSchema,
  singleSelectFieldSchema,
  multiSelectFieldSchema,
  geopointFieldSchema,
  imageFieldSchema,
  audioFieldSchema,
  videoFieldSchema,
  barcodeFieldSchema,
  signatureFieldSchema,
  labelFieldSchema,
  hiddenFieldSchema,
  secretFieldSchema,
  groupFieldSchema,
  repeatFieldSchema,
]);

export type Field = z.infer<typeof fieldSchema>;

export type ContainerField = Extract<Field, { kind: "group" | "repeat" }>;

export const fieldRegistry: { [K in FieldKind]: FieldKindMetadata<K> } = {
  text: textFieldMetadata,
  int: intFieldMetadata,
  decimal: decimalFieldMetadata,
  date: dateFieldMetadata,
  time: timeFieldMetadata,
  datetime: datetimeFieldMetadata,
  single_select: singleSelectFieldMetadata,
  multi_select: multiSelectFieldMetadata,
  geopoint: geopointFieldMetadata,
  image: imageFieldMetadata,
  audio: audioFieldMetadata,
  video: videoFieldMetadata,
  barcode: barcodeFieldMetadata,
  signature: signatureFieldMetadata,
  label: labelFieldMetadata,
  hidden: hiddenFieldMetadata,
  secret: secretFieldMetadata,
  group: groupFieldMetadata,
  repeat: repeatFieldMetadata,
};

export const fieldEditorSchemas: {
  [K in FieldKind]: FieldEditorSchema<Extract<Field, { kind: K }>>;
} = {
  text: textFieldEditorSchema,
  int: intFieldEditorSchema,
  decimal: decimalFieldEditorSchema,
  date: dateFieldEditorSchema,
  time: timeFieldEditorSchema,
  datetime: datetimeFieldEditorSchema,
  single_select: singleSelectFieldEditorSchema,
  multi_select: multiSelectFieldEditorSchema,
  geopoint: geopointFieldEditorSchema,
  image: imageFieldEditorSchema,
  audio: audioFieldEditorSchema,
  video: videoFieldEditorSchema,
  barcode: barcodeFieldEditorSchema,
  signature: signatureFieldEditorSchema,
  label: labelFieldEditorSchema,
  hidden: hiddenFieldEditorSchema,
  secret: secretFieldEditorSchema,
  group: groupFieldEditorSchema,
  repeat: repeatFieldEditorSchema,
};

/** Type guard for container kinds (group, repeat). Used wherever "can this
 *  field have children?" is asked — add/move field reducers, tree walkers,
 *  drag-drop validity checks. */
export function isContainer(f: Field): f is ContainerField {
  return fieldRegistry[f.kind].isContainer;
}

// Re-export individual kind types for downstream switch blocks.
export type {
  TextField,
  IntField,
  DecimalField,
  DateField,
  TimeField,
  DatetimeField,
  SingleSelectField,
  MultiSelectField,
  GeopointField,
  ImageField,
  AudioField,
  VideoField,
  BarcodeField,
  SignatureField,
  LabelField,
  HiddenField,
  SecretField,
  GroupField,
  RepeatField,
};
```

- [ ] **Step 2: Verify type checks**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/domain/fields/index.ts
git commit -m "feat(domain): assemble Field discriminated union + registry"
```

---

## Task 8: Create `lib/domain/modules.ts`, `lib/domain/forms.ts`, `lib/domain/blueprint.ts`

Move `Module`, `Form`, `BlueprintDoc` into the domain layer. Add `fieldParent` to the blueprint type.

**Files:**
- Create: `lib/domain/modules.ts`
- Create: `lib/domain/forms.ts`
- Create: `lib/domain/blueprint.ts`

- [ ] **Step 1: Create `lib/domain/modules.ts`**

```ts
// lib/domain/modules.ts
import { z } from "zod";
import { uuidSchema, type Uuid } from "./uuid";
// CaseType currently lives in lib/schemas/blueprint.ts; re-export its shape
// here so consumers can stop importing from schemas/. The schemas/blueprint.ts
// file is deleted later in this phase (Task 22).

const caseListColumnSchema = z.object({
  field: z.string(),
  header: z.string(),
});
export type CaseListColumn = z.infer<typeof caseListColumnSchema>;

export const moduleSchema = z.object({
  uuid: uuidSchema,
  id: z.string(), // semantic id (snake_case display slug)
  name: z.string(),
  caseType: z.string().optional(),
  caseListOnly: z.boolean().optional(),
  purpose: z.string().optional(),
  caseListColumns: z.array(caseListColumnSchema).optional(),
  caseDetailColumns: z.array(caseListColumnSchema).nullable().optional(),
});
export type Module = z.infer<typeof moduleSchema>;

export type ModuleKindMetadata = {
  icon: string;
  saDocs: string;
};
export const moduleMetadata: ModuleKindMetadata = {
  icon: "tabler:stack",
  saDocs: "A module is a top-level menu in the CommCare app. It groups related forms under one case type.",
};
```

- [ ] **Step 2: Create `lib/domain/forms.ts`**

```ts
// lib/domain/forms.ts
import { z } from "zod";
import { uuidSchema } from "./uuid";

export const FORM_TYPES = ["registration", "followup", "close", "survey"] as const;
export type FormType = (typeof FORM_TYPES)[number];

export const CASE_FORM_TYPES: ReadonlySet<FormType> = new Set([
  "registration",
  "followup",
  "close",
]);

export const CASE_LOADING_FORM_TYPES: ReadonlySet<FormType> = new Set([
  "followup",
  "close",
]);

export const POST_SUBMIT_DESTINATIONS = [
  "app_home",
  "root",
  "module",
  "parent_module",
  "previous",
] as const;
export type PostSubmitDestination = (typeof POST_SUBMIT_DESTINATIONS)[number];

const closeConditionSchema = z.object({
  field: z.string(), // was `question` — renamed
  answer: z.string(),
  operator: z.enum(["=", "selected"]).optional(),
});

const formLinkDatumSchema = z.object({
  name: z.string(),
  xpath: z.string(),
});

const formLinkTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("form"),
    moduleUuid: uuidSchema, // was moduleIndex
    formUuid: uuidSchema, // was formIndex
  }),
  z.object({
    type: z.literal("module"),
    moduleUuid: uuidSchema,
  }),
]);

const formLinkSchema = z.object({
  condition: z.string().optional(),
  target: formLinkTargetSchema,
  datums: z.array(formLinkDatumSchema).optional(),
});
export type FormLink = z.infer<typeof formLinkSchema>;

// Connect config — same shape as current lib/schemas/blueprint.ts.
const connectLearnModuleSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  time_estimate: z.number().int().positive(),
});
const connectAssessmentSchema = z.object({
  id: z.string().optional(),
  user_score: z.string(),
});
const connectDeliverUnitSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  entity_id: z.string(),
  entity_name: z.string(),
});
const connectTaskSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
});
const connectConfigSchema = z.object({
  learn_module: connectLearnModuleSchema.optional(),
  assessment: connectAssessmentSchema.optional(),
  deliver_unit: connectDeliverUnitSchema.optional(),
  task: connectTaskSchema.optional(),
});
export type ConnectConfig = z.infer<typeof connectConfigSchema>;
export type ConnectLearnModule = z.infer<typeof connectLearnModuleSchema>;
export type ConnectAssessment = z.infer<typeof connectAssessmentSchema>;
export type ConnectDeliverUnit = z.infer<typeof connectDeliverUnitSchema>;
export type ConnectTask = z.infer<typeof connectTaskSchema>;

export const formSchema = z.object({
  uuid: uuidSchema,
  id: z.string(),
  name: z.string(),
  type: z.enum(FORM_TYPES),
  purpose: z.string().optional(),
  closeCondition: closeConditionSchema.optional(),
  connect: connectConfigSchema.nullable().optional(),
  postSubmit: z.enum(POST_SUBMIT_DESTINATIONS).optional(),
  formLinks: z.array(formLinkSchema).optional(),
});
export type Form = z.infer<typeof formSchema>;

export type FormKindMetadata = {
  icon: string;
  saDocs: string;
};
export const formMetadata: FormKindMetadata = {
  icon: "tabler:file-text",
  saDocs: "A form is a single data-collection surface within a module. Its type (registration/followup/close/survey) determines its case behavior.",
};
```

- [ ] **Step 3: Create `lib/domain/blueprint.ts`**

```ts
// lib/domain/blueprint.ts
//
// The normalized blueprint document — single source of truth for the
// builder's domain state. Firestore stores this shape directly (no
// nested-tree conversion). In-memory representation matches on-disk,
// minus the `fieldParent` reverse index which is rebuilt from
// `fieldOrder` on load.

import { z } from "zod";
import { uuidSchema, type Uuid } from "./uuid";
import { moduleSchema, type Module } from "./modules";
import { formSchema, type Form } from "./forms";
import { fieldSchema, type Field } from "./fields";

// Case type schemas — moved verbatim from lib/schemas/blueprint.ts.
const casePropertyMappingSchema = z.object({
  case_property: z.string(),
  question_id: z.string(), // stays "question_id" — CommCare terminology at the boundary
});
export type CasePropertyMapping = z.infer<typeof casePropertyMappingSchema>;

const casePropertySchema = z.object({
  name: z.string(),
  label: z.string(),
  data_type: z.enum([
    "text", "int", "decimal", "date", "time", "datetime",
    "single_select", "multi_select", "geopoint",
  ]).optional(),
  hint: z.string().optional(),
  required: z.string().optional(),
  validation: z.string().optional(),
  validation_msg: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});
export type CaseProperty = z.infer<typeof casePropertySchema>;

const caseTypeSchema = z.object({
  name: z.string(),
  properties: z.array(casePropertySchema),
  parent_type: z.string().optional(),
  relationship: z.enum(["child", "extension"]).optional(),
});
export type CaseType = z.infer<typeof caseTypeSchema>;

export const CONNECT_TYPES = ["learn", "deliver"] as const;
export type ConnectType = (typeof CONNECT_TYPES)[number];

export const blueprintDocSchema = z.object({
  appId: z.string(),
  appName: z.string(),
  connectType: z.enum(CONNECT_TYPES).nullable(),
  caseTypes: z.array(caseTypeSchema).nullable(),

  modules: z.record(uuidSchema, moduleSchema),
  forms: z.record(uuidSchema, formSchema),
  fields: z.record(uuidSchema, fieldSchema),

  moduleOrder: z.array(uuidSchema),
  formOrder: z.record(uuidSchema, z.array(uuidSchema)),
  fieldOrder: z.record(uuidSchema, z.array(uuidSchema)),

  // fieldParent is NOT persisted — derived from fieldOrder on load.
});

export type BlueprintDoc = z.infer<typeof blueprintDocSchema> & {
  /** Reverse index: field uuid → parent uuid (form or container). Maintained
   *  atomically by every mutation that touches fieldOrder. Rebuilt by
   *  rebuildFieldParent() on load. Not persisted. */
  fieldParent: Record<Uuid, Uuid | null>;
};
```

- [ ] **Step 4: Create `lib/domain/index.ts` barrel**

```ts
// lib/domain/index.ts
//
// Public barrel for the domain layer. Every consumer outside lib/domain/
// imports from here or from the kind-specific files under ./fields.

export * from "./uuid";
export * from "./kinds";
export * from "./modules";
export * from "./forms";
export * from "./blueprint";
export * from "./fields";
```

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
```

```bash
git add lib/domain/modules.ts lib/domain/forms.ts lib/domain/blueprint.ts lib/domain/index.ts
git commit -m "feat(domain): add Module, Form, BlueprintDoc in domain layer"
```

---

## Task 9: Write exhaustive schema round-trip tests

Verifies every field kind's Zod schema accepts valid values and rejects invalid ones; verifies the discriminated union dispatches correctly.

**Files:**
- Create: `lib/domain/__tests__/fields.test.ts`

- [ ] **Step 1: Write the test file**

```ts
// lib/domain/__tests__/fields.test.ts
import { describe, expect, it } from "vitest";
import { fieldSchema, fieldKinds, fieldRegistry, isContainer } from "../fields";
import { asUuid } from "../uuid";

describe("fieldSchema", () => {
  it("accepts a valid text field", () => {
    const f = fieldSchema.parse({
      kind: "text",
      uuid: asUuid("abc-123"),
      id: "age",
      label: "Age",
    });
    expect(f.kind).toBe("text");
  });

  it("rejects a text field missing kind", () => {
    expect(() =>
      fieldSchema.parse({ uuid: asUuid("abc"), id: "age", label: "Age" }),
    ).toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() =>
      fieldSchema.parse({
        kind: "likert_scale",
        uuid: asUuid("abc"),
        id: "x",
        label: "X",
      }),
    ).toThrow();
  });

  it("rejects single_select with <2 options", () => {
    expect(() =>
      fieldSchema.parse({
        kind: "single_select",
        uuid: asUuid("abc"),
        id: "x",
        label: "X",
        options: [{ value: "a", label: "A" }],
      }),
    ).toThrow();
  });

  it("accepts a valid single_select with options", () => {
    const f = fieldSchema.parse({
      kind: "single_select",
      uuid: asUuid("abc"),
      id: "x",
      label: "X",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
    });
    expect(f.kind).toBe("single_select");
  });

  it("rejects a group field that sets options (not in schema)", () => {
    // Zod strips unknown keys by default on non-strict schemas — assert
    // instead that options is NOT present on the parsed result.
    const f = fieldSchema.parse({
      kind: "group",
      uuid: asUuid("abc"),
      id: "g",
      label: "G",
      options: [{ value: "a", label: "A" }],
    });
    expect(f.kind).toBe("group");
    // @ts-expect-error — GroupField has no options property
    expect(f.options).toBeUndefined();
  });

  it("rejects a hidden field missing calculate (required)", () => {
    expect(() =>
      fieldSchema.parse({
        kind: "hidden",
        uuid: asUuid("abc"),
        id: "x",
      }),
    ).toThrow();
  });
});

describe("fieldRegistry", () => {
  it("has an entry for every kind in fieldKinds", () => {
    for (const kind of fieldKinds) {
      expect(fieldRegistry[kind]).toBeDefined();
      expect(fieldRegistry[kind].kind).toBe(kind);
    }
  });
});

describe("isContainer", () => {
  it("returns true for group and repeat", () => {
    const g = fieldSchema.parse({
      kind: "group",
      uuid: asUuid("abc"),
      id: "g",
      label: "G",
    });
    expect(isContainer(g)).toBe(true);

    const r = fieldSchema.parse({
      kind: "repeat",
      uuid: asUuid("abc"),
      id: "r",
      label: "R",
    });
    expect(isContainer(r)).toBe(true);
  });

  it("returns false for input kinds", () => {
    const t = fieldSchema.parse({
      kind: "text",
      uuid: asUuid("abc"),
      id: "t",
      label: "T",
    });
    expect(isContainer(t)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- lib/domain/__tests__/fields.test.ts --run
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add lib/domain/__tests__/fields.test.ts
git commit -m "test(domain): exhaustive Field schema round-trip tests"
```

---

## Task 10: Update `lib/doc/types.ts` to re-export from domain + add `fieldParent`

`lib/doc/types.ts` becomes a thin re-export shim for the rest of Phase 1. Phase 7 deletes it entirely after all consumers move to `@/lib/domain` imports.

**Files:**
- Modify: `lib/doc/types.ts`

- [ ] **Step 1: Replace its contents**

```ts
// lib/doc/types.ts
//
// DEPRECATED: this file is a re-export shim from the domain layer for
// Phase 1's in-flight migration. Consumers should import from
// `@/lib/domain` directly. Phase 7 deletes this file.

export type {
  Uuid,
  Module as ModuleEntity,
  Form as FormEntity,
  Field as QuestionEntity,
  BlueprintDoc,
} from "@/lib/domain";
export { asUuid } from "@/lib/domain";

import type { Uuid } from "@/lib/domain";
import type { CaseType, ConnectType, Field, Form, Module } from "@/lib/domain";

// ─── Mutation union ────────────────────────────────────────────────────
//
// Identical to the current Mutation union but with question→field renamed
// throughout. `replaceForm` retains its `questionOrder` key for Phase 1
// backward-compat; Phase 2 kills replaceForm entirely.

export type Mutation =
  // Module
  | { kind: "addModule"; module: Module; index?: number }
  | { kind: "removeModule"; uuid: Uuid }
  | { kind: "moveModule"; uuid: Uuid; toIndex: number }
  | { kind: "renameModule"; uuid: Uuid; newId: string }
  | { kind: "updateModule"; uuid: Uuid; patch: Partial<Omit<Module, "uuid">> }
  // Form
  | { kind: "addForm"; moduleUuid: Uuid; form: Form; index?: number }
  | { kind: "removeForm"; uuid: Uuid }
  | { kind: "moveForm"; uuid: Uuid; toModuleUuid: Uuid; toIndex: number }
  | { kind: "renameForm"; uuid: Uuid; newId: string }
  | { kind: "updateForm"; uuid: Uuid; patch: Partial<Omit<Form, "uuid">> }
  | {
      kind: "replaceForm";
      uuid: Uuid;
      form: Form;
      fields: Field[];            // renamed from `questions`
      fieldOrder: Record<Uuid, Uuid[]>; // renamed from `questionOrder`
    }
  // Field
  | { kind: "addField"; parentUuid: Uuid; field: Field; index?: number }
  | { kind: "removeField"; uuid: Uuid }
  | { kind: "moveField"; uuid: Uuid; toParentUuid: Uuid; toIndex: number }
  | { kind: "renameField"; uuid: Uuid; newId: string }
  | { kind: "duplicateField"; uuid: Uuid }
  | { kind: "updateField"; uuid: Uuid; patch: Partial<Omit<Field, "uuid">> }
  // App-level
  | { kind: "setAppName"; name: string }
  | { kind: "setConnectType"; connectType: ConnectType | null }
  | { kind: "setCaseTypes"; caseTypes: CaseType[] | null };
```

- [ ] **Step 2: Commit**

```bash
git add lib/doc/types.ts
git commit -m "refactor(doc): re-export types from domain; rename question→field in Mutation"
```

---

## Task 11: Update `lib/doc/store.ts` reducer — rename + `fieldParent` maintenance

Every `question*` handler → `field*`. The reducer now rebuilds `fieldParent` on every mutation that touches `fieldOrder` (addField, removeField, moveField, replaceForm, duplicateField, load).

**Files:**
- Modify: `lib/doc/store.ts`

- [ ] **Step 1: Rename reducer cases and update `BlueprintDoc.questions`/`questionOrder` to `fields`/`fieldOrder`**

Mechanical global renames inside `lib/doc/store.ts`:
- `state.questions` → `state.fields`
- `state.questionOrder` → `state.fieldOrder`
- `addQuestion` / `removeQuestion` / `moveQuestion` / `renameQuestion` / `duplicateQuestion` / `updateQuestion` case labels → `addField` / `removeField` / `moveField` / `renameField` / `duplicateField` / `updateField`
- Local variable `question` / `questions` → `field` / `fields`
- `replaceForm` body: read `fields` and `fieldOrder` instead of `questions` and `questionOrder`

- [ ] **Step 2: Add `rebuildFieldParent` helper**

At the top of `store.ts`:

```ts
import type { BlueprintDoc, Uuid } from "@/lib/domain";

/** Rebuild the fieldParent reverse index from formOrder + fieldOrder.
 *  Called on load and after any structural change that touches ordering.
 *  This is O(total fields) — acceptable on mutation because the number of
 *  mutations per user interaction is small. */
export function rebuildFieldParent(doc: BlueprintDoc): void {
  doc.fieldParent = {} as Record<Uuid, Uuid | null>;

  // Every field uuid that appears as a child of some parent gets that
  // parent recorded. Parents are either form uuids (for top-level fields)
  // or container-field uuids (for nested fields under group/repeat).
  for (const [parentUuid, fieldUuids] of Object.entries(doc.fieldOrder)) {
    for (const fieldUuid of fieldUuids) {
      doc.fieldParent[fieldUuid as Uuid] = parentUuid as Uuid;
    }
  }

  // Orphan guard: any field in doc.fields that doesn't appear in any
  // fieldOrder entry gets null. In a well-formed doc this never fires,
  // but it's cheap insurance against bugs that would otherwise leave
  // parent lookup undefined.
  for (const uuid of Object.keys(doc.fields)) {
    if (!(uuid in doc.fieldParent)) doc.fieldParent[uuid as Uuid] = null;
  }
}
```

- [ ] **Step 3: Wire `rebuildFieldParent` into mutations**

In each reducer case that touches `fieldOrder` (`addField`, `removeField`, `moveField`, `replaceForm`, `duplicateField`, plus `load`), call `rebuildFieldParent(state)` at the end of the case.

- [ ] **Step 4: Run existing doc tests**

```bash
npm test -- lib/doc/__tests__ --run
```

Expected: some fail because they reference `question` identifiers. Fix those test names in Task 12.

- [ ] **Step 5: Commit**

```bash
git add lib/doc/store.ts
git commit -m "refactor(doc): rename question→field in store reducer; add fieldParent index"
```

---

## Task 12: Rename `lib/doc/hooks/` files and update exports

Rename `useQuestion.ts` → `useField.ts`, `useOrderedQuestions.ts` → `useOrderedFields.ts`, etc. Update every exported identifier.

**Files:**
- Rename: `lib/doc/hooks/useQuestion.ts` → `lib/doc/hooks/useField.ts`
- Rename: `lib/doc/hooks/useOrderedQuestions.ts` → `lib/doc/hooks/useOrderedFields.ts`
- Rename: `lib/doc/hooks/useQuestionTree.ts` → `lib/doc/hooks/useFieldTree.ts`
- Modify: `lib/doc/hooks/index.ts` — update exports
- Add: `lib/doc/hooks/useParent.ts` — reads `fieldParent`
- Add: `lib/doc/hooks/useAncestors.ts` — walks `fieldParent` to root

- [ ] **Step 1: Rename files**

```bash
git mv lib/doc/hooks/useQuestion.ts lib/doc/hooks/useField.ts
git mv lib/doc/hooks/useOrderedQuestions.ts lib/doc/hooks/useOrderedFields.ts
git mv lib/doc/hooks/useQuestionTree.ts lib/doc/hooks/useFieldTree.ts
# Rename test files too:
git mv lib/doc/hooks/__tests__/useQuestion.test.ts lib/doc/hooks/__tests__/useField.test.ts
# etc. for every test file
```

- [ ] **Step 2: Rename exported hooks**

Inside each renamed file, rename:
- `useQuestion` → `useField`
- `useOrderedQuestions` → `useOrderedFields`
- `useQuestionTree` → `useFieldTree`

Update JSDoc to say "field" instead of "question."

- [ ] **Step 3: Create `useParent` and `useAncestors`**

```ts
// lib/doc/hooks/useParent.ts
import { useBlueprintDoc } from "../store";
import type { Uuid } from "@/lib/domain";

/** Returns the parent uuid of `fieldUuid` (form or container), or null. */
export function useParent(fieldUuid: Uuid): Uuid | null {
  return useBlueprintDoc((s) => s.fieldParent[fieldUuid] ?? null);
}
```

```ts
// lib/doc/hooks/useAncestors.ts
import { useMemo } from "react";
import { useBlueprintDoc } from "../store";
import type { Uuid } from "@/lib/domain";

/** Walks fieldParent from `fieldUuid` upward, returning the chain from
 *  immediate parent to the containing form. Does not include the field
 *  itself. */
export function useAncestors(fieldUuid: Uuid): Uuid[] {
  const parentIndex = useBlueprintDoc((s) => s.fieldParent);
  return useMemo(() => {
    const chain: Uuid[] = [];
    let current: Uuid | null = parentIndex[fieldUuid] ?? null;
    while (current) {
      chain.push(current);
      current = parentIndex[current] ?? null;
    }
    return chain;
  }, [fieldUuid, parentIndex]);
}
```

- [ ] **Step 4: Update `lib/doc/hooks/index.ts`**

Re-export all renamed hooks. Remove old names. Add new `useParent`, `useAncestors`.

- [ ] **Step 5: Run tests**

```bash
npm test -- lib/doc/hooks/__tests__ --run
```

Expected: failures from tests that still reference old names. Fix test names + inner symbols in the same commit.

- [ ] **Step 6: Commit**

```bash
git add lib/doc/hooks/
git commit -m "refactor(doc): rename question→field in hooks; add useParent + useAncestors"
```

---

## Task 13: Update `lib/doc/loader.ts` and autosave to use normalized Firestore

Replace `toDoc(bp)` / `toBlueprint(doc)` with direct reads/writes of the normalized `BlueprintDoc`.

**Files:**
- Modify: `lib/doc/loader.ts` (or whatever currently fetches + converts)
- Modify: `lib/doc/hooks/useAutoSave.ts` (will move to `lib/doc/hooks/` if currently top-level)

Find all callers of `toDoc` and `toBlueprint`:
```bash
rg "toDoc|toBlueprint" --type ts --type tsx
```

- [ ] **Step 1: Find the loader**

```bash
rg "toDoc\(" lib/ app/
```

Identify the one or two places that fetch from Firestore, parse, and hand off to the store. Typical path: `lib/doc/loader.ts` or `app/build/[id]/...page.tsx`.

- [ ] **Step 2: Replace converter calls**

Every `toDoc(rawBlueprint)` → `blueprintDocSchema.parse(rawDoc)` + `rebuildFieldParent(doc)`. Every `toBlueprint(doc)` → write `doc` directly (no transformation).

- [ ] **Step 3: Verify auto-save shape**

Open `useAutoSave` (or equivalent). It currently does something like:
```ts
const blueprint = toBlueprint(doc);
await setDoc(appRef, blueprint);
```
Replace with:
```ts
const { fieldParent, ...persistableDoc } = doc;
await setDoc(appRef, persistableDoc);
```

- [ ] **Step 4: Run the app locally to confirm load/save works**

```bash
npm run dev
```

Open an existing app in the browser. If the Firestore doc still has the legacy nested shape, the load will fail — that's expected until the migration runs in Task 19. For now, create a brand-new app in the UI and verify it saves + reloads.

- [ ] **Step 5: Commit**

```bash
git add lib/doc/loader.ts lib/doc/hooks/useAutoSave.ts
git commit -m "refactor(doc): Firestore reads/writes normalized BlueprintDoc directly"
```

---

## Task 14: Delete `lib/doc/converter.ts` and `lib/services/normalizedState.ts`

Both are replaced by the domain-direct approach.

**Files:**
- Delete: `lib/doc/converter.ts`
- Delete: `lib/services/normalizedState.ts`

- [ ] **Step 1: Verify no remaining imports**

```bash
rg "from.*converter|from.*normalizedState" --type ts --type tsx
```

Expected: no results. Fix any stragglers.

- [ ] **Step 2: Delete both files**

```bash
git rm lib/doc/converter.ts
git rm lib/services/normalizedState.ts
```

- [ ] **Step 3: Run full type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: delete converter.ts and normalizedState.ts"
```

---

## Task 15: Update `lib/services/blueprintHelpers.ts` to operate on normalized doc

Every helper function currently takes an `AppBlueprint` and mutates the nested shape. Rewrite to take `BlueprintDoc` and emit `Mutation[]` (or call the store's `applyMany` directly). Keep the file under `lib/services/` for now — Phase 3 moves it to `lib/agent/`.

**Files:**
- Modify: `lib/services/blueprintHelpers.ts` heavily

- [ ] **Step 1: Inventory helpers**

```bash
rg "^export (async )?function" lib/services/blueprintHelpers.ts
```

Expected: ~30 helpers (bpAddModule, bpAddForm, bpAddQuestion, bpSetScaffold, etc.).

- [ ] **Step 2: Rewrite each helper**

For each function:
1. Change its signature from `(bp: AppBlueprint, ...) => AppBlueprint` to one of:
   - `(doc: BlueprintDoc, ...) => Mutation[]` (pure — caller applies).
   - `(docStore: DocStoreApi, ...) => void` (impure — helper applies directly).
2. Rename `question`→`field` in the body.
3. Change `bp.modules[mIdx].forms[fIdx].questions.push(...)` style edits to construct `Mutation` objects.

The detailed rewrite per helper is too long for this plan — do them one at a time with tight tests (every helper should have a unit test; add missing ones).

- [ ] **Step 3: Run the SA integration tests**

```bash
npm test -- lib/services/__tests__ --run
```

Expect many failures until the SA tool handlers (Task 17) also update.

- [ ] **Step 4: Commit helper rewrites in logical chunks**

Commit every 3–5 helpers with a message like:
```bash
git commit -m "refactor(services): blueprintHelpers — migrate module helpers to doc shape"
```

---

## Task 16: Rewrite `case_property_on` → `case_property` across the domain

The wire-format SA tool schema keeps `case_property_on` (for backward compat with the SA prompt + existing fixture logs). Everywhere else, rename to `case_property`.

**Files:**
- Find: `rg "case_property_on" --type ts --type tsx`

- [ ] **Step 1: Inventory usages**

```bash
rg "case_property_on" --type ts --type tsx | wc -l
```

Typical count: 30–50 sites.

- [ ] **Step 2: Categorize**

- In `lib/services/solutionsArchitect.ts` and `lib/schemas/toolSchemas.ts`: **keep** as `case_property_on` (wire format to SA).
- In `lib/prompts/solutionsArchitectPrompt.ts`: **keep** — SA reads the wire format.
- Everywhere else: **rename** to `case_property`.

- [ ] **Step 3: Add boundary translation**

In the SA tool handler that receives a `case_property_on` argument, translate to `case_property` before calling into blueprintHelpers:

```ts
// lib/services/solutionsArchitect.ts — inside the addQuestions tool handler
const fieldForDoc: Field = {
  ...toolQuestion,
  case_property: toolQuestion.case_property_on,
};
// case_property_on is stripped because the Field schema doesn't include it.
```

- [ ] **Step 4: Run tests**

```bash
npx tsc --noEmit
npm test -- --run
```

Fix fallout. Some tests assert `case_property_on` on the in-memory doc — those tests now need to assert `case_property`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: rename case_property_on → case_property in internal domain"
```

---

## Task 17: Update `lib/services/solutionsArchitect.ts` tool handlers

Every tool handler that returned a new/updated `Question` now returns a new/updated `Field`. Translate wire field names at the boundary.

**Files:**
- Modify: `lib/services/solutionsArchitect.ts`

- [ ] **Step 1: Find every "Question" reference**

```bash
rg "Question" lib/services/solutionsArchitect.ts
```

- [ ] **Step 2: Map to "Field"**

- `QuestionEntity` / `Question` type annotations → `Field`.
- Variable names `question` / `questions` → `field` / `fields`.
- Tool-schema field names (the JSON the SA emits): **keep** `case_property_on` as-is (boundary compat). Other wire field names (`validation`, `validation_msg`, etc.) map 1:1 to domain fields with the same name — no translation needed.

- [ ] **Step 3: Handle the `children` → `fieldOrder` conversion**

The current SA emits nested `Question.children[]` in its tool output. Until Phase 3's mutation mapper replaces this, preserve the nested shape on wire and flatten it at the tool-handler boundary:

```ts
// Inside the tool handler that receives SA output:
function flattenSaQuestionTree(
  nested: SaQuestion,
  parentUuid: Uuid,
  out: { fields: Field[]; fieldOrder: Record<Uuid, Uuid[]> },
): void {
  const uuid = asUuid(crypto.randomUUID());
  const field: Field = toField(nested, uuid); // strips children, converts case_property_on → case_property, etc.
  out.fields.push(field);
  out.fieldOrder[parentUuid] ??= [];
  out.fieldOrder[parentUuid].push(uuid);
  if (nested.children?.length && (nested.type === "group" || nested.type === "repeat")) {
    for (const child of nested.children) {
      flattenSaQuestionTree(child, uuid, out);
    }
  }
}
```

- [ ] **Step 4: Run SA tests**

```bash
npm test -- lib/services/__tests__/formBuilderAgent.test.ts --run
```

Expect passes.

- [ ] **Step 5: Commit**

```bash
git add lib/services/solutionsArchitect.ts
git commit -m "refactor(sa): tool handlers consume Field; flatten SA nested questions at boundary"
```

---

## Task 18: Update SA prompt text to say "field"

Every internal-to-us mention of "question" in prompts, tool descriptions, and docs becomes "field." CommCare-facing terminology (the SA producing outputs that go to CommCare) stays as-is.

**Files:**
- Modify: `lib/prompts/solutionsArchitectPrompt.ts`
- Modify: `lib/schemas/toolSchemas.ts` (tool `description` strings, not field names)

- [ ] **Step 1: Find the prompt file**

```bash
rg "questions" lib/prompts/solutionsArchitectPrompt.ts | head -30
```

- [ ] **Step 2: Replace mentions**

Rules:
- "question" → "field" (lowercase) in sentences describing our internal model.
- "Question" → "Field" in type-name-like references.
- CommCare-specific phrases (e.g. "CommCare uses the term question in its XForm grammar") stay.
- Section headers like "### Question Types" → "### Field Types".

- [ ] **Step 3: Update tool descriptions**

In `lib/schemas/toolSchemas.ts`, every `.describe("... question ...")` becomes `.describe("... field ...")`. The tool field names themselves (`case_property_on`, `required`, `validation`, etc.) are unchanged — they are the SA's wire format.

- [ ] **Step 4: Run SA fixture tests**

```bash
npm test -- lib/services/__tests__/solutionsArchitect --run
```

The SA's model outputs won't differ because the wire field names haven't changed.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts/solutionsArchitectPrompt.ts lib/schemas/toolSchemas.ts
git commit -m "refactor(sa): update prompt and tool descriptions to say 'field'"
```

---

## Task 19: Write the one-time Firestore migration script

Converts every `AppBlueprint`-shaped app doc in Firestore to the new normalized `BlueprintDoc` shape.

**Files:**
- Create: `scripts/migrate-to-normalized-doc.ts`

- [ ] **Step 1: Write the script**

```ts
// scripts/migrate-to-normalized-doc.ts
//
// One-time migration: reads every app doc from Firestore, converts the
// legacy nested AppBlueprint shape to the normalized BlueprintDoc shape,
// writes it back. Idempotent — if a doc is already normalized (detected
// by presence of top-level `fields` key), skip.
//
// Usage:
//   npx tsx scripts/migrate-to-normalized-doc.ts [--dry-run] [--app-id=abc]

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { asUuid, blueprintDocSchema, type BlueprintDoc, type Uuid } from "@/lib/domain";

const dryRun = process.argv.includes("--dry-run");
const appIdFilter = process.argv.find((a) => a.startsWith("--app-id="))?.slice("--app-id=".length);

function legacyAppBlueprintToDoc(appId: string, legacy: any): BlueprintDoc {
  // Walk the nested tree, minting UUIDs where missing, flattening into
  // the normalized shape. Reuses logic from the deleted converter.ts —
  // inline it here so the script is self-contained.
  const modules: BlueprintDoc["modules"] = {};
  const forms: BlueprintDoc["forms"] = {};
  const fields: BlueprintDoc["fields"] = {};
  const moduleOrder: Uuid[] = [];
  const formOrder: Record<Uuid, Uuid[]> = {};
  const fieldOrder: Record<Uuid, Uuid[]> = {};

  for (const mod of legacy.modules ?? []) {
    const moduleUuid = asUuid(mod.uuid ?? crypto.randomUUID());
    moduleOrder.push(moduleUuid);
    modules[moduleUuid] = {
      uuid: moduleUuid,
      id: mod.id ?? mod.name.toLowerCase().replace(/\s+/g, "_"),
      name: mod.name,
      caseType: mod.case_type,
      caseListOnly: mod.case_list_only,
      purpose: mod.purpose,
      caseListColumns: mod.case_list_columns,
      caseDetailColumns: mod.case_detail_columns,
    };
    formOrder[moduleUuid] = [];

    for (const form of mod.forms ?? []) {
      const formUuid = asUuid(form.uuid ?? crypto.randomUUID());
      formOrder[moduleUuid].push(formUuid);
      forms[formUuid] = {
        uuid: formUuid,
        id: form.id ?? form.name.toLowerCase().replace(/\s+/g, "_"),
        name: form.name,
        type: form.type,
        purpose: form.purpose,
        closeCondition: form.close_condition
          ? {
              field: form.close_condition.question, // renamed
              answer: form.close_condition.answer,
              operator: form.close_condition.operator,
            }
          : undefined,
        connect: form.connect,
        postSubmit: form.post_submit,
        formLinks: form.form_links?.map((link: any) => ({
          ...link,
          // Translate form_link target moduleIndex/formIndex → uuids via
          // the already-minted moduleOrder/formOrder maps.
          target: migrateFormLinkTarget(link.target, moduleOrder, formOrder),
        })),
      };
      fieldOrder[formUuid] = [];

      function walk(questions: any[], parentUuid: Uuid) {
        for (const q of questions ?? []) {
          const fieldUuid = asUuid(q.uuid ?? crypto.randomUUID());
          fieldOrder[parentUuid].push(fieldUuid);
          const fieldObj: any = {
            kind: q.type,
            uuid: fieldUuid,
            id: q.id,
            label: q.label,
            hint: q.hint,
            required: q.required,
            relevant: q.relevant,
            case_property: q.case_property_on, // renamed
          };
          // Pull in kind-specific fields.
          if (q.validation !== undefined) fieldObj.validate = q.validation;
          if (q.validation_msg !== undefined) fieldObj.validate_msg = q.validation_msg;
          if (q.calculate !== undefined) fieldObj.calculate = q.calculate;
          if (q.default_value !== undefined) fieldObj.default_value = q.default_value;
          if (q.options !== undefined) fieldObj.options = q.options;

          fields[fieldUuid] = fieldObj;

          if (q.children?.length && (q.type === "group" || q.type === "repeat")) {
            fieldOrder[fieldUuid] = [];
            walk(q.children, fieldUuid);
          }
        }
      }
      walk(form.questions, formUuid);
    }
  }

  return {
    appId,
    appName: legacy.app_name,
    connectType: legacy.connect_type ?? null,
    caseTypes: legacy.case_types ?? null,
    modules,
    forms,
    fields,
    moduleOrder,
    formOrder,
    fieldOrder,
    fieldParent: {} as Record<Uuid, Uuid | null>, // derived on load; not persisted
  };
}

function migrateFormLinkTarget(
  legacyTarget: any,
  moduleOrder: Uuid[],
  formOrder: Record<Uuid, Uuid[]>,
): any {
  if (legacyTarget.type === "module") {
    return { type: "module", moduleUuid: moduleOrder[legacyTarget.moduleIndex] };
  }
  if (legacyTarget.type === "form") {
    const moduleUuid = moduleOrder[legacyTarget.moduleIndex];
    const formUuid = formOrder[moduleUuid][legacyTarget.formIndex];
    return { type: "form", moduleUuid, formUuid };
  }
  return legacyTarget;
}

async function main() {
  initializeApp({
    credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8"))),
  });
  const db = getFirestore();

  const snapshot = appIdFilter
    ? await db.collection("apps").where("__name__", "==", appIdFilter).get()
    : await db.collection("apps").get();

  let migrated = 0;
  let skipped = 0;

  for (const docRef of snapshot.docs) {
    const data = docRef.data();

    // Already migrated? Skip.
    if ("fields" in data && "fieldOrder" in data) {
      skipped++;
      continue;
    }

    const doc = legacyAppBlueprintToDoc(docRef.id, data);

    // Validate the result.
    const parsed = blueprintDocSchema.parse({ ...doc });
    // (fieldParent omitted — not persisted)
    const { fieldParent, ...persistable } = doc;

    if (dryRun) {
      console.log(`[dry-run] would migrate ${docRef.id}: ${Object.keys(doc.fields).length} fields`);
    } else {
      await docRef.set(persistable, { merge: false });
      console.log(`Migrated ${docRef.id}: ${Object.keys(doc.fields).length} fields`);
    }
    migrated++;
  }

  console.log(`Done. Migrated: ${migrated}, Skipped: ${skipped}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Test against a dev Firestore**

```bash
npx tsx scripts/migrate-to-normalized-doc.ts --dry-run
```

Expected: prints "would migrate" for every legacy app, "skipped" for any already-normalized. No writes.

- [ ] **Step 3: Write a unit test against a fixture legacy blueprint**

```ts
// scripts/__tests__/migrate-to-normalized-doc.test.ts
import { describe, it, expect } from "vitest";
import { legacyAppBlueprintToDoc } from "../migrate-to-normalized-doc";
import fixture from "./fixtures/legacy-blueprint.json";

describe("legacyAppBlueprintToDoc", () => {
  it("produces a valid BlueprintDoc from a legacy nested blueprint", () => {
    const doc = legacyAppBlueprintToDoc("test-app", fixture);
    expect(Object.keys(doc.modules).length).toBeGreaterThan(0);
    expect(Object.keys(doc.fields).length).toBeGreaterThan(0);
    // fieldOrder keys must all appear in formOrder values OR fields (for nested)
    // …additional invariants
  });
});
```

Export `legacyAppBlueprintToDoc` from the script so the test can import it. Capture a real legacy blueprint from Firestore as the fixture.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-to-normalized-doc.ts scripts/__tests__/
git commit -m "feat(scripts): add one-time Firestore migration to normalized doc"
```

---

## Task 20: Stub empty `lib/commcare/` directory

Creates the directory so future phases can reference the import boundary. Phase 2+ populates it.

**Files:**
- Create: `lib/commcare/index.ts`
- Create: `lib/commcare/CLAUDE.md`

- [ ] **Step 1: Write the placeholder**

```ts
// lib/commcare/index.ts
//
// The one-way bridge from our normalized domain to CommCare's wire
// formats. THIS PACKAGE IS THE ONLY PLACE in lib/ that imports
// CommCare-specific vocabulary (question, case_property_on, etc.).
//
// In Phase 1 this directory is empty. Phase 2+ populates it by moving
// lib/services/cczCompiler, hqJsonExpander, lib/transpiler, and
// lib/services/commcare/validate/ here.

export {};
```

```md
# lib/commcare

One-way emission boundary. Nothing else in `lib/` imports from here
except at the compile/upload entry points. This package is the only
place that knows CommCare's wire vocabulary.

Currently empty in Phase 1 — future phases populate it.
```

- [ ] **Step 2: Commit**

```bash
git add lib/commcare/
git commit -m "feat(commcare): stub lib/commcare/ package"
```

---

## Task 21: Rename `Question` → `Field` everywhere else (components, app, tests)

The big mechanical pass. Every TSX/TS file outside `lib/commcare/`, `lib/prompts/`, `lib/schemas/toolSchemas.ts`, and `lib/services/solutionsArchitect.ts` (which keep wire-format terms) renames:

- Type: `Question` → `Field`, `QuestionEntity` → `Field`
- Type: `QuestionRow` → `FieldRow` (component), `QuestionRenderer` → `FieldRenderer`
- Variables: `question` → `field`, `questions` → `fields`, `questionUuid` → `fieldUuid`, `questionOrder` → `fieldOrder`
- Hooks: `useQuestion` → `useField`, `useOrderedQuestions` → `useOrderedFields`
- Props: `questionId` → `fieldId`, `questionUuid` → `fieldUuid`

**Files to touch:**
- `components/builder/**`
- `components/preview/**`
- `components/chat/**`
- `hooks/**` (top-level `/hooks/` — stays in this phase, rename only)
- `app/**`
- Every `__tests__` folder

- [ ] **Step 1: Inventory**

```bash
rg -c "\\bQuestion\\b|\\bquestion\\b" components/ app/ hooks/ | head -30
```

Expect 100+ files.

- [ ] **Step 2: Do the rename in subdirectories, one commit per area**

Strategy: use `sed -i '' 's/Question/Field/g'` cautiously (it renames everything, including comments and strings) — but be aware this over-captures. Better: use the editor's project-wide rename tools, reviewing each change.

Alternative approach: use TypeScript's compiler API via `ts-morph` for a structural rename. A short script:

```ts
// scripts/rename-question-to-field.ts (keep after migration as a reference)
import { Project } from "ts-morph";
const project = new Project({ tsConfigFilePath: "./tsconfig.json" });
for (const file of project.getSourceFiles([
  "components/**/*.{ts,tsx}",
  "app/**/*.{ts,tsx}",
  "hooks/**/*.{ts,tsx}",
])) {
  // Rename types
  file.getInterfaces().forEach((i) => {
    if (i.getName() === "Question") i.rename("Field");
  });
  file.getTypeAliases().forEach((t) => {
    if (t.getName() === "QuestionEntity") t.rename("Field");
  });
  // Rename identifiers
  file.getVariableDeclarations().forEach((v) => {
    // Skip CommCare boundary terms
    if (v.getName() === "question") v.rename("field");
    if (v.getName() === "questions") v.rename("fields");
    // etc.
  });
}
project.saveSync();
```

Run this script once, then review the diff carefully.

- [ ] **Step 3: Handle special cases**

- `SelectOption` - no change (CommCare wire term, not a "question").
- `useQuestion` inside `lib/services/solutionsArchitect.ts` — leave as `question` where it refers to SA tool output (wire shape).
- `questionTypeConversions.ts`, `questionTypeIcons.ts` in `lib/` — rename to `fieldTypeConversions.ts`, `fieldTypeIcons.ts` (and every internal identifier). Or delete if the registry now supplies the same data.

- [ ] **Step 4: Run build + tests**

```bash
npx tsc --noEmit
npm run lint
npm test -- --run
```

Fix every type error. Fix every test failure caused by renamed imports.

- [ ] **Step 5: Commit in logical chunks**

```bash
git add components/builder/
git commit -m "refactor(builder): rename question→field in components/builder"

git add components/preview/
git commit -m "refactor(preview): rename question→field in components/preview"

# etc. for components/chat, hooks, app, tests
```

---

## Task 22: Delete `lib/schemas/blueprint.ts`

Its types are now in `lib/domain/`. Any still-referencing callers (there should be zero after Task 21) are the bug.

**Files:**
- Delete: `lib/schemas/blueprint.ts`

- [ ] **Step 1: Verify no remaining imports**

```bash
rg "from \"@/lib/schemas/blueprint\"" --type ts --type tsx
```

Expected: empty output.

- [ ] **Step 2: Move `deriveCaseConfig` to its own file**

`deriveCaseConfig` (~100 lines at the bottom of `lib/schemas/blueprint.ts`) is a utility that's not strictly schema. Move it to `lib/services/deriveCaseConfig.ts` verbatim, updating imports. (Phase 3's job to find a better home — possibly `lib/commcare/`.)

```bash
# Create the new file, paste deriveCaseConfig + its local types
git add lib/services/deriveCaseConfig.ts
```

Update every import of `deriveCaseConfig` across the codebase.

- [ ] **Step 3: Delete the schema file**

```bash
git rm lib/schemas/blueprint.ts
```

- [ ] **Step 4: Final type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete lib/schemas/blueprint.ts; move deriveCaseConfig"
```

---

## Task 23: Replace `lib/types/` contents with re-exports from `lib/domain`

If `lib/types/` contains domain-specific types (Form, Module, Question), redirect them. Check each file.

**Files:**
- Inventory: `rg "export" lib/types/`
- Modify: every file in `lib/types/` that duplicates domain types

- [ ] **Step 1: Inventory what's in `lib/types/`**

```bash
ls lib/types/
```

For each file, decide:
- If it's a domain type (Question, Form, Module): replace with `export * from "@/lib/domain"` re-export, or delete and update callers.
- If it's a cross-cutting utility type: leave it.

- [ ] **Step 2: Commit**

```bash
git add lib/types/
git commit -m "refactor(types): redirect domain types to lib/domain"
```

---

## Task 24: Update `app/api/chat/route.ts` and adjacent route handlers

Any `toDoc` / `toBlueprint` calls in route handlers need removing. Any `Question` references need renaming.

**Files:**
- Modify: `app/api/chat/route.ts`
- Modify: `app/api/upload/route.ts` (if it calls `toBlueprint`)
- Modify: any other `app/api/*` handlers

- [ ] **Step 1: Find affected routes**

```bash
rg "toDoc|toBlueprint|QuestionEntity|case_property_on" app/api/
```

- [ ] **Step 2: Rewrite**

Remove converter calls. Update types. Preserve the wire-format boundary at the very outer edge (SA output, CommCare HQ upload).

- [ ] **Step 3: Run integration tests**

```bash
npm test -- app/api/__tests__ --run
```

- [ ] **Step 4: Commit**

```bash
git add app/api/
git commit -m "refactor(api): remove converter calls; migrate to Field"
```

---

## Task 25: Full-repo rename audit

Guarantees nothing was missed.

- [ ] **Step 1: Search for leftover `Question` in non-allow-listed paths**

```bash
rg "\\bQuestion\\b" \
  --type ts --type tsx \
  -g '!lib/commcare/**' \
  -g '!lib/prompts/**' \
  -g '!lib/schemas/toolSchemas.ts' \
  -g '!lib/services/solutionsArchitect.ts' \
  -g '!node_modules/**' \
  -g '!**/__tests__/fixtures/**' \
  | head -50
```

Expected: zero results.

If any remain, they are real holes — rename them.

- [ ] **Step 2: Search for leftover `question` lowercase**

```bash
rg "\\bquestion\\b" \
  --type ts --type tsx \
  -g '!lib/commcare/**' \
  -g '!lib/prompts/**' \
  -g '!lib/schemas/toolSchemas.ts' \
  -g '!lib/services/solutionsArchitect.ts' \
  -g '!node_modules/**' \
  -g '!**/__tests__/fixtures/**' \
  | head -50
```

Expected: zero (or allow-listed cases like "The SA's question-asking strategy" in comments, which are fine — they refer to conversational questions to the user, not blueprint fields).

- [ ] **Step 3: Commit any stragglers**

```bash
git add -A
git commit -m "refactor: rename audit — catch stragglers"
```

---

## Task 26: Add `fieldParent` integration tests

Verify the index is maintained correctly across every mutation.

**Files:**
- Create: `lib/doc/__tests__/fieldParent.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// lib/doc/__tests__/fieldParent.test.ts
import { describe, it, expect } from "vitest";
import { asUuid } from "@/lib/domain";
import { createDocStore } from "../store"; // adapt import name if different

function emptyDoc(appId = "test") {
  // Helper: make a baseline doc with one module + one form + no fields.
  // Adjust to match real store API.
}

describe("fieldParent index", () => {
  it("addField sets parent to the form uuid", () => {
    const store = createDocStore(/* ... */);
    const formUuid = asUuid("form-1");
    const fieldUuid = asUuid("f-1");
    // seed
    store.applyMany([
      { kind: "addField", parentUuid: formUuid, field: { kind: "text", uuid: fieldUuid, id: "age", label: "Age" } },
    ]);
    expect(store.getState().fieldParent[fieldUuid]).toBe(formUuid);
  });

  it("moveField updates the parent atomically", () => { /* ... */ });
  it("removeField removes the entry", () => { /* ... */ });
  it("duplicateField registers the new parent", () => { /* ... */ });
  it("replaceForm rebuilds all affected parents", () => { /* ... */ });
  it("load rebuilds the full index", () => { /* ... */ });
  it("nested fields (group/repeat) have the container as parent", () => { /* ... */ });
});
```

- [ ] **Step 2: Run**

```bash
npm test -- lib/doc/__tests__/fieldParent.test.ts --run
```

- [ ] **Step 3: Commit**

```bash
git add lib/doc/__tests__/fieldParent.test.ts
git commit -m "test(doc): fieldParent index invariants across mutations"
```

---

## Task 27: Run migration against staging Firestore (dry run)

Before merging, validate the migration script against real production-shaped data in a staging environment.

- [ ] **Step 1: Export staging Firestore backup**

```bash
gcloud firestore export gs://commcare-nova-staging-backups/pre-phase-1
```

- [ ] **Step 2: Run dry-run**

```bash
GOOGLE_APPLICATION_CREDENTIALS=./staging-key.json \
  npx tsx scripts/migrate-to-normalized-doc.ts --dry-run
```

Inspect every "would migrate" line. Check field counts line up with expectations.

- [ ] **Step 3: Run on a single test app**

```bash
npx tsx scripts/migrate-to-normalized-doc.ts --app-id=<test-app-id>
```

Then reload the app in the browser — verify it renders identically to pre-migration.

- [ ] **Step 4: Commit any script tweaks discovered**

```bash
git add scripts/migrate-to-normalized-doc.ts
git commit -m "fix(migrate): [whatever tweak the dry-run revealed]"
```

---

## Task 28: Final full-suite verification

- [ ] **Step 1: Type-check**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
```

- [ ] **Step 2: Lint**

```bash
npm run lint && echo "✓ lint clean"
```

- [ ] **Step 3: Build**

```bash
npm run build && echo "✓ build clean"
```

- [ ] **Step 4: Tests**

```bash
npm test -- --run
```

Expected: passing count ≥ baseline (from Task 1). Any new failures are real and must be fixed before completing this task.

- [ ] **Step 5: Manual smoke**

Start the dev server:

```bash
npm run dev
```

Then in the browser:

- Open an app that was migrated by the script. Confirm it renders without errors.
- Add a new text field. Confirm it saves.
- Rename the field. Confirm rename persists after refresh.
- Delete the field. Confirm it's gone after refresh.
- Create a new blank app. Generate a short blueprint via the SA. Confirm every tool call succeeds and the app shape is correct.
- Trigger undo after the SA run. Confirm full revert.

Document any bugs found; fix in follow-up commits before opening the PR.

- [ ] **Step 6: Commit marker**

```bash
git commit --allow-empty -m "chore: phase 1 verification complete"
```

---

## Task 29: Open PR to main

- [ ] **Step 1: Push the branch**

```bash
git push -u origin refactor/phase-1-domain-rename
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "refactor: phase 1 — domain layer + rename + normalized Firestore" --body "$(cat <<'EOF'
## Summary

Phase 1 of 7 from `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`.

- Adds `lib/domain/` with per-kind field files (19 kinds), `Field` discriminated union, `fieldRegistry`, `fieldEditorSchemas`.
- Renames `Question`→`Field`, `question`→`field`, `questionOrder`→`fieldOrder`, `case_property_on`→`case_property` across the internal domain.
- Adds `fieldParent` reverse index, maintained atomically by every mutation.
- Deletes `AppBlueprint`, converters, `lib/schemas/blueprint.ts`, `lib/services/normalizedState.ts`.
- Firestore now stores the normalized doc directly.
- One-time migration script at `scripts/migrate-to-normalized-doc.ts`.

## Test plan

- [x] Unit tests pass (≥ baseline count).
- [x] Schema round-trip tests for every field kind.
- [x] `fieldParent` index invariants across all mutations.
- [x] Migration script dry-run produces expected output against staging.
- [ ] Single-app migration verified in staging browser.
- [ ] Full-staging migration scheduled for merge day.

## Deployment

Before merge: run migration script against production Firestore.
After merge: new writes use the normalized shape directly.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Pause for review**

Do not merge until the PR is reviewed and the production Firestore migration is scheduled.

---

## What Phase 2 picks up

After Phase 1 lands:
- `replaceForm` still exists — Phase 2 kills it.
- `notify*` mutations still exist — Phase 2 kills them.
- `lib/services/blueprintHelpers.ts` still holds doc-mutating helpers — Phase 3 moves them into `lib/agent/`.
- SA tool schemas still hand-written — Phase 3 generates them from `fieldRegistry`.
- Event log still dual — Phase 4.
- Declarative editor still stubs — Phase 5.
- Top-level `/hooks/` still exists — Phase 6.

Phase 2's implementation plan gets written after Phase 1 lands and exact file paths / mutation names are locked in.
