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
// Recursive shape note: `and` / `or` / `not` / `when-input-present` /
// `exists` / `missing` reference the predicate union themselves. The
// cycle goes through a `z.discriminatedUnion(...)` (not a single
// self-referencing object), so the cleanest Zod 4 fallback documented
// for union recursion applies — each recursive slot wraps its
// predicate reference in `z.lazy(...)`, and `predicateSchema` carries
// an explicit `z.ZodType<Predicate>` annotation. The block below the
// operators explains why.

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
 * case-type scope and each subsequent step originates at the
 * destination of the previous step.
 *
 * `identifier` is constrained to XML element-name vocabulary so the
 * value can flow through wire emitters that interpolate it directly
 * into XPath path steps without quoting; `throughCaseType` is
 * constrained to CommCare's case-type vocabulary for the same
 * interpolation-safety reason. Source citations for the runtime
 * wire shape live in the file-level RelationPath comment above —
 * keeping them in one place avoids drift between the per-schema and
 * file-level copies.
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
 * `caseType` names the **originating case-type scope** — the case
 * type the predicate runs against, i.e. the case type at the
 * predicate's "self" position. It is NOT the case type the property
 * lives on when `via` is present. When `via` is absent or
 * `{ kind: "self" }`, the property is read directly on a case of
 * `caseType`. When `via` is a relation walk
 * (`ancestor` / `subcase` / `any-relation`), the walk resolves to a
 * destination case type and `property` semantically references the
 * property on that destination.
 *
 * Example: a predicate over the `patient` case list filtering by
 * `region` on the patient's `household` parent is
 * `prop("patient", "region", ancestorPath(relationStep("parent",
 * "household")))`. `caseType` is `patient` (originating scope);
 * `property` is `region` on the `household` destination reached via
 * the `parent` index hop.
 *
 * `caseType` is required even when `via` is present so the
 * originating scope is always explicit at the AST node — readers
 * don't have to trace back through nesting to recover it, and a
 * downstream consumer (type checker, emitter, SQL compiler) starts
 * its walk from a known root.
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
 * search input's runtime value (XPath:
 * `instance('search-input:results')/input/field[@name='<name>']`;
 * SQL: a bound parameter). The CCHQ search-input instance is
 * registered at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/instances.py:354`
 * and the canonical path is documented at
 * `commcare-hq/docs/case_search_query_language.rst:299`.
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

// ---------- Session refs (`/session/user/data/` and `/session/context/`) ----------
//
// CommCare's `commcaresession` instance carries TWO distinct trees under
// `/session/`, each with its own population mechanism and its own
// authoring contract. The split between these schemas matches the wire-
// shape split the framework imposes — collapsing both onto one term
// kind would let an author emit
// `instance('commcaresession')/session/user/data/userid`, which silently
// returns empty (the field is at `/session/context/userid`, not at
// `/session/user/data/userid`).
//
//   - `/session/user/data/<field>` is OPEN-NAMESPACE — populated by
//     `addUserProperties` in `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`.
//     `addUserProperties` iterates an arbitrary `userFields` Hashtable
//     and writes each key as a child of `<data>` under `<user>`, so any
//     custom user-data field name (e.g. `commcare_location_id`,
//     `commcare_project`, `is_supervisor`, `role`) round-trips through
//     it. `sessionUserSchema` matches this shape — `field` is open
//     XML-element-name vocabulary.
//
//   - `/session/context/<field>` is CLOSED-NAMESPACE — populated by
//     `addMetadata` in the same file. `addMetadata` writes exactly seven
//     fields (`deviceid`, `appversion`, `username`, `userid`, `drift`,
//     `window_width`, `applanguage`) and authoring-time names outside
//     that set don't resolve at the wire. `sessionContextSchema` matches
//     this shape with a closed `z.enum(SESSION_CONTEXT_FIELDS)`.
//
// The four-vs-seven narrowing decision is documented on
// `SESSION_CONTEXT_FIELDS` below.

/**
 * Closed set of `/session/context/<field>` entries that
 * `sessionContextSchema` exposes for authoring. The framework writes
 * seven entries total via `addMetadata` in
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`
 * (`deviceid`, `appversion`, `username`, `userid`, `drift`,
 * `window_width`, `applanguage`); v1 narrows to the four with clear
 * authoring semantics:
 *
 *   - `userid` — the canonical owner / current-user identifier;
 *     drives owner-keyed filters and case-claim flows.
 *   - `username` — display-name pairing with `userid` for UI surfaces
 *     that label the active user.
 *   - `deviceid` — supports device-targeting filters (e.g. surfacing
 *     a specific device's submissions in a sync-status case list).
 *   - `appversion` — supports version-gating filters (e.g.
 *     "show only cases on app version >= 2.0"); lexicographic compare
 *     is acceptable because CommCare app-version strings sort
 *     correctly under text ordering.
 *
 * The other three are intentionally excluded:
 *
 *   - `drift` is a diagnostic clock-skew signal with no authoring
 *     semantic — surfacing it as a filterable field would expose a
 *     diagnostic to the SA tool surface that authors have no reason
 *     to express against.
 *   - `window_width` is a UI-internal viewport metric used by the
 *     CommCare web client's responsive layout — not a stable
 *     case-data signal authors filter on.
 *   - `applanguage` is a localization concern; localization belongs
 *     in the form / module's translation surface, not in case-search
 *     filtering against an instance path.
 *
 * Pattern mirrors `MATCH_MODES` / `MULTI_SELECT_QUANTIFIERS` /
 * `DISTANCE_UNITS` / `COMPARISON_KINDS`: a closed `as const` tuple
 * feeds the schema via `z.enum(...)`, and `SessionContextField`
 * derives from the same source so authoring-time `field` values share
 * one declaration. Adding an entry — when a real authoring use case
 * surfaces — widens both surfaces simultaneously and is non-breaking
 * (every previously-valid AST stays valid; the enum just admits more
 * payloads).
 */
export const SESSION_CONTEXT_FIELDS = [
	"userid",
	"username",
	"deviceid",
	"appversion",
] as const;
export type SessionContextField = (typeof SESSION_CONTEXT_FIELDS)[number];

/**
 * Reference to an open-namespace custom user-data field on the current
 * session user (e.g. their assigned region, their CommCare project,
 * an organization-defined role).
 *
 * Wire path: `instance('commcaresession')/session/user/data/<field>`.
 * Population site: `addUserProperties` in
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`,
 * which writes an arbitrary `userFields` Hashtable as `<data>` children
 * under `<user>`. Field names are OPEN — any custom field a CommCare
 * project provisions on its users round-trips through this path. The
 * canonical `session_var` helper in
 * `commcare-hq/corehq/apps/app_manager/xpath.py` builds the same path
 * via `session_var(var, path='user/data')`.
 *
 * `field` is constrained to XML element-name vocabulary because the
 * wire form places the field as a literal XML element name in the
 * path step.
 */
export const sessionUserSchema = z.object({
	kind: z.literal("session-user"),
	field: xmlElementNameField("Session-user field"),
});
export type SessionUserRef = z.infer<typeof sessionUserSchema>;

/**
 * Reference to a closed-namespace framework-controlled context field on
 * the current session (e.g. the active user's `userid`, the current
 * `appversion`).
 *
 * Wire path: `instance('commcaresession')/session/context/<field>`.
 * Population site: `addMetadata` in
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`,
 * which writes exactly seven framework-defined fields under `<context>`.
 * Authoring-time field names outside the framework set don't resolve at
 * the wire, so `field` is constrained to the closed
 * `SESSION_CONTEXT_FIELDS` enum. CCHQ's `session_var(var,
 * path='context')` in `commcare-hq/corehq/apps/app_manager/xpath.py`
 * (one caller resolves the usercase via this path) is the production
 * helper that emits the same wire form.
 *
 * The closed set is documented on `SESSION_CONTEXT_FIELDS` above —
 * including which framework fields v1 intentionally excludes and why.
 */
export const sessionContextSchema = z.object({
	kind: z.literal("session-context"),
	field: z.enum(SESSION_CONTEXT_FIELDS),
});
export type SessionContextRef = z.infer<typeof sessionContextSchema>;

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
	sessionUserSchema,
	sessionContextSchema,
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
 *
 * The two-element list is a deliberate Nova narrowing of CCHQ's wider
 * unit vocabulary. CCHQ accepts nine units (`miles`, `yards`, `feet`,
 * `inch`, `kilometers`, `meters`, `centimeters`, `millimeters`,
 * `nauticalmiles` per
 * `commcare-hq/corehq/apps/es/queries.py:22-23`); Nova exposes the
 * two imperial/metric anchor units. Authors who need other units
 * coerce upstream of the AST.
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
 * Closed set of CCHQ text-match wire dispatches. Pattern mirrors
 * `COMPARISON_KINDS` and `DISTANCE_UNITS` above: a top-level `as
 * const` tuple feeds the schema via `z.enum(...)`, and `MatchMode`
 * derives from it so the builder's `mode` parameter shares this
 * single source of truth. Adding a mode here automatically widens
 * the builder's accepted argument set rather than requiring parallel
 * maintenance.
 *
 * Each mode maps to a CCHQ query function registered at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:39-54`:
 *
 *   - `fuzzy` → `fuzzy-match` (Elasticsearch `queries.fuzzy` against
 *     `PROPERTY_VALUE`, edit-distance match)
 *     — `query_functions.py:92-98`.
 *   - `phonetic` → `phonetic-match` (Soundex / metaphone-style match
 *     via `sounds_like_text_query`)
 *     — `query_functions.py:84-89`.
 *   - `fuzzy-date` → `fuzzy-date` (digit-permutation date match for
 *     transposed YYYY-MM-DD inputs)
 *     — `query_functions.py:101-113`.
 *   - `starts-with` → `starts-with` (`case_property_starts_with` →
 *     `prefix` filter on `PROPERTY_VALUE_EXACT`)
 *     — `query_functions.py:31-35` and `case_search.py:312-323`.
 */
export const MATCH_MODES = [
	"fuzzy",
	"phonetic",
	"fuzzy-date",
	"starts-with",
] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

/**
 * Closed set of multi-select containment quantifiers. Same
 * top-level-tuple-feeds-schema pattern as `MATCH_MODES` /
 * `COMPARISON_KINDS` / `DISTANCE_UNITS`. `any` maps to CCHQ's
 * `selected-any` (any token matches); `all` maps to `selected-all`
 * (every token matches). Both registered at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:44-45`
 * and dispatched through `_selected_query` →
 * `case_property_query(..., multivalue_mode='or' | 'and')` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:46-51`.
 */
export const MULTI_SELECT_QUANTIFIERS = ["any", "all"] as const;
export type MultiSelectQuantifier = (typeof MULTI_SELECT_QUANTIFIERS)[number];

/**
 * Approximate text match against a property's stored string value. The
 * `mode` discriminator (one of `MATCH_MODES`) selects the CCHQ wire
 * form — see `MATCH_MODES`'s JSDoc for per-mode source citations.
 *
 * The four modes share one operator (rather than four sibling
 * predicates) so the UI surface and the SA write the same shape and
 * toggle the dispatch via the discriminator. The single-operator design
 * also lets reductions / rewrites match on `kind: "match"` once
 * regardless of mode.
 *
 * Like `within-distance`, the `property` slot is constrained to a
 * direct property reference — text match against a literal or input is
 * meaningless.
 *
 * `value` is a string (not a term) — the predicate captures a static
 * match value baked at construction time. CCHQ's wire layer accepts
 * runtime substitution of search-input refs / user-context fields via
 * `unwrap_value` (`commcare-hq/corehq/apps/case_search/dsl_utils.py`),
 * so widening `value: termSchema` would have a wire target. The
 * narrowing here is a deliberate Nova-side AST scope decision — v1
 * authors reconstruct the predicate per input change rather than
 * driving the match value at runtime. Authors who need a dynamic match
 * value rebuild the predicate when the input changes.
 *
 * `value` is non-empty: `match(prop, "")` has no useful semantics.
 * Each CCHQ mode collapses an empty value to a different non-match —
 * `starts-with` is vacuously true (empty prefix matches every
 * property), `fuzzy-match` short-circuits to `case_property_missing`
 * (`case_property_query` in `commcare-hq/corehq/apps/es/case_search.py`,
 * the `value == ''` arm), `phonetic-match` matches nothing (empty
 * Elasticsearch `match` produces no tokens to score), `fuzzy-date`
 * depends on `date_permutations("")`. None expresses what an author
 * typing `match(prop, "")` intends; the "property is unset" operator
 * is `is-null(prop)`. Reject at the schema layer so emitters don't
 * carry per-mode policy.
 */
const matchSchema = z.object({
	kind: z.literal("match"),
	property: propertyRefSchema,
	value: z.string().min(1),
	mode: z.enum(MATCH_MODES),
});

/**
 * Multi-select containment predicate — "the multi_select property
 * contains some / all of these tokens." The `quantifier` discriminator
 * (one of `MULTI_SELECT_QUANTIFIERS`) picks between `selected-any` and
 * `selected-all`; see `MULTI_SELECT_QUANTIFIERS`'s JSDoc for source
 * citations.
 *
 * The schema keeps both quantifiers in one operator (rather than two
 * sibling predicates) so a UI surface or reducer toggling "any of" ↔
 * "all of" doesn't have to reshape the parent object. Reductions /
 * rewrites that care about either quantifier match on `kind:
 * "multi-select-contains"` once and dispatch on the payload field.
 *
 * `property` is constrained to a direct property reference — multi-
 * select containment against a literal or input has no useful
 * semantics. `values` is a non-empty list of literals (not arbitrary
 * terms) because both wire forms — `selected-any(prop, 'v1 v2')` /
 * expanded `selected(prop, 'v1') or selected(prop, 'v2')` on-device —
 * demand a static value list. Each literal carries the per-token value
 * a `selected*` call dispatches against the multi_select's stored
 * space-separated tokens.
 *
 * Empty-list rejection: the schema's tuple-with-rest shape rejects an
 * empty `values`. An empty `multi-select-contains` is trivially true
 * for `quantifier: "all"` (vacuous universal) and trivially false for
 * `quantifier: "any"` (vacuous existential), neither of which is a
 * useful authored predicate. The canonical authoring shape for "always
 * true" is `match-all` and for "always false" is `match-none`; reject
 * at the schema layer so downstream consumers don't see degenerate
 * payloads.
 *
 * All-null-list rejection: same defense `inSchema.values` carries.
 * Both wire targets collapse an all-null list to a duplicated "is
 * unset" predicate (the canonical `is-null(prop)` shape), so reject
 * here too. Source citations live next to the `.refine(...)` call
 * below.
 *
 * Wire-side whitespace tokenization on `values`: CCHQ's `selected-any`
 * / `selected-all` tokenize the values argument by whitespace at the
 * wire layer (`case_property_text_query` docstring at
 * `commcare-hq/corehq/apps/es/case_search.py:294-296` — "If the value
 * has multiple words, they will be OR'd together in this query"). A
 * literal like `"foo bar"` emits as `selected-any(prop, 'foo bar')`
 * and is expanded by CCHQ to "contains any of {foo, bar}" rather than
 * "contains the literal token 'foo bar'". Multi-select option values
 * rarely contain whitespace by convention, so this surfaces as a
 * caveat rather than a schema-level rejection — option vocabularies
 * legitimately can contain whitespace, and authors who need
 * space-bearing matches construct an `or`-of-`eq` predicate against
 * the property's `_value` storage rather than routing through
 * `multi-select-contains`.
 */
const multiSelectContainsSchema = z
	.object({
		kind: z.literal("multi-select-contains"),
		property: propertyRefSchema,
		// Tuple-with-rest produces `[Literal, ...Literal[]]` rather than
		// `Literal[]` — the same shape `inSchema.values` uses.
		// Construction-site object literals like
		// `{ kind: "multi-select-contains", ..., values: [] }` fail at
		// compile time rather than at parse. Indexed access on the
		// resulting type still yields `Literal` under the project's
		// current `tsconfig` (no `noUncheckedIndexedAccess`), so the
		// runtime parse rejection is what enforces non-empty at read
		// sites.
		values: z.tuple([literalSchema], literalSchema),
		quantifier: z.enum(MULTI_SELECT_QUANTIFIERS),
	})
	// All-null rejection mirrors `inSchema.values`'s defense: both wire
	// targets collapse an all-null list to a duplicated "is unset"
	// predicate, which is what the canonical `is-null(prop)` shape
	// expresses cleanly.
	//
	// CSQL: `case_property_query(name, '', multivalue_mode=...)`
	// short-circuits at `commcare-hq/corehq/apps/es/case_search.py:245-246`
	// to `case_property_missing(name)` — "the property is missing" —
	// before reaching the multivalue tokenization branch. Every null
	// literal lowers to the wire-form empty string at the term emitter,
	// so an all-null list never reaches the `selected-any` /
	// `selected-all` per-token logic; the entire predicate is a single
	// "is missing" check duplicated by `quantifier`'s OR / AND.
	//
	// On-device: `XPathSelectedFunc.multiSelected` at
	// `commcare-core/src/main/java/org/javarosa/xpath/expr/XPathSelectedFunc.java:38-54`
	// trims the candidate token before searching: with the candidate
	// trimming to the empty string, the substring test
	// `(" " + s1 + " ").contains(" " + "" + " ")` reduces to
	// `(" " + s1 + " ").contains("  ")`, which is true iff `s1` is the
	// empty string — i.e., the property is unset. OR / AND of identical
	// "property is unset" terms collapses to one "is unset" check.
	//
	// Both targets emit a duplicated "is unset" predicate for an all-
	// null shape, almost certainly an authoring bug; the canonical
	// shape for the same intent is `is-null(prop)`. Reject at the AST
	// layer so downstream consumers don't have to encode the policy.
	// Mixed null + non-null lists are accepted because they encode the
	// meaningful "is unset OR / AND has token X" predicate.
	.refine(
		(s) => s.values.some((v) => v.value !== null),
		"multi-select-contains.values must contain at least one non-null value",
	);

// ---------- Sentinel predicates ----------
//
// `match-all` and `match-none` are the boolean-algebra identity and
// absorbing elements — always-true and always-false predicates that
// carry no payload other than their discriminator. CCHQ exposes the
// same pair as zero-arg query functions registered at
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:52-53`
// and implemented at
// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:162-177`
// (each implementation rejects any argument with an
// `XPathFunctionException`).
//
// They exist as first-class AST nodes so a UI surface or reducer can
// produce a well-typed "empty filter" / "no matches" predicate without
// picking an arbitrary tautology / contradiction encoding (e.g.
// `eq(literal(1), literal(1))` for true). The schemas guarantee that
// the only way to construct one of these predicates is the canonical
// shape — a discriminator-only object — so consumers never have to
// recognise an alternate encoding.

const matchAllSchema = z.object({ kind: z.literal("match-all") });
const matchNoneSchema = z.object({ kind: z.literal("match-none") });

// ---------- Null-check predicate ----------
//
// `is-null` is the structural "left is unset" predicate — the
// canonical form a UI surface or compiler reaches for when asking
// "does the property carry a value?" Authoring it as a first-class
// AST node (rather than `eq(prop, literal(null))`) keeps the
// "is unset" intent explicit at every layer, so consumers don't have
// to recognise an alternate encoding to detect the canonical
// existence query.
//
// `left` is `termSchema`, not `propertyRefSchema`, so authors can
// express "is the input X unset" or "is the user's region unset"
// alongside the canonical "is the property unset" shape. The schema
// is intentionally structural-only: it admits every Term variant in
// `left` (including the meaningless `is-null(literal(...))` shape,
// which can't be "unset" by definition). Whether a checker rejects
// the literal shape is a type-checker concern, not a schema concern.

const isNullSchema = z.object({
	kind: z.literal("is-null"),
	left: termSchema,
});

// ---------- Range predicate ----------
//
// `between` is the structural range predicate — bounded interval on
// `left` with optional lower / upper bounds and per-bound inclusivity
// flags. Authoring the structural form (rather than a hand-written
// `and(gte, lte)`) keeps the inclusivity intent explicit at the AST
// node and lets a "show all configured ranges" UI surface match on
// `kind: "between"` directly rather than having to recognise the
// conjunction shape.
//
// `lower` / `upper` are optional `termSchema` (so a search-input or
// session-user reference can drive either bound). The
// `lowerInclusive` / `upperInclusive` slots are required booleans so
// the inclusivity is always explicit at the AST node and a reader
// doesn't have to infer from missing fields. The `.refine(...)`
// rejects the both-bounds-absent shape: a `between` with neither
// bound is equivalent to "always true" and the canonical shape for
// "always true" is `match-all`, so accepting the all-absent form
// would silently produce a duplicate representation.
//
// Bound ordering: when both bounds are literal-typed and `lower >
// upper`, the predicate is trivially false. The schema does NOT
// reject this case at parse time because bounds may also be
// search-input or user-context refs whose values aren't known until
// runtime — adding a literal-pair-only refinement here would either
// miss the term-pair case (silent wrong-answer in the runtime path)
// or reject term-pair shapes the schema must accept. Detection of
// the literal-pair impossibility is a type-checker rule (it has the
// type information to recognise the literal pair); the term-pair
// case is a runtime check. The schema's role here is structural
// only.

const betweenSchema = z
	.object({
		kind: z.literal("between"),
		left: termSchema,
		lower: termSchema.optional(),
		upper: termSchema.optional(),
		lowerInclusive: z.boolean(),
		upperInclusive: z.boolean(),
	})
	.refine(
		(v) => v.lower !== undefined || v.upper !== undefined,
		"between must have at least one bound (lower or upper)",
	);

// ---------- Recursive predicate operators ----------
//
// `and`, `or`, `not`, `when-input-present`, `exists`, and `missing`
// reference the predicate union themselves. (`exists` and `missing`
// recurse through their optional `where` slot, which evaluates a
// nested predicate in the destination scope of `via`; their schemas
// live in their own block below this one because they share a
// `via: relationPathSchema` shape, but they go through the same
// `z.lazy` chain documented here.) Two distinct constraints converge
// here:
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
//      (Zod issue #5035 details the TS 5.9+ behavior). The recursive
//      arms of `Predicate` are therefore hand-declared, and
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

// ---------- Relational quantifiers ----------
//
// `exists` and `missing` are the relational quantifiers — "at least
// one related case satisfies `where`" / "no related case satisfies
// `where`". `via` is a `RelationPath` (the four-kind discriminator
// declared above); `where` is an optional nested predicate evaluated
// in the destination scope of the walk. When `where` is absent, the
// predicate degenerates to "any related case exists" / "no related
// case exists".
//
// CCHQ exposes the corresponding query functions in two spots:
//   - `subcase-exists` at
//     `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py:51-62`.
//     It accepts a one-or-two-argument form — the filter argument is
//     optional per the parser at
//     `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py:207`.
//   - `ancestor-exists` at
//     `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py:97-118`.
//     It unconditionally requires two arguments (the implementation
//     calls `confirm_args_count(node, 2)`).
//
// The asymmetry — `subcase-exists` accepting the no-filter shape,
// `ancestor-exists` not — sits at the CCHQ wire boundary, not at this
// AST. The schema keeps `where` optional uniformly across both kinds
// because the AST-level semantic contract ("filter the related cases
// by an additional predicate") is the same regardless of how each
// downstream wire target represents it.
//
// `where` is recursive (a nested predicate evaluated in the
// destination scope), so it goes through the same
// `z.lazy(() => predicateSchema)` pattern as `andSchema.clauses` /
// `notSchema.clause` / `whenInputPresentSchema.clause`. `via`
// references `relationPathSchema` directly because the relation-path
// union is fully resolved above this point and carries no
// `predicateSchema` reference (it never embeds a predicate).

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

/**
 * The full predicate union, discriminated on `kind` — consumers
 * narrowing on `p.kind` get full per-variant typing without manual
 * casts. Adding an operator means: (1) define its schema above, (2) add
 * it to this union, (3) extend the type checker / XPath emitter / SQL
 * compiler.
 *
 * Drift policy — non-recursive arms (`comparisonSchema`, `inSchema`,
 * `withinDistanceSchema`, `matchSchema`, `multiSelectContainsSchema`,
 * `matchAllSchema`, `matchNoneSchema`, `isNullSchema`, `betweenSchema`)
 * derive their TS shape from their schema via `z.infer<typeof X>`, so
 * adding a field to those schemas updates the union automatically.
 * Recursive arms (`and`, `or`, `not`, `when-input-present`, `exists`,
 * `missing`) are hand-declared because TypeScript cannot resolve
 * `z.infer` through a discriminated-union recursion cycle (Zod issue
 * #4264). Adding a field to one of the recursive schemas requires a
 * parallel hand-update to the matching arm here. Any required-field
 * drift surfaces as a CI failure (the schema rejects predicates that
 * don't supply the field; the test suite parses each arm). Optional-
 * field drift on the recursive arms is caught by the structural
 * assertion at the bottom of this file.
 */
export type Predicate =
	| z.infer<typeof comparisonSchema>
	| z.infer<typeof inSchema>
	| z.infer<typeof withinDistanceSchema>
	| z.infer<typeof matchSchema>
	| z.infer<typeof multiSelectContainsSchema>
	| z.infer<typeof matchAllSchema>
	| z.infer<typeof matchNoneSchema>
	| z.infer<typeof isNullSchema>
	| z.infer<typeof betweenSchema>
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
	  }
	// `exists` / `missing` are recursive through the optional `where`
	// slot — a nested predicate evaluated in the destination scope of
	// `via`. The hand-declared shape mirrors the schema: `where?` is
	// optional (so the absent-key contract holds across the round-trip)
	// and `via: RelationPath` carries the structural traversal kind.
	| { kind: "exists"; via: RelationPath; where?: Predicate }
	| { kind: "missing"; via: RelationPath; where?: Predicate };

export const predicateSchema: z.ZodType<Predicate> = z.discriminatedUnion(
	"kind",
	[
		comparisonSchema,
		inSchema,
		withinDistanceSchema,
		matchSchema,
		multiSelectContainsSchema,
		matchAllSchema,
		matchNoneSchema,
		isNullSchema,
		betweenSchema,
		andSchema,
		orSchema,
		notSchema,
		whenInputPresentSchema,
		existsSchema,
		missingSchema,
	],
);

// ---------- Drift guard ----------
//
// `_driftGuard` compares each recursive arm's non-recursive structural
// surface against its schema's `z.infer`. The recursive slots
// themselves (`clauses` on `and` / `or`, `clause` on `not` /
// `when-input-present`, `where` on `exists` / `missing`) cannot be
// compared via `z.infer` — through `z.lazy`, the inferred shape of
// the payload widens unpredictably across TS versions. So each arm is
// stripped of its recursive slot before comparison.
//
// Three of the six arms (`and`, `or`, `not`) have only their `kind`
// discriminator left after the strip, so the guard for those reduces
// to "the discriminator string matches itself." `when-input-present`
// retains `input: SearchInputRef` as its non-recursive structural
// surface; `exists` and `missing` retain `via: RelationPath` (the
// relation-path union is non-recursive — it never embeds a
// predicate — so its full structure is part of the compared
// surface). The guard's value is forward-looking: if any future
// change adds a non-recursive field to one of these schemas (e.g.
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
// adjacent test file — `not(...)`, `when-input-present(...)`,
// `exists(...).where`, and `missing(...).where` each parse nested
// predicates, so the only escape route this guard misses — a
// payload-shape change reachable only through recursion — is caught
// there.

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
type _ExistsArm = Omit<Extract<Predicate, { kind: "exists" }>, "where">;
type _MissingArm = Omit<Extract<Predicate, { kind: "missing" }>, "where">;

type _AndInferred = Omit<z.infer<typeof andSchema>, "clauses">;
type _OrInferred = Omit<z.infer<typeof orSchema>, "clauses">;
type _NotInferred = Omit<z.infer<typeof notSchema>, "clause">;
type _WhenInputPresentInferred = Omit<
	z.infer<typeof whenInputPresentSchema>,
	"clause"
>;
type _ExistsInferred = Omit<z.infer<typeof existsSchema>, "where">;
type _MissingInferred = Omit<z.infer<typeof missingSchema>, "where">;

// `_driftGuard` is kept as a `const` declaration so the type assertion
// has a binding site — the per-arm equality checks are evaluated at
// the binding's annotated type. If any of them resolves to `false`,
// the initializer fails to assign to the annotated type and CI
// catches it. Removing the const would lose the type-check site; the
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
	exists: _TypesEqual<_ExistsArm, _ExistsInferred>;
	missing: _TypesEqual<_MissingArm, _MissingInferred>;
} = {
	and: true,
	or: true,
	not: true,
	whenInputPresent: true,
	exists: true,
	missing: true,
};
