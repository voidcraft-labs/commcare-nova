# Builder Foundation Re-architecture — Design Spec

**Date:** 2026-04-16
**Status:** Approved for planning
**Scope:** Domain model, mutation API, event log, UI architecture, lib topology.
**Supersedes:** partial outcomes of `2026-04-12-builder-state-rearchitecture-design.md`.

---

## Problem

The April 12 re-architecture delivered `BlueprintDoc` + `BuilderSession`, dissolved `BuilderEngine`, and moved navigation to the URL. Those wins are real. But the spec stopped short of fixing the domain model, didn't enforce its own subscription rule, and left several foundational shapes duplicated. Eight issues remain:

1. **The domain model is weakly typed.** `Question` is a single flat shape accommodating 19 heterogeneous kinds. `group.validate` and `text.options` are both accessible without a type error. Per-kind capabilities live as scattered conditionals, set-membership checks, and parallel tables across five or more files. Adding a new kind touches schema, SA prompt, validation rules, compiler, and UI editor — no single source of truth.

2. **Entity data exists in three shapes.** `BlueprintDoc` (normalized, camelCase, branded UUIDs), `AppBlueprint` (nested, snake_case, Firestore wire format), and `normalizedState` (a compat layer for pre-refactor consumers). Every field touches three files plus their converters.

3. **Agent and user mutations are asymmetric.** Users emit fine-grained `updateQuestion`, `moveQuestion`. The SA emits `replaceForm` (wholesale). Events flow through different shapes, replay runs its own reconstruction path, and a future API/MCP client cannot reuse either.

4. **Event log is dual.** A `StoredEvent` stream captures SA emissions for replay. Thread messages hold chat history. The mutation stream is implicit in `applyMany` calls. Replay (`logReplay.ts`, 376 lines) reconstructs progressive state because no mutation record exists on disk.

5. **Selector discipline — the last refactor's flagship rule — was never enforced.** Fifteen-plus call sites still pass inline selector functions to `useBlueprintDoc`. The Biome rule bans raw store imports, not selector functions.

6. **Hooks are organizationally homeless.** Top-level `/hooks/` mixes save, edit, form-engine, navigation, and keyboard-shortcut concerns. Store-owning hooks live inside `lib/doc/hooks/`, but consumers drift toward the top-level directory because it's shorter to import.

7. **God components remain.** `FormSettingsPanel` (1360 lines) bundles form metadata, connect config, case config, and case-list UI. `AppTree` (983) mixes tree rendering, selection, and context menu. `VirtualFormList` (831) holds a 243-line drag-lifecycle effect. Per-kind property editors are hand-wired across `ContextualEditorData` / `Logic` / `UI`.

8. **CommCare's "question" vocabulary leaks into our domain.** A hidden binding is not a question. A group is not a question. The word is CommCare's naming choice and has no purpose in our internal model.

Every remaining pain point traces back to one of these eight. The architecture as delivered is clean enough to build on, but the eight gaps above are each worth fixing before the next surface (API, MCP, additional SA capabilities) lands on top of them.

## Goals

1. **One shape per concept.** One `Field` discriminated union for the domain. One `Mutation` union for state change. One `Event` type for the log. One normalized shape on disk and in memory.
2. **Types enforce invariants.** `GroupField.validate` fails to compile. Exhaustive `switch(field.kind)` catches missing cases at build time. Runtime invariants that can't be expressed cleanly in TS (e.g., a parent uuid must resolve to a container) are asserted in the reducer with typed errors, not scattered across call sites.
3. **Agent and user speak the same mutation API.** `applyMany(mutations)` is the only path to state change, regardless of actor. A future API/MCP client reuses the same surface.
4. **Registry drives behavior.** Compiler, validator, declarative editor, SA tool-schema generator all read from one per-kind metadata table. Adding a field kind is one file.
5. **Event log is unified, supplemental, and thin.** Two families (mutation, conversation) under one time-ordered stream. Blueprint snapshot stays authoritative; replay fits in ~30 lines.
6. **Subscription discipline is lint-enforced.** No inline selectors outside store-owning directories. No direct store imports outside store-owning directories. Named hook per read.
7. **"Question" disappears from our vocabulary.** Everything internal is `Field`. CommCare's wire formats keep their terms at the emission boundary only.
8. **UI is declarative where declarative is cheaper.** Field property editors are schema-driven. God components split along their natural concerns.

## Non-goals

- **Platform abstraction.** CommCare is the only target by definition. No plugin model, no generic form-builder core.
- **Full event sourcing.** Blueprint snapshot remains authoritative for state. Log is supplemental.
- **Changing framework choices.** Better Auth, Firestore, Zustand, Immer, zundo, Next.js, React, Tailwind, Base UI, Tiptap, Pragmatic DnD, `@tanstack/react-virtual` all stay.
- **Changing the SA's reasoning strategy, tool loop, or prompt-cache behavior.** Tool *schemas* change (generated from the registry; SA speaks "field"); prompt strategy does not.
- **Per-kind SA tools** (splitting `addQuestions` into `addTextField` / `addSelectField` / …). The generator is built to support both modes; we ship on `flat-sentinels` and leave the flip to a future PR.
- **Log compaction / archival.** Deferred.
- **Gradual migration.** No adapter layers, no runnable intermediate states. Big-bang in a worktree. Only the end state matters.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  URL  (/build/[id]/...path)                                     │
│  source of truth for location + selection                       │
└─────────────────────────────────────────────────────────────────┘
          │  useLocation(), useNavigate(), useSelect()
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  lib/domain/                                                    │
│  · Field = TextField | SingleSelectField | GroupField | ...    │
│  · One file per kind: TS type + Zod schema + metadata +        │
│    declarative editor schema                                    │
│  · ContainerField typed predicate                               │
│  · fieldRegistry[kind] — the one lookup table                   │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  lib/doc/   (Zustand + Immer + zundo + subscribeWithSelector)   │
│  · Normalized: modules, forms, fields tables                    │
│  · Ordering: moduleOrder, formOrder, fieldOrder                 │
│  · Index: fieldParent (maintained atomically)                   │
│  · Mutation<kind> — typed discriminated union                   │
│  · applyMany(mutations) — one call = atomic, one undo entry     │
│  · Named hooks only; lint-enforced                              │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  lib/session/  (ephemeral UI, mostly unchanged)                 │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  lib/log/                                                       │
│  · Event = MutationEvent | ConversationEvent                    │
│  · writer (Firestore sink) + reader (replay)                    │
│  · replay(events) ≈ 30 lines                                    │
└─────────────────────────────────────────────────────────────────┘
          │                                 │
          ▼                                 ▼
┌─────────────────────┐              ┌─────────────────────────┐
│  lib/agent/         │              │  lib/commcare/          │
│  · SA + prompts     │              │  · compiler (doc →      │
│  · toolSchemas      │              │    XForm XML)           │
│    (registry-gen)   │              │  · expander (→ HQ JSON) │
│  · mutationMapper   │              │  · validator            │
│  · validationLoop   │              │  · xpath/ (Lezer)       │
│  · autoFixer        │              │  · hq/ (client, upload) │
│  · errorClassifier  │              │  Only place that knows  │
│                     │              │  CommCare wire terms.   │
└─────────────────────┘              └─────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  components/                                                    │
│  · FieldEditorPanel (declarative, reads fieldRegistry[kind])    │
│  · VirtualFormList (shell; drag-intent hook extracted)          │
│  · Split: FormBasicSettings + FormConnectConfig + CaseConfig    │
│  · AppTree split: tree rendering + context menu                 │
└─────────────────────────────────────────────────────────────────┘
```

**Three invariants the new architecture enforces structurally:**

1. **One shape per concept.** Field, Mutation, Event. Firestore stores the same normalized shape we hold in memory.
2. **Types enforce domain invariants.** The TypeScript discriminated union prevents accessing fields a kind doesn't support. The `ContainerField` predicate prevents non-containers from becoming parents. Exhaustive switches catch missing handlers at build time.
3. **Agent and user emit identical mutations.** `applyMany` is the only write path. Event log records mutations directly — no reconstruction, no dual shapes.

---

## Detailed design

### 1. Domain layer (`lib/domain/`)

The domain is a proper TypeScript discriminated union, one file per field kind.

**File layout:**

```
lib/domain/
  fields/
    index.ts           # Field union, ContainerField, fieldRegistry, kind list
    base.ts            # FieldBase, InputFieldBase shared types
    text.ts            # TextField type + Zod + metadata + editor schema
    int.ts
    decimal.ts
    date.ts
    time.ts
    datetime.ts
    singleSelect.ts
    multiSelect.ts
    image.ts
    audio.ts
    video.ts
    barcode.ts
    signature.ts
    geopoint.ts
    label.ts
    hidden.ts
    secret.ts
    group.ts
    repeat.ts
  modules.ts           # Module type + Zod + metadata
  forms.ts             # Form type + Zod + metadata
  blueprint.ts         # BlueprintDoc type (pulled up from lib/doc/types.ts)
  index.ts             # barrel export
```

**Field type shape:**

```ts
// base.ts
export type FieldBase = {
  uuid: Uuid;
  id: string;                       // semantic id; CommCare property name
  label: string;
};

export type InputFieldBase = FieldBase & {
  hint?: string;
  required?: boolean;
  relevant?: string;
  case_property?: string;           // renamed from case_property_on
};

// text.ts
export const textFieldSchema = z.object({
  kind: z.literal('text'),
  uuid: uuidSchema,
  id: z.string(),
  label: z.string(),
  hint: z.string().optional(),
  required: z.boolean().optional(),
  relevant: z.string().optional(),
  case_property: z.string().optional(),
  validate: z.string().optional(),
  calculate: z.string().optional(),
});
export type TextField = z.infer<typeof textFieldSchema>;

export const textFieldMetadata: FieldKindMetadata<'text'> = {
  kind: 'text',
  xformKind: 'input',
  dataType: 'xsd:string',
  icon: 'tabler:pencil',
  isStructural: false,
  isContainer: false,
  saDocs: 'Free-text field for short single-line string input.',
};

export const textFieldEditorSchema: FieldEditorSchema<TextField> = {
  data:  [{ key: 'case_property', component: CasePropertySelect }],
  logic: [
    { key: 'required',    component: BooleanField },
    { key: 'relevant',    component: XPathField },
    { key: 'validate',    component: XPathField },
    { key: 'calculate',   component: XPathField },
  ],
  ui:    [{ key: 'hint',  component: TextareaField }],
};

// group.ts
export const groupFieldSchema = z.object({
  kind: z.literal('group'),
  uuid: uuidSchema,
  id: z.string(),
  label: z.string(),
  relevant: z.string().optional(),
});
export type GroupField = z.infer<typeof groupFieldSchema>;
// no validate, no required, no options — the *type* says so.
```

**The union:**

```ts
// fields/index.ts
export const fieldSchema = z.discriminatedUnion('kind', [
  textFieldSchema,
  singleSelectFieldSchema,
  // ...
  groupFieldSchema,
  repeatFieldSchema,
]);
export type Field = z.infer<typeof fieldSchema>;

export type ContainerField = Extract<Field, { kind: 'group' | 'repeat' }>;

export function isContainer(f: Field): f is ContainerField {
  return fieldRegistry[f.kind].isContainer;
}

export const fieldKinds = ['text', 'int', /* ... */, 'repeat'] as const;
export type FieldKind = typeof fieldKinds[number];
```

**The registry:**

```ts
// fields/index.ts
export const fieldRegistry: {
  [K in FieldKind]: FieldKindMetadata<K>;
} = {
  text: textFieldMetadata,
  int: intFieldMetadata,
  // ...
  group: groupFieldMetadata,
  repeat: repeatFieldMetadata,
};

export const fieldEditorSchemas: {
  [K in FieldKind]: FieldEditorSchema<Extract<Field, { kind: K }>>;
} = {
  text: textFieldEditorSchema,
  int: intFieldEditorSchema,
  // ...
};
```

**What the registry carries (non-behavioral metadata):**

```ts
type FieldKindMetadata<K extends FieldKind> = {
  kind: K;
  xformKind: XFormControlKind;      // CommCare emission: 'input' | 'select1' | 'select' | 'trigger' | 'group' | 'repeat' | 'output'
  dataType: XFormDataType;          // 'xsd:string' | 'xsd:int' | ... | 'geopoint' | '' (for structural)
  icon: string;                     // iconify id
  isStructural: boolean;            // group, repeat, label
  isContainer: boolean;             // group, repeat
  saDocs: string;                   // one-sentence description shown to the SA
  convertTargets: FieldKind[];      // which kinds this type can be converted to
};
```

**Sections are fixed.** Data / Logic / UI are the three panel sections; they do not vary per kind. Each kind's `FieldEditorSchema` slots entries into them.

**Why one file per kind:** every fact about `text` lives in `text.ts`. Adding `likert_scale` is one new file and one entry in the `fieldKinds` list. Compiler, validator, editor, SA tool generator, and docs all pick up the new kind automatically.

**Zod as source of truth at boundaries.** Every `*FieldSchema` is a Zod schema; TS types infer via `z.infer`. Firestore reads validate against `fieldSchema`. SA tool schemas are generated from the same Zod (see §6). Internal code reads the inferred TS types.

### 2. Doc store (`lib/doc/`)

Normalized state, fine-grained mutations, one atomic write path.

```ts
export type BlueprintDoc = {
  appId: string;
  appName: string;
  connectType: ConnectType;
  caseTypes: CaseType[];

  // Entity tables (UUID-keyed)
  modules: Record<Uuid, Module>;
  forms:   Record<Uuid, Form>;
  fields:  Record<Uuid, Field>;

  // Ordering maps
  moduleOrder: Uuid[];
  formOrder:   Record<Uuid /* moduleUuid */, Uuid[]>;
  fieldOrder:  Record<Uuid /* formUuid | containerUuid */, Uuid[]>;

  // Parent index — maintained atomically with every mutation
  fieldParent: Record<Uuid, Uuid | null>;   // child → parent (form or container)
};
```

**`fieldParent` is the big add.** It's rebuilt on load, updated by every mutation that touches `fieldOrder`, and never read from components directly — only through `useParent(uuid)` and `useAncestors(uuid)` hooks. It eliminates the "scan every order array" cost for finding a field's parent.

**Mutation API — flat, typed, UUID-keyed:**

```ts
export type Mutation =
  // Modules
  | { kind: 'addModule';        module: Module; index?: number }
  | { kind: 'removeModule';     uuid: Uuid }
  | { kind: 'moveModule';       uuid: Uuid; toIndex: number }
  | { kind: 'renameModule';     uuid: Uuid; id: string }
  | { kind: 'updateModule';     uuid: Uuid; patch: Partial<Module> }

  // Forms
  | { kind: 'addForm';          moduleUuid: Uuid; form: Form; index?: number }
  | { kind: 'removeForm';       uuid: Uuid }
  | { kind: 'moveForm';         uuid: Uuid; toModuleUuid: Uuid; toIndex: number }
  | { kind: 'renameForm';       uuid: Uuid; id: string }
  | { kind: 'updateForm';       uuid: Uuid; patch: Partial<Form> }

  // Fields
  | { kind: 'addField';         parentUuid: Uuid; field: Field; index?: number }
  | { kind: 'removeField';      uuid: Uuid }
  | { kind: 'moveField';        uuid: Uuid; toParentUuid: Uuid; toIndex: number }
  | { kind: 'renameField';      uuid: Uuid; id: string }
  | { kind: 'updateField';      uuid: Uuid; patch: Partial<Field> }
  | { kind: 'duplicateField';   uuid: Uuid }
  | { kind: 'convertField';     uuid: Uuid; toKind: FieldKind }

  // App-level
  | { kind: 'setAppName';       name: string }
  | { kind: 'setConnectType';   connectType: ConnectType }
  | { kind: 'setCaseTypes';     caseTypes: CaseType[] };
```

**Mutations deleted from the public API:**

- `replaceForm` — killed. See §6 for how agent writes become fine-grained.
- `notify*` — these were side-effect triggers (XPath literal rewriting on rename). Folded into the reducer: `renameField` calls the XPath rewrite helper internally. Not exposed as mutation kinds.
- `loadBlueprint` — replaced by an internal `load(doc)` action on the store (not a `Mutation`). Pauses zundo before populating, resumes after.

**Parent-type enforcement:** `Mutation.addField` takes `parentUuid`. The reducer asserts the parent is a `Form` or a `ContainerField`. TypeScript can't enforce this at compile time without carrying a branded `ParentUuid` type through every consumer, which is more invasive than the invariant earns. A runtime assertion with good error messages is enough; tests cover it.

**Single write path:**

```ts
// Public store API
applyMany(mutations: Mutation[]): void;        // atomic; one undo entry
// Every individual mutation is expressed via applyMany([m]).

// Internal-only (not part of Mutation)
load(doc: BlueprintDoc): void;                 // pauses zundo, replaces state, resumes
beginAgentWrite(stage?: string): void;         // pauses zundo
endAgentWrite(): void;                         // resumes; whole agent run = one undo entry
```

**All-or-nothing semantics.** Immer drafts make `applyMany` atomic for in-process failures — if any mutation's reducer throws, the draft is abandoned and no mutation applies. For an HTTP/MCP surface, the route handler wraps the call in a try/catch and returns the full blueprint on success or an error on failure. There is no "partial success" state.

**Hooks (all in `lib/doc/hooks/`):**

```ts
// Entity reads
useField(uuid: Uuid): Field | undefined;
useForm(uuid: Uuid): Form | undefined;
useModule(uuid: Uuid): Module | undefined;

// Tree navigation
useChildren(containerOrFormUuid: Uuid): Uuid[];
useChildFields(containerOrFormUuid: Uuid): Field[];
useParent(fieldUuid: Uuid): Uuid | null;
useAncestors(fieldUuid: Uuid): Uuid[];

// Ordered collections
useOrderedModules(): Module[];
useOrderedForms(moduleUuid: Uuid): Form[];
useOrderedFields(parentUuid: Uuid): Field[];

// App-level
useAppName(): string;
useConnectType(): ConnectType;
useCaseTypes(): CaseType[];

// Undo/redo
useUndoRedo(): { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };

// Mutations
useApplyMany(): (mutations: Mutation[]) => void;
```

**Lint rule:** `noRestrictedImports` expanded. Outside `lib/doc/**`, importing `useBlueprintDoc` / `useBlueprintDocShallow` / `useBlueprintDocTemporal` fails the build. Consumers use named hooks only.

### 3. Session (`lib/session/`)

Structurally unchanged from the April 12 refactor. The only edits:

- Rename `connectStash` key `FormConnect` → follows field rename (any CommCare-derived types renamed for consistency).
- Move `hooks/useCommitField.ts` → `lib/ui/hooks/useCommitField.ts` (not session-specific).

### 4. Routing (`lib/routing/`)

Path-based URLs with History API already landed. Two changes:

**Expose named hooks:**

```ts
// lib/routing/hooks/
useLocation(): Location;
useNavigate(): (target: Location) => void;
useSelect(): (uuid: Uuid | null) => void;   // consults EditGuardContext
useBreadcrumbs(): Breadcrumb[];
```

**Lint rule:** `noRestrictedImports` bans `next/navigation`'s `router.push` / `router.replace` outside `lib/routing/**`. Components import `useNavigate` / `useSelect` — not the raw router.

**`isValidLocation` / recovery stays.** Deletion-recovery effect that strips stale path segments on doc change is already correct.

### 5. Event log (`lib/log/`)

One time-ordered stream, two event families.

```ts
// lib/log/types.ts
export type Event = MutationEvent | ConversationEvent;

export type MutationEvent = {
  kind: 'mutation';
  runId: string;
  ts: number;
  actor: 'user' | 'agent';
  stage?: string;                  // e.g. 'scaffold', 'module:abc', 'form:def'
  mutation: Mutation;
};

export type ConversationEvent = {
  kind: 'conversation';
  runId: string;
  ts: number;
  payload: ConversationPayload;
};

export type ConversationPayload =
  | { type: 'user-message';       text: string; attachments?: Attachment[] }
  | { type: 'assistant-text';     text: string }
  | { type: 'assistant-reasoning'; text: string }
  | { type: 'tool-call';          toolName: string; input: unknown }
  | { type: 'tool-result';        toolName: string; output: unknown }
  | { type: 'error';              error: GenerationError };
```

**Writer (`lib/log/writer.ts`):** `logEvent(event)` fire-and-forgets to Firestore. Batched every ~100ms to avoid hot-path writes. Same collection as today's `StoredEvent`, new shape.

**Reader (`lib/log/reader.ts`):** `readEvents(appId, runId?)` paginates by `ts`. Consumers: chat history rendering, replay.

**Replay (`lib/log/replay.ts`):**

```ts
export async function replayEvents(
  events: Event[],
  onMutation: (m: Mutation) => void,
  onConversation: (p: ConversationPayload) => void,
  delayPerEvent = 150,
  signal?: AbortSignal,
): Promise<void> {
  for (const e of events) {
    if (signal?.aborted) return;
    if (e.kind === 'mutation') onMutation(e.mutation);
    else onConversation(e.payload);
    await sleep(delayPerEvent);
  }
}
```

That's the whole thing. The progressive-chat-history reconstruction in today's `logReplay.ts` (376 lines) is gone because conversation events are in the log directly; no reconstruction is needed.

**Authority:** blueprint snapshot on the app doc remains authoritative for state. Log is supplemental. If logs are lost, the app still loads. This is deliberately not full event sourcing.

**Storage format:** one Firestore collection per app (`apps/{appId}/events`), documents keyed by `{runId}:{ts}:{seq}`. Compaction is out of scope for this spec.

### 6. Agent (`lib/agent/`)

One directory for all LLM-facing code.

```
lib/agent/
  solutionsArchitect.ts       # ToolLoopAgent factory
  prompts/
    solutionsArchitect.ts     # build + edit prompts (both say "field")
  tools/
    addFields.ts              # generated tool schemas (flat-sentinels mode)
    updateField.ts
    addForm.ts
    …
  toolSchemaGenerator.ts      # registry → Anthropic tool schemas
  mutationMapper.ts           # SA tool output → Mutation[]
  validationLoop.ts
  autoFixer.ts
  errorClassifier.ts
  generationContext.ts        # LLM client + writer wrapper
  streamDispatcher.ts         # SSE → Event[] → applyMany + log writer
```

**Tool schemas are generated, not hand-written.** `toolSchemaGenerator(registry, mode)`:

```ts
type Mode = 'flat-sentinels' | 'per-type';

export function generateToolSchemas(
  registry: typeof fieldRegistry,
  mode: Mode,
): ToolSchema[];
```

- **`flat-sentinels`** (shipped): one `addFields` tool accepting any kind, schema-compiled under Anthropic's 8-optional-fields-per-item limit via empty-string / false sentinels. Post-processor strips sentinels before mutation mapping.
- **`per-type`** (future): one tool per kind (`addTextFields`, `addSelectFields`, …). Each tool's schema has only the kind's fields, so real optionals fit. No sentinel tokens.

Flipping modes is a one-line change plus an SA-prompt edit. The generator is built to support both; we ship on `flat-sentinels` to leave the LLM behavior unchanged.

**Mutation mapper runs server-side in the agent loop.** SA tool call → `mutationMapper.toMutations(toolName, args, doc)` → `Mutation[]` → `docStore.applyMany(m)` → `logWriter.logEvent({ kind: 'mutation', ... })` → SSE write to client. The client's stream handler receives mutation events and re-applies them to its own store.

Why server-side:
- The log captures mutations directly. No reconstruction at replay.
- The canonical translation happens once. Client and replay share the same events.
- An API/MCP caller invoking the same tool gets the same mutations.

**The mutation mapper is pure.** Given the current doc state and a tool call, it returns `Mutation[]`. Tool outputs may be form-scoped (the SA emits a full form shape) but the mapper decomposes them into fine-grained mutations: `addForm` + many `addField`s + any `updateForm` for case config.

**`replaceForm` is gone.** The mapper emits the decomposed sequence.

**Logging moves out of the agent layer.** `lib/services/logReplay.ts` and `eventLogger.ts` are deleted; their replacements live under `lib/log/`. The agent no longer owns logging — it calls `logWriter.logEvent` as a plain client of the log module.

**Autofix and validation loops** stay as they are structurally, just relocated. They produce mutations too, and those mutations also flow through the log as agent-actor mutation events.

### 7. CommCare boundary (`lib/commcare/`)

The one-way bridge from our normalized domain to CommCare's wire formats. The only place in `lib/` that imports CommCare's vocabulary.

```
lib/commcare/
  compiler.ts               # BlueprintDoc → HqApplication (the overall expander)
  xform/
    builder.ts              # field subtree → XForm XML
    bindings.ts             # bind-element construction, xpath wiring
    output.ts               # output/label/hint XML emission
  expander.ts               # HqApplication → upload-ready JSON
  validator/
    index.ts
    rules/
      field.ts
      form.ts
      app.ts
    xpathValidator.ts
  xpath/
    grammar.lezer.grammar   # was lib/codemirror/xpath.grammar
    parser.ts               # Lezer parser (generated)
    transpiler.ts           # was lib/transpiler/
  hq/
    client.ts               # listDomains, importApp, auth
    csrf.ts                 # CSRF token fetch workaround
    wafPadding.ts           # WAF-bypass padding field
  types.ts                  # HqApplication, HqForm, HqModule — CommCare wire types
```

**Compiler reads normalized doc directly.** No intermediate `AppBlueprint`. The compiler walks `moduleOrder`, then `formOrder[m]`, then `fieldOrder[f|g]` recursively, emitting XForm XML and HQ JSON as it goes.

**Field kinds map via `fieldRegistry[kind].xformKind` and `dataType`.** The compiler has one `emitField(field, ctx)` dispatch that reads the registry entry and branches once per `xformKind` (`input` vs `select1` vs `select` vs `group` vs `repeat` vs …). No per-kind hand-wiring inside the compiler.

**Import direction:** `lib/commcare/` imports from `lib/domain/` (reads our types). **Nothing outside `lib/commcare/` imports from it** except at the compile/emit entry point — typically `app/api/upload/route.ts` and a preview renderer. Biome `noRestrictedImports` enforces the boundary.

**Vocabulary rule:** CommCare's `"question"`, `"case_property_on"` (the old field name), CommCare's form-type strings (`'registration'` etc.) appear *only* inside `lib/commcare/`. A one-way mapping lives at the emission boundary:

```ts
// lib/commcare/compiler.ts — internal
function fieldToXFormKind(kind: FieldKind): XFormControlKind {
  return fieldRegistry[kind].xformKind;
}
```

### 8. Persistence (`lib/db/`)

**Firestore stores `BlueprintDoc` directly.** `AppBlueprint` nested tree is deleted. `toDoc` / `toBlueprint` converters are deleted. `normalizedState.ts` is deleted.

**Doc shape on disk:**

```ts
// Same as in-memory, minus ephemeral fields
{
  appId: string;
  appName: string;
  connectType: ConnectType;
  caseTypes: CaseType[];
  modules: Record<Uuid, Module>;
  forms: Record<Uuid, Form>;
  fields: Record<Uuid, Field>;
  moduleOrder: Uuid[];
  formOrder: Record<Uuid, Uuid[]>;
  fieldOrder: Record<Uuid, Uuid[]>;
  // fieldParent is derived on load; not persisted (saves space + can't drift)
}
```

**Load:** read doc, call `rebuildFieldParent(doc)` to populate the index, `docStore.load(doc)`.

**Save:** `useAutoSave` (in `lib/doc/hooks/`) watches applied mutations; on batch/idle, writes the current doc state to Firestore. Same auto-save strategy as today, pointing at the new shape.

**Migration:** a one-time script (`scripts/migrate-to-normalized-doc.ts`) walks existing `AppBlueprint` docs and writes the normalized shape. Run once in production before the switch. No runtime migration layer.

### 9. UI architecture

**Declarative field property editor:**

```tsx
// components/builder/FieldEditorPanel.tsx (new, replaces ContextualEditor{Data,Logic,UI})
export function FieldEditorPanel({ fieldUuid }: { fieldUuid: Uuid }) {
  const field = useField(fieldUuid);
  if (!field) return null;
  const schema = fieldEditorSchemas[field.kind] as FieldEditorSchema<typeof field>;
  return (
    <>
      <Section title="Data">   {schema.data.map(renderEntry(field))}  </Section>
      <Section title="Logic">  {schema.logic.map(renderEntry(field))} </Section>
      <Section title="UI">     {schema.ui.map(renderEntry(field))}    </Section>
    </>
  );
}
```

Each entry's `component` receives the typed `field` and a typed `onChange(nextValue: F[K])`. No `if (field.kind === ...)` inside the panel. Adding a new kind's editor is a new entry in that kind's `*EditorSchema`.

**Field header (chrome, not schema):**

```tsx
// components/builder/FieldHeader.tsx — renders for every kind
// Reads fieldRegistry[field.kind] for icon, convertTargets, isStructural
// Handles: id edit, type picker, move/duplicate/convert/delete, sibling-conflict detection
```

**Component splits:**

- `components/builder/FormSettingsPanel.tsx` (1360 lines) →
  - `FormBasicSettings.tsx` (name, form type)
  - `FormConnectConfig.tsx` (learn/deliver connect modes)
  - `FormCaseConfig.tsx` (case preload + case list columns)
  - `FormSettingsPanel.tsx` (~80 lines, tabs/shell only)

- `components/builder/AppTree.tsx` (983 lines) →
  - `AppTree.tsx` (tree rendering, selection)
  - `AppTreeContextMenu.tsx` (context menu, move/duplicate/delete actions)
  - `useAppTreeSelection` hook

- `components/builder/VirtualFormList.tsx` (831 lines) →
  - `VirtualFormList.tsx` (shell: virtualizer, row dispatch, scroll container)
  - `useDragIntent.ts` (drag lifecycle: `onDragStart`, placeholder calculation, `onDrop` dispatch) — extracted to its own file

**Row components unchanged structurally** — they already don't know about virtualization.

### 10. Hook + selector discipline

**All hooks colocate with their domain.** Top-level `/hooks/` directory deleted. Redistribution:

| Current location | New location |
|---|---|
| `hooks/useAutoSave.ts` | `lib/doc/hooks/useAutoSave.ts` |
| `hooks/useCommitField.ts` | `lib/ui/hooks/useCommitField.ts` |
| `hooks/useToasts.ts` | `lib/ui/hooks/useToasts.ts` |
| `hooks/useKeyboardShortcuts.ts` | `lib/ui/hooks/useKeyboardShortcuts.ts` |
| `hooks/useAuth.ts` | `lib/auth/hooks/useAuth.ts` |
| `hooks/use-is-breakpoint.ts` | `lib/ui/hooks/useIsBreakpoint.ts` (renamed to camelCase) |
| `hooks/use-menu-navigation.ts` | `lib/ui/hooks/useMenuNavigation.ts` |
| `hooks/use-tiptap-editor.ts` | `lib/ui/hooks/useTiptapEditor.ts` |
| `hooks/useSaveQuestion.ts` | deleted (folded into declarative editor primitives) |
| `hooks/useTextEditSave.ts` | deleted (folded into `useCommitField`) |
| `hooks/useFormEngine.ts` | deleted (index-based compat shim) |
| `hooks/useEditContext.tsx` | deleted (index-based compat shim) |

**Lint rule expansions in `biome.json`:**

```json
"noRestrictedImports": {
  "paths": [
    {
      "name": "@/lib/doc/store",
      "message": "Use named hooks from @/lib/doc/hooks. Do not pass inline selectors to useBlueprintDoc.",
      "allowImportingNamesFrom": ["@/lib/doc/hooks/**"]
    },
    {
      "name": "@/lib/session/store",
      "message": "Use named hooks from @/lib/session/hooks.",
      "allowImportingNamesFrom": ["@/lib/session/hooks/**"]
    },
    {
      "name": "next/navigation",
      "importNames": ["useRouter", "useSearchParams", "usePathname"],
      "message": "Use useLocation / useNavigate / useSelect from @/lib/routing/hooks.",
      "allowImportingNamesFrom": ["@/lib/routing/**"]
    }
  ]
}
```

### 11. What goes away

- `lib/services/` entirely — contents redistributed to `lib/agent/`, `lib/commcare/`, `lib/log/`, `lib/db/`.
- `lib/schemas/blueprint.ts` — folded into `lib/domain/`.
- `lib/schemas/toolSchemas.ts` — replaced by generated tool schemas.
- `lib/types/` — folded into `lib/domain/`.
- `lib/prompts/` — folded into `lib/agent/prompts/`.
- `lib/transpiler/` — folded into `lib/commcare/xpath/`.
- `lib/codemirror/` (grammar) — folded into `lib/commcare/xpath/`.
- `lib/services/normalizedState.ts` — deleted; the store is normalized, no separate layer.
- `lib/doc/converter.ts` — deleted (no more two-shape bridge).
- `lib/services/logReplay.ts` — deleted; `lib/log/replay.ts` is ~30 lines.
- `lib/services/eventLogger.ts` — deleted; `lib/log/writer.ts` is its replacement.
- `AppBlueprint` type and `toDoc` / `toBlueprint` — deleted.
- `replaceForm` mutation — deleted.
- All `notify*` mutations — deleted from public API; work folds into their causing mutations.
- Top-level `/hooks/` directory — deleted.
- `useFormEngine`, `useEditContext` — deleted (index-based shims).
- `ContextualEditorHeader/Data/Logic/UI` — replaced by `FieldHeader` + `FieldEditorPanel`.
- `BuilderEditContext` positional-identity context — no longer needed; consumers use UUIDs.
- The word "question" from internal code, types, hooks, components, mutation names, prompts, and Firestore fields. It survives only inside `lib/commcare/` where CommCare demands it.

---

## Migration phases

Migration is big-bang in a worktree. No adapter layers, no per-phase runnable states. Phases are organizational — they group related work so implementation can land in clear chunks, but the app is only required to work at the end.

| # | Phase | Scope |
|---|---|---|
| 1 | **Domain layer + rename** | Create `lib/domain/` with per-kind files. Define `Field` discriminated union, `fieldRegistry`, `fieldEditorSchemas`. Rename `Question`→`Field`, `question`→`field` everywhere except inside `lib/commcare/`. Delete `AppBlueprint`, converters, `normalizedState`. Update Firestore persistence to normalized shape + run one-time migration script. |
| 2 | **Mutation API rebuild** | Replace current mutation set with the one in §2. Delete `replaceForm`, public `notify*`. Add `fieldParent` index. Add `convertField` mutation. Switch store to `applyMany` as only write path. |
| 3 | **Agent + tool-schema generator** | Build `toolSchemaGenerator` in `flat-sentinels` mode producing today's schema shape. Move `mutationMapper` to run server-side. Rewrite to emit fine-grained mutations. Update SA prompt to say "field". Move agent code to `lib/agent/`. |
| 4 | **Event log unification** | Implement `lib/log/` (writer, reader, replay). Rewrite stream dispatcher to emit `Event`s. Delete `logReplay.ts`, `eventLogger.ts`. Replay UI consumes events from the log. |
| 5 | **UI: declarative editor + component splits** | Build `FieldEditorPanel` + `FieldHeader` driven by registry. Delete `ContextualEditor*` components. Split `FormSettingsPanel`, `AppTree`. Extract `useDragIntent` from `VirtualFormList`. |
| 6 | **Hook + selector hygiene + lint** | Move hooks to their domain owners. Delete `/hooks/` top-level. Add/expand `noRestrictedImports` rules. Fix all ~15 inline-selector violations. Add `useNavigate`, `useSelect`. |
| 7 | **Cleanup** | Delete `lib/services/`, `lib/schemas/`, `lib/types/`, `lib/prompts/`, `lib/transpiler/`, `lib/codemirror/`, `useFormEngine`, `useEditContext`. Update `CLAUDE.md` files. Full `npm run lint`, `npm run build`, `npx tsc --noEmit`, `npm test` clean. |

Phases overlap heavily in practice — the rename pass (Phase 1) touches consumers that Phase 6 also touches. Implementation order can interleave; what matters is the final shape.

---

## Testing strategy

**Unit:**

- Every `Mutation` kind: input doc + args → expected doc (snapshot on the doc, not on React output).
- `mutationMapper(tool, args, doc)` for each tool call shape — agent emits decomposed mutation sequence.
- `toolSchemaGenerator(registry, 'flat-sentinels')` produces byte-identical schemas to today's hand-written tool schemas.
- `fieldSchema.parse()` for each kind — Zod validates inferred types.
- `replayEvents(events, onMutation, onConversation)` applies mutations in order and produces expected final state.
- `rebuildFieldParent(doc)` produces correct parent index for every field.
- `compiler.emitForm(form, doc)` — round-trip a fixture form to XForm XML and assert structure.

**Integration:**

- Full agent stream: fire a fixture event sequence, assert doc reaches expected state AND log captures expected `Event[]`.
- Undo across an agent write: one undo reverses the whole generation; verified via `temporal.pastStates.length`.
- Lint enforcement: construct a test file with inline selectors; assert Biome fails.
- Deep link validity: push a stale path, expect it to be stripped; push a valid uuid path, expect `useLocation()` to resolve.

**Manual smoke (at end of Phase 7):**

- Browser back/forward across module/form/field selections.
- Cmd+click deep link opens a field directly.
- Undo/redo during and after agent generation.
- Drag a field across group boundaries; into an empty group; past the top/bottom edges.
- Scroll a 200-field form at 60fps; selected field stays mounted when scrolled away.
- Switch cursor mode (edit ↔ pointer).
- Mid-stream network kill — error banner, recoverable doc.
- Load an existing app after the migration script; verify blueprint matches pre-migration state.

---

## Risks

- **The rename touches ~100+ files.** Mechanical but broad; expect a large PR. Mitigated by doing it in one pass alongside the domain-type migration so consumers update once.
- **Firestore migration is the one non-reversible step.** Mitigation: dry-run the migration script in staging; take a full Firestore export before running; provide a reverse script as a safety net.
- **Tool-schema byte-identity check is important.** If the generator produces a schema that differs even slightly from today's hand-written one, the SA's outputs may change in ways that break fixture tests. Mitigation: diff the generated schema against today's `addQuestionsSchema` as a gate in Phase 3.
- **Server-side mutation mapper changes streaming timing.** Today client receives SA events and applies mutations. Moving the mapper server-side means the client receives `MutationEvent`s directly. If event timing differs, animations or progress UI may feel different. Mitigation: preserve the same pacing at the SSE layer.
- **Registry-driven compiler.** The compiler branches on `xformKind`, not `kind`. If two kinds share an `xformKind` but need different emission (e.g. `int` vs `decimal` both map to `input` but with different `dataType`), the dispatch reads `dataType` as the secondary key. Verify every kind's emission matches current output with fixture tests.

---

## Success criteria

1. No field in any type can access a property outside its kind. `const g: GroupField; g.validate` is a type error.
2. No inline selector functions exist outside store-owning directories. `rg "useBlueprintDoc\(\(s" components/ app/` returns zero results. Biome fails the build if any appear.
3. `Question`, `question`, `case_property_on` appear nowhere outside `lib/commcare/`.
4. `AppBlueprint`, `toDoc`, `toBlueprint`, `normalizedState`, `replaceForm`, and all `notify*` mutations no longer exist.
5. `lib/services/` no longer exists.
6. Top-level `/hooks/` no longer exists.
7. `lib/log/replay.ts` is ≤ 50 lines.
8. `FormSettingsPanel` is ≤ 200 lines after split. `AppTree` is ≤ 400 lines after split. `VirtualFormList`'s drag lifecycle is in a separate hook file.
9. `npm run lint`, `npm run build`, `npx tsc --noEmit`, `npm test` are all clean.
10. A full SA generation on fixture inputs produces a normalized doc that, when compiled, emits byte-identical XForm XML and HQ-upload JSON to today's system. (The in-memory shape changes; the CommCare output does not.)
11. An existing production app, after running the one-time migration script, loads correctly and compiles to byte-identical CommCare output against a pre-migration diff.
12. Adding a hypothetical new field kind is one new file in `lib/domain/fields/` and one new entry in `fieldKinds`. Nothing else changes.
