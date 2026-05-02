# Case List & Search — Foundation Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2 — supersedes v1 of this same file. v1 had a fundamental scope error (missing AST coverage for relational queries, expression family entirely absent, three wire dialects collapsed to two) that surfaced after the implementor had shipped Tasks 1–8. v2 reconciles with shipped work where possible and supersedes where the shipped emitter design is structurally wrong.

**Goal:** Build the typed Predicate AST + typed Expression AST, schema-driven type checker, JSON Schema generator, three per-dialect CommCare wire emitters, AST → Kysely compiler, and the representability checker. Ships as tested library code with no consumer yet — Plans 2–5 wire it up.

**Architecture summary** (full detail in `docs/superpowers/specs/2026-04-30-case-list-search-design.md` v2):
- Two AST families: Predicate (boolean) + Expression (value), sharing Term shapes
- Three wire targets dispatched as separate visitors: case-list filter (on-device, plain XPath 1.0 + `selected()`), CSQL (server-side ES, full extension set), post-ES search filter (on-device, same as case-list filter)
- Postgres SQL via Kysely as the live runtime — full operator coverage, no losses
- Representability checker surfaces unrepresentable / lossy shapes per target at authoring time

**Tech Stack:** TypeScript (strict), Zod (AST validation), Vitest (tests), Kysely (typed SQL builder). Existing CommCare XPath infrastructure under `lib/commcare/xpath/`.

---

## Reconciliation with shipped work

The implementor (working in `.worktrees/case-foundation` on branch `feat/case-list-search-foundation`) has shipped 33 commits across tasks 1–8 of v1 plus extensive structural improvements (identifier regex validation, drift guards, typed-date literals via `data_type` on `Literal`, per-context CSQL escape strategy, source-citation comments). That work is high quality and most of it survives.

**What survives unchanged from shipped work:**
- `lib/domain/predicate/types.ts` — Term schemas (`prop`, `input`, `user`, `literal`), comparison + logical predicates, the structural defenses (identifier patterns, drift guards). v2 extends this file with new operators rather than replacing it.
- `lib/domain/predicate/builders.ts` — comparison + logical + `in` + `within-distance` + `fuzzy` + `whenInput` builders. v2 extends.
- `lib/domain/predicate/jsonSchema.ts` — write-side JSON Schema generator. Stays as-is.
- `lib/domain/predicate/typeChecker.ts` — comparison + logical + `in` + special-operator checking. v2 extends with new operators.
- `lib/commcare/predicate/xpathEmitter.ts` — base structure, comparison + logical + `not` emission, the per-context string-escape strategy, the source-citation pattern. v2 splits this into three visitors.

**What v2 explicitly supersedes from shipped work (tasks below):**
- The single-emitter-with-context-branch shape — split into three per-dialect visitors. The shipped emitter's `EmissionContext = "case-list-filter" | "csql"` branch in one function is structurally wrong; the on-device dialect supports a strict subset of CSQL functions, not the same set with different escape rules. Verified at `commcare-core/.../ASTNodeFunctionCall.java:113-269` and `commcare-hq/.../xpath_functions/__init__.py:39-54`.
- The `in` operator's emission to `selected-any` for multi-value cases in case-list-filter context — broken on Android (CSQL-only function in an on-device dialect). Already partially fixed by the `isIn or-of-=` commit on this branch (or-of-eq for case-list filter), but the multi-select-vs-scalar dispatch needs the new `multi-select-contains` operator to land cleanly.
- The `fuzzy` operator's emission to case-list-filter context — same problem; CSQL-only.
- `within-distance` operator emission to case-list-filter context — same problem.

The v2 plan landing order: extend the AST + type checker first (Group A), then split the emitter into three visitors and reconcile the broken emissions (Group B), then add the new wire targets and Kysely compiler (Group C).

---

## File Structure

```
lib/domain/predicate/                    # Predicate AST + ValueExpression AST (one package)
├── types.ts                             # both unions: predicate operators + ValueExpression arms
├── builders.ts                          # both surfaces: predicate builders + ValueExpression builders + auto-wrap
├── reduction.ts                         # NEW — and([]) → match-all etc.
├── jsonSchema.ts                        # unchanged
├── typeChecker.ts                       # checkPredicate + checkExpression
└── __tests__/

lib/commcare/predicate/                  # NEW: three visitors, not one
├── caseListFilterEmitter.ts             # NEW (replaces single xpathEmitter for case-list-filter context)
├── csqlEmitter.ts                       # NEW (replaces single xpathEmitter for csql context, with concat() wrapping)
├── searchFilterEmitter.ts               # NEW (post-ES on-device dialect; mostly shared with caseListFilterEmitter)
├── representability.ts                  # NEW — validateRepresentability(ast, target)
├── stringQuoting.ts                     # NEW — shared quoting helpers extracted from shipped xpathEmitter
└── __tests__/

lib/commcare/expression/                 # NEW — Expression AST → wire emission
├── caseListFilterEmitter.ts             # on-device dialect for value expressions inside case-list nodesets
├── csqlEmitter.ts                       # CSQL value functions (today, now, date-add, etc.)
└── __tests__/

lib/case-store/sql/                      # NEW — Postgres compiler
├── database.ts                          # Kysely Database type
├── compileTerm.ts
├── compilePredicate.ts
├── compileExpression.ts
├── compileRelationPath.ts               # JOIN spec on case_indices
└── __tests__/
```

The shipped `lib/commcare/predicate/xpathEmitter.ts` is **deprecated and removed** in Task B1. Its content migrates into the three per-dialect emitters; the `stringQuoting.ts` helpers extract the shared logic.

The Predicate and ValueExpression families live in one package because predicates ARE expressions that resolve to boolean — the boolean-typed arm of the broader expression family. Predicate operators carry `ValueExpression` operands so arithmetic / conditional expressions can drive comparisons; `ValueExpression` arms (`if` / `switch` / `count`) carry `Predicate` clauses so boolean conditions can drive value selection. Both unions reference each other through `z.lazy(...)` within this single module — the canonical Zod pattern for self-recursion through discriminated unions. Splitting the families across packages would have required cross-package `z.lazy` (a module-loading workaround, not a real recursion mechanism); collapsing into one module eliminates that and lets every consumer import both families through one barrel. The wire-emission boundary (`lib/commcare/predicate` + `lib/commcare/expression`) keeps two directories because the per-dialect emitter sets diverge between predicate and value position — that split is wire-side, not authoring-side.

---

## Group A — Extend the AST and type checker (additive on shipped work)

These tasks extend types.ts, builders.ts, and typeChecker.ts with operators the shipped emitter doesn't reference. No file deletions; everything appends to the discriminated union and the switch statements. The implementor is familiar with these patterns from tasks 2–6.

### Task A1: Add Predicate AST kinds for sentinels, null check, range, and relations — SHIPPED

Shipped across commits `027732a4` → `84a092ec` → `777aca61` → `207bcdff` → `033c73fe` → `cd32cd63` → `663b0267`.

**Files modified:**
- `lib/domain/predicate/types.ts`
- `lib/domain/predicate/builders.ts`
- `lib/domain/predicate/typeChecker.ts`
- `lib/commcare/predicate/xpathEmitter.ts` (defensive throw arms; file slated for B6 deletion)
- `lib/domain/predicate/__tests__/{types,builders,typeChecker}.test.ts`

**Schemas that landed** (match the v2 spec's Predicate AST family):

```ts
const matchAllSchema = z.object({ kind: z.literal("match-all") });
const matchNoneSchema = z.object({ kind: z.literal("match-none") });
const isNullSchema = z.object({ kind: z.literal("is-null"), left: termSchema });
const betweenSchema = z.object({
  kind: z.literal("between"),
  left: termSchema,
  lower: termSchema.optional(),
  upper: termSchema.optional(),
  lowerInclusive: z.boolean(),
  upperInclusive: z.boolean(),
}).refine(
  (v) => v.lower !== undefined || v.upper !== undefined,
  "between must have at least one bound (lower or upper)",
);
const existsSchema = z.object({
  kind: z.literal("exists"),
  via: relationPathSchema,
  where: z.lazy(() => predicateSchema).optional(),
});
const missingSchema = z.object({
  kind: z.literal("missing"),
  via: relationPathSchema,
  where: z.lazy(() => predicateSchema).optional(),
});
```

`Predicate` union extended with two non-recursive arms (`match-all`, `match-none`, `is-null`, `between`) and two recursive arms (`exists`, `missing`). Drift guard extended with `_ExistsArm` and `_MissingArm` (each strips `where` before structural equality).

**Builders that landed:**

```ts
export const matchAll = (): Extract<Predicate, { kind: "match-all" }> => /* discriminator-only */
export const matchNone = (): Extract<Predicate, { kind: "match-none" }> => /* discriminator-only */
export const isNull = (left: Term | ValueExpression): Extract<Predicate, { kind: "is-null" }> => /* operand auto-wraps */
export function between(left: Term | ValueExpression, opts: BetweenOptions): Extract<Predicate, { kind: "between" }>
  // lowerInclusive / upperInclusive default to true (mathematical [lower, upper])
  // absent-not-undefined contract: omitted bounds produce no key on the result
  // Term-shaped operands auto-wrap as the `term` arm of ValueExpression (Task A6).
export const exists = (via: RelationPath, where?: Predicate): Extract<Predicate, { kind: "exists" }> => /* absent-where */
export const missing = (via: RelationPath, where?: Predicate): Extract<Predicate, { kind: "missing" }> => /* absent-where */
```

(`is-null` / `between` operand types are widened to `Term | ValueExpression` in Task A6 — see the `Task A6` block below for the full operand-widening change set across `eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`isIn`/`within`/`isNull`/`isBlank`/`between`.)

**Type-checker policy that landed** (encoded in `walk()`'s switch):

- `match-all` / `match-none` — return cleanly. By construction nullary discriminator-only sentinels are well-typed.
- `is-null` / `between` / `exists` / `missing` — throw with `Error("checkPredicate: no rules for kind '<kind>'")`. The throw is the structural defense — silently passing kinds without dedicated semantic rules would produce false-positive "type-checks clean" verdicts on unchecked predicates. The throw fires both directly and through wrapper recursion (`and(eq(...), isNull(...))`). The four kinds are listed in `checkPredicate`'s public JSDoc so callers can scope inputs or handle the throw. Task A5 lands the rules and removes the throw arm + the JSDoc paragraph + the throw-arm tests in one change.

**`prop.via` resolution policy** (related correctness fix, not strictly A1 but landed in A1's commit chain):

- `resolveTermType`'s `case "prop":` arm emits a `CheckError` (not throw) when `term.via` is present and not `{ kind: "self" }`. The originating-scope check still runs structurally; the destination-scope check requires Task A5's destination-scope resolution rule. The error path is `[..., "left"]` (or "right"); the message names "via" and "destination scope" so the editor can route the highlight. Closes the silent-accept gap that the throw-on-unimplemented policy was supposed to prevent.

**Deviations from the v2 plan's outline above (all principled):**

1. **Per-kind narrowed return types** on builders (`Extract<Predicate, { kind: "..." }>`) instead of the wide `Predicate` union. Callers narrowing on `kind` after a builder call get per-variant fields directly.
2. **Absent-not-undefined contract** on every optional slot (`between.lower`/`upper`, `exists.where`, `missing.where`). Builders construct objects without materializing the slot key when omitted, preserving round-trip equality.
3. **`between` defaults `lowerInclusive`/`upperInclusive` to `true`** when omitted, matching the mathematical [lower, upper] convention. Documented with the absent-bounds contract together.
4. **Schema-level `lower > upper` for literal-typed bounds is intentionally accepted** — bounds may be Term refs (search-input, user-context) whose values aren't known at parse time. The type checker (Task A5) is the right place to detect literal-pair impossibility; runtime checking handles the term-pair case. Documented in `betweenSchema`'s JSDoc.
5. **`xpathEmitter.ts` got per-kind defensive throw arms** for the six new kinds. Strictly out of A1's file list, but the file's existing exhaustiveness pattern doesn't have a `never` default, so adding new arms to `Predicate` without matching emitter cases breaks compile. Throws (with clear "no emission for kind" messages) keep the build green. The file is deleted in B6; the throw arms are temporary scaffolding.
6. **CCHQ source citations on the new schemas** verified at production code (not test mocks): `match-all`/`match-none` registry at `corehq/apps/case_search/xpath_functions/__init__.py:52-53`; implementations at `query_functions.py:162-177`; `subcase-exists` at `subcase_functions.py:51-62` with optional-filter check at `:207`; `ancestor-exists` at `ancestor_functions.py:97-118` with mandatory 2-arg confirm.
7. **`DISTANCE_UNITS` (Task 2) Nova-narrowing note added** — CCHQ accepts nine units (`miles`, `kilometers`, `yards`, `feet`, `inch`, `meters`, `centimeters`, `millimeters`, `nauticalmiles` per `commcare-hq/corehq/apps/es/queries.py:22-23`); Nova exposes only the imperial/metric anchors. Documented in the schema-level JSDoc.

### Task A2: Add Predicate AST kinds for multi-select-contains and match (text-match modes) — SHIPPED

Shipped across commits `063deab6` → `faad7821` → `f6a28730` → `0d8a8fb9` → `7b10fded` → `f734c02f`.

**Files modified:**
- `lib/domain/predicate/types.ts`
- `lib/domain/predicate/builders.ts`
- `lib/domain/predicate/typeChecker.ts`
- `lib/commcare/predicate/xpathEmitter.ts`
- `lib/domain/predicate/__tests__/types.test.ts`
- `lib/domain/predicate/__tests__/builders.test.ts`
- `lib/domain/predicate/__tests__/typeChecker.test.ts`

**Schemas that landed:**

```ts
const matchSchema = z.object({
  kind: z.literal("match"),
  property: propertyRefSchema,
  value: z.string().min(1),
  mode: z.enum(MATCH_MODES),
});

const multiSelectContainsSchema = z.object({
  kind: z.literal("multi-select-contains"),
  property: propertyRefSchema,
  values: z.tuple([literalSchema], literalSchema),  // non-empty
  quantifier: z.enum(MULTI_SELECT_QUANTIFIERS),
}).refine(/* reject all-null values list — collapses to is-null on both wire targets */);
```

The shipped `fuzzy` schema was **replaced directly** by `match(prop, val, mode: "fuzzy")` with no deprecation alias and no migration helper — the AST has not been persisted in production. Call sites in builders, type checker, emitter, and tests were swept in one change; the standalone `fuzzy` schema and `fuzzyMatch` builder are gone.

**Closed sets pulled to module-top constants:**

```ts
export const MATCH_MODES = ["fuzzy", "phonetic", "fuzzy-date", "starts-with"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const MULTI_SELECT_QUANTIFIERS = ["any", "all"] as const;
export type MultiSelectQuantifier = (typeof MULTI_SELECT_QUANTIFIERS)[number];
```

Both follow the `COMPARISON_KINDS` / `DISTANCE_UNITS` pattern already established by Task 2 — single source of truth feeds both the schema's `z.enum(...)` and the builder's parameter type, so adding a mode/quantifier widens both surfaces in one edit.

**Builders that landed:**

```ts
export const matches = (property: PropertyRef, value: string, mode: MatchMode):
  Extract<Predicate, { kind: "match" }> => /* ... */;

export const multiSelectAny = (property: PropertyRef, first: Literal, ...rest: Literal[]):
  Extract<Predicate, { kind: "multi-select-contains" }> => /* variadic-with-required-first */;

export const multiSelectAll = (property: PropertyRef, first: Literal, ...rest: Literal[]):
  Extract<Predicate, { kind: "multi-select-contains" }> => /* variadic-with-required-first */;
```

The variadic-with-required-first signature on the multi-select builders mirrors A3's `ancestorPath` and the existing `and` / `or` / `isIn` pattern: it lifts `.min(1)` non-emptiness into the type system and rejects empty calls at compile time.

**Type-checker allow-list — `MATCH_PROPERTY_TYPES_BY_MODE`:**

The shipped allow-list for the deleted `fuzzy` operator (`text` / `single_select` / `multi_select`, citing `_selected_query` at `commcare-hq/.../xpath_functions/query_functions.py:46-51`) was the right shape for three of the four modes but too narrow for `fuzzy-date`. CCHQ's `fuzzy-date` accepts `date` and `datetime` properties in addition to text — narrowing to text-only would defeat the operator on typed properties. Shipped as a `Record<MatchMode, ReadonlySet<...>>` for exhaustiveness:

```ts
const MATCH_PROPERTY_TYPES_BY_MODE: Record<MatchMode, ReadonlySet<...>> = {
  "fuzzy":       new Set(["text", "single_select", "multi_select"]),
  "phonetic":    new Set(["text", "single_select", "multi_select"]),
  "starts-with": new Set(["text", "single_select", "multi_select"]),
  "fuzzy-date":  new Set(["text", "single_select", "multi_select", "date", "datetime"]),
};
```

The exhaustive `Record` shape forces every `MatchMode` addition to declare its allow-list explicitly rather than fall through to a default; missing modes are a compile error.

**Deviations from the v2 plan's outline above (all principled improvements):**

1. **`MATCH_PROPERTY_TYPES_BY_MODE` per-mode allow-list** instead of one shared `MATCH_PROPERTY_TYPES` set. The plan above said the shipped allow-list "survives unchanged" across all four modes; that was wrong for `fuzzy-date`, which CCHQ accepts on date/datetime properties. The Record shape encodes per-mode dispatch and keeps modes from silently sharing the wrong narrowing.
2. **`z.tuple([T], T)` non-emptiness on `values`** (matching A3's `ancestor` `via`, A1's `and`/`or` clauses, `inSchema.values`) instead of `.min(1)` — lifts the constraint into the inferred type.
3. **All-null values rejection on `multi-select-contains`** via `.refine(...)`. Both wire targets collapse a list of nulls to a duplicated "is unset" predicate (`case_search.py:245-246` in CCHQ short-circuits to `case_property_missing`; `XPathSelectedFunc.java:38-54` in commcare-core's on-device path reduces empty trim to is-empty), so reject at the schema layer and direct authors to the canonical `is-null(prop)` operator.
4. **`match.value: z.string().min(1)`** with rationale grounded in CCHQ's per-mode collapse of empty values (different non-match per mode — vacuous prefix for `starts-with`, `case_property_missing` for `fuzzy-match`, no-token-match for `phonetic-match`, `date_permutations("")` undefined for `fuzzy-date`) rather than a uniform "trivially true" framing. Authors who want is-unset semantics use `is-null(prop)`.
5. **Variadic-with-required-first builders** (`multiSelectAny(prop, first, ...rest)` / `multiSelectAll(prop, first, ...rest)`) instead of the v2 plan's `(prop, values: Literal[])`. Catches empty calls at compile time and matches the A3 / A1 pattern.
6. **Per-kind narrowed return types** (`Extract<Predicate, { kind: "match" }>` and `Extract<Predicate, { kind: "multi-select-contains" }>`) on builders — same pattern A3 established for relation-path builders.
7. **Comment-attribution sweep across the recursive arms** of `checkPredicate` after the reviewer caught a stale claim about `_selected_query` being used by all match modes (it dispatches `selected-any` and `selected-all` only; each `match` mode has its own dispatch function in `xpath_functions/`). Citations corrected to the per-mode dispatcher in `query_functions.py`.

**Multi-select asymmetry — documented in JSDoc:**

`selected-any` and `selected-all` look symmetric on the surface (both quantify `selected(prop, v)` over a values list) but CCHQ-side empty-list semantics diverge: `selected-any(prop, '')` returns false for every case (vacuous existential) while `selected-all(prop, '')` returns true for every case (vacuous universal). Nova's schema rejects empty lists at parse time so the asymmetry never reaches the wire, but the rationale is documented in `multiSelectContainsSchema`'s JSDoc so that B-stage emitter authors don't reintroduce the gap.

### Task A3: Add RelationPath structure — SHIPPED

Shipped across commits `ec43585d` → `21d8a103` → `476fcaef` → `b08a203f` → `c908cee8` → `d461cd86` → `6eccfa99`.

**Files modified:**
- `lib/domain/predicate/types.ts`
- `lib/domain/predicate/builders.ts`
- `lib/domain/predicate/__tests__/types.test.ts`
- `lib/domain/predicate/__tests__/builders.test.ts`

**Schema shape that landed** (matches the v2 spec's RelationPath section):

```ts
const relationStepSchema = z.object({
  identifier: xmlElementNameField("Relation step identifier"),
  throughCaseType: caseTypeField("Through case type").optional(),
});

const relationPathSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }),
  z.object({
    kind: z.literal("ancestor"),
    via: z.tuple([relationStepSchema], relationStepSchema), // non-empty
  }),
  z.object({
    kind: z.literal("subcase"),
    identifier: xmlElementNameField("Subcase identifier"),
    ofCaseType: caseTypeField("Of case type").optional(),
  }),
  z.object({
    kind: z.literal("any-relation"),
    identifier: xmlElementNameField("Any-relation identifier"),
    ofCaseType: caseTypeField("Of case type").optional(),
  }),
]);
```

**Builders that landed:**

```ts
export const relationStep = (identifier: string, throughCaseType?: string): RelationStep => /* absent-key contract */
export const selfPath = (): Extract<RelationPath, { kind: "self" }> => ({ kind: "self" });
export const ancestorPath = (first: RelationStep, ...rest: RelationStep[]): Extract<RelationPath, { kind: "ancestor" }> => /* variadic-with-required-first */
export const subcasePath = (identifier: string, ofCaseType?: string): Extract<RelationPath, { kind: "subcase" }> => /* absent-key contract */
export const anyRelationPath = (identifier: string, ofCaseType?: string): Extract<RelationPath, { kind: "any-relation" }> => /* absent-key contract */
```

`propertyRefSchema` extended with optional `via: relationPathSchema.optional()`. `prop()` builder extended with optional third parameter.

**Deviations from the v2 plan's outline above (all principled improvements):**

1. **`xmlElementNameField` / `caseTypeField` helpers used** at every identifier slot rather than inline `z.string().regex(...)` calls. Three helpers (xmlElementNameField, caseTypeField, casePropertyField) collapse 10 near-identical regex+message duplications across the file. The helpers also normalize the user-facing error-message phrasing.
2. **`z.tuple([T], T)` (Zod 4 idiom) instead of `.array(T).min(1)`** for the ancestor `via` non-empty constraint. The plan's `.min(1)` form is correct at parse time but doesn't lift the non-emptiness into the inferred type; the tuple-with-rest form does (per Zod issue #5253 / Zod 4 migration guide). Applied holistically — also to `andSchema.clauses`, `orSchema.clauses`, `inSchema.values`.
3. **Variadic-with-required-first `ancestorPath(first, ...rest)`** instead of plain `(...steps)`. Catches empty calls at compile time, mirroring the `and` / `or` / `isIn` builder pattern.
4. **Per-kind narrowed return types** (`Extract<RelationPath, { kind: "..." }>`) on builders rather than the wide `RelationPath` union. Callers narrowing on `kind` after a builder call get per-variant fields directly.
5. **`anyRelationPath` builder added** (the v2 plan's outline omitted it; the schema has four kinds and a fourth builder is structurally consistent).
6. **Absent-not-undefined contract** on every optional slot (`prop`'s `via`, `relationStep`'s `throughCaseType`, `subcasePath` / `anyRelationPath`'s `ofCaseType`). Builders construct objects without materializing `slot: undefined`, preserving round-trip equality assertions.

**Originating-scope semantics on `propertyRefSchema.caseType`** (locked in JSDoc; consumers must encode this contract):

`caseType` names the **originating scope** — the case type the predicate runs against (the predicate's "self" position) — NOT where the property lives when `via` is present. With `via` absent or `{ kind: "self" }`, the property is read on a case of `caseType`. With `via` a relation walk, the walk resolves to a destination case type and `property` is read on that destination. The `caseType` qualifier stays explicit even when `via` is present so the originating scope is always recoverable without tracing back through nesting. Task A5's type checker encodes this contract.

**Wire-target portability for `any-relation`**: matches both CHILD and EXTENSION relationships under one identifier on the Postgres target. CCHQ's on-device and CSQL function sets expose only direction-specific operators (`ancestor-exists` / `subcase-exists`), so `any-relation` has no direct CCHQ wire form. The representability checker (Task B5) rejects it for CCHQ targets; any consumer compiling to a CCHQ target must reject or rewrite the kind into a direction-specific one.

### Task A4: Add Term split — session-context separated from session-user — SHIPPED

Shipped across commits `6b221054` → `2d0c308a`.

**Files modified:**
- `lib/domain/predicate/types.ts`
- `lib/domain/predicate/builders.ts`
- `lib/domain/predicate/typeChecker.ts`
- `lib/commcare/predicate/xpathEmitter.ts`
- `lib/domain/predicate/__tests__/types.test.ts`
- `lib/domain/predicate/__tests__/builders.test.ts`
- `lib/domain/predicate/__tests__/typeChecker.test.ts`
- `lib/commcare/predicate/__tests__/xpathEmitter.test.ts`

**The wire layout this task encodes** (CCHQ source is `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`):

- **`/session/user/data/<field>`** — populated by `addUserProperties` at `:105-117`. Open namespace; arbitrary custom user-data field names (e.g., `commcare_location_id`, `commcare_project`, `is_supervisor`, `role`, `commtrack-supply-point`).
- **`/session/context/<field>`** — populated by `addMetadata` at `:89-103`. Closed namespace; seven framework-controlled fields: `deviceid`, `appversion`, `username`, `userid`, `drift`, `window_width`, `applanguage`.

The shipped `userContextRefSchema` (one `kind: "user"` arm pointing only to `/session/user/data/<field>`) accepted any string at any field, so `userField("userid")` emitted `/session/user/data/userid` — a path that silently returns empty because `userid` lives at `/session/context/userid`. The split eliminates that leak.

**Schemas that landed:**

```ts
// Closed set of framework-populated /session/context/<field> entries with
// authoring-meaningful semantics. The full framework set (per
// SessionInstanceBuilder.java:89-103) also includes `drift`, `window_width`,
// and `applanguage` — diagnostic / UI-internal / localization fields with
// no authoring use case today. Adding to the enum is non-breaking; promote
// when a real use case surfaces.
const SESSION_CONTEXT_FIELDS = ["userid", "username", "deviceid", "appversion"] as const;

const sessionUserSchema = z.object({
  kind: z.literal("session-user"),
  field: xmlElementNameField("Session-user field"),
});

const sessionContextSchema = z.object({
  kind: z.literal("session-context"),
  field: z.enum(SESSION_CONTEXT_FIELDS),
});
```

**Builders that landed:**

```ts
export const sessionUser = (field: string): SessionUserRef => /* absent-not-undefined contract */;
export const sessionContext = (field: SessionContextField): SessionContextRef => /* ... */;
```

`SessionUserRef = z.infer<typeof sessionUserSchema>` and `SessionContextRef = z.infer<typeof sessionContextSchema>` — structurally equivalent to `Extract<Term, { kind: "..." }>`. The `z.infer` form matches every other Term builder in the file (`prop`, `input`, `literal`); the `Extract<...>` form is reserved for predicate and relation-path builders. This was a deviation from my initial implementer prompt, validated as the established convention by the code-quality reviewer.

The shipped `userContextRefSchema` was **replaced directly** — no migration helper, no deprecation alias. Same pattern A1/A2/A3 followed: the AST has not been persisted in production (`userContextRefSchema` was contained entirely within `lib/domain/predicate/` and the emitter), so call-site sweep is the right move.

**Type-checker arm split** at `lib/domain/predicate/typeChecker.ts`: shipped `case "user"` (returning `"text"` unconditionally) became:
- `case "session-user"` → `"text"` (the `/user/data/` namespace returns string at the wire because `addUserProperties` writes Hashtable<String,String> values).
- `case "session-context"` → `"text"` (v1's four-field set is wire strings).

**Emitter arm split** at `lib/commcare/predicate/xpathEmitter.ts` (slated for B6 deletion):
- `case "session-user"` → `instance('commcaresession')/session/user/data/${term.field}`
- `case "session-context"` → `instance('commcaresession')/session/context/${term.field}`

**Deviations from the v2 plan's outline above (all principled improvements):**

1. **Field-set rewrite from the v2 outline.** The original v2 outline specified `["userid", "username", "appid", "domain", "device_id"]`. Three of those were wrong vs CCHQ's actual wire form: `appid` is `appversion`; `device_id` is `deviceid`; `domain` doesn't exist anywhere in the session at all. Verified at `SessionInstanceBuilder.java:89-103` and corrected before dispatch.
2. **No migration helper.** The v2 outline included a migration helper for the `kind: "user"` → split. The shipped AST has no Firestore reach, so call-site sweep is correct (matching A1/A2/A3); migration code would carry persistent debt for a problem that doesn't exist.
3. **`appversion` lex-ordering rationale corrected post-implementation.** A first pass shipped a comment claiming "lex ordering on appversion happens to match semantic version ordering." That's false — `'10.0' < '2.0'` lexicographically, and CommCare HQ has crossed 9 → 10 routinely (e.g. `"2.53.0"` lex-compares as less than `"2.9.0"`). Rewrote the rationale across `types.ts`, `typeChecker.ts`, and the test comment to be honest: lex is the only wire-exposed ordering on `/session/context/appversion`; semver-correct gates compose multiple comparisons; authoring-correctness for version gating is Plan 3 / validator territory. The return type stays `"text"` (the wire is a string regardless of how authors compare it).
4. **Holistic JSDoc sweep.** The `userField → sessionUser/sessionContext` rename initially missed five "user-context" JSDoc references that the rename should have updated (`xmlElementNameField` helper docstring, `match` operator's `unwrap_value` paragraph, `between` ordering JSDoc, file-header coverage comment in `typeChecker.ts`, `isNull`'s Term-variant list in `builders.ts`). Swept in the same follow-up commit; the `xmlElementNameField` docstring also now notes that the closed-enum `session-context` arm uses `z.enum(SESSION_CONTEXT_FIELDS)` directly rather than this helper.

**Memory carry-forward to A5–A7 implementer prompts:** explicitly require a comment-prose grep at the end of any rename (`rg "<old-term>"` to verify zero leftovers); pre-verify any "lex ordering happens to work" / "semver compares correctly as text" claims against real CCHQ version strings before shipping rationale comments.

### Task A4.5: Add `is-blank` operator + lock null/blank semantic — SHIPPED

Shipped across commits `c2d2b393` → `2f7941d0` → `510441fb`.

**Files modified:**
- `lib/domain/predicate/types.ts`
- `lib/domain/predicate/builders.ts`
- `lib/domain/predicate/typeChecker.ts`
- `lib/commcare/predicate/xpathEmitter.ts`
- `lib/domain/predicate/__tests__/types.test.ts`
- `lib/domain/predicate/__tests__/builders.test.ts`
- `lib/domain/predicate/__tests__/typeChecker.test.ts`
- `lib/commcare/predicate/__tests__/xpathEmitter.test.ts`
- `docs/superpowers/specs/2026-04-30-case-list-search-design.md` (Null vs blank semantics subsection)
- `docs/superpowers/plans/2026-04-30-case-list-search-foundation.md` (this section + B5 representability table)

**What landed:**

- `isBlankSchema` (portable: absent OR empty-string), parallel-shaped to the shipped `isNullSchema` (strict: absent only). Both accept any Term in `left`; literal-rejection is the type-checker's job.
- `isBlank` builder mirroring `isNull` with `Extract<Predicate, { kind: "is-blank" }>` return type.
- Type-checker `walk` switch has dedicated arms for both operators sharing a `checkAbsenceOperator` helper that rejects literal-shaped `left` and resolves non-literal terms for unknown-property / unknown-input error propagation.
- Transitional emitter (`xpathEmitter.ts`, slated for B6 deletion) emits `<term> = ''` for `is-blank` and throws on `is-null` — minimal arms; the per-dialect B-stage emitters write the correct wire forms from the spec subsection, not by copying this transitional code.
- The shipped `isNullSchema` JSDoc was rewritten to lock the strict-absent semantic ("key not present in JSONB / Map") and drop the "does the property carry a value?" hedge.

**Locked semantic, family-wide**: the AST is **Postgres-strict**. Every operator that touches null / empty-string / missing-property semantics distinguishes the three states (absent / cleared / explicit-empty) at the data-model layer. CCHQ's wire collapse is a per-dialect emitter concern + B5 representability checker error, not an AST design constraint.

**v1 surface scoping** (per the user's "apps are always in a valid state" principle): v1 authoring surfaces (filter UI, SA tool surface, validator) emit only `is-blank` for predicates targeting CCHQ. `is-null` has no v1 author-facing path — it's foundation infrastructure consumed by future non-filter surfaces (case-data inspection, audit / admin views, expression operators that need to distinguish absent from empty, Phase-2 Cloud SQL deploy where strict-absent is natively representable). The B5 representability checker stays as defense-in-depth for any programmatic source that ever produces `is-null` in a CCHQ-bound emission.

**Deviations from the v2 plan's outline above (all principled improvements):**

1. **CCHQ citation correction (Finding 1 from code-quality review)**: the initial commit cited `case_property_missing(prop)` as registered at `xpath_functions/__init__.py:46`. Verified false against `/Users/braxtonperry/code/commcare-hq` — line 46 is `'within-distance'`; `case_property_missing` is not a CSQL XPath function at all. It's a Python helper at `corehq/apps/es/case_search.py:378`, called internally by `case_property_query()` at lines 241-246 when value == ''. The actual CSQL wire form for `is-blank(prop)` is `prop = ''`, which the server short-circuits internally. Citations corrected across all sites in the follow-up commit `2f7941d0`.
2. **Architectural reframing (Finding 3 from code-quality review)**: the initial commit's "four-layer practical defense" framing (Representability checker / UI default card with `is-null` opt-in / SA prompt / Platform-divergence panel) leaked CCHQ's "click through warnings" pattern into Nova. Reworked in `510441fb` to the v1-surface-scoping framing: there is no v1 path producing `is-null` for users; the operator exists in the AST as foundation infrastructure for future surfaces. Documented in the spec and in code JSDoc.
3. **Test-comment sweep (Finding 2)**: production JSDocs in `inSchema` and `multiSelectContainsSchema` were updated to cite both `is-null` and `is-blank` as canonical absence-check shapes; parallel test-file comments needed the same sweep. Done in `2f7941d0`.

**Memory carry-forward to A5–A7 / B-stage / C-stage implementer prompts:**

- "Apps are always in a valid state" is the deeper design principle — never propose authoring flows that introduce a state the user has authored but cannot instantly export. Construction-time rejection is the right gate; opt-in / are-you-sure / advanced-toggle framing imports CCHQ's click-through-warnings pattern back in.
- For B-stage emitters: wire forms come from the spec's "Null vs blank semantics" table, NOT from copying the transitional `xpathEmitter.ts`.
- For any future operator touching null/empty/missing semantics: design Postgres-strict at the AST, the wire layer handles the constraint via per-dialect emitter + B5 representability checker.

### Task A5: Type-checker rules for new Predicate operators — SHIPPED

Shipped across commits `8bead4b5` → `9c1e2bdd` → `be911ee1`.

**Files modified:**
- `lib/domain/predicate/typeChecker.ts`
- `lib/domain/predicate/__tests__/typeChecker.test.ts`

**What landed:**

Most operators on the v2 plan's per-operator-rules list were already shipped clean from earlier tasks (`match-all` / `match-none` / `match` / `multi-select-contains` / `in` / `within-distance` / `when-input-present` / `compare` operand resolution). A4.5 shipped `is-null` / `is-blank` via `checkAbsenceOperator`. **A5's actual scope was the three remaining stubs that throw**: `between`, `exists`, `missing`, plus the `prop.via` proper destination-scope resolution that A3 had stubbed as a CheckError emit.

Helpers and rules:

- `checkBetween` — ordered-types check (re-uses the shipped `ORDERED_TYPES` constant; no extraction needed), per-bound `typesCompatible` check, literal-pair `lower > upper` impossibility detection (with caveat doc on TZ-suffixed datetime corner per the code-quality follow-up).
- `checkRelationPath(relationPath, originCaseType, ctx, errors, path) → string | undefined` — walks `parent_type` for `ancestor` (with `throughCaseType` validation against `origin.parent_type`); reverse-walks for `subcase` and `any-relation` with `ofCaseType` disambiguation. Distinct error messages for unknown originating type, no-candidates, ambiguous (multiple candidates without `ofCaseType`), and `ofCaseType` names a non-subcase. The `case "self":` arm is structurally unreachable (callers handle self elsewhere) — defensive throw + JSDoc.
- `checkInDestinationScope(predicate, destination, ctx, errors, path)` — recursively walks the where-clause with `currentCaseType` rebound via spread (`{ ...ctx, currentCaseType }`) so the parent scope can't be polluted; the recursive walk re-enters the standard `walk` function so nested `exists`/`missing` resolve their own destination scopes correctly.
- `checkRelationalQuantifier` — top-level dispatcher for `exists`/`missing`. Rejects `via.kind === "self"` uniformly (advisor-backed deviation from the v2 plan's outline — `exists(self, w)` reduces to `w(currentScope)` and is degenerate at every position; the redundancy belongs in A7's reduction module, not in scope-boundary plumbing). Routes the where-clause through `checkInDestinationScope`.
- `resolveTermType`'s `prop` arm flips from emit-and-return on non-self `via` to proper destination-scope resolution: looks up `term.property` on the case type that `checkRelationPath` resolves to from `term.caseType`. The originating-scope JSDoc on `propertyRefSchema.caseType` (locked in A3) is encoded — `caseType` names the originating scope; with `via` present, the property is read on the destination.
- `TypeContext.currentCaseType?: string` — new optional slot, threaded through callers. Optional so existing call sites compose unchanged; gates the `prop.caseType === currentCaseType` constraint in `resolveTermType` only when bound.

**CCHQ source citations verified at `/Users/braxtonperry/code/commcare-hq`:** `subcase-exists` registered at `xpath_functions/__init__.py:41`, implementation at `subcase_functions.py:51-62` with optional filter at `:207`. `ancestor-exists` registered at `__init__.py:51`, implementation at `ancestor_functions.py:97-118` with mandatory 2-arg via `confirm_args_count` at `:109`.

**Deviations from the v2 plan's outline above (all principled improvements):**

1. **Uniform rejection of `exists(via=self, ...)`** instead of the plan's "allow nested but reject top-level" framing. `exists(self, w)` is degenerate at every position; advisor-backed call to push the reduction into A7 rather than carry scope-boundary plumbing for a shape no UI surface or reducer would emit.
2. **`ORDERED_TYPES` constant re-used as-is** from the shipped comparison checker — no extraction required because it was already a module-top constant. Same for `typesCompatible`.
3. **JSDoc precision pass** (commit `be911ee1`): `checkRelationPath` ancestor arm's "Should not happen" comment was reframed to acknowledge the originating-side failure path is reachable after A5's flip; the literal-pair lex-order doc carries an explicit caveat for TZ-suffixed datetime strings (CCHQ wire convention is naive datetimes so behavior is correct in practice).
4. **Test coverage filled three distinct error paths** the initial commit missed: `between` directly on `decimal` and `time` properties, subcase walk with zero candidates, and `prop.via` with an unknown originating case type. Each path produces a unique editor-facing message.

**Verification gates (all green at HEAD `be911ee1`):**
- 141 typeChecker tests pass (was 137 before the code-quality follow-up; +4 new for the coverage gaps)
- Full predicate suite green
- `npx tsc --noEmit` clean
- `npx @biomejs/biome check lib/domain/predicate/` clean

### Task A6: ValueExpression schemas + predicate operand widening — SHIPPED

Shipped across commits `69879f04` → `a289b39d` → `929866ea` → `85fdd8a6` → `48a1e04b` → `bb82ce9d` → `cf2836b0` → `86935519` → `c73f25e1` → `718eceb4` → `f6cb20f6`.

**Files modified:**
- `lib/domain/predicate/types.ts` — adds 14 `ValueExpression` arms + widens 9 predicate operand fields across 6 schemas (`comparison.left`/`right`, `in.left`, `within-distance.center`, `between.left`/`lower`/`upper`, `is-null.left`, `is-blank.left`) from `Term` to `ValueExpression`. Both unions hand-declared because z.lazy slots break z.infer; drift guards expanded to cover every operand-widened predicate arm and every ValueExpression arm.
- `lib/domain/predicate/builders.ts` — adds `toValueExpression(...)` auto-wrap helper plus all 14 ValueExpression builders (`term`, `today`, `now`, `dateAdd`, `dateCoerce`, `datetimeCoerce`, `double`, `arith`, `concat`, `coalesce`, `ifExpr`, `switchCase` + `switchExpr`, `count`, `unwrapList`, `formatDate`). Predicate-operand builders (`eq`, `isIn`, `within`, `isNull`, `isBlank`, `between`) accept `Term | ValueExpression` and route Term inputs through the auto-wrap so existing call sites compose unchanged.
- `lib/domain/predicate/typeChecker.ts` — adds `checkExpression(...)` (the value-side analogue of `resolveTermType`), the `SEQUENCE_TYPE` sentinel for `unwrap-list`'s output, and the `accumulateBranchType` helper shared across `if` / `switch` / `coalesce` branch-agreement loops. Operand callsites (`checkComparison`, `checkIn`, `checkWithinDistance`, `checkBetween`, `checkAbsenceOperator`) swap from `resolveTermType` to `checkExpression`; the literal-pair impossibility check on `between` and the literal-rejection rule on `is-null`/`is-blank` unwrap the operand's `term` arm.
- `lib/commcare/predicate/xpathEmitter.ts` — adds `unwrapTermFromExpression(...)` with an exhaustive switch that accepts the `term` arm and throws on every other arm with an operator-scope error stating only the term-arm structural lifter is supported by this emitter. Per-dialect arm support lives in the per-dialect emitter modules.

**Architecture pivot from option (a) to (b)+(c):**

The first commit (`69879f04`) exported shared type-checker helpers (`ORDERED_TYPES`, `typesCompatible`, `ResolvedType`, etc.) under an option-(a) shape — separate `lib/domain/predicate/` and `lib/domain/expression/` packages bridged by a `value-expression` Term arm via cross-package `z.lazy`. After that commit landed, the architecture pivoted to (b)+(c): drop the `value-expression` Term arm; widen Predicate operands directly to `ValueExpression`; collapse both families into a single package. The pivot eliminates cross-package `z.lazy` in favor of intra-file `z.lazy` for genuine self-recursion only — the canonical Zod 4 pattern. The exported helpers from `69879f04` survive the pivot intact and stay in the predicate package.

**What landed:**

The two families collapse into one package: `lib/domain/predicate` houses both `Predicate` and `ValueExpression`. Cross-cycle recursion (Predicate operators → ValueExpression operands; ValueExpression `if` / `switch` / `count` arms → Predicate clauses) goes through `z.lazy(...)` intra-file. No cross-package z.lazy.

Schemas cover the spec's 14 arms verbatim — `term`, `today`, `now`, `date-add`, `date-coerce`, `datetime-coerce`, `double`, `arith`, `concat`, `coalesce`, `if`, `switch`, `count`, `unwrap-list`, `format-date`. Non-empty arms (`concat.parts`, `coalesce.values`, `switch.cases`) use the tuple-with-rest pattern matching `and.clauses` / `or.clauses` for compile-time empty-list rejection.

Type-checker rules:
- `term` delegates to `resolveTermType`.
- `today` returns `date`; `now` returns `datetime`.
- `date-add` returns the same type as `date` (date or datetime); `quantity` must be numeric.
- `date-coerce` / `datetime-coerce` accept text-shaped operands; return date/datetime.
- `double` accepts text or numeric; returns decimal.
- `arith` operands must be numeric; result type follows int×int=int, mixed=decimal.
- `concat` parts cast to text; result is text.
- `coalesce` values must agree on type (after empty-string-coerce-to-null); result is the agreed type.
- `if`: cond is Predicate (recursed via the predicate walker); then/else types must agree.
- `switch`: on is value; cases.when literals must be compatible with `on`'s type; cases.then must agree with each other and with fallback.
- `count` returns int; the relation walk is type-checked via `checkRelationPath`; the optional `where` clause is type-checked recursively in the destination scope.
- `unwrap-list` accepts text-shaped; returns the `_sequence` sentinel. v1 has no AST consumer for the sequence type — `multi-select-contains.values` and `in.values` stay literal-only because every wire target demands a static value list. The CSQL emitter routes `unwrap-list` into `selected-any(prop, unwrap-list(...))` at wire-emit time; that pattern lands in B-phase. The compatibility table treats `_sequence` as incompatible with every scalar (including itself) so a v1 author who composes a sequence into a scalar slot gets a clear error.
- `format-date` accepts date or datetime; returns text.

The `then` field name on `if` and `switch.cases` triggers Biome's `noThenProperty` rule. Suppressed inline with rationale on `ifSchema`'s JSDoc: the slot holds a ValueExpression object (one of fifteen non-function shapes), never a callable, and the AST never reaches a Promise-resolution boundary, so the thenable hazard the rule defends against doesn't apply.

**Reviews:**

- Spec-compliance review (sonnet): ✅ Compliant. Zero findings ≥80 confidence; the 14-arm coverage, 9-operand widening, builder surface, type-checker rules, and xpathEmitter scope all match the spec.
- Code-quality review (opus): 11 findings. All addressed in the fix-pass commit chain (`48a1e04b` → `f6cb20f6`) — eternal-present sweep across comments + runtime errors + test assertions, `TERM_KINDS` cast removal, `asValueExpr` test-helper consistency, `accumulateBranchType` extraction, object-shape `it.each` parameterization, Zod 4 `z.lazy().optional()` verification, and re-review minor follow-ups on residual forward-temporal framing in the `is-null` / `count` JSDoc. Re-review approved.
- Findings deferred: the drift-guard optional-vs-required gap on stripped recursive slots (a hypothetical drift mode the current guard doesn't pin); documented inline as a known limitation, not patched.

**Verification gates (all green at HEAD `f6cb20f6`):**
- 494 predicate-domain tests pass
- Full repo: 2270 tests / 138 files
- `npx tsc --noEmit` clean
- `npm run lint` clean
- Eternal-present sweep grep returns zero hits

### Task A7: Reduction module — SHIPPED

Shipped across commits `73724f51` → `a8374aa0` → `09946c67` → `14ffcc7a` → `7f505a92` → `b2a89cbd`.

**Files modified:**
- `lib/domain/predicate/reduction.ts` (new) — `reduceAnd` / `reduceOr` / `reduceNot` exports, each returning the rewritten Predicate when a reduction applies and `undefined` otherwise. Sentinel returns use inline discriminator-only literals (`{ kind: "match-all" }` / `{ kind: "match-none" }`) so the module is zero-runtime-import on the rest of the predicate package.
- `lib/domain/predicate/__tests__/reduction.test.ts` (new) — 10 unit tests covering all 7 reductions plus the no-reduction-applies undefined returns.
- `lib/domain/predicate/builders.ts` — `and` / `or` / `not` thread inputs through the reducers before falling through to standard construction. Function overloads preserve precise per-arm return types: `and()` → `match-all`, `and(x)` → `T`, `and(x, y, ...)` → `Extract<{ kind: "and" }>`; parallel for `or`. `not` carries four overloads: `not(matchAll)` → `match-none`, `not(matchNone)` → `match-all`, `not(not(...))` → `Predicate`, `not(<other>)` → `Extract<{ kind: "not" }>`.
- `lib/domain/predicate/__tests__/builders.test.ts` — 10 builder-integration tests + a `typeCheckReductionNarrowing` block locking all 11 reduction outcomes at the type level. Removed the `@ts-expect-error` for `and()` / `or()` (now legitimately produce sentinels via reduction).
- `lib/domain/predicate/types.ts` — refreshed `andSchema` / `orSchema` non-empty-tuple comment to frame the schema check as a defensive backstop for direct-literal / parsed-JSON paths, with the builder reductions as the primary surface.

**The 7 reductions:**
- `and([])` → `match-all`
- `or([])` → `match-none`
- `and([x])` → `x`
- `or([x])` → `x`
- `not(match-all)` → `match-none`
- `not(match-none)` → `match-all`
- `not(not(x))` → `x`

**Architectural decisions:**

1. **Separate `reduction.ts` module** (over in-builder helpers) — independent unit-testability of each reducer + clean separation between the structural reduction rules and the builder API surface.
2. **`undefined` no-reduction signal** (over a sentinel constant or always-return-Predicate) — the builder dispatches on `reduceX(...) ?? <standard construction>` in a single line; readers see the reduction-first pattern at the call site without indirection.
3. **TypeScript function overloads on `and` / `or` / `not`** (over a single widened `Predicate` return) — preserves the file-level "per-arm narrowing" contract that lets call sites access `.clauses` / `.clause` directly without re-narrowing.
4. **Inline sentinel literals in `reduction.ts`** (over calling `matchAll()` / `matchNone()` from `builders.ts`) — the cyclic builder call would have created a `reduction.ts` ↔ `builders.ts` import cycle that worked only because `matchAll` / `matchNone` were `function` declarations (hoisted). Inline keeps the dep-graph linear; the schema's `z.literal("match-all")` is the source of truth on the kind discriminator, and the type system catches any structural divergence.
5. **Schema's non-empty tuple stays as defensive backstop** for direct-literal and parsed-JSON paths — the builder reductions are the primary surface; the schema check fires only when someone bypasses the builders.

**Reviews:**

- Spec-compliance review (sonnet): ✅ Compliant. All 7 reductions, builder integration (reduction-first wiring), and test coverage match the plan.
- Code-quality review (opus): 4 findings — 1 Blocker (cycle), 2 Important (mid-file import + brittle line citation in JSDoc), 1 Minor (future-consumer hedge). All addressed in the fix-pass commit chain (`7f505a92` → `b2a89cbd`). Re-review approved.

**Verification gates (all green at HEAD `b2a89cbd`):**
- 514 predicate-domain + commcare-predicate tests pass (was 494 pre-A7; +20 for reduction)
- `npx tsc --noEmit` clean
- `npm run lint` clean
- Cycle smoke test: `rg "from \"./builders\"" lib/domain/predicate/reduction.ts` returns zero hits

---

## Group B — Supersede the broken emitter (split into per-dialect visitors)

These tasks delete `lib/commcare/predicate/xpathEmitter.ts` and replace it with three per-dialect emitters. The shipped CCHQ source citations and the per-context string-escape strategy migrate into shared helpers.

### Task B1: Extract shared quoting helpers — SHIPPED

Shipped across commits `670ce644` → `a090e557` → `fad0a6a5`.

**Files modified:**
- `lib/commcare/predicate/stringQuoting.ts` (new, 180 lines) — three permanent helpers + the canonical `WireDialect` union (`"case-list-filter" | "csql" | "search-filter"`) the per-dialect emitters and the B5 representability checker share.
- `lib/commcare/predicate/__tests__/stringQuoting.test.ts` (new, 41 tests) — per-dialect coverage for `quoteLiteral`, pass-through assertions for `quoteIdentifier`, and exponent-form expansion pinning for `formatNumeric` (exact decimal output strings asserted, including the `1e-7` / `1e21` boundaries).
- `lib/commcare/predicate/xpathEmitter.ts` — slimmed to delegate every literal-emission and identifier-emission callsite into `stringQuoting`. The transitional emitter's `EmissionContext` (`"case-list-filter" | "csql"`) stays a structural subset of `WireDialect` with no aliasing back-and-forth, preserving the type-system constraint that the transitional emitter does not handle `search-filter`.

**Helper surface (the new `stringQuoting.ts` module exports):**
- `WireDialect` — the canonical three-arm union; B2-B5 import the type from here rather than redeclaring.
- `quoteLiteral(value, dialect)` — per-dialect string-literal escape. `case-list-filter` and `search-filter` (both XPath 1.0 on-device) share the alternating-quote `concat()` fallback for embedded single quotes; `csql` switches between single- and double-quoted literals and throws on values containing both quote styles (CSQL excludes `concat()` from its value-function whitelist per `corehq/apps/case_search/xpath_functions/__init__.py:27-36`, with `dsl_utils.unwrap_value` raising `CaseFilterError` on any function name outside that whitelist).
- `quoteIdentifier(name)` — pass-through. Centralized so the per-dialect emitters call one place rather than open-coding the rule.
- `formatNumeric(value)` — verbatim port of the prior numeric-literal expansion (CommCare's XPath grammar at `lib/commcare/xpath/grammar.lezer.grammar:133-136` admits decimal-only literals; JavaScript's `String(n)` switches to exponent form below ~1e-6 and at or above 1e21, so the helper rebuilds the decimal manually for those magnitudes).

**Architectural decisions:**

1. **Single canonical `WireDialect` union exported from `stringQuoting.ts`** (over redeclaring per-emitter or scattering in `types.ts`) — B5's representability checker, the three per-dialect emitters, and `quoteLiteral` itself all share one type-level definition; drift is structurally impossible.
2. **`EmissionContext` stays distinct from `WireDialect`** (no alias, no re-export) — the transitional emitter's narrower union preserves the type-system signal that it does not yet handle `search-filter`; assignment compiles cleanly at the `quoteLiteral` callsite because `EmissionContext` is a structural subset.
3. **`quoteIdentifier` wired through the transitional emitter's `prop` arm** (both reserved-attribute branch and bare-name branch) — the JSDoc claim that "every emitter funnels identifier emission through it" is factual today, not aspirational.
4. **Transitional emitter trimmed to minimal comments** per `feedback_minimize_transitional_docs.md` (the file is deleted in B6) — citation depth migrates to the permanent `stringQuoting.ts` module and to the per-dialect emitters in B2-B5; no rich JSDoc on doomed surfaces.
5. **Three test-suite voice patterns scrubbed in the same task** — the original sweep regex missed `supersed`, `until X land`, and `if one ever lands`; the strengthened regex set is now part of the verification gate for all subsequent B-tasks.

**Reviews:**

- Spec-compliance review (sonnet): ✅ Compliant. All three helpers, the dialect type, the per-dialect behavior, the transitional-emitter delegation, and the boundary-segment invariant for the concat fallback verified.
- Code-quality review (opus): 3 findings on the original `670ce644` — 1 Blocker (file-level header voice with "superseded ... until ... land"), 2 Important (`EmissionContext` widening comment + `quoteIdentifier` rationale both roadmap-flavored). Resolved in fix-pass `a090e557` and re-review APPROVED. Same review's tail flagged two pre-existing "if one ever lands" hits in the test parameterization comments — scrubbed in follow-up `fad0a6a5`.

**Verification gates (all green at HEAD `fad0a6a5`):**
- 555 predicate-domain + commcare-predicate tests pass (514 baseline + 41 new in `stringQuoting.test.ts`)
- `npx tsc --noEmit` clean
- `npm run lint` clean (zero warnings)
- Strengthened eternal-present sweep returns zero hits across the four predicate-package files (regex extends the prior sweep with `supersed`, `until [^.]*(land|come|arriv)`, `future change`, `will (eventually|land|move|migrate)`, `transitional emitter knows`, `deleted in (B|C)`, `ever lands`, `if one ever`, `hypothetical`)

### Task B2: Build the case-list-filter visitor

**Files:**
- Create: `lib/commcare/predicate/caseListFilterEmitter.ts`
- Test: `__tests__/caseListFilterEmitter.test.ts`

Operator coverage (the on-device subset):
- Sentinels: `match-all` → `true()`, `match-none` → `false()`
- Logical: `and`, `or`, `not`
- Comparison: `compare` (six ops)
- `is-null`: `prop = ''`
- `in`: or-of-eq (always; never `selected-any`)
- `between`: expand to `and(gte, lte)`
- `multi-select-contains` quantifier=any single-value: `selected(prop, 'v')`
- `multi-select-contains` quantifier=any multi-value: expand to OR of `selected()` calls
- `multi-select-contains` quantifier=all: expand to AND of `selected()` calls
- `match` mode=starts-with: `starts-with(prop, 'v')`
- `match` other modes: **throw** (representability checker should have caught earlier; throw is a defense)
- `within-distance`: throw (CSQL-only)
- `exists`: expand to count-presence test against `instance('casedb')` join
- `missing`: `not(exists(...))`
- `when-input-present`: `if(count(<input>), <clause>, true())`

The `exists` expansion is the on-device join pattern: `count(instance('casedb')/casedb/case[@case_id=current()/index/parent][<filter>]) > 0` for an ancestor walk; reverse-direction joins for subcase. Multi-hop ancestors compose nested joins.

Steps:
- [ ] Port shipped emitter tests for comparison + logical to this file (verify behavior unchanged)
- [ ] Write failing tests for new operators (sentinels, between, multi-select expansions, match starts-with, exists join expansion)
- [ ] Implement visitor
- [ ] Add throw branches for CSQL-only operators with clear error messages
- [ ] Run tests, commit

### Task B3: Build the CSQL visitor with hoisting + `concat()` wrapping

**Files:**
- Create: `lib/commcare/predicate/csqlEmitter.ts`
- Create: `lib/commcare/predicate/csqlHoist.ts`
- Test: `__tests__/csqlEmitter.test.ts`, `csqlHoist.test.ts`

CCHQ's CSQL function vocabulary is split into two disjoint sets, verified at `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py`:
- **Query functions** (predicate-position; lines 39-54): `selected`, `selected-any`, `selected-all`, `fuzzy-match`, `phonetic-match`, `fuzzy-date`, `within-distance`, `subcase-exists`, `subcase-count`, `ancestor-exists`, `match-all`, `match-none`, `not`, `starts-with`, `=`, `!=`, `<`, `<=`, `>`, `>=`.
- **Value functions** (term-position; lines 27-36): `date`, `date-add`, `datetime`, `datetime-add`, `double`, `now`, `today`, `unwrap-list`.

Conditionals (`if`, `switch`), aggregations (`count` outside top-level comparison), arithmetic (`arith`), and string concatenation (`concat`) are **not** in either set. They cannot appear inside the CSQL fragment; they must be hoisted into the on-device XPath wrapper that builds the `_xpath_query` string.

**`csqlHoist.ts` performs the hoisting pass** as a separate AST → AST transformation before emission:
- Walks the predicate AST.
- For each `if` / `switch` / `arith` / `concat` / non-comparison `count` node found in a position the CSQL emitter cannot represent, lifts the node into a wrapper expression and replaces it in the inner AST with a synthetic input ref (so the inner emission sees a stable interpolation point).
- The wrapper output is what gets emitted into `<data key="_xpath_query" ref="...">` — it's an on-device XPath expression that builds the CSQL fragment string. Plan 4's wire emission consumes the wrapper expression, not the bare CSQL fragment.

`subcase-count` is recognized only as the LHS of a binary comparison (`commcare-hq/.../filter_dsl.py:89-95`); the hoisting pass treats `count(...)` outside a top-level comparison as unrepresentable and emits a representability error rather than hoisting it (CSQL has no value-context home for it).

**Operator coverage of the CSQL emission visitor** (after hoisting):
- Comparison + logical (from B2 patterns, `not` from CSQL's query function set).
- `multi-select-contains` quantifier=any: `selected-any(prop, 'v1 v2')`.
- `multi-select-contains` quantifier=all: `selected-all(prop, 'v1 v2')`.
- `multi-select-contains` quantifier=any single value: `selected(prop, 'v')` (`commcare-hq/.../xpath_functions/__init__.py:43` aliases `selected` to `selected-any` server-side; we emit the alias for readability).
- `match` mode=fuzzy: `fuzzy-match(prop, 'v')`.
- `match` mode=phonetic: `phonetic-match(prop, 'v')`.
- `match` mode=fuzzy-date: `fuzzy-date(prop, 'v')`.
- `match` mode=starts-with: `starts-with(prop, 'v')`.
- `within-distance`: `within-distance(prop, '<lat lon>', dist, 'unit')`.
- `exists` ancestor: `ancestor-exists('parent/parent', '<csql filter>')` (multi-hop slashes).
- `exists` subcase: `subcase-exists('rel', '<csql filter>')`.
- `match-all` / `match-none`: emit `match-all()` / `match-none()`.
- `is-null`: `prop = ''`.
- `between`: expand to `and(gte, lte)`.
- Value functions allowed inside terms: `today`, `now`, `date`, `date-add`, `datetime`, `datetime-add`, `double`, `unwrap-list` (CCHQ's value-function set, verified above).

**`concat()` wrapping**: the emitter wraps its output in `concat(...)` unconditionally — every CSQL value is a `concat()` template; downstream code reads one shape. The wrapping pass walks the post-emission string, identifies runtime-instance interpolation points (input refs, session-user refs, session-context refs from the hoisting pass's synthetic inputs), and lifts them as `concat()` arguments. Constant string parts become quoted string literals; runtime parts become path expressions.

Steps:
- [ ] Write failing tests for the hoisting pass: every `if`/`switch`/`arith`/`concat`/`count` node in non-representable positions surfaces as a hoist or a representability error
- [ ] Implement `csqlHoist.ts`
- [ ] Write failing tests for the emitter (CSQL-specific operators, the CCHQ value-function set, concat() wrapping shape)
- [ ] Implement `csqlEmitter.ts`
- [ ] Run tests, commit

### Task B4: Build the post-ES search-filter visitor

**Files:**
- Create: `lib/commcare/predicate/searchFilterEmitter.ts`
- Test: `__tests__/searchFilterEmitter.test.ts`

Same operator coverage as B2 (case-list-filter dialect — on-device subset). Most code is shared with B2 via composition, not duplication. The visitor exists as a separate file because the post-ES context has different scoping (the case-list emitter resolves property refs in the case-list module's case-type scope; the post-ES filter resolves in the search results scope, which is the same case-type but different XPath context root).

Steps:
- [ ] Port B2 emission code as a shared helper module
- [ ] Implement search-filter visitor as thin wrapper specifying the context root
- [ ] Write failing tests
- [ ] Run tests, commit

### Task B5: Build the representability checker

**Files:**
- Create: `lib/commcare/predicate/representability.ts`
- Test: `__tests__/representability.test.ts`

```ts
type RepresentabilityIssue =
  | { kind: "unrepresentable"; node: Predicate | ValueExpression; target: WireTarget; reason: string }
  | { kind: "lossy"; node: Predicate | ValueExpression; target: WireTarget; transformation: string };

type WireTarget = "case-list-filter" | "csql" | "search-filter";

export function validateRepresentability(ast: Predicate, target: WireTarget): RepresentabilityIssue[];
```

Walk the AST. For each node, check against a per-target operator table:

**Unrepresentable on every CCHQ wire target (case-list-filter, CSQL, post-ES search filter):**
- `is-null` — strict "left resolves to absent" has no CCHQ wire form. On every CCHQ dialect, `prop = ''` matches absent / cleared / empty alike; in CSQL the server-side `case_property_query()` short-circuits to `case_property_missing()` semantics at `commcare-hq/corehq/apps/es/case_search.py:241-246`, also matching all three states. v1 has no author-facing surface that produces `is-null` — `is-blank` is the only operator the v1 UI / SA / validator ever emit for CCHQ-bound predicates. The B5 representability checker stays as defense-in-depth: any programmatic source that ever produces `is-null` in a CCHQ-bound emission errors at authoring time. The Cloud SQL Postgres runtime executes `is-null` natively for future non-filter surfaces. Same dispatch pattern as `match(mode: fuzzy)` in case-list-filter context.
- `any-relation` — CCHQ's on-device and CSQL function sets expose only direction-specific operators (`ancestor-exists` / `subcase-exists`); the direction-agnostic walk has no wire form on any CCHQ dialect.

**Unrepresentable on case-list-filter target:**
- `match` mode∈{fuzzy, phonetic, fuzzy-date} — CSQL-only; no on-device equivalent.
- `within-distance` — CSQL-only.
- `date-add` value expression — `date-add` is **not** in `commcare-core/.../parser/ast/ASTNodeFunctionCall.java:113-269`'s on-device dispatcher (it falls through to `XPathCustomRuntimeFunc`, and the case-list-filter context registers no handler for it). Date arithmetic with day-only intervals can be emitted as XPath operator arithmetic (`date(prop) + days`); month/year arithmetic is unrepresentable on-device.

**Unrepresentable on CSQL target:**
- `if` / `switch` / `arith` / `concat` value expressions appearing inside a position the hoisting pass cannot lift (e.g., inside `subcase-exists`'s filter argument). The hoisting pass produces a representability error in this case.
- `count(...)` value expression outside a top-level binary comparison — `subcase-count` is recognized in CSQL only as the LHS of a comparison (`commcare-hq/.../filter_dsl.py:89-95`); standalone `count(...)` has no value-context home.

**Unrepresentable on search-filter target:** same set as case-list-filter (the post-ES dialect mirrors on-device).

**Lossy-but-representable hint surfaces (Plan 3 validator wires the UI message):**
- `compare(prop, literal(""))` and `compare(prop, literal(null))` — emit cleanly to every target but silently match absent fields too on CCHQ wire (CCHQ collapses absent / cleared / empty). The B5 checker flags the node with a `kind: "lossy"` issue carrying the rationale "did you mean is-blank?"; the Plan 3 validator renders the hint as a soft warning on the offending card.

**Lossy on case-list-filter:**
- `multi-select-contains` quantifier=any multi-value: expands to OR-of-`selected()` (still works; slower than CSQL's native `selected-any`).
- `multi-select-contains` quantifier=all: expands to AND-of-`selected()`.
- Multi-hop `exists` — expands to nested `instance('casedb')` joins (works; performs worse with depth).

Returns a list of issues with paths so the UI can highlight the offending card.

Steps:
- [ ] Write failing tests covering each target × operator combo
- [ ] Implement walker + per-target table
- [ ] Run tests, commit

### Task B6: Delete the shipped `xpathEmitter.ts`

**Files:**
- Delete: `lib/commcare/predicate/xpathEmitter.ts`
- Modify: `lib/commcare/predicate/index.ts` to export new visitors instead

Once Tasks B1–B5 are green, delete the old emitter. Update tests/imports across the codebase. The deletion is a structural defense: keeping it around as a "shim" risks future regressions where someone imports the old emitter and bypasses the per-dialect dispatch.

Steps:
- [ ] Verify no consumers of `xpathEmitter` outside `lib/commcare/predicate/`
- [ ] Update `index.ts`
- [ ] Delete file
- [ ] Run full test suite, commit

---

## Group C — Expression emitters + Postgres compiler

### Task C1: Expression emitters (per dialect)

**Files:**
- Create: `lib/commcare/expression/caseListFilterEmitter.ts`
- Create: `lib/commcare/expression/csqlEmitter.ts`
- Test: `__tests__/`

The two emitters cover **different operator sets** because the dialects support different functions.

**case-list-filter emitter** (on-device dispatcher at `commcare-core/.../ASTNodeFunctionCall.java:113-269` registers `today`, `now`, `date`, `format-date`, `if`, `count`, `cond`, `coalesce`, `concat`, plus standard XPath operators):
- `today`, `now`, `date-coerce`, `datetime-coerce`, `double`, `arith`, `concat`, `coalesce`, `if`, `switch` (nested-`if` expansion), `format-date`, `count` (uses relational join expansion against `instance('casedb')`), term lifter.
- `date-add`: emit only when `interval === "days"` and `quantity` is a numeric literal — compiles to XPath operator arithmetic `date(prop) + days_n`. For other intervals (months/years) or non-literal quantities, surface as **unrepresentable** (the representability checker catches this earlier; the emitter throws as a defense).
- `unwrap-list`: unrepresentable on-device.

**csql emitter** (CCHQ value-function set at `commcare-hq/.../xpath_functions/__init__.py:27-36`: `date`, `date-add`, `datetime`, `datetime-add`, `double`, `now`, `today`, `unwrap-list`):
- `today`, `now`, `date-coerce` (emits as `date(...)`), `datetime-coerce` (emits as `datetime(...)`), `double`, `date-add` (all interval kinds; CSQL supports them natively), `unwrap-list`, `format-date`, term lifter.
- `if`, `switch`, `arith`, `concat`, `coalesce`, `count`: **not emitted by this visitor**. Plan 1 Task B3's hoisting pass lifts them into the on-device wrapper that builds the `_xpath_query` string before the CSQL emitter sees the AST. If the visitor encounters one, it throws (defense; the hoist pass should have caught it).

Steps:
- [ ] Write failing tests per operator per dialect, including the asymmetric coverage explicitly (`date-add` representability gates on case-list-filter; hoisted operators throw on CSQL)
- [ ] Implement
- [ ] Run tests, commit

### Task C2: Kysely Database type definitions

**Files:**
- Create: `lib/case-store/sql/database.ts`
- Test: `__tests__/database.test.ts`

`cases`, `case_type_schemas`, `case_indices` table definitions per the spec. Test verifies a typed query compiles via `.compile()` (no live DB needed).

Steps:
- [ ] `npm install kysely`
- [ ] Define Database interface
- [ ] Test typed query compilation
- [ ] Commit

### Task C3: Term compiler — Kysely

**Files:**
- Create: `lib/case-store/sql/compileTerm.ts`
- Test: `__tests__/compileTerm.test.ts`

Compile each Term variant to a Kysely expression. Property refs become typed JSONB extractions (`(properties->>'name')::cast`). Property refs with `via` become joined-table extractions (the `via` is compiled by C5). Literals bind via Kysely params. Search-input / session-user / session-context refs require a runtime binding map passed in `CompileContext`.

Steps:
- [ ] Write failing tests per Term variant
- [ ] Implement
- [ ] Run tests, commit

### Task C4: Predicate compiler — Kysely

**Files:**
- Create: `lib/case-store/sql/compilePredicate.ts`
- Test: `__tests__/compilePredicate.test.ts`

All operators except relational. JSONB operators for multi-select (`?|`, `?&`); pg_trgm for fuzzy; fuzzystrmatch for phonetic; PostGIS for within-distance; standard SQL for the rest.

Steps:
- [ ] Write failing tests per operator
- [ ] Implement, with PostGIS / pg_trgm / fuzzystrmatch dependencies declared
- [ ] Run tests, commit

### Task C5: RelationPath compiler — Kysely (case_indices joins)

**Files:**
- Create: `lib/case-store/sql/compileRelationPath.ts`
- Test: `__tests__/compileRelationPath.test.ts`

Compile each RelationPath variant to a JOIN spec on `case_indices`. Multi-hop ancestor walks compose `case_indices` joins (one row per direct edge; recursive CTE for transitive closure). Subcase paths join in the reverse direction.

Steps:
- [ ] Write failing tests per RelationPath variant
- [ ] Implement
- [ ] Run tests, commit

### Task C6: Expression compiler — Kysely

**Files:**
- Create: `lib/case-store/sql/compileExpression.ts`
- Test: `__tests__/compileExpression.test.ts`

Each ValueExpression variant compiles to Kysely. `today` → `CURRENT_DATE`, `now` → `NOW()`, `date-add` → `+ INTERVAL`. `if` / `switch` → `CASE WHEN`. `count` uses C5's RelationPath compiler + `COUNT(*)` aggregate.

Steps:
- [ ] Write failing tests per Expression variant
- [ ] Implement
- [ ] Run tests, commit

### Task C7: Predicate-using-Expression integration

**Files:** existing compilePredicate.ts updated.

Predicate operator schemas carry `ValueExpression` operands at every widened slot (`compare.left`/`right`, `in.left`, `within-distance.center`, `between.left`/`lower`/`upper`, `is-null.left`, `is-blank.left` — see Task A6). The compiler's predicate-operand handler dispatches on the operand's `kind` discriminator: a `term` arm delegates to the Term compiler; every other arm (`arith`, `if`, `count`, etc.) delegates to the Expression compiler. The Postgres path executes value-expressions natively in any operand position (mixed with predicate-side scalars via the same compatibility table the type checker uses).

Steps:
- [ ] Write failing tests covering Predicates that contain ValueExpressions in operand position (`gt(arith("+", prop, literal(1)), literal(18))`, `eq(count(via), prop("expected"))`)
- [ ] Wire dispatch through `compilePredicate`'s operand handler — `term` → `compileTerm`, every other ValueExpression arm → `compileExpression`
- [ ] Run tests, commit

### Task C7.5: Postgres test infrastructure

**Files:**
- `package.json` — add `@testcontainers/postgresql` dev dependency
- Create: `vitest.setup.ts` (or `lib/case-store/sql/__tests__/globalSetup.ts`) — Vitest `globalSetup` hook that boots the container once per test run
- Create: `lib/case-store/sql/__tests__/setup.ts` — per-test fixture that opens a transaction and rolls it back on teardown
- Test: validate the harness boots a single container per test run, installs `pg_trgm` / `fuzzystrmatch` / `postgis` (and `pg_jsonschema` when available — Plan 2's extension allowlist gate determines which trigger implementation deploys against the live Cloud SQL instance), seeds the schema from the JSON Schema generator once, and accepts a smoke `INSERT` + `SELECT` round-trip.

**Container-sharing strategy**: one container per Vitest run via `globalSetup`, NOT one container per file. Per-test isolation comes from wrapping each test in `BEGIN` + `ROLLBACK` so writes never persist beyond the test. This is the canonical pattern; without it, every test file pays a 5-15s container-boot cost and watch-loop iteration becomes unusable. Document the strategy in the harness JSDoc + a CLAUDE.md note in the case-store package.

Plan 1 introduces this infrastructure (rather than Plan 2) because Plan 1 needs to validate the AST → Kysely compiler against a real Postgres at unit-test time. Plan 2 inherits this harness for `PostgresCaseStore` integration tests; the same container + the same per-test transaction-rollback pattern serve both.

Steps:
- [ ] Install `@testcontainers/postgresql`
- [ ] Implement Vitest `globalSetup` that boots the container, installs extensions, seeds schema, exports the connection string via env
- [ ] Implement per-test fixture (`beforeEach` opens transaction, `afterEach` rolls back)
- [ ] Verify watch-loop cost: `npm run test -- --watch` on a predicate test file should re-run in <1s after the container is up
- [ ] Test: container boots, extensions present, schema bootstrapped, smoke round-trip succeeds, parallel test files share the container
- [ ] Run tests, commit

### Task C8: Barrel exports + CLAUDE.md updates

**Files:**
- `lib/domain/predicate/index.ts`, `lib/commcare/predicate/index.ts`, `lib/commcare/expression/index.ts`, `lib/case-store/sql/index.ts`
- `lib/domain/predicate/CLAUDE.md` (update) — covers both Predicate and ValueExpression AST families since they live in the same package post-A6.

Steps:
- [ ] Write barrels
- [ ] Update CLAUDE.md to reflect the two-AST-families-in-one-package architecture
- [ ] Run full test suite
- [ ] Commit

---

## Final verification

- [ ] `npm run test` — all tests green including pre-existing
- [ ] `npm run lint` — no errors, no warnings
- [ ] `grep -rn "TODO\|FIXME\|XXX" lib/domain/predicate lib/commcare/predicate lib/commcare/expression lib/case-store` — empty
- [ ] Cross-check: every operator from the spec's V1-IN list has type-checker, three wire emitters (where representable), and Postgres compiler coverage. Build a coverage matrix as a docs artifact.
- [ ] Cross-check: every issue in `representability.ts` traces back to a tested case in the wire emitter throw-or-skip behavior.

## Plan shape

Three groups of tasks. Group A extends the shipped AST + type checker; Group B supersedes the broken emitter by splitting into per-dialect visitors and adds the CSQL hoisting pass; Group C lands the Postgres compiler with testcontainers infra. Tasks within each group can run in dependency order; Groups A and B are largely additive on shipped work and can in principle interleave; Group C depends on Group A's full operator set being in place. Plan 2 picks up the Cloud SQL provisioning + extension allowlist gate against the live instance.

The implementor's 33 shipped commits cover the comparison + logical + initial special-operator coverage at the AST + type-checker layers; what's left is everything called out in the v2 corrections above.
