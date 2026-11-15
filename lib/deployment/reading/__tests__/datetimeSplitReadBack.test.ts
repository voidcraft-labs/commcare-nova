/**
 * The document a split declaration makes of a reading reads back to itself.
 *
 * Contract: for every document the proof lane publishes that holds a date and
 * time question, its export read back as Nova reads a document it holds gives
 * a reading that offers a declaration splitting those questions; that
 * declaration's mutations, applied through the commit gate, give the split
 * document; and the split document's own export, re-read under
 * `matchingResolver` over the split document's identities, gives the split
 * document exactly, its declaration among the choices the re-read offers. So
 * the questions the split made keep their UUIDs on the re-read, which is what
 * the fixed point of a reading holds of a split before the review offers it.
 *
 * Plausible failure: a split that no reading could ever offer, because the
 * questions it makes print a source the reader reads as something else, or
 * read back under UUIDs other than the split gave them.
 */

import { describe, expect, it } from "vitest";
import { readHqApp } from "@/lib/commcare/reader";
import {
	hydrated,
	publishedCorpus,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { BlueprintDoc } from "@/lib/domain";
import { readBackDifferences } from "../readBack";
import { lookupContextOf, readBackInput, servedExport } from "./novaReading";

function holdsDatetimeQuestion(doc: BlueprintDoc): boolean {
	return Object.values(doc.fields).some((field) => field.kind === "datetime");
}

describe("the split document of a reading", () => {
	it("reads back to itself, for every corpus document with a date and time question", {
		timeout: 120_000,
	}, async () => {
		const checked: string[] = [];
		for (const document of publishedCorpus()) {
			const doc = hydrated(document);
			if (!holdsDatetimeQuestion(doc)) continue;
			const options = { ...(document.lookup && { lookup: document.lookup }) };
			const reading = readHqApp(
				await readBackInput(doc, servedExport(doc, options), options),
			);
			if (reading.kind !== "read")
				throw new Error(
					`${document.id} read to an account: ${reading.findings.map((one) => one.code).join(", ")}`,
				);
			const { declaration } = reading.draft;
			const split =
				declaration.kind === "choices"
					? declaration.choices.find((choice) => choice.split)
					: undefined;
			if (split === undefined)
				throw new Error(`${document.id}'s reading offers no split.`);
			const verdict = mutationCommitVerdict(
				reading.draft.doc,
				split.mutations,
				lookupContextOf(document.lookup),
			);
			if (!verdict.ok)
				throw new Error(
					`${document.id}'s split is refused: ${verdict.findings.map((one) => one.code).join(", ")}`,
				);
			const splitDoc = verdict.nextDoc;
			expect(
				Object.values(splitDoc.fields).some(
					(field) => field.kind === "datetime",
				),
				document.id,
			).toBe(false);
			const again = readHqApp(
				await readBackInput(splitDoc, servedExport(splitDoc, options), options),
			);
			if (again.kind !== "read")
				throw new Error(
					`${document.id}'s split document read to an account: ${again.findings.map((one) => one.code).join(", ")}`,
				);
			expect(again.defects, document.id).toEqual([]);
			const offered = again.draft.declaration;
			expect(
				readBackDifferences(splitDoc, {
					doc: again.draft.doc,
					choices: offered.kind === "choices" ? offered.choices : [],
				}),
				document.id,
			).toEqual([]);
			checked.push(document.id);
		}
		expect(checked.length).toBeGreaterThanOrEqual(3);
	});
});
