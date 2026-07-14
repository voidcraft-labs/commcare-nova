// lib/domain/predicate/types.ts
//
// Two-family AST: the boolean-valued **Predicate** family and the
// value-bearing **ValueExpression** family. Together they form the
// authoring source of truth for every filter, sort key, calculated
// column, search-input default, and default search filter in the case-
// list and search system. Compiled to CommCare XPath/CSQL at HQ wire
// emission and to Kysely query-builder calls at runtime — never
// round-tripped through strings.
//
// Why an AST instead of strings: every authored predicate or
// expression must compile to two different targets (CommCare
// XPath/CSQL going up to HQ, Kysely SQL running locally) AND drive an
// editing UI. A string-only representation would force a parser at
// every boundary; storing the AST keeps each surface as a one-way
// emitter and locks the semantics in one place. Concretely, this is
// the structural defense against the accretion-and-untyped-strings
// pattern that produced CommCare HQ's case-search XPath dialect over
// 25 years — every new capability there became another function added
// to the same untyped expression language. By forcing every authored
// predicate / expression through this typed AST, that pattern is
// structurally prevented here.
//
// Why one package, not two: predicates ARE expressions that resolve
// to boolean — they are the boolean-typed arm of the broader
// expression family. Predicate operators carry `ValueExpression`
// operands so an arithmetic expression can drive a comparison
// (`gt(add(prop, literal(1)), literal(5))`); `ValueExpression` arms
// like `if` / `switch` / `count` carry `Predicate` clauses so a
// boolean condition can drive a value selection. The two families
// reference each other through `z.lazy(...)` within this single
// module, the canonical Zod pattern for self-recursion through
// discriminated unions; collapsing them into one module eliminates
// the cross-package z.lazy that an earlier shape needed and lets
// every consumer import both families through one barrel. The Term
// shapes are shared verbatim between the families — a `case-property`
// term, a `search-input` term, a `session-context` term, a typed
// literal — and the ValueExpression's `term` arm is the structural
// lifter that admits any Term where a value is expected.
//
// The AST uses Zod-discriminated unions on a `kind` field, matching
// Nova's existing patterns (see `lib/domain/fields/index.ts` for the
// flagship example). New operators are explicit additions to the
// union; behavior is never tucked under existing kinds via hidden
// state.
//
// Recursive shape note: both unions carry self-recursive arms (`and`
// / `or` / `not` / `when-input-present` / `exists` / `missing` on the
// Predicate side; `arith` / `concat` / `if` / `switch` / `count` /
// `unwrap-list` / `format-date` / `date-add` / `date-coerce` /
// `datetime-coerce` / `double` / `coalesce` / `term` on the
// ValueExpression side, with `if` / `switch` / `count` also crossing
// into Predicate). Every cycle goes through a
// `z.discriminatedUnion(...)` (not a single self-referencing object),
// so the cleanest Zod 4 fallback documented for union recursion
// applies — each recursive slot wraps its schema reference in
// `z.lazy(...)`, and each union schema carries an explicit
// `z.ZodType<...>` annotation. The block above each schema's union
// declaration explains why.

import { z } from "zod";
// Imported from the leaf at `../casePropertyTypes` (not
// `../blueprint`) to avoid a cycle: `blueprint.ts` imports
// `moduleSchema`, which imports `predicateSchema` /
// `valueExpressionSchema` from this file, which would in turn
// import back into `blueprint.ts` and break module-load order.
import { casePropertyDataTypeSchema } from "../casePropertyTypes";

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
// (the `noRestrictedImports` rule's scope excludes `__tests__/**`)
// and asserts the inlined patterns' `.source` equals the canonical
// constants' `.source`. If the source-of-truth constants are
// updated, the test fails until the inlined copies here are updated
// to match. Each pattern is exported below so the guard test can
// compare it.

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
 * element-name vocabulary — search-input names, session-user fields,
 * and relation identifiers all draw from this closed set. Hyphens are
 * NOT permitted; see the JSDoc on `XML_ELEMENT_NAME_PATTERN` for the
 * vocabulary divergence rationale. The closed-enum `session-context`
 * arm uses `z.enum(SESSION_CONTEXT_FIELDS)` directly and does NOT flow
 * through this helper — its field set is the framework-controlled
 * narrowing in `types.ts`, not an open identifier vocabulary.
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
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`,
// `ancestor_functions.py::walk_ancestor_hierarchy`, and
// `subcase_functions.py::subcase`.
// The Postgres dialect lowers to a JOIN on the `case_indices` table.
//
// The four kinds (`self`, `ancestor`, `subcase`, `any-relation`) capture
// the direction of the walk — no traversal, up via parent/host index,
// down via reverse index, or unknown direction. They do NOT encode
// CommCare's relationship-id (CHILD = 1, EXTENSION = 2 at
// `commcare-hq/corehq/form_processor/models/cases.py::CommCareCaseIndex`); the
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
export const relationStepSchema = z
	.object({
		identifier: xmlElementNameField("Relation identifier"),
		throughCaseType: caseTypeField("Through case type").optional(),
	})
	.strict();
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
	z.object({ kind: z.literal("self") }).strict(),
	z
		.object({
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
		})
		.strict(),
	z
		.object({
			kind: z.literal("subcase"),
			identifier: xmlElementNameField("Subcase identifier"),
			ofCaseType: caseTypeField("Of case type").optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("any-relation"),
			identifier: xmlElementNameField("Relation identifier"),
			ofCaseType: caseTypeField("Of case type").optional(),
		})
		.strict(),
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
export const propertyRefSchema = z
	.object({
		kind: z.literal("prop"),
		caseType: caseTypeField("Case type"),
		property: casePropertyField("Property name"),
		via: relationPathSchema.optional(),
	})
	.strict();
export type PropertyRef = z.infer<typeof propertyRefSchema>;

/**
 * Reference to a value the user typed into a search input on the
 * case-search screen. Resolved at compile time by mapping `name` to the
 * search input's runtime value (XPath:
 * `instance('search-input:results')/input/field[@name='<name>']`;
 * SQL: a bound parameter). The CCHQ search-input instance is
 * registered at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/instances.py::search_input_instances`
 * and the canonical path is documented at
 * `commcare-hq/docs/case_search_query_language.rst`.
 *
 * `name` is constrained to XML element-name vocabulary (no hyphens) —
 * the wire form `<input>/<field @name='...'>` makes the name surface
 * as an XML attribute value, but downstream code paths that derive
 * structural identifiers from the input name still rely on element-
 * name shape, so the schema rejects hyphens here.
 */
export const searchInputRefSchema = z
	.object({
		kind: z.literal("input"),
		name: xmlElementNameField("Search input name"),
	})
	.strict();
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
 *     drives owner-keyed filters and other current-user-scoped
 *     comparisons.
 *   - `username` — display-name pairing with `userid` for UI surfaces
 *     that label the active user.
 *   - `deviceid` — supports device-targeting filters (e.g. surfacing
 *     a specific device's submissions in a sync-status case list).
 *   - `appversion` — supports version-gating filters. The wire is a
 *     string at `/session/context/appversion`, and lexicographic is
 *     the only ordering CCHQ exposes against it: there is no
 *     semantic-version-aware comparator at the wire layer. Authors
 *     who write `appversion >= '2.10'` to gate "version 2.10 or
 *     newer" should know that lex compare ranks `'10.0' < '2.0'`
 *     (because `'1' < '2'`) and `'2.53.0' < '2.9.0'` — the wire
 *     answer disagrees with semver intuition once digit counts
 *     diverge. Authors who need a semver-correct gate compose
 *     multiple comparisons (e.g. by exact-matching the major /
 *     minor segments). Authoring-time correctness for version
 *     gating is a validator concern; the type checker's job here
 *     is only to resolve the term to its wire type.
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
export const sessionUserSchema = z
	.object({
		kind: z.literal("session-user"),
		field: xmlElementNameField("Session-user field"),
	})
	.strict();
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
export const sessionContextSchema = z
	.object({
		kind: z.literal("session-context"),
		field: z.enum(SESSION_CONTEXT_FIELDS),
	})
	.strict();
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
export const literalSchema = z
	.object({
		kind: z.literal("literal"),
		value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
		data_type: casePropertyDataTypeSchema.optional(),
	})
	.strict();
export type Literal = z.infer<typeof literalSchema>;

export const termSchema = z.discriminatedUnion("kind", [
	propertyRefSchema,
	searchInputRefSchema,
	sessionUserSchema,
	sessionContextSchema,
	literalSchema,
]);
export type Term = z.infer<typeof termSchema>;

// ---------- ValueExpression operators (anything that resolves to a value) ----------
//
// `ValueExpression` is the value-bearing sister AST to `Predicate`.
// Every value slot in the system — calculated-column expressions,
// search-input defaults, sort-calculation keys, the date argument to
// the late-flag column, the source of an ID-mapping column,
// arithmetic / conditional operands inside a Predicate's comparison
// — composes through this union. The discriminator carries the
// operator name; arms split by structural shape rather than by output
// type so the schema can validate each arm's per-operator rules
// independently of the type checker (which adds the
// type-compatibility layer).
//
// **The 14 arms:**
//
//   - `term` — structural lifter for any `Term`. Lets a property /
//     input / session ref / literal flow through any value slot.
//   - `today` / `now` — discriminator-only date / datetime constants.
//     `today` resolves to the project-timezone ISO date; `now` resolves
//     to the UTC ISO datetime.
//   - `date-add` — `date + (interval × quantity)` arithmetic. Wire
//     emission diverges per dialect: CSQL emits the named `date-add`
//     value function; the on-device dialect supports day-only
//     intervals via XPath operator arithmetic and rejects month / year
//     intervals at the representability checker.
//   - `date-coerce` / `datetime-coerce` — string → typed date /
//     datetime via CommCare's wire `date(...)` / `datetime(...)`
//     value functions.
//   - `double` — forced numeric coercion via CSQL's `double(...)`
//     value function, matching CCHQ's wire form.
//   - `arith` — five-op numeric arithmetic (`+` / `-` / `*` / `div` /
//     `mod`), the CCHQ-vocabulary names. The discriminator collapses
//     all five into one arm because the operand shape is identical
//     and the wire emission is symmetric.
//   - `concat` — variadic string concatenation. Each part casts to
//     text at evaluation time.
//   - `coalesce` — first-non-empty fallback chain. Empty values
//     coerce to null at evaluation time, so every dialect's evaluator
//     short-circuits on the first non-null / non-empty input.
//   - `if` — boolean conditional with eager evaluation of both
//     branches. The condition is a `Predicate` (cross-family
//     reference); the branches are `ValueExpression`.
//   - `switch` — value-driven multi-case selector. The discriminator
//     value (`on`) compares against each case's `when` literal; the
//     first match wins. `fallback` is the no-match value.
//   - `count` — relational aggregation. Returns the cardinality of
//     cases reachable along `via` whose `where` predicate (optional)
//     holds. The "value, not predicate" decision lets `count(...) > 2`
//     compose naturally as `gt(count(...), literal(2))` rather than
//     a special-case predicate.
//   - `unwrap-list` — CSQL's `unwrap-list` value function: pull a
//     JSON-encoded array stored in a property and surface it as a
//     sequence of values. v1 has no AST consumer for the resulting
//     sequence type — `multi-select-contains.values` and `in.values`
//     stay literal-only because the wire targets demand a static
//     value list — but the arm is part of the persisted-shape
//     contract, so it lives in the AST today. The CSQL wire emitter
//     routes it into `selected-any(prop, unwrap-list(...))` at the
//     wire-emission boundary.
//   - `format-date` — date / datetime → text via CommCare's
//     `format-date(date, pattern)`. The pattern slot accepts the
//     three preset names (`short` / `long` / `iso`) plus an arbitrary
//     pattern string for advanced authors.
//
// **Cross-family cycle:** the `if` and `switch` arms carry
// `Predicate` operands (`cond` and `cases[].when` respectively, with
// `count.where` also predicate-typed), and Predicate operator schemas
// below (the eight widened operand sites — see the next section)
// carry `ValueExpression` operands. The cycle goes through
// `z.lazy(...)` on every cross-reference: each ValueExpression arm
// that references `predicateSchema` wraps the reference in
// `z.lazy(() => predicateSchema)`, and each Predicate operator arm
// that references `valueExpressionSchema` wraps it in
// `z.lazy(() => valueExpressionSchema)`. Self-recursion within
// ValueExpression follows the same pattern (`z.lazy(() =>
// valueExpressionSchema)` for `arith.left` etc.). Every cycle
// resolves at first-parse time, when both `const` bindings are
// complete; declaration order in the file does not matter for the
// cycle, only for `discriminatedUnion(...)`'s eager arm-shape read.

/**
 * Closed set of `arith` operators. CCHQ's wire vocabulary names —
 * `+` / `-` / `*` are the standard XPath arithmetic operators; `div`
 * and `mod` use the CCHQ-style spelled-out names rather than `/`
 * (the XPath path separator) and `%` (which has no XPath meaning).
 * Authors compose `arith(prop, literal(1), "+")` rather than parsing
 * an infix expression.
 *
 * Pattern mirrors `COMPARISON_KINDS` / `MATCH_MODES` /
 * `MULTI_SELECT_QUANTIFIERS` / `DISTANCE_UNITS` — a top-level `as
 * const` tuple feeds the schema via `z.enum(...)`, and `ArithOp`
 * derives from the same source so authoring-time `op` values share
 * one declaration.
 */
export const ARITH_OPS = ["+", "-", "*", "div", "mod"] as const;
export type ArithOp = (typeof ARITH_OPS)[number];

/**
 * Closed set of `date-add` interval kinds. The canonical CCHQ value-
 * function set verified at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
 * — CSQL accepts each via the `date-add` / `datetime-add` value
 * functions; the on-device dispatcher does not register a handler
 * (the representability checker rejects non-day intervals for
 * on-device emission, and the on-device emitter falls back to
 * XPath operator arithmetic for `days`-only).
 *
 * Same `as const` pattern as `ARITH_OPS`. Adding an interval here
 * widens the schema's `interval` enum; the on-device emitter and
 * the representability checker both have to grow new arms in
 * lockstep, surfaced via the exhaustive switch over `DATE_ADD_INTERVALS`.
 */
export const DATE_ADD_INTERVALS = [
	"seconds",
	"minutes",
	"hours",
	"days",
	"weeks",
	"months",
	"years",
] as const;
export type DateAddInterval = (typeof DATE_ADD_INTERVALS)[number];

/**
 * Closed set of preset `format-date` patterns. The three preset names
 * are CommCare's wire-vocabulary aliases — `short` (locale-default
 * short form), `long` (locale-default long form), `iso` (ISO 8601
 * date-only). Authors who need a custom pattern pass an arbitrary
 * string at the `format-date` builder, which the schema admits via
 * the `string` branch of the `pattern` union.
 *
 * Surfacing the preset names as a closed enum lets the type checker
 * recognise the canonical patterns and lets a UI surface render
 * them as preset-card affordances rather than free-text inputs. The
 * arbitrary-string branch retains the full CCHQ pattern vocabulary
 * for advanced cases.
 */
export const FORMAT_DATE_PRESETS = ["short", "long", "iso"] as const;
export type FormatDatePreset = (typeof FORMAT_DATE_PRESETS)[number];

// ---------- ValueExpression arm schemas ----------
//
// Each operator's schema lives below as a named `const`, mirroring
// the per-arm pattern Predicate operators use. ValueExpression-side
// recursion (`arith.left` references `valueExpressionSchema`,
// `if.then` references `valueExpressionSchema`, etc.) wraps the
// reference in `z.lazy(...)`. Cross-family recursion into
// `predicateSchema` (the `if.cond`, `switch.cases[].when` (literal,
// not predicate — see below), `count.where` slots) wraps via
// `z.lazy(() => predicateSchema)`.
//
// Why one schema per operator instead of inlining them in the
// `discriminatedUnion(...)` call: same as the Predicate side —
// `z.discriminatedUnion` requires each member to be a single object
// schema carrying the discriminant key. Defining each as a named
// const keeps the union list readable and lets each operator's
// contract live next to its discriminator declaration.

/**
 * Structural lifter: any `Term` becomes a `ValueExpression` of
 * `kind: "term"`. Builders auto-wrap Term-shaped inputs at the
 * call site (see `builders.ts:toValueExpression`), so authors call
 * `eq(prop("name"), literal("Alice"))` and the predicate's
 * `left` / `right` slots receive a ValueExpression-of-Term without
 * an explicit wrapper. The arm exists in the schema so the wire
 * emitters and the type checker have a single dispatch shape on
 * the value side.
 */
const valueExpressionTermSchema = z
	.object({
		kind: z.literal("term"),
		term: termSchema,
	})
	.strict();

const todaySchema = z.object({ kind: z.literal("today") }).strict();
const nowSchema = z.object({ kind: z.literal("now") }).strict();

const dateAddSchema = z
	.object({
		kind: z.literal("date-add"),
		date: z.lazy(() => valueExpressionSchema),
		interval: z.enum(DATE_ADD_INTERVALS),
		quantity: z.lazy(() => valueExpressionSchema),
	})
	.strict();

const dateCoerceSchema = z
	.object({
		kind: z.literal("date-coerce"),
		value: z.lazy(() => valueExpressionSchema),
	})
	.strict();

const datetimeCoerceSchema = z
	.object({
		kind: z.literal("datetime-coerce"),
		value: z.lazy(() => valueExpressionSchema),
	})
	.strict();

const doubleSchema = z
	.object({
		kind: z.literal("double"),
		value: z.lazy(() => valueExpressionSchema),
	})
	.strict();

const arithSchema = z
	.object({
		kind: z.literal("arith"),
		op: z.enum(ARITH_OPS),
		left: z.lazy(() => valueExpressionSchema),
		right: z.lazy(() => valueExpressionSchema),
	})
	.strict();

/**
 * `concat`'s `parts` is a non-empty list. An empty `concat()` is the
 * empty string — the canonical authoring shape for that intent is
 * `literal("")`, so reject the degenerate shape at the schema. The
 * tuple-with-rest produces `[ValueExpression, ...ValueExpression[]]`
 * rather than `ValueExpression[]`, so construction-site object
 * literals like `{ kind: "concat", parts: [] }` fail at compile time
 * rather than only at parse — same defense `andSchema.clauses` uses.
 */
const concatSchema = z
	.object({
		kind: z.literal("concat"),
		parts: z.tuple(
			[z.lazy(() => valueExpressionSchema)],
			z.lazy(() => valueExpressionSchema),
		),
	})
	.strict();

/**
 * `coalesce`'s `values` is non-empty for the same reason `concat.parts`
 * is — an empty `coalesce()` has no fallback to return; the canonical
 * shape for "always null" is `literal(null)`, which the schema admits
 * via the `term` arm. Tuple-with-rest enforces the constraint at the
 * type layer.
 */
const coalesceSchema = z
	.object({
		kind: z.literal("coalesce"),
		values: z.tuple(
			[z.lazy(() => valueExpressionSchema)],
			z.lazy(() => valueExpressionSchema),
		),
	})
	.strict();

/**
 * Conditional value selection. `cond` is a `Predicate`; both
 * branches are `ValueExpression`. CCHQ's on-device wire form is
 * `if(cond, then, else)`; CSQL has no native `if` value function,
 * so the CSQL wire emitter hoists `if` arms out of CSQL fragments
 * at the wire-emission boundary. The branch slot names are `then`
 * and `else` — `else` is a JS reserved word in statement positions,
 * but both are legal property names everywhere this AST surfaces.
 *
 * `then`-property hazard explained: Biome's `noThenProperty` rule
 * defends against accidentally creating a thenable that
 * `Promise.resolve(...)` would mistake for a Promise. The hazard
 * requires `then` to be a *callable function* — the resolver checks
 * `IsCallable(then)` before scheduling a thenable resolution
 * (per ECMAScript §27.2.1.4 and the Promises/A+ §2.3.3.3 protocol).
 * Our `then` slot holds a `ValueExpression` object whose `kind`
 * discriminator is one of fifteen non-function shapes; neither the
 * schema nor the inferred type admits a function in this slot. The
 * AST objects also never reach a Promise-resolution boundary —
 * predicates and expressions are typed AST values manipulated via
 * builders, the validator, and wire emitters, none of which await
 * an AST node. Suppressing the rule preserves the authored
 * vocabulary `{ cond, then, else }` at the AST without forcing a
 * downstream rename pass at every consumer.
 */
const ifSchema = z
	.object({
		kind: z.literal("if"),
		cond: z.lazy(() => predicateSchema),
		// biome-ignore lint/suspicious/noThenProperty: `then` is a ValueExpression object (never callable); see the JSDoc above for the full thenable-hazard analysis.
		then: z.lazy(() => valueExpressionSchema),
		else: z.lazy(() => valueExpressionSchema),
	})
	.strict();

/**
 * Single switch-case shape — a `when` literal compared against the
 * outer `switch.on` value, plus the `then` value selected when the
 * comparison succeeds. `when` is a `Literal`, not an arbitrary term
 * or expression: every CCHQ wire form for switch-style dispatch
 * compiles to nested `if(value = literal, then, ...)` chains, which
 * demand a static value at each comparison site. The Postgres
 * compiler emits `CASE WHEN value = literal THEN then ... END` with
 * the same constraint.
 *
 * `then`-property hazard explained: same analysis as `ifSchema.then`
 * — the slot holds a `ValueExpression` object (one of fifteen
 * non-function shapes), never a callable function, and the AST
 * objects never reach a Promise-resolution boundary. The
 * `noThenProperty` lint rule defends against an unrelated thenable-
 * hazard pattern; the suppression here preserves the
 * `{ when, then }` shape at the AST.
 */
const switchCaseSchema = z
	.object({
		when: literalSchema,
		// biome-ignore lint/suspicious/noThenProperty: `then` is a ValueExpression object (never callable); see `ifSchema`'s JSDoc for the full thenable-hazard analysis.
		then: z.lazy(() => valueExpressionSchema),
	})
	.strict();

/**
 * Value-driven multi-case selector. `on` is the discriminator value;
 * `cases[].when` literals are compared against it in order; the
 * first match wins. `fallback` runs when no case matches. `cases`
 * is non-empty for the same reason `concat.parts` is — an empty
 * `cases` list collapses to `fallback`, and the canonical shape for
 * that is `fallback` directly.
 */
const switchSchema = z
	.object({
		kind: z.literal("switch"),
		on: z.lazy(() => valueExpressionSchema),
		cases: z.tuple([switchCaseSchema], switchCaseSchema),
		fallback: z.lazy(() => valueExpressionSchema),
	})
	.strict();

/**
 * Relational aggregation: count related cases reachable along `via`
 * whose optional `where` predicate holds. `via` is a `RelationPath`
 * (the four-kind discriminator declared above this section); `where`
 * is an optional nested predicate evaluated in the destination scope
 * of the walk (same shape `existsSchema.where` carries below).
 *
 * The "count is a value, not a predicate" decision lets the natural
 * compositions land cleanly: `gt(count(via), literal(2))`,
 * `eq(count(via), prop("expected_visits"))`. CCHQ's wire `subcase-count`
 * is recognised only as the LHS of a binary comparison
 * (`commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`
 * via `_is_subcase_count`), so a `count(...)` outside
 * a comparison context is unrepresentable in CSQL — the
 * representability checker flags this at authoring time. The
 * Postgres compiler executes the count natively in any value
 * position.
 */
const countSchema = z
	.object({
		kind: z.literal("count"),
		via: relationPathSchema,
		where: z.lazy(() => predicateSchema).optional(),
	})
	.strict();

/**
 * CSQL's `unwrap-list` value function: pull a JSON-encoded array
 * stored in a property's value and surface it as a sequence of
 * values. The wire form is one of the eight CSQL value functions
 * registered on
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
 *
 * v1 has no AST consumer for the resulting sequence type —
 * `in.values` and `multi-select-contains.values` stay literal-only
 * because every wire target demands a static value list. The CSQL
 * emitter routes `unwrap-list` into `selected-any(prop,
 * unwrap-list(...))` at the wire-emission boundary. The type
 * checker stages a `"sequence"` resolved-type sentinel (see
 * `typeChecker.ts`) so the arm has a defined verdict even though
 * no current operator consumes the result; the sentinel lets a
 * future widening of the consuming surface thread the sequence
 * type through without re-wiring the type checker's compatibility
 * table.
 */
const unwrapListSchema = z
	.object({
		kind: z.literal("unwrap-list"),
		value: z.lazy(() => valueExpressionSchema),
	})
	.strict();

/**
 * `format-date(date, pattern)`. The `pattern` union accepts the three
 * preset names (`short` / `long` / `iso`) plus an arbitrary string
 * for advanced patterns. The schema's `union` over `enum` + `string`
 * is structural: at runtime, the preset enum branch matches first
 * and an arbitrary string falls through to the `string` branch.
 * Authors who type a preset name spelled correctly hit the enum
 * branch (and a UI surface can render them as known-pattern chips);
 * everything else lands as a free-text custom pattern.
 *
 * The pattern slot is non-empty: `format-date(date, "")` is
 * meaningless on every CCHQ dialect.
 */
const formatDateSchema = z
	.object({
		kind: z.literal("format-date"),
		date: z.lazy(() => valueExpressionSchema),
		pattern: z.union([z.enum(FORMAT_DATE_PRESETS), z.string().min(1)]),
	})
	.strict();

// ---------- Predicate operators (anything that resolves to a boolean) ----------

/**
 * Comparison operators. Keeping them in a single tuple lets the schema
 * narrow them collectively (`z.enum(COMPARISON_KINDS)`) and lets the
 * compilers iterate the set when emitting (one mapping table for all
 * six). Strict ordering doesn't matter — the type checker treats the
 * set as semantically equivalent up to operand-type rules.
 *
 * The enum collapse is correct *only because all six share the same
 * operand shape* (`left` / `right`, both `valueExpressionSchema`). If
 * a future operator needs an asymmetric field — e.g. `case_sensitive`
 * only on `eq`/`neq` — split the enum back into per-literal arms (one
 * `z.object` per operator) rather than tacking optional fields onto
 * this schema. Smuggling per-operator behavior under an optional
 * shared field would violate the design property "behavior is never
 * tucked under existing kinds via hidden state".
 *
 * Operand shape: `left` and `right` are `ValueExpression` (not bare
 * `Term`). This is the structural composition primitive that lets
 * arithmetic / conditional expressions drive a comparison —
 * `gt(arith("+", prop("age"), literal(1)), literal(18))` lands at
 * the AST without needing an intermediate calc-and-compare
 * scaffolding. Term-shaped operands flow through unchanged: builders
 * auto-wrap `Term` arguments in `{ kind: "term", term: <Term> }` at
 * the call site (see `builders.ts:toValueExpression`), so
 * `eq(prop("name"), literal("Alice"))` constructs the expected
 * ValueExpression-of-Term wrapper without any author-visible
 * ceremony.
 */
export const COMPARISON_KINDS = [
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];

const comparisonSchema = z
	.object({
		kind: z.enum(COMPARISON_KINDS),
		left: z.lazy(() => valueExpressionSchema),
		right: z.lazy(() => valueExpressionSchema),
	})
	.strict();

/**
 * Set membership with value-equality semantics: `left` equals one of
 * the literals in `values`. Right side is restricted to literals (not
 * arbitrary expressions) because the wire targets — an XPath or-of-
 * equalities chain on the case-list side and SQL `IN (...)` on the
 * runtime side — both demand a static value list. `unwrap-list`
 * (CSQL's value-function for sequence sources) does NOT widen this
 * slot: the wire pattern there is `selected-any(prop, unwrap-list(...))`
 * via `multi-select-contains`, not an `in`-semantics expansion.
 *
 * `left` is `ValueExpression` so an arithmetic / conditional
 * expression can sit in the membership-test position (`isIn(arith("+",
 * prop("age"), literal(1)), literal(18), literal(19))`). Term-shaped
 * `left` flows through unchanged — builders auto-wrap Term inputs as
 * ValueExpression-of-Term.
 *
 * `values` is non-empty (tuple-with-rest): an empty `in(...)` is
 * trivially false at every target and is virtually always an
 * authoring bug (e.g. a filter UI that bound to an unset variable).
 * Reject at the AST layer so downstream compilers don't have to
 * encode the policy.
 *
 * The `.refine` rejecting all-null `values` defends a structural
 * degenerate: a list of nothing-but-null collapses on every wire to
 * "the property is absent OR the property is absent OR ...", which
 * is just "the property is absent" duplicated. That's not what `in`
 * means; the canonical authoring shapes for the absence-check intent
 * are `is-null(prop)` (strict-absent, Postgres-only) and
 * `is-blank(prop)` (absent-or-empty, portable to CCHQ). Mixed
 * null + non-null lists are accepted because they encode the
 * meaningful "absent OR equals one of these values" predicate.
 */
const inSchema = z
	.object({
		kind: z.literal("in"),
		left: z.lazy(() => valueExpressionSchema),
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
	})
	.strict();

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
 * `commcare-hq/corehq/apps/es/queries.py::DISTANCE_UNITS`); Nova exposes the
 * two imperial/metric anchor units. Authors who need other units
 * coerce upstream of the AST.
 */
const DISTANCE_UNITS = ["miles", "kilometers"] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

/**
 * Geo predicate: include cases whose `property` (a geopoint) lies
 * within `distance` of `center`. `property` is a direct property
 * reference (the geopoint can't be a literal or an input — those
 * shapes don't make geometric sense, and the wire layer at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::within_distance`
 * dispatches `within-distance` against a property name, not a value
 * expression). `center` is a `ValueExpression` so a date-driven or
 * arithmetic-derived center coordinate (rare but representable via
 * the typed AST) can drive the query alongside the natural search-
 * input or session-user shapes.
 *
 * `distance` is `.nonnegative()` — a negative radius is geometrically
 * meaningless and would propagate to two compilers (XPath/CSQL and
 * Kysely) that don't share a rejection layer. Reject at the AST. Zod
 * 4's `z.number()` already rejects `NaN` and `±Infinity`, so the only
 * structural concern left here is the sign.
 */
const withinDistanceSchema = z
	.object({
		kind: z.literal("within-distance"),
		property: propertyRefSchema,
		center: z.lazy(() => valueExpressionSchema),
		distance: z.number().nonnegative(),
		unit: z.enum(DISTANCE_UNITS),
	})
	.strict();

/**
 * Closed set of CCHQ text-match wire dispatches. Pattern mirrors
 * `COMPARISON_KINDS` and `DISTANCE_UNITS` above: a top-level `as
 * const` tuple feeds the schema via `z.enum(...)`, and `MatchMode`
 * derives from it so the builder's `mode` parameter shares this
 * single source of truth. Adding a mode here automatically widens
 * the builder's accepted argument set rather than requiring parallel
 * maintenance.
 *
 * Each mode maps to a CCHQ query function registered on
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`:
 *
 *   - `fuzzy` → `fuzzy-match` (Elasticsearch `queries.fuzzy` against
 *     `PROPERTY_VALUE`, edit-distance match)
 *     — `query_functions.py::fuzzy_match`.
 *   - `phonetic` → `phonetic-match` (Soundex / metaphone-style match
 *     via `sounds_like_text_query`)
 *     — `query_functions.py::phonetic_match`.
 *   - `fuzzy-date` → `fuzzy-date` (digit-permutation date match for
 *     transposed YYYY-MM-DD inputs)
 *     — `query_functions.py::fuzzy_date`.
 *   - `starts-with` → `starts-with` (`case_property_starts_with` →
 *     `prefix` filter on `PROPERTY_VALUE_EXACT`)
 *     — `query_functions.py::starts_with` and
 *     `case_search.py::case_property_starts_with`.
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
 * `COMPARISON_KINDS` / `DISTANCE_UNITS`. Each quantifier composes a
 * per-value list into one predicate: `any` joins with OR (the
 * property contains at least one of the values), `all` joins with
 * AND (the property contains every value). Both wire emitters
 * expand the quantifier into per-value `selected(prop, 'v')` calls
 * — the on-device emitter at
 * `caseListFilterEmitter.ts::emitMultiSelectContains` and the CSQL
 * emitter at `csqlEmitter.ts::emitMultiSelectSegments`. CCHQ's
 * `selected` whitelist entry on
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`
 * dispatches through `case_property_query` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::_selected_query`
 * and treats its value argument as one literal token, so multi-word
 * values stay intact (unlike `selected-any` / `selected-all`, which
 * tokenize their single value argument on whitespace).
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
 * `value` carries any `ValueExpression` — a literal text constant
 * lifted through the `term` arm (`term(literal("alice"))`), a
 * search-input ref (`term(input("name_search"))`), a session ref, or
 * a derived value expression. The widening matches the operand-
 * widening pattern at every other Predicate operator's value slot
 * (`compare`, `between`, `in`, `is-null`, `is-blank`,
 * `within-distance`); search inputs driving fuzzy / phonetic /
 * starts-with / fuzzy-date matches at runtime is the load-bearing
 * use case for case-search authoring. The wire target supports
 * runtime substitution via the on-device wrapper that builds the
 * CSQL `_xpath_query` string — see CCHQ's `unwrap_value` at
 * `commcare-hq/corehq/apps/case_search/dsl_utils.py::unwrap_value`
 * and the canonical concat pattern in
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`.
 *
 * The type checker rejects values that don't resolve to a text-
 * coercible type — `term(literal(5))` matched against a text property
 * is ill-typed at construction.
 *
 * Empty-string literals (`term(literal(""))`) are a category error and
 * the type checker rejects them. Each CCHQ mode collapses an empty
 * value to a different non-match — `starts-with` is vacuously true
 * (empty prefix matches every property), `fuzzy-match` short-circuits
 * to `case_property_missing` (`case_property_query` in
 * `commcare-hq/corehq/apps/es/case_search.py`, the `value == ''` arm),
 * `phonetic-match` matches nothing (empty Elasticsearch `match`
 * produces no tokens to score), `fuzzy-date` depends on
 * `date_permutations("")`. None expresses what an author typing
 * `match(prop, "")` intends; the canonical authoring shapes for the
 * absence-check intent are `is-null(prop)` (strict-absent,
 * Postgres-only) and `is-blank(prop)` (absent-or-empty, portable to
 * CCHQ). Runtime values (search-input refs, session refs) that resolve
 * to empty strings at evaluation time pass through the same wire
 * collapse — the foundation does not rewrite them; the wire layer's
 * lossiness is the wire layer's concern.
 */
const matchSchema = z
	.object({
		kind: z.literal("match"),
		property: propertyRefSchema,
		value: z.lazy(() => valueExpressionSchema),
		mode: z.enum(MATCH_MODES),
	})
	.strict();

/**
 * Multi-select containment predicate — "the multi_select property
 * contains some / all of these values." The `quantifier`
 * discriminator (one of `MULTI_SELECT_QUANTIFIERS`) picks between
 * an OR / AND of per-value `selected(prop, 'v')` calls; see
 * `MULTI_SELECT_QUANTIFIERS`'s JSDoc for the wire shape.
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
 * terms) because the wire emitters dispatch one `selected(prop, 'v')`
 * call per value, and each value must be a static string a wire
 * literal can carry. Each literal carries one value the per-value
 * `selected` call tests against the multi_select's stored
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
 * Both wire targets collapse an all-null list to a duplicated
 * absence check — the CCHQ wire matches absent / cleared / empty
 * alike — so the canonical authoring shapes for the intent are
 * `is-null(prop)` (strict-absent, Postgres-only) and
 * `is-blank(prop)` (absent-or-empty, the CCHQ-portable form;
 * emits `prop = ''` on every CCHQ dialect, with the server-side
 * `case_property_query()` short-circuit at
 * `commcare-hq/corehq/apps/es/case_search.py::case_property_query`
 * collapsing empty-value queries into the absent-or-empty match set
 * in CSQL).
 * Reject the all-null list here so downstream consumers don't have
 * to encode the policy. Source citations live next to the
 * `.refine(...)` call below.
 *
 * Multi-word values stay intact on every wire path. CCHQ's
 * `selected_any` / `selected_all` whitelist entries on
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`
 * dispatch through `case_property_text_query` at
 * `commcare-hq/corehq/apps/es/case_search.py::case_property_text_query`,
 * which forwards the value argument to ElasticSearch's `match` query
 * — `match` tokenizes on whitespace, so a single space-joined call
 * would silently break a multi-word author intent. Both CSQL and
 * on-device emitters compose multi-value predicates as
 * `or` / `and` over per-value `selected(prop, 'v')` calls, where
 * each `selected` call takes one value literal and CCHQ's matcher
 * treats it as one token regardless of internal whitespace.
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
	.strict()
	// All-null rejection mirrors `inSchema.values`'s defense: both wire
	// targets collapse an all-null list to a duplicated absence check
	// — the wire matches absent / cleared / empty alike on CCHQ — so
	// the canonical authoring shapes for the intent are
	// `is-null(prop)` (strict-absent, Postgres-only) and
	// `is-blank(prop)` (absent-or-empty, the CCHQ-portable form;
	// emits `prop = ''` on every CCHQ dialect).
	//
	// CSQL: each emitted `selected(name, '')` call routes to
	// `case_property_query(name, '', ...)` at
	// `commcare-hq/corehq/apps/es/case_search.py::case_property_query`,
	// whose `value == ''` arm short-circuits to `case_property_missing(name)`
	// — "the property is missing." Every null literal lowers to the
	// wire-form empty string at the term emitter, so an all-null list
	// produces an OR / AND of identical absence checks; the predicate
	// is a single absence check duplicated by `quantifier`. The CCHQ
	// wire match-set covers absent / cleared / empty — the same match
	// set `is-blank(prop)` expresses cleanly at the AST layer.
	//
	// On-device: `XPathSelectedFunc.multiSelected` at
	// `commcare-core/src/main/java/org/javarosa/xpath/expr/XPathSelectedFunc.java::XPathSelectedFunc.multiSelected`
	// trims the candidate token before searching: with the candidate
	// trimming to the empty string, the substring test
	// `(" " + s1 + " ").contains(" " + "" + " ")` reduces to
	// `(" " + s1 + " ").contains("  ")`, which is true iff `s1` is the
	// empty string — i.e., the property's value is the empty string
	// (which on CCHQ is the absent / cleared / empty match-set). OR
	// / AND of identical absence checks collapses to one such check.
	//
	// Both targets emit a duplicated absence check for an all-null
	// shape, almost certainly an authoring bug; reject at the AST
	// layer so downstream consumers don't have to encode the policy.
	// Mixed null + non-null lists are accepted because they encode
	// the meaningful "absent OR / AND has token X" predicate.
	.refine(
		(s) => s.values.some((v) => v.value !== null),
		"multi-select-contains.values must contain at least one non-null value",
	);

// ---------- Sentinel predicates ----------
//
// `match-all` and `match-none` are the boolean-algebra identity and
// absorbing elements — always-true and always-false predicates that
// carry no payload other than their discriminator. CCHQ exposes the
// same pair as zero-arg query functions registered on
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`
// and implemented at
// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::match_all`
// and
// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::match_none`
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

const matchAllSchema = z.object({ kind: z.literal("match-all") }).strict();
const matchNoneSchema = z.object({ kind: z.literal("match-none") }).strict();

// ---------- Null / blank predicates ----------
//
// CCHQ's wire layer collapses three semantically distinct states —
// *property never written* / *property written, then cleared* /
// *property explicitly set to empty* — into one wire-readable state.
// On every CCHQ dialect, `prop = ''` matches all three states; in
// CSQL the server-side `case_property_query()` short-circuits empty-
// value queries to `case_property_missing()` semantics at
// `commcare-hq/corehq/apps/es/case_search.py::case_property_query`,
// also matching all three states. (`case_property_missing` is a
// Python helper at the same file's `case_property_missing` — not a
// CSQL function authors can write.)
// The wire conflation is a CCHQ-side accumulation; **Nova's AST and
// runtime are not bound by it**.
// Postgres JSONB distinguishes "key absent" from "key present with
// empty-string value" (`NOT (properties ? 'X')` versus `properties->>'X'
// = ''`). Nova's runtime is Postgres natively (no in-memory
// alternative), so the strict three-state distinction is the
// runtime contract every read path observes. The Predicate AST
// carries the strict semantic family-wide; per-dialect emitters
// handle the CCHQ wire conflation.
//
// Two operators encode the family at this layer:
//
//   - `is-null` — **strict.** `left` resolves to absent (key not
//     present in the JSONB document). Postgres: emits the
//     presence test (`NOT (properties ? 'X')` for property refs;
//     equivalent for input / session refs). CCHQ wire:
//     **unrepresentable** — the wire layer collapses absent /
//     cleared / empty into one match set, so emitting `is-null`
//     against any CCHQ target would silently widen the match set
//     and lose the AST's strictness signal. The representability
//     checker errors at authoring time; the per-dialect emitters
//     defensively throw. Same dispatch pattern as `match(mode:
//     fuzzy)` in case-list-filter context. Filter authoring
//     surfaces (filter UI, SA tool surface, validator) reach for
//     `is-blank` instead because "field empty" is the user-facing
//     intent and `is-blank` emits cleanly on every CCHQ target;
//     `is-null` is foundation infrastructure for non-filter
//     surfaces (case-data inspection, audit / admin views,
//     expression operators that distinguish absent from empty),
//     where Postgres natively represents strict-absent via the
//     JSONB presence test. The operator stays in the AST
//     regardless because the discriminated-union shape is part
//     of the persisted contract — removing a kind would
//     invalidate every persisted predicate that used it.
//
//   - `is-blank` — **portable.** `left` resolves to absent OR
//     empty-string. Postgres: emits the disjunction
//     (`(NOT (properties ? 'X')) OR properties->>'X' = ''` for
//     property refs; equivalent for input / session refs). CCHQ
//     wire: cleanly representable on every target — wire form
//     `prop = ''` (the on-device idiom for absent-or-empty; CSQL
//     server-side `case_property_query()` short-circuits empty-value
//     queries to `case_property_missing()` semantics at
//     `commcare-hq/corehq/apps/es/case_search.py::case_property_query`,
//     matching absent / cleared / empty alike).
//     `case_property_missing` is a Python helper at the same file's
//     `case_property_missing`, not a CSQL function authors can write
//     — the empty-equality form is the only authorable shape, and
//     CCHQ does the right thing on the server.
//     Search-input refs in case-list / post-ES filters wrap the
//     equality in `if(count(input), real_predicate, match-all())`
//     so absent inputs short-circuit cleanly.
//
// Both schemas accept every Term variant in `left` — property refs,
// search-input refs, both session-ref kinds, and (structurally only)
// literals. The literal-shaped left is meaningless for both
// operators (a literal is the value itself; "is the literal 5
// absent" is ill-formed), but the schema is structural-only and
// admits the shape. The type-checker rule (in
// `lib/domain/predicate/typeChecker.ts`) rejects literal-shaped
// `left` for both operators with a parallel rule shape — the type
// checker is the right layer for the constraint because it has the
// term-discriminator context to surface a semantic-class error.

// `left` is `ValueExpression` (not bare `Term`) so expression-shaped
// operands (`is-null(arith(prop, literal(0), "div"))` — "is the per-
// unit ratio undefined?") compose at the AST level. The type
// checker's literal-rejection rule (a literal is the value itself,
// not a runtime read whose presence is in question) extends to
// literal-shaped ValueExpressions via the `term` arm — see
// `checkAbsenceOperator` in `typeChecker.ts`. Term-shaped operands
// flow through unchanged: builders auto-wrap Term inputs as
// ValueExpression-of-Term.

const isNullSchema = z
	.object({
		kind: z.literal("is-null"),
		left: z.lazy(() => valueExpressionSchema),
	})
	.strict();

const isBlankSchema = z
	.object({
		kind: z.literal("is-blank"),
		left: z.lazy(() => valueExpressionSchema),
	})
	.strict();

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
// search-input, session-user, or session-context refs whose values
// aren't known until runtime — adding a literal-pair-only refinement
// here would either miss the term-pair case (silent wrong-answer in
// the runtime path) or reject term-pair shapes the schema must
// accept. Detection of the literal-pair impossibility is a type-
// checker rule (it has the type information to recognise the literal
// pair); the term-pair case is a runtime check. The schema's role
// here is structural only.

// `left` / `lower` / `upper` are `ValueExpression` so an arithmetic-
// derived bound (e.g. `between(prop("age"), { lower: arith("+",
// input("min"), literal(1)), upper: ... })`) composes at the AST.
// Term-shaped bounds flow through unchanged via the builder's auto-
// wrap. The literal-pair impossibility check in the type checker
// (when `lower > upper` and both are typed-literal terms) descends
// through the `term` arm of ValueExpression to read the underlying
// literal — see `checkBetween` in `typeChecker.ts`.

// `z.lazy(() => schema).optional()` is the canonical Zod 4 form for
// an optional recursive slot — the `.optional()` chain on a lazy
// schema preserves the absent-key strip behavior that
// `schema.optional()` provides on a non-recursive shape. Empirically
// pinned by the absent-not-undefined tests in
// `lib/domain/predicate/__tests__/builders.test.ts` (the
// `"upper" in lowerOnly` / `"lower" in upperOnly` assertions on
// `between()`'s output).
const betweenSchema = z
	.object({
		kind: z.literal("between"),
		left: z.lazy(() => valueExpressionSchema),
		lower: z.lazy(() => valueExpressionSchema).optional(),
		upper: z.lazy(() => valueExpressionSchema).optional(),
		lowerInclusive: z.boolean(),
		upperInclusive: z.boolean(),
	})
	.strict()
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
// to `false` — neither is the canonical AST shape for those values
// (the canonical shapes are `match-all` and `match-none` respectively).
// The schema rejects the empty-list shape so a directly-parsed
// `{ kind: "and", clauses: [] }` literal — e.g. parsing persisted
// JSON from an older schema — fails loudly rather than reaching
// downstream consumers as a tautology.
//
// The `and` / `or` builders in `lib/domain/predicate/builders.ts`
// thread their inputs through the construction-time reductions in
// `lib/domain/predicate/reduction.ts` BEFORE the schema parse. The
// reductions collapse the empty- and single-clause inputs to
// canonical sentinel / unwrapped forms (`and()` → `match-all`,
// `and(x)` → `x`, etc.), so the schema's non-empty shape is the
// defensive backstop for direct schema use, not the primary surface
// authors interact with. See the file-level comment in
// `builders.ts`'s "Logical" section for the full reduction contract.
//
// Both schemas use the Zod 4 tuple-with-rest idiom rather than
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

const andSchema = z
	.object({
		kind: z.literal("and"),
		clauses: z.tuple(
			[z.lazy(() => predicateSchema)],
			z.lazy(() => predicateSchema),
		),
	})
	.strict();

const orSchema = z
	.object({
		kind: z.literal("or"),
		clauses: z.tuple(
			[z.lazy(() => predicateSchema)],
			z.lazy(() => predicateSchema),
		),
	})
	.strict();

const notSchema = z
	.object({
		kind: z.literal("not"),
		clause: z.lazy(() => predicateSchema),
	})
	.strict();

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
const whenInputPresentSchema = z
	.object({
		kind: z.literal("when-input-present"),
		input: searchInputRefSchema,
		clause: z.lazy(() => predicateSchema),
	})
	.strict();

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
//     `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::subcase`.
//     It accepts a one-or-two-argument form — the filter argument is
//     optional per the parser at
//     `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::_extract_subcase_query_parts`.
//   - `ancestor-exists` at
//     `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::ancestor_exists`.
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

const existsSchema = z
	.object({
		kind: z.literal("exists"),
		via: relationPathSchema,
		where: z.lazy(() => predicateSchema).optional(),
	})
	.strict();

const missingSchema = z
	.object({
		kind: z.literal("missing"),
		via: relationPathSchema,
		where: z.lazy(() => predicateSchema).optional(),
	})
	.strict();

/**
 * The full predicate union, discriminated on `kind` — consumers
 * narrowing on `p.kind` get full per-variant typing without manual
 * casts. Adding an operator means: (1) define its schema above, (2) add
 * it to this union, (3) extend the type checker / XPath emitter / SQL
 * compiler.
 *
 * Drift policy — `matchSchema`, `multiSelectContainsSchema`,
 * `matchAllSchema`, `matchNoneSchema` derive their TS shape from
 * their schema via `z.infer<typeof X>` because they have no
 * recursion (no `z.lazy(...)` slot). Adding a field to one of
 * those schemas updates the union automatically.
 *
 * Every other arm is hand-declared because TypeScript cannot resolve
 * `z.infer` through a `z.lazy(...)` slot — the inferred type widens
 * to `any` or the resolver fails (Zod issue #4264, TS 5.9+ behavior
 * documented in #5035). This applies both to the always-recursive
 * arms (`and` / `or` / `not` / `when-input-present` / `exists` /
 * `missing` — the cycle goes through their predicate slot) AND to
 * the operand-widened arms (`comparison` / `in` / `within-distance` /
 * `is-null` / `is-blank` / `between` — the cycle goes through their
 * `ValueExpression` operands). Adding a field to one of the hand-
 * declared schemas requires a parallel hand-update to the matching
 * arm here. Any required-field drift surfaces as a CI failure (the
 * schema rejects predicates that don't supply the field; the test
 * suite parses each arm). Optional-field drift on the hand-declared
 * arms is caught by the structural assertion at the bottom of this
 * file.
 */
export type Predicate =
	// Operand-widened arms (ValueExpression-bearing operand slots). The
	// hand-declared shape mirrors the schema's runtime shape exactly;
	// the drift guard at the bottom of this file catches divergence in
	// the non-recursive structural surface (e.g. a future
	// `case_sensitive` flag added to `comparisonSchema` must update the
	// arm here in lockstep).
	| {
			kind: ComparisonKind;
			left: ValueExpression;
			right: ValueExpression;
	  }
	| {
			kind: "in";
			left: ValueExpression;
			values: [Literal, ...Literal[]];
	  }
	| {
			kind: "within-distance";
			property: PropertyRef;
			center: ValueExpression;
			distance: number;
			unit: DistanceUnit;
	  }
	| { kind: "is-null"; left: ValueExpression }
	| { kind: "is-blank"; left: ValueExpression }
	| {
			kind: "between";
			left: ValueExpression;
			lower?: ValueExpression;
			upper?: ValueExpression;
			lowerInclusive: boolean;
			upperInclusive: boolean;
	  }
	// Non-recursive arms — z.infer-derived because no z.lazy is in
	// play. Adding a field to these schemas updates the union
	// automatically without a parallel hand-update.
	| z.infer<typeof matchSchema>
	| z.infer<typeof multiSelectContainsSchema>
	| z.infer<typeof matchAllSchema>
	| z.infer<typeof matchNoneSchema>
	// Always-recursive arms (predicate-bearing slots). Same shape as
	// their schemas; the cycle goes through the slot's z.lazy.
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
		isBlankSchema,
		betweenSchema,
		andSchema,
		orSchema,
		notSchema,
		whenInputPresentSchema,
		existsSchema,
		missingSchema,
	],
);

// ---------- ValueExpression union ----------
//
// Hand-declared shape: every ValueExpression arm carries at least
// one `z.lazy(...)` slot (self-recursion through
// `valueExpressionSchema` or cross-family recursion through
// `predicateSchema`), so `z.infer<typeof valueExpressionSchema>`
// would widen to `any` or fail to resolve — same TS limitation that
// drives the Predicate side's hand-declared arms. The drift guard at
// the bottom of this file pins each arm's non-recursive structural
// surface against the schema; the recursive slots' CONTENT is pinned
// by the parse tests in the adjacent test file.
//
// Adding a new ValueExpression operator means: (1) define its schema
// above, (2) add it to this union, (3) add it to
// `valueExpressionSchema` below, (4) extend the drift guard at the
// bottom of this file, (5) extend the type checker / wire emitters
// / SQL compiler. Steps 1-4 stay in this file; the guard's
// compile-time check ensures the hand-declared arm and the schema
// stay in lockstep on the non-recursive surface.

/**
 * Single switch-case shape (`when` / `then`). Hand-declared because
 * `then` carries the z.lazy ValueExpression cycle. Mirrors
 * `switchCaseSchema` above.
 */
export type SwitchCase = { when: Literal; then: ValueExpression };

export type ValueExpression =
	| { kind: "term"; term: Term }
	| { kind: "today" }
	| { kind: "now" }
	| {
			kind: "date-add";
			date: ValueExpression;
			interval: DateAddInterval;
			quantity: ValueExpression;
	  }
	| { kind: "date-coerce"; value: ValueExpression }
	| { kind: "datetime-coerce"; value: ValueExpression }
	| { kind: "double"; value: ValueExpression }
	| {
			kind: "arith";
			op: ArithOp;
			left: ValueExpression;
			right: ValueExpression;
	  }
	// `parts` / `values` are non-empty: tuple-with-rest in the schemas
	// (`concatSchema.parts` / `coalesceSchema.values`) and the matching
	// `[ValueExpression, ...ValueExpression[]]` here share one definition
	// of "at least one part" between runtime and TS shapes.
	| {
			kind: "concat";
			parts: [ValueExpression, ...ValueExpression[]];
	  }
	| {
			kind: "coalesce";
			values: [ValueExpression, ...ValueExpression[]];
	  }
	| {
			kind: "if";
			cond: Predicate;
			then: ValueExpression;
			else: ValueExpression;
	  }
	| {
			kind: "switch";
			on: ValueExpression;
			cases: [SwitchCase, ...SwitchCase[]];
			fallback: ValueExpression;
	  }
	| { kind: "count"; via: RelationPath; where?: Predicate }
	| { kind: "unwrap-list"; value: ValueExpression }
	| {
			kind: "format-date";
			date: ValueExpression;
			pattern: FormatDatePreset | string;
	  };

export const valueExpressionSchema: z.ZodType<ValueExpression> =
	z.discriminatedUnion("kind", [
		valueExpressionTermSchema,
		todaySchema,
		nowSchema,
		dateAddSchema,
		dateCoerceSchema,
		datetimeCoerceSchema,
		doubleSchema,
		arithSchema,
		concatSchema,
		coalesceSchema,
		ifSchema,
		switchSchema,
		countSchema,
		unwrapListSchema,
		formatDateSchema,
	]);

// ---------- Drift guard ----------
//
// `_driftGuard` compares each hand-declared arm's non-recursive
// structural surface against its schema's `z.infer`. The recursive
// slots themselves cannot be compared via `z.infer` — through
// `z.lazy`, the inferred shape of the payload widens unpredictably
// across TS versions. So each arm is stripped of its recursive
// slot(s) before comparison.
//
// Two families of recursive slots:
//   - **Predicate-bearing slots** (cross- and self-cycle on the
//     Predicate side): `clauses` on `and` / `or`, `clause` on `not`
//     / `when-input-present`, `where` on `exists` / `missing`,
//     `where` on `count`, `cond` on `if`. These slots wrap
//     `z.lazy(() => predicateSchema)` in their schema.
//   - **ValueExpression-bearing slots** (cross-cycle from Predicate
//     into ValueExpression operands, and self-cycle on the
//     ValueExpression side): `left` / `right` on `comparison`,
//     `left` on `in` / `is-null` / `is-blank` / `between`,
//     `lower` / `upper` on `between`, `center` on
//     `within-distance`, every value slot on every ValueExpression
//     arm.
//
// The arms below strip both kinds of slot before comparison. Arms
// whose only structural surface is the `kind` discriminator (e.g.
// `andSchema`, `arithSchema` after stripping its operands and
// keeping `op`) reduce to "the discriminator string matches itself"
// for the recursive-slot strip plus per-arm scalar checks for any
// surviving non-recursive field (`op` on `arith`, `interval` on
// `date-add`, `pattern` on `format-date`, etc.). The guard's value
// is forward-looking: if any future change adds a non-recursive
// field to one of these schemas, the corresponding arm's hand-
// declared shape must update or the guard fails. Catches additions,
// removals, and renames of non-recursive fields — exactly the drift
// path that the recursive-slot strip leaves uncovered.
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
// adjacent test file — every recursive arm parses a nested
// predicate / expression, so the only escape route this guard
// misses — a payload-shape change reachable only through recursion
// — is caught there.
//
// The recursive-slot strip in this guard does not pin
// optional-vs-required divergence on the stripped slots; that drift
// mode is uncovered.

type _TypesEqual<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

// Predicate arms with predicate-bearing recursive slots (the original
// six). Each strips the recursive slot before comparison so the guard
// pins the surviving non-recursive surface only.
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

// Predicate arms with ValueExpression-bearing operand slots (the
// operand-widened set). Each strips the value-expression operands
// before comparison; the guard pins per-arm scalar / structural
// fields that don't recurse.
type _ComparisonArm = Omit<
	Extract<Predicate, { kind: ComparisonKind }>,
	"left" | "right"
>;
type _InArm = Omit<Extract<Predicate, { kind: "in" }>, "left">;
type _WithinDistanceArm = Omit<
	Extract<Predicate, { kind: "within-distance" }>,
	"center"
>;
type _IsNullArm = Omit<Extract<Predicate, { kind: "is-null" }>, "left">;
type _IsBlankArm = Omit<Extract<Predicate, { kind: "is-blank" }>, "left">;
type _BetweenArm = Omit<
	Extract<Predicate, { kind: "between" }>,
	"left" | "lower" | "upper"
>;

type _ComparisonInferred = Omit<
	z.infer<typeof comparisonSchema>,
	"left" | "right"
>;
type _InInferred = Omit<z.infer<typeof inSchema>, "left">;
type _WithinDistanceInferred = Omit<
	z.infer<typeof withinDistanceSchema>,
	"center"
>;
type _IsNullInferred = Omit<z.infer<typeof isNullSchema>, "left">;
type _IsBlankInferred = Omit<z.infer<typeof isBlankSchema>, "left">;
type _BetweenInferred = Omit<
	z.infer<typeof betweenSchema>,
	"left" | "lower" | "upper"
>;

// ValueExpression arms — every value-bearing arm carries at least
// one z.lazy slot, so each is hand-declared and the guard strips its
// recursive slot(s) before comparison. The non-recursive surface
// surviving the strip is per-arm — `op` on `arith`, `interval` on
// `date-add`, `pattern` on `format-date`, `via` on `count`, the
// inner Term shape on `term`, etc.
type _ValueExpressionTermArm = Omit<
	Extract<ValueExpression, { kind: "term" }>,
	"term"
>;
type _TodayArm = Extract<ValueExpression, { kind: "today" }>;
type _NowArm = Extract<ValueExpression, { kind: "now" }>;
type _DateAddArm = Omit<
	Extract<ValueExpression, { kind: "date-add" }>,
	"date" | "quantity"
>;
type _DateCoerceArm = Omit<
	Extract<ValueExpression, { kind: "date-coerce" }>,
	"value"
>;
type _DatetimeCoerceArm = Omit<
	Extract<ValueExpression, { kind: "datetime-coerce" }>,
	"value"
>;
type _DoubleArm = Omit<Extract<ValueExpression, { kind: "double" }>, "value">;
type _ArithArm = Omit<
	Extract<ValueExpression, { kind: "arith" }>,
	"left" | "right"
>;
type _ConcatArm = Omit<Extract<ValueExpression, { kind: "concat" }>, "parts">;
type _CoalesceArm = Omit<
	Extract<ValueExpression, { kind: "coalesce" }>,
	"values"
>;
type _IfArm = Omit<
	Extract<ValueExpression, { kind: "if" }>,
	"cond" | "then" | "else"
>;
type _SwitchArm = Omit<
	Extract<ValueExpression, { kind: "switch" }>,
	"on" | "cases" | "fallback"
>;
type _CountArm = Omit<Extract<ValueExpression, { kind: "count" }>, "where">;
type _UnwrapListArm = Omit<
	Extract<ValueExpression, { kind: "unwrap-list" }>,
	"value"
>;
type _FormatDateArm = Omit<
	Extract<ValueExpression, { kind: "format-date" }>,
	"date"
>;

type _ValueExpressionTermInferred = Omit<
	z.infer<typeof valueExpressionTermSchema>,
	"term"
>;
type _TodayInferred = z.infer<typeof todaySchema>;
type _NowInferred = z.infer<typeof nowSchema>;
type _DateAddInferred = Omit<
	z.infer<typeof dateAddSchema>,
	"date" | "quantity"
>;
type _DateCoerceInferred = Omit<z.infer<typeof dateCoerceSchema>, "value">;
type _DatetimeCoerceInferred = Omit<
	z.infer<typeof datetimeCoerceSchema>,
	"value"
>;
type _DoubleInferred = Omit<z.infer<typeof doubleSchema>, "value">;
type _ArithInferred = Omit<z.infer<typeof arithSchema>, "left" | "right">;
type _ConcatInferred = Omit<z.infer<typeof concatSchema>, "parts">;
type _CoalesceInferred = Omit<z.infer<typeof coalesceSchema>, "values">;
type _IfInferred = Omit<z.infer<typeof ifSchema>, "cond" | "then" | "else">;
type _SwitchInferred = Omit<
	z.infer<typeof switchSchema>,
	"on" | "cases" | "fallback"
>;
type _CountInferred = Omit<z.infer<typeof countSchema>, "where">;
type _UnwrapListInferred = Omit<z.infer<typeof unwrapListSchema>, "value">;
type _FormatDateInferred = Omit<z.infer<typeof formatDateSchema>, "date">;

// `_driftGuard` is kept as a `const` declaration so the type assertion
// has a binding site — the per-arm equality checks are evaluated at
// the binding's annotated type. If any of them resolves to `false`,
// the initializer fails to assign to the annotated type and CI
// catches it. Removing the const would lose the type-check site; the
// `_` prefix follows the convention for "type assertion that has no
// runtime role" in this codebase.
const _driftGuard: {
	// Predicate side — predicate-bearing recursive arms.
	and: _TypesEqual<_AndArm, _AndInferred>;
	or: _TypesEqual<_OrArm, _OrInferred>;
	not: _TypesEqual<_NotArm, _NotInferred>;
	whenInputPresent: _TypesEqual<
		_WhenInputPresentArm,
		_WhenInputPresentInferred
	>;
	exists: _TypesEqual<_ExistsArm, _ExistsInferred>;
	missing: _TypesEqual<_MissingArm, _MissingInferred>;
	// Predicate side — operand-widened arms (ValueExpression operands).
	comparison: _TypesEqual<_ComparisonArm, _ComparisonInferred>;
	in: _TypesEqual<_InArm, _InInferred>;
	withinDistance: _TypesEqual<_WithinDistanceArm, _WithinDistanceInferred>;
	isNull: _TypesEqual<_IsNullArm, _IsNullInferred>;
	isBlank: _TypesEqual<_IsBlankArm, _IsBlankInferred>;
	between: _TypesEqual<_BetweenArm, _BetweenInferred>;
	// ValueExpression side — every value-bearing arm.
	valueExpressionTerm: _TypesEqual<
		_ValueExpressionTermArm,
		_ValueExpressionTermInferred
	>;
	today: _TypesEqual<_TodayArm, _TodayInferred>;
	now: _TypesEqual<_NowArm, _NowInferred>;
	dateAdd: _TypesEqual<_DateAddArm, _DateAddInferred>;
	dateCoerce: _TypesEqual<_DateCoerceArm, _DateCoerceInferred>;
	datetimeCoerce: _TypesEqual<_DatetimeCoerceArm, _DatetimeCoerceInferred>;
	double: _TypesEqual<_DoubleArm, _DoubleInferred>;
	arith: _TypesEqual<_ArithArm, _ArithInferred>;
	concat: _TypesEqual<_ConcatArm, _ConcatInferred>;
	coalesce: _TypesEqual<_CoalesceArm, _CoalesceInferred>;
	if: _TypesEqual<_IfArm, _IfInferred>;
	switch: _TypesEqual<_SwitchArm, _SwitchInferred>;
	count: _TypesEqual<_CountArm, _CountInferred>;
	unwrapList: _TypesEqual<_UnwrapListArm, _UnwrapListInferred>;
	formatDate: _TypesEqual<_FormatDateArm, _FormatDateInferred>;
} = {
	and: true,
	or: true,
	not: true,
	whenInputPresent: true,
	exists: true,
	missing: true,
	comparison: true,
	in: true,
	withinDistance: true,
	isNull: true,
	isBlank: true,
	between: true,
	valueExpressionTerm: true,
	today: true,
	now: true,
	dateAdd: true,
	dateCoerce: true,
	datetimeCoerce: true,
	double: true,
	arith: true,
	concat: true,
	coalesce: true,
	if: true,
	switch: true,
	count: true,
	unwrapList: true,
	formatDate: true,
};

// ---------- JSON-schema definition names ----------
//
// A registered id makes every `z.toJSONSchema` emission — including the
// AI SDK's default tool-schema serialization — extract the schema into
// the `definitions` block ONCE under that name and emit
// `{"$ref": "#/definitions/Predicate"}` at each use site. Without it,
// each of a predicate-carrying tool's operator arms re-inlines the full
// term structure (~28k tokens of duplication across the SA tool set),
// and only the recursion-forced nodes get extracted, under positional
// `__schemaN` keys that renumber per tool (same label, different meaning
// across tools). One stable name per AST family member, identical in
// every emission surface (SA tools and the MCP listing alike).
// `globalRegistry.add` attaches to the instance in place (no clone —
// unlike `.meta()`, which clones and double-serializes shared child
// nodes into stray micro-definitions); parsing is untouched.

z.globalRegistry.add(relationStepSchema, { id: "RelationStep" });
z.globalRegistry.add(relationPathSchema, { id: "RelationPath" });
z.globalRegistry.add(propertyRefSchema, { id: "PropertyRef" });
z.globalRegistry.add(searchInputRefSchema, { id: "SearchInputRef" });
z.globalRegistry.add(sessionUserSchema, { id: "SessionUser" });
z.globalRegistry.add(sessionContextSchema, { id: "SessionContext" });
z.globalRegistry.add(literalSchema, { id: "Literal" });
z.globalRegistry.add(termSchema, { id: "Term" });
z.globalRegistry.add(predicateSchema, { id: "Predicate" });
z.globalRegistry.add(valueExpressionSchema, { id: "ValueExpression" });
