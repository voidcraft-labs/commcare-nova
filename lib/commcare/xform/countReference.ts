/**
 * Classifies a `count_bound` repeat's count expression as either a
 * location-path reference or a non-path value, to decide how the XForm
 * emitter wires `jr:count`.
 *
 * ## Why this exists
 *
 * JavaRosa parses the `jr:count` attribute value through
 * `XPathReference(String)`, whose constructor calls `getPathExpr` and throws
 * `XPathTypeMismatchException("Expected XPath path, got XPath expression:
 * [...]")` when the parsed result is NOT an `XPathPathExpr`
 * (`commcare-core/.../org/javarosa/model/xform/XPathReference.java::
 * getPathExpr`, reached from `commcare-core/.../org/javarosa/xform/parse/
 * XFormParser.java::parseGroup`, which wraps the `jr:count` attribute in
 * `new XPathReference(countRef)`). So `jr:count` MUST be a node reference — a
 * literal (`3`), arithmetic (`3 + 2`), or function call (`count(...)`) on that
 * attribute is a hard parse failure on upload.
 *
 * The emitter therefore hoists any non-path count into a hidden data node
 * seeded by an `xforms-ready` `<setvalue>` and points `jr:count` at that node —
 * `<count_node/>` + `<setvalue ref=".../count_node" value="<expr>"/>` +
 * `jr:count=".../count_node"`. A count that is already a path points `jr:count`
 * straight at it, no hoist. Both shapes are what JavaRosa's repeat-count
 * parsing accepts through `XPathReference(String)`.
 *
 * ## Shared gate
 *
 * The PATH-only test is exactly the gate every other PATH-only surface uses
 * (bind `nodeset`, control `ref`, `<setvalue ref>`), so this delegates to the
 * single `isPathExpression` classifier in `./pathExpression`. Both the emitter
 * and the parse-time oracle funnel through that one gate, which mirrors
 * JavaRosa's `XPathReference.getPathExpr` AST check. See that module for the
 * path-node allowlist and the parenthesized-expression handling.
 */

import { isPathExpression } from "@/lib/commcare/xform/pathExpression";

/**
 * Returns `true` when `expr` is a location path that JavaRosa accepts directly
 * as a `jr:count` reference, `false` when it must be hoisted into a hidden
 * node first.
 *
 * `expr` is the ALREADY-hashtag-expanded count string (the emitter calls
 * `expandHashtags` first). A parse error returns `false` — an unparseable
 * count is never a valid path, and hoisting is the safe direction (a
 * false-negative classification merely adds an extra hidden node; a
 * false-positive emits a `jr:count` JavaRosa rejects, which is the exact bug
 * this guards).
 */
export function isCountReferencePath(expr: string): boolean {
	return isPathExpression(expr);
}
