/**
 * The canonical form of a document: every pair of documents that print one
 * export, or that differ only in content no export holds, replaced by the
 * member a reading returns. A Nova document is not always in the reader's
 * image, so a read back of its export is compared with this form of it.
 *
 * The list is the reader's own choices (`assemble.ts::READER_CANONICAL_CHOICES`,
 * each written by the reader module that makes it) and the print collisions
 * of one expression slot (`expressions/canonical.ts::canonicalExpression`),
 * applied to every slot of the document. Nothing here parses or prints: each
 * row is a rewrite over the typed document.
 */

import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import { type Expression, isExpression } from "@/lib/domain/expression/types";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
	rewriteExpressionSlotValues,
} from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { identityLookupWireNaming } from "../lookup/naming";
import { READER_CANONICAL_CHOICES } from "./assemble";
import { withCandidate } from "./candidate";
import { canonicalExpression } from "./expressions/canonical";
import { slotPrintUnder } from "./expressions/readExpression";
import { sameJson } from "./jsonCursor";

export interface Canonicalization {
	readonly id: string;
	/** `one-wire`: two documents print the same bytes. `not-carried`: content no export holds. */
	readonly kind: "one-wire" | "not-carried";
	/** The document with every instance of the pair replaced by the member the reader returns. */
	apply(doc: BlueprintDoc): BlueprintDoc;
}

/** The slot a menu's case list filter is held in. */
const CASE_LIST_FILTER_SLOT = "case_list_filter";

/** Every expression owner of a document, menus first, in the order the
 *  reference slots walk them. */
function carriers(doc: BlueprintDoc): ExpressionCarrierRef[] {
	return [
		...doc.moduleOrder.map((uuid) => ({ entity: "module" as const, uuid })),
		...(Object.keys(doc.forms) as Uuid[]).map((uuid) => ({
			entity: "form" as const,
			uuid,
		})),
		...(Object.keys(doc.fields) as Uuid[]).map((uuid) => ({
			entity: "field" as const,
			uuid,
		})),
	];
}

/**
 * Every expression slot of `doc` holding the canonical tree of what it
 * stores, and no case list filter where that tree is `match-all`, which the
 * emitter writes none for. Each slot is canonicalized in its own context over
 * `doc`, with no Project lookup types (a slot's print collisions never read a
 * column's type) and under the identity lookup naming, which binds the same
 * questions in a Save to Case block's place as any naming does.
 */
function canonicalSlots(doc: BlueprintDoc): BlueprintDoc {
	const naming = identityLookupWireNaming();
	const lookupTypes = new Map();
	const replacements = new Map<string, Expression[]>();
	const droppedFilters = new Set<Uuid>();
	let changed = false;
	const ownerKey = (owner: ExpressionCarrierRef) =>
		`${owner.entity}:${owner.uuid}`;
	for (const owner of carriers(doc)) {
		const trees: Expression[] = [];
		for (const { ref, expression } of expressionSlotValues(doc, owner)) {
			const context = slotContext(doc, ref, lookupTypes);
			const tree =
				context === undefined
					? expression
					: canonicalExpression(
							expression,
							context,
							slotPrintUnder(doc, ref, naming),
						);
			if (
				ref.entity === "module" &&
				ref.slot === CASE_LIST_FILTER_SLOT &&
				effectiveFilterForEmission(tree) === undefined
			)
				droppedFilters.add(ref.uuid);
			if (!sameJson(tree, expression)) changed = true;
			trees.push(sameJson(tree, expression) ? expression : tree);
		}
		if (trees.length > 0) replacements.set(ownerKey(owner), trees);
	}
	if (!changed && droppedFilters.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const owner of carriers(doc)) {
			const trees = replacements.get(ownerKey(owner));
			if (trees === undefined) continue;
			// The walk over the draft meets the slots in the order the walk over
			// `doc` did, the two documents having one shape.
			let at = 0;
			rewriteExpressionSlotValues(draft, owner, (value) => {
				if (!isExpression(value)) return value;
				const tree = trees[at++];
				return tree === undefined || sameJson(tree, value) ? value : tree;
			});
		}
		for (const uuid of droppedFilters) {
			const config = draft.modules[uuid]?.caseListConfig;
			if (config !== undefined) delete config.filter;
		}
	});
}

export const CANONICALIZATIONS: readonly Canonicalization[] = [
	...READER_CANONICAL_CHOICES.map(
		(choice): Canonicalization => ({
			id: choice.id,
			kind: choice.kind,
			apply: choice.apply,
		}),
	),
	{
		/** Two trees of one slot that print the same bytes there
		 *  (`expressions/canonical.ts::PRINT_COLLISIONS`): the reader returns the
		 *  canonical one, and no case list filter where that tree is `match-all`. */
		id: "expression-print-collisions",
		kind: "one-wire",
		apply: canonicalSlots,
	},
];

/** The document as it is stored, for a comparison that no derived slot and
 *  no fresh object of an unchanged document moves. */
function stored(doc: BlueprintDoc): unknown {
	return toPersistableDoc(doc);
}

/** Every row applied in list order, repeated until none changes the document. */
export function canonDocument(doc: BlueprintDoc): BlueprintDoc {
	let current = doc;
	for (let pass = 0; pass < CANONICALIZATIONS.length; pass++) {
		const next = CANONICALIZATIONS.reduce(
			(one, row) => row.apply(one),
			current,
		);
		if (sameJson(stored(next), stored(current))) return current;
		current = next;
	}
	throw new Error(
		"Nova's canonical form of a document did not settle. Each canonicalization returns the member of its pair the reader returns, so applying one twice changes nothing; look at the row whose result another row undoes.",
	);
}
