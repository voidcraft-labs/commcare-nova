/**
 * Static reference joins for generated XForms and their suite entry datums.
 * This test-only oracle checks declarations and Nova's closed session context.
 * It does not execute XPath or install media. XFormOracleRuntimeTest proves
 * missing session leaves and undeclared instances can refuse scalar calculation
 * differently; references are checked before their evaluation context is known.
 * Media references belong to xformOracle.ts; syntax belongs to pathExpression.
 * Runtime search-produced session data is outside the declared datum contract.
 */

import type { SyntaxNode } from "@lezer/common";
import { getAttributeValue } from "domutils";
import { parser } from "@/lib/commcare/xpath";
import { COMMCARE_SESSION_CONTEXT_FIELDS } from "../sessionContext";
import {
	type ValidationError,
	type ValidationLocation,
	validationError,
} from "./errors";
import { buildXFormDataModel, type XFormDataModel } from "./xformDataModel";

/**
 * The closed set of `session/context/<X>` fields CommCare populates on the
 * session instance. Sourced from
 * `commcare-core/.../session/SessionInstanceBuilder.java::addMetadata`:
 *
 *   deviceid, appversion, username, userid, drift, window_width, applanguage
 *
 * `addUserProperties` also populates `session/user/data/*` from user
 * fields, but those are a separate path (`/session/user/data/<X>`, not
 * `/session/context/<X>`); user-data references are unbounded by design
 * (operators add custom user fields), so this oracle does NOT validate
 * them. The context set is the closed surface that's always available
 * and whose membership errors are catchable structurally.
 */
const SESSION_CONTEXT_FIELDS: ReadonlySet<string> = new Set(
	COMMCARE_SESSION_CONTEXT_FIELDS,
);

/**
 * The XPath surfaces JavaRosa evaluates at install / form-init time. Each
 * lives on the form's `<model>` block (binds + setvalues) or in the body
 * (`<output>`). The XForm oracle's PATH/ANY classifiers gate which attrs
 * may carry an expression — this oracle assumes those gates have already
 * passed and focuses on whether the references inside the expressions
 * resolve.
 */
interface XPathSurface {
	/** The expression text — guaranteed already parseable by xformOracle. */
	readonly expr: string;
	/** Where the expression came from — used for error messaging. */
	readonly origin: string;
}

/** Resolve emitted references against actual form declarations and entry datums. */
export function validateBindingResolution(
	xml: string,
	formName: string,
	moduleName: string,
	sessionDatumIds: ReadonlySet<string>,
): ValidationError[] {
	const built = buildXFormDataModel(xml, formName, moduleName);
	if ("fatal" in built) return [built.fatal];
	const model = built.model;

	const loc: ValidationLocation = { formName, moduleName };
	const errors: ValidationError[] = [];

	for (const surface of collectXPathSurfaces(model)) {
		const refs = analyzeXPath(surface.expr);

		// Rule 3: every `instance('<id>')` reference, including session,
		// must appear in the XForm's `<model><instance id=...>` declarations.
		for (const id of refs.instanceIds) {
			if (model.declaredInstanceIds.has(id)) continue;
			errors.push(
				validationError(
					"BINDING_RESOLUTION_INSTANCE_UNDECLARED",
					"form",
					`"${formName}" references instance("${id}") in ${surface.origin}, but the form's <model> has no <instance id="${id}"> declaration. CommCare cannot evaluate this undeclared instance. Check that the XForm emitter declared the secondary instance for whatever the form needs. This is a bug in the form generator.`,
					loc,
				),
			);
		}

		// Rule 1: every `instance('commcaresession')/session/data/<X>` ref
		// must declare `<X>` as a session datum on the form's entry.
		for (const datumId of refs.sessionDataRefs) {
			if (sessionDatumIds.has(datumId)) continue;
			errors.push(
				validationError(
					"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
					"form",
					`"${formName}" references session datum "${datumId}" in ${surface.origin} (via instance('commcaresession')/session/data/${datumId}), but no <datum id="${datumId}"> is declared on this form's <entry> in suite.xml. A direct calculation from this missing datum can fail at initialization, and other expressions cannot read the intended value. Check that the entry emits a datum for whatever the form needs. This is a bug in the form generator.`,
					loc,
				),
			);
		}

		// Rule 2: every `instance('commcaresession')/session/context/<X>` ref
		// must be one of the closed set CommCare populates.
		for (const ctxName of refs.sessionContextRefs) {
			if (SESSION_CONTEXT_FIELDS.has(ctxName)) continue;
			errors.push(
				validationError(
					"BINDING_RESOLUTION_SESSION_CONTEXT_UNKNOWN",
					"form",
					`"${formName}" references session/context/${ctxName} in ${surface.origin}, but CommCare only populates these context fields: ${[...SESSION_CONTEXT_FIELDS].sort().join(", ")}. A missing structural context name can fail when CommCare evaluates the expression. This is a bug in the form generator.`,
					loc,
				),
			);
		}

		// Local form-path existence is outside this declaration-join oracle.
		// Core can reject missing structural paths during calculation; domain
		// identity validation and the XForm bind/control checks own those paths.
	}

	return errors;
}

/**
 * Collect every install-time-evaluable XPath surface on a form: bind
 * calculate/relevant/constraint/required, `<setvalue value>`, and body
 * `<output value>`. Surfaces with no expression (or with an empty
 * expression) are skipped — empty isn't a reference and isn't an error.
 */
function collectXPathSurfaces(model: XFormDataModel): XPathSurface[] {
	const surfaces: XPathSurface[] = [];

	// Every `<bind>` element under `<model>`. The XForm oracle has already
	// proven the bind has a nodeset and the ANY-expression attrs parse; we
	// only need to walk the expression slots. Mirrors the surface list in
	// `xformOracle.ts::checkBinds` — JavaRosa evaluates all five attributes
	// via `buildCondition` / `buildCalculate` at parse, and references
	// inside any of them resolve at form-init.
	for (const bind of model.definitionElements.filter(
		(el) => el.name === "bind",
	)) {
		const nodeset = getAttributeValue(bind, "nodeset") ?? "<bind>";
		for (const attr of [
			"calculate",
			"relevant",
			"constraint",
			"required",
			"readonly",
		] as const) {
			const expr = getAttributeValue(bind, attr);
			if (expr) {
				surfaces.push({
					expr,
					origin: `<bind nodeset="${nodeset}" ${attr}=...>`,
				});
			}
		}
	}

	// `<setvalue>` value attribute. The `ref` is path-only (already checked
	// by xformOracle); `value` is the ANY-expression slot we resolve here.
	for (const setvalue of model.definitionElements.filter(
		(el) => el.name === "setvalue",
	)) {
		const ref = getAttributeValue(setvalue, "ref") ?? "<setvalue>";
		const value = getAttributeValue(setvalue, "value");
		if (value) {
			surfaces.push({
				expr: value,
				origin: `<setvalue ref="${ref}" value=...>`,
			});
		}
	}

	// `<output>` body elements. The `value` attribute is the expression
	// JavaRosa evaluates when rendering an itext label.
	for (const output of model.definitionElements.filter(
		(el) => el.name === "output",
	)) {
		const value =
			getAttributeValue(output, "ref") ?? getAttributeValue(output, "value");
		if (value) {
			surfaces.push({
				expr: value,
				origin: `<output ${getAttributeValue(output, "ref") !== undefined ? "ref" : "value"}=...>`,
			});
		}
	}

	return surfaces;
}

/**
 * The references an XPath expression makes that this oracle resolves.
 *
 * Lezer node names referenced below (matched via `cursor.type.name`):
 *   - `Invoke` — function call. We pattern-match `instance('X')` against
 *     this, looking at its `FunctionName` + first `StringLiteral` child.
 *   - `Child` / `Descendant` — left-recursive path step productions. In
 *     the parsed tree, each looks like `[expr, '/', step]` — the `/` is
 *     an anonymous terminal node, so the step lives at `lastChild`. The
 *     leftmost `Child` in an absolute path has the `/` token in
 *     `firstChild` slot rather than another expression.
 *   - `NameTest` — a plain element / attribute local name.
 *   - `AttrSpecified` — `@<name>` shape; wraps a `NameTest` as its only
 *     non-`@` child.
 *
 * SyntaxNode identity isn't preserved across accessors (Lezer fabricates
 * fresh wrappers on each `.firstChild` / `.parent` call), so all "is X
 * the same node as Y" checks compare by `.from` instead of `===`.
 */
interface XPathRefs {
	/** Every `instance('<id>')` call — `id` literal. */
	readonly instanceIds: ReadonlySet<string>;
	/** Every `instance('commcaresession')/session/data/<X>` — `X` segment. */
	readonly sessionDataRefs: ReadonlySet<string>;
	/** Every `instance('commcaresession')/session/context/<X>` — `X` segment. */
	readonly sessionContextRefs: ReadonlySet<string>;
	/** A session-instance path that can observe the whole `session/data`
	 * container rather than one exact datum leaf. */
	readonly broadSessionDataAccess: boolean;
}

/**
 * Walk one XPath expression, extract every install-time-resolvable
 * reference. Unparseable expressions contribute nothing — their parse
 * failure is the XForm oracle's concern.
 */
function analyzeXPath(expr: string): XPathRefs {
	const instanceIds = new Set<string>();
	const sessionDataRefs = new Set<string>();
	const sessionContextRefs = new Set<string>();
	let broadSessionDataAccess = false;

	const trimmed = expr.trim();
	if (!trimmed) {
		return {
			instanceIds,
			sessionDataRefs,
			sessionContextRefs,
			broadSessionDataAccess,
		};
	}

	const tree = parser.parse(trimmed);
	const cursor = tree.cursor();

	do {
		if (cursor.type.name !== "Invoke") continue;
		const invoke = cursor.node;
		const id = readInstanceCallArgument(trimmed, invoke);
		if (id === null) continue;
		instanceIds.add(id);
		if (id !== "commcaresession") continue;
		const trailing = collectTrailingPathSteps(trimmed, invoke);
		const access = classifySessionDataAccess(trailing);
		broadSessionDataAccess ||=
			access.broad || resolvedSessionPathParticipatesInFilter(invoke);
		if (access.exactDatumId !== undefined) {
			sessionDataRefs.add(access.exactDatumId);
		}
		if (
			isExactChildName(trailing[0], "session") &&
			isExactChildName(trailing[1], "context") &&
			trailing[2]?.axis === "child" &&
			trailing[2].name !== undefined
		) {
			sessionContextRefs.add(trailing[2].name);
		}
	} while (cursor.next());

	return {
		instanceIds,
		sessionDataRefs,
		sessionContextRefs,
		broadSessionDataAccess,
	};
}

/**
 * Exact session datum ids referenced by one already-projected XPath.
 *
 * This is structural over the Lezer tree: callers compare the returned ids
 * with datums derived from the source entry instead of guessing from text or
 * matching a `case_id_new_*` prefix.
 */
export function sessionDataReferencesInXPath(
	expr: string,
): ReadonlySet<string> {
	return analyzeXPath(expr).sessionDataRefs;
}

export interface SessionDataXPathAccess {
	readonly exactDatumIds: ReadonlySet<string>;
	readonly broad: boolean;
}

/** Exact datum leaves plus whether the expression structurally reaches a
 * broader/ancestor/wildcard/descendant view of `session/data`. */
export function sessionDataAccessInXPath(expr: string): SessionDataXPathAccess {
	const analyzed = analyzeXPath(expr);
	return {
		exactDatumIds: analyzed.sessionDataRefs,
		broad: analyzed.broadSessionDataAccess,
	};
}

/**
 * Given an `Invoke` node, return the unquoted id when it is an
 * `instance('<id>')` call, or `null` otherwise. Same shape as
 * `xform/instanceRefs.ts::readInstanceArgument` — kept local to keep the
 * oracle module self-contained.
 */
function readInstanceCallArgument(
	source: string,
	invoke: SyntaxNode,
): string | null {
	const fnName = invoke.firstChild;
	if (fnName === null || fnName.type.name !== "FunctionName") return null;
	if (source.slice(fnName.from, fnName.to) !== "instance") return null;

	const argList = fnName.nextSibling;
	if (argList === null || argList.type.name !== "ArgumentList") return null;

	for (
		let child = argList.firstChild;
		child !== null;
		child = child.nextSibling
	) {
		if (child.type.name !== "StringLiteral") continue;
		return unquoteXPathStringLiteral(source.slice(child.from, child.to));
	}
	return null;
}

/**
 * Strip surrounding quotes and collapse the doubled-quote escape.
 */
function unquoteXPathStringLiteral(literal: string): string {
	if (literal.length < 2) return literal;
	const quote = literal[0];
	const inner = literal.slice(1, -1);
	return inner.split(`${quote}${quote}`).join(quote);
}

/**
 * From an `Invoke` node, walk up the left-recursive `Child` chain that
 * extends the call with `/step` segments. Each `Child` node looks like
 * `Child { expr "/" step }` in the source grammar; in the parsed tree the
 * `/` materializes as an anonymous terminal, so the actual step is the
 * `Child` node's `lastChild`. Walking up the chain only continues while
 * the current node is the parent's `firstChild` (the left side) — once
 * the path enters a predicate / equality / arithmetic expression, the
 * chain ends.
 *
 * Returns in-order structural steps, retaining the axis and whether the node
 * test is one exact name. Wildcards, parent steps, descendant separators,
 * and explicit axes therefore stay distinguishable without reading source
 * text back through a regex.
 */
interface TrailingPathStep {
	readonly axis: "child" | "descendant" | "parent" | "ancestor" | "other";
	/** Present only for one exact, non-wildcard name test. */
	readonly name?: string;
}

function collectTrailingPathSteps(
	source: string,
	invoke: SyntaxNode,
): TrailingPathStep[] {
	const steps: TrailingPathStep[] = [];
	let current: SyntaxNode = invoke;
	while (true) {
		const parent = current.parent;
		if (parent === null) break;
		if (parent.type.name !== "Child" && parent.type.name !== "Descendant") {
			break;
		}
		// SyntaxNode identity isn't preserved across accessor calls (Lezer
		// fabricates fresh BufferNode wrappers on each `.firstChild` /
		// `.parent`), so we test "is `current` the left child of `parent`"
		// by start-position equality rather than `===`.
		if (parent.firstChild === null) break;
		if (parent.firstChild.from !== current.from) break;
		const step = parent.lastChild;
		if (step === null) break;
		if (step.type.name === "NameTest") {
			steps.push({
				axis: parent.type.name === "Descendant" ? "descendant" : "child",
				...(step.firstChild === null && {
					name: source.slice(step.from, step.to),
				}),
			});
		} else if (step.type.name === "ParentStep") {
			steps.push({ axis: "parent" });
		} else if (step.type.name === "AxisSpecified") {
			const axisNode = step.firstChild;
			const test = step.lastChild;
			const axisName =
				axisNode === null ? "" : source.slice(axisNode.from, axisNode.to);
			const axis =
				axisName === "child"
					? "child"
					: axisName === "descendant" || axisName === "descendant-or-self"
						? "descendant"
						: axisName === "parent" ||
								axisName === "ancestor" ||
								axisName === "ancestor-or-self"
							? "ancestor"
							: "other";
			steps.push({
				axis,
				...(test?.type.name === "NameTest" && test.firstChild === null
					? { name: source.slice(test.from, test.to) }
					: {}),
			});
		} else {
			steps.push({ axis: "other" });
		}
		current = parent;
	}
	return steps;
}

/** Whether the path rooted at this invocation is used as a filter carrier.
 * Relative paths inside that predicate inherit the carrier's session node as
 * their context, so they can navigate back to `session/data` without another
 * explicit `instance('commcaresession')` call for the analyzer to discover. */
function resolvedSessionPathParticipatesInFilter(invoke: SyntaxNode): boolean {
	let current = invoke;
	while (true) {
		const parent = current.parent;
		if (parent === null) return false;
		if (parent.type.name === "Filtered") {
			return parent.firstChild?.from === current.from;
		}
		if (
			(parent.type.name !== "Child" && parent.type.name !== "Descendant") ||
			parent.firstChild?.from !== current.from
		) {
			return false;
		}
		current = parent;
	}
}

function isExactChildName(
	step: TrailingPathStep | undefined,
	name: string,
): boolean {
	return step?.axis === "child" && step.name === name;
}

/** Classify only paths rooted at the commcaresession instance. Once one
 * exact datum child has been selected, only child/descendant reads stay
 * inside it. Every other axis can escape to the data container or a sibling. */
function classifySessionDataAccess(steps: readonly TrailingPathStep[]): {
	readonly exactDatumId?: string;
	readonly broad: boolean;
} {
	if (steps.length === 0) return { broad: true };
	if (!isExactChildName(steps[0], "session")) {
		return {
			broad: steps[0]?.axis !== "child" || steps[0]?.name === undefined,
		};
	}
	if (steps.length === 1) return { broad: true };
	if (!isExactChildName(steps[1], "data")) {
		const escapesSiblingSubtree = steps
			.slice(2)
			.some((step) => step.axis === "parent" || step.axis === "ancestor");
		return {
			broad:
				steps[1]?.axis !== "child" ||
				steps[1]?.name === undefined ||
				escapesSiblingSubtree,
		};
	}
	if (steps.length === 2) return { broad: true };
	const datum = steps[2];
	if (datum?.axis !== "child" || datum.name === undefined) {
		return { broad: true };
	}
	return {
		exactDatumId: datum.name,
		broad: steps
			.slice(3)
			.some((step) => step.axis !== "child" && step.axis !== "descendant"),
	};
}
