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
 * This oracle walks every install-time-evaluable XPath surface on a form
 * (bind `calculate`/`relevant`/`constraint`/`required`, `<setvalue value>`,
 * body `<output value>`) and resolves each reference against the symbols
 * available at the form's evaluation context:
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
 *   4. Absolute `/data/...` references in ANY-expression slots — the path
 *      must resolve to a node or attribute in the form's data instance
 *      tree. The XForm parse-time oracle already catches dangling
 *      `<bind nodeset>` and `<control ref>` paths; this check extends the
 *      same constraint to refs that live inside expression bodies, where
 *      JavaRosa evaluates them at install/runtime rather than parse.
 *
 * Test-oracle posture: same as the XForm + suite oracles per
 * `validator/xformOracle.ts`. A failure here is a generator bug, not a
 * fixable authoring state. Co-developed with a fuzzer that emits from
 * schema-valid blueprints; a failing case is either oracle-too-strict or
 * emitter bug, never a new reject rule.
 *
 * Out of scope (covered elsewhere):
 *   - XPath syntactic validity: `xformOracle.ts` (#3 — non-path nodeset,
 *     #4 — unparseable expressions).
 *   - XPath type compatibility: `validator/typeChecker.ts`.
 *   - Function arity / signature: `validator/functionRegistry.ts`.
 *   - Dependency cycles: doc-layer `validateBlueprintDeep` via `TriggerDag`.
 */

import type { SyntaxNode } from "@lezer/common";
import { findAll, getAttributeValue } from "domutils";
import { parser } from "@/lib/commcare/xpath";
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
const SESSION_CONTEXT_FIELDS: ReadonlySet<string> = new Set([
	"deviceid",
	"appversion",
	"username",
	"userid",
	"drift",
	"window_width",
	"applanguage",
]);

/**
 * The set of root paths a `/data/...` reference might target. The main
 * instance's root path varies per form (it's the data element's tag name,
 * e.g. `/data` for `<data>`, `/household_visit` if the emitter named the
 * root differently). Resolved against `XFormDataModel.rootPath`.
 */

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
): ValidationError[] {
	const built = buildXFormDataModel(xml, formName, moduleName);
	if ("fatal" in built) return [built.fatal];
	const model = built.model;

	const loc: ValidationLocation = { formName, moduleName };
	const errors: ValidationError[] = [];

	for (const surface of collectXPathSurfaces(model)) {
		const refs = analyzeXPath(surface.expr, model.rootPath);

		// Rule 3: every `instance('<id>')` ref where id is not commcaresession
		// must appear in the XForm's `<model><instance id=...>` declarations.
		for (const id of refs.instanceIds) {
			if (id === "commcaresession") continue;
			if (model.declaredInstanceIds.has(id)) continue;
			errors.push(
				validationError(
					"BINDING_RESOLUTION_INSTANCE_UNDECLARED",
					"form",
					`"${formName}" references instance("${id}") in ${surface.origin} but no <instance id="${id}"> is declared on the form. JavaRosa throws XPathMissingInstanceException when an instance reference can't be resolved at evaluation — CommCare surfaces this as "A part of your application is invalid." Check that the XPath surface is scanned for instance accumulation (the InstanceTracker in xform/builder.ts owns this). This is a bug in the form generator.`,
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
					`"${formName}" references session datum "${datumId}" in ${surface.origin} (via instance('commcaresession')/session/data/${datumId}), but no <datum id="${datumId}"> is declared on this form's <entry> in suite.xml. JavaRosa accepts the reference at parse but crashes when it tries to resolve the value — CommCare surfaces this as "A part of your application is invalid." Check that session.ts::deriveSessionDatums emits a datum for whatever the form needs. This is a bug in the form generator.`,
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
					`"${formName}" references session/context/${ctxName} in ${surface.origin}, but CommCare's SessionInstanceBuilder only populates these context fields: ${[...SESSION_CONTEXT_FIELDS].sort().join(", ")}. An unknown context name will resolve to an empty node-set at runtime. This is a bug in the form generator.`,
					loc,
				),
			);
		}

		// Rule 4: every absolute /data/... reference (or whatever the root
		// path is named) must resolve to a node or attribute in the form's
		// data instance tree. Bind nodesets are already checked by
		// xformOracle's dangling-bind invariant; this extends the same
		// check to references that live inside expression bodies.
		for (const path of refs.mainInstancePaths) {
			if (model.instancePaths.has(path)) continue;
			errors.push(
				validationError(
					"BINDING_RESOLUTION_FORM_PATH_MISSING",
					"form",
					`"${formName}" references "${path}" in ${surface.origin}, but no such node or attribute exists in the form's data instance tree. JavaRosa resolves the reference to an empty node-set at runtime. Check that the data tree is emitted before the bind. This is a bug in the form generator.`,
					loc,
				),
			);
		}
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
	// only need to walk the four expression slots.
	for (const bind of findAll((el) => el.name === "bind", model.doc.children)) {
		const nodeset = getAttributeValue(bind, "nodeset") ?? "<bind>";
		for (const attr of [
			"calculate",
			"relevant",
			"constraint",
			"required",
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
	/**
	 * Every absolute reference rooted at the form's main instance —
	 * normalized to a full path like `/data/foo/@bar`. The oracle checks
	 * each against the form's `instancePaths` set.
	 */
	readonly mainInstancePaths: ReadonlySet<string>;
}

/**
 * Walk one XPath expression, extract every install-time-resolvable
 * reference. Unparseable expressions contribute nothing — their parse
 * failure is the XForm oracle's concern.
 */
function analyzeXPath(expr: string, rootPath: string): XPathRefs {
	const instanceIds = new Set<string>();
	const sessionDataRefs = new Set<string>();
	const sessionContextRefs = new Set<string>();
	const mainInstancePaths = new Set<string>();

	const trimmed = expr.trim();
	if (!trimmed) {
		return {
			instanceIds,
			sessionDataRefs,
			sessionContextRefs,
			mainInstancePaths,
		};
	}

	const tree = parser.parse(trimmed);
	const cursor = tree.cursor();

	do {
		// `instance('X')` calls.
		if (cursor.type.name === "Invoke") {
			const invoke = cursor.node;
			const id = readInstanceCallArgument(trimmed, invoke);
			if (id !== null) {
				instanceIds.add(id);
				if (id === "commcaresession") {
					const trailing = collectTrailingPathSegments(trimmed, invoke);
					if (trailing[0] === "session") {
						if (trailing[1] === "data" && trailing.length >= 3) {
							sessionDataRefs.add(trailing[2]);
						} else if (trailing[1] === "context" && trailing.length >= 3) {
							sessionContextRefs.add(trailing[2]);
						}
					}
				}
			}
		}

		// Absolute paths rooted at the main instance. We only pick up the
		// top-level `Child` / `Descendant` chains (those whose parent isn't
		// itself a `Child`/`Descendant`) so the inner steps of a longer
		// path aren't double-counted as their own chains.
		if (cursor.type.name === "Child" || cursor.type.name === "Descendant") {
			const node = cursor.node;
			const parent = node.parent;
			if (
				parent === null ||
				(parent.type.name !== "Child" && parent.type.name !== "Descendant")
			) {
				const path = readAbsolutePath(trimmed, node);
				if (path === rootPath || path?.startsWith(`${rootPath}/`)) {
					mainInstancePaths.add(path);
				}
			}
		}
	} while (cursor.next());

	return {
		instanceIds,
		sessionDataRefs,
		sessionContextRefs,
		mainInstancePaths,
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
 * Returns the in-order segment names — `['session', 'data', 'case_id']`
 * for `instance('commcaresession')/session/data/case_id`. Stops on the
 * first step that isn't a plain `NameTest`, so the segments returned are
 * unambiguous local names.
 */
function collectTrailingPathSegments(
	source: string,
	invoke: SyntaxNode,
): string[] {
	const segments: string[] = [];
	let current: SyntaxNode = invoke;
	while (true) {
		const parent = current.parent;
		if (parent === null) break;
		if (parent.type.name !== "Child") break;
		// SyntaxNode identity isn't preserved across accessor calls (Lezer
		// fabricates fresh BufferNode wrappers on each `.firstChild` /
		// `.parent`), so we test "is `current` the left child of `parent`"
		// by start-position equality rather than `===`.
		if (parent.firstChild === null) break;
		if (parent.firstChild.from !== current.from) break;
		const step = parent.lastChild;
		if (step === null) break;
		if (step.type.name !== "NameTest") break;
		segments.push(source.slice(step.from, step.to));
		current = parent;
	}
	return segments;
}

/**
 * Serialize a `Child` / `Descendant` chain into its absolute-path string
 * — `/data/foo/@bar`-shaped. Returns `null` for chains that don't anchor
 * at a leading `/` (relative paths or chains anchored on an `Invoke`),
 * or for chains whose segments aren't all plain `NameTest` / `@<NameTest>`
 * — the oracle resolves only the shapes it can statically pin to a data
 * tree path; a false positive on a more complex chain is worse than no
 * check.
 *
 * The leading `/` appears as an anonymous terminal in the parsed tree
 * (Lezer doesn't emit a `RootPath` node when the `/` opens a longer
 * chain — it only emits `RootPath` for the bare `/` literal expression).
 * So the "this is absolute" signal is: the leftmost `Child` in the chain
 * has its `firstChild` as the `/` terminal token rather than another
 * `Child` / `Invoke` / `NameTest`.
 */
function readAbsolutePath(source: string, chain: SyntaxNode): string | null {
	// Descend to the leftmost `Child` / `Descendant` — the one that holds
	// the path's anchor.
	let leftmost: SyntaxNode = chain;
	while (leftmost.firstChild !== null) {
		const fc = leftmost.firstChild;
		if (fc.type.name !== "Child" && fc.type.name !== "Descendant") break;
		leftmost = fc;
	}

	// An absolute path starts the leftmost Child with the `/` terminal
	// token (anonymous, named `"/"` in `cursor.type.name`). Anything else
	// in that slot — `Invoke` for `instance('x')/...`, `NameTest` for a
	// relative path — means this chain isn't absolute and the oracle has
	// no business resolving it as one.
	const anchor = leftmost.firstChild;
	if (anchor === null) return null;
	if (anchor.type.name !== "/") return null;

	// First step is the leftmost Child's `lastChild` (the step the `/`
	// targets).
	const firstStep = leftmost.lastChild;
	if (firstStep === null) return null;
	const firstSeg = readPathSegment(source, firstStep);
	if (firstSeg === null) return null;
	const segments: string[] = [firstSeg];

	// Walk back up the chain, picking up each enclosing `Child`'s step.
	// Identity comparisons use `.from` since Lezer fabricates fresh
	// SyntaxNode wrappers per accessor call.
	let node: SyntaxNode = leftmost;
	while (true) {
		const parent: SyntaxNode | null = node.parent;
		if (parent === null) break;
		if (parent.type.name !== "Child" && parent.type.name !== "Descendant") {
			break;
		}
		if (parent.firstChild === null) break;
		if (parent.firstChild.from !== node.from) break;
		const step = parent.lastChild;
		if (step === null) return null;
		const segment = readPathSegment(source, step);
		if (segment === null) return null;
		segments.push(segment);
		node = parent;
	}

	return `/${segments.join("/")}`;
}

/**
 * Read the local-name + optional `@` prefix of a single step. Returns
 * `null` for steps that aren't a plain NameTest or an `@<NameTest>`
 * — anything else (axes, predicates, function calls) means this chain
 * isn't a simple absolute path the oracle can statically resolve.
 */
function readPathSegment(source: string, step: SyntaxNode): string | null {
	if (step.type.name === "NameTest") {
		return source.slice(step.from, step.to);
	}
	if (step.type.name === "AttrSpecified") {
		// AttrSpecified { "@" generalStep } — generalStep inlines as the child.
		const inner = step.firstChild;
		if (inner === null || inner.type.name !== "NameTest") return null;
		return `@${source.slice(inner.from, inner.to)}`;
	}
	return null;
}
