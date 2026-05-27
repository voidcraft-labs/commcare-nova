/**
 * Shared `domhandler` element + text constructors and serializer options used
 * by every wire-emission module in this package — the XForm side
 * (`xform/builder.ts`, `xform/metaBlock.ts`, `xform/caseBlocks.ts`) and the
 * suite.xml side (`compiler.ts`, `session.ts`, the modules under `suite/`).
 *
 * Each emitter constructs a tree of `Element` / `Text` nodes and hands them to
 * `dom-serializer` once at the end. The serializer is the single, exclusive
 * escaping authority — hand-escaping a value here and then handing it to the
 * serializer would double-encode it (`&` → `&amp;` → `&amp;amp;`). Attribute
 * values are therefore passed in RAW; the serializer XML-escapes `<` / `>` /
 * `&` / `"` / `'` exactly once at render time.
 *
 * Centralizing these helpers keeps the per-emitter modules from re-declaring
 * the same one-line constructors, and pins one set of render options so every
 * emitter's bytes round-trip identically under the validator's parse oracles
 * (`validator/xformOracle.ts` and `validator/suiteOracle.ts` re-parse what
 * these emitters produce).
 */

import { type ChildNode, Element, Text } from "domhandler";

/**
 * Build an XML element with raw attribute values and optional element
 * children. Attribute insertion order is preserved by the serializer, so
 * callers control byte-level attribute sequence by ordering the `attribs`
 * object literal.
 */
export function el(
	name: string,
	attribs: Record<string, string>,
	children: ChildNode[] = [],
): Element {
	return new Element(name, attribs, children);
}

/**
 * Build a Text node carrying raw character data. The serializer XML-escapes
 * the text exactly once at render time.
 */
export function text(data: string): Text {
	return new Text(data);
}

/**
 * Shared `dom-serializer` options. `xmlMode` so element names / namespaces /
 * self-closing follow XML rules; `selfClosingTags` so empty elements render
 * `<x/>`; `encodeEntities: "utf8"` so the serializer escapes `<` / `>` / `&` /
 * `"` / `'` in text and attribute values exactly once. The `'` → `&apos;` and
 * `"` → `&quot;` encodings are XML-spec-equivalent to the literal characters
 * (a conforming parser decodes them back identically), so emitting them rather
 * than the bare characters is a no-op for CommCare and Vellum.
 */
export const RENDER_OPTS = {
	xmlMode: true,
	selfClosingTags: true,
	encodeEntities: "utf8" as const,
} as const;
