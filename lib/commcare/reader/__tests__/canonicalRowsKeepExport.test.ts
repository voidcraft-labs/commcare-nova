/**
 * Every canonical row keeps the export of every document the proof lane publishes.
 *
 * Contract: a row of `assemble.ts::READER_CANONICAL_CHOICES` rewrites one member of a pair into
 * the other, and both members print one export (`one-wire`) or the row removes what no export
 * carries (`not-carried`). So for each targeted and producer document `targetedReadBack.test.ts`
 * reads, expanded as a publish expands it (`publishedDocuments.ts`), applying the rows in list
 * order leaves `expandDoc`'s output byte for byte as it was after every row that changes the
 * document.
 *
 * Plausible failure: a row that moves content to a place that prints differently (an order rule
 * whose element names the column it is authored on moved to another column), which a read-back
 * that compares documents passes, since the reading and the canonical document agree, while a
 * first publish of the reading rewrites what CommCare HQ holds with no register row. The test
 * names the row and the document of every change.
 */
import { expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { type ExpandOptions, expandDoc } from "../../expander";
import { READER_CANONICAL_CHOICES } from "../assemble";
import {
	hydrated,
	publishExpansion,
	publishedCorpus,
	publishRefuses,
} from "./publishedDocuments";

const printed = (doc: BlueprintDoc, options: ExpandOptions) =>
	JSON.stringify(expandDoc(doc, options));

it("applies no canonical row that changes a published document's export", {
	// About two hundred documents, each expanded once and again after each row that changes
	// it: a few seconds alone, generous for a shared runner.
	timeout: 60_000,
}, () => {
	const failures: string[] = [];
	let printedDocuments = 0;
	for (const document of publishedCorpus()) {
		let doc: BlueprintDoc;
		try {
			doc = hydrated(document);
			if (publishRefuses(document, doc)) continue;
		} catch {
			// `targetedReadBack.test.ts` names a document that does not load.
			continue;
		}
		printedDocuments++;
		const { options } = publishExpansion(document, doc);
		let current = doc;
		let before = printed(current, options);
		for (const row of READER_CANONICAL_CHOICES) {
			const next = row.apply(current);
			if (next === current) continue;
			const after = printed(next, options);
			if (after !== before)
				failures.push(`${row.id} changes the export of ${document.id}`);
			current = next;
			before = after;
		}
	}
	expect(printedDocuments).toBeGreaterThan(100);
	expect(failures).toEqual([]);
});
