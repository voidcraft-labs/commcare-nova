/**
 * The record-expression corpus draws the whole record rule set.
 *
 * Contract: in the record slots of a fixed sample of
 * `recordExpressionDocArbitrary`'s documents, the trees
 * `expressionArbitrary` draws for each slot's own request, bound to that
 * slot, hold among those the slot's checker admits every expression kind
 * and every choice of each operator list the domain names
 * (`domainVocabulary`: arithmetic operators, intervals, match modes,
 * quantifiers, date presets), but the kinds `RECORD_KIND_COVERAGE` names
 * with their reasons.
 *
 * Plausible failure: a kind or an operator the domain adds, or one a builder
 * stops offering or draws only where no slot admits it, so the read-back
 * properties never meet it.
 */

import fc from "fast-check";
import { expect, it } from "vitest";
import { checkExpression } from "@/lib/domain/expression";
import {
	bindTree,
	domainVocabulary,
	drawnVocabulary,
	expressionArbitrary,
	recordExpressionDocArbitrary,
	recordSlotsOf,
	requestOf,
} from "./recordExpressionArbitrary";

it("draws every kind and operator of the record rule set where a record slot admits it", {
	timeout: 120_000,
}, () => {
	const drawn = new Set<string>();
	const docs = fc.sample(recordExpressionDocArbitrary, {
		seed: 20261117,
		numRuns: 8,
	});
	for (const [index, doc] of docs.entries())
		for (const slot of recordSlotsOf(doc)) {
			const request = requestOf(slot.ctx.profile.expectation);
			const trees =
				request === undefined ? undefined : expressionArbitrary(request);
			if (trees === undefined) continue;
			for (const tree of fc.sample(trees, { seed: index, numRuns: 500 })) {
				const bound = bindTree(tree, slot.bindings);
				if (
					bound === undefined ||
					checkExpression(bound, slot.ctx).errors.length > 0
				)
					continue;
				for (const entry of drawnVocabulary(bound)) drawn.add(entry);
			}
		}
	const missing = [...domainVocabulary()].filter((entry) => !drawn.has(entry));
	expect(missing).toEqual([]);
});
