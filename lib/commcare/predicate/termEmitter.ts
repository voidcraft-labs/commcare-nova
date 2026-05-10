// lib/commcare/predicate/termEmitter.ts
//
// Shared term-emission helpers used across both the predicate
// emitters (case-list-filter / CSQL) and the value-expression
// emitters (`lib/commcare/expression/`). Term emission is the leaf
// concern at every CommCare wire surface — every operator's operand
// path eventually reaches a `Term` (a property reference, an input
// reference, a session reference, or a literal), and the per-dialect
// wire shape for each term flavor is identical regardless of the
// operator that wraps it. Centralising the leaf emitters here keeps
// every dialect surface consistent on identifier rules, reserved-
// attribute prefixing, and runtime instance-path shapes.
//
// Two shape families coexist:
//
//   - **On-device XPath** (`emitTerm`). Each term emits as a single
//     wire-form string drop-in for either the case-list `<detail
//     nodeset>` slot or the post-ES `<search_filter>` slot.
//     Compile-time-known values (literals, property identifiers) and
//     runtime-resolved instance paths (search-input refs, session
//     refs) all collapse to one string at this layer because both
//     run in the same on-device XPath evaluator.
//   - **CSQL** (`emitTermSegment`). The CSQL dialect lives inside an
//     on-device `concat(...)` wrapper that builds the `_xpath_query`
//     string at runtime, so the leaf emitter splits compile-time-
//     known values (constant) from runtime-resolved instance reads
//     (runtime). The two arms compose into the segment-list IR that
//     both predicate-side and expression-side emitters return.
//
// Source citations for each wire shape live alongside the per-arm
// emitter so a reader scanning either dialect sees the rationale
// next to the code.

import type {
	PropertyRef,
	RelationStep,
	SearchInputRef,
	SessionContextRef,
	SessionUserRef,
	Term,
} from "@/lib/domain/predicate/types";
import type { CsqlSegment } from "./csqlSegment";
import { formatNumeric, quoteIdentifier, quoteLiteral } from "./stringQuoting";

/**
 * The four CommCare case properties CCHQ stores as XML attributes on
 * `<case>` in the casedb restore output. XPath addresses XML
 * attributes via the `@` prefix, so a wire-form read of `case_id`,
 * `case_type`, `owner_id`, or `status` emits as `@case_id` etc.; the
 * other case properties read as bare identifiers because CCHQ stores
 * them as child elements rather than attributes.
 *
 * Sources (production code, not tests):
 *
 *   - `corehq/ex-submodules/casexml/apps/case/xml/generator.py::CaseDBXMLGenerator.get_root_element`
 *     — sets exactly these four as XML attributes on `<case>`;
 *     everything else is emitted as a child element.
 *   - `corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY`
 *     registers ten system metadata keys; these four carry the `@`
 *     prefix while the other six do not.
 *
 * Both dialects share the same set because both target the same
 * underlying case storage shape.
 */
export const RESERVED_CASE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

// ============================================================
// Relation-walk anchor builders
// ============================================================
//
// Both the on-device join-form (`exists` / `missing` / inline `prop`-
// via-relation reads) and the on-device expression emitter's `count`
// expansion call the same anchor builders. Sharing them here keeps
// the wire shape uniform across operator surfaces — a regression in
// one builder would surface across every consumer at once.

/**
 * Build the `instance('casedb')/casedb/case[@case_id=<anchor>]`
 * nodeset for an ancestor walk. The first hop anchors against
 * `current()/index/<rel>`; each subsequent hop nests inside the
 * previous hop's nodeset as `<previous>/index/<next>`. The canonical
 * shape with one hop is
 * `instance('casedb')/casedb/case[@case_id=current()/index/<rel0>]`;
 * with two hops it composes to
 * `instance('casedb')/casedb/case[@case_id=instance('casedb')/casedb/case[@case_id=current()/index/<rel0>]/index/<rel1>]`.
 *
 * Source: CCHQ's hashtag-replacement pattern at
 * `commcare-hq/corehq/apps/app_manager/xpath.py::interpolate_xpath`
 * builds the same wire shape (`#parent` / `#host` expand to
 * `instance('casedb')/casedb/case[@case_id=<base>/index/<rel>]`).
 *
 * Accepts a non-empty list of relation steps; the
 * `RelationPath`-with-`ancestor` schema's tuple-with-rest shape
 * already enforces non-empty at parse time.
 */
export function buildAncestorJoinNodeset(
	via: ReadonlyArray<{ identifier: string }>,
): string {
	let anchor = `current()/index/${via[0].identifier}`;
	for (let i = 1; i < via.length; i++) {
		anchor = `instance('casedb')/casedb/case[@case_id=${anchor}]/index/${via[i].identifier}`;
	}
	return `instance('casedb')/casedb/case[@case_id=${anchor}]`;
}

/**
 * Build the
 * `instance('casedb')/casedb/case[index/<rel>=current()/@case_id]`
 * nodeset for a subcase walk. Reverse-direction join: the inner case
 * has `index/<rel>` pointing back at the outer case's `@case_id`.
 * `current()/@case_id` reads the outer case's id from the predicate's
 * evaluation context (inside a casedb nodeset filter, `current()` is
 * the case being filtered).
 *
 * The canonical CCHQ example pinning this shape is at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::_update_refs`.
 */
export function buildSubcaseJoinNodeset(identifier: string): string {
	return `instance('casedb')/casedb/case[index/${identifier}=current()/@case_id]`;
}

// ============================================================
// On-device term emission (XPath string)
// ============================================================

/**
 * Emit a term as its on-device wire-form XPath string. Each variant
 * has a fixed wire shape verified against CCHQ source:
 *
 *   - `prop` — bare identifier (or `@`-prefixed for the four reserved
 *     attributes). When the term carries a non-self `via`, the
 *     emitter prepends the relation-walk anchor and joins with `/`;
 *     direction-agnostic walks use XPath's node-set union operator
 *     `|` to combine both directions. See `emitOnDevicePropertyRef`.
 *   - `input` — `instance('search-input:results')/input/field[@name='<name>']`,
 *     the canonical search-input read documented in
 *     `commcare-hq/docs/case_search_query_language.rst` and registered
 *     at
 *     `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/instances.py::search_input_instances`.
 *   - `session-user` — open-namespace
 *     `instance('commcaresession')/session/user/data/<field>`,
 *     populated by
 *     `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java::SessionInstanceBuilder.addUserProperties`
 *     (iterates an arbitrary `userFields` Hashtable and writes each
 *     as a `<data>` child under `<user>`). CCHQ's
 *     `session_var(var, path='user/data')` in
 *     `commcare-hq/corehq/apps/app_manager/xpath.py::session_var`
 *     builds the same path.
 *   - `session-context` — closed-namespace
 *     `instance('commcaresession')/session/context/<field>`,
 *     populated by `SessionInstanceBuilder.addMetadata` in the same
 *     class.
 *   - `literal` — primitive value via `emitOnDeviceLiteralValue`.
 */
export function emitTerm(term: Term): string {
	switch (term.kind) {
		case "prop":
			return emitOnDevicePropertyRef(term);
		case "input":
			return `instance('search-input:results')/input/field[@name='${term.name}']`;
		case "session-user":
			// `field` is constrained to XML element-name vocabulary at
			// the schema layer (no quoting / escaping required for valid
			// values; invalid values reject at parse time).
			return `instance('commcaresession')/session/user/data/${term.field}`;
		case "session-context":
			// `field` is one of the four `SESSION_CONTEXT_FIELDS`
			// members validated at the schema layer; direct
			// interpolation is safe.
			return `instance('commcaresession')/session/context/${term.field}`;
		case "literal":
			return emitOnDeviceLiteralValue(term.value);
		default: {
			const _exhaustive: never = term;
			throw new Error(`emitTerm: unhandled term kind ${String(_exhaustive)}`);
		}
	}
}

/**
 * Emit a property reference as its on-device wire-form XPath. The
 * wire shape depends on the optional `via` walk:
 *
 *   - **No walk** (`via` absent or `via.kind === "self"`): bare
 *     property name (or `@`-prefixed reserved attribute). The
 *     case-type qualifier is dropped; the surrounding casedb nodeset
 *     selects the wire-correct case type at execution time.
 *   - **Ancestor walk**: prepend
 *     `instance('casedb')/casedb/case[@case_id=current()/index/<rel>]`
 *     (with multi-hop nesting) and join the property name with `/`.
 *   - **Subcase walk**: prepend
 *     `instance('casedb')/casedb/case[index/<rel>=current()/@case_id]`
 *     and join with `/`. Subcase reads select multiple cases when
 *     more than one subcase points back; authors who need cardinality
 *     control compose via `exists` / `count` instead.
 *   - **Direction-agnostic walk** (`any-relation`): combine both
 *     direction-specific paths via XPath's union operator `|`,
 *     producing `(<ancestor-path> | <subcase-path>)`. Union joins
 *     two node-sets into one node-set whose comparisons follow XPath
 *     1.0's existential semantics — `(a | b) = 'south'` is true when
 *     any node in the unified set equals `'south'`. A boolean `or`
 *     would coerce each path to its boolean value (non-empty →
 *     `true()`) before string equality, comparing the literal
 *     `'true'` / `'false'` against the RHS — which is never the
 *     intent.
 *
 * Reserved CommCare attributes pick up the `@` prefix at the leaf;
 * everything else flows through `quoteIdentifier` for the lexical
 * pass-through.
 */
export function emitOnDevicePropertyRef(prop: PropertyRef): string {
	const leaf = RESERVED_CASE_ATTRIBUTES.has(prop.property)
		? `@${quoteIdentifier(prop.property)}`
		: quoteIdentifier(prop.property);
	const via = prop.via;
	if (via === undefined || via.kind === "self") {
		return leaf;
	}
	switch (via.kind) {
		case "ancestor":
			return `${buildAncestorJoinNodeset(via.via)}/${leaf}`;
		case "subcase":
			return `${buildSubcaseJoinNodeset(via.identifier)}/${leaf}`;
		case "any-relation": {
			// XPath `|` is the node-set union operator; the result is
			// one node-set containing every node from either direction,
			// and `(<set>) = <rhs>` returns true when any member of the
			// set equals the RHS.
			const ancestor = `${buildAncestorJoinNodeset([{ identifier: via.identifier }])}/${leaf}`;
			const subcase = `${buildSubcaseJoinNodeset(via.identifier)}/${leaf}`;
			return `(${ancestor} | ${subcase})`;
		}
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`emitOnDevicePropertyRef: unhandled RelationPath kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Compile a primitive literal to its on-device wire form. Numbers
 * emit as unquoted XPath numbers via `formatNumeric` (CommCare's
 * grammar rejects scientific notation; see `formatNumeric`'s JSDoc
 * for the grammar citation). Booleans emit as the strings `'true'` /
 * `'false'`; `null` emits as `''` because XPath compares an absent
 * attribute equal to `''`, so `<prop> = ''` is the natural "is
 * unset" form.
 *
 * String literals route through `quoteLiteral` for the per-dialect
 * escape strategy. The on-device dialect has XPath 1.0's `concat()`
 * available for the embedded-quote fallback, so values containing
 * single quotes emit as `concat('part1', "'", 'part2', ...)`.
 */
export function emitOnDeviceLiteralValue(
	value: string | number | boolean | null,
): string {
	if (value === null) return "''";
	if (typeof value === "number") return formatNumeric(value);
	if (typeof value === "boolean") return value ? "'true'" : "'false'";
	return quoteLiteral(value, "case-list-filter");
}

// ============================================================
// CSQL term emission (segment-list IR)
// ============================================================
//
// CSQL's two-arm `TermEmission` distinguishes compile-time-known
// emissions (constants — emitted directly into the CSQL string) from
// runtime-resolved emissions (an XPath path expression whose result
// interpolates as a string into the CSQL fragment via the surrounding
// `concat(...)` wrapper).
//
// The named alias types (`ConstantTermEmission` / `RuntimeTermEmission`)
// let callers narrow the return type when they know an emitter
// produces only one arm — `emitCsqlPropertyRefSegment` always returns
// the constant arm because a property reference is always a compile-
// time-known identifier, so its return type lifts the dead-branch
// guarantee into the type system.

export type ConstantTermEmission = {
	readonly kind: "constant";
	readonly text: string;
};
export type RuntimeTermEmission = {
	readonly kind: "runtime";
	readonly xpath: string;
};
export type TermEmission = ConstantTermEmission | RuntimeTermEmission;

/**
 * Compile a term to its CSQL wire form. Terms with a compile-time-
 * known value (literals, property references) emit as `constant`;
 * terms resolved at runtime against an instance path (search-input
 * refs, session refs, synthetic hoist refs sharing the search-input
 * wire shape) emit as `runtime`.
 */
export function emitTermSegment(t: Term): TermEmission {
	switch (t.kind) {
		case "prop":
			return { kind: "constant", text: emitCsqlPropertyRefText(t) };
		case "input":
			return { kind: "runtime", xpath: emitSearchInputXPath(t) };
		case "session-user":
			return { kind: "runtime", xpath: emitSessionUserXPath(t) };
		case "session-context":
			return { kind: "runtime", xpath: emitSessionContextXPath(t) };
		case "literal":
			return emitCsqlLiteralSegment(t.value);
		default: {
			const _exhaustive: never = t;
			throw new Error(
				`emitTermSegment: unhandled term kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Compile a property reference to its CSQL identifier text. Reserved
 * case attributes (`case_id`, `case_type`, `owner_id`, `status`) get
 * the `@`-prefix per CCHQ's `INDEXED_METADATA_BY_KEY` registration at
 * `commcare-hq/corehq/apps/case_search/const.py::INDEXED_METADATA_BY_KEY`.
 * User-defined properties pass through bare.
 *
 * The `via` slot — relation walks reaching a property on a related
 * case — is dropped at this emission layer because CCHQ's CSQL
 * comparison-form for relational reads uses the slash-path shape on
 * the comparison's left side (`<rel>/<prop> = <value>` parsed via
 * `is_ancestor_comparison` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::is_ancestor_comparison`),
 * which the emitter does not generate. The intended path for
 * relational reads is `exists` / `missing` predicates that carry the
 * relation walk explicitly.
 */
export function emitCsqlPropertyRefText(t: PropertyRef): string {
	if (RESERVED_CASE_ATTRIBUTES.has(t.property)) {
		return `@${quoteIdentifier(t.property)}`;
	}
	return quoteIdentifier(t.property);
}

/**
 * Wrap a `PropertyRef` emission as a `ConstantTermEmission`. The
 * narrowed return type lifts the property-ref-is-always-constant
 * guarantee into the type system so callers that depend on the
 * constancy (e.g. emitting a function-call wrapper that splices the
 * property text inline) need not branch on the runtime arm.
 */
export function emitCsqlPropertyRefSegment(
	t: PropertyRef,
): ConstantTermEmission {
	return { kind: "constant", text: emitCsqlPropertyRefText(t) };
}

/**
 * Compile a search-input ref to its CSQL runtime XPath. The wire form
 * `instance('search-input:results')/input/field[@name='<name>']` is
 * the canonical search-input read documented in
 * `commcare-hq/docs/case_search_query_language.rst` and registered at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/instances.py::search_input_instances`.
 *
 * `name` is constrained at the schema layer to XML element-name
 * vocabulary (no hyphens, no quotes), so direct interpolation is
 * safe.
 */
export function emitSearchInputXPath(t: SearchInputRef): string {
	return `instance('search-input:results')/input/field[@name='${t.name}']`;
}

/**
 * Compile a session-user ref to its on-device XPath. The wire form
 * `instance('commcaresession')/session/user/data/<field>` reads from
 * the open-namespace custom user-data tree populated by
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java::SessionInstanceBuilder.addUserProperties`.
 */
export function emitSessionUserXPath(t: SessionUserRef): string {
	return `instance('commcaresession')/session/user/data/${t.field}`;
}

/**
 * Compile a session-context ref to its on-device XPath. The wire form
 * `instance('commcaresession')/session/context/<field>` reads from
 * the closed-namespace framework-controlled context tree populated by
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java::SessionInstanceBuilder.addMetadata`.
 */
export function emitSessionContextXPath(t: SessionContextRef): string {
	return `instance('commcaresession')/session/context/${t.field}`;
}

/**
 * Compile a literal to its CSQL wire-form constant text. Numeric
 * literals route through `formatNumeric` to dodge XPath's exponent-
 * form rejection; boolean literals emit as the strings `'true'` /
 * `'false'` matching CCHQ's case-property storage shape; `null`
 * literals emit as `''` (the natural absent / empty form). String
 * literals route through `quoteLiteral(value, "csql")` for the per-
 * dialect single↔double quote-style escape.
 */
export function emitCsqlLiteralSegment(
	value: string | number | boolean | null,
): TermEmission {
	if (value === null) return { kind: "constant", text: "''" };
	if (typeof value === "number") {
		return { kind: "constant", text: formatNumeric(value) };
	}
	if (typeof value === "boolean") {
		return { kind: "constant", text: value ? "'true'" : "'false'" };
	}
	return { kind: "constant", text: quoteLiteral(value, "csql") };
}

/**
 * Wrap a single `TermEmission` into a `CsqlSegment[]`. Constant
 * emissions become a single constant segment; runtime emissions wrap
 * in CSQL double-quoted brackets so the runtime XPath result
 * interpolates as a CSQL string value (the canonical pattern
 * documented in `commcare-hq/docs/case_search_query_language.rst`).
 *
 * Centralising the wrap shape here keeps every operand emission path
 * — comparison operands, `in` values, `between` bounds, expression-
 * emitter operand sites — consistent on the runtime-bracketing rule.
 */
export function wrapTermAsSegmentList(term: TermEmission): CsqlSegment[] {
	if (term.kind === "constant") {
		return [{ kind: "constant", text: term.text }];
	}
	return [
		{ kind: "constant", text: '"' },
		{ kind: "runtime", xpath: term.xpath },
		{ kind: "constant", text: '"' },
	];
}

/**
 * Slash-join a relation-step chain into the path serialization CCHQ
 * parses at `ancestor_functions.py::_is_ancestor_path_expression`. The
 * walker there reads the argument as a binary expression of `Step /
 * Step / ...` nodes, where each `Step` carries a single identifier;
 * serializing the chain as `parent/host` matches the parser's
 * expected shape.
 */
export function serializeAncestorPath(steps: readonly RelationStep[]): string {
	return steps.map((s) => s.identifier).join("/");
}
