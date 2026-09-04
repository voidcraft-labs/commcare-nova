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
// byte-exact in `text` runs. Reference spellings themselves are canonical
// projections of identity. In particular, an absolute form path always prints
// as `/data/<current path>`; separator bytes are not persisted.
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
//   - `path-ref` — the same identity in the canonical absolute
//     `/data/<path>` spelling. Only the target UUID is stored; print
//     re-derives the complete path from current identity.
//   - `case-ref` — an explicit per-type reference `#<type>/<prop>`.
//   - `user-ref` — a built-in or external `#user/<property>` name. The
//     name is intentionally the identity because it has no doc entity.
//   - `user-property-ref` — Nova-authored custom worker information,
//     stored by stable uuid and printed through its current saved name.
// Unresolved, contextual, unknown, and malformed hashtag references are not a
// stored arm. The parse boundary reports them and the commit gate rejects
// them; only canonical identity-backed leaves enter the document.
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
import { authoredCasePropertyNameSchema } from "../casePropertyName";
import { externalUserPropertyNameSchema } from "../externalUserProperty";
import { uuidSchema } from "../uuid";

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
	})
	.strict();

const xpathCaseRefPartSchema = z
	.object({
		kind: z.literal("case-ref"),
		caseType: z.string(),
		property: authoredCasePropertyNameSchema,
	})
	.strict();

const xpathUserRefPartSchema = z
	.object({
		kind: z.literal("user-ref"),
		property: externalUserPropertyNameSchema,
	})
	.strict();

const xpathUserPropertyRefPartSchema = z
	.object({
		kind: z.literal("user-property-ref"),
		userPropertyUuid: uuidSchema,
	})
	.strict();

/**
 * A search answer carried into a no-matches registration form: the value
 * the worker typed into a Search prompt of the form's own module before
 * the search that found nothing. Identity is the prompt's uuid, so a
 * renamed prompt never rewrites the expression; printing resolves it to
 * `#search/<current name>`.
 */
const xpathSearchAnswerRefPartSchema = z
	.object({
		kind: z.literal("search-answer-ref"),
		searchInputUuid: uuidSchema,
	})
	.strict();

const xpathPartSchema = z.discriminatedUnion("kind", [
	xpathTextPartSchema,
	xpathFieldRefPartSchema,
	xpathPathRefPartSchema,
	xpathCaseRefPartSchema,
	xpathUserRefPartSchema,
	xpathUserPropertyRefPartSchema,
	xpathSearchAnswerRefPartSchema,
]);

export type XPathTextPart = z.infer<typeof xpathTextPartSchema>;
export type XPathFieldRefPart = z.infer<typeof xpathFieldRefPartSchema>;
export type XPathPathRefPart = z.infer<typeof xpathPathRefPartSchema>;
export type XPathCaseRefPart = z.infer<typeof xpathCaseRefPartSchema>;
export type XPathUserRefPart = z.infer<typeof xpathUserRefPartSchema>;
export type XPathUserPropertyRefPart = z.infer<
	typeof xpathUserPropertyRefPartSchema
>;
export type XPathSearchAnswerRefPart = z.infer<
	typeof xpathSearchAnswerRefPartSchema
>;
export type XPathPart = z.infer<typeof xpathPartSchema>;

/** A reference-carrying part — everything except verbatim text. */
export type XPathRefPart = Exclude<XPathPart, XPathTextPart>;

export const xpathExpressionSchema = z
	.object({
		parts: z.array(xpathPartSchema),
	})
	.strict();

export type XPathExpression = z.infer<typeof xpathExpressionSchema>;

/** Is this stored slot value an exact canonical expression AST? Total readers
 * cannot assume schema-parsed input, so the predicate validates every part and
 * rejects missing, unknown, or extra leaf fields. */
export function isXPathExpression(value: unknown): value is XPathExpression {
	return xpathExpressionSchema.safeParse(value).success;
}

/** The empty expression — prints as `""`. */
function emptyXPathExpression(): XPathExpression {
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
