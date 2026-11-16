/**
 * A case list's two screens' orders, each apart from its `columns` array, read back to the
 * document's canonical form.
 *
 * Contract: for each document of the workflow fuzz corpus with its case lists' Results and Details
 * orders drawn apart from the `columns` array and from each other, its export, served on CommCare
 * HQ's own shell and read as a read back of a document Nova holds is made, reads with no finding
 * and no reader defect, and `readBackDifferences` of `canonDocument(D)` against the reading is
 * empty. The workflow corpus itself writes every order as its `columns` array (the proof lane
 * draws its documents from it, so its draws stay), which leaves the rows that read the orders
 * (`columns-off-a-screen-last-in-its-order`, `columns-joined-as-read`, `columns-in-list-order`)
 * unexercised there.
 *
 * Plausible failures: two columns the export tells apart by place alone (equal columns, or a
 * column hidden from Results over another's property) read back in other places or under other
 * identities than the canonical form gives them; a list order a canonical row moves without the
 * identities a reading gives each place; a `columns` array in another order than the reading's.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import {
	readBackInput,
	servedExport,
} from "@/lib/deployment/reading/__tests__/novaReading";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { withCandidate } from "../../candidate";
import { canonDocument } from "../../canon";
import { readHqApp } from "../../index";

/** `order` arranged by `keys`: each place ranked by the key drawn for it, ties by place. */
function arranged(order: readonly Uuid[], keys: readonly number[]): Uuid[] {
	return order
		.map((uuid, index) => ({ uuid, index, key: keys[index] ?? 0 }))
		.sort((a, b) => a.key - b.key || a.index - b.index)
		.map(({ uuid }) => uuid);
}

/** `doc` with each case list's two orders arranged by the drawn keys. */
function withOrders(
	doc: BlueprintDoc,
	keys: readonly (readonly [readonly number[], readonly number[]])[],
): BlueprintDoc {
	return withCandidate(doc, (draft) => {
		draft.moduleOrder.forEach((moduleUuid, index) => {
			const config = draft.modules[moduleUuid]?.caseListConfig;
			const [list, detail] = keys[index] ?? [[], []];
			if (config === undefined) return;
			config.listColumnOrder = arranged(config.listColumnOrder, list);
			config.detailColumnOrder = arranged(config.detailColumnOrder, detail);
		});
	});
}

const ORDER_KEYS = fc.array(
	fc.tuple(
		fc.array(fc.nat({ max: 5 }), { minLength: 6, maxLength: 6 }),
		fc.array(fc.nat({ max: 5 }), { minLength: 6, maxLength: 6 }),
	),
	{ minLength: 4, maxLength: 4 },
);

describe("a read back of a fuzz document whose case lists hold their orders apart", () => {
	it("gives the document's canonical form", {
		// Each run is one expansion, one served source, one whole reading and one canonical
		// form, as `canonReadBack.fuzz.test.ts` runs them.
		timeout: 120_000,
	}, async () => {
		await fc.assert(
			fc.asyncProperty(suiteDocArbitrary, ORDER_KEYS, async (drawn, keys) => {
				rebuildFieldParent(drawn);
				const doc = withOrders(drawn, keys);
				const outcome = readHqApp(await readBackInput(doc, servedExport(doc)));
				expect(outcome.defects).toEqual([]);
				expect(
					outcome.kind === "read"
						? []
						: outcome.findings.map((finding) => finding.code),
				).toEqual([]);
				if (outcome.kind !== "read") return;
				const { declaration } = outcome.draft;
				expect(
					readBackDifferences(canonDocument(doc), {
						doc: outcome.draft.doc,
						choices: declaration.kind === "choices" ? declaration.choices : [],
					}).map((one) => `${one.kind} /${one.path.join("/")}`),
				).toEqual([]);
			}),
			{ seed: 20261115, numRuns: 100 },
		);
	});
});
