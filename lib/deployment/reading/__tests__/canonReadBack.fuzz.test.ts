/**
 * The canonical form is complete over Nova's own documents: a read back of a
 * fuzz document's export gives the document's canonical form, exactly.
 *
 * Contract: for each document of the compiler's fuzz corpora (the field-tree
 * corpus and the workflow corpus), its export, served on CommCare HQ's own
 * shell, read by the production reader as a read back of a document Nova
 * holds is made (the document's own UUIDs through `matchingResolver` over its
 * identities, and the rest of the reader's input the document's own), reads
 * with no finding and no reader defect, and `readBackDifferences` of
 * `canonDocument(D)` against the reading's document, beside the declarations
 * the reading offers, is empty.
 *
 * Plausible failure: a pair of documents that print one export which the
 * canonical list lacks, a slot the reader reads back as something else, or
 * content the reader adds or drops. The rule for a failure is fixed: a sample
 * that reads back to another document whose emission is byte-equal is a pair
 * that joins the canonical list; one whose emission differs, or that reads to
 * an account, is a reader defect corrected in the reader module that owns the
 * slot.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { readHqApp } from "@/lib/commcare/reader";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { whereText } from "@/lib/commcare/reader/place";
import { rebuildFieldParent, toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { readBackDifferences } from "../readBack";
import { readBackInput, servedExport } from "./novaReading";

/** Why `doc` does not read back to its canonical form, or null where it does. */
async function readBackFailure(doc: BlueprintDoc): Promise<string | null> {
	rebuildFieldParent(doc);
	const served = servedExport(doc);
	const outcome = readHqApp(await readBackInput(doc, served));
	if (outcome.defects.length > 0)
		return `reader defect: ${JSON.stringify(outcome.defects[0])}`;
	if (outcome.kind !== "read")
		return `read to an account: ${outcome.findings
			.map(
				(finding) =>
					`${finding.code} at ${whereText(finding.place)} (${finding.detail.name ?? ""})`,
			)
			.join("; ")}`;
	const { declaration } = outcome.draft;
	const expected = canonDocument(doc);
	const differences = readBackDifferences(expected, {
		doc: outcome.draft.doc,
		choices: declaration.kind === "choices" ? declaration.choices : [],
	});
	return differences.length === 0
		? null
		: `${differences.length} difference(s): ${differences
				.slice(0, 8)
				.map(
					(one) =>
						`${one.kind} /${one.path.join("/")} (want ${at(expected, one.path)}, got ${at(outcome.draft.doc, one.path)})`,
				)
				.join("; ")}`;
}

/** The value at `path` of `doc` as JSON, cut short, for a failure's message. */
function at(doc: BlueprintDoc, path: readonly string[]): string {
	let node: unknown = toPersistableDoc(doc);
	for (const key of path)
		node =
			node !== null && typeof node === "object"
				? (node as Record<string, unknown>)[key]
				: undefined;
	return (JSON.stringify(node) ?? "nothing").slice(0, 160);
}

describe("a read back of a fuzz document's export", () => {
	for (const [name, arbitrary] of [
		["field-tree", blueprintDocArbitrary],
		["workflow", suiteDocArbitrary],
	] as const)
		it(`gives the document's canonical form, over the ${name} corpus`, {
			// Each run is one expansion, one served source, one whole reading and
			// one canonical form; a hundred runs of a corpus took under five
			// seconds locally, and three hundred under fifteen. The bound leaves a
			// shared CI runner under load room.
			timeout: 120_000,
		}, async () => {
			await fc.assert(
				fc.asyncProperty(arbitrary, async (doc) => {
					const failure = await readBackFailure(doc);
					expect(failure).toBeNull();
				}),
				{ seed: 20261115, numRuns: 100 },
			);
		});
});
