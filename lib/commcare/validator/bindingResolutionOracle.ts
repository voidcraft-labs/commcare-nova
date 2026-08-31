/**
 * Install-time XPath-resolution oracle.
 *
 * The XForm parse-time oracle (`xformOracle.ts`) mirrors CommCare's parse
 * contract — it proves the form is well-formed XML, every bind has a
 * resolvable nodeset, every XPath surface parses as XPath. That contract
 * stops at parse: a `calculate="instance('commcaresession')/session/data/X"`
 * where `X` was never declared as a session datum is structurally valid XML
 * and structurally valid XPath. JavaRosa accepts it at parse and crashes at
 * form-init when the calculate tries to evaluate (`XPathTypeMismatchException`,
 * which CommCare surfaces as "A part of your application is invalid.").
 *
 * This oracle walks the ANY-expression XPath surfaces on a form — bind
 * `calculate`/`relevant`/`constraint`/`required`/`readonly`, `<setvalue
 * value>`, and body `<output value>` — and resolves each reference
 * against the symbols available at the form's evaluation context:
 *
 *   1. `instance('commcaresession')/session/data/<X>` — `<X>` must be the
 *      `id` of a session datum declared on the form's `<entry>` in
 *      `suite.xml`. The XForm has no way to know what the session looks
 *      like; the caller passes the entry's declared datum ids in.
 *   2. `instance('commcaresession')/session/context/<X>` — `<X>` must be
 *      one of the closed set of fields CommCare populates on the session
 *      context (`commcare-core .../session/SessionInstanceBuilder.java::
 *      addMetadata`).
 *   3. `instance('<id>')` for any non-`commcaresession` `<id>` — `<id>` must
 *      appear in the XForm's `<model><instance id="..."/>` declarations.
 *      JavaRosa's `EvaluationContext.resolveReference` throws
 *      `XPathMissingInstanceException` at evaluation when the instance
 *      isn't in scope; the parse-time check leaves the gap.
 *
 * Form-path references inside expression bodies are intentionally NOT
 * checked: a missing `/data/...` reference resolves to an empty node-set
 * at runtime — degraded UX (an empty `<output>` value, a `false` branch
 * on a relevant) rather than an install-time crash. Dangling bind
 * NODESETS — the install-time-fatal case — are caught by the XForm
 * parse-time oracle's `XFORM_DANGLING_BIND` check.
 *
 * Test-oracle posture: a failure here is a generator bug, not a fixable
 * authoring state. Unlike the XForm + suite oracles (which compileCcz throws
 * on as a defense-in-depth backstop), THIS oracle is fuzz-only — invoked
 * from `__tests__/bindingResolutionOracle.fuzz.test.ts` to prove emitter
 * totality. The user-visible gate for the only authoring shape that would
 * reach an unresolved reference today is the doc-layer rule
 * `validator/rules/form.ts::caseHashtagOnCreateForm`.
 *
 * Out of scope (covered elsewhere):
 *   - XPath syntactic validity: `xformOracle.ts` (non-path nodeset,
 *     unparseable expressions).
 *   - XPath type compatibility: `validator/typeChecker.ts`.
 *   - Function arity / signature: `validator/functionRegistry.ts`.
 *   - Dependency cycles: doc-layer `validateBlueprintDeep` via `TriggerDag`.
 *
 * Known intentional gap: `SessionInstanceBuilder.addUserQueryData` writes
 * `stringquery` / `fingerprintquery` into `session/data/*` at runtime after
 * the user performs a case-search. Those names aren't declared as `<datum>`
 * entries in `suite.xml`, so a reference to either would false-positive
 * here. No Nova-emitted XPath references them today.
 */

import type { SyntaxNode } from "@lezer/common";
import { isTag } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
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
 * The `jr://file/` prefix every CommCare media reference carries inside an
 * itext `<value form="image|audio|video">` sibling. The media-resolution check
 * strips this prefix before comparing against the manifest, which carries the
 * `commcare/<hash><ext>` wire paths the compiler bundled into the CCZ.
 */
const JR_FILE_PREFIX = "jr://file/";

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

/**
 * Public entry — validates every install-time XPath surface on the form
 * against the supplied symbol sets. The caller (typically `compileCcz`)
 * threads in:
 *
 *   - `sessionDatumIds`: the `id` of every `<datum>` declared on the
 *     form's `<entry>` in `suite.xml`. Built by walking the entry the
 *     compiler has already derived for this form.
 *   - `mediaManifest`, optional: the closed set of `commcare/<hash><ext>`
 *     wire paths bundled into the CCZ archive. When supplied, the oracle
 *     additionally proves every `<value form="image|audio|video">jr://...`
 *     itext sibling resolves into that set. Defense-in-depth alongside
 *     the parse-time check `xformOracle::validateXForm` runs on the
 *     same surface — same install-fatal contract from two angles:
 *     parse-time totality + install-time resolution.
 *
 * Returns an empty array on a clean form; one `ValidationError` per
 * unresolved reference otherwise. Each error code names what kind of
 * resolution failed so callers can route them differently if needed.
 */
export function validateBindingResolution(
	xml: string,
	formName: string,
	moduleName: string,
	sessionDatumIds: ReadonlySet<string>,
	mediaManifest?: ReadonlySet<string>,
): ValidationError[] {
	const built = buildXFormDataModel(xml, formName, moduleName);
	if ("fatal" in built) return [built.fatal];
	const model = built.model;

	const loc: ValidationLocation = { formName, moduleName };
	const errors: ValidationError[] = [];

	for (const surface of collectXPathSurfaces(model)) {
		const refs = analyzeXPath(surface.expr);

		// Rule 3: every `instance('<id>')` ref where id is not commcaresession
		// must appear in the XForm's `<model><instance id=...>` declarations.
		for (const id of refs.instanceIds) {
			if (id === "commcaresession") continue;
			if (model.declaredInstanceIds.has(id)) continue;
			errors.push(
				validationError(
					"BINDING_RESOLUTION_INSTANCE_UNDECLARED",
					"form",
					`"${formName}" references instance("${id}") in ${surface.origin}, but the form's <model> has no <instance id="${id}"> declaration. CommCare will reject this form at form-init with "A part of your application is invalid." Check that the XForm emitter declared the secondary instance for whatever the form needs. This is a bug in the form generator.`,
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
					`"${formName}" references session datum "${datumId}" in ${surface.origin} (via instance('commcaresession')/session/data/${datumId}), but no <datum id="${datumId}"> is declared on this form's <entry> in suite.xml. CommCare will reject this form at form-init with "A part of your application is invalid." Check that the entry emits a datum for whatever the form needs. This is a bug in the form generator.`,
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
					`"${formName}" references session/context/${ctxName} in ${surface.origin}, but CommCare only populates these context fields: ${[...SESSION_CONTEXT_FIELDS].sort().join(", ")}. An unknown context name resolves to an empty node-set at runtime. This is a bug in the form generator.`,
					loc,
				),
			);
		}

		// Form-path references inside expression bodies (`<output value>`,
		// bind `calculate`/`relevant`/etc.) intentionally do NOT enforce
		// path existence: JavaRosa resolves a missing path to an empty
		// node-set at runtime, which is degraded UX (an empty label
		// output, an `if(...)` branch that evaluates false) rather than
		// an install-time crash. Dangling bind NODESETS, by contrast,
		// ARE install-time-fatal — `xformOracle.ts::checkBinds` already
		// flags them via `XFORM_DANGLING_BIND`. The instance + session
		// rules above carry this oracle's full install-time-fatal
		// coverage.
	}

	// Rule 4 (optional) — every itext `<value form="image|audio|video">jr://...`
	// path must resolve to a bundled wire path in the manifest. The check is
	// install-time-fatal: at form-init JavaRosa walks the itext entries and
	// resolves each media value through the media-suite installer; a
	// reference without a corresponding installed file falls back to the
	// localization default (empty) and renders as a broken icon. Mirrors the
	// parse-time check `xformOracle::checkMediaValues` runs on the same
	// surface — both fire; both are correct boundaries.
	for (const err of checkItextMediaValues(
		model,
		mediaManifest,
		formName,
		loc,
	)) {
		errors.push(err);
	}

	return errors;
}

/**
 * Walk every `<value form="image|audio|video">` sibling inside the form's
 * itext block(s) and resolve its `jr://file/...` text content against the
 * supplied manifest. Skipped when `mediaManifest === undefined` — the
 * media-OFF path emits no media values and has nothing to resolve.
 */
function checkItextMediaValues(
	model: XFormDataModel,
	mediaManifest: ReadonlySet<string> | undefined,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	if (mediaManifest === undefined) return [];
	const errors: ValidationError[] = [];

	for (const valueEl of findAll(
		(el) => el.name === "value",
		model.doc.children,
	)) {
		const form = getAttributeValue(valueEl, "form");
		if (form !== "image" && form !== "audio" && form !== "video") continue;

		const refText = readElementText(valueEl).trim();
		if (refText === "") continue;
		if (!refText.startsWith(JR_FILE_PREFIX)) continue;

		const wirePath = refText.slice(JR_FILE_PREFIX.length);
		if (mediaManifest.has(wirePath)) continue;

		errors.push(
			validationError(
				"BINDING_RESOLUTION_MEDIA_REF_UNDECLARED",
				"form",
				`"${formName}" carries an itext <value form="${form}"> referencing "${refText}", but the install-time media manifest has no entry for "${wirePath}". CommCare resolves this jr:// reference against media_suite.xml's local resources at install; an unresolved reference renders as a broken icon. This is a bug in the form generator.`,
				loc,
			),
		);
	}

	return errors;
}

/**
 * Concatenate every direct text-child of an element. Mirrors `domhandler`'s
 * `Text` node layout — adjacent text segments stay as sibling children, and
 * the equivalent of `parser.nextText()` is a children sweep with `.data`
 * concatenation.
 */
function readElementText(el: import("domhandler").Element): string {
	let acc = "";
	for (const child of getChildren(el)) {
		if (isTag(child)) continue;
		const data = (child as { data?: string }).data;
		if (typeof data === "string") acc += data;
	}
	return acc;
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
	for (const bind of findAll((el) => el.name === "bind", model.doc.children)) {
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
	for (const setvalue of findAll(
		(el) => el.name === "setvalue",
		model.doc.children,
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
	for (const output of findAll(
		(el) => el.name === "output",
		model.doc.children,
	)) {
		const value = getAttributeValue(output, "value");
		if (value) {
			surfaces.push({ expr: value, origin: `<output value=...>` });
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
