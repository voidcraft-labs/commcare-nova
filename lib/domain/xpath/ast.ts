// lib/domain/xpath/ast.ts
//
// The stored form of an XPath expression slot: a typed AST whose
// reference leaves carry IDENTITY instead of text. A form-local
// reference holds the target field's stable uuid — a rename never
// touches the slot, because printing resolves the uuid to the field's
// CURRENT path. A case-property reference holds the
// `(caseType, property)` name pair — name-keyed on purpose: case
// properties are a name-keyed namespace co-owned by every writer, so
// the name IS the identity and a property rename remains a cascade
// (a structural walk over these leaves on exactly the indexed
// carriers).
//
// Everything between the reference leaves is verbatim source text —
// operators, literals, function calls, whitespace, quoting — kept
// byte-exact in `text` runs. That carries the round-trip law the
// parser/printer pair is fuzz-pinned to: `print(parse(s)) === s`
// byte-identical for every input string, which is what makes a stored
// expression provably safe to migrate (parse → AST → print reproduces
// the original bytes over an unrenamed doc).
//
// The parser (`lib/commcare/xpath/expressionAst.ts` — it needs the
// Lezer grammar) decides which textual shapes become leaves; this
// module owns the shape, the printer, and the structural walks,
// because the stored shape is part of the `Field` / `Form` schemas and
// `lib/domain` cannot import `lib/commcare`.
//
// ## Leaf vocabulary
//
//   - `field-ref` — a resolved `#form/<path>` reference. Prints as
//     `#form/` + the target's current id path from its form root.
//   - `path-ref` — the same identity in the absolute `/data/<path>`
//     spelling. `seps` keeps each separator run byte-exact (`/`, `//`,
//     and any whitespace around them), one entry per path segment
//     (the first precedes `data`), so unusual spacing survives the
//     round trip; print re-derives the segment names from the uuid.
//   - `case-ref` — an explicit per-type reference `#<type>/<prop>`.
//   - `user-ref` — `#user/<prop>`; the property names a built-in user
//     property outside the doc, so the name is the whole identity.
//   - `raw-ref` — a hashtag that names no identity the doc can
//     anchor: a dangling `#form/...`, the transitional contextual
//     `#case/...` (whose meaning follows the owning module's CURRENT
//     case type rather than naming one), an unknown namespace, or a
//     malformed multi-segment shape. Prints verbatim; the validator
//     adjudicates it from the printed text exactly as it always has.
//
// `.`/`..` and every other structural XPath shape stay inside `text`
// runs — they are evaluation context, not references.
//
// ## Null semantics
//
// The slot-level vocabulary is unchanged: an absent slot is absent
// (key missing), an empty expression is `{ parts: [] }` (prints `""`,
// the stored-empty-string twin), and `null` exists only as the wire
// representation of "clear this slot" — never stored. The wire
// collapse of empty case values to `prop=''` stays an emit-time
// concern.

import { z } from "zod";
import { type Uuid, uuidSchema } from "../uuid";

const xpathTextPartSchema = z
	.object({
		kind: z.literal("text"),
		text: z.string(),
	})
	.strict();

const xpathFieldRefPartSchema = z
	.object({
		kind: z.literal("field-ref"),
		uuid: uuidSchema,
	})
	.strict();

const xpathPathRefPartSchema = z
	.object({
		kind: z.literal("path-ref"),
		uuid: uuidSchema,
		seps: z.array(z.string()),
	})
	.strict();

const xpathCaseRefPartSchema = z
	.object({
		kind: z.literal("case-ref"),
		caseType: z.string(),
		property: z.string(),
	})
	.strict();

const xpathUserRefPartSchema = z
	.object({
		kind: z.literal("user-ref"),
		property: z.string(),
	})
	.strict();

const xpathRawRefPartSchema = z
	.object({
		kind: z.literal("raw-ref"),
		namespace: z.string(),
		segments: z.array(z.string()),
	})
	.strict();

export const xpathPartSchema = z.discriminatedUnion("kind", [
	xpathTextPartSchema,
	xpathFieldRefPartSchema,
	xpathPathRefPartSchema,
	xpathCaseRefPartSchema,
	xpathUserRefPartSchema,
	xpathRawRefPartSchema,
]);

export type XPathTextPart = z.infer<typeof xpathTextPartSchema>;
export type XPathFieldRefPart = z.infer<typeof xpathFieldRefPartSchema>;
export type XPathPathRefPart = z.infer<typeof xpathPathRefPartSchema>;
export type XPathCaseRefPart = z.infer<typeof xpathCaseRefPartSchema>;
export type XPathUserRefPart = z.infer<typeof xpathUserRefPartSchema>;
export type XPathRawRefPart = z.infer<typeof xpathRawRefPartSchema>;
export type XPathPart = z.infer<typeof xpathPartSchema>;

/** A reference-carrying part — everything except verbatim text. */
export type XPathRefPart = Exclude<XPathPart, XPathTextPart>;

export const xpathExpressionSchema = z
	.object({
		parts: z.array(xpathPartSchema),
	})
	.strict();

export type XPathExpression = z.infer<typeof xpathExpressionSchema>;

/** Is this stored slot value an expression AST (vs any legacy shape a
 *  degenerate doc might carry)? A cheap structural probe for total
 *  readers that cannot assume schema-parsed input. */
export function isXPathExpression(value: unknown): value is XPathExpression {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { parts?: unknown }).parts)
	);
}

/** The empty expression — prints as `""`. */
export function emptyXPathExpression(): XPathExpression {
	return { parts: [] };
}

/** An expression that is exactly one verbatim text run. The parser
 *  uses this for sources it cannot structure (a Lezer error anywhere
 *  makes ref classification unreliable, so the whole source stays
 *  opaque text — zero reference leaves, prints byte-identically). */
export function opaqueXPathExpression(source: string): XPathExpression {
	if (source.length === 0) return emptyXPathExpression();
	return { parts: [{ kind: "text", text: source }] };
}

/** Every reference leaf in the expression, in source order. */
export function xpathRefParts(expr: XPathExpression): XPathRefPart[] {
	return expr.parts.filter(
		(part): part is XPathRefPart => part.kind !== "text",
	);
}

/** Does the expression carry zero parts (prints as `""`)? */
export function isEmptyXPathExpression(expr: XPathExpression): boolean {
	return expr.parts.length === 0;
}

/** Deep-clone an expression. Leaves are copied VERBATIM — a cloned
 *  `field-ref` keeps pointing at the original target. `duplicateField`
 *  and every other clone path rely on this staying a plain structural
 *  copy with no re-pointing. */
export function cloneXPathExpression(expr: XPathExpression): XPathExpression {
	return {
		parts: expr.parts.map((part) => {
			switch (part.kind) {
				case "text":
					return { ...part };
				case "field-ref":
					return { ...part };
				case "path-ref":
					return { ...part, seps: [...part.seps] };
				case "case-ref":
					return { ...part };
				case "user-ref":
					return { ...part };
				case "raw-ref":
					return { ...part, segments: [...part.segments] };
				default: {
					const _exhaustive: never = part;
					return _exhaustive;
				}
			}
		}),
	};
}

/** Build a resolved form-local reference leaf. */
export function xpathFieldRef(uuid: Uuid): XPathFieldRefPart {
	return { kind: "field-ref", uuid };
}

/** Build an explicit per-type case-property reference leaf. */
export function xpathCaseRef(
	caseType: string,
	property: string,
): XPathCaseRefPart {
	return { kind: "case-ref", caseType, property };
}
