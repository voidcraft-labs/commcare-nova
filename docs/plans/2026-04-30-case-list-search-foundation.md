# Case List & Search — Foundation Implementation Plan (v2)

> **For agentic workers:** Implement this plan task-by-task with subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2 — supersedes v1 of this same file. v1 had a fundamental scope error (missing AST coverage for relational queries, expression family entirely absent, three wire dialects collapsed to two) that surfaced after the implementor had shipped Tasks 1–8. v2 reconciles with shipped work where possible and supersedes where the shipped emitter design is structurally wrong.

**Goal:** Build the typed Predicate AST + typed Expression AST, schema-driven type checker, JSON Schema generator, two CommCare wire emitters (on-device XPath + CSQL with total hoisting), and the AST → Kysely compiler. Ships as tested library code with no consumer yet — Plans 2–5 wire it up.

**Architecture summary** (full detail in `docs/specs/2026-04-30-case-list-search-design.md` v2):
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
- `docs/specs/2026-04-30-case-list-search-design.md` (Null vs blank semantics subsection)
- `docs/plans/2026-04-30-case-list-search-foundation.md` (this section + the B-phase emitter behavior on `is-blank` / `is-null`)

**What landed:**

- `isBlankSchema` (portable: absent OR empty-string), parallel-shaped to the shipped `isNullSchema` (strict: absent only). Both accept any Term in `left`; literal-rejection is the type-checker's job.
- `isBlank` builder mirroring `isNull` with `Extract<Predicate, { kind: "is-blank" }>` return type.
- Type-checker `walk` switch has dedicated arms for both operators sharing a `checkAbsenceOperator` helper that rejects literal-shaped `left` and resolves non-literal terms for unknown-property / unknown-input error propagation.
- Transitional emitter (`xpathEmitter.ts`, slated for B6 deletion) emits `<term> = ''` for `is-blank` and throws on `is-null` — minimal arms; the per-dialect B-stage emitters write the correct wire forms from the spec subsection, not by copying this transitional code.
- The shipped `isNullSchema` JSDoc was rewritten to lock the strict-absent semantic ("key not present in JSONB / Map") and drop the "does the property carry a value?" hedge.

**Locked semantic, family-wide**: the AST is **Postgres-strict**. Every operator that touches null / empty-string / missing-property semantics distinguishes the three states (absent / cleared / explicit-empty) at the data-model layer. CCHQ's wire collapse is a per-emitter concern: the wire emitters faithfully emit `prop = ''` for both `is-null` and `is-blank` (CCHQ's `case_property_query()` short-circuits absent / cleared / empty alike). The Postgres runtime executes the strict semantic natively. No representability checker; no validator hint; no soft-warning UI.

**Surface scoping**: authoring surfaces (filter UI, SA tool surface) default to `is-blank` for "field is empty" intents — the canonical author-facing operator for absent-or-empty semantics. `is-null` is available for any caller that wants strict-absent semantics; on Postgres it executes natively, on CCHQ wire it emits as `prop = ''` (the wire's lossiness collapses absent / cleared / empty alike). Both AST kinds emit faithfully; the AST distinction is preserved end-to-end on Postgres surfaces (case-data inspection, audit / admin views, expression operators that need to distinguish absent from empty).

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
- `unwrap-list` accepts text-shaped; returns the `_sequence` sentinel. The predicate AST has no consumer of the sequence type — `multi-select-contains.values` and `in.values` stay literal-only because every wire target demands a static value list. The CSQL emitter routes `unwrap-list` into `selected-any(prop, unwrap-list(...))` at wire-emit time; that pattern lands in the B-phase. The compatibility table treats `_sequence` as incompatible with every scalar (including itself) so an author composing a sequence into a scalar slot gets a clear error at the type-checker layer.
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

### Task C3: Term compiler — Kysely — SHIPPED

Shipped across commits `16fb0eb2` → `e1711f6a`.

**Files:**
- `lib/case-store/sql/compileTerm.ts` (new) — total `Term` compiler. Public surface: `compileTerm(term, ctx) → Expression<unknown>`. Dispatches on the five Term arms (`prop`, `literal`, `input`, `session-user`, `session-context`).
- `lib/case-store/sql/__tests__/compileTerm.test.ts` (new, 37 compile-only tests) — DummyDriver coverage of every Term arm + every property-data-type cast + tenant-scope positive assertion + reserved-column shadowing pin + binding error paths.
- `lib/case-store/sql/__tests__/compileTerm.harness.test.ts` (new, 8 round-trip tests) — execute-against-real-Postgres via testcontainers; one round-trip per `CasePropertyDataType` cast token (text, int, decimal, date, time, datetime, single_select, multi_select, geopoint) plus a Postgres-strict null semantic test that pins `eq(prop, literal(""))` does NOT match an absent JSONB key.

**Term-arm coverage:**
- `prop` with `via.kind === "self"`: typed JSONB extraction `(${anchorAlias}.properties ${readOperator} ${property})::${cast}` for non-reserved properties; reserved scalar columns (`case_id`, `case_type`, `owner_id`, `status`) read directly via `sql.ref(${anchorAlias}.${column})` without JSONB.
- `prop` with non-self `via`: reads through `RELATION_PATH_LEAF_ALIAS` (`"rp_leaf"`) — the term compiler does NOT call `compileRelationPath`. The wider compiler (C4 / C7) drives the join; `compileTerm` assumes the leaf alias is in scope. Negative-assertion test pins this contract.
- `literal`: binds via `sql\`${value}\`` for Kysely's parameter channel; non-null literals add `::${cast}`. `null` emits as the SQL keyword `null` (not parameterized).
- `input` / `session-user` / `session-context`: resolve from `TermBindings` maps; missing bindings throw at compile time.

**Property-type cast mapping** (`POSTGRES_CAST_FOR_DATA_TYPE`, all 9 variants):
- `text` → `::text` (the `->>` returns text natively; explicit cast documents intent).
- `int` → `::int`.
- `decimal` → `::numeric`.
- `date` → `::date`.
- `time` → `::time`.
- `datetime` → `::timestamptz`.
- `single_select` → `::text`.
- `multi_select` → `::jsonb` paired with `->` (not `->>`) — needed because the predicate compiler's `multi-select-contains` uses JSONB containment operators (`?|`, `?&`, `@>`) that require JSONB on the LHS.
- `geopoint` → `::text` (CCHQ's wire format is the four-decimal string `"latitude longitude altitude accuracy"`; PostGIS spatial dispatch happens at the predicate layer in C4 via `within-distance`'s `ST_DWithin`, not at the term layer).

**Architectural decisions:**

1. **`compileTerm`'s relation-path involvement.** Originally `compileTerm` did NOT invoke `compileRelationPath` — the wider compiler drove the join so one outer query could reuse a single relation-path subquery across multiple term reads. Phase 1 (C5 SHIPPED amendment) flipped this for non-self via property reads: `compileTerm.compilePropertyRef` now constructs a correlated scalar subquery via `compileRelationPath`, allowing non-self via reads in any value-bearing operand position. Self via reads still bypass the relation-path compiler and read directly off the anchor's `cases` row. See C5 SHIPPED for the architectural details.
2. **`multi_select` uses `->` (JSONB) not `->>` (text).** JSONB containment operators on the LHS require JSONB. Documented inline + test-pinned.
3. **Property's `data_type` resolves on the walk's destination case-type for non-self `via`** (NOT `term.caseType`, which is the originating scope). Mirrors `checkRelationPath` in the type checker.
4. **Tenant scope on context but not consumed by `compileTerm`.** `TermCompileContext` carries `appId` / `ownerId`; the compiler doesn't apply tenant filters at the term layer (the wider compiler does). Positive-assertion test pins the absence of tenant-filter SQL in the term's emitted expression.
5. **`TermBindings` value type narrows to `string | number | boolean | Date | null`** so structured payloads fail at the type boundary, not inside the pg-driver.
6. **Reserved-column shadowing routes to scalar columns unconditionally** — if the property name is in the `RESERVED_SCALAR_COLUMNS` set, the scalar column reads regardless of schema. The blueprint validator owns rejecting these names; the routing handles the bypass path. Test pin.
7. **Geopoint storage shape verified against CCHQ source** (`commcare-hq/corehq/ex-submodules/couchforms/geopoint.py`) — four space-separated decimals. The `text`-cast read at the term layer + PostGIS dispatch at the predicate layer (C4's `within-distance` arm) are the two consumers.

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `16fb0eb2`. All 11 checklist items verified — every Term variant, JSONB extraction shape, property-type cast mapping, non-self via destination resolution, literal parameter binding, bindings shape, tenant-scope positive assertion, test coverage matching the plan, object args, no version-label leakage. The `multi_select` divergence and the C5-separation design call were both audited as defensible.
- Code-quality review (opus): ❌ Round 1 found 1 BLOCKING on `16fb0eb2` — harness round-trip coverage missed 4 of 9 `CasePropertyDataType` variants (`time`, `datetime`, `single_select`, `geopoint`). The schema even declared `registered_at` (datetime) and `color` (single_select) but no test body read them. The harness file's own header explicitly cited the C5-class bug class as the reason it exists. Resolved in fix-pass `e1711f6a` with 4 new round-trips. `time` and `datetime` use ordered comparisons (`>`) so a `::time` / `::timestamptz` typo would fail Postgres parse — the C5-class regression defense. Re-review APPROVED.

**Verification gates (all green at HEAD `e1711f6a`):**
- 2614 full-project tests pass / 14 skipped (vs 2565 pre-C3 baseline; +49 net new tests = 37 compile-only + 8 harness round-trips + 4 fix-pass round-trips).
- `npx tsc --noEmit` clean
- `npm run lint` clean (801 files; zero warnings, zero errors)
- Strengthened eternal-present sweep returns zero hits across the three new files (regex includes `\bB[0-9]\b|\bC[0-9]\b`).

### Task C4: Predicate compiler — Kysely — SHIPPED

Shipped across commits `f8a8d212` → `7d0f78e7` (the fix-pass changes landed bundled with the C6 plan SHIPPED-sync due to a staging-area collision; the code lives at HEAD `7d0f78e7` for both predicate-compiler files and the cast-table export from `compileTerm.ts`).

**Files:**
- `lib/case-store/sql/compilePredicate.ts` (new) — total `Predicate` compiler covering every kind in the union: sentinels (match-all/match-none), logical (and/or/not), comparison (six ops), null/blank (is-null, is-blank, with Postgres-strict semantics), membership (in, between), multi-select-contains (any/all quantifiers), match (fuzzy via pg_trgm, phonetic via fuzzystrmatch, fuzzy-date via permutation IN-list, starts-with), within-distance (PostGIS `ST_DWithin`), exists / missing (correlated `EXISTS (subquery)` against the relation-path leaf), when-input-present.
- `lib/case-store/sql/compileTerm.ts` (modified) — `POSTGRES_CAST_FOR_DATA_TYPE` exported as `Readonly<Record<CasePropertyDataType, string>>` for shared use across the SQL package.
- `lib/case-store/sql/__tests__/compilePredicate.test.ts` (new, 53+ cold tests via DummyDriver).
- `lib/case-store/sql/__tests__/compilePredicate.harness.test.ts` (new, 29+ round-trips against the testcontainers harness; covers every arm + the four distinct null-semantic cases).

**Postgres extension dispatch (per the plan):**
- JSONB key-existence (`?`), `?|`, `?&` for multi-select-contains.
- `pg_trgm` for fuzzy match (similarity operator + threshold).
- `fuzzystrmatch` `dmetaphone` for phonetic match.
- PostGIS `ST_DWithin` + `ST_GeogFromText` for within-distance.
- Standard SQL for the rest.

**Postgres-strict null semantics (4 distinct cases):**
- `is-null(prop)` → `NOT (anchor.properties ? 'key')` for property refs (key-existence test); `<term> IS NULL` for non-prop terms. Strict-absent only.
- `is-blank(prop)` → `(NOT (anchor.properties ? 'key')) OR (anchor.properties->>'key') = ''` for prop terms; `<term> IS NULL OR <term> = ''` for non-prop terms.
- `compare(prop, literal(""))` → standard equality against JSONB `->>`. Strict-empty only.
- `compare(prop, literal(null))` → equality against SQL `NULL` keyword. Strict-null only.

All four cases round-trip-pinned in the harness against rows where the JSONB key is absent / present-with-empty-string / present-with-null. The wire-collapse that CCHQ does is NOT replicated on Postgres — the live runtime preserves the strict semantic per `feedback_postgres_strict_ast_null_semantics.md`.

**`fuzzy-date` semantics — verified against CCHQ source.** NOT a partial-date range. CCHQ at `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:101-140` implements `date_permutations("2024-12-03")` producing 16 transposed-date variants (year/month/day swaps and digit reversals). The compiler emits `prop IN (perm1, perm2, ...)` over the structurally-valid permutation set. Algorithm matches the cited Python source.

**Architectural decisions:**

1. **`PredicateCompileContext = TermCompileContext`** — no extra fields. The EXISTS-based join strategy means no "joins to register" channel needs to thread through.
2. **Correlated `EXISTS (subquery)` / `NOT EXISTS (subquery)` for `exists`/`missing`** — over side-channel join registration. Inner `where` compiles with `anchorAlias` swapped to the leaf alias so self-via terms inside route through the related case row. Self-via collapses to `where` directly (or trivial-true/false sentinels for the no-where case).
3. **Reserved-column shadowing on `is-null`/`is-blank`** — the four reserved scalar columns (`case_id`, `case_type`, `owner_id`, `status`) dispatch through `IS NULL` / `OR <col> = ''` instead of the JSONB `?` operator. Matches the term compiler's reserved-column routing.
4. **Tenant scope is the OUTER query's responsibility, not the predicate's.** The predicate compiler trusts the caller has applied tenant scope. Documented in JSDoc; positive-assertion test confirms no `(app_id, owner_id)` filter SQL appears in the predicate's emitted expression.
5. **Nested non-self relation walks compose.** Originally rejected at compile time via `containsNonSelfRelationWalk` (the rejection guarded against the SQL alias-shadowing case where an inner subquery's `rp_leaf` would shadow the outer's `rp_leaf` under SQL lexical scoping). Phase 1 (C5 SHIPPED amendment) replaced the rejection with the depth-suffix mechanism (`leafAliasForDepth(depth)` returns `rp_leaf` at depth 0 and `rp_leaf_<N>` at deeper levels). The `containsNonSelfRelationWalk` function and its callers are gone; nested non-self walks compose end-to-end via the `relationPathDepth` thread on `RelationPathCompileContext`. See C5 SHIPPED for the depth-suffix architecture and the two new harness tests pinning the composition.
6. **Cast-table single-source via the dedicated `dataTypeTokens.ts` sibling module** — both `compileTerm` and the shared `compileLiteral` helper (extracted in C8) read the cast token directly from `dataTypeTokens.ts`'s exported `POSTGRES_CAST_FOR_DATA_TYPE` table. Earlier `SYNTHETIC_LITERAL_CONTEXT` with `db: undefined as never` was a fragile workaround; the data-only sibling module eliminates the synthetic context entirely. The `compileLiteralValue` helper this section originally described was renamed to `compileLiteral` in C8 and lifted to its own module so both `compileTerm.literal` arm and `compilePredicate.in.values` arm consume the same helper.
7. **`multi-select-contains` rejects non-string literals at the SQL boundary.** `Literal({ value: 5 })` reaching the `?|` operator against a JSONB array containing the number `5` would silently mismatch (numbers and strings are distinct JSONB types). The rejection is at the SQL-emission layer with a clear error message; schema-layer narrowing was rejected as cross-cutting (would require splitting `literalSchema` shared with `inSchema.values`).
8. **`when-input-present` "bound" definition documented as `bindings.has(name)` regardless of value.** The divergence from CCHQ's `count(input)` (which returns 0 for empty strings) is documented inline; callers wanting CCHQ alignment strip blank values from `searchInputs` before passing the bindings.

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `f8a8d212`. Every Predicate kind dispatched; Postgres extension dispatch covers all four arms (JSONB / pg_trgm / fuzzystrmatch / PostGIS); Postgres-strict null semantics correctly implemented; `fuzzy-date` permutation algorithm verified against CCHQ source; relation-path EXISTS strategy clean; nested-non-self-walks rejection acceptable for the C4 stage with C7 deferral; tenant scope correctly the outer query's responsibility; coordination with C6 clean.
- Code-quality review (opus): ❌ Round 1 found 1 BLOCKING + 2 IMPORTANT + 1 SUGGESTION on `f8a8d212` — pervasive eternal-present voice violations (11 sites positioning code relative to a not-yet-landed C7 integration; "for now", "until X integrates", "is not yet supported" leaked into both docstrings and runtime error messages); `SYNTHETIC_LITERAL_CONTEXT` `db: undefined as never` fragility; `compileMultiSelectContains` silent type coercion via `String(v)`; `when-input-present` empty-string semantic undocumented. All resolved in fix-pass `7d0f78e7` (Option A for the synthetic context, Option B for multi-select narrowing, suggestion punted with explicit JSDoc). Strengthened sweep regex extended with `integration layer|is not yet|for now\b|Until [Tt]he|integrat(es|ion) (covers|wires)` patterns. Re-review APPROVED.

**Verification gates (all green at HEAD `7d0f78e7`):**
- 2766 full-project tests pass / 14 skipped (was 2614 pre-C4-and-C6 baseline; C4's contribution: 53 cold + 29 harness + 1 fix-pass non-string-token rejection test).
- `npx tsc --noEmit` clean
- `npm run lint` clean (807 files; zero warnings, zero errors)
- Strengthened eternal-present sweep returns zero hits across the four touched files (regex includes `\bB[0-9]\b|\bC[0-9]\b` plus the C4-fix-pass-added patterns).

### Task C5: RelationPath compiler — Kysely (case_indices joins) — SHIPPED

Shipped across commits `48c2eac5` → `2a0550ca` → `96909fc4` → `5cc3db1d` → `75ed1ac7`. The first two commits landed the initial implementation against the original "raw sql template + chain-of-joins-as-subquery" shape; the last three rewrote `compileRelationPath.ts` to nested correlated EXISTS via Kysely's typed query builder and unblocked nested non-self relation walks (the `containsNonSelfRelationWalk` rejection in `compilePredicate.ts` is gone).

**Files:**
- `lib/case-store/sql/compileRelationPath.ts` (new) — total `RelationPath` compiler. Public surface: `compileRelationPath(path, ctx) → CompiledRelationPath`. Result is a discriminated union: `{ kind: "self" }` for the no-op degenerate, or `{ kind: "joined", leafAlias, buildLeafSubquery() }` returning an `AliasedExpression<RelationPathLeafRow, string>` callers thread directly into `innerJoin`, wrap in `eb.exists(eb.selectFrom(...))` for predicate-side EXISTS, or wrap in `(SELECT count(*) FROM ...)` for expression-side count.
- `lib/case-store/sql/compileTerm.ts` (modified) — `compilePropertyRef`'s non-self via branch constructs a correlated scalar subquery: `(SELECT (<leaf>.properties ->> 'k')::cast FROM (<leaf-aliased-expr>) WHERE <leaf>.anchor_case_id = <ctx.anchorAlias>.case_id LIMIT 1)`. The same shape composes in any value-bearing operand slot.
- `lib/case-store/sql/compilePredicate.ts` (modified) — `containsNonSelfRelationWalk` and its callers removed; `compileExistsOrMissing` increments `relationPathDepth` before recursing into the inner `where`; `compilePropertyAbsenceCheck` for non-self via routes through `compileTerm` so the absence check matches the value-bearing read's semantic.
- `lib/case-store/sql/compileExpression.ts` (modified) — `compileCount` threads `relationPathDepth` through to `compileRelationPath` (depth unchanged when no inner where; depth bumped when threading through the predicate thunk for `count(via, where)`).
- `lib/case-store/sql/__tests__/compileRelationPath.test.ts` (new, 13 tests) — `.compile()`-only coverage of the join shapes plus a structural-assertion regex (`/inner join \(/i` + `) as "rp_leaf"` token check) on every joined arm so the JOIN-target-paren-wrap invariant is structurally pinned, not implied.
- `lib/case-store/sql/__tests__/compileRelationPath.harness.test.ts` (new, 5 tests) — execute-against-real-Postgres round-trips via the testcontainers harness covering all four joined arms (`ancestor` single-hop, `ancestor` two-hop, `subcase`, `any-relation`) plus a depth-filter regression test that seeds both `depth=1` and `depth=2` rows and asserts the single-hop walk reads only the depth=1 leaf — structural defense against a future regression dropping the depth pin.
- `lib/case-store/sql/__tests__/compilePredicate.harness.test.ts` (modified) — replaced the rejection test with two positive nested non-self walk tests that round-trip against the live engine: (1) `exists(parent: household, where: exists(parent: village, where: name = "X"))` and (2) `exists(parent: household, where: eq(prop("household", "name", via=parent: village), "X"))`. Together these pin the depth-suffix mechanism end-to-end.
- `lib/case-store/sql/__tests__/compileTerm.test.ts` (modified) — updated for the scalar-subquery contract on non-self via reads.
- `lib/case-store/sql/database.ts` (modified) — file-header docstring + `CaseIndicesTable.depth` JSDoc cross-reference `compileRelationPath.ts`.

**RelationPath variant coverage:**
- `self` — degenerate; result `{ kind: "self" }`. The leaf alias IS the anchor; callers handle as a no-op join (read directly from the anchor's columns).
- `ancestor` walk (single + multi-hop) — chain of `(case_indices, cases)` joins, one per AST step, built via Kysely's typed builder. Single-hop arms compile entirely under static type checking; multi-hop walks chain `innerJoin('case_indices as ciN', ...)` and `innerJoin('cases as csN', ...)` through a type-erased local view at the loop's tail because TS template-literal types cannot enumerate runtime alias accumulation. AST schema (`z.tuple([RelationStep], rest)`) bounds hop count statically — recursive CTE unnecessary.
- `subcase` — reverses the join direction (`case_indices.ancestor_id = anchor.case_id` then `case_indices.case_id → cases.case_id`); single-hop, fully type-checked.
- `any-relation` — `UNION ALL` of single-hop ancestor + single-hop subcase variants under the same identifier, composed via Kysely's `selectQueryBuilder.unionAll(other)` and aliased once at the union boundary.

**Tenant filter discipline:** the `(app_id, owner_id)` filter applies on EVERY joined `cases` row in the walk, not just the leaf. Multi-hop ancestor walks filter intermediate cases too. `null` `ownerId` compiles to `IS NULL` (not `= NULL` which never matches in SQL). Structurally enforced via per-arm typed-builder `where(eb.and([...]))` calls at every hop; tests pin the parameter-count invariant.

**Depth filter:** `case_indices.depth = 1` on every lookup. Materialization-agnostic against the spec's "case_indices materialization policy" gate — works under Option A (full closure) or Option B (direct edges only) per Plan 2's eventual choice.

**`RelationStep.ofCaseType` / `throughCaseType` filtering:** applied per step. Ancestor steps use `throughCaseType` for intermediate filtering; subcase / any-relation use `ofCaseType` for leaf filtering. The `any-relation` walk maps `ofCaseType` to `throughCaseType` on the ancestor branch correctly.

**Architectural decisions:**

1. **Nested correlated EXISTS via Kysely's typed builder.** Each relation path compiles to an aliased subquery (`AliasedExpression<RelationPathLeafRow, string>`) callers thread through `innerJoin`, `eb.exists(eb.selectFrom(...))`, or `(SELECT count(*) FROM ...)`. The body is built entirely in the typed builder (`db.selectFrom('case_indices as ci0').innerJoin('cases as cs0', (jb) => jb.onRef(...)).where(...).select([...])`); `compileRelationPath.ts` carries zero `sql\`` template uses.
2. **Chain-of-joins, NOT recursive CTE.** Hop count is statically known from the AST schema (`ancestor.via` is a non-empty tuple-with-rest); arbitrary depth is impossible at the type level. `WITH RECURSIVE` would add complexity without covering any shape the chain doesn't already handle.
3. **Subquery-as-join, not spliced JOIN clauses.** Every relation path compiles to a single subquery the consumer aliases via `leafAliasForDepth(ctx.relationPathDepth ?? 0)`. Intermediate joins, tenant filters, depth filters, and case-type filters live inside the subquery; consumers see one alias and read columns through `<leafAlias>.<col>`.
4. **Depth-suffixed leaf alias for inner-to-outer correlations.** `RelationPathCompileContext.relationPathDepth` (optional, defaulting to 0 — the outermost depth) carries the nesting depth. `leafAliasForDepth(depth)` returns `rp_leaf` at depth 0 and `rp_leaf_<N>` at deeper levels. The depth-suffix is the structural defense against the case where an inner subquery's correlated WHERE references the outer leaf alias: SQL's lexical scoping binds an unqualified `rp_leaf` to the innermost FROM list, so without the suffix the inner subquery's `rp_leaf` shadows the outer one and the correlation `rp_leaf.anchor_case_id = rp_leaf.case_id` resolves to `<inner>.anchor_case_id = <inner>.case_id` — always false for a `parent` walk by construction. Hop aliases (`ci0`/`cs0`/`ci1`/`cs1`/...) stay scope-isolated by SQL subquery scoping; only the leaf alias crosses scope boundaries via correlation references and needs the depth-suffix.
5. **JOIN target paren-wrapping** is handled by Kysely's typed builder automatically; no manual wrap needed. The cold compile-only suite still asserts the `inner join (` / `) as "<alias>"` token shape as a structural defense, and the harness round-trips pin behavioral correctness against the live engine.
6. **`RelationPathLeafRow extends Selectable<Database["cases"]>`** plus synthetic `anchor_case_id`. Picks up every `cases` column automatically; `Selectable<...>` strips Kysely's `JSONColumnType<JsonObject>` to the read-side `JsonObject` consumers expect.
7. **`RelationPathCompileContext` uses object args** (`{ db, appId, ownerId, anchorAlias, relationPathDepth? }`) — no positional same-type args. Standing rule per the project's "good function signatures over UUID branding" lock-in.
8. **Term-side correlated scalar subquery for non-self via property reads.** `compileTerm.compilePropertyRef`'s non-self via branch builds a correlated scalar subquery `(SELECT (<leaf>.properties ->> 'k')::cast FROM (<leaf-aliased-expr>) WHERE <leaf>.anchor_case_id = <anchorAlias>.case_id LIMIT 1)`. The `LIMIT 1` makes the result scalar; multi-row leaves would otherwise surface as a "more than one row returned by a subquery used as an expression" runtime error. Reserved scalar columns bypass JSONB and read directly off the leaf row.
9. **`compilePredicate.containsNonSelfRelationWalk` removed.** The defensive backstop against nested non-self walks (the obsolete shape that flat-JOIN aliases would shadow under nesting) is gone. The depth-suffix mechanism keeps nested correlations valid; the function and its callers were dropped.

**Reviews (initial implementation, commits `48c2eac5` → `2a0550ca`):**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `48c2eac5`. All 8 checklist items verified — every variant, tenant filter on every joined `cases` row, depth=1 on every lookup, ofCaseType / throughCaseType per step, API shape, object-args context, test coverage. The implementer's design deviations (chain-of-joins vs CTE, raw SQL template, subquery-as-join) all justified against the AST schema's bounded-depth contract.
- Code-quality review (opus): ❌ Round 1 found 4 BLOCKING + 1 SUGGESTION + 1 cleanup on `48c2eac5`. Critical: JOIN target lacked paren-wrapping → malformed SQL. DummyDriver tests passed because they never executed; consumers (C6 / C7) would have hit Postgres parse errors at first execution. Plus stale recursive-CTE claims in `database.ts`, header comment lying about `sql.id` (uses `sql.ref` / `sql.table`), and hand-typed `RelationPathLeafRow` instead of `Selectable<Database["cases"]>`. All resolved in fix-pass `2a0550ca` with new harness round-trip tests + structural assertion. Re-review APPROVED.

**Reviews (typed-builder rewrite, commits `96909fc4` → `5cc3db1d` → `75ed1ac7`):**

- Spec-compliance review (sonnet on Phase 1): ❌ COMPLIANT WITH FINDINGS on `96909fc4`. F-1: stale file-header comments (in `compileRelationPath.ts:54-71` and `compilePredicate.ts:108-109`) described the alias-isolation mechanism using the pre-rewrite "subquery scoping alone is sufficient" premise, with one sentence directly contradicting the implementation. Resolved in fix-pass `5cc3db1d`. All 11 spec invariants pass; all five verification gates pass independently.
- Code-quality review (opus on Phase 1): ❌ APPROVED WITH FINDINGS on `96909fc4` + `5cc3db1d`. IMPORTANT-1: stale literal `"rp_leaf"` references in two JSDoc blocks contradicted the runtime-widened `string` type (the `leafAlias` cast widened to `string` to accommodate the depth-suffix). IMPORTANT-2: eternal-present voice violation in `relationPathDepth` JSDoc ("unmodified call sites" / "backwards-compatible") implied a prior version where the field was required. Resolved in fix-pass `75ed1ac7`. SUGGESTION-1 (duplicate misuse-contract error message in `compilePredicate.ts:373` and `:1243`) deferred to Phase 2's `compileValueExprOperand` consolidation. Phase 2 readiness assessment: the scalar-subquery shape composes cleanly with Phase 2's zero-`sql\`` goal — sketched against `compileTerm.ts:577-578`'s correlated subquery and verified `selectFrom(<aliased-expr>).select(...).whereRef(...).limit(1)` produces the equivalent shape.
- The supervisor adjudicated the implementer's deviation from the dispatch brief (the brief forbade `aliasDepth`-shaped scaffolding; the implementer renamed to `relationPathDepth` and shipped depth-suffixed aliases) as principled. The brief's premise that "subquery scoping isolates aliases across nesting levels" was an over-reach: correlated inner-to-outer references DO require distinct alias names, and depth-suffix is one valid mechanism. The supervisor's lesson — when a colleague's verification covers SHAPE, do not extend it to all COMPOSITIONS using that shape without sketching the alternative for each.

**Verification gates (all green at HEAD `75ed1ac7`):**
- 2767 full-project tests pass / 14 skipped (vs 2766 pre-Phase-1 baseline; +1 net new = -1 deleted nested-walk-rejection test + 2 new positive nested-walk tests in `compilePredicate.harness.test.ts`).
- `npx tsc --noEmit` clean
- `npm run lint` clean (807 files; zero warnings, zero errors)
- `rg "\bsql\`" lib/case-store/sql/compileRelationPath.ts` returns 0 matches.
- `rg "containsNonSelfRelationWalk" lib/case-store/sql/` returns 0 matches.
- `rg "aliasDepth" lib/case-store/sql/` returns 0 matches (`relationPathDepth` is the post-rewrite name).
- Strengthened eternal-present sweep returns zero hits across the touched files. Sweep regex set: `task ?B|extract|moved|added|previously|originally|formerly|now (uses|delegates|imports)|in (this|that) (task|step)|supersed|until [^.]*(land|come|arriv)|future change|will (eventually|land|move|migrate)|transitional emitter knows|deleted in (B|C)|ever lands|if one ever|hypothetical|representab|Plan ?[0-9]|Phase ?[0-9]|\bv[0-9]\b|\bV[0-9]\b|\bB[0-9]\b|\bC[0-9]\b|unmodified|backwards.compatible|forward.compatible|migration accommodation`. The `unmodified|backwards.compatible|...` patterns were added during Phase 1's code-quality review to catch the migration-framed JSDoc the prior pattern set missed.

### Task C6: Expression compiler — Kysely — SHIPPED

Shipped across commits `a74da3c4` → `e25d2525`.

**Files:**
- `lib/case-store/sql/compileExpression.ts` (new) — total `ValueExpression` compiler covering all 15 union arms (term, today, now, date-coerce, datetime-coerce, double, arith, concat, coalesce, if, switch, count, unwrap-list, format-date, date-add). Public surface: `compileExpression(expr, ctx) → Expression<unknown>`. Context shape: `ExpressionCompileContext extends TermCompileContext` plus an optional `compilePredicate?: CompilePredicateThunk` callback.
- `lib/case-store/sql/__tests__/compileExpression.test.ts` (new, 37 cold-suite tests) — DummyDriver coverage of every arm + per-op for `arith` (5 ops) + per-interval for `date-add` (7 units) + per-preset for `format-date` (3 presets + free-form) + 3 `if`/`switch` shape tests + 4 `count` tests (subquery shape, thunk thread, self-via throw, missing-thunk throw).
- `lib/case-store/sql/__tests__/compileExpression.harness.test.ts` (new, 32 round-trip tests against the testcontainers harness) — `today`/`now` constants, 3 coercion arms, 5 `arith` ops, 2 `concat` (join + NULL-as-empty), 2 `coalesce`, 4 `format-date` (iso/short/long presets + custom pattern), 8 `date-add` intervals + negative quantity, 3 `count` shapes, 3 `if`/`switch` end-to-end via stub thunks. C5-class regression defense: round-trips fire every cast token through Postgres's parse step.

**Operator coverage and SQL shapes:**
- Date / time constants: `today` → `current_date`; `now` → `now()`.
- Date coercion: `date-coerce(value)` → `(<value>)::date`; `datetime-coerce(value)` → `(<value>)::timestamptz`.
- Numeric: `double(value)` → `(<value>)::numeric`; `arith(left, op, right)` → `(<left>) <op> (<right>)` over the five AST ops.
- String: `concat(parts)` → Postgres `concat(...)` (NULL-tolerant — "NULL arguments are ignored" per the official docs, observably identical to coercing-to-empty); `format-date(date, format)` → `to_char((<date>)::timestamptz, '<format>')` with a typed preset Record (`short` → `MM/DD/YYYY`; `long` → `FMMonth FMDD, YYYY` (FM strips Postgres's fixed-width month-name fill); `iso` → `YYYY-MM-DD`); free-form strings pass through.
- Conditional: `coalesce(parts)` → `COALESCE(<part1>, ...)`; `if(condition, then, else)` → searched `CASE WHEN <cond> THEN <then> ELSE <else> END`; `switch(on, branches, default)` → simple `CASE <on> WHEN <when_1> THEN <then_1> ... ELSE <default> END` (discriminator evaluates once — important for expensive `on` shapes like `count(...)`).
- Aggregation: `count(via, where?)` → calls `compileRelationPath(via, ctx)` and wraps `buildLeafSubquery()` in `(SELECT COUNT(*) FROM (<rp_leaf>) AS rp)` with the optional `where` filter applied via the predicate-compiler callback.
- Date arithmetic: `date-add(value, interval, quantity)` → `(<value>)::timestamptz + (<quantity> * INTERVAL '1 <interval>')`. Result type is `timestamptz` for every interval unit (day-only intervals lose the date-typed return but preserve uniform downstream consumption).
- List: `unwrap-list(value)` — defensive throw with citation. The CSQL hoist pass at the wire-emission boundary handles `unwrap-list`; no Postgres consumer exists at the SQL-compiler layer.
- Term lifter: `term(t)` → delegates to `compileTerm(t, ctx)`.

**Architectural decisions:**

1. **Thunk-based predicate decoupling.** `compilePredicate?: CompilePredicateThunk` callback on `ExpressionCompileContext`. The Expression compiler does not import the Predicate compiler — the integrating caller (C7) wires the callback. Defensive throws fire on `if.cond` and `count.where` when the callback is absent. Zero direct import of `compilePredicate.ts` from `compileExpression.ts` — no cycle. C7 wires the callback as one ctx field.
2. **`switch` uses simple-CASE form** (`CASE <on> WHEN ... END`), not searched-CASE. Discriminator evaluates once — important for expensive `on` shapes like `count(...)`.
3. **`format-date` preset Record + Postgres-pattern pass-through.** Authors target Postgres's `to_char` vocabulary directly on Nova-runtime apps; the preset Record is a typed lookup, not a CCHQ-vocabulary translation layer. The runtime preset-key set derives from `Object.keys(FORMAT_DATE_PRESET_TO_PATTERN)` so adding a preset to the Record auto-extends the dispatch.
4. **`date-add` casts the base to `timestamptz`** for every interval unit; the result type is uniform `timestamptz`. Day-only intervals lose the date-typed return type, but Postgres coerces between `date` and `timestamptz` cleanly across every comparison and composition context the case-store consumes; the uniform type-shape simplifies downstream type inference at the cost of a precision-irrelevant widening.
5. **`concat` uses Postgres `concat(...)`** (NULL-tolerant), matching the type checker's "each part casts to text at evaluation" spec.
6. **`unwrap-list` defensive throw** — the CSQL hoist at the wire-emission boundary handles this kind. The throw catches any unexpected reach into the Postgres compiler.
7. **`long` preset pattern uses `FM` prefix on `Month`** (`FMMonth FMDD, YYYY`) to strip Postgres's fixed-width month-name fill, so the rendered output is `"May 2, 2026"` not `"May      2, 2026"`. Round-trip-pinned in the harness.

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `a74da3c4`. All 12 checklist items verified — every ValueExpression arm, plan's wire forms (`current_date`, `now()`, `+ INTERVAL`, `CASE WHEN`, `COUNT(*)`), thunk-based decoupling shape, `format-date` preset translation, `switch` simple-CASE form, `date-add` `timestamptz` cast, `concat` NULL-tolerance, `unwrap-list` defensive throw, object args, harness coverage, no version-label leakage, C4 coordination clean.
- Code-quality review (opus): ❌ Round 1 found 1 BLOCKING + 2 SUGGESTIONS on `a74da3c4` — dead `ExpressionCompileDatabase` / `ExpressionCompileSchemas` exports + their dragged-in `Kysely` / `CaseType` imports; `concat` docstring mis-cited the Postgres semantic ("NULL parts coerce to empty" → actually "NULL arguments are ignored"); `format-date` harness coverage gap on `short` and `long` presets. All resolved in fix-pass `e25d2525` (the `long` preset pattern shift to `FMMonth FMDD, YYYY` discovered during the harness round-trip + drive-by header fix on `switch` simple-CASE description). Re-review APPROVED.

**Verification gates (all green at HEAD `e25d2525`):**
- 2765 full-project tests pass / 14 skipped (vs 2614 pre-C6 baseline; +69 net new from C6 = 37 cold + 32 harness, plus +82 from C4's parallel landing).
- `npx tsc --noEmit` clean
- `npm run lint` clean on C6-touched files (worktree-wide lint has C4 cleanup territory not in C6's scope)
- Strengthened eternal-present sweep returns zero hits across the three new files (regex includes `\bB[0-9]\b|\bC[0-9]\b`).

### Task C7: Predicate-using-Expression integration + typed-builder rewrite — SHIPPED

Shipped across commits `d559c99f` → `6ac9afae` → `9ea7c934` → `e58bbfe7`. Phase 2 of the case-store SQL rewrite. Phase 1 (the `compileRelationPath` nested-EXISTS rewrite via Kysely's typed builder) landed under C5 SHIPPED across commits `96909fc4` → `5cc3db1d` → `75ed1ac7`; Phase 2 completes the foundation by removing every remaining `sql\`` template literal use across the three other compilers, wiring the predicate-side dispatch at every widened ValueExpression operand site, and consolidating the duplicate misuse-contract throws.

**Files:**
- `lib/case-store/sql/compileTerm.ts` (rewrite) — every `sql\`` template literal use removed (13 → 0). JSONB property reads emit via `eb.cast(eb('properties', '->>', key), cast)` (per-data-type read operator + cast threaded from `JSONB_READ_OPERATOR_FOR_DATA_TYPE` and `POSTGRES_CAST_FOR_DATA_TYPE`). Literal emission via `eb.lit(null)` for SQL `null`, `eb.cast(eb.val(value), cast)` for typed literals, `eb.val(value)` for untyped. The Phase 1 correlated scalar subquery for non-self via uses `ctx.db.selectFrom(<aliased-leaf-expr>).select(...).whereRef(<leaf>.anchor_case_id, '=', <anchor>.case_id).limit(1)` — typed builder throughout.
- `lib/case-store/sql/compileExpression.ts` (rewrite) — every `sql\`` template literal use removed (13 → 0). Two `sql.raw` escape hatches for Kysely API gaps: `sql.raw("current_date")` for the niladic `CURRENT_DATE` keyword (`eb.fn` always parens; Postgres rejects `current_date()`) and `sql.raw("interval")` for the `INTERVAL '1 <unit>'` cast type (Postgres `interval` is not in Kysely's `SIMPLE_COLUMN_DATA_TYPES`). Both citations resolve against `node_modules/kysely/dist/cjs/...`. Simple-CASE for `switch` preserved (C6 lock — discriminator evaluates ONCE) via `eb.case<unknown>(onExpr as Expression<unknown>)` typed assertion that opens the typed simple-CASE shape; per-iteration `.when(whenExpr).then(thenExpr)` accumulator widening through the loop is asserted because TS cannot enumerate per-iteration `O` widening.
- `lib/case-store/sql/compilePredicate.ts` (rewrite + dispatch wiring) — every `sql\`` template literal use removed (16 → 0). Two `sql.raw` escape hatches for `geography` PostGIS extension cast type in `compileWithinDistance` (property side at `:1127` + center side at `:1131`; same Kysely API gap as `interval`). `compileValueExprOperand(operand, ctx)` dispatch helper added; wired at all 7 widened operand sites (`compare.left`/`right`, `in.left`, `between.left`/`lower`/`upper`, `within-distance.center`, `is-null.left`, `is-blank.left`). The `expressionContextFor(ctx)` cycle-break attaches a `compilePredicate` callback to the expression context so `if` / `switch` / `count` arms can recurse into the predicate compiler without an import edge from `compileExpression` to `compilePredicate`. The duplicate "non-term ValueExpression operand" misuse-contract throws (Phase 1 SUGGESTION-1) removed — the dispatch handles all arms.
- `lib/case-store/sql/__tests__/compileTerm.test.ts` (modified) — token-shape assertions migrated from raw-SQL fragments to typed-builder fragments.
- `lib/case-store/sql/__tests__/compileExpression.test.ts` (modified) — token-shape assertions migrated; new behavioral test pins simple-CASE: `count(*)` discriminator must appear EXACTLY ONCE in the rendered SQL (a searched-CASE regression would emit it N times — once per `when` arm); also asserts `\bcase\s+when\b` regex never matches (the searched-CASE shape).
- `lib/case-store/sql/__tests__/compilePredicate.test.ts` (modified) — 7 new dispatch tests at the widened operand sites, replacing the throw-on-non-term tests; all assertions behavioral (the dispatch produces the expression's signature SQL shape).
- `lib/case-store/sql/__tests__/compileExpression.harness.test.ts` (modified) — new harness round-trip pins simple-CASE behavior end-to-end against an outer-row property discriminator (three patient rows at distinct ages drive all three switch arms).

**Operator coverage:** every C3 / C4 / C6 SHIPPED contract preserved end-to-end. The SQL shapes those sections describe still hold; only the IMPLEMENTATION strategy moved from raw `sql\`` template literals to Kysely's typed `eb.*` API. See C3 SHIPPED for term arms, C4 SHIPPED for predicate arms, C6 SHIPPED for expression arms.

**Architectural decisions:**

1. **Typed builder throughout the case-store SQL package.** ZERO `sql\`` template literal uses across the four compiler source files (`compileTerm.ts`, `compileExpression.ts`, `compilePredicate.ts`, `compileRelationPath.ts`). Every operator dispatch — JSONB reads, casts, literals, comparisons, EXISTS, count subqueries, simple/searched CASE, function calls, PostGIS spatial dispatch, pg_trgm similarity — composes through Kysely's typed `eb.*` API. The verified Kysely API surface includes `eb.cast<T>(expr, type)`, `eb.ref`, `eb.val`, `eb.lit`, `eb.fn`, `eb.case`, `eb.selectFrom`, `eb.exists`, `eb(left, op, right)`; JSONB key-existence operators (`?`, `?|`, `?&`) are in `COMPARISON_OPERATORS`; JSONB extract operators (`->`, `->>`) are in `JSON_OPERATORS`; pg_trgm `%` is in `OPERATORS` (arithmetic-classified, recovered via `.$castTo<boolean>()`). Test files retain `sql\`(values (1))\`` for tableless VALUES sources Kysely has no typed builder for; that scope is out of bounds for the source-file gate.
2. **Four documented `sql.raw` escape hatches** for verified Kysely API gaps (read against `node_modules/kysely/dist/cjs/...`):
   - `compileExpression.ts:354`: `sql.raw("current_date")` — `eb.fn` always parens via `default-query-compiler.js:visitFunction`; Postgres rejects `current_date()`.
   - `compileExpression.ts:494`: `sql.raw("interval")` — Postgres `interval` is not in Kysely's `SIMPLE_COLUMN_DATA_TYPES` per `data-type-node.js`. The `Expression<any>` overload of `eb.cast` is Kysely's documented escape hatch for extension types per `data-type-parser.js`.
   - `compilePredicate.ts:1127` and `:1131`: `sql.raw("geography")` — PostGIS `geography` extension cast type, same API gap as `interval`. Both call sites in `compileWithinDistance` (LHS property; RHS center expression).
   All four sites use closed compile-time constants; no caller-supplied input flows into raw emission.
3. **`compileValueExprOperand` dispatch shape.** Single helper at `compilePredicate.ts:403-411` routes every widened operand: `term` → `compileTerm`; non-term → `compileExpression`. Wired at 7 sites. The shape is single-source so the dispatch contract lives in one place; the earlier duplicate misuse-contract throws (Phase 1 SUGGESTION-1) consolidate into this dispatch by virtue of every non-term arm now routing through it instead of throwing.
4. **`expressionContextFor(ctx)` cycle-break helper** at `compilePredicate.ts:413-431`. Lifts `PredicateCompileContext` to `ExpressionCompileContext` by attaching a `compilePredicate` callback (which closes the `if` / `switch` / `count` arm recursion path). Named-helper form makes the cycle break + its direction visible at one named site; without the helper the wiring would bury under a spread-and-property literal at the call site.
5. **Simple-CASE for `switch` preserved (C6 lock).** `eb.case<E extends Expression<any>>(expression: E)` per `node_modules/kysely/dist/cjs/query-builder/case-builder.d.ts:8-19` accepts any `Expression<any>` discriminator, including `Expression<unknown>`. The discriminator evaluates ONCE per row — verified by the new behavioral test pinning `count(*)` substring count and the new harness round-trip executing all three switch arms against real data. The C6 SHIPPED rationale (discriminator evaluates once — important for expensive `on` shapes like `count(...)`) holds end-to-end.
6. **Type-erased local views for runtime-derived aliases.** `DynamicExprBuilder` / `DynamicCorrelatedQuery` / `DynamicCountQuery` / `DynamicExistsQuery` view types in compileTerm/compileExpression/compilePredicate surface only the methods the runtime path calls. Same pattern Phase 1 established with `DynamicQuery` / `DynamicSelection` in `compileRelationPath.ts`. The type-system limit is the bridge between statically-known column unions on `Database` and the runtime-derived `${alias}.${column}` strings the typed builder cannot enumerate; the local-only view minimises the erasure surface to exactly the methods called.

**Reviews:**

- Spec-compliance review (sonnet): ❌ COMPLIANT WITH FINDINGS on `d559c99f` + `6ac9afae`. F-1 (confidence 90): stale section-header comment at `compileExpression.test.ts:410-411` described the OLD searched-CASE shape after the simple-CASE fix-pass restored simple-CASE in code. The implementation, the describe block name, and all test assertions were correct; only the section header was stale. Resolved in fix-pass `9ea7c934`. All 10 spec invariants pass; all five verification gates pass independently.
- Supervisor pushback during initial implementation: BLOCKING-1 caught a regression where `switch` was emitted as searched-CASE (`CASE WHEN <on> = <when_1> ...`) instead of simple-CASE (`CASE <on> WHEN <when_1> ...`). The C6 SHIPPED lock requires simple-CASE so the discriminator evaluates ONCE — critical for expensive `on` shapes like `count(...)`. The implementer's "Kysely's typed simple-CASE shape requires a typed `W` discriminator the open `Expression<unknown>` cannot satisfy" rationale was wrong; verified against `node_modules/kysely/dist/cjs/query-builder/case-builder.d.ts:8-19`. Restored in fix-pass `6ac9afae`. IMPORTANT-2 (also caught during supervisor pushback): the four `sql.raw` use sites need source-of-truth citations to defend the Kysely API gap claim. Implementer documented all four sites in code with `node_modules` source paths; same fix-pass.
- Code-quality review (opus): ❌ NEEDS FIXES on `d559c99f` + `6ac9afae` + `9ea7c934`. BLOCKING-1: `compileWithinDistance` JSDoc named a phantom helper (`compileValueExprAsTerm` — does not exist; actual is `compileValueExprOperand`) AND described the OLD throw-on-non-term contract Phase 2 removed. Same comment-vs-code drift class as the F-1 / Phase-1 IMPORTANT-1 fix-passes. BLOCKING-2: test describe-block at `compilePredicate.test.ts:805` framed the removed throw as "legacy" — eternal-present voice violation. IMPORTANT-1: `expressionContextFor` JSDoc fabricated a "tests inspect this name" rationale (zero such tests exist) — narrow-rationale anti-pattern. SUGGESTION-1: duplicate literal-emission logic across `compileLiteral` (compileTerm) and `compileLiteralValue` (compilePredicate); deferred to C8's barrel-export inventory pass. All blockers + IMPORTANT resolved in fix-pass `e58bbfe7` after a proactive comment-drift sweep of the entire case-store SQL package. Three sweeps run pre-commit: (1) `rg "throw|legacy|formerly|previously|used to|now uses|now delegates|now imports|extracted from|lifted from"` — all `throw` matches are current-tense; zero drift-pattern matches. (2) `rg "compileValueExprAsTerm|expressionContextFor"` — phantom helper purged; real helper has only its declaration + one call site. (3) Cross-reference of every backtick-quoted JSDoc helper-name against the actual source-defined helper set; all 11 source-file references and 4 test-file references resolve to real definitions. Goal: this is the third comment-vs-code drift fix-pass on the branch (Phase 1 had two; Phase 2 had `9ea7c934`'s F-1); the proactive sweep aimed to make it the LAST.

**Verification gates (all green at HEAD `e58bbfe7`):**
- 2774 full-project tests pass / 14 skipped (vs 2767 pre-Phase-2 baseline at `f8105be3`; +7 net new = 7 dispatch tests + 1 simple-CASE cold + 1 simple-CASE harness round-trip - 2 throw-on-non-term tests removed).
- `npx tsc --noEmit` clean
- `npm run lint` clean (807 files; zero warnings, zero errors)
- `rg "\bsql\`" lib/case-store/sql/{compileTerm,compileExpression,compilePredicate,compileRelationPath}.ts` returns 0 matches.
- `rg "throw.*term-arm" lib/case-store/sql/` returns 0 matches.
- `rg "containsNonSelfRelationWalk|aliasDepth" lib/case-store/sql/` returns 0 matches (Phase 1 invariants preserved).
- `rg "compileValueExprAsTerm" lib/case-store/sql/` returns 0 matches (phantom helper purged).
- Strengthened eternal-present sweep on touched files: 0 hits. Sweep regex set includes the Phase-1-fix-pass-added `unmodified|backwards.compatible|forward.compatible|migration accommodation` patterns plus the proactive `legacy|formerly|previously|used to|now uses|now delegates|now imports|extracted from|lifted from` patterns added during Phase 2's `e58bbfe7` fix-pass.

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
4. **Schema seeded from spec DDL verbatim**, not introspected from the Database type. Direct DDL is structurally smaller than building an introspector; CLAUDE.md documents the three-surface (spec, Database type, harness DDL) lockstep so a schema change updates all three in step.
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

#### Post-shipped amendment 2026-05-03 — image bump + pg_jsonschema removal

The original SHIPPED bullets above are preserved as the historical record of what landed at `d223d9b9`. This amendment captures two architectural decisions that landed after the spec-compliance review and required code + spec + Plan 2 sweeps to reflect.

**1. Image bump: `postgis/postgis:16-3.4` → `imresamu/postgis:18-3.6.1-alpine3.23` (digest-pinned).**

- Cloud SQL's default Postgres major has been **18** since 2025-09-25; the prior PG-16 pin was stale.
- Cloud SQL bundles **PostGIS 3.6.0** with PG 18 (release notes 2025-10-27); the `imresamu/postgis:18-3.6.1` image is one PostGIS patch ahead of production — strictly closer than the static extensions docs page suggests (that page's PostGIS table only goes through PG 17 and shows 3.5.2).
- The official `postgis/postgis` image publishes `linux/amd64` only at every major version. The `imresamu/postgis` rebuild publishes both `amd64` and `arm64` manifests, which lets Apple Silicon dev machines run the testcontainer natively rather than under emulation. Maintainer Imre Samu is a verified `@postgis` GitHub-org member.
- Supply-chain mitigation: the harness pins by SHA-256 content digest (`@sha256:8990ec…712bac`), not by floating tag. A maintainer-account compromise can't push a malicious image into our test runs without a conscious digest bump in `globalSetup.ts`.

**2. `pg_jsonschema` architecture removed: validation moves to TypeScript only.**

- Cloud SQL **does not allowlist** `pg_jsonschema`. The original spec's "use `pg_jsonschema` if Cloud SQL allows it; PL/pgSQL fallback if not" pattern was based on an unverified premise. Production was always going to take the fallback path.
- Hand-rolling PL/pgSQL to mirror the TypeScript JSON-Schema validator's behavior creates a second validator to keep in sync — the divergence becomes the bug surface, not a defense.
- `pg_jsonschema` exists for architectures where the database is the trust boundary (Supabase, PostgREST). Nova's API routes are the trust boundary; the database is internal. The TypeScript validator at `lib/domain/predicate/jsonSchema.ts` + `ajv` runs at every write and is the single source of truth.
- Code changes: `globalSetup.ts` `OPTIONAL_EXTENSIONS` constant + probe loop deleted; `harness.test.ts` `pg_jsonschema` test deleted; `lib/case-store/CLAUDE.md` "fourth extension" paragraph rewritten to document the TS-side validator decision.
- Spec changes: § "Write-time validation" rewritten to commit to TS-side validation; verification gate at line 545 retargeted to the three required extensions; risk-mitigation entry for `pg_jsonschema` deleted.
- Plan 2 changes: file-structure tree's `triggers/` directory removed; Task 2 rewritten to drop `pg_jsonschema` and the trigger-deployment policy; Task 9 (CLAUDE.md outline) updated.

**Surfaces bullets 1130, 1139, 1142, 1147 in the original SHIPPED record are now stale on the new architecture** but are preserved verbatim as the accurate historical record at the time of `d223d9b9` review. The new state lives in this amendment block and in the touched files themselves.

### Task C8: Barrel exports + CLAUDE.md updates + literal-emission consolidation + true zero raw SQL — SHIPPED

Shipped across commits `1b35db8e` → `72baaba6` → `52e04036`. The first commit landed the initial barrels + CLAUDE.md + the deferred Phase-2 SUGGESTION-1 (literal-emission consolidation). The second was the code-quality reviewer fix-pass (drift sweep + cast-table extraction to a third sibling module + barrel-test simplification). The third eliminated all four `sql.raw(...)` escape hatches the supervisor had initially accepted as "documented Kysely API gaps" — the user's correction that the locked goal was ZERO raw SQL emission across the package, not just zero `sql\`` template literals, drove the rewrites against verified typed-builder alternatives.

**Files:**
- `lib/case-store/sql/index.ts` (new) — barrel for the case-store SQL package. Named exports for the four compiler entry points (`compileTerm`, `compileExpression`, `compilePredicate`, `compileRelationPath`), all compile-context interfaces (`TermCompileContext`, `ExpressionCompileContext`, `PredicateCompileContext`, `RelationPathCompileContext`, `CompiledRelationPath`, `RelationPathLeafRow`, `TermBindings`, `TermBindingValue`, `CompilePredicateThunk`), the per-data-type tables (`POSTGRES_CAST_FOR_DATA_TYPE`), the leaf-alias constants (`RELATION_PATH_LEAF_ALIAS`, `leafAliasForDepth`), and the Database type contract (`Database`, `CasesTable`, `CaseTypeSchemasTable`, `CaseIndicesTable`, `CaseIndexRelationship`). Internal helpers (`compileLiteral`, `compileValueExprOperand`, `expressionContextFor`, the type-erased `Dynamic*` views, `JSONB_READ_OPERATOR_FOR_DATA_TYPE`) stay package-private.
- `lib/case-store/sql/dataTypeTokens.ts` (new) — data-only sibling module owning `POSTGRES_CAST_FOR_DATA_TYPE` and `JSONB_READ_OPERATOR_FOR_DATA_TYPE`. Both `compileTerm` and `compileLiteral` import from this module independently (no circular edges between the compiler modules; the cast table is read-only data with no behavioral coupling).
- `lib/case-store/sql/compileLiteral.ts` (new) — shared literal-emission helper consumed by `compileTerm`'s `literal` arm and `compilePredicate`'s `in.values` arm. Three branches: `eb.lit(null)` for null literals (emits SQL `NULL` keyword rather than a `$N`-bound parameter), `eb.cast(eb.val(value), POSTGRES_CAST_FOR_DATA_TYPE[dataType])` for typed literals, `eb.val(value)` for untyped. Eliminates the prior duplication between `compileTerm.compileLiteral` and `compilePredicate.compileLiteralValue`.
- `lib/domain/predicate/index.ts` (new) — wholesale `export *` from the five sibling modules (`./types`, `./builders`, `./typeChecker`, `./jsonSchema`, `./reduction`). Each module curates its own surface; no name collisions.
- `lib/commcare/predicate/index.ts` and `lib/commcare/expression/index.ts` (existing from B6 / C1) — verified accurate, no changes.
- `lib/case-store/sql/CLAUDE.md` (new) — compiler-stack documentation: four-compiler composition diagram, the `compileValueExprOperand` dispatch shape, the `relationPathDepth` thread for nested-walk composition, the Postgres-strict null semantics, the tenant-scope contract (outer-query filter is the caller's responsibility; the foundation only enforces inside relation walks), and the public-surface inventory.
- `lib/domain/predicate/CLAUDE.md` (new) — two-AST-families-in-one-package architecture: Predicate + ValueExpression families share Term shapes via intra-file `z.lazy`; full operator inventory; Term family arms; RelationPath kinds; the locked Postgres-strict null/blank semantic; type-checker contract; JSON Schema generator's role; reduction module.
- `lib/case-store/CLAUDE.md` (modified) — one-line cross-reference to `sql/CLAUDE.md` and the compiler-stack files.
- `lib/case-store/sql/__tests__/_barrel-verification.test.ts` (new, 3 tests) — runtime asserts for compiler entry points, the cast table, and the leaf-alias constants; type-only `_BarrelTypeSurface` aggregating struct pins every type-only re-export at compile time; explicit assertion that `compileLiteral` and `JSONB_READ_OPERATOR_FOR_DATA_TYPE` are NOT exposed by the barrel.
- `docs/coverage/2026-05-02-foundation-coverage-matrix.md` (new) — coverage matrix as docs artifact: every spec V1-IN operator (16 Predicate union schemas / 21 distinct discriminator values once `compare`'s six comparison kinds and `match`'s four modes are split + 15 ValueExpression schemas) cited `file:line` against four compilation surfaces (type checker, on-device XPath, CSQL, Postgres compiler), plus Term family + RelationPath family tables, plus cross-arm verification gates.
- `lib/case-store/sql/compileExpression.ts` (modified by `52e04036`) — `compileToday` switched from `sql.raw("current_date")` to `eb.cast(eb.fn<Date>("now"), "date")` (Postgres documents `current_date` and `now()::date` as transaction-stable equivalents). `compileDateAdd` switched from `eb.cast(eb.val(\`1 ${unit}\`), sql.raw("interval"))` to `eb.fn("make_interval", [...zero-padded slots, quantityExpr])` per Postgres's positional `make_interval(years, months, weeks, days, hours, mins, secs)` signature.
- `lib/case-store/sql/compilePredicate.ts` (modified by `52e04036`) — `compileWithinDistance` switched both `geography` casts from `eb.cast(eb.fn("st_makepoint", [lon, lat]), sql.raw("geography"))` to a `geographyPoint(lon, lat)` helper using `ST_GeogFromText('POINT(<lon> <lat>)')` (returns geography directly, SRID 4326 default per PostGIS docs). The WKT payload composes through Postgres `concat(...)` so lon/lat numerics flow as typed-builder arguments.

**Architectural decisions:**

1. **Named exports for `lib/case-store/sql/index.ts`, wholesale `export *` for `lib/domain/predicate/index.ts`.** Per-package decision: `case-store/sql` has internal helpers (`compileLiteral`, dispatch helpers, type-erased views) that must NOT leak; named exports let the barrel curate. `domain/predicate`'s sibling modules already curate their own surfaces; wholesale re-export is mechanical and safe.
2. **`dataTypeTokens.ts` as a third sibling module** rather than exporting tables from `compileTerm.ts`. Tables are pure data; isolating them in a dedicated module breaks the implied "compileTerm owns the tables" coupling (which would have made `compileLiteral` import from `compileTerm`, creating a structurally circular edge through the lazy data access). Three modules of equal weight: `compileTerm` and `compileLiteral` import from `dataTypeTokens`; neither imports the other.
3. **`compileLiteral` as sibling module** rather than as an export from `compileTerm`. Both consumers (term-side literal arm + predicate-side `in.values` arm) treat literal emission as a leaf concern; the sibling shape lets either consumer evolve independently without touching the other.
4. **Coverage matrix as docs artifact** lives at `docs/coverage/`, separate from specs and plans. The matrix grounds the "every V1-IN operator covers four surfaces" verification gate the plan's Final-verification block requires; future drift is catchable mechanically by re-running the cited file:line checks.
5. **TRUE zero raw SQL across the case-store SQL package.** Every `sql\`...\`` template literal AND every `sql.raw(...)` function call eliminated from the four compiler source files (`compileTerm`, `compileExpression`, `compilePredicate`, `compileRelationPath`) plus the new `compileLiteral` module. The supervisor's initial framing of "ZERO `sql\`` template uses" was a goalpost shift the user corrected: `sql.raw(...)` IS raw SQL emission, just different syntax. Every Postgres expression flows through Kysely's typed builder surface (`eb.fn`, `eb.cast`, `eb()`, `eb.val`, `eb.lit`, `eb.and`, `eb.or`, `eb.not`, `eb.exists`, `eb.case()`, `eb.selectFrom`, `eb.ref`). Test files retain `sql\`(values (1))\`` for tableless VALUES sources where Kysely has no typed builder; that scope is out of bounds for the source-file gate.
6. **Three Postgres features that look like they need raw emission route through typed-builder primitives instead.** `current_date` → `eb.cast(eb.fn<Date>("now"), "date")` (Postgres-equivalent via `now()::date`). `interval` cast for `date-add` → `eb.fn("make_interval", [positional slots])` (Postgres's `make_interval` returns the typed interval directly; no cast needed). `geography` cast for `within-distance` → `eb.fn("st_geogfromtext", [<wkt>])` (PostGIS's `ST_GeogFromText` returns `geography` directly with default SRID 4326). Future compiler arms reaching for a Postgres feature outside Kysely's typed surface should follow the same pattern: identify the function-call surface that returns the typed value directly, not the cast token Kysely's `ColumnDataType` enum doesn't include.

**Reviews:**

- Spec-compliance review (sonnet): ✅ COMPLIANT on `1b35db8e`. All 10 invariants pass; all five verification gates pass independently. Coverage matrix grounded in actual code (every spot-checked cell resolves to the cited file:line). No findings ≥80 confidence.
- Code-quality review (opus): ❌ NEEDS FIXES on `1b35db8e`. BLOCKING-1: stale `compileLiteralValue` reference in `compilePredicate.ts:530-534` JSDoc (helper renamed to `compileLiteral` in the commit; JSDoc not updated — same comment-vs-code drift class as Phase 1's F-1 + Phase 2's F-1). BLOCKING-2: `lib/domain/predicate/CLAUDE.md:227` v1-punt-framing ("v1 has no operator that consumes a sequence") — verbatim match against `feedback_no_v1_punt_framing.md` strip examples; locked rule violation in freshly-authored permanent doc. IMPORTANT-1: "decoupled siblings" rationale across three new docs didn't survive the actual import graph (`compileTerm` ↔ `compileLiteral` cycle on `POSTGRES_CAST_FOR_DATA_TYPE`); the supervisor's "stress-test rationale" memory required sketching the alternative (extract the cast table to a third sibling). SUGGESTION-1: redundant `_PinX` block in barrel-verification test. All three findings (plus SUGGESTION-1) resolved in fix-pass `72baaba6` with `dataTypeTokens.ts` extraction + barrel-test simplification + JSDoc/CLAUDE.md sweep. SUGGESTION-2 (filename `_` prefix) and SUGGESTION-3 (coverage-matrix maintenance note) deferred as polish.
- Supervisor adjudication after the fix-pass: the user surfaced that the four `sql.raw` sites still violated the locked "zero raw SQL" goal; the "documented Kysely API gap" framing the supervisor had accepted was a goalpost shift relative to the original "pure typed builder throughout" claim. The supervisor verified all four sites have clean typed-builder alternatives, then dispatched the implementer for the rewrite. Commit `52e04036` eliminated all four sites: pre-commit harness probes verified `current_date == now()::date` (timezone-equivalent); `ST_DWithin(::geography, ::geography, 5000)` ≡ `ST_DWithin(ST_GeogFromText, ST_GeogFromText, 5000)` for both close-pair (true) and far-pair (false); `make_interval(...)` returns the expected `INTERVAL '7 <unit>'` value for all 7 unit arms.

**Verification gates (all green at HEAD `52e04036`):**
- 2777 full-project tests pass / 14 skipped (vs 2774 pre-C8 baseline; +3 net new = 3 barrel-verification tests; the `52e04036` rewrite cold-test assertions were updated for the new SQL emission shapes but no test count delta).
- `npx tsc --noEmit` clean
- `npm run lint` clean (812 files; zero warnings, zero errors)
- `rg "sql\.raw|\bsql\`" lib/case-store/sql/*.ts` returns 0 matches across the source files (TRUE zero raw SQL).
- `rg "containsNonSelfRelationWalk|aliasDepth|compileValueExprAsTerm" lib/case-store/sql/` returns 0 matches (Phase 1+2 invariants preserved).
- `grep -rn "TODO\|FIXME\|XXX" lib/domain/predicate lib/commcare/predicate lib/commcare/expression lib/case-store` returns empty.
- Strengthened eternal-present sweep on touched files: 0 hits.
- Coverage matrix at `docs/coverage/2026-05-02-foundation-coverage-matrix.md` documents every V1-IN operator across four compilation surfaces with file:line citations.

#### Post-shipped amendment 2026-05-03 — Elm-style error-message rewrite

The original `throw new Error(...)` sites across the foundation used terse one-line strings that named the failing function and the AST kind but offered no diagnostic structure, no actionable next step, and no consistency of voice. Audit and rewrite of all 34 error sites against the published patterns from Elm's "Compiler Errors for Humans" (Czaplicki, 2015), Rust's diagnostics guide, and Roc's friendly-diagnostics design. Three shape categories drive the rewrite (with a small helper module owning the formatting):

- **Internal bug — exhaustive switch (16 sites).** Header names the function, family, and offending kind; body lists every valid kind so the reader can spot the missing one without cross-referencing the AST type definitions; closing paragraph names the typical bypass paths (`as any`, runtime AST construction, partial discriminated-union widening) and prescribes the fix ("add the missing case to the switch in `<where>`"). Helper: `unhandledKindMessage`.
- **Internal bug — invariant violated (4 sites).** Header names the function and the negation that triggered the throw; body explains the contract that was supposed to hold and which upstream callers were supposed to enforce it. Helper: `compilerBugMessage`.
- **Type-checker bypass (10 sites).** Header names the function and the rule that was violated; body shows `expected:` / `got:` for the diagnostic facts; narrative explains that the type checker (`checkPredicate` / `checkExpression`) is the upstream gate; site-specific hint prescribes the concrete fix (register the property, route the AST through `checkPredicate`, etc.). Helper: `typeCheckerBypassMessage`.

The remaining 4 sites (between-with-no-bounds, the two caller-setup `ctx.compilePredicate` checks, the two domain-semantic fuzzy-date errors) inline with the same voice the helpers establish — each is one-of-a-kind so the helper would be over-engineered.

**Files:**
- `lib/domain/predicate/errors.ts` (new) — three formatter functions plus voice/structure documentation in the file header. Re-exported through `lib/domain/predicate/index.ts` so both the type checker (same package) and the SQL compilers (cross-package) consume one source.
- `lib/domain/predicate/__tests__/errors.test.ts` (new, 7 tests) — pin the canonical multi-section shape of each helper. The expected-text strings double as the example a future contributor reads to copy the voice for a new call site.
- `lib/case-store/sql/{compileTerm,compilePredicate,compileExpression,compileRelationPath}.ts` — every `throw new Error(...)` site rewritten to use a helper or to inline with the same voice; redundant JSDoc paragraphs above each throw trimmed once the message itself names the contract.
- `lib/domain/predicate/{typeChecker,jsonSchema}.ts` — exhaustive-switch ICEs migrated to `unhandledKindMessage`; `checkRelationPath`'s `self`-unreachable throw rewritten as a multi-section message naming the upstream short-circuit chain (`checkRelationalQuantifier`, `resolveTermType`).
- `lib/domain/predicate/CLAUDE.md` — file-map entry added for `errors.ts`.
- `lib/case-store/sql/compilePredicate.ts` — pre-existing `Plan 2`-forward-reference comment block above the fuzzy-date dynamic-value throw trimmed (per `feedback_forward_projected_in_docs_not_code` — that obligation lives in Plan 2's task list, not in foundation code).

**Verification gates:**
- 2784 full-project tests pass / 14 skipped (vs 2777 baseline; +7 net = 7 new `errors.test.ts` tests).
- All four pre-existing tests that match on error substrings (`compilePredicate.test.ts:436` `/string-typed token literals/`, `compilePredicate.test.ts:503` `/YYYY-MM-DD/`, `compileTerm.test.ts:380,386,471,491,511`, `compileExpression.test.ts:410,553,566,703`) still pass — substrings preserved across the rewrites.
- `npx tsc --noEmit` clean.
- `npm run lint` clean.



- [ ] `npm run test` — all tests green including pre-existing
- [ ] `npm run lint` — no errors, no warnings
- [ ] `grep -rn "TODO\|FIXME\|XXX" lib/domain/predicate lib/commcare/predicate lib/commcare/expression lib/case-store` — empty
- [ ] Cross-check: every operator from the spec's V1-IN list has type-checker coverage, an on-device XPath emission, a CSQL emission (via hoist + faithful emission), and a Postgres compiler emission. Build a coverage matrix as a docs artifact.

## Plan shape

Three groups of tasks. Group A extends the shipped AST + type checker; Group B supersedes the broken emitter by splitting into per-dialect visitors and adds the CSQL hoisting pass; Group C lands the Postgres compiler with testcontainers infra. Tasks within each group can run in dependency order; Groups A and B are largely additive on shipped work and can in principle interleave; Group C depends on Group A's full operator set being in place. Plan 2 picks up the Cloud SQL provisioning + extension allowlist gate against the live instance.

The implementor's 33 shipped commits cover the comparison + logical + initial special-operator coverage at the AST + type-checker layers; what's left is everything called out in the v2 corrections above.
