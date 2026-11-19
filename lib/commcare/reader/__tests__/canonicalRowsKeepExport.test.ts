/**
 * Every canonical row keeps the export of every document the proof lane publishes.
 *
 * Contract: a row of `canon.ts::CANONICALIZATIONS` (each of `assemble.ts::READER_CANONICAL_CHOICES`,
 * then every expression slot's print collisions applied over the whole document) rewrites one
 * member of a pair into the other, and both members print one export (`one-wire`) or the row
 * removes what no export carries (`not-carried`). So for each targeted and producer document `targetedReadBack.test.ts`
 * reads, expanded as a publish expands it (`publishedDocuments.ts`), applying the rows in list
 * order leaves `expandDoc`'s output byte for byte as it was after every row that changes the
 * document. A row changes the document where its stored form changes (`toPersistableDoc`, as
 * `canonDocument` decides it), so only those rows' members are printed, and a document no row
 * changes is never printed.
 *
 * Plausible failure: a row that moves content to a place that prints differently (an order rule
 * whose element names the column it is authored on moved to another column), which a read-back
 * that compares documents passes, since the reading and the canonical document agree, while a
 * first publish of the reading rewrites what CommCare HQ holds with no register row. The test
 * names the row and the document of every change.
 */
import { expect, it } from "vitest";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { type ExpandOptions, expandDoc } from "../../expander";
import { CANONICALIZATIONS } from "../canon";
import { sameJson } from "../jsonCursor";
import {
	hydrated,
	publishExpansion,
	publishedCorpus,
	publishRefuses,
} from "./publishedDocuments";

const printed = (doc: BlueprintDoc, options: ExpandOptions) =>
	JSON.stringify(expandDoc(doc, options));

it("applies no canonical row that changes a published document's export", {
	// About three hundred documents, each expanded before and after each row that changes it:
	// about 14 s alone on a hosted runner's four cores, a third of it building the corpus, and
	// several times that in a batch that shares the cores.
	timeout: 90_000,
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
		let stored = toPersistableDoc(current);
		// The export of the document as it stands, printed when a row first changes it.
		let before: string | undefined;
		for (const row of CANONICALIZATIONS) {
			const next = row.apply(current);
			if (next === current) continue;
			const nextStored = toPersistableDoc(next);
			if (sameJson(nextStored, stored)) continue;
			before ??= printed(current, options);
			const after = printed(next, options);
			if (after !== before)
				failures.push(`${row.id} changes the export of ${document.id}`);
			current = next;
			stored = nextStored;
			before = after;
		}
	}
	expect(printedDocuments).toBeGreaterThan(100);
	expect(failures).toEqual([]);
});
