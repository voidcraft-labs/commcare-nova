# Case List & Search — Foundation Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2 — supersedes v1 of this same file. v1 had a fundamental scope error (missing AST coverage for relational queries, expression family entirely absent, three wire dialects collapsed to two) that surfaced after the implementor had shipped Tasks 1–8. v2 reconciles with shipped work where possible and supersedes where the shipped emitter design is structurally wrong.

**Goal:** Build the typed Predicate AST + typed Expression AST, schema-driven type checker, JSON Schema generator, two CommCare wire emitters (on-device XPath + CSQL with total hoisting), and the AST → Kysely compiler. Ships as tested library code with no consumer yet — Plans 2–5 wire it up.

**Architecture summary** (full detail in `docs/superpowers/specs/2026-04-30-case-list-search-design.md` v2):
- Two AST families: Predicate (boolean) + Expression (value), sharing Term shapes
- Three wire targets dispatched as separate visitors: case-list filter (on-device, plain XPath 1.0 + `selected()`), CSQL (server-side ES, full extension set), post-ES search filter (on-device, same as case-list filter)
- Postgres SQL via Kysely as the live runtime — full operator coverage, no losses
- Wire emitters are total — every AST shape produces a wire string via closest-CCHQ-form-or-literal-emission (no per-dialect rejection)

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
- The single-emitter-with-context-branch shape — split into two emitters (on-device XPath + CSQL with hoisting). The shipped emitter's `EmissionContext = "case-list-filter" | "csql"` branch in one function conflated two grammars: the on-device XPath grammar (parsed by the runtime player) and the CSQL grammar (parsed by ElasticSearch at search time). The CSQL grammar genuinely rejects nodes outside its function whitelists (`commcare-hq/.../xpath_functions/__init__.py`); the hoisting pass handles that constraint. The on-device XPath grammar is permissive — Nova emits the maximum CCHQ feature subset and runtime player support is Dimagi's concern, not ours.
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

The transitional `lib/commcare/predicate/xpathEmitter.ts` is **deleted** in Task B6 once Tasks B2 and B3 ship. Its lexical helpers already migrated into `stringQuoting.ts` in Task B1; its operator dispatch migrates into the two new emitters in Tasks B2 (on-device XPath) and B3 (CSQL with total hoisting).

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

**Wire-target portability for `any-relation`**: matches both CHILD and EXTENSION relationships under one identifier on the Postgres target. CCHQ's wire grammars expose only direction-specific operators (`ancestor-exists` / `subcase-exists`), so the wire emitters expand `any-relation` to `(<ancestor-form> or <subcase-form>)` on every CCHQ slot — direction-specific OR'd. Postgres natively supports the direction-agnostic form via the `case_indices.identifier` index.

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
- `docs/superpowers/plans/2026-04-30-case-list-search-foundation.md` (this section + the B-phase emitter behavior on `is-blank` / `is-null`)

**What landed:**

- `isBlankSchema` (portable: absent OR empty-string), parallel-shaped to the shipped `isNullSchema` (strict: absent only). Both accept any Term in `left`; literal-rejection is the type-checker's job.
- `isBlank` builder mirroring `isNull` with `Extract<Predicate, { kind: "is-blank" }>` return type.
- Type-checker `walk` switch has dedicated arms for both operators sharing a `checkAbsenceOperator` helper that rejects literal-shaped `left` and resolves non-literal terms for unknown-property / unknown-input error propagation.
- Transitional emitter (`xpathEmitter.ts`, slated for B6 deletion) emits `<term> = ''` for `is-blank` and throws on `is-null` — minimal arms; the per-dialect B-stage emitters write the correct wire forms from the spec subsection, not by copying this transitional code.
- The shipped `isNullSchema` JSDoc was rewritten to lock the strict-absent semantic ("key not present in JSONB / Map") and drop the "does the property carry a value?" hedge.

**Locked semantic, family-wide**: the AST is **Postgres-strict**. Every operator that touches null / empty-string / missing-property semantics distinguishes the three states (absent / cleared / explicit-empty) at the data-model layer. CCHQ's wire collapse is a per-emitter concern: the wire emitters faithfully emit `prop = ''` for both `is-null` and `is-blank` (CCHQ's `case_property_query()` short-circuits absent / cleared / empty alike). The Postgres runtime executes the strict semantic natively. No representability checker; no validator hint; no soft-warning UI.

**v1 surface scoping**: v1 authoring surfaces (filter UI, SA tool surface) default to `is-blank` for "field is empty" intents — the canonical author-facing operator for absent-or-empty semantics. `is-null` is available for any caller that wants strict-absent semantics; on Postgres it executes natively, on CCHQ wire it emits as `prop = ''` (the wire's lossiness collapses absent / cleared / empty alike). Both AST kinds emit faithfully; the AST distinction is preserved end-to-end on Postgres surfaces (case-data inspection, audit / admin views, expression operators that need to distinguish absent from empty).

**Deviations from the v2 plan's outline above (all principled improvements):**

1. **CCHQ citation correction (Finding 1 from code-quality review)**: the initial commit cited `case_property_missing(prop)` as registered at `xpath_functions/__init__.py:46`. Verified false against `/Users/braxtonperry/code/commcare-hq` — line 46 is `'within-distance'`; `case_property_missing` is not a CSQL XPath function at all. It's a Python helper at `corehq/apps/es/case_search.py:378`, called internally by `case_property_query()` at lines 241-246 when value == ''. The actual CSQL wire form for `is-blank(prop)` is `prop = ''`, which the server short-circuits internally. Citations corrected across all sites in the follow-up commit `2f7941d0`.
2. **Architectural reframing (Finding 3 from code-quality review)**: the initial commit's "four-layer practical defense" framing (Representability checker / UI default card with `is-null` opt-in / SA prompt / Platform-divergence panel) leaked CCHQ's "click through warnings" pattern into Nova. Reworked in `510441fb` to the v1-surface-scoping framing: there is no v1 path producing `is-null` for users; the operator exists in the AST as foundation infrastructure for future surfaces. Documented in the spec and in code JSDoc.
3. **Test-comment sweep (Finding 2)**: production JSDocs in `inSchema` and `multiSelectContainsSchema` were updated to cite both `is-null` and `is-blank` as canonical absence-check shapes; parallel test-file comments needed the same sweep. Done in `2f7941d0`.

**Memory carry-forward to A5–A7 / B-stage / C-stage implementer prompts:**

- "Apps are always in a valid state" is the deeper design principle — never propose authoring flows that introduce a state the user has authored but cannot instantly export. Construction-time rejection is the right gate; opt-in / are-you-sure / advanced-toggle framing imports CCHQ's click-through-warnings pattern back in.
- For B-stage emitters: wire forms come from the spec's "Null vs blank semantics" table, NOT from copying the transitional `xpathEmitter.ts`.
- For any future operator touching null/empty/missing semantics: design Postgres-strict at the AST. The wire emitters faithfully emit the closest CCHQ form (typically `prop = ''` for empty/absent intents). No representability checker.

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

## Group B — Replace the transitional emitter with two faithful emitters

These tasks delete `lib/commcare/predicate/xpathEmitter.ts` and replace it with two emitters: one for on-device XPath (the case-list-filter and post-ES search-filter slots — same XPath grammar, different wire-format positions) and one for CSQL (the `_xpath_query` slot, with total hoisting for nodes outside CSQL's grammar). Both emitters are total — no `throw` arms for "feature unsupported on a runtime player". Per `feedback_max_subset_no_dimagi_litter.md`, Nova emits the maximum web-apps feature subset of CCHQ; runtime player capabilities are Dimagi's concern, not Nova's authoring concern.

### Task B1: Extract shared quoting helpers — SHIPPED

Shipped across commits `670ce644` → `a090e557` → `fad0a6a5`.

**Files modified:**
- `lib/commcare/predicate/stringQuoting.ts` (new, 180 lines) — three permanent helpers + the canonical `WireDialect` union (`"case-list-filter" | "csql" | "search-filter"`) shared by the on-device XPath emitter (B2) and the CSQL emitter (B3). The `WireDialect` arms label the three CCHQ wire slots — same XPath grammar for `case-list-filter` and `search-filter`, distinct CSQL grammar for `csql`.
- `lib/commcare/predicate/__tests__/stringQuoting.test.ts` (new, 41 tests) — per-dialect coverage for `quoteLiteral`, pass-through assertions for `quoteIdentifier`, and exponent-form expansion pinning for `formatNumeric` (exact decimal output strings asserted, including the `1e-7` / `1e21` boundaries).
- `lib/commcare/predicate/xpathEmitter.ts` — slimmed to delegate every literal-emission and identifier-emission callsite into `stringQuoting`. The transitional emitter's `EmissionContext` (`"case-list-filter" | "csql"`) stays a structural subset of `WireDialect` with no aliasing back-and-forth, preserving the type-system constraint that the transitional emitter does not handle `search-filter`.

**Helper surface (the new `stringQuoting.ts` module exports):**
- `WireDialect` — the canonical three-arm union (one arm per CCHQ wire slot); B2 and B3 import the type from here rather than redeclaring.
- `quoteLiteral(value, dialect)` — per-dialect string-literal escape. `case-list-filter` and `search-filter` (both XPath 1.0 on-device) share the alternating-quote `concat()` fallback for embedded single quotes; `csql` switches between single- and double-quoted literals and throws on values containing both quote styles (CSQL excludes `concat()` from its value-function whitelist per `corehq/apps/case_search/xpath_functions/__init__.py:27-36`, with `dsl_utils.unwrap_value` raising `CaseFilterError` on any function name outside that whitelist).
- `quoteIdentifier(name)` — pass-through. Centralized so the per-dialect emitters call one place rather than open-coding the rule.
- `formatNumeric(value)` — verbatim port of the prior numeric-literal expansion (CommCare's XPath grammar at `lib/commcare/xpath/grammar.lezer.grammar:133-136` admits decimal-only literals; JavaScript's `String(n)` switches to exponent form below ~1e-6 and at or above 1e21, so the helper rebuilds the decimal manually for those magnitudes).

**Architectural decisions:**

1. **Single canonical `WireDialect` union exported from `stringQuoting.ts`** (over redeclaring per-emitter or scattering in `types.ts`) — B2's on-device XPath emitter, B3's CSQL emitter, and `quoteLiteral` itself all share one type-level definition; drift is structurally impossible.
2. **`EmissionContext` stays distinct from `WireDialect`** (no alias, no re-export) — the transitional emitter's narrower union preserves the type-system signal that it does not yet handle `search-filter`; assignment compiles cleanly at the `quoteLiteral` callsite because `EmissionContext` is a structural subset.
3. **`quoteIdentifier` wired through the transitional emitter's `prop` arm** (both reserved-attribute branch and bare-name branch) — the JSDoc claim that "every emitter funnels identifier emission through it" is factual today, not aspirational.
4. **Transitional emitter trimmed to minimal comments** per `feedback_minimize_transitional_docs.md` (the file is deleted in B6) — citation depth migrates to the permanent `stringQuoting.ts` module and to the two new emitters in B2 (on-device XPath) and B3 (CSQL with hoisting); no rich JSDoc on doomed surfaces.
5. **Three test-suite voice patterns scrubbed in the same task** — the original sweep regex missed `supersed`, `until X land`, and `if one ever lands`; the strengthened regex set is now part of the verification gate for all subsequent B-tasks.

**Reviews:**

- Spec-compliance review (sonnet): ✅ Compliant. All three helpers, the dialect type, the per-dialect behavior, the transitional-emitter delegation, and the boundary-segment invariant for the concat fallback verified.
- Code-quality review (opus): 3 findings on the original `670ce644` — 1 Blocker (file-level header voice with "superseded ... until ... land"), 2 Important (`EmissionContext` widening comment + `quoteIdentifier` rationale both roadmap-flavored). Resolved in fix-pass `a090e557` and re-review APPROVED. Same review's tail flagged two pre-existing "if one ever lands" hits in the test parameterization comments — scrubbed in follow-up `fad0a6a5`.

**Verification gates (all green at HEAD `fad0a6a5`):**
- 555 predicate-domain + commcare-predicate tests pass (514 baseline + 41 new in `stringQuoting.test.ts`)
- `npx tsc --noEmit` clean
- `npm run lint` clean (zero warnings)
- Strengthened eternal-present sweep returns zero hits across the four predicate-package files (regex extends the prior sweep with `supersed`, `until [^.]*(land|come|arriv)`, `future change`, `will (eventually|land|move|migrate)`, `transitional emitter knows`, `deleted in (B|C)`, `ever lands`, `if one ever`, `hypothetical`)

### Task B2: Build the on-device XPath emitter — SHIPPED

Shipped across commits `60726e76` → `87e7f28c` → `eb0df2be`.

**Files:**
- `lib/commcare/predicate/caseListFilterEmitter.ts` (new) — total visitor; emits on-device XPath for both the case-list-filter slot and the post-ES search-filter slot. Same XPath grammar; the wire layer routes the string into the right slot.
- `lib/commcare/predicate/__tests__/caseListFilterEmitter.test.ts` (new, 95 tests) — pinned wire-string fixtures across all operator + term arms; backward-compat coverage for the operators that already had pinned forms in `xpathEmitter.test.ts`; new-operator coverage for sentinels / between / multi-select / match / exists-walks / `prop` cross-relation reads / `within-distance` / `any-relation` OR-expansion.

**Operator coverage (faithful emission, no throws for runtime-player gaps):**
- Sentinels: `match-all` → `true()`, `match-none` → `false()`.
- Logical: `and`, `or`, `not` with precedence-aware paren wrapping.
- Comparison (six ops): `<left> <op> <right>`.
- `is-blank` and `is-null`: both emit as `<term> = ''`. CCHQ wire collapses absent / cleared / empty alike via the `case_property_query()` short-circuit at `commcare-hq/corehq/apps/es/case_search.py:241-246`. The AST distinction is preserved on Postgres.
- `in` single value: `prop = 'v'`. Multi-value: `(prop = 'v1' or prop = 'v2' or ...)` — value-equality OR-of-eq.
- `between`: expand to `(prop >= lo and prop <= hi)` with per-flag inclusivity.
- `multi-select-contains`: quantifier=any single → `selected(prop, 'v')`; any multi → OR-of-`selected()`; all → AND-of-`selected()`.
- `match` modes: starts-with → `starts-with(prop, 'v')`; fuzzy → `fuzzy-match(prop, 'v')`; phonetic → `phonetic-match(prop, 'v')`; fuzzy-date → `fuzzy-date(prop, 'v')`.
- `within-distance`: `within-distance(prop, '<lat,lon>', <distance>, '<unit>')` per `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:54-81`.
- `exists` / `missing`: walk the `RelationPath`. Single-hop ancestor / multi-hop nested anchors / subcase reverse-join / self degenerate (collapses to inner filter or `false()`) / any-relation expand to OR of direction-specific forms. `missing` uses `count(...) = 0` (presence comparator threaded at the build site, not via post-emission string substitution).
- `prop` term with non-self `via`: inline path expression. Ancestor walks chain anchors via `[@case_id=current()/index/<rel>]`. Subcase walks reverse direction via `[index/<rel>=current()/@case_id]`. With `via.kind === "any-relation"`, the emission is a node-set union `(<ancestor-form> | <subcase-form>)` — not boolean disjunction — so equality comparisons against the result test existential equality across the union node-set.
- `when-input-present`: `if(count(<input>), <clause>, true())`.

**Term arms:**
- `prop`: bare reference, with `@`-prefix for the four reserved attributes per `corehq/ex-submodules/casexml/apps/case/xml/generator.py:237-246` and `corehq/apps/case_search/const.py:53-103`.
- `input`: `instance('search-input:results')/input/field[@name='<n>']`.
- `session-user`: `instance('commcaresession')/session/user/data/<field>` per `corehq/apps/app_manager/xpath.py:114-119`.
- `session-context`: `instance('commcaresession')/session/context/<field>` per `corehq/apps/app_manager/xpath.py:248`.
- `literal`: routes through `quoteLiteral(value, "case-list-filter")` / `formatNumeric` / boolean stringification / null-as-empty.

**Operand handling:** predicate operators carry `ValueExpression`. The emitter accepts only the `term` arm via `unwrapTermFromExpression` (exhaustive switch with `_exhaustive: never` default — adding a new ValueExpression kind surfaces as a compile-time error). C1's expression emitter wires per-slot ValueExpression emission later. Same exhaustiveness pattern across every operator dispatch (`emitTerm`, `emitMatch`, `emitMultiSelectContains`, `emitExistsOrMissing`, `emitPropertyRef`); `between` both-bounds-absent retained as a structural defense for the schema-bypass path.

**Architectural decisions:**

1. **One on-device emitter, two slots.** The case-list-filter slot and the post-ES search-filter slot share the on-device XPath grammar; the same emitter serves both. The wire layer routes the string into the right slot in the CCHQ XML.
2. **Faithful emission, no per-runtime-player rejection.** AST shapes whose CCHQ wire form is a direct function call (`fuzzy-match`, `within-distance`, `phonetic-match`, `fuzzy-date`) emit literally. `is-null` emits as the closest CCHQ form (`<term> = ''`); the wire's lossiness is the wire's concern, faithfully passed through. Per `feedback_max_subset_no_dimagi_litter.md`, runtime player capabilities are Dimagi's structural concern, not Nova's authoring layer.
3. **`any-relation` `prop` reads emit as XPath node-set union `|`** (not boolean `or`) — equality against a node-set tests existential equality across the union, which is the semantics the AST means. Boolean disjunction would coerce the LHS to true/false and break comparison-context use.
4. **`exists` / `missing` presence comparator threaded at build site** (`emitCountPresenceTest` selects `> 0` vs `= 0` from the operator kind) rather than emitting `count(...) > 0` and string-substituting to `= 0` for `missing`. The substitution would corrupt filter clauses containing `gt(prop, literal(0))` because the `> 0` substring matches the inner comparison first.
5. **File header frames the emission policy in terms of CCHQ HQ's import-side query-function registry,** not in terms of which runtime players (web, Android, iOS) render which functions. Dimagi runtime fragmentation is their structural concern; Nova's emitter commits only to "well-formed XPath that CCHQ HQ accepts at import".

**Reviews:**

- Spec-compliance review (sonnet): ✅ Compliant. Eight checklist items verified — total emitter, faithful emission of every operator + term arm, citation discipline, `is-null` / `is-blank` parity, no `representability` / `WireTarget` mentions, correctness fixes (presence comparator threading + node-set union for any-relation prop reads), test coverage matches plan steps.
- Code-quality review (opus): 3 yellow findings on `87e7f28c` — `emitTerm` missing exhaustiveness default, file-header tracking Dimagi runtime fragmentation by enumerating runtime players, test-file header carrying the same fragmentation framing. Resolved in fix-pass `eb0df2be` and re-review APPROVED. The implementer also corrected a Shell 3 coverage overstatement (the runtime tests are spot-checks; compile-time `_exhaustive: never` on `unwrapTermFromExpression` is the load-bearing exhaustiveness mechanism).

**Verification gates (all green at HEAD `eb0df2be`):**
- Predicate-domain + commcare-predicate tests pass (650 with B2 in isolation; 750 once B3 lands)
- `npx tsc --noEmit` clean (B2-scoped)
- `npm run lint` clean (zero warnings, B2-scoped)
- Strengthened eternal-present sweep returns zero hits across `caseListFilterEmitter.ts` and `caseListFilterEmitter.test.ts` (the regex includes `representab` to catch any leaked B5 references)

### Task B3: Build the CSQL emitter with total hoisting + `concat()` wrapping — SHIPPED

Shipped across commits `8d6773ee` → `e4c48920`.

**Files:**
- `lib/commcare/predicate/csqlHoist.ts` (new) — total hoisting pass; lifts non-CSQL-grammar nodes into the on-device wrapper that builds the `_xpath_query` string. Returns `CsqlHoistResult { hoisted: Predicate; wrappers: HoistedWrapper[] }` — no error states.
- `lib/commcare/predicate/csqlEmitter.ts` (new) — total CSQL-grammar emitter; wraps output in `concat(...)` unconditionally; threads `HoistedWrapper`s through the surrounding wrapper expression.
- `lib/commcare/predicate/__tests__/csqlHoist.test.ts` (new, 22 tests) — coverage of hoist arms (`if`/`switch`/`arith`/`concat`/`coalesce`/`count`/`format-date`), the `subcase-count` LHS-of-comparison carve-out, synthetic-input collision avoidance (seed-past-author-ref + ignore-non-numeric-suffix paths).
- `lib/commcare/predicate/__tests__/csqlEmitter.test.ts` (new, 90 tests across two waves) — backward-compat for shared operators; CSQL-specific operator shapes (multi-select-contains quantifiers, match modes, within-distance, exists ancestor / subcase / any-relation, `match-all` / `match-none` calls, is-null / is-blank parity, between, when-input-present hoist); concat() wrapping shape; `date-coerce` → `date(...)` rename; `datetime-coerce` → `datetime(...)` rename; `format-date` hoist.

**Hoist coverage (total — no error states):**
- `if` / `switch` / `arith` / `concat` / `coalesce` value expressions in any term position lift into the wrapper.
- `count(...)` lifts EXCEPT when it's the LHS of a top-level binary comparison (the `subcase-count` carve-out per `commcare-hq/corehq/apps/case_search/filter_dsl.py:88-90`); the comparison emits CSQL's native `subcase-count(...)` form.
- `format-date(date, format)` lifts; the wrapper computes the formatted string on-device and injects the result as a string literal.
- `when-input-present` is handled at emission time (not hoist time) via recursive CSQL emission of the inner clause; the wrapper structure is the canonical `if(count(<input>), '<inner-csql>', 'match-all()')` per `docs/case_search_query_language.rst:299-303`. The `match-all()` fallback is CSQL's AND-identity (a no-op when AND-combined with siblings on input-unset).
- Synthetic input ref names use `csql_hoist_<n>`; the hoist pass scans the input AST for any author-written `csql_hoist_<n>` references and seeds the counter past the highest existing index, avoiding collisions.

**Operator coverage of the CSQL emission visitor (after hoisting):**
- Comparison + logical (CSQL's `not` is in the query function set).
- `multi-select-contains`: any single → `selected(prop, 'v')`; any multi → `selected-any(prop, 'v1 v2')`; all → `selected-all(prop, 'v1 v2')`.
- `match` modes: starts-with → `starts-with`; fuzzy → `fuzzy-match`; phonetic → `phonetic-match`; fuzzy-date → `fuzzy-date`.
- `within-distance`: `within-distance(prop, '<lat,lon>', <distance>, '<unit>')` per `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:54-81`.
- `exists` ancestor: `ancestor-exists('parent/parent', '<csql filter>')`. CCHQ's `confirm_args_count(node, 2)` at `ancestor_functions.py:109` requires the 2-arg form; absent `where` clauses inject `match-all()` as the filter.
- `exists` subcase: `subcase-exists('rel', '<csql filter>')`.
- `exists` / `missing` with `via.kind === "any-relation"`: expand to `(<ancestor-exists> or <subcase-exists>)`; `missing` wraps in `not(...)`.
- `match-all` / `match-none` predicates: emit `match-all()` / `match-none()`.
- `is-blank` and `is-null`: both emit as `prop = ''`. CCHQ's `case_property_query()` short-circuit at `commcare-hq/corehq/apps/es/case_search.py:241-246` collapses absent / cleared / empty alike — faithful emission of CCHQ's wire lossiness.
- `between`: expand to `(<gte> and <lte>)`.
- `date-coerce(value)` → `date(<value>)` (rename at emission time; same operator semantically, different wire syntax).
- `datetime-coerce(value)` → `datetime(<value>)`.

**`concat()` wrapping**: the emitter walks an internal `CsqlSegment[]` IR (`{kind: "constant", text} | {kind: "runtime", xpath}` discriminated union) and emits the result as a `concat(...)` template. Constants split at quote-style boundaries via the alternating-quote idiom from the XPath grammar at `lib/commcare/xpath/grammar.lezer.grammar:128-131`, so a constant carrying both `'` and `"` produces multiple concat args automatically. Runtime parts (search-input refs, session-user refs, session-context refs, synthetic inputs from the hoisting pass) emit as path expressions evaluated on-device at runtime. `mergeAdjacentConstants` runs once at the wrap layer; per-arm emitters produce raw segment lists. `via.identifier` routes through `quoteLiteral(_, "csql")` in `ancestor-exists` / `subcase-exists` emission, matching the property-emitter quoting discipline.

**Architectural decisions:**

1. **Hoist pass is total** — no `errors` field on `CsqlHoistResult`, no `HoistError` type. Every AST node has a CSQL emission via hoist + faithful emission. The plan + memory both lock this; the implementation matches.
2. **`when-input-present` handled in emitter, not hoist pass** — needs recursive CSQL emission of the inner clause, which the hoist pass cannot produce. `emitHoistedWrapper` is the inner emission entry point that skips re-hoisting an already-hoisted clause; `emitCsql` (public) hoists then delegates to it.
3. **Segment-list IR over post-emission string parsing** — the inner emitter produces `CsqlSegment[]`; the wrapping pass walks segments rather than re-parsing an emitted string. Constants split at quote-style boundaries cleanly via the IR.
4. **Synthetic-input collision avoidance via scan-and-seed** — chose this over a schema `.refine` to keep the change in B3-owned files. The hoist pass walks the input AST first, collects author-written `csql_hoist_<n>` indices, and seeds `nextIndex` past the maximum.
5. **`date-coerce` / `datetime-coerce` rename at emission**, not hoist — these AST kinds have direct CSQL equivalents (`date` / `datetime`) under different names. Renaming at emission preserves the AST's semantic naming while emitting CSQL's wire vocabulary. `format-date` hoists because CSQL has no equivalent.
6. **Mutation-safety contract softened** — the hoist pass does not allocate fresh subtrees on every arm; the contract is "input is never mutated; subtrees may share with the input by reference". Per-arm fresh allocation is busywork when the input is treated as immutable upstream.
7. **`mergeAdjacentConstants` consolidated at wrap layer only** — per-arm emitters produce raw segment lists; the wrap layer is the sole merge point. Eliminates dead work + makes the merge invariant single-sourced.

**Reviews:**

- Spec-compliance review (sonnet): ❌ Round 1 found 3 gaps (`HoistedWrapper.inputRef` rename, `any-relation` throws instead of expanding, `date-coerce` / `datetime-coerce` / `format-date` not in CSQL whitelist but pass through). All resolved in fix-pass `e4c48920` and re-review ✅ COMPLIANT.
- Code-quality review (opus): ❌ Round 1 found 5 BLOCKING + 7 IMPORTANT + 3 SUGGESTIONS — `Plan 4` / `v1 emitter` roadmap-phase labelling, comment lie on "every returned predicate is a fresh allocation", `OPERATOR_MAPPING` citation drift, missing `_exhaustive: never` defaults on multiple switches, synthetic-input collision risk, `between` rebuild duplication, `case_property_text_query` citation precision, `mergeAdjacentConstants` running twice, `emitWhenInputPresentSegments` re-running hoist over already-hoisted clauses. All blockers + importants resolved in fix-pass `e4c48920`; all 3 suggestions adopted (`wrapTermAsSegmentList` helper extraction, `via.identifier` quoting, collision regression tests). Re-review APPROVED.

**Verification gates (all green at HEAD `e4c48920`):**
- 762 predicate-domain + commcare-predicate tests pass (was 555 pre-B-phase; +95 from B2, +112 from B3)
- `npx tsc --noEmit` clean
- `npm run lint` clean (zero warnings)
- Strengthened eternal-present sweep returns zero hits across `csqlHoist.ts`, `csqlEmitter.ts`, `csqlHoist.test.ts`, `csqlEmitter.test.ts`. Sweep regex now includes `Plan ?[0-9]|Phase ?[0-9]|\bv[0-9]\b|\bV[0-9]\b` to catch roadmap-phase / version-label patterns.

**Known scope boundary (deferred to C1):** operand emission for grammar value functions `today` / `now` / `date-add` / `double` / `unwrap-list` still throws via `unwrapTermFromExpression`. The current throw is structural exhaustiveness consistent with B2's pattern; C1's expression emitter wires per-slot ValueExpression emission later when these arms appear in operand positions outside the term lifter.

### Task B6: Delete the transitional `xpathEmitter.ts` — SHIPPED

Shipped across commits `9b4c113e` → `f4f74101`.

**Files:**
- `lib/commcare/predicate/xpathEmitter.ts` — DELETED (~448 lines).
- `lib/commcare/predicate/__tests__/xpathEmitter.test.ts` — DELETED (~874 lines, 83 tests).
- `lib/commcare/predicate/index.ts` — rewritten as the package's permanent public surface barrel (eternal-present JSDoc; exports the two emitter entry points + their result types + the lexical helpers + `WireDialect`).
- `lib/commcare/predicate/caseListFilterEmitter.ts` — secondary fix-pass cleanup: routed `within-distance.unit` through `quoteLiteral(p.unit, "case-list-filter")` for symmetry with the CSQL emitter; renamed two `v1` / `v2` placeholder values in template comments to `a` / `b` to satisfy the strengthened sweep.
- `lib/commcare/predicate/csqlEmitter.ts` — secondary fix-pass cleanup: dropped the `B2` roadmap-label reference in the any-relation arm comment; narrowed `emitPropertyRefSegment`'s return type via new `ConstantTermEmission` / `RuntimeTermEmission` aliases composed into the existing `TermEmission` union, eliminating a confessed-dead runtime branch in `emitMatchSegments`.

**Public barrel surface (`lib/commcare/predicate/index.ts`):**
- `emitCaseListFilter(predicate)` from `./caseListFilterEmitter` — on-device XPath emitter; serves both case-list-filter and post-ES search-filter slots.
- `emitCsql(predicate)` from `./csqlEmitter` — CSQL emitter with total hoisting + concat() wrapping; returns `CsqlEmissionResult` (the wrapper string + the lifted `HoistedWrapper`s the wire layer threads into the `_xpath_query` slot).
- Type-only exports: `CsqlEmissionResult`, `CsqlHoistResult`, `HoistedWrapper`, `WireDialect`.
- Lexical helpers: `quoteLiteral`, `quoteIdentifier`, `formatNumeric` from `./stringQuoting`.
- `hoistForCsql` is intentionally NOT exported — `emitCsql` already wraps the hoist pass and returns the wrappers in its result; re-exporting `hoistForCsql` would invite a double-walk where callers scan, discard, then call `emitCsql` to scan again. Documented in the barrel JSDoc.

**Architectural decisions:**

1. **Hard deletion, not deprecation shim** — keeping the transitional emitter as a re-export risked future regressions where a consumer imports the old emitter and bypasses the per-slot dispatch. The deletion is the structural defense.
2. **`hoistForCsql` not on the public surface** — single-call shape (`emitCsql`) constrains callers; double-walk avoidance.
3. **Type-only re-exports use `export type`** — `verbatimModuleSyntax` discipline; consumers don't pay runtime import overhead on type-only references.
4. **`emitPropertyRefSegment` narrowed return type** (`ConstantTermEmission` not `TermEmission`) — the dead runtime branch in `emitMatchSegments` was a confessed-dead "uniformity" rationale; the type narrow turns the invariant into a compile-time fact. The wider `TermEmission` union stays for `emitTermSegment` where both arms are legitimately produced.
5. **`within-distance.unit` routed through `quoteLiteral`** on both emitters — closes a lexical-pass-through asymmetry. Wire output unchanged for the current `miles` / `kilometers` enum (no escape characters), but the centralized rule covers any future enum extension.
6. **Strengthened sweep regex extended with `\bB[0-9]\b|\bC[0-9]\b`** — catches roadmap labels for B-phase and C-phase ordinals that the prior regex pattern set missed (the `B2` reference in the original commit slipped through the `task ?B` and `deleted in (B|C)` patterns).

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on the original `9b4c113e` — all six checklist items verified (deletion, barrel rewrite, no external consumers, test-count math, eternal-present voice, `v1`/`v2` placeholder rename only in comments not in test fixtures).
- Code-quality review (opus): ❌ Round 1 found 3 BLOCKING on `9b4c113e` — `B2` roadmap label leak, confessed-dead branch in `emitMatchSegments`, asymmetric `within-distance.unit` quoting between emitters. Resolved in fix-pass `f4f74101` and re-review APPROVED.

**Verification gates (all green at HEAD `f4f74101`):**
- 2455 full-project tests pass / 14 skipped (down from 2538 by exactly 83 — the deleted `xpathEmitter.test.ts`)
- `npx tsc --noEmit` clean
- `npm run lint` clean (zero warnings)
- Extended eternal-present sweep returns zero hits across the five package files. Final regex set:
  ```
  task ?B|extract|moved|added|previously|originally|formerly|now (uses|delegates|imports)|in (this|that) (task|step)|supersed|until [^.]*(land|come|arriv)|future change|will (eventually|land|move|migrate)|transitional emitter knows|deleted in (B|C)|ever lands|if one ever|hypothetical|representab|Plan ?[0-9]|Phase ?[0-9]|\bv[0-9]\b|\bV[0-9]\b|\bB[0-9]\b|\bC[0-9]\b
  ```

---

## Group C — Expression emitters + Postgres compiler

### Task C1: Expression emitters — SHIPPED

Shipped across commits `afd22a13` → `b8013de2`.

**Files:**
- `lib/commcare/expression/onDeviceEmitter.ts` (new) — total on-device XPath emitter for `ValueExpression`. Public surface: `emitOnDeviceExpression(expr): string`.
- `lib/commcare/expression/csqlEmitter.ts` (new) — total CSQL segment-list emitter for the eight CSQL value-function-whitelist arms; throws on the seven non-whitelist arms with a "should have been hoisted" defensive message. Public surface: `emitCsqlExpressionSegments(expr): CsqlSegment[]`.
- `lib/commcare/expression/index.ts` (new) — barrel exporting both emitter entry points + the `CsqlSegment` type re-export.
- `lib/commcare/expression/__tests__/onDeviceEmitter.test.ts` (new) — pinned wire-string fixtures across all 14 ValueExpression arms.
- `lib/commcare/expression/__tests__/csqlEmitter.test.ts` (new) — coverage of the eight whitelist arms emitting cleanly + the seven non-whitelist arms throwing.
- `lib/commcare/predicate/termEmitter.ts` (new, extracted from the predicate emitters) — shared term-emission module used by both predicate and expression emitters. Public surface: on-device `emitTerm`, CSQL `emitTermSegment`, the relation-walk anchor builders (`buildAncestorJoinNodeset`, `buildSubcaseJoinNodeset`), `wrapTermAsSegmentList`, `RESERVED_CASE_ATTRIBUTES`.
- `lib/commcare/predicate/csqlSegment.ts` (new, extracted) — shared `CsqlSegment` discriminated-union IR + `mergeAdjacentConstants` + `quoteConstantSegmentForXPath` helper.
- `lib/commcare/predicate/caseListFilterEmitter.ts` (modified) — operand sites that previously threw on non-term ValueExpression arms now delegate to `emitOnDeviceExpression`.
- `lib/commcare/predicate/csqlEmitter.ts` (modified) — comparison-operand sites unified through `emitComparisonOperandSegments`, which delegates to `emitCsqlExpressionSegments` for whitelist arms; the hoist pass continues to handle the rest.

**Operator coverage of the on-device emitter (total — every arm emits faithfully):**
- Date / time constants: `today` → `today()`, `now` → `now()`.
- Date coercion: `date-coerce(value)` → `date(<value>)`, `datetime-coerce(value)` → `datetime(<value>)` (rename at emission, same operator semantically).
- Numeric: `double(value)` → `double(<value>)`, `arith(left, op, right)` → `(<left> <xpath-op> <right>)` with paren wrapping (five op kinds via `ARITH_OPS` exhaustive record).
- String: `concat(parts)` → `concat(<part1>, ...)`, `format-date(date, format)` → `format-date(<date>, '<format>')`.
- Conditional: `coalesce(parts)` → `coalesce(<part1>, ...)`, `if(condition, then, else)` → `if(<predicate-emit(condition)>, <then>, <else>)` (recurses into the on-device predicate emitter), `switch(branches, default)` → right-nested `if(...)` chain.
- Aggregation: `count(via, where?)` — multi-shape walk emission. `count(self)` → `1`; `count(self, filter)` → `if(<filter>, 1, 0)`; `count(ancestor)` / `count(subcase)` → relational join expansion against `instance('casedb')` returning the count of matching cases; `count(any-relation)` → `(<ancestor-count> + <subcase-count>)` (sum across both directions, valid under CommCare's acyclic case-relation invariant).
- Date arithmetic: `date-add(value, interval, quantity)` → `date-add(<value>, '<interval>', <quantity>)` (3-arg form per the verified CCHQ signature at `commcare-hq/corehq/apps/case_search/xpath_functions/value_functions.py:115` — the plan's prior `'<n><unit>'` 1-arg framing was incorrect and corrected during implementation).
- List: `unwrap-list(value)` → `unwrap-list(<value>)`.
- Term lifter: `term(t)` → delegates to the shared `emitTerm`.

**Operator coverage of the CSQL emitter (eight whitelist arms emit; seven non-whitelist throw):**
- Whitelist (per `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-36`): `today`, `now`, `date-coerce` → `date`, `datetime-coerce` → `datetime`, `double`, `date-add` (3-arg), `unwrap-list`, `term` (delegates to shared `emitTermSegment`).
- Non-whitelist (`arith`, `concat`, `coalesce`, `if`, `switch`, `count`, `format-date`): defensive throw with "should have been hoisted before this emitter ran". The hoist pass at `lib/commcare/predicate/csqlHoist.ts` lifts these arms into the on-device wrapper before this emitter sees them; the throw defends the bypass path. The exhaustive `_exhaustive: never` default catches new ValueExpression kinds at compile time.

**Architectural decisions:**

1. **Term-emitter extracted to a shared package-internal module** (`lib/commcare/predicate/termEmitter.ts`) over duplication or cross-package import gymnastics. Both predicate emitters (case-list-filter + CSQL) and both expression emitters (on-device + CSQL) consume the same term-emission helpers; one source of truth keeps wire-syntax invariants single-sourced.
2. **`CsqlSegment` IR also extracted** to `lib/commcare/predicate/csqlSegment.ts` so both predicate-side and expression-side CSQL emitters return the same shape; `mergeAdjacentConstants` and `quoteConstantSegmentForXPath` live with the IR.
3. **Plan's `date-add` wire format corrected against CCHQ source.** The plan said `'<n><unit>'` 1-arg; CCHQ's actual signature is `date-add(date, interval, quantity)` 3-arg per `value_functions.py:115` (`confirm_args_count(node, 3)`). Both emitters use the verified 3-arg shape; `interval` routes through `quoteLiteral` to quote it as a string literal.
4. **`count(self)` and `count(any-relation)` shapes invented** because the plan's "shape identical to exists's join without `> 0`" framing doesn't translate. `count(self)` returns `1` (a self-case always exists at its own scope); `count(self, filter)` returns `if(<filter>, 1, 0)`; `count(any-relation)` returns the sum of both directions. Tests pin all four shapes.
5. **CSQL expression emitter returns segments unwrapped, comparison-operand emitter wraps them.** The term-arm runtime refs come back as `[runtime <X>]`; the predicate-side `emitComparisonOperandSegments` is the layer that wraps them in CSQL double-quote brackets when needed (`<prop> = "<value>"`). This unified the dispatch and eliminated the prior `emitCoerceCallSegments` special case.
6. **Predicate-side CSQL operand sites unified through one helper** (`emitComparisonOperandSegments`), so `in` / `between` / `is-blank` / `within-distance` operand slots now handle every CSQL whitelist arm cleanly. Broader than the plan's explicit scope but consistent with its intent (any operand position that accepts `ValueExpression` should accept all whitelist arms).
7. **Operand-throw tests in `caseListFilterEmitter.test.ts` replaced with happy-path delegation tests.** With C1 wiring, the operands emit cleanly via the expression emitter; the original throw-tests were B-phase scope-boundary defenses no longer applicable.
8. **Defensive throws on non-whitelist arms in the CSQL expression emitter** with a "should have been hoisted" message defend the hoist-pass-bypass path; the exhaustive `_exhaustive: never` default catches new ValueExpression kinds at compile time.

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `afd22a13`. Every checklist item verified — both emitter entry points + result types, all 14 on-device arms, all 8 CSQL whitelist arms + 7 throws, term-emitter sharing via extracted module, predicate-emitter operand wiring, `date-add` 3-arg correction, `count(self)` / `count(any-relation)` invented expansions, broader CSQL operand wiring through `emitComparisonOperandSegments`. The three flagged deviations (date-add correction, count expansions, broader operand wiring) verified as defensible.
- Code-quality review (opus): ❌ Round 1 found 2 BLOCKING on `afd22a13` — stale `unwrapTermFromExpression` reference in `csqlEmitter.ts:23` and the matching test-file header at `csqlEmitter.test.ts:217`. The function does not exist anywhere in the predicate package after C1's refactor; the strengthened sweep regex doesn't catch stale identifier references. Resolved in fix-pass `b8013de2` (Option B — dropped the cross-file precedent citation; the local `_exhaustive: never` default speaks for itself). Re-review APPROVED.

**Verification gates (all green at HEAD `b8013de2`):**
- 2520 full-project tests pass / 14 skipped (vs 2455 pre-C1 baseline; +65 net new tests across the two expression test files + the new shared-module imports + the predicate-emitter delegation tests)
- `npx tsc --noEmit` clean
- `npm run lint` clean (zero warnings)
- Strengthened eternal-present sweep returns zero hits across all touched files (regex set extended in B6 with `\bB[0-9]\b|\bC[0-9]\b`)
- Bonus stale-identifier sweep `grep -rn 'unwrapTermFromExpression' lib/commcare/` returns zero matches

**Files (carried from the original C1 plan section):**
- Create: `lib/commcare/expression/onDeviceEmitter.ts`
- Create: `lib/commcare/expression/csqlEmitter.ts`
- Tests: `lib/commcare/expression/__tests__/`

Two emitters mirror the predicate-side B2 / B3 split — same wire-grammar reasoning, applied to `ValueExpression` instead of `Predicate`. Both emitters are total: every `ValueExpression` AST node produces a wire string. No per-runtime-player rejection, no representability surface, no error states. The closest-CCHQ-form-or-literal-emission rule applies (consistent with B2 / B3).

**On-device emitter** (`onDeviceEmitter.ts`) — emits XPath value expressions usable in any on-device expression slot (calculated columns, sort keys, late-flag arguments, etc.):
- `today` → `today()`; `now` → `now()`.
- `date-coerce(value)` → `date(<value>)`; `datetime-coerce(value)` → `datetime(<value>)` (rename at emission, same operator semantically).
- `double(value)` → `double(<value>)`.
- `arith(left, op, right)` → `(<left> <xpath-op> <right>)`.
- `concat(parts)` → `concat(<part1>, <part2>, ...)`.
- `coalesce(parts)` → `coalesce(<part1>, <part2>, ...)`.
- `if(condition, then, else)` → `if(<predicate-emit(condition)>, <then>, <else>)` — recursively calls the on-device predicate emitter for the condition.
- `switch(branches, default)` → expand to nested `if(...)` chain (XPath has no native `switch`).
- `format-date(date, format)` → `format-date(<date>, '<format>')`.
- `count(via, where?)` → relational join expansion against `instance('casedb')`, identical shape to the on-device predicate emitter's `exists` join (re-uses the join helper for consistency).
- `date-add(value, interval, quantity)` → emit literally as `date-add(<value>, '<n><unit>')` — well-formed XPath function-call syntax. Whether a runtime player dispatches `date-add` is Dimagi's concern.
- `unwrap-list(value)` → emit literally as `unwrap-list(<value>)`.
- `term(t)` → delegate to the on-device term emitter (already shipped in `lib/commcare/predicate/caseListFilterEmitter.ts`; lift it as a shared helper or call across packages).

**CSQL emitter** (`csqlEmitter.ts`) — emits the `ValueExpression` arms that ARE in CCHQ's CSQL value-function whitelist (`commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-36`):
- `today` → `today()`; `now` → `now()`.
- `date-coerce(value)` → `date(<value>)`; `datetime-coerce(value)` → `datetime(<value>)`.
- `double(value)` → `double(<value>)`.
- `date-add(value, interval, quantity)` → `date-add(<value>, '<n><unit>')` (CSQL supports all interval kinds natively).
- `unwrap-list(value)` → `unwrap-list(<value>)`.
- `term(t)` → delegate to the CSQL term emitter (already shipped in `lib/commcare/predicate/csqlEmitter.ts` as the segment-list IR producer; lift the helper).
- `arith` / `concat` / `coalesce` / `if` / `switch` / `count` / `format-date` → throw with a "should have been hoisted before this emitter ran" defensive message. The B3 CSQL hoisting pass lifts these arms into the on-device wrapper that builds the `_xpath_query` string before the CSQL emitter sees them; this throw defends the bypass path. Same exhaustiveness pattern as B3's emitter throws on non-term ValueExpression arms in operand position.

**Integration with B2 / B3 predicate emitters:** the predicate emitters' operand-side currently throws on non-term ValueExpression arms (the structural exhaustiveness defense documented as the B3-deferred scope boundary in `feedback_max_subset_no_dimagi_litter.md`). C1 wires the predicate emitters to call the appropriate expression emitter for the slot:
- `caseListFilterEmitter.ts` operand sites → call `onDeviceEmitter.ts`.
- `csqlEmitter.ts` operand sites → call this `csqlEmitter.ts` (segment-list IR-aware so the wrapper-IR composition stays clean).

The barrel at `lib/commcare/predicate/index.ts` may need a sibling barrel at `lib/commcare/expression/index.ts` exporting the two emitter entry points + their result types; consumers compose the two packages as a single wire-emission surface.

Steps:
- [ ] Decide on the term-emitter sharing shape (extract to `lib/commcare/predicate/terms/` for cross-package reuse, OR have the expression emitters import the term helpers directly from the predicate package). Pick the lower-churn option.
- [ ] Write failing tests per operator per emitter — pinned wire strings; integration tests covering the predicate-emitter → expression-emitter handoff for non-term operands.
- [ ] Implement both emitters.
- [ ] Wire the predicate emitters' operand sites to call the expression emitters (replace the deferred throws with the appropriate dispatch).
- [ ] Run tests, commit.

### Task C2: Kysely Database type definitions — SHIPPED

Shipped across commits `97721548` → `fadb47ca`.

**Files:**
- `lib/case-store/sql/database.ts` (new) — Kysely Database type plus per-table interfaces for `cases`, `case_type_schemas`, `case_indices`. Schema reflects the spec DDL verbatim (the plan task description had several deltas from the spec; the implementer correctly followed the spec as the single source of truth).
- `lib/case-store/sql/__tests__/database.test.ts` (new, 13 tests) — `DummyDriver` + `PostgresAdapter` + `PostgresQueryCompiler` cold Kysely instance compiling representative typed queries via `.compile()`; assertions on `compiled.sql` shape (using `toContain` for identifiers / JSONB-operator fragments) plus exact-array assertions on `compiled.parameters`. `@ts-expect-error` test pin on the `relationship: "host"` invalid-arm narrowing.
- `package.json` / `package-lock.json` — `kysely ^0.28.16` added to `dependencies` (not `devDependencies` — the runtime uses Kysely for query building, not just tests).

**Schema implemented (per spec lines 247-284):**

`cases` table:
- `case_id` UUID PRIMARY KEY (typed as `string`; no UUID branding — the spec doesn't require it).
- `app_id` TEXT NOT NULL, `case_type` TEXT NOT NULL, `owner_id` TEXT NULLABLE (multi-tenancy isolation key is `(app_id, owner_id)`).
- `status`, `opened_on`, `modified_on`, `closed_on`, `parent_case_id`, `depth` — all NULLABLE except `case_id`/`app_id`/`case_type`.
- `properties` JSONB NOT NULL — typed as `JSONColumnType<JsonObject>` where `JsonObject = Record<string, JsonValue>` and `JsonValue` is the standard recursive JSON-value union including `null`. The three-state distinction (key absent / key present with `null` / key present with empty string) is preserved at the JSONB runtime layer, not narrowed at the static type layer. Per-case-type narrowing happens via `case_type_schemas.schema`'s JSON Schema validator, not via column-type widening.
- No `created_at` / `updated_at` columns (the spec does not specify them; the implementer verified absence in the spec DDL).

`case_type_schemas` table:
- Composite PRIMARY KEY `(app_id, case_type)`. NO surrogate UUID `id` column.
- `app_id` TEXT, `case_type` TEXT, `schema` JSONB NOT NULL.

`case_indices` table:
- Composite PRIMARY KEY `(case_id, ancestor_id, identifier)` per spec line 280.
- `relationship` typed as the literal union `"child" | "extension"` (exported as `CaseIndexRelationship`); `@ts-expect-error` test pins the narrowing.
- `depth` INT NOT NULL — `depth=1` means a direct edge between a case and its immediate ancestor; higher values are reserved for storing transitive edges; the relation-path compiler reads whichever rows exist via recursive CTE (the `case_indices` materialization policy is owned by Plan 2's `caseIndices.ts` — the Database type stays neutral on the policy choice).

**Architectural decisions:**

1. **Spec DDL is the single source of truth.** Plan task description had seven drifts from the spec (`app_id`/`owner_id` UUID vs TEXT, `owner_id` non-nullable, surrogate `id` PK on `case_type_schemas`, `closed_at` vs `closed_on`, missing `status`/`opened_on`/`modified_on`/`parent_case_id`/`depth` columns, `parent_case_id`/`child_case_id` vs `case_id`/`ancestor_id` on `case_indices`, no `depth` column). The implementer followed the spec verbatim — correct behavior per `feedback_check_actual_code_not_spec.md`.
2. **JSONB typing preserves Postgres-strict null semantics at the runtime layer.** `JSONColumnType<JsonObject>` produces `JsonObject` on `Selectable` and `string` (JSON-stringified) on `Insertable`. The `null` value is included in `JsonValue` recursively so a key value of `null` is well-typed.
3. **No UUID branding on `case_id`.** Postgres pg-driver round-trips UUID as `string`; speculative branding would fight every value site.
4. **`relationship` is a literal union, not open `string`.** The spec hardcodes the two values; static narrowing is structural.
5. **`kysely` lives in `dependencies`, not `devDependencies`.** Runtime uses Kysely for query building.
6. **`DummyDriver` + `PostgresAdapter` + `PostgresQueryCompiler` test pattern** — canonical compile-only setup that catches column-name typos, type mismatches on `where` values, and schema drift between the Database type and the SQL the eventual migrations produce. No live DB connection.

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `97721548`. All seven plan-vs-spec drift corrections verified against the spec DDL at lines 247-284. Schema, types, PKs, nullability, literal unions all match.
- Code-quality review (opus): ❌ Round 1 found 2 BLOCKING + 1 IMPORTANT + 1 SUGGESTION on `97721548` — JSDoc carried future-work language ("RLS lands ... once X"), staged a hypothetical migration ("switching is a one-line change ... already accommodates"), and asserted an invariant about a not-yet-existing `CaseStore` interface ("no path that bypasses the filter"). Plus a test-theatre `expect()` on a `@ts-expect-error` pin. Resolved in fix-pass `fadb47ca`: dropped the RLS sentence, rewrote the `depth` JSDoc as a present-tense statement, softened the `CaseStore` claim, replaced the test-theatre `expect` with `void _invalid;`. Bonus: implementer caught + fixed an adjacent TS2578 issue where the literal substring `@ts-expect-error` in an explanation comment was being matched by TypeScript's directive parser. Re-review APPROVED.

**Verification gates (all green at HEAD `fadb47ca`):**
- 2533 full-project tests pass / 14 skipped (vs 2520 pre-C2 baseline; +13 net new tests in `database.test.ts`)
- `npx tsc --noEmit` clean
- `npm run lint` clean (zero warnings)
- Strengthened eternal-present sweep returns zero hits across `database.ts` and `database.test.ts` (regex set extended in B6 with `\bB[0-9]\b|\bC[0-9]\b`)

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

### Task C5: RelationPath compiler — Kysely (case_indices joins) — SHIPPED

Shipped across commits `48c2eac5` → `2a0550ca`.

**Files:**
- `lib/case-store/sql/compileRelationPath.ts` (new) — total `RelationPath` compiler. Public surface: `compileRelationPath(path, ctx) → CompiledRelationPath`. Result is a discriminated union: `{ kind: "self" }` for the no-op degenerate, or `{ kind: "joined", leafAlias, buildLeafSubquery() }` returning an `AliasedExpression<RelationPathLeafRow, "rp_leaf">` callers thread directly into `innerJoin`.
- `lib/case-store/sql/__tests__/compileRelationPath.test.ts` (new, 13 tests) — `.compile()`-only coverage of the join shapes plus a structural-assertion regex (`/inner join \(/i` + `) as "rp_leaf"` token check) on every joined arm so the JOIN-target-paren-wrap invariant is structurally pinned, not implied.
- `lib/case-store/sql/__tests__/compileRelationPath.harness.test.ts` (new, 5 tests) — execute-against-real-Postgres round-trips via the testcontainers harness covering all four joined arms (`ancestor` single-hop, `ancestor` two-hop, `subcase`, `any-relation`) plus a depth-filter regression test that seeds both `depth=1` and `depth=2` rows and asserts the single-hop walk reads only the depth=1 leaf — structural defense against a future regression dropping the depth pin.
- `lib/case-store/sql/database.ts` (modified) — file-header docstring + `CaseIndicesTable.depth` JSDoc updated to describe the chain-of-joins read strategy; both spots cross-reference `compileRelationPath.ts`.

**RelationPath variant coverage:**
- `self` — degenerate; result `{ kind: "self" }`. The leaf alias IS the anchor; callers handle as a no-op join (read directly from the anchor's columns).
- `ancestor` walk (single + multi-hop) — chain of `(case_indices, cases)` joins, one per AST step. Multi-hop composes by chaining the inner `case_indices.ancestor_id → cases.case_id` then `case_indices.case_id = previous_anchor_id` in sequence. AST schema (`z.tuple([RelationStep], rest)`) bounds hop count statically — recursive CTE unnecessary.
- `subcase` — reverses the join direction (`case_indices.ancestor_id = anchor.case_id` then `case_indices.case_id → cases.case_id`).
- `any-relation` — `UNION ALL` of single-hop ancestor + single-hop subcase variants under the same identifier.

**Tenant filter discipline:** the `(app_id, owner_id)` filter applies on EVERY joined `cases` row in the walk, not just the leaf. Multi-hop ancestor walks filter intermediate cases too. `null` `ownerId` compiles to `IS NULL` (not `= NULL` which never matches in SQL). Structurally enforced via `tenantFilterFragments(casesAlias, ctx)` called at every hop; tests pin the parameter-count invariant.

**Depth filter:** `case_indices.depth = 1` on every lookup. Materialization-agnostic against the spec's "case_indices materialization policy" gate — works under Option A (full closure) or Option B (direct edges only) per Plan 2's eventual choice.

**`RelationStep.ofCaseType` / `throughCaseType` filtering:** applied per step. Ancestor steps use `throughCaseType` for intermediate filtering; subcase / any-relation use `ofCaseType` for leaf filtering. The `any-relation` walk maps `ofCaseType` to `throughCaseType` on the ancestor branch correctly.

**Architectural decisions:**

1. **Chain-of-joins, NOT recursive CTE.** Hop count is statically known from the AST schema (`ancestor.via` is a non-empty tuple-with-rest); arbitrary depth is impossible at the type level. `WITH RECURSIVE` would add complexity without covering any shape the chain doesn't already handle.
2. **Subquery-as-join, not spliced JOIN clauses.** Every relation path compiles to a single subquery aliased as `rp_leaf` that callers thread through `innerJoin`. Intermediate joins, tenant filters, depth filters, and case-type filters live inside the subquery; consumers see one alias and read columns through `<rp_leaf>.<col>`.
3. **Raw `sql` template literal, not Kysely's typed builder.** Per-iteration aliases (`ci0`, `cs0`, `ci1`, ...) accumulate into Kysely's table-set type in a way the typed builder cannot express. `sql.ref` for column references and `sql.table` for table names is the canonical Kysely escape hatch for this shape; all identifiers go through the helpers (no raw string interpolation into SQL).
4. **JOIN target paren-wrapped at the composition boundary.** `composeSubqueryBody` wraps the body; `buildAnyRelationBody` wraps the union of branches. Without this, Kysely's `RawBuilder.as(...)` semantics (which appends ` as "rp_leaf"` without wrapping) produce `INNER JOIN select ... where ... as "rp_leaf" ON ...` — invalid Postgres syntax. The structural-assertion regex + the harness round-trips together pin the wrap invariant against future regressions.
5. **`RelationPathLeafRow extends Selectable<Database["cases"]>`** plus synthetic `anchor_case_id`. Picks up every `cases` column automatically; `Selectable<...>` strips Kysely's `JSONColumnType<JsonObject>` to the read-side `JsonObject` consumers expect. Closed an existing latent typing bug where the prior hand-typed leaf row had `properties` as the insert/update wrapper, not the read shape.
6. **`RelationPathCompileContext` uses object args** (`{ db, appId, ownerId, anchorAlias }`) — no positional same-type args. Standing rule per the user's "good function signatures over UUID branding" lock-in.

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `48c2eac5`. All 8 checklist items verified — every variant, tenant filter on every joined `cases` row, depth=1 on every lookup, ofCaseType / throughCaseType per step, API shape, object-args context, test coverage. The implementer's design deviations (chain-of-joins vs CTE, raw SQL template, subquery-as-join) all justified against the AST schema's bounded-depth contract.
- Code-quality review (opus): ❌ Round 1 found 4 BLOCKING + 1 SUGGESTION + 1 cleanup on `48c2eac5`. Critical: JOIN target lacked paren-wrapping → malformed SQL. DummyDriver tests passed because they never executed; consumers (C6 / C7) would have hit Postgres parse errors at first execution. Plus stale recursive-CTE claims in `database.ts`, header comment lying about `sql.id` (uses `sql.ref` / `sql.table`), and hand-typed `RelationPathLeafRow` instead of `Selectable<Database["cases"]>`. All resolved in fix-pass `2a0550ca` with new harness round-trip tests + structural assertion. Re-review APPROVED (gates verified by supervisor).

**Verification gates (all green at HEAD `2a0550ca`):**
- 2565 full-project tests pass / 14 skipped (vs 2556 pre-fix-pass; +9 = 4 paren-wrap structural assertions in compile-only suite + 5 harness round-trips). The `pg_jsonschema` allowlist-gate falls through to the warn path on the postgis/postgis:16-3.4 image, as expected.
- `npx tsc --noEmit` clean
- `npm run lint` clean (798 files; zero warnings, zero errors)
- Strengthened eternal-present sweep returns zero hits across the four touched files (regex includes `\bB[0-9]\b|\bC[0-9]\b`)

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

### Task C7.5: Postgres test infrastructure — SHIPPED

Shipped across commits `d223d9b9` → `5171cd9a`.

**Files:**
- `package.json` / `package-lock.json` — `@testcontainers/postgresql ^11.14.0`, `pg ^8.20.0`, `@types/pg ^8.20.0` added to `devDependencies`.
- `vitest.config.ts` (modified) — `globalSetup` hook + `hookTimeout: 30_000`.
- `lib/case-store/sql/__tests__/globalSetup.ts` (new) — boots a single `postgis/postgis:16-3.4` container per Vitest run; installs `pg_trgm`, `fuzzystrmatch`, `postgis`; conditionally installs `pg_jsonschema` when the image supports it; seeds the schema verbatim from the spec DDL at lines 254-284; publishes the connection URI via `project.provide("postgresTestUrl", ...)`. `console.warn` for the `pg_jsonschema`-absent path because globalSetup runs in the orchestrator before any worker initializes its `@/lib/logger` mock.
- `lib/case-store/sql/__tests__/setup.ts` (new) — per-test fixture via `test.extend<CaseStoreFixtures>` exposing two fixtures, `pgClient` (raw `pg.PoolClient` inside `BEGIN` / `ROLLBACK`) and `db` (a `Kysely<Database>` wrapping the same client through a single-connection pool adapter so the Kysely-side query pool's per-query release is a no-op and the BEGIN scope persists across the whole test). Both fixtures share one connection and one transaction. The empty-pattern fixture form `({}, use) => ...` per Vitest's documented constraint (the parser checks that the first arg starts with `{` and ends with `}`); the `biome-ignore` for `noEmptyPattern` is single-line and citation-anchored to `@vitest/runner/dist/chunk-artifact.js:528`.
- `lib/case-store/sql/__tests__/harness.test.ts` + `harness-isolation.test.ts` (new, 10 smoke tests) — connectivity, extension installation, schema column inventory, INSERT/SELECT round-trip, intra-file rollback isolation, cross-file isolation (proves the container is shared and writes don't survive file boundaries).
- `lib/case-store/CLAUDE.md` (new) — documents the container-per-run + transaction-per-test contract end-to-end, plus the spec→type→DDL three-surface lockstep rule.

**Architectural decisions:**

1. **Container-per-run, not per-file.** `globalSetup.ts` runs in the orchestrator process and boots one container; workers receive the connection URI via `project.provide()`. Per-test isolation comes from `BEGIN` / `ROLLBACK` wrapped around each test body. Without this strategy, every test file would pay a 5-15s container-boot cost and watch-loop iteration becomes unusable.
2. **Both fixtures share one connection.** The `db` fixture wraps the `pgClient` connection through a single-connection pool adapter whose `release()` is a no-op so Kysely's per-query release doesn't unwind the `BEGIN` scope. Both fixtures see the same transaction's writes; tests can mix-and-match raw pg and Kysely against the same data.
3. **`pg_jsonschema` allowlist-gated.** Probe `pg_available_extensions`; install if present, log a single `console.warn` if absent. The case-store compilers don't depend on the trigger; the harness's two code paths (extension installed / fallback expected) are both testable downstream.
4. **Schema seeded from spec DDL verbatim**, not introspected from the Database type. Simpler for v1; the CLAUDE.md notes the three-surface (spec, Database type, harness DDL) lockstep so a future schema change updates all three.
5. **`case_type_schemas` row seeding is per-test, not global.** Tests that need a typed schema row insert it through the transaction-scoped `db` fixture and let it roll back. CLAUDE.md documents this so a future test author doesn't add a global seed.
6. **`console.warn` over `@/lib/logger`** for the `pg_jsonschema`-absent path. Both write to the orchestrator's stderr identically; `console.warn` keeps the harness module free of an internal-package import.
7. **`max: 5` connection pool** — leaves headroom for tests that opt into `test.concurrent`. Each worker has its own pool; cross-worker isolation comes from distinct connections, not from this size. Vitest runs intra-file tests serially by default.

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `d223d9b9`. All nine checklist items verified — devDependencies placement, globalSetup wiring (once per run), three required extensions, `pg_jsonschema` allowlist-gate, schema DDL match against spec lines 254-284, BEGIN/ROLLBACK isolation, smoke test coverage, CLAUDE.md content, no version-label leakage.
- Code-quality review (opus): ❌ Round 1 found 3 BLOCKING + 2 IMPORTANT + 1 SUGGESTION on `d223d9b9` — Vitest fixture pattern misdiagnosed (used `({ task: _task }, use)` workaround when canonical empty-fixture is `({}, use)`), forward-reference comments throughout the harness ("once they land", "runtime trigger / PL/pgSQL fallback" framing in five places), incoherent `console.warn` rationale, missing inline comment on `client.query.bind` cast, wrong `max: 5` pool-size justification, duplicate CLAUDE.md example. All resolved in fix-pass `5171cd9a` (the `({}, use)` adoption needs a single-line `biome-ignore` for `noEmptyPattern`, citation-anchored to the Vitest source line). Re-review APPROVED.

**Verification gates (all green at HEAD `5171cd9a`):**
- 2556 full-project tests pass / 14 skipped (vs 2533 pre-C-phase baseline; +10 from C7.5 smoke + 13 from C5 RelationPath which landed mid-fix-pass).
- `npx tsc --noEmit` clean
- `npm run lint` clean (zero warnings, zero errors)
- Strengthened eternal-present sweep returns zero hits across the touched files (regex includes `\bB[0-9]\b|\bC[0-9]\b`).
- Bonus forward-reference sweep (`once.*(land|ship)|will (land|ship|come)|until.*(land|ship|arriv)|runtime trigger|PL/pgSQL fallback|case-store.s runtime`) returns zero hits.

**Boot-time delta:** ~3s on `npm test`. Well below the 5-15s ceiling the spec noted as an unusable threshold.

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
- [ ] Cross-check: every operator from the spec's V1-IN list has type-checker coverage, an on-device XPath emission, a CSQL emission (via hoist + faithful emission), and a Postgres compiler emission. Build a coverage matrix as a docs artifact.

## Plan shape

Three groups of tasks. Group A extends the shipped AST + type checker; Group B supersedes the broken emitter by splitting into per-dialect visitors and adds the CSQL hoisting pass; Group C lands the Postgres compiler with testcontainers infra. Tasks within each group can run in dependency order; Groups A and B are largely additive on shipped work and can in principle interleave; Group C depends on Group A's full operator set being in place. Plan 2 picks up the Cloud SQL provisioning + extension allowlist gate against the live instance.

The implementor's 33 shipped commits cover the comparison + logical + initial special-operator coverage at the AST + type-checker layers; what's left is everything called out in the v2 corrections above.
