# Case List & Search — Foundation Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2 — supersedes v1 of this same file. v1 had a fundamental scope error (missing AST coverage for relational queries, expression family entirely absent, three wire dialects collapsed to two) that surfaced after the implementor had shipped Tasks 1–8. v2 reconciles with shipped work where possible and supersedes where the shipped emitter design is structurally wrong.

**Goal:** Build the typed Predicate AST + typed Expression AST, schema-driven type checker, JSON Schema generator, three per-dialect CommCare wire emitters, AST → Kysely compiler, and the representability checker. Ships as tested library code with no consumer yet — Plans 2–5 wire it up.

**Architecture summary** (full detail in `docs/superpowers/specs/2026-04-30-case-list-search-design.md` v2):
- Two AST families: Predicate (boolean) + Expression (value), sharing Term shapes
- Three wire targets dispatched as separate visitors: case-list filter (on-device, plain XPath 1.0 + `selected()`), CSQL (server-side ES, full extension set), post-ES search filter (on-device, same as case-list filter)
- Postgres SQL via Kysely as the runtime/preview target — full operator coverage, no losses
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
lib/domain/predicate/                    # Predicate AST family
├── types.ts                             # extended with new operators
├── builders.ts                          # extended
├── reduction.ts                         # NEW — and([]) → match-all etc.
├── jsonSchema.ts                        # unchanged
├── typeChecker.ts                       # extended
└── __tests__/

lib/domain/expression/                   # NEW — Expression AST family
├── types.ts                             # ValueExpression schemas
├── builders.ts                          # typed construction helpers
├── typeChecker.ts                       # expression type checker
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

---

## Group A — Extend the AST and type checker (additive on shipped work)

These tasks extend types.ts, builders.ts, and typeChecker.ts with operators the shipped emitter doesn't reference. No file deletions; everything appends to the discriminated union and the switch statements. The implementor is familiar with these patterns from tasks 2–6.

### Task A1: Add Predicate AST kinds for sentinels, null check, range, and relations

**Files:**
- Modify: `lib/domain/predicate/types.ts`
- Modify: `lib/domain/predicate/builders.ts`
- Test: `lib/domain/predicate/__tests__/types.test.ts`, `builders.test.ts`

New Zod schemas added to the Predicate union:

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
}).refine((v) => v.lower !== undefined || v.upper !== undefined, "between must have at least one bound");

const existsSchema = z.object({
  kind: z.literal("exists"),
  via: relationPathSchema,
  where: predicateSchema.optional(),
});
const missingSchema = z.object({
  kind: z.literal("missing"),
  via: relationPathSchema,
  where: predicateSchema.optional(),
});
```

`relationPathSchema` is added to types.ts as well (see Task A3 for its shape).

Builders:

```ts
export const matchAll = (): Predicate => ({ kind: "match-all" });
export const matchNone = (): Predicate => ({ kind: "match-none" });
export const isNull = (left: Term): Predicate => ({ kind: "is-null", left });
export const between = (left: Term, opts: { lower?: Term; upper?: Term; lowerInclusive?: boolean; upperInclusive?: boolean }): Predicate => ({ ... });
export const exists = (via: RelationPath, where?: Predicate): Predicate => ({ ... });
export const missing = (via: RelationPath, where?: Predicate): Predicate => ({ ... });
```

Tests cover round-trip parse, builder construction, refinement enforcement (between with no bounds rejected, exists/missing with invalid path rejected).

Steps:
- [ ] Write failing tests for each new schema (round-trip parse + builder construction)
- [ ] Add Zod schemas to `types.ts`, extend `predicateSchema` discriminated union
- [ ] Add to `Predicate` TS type (handle the recursive arms via the existing `z.lazy` + hand-declared-arm pattern; drift guard updates)
- [ ] Add builders to `builders.ts`
- [ ] Run tests, commit

### Task A2: Add Predicate AST kinds for multi-select-contains and match (text-match modes)

**Files:** same as A1.

`multi-select-contains` and `match` replace the v1 plan's separate `selected` / `selected-any` / `selected-all` operators (which v1 also missed) and the v1 plan's `fuzzy` operator (which the implementor shipped under that name).

```ts
const multiSelectContainsSchema = z.object({
  kind: z.literal("multi-select-contains"),
  property: propertyRefSchema,
  values: z.array(literalSchema).min(1),
  quantifier: z.enum(["any", "all"]),
});

const matchSchema = z.object({
  kind: z.literal("match"),
  property: propertyRefSchema,
  value: z.string().min(1),
  mode: z.enum(["fuzzy", "phonetic", "fuzzy-date", "starts-with"]),
});
```

The shipped `fuzzy` schema is **replaced directly** by `match(prop, val, mode: "fuzzy")` — no deprecation alias, no migration helper. The shipped AST has not been persisted in production, so there is no migration debt. Sweep the typeChecker, builders, tests, and emitter call sites in one change.

The shipped typeChecker's allow-list for `fuzzy` (currently `text` / `single_select` / `multi_select` per `FUZZY_PROPERTY_TYPES` at the shipped `lib/domain/predicate/typeChecker.ts:162-167`, with rationale citing `commcare-hq/.../xpath_functions/query_functions.py:46-51` where `_selected_query` dispatches all three through `case_property_query`) is the **correct** allow-list and survives unchanged. The new `match` operator inherits this allow-list across all four modes (`fuzzy`, `phonetic`, `fuzzy-date`, `starts-with`). Do not narrow it to `text` only.

Builders:

```ts
export const matches = (property: PropertyRef, value: string, mode: MatchMode): Predicate => ({ ... });
export const multiSelectAny = (property: PropertyRef, values: Literal[]): Predicate => ({ ... });
export const multiSelectAll = (property: PropertyRef, values: Literal[]): Predicate => ({ ... });
```

Tests cover construction + round-trip.

Steps:
- [ ] Write failing tests for `multi-select-contains` + `match` schemas
- [ ] Add schemas, extend union, update Predicate type
- [ ] Add builders
- [ ] Replace shipped `fuzzy` schema directly with `match` (rewrite call sites in tests + emitter; delete `fuzzy` schema)
- [ ] Run tests, commit

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

### Task A4: Add Term split — session-context separated from session-user

**Files:** `lib/domain/predicate/types.ts`, builders.ts, tests.

The shipped `userContextRefSchema` conflates `instance('commcaresession')/session/user/data/<field>` (custom user data) and `instance('commcaresession')/session/context/<field>` (predefined session context fields like `userid`, `username`). They're different wire targets with different valid field sets.

Split into two:
```ts
const SESSION_CONTEXT_FIELDS = ["userid", "username", "appid", "domain", "device_id"] as const;

const sessionUserSchema = z.object({
  kind: z.literal("session-user"),
  field: z.string().regex(XML_ELEMENT_NAME_PATTERN),
});
const sessionContextSchema = z.object({
  kind: z.literal("session-context"),
  field: z.enum(SESSION_CONTEXT_FIELDS),
});
```

Migration helper rewrites `{ kind: "user", field: "userid" }` → `{ kind: "session-context", field: "userid" }` and `{ kind: "user", field: "<other>" }` → `{ kind: "session-user", field: "<other>" }`.

Builders:
```ts
export const sessionUser = (field: string): UserContextRef => ({ ... });
export const sessionContext = (field: SessionContextField): SessionContextRef => ({ ... });
```

Steps:
- [ ] Write failing tests
- [ ] Add both schemas; remove shipped `userContextRefSchema`
- [ ] Migration helper
- [ ] Update existing `userField` builder uses to either `sessionUser` or `sessionContext`
- [ ] Update type-checker term-resolution arm
- [ ] Run tests, commit

### Task A5: Type-checker rules for new Predicate operators

**Files:** `lib/domain/predicate/typeChecker.ts`, tests.

Per-operator rules:
- `match-all` / `match-none` — always check `ok: true`.
- `is-null` — `left` must be a property or input ref (not a literal — `is-null(literal(...))` is meaningless).
- `between` — `left` and any provided bounds must be ordered types (int/decimal/date/datetime/time); types must agree.
- `exists` / `missing` — `via` is type-checked against the case-type schema; `where` (if present) is type-checked recursively in the destination scope (resolved via `via`).
- `multi-select-contains` — `property` must be `multi_select`-typed; values must be members of the option set if declared.
- `match` — `property` must be a text-shaped type. The allow-list is `text` / `single_select` / `multi_select` (the same set as `FUZZY_PROPERTY_TYPES` in the shipped `typeChecker.ts:162-167`, and the same set CCHQ's `case_property_query` accepts at `commcare-hq/.../xpath_functions/query_functions.py:46-51`). All four modes (`fuzzy`, `phonetic`, `fuzzy-date`, `starts-with`) share this allow-list. Do not narrow.
- `compare` (existing, but extended) — operands resolved via the new `via` slot on `case-property`.

Steps:
- [ ] Write failing tests for each new operator's rule
- [ ] Extend `walk` switch in `typeChecker.ts` with new arms
- [ ] Add helper `checkRelationPath(path, ctx)` that resolves the destination case type and feeds back into Term resolution
- [ ] Add helper `checkInDestinationScope(predicate, destinationCaseType, ctx)` for `exists`/`missing` filter checking
- [ ] Run tests, commit

### Task A6: Expression AST — types, builders, type checker

**Files:**
- Create: `lib/domain/expression/types.ts`
- Create: `lib/domain/expression/builders.ts`
- Create: `lib/domain/expression/typeChecker.ts`
- Test: `lib/domain/expression/__tests__/`

Schemas for the Expression family per the spec — `today`, `now`, `date-add`, `date-coerce`, `datetime-coerce`, `double`, `arith`, `concat`, `coalesce`, `if`, `switch`, `count`, `unwrap-list`, `format-date`, plus the `term` lifter.

Type-checker rules:
- `today` returns `date`; `now` returns `datetime`.
- `date-add` returns the same type as `date` (date or datetime); `quantity` must be int.
- `date-coerce` / `datetime-coerce` accept text and return date/datetime.
- `double` accepts any term; returns decimal.
- `arith` operands must be numeric; result type follows int×int=int, mixed=decimal.
- `concat` parts cast to text; result is text.
- `coalesce` values must agree on type (after empty-string-coerce-to-null); result is the agreed type. Empty `values` array is rejected.
- `if`: cond is Predicate, then/else types must agree.
- `switch`: on is value; cases.when literals match `on`'s type; cases.then types must agree with each other and with fallback.
- `count` returns int.
- `unwrap-list` accepts text; returns a sequence type. The sequence type is V1's only sequence-producing operator; downstream operators that consume it (currently only `multi-select-contains` via the CSQL emitter's `selected-any(prop, unwrap-list(...))` pattern) must accept it.
- `format-date` accepts date/datetime; returns text.

Steps per sub-section:
- [ ] Write failing tests for ValueExpression construction + round-trip
- [ ] Build `types.ts` Zod schemas with `z.lazy` + hand-declared arms for recursive shapes
- [ ] Build `builders.ts`
- [ ] Build `typeChecker.ts`
- [ ] Run tests, commit per sub-section

### Task A7: Reduction module

**Files:**
- Create: `lib/domain/predicate/reduction.ts`
- Test: `lib/domain/predicate/__tests__/reduction.test.ts`

Construction-time reductions:
- `and([])` → `match-all`
- `or([])` → `match-none`
- `and([x])` → `x`
- `or([x])` → `x`
- `not(match-all)` → `match-none`
- `not(match-none)` → `match-all`
- `not(not(x))` → `x`

Builders use the reductions internally so authors who construct empty conjunctions get the sentinel rather than a schema error.

Steps:
- [ ] Write failing tests for each reduction
- [ ] Implement
- [ ] Wire reductions into builders
- [ ] Run tests, commit

---

## Group B — Supersede the broken emitter (split into per-dialect visitors)

These tasks delete `lib/commcare/predicate/xpathEmitter.ts` and replace it with three per-dialect emitters. The shipped CCHQ source citations and the per-context string-escape strategy migrate into shared helpers.

### Task B1: Extract shared quoting helpers

**Files:**
- Create: `lib/commcare/predicate/stringQuoting.ts`
- Test: `__tests__/stringQuoting.test.ts`

Move out of the shipped xpathEmitter:
- `quoteLiteral(value, dialect: "case-list-filter" | "csql" | "search-filter")` — handles the per-dialect string-escape strategy (concat-fallback for case-list-filter; quote-style switching for CSQL).
- `quoteIdentifier(name)` — pass-through (identifiers are already validated upstream); kept for boundary clarity.
- `formatNumeric(value)` — non-scientific numeric literal output (already shipped; extract verbatim).

Steps:
- [ ] Write failing tests covering each per-dialect quoting case (matching shipped emitter's existing tests for backward compat)
- [ ] Extract helpers from shipped `xpathEmitter.ts`
- [ ] Run tests, commit

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

**Unrepresentable on case-list-filter target:**
- `match` mode∈{fuzzy, phonetic, fuzzy-date} — CSQL-only; no on-device equivalent.
- `within-distance` — CSQL-only.
- `date-add` value expression — `date-add` is **not** in `commcare-core/.../parser/ast/ASTNodeFunctionCall.java:113-269`'s on-device dispatcher (it falls through to `XPathCustomRuntimeFunc`, and the case-list-filter context registers no handler for it). Date arithmetic with day-only intervals can be emitted as XPath operator arithmetic (`date(prop) + days`); month/year arithmetic is unrepresentable on-device.

**Unrepresentable on CSQL target:**
- `if` / `switch` / `arith` / `concat` value expressions appearing inside a position the hoisting pass cannot lift (e.g., inside `subcase-exists`'s filter argument). The hoisting pass produces a representability error in this case.
- `count(...)` value expression outside a top-level binary comparison — `subcase-count` is recognized in CSQL only as the LHS of a comparison (`commcare-hq/.../filter_dsl.py:89-95`); standalone `count(...)` has no value-context home.

**Unrepresentable on search-filter target:** same set as case-list-filter (the post-ES dialect mirrors on-device).

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

### Task C2-pre: Cloud SQL extension allowlist gate (verification)

**Files:**
- Create: `scripts/verify-cloud-sql-extensions.ts`
- Document: `docs/superpowers/specs/2026-04-30-case-list-search-design.md` "Open verification gates" section

Before any case-store code touches the trigger contract, verify whether `pg_jsonschema` is on Cloud SQL's extension allowlist. The script connects to the staging Cloud SQL instance, runs `SELECT * FROM pg_available_extensions WHERE name = 'pg_jsonschema'`, and reports the result. PostGIS, pg_trgm, fuzzystrmatch are also checked (used by the Postgres compiler).

If `pg_jsonschema` is unavailable, the trigger implementation in Plan 2 falls back to a PL/pgSQL validator that calls a JSON-Schema-validation library compiled to PL/pgSQL (or a from-scratch PL/pgSQL implementation of the subset we use). The architecture is identical from the application's perspective; the choice is recorded in this gate's output.

Steps:
- [ ] Write the verification script
- [ ] Run against staging; record the output in a sibling file `docs/superpowers/specs/cloud-sql-extension-availability.md`
- [ ] If `pg_jsonschema` unavailable: schedule a Plan 2 task addendum for the PL/pgSQL fallback implementation
- [ ] Commit script + output


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

Some Predicates take Term operands that may be Expression-lifted (`compare(prop, value-expression(today()), gt)`). The Term compiler delegates to the Expression compiler for `value-expression` term variants.

Steps:
- [ ] Write failing tests covering Predicates that contain ValueExpressions
- [ ] Wire delegation through compileTerm
- [ ] Run tests, commit

### Task C7.5: Postgres test infrastructure

**Files:**
- `package.json` — add `@testcontainers/postgresql` dev dependency
- Create: `lib/case-store/sql/__tests__/setup.ts` — testcontainers boot + extension install + schema bootstrap
- Test: validate the harness boots a container, installs `pg_trgm` / `fuzzystrmatch` / `postgis` (and `pg_jsonschema` if the C2-pre gate confirmed availability), seeds the schema from the JSON Schema generator, and accepts a smoke `INSERT` + `SELECT` round-trip.

Plan 1 introduces this infrastructure (rather than Plan 2) because Plan 1 needs to validate the AST → Kysely compiler against a real Postgres at unit-test time. Plan 2 Task 9 inherits this harness for cross-implementation parity tests; without it Plan 2 Task 9's stated 1-day estimate would balloon by the missing infra cost.

Steps:
- [ ] Install `@testcontainers/postgresql`
- [ ] Implement boot helper that builds the container, runs the schema, returns a Kysely instance
- [ ] Test: container boots, extensions present, schema bootstrapped, smoke round-trip succeeds
- [ ] Run tests, commit

### Task C8: Barrel exports + CLAUDE.md updates

**Files:**
- `lib/domain/predicate/index.ts`, `lib/domain/expression/index.ts`, `lib/commcare/predicate/index.ts`, `lib/commcare/expression/index.ts`, `lib/case-store/sql/index.ts`
- `lib/domain/predicate/CLAUDE.md` (update) + new `lib/domain/expression/CLAUDE.md`

Steps:
- [ ] Write barrels
- [ ] Update CLAUDE.md to reflect the dual AST architecture
- [ ] Run full test suite
- [ ] Commit

---

## Final verification

- [ ] `npm run test` — all tests green including pre-existing
- [ ] `npm run lint` — no errors, no warnings
- [ ] `grep -rn "TODO\|FIXME\|XXX" lib/domain/predicate lib/domain/expression lib/commcare/predicate lib/commcare/expression lib/case-store` — empty
- [ ] Cross-check: every operator from the spec's V1-IN list has type-checker, three wire emitters (where representable), and Postgres compiler coverage. Build a coverage matrix as a docs artifact.
- [ ] Cross-check: every issue in `representability.ts` traces back to a tested case in the wire emitter throw-or-skip behavior.

## Plan shape

Three groups of tasks. Group A extends the shipped AST + type checker; Group B supersedes the broken emitter by splitting into per-dialect visitors and adds the CSQL hoisting pass; Group C lands the Postgres compiler with testcontainers infra and the Cloud SQL extension allowlist gate. Tasks within each group can run in dependency order; Groups A and B are largely additive on shipped work and can in principle interleave; Group C depends on Group A's full operator set being in place.

The implementor's 33 shipped commits cover the comparison + logical + initial special-operator coverage at the AST + type-checker layers; what's left is everything called out in the v2 corrections above.
