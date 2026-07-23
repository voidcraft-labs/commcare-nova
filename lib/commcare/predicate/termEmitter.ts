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
import type { Uuid } from "@/lib/domain/uuid";
import { emitCasePropertyWirePath } from "../casePropertyWire";
import type { CsqlSegment } from "./csqlSegment";
import { formatNumeric, quoteLiteral } from "./stringQuoting";

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
export { RESERVED_CASE_ATTRIBUTES } from "../casePropertyWire";

/** Form-submission-only XPath bindings for identity-backed expression leaves. */
export interface OnDeviceExpressionBindings {
	readonly formFields?: ReadonlyMap<Uuid, string>;
	readonly operationIds?: ReadonlyMap<Uuid, string>;
	/** Case-id expression that replaces `current()/@case_id` at a form
	 *  expression's root. Related-case predicate scopes intentionally ignore
	 *  it because their body is evaluated candidate-relative. */
	readonly rootCaseId?: string;
	/** Optional form-surface anchor for case-property reads. Case-list and
	 *  search predicates evaluate with a case as `current()`, so their normal
	 *  property emission is relative. Form submission expressions do not;
	 *  they supply a resolver that anchors reads on the loaded case snapshot. */
	readonly caseProperty?: (
		property: PropertyRef,
		root: InstanceRoot,
		scope: "root" | "related",
	) => string | undefined;
}

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
 * Storage-instance root selector for emitted wire shapes. The
 * default `"casedb"` keeps the canonical
 * `instance('casedb')/casedb/case[...]` shape every case-loading
 * slot consumes. The `"results"` arm rewrites the root to
 * `instance('results')/results/case[...]` for emission inside a
 * search-target `<detail>` block — CCHQ's
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_search_short']`
 * pins the shape; the search-result roster lives at
 * `instance('results')` instead of `instance('casedb')`.
 *
 * The path segment between the instance reference and the
 * `case[...]` predicate mirrors the instance name (`/casedb/case` vs
 * `/results/case`) — CCHQ's wire grammar binds both segments to the
 * surrounding instance id.
 */
export type InstanceRoot = "casedb" | "results";

/**
 * Optional leaf override for an on-device evaluation surface whose current
 * case is not the surrounding nodeset row. Form-command relevancy is the one
 * current caller: its direct self properties must anchor through the selected
 * session `case_id`. Related reads never use this hook.
 */
export interface OnDeviceTermEmissionContext
	extends OnDeviceExpressionBindings {
	readonly emitSelfProperty?: (property: PropertyRef) => string;
}

/** Default instance root — every on-device emission outside a
 *  search-target detail block consumes the casedb roster. */
export const DEFAULT_INSTANCE_ROOT: InstanceRoot = "casedb";

/**
 * Build the `instance('<root>')/<root>/case[@case_id=<anchor>]`
 * nodeset for an ancestor walk. The first hop anchors against
 * `current()/index/<rel>`; each subsequent hop nests inside the
 * previous hop's nodeset as `<previous>/index/<next>`. The canonical
 * shape with one hop is
 * `instance('<root>')/<root>/case[@case_id=current()/index/<rel0>]`;
 * with two hops it composes to
 * `instance('<root>')/<root>/case[@case_id=instance('<root>')/<root>/case[@case_id=current()/index/<rel0>]/index/<rel1>]`.
 *
 * Source: CCHQ's hashtag-replacement pattern at
 * `commcare-hq/corehq/apps/app_manager/xpath.py::interpolate_xpath`
 * builds the same wire shape (`#parent` / `#host` expand to
 * `instance('casedb')/casedb/case[@case_id=<base>/index/<rel>]`); the
 * search-target detail variant pins `instance('results')` at
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_search_short']`.
 *
 * `root` defaults to the case-loading roster. The search-target
 * detail emission threads `"results"` for emission inside a
 * `<detail id="m{N}_search_*">` block — CCHQ's runtime evaluates
 * relation walks there against the search-result roster, not the
 * local casedb. Nested hops keep the same `root`; cross-instance
 * walks are not a CCHQ wire shape.
 *
 * Accepts a non-empty list of relation steps; the
 * `RelationPath`-with-`ancestor` schema's tuple-with-rest shape
 * already enforces non-empty at parse time.
 */
export function buildAncestorJoinNodeset(
	via: ReadonlyArray<RelationStep>,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
): string {
	let nodeset = buildCaseByIdNodeset(
		`current()/index/${via[0].identifier}`,
		via[0].throughCaseType,
		root,
	);
	for (let i = 1; i < via.length; i++) {
		nodeset = buildCaseByIdNodeset(
			`${nodeset}/index/${via[i].identifier}`,
			via[i].throughCaseType,
			root,
		);
	}
	return nodeset;
}

function buildCaseByIdNodeset(
	caseId: string,
	caseType: string | undefined,
	root: InstanceRoot,
): string {
	const typeFilter =
		caseType === undefined
			? ""
			: ` and @case_type=${quoteLiteral(caseType, "case-list-filter")}`;
	return `instance('${root}')/${root}/case[@case_id=${caseId}${typeFilter}]`;
}

/**
 * Build the
 * `instance('<root>')/<root>/case[index/<rel>=current()/@case_id]`
 * nodeset for a subcase walk. Reverse-direction join: the inner case
 * has `index/<rel>` pointing back at the outer case's `@case_id`.
 * `current()/@case_id` reads the outer case's id from the predicate's
 * evaluation context (inside a casedb nodeset filter, `current()` is
 * the case being filtered).
 *
 * The canonical CCHQ example pinning this shape (against the
 * casedb root) is at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::_update_refs`.
 * No CCHQ fixture exercises a subcase walk against the search-result
 * roster (`instance('results')`) — the search-result instance carries
 * only the cases the search query returned, and CCHQ's
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`
 * fixture pins only ancestor walks against it. A subcase walk under
 * a search-target detail may therefore be a wire shape CCHQ's
 * runtime treats as an empty result set; the rewrite here keeps the
 * structural shape symmetric with the ancestor walk, but the
 * meaning at runtime is unverified.
 */
export function buildSubcaseJoinNodeset(
	identifier: string,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
	ofCaseType?: string,
	anchorCaseId = "current()/@case_id",
): string {
	const typeFilter =
		ofCaseType === undefined
			? ""
			: ` and @case_type=${quoteLiteral(ofCaseType, "case-list-filter")}`;
	return `instance('${root}')/${root}/case[index/${identifier}=${anchorCaseId}${typeFilter}]`;
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
 *
 * `root` threads to the property-ref emitter for the case-roster
 * instance selector — the search-target detail block emits against
 * `instance('results')` instead of `instance('casedb')`. The other
 * arms (search-input, session, literal) name fixed instance ids
 * unrelated to the case roster, so they ignore `root`.
 */
export function emitTerm(
	term: Term,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
	context: OnDeviceTermEmissionContext = {},
	casePropertyScope: "root" | "related" = "root",
): string {
	switch (term.kind) {
		case "prop": {
			if (
				context.emitSelfProperty !== undefined &&
				(term.via === undefined || term.via.kind === "self")
			) {
				return context.emitSelfProperty(term);
			}
			return (
				context.caseProperty?.(term, root, casePropertyScope) ??
				emitOnDevicePropertyRef(term, root)
			);
		}
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
		case "field": {
			const xpath = context.formFields?.get(term.uuid);
			if (xpath === undefined) {
				throw new Error(
					`emitTerm: form field '${term.uuid}' has no XPath binding in this expression context.`,
				);
			}
			return xpath;
		}
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
 *     case-type qualifier is dropped; the surrounding casedb /
 *     results nodeset selects the wire-correct case type at
 *     execution time.
 *   - **Ancestor walk**: prepend
 *     `instance('<root>')/<root>/case[@case_id=current()/index/<rel>]`
 *     (with multi-hop nesting) and join the property name with `/`.
 *   - **Subcase walk**: prepend
 *     `instance('<root>')/<root>/case[index/<rel>=current()/@case_id]`
 *     and join with `/`. Subcase reads select multiple cases when
 *     more than one subcase points back; authors who need cardinality
 *     control compose via `exists` / `count` instead.
 *   - **Direction-agnostic walk** (`any-relation`): combine both
 *     direction-specific paths via XPath's union operator `|`,
 *     producing `(<ancestor-path> | <subcase-path>)`. This helper only
 *     constructs the raw node-set. CommCare Core does NOT implement XPath
 *     1.0 general node-set comparison and throws when scalar coercion sees
 *     several nodes, so validated scalar slots reject this shape and
 *     predicate slots normalize it into explicit direction-specific
 *     quantifiers before comparison. Callers must not treat this union as an
 *     existential scalar comparison shortcut.
 *
 * `root` selects the storage-instance id woven into every relation-
 * walk anchor — `"casedb"` for the case-loading roster (default),
 * `"results"` for emission inside a search-target detail block. The
 * leaf identifier is identical regardless of root.
 *
 * Reserved CommCare attributes pick up the `@` prefix at the leaf;
 * everything else flows through `quoteIdentifier` for the lexical
 * pass-through.
 */
export function emitOnDevicePropertyRef(
	prop: PropertyRef,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
): string {
	const leaf = emitCasePropertyWirePath(prop.property);
	const via = prop.via;
	if (via === undefined || via.kind === "self") {
		return leaf;
	}
	switch (via.kind) {
		case "ancestor":
			return `${buildAncestorJoinNodeset(via.via, root)}/${leaf}`;
		case "subcase":
			return `${buildSubcaseJoinNodeset(via.identifier, root, via.ofCaseType)}/${leaf}`;
		case "any-relation": {
			// XPath `|` is the node-set union operator. Core cannot generally
			// scalar-compare a multi-node result; validated consumers normalize
			// or reject this shape before it reaches a comparison.
			const ancestor = `${buildAncestorJoinNodeset([{ identifier: via.identifier, throughCaseType: via.ofCaseType }], root)}/${leaf}`;
			const subcase = `${buildSubcaseJoinNodeset(via.identifier, root, via.ofCaseType)}/${leaf}`;
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
	readonly inputNames?: readonly string[];
};
export type TermEmission = ConstantTermEmission | RuntimeTermEmission;

/**
 * Fixed CSQL expression returned instead of an authored query when a runtime
 * string contains both quote delimiters. CCHQ's CSQL parser accepts either
 * single- or double-quoted XPath literals but has no escape syntax and does
 * not whitelist `concat()` as a value function, so such a value is inherently
 * unrepresentable. A fixed unknown function makes the remote query fail
 * explicitly without allowing any runtime bytes to reach the CSQL grammar.
 */
export const CSQL_UNREPRESENTABLE_RUNTIME_STRING =
	"nova-runtime-value-contains-both-quote-types()";

export type RuntimeCsqlQuoteStyle = "single" | "double";

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
			return {
				kind: "runtime",
				xpath: emitSearchInputXPath(t),
				inputNames: [t.name],
			};
		case "session-user":
			return { kind: "runtime", xpath: emitSessionUserXPath(t) };
		case "session-context":
			return { kind: "runtime", xpath: emitSessionContextXPath(t) };
		case "field":
			throw new Error(
				"emitTermSegment: form-field terms are form-submission values and cannot be emitted into server-side CSQL.",
			);
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
 * The `via` slot is always `self` (or absent) at this emission
 * layer: `lib/domain/predicate/normalizeRelationReads.ts`
 * rewrites every `prop(via)` reference that reaches native CSQL
 * emission — directly or through a native value function — into an
 * enclosing `exists` envelope before the segment emitter runs, so
 * the relation walk emits via CCHQ's `ancestor-exists` /
 * `subcase-exists` query functions rather than as an inline read on
 * a comparison operand. CCHQ's parser also recognises a
 * `<rel>/<prop> = <value>` slash-path form on the comparison's left
 * side via `is_ancestor_comparison` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::is_ancestor_comparison`,
 * but Nova never emits it — staying on the single envelope form
 * keeps the wire surface consistent across operators and avoids
 * per-operator branching on which slots admit the slash-path shape.
 */
export function emitCsqlPropertyRefText(t: PropertyRef): string {
	return emitCasePropertyWirePath(t.property);
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
 * emissions become a single constant segment; runtime emissions route
 * through `quoteRuntimeCsqlValue` so the runtime XPath result becomes a
 * complete CSQL string literal with a delimiter chosen after evaluation.
 *
 * Centralising the wrap shape here keeps every operand emission path
 * — comparison operands, `in` values, `between` bounds, expression-
 * emitter operand sites — consistent on the runtime-bracketing rule.
 */
export function wrapTermAsSegmentList(term: TermEmission): CsqlSegment[] {
	if (term.kind === "constant") {
		return [{ kind: "constant", text: term.text }];
	}
	return quoteRuntimeCsqlValue(term.xpath, "double", term.inputNames);
}

/**
 * Emit one runtime XPath value as an already-quoted CSQL string literal.
 *
 * The quote choice happens on-device after the value resolves:
 *
 * - use the preferred delimiter when the value does not contain it;
 * - otherwise use the other CSQL delimiter, preserving every byte;
 * - attach a rejection condition when the value contains both delimiters.
 *
 * The final wrapper consumes `rejectWhen` before evaluating the query-building
 * concat. This is intentionally not sanitization: removing or replacing quote
 * characters would silently change exact-match semantics. The preferred style
 * defaults to CCHQ's documented double-quoted runtime scalar form; callers
 * interpolating JSON (notably `unwrap-list`) prefer single quotes because JSON
 * necessarily carries double quotes.
 */
export function quoteRuntimeCsqlValue(
	xpath: string,
	preferredStyle: RuntimeCsqlQuoteStyle = "double",
	inputNames?: readonly string[],
): CsqlSegment[] {
	const containsSingle = `contains(${xpath}, "'")`;
	const containsDouble = `contains(${xpath}, '"')`;
	const singleQuoted = `concat("'", ${xpath}, "'")`;
	const doubleQuoted = `concat('"', ${xpath}, '"')`;
	const quoted =
		preferredStyle === "single"
			? `if(${containsSingle}, ${doubleQuoted}, ${singleQuoted})`
			: `if(${containsDouble}, ${singleQuoted}, ${doubleQuoted})`;

	return [
		{
			kind: "runtime",
			xpath: quoted,
			rejectWhen: `${containsSingle} and ${containsDouble}`,
			rejectionInputNames: inputNames,
		},
	];
}

/**
 * Slash-join a relation-step chain into the bare path text that
 * lands as `ancestor-exists`'s first argument on the wire — `parent`
 * for a single step, `parent/host` for a chain. The CSQL emitter
 * embeds the return value verbatim into the function call, without
 * surrounding quotes, because CCHQ's
 * `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::_is_ancestor_path_expression`
 * requires the AST node to be a `Step` or `BinaryExpression(op='/')`
 * — a string Literal silently fails the walker and the search
 * returns zero rows. Each `RelationStep.identifier` is already
 * schema-constrained to the CCHQ identifier shape (no embedded
 * slashes or quotes), so the slash-joined result is grammar-safe
 * without escaping.
 */
export function serializeAncestorPath(steps: readonly RelationStep[]): string {
	return steps.map((s) => s.identifier).join("/");
}
