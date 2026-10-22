import type { ExpressionEditorContext } from "@/lib/codemirror/expressionEditorContext";
import { deepEqual } from "@/lib/doc/deepEqual";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import { expressionChildren } from "@/lib/domain/expression/children";
import { type ExpressionSpans, spanKey } from "@/lib/domain/expression/spans";
import {
	type CheckPath,
	type Expression,
	isExpression,
	type Term,
} from "@/lib/domain/expression/types";

/**
 * Three-way reconciliation for an open expression editor.
 *
 * `base` is the shown text the local draft started from, under the
 * document `baseScope` holds; `incoming` is the newest shown text, under
 * `incomingScope`. A clean draft follows the incoming text. A dirty draft
 * is respelled, never rewritten, under one rule:
 *
 * 1. the stored tree is unchanged (both scopes hold one `Expression` for the
 *    slot); otherwise the draft keeps its text and the edit conflicts;
 * 2. the draft parses under the old document's scope; otherwise conflict;
 * 3. each place of the draft's parse whose identity prints differently in
 *    the new document is replaced at its span by the new spelling, and the
 *    rest of the draft keeps the person's own spacing and spelling; a read
 *    whose identity the new document lacks is a conflict.
 *
 * That covers a question renamed or moved (in every spelling, relative
 * included), a worker-information slug, a Search answer, a data table or
 * column, a choice's value, and a session value whose id follows the menu's
 * shape. The respelled draft must parse under the new scope to the same
 * tree, or the edit conflicts. When the shown text did not change, an
 * identity the draft alone reads is respelled the same way, and a draft
 * that does not parse or reads something now gone is left to the linter.
 * A change elsewhere in the document therefore never conflicts, and a draft
 * that parsed is not parsed again for it: each reconciliation hands the next
 * its reading of the draft (`XPathDraftReading`).
 */

type ParseScope = ExpressionEditorContext["scope"];
type Span = { readonly from: number; readonly to: number };

/**
 * What a draft that parsed reads, under the scope of the latest
 * reconciliation: its tree, where each node sits in the draft's text, and
 * the tree's print under that scope. The next reconciliation starts from it
 * instead of parsing the draft again, so a change elsewhere in the document
 * costs one print of the tree under the new scope. It holds only while the
 * draft and the scope are the ones it was taken under.
 */
export interface XPathDraftReading {
	readonly draft: string;
	readonly scope: ParseScope;
	readonly expression: Expression | undefined;
	readonly spans: ExpressionSpans;
	readonly printed?: ReturnType<typeof print>;
}

export interface XPathDraftReconciliation {
	readonly base: string;
	readonly draft: string;
	readonly conflict: boolean;
	/** The resulting draft's reading under the incoming scope, when it
	 *  parsed. */
	readonly reading?: XPathDraftReading;
}

function parse(scope: ParseScope, text: string) {
	return parseFormExpressionForSlot(scope.doc, scope.slot, text, scope.lookup, {
		...(scope.form === undefined ? {} : { form: scope.form }),
	});
}

function print(scope: ParseScope, expression: Expression) {
	return projectFormExpression(
		scope.doc,
		scope.slot,
		expression,
		scope.lookup,
		{
			...(scope.form === undefined ? {} : { form: scope.form }),
		},
	);
}

/** The text a node holds between its children's spans. */
function ownSegments(
	span: Span,
	children: readonly Span[],
): readonly Span[] | undefined {
	const sorted = [...children].sort((a, b) => a.from - b.from);
	const segments: Span[] = [];
	let at = span.from;
	for (const child of sorted) {
		if (child.from < at || child.to > span.to) return undefined;
		segments.push({ from: at, to: child.from });
		at = child.to;
	}
	segments.push({ from: at, to: span.to });
	return segments;
}

/** The draft's replacements: each segment whose text differs between the
 * two prints, respelled with the new print's text. */
function respellings(
	expression: Expression,
	draft: { readonly text: string; readonly spans: ExpressionSpans },
	before: { readonly text: string; readonly spans: ExpressionSpans },
	after: { readonly text: string; readonly spans: ExpressionSpans },
): readonly (Span & { readonly insert: string })[] | undefined {
	const edits: (Span & { readonly insert: string })[] = [];
	let failed = false;
	const visit = (node: Expression | Term, path: CheckPath): void => {
		if (failed) return;
		const children = expressionChildren(node, path).filter(
			(child) => child.kind !== "relation",
		);
		// A term wrapper shares its term's span: it holds no text of its own.
		if (isExpression(node) && node.kind === "term") {
			for (const child of children) visit(child.value, child.path);
			return;
		}
		const key = spanKey(path);
		const spansOf = (spans: ExpressionSpans) => {
			const span = spans.get(key);
			if (span === undefined) return undefined;
			const own = children.map((child) => spans.get(spanKey(child.path)));
			return own.every((child): child is Span => child !== undefined)
				? ownSegments(span, own)
				: undefined;
		};
		const old = spansOf(before.spans);
		const next = spansOf(after.spans);
		if (old === undefined || next === undefined || old.length !== next.length) {
			failed = true;
			return;
		}
		const changed = old.flatMap((segment, index) => {
			const newer = next[index];
			const oldText = before.text.slice(segment.from, segment.to);
			const newText = after.text.slice(newer.from, newer.to);
			return oldText === newText ? [] : [{ index, newText }];
		});
		if (changed.length > 0) {
			const typed = spansOf(draft.spans);
			if (typed === undefined || typed.length !== old.length) {
				failed = true;
				return;
			}
			for (const { index, newText } of changed)
				edits.push({ ...typed[index], insert: newText });
		}
		for (const child of children) visit(child.value, child.path);
	};
	visit(expression, []);
	if (failed) return undefined;
	const sorted = [...edits].sort((a, b) => a.from - b.from);
	for (let index = 1; index < sorted.length; index++)
		if (sorted[index].from < sorted[index - 1].to) return undefined;
	return sorted;
}

/** The draft's reading under `scope`: the one carried from the previous
 * reconciliation when it was taken of this draft under this scope, else a
 * fresh parse. */
function readDraft(
	draft: string,
	scope: ParseScope,
	carried: XPathDraftReading | undefined,
): XPathDraftReading | undefined {
	if (
		carried !== undefined &&
		carried.draft === draft &&
		carried.scope === scope
	)
		return carried;
	const parsed = parse(scope, draft);
	return parsed.ok
		? { draft, scope, expression: parsed.expression, spans: parsed.spans }
		: undefined;
}

/** The draft respelled for the incoming document, or why it cannot be. */
function respellDraft(
	draft: string,
	baseScope: ParseScope,
	incomingScope: ParseScope,
	carried: XPathDraftReading | undefined,
):
	| { readonly draft: string; readonly reading: XPathDraftReading }
	| "unparsed"
	| "lost"
	| "changed" {
	const reading = readDraft(draft, baseScope, carried);
	if (reading === undefined) return "unparsed";
	const expression = reading.expression;
	if (expression === undefined)
		return { draft, reading: { ...reading, scope: incomingScope } };
	const before = reading.printed ?? print(baseScope, expression);
	const after = print(incomingScope, expression);
	if (before.text === after.text)
		return {
			draft,
			reading: { ...reading, scope: incomingScope, printed: after },
		};
	if (before.unresolved.length > 0 || after.unresolved.length > 0)
		return "lost";
	const edits = respellings(
		expression,
		{ text: draft, spans: reading.spans },
		before,
		after,
	);
	if (edits === undefined) return "changed";
	let respelled = "";
	let at = 0;
	for (const edit of edits) {
		respelled += draft.slice(at, edit.from) + edit.insert;
		at = edit.to;
	}
	respelled += draft.slice(at);
	const reparsed = parse(incomingScope, respelled);
	return reparsed.ok && deepEqual(reparsed.expression, expression)
		? {
				draft: respelled,
				reading: {
					draft: respelled,
					scope: incomingScope,
					expression,
					spans: reparsed.spans,
					printed: after,
				},
			}
		: "changed";
}

export function reconcileXPathDraft({
	base,
	draft,
	incoming,
	baseScope,
	incomingScope,
	conflict = false,
	reading,
}: {
	readonly base: string;
	readonly draft: string;
	readonly incoming: string;
	/** The scope `base` was printed under, or undefined with no context. */
	readonly baseScope: ParseScope | undefined;
	/** The scope `incoming` was printed under. */
	readonly incomingScope: ParseScope | undefined;
	/** A same-slot collision was already observed in this mounted edit. */
	readonly conflict?: boolean;
	/** The previous reconciliation's `reading`. */
	readonly reading?: XPathDraftReading;
}): XPathDraftReconciliation {
	// A later peer projection cannot prove that the local same-slot edit is
	// suddenly safe. Advance the shared base, but preserve both the draft and
	// the refusal until the editor's explicit cancel/reload path unmounts it.
	if (conflict) return { base: incoming, draft, conflict: true };
	if (draft === base || draft === incoming)
		return { base: incoming, draft: incoming, conflict: false };
	const shownChanged = incoming !== base;
	const fail = (): XPathDraftReconciliation =>
		shownChanged
			? { base: incoming, draft, conflict: true }
			: { base, draft, conflict: false };
	if (baseScope === undefined || incomingScope === undefined) return fail();
	if (
		baseScope.doc === incomingScope.doc &&
		baseScope.lookup === incomingScope.lookup
	) {
		const carried =
			reading?.draft === draft && reading.scope === baseScope
				? { ...reading, scope: incomingScope }
				: undefined;
		return {
			base: incoming,
			draft,
			conflict: false,
			...(carried && { reading: carried }),
		};
	}
	if (!deepEqual(baseScope.current, incomingScope.current))
		return { base: incoming, draft, conflict: true };
	const respelled = respellDraft(draft, baseScope, incomingScope, reading);
	if (typeof respelled === "string") return fail();
	return {
		base: incoming,
		draft: respelled.draft,
		conflict: false,
		reading: respelled.reading,
	};
}
