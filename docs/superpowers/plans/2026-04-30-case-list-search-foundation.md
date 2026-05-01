# Case List & Search — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the typed predicate AST, schema-driven type checker, JSON Schema generator, AST → CommCare XPath/CSQL compiler, and AST → Kysely SQL compiler that the case-list and case-search system depends on. Ships as tested library code with no consumer yet — Plans 2–5 wire it up.

**Architecture:** A single discriminated-union AST stored as Zod schemas. Three derived artifacts: a JSON Schema generator from the blueprint's `CaseType.properties[].data_type` (write-side enforcement, used in Plan 2), a schema-aware type checker (author-time validation), and two compilers — one to CommCare XPath/CSQL for HQ wire emission, one to Kysely query-builder calls for runtime execution. The AST is the source of truth; strings only exist at emission boundaries. See `docs/superpowers/specs/2026-04-30-case-list-search-design.md` for the full design.

**Tech Stack:** TypeScript (strict), Zod (AST validation), Vitest (tests), Kysely (typed SQL builder, new dependency), the existing CommCare XPath emission patterns under `lib/commcare/`.

---

## File Structure

**New package: `lib/domain/predicate/`** — owns the AST and its derivatives (type checker, JSON Schema generation). Lives under `lib/domain/` because the AST is part of the doc shape (will be persisted in Firestore inside module config in Plan 3).

```
lib/domain/predicate/
├── types.ts              — Zod-discriminated AST schemas + inferred TS types
├── builders.ts           — typed construction helpers (prop, input, eq, gt, and, or, etc.)
├── typeChecker.ts        — checkPredicate(p, ctx) → Ok | Err
├── jsonSchema.ts         — caseTypeToJsonSchema(caseType) → JSON Schema
├── index.ts              — barrel
└── __tests__/
    ├── builders.test.ts
    ├── typeChecker.test.ts
    └── jsonSchema.test.ts
```

**New package: `lib/commcare/predicate/`** — the AST → CommCare XPath/CSQL emitter. Lives under `lib/commcare/` because it speaks CommCare's wire vocabulary (the existing one-way emission boundary).

```
lib/commcare/predicate/
├── xpathEmitter.ts       — emitXPath(p, ctx) → string
├── index.ts              — barrel
└── __tests__/
    └── xpathEmitter.test.ts
```

**New package: `lib/case-store/sql/`** — the AST → Kysely emitter and the typed `Database` shape Kysely needs. Lives under a new `lib/case-store/` because it owns the case-store interface (Plan 2 implements `InMemoryCaseStore` here; the Postgres deploy spec adds `PostgresCaseStore`).

```
lib/case-store/
└── sql/
    ├── database.ts          — Kysely `Database` type definitions for cases / case_type_schemas / case_indices
    ├── predicateCompiler.ts — compileToKysely(p, ctx) → Kysely query node
    ├── index.ts             — barrel
    └── __tests__/
        └── predicateCompiler.test.ts
```

**Modified files:**
- `lib/domain/index.ts` — re-export the predicate barrel
- `package.json` — add `kysely` dependency
- `lib/domain/predicate/CLAUDE.md` — new doc file explaining the AST contract

---

## Operator coverage in this plan

The AST includes these operators. Each gets type-checker, XPath emitter, and SQL compiler coverage.

- Comparison: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`
- Membership: `in`
- Logical: `and`, `or`, `not`
- Geo: `within-distance`
- Phonetic/fuzzy: `fuzzy`
- Conditional input handling: `when-input-present`

Terms (right-hand sides):
- `prop` — case property reference
- `input` — search input reference
- `user` — session user-data field
- `literal` — primitive value

---

## Task 1: AST type definitions (Zod discriminated unions)

**Files:**
- Create: `lib/domain/predicate/types.ts`
- Test: `lib/domain/predicate/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test for term parsing**

```ts
// lib/domain/predicate/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import { termSchema, predicateSchema } from "../types";

describe("term schema", () => {
  it("parses a property reference", () => {
    const result = termSchema.parse({
      kind: "prop",
      caseType: "patient",
      property: "age",
    });
    expect(result.kind).toBe("prop");
  });

  it("parses a literal", () => {
    expect(termSchema.parse({ kind: "literal", value: 42 })).toEqual({
      kind: "literal",
      value: 42,
    });
  });

  it("rejects an unknown term kind", () => {
    expect(() => termSchema.parse({ kind: "bogus" })).toThrow();
  });
});

describe("predicate schema", () => {
  it("parses a nested and/eq predicate", () => {
    const result = predicateSchema.parse({
      kind: "and",
      clauses: [
        {
          kind: "eq",
          left: { kind: "prop", caseType: "patient", property: "status" },
          right: { kind: "literal", value: "open" },
        },
        {
          kind: "gt",
          left: { kind: "prop", caseType: "patient", property: "age" },
          right: { kind: "literal", value: 18 },
        },
      ],
    });
    expect(result.kind).toBe("and");
  });

  it("parses a within-distance predicate", () => {
    const result = predicateSchema.parse({
      kind: "within-distance",
      property: { kind: "prop", caseType: "clinic", property: "location" },
      center: { kind: "input", name: "user_location" },
      distance: 50,
      unit: "miles",
    });
    expect(result.kind).toBe("within-distance");
  });

  it("rejects an ill-formed predicate (eq missing right)", () => {
    expect(() =>
      predicateSchema.parse({
        kind: "eq",
        left: { kind: "prop", caseType: "patient", property: "age" },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/domain/predicate/__tests__/types.test.ts`
Expected: FAIL with "Cannot find module '../types'"

- [ ] **Step 3: Write the AST schemas**

```ts
// lib/domain/predicate/types.ts
//
// Predicate AST. Source of truth for every filter, sort key, calculated
// column, search input default, and default search filter in the case-list
// and search system. Compiled to CommCare XPath/CSQL at HQ wire emission
// and to Kysely query-builder calls at runtime — never round-tripped
// through strings.
//
// The AST uses Zod-discriminated unions on a `kind` field (matching Nova's
// existing patterns: `fieldSchema`, `Mutation` types). Operators are
// explicit additions to the union; new behavior is never added by
// overloading existing kinds with hidden state.

import { z } from "zod";

// ---------- Terms (anything that resolves to a value) ----------

export const propertyRefSchema = z.object({
  kind: z.literal("prop"),
  caseType: z.string(),
  property: z.string(),
});
export type PropertyRef = z.infer<typeof propertyRefSchema>;

export const searchInputRefSchema = z.object({
  kind: z.literal("input"),
  name: z.string(),
});
export type SearchInputRef = z.infer<typeof searchInputRefSchema>;

export const userContextRefSchema = z.object({
  kind: z.literal("user"),
  field: z.string(),
});
export type UserContextRef = z.infer<typeof userContextRefSchema>;

export const literalSchema = z.object({
  kind: z.literal("literal"),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
export type Literal = z.infer<typeof literalSchema>;

export const termSchema = z.discriminatedUnion("kind", [
  propertyRefSchema,
  searchInputRefSchema,
  userContextRefSchema,
  literalSchema,
]);
export type Term = z.infer<typeof termSchema>;

// ---------- Predicate kinds (anything that resolves to a boolean) ----------

const COMPARISON_KINDS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];

const comparisonSchema = z.object({
  kind: z.enum(COMPARISON_KINDS),
  left: termSchema,
  right: termSchema,
});

const inSchema = z.object({
  kind: z.literal("in"),
  left: termSchema,
  values: z.array(literalSchema),
});

const withinDistanceSchema = z.object({
  kind: z.literal("within-distance"),
  property: propertyRefSchema,
  center: termSchema,
  distance: z.number(),
  unit: z.enum(["miles", "kilometers"]),
});

const fuzzySchema = z.object({
  kind: z.literal("fuzzy"),
  property: propertyRefSchema,
  value: z.string(),
});

// Recursive shapes use z.lazy(). The TS recursive type is declared below
// the schemas so the lazy callbacks can reference predicateSchema at use.

export type Predicate =
  | z.infer<typeof comparisonSchema>
  | z.infer<typeof inSchema>
  | z.infer<typeof withinDistanceSchema>
  | z.infer<typeof fuzzySchema>
  | { kind: "and"; clauses: Predicate[] }
  | { kind: "or"; clauses: Predicate[] }
  | { kind: "not"; clause: Predicate }
  | { kind: "when-input-present"; input: SearchInputRef; then: Predicate };

const andSchema: z.ZodType<Extract<Predicate, { kind: "and" }>> = z.lazy(() =>
  z.object({
    kind: z.literal("and"),
    clauses: z.array(predicateSchema),
  }),
);

const orSchema: z.ZodType<Extract<Predicate, { kind: "or" }>> = z.lazy(() =>
  z.object({
    kind: z.literal("or"),
    clauses: z.array(predicateSchema),
  }),
);

const notSchema: z.ZodType<Extract<Predicate, { kind: "not" }>> = z.lazy(() =>
  z.object({
    kind: z.literal("not"),
    clause: predicateSchema,
  }),
);

const whenInputPresentSchema: z.ZodType<
  Extract<Predicate, { kind: "when-input-present" }>
> = z.lazy(() =>
  z.object({
    kind: z.literal("when-input-present"),
    input: searchInputRefSchema,
    then: predicateSchema,
  }),
);

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    comparisonSchema,
    inSchema,
    withinDistanceSchema,
    fuzzySchema,
    andSchema,
    orSchema,
    notSchema,
    whenInputPresentSchema,
  ]),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/domain/predicate/__tests__/types.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/predicate/types.ts lib/domain/predicate/__tests__/types.test.ts
git commit -m "feat(predicate): add typed AST schema for case-list and search predicates"
```

---

## Task 2: AST construction builders

**Files:**
- Create: `lib/domain/predicate/builders.ts`
- Test: `lib/domain/predicate/__tests__/builders.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/domain/predicate/__tests__/builders.test.ts
import { describe, it, expect } from "vitest";
import { and, eq, gt, input, prop, literal, within, fuzzy, whenInput, not, or } from "../builders";
import { predicateSchema } from "../types";

describe("predicate builders", () => {
  it("constructs an eq comparison via builders", () => {
    const p = eq(prop("patient", "status"), literal("open"));
    expect(p.kind).toBe("eq");
    // The resulting AST must round-trip through Zod parse.
    expect(predicateSchema.parse(p)).toEqual(p);
  });

  it("constructs a nested and(eq, gt) predicate", () => {
    const p = and(
      eq(prop("patient", "status"), literal("open")),
      gt(prop("patient", "age"), literal(18)),
    );
    expect(p.kind).toBe("and");
    expect(p.clauses).toHaveLength(2);
    expect(predicateSchema.parse(p)).toEqual(p);
  });

  it("constructs a within-distance predicate", () => {
    const p = within(
      prop("clinic", "location"),
      input("user_location"),
      50,
      "miles",
    );
    expect(p.kind).toBe("within-distance");
    expect(p.unit).toBe("miles");
    expect(predicateSchema.parse(p)).toEqual(p);
  });

  it("constructs when-input-present wrapping an eq", () => {
    const p = whenInput(
      input("phone_number"),
      eq(prop("patient", "phone"), input("phone_number")),
    );
    expect(p.kind).toBe("when-input-present");
    expect(p.then.kind).toBe("eq");
    expect(predicateSchema.parse(p)).toEqual(p);
  });

  it("constructs or(not(...), fuzzy(...))", () => {
    const p = or(
      not(eq(prop("patient", "status"), literal("closed"))),
      fuzzy(prop("patient", "name"), "alice"),
    );
    expect(p.kind).toBe("or");
    expect(p.clauses[0].kind).toBe("not");
    expect(p.clauses[1].kind).toBe("fuzzy");
    expect(predicateSchema.parse(p)).toEqual(p);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/domain/predicate/__tests__/builders.test.ts`
Expected: FAIL with "Cannot find module '../builders'"

- [ ] **Step 3: Write the builders**

```ts
// lib/domain/predicate/builders.ts
//
// Typed construction helpers for predicate ASTs. Engineers and the SA agent
// build predicates by calling these — never by composing AST objects by
// hand. Each builder returns a typed AST node that is, by construction,
// parseable by predicateSchema.

import type {
  ComparisonKind,
  Literal,
  Predicate,
  PropertyRef,
  SearchInputRef,
  Term,
  UserContextRef,
} from "./types";

// ---------- Term builders ----------

export function prop(caseType: string, property: string): PropertyRef {
  return { kind: "prop", caseType, property };
}

export function input(name: string): SearchInputRef {
  return { kind: "input", name };
}

export function userField(field: string): UserContextRef {
  return { kind: "user", field };
}

export function literal(value: string | number | boolean | null): Literal {
  return { kind: "literal", value };
}

// ---------- Comparison builders ----------

const comparison =
  (kind: ComparisonKind) =>
  (left: Term, right: Term): Predicate => ({ kind, left, right });

export const eq = comparison("eq");
export const neq = comparison("neq");
export const gt = comparison("gt");
export const gte = comparison("gte");
export const lt = comparison("lt");
export const lte = comparison("lte");

// ---------- Membership ----------

export function isIn(left: Term, values: Literal[]): Predicate {
  return { kind: "in", left, values };
}

// ---------- Logical ----------

export function and(...clauses: Predicate[]): Predicate {
  return { kind: "and", clauses };
}

export function or(...clauses: Predicate[]): Predicate {
  return { kind: "or", clauses };
}

export function not(clause: Predicate): Predicate {
  return { kind: "not", clause };
}

// ---------- Geo / fuzzy / conditional ----------

export function within(
  property: PropertyRef,
  center: Term,
  distance: number,
  unit: "miles" | "kilometers",
): Predicate {
  return { kind: "within-distance", property, center, distance, unit };
}

export function fuzzy(property: PropertyRef, value: string): Predicate {
  return { kind: "fuzzy", property, value };
}

export function whenInput(
  inputRef: SearchInputRef,
  then: Predicate,
): Predicate {
  return { kind: "when-input-present", input: inputRef, then };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/domain/predicate/__tests__/builders.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/predicate/builders.ts lib/domain/predicate/__tests__/builders.test.ts
git commit -m "feat(predicate): add typed AST construction builders"
```

---

## Task 3: JSON Schema generator from CaseType

**Files:**
- Create: `lib/domain/predicate/jsonSchema.ts`
- Test: `lib/domain/predicate/__tests__/jsonSchema.test.ts`

The blueprint's `CaseType.properties[].data_type` is canonical. This task derives a JSON Schema for write-side validation in the case database (consumed in Plan 2 by the in-memory `CaseStore` and later by the Postgres trigger). Mapping per `data_type`:

- `text` → `{ type: "string" }`
- `int` → `{ type: "integer" }`
- `decimal` → `{ type: "number" }`
- `date` → `{ type: "string", format: "date" }`
- `time` → `{ type: "string", format: "time" }`
- `datetime` → `{ type: "string", format: "date-time" }`
- `single_select` → `{ type: "string", enum: [<option values>] }`
- `multi_select` → `{ type: "array", items: { type: "string", enum: [<option values>] } }`
- `geopoint` → `{ type: "string", pattern: "^-?\\d+\\.?\\d*\\s-?\\d+\\.?\\d*$" }` (CommCare wire format: `"lat lon"`)
- Property without a `data_type` → `{ type: "string" }` (default to text per existing `caseProperty.data_type.optional()` behavior in `lib/domain/blueprint.ts:33`)

- [ ] **Step 1: Write the failing test**

```ts
// lib/domain/predicate/__tests__/jsonSchema.test.ts
import { describe, it, expect } from "vitest";
import type { CaseType } from "@/lib/domain";
import { caseTypeToJsonSchema } from "../jsonSchema";

describe("caseTypeToJsonSchema", () => {
  it("maps a text property", () => {
    const ct: CaseType = {
      name: "patient",
      properties: [{ name: "name", label: "Name", data_type: "text" }],
    };
    expect(caseTypeToJsonSchema(ct)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      additionalProperties: false,
    });
  });

  it("maps int / decimal / date / datetime", () => {
    const ct: CaseType = {
      name: "patient",
      properties: [
        { name: "age", label: "Age", data_type: "int" },
        { name: "bmi", label: "BMI", data_type: "decimal" },
        { name: "dob", label: "DOB", data_type: "date" },
        { name: "registered_at", label: "When", data_type: "datetime" },
      ],
    };
    const schema = caseTypeToJsonSchema(ct);
    expect(schema.properties.age).toEqual({ type: "integer" });
    expect(schema.properties.bmi).toEqual({ type: "number" });
    expect(schema.properties.dob).toEqual({ type: "string", format: "date" });
    expect(schema.properties.registered_at).toEqual({
      type: "string",
      format: "date-time",
    });
  });

  it("maps single_select with options to an enum", () => {
    const ct: CaseType = {
      name: "patient",
      properties: [
        {
          name: "status",
          label: "Status",
          data_type: "single_select",
          options: [
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ],
        },
      ],
    };
    expect(caseTypeToJsonSchema(ct).properties.status).toEqual({
      type: "string",
      enum: ["open", "closed"],
    });
  });

  it("maps multi_select to an array of enum-restricted strings", () => {
    const ct: CaseType = {
      name: "patient",
      properties: [
        {
          name: "languages",
          label: "Languages",
          data_type: "multi_select",
          options: [
            { value: "en", label: "English" },
            { value: "fr", label: "French" },
          ],
        },
      ],
    };
    expect(caseTypeToJsonSchema(ct).properties.languages).toEqual({
      type: "array",
      items: { type: "string", enum: ["en", "fr"] },
    });
  });

  it("maps geopoint to a string with the CommCare pattern", () => {
    const ct: CaseType = {
      name: "clinic",
      properties: [
        { name: "location", label: "Loc", data_type: "geopoint" },
      ],
    };
    expect(caseTypeToJsonSchema(ct).properties.location).toEqual({
      type: "string",
      pattern: "^-?\\d+\\.?\\d*\\s-?\\d+\\.?\\d*$",
    });
  });

  it("defaults a property without data_type to string", () => {
    const ct: CaseType = {
      name: "patient",
      properties: [{ name: "notes", label: "Notes" }],
    };
    expect(caseTypeToJsonSchema(ct).properties.notes).toEqual({
      type: "string",
    });
  });

  it("forbids unknown properties via additionalProperties:false", () => {
    const ct: CaseType = {
      name: "patient",
      properties: [{ name: "name", label: "Name", data_type: "text" }],
    };
    expect(caseTypeToJsonSchema(ct).additionalProperties).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/domain/predicate/__tests__/jsonSchema.test.ts`
Expected: FAIL with "Cannot find module '../jsonSchema'"

- [ ] **Step 3: Write the generator**

```ts
// lib/domain/predicate/jsonSchema.ts
//
// Generate a JSON Schema document from a CaseType definition. The blueprint's
// CaseType.properties[].data_type is the source of truth for property types;
// this module transforms it into the JSON Schema that the case database uses
// for write-side validation. Bad writes are rejected at the database boundary;
// reads can rely on values matching their declared types without runtime
// coercion.

import type { CaseProperty, CaseType } from "@/lib/domain";

// CommCare's geopoint wire format: "lat lon" (space-separated decimals).
// A negative number, optional decimal, whitespace, then another. Reused at
// the write-side validator and matches the runtime expectation of XForm's
// geopoint binding.
const GEOPOINT_PATTERN = "^-?\\d+\\.?\\d*\\s-?\\d+\\.?\\d*$";

export type JsonSchema = {
  type: "object";
  properties: Record<string, PropertySchema>;
  additionalProperties: false;
};

type PropertySchema =
  | { type: "string"; format?: string; enum?: string[]; pattern?: string }
  | { type: "integer" }
  | { type: "number" }
  | { type: "array"; items: { type: "string"; enum?: string[] } };

export function caseTypeToJsonSchema(caseType: CaseType): JsonSchema {
  const properties: Record<string, PropertySchema> = {};
  for (const prop of caseType.properties) {
    properties[prop.name] = propertyToSchema(prop);
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

function propertyToSchema(prop: CaseProperty): PropertySchema {
  switch (prop.data_type) {
    case undefined:
    case "text":
      return { type: "string" };
    case "int":
      return { type: "integer" };
    case "decimal":
      return { type: "number" };
    case "date":
      return { type: "string", format: "date" };
    case "time":
      return { type: "string", format: "time" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "single_select":
      return {
        type: "string",
        enum: (prop.options ?? []).map((o) => o.value),
      };
    case "multi_select":
      return {
        type: "array",
        items: {
          type: "string",
          enum: (prop.options ?? []).map((o) => o.value),
        },
      };
    case "geopoint":
      return { type: "string", pattern: GEOPOINT_PATTERN };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/domain/predicate/__tests__/jsonSchema.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/predicate/jsonSchema.ts lib/domain/predicate/__tests__/jsonSchema.test.ts
git commit -m "feat(predicate): generate JSON Schema from CaseType for write-side validation"
```

---

## Task 4: Type checker — comparison operators

**Files:**
- Create: `lib/domain/predicate/typeChecker.ts`
- Test: `lib/domain/predicate/__tests__/typeChecker.test.ts`

The type checker walks an AST and validates operand types against a `TypeContext` derived from the blueprint's `CaseType` schema. This task lands the base structure plus comparison operator coverage; subsequent tasks add the remaining operators.

**Type compatibility rules (used across the type checker):**

- `eq`/`neq` — types must be identical (`int` vs `int`, `text` vs `text`). Numeric promotion: `int` may compare with `decimal`. Date types are compatible only with the same date kind. `single_select` with `text` is allowed (string-typed under the hood).
- `gt`/`gte`/`lt`/`lte` — operands must be ordered: `int`/`decimal`/`date`/`datetime`/`time`. Strings are not ordered; ordering on strings raises an error.
- All operators error if a `prop` term references a property that doesn't exist on the named case type.

- [ ] **Step 1: Write the failing test**

```ts
// lib/domain/predicate/__tests__/typeChecker.test.ts
import { describe, it, expect } from "vitest";
import type { CaseType } from "@/lib/domain";
import { eq, gt, lt, prop, literal, input } from "../builders";
import { checkPredicate } from "../typeChecker";

const PATIENT: CaseType = {
  name: "patient",
  properties: [
    { name: "name", label: "Name", data_type: "text" },
    { name: "age", label: "Age", data_type: "int" },
    { name: "dob", label: "DOB", data_type: "date" },
    {
      name: "status",
      label: "Status",
      data_type: "single_select",
      options: [
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
      ],
    },
  ],
};

const ctx = {
  caseTypes: [PATIENT],
  currentCaseType: "patient",
  knownInputs: [],
};

describe("checkPredicate — comparison operators", () => {
  it("accepts int = int", () => {
    const p = eq(prop("patient", "age"), literal(42));
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(true);
  });

  it("accepts text = text", () => {
    const p = eq(prop("patient", "name"), literal("Alice"));
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(true);
  });

  it("rejects int = string-literal mismatch", () => {
    const p = eq(prop("patient", "age"), literal("forty-two"));
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/type mismatch/i);
    }
  });

  it("accepts gt on int", () => {
    const p = gt(prop("patient", "age"), literal(18));
    expect(checkPredicate(p, ctx).ok).toBe(true);
  });

  it("rejects gt on text (strings aren't ordered)", () => {
    const p = gt(prop("patient", "name"), literal("M"));
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/not ordered/i);
    }
  });

  it("accepts lt on date", () => {
    const p = lt(prop("patient", "dob"), literal("2000-01-01"));
    expect(checkPredicate(p, ctx).ok).toBe(true);
  });

  it("rejects an unknown property reference", () => {
    const p = eq(prop("patient", "bogus"), literal("x"));
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/unknown property/i);
    }
  });

  it("rejects an unknown case type reference", () => {
    const p = eq(prop("alien_type", "x"), literal("y"));
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/unknown case type/i);
    }
  });

  it("accepts input ref against int prop when input is declared", () => {
    const ctxWithInput = {
      ...ctx,
      knownInputs: [{ kind: "input", name: "min_age" } as const],
    };
    const p = gt(prop("patient", "age"), input("min_age"));
    expect(checkPredicate(p, ctxWithInput).ok).toBe(true);
  });

  it("rejects input ref when input isn't declared", () => {
    const p = gt(prop("patient", "age"), input("undeclared"));
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/unknown search input/i);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/domain/predicate/__tests__/typeChecker.test.ts`
Expected: FAIL with "Cannot find module '../typeChecker'"

- [ ] **Step 3: Write the type checker (comparison-only this task)**

```ts
// lib/domain/predicate/typeChecker.ts
//
// Schema-driven type checker for the predicate AST. Walks a Predicate against
// a TypeContext (derived from the blueprint's CaseType schema and the
// declared search inputs in scope) and produces either Ok or a list of
// typed errors. Errors carry paths so the UI can highlight the offending
// card.
//
// This file lands the base structure plus comparison operators. Logical,
// membership, geo, fuzzy, and when-input-present operators are added in
// later tasks.

import type { CaseType, CaseProperty } from "@/lib/domain";
import type { ComparisonKind, Literal, Predicate, SearchInputRef, Term } from "./types";

// ---------- Types ----------

export type SearchInputDecl = {
  kind: "input";
  name: string;
  /** Declared property type the input feeds into; widens or narrows the
   *  type-check rules at the comparison site. Optional — when absent, the
   *  input is treated as `text`. */
  data_type?: CaseProperty["data_type"];
};

export type TypeContext = {
  caseTypes: CaseType[];
  currentCaseType: string;
  knownInputs: SearchInputDecl[];
};

export type CheckPath = (string | number)[];
export type CheckError = { path: CheckPath; message: string };

export type CheckResult =
  | { ok: true }
  | { ok: false; errors: CheckError[] };

const ORDERED_TYPES: Set<NonNullable<CaseProperty["data_type"]>> = new Set([
  "int",
  "decimal",
  "date",
  "datetime",
  "time",
]);

// ---------- Top-level walker ----------

export function checkPredicate(
  predicate: Predicate,
  ctx: TypeContext,
): CheckResult {
  const errors: CheckError[] = [];
  walk(predicate, ctx, errors, []);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function walk(
  p: Predicate,
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): void {
  switch (p.kind) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      checkComparison(p.kind, p.left, p.right, ctx, errors, path);
      break;
    default:
      // Logical / collection / special operators are added in later tasks.
      // For now, recursing children of unknown kinds is a no-op so the
      // walker doesn't false-positive against forward-declared kinds.
      break;
  }
}

// ---------- Comparison checking ----------

function checkComparison(
  kind: ComparisonKind,
  left: Term,
  right: Term,
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): void {
  const leftType = resolveTermType(left, ctx, errors, [...path, "left"]);
  const rightType = resolveTermType(right, ctx, errors, [...path, "right"]);
  if (leftType === undefined || rightType === undefined) return;

  if (kind !== "eq" && kind !== "neq") {
    if (!ORDERED_TYPES.has(leftType) || !ORDERED_TYPES.has(rightType)) {
      errors.push({
        path,
        message: `Operator '${kind}' requires ordered types (int, decimal, date, datetime, time); got '${leftType}' and '${rightType}'. Strings are not ordered.`,
      });
      return;
    }
  }

  if (!typesCompatible(leftType, rightType)) {
    errors.push({
      path,
      message: `Type mismatch: '${leftType}' and '${rightType}' are not comparable.`,
    });
  }
}

// ---------- Term resolution ----------

function resolveTermType(
  term: Term,
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): NonNullable<CaseProperty["data_type"]> | undefined {
  switch (term.kind) {
    case "prop": {
      const ct = ctx.caseTypes.find((c) => c.name === term.caseType);
      if (!ct) {
        errors.push({
          path,
          message: `Unknown case type '${term.caseType}'.`,
        });
        return undefined;
      }
      const prop = ct.properties.find((p) => p.name === term.property);
      if (!prop) {
        errors.push({
          path,
          message: `Unknown property '${term.property}' on case type '${term.caseType}'.`,
        });
        return undefined;
      }
      return prop.data_type ?? "text";
    }
    case "input": {
      const decl = ctx.knownInputs.find((i) => i.name === term.name);
      if (!decl) {
        errors.push({
          path,
          message: `Unknown search input '${term.name}'.`,
        });
        return undefined;
      }
      return decl.data_type ?? "text";
    }
    case "user":
      // User-context refs default to text (CommCare's session/user/data is string-typed).
      return "text";
    case "literal":
      return literalType(term);
  }
}

function literalType(lit: Literal): NonNullable<CaseProperty["data_type"]> {
  switch (typeof lit.value) {
    case "string":
      return "text";
    case "number":
      return Number.isInteger(lit.value) ? "int" : "decimal";
    case "boolean":
      return "text"; // CommCare booleans are text-encoded ("true"/"false").
    case "object":
      return "text"; // null
  }
}

// ---------- Compatibility table ----------

function typesCompatible(
  a: NonNullable<CaseProperty["data_type"]>,
  b: NonNullable<CaseProperty["data_type"]>,
): boolean {
  if (a === b) return true;
  // int / decimal are mutually comparable.
  if ((a === "int" || a === "decimal") && (b === "int" || b === "decimal")) return true;
  // single_select / multi_select compare with text values.
  if (a === "single_select" && b === "text") return true;
  if (a === "text" && b === "single_select") return true;
  if (a === "multi_select" && b === "text") return true;
  if (a === "text" && b === "multi_select") return true;
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/domain/predicate/__tests__/typeChecker.test.ts`
Expected: PASS, all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/predicate/typeChecker.ts lib/domain/predicate/__tests__/typeChecker.test.ts
git commit -m "feat(predicate): add type checker base + comparison-operator coverage"
```

---

## Task 5: Type checker — logical operators (and / or / not)

**Files:**
- Modify: `lib/domain/predicate/typeChecker.ts`
- Modify: `lib/domain/predicate/__tests__/typeChecker.test.ts`

- [ ] **Step 1: Write the failing test (append to existing file)**

```ts
// Append to lib/domain/predicate/__tests__/typeChecker.test.ts

import { and, or, not } from "../builders";

describe("checkPredicate — logical operators", () => {
  it("accepts and(eq, gt) when both clauses are well-typed", () => {
    const p = and(
      eq(prop("patient", "name"), literal("Alice")),
      gt(prop("patient", "age"), literal(18)),
    );
    expect(checkPredicate(p, ctx).ok).toBe(true);
  });

  it("flags errors from each clause separately under and(...)", () => {
    const p = and(
      eq(prop("patient", "age"), literal("not-a-number")),  // type mismatch
      gt(prop("patient", "bogus"), literal(1)),              // unknown prop
    );
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
    }
  });

  it("accepts or(...) with valid clauses", () => {
    const p = or(
      eq(prop("patient", "status"), literal("open")),
      eq(prop("patient", "status"), literal("closed")),
    );
    expect(checkPredicate(p, ctx).ok).toBe(true);
  });

  it("accepts not(eq) when inner is well-typed", () => {
    const p = not(eq(prop("patient", "status"), literal("closed")));
    expect(checkPredicate(p, ctx).ok).toBe(true);
  });

  it("propagates errors from inside not(...)", () => {
    const p = not(gt(prop("patient", "name"), literal("M")));
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/domain/predicate/__tests__/typeChecker.test.ts`
Expected: FAIL — and/or/not now hit the default-no-op branch and unbalanced predicates pass when they shouldn't.

- [ ] **Step 3: Update the walker to handle logical operators**

In `lib/domain/predicate/typeChecker.ts`, replace the `walk` function with the version below.

```ts
function walk(
  p: Predicate,
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): void {
  switch (p.kind) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      checkComparison(p.kind, p.left, p.right, ctx, errors, path);
      break;
    case "and":
    case "or":
      for (let i = 0; i < p.clauses.length; i++) {
        walk(p.clauses[i], ctx, errors, [...path, p.kind, i]);
      }
      break;
    case "not":
      walk(p.clause, ctx, errors, [...path, "not"]);
      break;
    default:
      // in / within-distance / fuzzy / when-input-present added in later tasks
      break;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/domain/predicate/__tests__/typeChecker.test.ts`
Expected: PASS, all comparison + logical tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/predicate/typeChecker.ts lib/domain/predicate/__tests__/typeChecker.test.ts
git commit -m "feat(predicate): type-check logical operators (and / or / not)"
```

---

## Task 6: Type checker — collection and special operators (in / within-distance / fuzzy / when-input-present)

**Files:**
- Modify: `lib/domain/predicate/typeChecker.ts`
- Modify: `lib/domain/predicate/__tests__/typeChecker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// Append to lib/domain/predicate/__tests__/typeChecker.test.ts

import { isIn, within, fuzzy, whenInput } from "../builders";

describe("checkPredicate — special operators", () => {
  it("accepts isIn with type-compatible values", () => {
    const p = isIn(prop("patient", "status"), [
      literal("open"),
      literal("closed"),
    ]);
    expect(checkPredicate(p, ctx).ok).toBe(true);
  });

  it("rejects isIn when literal types don't match the property", () => {
    const p = isIn(prop("patient", "age"), [literal("eighteen"), literal(42)]);
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/type mismatch/i);
    }
  });

  it("accepts within-distance when property is geopoint", () => {
    const ctx2 = {
      ...ctx,
      caseTypes: [
        {
          ...PATIENT,
          properties: [
            ...PATIENT.properties,
            { name: "location", label: "Location", data_type: "geopoint" as const },
          ],
        },
      ],
      knownInputs: [{ kind: "input" as const, name: "user_loc", data_type: "geopoint" as const }],
    };
    const p = within(prop("patient", "location"), input("user_loc"), 50, "miles");
    expect(checkPredicate(p, ctx2).ok).toBe(true);
  });

  it("rejects within-distance when property is not geopoint", () => {
    const p = within(prop("patient", "name"), input("user_loc"), 50, "miles");
    const result = checkPredicate(p, {
      ...ctx,
      knownInputs: [{ kind: "input" as const, name: "user_loc", data_type: "geopoint" as const }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/geopoint/i);
    }
  });

  it("accepts fuzzy on a text property", () => {
    const p = fuzzy(prop("patient", "name"), "alice");
    expect(checkPredicate(p, ctx).ok).toBe(true);
  });

  it("rejects fuzzy on a non-text property", () => {
    const p = fuzzy(prop("patient", "age"), "alice");
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/text/i);
    }
  });

  it("accepts when-input-present wrapping a typed comparison", () => {
    const ctxWithInput = {
      ...ctx,
      knownInputs: [{ kind: "input" as const, name: "phone", data_type: "text" as const }],
    };
    const p = whenInput(
      input("phone"),
      eq(prop("patient", "name"), input("phone")),
    );
    expect(checkPredicate(p, ctxWithInput).ok).toBe(true);
  });

  it("rejects when-input-present referencing an unknown input", () => {
    const p = whenInput(
      input("undeclared"),
      eq(prop("patient", "name"), literal("Alice")),
    );
    const result = checkPredicate(p, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/unknown search input/i);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/domain/predicate/__tests__/typeChecker.test.ts`
Expected: FAIL — special operators are still no-ops in the walker.

- [ ] **Step 3: Update the walker to handle special operators**

Replace the `walk` function in `lib/domain/predicate/typeChecker.ts` with this expanded version, and add the helper checkers below.

```ts
function walk(
  p: Predicate,
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): void {
  switch (p.kind) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      checkComparison(p.kind, p.left, p.right, ctx, errors, path);
      break;
    case "and":
    case "or":
      for (let i = 0; i < p.clauses.length; i++) {
        walk(p.clauses[i], ctx, errors, [...path, p.kind, i]);
      }
      break;
    case "not":
      walk(p.clause, ctx, errors, [...path, "not"]);
      break;
    case "in":
      checkIn(p.left, p.values, ctx, errors, path);
      break;
    case "within-distance":
      checkWithinDistance(p, ctx, errors, path);
      break;
    case "fuzzy":
      checkFuzzy(p, ctx, errors, path);
      break;
    case "when-input-present":
      checkWhenInputPresent(p, ctx, errors, path);
      break;
  }
}

function checkIn(
  left: Term,
  values: Literal[],
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): void {
  const leftType = resolveTermType(left, ctx, errors, [...path, "left"]);
  if (leftType === undefined) return;
  for (let i = 0; i < values.length; i++) {
    const valType = literalType(values[i]);
    if (!typesCompatible(leftType, valType)) {
      errors.push({
        path: [...path, "values", i],
        message: `Type mismatch: literal '${valType}' is not comparable with property type '${leftType}'.`,
      });
    }
  }
}

function checkWithinDistance(
  p: Extract<Predicate, { kind: "within-distance" }>,
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): void {
  const propType = resolveTermType(p.property, ctx, errors, [...path, "property"]);
  if (propType !== undefined && propType !== "geopoint") {
    errors.push({
      path: [...path, "property"],
      message: `within-distance requires a geopoint property; got '${propType}'.`,
    });
  }
  const centerType = resolveTermType(p.center, ctx, errors, [...path, "center"]);
  if (centerType !== undefined && centerType !== "geopoint" && centerType !== "text") {
    errors.push({
      path: [...path, "center"],
      message: `within-distance center must be a geopoint or text-encoded coordinate; got '${centerType}'.`,
    });
  }
}

function checkFuzzy(
  p: Extract<Predicate, { kind: "fuzzy" }>,
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): void {
  const propType = resolveTermType(p.property, ctx, errors, [...path, "property"]);
  if (propType !== undefined && propType !== "text" && propType !== "single_select" && propType !== "multi_select") {
    errors.push({
      path: [...path, "property"],
      message: `fuzzy match requires a text-typed property; got '${propType}'.`,
    });
  }
}

function checkWhenInputPresent(
  p: Extract<Predicate, { kind: "when-input-present" }>,
  ctx: TypeContext,
  errors: CheckError[],
  path: CheckPath,
): void {
  const decl = ctx.knownInputs.find((i) => i.name === p.input.name);
  if (!decl) {
    errors.push({
      path: [...path, "input"],
      message: `Unknown search input '${p.input.name}'.`,
    });
    return;
  }
  walk(p.then, ctx, errors, [...path, "then"]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/domain/predicate/__tests__/typeChecker.test.ts`
Expected: PASS, all type checker tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/predicate/typeChecker.ts lib/domain/predicate/__tests__/typeChecker.test.ts
git commit -m "feat(predicate): type-check membership, geo, fuzzy, and conditional operators"
```

---

## Task 7: AST → CommCare XPath emitter — base + comparison + logical operators

**Files:**
- Create: `lib/commcare/predicate/xpathEmitter.ts`
- Test: `lib/commcare/predicate/__tests__/xpathEmitter.test.ts`

The emitter walks an AST and produces a CommCare-compatible XPath/CSQL string. Two emission contexts:

- `case-list-filter` — used as a predicate inside `instance('casedb')/casedb/case[...][...]`. Property references resolve as bare names (e.g. `status`); session/user references resolve to `instance('commcaresession')/session/user/data/<field>`.
- `csql` — used in `_xpath_query` value at search time. Property references are bare names; literal-quoting and string concatenation against runtime instances is done by the wire layer (Plan 4 wraps this in a `concat()` template when input refs are present).

This task lands base + comparison + logical operators. Tasks 8 covers special operators.

- [ ] **Step 1: Write the failing test**

```ts
// lib/commcare/predicate/__tests__/xpathEmitter.test.ts
import { describe, it, expect } from "vitest";
import { and, or, not, eq, neq, gt, gte, lt, lte, prop, literal, input, userField } from "@/lib/domain/predicate/builders";
import { emitXPath } from "../xpathEmitter";

describe("emitXPath — comparison operators (case-list-filter context)", () => {
  it("emits eq with a string literal", () => {
    const p = eq(prop("patient", "status"), literal("open"));
    expect(emitXPath(p, "case-list-filter")).toBe("status = 'open'");
  });

  it("emits eq with a numeric literal", () => {
    const p = eq(prop("patient", "age"), literal(42));
    expect(emitXPath(p, "case-list-filter")).toBe("age = 42");
  });

  it("emits neq", () => {
    const p = neq(prop("patient", "status"), literal("closed"));
    expect(emitXPath(p, "case-list-filter")).toBe("status != 'closed'");
  });

  it("emits gt / gte / lt / lte", () => {
    expect(emitXPath(gt(prop("patient", "age"), literal(18)), "case-list-filter")).toBe("age > 18");
    expect(emitXPath(gte(prop("patient", "age"), literal(18)), "case-list-filter")).toBe("age >= 18");
    expect(emitXPath(lt(prop("patient", "age"), literal(18)), "case-list-filter")).toBe("age < 18");
    expect(emitXPath(lte(prop("patient", "age"), literal(18)), "case-list-filter")).toBe("age <= 18");
  });

  it("escapes single quotes in string literals", () => {
    const p = eq(prop("patient", "name"), literal("O'Brien"));
    // CommCare XPath escapes a single quote inside a single-quoted string by
    // closing+concatenating: 'O' + "'" + 'Brien'. Using XPath's concat() is
    // the cleanest portable form.
    expect(emitXPath(p, "case-list-filter")).toBe(
      `name = concat('O', "'", 'Brien')`,
    );
  });

  it("emits user-context refs against session/user/data", () => {
    const p = eq(prop("patient", "owner_id"), userField("commcare_location_id"));
    expect(emitXPath(p, "case-list-filter")).toBe(
      "owner_id = instance('commcaresession')/session/user/data/commcare_location_id",
    );
  });

  it("emits search-input refs against the search-input results instance", () => {
    const p = eq(prop("patient", "name"), input("name_query"));
    expect(emitXPath(p, "case-list-filter")).toBe(
      "name = instance('search-input:results')/input/field[@name='name_query']",
    );
  });
});

describe("emitXPath — logical operators", () => {
  it("emits and(...) joining clauses", () => {
    const p = and(
      eq(prop("patient", "status"), literal("open")),
      gt(prop("patient", "age"), literal(18)),
    );
    expect(emitXPath(p, "case-list-filter")).toBe(
      "status = 'open' and age > 18",
    );
  });

  it("emits or(...) joining clauses", () => {
    const p = or(
      eq(prop("patient", "status"), literal("open")),
      eq(prop("patient", "status"), literal("active")),
    );
    expect(emitXPath(p, "case-list-filter")).toBe(
      "status = 'open' or status = 'active'",
    );
  });

  it("parenthesizes or-clauses inside an and (precedence)", () => {
    const p = and(
      or(
        eq(prop("patient", "status"), literal("open")),
        eq(prop("patient", "status"), literal("active")),
      ),
      gt(prop("patient", "age"), literal(18)),
    );
    expect(emitXPath(p, "case-list-filter")).toBe(
      "(status = 'open' or status = 'active') and age > 18",
    );
  });

  it("emits not(...) wrapping its inner with not(...)", () => {
    const p = not(eq(prop("patient", "status"), literal("closed")));
    expect(emitXPath(p, "case-list-filter")).toBe(
      "not(status = 'closed')",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/commcare/predicate/__tests__/xpathEmitter.test.ts`
Expected: FAIL with "Cannot find module '../xpathEmitter'"

- [ ] **Step 3: Write the emitter (base + comparison + logical)**

```ts
// lib/commcare/predicate/xpathEmitter.ts
//
// Compile a predicate AST to a CommCare-compatible XPath/CSQL string.
//
// Two emission contexts are supported:
//   - case-list-filter: predicate string used inside the case-list nodeset
//     (e.g. instance('casedb')/casedb/case[...][<this>])
//   - csql:             predicate string used in _xpath_query during search
//
// Both contexts share the same operator emission and quoting rules; they
// differ only at the Plan-4 wire layer in how the result is wrapped (csql
// is concatenated into a string template; case-list-filter is dropped into
// a nodeset directly).
//
// This file lands base + comparison + logical. Membership, geo, fuzzy, and
// when-input-present are added in Task 8.

import type { Predicate, Term } from "@/lib/domain/predicate";

export type EmissionContext = "case-list-filter" | "csql";

const COMPARISON_OPS: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

export function emitXPath(p: Predicate, ctx: EmissionContext): string {
  return emitPredicate(p, ctx, /* parentPrec */ 0);
}

// Operator precedence (higher binds tighter): comparison > and > or.
// Use precedence to decide whether sub-expressions need parens.
const PREC_OR = 1;
const PREC_AND = 2;
const PREC_COMPARISON = 3;

function emitPredicate(p: Predicate, ctx: EmissionContext, parentPrec: number): string {
  switch (p.kind) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `${emitTerm(p.left, ctx)} ${COMPARISON_OPS[p.kind]} ${emitTerm(p.right, ctx)}`;
    case "and": {
      const inner = p.clauses
        .map((c) => emitPredicate(c, ctx, PREC_AND))
        .join(" and ");
      return parentPrec > PREC_AND ? `(${inner})` : inner;
    }
    case "or": {
      const inner = p.clauses
        .map((c) => emitPredicate(c, ctx, PREC_OR))
        .join(" or ");
      return parentPrec > PREC_OR ? `(${inner})` : inner;
    }
    case "not":
      return `not(${emitPredicate(p.clause, ctx, 0)})`;
    default:
      // in / within-distance / fuzzy / when-input-present added in Task 8
      throw new Error(`emitXPath: operator '${p.kind}' not yet supported`);
  }
}

function emitTerm(term: Term, _ctx: EmissionContext): string {
  switch (term.kind) {
    case "prop":
      // Bare property name. The case-type scope is implied by the
      // surrounding nodeset; we don't emit casedb/case[...] paths here.
      return term.property;
    case "input":
      return `instance('search-input:results')/input/field[@name='${term.name}']`;
    case "user":
      return `instance('commcaresession')/session/user/data/${term.field}`;
    case "literal":
      return emitLiteral(term.value);
  }
}

function emitLiteral(value: string | number | boolean | null): string {
  if (value === null) return "''";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "'true'" : "'false'";
  // string: quote with single quotes; escape any embedded single quotes
  // by switching to concat() because XPath 1.0 lacks a string-escape syntax.
  if (!value.includes("'")) return `'${value}'`;
  const parts = value.split("'");
  // Build concat('part0', "'", 'part1', "'", 'part2', ...)
  const args: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    args.push(`'${parts[i]}'`);
    if (i < parts.length - 1) args.push(`"'"`);
  }
  return `concat(${args.join(", ")})`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/commcare/predicate/__tests__/xpathEmitter.test.ts`
Expected: PASS, all comparison + logical tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/commcare/predicate/xpathEmitter.ts lib/commcare/predicate/__tests__/xpathEmitter.test.ts
git commit -m "feat(predicate): AST → CommCare XPath for comparison + logical operators"
```

---

## Task 8: AST → CommCare XPath emitter — special operators (in / within-distance / fuzzy / when-input-present)

**Files:**
- Modify: `lib/commcare/predicate/xpathEmitter.ts`
- Modify: `lib/commcare/predicate/__tests__/xpathEmitter.test.ts`

Wire-format references for the special operators (verified against `~/code/commcare-hq/corehq/apps/case_search/xpath_functions/` and the case-list-search confluence cache):

- `in` — emits `selected-any(<prop>, '<v1> <v2>')` for multi-value membership over CommCare's space-delimited multi-select format. Single-value falls back to plain `<prop> = '<v>'`.
- `within-distance` — `within-distance(<prop>, <center-expr>, <distance>, '<unit>')`.
- `fuzzy` — `fuzzy-match(<prop>, '<value>')`.
- `when-input-present` — wrapped at the wire layer with `if(count(<input-expr>), <then-csql>, '')` per the cache file's pattern.

- [ ] **Step 1: Write the failing test (append)**

```ts
// Append to lib/commcare/predicate/__tests__/xpathEmitter.test.ts

import { isIn, within, fuzzy, whenInput } from "@/lib/domain/predicate/builders";

describe("emitXPath — special operators", () => {
  it("emits isIn with a single value as a plain equality", () => {
    const p = isIn(prop("patient", "status"), [literal("open")]);
    expect(emitXPath(p, "case-list-filter")).toBe("status = 'open'");
  });

  it("emits isIn with multiple values via selected-any", () => {
    const p = isIn(prop("patient", "status"), [
      literal("open"),
      literal("active"),
    ]);
    expect(emitXPath(p, "case-list-filter")).toBe(
      "selected-any(status, 'open active')",
    );
  });

  it("emits within-distance with a literal center and miles", () => {
    const p = within(prop("clinic", "location"), literal("40.7,-74.0"), 50, "miles");
    expect(emitXPath(p, "case-list-filter")).toBe(
      "within-distance(location, '40.7,-74.0', 50, 'miles')",
    );
  });

  it("emits within-distance with an input center", () => {
    const p = within(prop("clinic", "location"), input("user_loc"), 25, "kilometers");
    expect(emitXPath(p, "case-list-filter")).toBe(
      "within-distance(location, instance('search-input:results')/input/field[@name='user_loc'], 25, 'kilometers')",
    );
  });

  it("emits fuzzy as fuzzy-match(prop, 'value')", () => {
    const p = fuzzy(prop("patient", "name"), "alice");
    expect(emitXPath(p, "case-list-filter")).toBe(
      "fuzzy-match(name, 'alice')",
    );
  });

  it("emits when-input-present as if(count(input), then, '')", () => {
    const p = whenInput(
      input("name_query"),
      eq(prop("patient", "name"), input("name_query")),
    );
    expect(emitXPath(p, "case-list-filter")).toBe(
      "if(count(instance('search-input:results')/input/field[@name='name_query']), name = instance('search-input:results')/input/field[@name='name_query'], '')",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/commcare/predicate/__tests__/xpathEmitter.test.ts`
Expected: FAIL — special operators throw "not yet supported".

- [ ] **Step 3: Update the emitter to handle special operators**

In `lib/commcare/predicate/xpathEmitter.ts`, replace the `default:` branch of `emitPredicate` with the cases below.

```ts
function emitPredicate(p: Predicate, ctx: EmissionContext, parentPrec: number): string {
  switch (p.kind) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `${emitTerm(p.left, ctx)} ${COMPARISON_OPS[p.kind]} ${emitTerm(p.right, ctx)}`;
    case "and": {
      const inner = p.clauses
        .map((c) => emitPredicate(c, ctx, PREC_AND))
        .join(" and ");
      return parentPrec > PREC_AND ? `(${inner})` : inner;
    }
    case "or": {
      const inner = p.clauses
        .map((c) => emitPredicate(c, ctx, PREC_OR))
        .join(" or ");
      return parentPrec > PREC_OR ? `(${inner})` : inner;
    }
    case "not":
      return `not(${emitPredicate(p.clause, ctx, 0)})`;
    case "in": {
      if (p.values.length === 1) {
        return `${emitTerm(p.left, ctx)} = ${emitLiteral(p.values[0].value)}`;
      }
      const joined = p.values
        .map((v) => String(v.value ?? ""))
        .join(" ");
      return `selected-any(${emitTerm(p.left, ctx)}, '${joined}')`;
    }
    case "within-distance":
      return `within-distance(${emitTerm(p.property, ctx)}, ${emitTerm(p.center, ctx)}, ${p.distance}, '${p.unit}')`;
    case "fuzzy":
      return `fuzzy-match(${emitTerm(p.property, ctx)}, '${p.value}')`;
    case "when-input-present": {
      const inputExpr = emitTerm(p.input, ctx);
      const thenExpr = emitPredicate(p.then, ctx, 0);
      return `if(count(${inputExpr}), ${thenExpr}, '')`;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/commcare/predicate/__tests__/xpathEmitter.test.ts`
Expected: PASS, all XPath emitter tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/commcare/predicate/xpathEmitter.ts lib/commcare/predicate/__tests__/xpathEmitter.test.ts
git commit -m "feat(predicate): AST → CommCare XPath for membership / geo / fuzzy / conditional"
```

---

## Task 9: Install Kysely and add the typed `Database` shape

**Files:**
- Modify: `package.json`
- Create: `lib/case-store/sql/database.ts`
- Test: `lib/case-store/sql/__tests__/database.test.ts`

- [ ] **Step 1: Install Kysely**

```bash
npm install kysely
```

Verify: `grep '"kysely"' package.json` should show the new dependency.

- [ ] **Step 2: Write the failing test**

```ts
// lib/case-store/sql/__tests__/database.test.ts
import { describe, it, expect } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import type { Database } from "../database";

describe("Database type", () => {
  it("compiles a typed query against the cases table", () => {
    // We only need the Kysely instance for compile-time type checks;
    // no actual driver is wired (Plan 2's PostgresCaseStore wires it).
    const db = new Kysely<Database>({
      dialect: new PostgresDialect({
        // Pool placeholder; .compile() does not require a live connection.
        pool: {} as never,
      }),
    });

    const compiled = db
      .selectFrom("cases")
      .select(["case_id", "case_type"])
      .where("app_id", "=", "demo-app")
      .where("case_type", "=", "patient")
      .compile();

    expect(compiled.sql).toContain("from \"cases\"");
    expect(compiled.parameters).toEqual(["demo-app", "patient"]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- lib/case-store/sql/__tests__/database.test.ts`
Expected: FAIL with "Cannot find module '../database'"

- [ ] **Step 4: Write the Database type**

```ts
// lib/case-store/sql/database.ts
//
// Typed schema definitions for Kysely. Mirrors the Postgres schema spec'd
// in docs/superpowers/specs/2026-04-30-case-list-search-design.md. Plan 1
// uses these types only for compile-time correctness; Plan 2 wires the
// in-memory store; the Postgres deploy spec wires a real connection.

import type { ColumnType, Generated } from "kysely";

export interface CasesTable {
  case_id: string;
  app_id: string;
  case_type: string;
  owner_id: string | null;
  status: string | null;
  // ColumnType<Read, Insert, Update> — Postgres returns Date but accepts ISO strings.
  opened_on: ColumnType<Date, string | undefined, string | undefined>;
  modified_on: ColumnType<Date, string | undefined, string | undefined>;
  closed_on: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  parent_case_id: string | null;
  /** JSONB column containing user-defined typed properties.
   *  Schema is enforced at the database write boundary (write-time
   *  validation against the `case_type_schemas` row). Query-side casts to
   *  primitive types are emitted by the AST → Kysely compiler with the
   *  knowledge that writes are validated. */
  properties: Record<string, unknown>;
}

export interface CaseTypeSchemasTable {
  app_id: string;
  case_type: string;
  schema: Record<string, unknown>;
}

export interface CaseIndicesTable {
  case_id: string;
  ancestor_id: string;
  identifier: string;
  relationship: "child" | "extension";
  depth: number;
}

export interface Database {
  cases: CasesTable;
  case_type_schemas: CaseTypeSchemasTable;
  case_indices: CaseIndicesTable;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- lib/case-store/sql/__tests__/database.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/case-store/sql/database.ts lib/case-store/sql/__tests__/database.test.ts
git commit -m "feat(case-store): add Kysely + typed Database schema for cases / case_type_schemas / case_indices"
```

---

## Task 10: AST → Kysely SQL compiler — comparison + logical operators

**Files:**
- Create: `lib/case-store/sql/predicateCompiler.ts`
- Test: `lib/case-store/sql/__tests__/predicateCompiler.test.ts`

The compiler walks the AST and constructs Kysely `ExpressionBuilder` calls that produce typed JSONB-aware SQL. We don't run the SQL against a real database in this plan — we compile via `.compile()` and assert on the SQL string and parameters.

JSONB extraction patterns:
- `text` → `(properties->>'<name>')`
- `int` → `((properties->>'<name>')::int)`
- `decimal` → `((properties->>'<name>')::numeric)`
- `date` / `datetime` / `time` → `((properties->>'<name>')::<sql-cast>)`

The compiler reads the case-type schema (passed via `CompileContext`) to know each property's type at extraction time. Casts are guaranteed safe because writes are validated against the JSON Schema (Plan 2 wires the trigger).

- [ ] **Step 1: Write the failing test**

```ts
// lib/case-store/sql/__tests__/predicateCompiler.test.ts
import { describe, it, expect } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { CaseType } from "@/lib/domain";
import { and, or, not, eq, gt, lt, prop, literal } from "@/lib/domain/predicate/builders";
import type { Database } from "../database";
import { compilePredicate } from "../predicateCompiler";

const PATIENT: CaseType = {
  name: "patient",
  properties: [
    { name: "name", label: "Name", data_type: "text" },
    { name: "age", label: "Age", data_type: "int" },
    { name: "dob", label: "DOB", data_type: "date" },
  ],
};

function makeDb() {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: {} as never }),
  });
}

describe("compilePredicate — comparison operators", () => {
  it("emits eq on text via ->> extraction", () => {
    const db = makeDb();
    const p = eq(prop("patient", "name"), literal("Alice"));
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [PATIENT] }))
      .compile();
    expect(compiled.sql).toContain(`"properties" ->> 'name'`);
    expect(compiled.sql).toContain("=");
    expect(compiled.parameters).toContain("Alice");
  });

  it("emits gt on int with ::int cast", () => {
    const db = makeDb();
    const p = gt(prop("patient", "age"), literal(18));
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [PATIENT] }))
      .compile();
    expect(compiled.sql).toContain(`("properties" ->> 'age')::int`);
    expect(compiled.sql).toContain(">");
    expect(compiled.parameters).toContain(18);
  });

  it("emits lt on date with ::date cast", () => {
    const db = makeDb();
    const p = lt(prop("patient", "dob"), literal("2000-01-01"));
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [PATIENT] }))
      .compile();
    expect(compiled.sql).toContain(`("properties" ->> 'dob')::date`);
  });
});

describe("compilePredicate — logical operators", () => {
  it("emits and(...) joined with AND", () => {
    const db = makeDb();
    const p = and(
      eq(prop("patient", "name"), literal("Alice")),
      gt(prop("patient", "age"), literal(18)),
    );
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [PATIENT] }))
      .compile();
    expect(compiled.sql).toMatch(/and/i);
    expect(compiled.parameters).toEqual(expect.arrayContaining(["Alice", 18]));
  });

  it("emits or(...) joined with OR", () => {
    const db = makeDb();
    const p = or(
      eq(prop("patient", "name"), literal("Alice")),
      eq(prop("patient", "name"), literal("Bob")),
    );
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [PATIENT] }))
      .compile();
    expect(compiled.sql).toMatch(/or/i);
  });

  it("emits not(...) wrapping its inner", () => {
    const db = makeDb();
    const p = not(eq(prop("patient", "name"), literal("Alice")));
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [PATIENT] }))
      .compile();
    expect(compiled.sql).toMatch(/not/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/case-store/sql/__tests__/predicateCompiler.test.ts`
Expected: FAIL with "Cannot find module '../predicateCompiler'"

- [ ] **Step 3: Write the compiler (comparison + logical)**

```ts
// lib/case-store/sql/predicateCompiler.ts
//
// Compile a predicate AST to a Kysely WHERE-clause builder.
//
// The compiler walks the AST and constructs a function (eb) => Expression
// that Kysely accepts in `.where(...)`. Property references compile to
// typed JSONB extractions (`(properties->>'name')::cast`) chosen from the
// case-type schema. Casts are safe because writes are validated against
// the JSON Schema generated by `caseTypeToJsonSchema` (Plan 2).
//
// This file lands base + comparison + logical. Membership / geo / fuzzy /
// conditional are added in Task 11.

import type { CaseProperty, CaseType } from "@/lib/domain";
import type { Predicate, PropertyRef, Term } from "@/lib/domain/predicate";
import type { ExpressionBuilder, Expression } from "kysely";
import { sql } from "kysely";
import type { Database } from "./database";

export type CompileContext = {
  caseTypes: CaseType[];
};

type Eb = ExpressionBuilder<Database, "cases">;

/** Build a Kysely WHERE-clause callback that filters the `cases` table. */
export function compilePredicate(
  p: Predicate,
  ctx: CompileContext,
): (eb: Eb) => Expression<unknown> {
  return (eb) => emitPredicate(p, ctx, eb);
}

function emitPredicate(p: Predicate, ctx: CompileContext, eb: Eb): Expression<unknown> {
  switch (p.kind) {
    case "eq":
      return eb(emitTerm(p.left, ctx, eb), "=", emitTerm(p.right, ctx, eb));
    case "neq":
      return eb(emitTerm(p.left, ctx, eb), "!=", emitTerm(p.right, ctx, eb));
    case "gt":
      return eb(emitTerm(p.left, ctx, eb), ">", emitTerm(p.right, ctx, eb));
    case "gte":
      return eb(emitTerm(p.left, ctx, eb), ">=", emitTerm(p.right, ctx, eb));
    case "lt":
      return eb(emitTerm(p.left, ctx, eb), "<", emitTerm(p.right, ctx, eb));
    case "lte":
      return eb(emitTerm(p.left, ctx, eb), "<=", emitTerm(p.right, ctx, eb));
    case "and":
      return eb.and(p.clauses.map((c) => emitPredicate(c, ctx, eb)));
    case "or":
      return eb.or(p.clauses.map((c) => emitPredicate(c, ctx, eb)));
    case "not":
      return eb.not(emitPredicate(p.clause, ctx, eb));
    default:
      throw new Error(`compilePredicate: operator '${p.kind}' not yet supported`);
  }
}

function emitTerm(term: Term, ctx: CompileContext, eb: Eb): Expression<unknown> {
  switch (term.kind) {
    case "prop":
      return propertyExtraction(term, ctx, eb);
    case "literal":
      return eb.val(term.value);
    case "input":
      // Search inputs are bound at runtime by the case-store query layer;
      // Plan 2 wires that. For now compile to a parameterized placeholder.
      throw new Error(
        "compilePredicate: search input refs require a runtime binding map (Plan 2)",
      );
    case "user":
      throw new Error(
        "compilePredicate: user-context refs require a runtime binding map (Plan 2)",
      );
  }
}

function propertyExtraction(
  ref: PropertyRef,
  ctx: CompileContext,
  _eb: Eb,
): Expression<unknown> {
  const ct = ctx.caseTypes.find((c) => c.name === ref.caseType);
  const prop = ct?.properties.find((p) => p.name === ref.property);
  const cast = jsonbCastFor(prop?.data_type);
  if (cast === null) {
    return sql`("properties" ->> ${ref.property})`;
  }
  return sql`(("properties" ->> ${ref.property})::${sql.raw(cast)})`;
}

function jsonbCastFor(dt: CaseProperty["data_type"]): string | null {
  switch (dt) {
    case "int":
      return "int";
    case "decimal":
      return "numeric";
    case "date":
      return "date";
    case "datetime":
      return "timestamptz";
    case "time":
      return "time";
    case "single_select":
    case "multi_select":
    case "geopoint":
    case "text":
    case undefined:
      return null;  // text comparison via ->> is correct
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/case-store/sql/__tests__/predicateCompiler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/case-store/sql/predicateCompiler.ts lib/case-store/sql/__tests__/predicateCompiler.test.ts
git commit -m "feat(case-store): AST → Kysely for comparison + logical operators with typed JSONB extraction"
```

---

## Task 11: AST → Kysely SQL compiler — special operators (in / within-distance / fuzzy / when-input-present)

**Files:**
- Modify: `lib/case-store/sql/predicateCompiler.ts`
- Modify: `lib/case-store/sql/__tests__/predicateCompiler.test.ts`

SQL emission for the special operators:
- `in` — `(properties->>'name')::cast IN (?, ?, ...)` (array binding via Kysely's eb).
- `within-distance` — emits via PostGIS `ST_DWithin(geog_a, geog_b, distance_meters)`. Both operands convert from CommCare's `"lat lon"` text format via `ST_GeographyFromText('SRID=4326;POINT(lon lat)')`. Geo support in V1 ships behind an explicit context flag; if PostGIS is unavailable the compiler raises rather than emitting broken SQL.
- `fuzzy` — emits via `pg_trgm`'s `<%` similarity operator (or `similarity(a, b) > threshold`). Uses the property's text value.
- `when-input-present` — without a runtime binding for the input, this operator can't be compiled to SQL on its own; it requires the case-store query layer (Plan 2) to substitute the input value at runtime. For now the compiler raises with a clear error directing the caller to use the runtime binding API.

- [ ] **Step 1: Write the failing test (append)**

```ts
// Append to lib/case-store/sql/__tests__/predicateCompiler.test.ts

import { isIn, within, fuzzy, whenInput, input } from "@/lib/domain/predicate/builders";

describe("compilePredicate — special operators", () => {
  it("emits isIn with multiple values via IN (...)", () => {
    const db = makeDb();
    const p = isIn(prop("patient", "status"), [
      literal("open"),
      literal("active"),
    ]);
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [PATIENT] }))
      .compile();
    expect(compiled.sql).toMatch(/in\s*\(/i);
    expect(compiled.parameters).toEqual(expect.arrayContaining(["open", "active"]));
  });

  it("emits within-distance via ST_DWithin (PostGIS)", () => {
    const db = makeDb();
    const ctWithGeo: CaseType = {
      ...PATIENT,
      properties: [
        ...PATIENT.properties,
        { name: "location", label: "Loc", data_type: "geopoint" },
      ],
    };
    const p = within(
      prop("patient", "location"),
      literal("40.7 -74.0"),
      50,
      "miles",
    );
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [ctWithGeo] }))
      .compile();
    expect(compiled.sql).toContain("ST_DWithin");
    // 50 miles in meters ≈ 80467.2
    expect(compiled.sql).toMatch(/80467/);
  });

  it("emits fuzzy via pg_trgm % similarity threshold", () => {
    const db = makeDb();
    const p = fuzzy(prop("patient", "name"), "alice");
    const compiled = db
      .selectFrom("cases")
      .selectAll()
      .where(compilePredicate(p, { caseTypes: [PATIENT] }))
      .compile();
    expect(compiled.sql).toMatch(/similarity\(/i);
    expect(compiled.parameters).toContain("alice");
  });

  it("when-input-present without a runtime binding throws a clear error", () => {
    const p = whenInput(
      input("phone"),
      eq(prop("patient", "name"), input("phone")),
    );
    expect(() =>
      compilePredicate(p, { caseTypes: [PATIENT] })({} as never),
    ).toThrow(/runtime binding/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- lib/case-store/sql/__tests__/predicateCompiler.test.ts`
Expected: FAIL — special operators throw "not yet supported".

- [ ] **Step 3: Update the compiler to handle special operators**

In `lib/case-store/sql/predicateCompiler.ts`, replace the `default:` case in `emitPredicate` with the cases below.

```ts
function emitPredicate(p: Predicate, ctx: CompileContext, eb: Eb): Expression<unknown> {
  switch (p.kind) {
    case "eq":
      return eb(emitTerm(p.left, ctx, eb), "=", emitTerm(p.right, ctx, eb));
    case "neq":
      return eb(emitTerm(p.left, ctx, eb), "!=", emitTerm(p.right, ctx, eb));
    case "gt":
      return eb(emitTerm(p.left, ctx, eb), ">", emitTerm(p.right, ctx, eb));
    case "gte":
      return eb(emitTerm(p.left, ctx, eb), ">=", emitTerm(p.right, ctx, eb));
    case "lt":
      return eb(emitTerm(p.left, ctx, eb), "<", emitTerm(p.right, ctx, eb));
    case "lte":
      return eb(emitTerm(p.left, ctx, eb), "<=", emitTerm(p.right, ctx, eb));
    case "and":
      return eb.and(p.clauses.map((c) => emitPredicate(c, ctx, eb)));
    case "or":
      return eb.or(p.clauses.map((c) => emitPredicate(c, ctx, eb)));
    case "not":
      return eb.not(emitPredicate(p.clause, ctx, eb));
    case "in":
      return eb(
        emitTerm(p.left, ctx, eb),
        "in",
        p.values.map((v) => v.value),
      );
    case "within-distance":
      return emitWithinDistance(p, ctx, eb);
    case "fuzzy":
      return emitFuzzy(p, ctx);
    case "when-input-present":
      throw new Error(
        "compilePredicate: when-input-present requires a runtime binding map; use the case-store query layer (Plan 2) to bind input values before compilation.",
      );
  }
}

function emitWithinDistance(
  p: Extract<Predicate, { kind: "within-distance" }>,
  ctx: CompileContext,
  eb: Eb,
): Expression<unknown> {
  const meters = p.unit === "miles" ? p.distance * 1609.344 : p.distance * 1000;
  // CommCare wire format is "lat lon" — convert to PostGIS POINT(lon lat).
  // We use a SQL helper to do this at extraction time so both operands are
  // geographies and ST_DWithin can do the spheroidal-distance check.
  const propExpr = geographyFromCaseProperty(p.property);
  const centerExpr = geographyFromTerm(p.center, ctx);
  return sql`ST_DWithin(${propExpr}, ${centerExpr}, ${sql.raw(String(meters))})`;
}

function geographyFromCaseProperty(ref: PropertyRef): Expression<unknown> {
  // Convert "lat lon" → "POINT(lon lat)" via split_part.
  return sql`ST_GeographyFromText('SRID=4326;POINT(' || split_part("properties" ->> ${ref.property}, ' ', 2) || ' ' || split_part("properties" ->> ${ref.property}, ' ', 1) || ')')`;
}

function geographyFromTerm(term: Term, _ctx: CompileContext): Expression<unknown> {
  if (term.kind !== "literal" || typeof term.value !== "string") {
    throw new Error(
      "compilePredicate: within-distance center must be a string literal in 'lat lon' format (Plan 2 adds runtime input bindings)",
    );
  }
  const [lat, lon] = term.value.split(/\s+/);
  return sql`ST_GeographyFromText(${`SRID=4326;POINT(${lon} ${lat})`})`;
}

function emitFuzzy(
  p: Extract<Predicate, { kind: "fuzzy" }>,
  ctx: CompileContext,
): Expression<unknown> {
  // pg_trgm similarity threshold; default 0.3 matches Postgres's pg_trgm.similarity_threshold default.
  const propExtraction = sql`("properties" ->> ${p.property.property})`;
  return sql`similarity(${propExtraction}, ${p.value}) > 0.3`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- lib/case-store/sql/__tests__/predicateCompiler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/case-store/sql/predicateCompiler.ts lib/case-store/sql/__tests__/predicateCompiler.test.ts
git commit -m "feat(case-store): AST → Kysely for membership / PostGIS geo / pg_trgm fuzzy"
```

---

## Task 12: Barrel exports, domain re-exports, and CLAUDE.md documentation

**Files:**
- Create: `lib/domain/predicate/index.ts`
- Create: `lib/commcare/predicate/index.ts`
- Create: `lib/case-store/sql/index.ts`
- Modify: `lib/domain/index.ts`
- Create: `lib/domain/predicate/CLAUDE.md`

- [ ] **Step 1: Write the predicate barrel**

```ts
// lib/domain/predicate/index.ts
export * from "./types";
export * from "./builders";
export * from "./typeChecker";
export * from "./jsonSchema";
```

- [ ] **Step 2: Write the CommCare predicate barrel**

```ts
// lib/commcare/predicate/index.ts
export * from "./xpathEmitter";
```

- [ ] **Step 3: Write the case-store SQL barrel**

```ts
// lib/case-store/sql/index.ts
export * from "./database";
export * from "./predicateCompiler";
```

- [ ] **Step 4: Re-export from the domain barrel**

Edit `lib/domain/index.ts` to add the predicate re-export.

```ts
// lib/domain/index.ts
//
// Public barrel for the domain layer. Every consumer outside lib/domain/
// imports from here or from the kind-specific files under ./fields.

export * from "./blueprint";
export * from "./caseTypes";
export * from "./fields";
export * from "./forms";
export * from "./kinds";
export * from "./modules";
export * from "./predicate";
export * from "./uuid";
```

- [ ] **Step 5: Add CLAUDE.md for the predicate package**

```markdown
<!-- lib/domain/predicate/CLAUDE.md -->
# lib/domain/predicate

The typed predicate AST that backs every filter, sort key, calculated column, search input default, and default search filter in the case-list and search system. The AST is the source of truth; strings only exist at emission boundaries.

## Layout

- `types.ts` — Zod-discriminated AST schemas + inferred TS types. Operators are explicit `kind`-tagged variants; new operators are additions to the union, never accretion of behaviors onto existing kinds.
- `builders.ts` — typed construction helpers (`prop`, `input`, `literal`, `eq`, `gt`, `and`, `or`, `not`, `within`, `fuzzy`, `whenInput`, `isIn`, ...). Engineers and the SA agent build predicates by calling these — never by composing AST objects by hand.
- `typeChecker.ts` — schema-driven type checker. Walks an AST against a `TypeContext` (current case-type schema + declared search inputs) and returns Ok or a list of typed errors with paths.
- `jsonSchema.ts` — derives a JSON Schema from a `CaseType` definition. Used by the case database (Plan 2) for write-side validation: bad writes are rejected at the database boundary; reads can rely on values matching declared types without runtime coercion.

## Compilers (live elsewhere)

- `lib/commcare/predicate/xpathEmitter.ts` — AST → CommCare XPath/CSQL string for HQ wire emission.
- `lib/case-store/sql/predicateCompiler.ts` — AST → Kysely query-builder calls for runtime execution.

The AST is in this package; emitters live with the surface they emit to. Two surfaces, one source.

## Design properties (the quality bar)

1. **Typed at construction.** Invalid predicates can't be represented in the AST. Comparing `int` to a string literal fails at construction, not runtime.
2. **Schema-driven, single source.** `CaseType.properties[].data_type` drives the JSON Schema, the type checker context, and the JSONB extraction casts emitted by the SQL compiler.
3. **One source, multiple targets.** A predicate authored once compiles to Postgres SQL (preview/runtime), CommCare XPath/CSQL (HQ wire), and UI cards (authoring surface, Plan 3+).
4. **Semantics-aware UI.** Each operator gets a card fitted to its meaning, not a generic field/op/value row.

These prevent the accretion-and-untyped-strings pattern that produced CommCare HQ's case-search debt. See `docs/superpowers/specs/2026-04-30-case-list-search-design.md` for the full design rationale.
```

- [ ] **Step 6: Run the full test suite to confirm everything still passes together**

Run: `npm run test -- lib/domain/predicate lib/commcare/predicate lib/case-store`
Expected: PASS, all tests across the three packages.

- [ ] **Step 7: Commit**

```bash
git add lib/domain/predicate/index.ts lib/commcare/predicate/index.ts lib/case-store/sql/index.ts lib/domain/index.ts lib/domain/predicate/CLAUDE.md
git commit -m "feat(predicate): add barrel exports + CLAUDE.md for the predicate package"
```

---

## Final verification

- [ ] **Run the full test suite**

```bash
npm run test
```

Expected: PASS, all tests green including pre-existing tests.

- [ ] **Run the linter**

```bash
npm run lint
```

Expected: no errors, no warnings.

- [ ] **Confirm no placeholder code or TODOs remain**

```bash
grep -rn "TODO\|FIXME\|XXX" lib/domain/predicate lib/commcare/predicate lib/case-store
```

Expected: empty output.
