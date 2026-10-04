/**
 * The corpus's fuzz sample: admitted, and fixed by its seed.
 *
 * In ordinary CI this draws a small sample and proves what the corpus's ids
 * rest on: the same seed draws the same documents (stored form and uploaded
 * media, byte for byte), another seed draws others, a document drawn in a
 * smaller sample is the same document in a larger one, and every document,
 * read back from the JSON the writer writes, passes the strict schema and
 * full validation.
 *
 * Run as a Vitest writer (`proof/corpus/emit.ts` does, inside the proof
 * image) with `NOVA_CORPUS_SAMPLE_DIR`, `NOVA_CORPUS_SAMPLE_SIZE` and
 * `NOVA_CORPUS_SAMPLE_SEED` set, the same tests run over that sample and it
 * is then written for the corpus: `index.json` and one `<id>.json` per
 * document. The sample is drawn here because its media bytes come from
 * `compilerEvidence.ts::manifestFor`, whose module imports Vitest.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { runValidation } from "@/lib/commcare/validator/runner";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { DEFAULT_CORPUS_SEED } from "../defaults";
import { writtenDocument } from "../documents";
import { type SampledDocument, sampleFuzzDocuments } from "../fuzzSample";

const destination = process.env.NOVA_CORPUS_SAMPLE_DIR;

function wholeNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`${name} holds a whole number (a sample size or a seed); got ${JSON.stringify(raw)}.`,
		);
	}
	return value;
}

const seed = wholeNumber("NOVA_CORPUS_SAMPLE_SEED", DEFAULT_CORPUS_SEED);
const size = wholeNumber("NOVA_CORPUS_SAMPLE_SIZE", 4);

/** A sampled document as the writer writes it, parsed back from its JSON text. */
function asWritten(sampled: SampledDocument): unknown {
	return JSON.parse(
		JSON.stringify(
			writtenDocument(sampled.document.doc, sampled.document.media),
		),
	);
}

function draw(sampleSize: number, sampleSeed = seed): SampledDocument[] {
	return sampleFuzzDocuments({
		size: sampleSize,
		seed: sampleSeed,
		manifestFor,
	});
}

describe("the corpus's fuzz sample", () => {
	let sample: SampledDocument[] = [];
	beforeAll(() => {
		sample = draw(size);
	});

	it("admits every document, read back from what the writer writes", () => {
		expect(sample).toHaveLength(size);
		for (const sampled of sample) {
			const written = asWritten(sampled) as { doc: unknown };
			const parsed = blueprintDocSchema.safeParse(written.doc);
			expect(parsed.success, sampled.document.id).toBe(true);
			if (!parsed.success) continue;
			expect(
				runValidation(
					hydratePersistedBlueprint(parsed.data),
					LOOKUP_CONTEXT_UNAVAILABLE,
				).map((finding) => finding.code),
				sampled.document.id,
			).toEqual([]);
		}
	});

	it("draws the same documents for a seed, and other documents for another seed", () => {
		const pair = draw(2);
		expect(draw(2).map(asWritten)).toEqual(pair.map(asWritten));
		expect(draw(2, seed + 1).map(asWritten)).not.toEqual(pair.map(asWritten));
	});

	it("gives a document the same content whatever the sample's size", () => {
		// Sizes fixed here rather than taken from the requested sample, so the
		// writer runs for any size the lane asks for, none included.
		const larger = new Map(
			draw(4).map((sampled) => [sampled.document.id, asWritten(sampled)]),
		);
		const smaller = draw(2);
		expect(smaller.map((s) => s.generator)).toEqual(["xform", "suite"]);
		for (const document of smaller) {
			expect(larger.has(document.document.id), document.document.id).toBe(true);
			expect(larger.get(document.document.id), document.document.id).toEqual(
				asWritten(document),
			);
		}
	});

	afterAll(() => {
		// A sample that could not be drawn in full is not written; the
		// failing test says why.
		if (destination === undefined || sample.length !== size) return;
		mkdirSync(destination, { recursive: true });
		for (const sampled of sample) {
			writeFileSync(
				resolve(destination, `${sampled.document.id}.json`),
				JSON.stringify(
					writtenDocument(sampled.document.doc, sampled.document.media),
				),
			);
		}
		writeFileSync(
			resolve(destination, "index.json"),
			JSON.stringify(
				{
					seed,
					size,
					documents: sample.map((sampled) => ({
						id: sampled.document.id,
						generator: sampled.generator,
						index: sampled.index,
						file: `${sampled.document.id}.json`,
					})),
				},
				null,
				"\t",
			),
		);
	});
});
