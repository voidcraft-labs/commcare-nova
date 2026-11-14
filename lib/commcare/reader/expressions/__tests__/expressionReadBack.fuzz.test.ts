/**
 * Every expression Nova writes, read back from Nova's own export.
 *
 * Contract: over the emitter's own document corpora, each expression slot a
 * document stores (as the member of a canonical pair the reader returns,
 * `assemble.ts::READER_CANONICAL_CHOICES`) is read back by the whole reader from the export the
 * production emitter writes as `canonicalExpression` of the stored tree,
 * judged in the read document's own context; the reading raises no finding
 * and no reader defect, since every export Nova writes reads back; a second
 * reading of the same export gives the same trees and the same claims. One
 * outcome is not the expression reader's: a slot whose stored tree the read
 * document cannot hold as written, because what it needs is a fact of the
 * document no export carries (a property type no writer gives, which a
 * reading derives from the app), or that no export carries at all (the case
 * list of a menu that loads no case). It is counted, with the dormant slots,
 * and together they are never most of a corpus.
 *
 * Plausible failures: a lowering the emitter writes that no fold reads back
 * (a slot left `unrecognized` for Nova's own text), a fold that keeps less
 * than the stored tree (a literal's type, an identity), a held slot the
 * checker or the record dialect then refuses, and a reading that depends on
 * something other than its input.
 */
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import {
	corpusDocs,
	type EmissionReading,
	judgeReadBack,
	READ_BACK_CORPORA,
	readEmission,
} from "./readBackCorpus";

/** Documents per corpus. Each corpus, read twice, takes a few seconds on a
 *  laptop; the per-corpus budget leaves room for a shared CI runner. */
const DOCS_PER_CORPUS = 30;

/** The document as the reader returns its pair's member: two documents that
 *  print one export read back as one of them. */
function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** What a reading answered for each registration, for two readings to compare. */
function answers(reading: EmissionReading) {
	return reading.slots.map((slot) => ({
		ref: slot.registration.ref,
		text: slot.registration.text,
		expression: slot.outcome.expression,
		claim: slot.outcome.claim,
	}));
}

describe("expressions read back from Nova's own export", () => {
	for (const corpus of READ_BACK_CORPORA)
		it(`reads back every slot of the ${corpus.name} corpus`, {
			timeout: 60_000,
		}, async () => {
			const census = { same: 0, documentFact: 0, dormant: 0 };
			for (const doc of corpusDocs(corpus, DOCS_PER_CORPUS)) {
				const reading = await readEmission(doc, recordDialectRoundTrip);
				const again = await readEmission(doc, recordDialectRoundTrip);
				expect(isDeepStrictEqual(answers(again), answers(reading))).toBe(true);
				// Nova's own export reads: no finding and no defect of the reader.
				expect
					.soft(
						reading.closed.findings.map(
							(finding) =>
								`${finding.code} at ${JSON.stringify(finding.place)} (${finding.detail.name ?? ""})`,
						),
						`findings of ${doc.appName}`,
					)
					.toEqual([]);
				expect
					.soft(reading.closed.defects, `defects of ${doc.appName}`)
					.toEqual([]);
				const read = canonical(doc);
				for (const { stored, verdict } of judgeReadBack(read, reading)) {
					if (verdict.kind === "same") {
						census.same++;
						continue;
					}
					if (verdict.kind === "dormant") {
						census.dormant++;
						continue;
					}
					if (verdict.kind === "document-fact") {
						census.documentFact++;
						continue;
					}
					expect
						.soft(
							verdict.got,
							`${stored.ref.slot} (${verdict.claim?.entryId ?? "no claim"}): ${verdict.text ?? "not registered"}`,
						)
						.toEqual(verdict.want);
				}
			}
			expect(census.same).toBeGreaterThan(census.documentFact + census.dormant);
		});
});
