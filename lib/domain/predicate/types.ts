// lib/domain/predicate/types.ts
//
// Predicate AST. Source of truth for every filter, sort key, calculated
// column, search input default, and default search filter in the case-list
// and search system. Compiled to CommCare XPath/CSQL at HQ wire emission
// and to Kysely query-builder calls at runtime — never round-tripped
// through strings.
//
// Why an AST instead of strings: every authored predicate must compile to
// two different targets (CommCare XPath/CSQL going up to HQ, Kysely SQL
// running locally) AND drive an editing UI. A string-only representation
// would force a parser at every boundary; storing the AST keeps each
// surface as a one-way emitter and locks the semantics in one place.
// Concretely, this is the structural defense against the
// accretion-and-untyped-strings pattern that produced CommCare HQ's
// case-search XPath dialect over 25 years — every new capability there
// became another function added to the same untyped expression
// language. By forcing every authored predicate through this typed
// AST, that pattern is structurally prevented here. (See the design
// spec at docs/superpowers/specs/2026-04-30-case-list-search-design.md
// "Design properties — the quality bar" for the full rationale.)
//
// The AST uses Zod-discriminated unions on a `kind` field, matching
// Nova's existing patterns (see `lib/domain/fields/index.ts` for the
// flagship example). New operators are explicit additions to the union;
// behavior is never tucked under existing kinds via hidden state.
//
// Recursive shape note: `and` / `or` / `not` / `when-input-present`
// reference the predicate union itself. The cycle goes through a
// `z.discriminatedUnion(...)` (not a single self-referencing object), so
// the cleanest Zod 4 fallback documented for union recursion applies —
// each recursive slot wraps its predicate reference in `z.lazy(...)`,
// and `predicateSchema` carries an explicit `z.ZodType<Predicate>`
// annotation. The block below the operators explains why.

import { z } from "zod";
import { casePropertyDataTypeSchema } from "../blueprint";

// ---------- Identifier patterns ----------
//
// Property names, search-input names, user-data field names, and case
// types all flow through the wire emitters as raw identifiers (e.g.
// `eq(prop("patient", "status"), ...)` becomes `@status = '...'` on
// the XPath wire). The emitter does not quote or escape these
// identifiers — it interpolates them directly — so any character
// rejected by CommCare's identifier vocabulary at the schema layer
// would otherwise reach the wire as broken or attacker-controlled
// XPath. Reject at parse time rather than relying on each emitter
// to re-defend the boundary.
//
// The patterns below are deliberately inlined rather than imported
// from `lib/commcare/constants`. The `noRestrictedImports` rule in
// `biome.json` denies `lib/domain` direct access to
// `lib/commcare/*`, and the convention is that `lib/commcare`
// crosses the boundary in one direction only — domain → commcare at
// emission time. The patterns themselves are simple regex strings,
// not CommCare logic; a boundary-crossing import here would buy a
// shared declaration site at the cost of inverting the package
// graph for two regular expressions.
//
// `lib/commcare/constants.ts` is the source of truth for CommCare's
// identifier vocabulary. The patterns here mirror its
// `CASE_TYPE_REGEX` / `CASE_PROPERTY_REGEX` / `XML_ELEMENT_NAME_REGEX`
// constants. A drift guard in
// `__tests__/types.test.ts` crosses the boundary at test time
// (where the `noRestrictedImports` rule does not apply per
// `biome.json:61`) and asserts the inlined patterns' `.source`
// equals the canonical constants' `.source`. If the source-of-truth
// constants are updated, the test fails until the inlined copies
// here are updated to match. Each pattern is exported below so the
// guard test can compare it.

/**
 * Permitted shape of a CommCare case type identifier — leading
 * letter, then letters/digits/underscores/hyphens. Mirrors
 * `CASE_TYPE_REGEX` in `lib/commcare/constants.ts`.
 */
export const CASE_TYPE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Permitted shape of a case property name addressed in a predicate
 * AST. Mirrors `CASE_PROPERTY_REGEX` in `lib/commcare/constants.ts`
 * (same shape as case types: leading letter, then
 * letters/digits/underscores/hyphens). Hyphens are permitted because
 * existing CommCare deployments routinely store properties with
 * hyphenated names (e.g. `external-id`); the wire emitter treats
 * them as opaque identifiers.
 */
export const CASE_PROPERTY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Permitted shape of an XML element name — a search-input name and
 * a user-data field name both surface as XML element-style
 * identifiers in their resolved wire forms (`<input>/<field
 * @name='...'>` and `/session/user/data/<field>` respectively), so
 * each must conform to XML's element-name rules: leading letter or
 * underscore, then letters/digits/underscores. Hyphens are NOT
 * permitted here — that's the difference from
 * `CASE_PROPERTY_PATTERN` and matches the divergence in
 * `lib/commcare/constants.ts` between `XML_ELEMENT_NAME_REGEX` and
 * `CASE_PROPERTY_REGEX`.
 */
export const XML_ELEMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// ---------- Identifier-field schema helpers ----------
//
// Every identifier slot in the AST (case types, properties, search-input
// names, user-data fields, relation identifiers, etc.) reduces to one
// of three shapes: case-type vocabulary (`CASE_TYPE_PATTERN`), case-
// property vocabulary (`CASE_PROPERTY_PATTERN`), or XML element-name
// vocabulary (`XML_ELEMENT_NAME_PATTERN`). The case-property and case-
// type vocabularies happen to share a regex today but their domain
// roles are distinct, so each gets its own helper — a future
// divergence in CCHQ's vocabulary doesn't have to scan every
// `z.string().regex(...)` call.
//
// Each helper takes a `label` parameter that customizes the parse-error
// message for the field's domain role. Centralizing the message
// templates here means a phrasing change applies everywhere at once
// rather than drifting across ten call sites; centralizing the regex
// reference means adding a new identifier slot is one helper call
// rather than a copy-pasted three-line `.regex(...)` block.

/**
 * Builder for a Zod string-with-regex schema constrained to XML
 * element-name vocabulary — search-input names, user-context fields,
 * and relation identifiers all draw from this closed set. Hyphens are
 * NOT permitted; see the JSDoc on `XML_ELEMENT_NAME_PATTERN` for the
 * vocabulary divergence rationale.
 */
const xmlElementNameField = (label: string) =>
	z
		.string()
		.regex(
			XML_ELEMENT_NAME_PATTERN,
			`${label} must start with a letter or underscore and contain only letters, digits, or underscores.`,
		);

/**
 * Builder for a Zod string-with-regex schema constrained to CommCare
 * case-type vocabulary — case-type names and the `throughCaseType` /
 * `ofCaseType` qualifiers on relation paths all draw from this set.
 * Hyphens are permitted (the divergence from XML element names);
 * see the JSDoc on `CASE_TYPE_PATTERN` for the vocabulary rationale.
 */
const caseTypeField = (label: string) =>
	z
		.string()
		.regex(
			CASE_TYPE_PATTERN,
			`${label} must start with a letter and contain only letters, digits, underscores, or hyphens.`,
		);

/**
 * Builder for a Zod string-with-regex schema constrained to CommCare
 * case-property vocabulary. The pattern is presently identical to
 * `CASE_TYPE_PATTERN` (both admit hyphens), but the role is distinct
 * enough — case types name the schema, properties name a field within
 * a case — that drift in either vocabulary should not silently change
 * the other. Each helper carries the role-specific error message; if
 * the patterns ever diverge, the change lands in one place per role.
 */
const casePropertyField = (label: string) =>
	z
		.string()
		.regex(
			CASE_PROPERTY_PATTERN,
			`${label} must start with a letter and contain only letters, digits, underscores, or hyphens.`,
		);

// ---------- Relation paths (cross-case-type traversal) ----------
//
// `RelationPath` is the typed structural equivalent of CommCare's
// slash-separated index strings (`parent`, `parent/host`, etc.). It
// records HOW a property reference reaches across the case-relationship
// graph without committing to a particular wire form: emitters lower it
// to `instance('casedb')/casedb/case[@case_id = current()/index/<rel>]`
// for the on-device dialect — each `<rel>` resolves at runtime against
// the per-case `<index>` TreeElement built by `buildIndexTreeElement`
// in `commcare-core/src/main/java/org/commcare/cases/instance/CaseChildElement.java`
// (the index-loop adds one named TreeElement child per `CaseIndex`,
// using `i.getName()` as the element name — that's what makes
// `current()/index/<identifier>` resolvable as an XPath path step at
// evaluation time). The symbol anchor is the durable reference here;
// upstream line numbers drift across versions. The CSQL dialect lowers
// to `ancestor-exists(parent/host, ...)` / `subcase-exists('parent',
// ...)` per
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:39-54`,
// `ancestor_functions.py:39-94`, and `subcase_functions.py:51-62`.
// The Postgres dialect lowers to a JOIN on the `case_indices` table.
//
// The four kinds (`self`, `ancestor`, `subcase`, `any-relation`) capture
// the direction of the walk — no traversal, up via parent/host index,
// down via reverse index, or unknown direction. They do NOT encode
// CommCare's relationship-id (CHILD = 1, EXTENSION = 2 at
// `commcare-hq/corehq/form_processor/models/cases.py:1085-1090`); the
// `identifier` slot carries the user-named index (`parent`, `host`, or
// custom) and the relationship-id is derived at the case-store layer
// when the AST is lowered to SQL.
//
// `throughCaseType` (on `RelationStep`) and `ofCaseType` (on `subcase` /
// `any-relation`) are case-type narrowing hints. They let the type
// checker resolve property references inside the destination scope of
// an `exists` / `count` filter without re-walking the relationship
// graph at check time. Both are optional — authors can omit them and
// the type checker falls back to the broadest plausible scope.

/**
 * One step in a relation walk — the index name plus an optional
 * case-type narrowing hint. `RelationStep[]` represents a multi-hop
 * ancestor chain; the chain's first step originates at the current
 * case-type scope and each subsequent step originates at the destination
 * of the previous step.
 *
 * `identifier` is constrained to XML element-name vocabulary because
 * the wire form `current()/index/<identifier>` places the identifier
 * as an XML element-name path step. The on-device runtime build site
 * is `CaseChildElement.buildIndexTreeElement` (cited at the
 * file-level RelationPath comment), where each index identifier
 * surfaces as a named child of the per-case `<index>` TreeElement.
 * The CCHQ ES traversal is verified at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py:39-94`.
 * `throughCaseType` is constrained to CommCare's case-type vocabulary
 * to keep emitter interpolation safe.
 */
export const relationStepSchema = z.object({
	identifier: xmlElementNameField("Relation identifier"),
	throughCaseType: caseTypeField("Through case type").optional(),
});
export type RelationStep = z.infer<typeof relationStepSchema>;

/**
 * Typed traversal across the case-relationship graph. The four kinds:
 *
 *   - `self` — no traversal; the predicate runs in the current
 *     case-type scope. Distinct from absent-`via` on a property
 *     reference so that a UI surface can flip a relational read to/from
 *     the no-traversal form without reshaping the parent object.
 *   - `ancestor` — walk up via the parent/host index chain. `via` is
 *     the chain (e.g. `[{ identifier: "parent" }, { identifier: "host" }]`
 *     for "host of parent"). Maps to CCHQ's `ancestor-exists` server-side
 *     and to the `instance('casedb')/.../[@case_id =
 *     current()/index/<rel>]` join pattern on-device. The
 *     tuple-with-rest shape on `via` rules out the empty walk that
 *     would silently collapse to `self`.
 *   - `subcase` — walk down via the reverse index. `identifier` is the
 *     index name on the *child* case pointing back at the current case;
 *     `ofCaseType` narrows resolution inside the subcase filter so the
 *     type checker can resolve property references at the destination
 *     scope without re-walking the relationship graph at check time.
 *     Maps to CCHQ's `subcase-exists`/`subcase-count`.
 *   - `any-relation` — direction-agnostic relation by identifier.
 *     Models the case where authoring time can't commit to CHILD vs
 *     EXTENSION semantics (e.g. a custom index whose direction isn't
 *     known until runtime). On the Postgres target, this compiles to
 *     a `case_indices.identifier` lookup that matches both directions.
 *     CCHQ's on-device and CSQL function sets expose only
 *     direction-specific operators (`ancestor-exists` /
 *     `subcase-exists`), so this kind has no direct CCHQ wire form;
 *     any consumer compiling to a CCHQ target rejects or rewrites
 *     `any-relation` into a direction-specific kind.
 */
export const relationPathSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("self") }),
	z.object({
		kind: z.literal("ancestor"),
		// Tuple-with-rest is the Zod 4 idiom for non-empty arrays
		// (Zod issue #5253 / v4 migration guide). Compared with
		// `z.array(T).min(1)`, the tuple form infers as
		// `[T, ...T[]]` rather than `T[]`, which lets construction-
		// site object literals like `{ kind: "ancestor", via: [] }`
		// fail at compile time rather than at parse time. Indexed
		// access on the resulting type still yields `T` under the
		// project's current `tsconfig` (no `noUncheckedIndexedAccess`),
		// so the runtime parse rejection is what enforces non-empty
		// at read sites — but the construction-site distinction is
		// real and is locked by the
		// `typeCheckNonEmptyConstructionSite` block in the builders
		// test file. The same pattern guards `andSchema.clauses`,
		// `orSchema.clauses`, and `inSchema.values` below.
		via: z.tuple([relationStepSchema], relationStepSchema),
	}),
	z.object({
		kind: z.literal("subcase"),
		identifier: xmlElementNameField("Subcase identifier"),
		ofCaseType: caseTypeField("Of case type").optional(),
	}),
	z.object({
		kind: z.literal("any-relation"),
		identifier: xmlElementNameField("Relation identifier"),
		ofCaseType: caseTypeField("Of case type").optional(),
	}),
]);
export type RelationPath = z.infer<typeof relationPathSchema>;

// ---------- Terms (anything that resolves to a value) ----------
//
// Terms are the leaves of the AST. They never contain predicates and so
// are not recursive. Each term variant is a flat `z.object` joined by a
// flat `z.discriminatedUnion("kind", ...)`. Compilers pattern-match on
// `kind` and emit the corresponding XPath/SQL node.

/**
 * Reference to a property read from a case in a specific scope.
 *
 * `caseType` names the **originating case-type scope** — the case type
 * the predicate runs against, i.e. the case type at the predicate's
 * "self" position. It is NOT the case type the property lives on when
 * `via` is present. When `via` is absent or `{ kind: "self" }`, the
 * property is read directly on a case of `caseType`. When `via` is a
 * relation walk (`ancestor` / `subcase` / `any-relation`), the walk
 * resolves to a destination case type, and `property` is read on that
 * destination — the type checker uses `via`'s `throughCaseType` /
 * `ofCaseType` qualifiers to resolve the destination scope at check
 * time.
 *
 * Example: a predicate over the `patient` case list filtering by
 * `region` on the patient's `household` parent compiles to
 * `prop("patient", "region", ancestorPath(relationStep("parent",
 * "household")))`. `caseType` is `patient` (originating scope);
 * `property` is `region` on the `household` destination reached via
 * the `parent` index hop.
 *
 * The `caseType` qualifier is required even when `via` is present so
 * the originating scope is always explicit at the AST node — readers
 * don't have to trace back through nesting to recover it, and the
 * type checker can resolve the relation walk against the originating
 * case-type schema directly.
 *
 * Both `caseType` and `property` are constrained to CommCare's
 * identifier vocabulary at the schema layer — see the
 * "Identifier patterns" comment above for why. The emitter
 * interpolates these directly into XPath strings, so any character
 * outside the permitted set would either fail downstream parsing or
 * (worse) inject attacker-controlled syntax.
 *
 * Absence of `via` and `{ kind: "self" }` are semantically equivalent
 * — the schema accepts both shapes so a UI surface editing a
 * relational read can flip the kind without reshaping the parent
 * object. See the JSDoc on `relationPathSchema` for the full set of
 * supported walks.
 */
export const propertyRefSchema = z.object({
	kind: z.literal("prop"),
	caseType: caseTypeField("Case type"),
	property: casePropertyField("Property name"),
	via: relationPathSchema.optional(),
});
export type PropertyRef = z.infer<typeof propertyRefSchema>;

/**
 * Reference to a value the user typed into a search input on the
 * case-search screen. Resolved at compile time by mapping `name` to the
 * search input's runtime value (XPath: `instance('commcaresession')...`
 * or similar; SQL: a bound parameter).
 *
 * `name` is constrained to XML element-name vocabulary (no hyphens) —
 * the wire form `<input>/<field @name='...'>` makes the name surface
 * as an XML attribute value, but downstream code paths that derive
 * structural identifiers from the input name still rely on element-
 * name shape, so the schema rejects hyphens here.
 */
export const searchInputRefSchema = z.object({
	kind: z.literal("input"),
	name: xmlElementNameField("Search input name"),
});
export type SearchInputRef = z.infer<typeof searchInputRefSchema>;

/**
 * Reference to a field on the current session user (e.g. their assigned
 * region, their role). Compiled to `instance('commcaresession')/.../user/data/<field>`
 * on the XPath side and to a request-context parameter on the SQL side.
 *
 * `field` is constrained to XML element-name vocabulary because the
 * wire form `/session/user/data/<field>` places the field as a
 * literal XML element name in the path step.
 */
export const userContextRefSchema = z.object({
	kind: z.literal("user"),
	field: xmlElementNameField("User-context field"),
});
export type UserContextRef = z.infer<typeof userContextRefSchema>;

/**
 * A primitive constant. Numbers, booleans, and `null` are first-class
 * (rather than serialized to strings) so the type checker can validate
 * compatibility with the referenced property's data type without
 * round-tripping through string parsing.
 *
 * The optional `data_type` lets a literal carry its semantic type
 * explicitly — load-bearing for date / datetime / time literals, whose
 * wire form is a string and whose JS runtime type is therefore
 * indistinguishable from any other text. With `data_type` set, the type
 * checker uses the declared type directly; without it, the checker
 * infers from the JS runtime type. Authors construct typed literals via
 * `dateLiteral` / `datetimeLiteral` / `timeLiteral` in `builders.ts`
 * rather than setting the field by hand.
 *
 * Re-using `casePropertyDataTypeSchema` from the blueprint keeps the
 * literal's declarable type set identical to a property's declarable
 * type set — adding a property data type expands literals at the same
 * time, no parallel maintenance.
 */
export const literalSchema = z.object({
	kind: z.literal("literal"),
	value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
	data_type: casePropertyDataTypeSchema.optional(),
});
export type Literal = z.infer<typeof literalSchema>;

export const termSchema = z.discriminatedUnion("kind", [
	propertyRefSchema,
	searchInputRefSchema,
	userContextRefSchema,
	literalSchema,
]);
export type Term = z.infer<typeof termSchema>;

// ---------- Predicate operators (anything that resolves to a boolean) ----------

/**
 * Comparison operators. Keeping them in a single tuple lets the schema
 * narrow them collectively (`z.enum(COMPARISON_KINDS)`) and lets the
 * compilers iterate the set when emitting (one mapping table for all
 * six). Strict ordering doesn't matter — the type checker treats the
 * set as semantically equivalent up to operand-type rules.
 *
 * The enum collapse is correct *only because all six share the same
 * operand shape* (`left`/`right`, both `termSchema`). If a future
 * operator needs an asymmetric field — e.g. `case_sensitive` only on
 * `eq`/`neq` — split the enum back into per-literal arms (one
 * `z.object` per operator) rather than tacking optional fields onto
 * this schema. Smuggling per-operator behavior under an optional
 * shared field would violate the design property "behavior is never
 * tucked under existing kinds via hidden state".
 */
const COMPARISON_KINDS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];

const comparisonSchema = z.object({
	kind: z.enum(COMPARISON_KINDS),
	left: termSchema,
	right: termSchema,
});

/**
 * Set membership with value-equality semantics: `left` equals one of
 * the literals in `values`. Right side is restricted to literals (not
 * arbitrary terms) because the wire targets — an XPath or-of-equalities
 * chain on the case-list side and SQL `IN (...)` on the runtime side —
 * both demand a static value list.
 *
 * `values` is non-empty (tuple-with-rest): an empty `in(...)` is
 * trivially false at every target and is virtually always an
 * authoring bug (e.g. a filter UI that bound to an unset variable).
 * Reject at the AST layer so downstream compilers don't have to
 * encode the policy.
 *
 * The `.refine` rejecting all-null `values` defends a structural
 * degenerate: a list of nothing-but-null collapses on every wire to
 * "the property is unset OR the property is unset OR ...", which is
 * just "the property is unset" duplicated. That's not what `in`
 * means; the `eq(prop, literal(null))` shape is the canonical
 * "is unset" form. Mixed null + non-null lists are accepted because
 * they encode the meaningful "is unset OR equals one of these values"
 * predicate.
 */
const inSchema = z.object({
	kind: z.literal("in"),
	left: termSchema,
	// Tuple-with-rest produces `[Literal, ...Literal[]]` rather than
	// `Literal[]`. Construction-site object literals like
	// `{ kind: "in", left: ..., values: [] }` fail at compile time
	// rather than only at parse. Indexed access on the resulting
	// type still yields `Literal` under the project's current
	// `tsconfig` (no `noUncheckedIndexedAccess`), so the runtime
	// parse rejection is what enforces non-empty at read sites.
	// The `.refine()` below (rejecting all-null lists) runs after
	// the tuple-arity check so a malformed shape fails on arity
	// first; both checks are independent and both run on every
	// parse.
	values: z
		.tuple([literalSchema], literalSchema)
		.refine(
			(values) => values.some((v) => v.value !== null),
			"in.values must contain at least one non-null value",
		),
});

/**
 * Distance units accepted by `within-distance`. Pattern mirrors
 * `COMPARISON_KINDS` above: a local `as const` tuple feeds the schema
 * via `z.enum(...)`, and the exported `DistanceUnit` type derives from
 * it so the builder's `unit` parameter shares this single source of
 * truth. Adding a unit (e.g. `"meters"`) here automatically expands
 * the builder's accepted argument set rather than silently letting
 * the builder reject what the schema accepts.
 */
const DISTANCE_UNITS = ["miles", "kilometers"] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

/**
 * Geo predicate: include cases whose `property` (a geopoint) lies
 * within `distance` of `center`. `property` is constrained to a direct
 * property reference (the geopoint can't be a literal or an input —
 * those shapes don't make geometric sense), but `center` is a
 * full term so a search-input geopoint or a session user location
 * can drive the query.
 *
 * `distance` is `.nonnegative()` — a negative radius is geometrically
 * meaningless and would propagate to two compilers (XPath/CSQL and
 * Kysely) that don't share a rejection layer. Reject at the AST. Zod
 * 4's `z.number()` already rejects `NaN` and `±Infinity`, so the only
 * structural concern left here is the sign.
 */
const withinDistanceSchema = z.object({
	kind: z.literal("within-distance"),
	property: propertyRefSchema,
	center: termSchema,
	distance: z.number().nonnegative(),
	unit: z.enum(DISTANCE_UNITS),
});

/**
 * Phonetic / fuzzy match. Like `within-distance`, the left side must be
 * a direct property reference — fuzzy match against a literal or input
 * is meaningless. The right side is a string (not a term) because the
 * operator is unambiguously textual at every target.
 */
const fuzzySchema = z.object({
	kind: z.literal("fuzzy"),
	property: propertyRefSchema,
	value: z.string(),
});

// ---------- Recursive predicate operators ----------
//
// `and`, `or`, `not`, and `when-input-present` reference the predicate
// union itself. Two distinct constraints converge here:
//
//   1. Runtime — Zod 4's getter pattern (the documented v4 idiom for
//      self-referential objects, e.g. `Category` referencing
//      `Category`) fails when the recursion goes through a
//      `z.discriminatedUnion(...)`. The union's constructor eagerly
//      reads each member's shape to build the discriminator-to-arm
//      lookup table, and the cycle never resolves because the union
//      doesn't exist yet when the arms are declared.
//      `z.lazy(() => predicateSchema)` defers the access until the
//      first parse, after `predicateSchema`'s `const` binding is
//      complete, so the cycle resolves at use time.
//      (Zod issue #4264.)
//
//   2. TypeScript — TypeScript cannot resolve `z.infer` through a
//      recursive union; recent versions either collapse the chain to
//      `any` or reject the whole expression as a circular mapped type
//      (Zod issue #5035 details the TS 5.9+ behavior). The four
//      recursive arms of `Predicate` are therefore hand-declared, and
//      `predicateSchema` carries an explicit `z.ZodType<Predicate>`
//      annotation so the schema's runtime shape and the hand-declared
//      type stay reconciled. The drift guard at the bottom of this
//      file catches divergence between the hand-declared arms and the
//      schemas' inferred shapes.
//
// Why one schema per recursive operator instead of inlining them in
// the `discriminatedUnion(...)` call: `z.discriminatedUnion` requires
// each member to be a single object schema carrying the discriminant
// key. Defining each as a named const keeps the union list readable
// and lets each operator's contract live next to its discriminator
// declaration.

// `clauses` on `andSchema` and `orSchema` is non-empty: an empty `and`
// trivially evaluates to `true` and an empty `or` trivially evaluates
// to `false` — neither is useful and both almost always indicate an
// authoring bug (e.g. a filter UI that produced no clauses). Reject at
// the AST layer rather than surfacing tautologies/contradictions to
// downstream consumers.
//
// Both use the Zod 4 tuple-with-rest idiom rather than
// `z.array(...).min(1)`. The inferred type is
// `[Predicate, ...Predicate[]]` rather than `Predicate[]`, which lets
// construction-site object literals like
// `{ kind: "and", clauses: [] }` fail at compile time. (Indexed access
// on the resulting type still yields `Predicate` under the project's
// current `tsconfig` because `noUncheckedIndexedAccess` is not enabled,
// so the runtime parse rejection is what enforces non-empty at read
// sites; the construction-site distinction is what tuple-with-rest
// adds at the type layer.) Both tuple slots wrap their predicate
// reference in `z.lazy(...)` for the same reason the original
// `.min(1)` form did — see the recursive-shape note above for why
// the discriminated-union recursion has to go through `z.lazy`.

const andSchema = z.object({
	kind: z.literal("and"),
	clauses: z.tuple(
		[z.lazy(() => predicateSchema)],
		z.lazy(() => predicateSchema),
	),
});

const orSchema = z.object({
	kind: z.literal("or"),
	clauses: z.tuple(
		[z.lazy(() => predicateSchema)],
		z.lazy(() => predicateSchema),
	),
});

const notSchema = z.object({
	kind: z.literal("not"),
	clause: z.lazy(() => predicateSchema),
});

/**
 * Conditional inclusion: only apply `clause` if the named search input
 * is set at runtime. Models the common case-search pattern where an
 * optional input filters the result set only when the user typed a
 * value, and is otherwise a no-op. Distinct from `not(eq(input, null))`
 * because the wire targets emit different scaffolding (XPath
 * conditional include vs. SQL guarded subquery).
 *
 * The slot is named `clause` to parallel `notSchema.clause`: both arms
 * wrap a single predicate as a structural argument (not an imperative
 * continuation), so the field name reads the same way across the two
 * operators that share that shape. Reading semantics: `clause` is the
 * predicate that runs only when the trigger input is set.
 */
const whenInputPresentSchema = z.object({
	kind: z.literal("when-input-present"),
	input: searchInputRefSchema,
	clause: z.lazy(() => predicateSchema),
});

/**
 * The full predicate union, discriminated on `kind` — consumers
 * narrowing on `p.kind` get full per-variant typing without manual
 * casts. Adding an operator means: (1) define its schema above, (2) add
 * it to this union, (3) extend the type checker / XPath emitter / SQL
 * compiler.
 *
 * Drift policy — the four non-recursive arms (`comparisonSchema`,
 * `inSchema`, `withinDistanceSchema`, `fuzzySchema`) derive their TS
 * shape from their schema via `z.infer<typeof X>`, so adding a field
 * to those schemas updates the union automatically. The four recursive
 * arms (`and`, `or`, `not`, `when-input-present`) are hand-declared
 * because TypeScript cannot resolve `z.infer` through a
 * discriminated-union recursion cycle (Zod issue #4264). Adding a
 * field to one of those four schemas requires a parallel hand-update
 * to the matching arm here. Any required-field drift surfaces as a CI
 * failure (the schema rejects predicates that don't supply the field;
 * the test suite parses each arm). Optional-field drift is caught by
 * the structural assertion at the bottom of this file.
 */
export type Predicate =
	| z.infer<typeof comparisonSchema>
	| z.infer<typeof inSchema>
	| z.infer<typeof withinDistanceSchema>
	| z.infer<typeof fuzzySchema>
	// `clauses` is non-empty: tuple-with-rest in the schema (`andSchema`
	// / `orSchema`) and the matching `[Predicate, ...Predicate[]]` here
	// share one definition of "at least one clause" between the runtime
	// schema and the hand-declared TS shape. A consumer that reads
	// `p.clauses[0]` after narrowing on `kind` gets `Predicate`, not
	// `Predicate | undefined`.
	| { kind: "and"; clauses: [Predicate, ...Predicate[]] }
	| { kind: "or"; clauses: [Predicate, ...Predicate[]] }
	| { kind: "not"; clause: Predicate }
	| {
			kind: "when-input-present";
			input: SearchInputRef;
			clause: Predicate;
	  };

export const predicateSchema: z.ZodType<Predicate> = z.discriminatedUnion(
	"kind",
	[
		comparisonSchema,
		inSchema,
		withinDistanceSchema,
		fuzzySchema,
		andSchema,
		orSchema,
		notSchema,
		whenInputPresentSchema,
	],
);

// ---------- Drift guard ----------
//
// `_driftGuard` compares each recursive arm's non-recursive structural
// surface against its schema's `z.infer`. The recursive slots
// themselves (`clauses` on `and` / `or`, `clause` on `not` /
// `when-input-present`) cannot be compared via `z.infer` — through
// `z.lazy`, the inferred shape of the payload widens unpredictably
// across TS versions. So each arm is stripped of its recursive slot
// before comparison.
//
// Today, three of the four arms (`and`, `or`, `not`) have only their
// `kind` discriminator left after the strip, so the guard for those
// reduces to "the discriminator string matches itself." Only
// `when-input-present` has a non-discriminator non-recursive field
// (`input: SearchInputRef`), so it carries the actual structural
// check. The guard's value is forward-looking: if any future change
// adds a non-recursive field to one of these schemas (e.g.
// `andSchema` gains a `short_circuit?: boolean`), the corresponding
// arm's hand-declared shape must update or the guard fails. Catches
// additions, removals, and renames of non-recursive fields — exactly
// the drift path that the recursive-slot strip leaves uncovered.
//
// `_TypesEqual` is the standard TypeScript-FP pattern for strict
// structural equality (two types are considered equal iff a
// conditional indexing through one matches the other identically).
// Bidirectional `extends` is too loose — `{ a: string } extends
// { a: string; b?: number }` and the reverse are both true, so plain
// `extends` would silently allow optional-field drift. `_TypesEqual`
// is conservative: it treats `b?: number` as a structurally distinct
// type from "field absent", so optional additions/removals trip it.
//
// The recursive slot's CONTENT is pinned by parse tests in the
// adjacent test file (`not(...)` and `when-input-present(...)` parse
// nested predicates), so the only escape route this guard misses —
// a payload-shape change reachable only through recursion — is
// caught there.

type _TypesEqual<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

type _AndArm = Omit<Extract<Predicate, { kind: "and" }>, "clauses">;
type _OrArm = Omit<Extract<Predicate, { kind: "or" }>, "clauses">;
type _NotArm = Omit<Extract<Predicate, { kind: "not" }>, "clause">;
type _WhenInputPresentArm = Omit<
	Extract<Predicate, { kind: "when-input-present" }>,
	"clause"
>;

type _AndInferred = Omit<z.infer<typeof andSchema>, "clauses">;
type _OrInferred = Omit<z.infer<typeof orSchema>, "clauses">;
type _NotInferred = Omit<z.infer<typeof notSchema>, "clause">;
type _WhenInputPresentInferred = Omit<
	z.infer<typeof whenInputPresentSchema>,
	"clause"
>;

// `_driftGuard` is kept as a `const` declaration so the type assertion
// has a binding site — the four arm equality checks are evaluated at
// the binding's annotated type. If any of them resolves to `false`,
// the `{ and: true, or: true, not: true, whenInputPresent: true }`
// initializer fails to assign to the annotated type and CI catches
// it. Removing the const would lose the type-check site; the
// `_` prefix follows the convention for "type assertion that has no
// runtime role" in this codebase.
const _driftGuard: {
	and: _TypesEqual<_AndArm, _AndInferred>;
	or: _TypesEqual<_OrArm, _OrInferred>;
	not: _TypesEqual<_NotArm, _NotInferred>;
	whenInputPresent: _TypesEqual<
		_WhenInputPresentArm,
		_WhenInputPresentInferred
	>;
} = {
	and: true,
	or: true,
	not: true,
	whenInputPresent: true,
};
