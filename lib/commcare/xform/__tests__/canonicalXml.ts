/**
 * Structural canonicalizer for XForm XML — the behavior-preservation oracle
 * for the `builder.ts` string→DOM rewrite.
 *
 * The rewrite replaces hand-concatenated XML (with hand-crafted indentation
 * and `escapeXml`) with `domhandler` construction + `dom-serializer`. A DOM
 * serializer legitimately introduces PURELY COSMETIC differences the old
 * string output never had:
 *
 *   - inter-element whitespace / indentation (the serializer emits compact,
 *     unindented output; the old emitter hand-indented every element);
 *   - attribute order is preserved by both, but normalizing it here makes the
 *     comparison robust to any future attribute-assembly reordering that is
 *     genuinely irrelevant to CommCare (attribute order is not significant in
 *     XML 1.0);
 *   - self-closing vs paired empty tags (`<x/>` ≡ `<x></x>`);
 *   - entity ENCODING of the same character — the old `escapeXml` left `'`
 *     and (in text) some chars literal, while `dom-serializer`'s
 *     `encodeEntities: "utf8"` emits `&apos;` / `&quot;`. After a real XML
 *     parse BOTH decode to the identical character, so they are the same
 *     document.
 *
 * To prove the rewrite preserves BEHAVIOR (not merely validity), we compare
 * the OLD and NEW emitter output through this canonicalizer. It must absorb
 * exactly the four cosmetic differences above and NOTHING semantic. The
 * implementation strategy is the one that makes that line impossible to blur:
 * we PARSE both sides with the same XML parser the oracle uses, then
 * re-serialize through a normalizing walk. Anything a real XML parse treats as
 * identical (entity encoding, self-closing form, attribute order once sorted,
 * inter-element whitespace once collapsed) collapses to one string; anything
 * the parse treats as DIFFERENT (element order, attribute presence, attribute
 * VALUE, text content, element name, namespace prefix) survives untouched.
 *
 * It is deliberately NOT a pretty-printer and NOT configurable: a knob to
 * "normalize a bit more" is exactly how a botched rewrite sneaks past the
 * equivalence gate, so there is none.
 */

import render from "dom-serializer";
import type { AnyNode, ChildNode, Element } from "domhandler";
import { isCDATA, isComment, isTag, isText } from "domhandler";
import { parseDocument } from "htmlparser2";

/**
 * Parse options identical to the XForm oracle's (`xformOracle.ts::XML_OPTS`):
 * XML mode so element names / namespaces / self-closing are read by XML rules,
 * not HTML's tag-soup recovery. Keeping the SAME parser + options the oracle
 * uses means "the canonicalizer parsed it" and "the oracle parsed it" agree on
 * document structure — no second XML dialect enters the proof.
 */
const PARSE_OPTS = { xmlMode: true } as const;

/**
 * Serialize options for the per-element re-emission. `xmlMode` + self-closing
 * so every empty element renders as `<x/>` uniformly (the `<x/>` ≡ `<x></x>`
 * normalization), and `encodeEntities: "utf8"` so every retained character is
 * escaped by ONE fixed rule — collapsing the old emitter's mixed
 * literal-vs-entity encoding onto a single canonical encoding. Because both
 * OLD and NEW output pass through this same serializer, the encoding choice
 * itself is irrelevant; only that it is the SAME on both sides.
 */
const RENDER_OPTS = {
	xmlMode: true,
	selfClosingTags: true,
	encodeEntities: "utf8" as const,
} as const;

/**
 * Recursively rebuild one node with its attributes sorted and its element
 * children re-canonicalized, dropping pure-formatting text (whitespace-only
 * runs between elements) while preserving SIGNIFICANT text verbatim.
 *
 * "Significant text" = any text node whose data is not entirely whitespace.
 * XForm itext values, `<value>` bodies, and `<output>`-adjacent prose are all
 * significant and must survive byte-for-byte (modulo the parser already having
 * decoded entities). Whitespace-only text between structural elements is the
 * serializer's indentation and carries no meaning, so it is dropped — this is
 * the "collapse inter-element whitespace" rule. A whitespace-only text node
 * that is the SOLE child of an element (e.g. `<a>   </a>`) is also dropped,
 * matching how an XML consumer treats element-only content models.
 */
function canonicalizeNode(node: AnyNode): AnyNode | null {
	// Comments and CDATA are not part of any XForm Nova emits; if one ever
	// appears it is preserved structurally (its presence IS semantic), but we
	// never synthesize one, so this is a defensive pass-through.
	if (isComment(node) || isCDATA(node)) return node;

	if (isText(node)) {
		// Whitespace-only text is serializer indentation → drop it. Any text
		// with non-whitespace content is significant → keep verbatim (the
		// parser has already decoded entities, so the value is the true
		// character data and the re-serializer will re-encode it identically on
		// both OLD and NEW sides).
		return node.data.trim().length === 0 ? null : node;
	}

	if (!isTag(node)) return node;

	// Sort attributes alphabetically by name. Attribute order is not
	// significant in XML, and sorting makes the comparison immune to any
	// attribute-assembly reordering the rewrite introduces while leaving
	// attribute PRESENCE and VALUE (both semantic) exactly as parsed.
	const sortedAttribs: Record<string, string> = {};
	for (const name of Object.keys(node.attribs).sort()) {
		sortedAttribs[name] = node.attribs[name];
	}

	// Recurse into children, dropping the formatting-only text the walk above
	// rejects. Element ORDER is preserved (the surviving children keep their
	// relative order), because element order IS semantic in an XForm
	// (setvalue/bind/instance sequencing, body control order).
	const children: ChildNode[] = [];
	for (const child of node.children) {
		const canon = canonicalizeNode(child);
		if (canon !== null) children.push(canon as ChildNode);
	}

	// Rebuild the element shape `dom-serializer` consumes. We mutate a shallow
	// clone's fields rather than constructing a new `Element` so the parser's
	// namespace bookkeeping (the `:` in `jr:template` etc. is part of `name`
	// in xmlMode) is carried through untouched.
	const rebuilt = {
		...node,
		attribs: sortedAttribs,
		children,
	} as Element;
	return rebuilt;
}

/**
 * Canonicalize an XForm XML string to a stable structural form.
 *
 * Parses with the oracle's XML options, drops the XML declaration / PIs (the
 * parser surfaces the declaration as a directive node, which `findCanonical`
 * skips), normalizes attribute order + inter-element whitespace + self-closing
 * form + entity encoding, and serializes the result. Two XForms that differ
 * ONLY in those cosmetic dimensions produce byte-identical output; any
 * semantic difference (element order, attribute presence/value, text, name,
 * namespace) produces different output.
 */
export function canonicalizeXForm(xml: string): string {
	const doc = parseDocument(xml, PARSE_OPTS);
	const out: AnyNode[] = [];
	for (const child of doc.children) {
		// The XML declaration `<?xml version="1.0"?>` and any processing
		// instruction parse as a `directive`/`comment`-typed node with no tag
		// semantics. Dropping them is the "drop the XML declaration / PIs" rule
		// — they carry no document structure CommCare reads.
		if (!isTag(child) && !isText(child)) continue;
		const canon = canonicalizeNode(child);
		if (canon !== null) out.push(canon);
	}
	return render(out, RENDER_OPTS);
}
