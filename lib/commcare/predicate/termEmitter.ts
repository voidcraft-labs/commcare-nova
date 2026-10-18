// CSQL leaves and runtime interpolation. Device lowering lives in xpath/wire.
import type {
	SearchInputDecl,
	SearchInputInstanceId,
} from "@/lib/domain/predicate/typeChecker";
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
import { w } from "../xpath/wire/builders";
import { toWire } from "../xpath/wire/fromExpression";
import type { WireExpr } from "../xpath/wire/tree";
import type { CsqlSegment } from "./csqlSegment";
import { formatNumeric, quoteLiteral } from "./stringQuoting";
export type ConstantTermEmission = {
	readonly kind: "constant";
	readonly text: string;
};
export type RuntimeTermEmission = {
	readonly kind: "runtime";
	readonly xpath: WireExpr;
	readonly inputNames?: readonly string[];
	/**
	 * The runtime value structurally cannot contain a quote character, so a
	 * fixed double-quote CSQL delimiter is safe and no quote-choice `if` or
	 * fail-closed obligation is needed. Set for `date`-widget search inputs:
	 * on web apps `<prompt input="date">` binds the date picker's
	 * `yyyy-MM-dd` text (`commcare-core .../util/screen/QueryScreen.java::getSupportedPrompts`
	 * registers `INPUT_TYPE_DATE`), and Android omits `date` from its
	 * supported-prompt list entirely
	 * (`commcare-android .../activities/QueryRequestActivity.java::getSupportedPrompts`),
	 * so there the value is always absent and the interpolation is never
	 * reached. No runtime lets a worker type free text into the slot.
	 */
	readonly quoteFree?: boolean;
};
export type TermEmission = ConstantTermEmission | RuntimeTermEmission;

export type RuntimeCsqlQuoteStyle = "single" | "double";

/**
 * Compile a term to its CSQL wire form. Terms with a compile-time-
 * known value (literals, property references) emit as `constant`;
 * terms resolved at runtime against an instance path (search-input
 * refs, session refs, synthetic hoist refs sharing the search-input
 * wire shape) emit as `runtime`.
 */
export function emitTermSegment(
	t: Term,
	context: {
		readonly userPropertySlugs?: ReadonlyMap<Uuid, string>;
		readonly knownInputs?: ReadonlyArray<SearchInputDecl>;
		readonly searchInputInstanceId?: SearchInputInstanceId;
	} = {},
): TermEmission {
	switch (t.kind) {
		case "prop":
			return { kind: "constant", text: emitCsqlPropertyRefText(t) };
		case "input": {
			const searchInputNames = new Map(
				(context.knownInputs ?? []).map((input) => [input.uuid, input.name]),
			);
			const declaredType = (context.knownInputs ?? []).find(
				(input) => input.uuid === t.searchInputUuid,
			)?.data_type;
			return {
				kind: "runtime",
				xpath: emitSearchInputXPath(t, {
					searchInputNames,
					searchInputInstanceId: context.searchInputInstanceId,
				}),
				inputNames: [resolveSearchInputName(t, { searchInputNames })],
				// A `date`-widget input's runtime value is picker-formatted
				// `yyyy-MM-dd` text on every runtime that binds it — see the
				// `quoteFree` slot's JSDoc for the per-platform citations.
				...(declaredType === "date" ? { quoteFree: true } : {}),
			};
		}
		case "session-user":
			return { kind: "runtime", xpath: emitSessionUserXPath(t) };
		case "session-user-property": {
			const slug = context.userPropertySlugs?.get(t.userPropertyUuid);
			if (slug === undefined) {
				throw new Error(
					`emitTermSegment: worker-information property '${t.userPropertyUuid}' has no current saved-name binding.`,
				);
			}
			return {
				kind: "runtime",
				xpath: emitSessionUserXPath({ kind: "session-user", field: slug }),
			};
		}
		case "session-context":
			return { kind: "runtime", xpath: emitSessionContextXPath(t) };
		case "form-case":
		case "field":
			throw new Error(
				"emitTermSegment: form-field terms are form-submission values and cannot be emitted into server-side CSQL.",
			);
		case "literal":
			return emitCsqlLiteralSegment(t.value);
		case "fixed-location":
		case "owner-location-at-level":
			throw new Error(
				`emitTermSegment: '${t.kind}' is an on-device organization lookup and cannot be emitted into server-side CSQL.`,
			);
		case "table-column":
			throw new Error(
				"emitTermSegment: a lookup-table column term is valid only inside its table-lookup row predicate. It cannot be emitted directly into a case-query CSQL value; validation should reject the escaped table-row term before emission.",
			);
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
export interface CsqlSearchInputContext {
	readonly searchInputNames?: ReadonlyMap<Uuid, string>;
	readonly searchInputInstanceId?: SearchInputInstanceId;
}
export function emitSearchInputXPath(
	t: SearchInputRef,
	context: CsqlSearchInputContext = {},
): WireExpr {
	return toWire(
		{ kind: "term", term: t },
		{ target: "csql-runtime", types: {}, bindings: context },
	);
}

/** The answer instance of a standalone `<remote-request>` search. */
export const STANDALONE_SEARCH_INPUT_INSTANCE_ID = "search-input:results";

function resolveSearchInputName(
	t: SearchInputRef,
	context: Pick<CsqlSearchInputContext, "searchInputNames">,
): string {
	const name = context.searchInputNames?.get(t.searchInputUuid);
	if (name === undefined) {
		throw new Error(
			`Search input identity '${t.searchInputUuid}' has no current runtime-name binding.`,
		);
	}
	return name;
}

/**
 * Compile a session-user ref to its on-device XPath. The wire form
 * `instance('commcaresession')/session/user/data/<field>` reads from
 * the open-namespace custom user-data tree populated by
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java::SessionInstanceBuilder.addUserProperties`.
 */
export function emitSessionUserXPath(t: SessionUserRef): WireExpr {
	return toWire(
		{ kind: "term", term: t },
		{ target: "csql-runtime", types: {} },
	);
}

/**
 * Compile a session-context ref to its on-device XPath. The wire form
 * `instance('commcaresession')/session/context/<field>` reads from
 * the closed-namespace framework-controlled context tree populated by
 * `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java::SessionInstanceBuilder.addMetadata`.
 */
export function emitSessionContextXPath(t: SessionContextRef): WireExpr {
	return toWire(
		{ kind: "term", term: t },
		{ target: "csql-runtime", types: {} },
	);
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
 * Quote-free runtime emissions (a `date`-widget input — see the
 * `RuntimeTermEmission.quoteFree` JSDoc) skip the delimiter choice
 * entirely: the fixed double-quote delimiters emit as their own constant
 * segments around the raw value read, so the merge pass folds them into
 * the neighbouring CSQL text and the final wire form is the flat
 * doc-canonical `concat('… >= date("', <value>, '") …')` shape with no
 * `if` and no fail-closed obligation.
 *
 * Centralising the wrap shape here keeps every operand emission path
 * — comparison operands, `in` values, `between` bounds, expression-
 * emitter operand sites — consistent on the runtime-bracketing rule.
 */
export function wrapTermAsSegmentList(term: TermEmission): CsqlSegment[] {
	if (term.kind === "constant") {
		return [{ kind: "constant", text: term.text }];
	}
	if (term.quoteFree === true) {
		return quoteFreeRuntimeCsqlValue(term.xpath);
	}
	return quoteRuntimeCsqlValue(term.xpath, "double", term.inputNames);
}

/**
 * Emit a structurally quote-free runtime value as raw interpolation between
 * fixed double-quote CSQL delimiters. The delimiters are constant segments so
 * adjacent CSQL text merges around the value at the wrap layer.
 */
export function quoteFreeRuntimeCsqlValue(xpath: WireExpr): CsqlSegment[] {
	return [
		{ kind: "constant", text: '"' },
		{ kind: "runtime", xpath },
		{ kind: "constant", text: '"' },
	];
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
 * defaults to CCHQ's documented double-quoted runtime scalar form. Callers
 * that interpolate JSON may prefer single quotes because JSON necessarily
 * carries double quotes.
 */
export function quoteRuntimeCsqlValue(
	xpath: WireExpr,
	preferredStyle: RuntimeCsqlQuoteStyle = "double",
	inputNames?: readonly string[],
): CsqlSegment[] {
	const containsSingle = w.call("contains", [xpath, w.str("'")]);
	const containsDouble = w.call("contains", [xpath, w.str('"')]);
	const singleQuoted = w.call("concat", [w.str("'"), xpath, w.str("'")]);
	const doubleQuoted = w.call("concat", [w.str('"'), xpath, w.str('"')]);
	const quoted =
		preferredStyle === "single"
			? w.call("if", [containsSingle, doubleQuoted, singleQuoted])
			: w.call("if", [containsDouble, singleQuoted, doubleQuoted]);
	return [
		{
			kind: "runtime",
			xpath: quoted,
			...(preferredStyle === "double" ? { stringValueXPath: xpath } : {}),
			rejectWhen: w.and(containsSingle, containsDouble),
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
